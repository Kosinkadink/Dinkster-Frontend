/**
 * peekCandidatesFor unit tests: own-output precedence, producer fallback for
 * never-ran nodes, inline-scalar exclusion, hydrated-descriptor tolerance,
 * dedupe/ordering, and the occurrence-resolver guard.
 *
 * fetchPeekRendition unit tests: candidate order, generic rendition
 * negotiation, and the transient-vs-definitive miss contract the host's
 * negative cache relies on.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CompanionSource, CompanionSourceMap, NodeProgress, NodeSchema } from '@dinkster/core'
import type { RenditionInfo, RenditionResult, ValuePeekResult, ValueQuery } from '@dinkster/client'
import { declaredPreviewCandidates, fetchPeekRendition, peekCandidatesFor, type PeekValues } from '../src/peek-preview.js'

const sourcesOf = (
  entries: Record<string, Record<string, CompanionSource>>,
): CompanionSourceMap =>
  new Map(Object.entries(entries).map(([n, ports]) => [n, new Map(Object.entries(ports))]))

const producer = (node: string, output: string): CompanionSource => ({ kind: 'producer', node, output })

const done = (outputs: Record<string, { typeId: string; value?: string | number | boolean }>): NodeProgress => ({
  state: 'done',
  outputs,
})

const base = {
  sources: new Map() as CompanionSourceMap,
  execNodes: undefined,
  execOutputs: undefined,
  runtimeIdsOf: (id: string) => [id],
}

describe('peekCandidatesFor', () => {
  it('abstains without an occurrence resolver', () => {
    const execNodes = { n1: done({ image: { typeId: 'std.image' } }) }
    expect(peekCandidatesFor({ ...base, execNodes, nodeId: 'n1', runtimeIdsOf: undefined })).toEqual([])
  })

  it('a ran node offers its own non-inline outputs, sorted by output id', () => {
    const execNodes = {
      n1: done({ mask: { typeId: 'std.mask' }, image: { typeId: 'std.image' } }),
    }
    expect(peekCandidatesFor({ ...base, execNodes, nodeId: 'n1' })).toEqual([
      { node: 'n1', output: 'image' },
      { node: 'n1', output: 'mask' },
    ])
  })

  it('inline scalar outputs are excluded (they render as companions)', () => {
    const execNodes = {
      n1: done({ sum: { typeId: 'core.int', value: 42 }, image: { typeId: 'std.image' } }),
    }
    expect(peekCandidatesFor({ ...base, execNodes, nodeId: 'n1' })).toEqual([
      { node: 'n1', output: 'image' },
    ])
  })

  it('a ran node NEVER falls back to producers, even with none of its own', () => {
    const sources = sourcesOf({ n1: { in: producer('p1', 'image') } })
    const execNodes = {
      n1: done({ sum: { typeId: 'core.int', value: 7 } }),
      p1: done({ image: { typeId: 'std.image' } }),
    }
    expect(peekCandidatesFor({ ...base, sources, execNodes, nodeId: 'n1' })).toEqual([])
  })

  it('a never-ran node falls back to producers that DID run', () => {
    const sources = sourcesOf({ preview: { image: producer('sampler', 'image') } })
    const execNodes = { sampler: done({ image: { typeId: 'std.image' } }) }
    expect(peekCandidatesFor({ ...base, sources, execNodes, nodeId: 'preview' })).toEqual([
      { node: 'sampler', output: 'image' },
    ])
  })

  it('a producer resolving to a nested runtime id yields candidates keyed by that runtime id', () => {
    const sources = sourcesOf({ preview: { image: producer('imgsrc', 'image') } })
    const execNodes = { 'inst.imgsrc': done({ image: { typeId: 'std.image' } }) }
    const runtimeIdsOf = (id: string) => (id === 'imgsrc' ? ['inst.imgsrc'] : [])
    expect(peekCandidatesFor({ ...base, sources, execNodes, nodeId: 'preview', runtimeIdsOf })).toEqual([
      { node: 'inst.imgsrc', output: 'image' },
    ])
  })

  it('uses the compiled region state alias for producer value lookup', () => {
    const sources = sourcesOf({ preview: { image: producer('region', 'visible') } })
    const execNodes = { region: done({ state: { typeId: 'std.image' } }) }
    expect(peekCandidatesFor({
      ...base,
      sources,
      execNodes,
      nodeId: 'preview',
      outputAliases: { region: { visible: 'state' } },
    })).toEqual([{ node: 'region', output: 'state' }])
  })

  it('producer outputs that never ran or inlined a scalar are skipped', () => {
    const sources = sourcesOf({
      preview: {
        a: producer('never-ran', 'image'),
        b: producer('scalar', 'sum'),
        c: producer('imgsrc', 'image'),
      },
    })
    const execNodes = {
      scalar: done({ sum: { typeId: 'core.int', value: 3 } }),
      imgsrc: done({ image: { typeId: 'std.image' } }),
    }
    expect(peekCandidatesFor({ ...base, sources, execNodes, nodeId: 'preview' })).toEqual([
      { node: 'imgsrc', output: 'image' },
    ])
  })

  it('two inputs from the same producer output dedupe to one candidate', () => {
    const sources = sourcesOf({
      preview: { a: producer('imgsrc', 'image'), b: producer('imgsrc', 'image') },
    })
    const execNodes = { imgsrc: done({ image: { typeId: 'std.image' } }) }
    expect(peekCandidatesFor({ ...base, sources, execNodes, nodeId: 'preview' })).toEqual([
      { node: 'imgsrc', output: 'image' },
    ])
  })

  it('hydrated job-result descriptors count for both own outputs and producers', () => {
    const execOutputs = {
      target: { image: { typeId: 'std.image', fingerprint: 'fp' } },
    }
    // Own: the target node's descriptors are candidates.
    expect(peekCandidatesFor({ ...base, execOutputs, nodeId: 'target' })).toEqual([
      { node: 'target', output: 'image' },
    ])
    // Producer: a never-ran consumer resolves against the same descriptors.
    const sources = sourcesOf({ preview: { in: producer('target', 'image') } })
    expect(peekCandidatesFor({ ...base, sources, execOutputs, nodeId: 'preview' })).toEqual([
      { node: 'target', output: 'image' },
    ])
  })

  it('no execution presence anywhere yields nothing', () => {
    const sources = sourcesOf({ preview: { in: producer('p1', 'image') } })
    expect(peekCandidatesFor({ ...base, sources, nodeId: 'preview' })).toEqual([])
  })

  it('orders recorded outputs by schema/interface order instead of output id', () => {
    const execNodes = { n1: done({ alpha: { typeId: 'std.image' }, zeta: { typeId: 'std.image' } }) }
    expect(peekCandidatesFor({ ...base, execNodes, nodeId: 'n1', outputOrder: ['zeta', 'alpha'] })).toEqual([
      { node: 'n1', output: 'zeta' },
      { node: 'n1', output: 'alpha' },
    ])
  })

  it('offers only explicit preview:true outputs in schema order', () => {
    const schema = {
      type: 'test.media',
      items: [
        { kind: 'output', id: 'video', type: { kind: 'concrete', name: 'comfy.VIDEO' }, preview: true },
        { kind: 'output', id: 'unmarkedAudio', type: { kind: 'concrete', name: 'comfy.AUDIO' } },
        { kind: 'output', id: 'audio', type: { kind: 'concrete', name: 'comfy.AUDIO' }, preview: true },
      ],
    } as unknown as NodeSchema
    expect(declaredPreviewCandidates(schema, ['runtime'])).toEqual([
      { node: 'runtime', output: 'video', declaredIntent: true, mediaKind: 'video' },
      { node: 'runtime', output: 'audio', declaredIntent: true, mediaKind: 'audio' },
    ])
  })

  it('carries media intent through list output types', () => {
    const schema = {
      type: 'test.list-media',
      items: [{ kind: 'output', id: 'videos', type: { kind: 'list', element: { kind: 'concrete', name: 'comfy.VIDEO' } }, preview: true }],
    } as unknown as NodeSchema
    expect(declaredPreviewCandidates(schema, ['runtime'])).toEqual([
      { node: 'runtime', output: 'videos', declaredIntent: true, mediaKind: 'video' },
    ])
  })

  it('carries VIDEO intent through typed AssetRef outputs', () => {
    const schema = {
      type: 'test.video-asset',
      items: [{
        kind: 'output',
        id: 'video',
        type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.VIDEO' } },
        preview: true,
      }],
    } as unknown as NodeSchema
    expect(declaredPreviewCandidates(schema, ['runtime'])).toEqual([
      { node: 'runtime', output: 'video', declaredIntent: true, mediaKind: 'video' },
    ])
  })

  it('carries model3d intent through concrete and asset-typed outputs', () => {
    const schema = {
      type: 'test.model3d',
      items: [
        { kind: 'output', id: 'model', type: { kind: 'concrete', name: 'dinkster.model3d' }, preview: true },
        {
          kind: 'output',
          id: 'saved',
          type: { kind: 'asset', element: { kind: 'concrete', name: 'dinkster.model3d' } },
          preview: true,
        },
      ],
    } as unknown as NodeSchema
    expect(declaredPreviewCandidates(schema, ['runtime'])).toEqual([
      { node: 'runtime', output: 'model', declaredIntent: true, mediaKind: 'model3d' },
      { node: 'runtime', output: 'saved', declaredIntent: true, mediaKind: 'model3d' },
    ])
  })

  it('carries splat intent through concrete outputs as model3d', () => {
    const schema = {
      type: 'test.splat',
      items: [{ kind: 'output', id: 'splat', type: { kind: 'concrete', name: 'dinkster.splat' }, preview: true }],
    } as unknown as NodeSchema
    expect(declaredPreviewCandidates(schema, ['runtime'])).toEqual([
      { node: 'runtime', output: 'splat', declaredIntent: true, mediaKind: 'model3d' },
    ])
  })
})

// ---------------------------------------------------------------------------
// fetchPeekRendition
// ---------------------------------------------------------------------------

const descriptor = { typeId: 'std.image', fingerprint: 'fp' }
const png = { kind: 'png', mime: 'image/png', default: true }
const jpg = { kind: 'jpg', mime: 'image/jpeg' }

const hit = (renditions: readonly RenditionInfo[]): ValuePeekResult => ({
  available: true,
  descriptor,
  renditions,
})
const refusal = (reason: string): { available: false; reason: string; status: number; error: string } => ({
  available: false,
  reason,
  status: reason === 'http-error' ? 0 : 404,
  error: reason,
})
const bytesOf = (n: number): ArrayBuffer => new Uint8Array([n]).buffer
const mediaBytes = (mime: 'video/webm' | 'audio/wav'): ArrayBuffer => mime === 'video/webm'
  ? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer
  : new TextEncoder().encode('RIFF0000WAVE').buffer

/** Fake client: scripted per (nodeId, outputId); records queries. */
const fakeValues = (script: {
  peek: Record<string, ValuePeekResult>
  rendition?: Record<string, RenditionResult>
}): PeekValues & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    peek: (q: ValueQuery) => {
      calls.push(`peek:${q.nodeId}.${q.outputId}`)
      return Promise.resolve(script.peek[`${q.nodeId}.${q.outputId}`] ?? refusal('unknown-output'))
    },
    rendition: (q: ValueQuery, kind: string) => {
      calls.push(`rendition:${q.nodeId}.${q.outputId}:${kind}`)
      return Promise.resolve(script.rendition?.[`${q.nodeId}.${q.outputId}`] ?? refusal('no-rendition'))
    },
  }
}

