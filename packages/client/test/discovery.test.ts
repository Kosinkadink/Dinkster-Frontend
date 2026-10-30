/**
 * Native discovery tests: supervisor priority over the node catalog,
 * each conclusive match, the SPA-HTML routing
 * fallthrough case, and the unreachable/unrecognized split.
 */
import { describe, expect, it } from 'vitest'
import { discoverBackend, type FetchLike } from '../src/index.js'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const html = (): Response =>
  new Response('<!doctype html><html><body>app</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  })

/** Route fetches by path suffix; unrouted paths get `fallback` (or throw). */
const fakeFetch = (
  routes: Record<string, () => Response>,
  fallback?: () => Response,
): FetchLike => {
  return (url) => {
    const path = url.split('?')[0]!
    for (const [suffix, make] of Object.entries(routes)) {
      if (path.endsWith(suffix)) return Promise.resolve(make())
    }
    if (fallback) return Promise.resolve(fallback())
    return Promise.reject(new Error(`connect ECONNREFUSED (${url})`))
  }
}

const nativeNodes = () =>
  json(200, { schemaVersion: 1, nodes: {}, dinkster: { version: '0.1', schemaWire: 1 } })

describe('discoverBackend', () => {
  it('identifies a supervised Dinkster from /supervisor/status', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(200, { protocol: 1, state: 'starting' }),
    })
    expect(await discoverBackend('http://host:3639', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: true,
    })
  })

  it('identifies a standalone native engine from /api/nodes', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(404, { error: 'not found' }),
      '/api/nodes': nativeNodes,
    })
    expect(await discoverBackend('http://host:3639', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: false,
    })
  })

  it('never requests a stock ComfyUI endpoint', async () => {
    const seen: string[] = []
    const fetchFn: FetchLike = (url) => {
      seen.push(url)
      return Promise.resolve(url.includes('/api/nodes') ? nativeNodes() : json(404, {}))
    }
    expect(await discoverBackend('', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: false,
    })
    expect(seen).toHaveLength(2)
    expect(seen.some((url) => url.includes('/system_stats'))).toBe(false)
  })

  it('requests the nodes catalog without version negotiation', async () => {
    let nodesUrl = ''
    const fetchFn: FetchLike = (url) => {
      if (url.includes('/api/nodes')) {
        nodesUrl = url
        return Promise.resolve(nativeNodes())
      }
      return Promise.resolve(json(404, {}))
    }
    await discoverBackend('http://host', { fetchFn })
    expect(nodesUrl).toBe('http://host/api/nodes')
  })

  it('treats the supervisor 503 engine-not-ready gate on /api/nodes as supervised Dinkster', async () => {
    const fetchFn = fakeFetch({
      // A supervisor whose /supervisor/status is briefly unreachable but
      // whose proxy gate answers: still conclusively Dinkster.
      '/api/nodes': () => json(503, { error: 'engine-not-ready', state: 'starting' }),
    })
    expect(await discoverBackend('http://host', { fetchFn })).toEqual({
      kind: 'dinkster',
      supervised: true,
    })
  })

  it('rejects a stock ComfyUI server without probing its schema or stats', async () => {
    const seen: string[] = []
    const routes = fakeFetch({
      '/supervisor/status': () => json(404, {}),
      '/api/nodes': () => json(404, {}),
      '/system_stats': () => json(200, { system: { os: 'posix' }, devices: [] }),
      '/object_info': () => json(200, { EmptyImage: {} }),
    })
    const fetchFn: FetchLike = (url, init) => {
      seen.push(url)
      return routes(url, init)
    }
    expect((await discoverBackend('http://host:8188', { fetchFn })).kind).toBe('unrecognized')
    expect(seen).toEqual(['http://host:8188/supervisor/status', 'http://host:8188/api/nodes'])
  })

  it('rejects array-valued native identity sections', async () => {
    const fetchFn = fakeFetch({
      '/supervisor/status': () => json(404, {}),
      '/api/nodes': () => json(200, { nodes: [], dinkster: [] }),
    })
    expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
  })

  it('calls out SPA-HTML routing fallthrough as unrecognized, not a protocol', async () => {
    // A dev server answering 200 text/html for every path must match
    // nothing - this is the :5199/api/* fallthrough bug's signature.
    const fetchFn = fakeFetch({}, html)
    const result = await discoverBackend('', { fetchFn })
    expect(result.kind).toBe('unrecognized')
    if (result.kind === 'unrecognized') expect(result.detail).toContain('HTML')
  })

  it('reports arbitrary JSON servers as unrecognized', async () => {
    const fetchFn = fakeFetch({}, () => json(200, { hello: 'world' }))
    expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
  })

  it('reports unreachable when nothing answers, carrying the error detail', async () => {
    const fetchFn = fakeFetch({})
    const result = await discoverBackend('http://down:1', { fetchFn })
    expect(result.kind).toBe('unreachable')
    if (result.kind === 'unreachable') expect(result.detail).toContain('ECONNREFUSED')
  })

  it('is unrecognized (not unreachable) when only some probes fail transport', async () => {
    const fetchFn = fakeFetch({ '/api/nodes': () => json(200, [1, 2, 3]) })
    expect((await discoverBackend('http://host', { fetchFn })).kind).toBe('unrecognized')
  })

  it('strips trailing slashes from the base url', async () => {
    const seen: string[] = []
    const fetchFn: FetchLike = (url) => {
      seen.push(url)
      return Promise.resolve(json(200, { protocol: 1, state: 'ready' }))
    }
    await discoverBackend('http://host:3639///', { fetchFn })
    expect(seen[0]).toBe('http://host:3639/supervisor/status')
  })
})
