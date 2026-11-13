/**
 * DinksterValuesClient unit tests: /api/values query construction (runtime
 * region node ids, nested element descent, rendition negotiation),
 * recursive descriptor decode, structured refusal mapping (open reason
 * vocabulary), immutable rendition byte caching, and failure tolerance.
 */
import { describe, expect, it } from 'vitest'
import { defaultRenditionOf, DinksterValuesClient, imageAssetRefsOf, type FetchLike } from '../src/index.js'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function harness(respond: (url: string) => Response | undefined) {
  const urls: string[] = []
  const fetchFn: FetchLike = async (url) => {
    urls.push(url)
    const res = respond(url)
    if (!res) throw new Error(`unexpected fetch: ${url}`)
    return res
  }
  const client = new DinksterValuesClient({ baseUrl: 'http://test', clientId: 'client-1', fetchFn })
  return { client, urls }
}

const Q = { jobId: 'job-1', nodeId: 'n0', outputId: 'image' }

const OK_SCALAR = {
  available: true,
  descriptor: { typeId: 'INT', fingerprint: 'fp-int', meta: {}, value: 42 },
  renditions: [],
}

describe('peek: descriptor decode', () => {

  it('decodes declared renditions including pack-registered kinds', async () => {
    const body = {
      available: true,
      descriptor: { typeId: 'std.image', fingerprint: 'fp-img', meta: {} },
      renditions: [
        { kind: 'thumb', mime: 'image/webp' },
        { kind: 'png', mime: 'image/png', cacheKey: 'png/stored-v1', default: true },
      ],
    }
    const { client } = harness(() => jsonResponse(200, body))
    const res = await client.peek(Q)
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.renditions).toEqual([
        { kind: 'thumb', mime: 'image/webp' },
        { kind: 'png', mime: 'image/png', cacheKey: 'png/stored-v1', default: true },
      ])
      expect(defaultRenditionOf(res.renditions)?.kind).toBe('png')
    }
  })

  it('falls back to the first declared rendition when none is default', () => {
    expect(defaultRenditionOf([{ kind: 'a', mime: 'x' }, { kind: 'b', mime: 'y' }])?.kind).toBe('a')
    expect(defaultRenditionOf([])).toBeUndefined()
  })

})

describe('peek: refusals', () => {
  it.each([
    [404, 'unknown-job'],
    [404, 'unknown-output'],
    [404, 'not-retained'],
    [404, 'bad-element'],
    [409, 'not-complete'],
    [410, 'evicted'],
    [406, 'type-not-loadable'],
  ])('maps %i %s to structured data', async (status, reason) => {
    const { client } = harness(() => jsonResponse(status, { available: false, reason, error: `msg ${reason}` }))
    const res = await client.peek(Q)
    expect(res).toEqual({ available: false, reason, status, error: `msg ${reason}` })
  })

  it('preserves authorization codes and messages when the server omits a value reason', async () => {
    const { client } = harness(() => jsonResponse(403, {
      error: 'capability-required',
      message: 'scope shared requires jobs:read',
    }))
    await expect(client.peek(Q)).resolves.toEqual({
      available: false,
      reason: 'capability-required',
      status: 403,
      error: 'scope shared requires jobs:read',
    })
  })

  it('maps a non-JSON error body to http-error with the status', async () => {
    const { client } = harness(() => new Response('nope', { status: 500 }))
    const res = await client.peek(Q)
    expect(res).toEqual({ available: false, reason: 'http-error', status: 500, error: 'HTTP 500' })
  })

  it('maps network failure to a status-0 http-error refusal', async () => {
    const client = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        throw new Error('boom')
      },
    })
    const res = await client.peek(Q)
    expect(res).toEqual({ available: false, reason: 'http-error', status: 0, error: 'boom' })
  })

})

