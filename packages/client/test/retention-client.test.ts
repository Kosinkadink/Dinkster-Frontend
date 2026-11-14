import { describe, expect, it } from 'vitest'
import { DinksterConnection, RetentionClient } from '../src/index.js'
import { asConnectionId } from '@dinkster/core'

const generation = '0123456789abcdef0123456789abcdef'
const rotated = 'fedcba9876543210fedcba9876543210'
const holders = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), []]))
const census = (fields: Record<string, unknown> = {}) => ({
  clientId: '11111111111111111111111111111111', generation, revision: 3,
  connected: true, pendingRequests: 0, activeStreams: 0, complete: false, holders, ...fields,
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('backend retention enrollment', () => {
  it('enrolls concurrent HTTP and socket observations once and confines the generation to its backend', async () => {
    const admitted = deferred<Response>()
    const observed: string[] = []
    const client = new RetentionClient('http://backend/prefix', async (url, init) => {
      if (url.endsWith('/retention-clients')) {
        if (init?.method === 'GET') return json(census())
        expect(JSON.parse(init?.body as string)).toEqual({ revision: 0 })
        observed.push('enroll')
        return admitted.promise
      }
      expect(new Headers(init?.headers).get('X-Dinkster-Retention-Generation')).toBe(generation)
      expect(init?.redirect).toBe('error')
      observed.push(url)
      return json({})
    })
    const http = client.fetch('http://backend/prefix/api/nodes')
    const socket = client.socketUrl('ws://backend/prefix/api/events?clientId=one')
    expect(observed).toEqual(['enroll'])
    admitted.resolve(json(census()))
    await http
    expect(new URL(await socket).searchParams.get('retentionGeneration')).toBe(generation)
    await expect(client.fetch('http://registry/prefix/api/nodes')).rejects.toThrow('cannot leave its backend')
    await expect(client.socketUrl('ws://backend/other/api/events')).rejects.toThrow('cannot leave its backend')
    expect(observed).toEqual(['enroll', 'http://backend/prefix/api/nodes'])
  })

  it('enrolls output-profile probes and preserves their status and cancellation', async () => {
    const started = deferred<void>()
    let pending = false
    const client = new RetentionClient('http://backend/prefix', async (url, init) => {
      if (url.endsWith('/retention-clients')) return json(census())
      const target = new URL(url)
      expect(target.pathname).toBe('/prefix/api/output-profiles/model%2Fprofile')
      expect(Object.fromEntries(target.searchParams)).toEqual({ digest: 'blake3:abc', revision: 'r+2' })
      expect(new Headers(init?.headers).get('X-Dinkster-Retention-Generation')).toBe(generation)
      if (!pending) return json({ error: 'Refused' }, 409)
      started.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    const connection = new DinksterConnection({ id: asConnectionId('probe'), baseUrl: 'http://backend/prefix',
      clientId: 'probe', retentionClient: client })
    const controller = new AbortController()
    const response = await connection.probeOutputProfile('model/profile', 'blake3:abc', 'r+2', controller.signal)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Refused' })
    pending = true
    const probe = connection.probeOutputProfile('model/profile', 'blake3:abc', 'r+2', controller.signal)
    const rejected = expect(probe).rejects.toThrow('Probe closed')
    await started.promise
    controller.abort(new Error('Probe closed'))
    await rejected
  })

  it('reopens a stored client from the freshly read revision and disconnects without releasing owners', async () => {
    let saved = generation
    let disconnected = false
    const client = new RetentionClient('http://backend', async (_url, init) => {
      expect(new Headers(init?.headers).get('X-Dinkster-Retention-Generation')).toBe(disconnected ? rotated : generation)
      if (init?.method === 'GET') return json(census({ connected: false, revision: 17 }))
      if (init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toEqual({ revision: 17 })
        return json(census({ generation: rotated, revision: 18 }))
      }
      expect(init?.method).toBe('DELETE')
      expect(JSON.parse(init?.body as string)).toEqual({})
      return json(census({ generation: rotated, connected: false, revision: 18 }))
    }, { getItem: () => saved, setItem: (_key, value) => { saved = value } })
    expect(await client.enroll()).toBe(rotated)
    expect(saved).toBe(rotated)
    disconnected = true
    await client.disconnect()
  })

  it('keeps observations outside a quiescent census window and resumes streams after a refused clear', async () => {
    const inWindow = deferred<void>()
    const finish = deferred<void>()
    let paused = false
    let acknowledged = false
    let observed = false
    let resumes = 0
    const snapshot = census()
    const client = new RetentionClient('http://backend', async (url, init) => {
      if (url.endsWith('/retention-clients')) {
        if (init?.method === 'GET') {
          expect(paused).toBe(true)
          return json(snapshot)
        }
        if (init?.method === 'PUT') {
          expect(paused).toBe(true)
          expect(JSON.parse(init.body as string)).toEqual({ revision: snapshot.revision, holders: snapshot.holders })
          acknowledged = true
          return json(census({ complete: true }))
        }
        return json(snapshot)
      }
      if (url.endsWith('/clear')) {
        expect(paused && acknowledged).toBe(true)
        return json({ collectionEnabled: false, blocked: ['other_client_incomplete'] }, 409)
      }
      observed = true
      return json({})
    })
    client.registerStream(() => {
      paused = true
      return () => { paused = false; resumes += 1 }
    })
    const collection = client.collect(async (fetchFn) => {
      inWindow.resolve()
      await finish.promise
      return fetchFn('http://backend/api/library/storage/clear', { method: 'POST' })
    })
    await inWindow.promise
    const read = client.fetch('http://backend/api/assets/one')
    await Promise.resolve()
    expect(observed).toBe(false)
    expect(resumes).toBe(0)
    finish.resolve()
    expect((await collection).status).toBe(409)
    await read
    expect(observed).toBe(true)
    expect(paused).toBe(false)
    expect(resumes).toBe(1)
  })

  it('never acknowledges an incomplete owner and resumes streams when the operation fails', async () => {
    let writes = 0
    let resumed = false
    const client = new RetentionClient('http://backend', async (_url, init) => {
      if (init?.method === 'PUT') writes += 1
      return json(census({ holders: { ...holders, '4': [{ complete: false, ownerId: 'editor' }] } }))
    })
    client.registerStream(() => () => { resumed = true })
    await expect(client.collect(async () => { throw new Error('storage unavailable') })).rejects.toThrow('storage unavailable')
    expect(writes).toBe(0)
    expect(resumed).toBe(true)
  })
})
