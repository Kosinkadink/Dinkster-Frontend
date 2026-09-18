import { describe, expect, it, vi } from 'vitest'
import {
  AssetCatalogStore,
  canonicalAssetRef,
  createForeignAssetEnvelope,
  foreignRecordOf,
  resolveAssetCandidates,
  resolveFromAssetSources,
  type AssetReferenceMetadata,
  type AssetSource,
  type AssetSourceMatch,
  type ComfyAssetApiRecord,
  type ComfyWorkflowModelRecord,
} from '../src/asset-browser/asset-source.js'

const DIGEST_A = `blake3:${'a'.repeat(64)}`
const DIGEST_B = `blake3:${'b'.repeat(64)}`

const reference = (name = 'model.safetensors'): AssetReferenceMetadata => ({
  name,
  foreignIds: [{ namespace: 'comfy-asset-reference', value: 'foreign-1' }],
  tags: ['models', 'model_type:checkpoints'],
  provenance: [{ source: 'comfyui', value: 'loader_path:checkpoints/model.safetensors' }],
})

const match = (overrides: Partial<AssetSourceMatch> = {}): AssetSourceMatch => {
  const raw = {
    sourceId: 'mock',
    matchId: 'match-1',
    digest: DIGEST_A,
    digestVerified: true,
    reference: reference(),
    location: { virtualPath: 'mounts/checkpoints/model.safetensors' },
    size: 12,
    mediaType: 'application/octet-stream',
    ...overrides,
  }
  return {
    ...raw,
    envelope: overrides.envelope ?? createForeignAssetEnvelope('mock', { size: raw.size, mediaType: raw.mediaType }),
  }
}

describe('asset content identity and canonical boundary', () => {
  it.each([
    `blake3:${'A'.repeat(64)}`,
    `blake3:${'a'.repeat(63)}`,
    `blake3:${'a'.repeat(65)}`,
    `sha256:${'a'.repeat(64)}`,
    `${'a'.repeat(64)}`,
  ])('rejects non-canonical digest syntax: %s', (digest) => {
    expect(resolveAssetCandidates([match({ digest })])).toEqual({ status: 'unresolved', candidates: [] })
  })

  it('requires explicit digest verification and never treats a foreign id as authority', () => {
    const onlyForeignId = match({ digest: undefined, digestVerified: false })
    const unverifiedDigest = match({ digest: DIGEST_A, digestVerified: false })
    expect(resolveAssetCandidates([onlyForeignId])).toEqual({ status: 'unresolved', candidates: [] })
    expect(resolveAssetCandidates([unverifiedDigest])).toEqual({ status: 'unresolved', candidates: [] })
  })

  it('admits canonical refs only with safe size and non-empty media type', () => {
    const resolution = resolveAssetCandidates([match()])
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') throw new Error('expected resolved')
    expect(canonicalAssetRef(resolution.selected)).toEqual({
      digest: DIGEST_A,
      name: 'model.safetensors',
      size: 12,
      mediaType: 'application/octet-stream',
      virtualPath: 'mounts/checkpoints/model.safetensors',
    })
    for (const partial of [
      match({ size: -1 }),
      match({ size: 1.5 }),
      match({ size: Number.MAX_SAFE_INTEGER + 1 }),
      match({ size: undefined }),
      match({ mediaType: '' }),
      match({ mediaType: '   ' }),
      match({ mediaType: undefined }),
    ]) {
      const result = resolveAssetCandidates([partial])
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') {
        expect(canonicalAssetRef(result.selected)).toBeUndefined()
        expect(result.selected.envelope).toBe(partial.envelope)
        expect(foreignRecordOf(result.selected.envelope)).toEqual({ size: partial.size, mediaType: partial.mediaType })
      }
    }
  })
})