describe('rendition: bytes and immutable cache', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const renditionResponse = (fingerprint: string, kind: string): Response =>
    new Response(PNG.slice().buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        ETag: `"${fingerprint}/${kind}"`,
        'X-Dinkster-Type-Id': 'std.image',
        'X-Dinkster-Fingerprint': fingerprint,
        'X-Dinkster-Rendition': kind,
      },
    })

  it('fetches raw bytes with rendition metadata from headers', async () => {
    const { client, urls } = harness(() => renditionResponse('fp-1', 'png'))
    const res = await client.rendition(Q, 'default')
    expect(new URL(urls[0]!).searchParams.get('rendition')).toBe('default')
    expect(res.available).toBe(true)
    if (res.available) {
      expect(new Uint8Array(res.bytes)).toEqual(PNG)
      expect(res.mime).toBe('image/png')
      expect(res.kind).toBe('png') // the SERVED kind, not the requested 'default'
      expect(res.reportedKind).toBe('png')
      expect(res.fingerprint).toBe('fp-1')
      expect(res.typeId).toBe('std.image')
      expect(res.etag).toBe('"fp-1/png"')
    }
  })

  it.each(['png', 'default'])('requests and rotates the advertised cacheKey for %s callers', async (kind) => {
    let cacheKey = 'png/stored-v1'
    let reads = 0
    const { client, urls } = harness((url) => {
      const selector = new URL(url).searchParams.get('rendition')
      if (selector === null) return jsonResponse(200, {
        available: true,
        descriptor: { typeId: 'std.image', fingerprint: 'fp-1' },
        renditions: [{ kind: 'png', mime: 'image/png', default: true, cacheKey }],
      })
      return new Response(new Uint8Array([++reads]).buffer, { headers: {
        ETag: `"fp-1/${selector}"`,
        'X-Dinkster-Fingerprint': 'fp-1',
        'X-Dinkster-Rendition': 'png',
      } })
    })
    await client.peek(Q)
    const first = await client.rendition(Q, kind)
    expect(await client.rendition(Q, kind)).toEqual(first)
    cacheKey = 'png/stored-v2'
    await client.peek(Q)
    const second = await client.rendition(Q, kind)
    expect(await client.rendition(Q, kind)).toEqual(second)
    expect(urls.filter((url) => new URL(url).searchParams.has('rendition')).map((url) =>
      new URL(url).searchParams.get('rendition'))).toEqual(['png/stored-v1', 'png/stored-v2'])
    expect(reads).toBe(2)
    if (!first.available || !second.available) expect.unreachable('both renditions should succeed')
    else {
      expect(first.kind).toBe('png')
      expect(new Uint8Array(first.bytes)).toEqual(new Uint8Array([1]))
      expect(new Uint8Array(second.bytes)).toEqual(new Uint8Array([2]))
    }
  })

  it.each(['png', 'default'])('registers peek identity changes for existing %s callers', async (kind) => {
    let version: string | undefined = 'v1'
    let fingerprint = 'fp-1'
    let reads = 0
    const { client } = harness((url) => new URL(url).searchParams.has('rendition')
      ? new Response(new Uint8Array([++reads]).buffer, { headers: { ETag: '"opaque"' } })
      : jsonResponse(200, {
        available: true, descriptor: { typeId: 'comfy.IMAGE', fingerprint },
        renditions: [{ kind: 'png', mime: 'image/png', default: true, version }],
      }))
    await client.rendition(Q, kind)
    await client.peek(Q)
    const old = await client.rendition(Q, kind)
    await client.peek(Q)
    expect(await client.rendition(Q, kind)).toEqual(old)
    expect(reads).toBe(2)
    version = 'v2'
    await client.peek(Q)
    const updated = await client.rendition(Q, kind)
    expect(await client.rendition(Q, kind)).toEqual(updated)
    expect(reads).toBe(3)
    fingerprint = 'fp-2'
    await client.peek(Q)
    await client.rendition(Q, kind)
    expect(reads).toBe(4)
    version = undefined
    await client.peek(Q)
    await client.rendition(Q, kind)
    expect(reads).toBe(5)
  })

  it('does not revive cached v1 bytes when an older peek finishes after a successful v2 peek', async () => {
    let version = 'v1'
    let peeks = 0
    let reads = 0
    let finishPeek!: () => void
    let beginPeek!: () => void
    const peekStarted = new Promise<void>((resolve) => { beginPeek = resolve })
    const { client } = harness((url) => {
      if (new URL(url).searchParams.has('rendition')) {
        reads++
        return new Response(version, { headers: { ETag: `"${version}"` } })
      }
      const response = jsonResponse(200, {
        ...OK_SCALAR, renditions: [{ kind: 'png', mime: 'image/png', version }],
      })
      if (++peeks === 2) {
        const readText = response.text.bind(response)
        response.text = async () => {
          const text = await readText()
          beginPeek()
          return new Promise((resolve) => { finishPeek = () => resolve(text) })
        }
      }
      return response
    })
    await client.peek(Q)
    expect(await client.rendition(Q, 'png')).toMatchObject({ available: true, etag: '"v1"' })
    const older = client.peek(Q)
    await peekStarted
    version = 'v2'
    await client.peek(Q)
    const current = await client.rendition(Q, 'png')
    expect(current).toMatchObject({ available: true, etag: '"v2"' })
    finishPeek()
    expect(await older).toMatchObject({ available: true, renditions: [{ version: 'v1' }] })
    expect(await client.rendition(Q, 'png')).toEqual(current)
    expect(reads).toBe(2)
  })

  it('isolates element, frame, and window bytes with the same fingerprint and kind', async () => {
    let nextByte = 1
    const { client, urls } = harness(() => new Response(new Uint8Array([nextByte++]).buffer, {
      headers: {
        ETag: '"shared-etag"',
        'X-Dinkster-Fingerprint': 'same-fp',
        'X-Dinkster-Rendition': 'preview',
      },
    }))
    const element = await client.rendition({ ...Q, element: [1] }, 'preview')
    const frame = await client.rendition(Q, 'preview', { frame: 1 })
    const window = await client.rendition(Q, 'preview', { window: { start: 1, duration: 2 } })
    const elementAgain = await client.rendition({ ...Q, element: [1] }, 'preview')
    const frameAgain = await client.rendition(Q, 'preview', { frame: 1 })
    const windowAgain = await client.rendition(Q, 'preview', { window: { start: 1, duration: 2 } })

    expect(urls).toHaveLength(3)
    const byte = (result: Awaited<ReturnType<DinksterValuesClient['rendition']>>): number | undefined =>
      result.available ? new Uint8Array(result.bytes)[0] : undefined
    expect([element, frame, window].map(byte)).toEqual([1, 2, 3])
    expect([elementAgain, frameAgain, windowAgain].map(byte)).toEqual([1, 2, 3])
  })

  it('does not alias distinct jobs or outputs', async () => {
    const { client, urls } = harness((url) => {
      const u = new URL(url)
      return renditionResponse(`fp-${u.searchParams.get('jobId')}-${u.searchParams.get('outputId')}`, 'png')
    })
    const a = await client.rendition({ ...Q, jobId: 'job-a' }, 'png')
    const b = await client.rendition({ ...Q, jobId: 'job-b' }, 'png')
    const c = await client.rendition({ ...Q, jobId: 'job-a', outputId: 'mask' }, 'png')
    expect(urls).toHaveLength(3)
    if (a.available && b.available && c.available) {
      expect(a.fingerprint).toBe('fp-job-a-image')
      expect(b.fingerprint).toBe('fp-job-b-image')
      expect(c.fingerprint).toBe('fp-job-a-mask')
    } else {
      expect.unreachable('all three renditions should be available')
    }
  })

  it.each([
    [400, 'invalid-rendition'],
    [406, 'unavailable-rendition'],
    [404, 'bad-element'],
  ])('preserves published rendition refusal %i %s', async (status, reason) => {
    const { client } = harness(() => jsonResponse(status, { available: false, reason, error: reason }))
    expect(await client.rendition(Q, 'pack-kind')).toEqual({ available: false, reason, status, error: reason })
  })

  it('passes signals to fetch and structures fetch aborts and failures', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | null | undefined
    const aborting = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async (_url, init) => {
        receivedSignal = init?.signal
        controller.abort()
        throw new DOMException('stopped', 'AbortError')
      },
    })
    expect(await aborting.rendition(Q, 'png', { signal: controller.signal }))
      .toMatchObject({ available: false, reason: 'aborted', status: 0 })
    expect(receivedSignal).toBe(controller.signal)

    const failing = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => { throw new Error('offline') },
    })
    expect(await failing.rendition(Q, 'png'))
      .toEqual({ available: false, reason: 'http-error', status: 0, error: 'offline' })
  })

  it('structures response body aborts and failures and never caches them', async () => {
    const controller = new AbortController()
    let calls = 0
    const client = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        calls++
        const response = renditionResponse('fp-1', 'png')
        if (calls === 1) {
          Object.defineProperty(response, 'arrayBuffer', { value: async () => {
            controller.abort()
            throw new DOMException('stopped', 'AbortError')
          } })
        }
        return response
      },
    })
    expect(await client.rendition(Q, 'png', { signal: controller.signal }))
      .toMatchObject({ available: false, reason: 'aborted', status: 0 })
    expect(await client.rendition(Q, 'png')).toMatchObject({ available: true })
    expect(calls).toBe(2)

    const failing = new DinksterValuesClient({
      baseUrl: 'http://test',
      clientId: 'c',
      fetchFn: async () => {
        const response = renditionResponse('fp-1', 'png')
        Object.defineProperty(response, 'arrayBuffer', { value: async () => { throw new Error('stream reset') } })
        return response
      },
    })
    expect(await failing.rendition(Q, 'png'))
      .toEqual({ available: false, reason: 'http-error', status: 0, error: 'stream reset' })
  })
})

