import { describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '@dinkster/core'
import { RemoteNodeCatalog } from '../src/node-catalog.js'

const prefix = 'https://registry.example/static'
const pack = 'image-tools'
const path = 'packs/image-tools/1.10.0/schemas.json'
const schemaBody = (changes: Record<string, unknown> = {}) => JSON.stringify({
  packName: pack, version: '1.10.0', schemas: [{
    nodeType: 'image.resize', schemaVersion: 3, schemaWireVersion: 1, schemaSignature: 'resize-signature', role: 'compute',
    schema: {
      schemaVersion: 1, version: 3, displayName: 'Resize Image', category: 'image/transform', searchTerms: ['resample'],
      interface: [
        { role: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] }, required: true },
        { role: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 768, widget: { type: 'INT', min: 1, max: 4096 } },
        { role: 'output', id: 'result', type: { kind: 'concrete', types: ['IMAGE'] } },
      ],
    },
  }], ...changes,
})
const indexBody = (body = schemaBody(), changes: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: 1, items: [{
    name: pack, publisher: 'dinkster', version: '1.10.0', displayName: 'Image Tools', platforms: ['linux', 'darwin'],
    url: path, digest: `sha256:${sha256Hex(body)}`, ...changes,
  }],
})
const storage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
const serve = (base: string, index = indexBody(), body = schemaBody()) => vi.fn<typeof fetch>(async (url) => {
  if (url === `${base}/schemas/index.json`) return new Response(index, { headers: { ETag: '"index-1"' } })
  if (url === `${base}/${path}`) return new Response(body, { headers: { ETag: '"schema-1"' } })
  return new Response(null, { status: 404 })
})

describe('static first-party node catalog', () => {
  it('decodes real node interfaces identically from a copied static prefix, without dynamic routes', async () => {
    const mirror = 'https://mirror.example/copied/prefix'
    const liveFetch = serve(prefix)
    const mirrorFetch = serve(mirror)
    const live = await new RemoteNodeCatalog(prefix, storage(), liveFetch).refresh()
    const copied = await new RemoteNodeCatalog(mirror, storage(), mirrorFetch).refresh()
    expect(copied).toEqual(live)
    expect(live).toHaveLength(1)
    expect(live[0]!.schema).toMatchObject({ type: 'image.resize', pack, displayName: 'Resize Image', searchTerms: ['resample'] })
    expect(live[0]!.schema.items).toMatchObject([
      { kind: 'input', id: 'image' }, { kind: 'input', id: 'width', widget: { widgetType: 'INT', default: 768 } }, { kind: 'output', id: 'result' },
    ])
    expect(live[0]!.pack.platforms).toEqual(['linux', 'darwin'])
    expect(mirrorFetch.mock.calls.map(([url]) => url)).toEqual([`${mirror}/schemas/index.json`, `${mirror}/${path}`])
  })

  it('revalidates cached bodies with ETags, reads them immediately offline, and isolates mirror caches', async () => {
    const cache = storage()
    const fetchFn = serve(prefix)
    const catalog = new RemoteNodeCatalog(`${prefix}/`, cache, fetchFn)
    const first = await catalog.refresh()
    expect(catalog.cached()).toEqual(first)
    fetchFn.mockImplementation(async () => new Response(null, { status: 304 }))
    expect(await catalog.refresh()).toEqual(first)
    expect(fetchFn.mock.calls.slice(2).map(([, init]) => init?.headers)).toEqual([
      { 'If-None-Match': '"index-1"' }, { 'If-None-Match': '"schema-1"' },
    ])
    fetchFn.mockRejectedValue(new TypeError('offline'))
    expect(await new RemoteNodeCatalog(prefix, cache, fetchFn).refresh()).toEqual(first)
    expect(await new RemoteNodeCatalog('https://different.example/static', cache, fetchFn).refresh()).toEqual([])
    expect(await new RemoteNodeCatalog(prefix, storage(), fetchFn).refresh()).toEqual([])
  })

  it('rejects mismatched or malformed schema bodies even when a matching digest is advertised', async () => {
    for (const body of [schemaBody({ packName: 'other-pack' }), schemaBody({ version: '2.0.0' }), schemaBody({ schemas: [{ nodeType: 'bad', schemaWireVersion: 99 }] }), schemaBody({ schemas: [{ nodeType: 'bad', schemaVersion: 1, schemaWireVersion: 1, schemaSignature: 'x', schema: { interface: 'invalid' } }] })]) {
      const catalog = new RemoteNodeCatalog(prefix, storage(), serve(prefix, indexBody(body), body))
      expect(await catalog.refresh()).toEqual([])
      expect(catalog.cached()).toEqual([])
    }
    expect(await new RemoteNodeCatalog(prefix, storage(), serve(prefix, indexBody(), schemaBody({ version: '2.0.0' }))).refresh()).toEqual([])
  })

  it('does not fetch third-party or escaping URLs and does not revive removed discovery entries', async () => {
    for (const changes of [{ publisher: 'someone' }, { url: 'https://other.example/schemas.json' }, { version: '../secret', url: `packs/${pack}/../secret/schemas.json` }]) {
      const fetchFn = serve(prefix, indexBody(schemaBody(), changes))
      expect(await new RemoteNodeCatalog(prefix, storage(), fetchFn).refresh()).toEqual([])
      expect(fetchFn).toHaveBeenCalledTimes(1)
    }
    const cache = storage()
    const fetchFn = serve(prefix)
    const catalog = new RemoteNodeCatalog(prefix, cache, fetchFn)
    expect(await catalog.refresh()).toHaveLength(1)
    fetchFn.mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 1, items: [] })))
    expect(await catalog.refresh()).toEqual([])
    expect(catalog.cached()).toEqual([])
  })

  it('retains validated cached data on invalid refresh, but never substitutes it for a changed digest', async () => {
    const cache = storage()
    const fetchFn = serve(prefix)
    const catalog = new RemoteNodeCatalog(prefix, cache, fetchFn)
    const first = await catalog.refresh()
    fetchFn.mockImplementation(serve(prefix, indexBody(), 'corrupt body'))
    expect(await catalog.refresh()).toEqual(first)
    fetchFn.mockImplementation(serve(prefix, indexBody(schemaBody(), { digest: `sha256:${'a'.repeat(64)}` }), 'corrupt body'))
    expect(await catalog.refresh()).toEqual([])
    expect(catalog.cached()).toEqual([])
  })

  it('coalesces concurrent refreshes and ignores storage failures', async () => {
    const fetchFn = serve(prefix)
    const cache = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
    const catalog = new RemoteNodeCatalog(prefix, cache, fetchFn)
    const a = catalog.refresh()
    const b = catalog.refresh()
    expect(a).toBe(b)
    expect(await a).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(await new RemoteNodeCatalog('', cache, fetchFn).refresh()).toEqual([])
  })
})