describe('asset candidate resolution discrimination', () => {
  it('returns resolved for exactly one verified digest', () => {
    const result = resolveAssetCandidates([match()])
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.identity.digest).toBe(DIGEST_A)
  })

  it('returns unresolved when no authorized verified match exists', () => {
    expect(resolveAssetCandidates([])).toEqual({ status: 'unresolved', candidates: [] })
    expect(resolveAssetCandidates([match({ location: { virtualPath: '' } })])).toEqual({ status: 'unresolved', candidates: [] })
  })

  it('returns ambiguous for multiple different verified digests', () => {
    const result = resolveAssetCandidates([
      match(),
      match({ digest: DIGEST_B, location: { virtualPath: 'mounts/checkpoints/other/model.safetensors' } }),
    ])
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') expect(result.identities.map((identity) => identity.digest)).toEqual([DIGEST_A, DIGEST_B])
  })

  it('resolves duplicate same-digest locations by virtualPath then source id', () => {
    const result = resolveAssetCandidates([
      match({ sourceId: 'z-source', matchId: 'z', location: { virtualPath: 'mounts/z/model.safetensors' } }),
      match({ sourceId: 'z-source', matchId: 'a', location: { virtualPath: 'mounts/a/model.safetensors' } }),
      match({ sourceId: 'a-source', matchId: 'a', location: { virtualPath: 'mounts/a/model.safetensors' } }),
    ])
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') throw new Error('expected resolved')
    expect(result.candidates.map((candidate) => `${candidate.location.virtualPath}:${candidate.sourceId}`)).toEqual([
      'mounts/a/model.safetensors:a-source',
      'mounts/a/model.safetensors:z-source',
      'mounts/z/model.safetensors:z-source',
    ])
    expect(result.selected).toBe(result.candidates[0])
  })

  it('uses a source-local match id to break exact location and label ties', () => {
    const complete = match({ matchId: 'b' })
    const partial = match({ matchId: 'a', size: undefined })
    for (const input of [[complete, partial], [partial, complete]]) {
      const result = resolveAssetCandidates(input)
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') expect(result.selected.matchId).toBe('a')
    }
  })

  it('aggregates mock sources without granting authority to source-local ids', async () => {
    const source = mockSource('comfy', [match({ sourceId: 'forged', digest: undefined, digestVerified: false })])
    expect(await resolveFromAssetSources([source], { reference: reference() })).toEqual({ status: 'unresolved', candidates: [] })
    expect(source.resolve).toHaveBeenCalledOnce()
  })
})

describe('lossless foreign asset envelopes', () => {
  it('round-trips a complete Comfy Asset API record including unknown fields by identity', () => {
    const foreign: ComfyAssetApiRecord = {
      id: 'ref-1',
      name: 'model.safetensors',
      hash: DIGEST_A,
      asset_hash: DIGEST_A,
      loader_path: 'checkpoints/model.safetensors',
      display_name: null,
      size: 12,
      mime_type: 'application/octet-stream',
      tags: ['models', 'model_type:checkpoints'],
      user_metadata: { favorite: true },
      metadata: { tensors: 42 },
      is_immutable: false,
      future_field: { nested: ['kept', 7, null] },
    }
    const envelope = createForeignAssetEnvelope('comfy-asset-api', foreign, match())
    expect(foreignRecordOf(envelope)).toBe(foreign)
    expect(foreignRecordOf(envelope)).toEqual(foreign)
    expect(foreignRecordOf(envelope).future_field).toEqual({ nested: ['kept', 7, null] })
  })

  it('round-trips workflow models metadata including unknown fields without normalization', () => {
    const foreign: ComfyWorkflowModelRecord = {
      name: 'model.safetensors',
      url: 'https://provider.invalid/model.safetensors',
      directory: 'checkpoints',
      hash: 'ABCDEF',
      hash_type: 'sha256',
      provider_extension: { mirrors: ['one', 'two'] },
    }
    const envelope = createForeignAssetEnvelope('comfy-workflow-model', foreign)
    expect(foreignRecordOf(envelope)).toBe(foreign)
    expect(foreignRecordOf(envelope)).toEqual(foreign)
  })
})

