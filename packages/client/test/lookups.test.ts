/**
 * The editor's lookup client: equal demand is one call, answers are kept per
 * exact arguments until a trigger, a failed refresh keeps a same-argument
 * answer as stale, and a button press calls at most once on its own budget.
 */
import { describe, expect, it } from 'vitest'
import { createLookupClient, type LookupCall } from '../src/index.js'

interface Seen {
  readonly args: unknown[]
  readonly askedBy: string | undefined
}

/** A host whose answers the test hands out one request at a time. */
function fakeHost() {
  const seen: Seen[] = []
  const waiting: Array<(response: Response) => void> = []
  const fetchFn = (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { args: unknown[]; askedBy?: string }
    seen.push({ args: body.args, askedBy: body.askedBy })
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      waiting.push(resolve)
    })
  }
  const answer = async (status: number, body: unknown): Promise<void> => {
    for (let i = 0; i < 20 && waiting.length === 0; i += 1) await Promise.resolve()
    const next = waiting.shift()
    if (!next) throw new Error('no request is waiting')
    next(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  }
  return { seen, fetchFn, answer, waiting }
}

const call = (node: string, category: string): LookupCall => ({
  nodeType: 'dev.lookups.note',
  node,
  function: 'pack.loras_in',
  args: [category],
})