const transientOf = (e: unknown): boolean | undefined => (e as { transient?: boolean }).transient

describe('fetchPeekRendition', () => {
  it('returns the first candidate that peeks and renders, in order', async () => {
    const values = fakeValues({
      peek: { 'a.image': refusal('not-retained'), 'b.image': hit([png]) },
      rendition: {
        'b.image': { available: true, bytes: bytesOf(7), mime: 'image/png', kind: 'png', fingerprint: 'fp' },
      },
    })
    const got = await fetchPeekRendition(values, 'job', [
      { node: 'a', output: 'image' },
      { node: 'b', output: 'image' },
      { node: 'c', output: 'image' },
    ])
    expect(new Uint8Array(got.bytes)).toEqual(new Uint8Array([7]))
    expect(got.mime).toBe('image/png')
    expect(got).toMatchObject({ node: 'b', output: 'image' })
    // c is never touched: the loop stops at the first success.
    expect(values.calls).toEqual(['peek:a.image', 'peek:b.image', 'rendition:b.image:png'])
  })

  it('negotiates the declared default rendition, not a hardcoded kind', async () => {
    const values = fakeValues({
      peek: { 'a.image': hit([jpg, png]) }, // default flag wins over order
      rendition: {
        'a.image': { available: true, bytes: bytesOf(1), mime: 'image/png', kind: 'png', fingerprint: 'fp' },
      },
    })
    await fetchPeekRendition(values, 'job', [{ node: 'a', output: 'image' }])
    expect(values.calls).toContain('rendition:a.image:png')
  })

  it.each(['comfy.VIDEO', 'asset<comfy.VIDEO>'])('uses the bounded preview, never default original bytes, for %s', async (typeId) => {
    const values = fakeValues({
      peek: { 'a.video': {
        available: true, descriptor: { typeId, fingerprint: 'source' },
        renditions: [{ kind: 'original', mime: 'video/mp4', default: true }, { kind: 'preview', mime: 'video/webm' }],
      } },
      rendition: { 'a.video': { available: true, bytes: mediaBytes('video/webm'), mime: 'video/webm', kind: 'preview', fingerprint: 'source' } },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'video' }]))
      .resolves.toMatchObject({ mime: 'video/webm', previewOnly: true })
    expect(values.calls).toEqual(['peek:a.video', 'rendition:a.video:preview'])
  })

  it('makes original-only VIDEO unavailable without fetching or decoding its bytes', async () => {
    const values = fakeValues({ peek: { 'a.video': {
      available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'source' },
      renditions: [{ kind: 'original', mime: 'video/mp4', default: true }],
    } } })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'video' }]))
      .rejects.toMatchObject({ negativeCache: true })
    expect(values.calls).toEqual(['peek:a.video'])
  })

  it('falls back to an advertised poster when the browser refuses the preview codec', async () => {
    const calls: string[] = []
    const values: PeekValues = {
      peek: async () => ({
        available: true, descriptor: { typeId: 'comfy.VIDEO', fingerprint: 'source' },
        renditions: [{ kind: 'preview', mime: 'video/webm' }, { kind: 'poster', mime: 'image/png' }],
      }),
      rendition: async (_query, kind) => {
        calls.push(kind)
        return { available: true, kind, fingerprint: 'source',
          mime: kind === 'preview' ? 'video/webm' : 'image/png',
          bytes: kind === 'preview' ? mediaBytes('video/webm') : bytesOf(1),
        }
      },
    }
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'video' }],
      async ({ mime }) => mime === 'image/png')).resolves.toMatchObject({ mime: 'image/png', previewOnly: true })
    expect(calls).toEqual(['preview', 'poster'])
  })

  it('a successful but unrenderable candidate keeps an exhausted miss retryable', async () => {
    const values = fakeValues({
      peek: {
        'a.image': refusal('not-retained'),
        'b.image': refusal('evicted'),
        'c.image': hit([]), // value exists, nothing renderable
      },
    })
    const err = await fetchPeekRendition(values, 'job', [
      { node: 'a', output: 'image' },
      { node: 'b', output: 'image' },
      { node: 'c', output: 'image' },
    ]).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(transientOf(err)).toBe(true)
  })

  it('a transport failure on peek marks the miss transient (retryable)', async () => {
    const values = fakeValues({
      peek: { 'a.image': refusal('http-error'), 'b.image': refusal('not-retained') },
    })
    const err = await fetchPeekRendition(values, 'job', [
      { node: 'a', output: 'image' },
      { node: 'b', output: 'image' },
    ]).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(transientOf(err)).toBe(true)
  })

  it('a transport failure on the rendition fetch also marks transient', async () => {
    const values = fakeValues({
      peek: { 'a.image': hit([png]) },
      rendition: { 'a.image': refusal('http-error') as RenditionResult },
    })
    const err = await fetchPeekRendition(values, 'job', [{ node: 'a', output: 'image' }]).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(transientOf(err)).toBe(true)
  })

  it('a definitive rendition refusal (no-rendition) stays non-transient', async () => {
    const values = fakeValues({
      peek: { 'a.image': hit([png]) },
      rendition: { 'a.image': refusal('no-rendition') as RenditionResult },
    })
    const err = await fetchPeekRendition(values, 'job', [{ node: 'a', output: 'image' }]).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(transientOf(err)).toBe(false)
  })

  it('an empty candidate list is not negative-cacheable and makes no calls', async () => {
    const values = fakeValues({ peek: {} })
    const err = await fetchPeekRendition(values, 'job', []).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(transientOf(err)).toBe(true)
    expect(values.calls).toEqual([])
  })

  it('requests only list element zero and reports the full descriptor count', async () => {
    const calls: string[] = []
    const values: PeekValues = {
      peek: async (query) => {
        calls.push(`peek:${query.element?.join(',') ?? 'root'}`)
        return query.element === undefined
          ? hit([{ kind: 'wav', mime: 'audio/wav', default: true }]) && {
              available: true,
              descriptor: { typeId: 'list<comfy.AUDIO>', fingerprint: 'list', length: 3 },
              renditions: [],
            }
          : {
              available: true,
              descriptor: { typeId: 'comfy.AUDIO', fingerprint: 'audio' },
              renditions: [{ kind: 'wav', mime: 'audio/wav', default: true }],
            }
      },
      rendition: async (query) => {
        calls.push(`rendition:${query.element?.join(',') ?? 'root'}`)
        return { available: true, bytes: mediaBytes('audio/wav'), mime: 'audio/wav', kind: 'wav', fingerprint: 'audio' }
      },
    }
    await expect(fetchPeekRendition(values, 'job', [{ node: 'n', output: 'audio' }])).resolves.toMatchObject({
      mime: 'audio/wav', count: 3,
    })
    expect(calls).toEqual(['peek:root', 'peek:0'])
  })

  it('skips unsupported MIME and falls back to the next renderable candidate', async () => {
    const values = fakeValues({
      peek: { 'a.out': hit([{ kind: 'raw', mime: 'application/octet-stream', default: true }]), 'b.out': hit([{ kind: 'video', mime: 'video/webm', default: true }]) },
      rendition: {
        'a.out': { available: true, bytes: bytesOf(1), mime: 'application/octet-stream', kind: 'raw', fingerprint: 'a' },
        'b.out': { available: true, bytes: mediaBytes('video/webm'), mime: 'video/webm', kind: 'video', fingerprint: 'b' },
      },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'out' }, { node: 'b', output: 'out' }]))
      .resolves.toMatchObject({ mime: 'video/webm' })
    expect(values.calls).toEqual(['peek:a.out', 'rendition:a.out:raw', 'peek:b.out', 'rendition:b.out:video'])
  })

  it('accepts a GLB rendition with valid magic and version bytes', async () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0x0c, 0, 0, 0]).buffer
    const values = fakeValues({
      peek: { 'a.model': hit([{ kind: 'glb', mime: 'model/gltf-binary', default: true }]) },
      rendition: {
        'a.model': { available: true, bytes: glb, mime: 'model/gltf-binary', kind: 'glb', fingerprint: 'x' },
      },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'model' }]))
      .resolves.toMatchObject({ mime: 'model/gltf-binary' })
  })

  it('accepts a splat PLY rendition with valid magic bytes', async () => {
    const ply = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n').buffer
    const values = fakeValues({
      peek: { 'a.splat': hit([{ kind: 'ply', mime: 'model/ply', default: true }]) },
      rendition: {
        'a.splat': { available: true, bytes: ply, mime: 'model/ply', kind: 'ply', fingerprint: 'x' },
      },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'splat' }]))
      .resolves.toMatchObject({ mime: 'model/ply' })
  })

  it('accepts a splat PLY rendition with a CRLF header line', async () => {
    const ply = new TextEncoder().encode('ply\r\nformat binary_little_endian 1.0\r\n').buffer
    const values = fakeValues({
      peek: { 'a.splat': hit([{ kind: 'ply', mime: 'model/ply', default: true }]) },
      rendition: {
        'a.splat': { available: true, bytes: ply, mime: 'model/ply', kind: 'ply', fingerprint: 'x' },
      },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'splat' }]))
      .resolves.toMatchObject({ mime: 'model/ply' })
  })

  it('rejects PLY bytes with bad magic and falls through to the next candidate', async () => {
    const badPly = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer
    const values = fakeValues({
      peek: {
        'a.splat': hit([{ kind: 'ply', mime: 'model/ply', default: true }]),
        'b.image': hit([png]),
      },
      rendition: {
        'a.splat': { available: true, bytes: badPly, mime: 'model/ply', kind: 'ply', fingerprint: 'x' },
        'b.image': { available: true, bytes: bytesOf(9), mime: 'image/png', kind: 'png', fingerprint: 'y' },
      },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'splat' }, { node: 'b', output: 'image' }]))
      .resolves.toMatchObject({ mime: 'image/png' })
  })

  it('rejects GLB bytes with bad magic and falls through to the next candidate', async () => {
    const badGlb = new Uint8Array([0, 1, 2, 3, 2, 0, 0, 0, 0x0c, 0, 0, 0]).buffer
    const values = fakeValues({
      peek: {
        'a.model': hit([{ kind: 'glb', mime: 'model/gltf-binary', default: true }]),
        'b.image': hit([png]),
      },
      rendition: {
        'a.model': { available: true, bytes: badGlb, mime: 'model/gltf-binary', kind: 'glb', fingerprint: 'x' },
        'b.image': { available: true, bytes: bytesOf(9), mime: 'image/png', kind: 'png', fingerprint: 'y' },
      },
    })
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'model' }, { node: 'b', output: 'image' }]))
      .resolves.toMatchObject({ mime: 'image/png' })
  })

  it('falls through when browser metadata rejects a signature-valid candidate', async () => {
    const values = fakeValues({
      peek: {
        'a.out': hit([{ kind: 'video', mime: 'video/webm', default: true }]),
        'b.out': hit([{ kind: 'video', mime: 'video/webm', default: true }]),
      },
      rendition: {
        'a.out': { available: true, bytes: mediaBytes('video/webm'), mime: 'video/webm', kind: 'video', fingerprint: 'a' },
        'b.out': { available: true, bytes: mediaBytes('video/webm'), mime: 'video/webm', kind: 'video', fingerprint: 'b' },
      },
    })
    const validate = vi.fn(async (_result) => validate.mock.calls.length > 1)
    await expect(fetchPeekRendition(values, 'job', [{ node: 'a', output: 'out' }, { node: 'b', output: 'out' }], validate))
      .resolves.toMatchObject({ mime: 'video/webm' })
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('negative-caches only definitive 404/406/410 refusals', async () => {
    const permanent = fakeValues({ peek: { 'a.out': { ...refusal('gone'), status: 410 } } })
    const temporary = fakeValues({ peek: { 'a.out': { ...refusal('server-error'), status: 503 } } })
    const permanentError = await fetchPeekRendition(permanent, 'job', [{ node: 'a', output: 'out' }]).catch((e: unknown) => e)
    const temporaryError = await fetchPeekRendition(temporary, 'job', [{ node: 'a', output: 'out' }]).catch((e: unknown) => e)
    expect(transientOf(permanentError)).toBe(false)
    expect(transientOf(temporaryError)).toBe(true)
  })
})