describe('imageAssetRefsOf', () => {
  const digest = `blake3:${'d'.repeat(64)}`
  const asset = (over?: Record<string, unknown>) => ({
    typeId: 'ASSET',
    fingerprint: digest,
    meta: { digest, mediaType: 'image/png', name: 'out.png', ...over },
  })

  it('extracts a single image asset with its name', () => {
    expect(imageAssetRefsOf(asset())).toEqual([{ digest, mediaType: 'image/png', name: 'out.png' }])
  })

  it('recognizes typed-asset stamps (asset<comfy.IMAGE>), incl. inside a typed list', () => {
    // Since the backend's declaration migration (72c0719), save_image
    // outputs stamp asset<comfy.IMAGE> instead of the bare atom - the
    // exact live job-result shape the outputs panel renders.
    expect(imageAssetRefsOf({ ...asset(), typeId: 'asset<comfy.IMAGE>' }))
      .toEqual([{ digest, mediaType: 'image/png', name: 'out.png' }])
    const list = {
      typeId: 'list<asset<comfy.IMAGE>>',
      fingerprint: 'fp-list',
      length: 1,
      elements: [{ ...asset(), typeId: 'asset<comfy.IMAGE>' }],
    }
    expect(imageAssetRefsOf(list).map((r) => r.digest)).toEqual([digest])
    // Malformed near-misses stay rejected: the atom grammar owns the check.
    expect(imageAssetRefsOf({ ...asset(), typeId: 'asset<comfy.IMAGE' })).toEqual([])
  })

  it('recurses into list elements and dedupes by digest', () => {
    const list = {
      typeId: 'list<ASSET>',
      fingerprint: 'fp-list',
      length: 3,
      elements: [asset(), asset(), asset({ digest: `blake3:${'e'.repeat(64)}` })],
    }
    expect(imageAssetRefsOf(list).map((r) => r.digest)).toEqual([digest, `blake3:${'e'.repeat(64)}`])
  })

  it('skips non-image media types, missing digests, and non-asset types', () => {
    expect(imageAssetRefsOf(asset({ mediaType: 'application/json' }))).toEqual([])
    expect(imageAssetRefsOf({ typeId: 'ASSET', fingerprint: 'x', meta: { mediaType: 'image/png' } })).toEqual([])
    expect(imageAssetRefsOf({ typeId: 'comfy.IMAGE', fingerprint: 'x', meta: { digest, mediaType: 'image/png' } })).toEqual([])
  })

})