function mockSource(id: string, matches: readonly AssetSourceMatch[] = []): AssetSource & {
  resolve: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
} {
  return {
    id,
    label: id,
    resolve: vi.fn().mockResolvedValue(matches),
    query: vi.fn().mockResolvedValue({ items: [], cursor: undefined }),
  }
}

describe('asset catalog store against mock adapters', () => {
  it('transitions query, loading, ready, selection, append, and error state', async () => {
    const first = match()
    const second = match({ location: { virtualPath: 'mounts/checkpoints/b.safetensors' }, reference: reference('b.safetensors') })
    const source = mockSource('mock')
    source.query
      .mockResolvedValueOnce({ items: [{ id: 'a', candidate: first }], cursor: 'next' })
      .mockResolvedValueOnce({ items: [{ id: 'b', candidate: second }] })
      .mockRejectedValueOnce(new Error('catalog offline'))
    const store = new AssetCatalogStore([source], 'mock', 25)

    store.setQuery({ text: 'model', tags: ['models'] })
    expect(store.getState()).toMatchObject({ status: 'idle', items: [], query: { sourceId: 'mock', text: 'model', tags: ['models'] } })
    expect(store.getState().selectedId).toBeUndefined()
    const firstLoad = store.loadMore()
    expect(store.getState().status).toBe('loading')
    await firstLoad
    expect(store.getState()).toMatchObject({ status: 'ready', cursor: 'next', items: [{ id: 'a' }] })
    expect(source.query).toHaveBeenNthCalledWith(1, { text: 'model', tags: ['models'], limit: 25 })

    store.select('a')
    expect(store.getState().selectedId).toBe('a')
    store.select('missing')
    expect(store.getState().selectedId).toBeUndefined()
    await store.loadMore()
    expect(store.getState().items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(source.query).toHaveBeenNthCalledWith(2, { text: 'model', tags: ['models'], limit: 25, cursor: 'next' })

    store.setQuery({ text: 'other' })
    await store.loadMore()
    expect(store.getState()).toMatchObject({ status: 'error', error: 'catalog offline', items: [] })
  })

  it('ignores a stale page after the query changes', async () => {
    let release: ((value: unknown) => void) | undefined
    const source = mockSource('mock')
    source.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    source.query.mockResolvedValueOnce({ items: [{ id: 'new', candidate: match() }] })
    const store = new AssetCatalogStore([source], 'mock')
    store.setQuery({ text: 'old' })
    const stale = store.loadMore()
    store.setQuery({ text: 'new' })
    await store.loadMore()
    release?.({ items: [{ id: 'old', candidate: match() }] })
    await stale
    expect(store.getState().items.map((item) => item.id)).toEqual(['new'])
    expect(store.getState().query.text).toBe('new')
  })

  it('coalesces concurrent loads and stops after a terminal page', async () => {
    let release: ((value: { items: readonly []; cursor?: string }) => void) | undefined
    const source = mockSource('mock')
    source.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const store = new AssetCatalogStore([source], 'mock')
    const first = store.loadMore()
    await store.loadMore()
    expect(source.query).toHaveBeenCalledOnce()
    release?.({ items: [] })
    await first
    await store.loadMore()
    expect(source.query).toHaveBeenCalledOnce()
  })

  it('preserves a continuation cursor across failure and retries that page', async () => {
    const source = mockSource('mock')
    source.query
      .mockResolvedValueOnce({ items: [{ id: 'a', candidate: match() }], cursor: 'next' })
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ items: [{ id: 'b', candidate: match({ matchId: 'b' }) }] })
    const store = new AssetCatalogStore([source], 'mock')
    await store.loadMore()
    await store.loadMore()
    expect(store.getState()).toMatchObject({ status: 'error', error: 'temporary', cursor: 'next' })
    await store.loadMore()
    expect(source.query).toHaveBeenNthCalledWith(3, { text: '', tags: [], limit: 50, cursor: 'next' })
    expect(store.getState().items.map((item) => item.id)).toEqual(['a', 'b'])
  })
})