describe('lookup client', () => {
  it('serves every node asking with equal arguments from one call and keeps the answer', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    const all = Array.from({ length: 50 }, (_, index) => client.request(call(`n${index}`, 'sd')))
    await host.answer(200, { answer: ['sd/x'] })
    const entries = await Promise.all(all)
    expect(host.seen).toHaveLength(1)
    expect(entries.every((entry) => entry.state === 'ready')).toBe(true)
    // Kept until a trigger: asking again does not call.
    expect(await client.request(call('n0', 'sd'))).toEqual({ state: 'ready', answer: ['sd/x'] })
    expect(host.seen).toHaveLength(1)
    client.invalidate(['pack.loras_in'])
    expect(client.isOld(call('n0', 'sd'))).toBe(true)
    const again = client.request(call('n0', 'sd'))
    expect(client.entry(call('n0', 'sd'))).toEqual({ state: 'loading', answer: ['sd/x'] })
    await host.answer(200, { answer: ['sd/x', 'sd/y'] })
    expect(await again).toEqual({ state: 'ready', answer: ['sd/x', 'sd/y'] })
    expect(host.seen).toHaveLength(2)
  })

  it('asks again for a file the host had not checked when its files change, and only for that', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    const unchecked = client.request(call('n0', 'local'))
    await host.answer(409, { error: 'lookup-file-unchecked' })
    expect(await unchecked).toEqual({ state: 'unavailable', reason: 'file-unchecked' })
    const failed = client.request(call('n1', 'broken'))
    await host.answer(500, { error: 'lookup-failed' })
    expect(await failed).toEqual({ state: 'unavailable', reason: 'failed' })
    client.filesChanged()
    // The failure that is not about a file stays until Try again.
    expect(client.entry(call('n1', 'broken'))).toEqual({ state: 'unavailable', reason: 'failed' })
    expect(client.entry(call('n0', 'local'))).toBeUndefined()
    const again = client.request(call('n0', 'local'))
    await host.answer(200, { answer: ['checked'] })
    expect(await again).toEqual({ state: 'ready', answer: ['checked'] })
    expect(host.seen.map((seen) => seen.args)).toEqual([['local'], ['broken'], ['local']])
  })

  it('never shows an answer for other arguments, and a failed refresh is stale only for the same ones', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    const sd = client.request(call('a', 'sd'))
    await host.answer(200, { answer: ['sd/x'] })
    await sd
    // Another category on the same node waits for nothing it may borrow.
    const sdxl = client.request(call('a', 'sdxl'))
    expect(client.entry(call('a', 'sdxl'))).toEqual({ state: 'loading' })
    await host.answer(502, { error: 'lookup-failed' })
    expect(await sdxl).toEqual({ state: 'unavailable', reason: 'failed' })
    const refresh = client.request(call('a', 'sd'), { refresh: true })
    await host.answer(504, { error: 'lookup-timeout' })
    expect(await refresh).toEqual({ state: 'stale', answer: ['sd/x'], reason: 'timeout' })
    // A failure stays until a trigger; showing it does not ask again.
    expect(await client.request(call('a', 'sdxl'))).toEqual({ state: 'unavailable', reason: 'failed' })
    expect(host.seen).toHaveLength(3)
    // An answer that does not fit where it is used keeps the earlier one, stale.
    const misfit = client.request(call('a', 'sd'), { refresh: true, accept: (answer) => Array.isArray(answer) })
    await host.answer(200, { answer: 7 })
    expect(await misfit).toEqual({ state: 'stale', answer: ['sd/x'], reason: 'wrong-shape' })
  })

  it('keeps no answer that arrives after the host moved to another pack catalog', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    client.setPartition({ backend: '', epoch: 3, principal: 0 })
    const flight = client.request(call('a', 'sd'))
    for (let i = 0; i < 20 && host.seen.length === 0; i += 1) await Promise.resolve()
    expect(host.seen).toHaveLength(1)
    // A pack reload replaces the catalog while the call is under way.
    client.setPartition({ backend: '', epoch: 4, principal: 0 })
    await expect(flight).rejects.toThrow('aborted')
    expect(client.entry(call('a', 'sd'))).toBeUndefined()
    // The old request's late answer reaches nobody.
    host.waiting.shift()!(new Response(JSON.stringify({ answer: ['sd/old'] }), { status: 200 }))
    const fresh = client.request(call('a', 'sd'))
    await host.answer(200, { answer: ['sd/new'] })
    expect(await fresh).toEqual({ state: 'ready', answer: ['sd/new'] })
    expect(host.seen).toHaveLength(2)
  })

  it('cancels a shared call only when its last waiter leaves', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    const leaving = new AbortController()
    const first = client.request(call('a', 'sd'), { signal: leaving.signal })
    const second = client.request(call('b', 'sd'))
    leaving.abort()
    await expect(first).rejects.toThrow('aborted')
    await host.answer(200, { answer: ['sd/x'] })
    expect(await second).toEqual({ state: 'ready', answer: ['sd/x'] })
  })

  it('lets a press use a current answer without a call and call once when it is stale', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    const signal = new AbortController().signal
    const shown = client.request(call('a', 'sd'))
    await host.answer(200, { answer: ['sd/x'] })
    await shown
    expect(await client.resolve(call('a', 'sd'), 'options', { signal })).toEqual({ state: 'ready', value: ['sd/x'] })
    expect(host.seen).toHaveLength(1)

    const refresh = client.request(call('a', 'sd'), { refresh: true })
    await host.answer(502, { error: 'lookup-failed' })
    expect((await refresh).state).toBe('stale')
    const pressed = client.resolve(call('a', 'sd'), 'options', { signal })
    await host.answer(502, { error: 'lookup-failed' })
    expect(await pressed).toEqual({ state: 'failed', reason: 'failed' })
    expect(host.seen.map((item) => item.askedBy)).toEqual([undefined, undefined, 'press'])

    const paused = client.resolve(call('a', 'other'), 'value', { signal })
    await host.answer(429, { error: 'lookup-paused' })
    expect(await paused).toEqual({ state: 'paused' })
    const wrong = client.resolve(call('a', 'shape'), 'options', { signal })
    await host.answer(200, { answer: 'not a list' })
    expect(await wrong).toEqual({ state: 'failed', reason: 'wrong-shape' })
  })

  it('asks for one node at a time while other nodes go ahead', async () => {
    const host = fakeHost()
    const client = createLookupClient({ baseUrl: '', fetchFn: host.fetchFn })
    const slow = client.request(call('a', 'sd'))
    const queued = client.request({ ...call('a', 'x'), function: 'pack.other' })
    const elsewhere = client.request(call('b', 'sdxl'))
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    expect(host.seen.map((item) => item.args)).toEqual([['sd'], ['sdxl']])
    host.waiting.splice(1, 1)[0]!(new Response(JSON.stringify({ answer: ['sdxl/y'] }), { status: 200 }))
    expect(await elsewhere).toEqual({ state: 'ready', answer: ['sdxl/y'] })
    await host.answer(200, { answer: ['sd/x'] })
    await slow
    await host.answer(200, { answer: 'note' })
    expect(await queued).toEqual({ state: 'ready', answer: 'note' })
    expect(host.seen.map((item) => item.args)).toEqual([['sd'], ['sdxl'], ['x']])
  })
})
