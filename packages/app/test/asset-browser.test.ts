import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DinksterConnection, RetainedAssetOwner, RetainedAssetDeclaration } from '@dinkster/client'
import { assetSourcesStatus, committableAssetRef, isBrowserPreviewable, isCompatible, mediaKindForAccept } from '../src/asset-browser/helpers.js'
import { assetCollectionSource, assetEntryOf, assetEntryPickable } from '../src/asset-browser/collection-adapter.js'
import { clearMetadataCache, inspectAssetMetadata } from '../src/asset-browser/metadata.js'
import { mountAssetSource, mountAssetSources, normalizeMountEntry } from '../src/asset-browser/mountAssetSource.js'
import { localAssetSource } from '../src/asset-browser/localAssetSource.js'
import type { AssetBrowserItem, AssetSourceAdapter } from '../src/asset-browser/types.js'
import { initializeProjectScope } from '../src/projects.js'

const poster = vi.hoisted(() => vi.fn(async (_url: string, _mime: string) => 'data:image/png;base64,poster'))
vi.mock('../src/model3d-viewer.js', () => ({ renderModel3dPosterUrl: poster }))

const item = normalizeMountEntry('mount:m', 'm', { virtualPath: 'images/a.png', name: 'a.png', digest: 'blake3:a', size: 12, mediaType: 'image/png', kind: 'media/image' })
function previewFixture() {
  const entries = new Map<string, string>()
  const storage = { get length() { return entries.size }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
  vi.stubGlobal('localStorage', storage)
  const listeners = new Set<() => void>()
  const retainAssets = vi.fn(async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => ({ ...owner, ...declaration, revision: 1 }))
  const fetchRetainedAssets = vi.fn().mockResolvedValue(undefined)
  const releaseRetainedAssets = vi.fn()
  const fetchAssetBytes = vi.fn().mockResolvedValue(new Uint8Array([17, 31, 7]).buffer)
  const connection = { id: 'browser', assetUrl: (digest: string) => `/assets/${digest}`, retainAssets, fetchRetainedAssets, releaseRetainedAssets, fetchAssetBytes,
    status: { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } } as unknown as DinksterConnection
  let current = true
  const owner = { connection, current: () => current }
  const model = { ...item, digest: `blake3:${'a'.repeat(64)}`, name: 'model.glb', mediaType: 'model/gltf-binary' }
  return { entries, storage, listeners, retainAssets, fetchRetainedAssets, releaseRetainedAssets, fetchAssetBytes, owner,
    stale: () => { current = false }, entry: assetEntryOf(model, connection.assetUrl, owner) }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); initializeProjectScope('default') })

it.each(['accepted', 'refused', 'mismatched', 'project', 'connection', 'closed'])(
  'admits image bodies before creating self-contained local URLs: %s', async (scenario) => {
    const f = previewFixture()
    const digest = `blake3:${'b'.repeat(64)}`
    const entry = assetEntryOf({ ...item, digest }, f.owner.connection.assetUrl, f.owner)
    let admit!: () => void
    const admission = new Promise<void>((resolve) => { admit = resolve })
    f.retainAssets.mockImplementation(async (owner, declaration) => {
      await admission
      if (scenario === 'refused') throw new Error('refused')
      return { ...owner, ...declaration, revision: scenario === 'mismatched' ? 2 : 1 }
    })
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-image')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const abort = new AbortController()
    const pending = entry.thumbRender!(abort.signal).then((url) => url, () => 'refused')
    await vi.waitFor(() => expect(f.retainAssets).toHaveBeenCalledTimes(1))
    expect(f.fetchAssetBytes).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
    if (scenario === 'project') initializeProjectScope('different-project')
    if (scenario === 'connection') for (const listener of f.listeners) listener()
    if (scenario === 'closed') abort.abort()
    admit()
    expect(await pending).toBe(scenario === 'accepted' ? 'blob:owned-image' : 'refused')
    expect(f.fetchAssetBytes).toHaveBeenCalledTimes(scenario === 'accepted' ? 1 : 0)
    expect(createUrl).toHaveBeenCalledTimes(scenario === 'accepted' ? 1 : 0)
    expect(f.listeners.size).toBe(0)
    expect(f.releaseRetainedAssets).not.toHaveBeenCalled()
    if (scenario === 'accepted') {
      const blob = createUrl.mock.calls[0]![0] as Blob
      expect(blob.type).toBe('image/png')
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([17, 31, 7])
      expect(revokeUrl).not.toHaveBeenCalled()
      abort.abort()
      expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:owned-image')
    }
  },
)

it('renders model thumbnails from enrolled bytes and revokes the temporary source', async () => {
  const f = previewFixture()
  const createUrl = vi.spyOn(URL, 'createObjectURL')
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  poster.mockImplementationOnce(async (url, mime) => {
    expect(url).toMatch(/^blob:/)
    const bytes = await fetch(url).then((response) => response.arrayBuffer())
    return `${mime}:${[...new Uint8Array(bytes)].join(',')}`
  })
  expect(await f.entry.thumbRender!(new AbortController().signal)).toBe('model/gltf-binary:17,31,7')
  expect(revoke).toHaveBeenCalledWith(createUrl.mock.results[0]!.value)
})

describe('local recorded asset source', () => {
  it('retains aliases and job provenance, but never picks or previews missing bytes', async () => {
    const held = { ...item, digest: `blake3:${'a'.repeat(64)}`, name: 'same.png' }
    const missing = { ...held, digest: `blake3:${'b'.repeat(64)}` }
    const listLocalAssets = vi.fn().mockResolvedValue({ assets: [held, missing].map((asset) => ({
      asset, aliases: ['original.png', 'same.png'], observations: [{
        id: 'job', asset, originalName: 'original.png', kind: 'media/image', project: 'default', created: 100,
        origin: { kind: 'produced', job: 'job-123', node: 'save' },
      }],
    })), cursor: 'next' })
    const source = localAssetSource({ listLocalAssets,
      checkAssetAvailability: vi.fn().mockResolvedValue([{ digest: held.digest, status: 'available' }, { digest: missing.digest, status: 'missing' }]),
    } as unknown as DinksterConnection)
    const page = await source.page({ query: 'original', kind: 'media/*', limit: 24 })
    expect(page.cursor).toBe('next')
    expect(listLocalAssets).toHaveBeenCalledWith({ scope: 'local', q: 'original', limit: 24 })
    expect(page.items.map((row) => row.id)).toEqual([`local-assets:${held.digest}`, `local-assets:${missing.digest}`])
    expect(committableAssetRef(page.items[0]!)).toEqual({ digest: held.digest, name: held.name, size: held.size, mediaType: held.mediaType, virtualPath: held.virtualPath })
    expect(page.items[0]!.details).toContainEqual({ label: 'Origin job', text: 'job-123' })
    expect(page.items[0]!.details).toContainEqual({ label: 'Aliases', text: 'original.png, same.png' })
    const absent = assetEntryOf(page.items[1]!, (digest) => `/assets/${digest}`)
    expect(absent.badges).toContain('missing')
    expect(absent.thumbUrl).toBeUndefined()
    expect(absent.thumbRender).toBeUndefined()
    expect(assetEntryPickable(['image/*'], 'media/image')(absent)).toBe(false)
    expect(committableAssetRef(page.items[1]!)).toBeUndefined()
  })
})

describe('asset browser helpers', () => {
  it('intersects MIME and semantic kind and rejects unprovable rows', () => {
    expect(isCompatible(item, ['image/*'], 'media/*')).toBe(true)
    expect(isCompatible(item, ['video/*'], 'media/*')).toBe(false)
    const { mediaType: _mediaType, ...withoutMediaType } = item
    expect(isCompatible(withoutMediaType, [], undefined)).toBe(false)
    const latent = { ...item, name: 'example.LATENT', mediaType: 'application/x-comfy-latent', kind: 'data/latent' }
    expect(isCompatible(latent, ['.latent'], 'data/latent')).toBe(true)
    expect(isCompatible({ ...latent, name: 'example.latent.bak' }, ['.latent'], 'data/latent')).toBe(false)
    expect(isCompatible(latent, ['.latent'], 'media/image')).toBe(false)
  })
  it('accepts video wildcard browse rows without admitting image or audio MIME types', () => {
    const video = { ...item, name: 'clip.webm', mediaType: 'video/webm', kind: 'media/video' }
    expect(isCompatible(video, ['video/*'], 'media/video')).toBe(true)
    expect(isCompatible(video, ['video/mp4'], 'media/video')).toBe(false)
    expect(isCompatible(item, ['video/*'], 'media/video')).toBe(false)
    expect(isCompatible({ ...video, mediaType: 'audio/wav', kind: 'media/audio' }, ['video/*'], 'media/video')).toBe(false)
    expect(isCompatible(video, ['*/*'], 'media/*')).toBe(true)
  })
  it('derives media compatibility from MIME when mounted rows omit kind', () => {
    const { kind: _kind, ...kindless } = item
    expect(isCompatible(kindless, ['image/*'], 'media/image')).toBe(true)
    expect(isCompatible(kindless, ['image/*'], 'media/*')).toBe(true)
    expect(isCompatible(kindless, ['image/*'], 'model/*')).toBe(false)
    expect(isCompatible({ ...kindless, mediaType: 'application/x-safetensors' }, [], 'model/*')).toBe(false)
  })
  it('derives a semantic scope only from homogeneous browser media MIME lists', () => {
    expect(mediaKindForAccept(['image/png', 'image/jpeg', 'image/webp'])).toBe('media/image')
    expect(mediaKindForAccept(['audio/*'])).toBe('media/audio')
    expect(mediaKindForAccept(['image/png', 'application/octet-stream'])).toBeUndefined()
    expect(mediaKindForAccept(['application/octet-stream'])).toBeUndefined()
    expect(mediaKindForAccept([])).toBeUndefined()
  })
  it('never accepts a folder row - the Choose guard rests on this (AP10)', () =>
    expect(isCompatible({ ...item, folder: true }, ['image/*'], 'media/*')).toBe(false))
  it('applies conservative image preview policy', () => {
    expect(isBrowserPreviewable(item)).toBe(true)
    expect(isBrowserPreviewable({ ...item, kind: 'model/lora' })).toBe(false)
    expect(isBrowserPreviewable({ ...item, mediaType: 'video/mp4' })).toBe(false)
  })
})

describe('asset -> collection adapter', () => {
  it('maps folder rows to navigation entries without a ref (AP10)', () => {
    const folder: AssetBrowserItem = { id: 'mount:m:sub', name: 'sub', folder: true, childCount: 3, virtualPath: 'sub', source: { id: 'mount:m', label: 'm' } }
    const entry = assetEntryOf(folder)
    expect(entry.folder).toEqual({ path: 'sub' })
    expect(entry.ref).toBeUndefined()
    expect(entry.badges).toEqual(['folder', '3 items'])
    // and therefore the pick predicate can never accept it
    expect(assetEntryPickable([], undefined)(entry)).toBe(false)
  })
  it('refuses an entry missing a committed-AssetRef field: pickable means COMMITTABLE', () => {
    // A size-less row would render an enabled Choose whose commit silently
    // does nothing (the widget's boundary guard refuses it).
    const { size: _size, ...sizeless } = item
    expect(assetEntryPickable([], undefined)(assetEntryOf(sizeless))).toBe(false)
    expect(assetEntryPickable([], undefined)(assetEntryOf(item))).toBe(true)
  })
  it('refuses malformed sizes the ASSET widget validator would reject', () => {
    // Pickable derives from committableAssetRef, which requires a real
    // byte count (safe non-negative integer) - not merely a present size.
    // Malformed server/adapter data must hide the row, not let Choose
    // commit an AssetRef the widget boundary then refuses.
    const pickable = assetEntryPickable([], undefined)
    for (const size of [null, 'big', -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(pickable(assetEntryOf({ ...item, size: size as unknown as number }))).toBe(false)
    }
    expect(pickable(assetEntryOf({ ...item, size: 0 }))).toBe(true)
  })
  it('committableAssetRef yields the exact committed descriptor, defaulting virtualPath', () => {
    expect(committableAssetRef(item)).toEqual({
      digest: item.digest, name: item.name, size: item.size, mediaType: item.mediaType, virtualPath: item.virtualPath,
    })
    const { virtualPath: _vp, ...pathless } = item
    expect(committableAssetRef(pathless)?.virtualPath).toBe('')
    const { digest: _d, ...digestless } = item
    expect(committableAssetRef(digestless)).toBeUndefined()
    expect(committableAssetRef({ ...item, folder: true })).toBeUndefined()
  })
})

describe('asset collection source paging', () => {
  const folderRow: AssetBrowserItem = { id: 'mount:m:sub', name: 'sub', folder: true, virtualPath: 'sub', source: { id: 'mount:m', label: 'm' } }
  const adapterWith = (page: AssetSourceAdapter['page'], listFolder?: AssetSourceAdapter['listFolder']): AssetSourceAdapter => ({
    id: 'mount:m', label: 'm', sourceLabel: 'm',
    capabilities: { folders: listFolder !== undefined, query: true, kindFilter: true, thumbnails: true, actions: false },
    page,
    ...(listFolder !== undefined ? { listFolder } : {}),
  })

  it('prepends folder rows only on a fresh unqueried first page', async () => {
    const page = vi.fn().mockResolvedValue({ items: [item] })
    const listFolder = vi.fn().mockResolvedValue({ folders: [folderRow] })
    const source = assetCollectionSource(adapterWith(page, listFolder))
    const fresh = await source.page({ query: '', limit: 24 })
    expect(fresh.items.map((e) => e.id)).toEqual(['mount:m:sub', item.id])
    // appends must not repeat folder rows; a query result is mount-wide
    const appended = await source.page({ query: '', limit: 24, cursor: 'c2' })
    expect(appended.items.map((e) => e.id)).toEqual([item.id])
    const queried = await source.page({ query: 'cat', limit: 24 })
    expect(queried.items.map((e) => e.id)).toEqual([item.id])
    expect(listFolder).toHaveBeenCalledTimes(1)
  })

  it('prefers atomic page folders over separately listed folders', async () => {
    const atomic = { ...folderRow, id: 'mount:m:atomic', name: 'atomic', virtualPath: 'atomic' }
    const page = vi.fn().mockResolvedValue({ items: [item], folders: [atomic] })
    const listFolder = vi.fn().mockResolvedValue({ folders: [folderRow] })
    const result = await assetCollectionSource(adapterWith(page, listFolder)).page({ query: '', limit: 24 })
    expect(result.items.map((entry) => entry.id)).toEqual(['mount:m:atomic', item.id])
  })

  it('offers open-vocabulary kind options observed from unscoped browsing', async () => {
    const page = vi.fn().mockResolvedValue({ items: [item, { ...item, id: 'b', kind: 'future/thing' }] })
    const source = assetCollectionSource(adapterWith(page))
    const options = (): readonly string[] => source.filters![0]!.options().map((o) => o.value)
    expect(options()).toEqual([])
    await source.page({ query: '', limit: 24 })
    expect(options()).toEqual(['future/thing', 'media/image'])
  })

  it('fixes a picker kind at the source and offers no All kinds escape', async () => {
    const page = vi.fn().mockResolvedValue({ items: [item] })
    const source = assetCollectionSource(adapterWith(page), { fixedKind: 'model/checkpoint' })
    expect(source.filters).toBeUndefined()
    await source.page({ query: 'sd15', limit: 24, filters: { kind: '' } })
    expect(page).toHaveBeenCalledWith({ query: 'sd15', limit: 24, kind: 'model/checkpoint' })
  })
})

describe('mount source discovery', () => {
  it('browses ready and scanning mounts while excluding pending and failed mounts', async () => {
    // The live server exposed comfy-input and comfy-models as mode 'read';
    // a filter written against the invented 'readonly' vocabulary silently
    // hid both, leaving only comfy-output browsable.
    const listMountEntries = vi.fn().mockResolvedValue({ entries: [item.rawRef] })
    const connection = {
      listMounts: () => Promise.resolve([
        { id: 'comfy-input', mode: 'read', state: 'ready' },
        { id: 'comfy-models', mode: 'read', state: 'ready' },
        { id: 'comfy-output', mode: 'readwrite', state: 'ready' },
        { id: 'indexing', mode: 'read', state: 'scanning' },
        { id: 'queued', mode: 'read', state: 'pending' },
        { id: 'broken', mode: 'read', state: 'failed' },
      ]),
      listMountEntries,
    } as unknown as DinksterConnection
    const sources = await mountAssetSources(connection)
    expect(sources.map((source) => source.label)).toEqual(['comfy-input', 'comfy-models', 'comfy-output', 'indexing'])
    const scanningPage = await sources[3]!.page({ query: '', limit: 24 })
    expect(scanningPage.items.map((entry) => entry.name)).toEqual(['a.png'])
    expect(listMountEntries).toHaveBeenCalledWith('indexing', { path: '', recursive: false, limit: 24 })
  })

  it('scopes typed pickers to matching typed mounts and matching content in generic mounts', async () => {
    const listMountEntries = vi.fn((mountId: string, req: { kind?: string }) => Promise.resolve({
      entries: mountId === 'comfy-input' && req.kind === 'media/image' ? [item.rawRef] : [],
    }))
    const connection = {
      listMounts: () => Promise.resolve([
        { id: 'comfy-input', mode: 'read', state: 'ready' },
        { id: 'checkpoints', mode: 'read', state: 'ready', kind: 'model/checkpoint' },
        { id: 'vae', mode: 'read', state: 'ready', kind: 'model/vae' },
        { id: 'comfy-output', mode: 'readwrite', state: 'ready' },
        { id: 'indexing-empty', mode: 'read', state: 'scanning' },
      ]),
      listMountEntries,
    } as unknown as DinksterConnection
    const imageSources = await mountAssetSources(connection, 'media/image')
    expect(imageSources.map((source) => source.label)).toEqual(['comfy-input'])
    expect(listMountEntries).toHaveBeenNthCalledWith(1, 'comfy-input', { path: '', recursive: true, limit: 1, kind: 'media/image' })
    expect(listMountEntries).toHaveBeenNthCalledWith(2, 'comfy-output', { path: '', recursive: true, limit: 1, kind: 'media/image' })
    expect(listMountEntries).toHaveBeenNthCalledWith(3, 'indexing-empty', { path: '', recursive: true, limit: 1, kind: 'media/image' })

    listMountEntries.mockClear()
    const checkpointSources = await mountAssetSources(connection, 'model/checkpoint')
    expect(checkpointSources.map((source) => source.label)).toEqual(['checkpoints'])
    expect(listMountEntries).toHaveBeenCalledTimes(3)
  })

  it('keeps matching typed mounts when one generic-mount probe fails', async () => {
    const connection = {
      listMounts: () => Promise.resolve([
        { id: 'broken-generic', mode: 'read', state: 'ready' },
        { id: 'checkpoints', mode: 'read', state: 'ready', kind: 'model/checkpoint' },
      ]),
      listMountEntries: () => Promise.reject(new Error('probe failed')),
    } as unknown as DinksterConnection
    const sources = await mountAssetSources(connection, 'model/checkpoint')
    expect(sources.map((source) => source.label)).toEqual(['checkpoints'])
  })

  it('distinguishes unsettled discovery from a settled empty result', () => {
    // undefined sources = request in flight; [] = settled with nothing.
    // Collapsing the two rendered "loading readable mounts..." forever.
    expect(assetSourcesStatus(undefined, undefined)).toBe('loading')
    expect(assetSourcesStatus([], undefined)).toBe('empty')
    expect(assetSourcesStatus([{}], undefined)).toBe('ready')
    expect(assetSourcesStatus(undefined, 'GET /api/mounts failed: 500')).toBe('error')
    expect(assetSourcesStatus([{}], 'late error wins: the host must not show a browser over a reported failure')).toBe('error')
  })
})

describe('mount source folder navigation', () => {
  it('uses non-recursive folder pages and recursive search within the current folder', async () => {
    const listMountEntries = vi.fn()
      .mockResolvedValueOnce({ entries: [item.rawRef], folders: ['trips'], cursor: 'folder-next' })
      .mockResolvedValueOnce({ entries: [item.rawRef], cursor: 'search-next' })
      .mockResolvedValueOnce({ entries: [item.rawRef] })
    const source = mountAssetSource({ listMountEntries } as unknown as DinksterConnection, 'input')
    const signal = new AbortController().signal

    const folderPage = await source.page({ query: '', folder: 'photos', limit: 24, signal })
    const searchPage = await source.page({ query: 'moon', folder: 'photos', limit: 24, cursor: 'search-cursor' })
    await source.page({ query: '', folder: 'photos', limit: 24 })

    expect(source.capabilities.folders).toBe(true)
    expect(folderPage.folders).toEqual([expect.objectContaining({ name: 'trips', folder: true, virtualPath: 'photos/trips' })])
    expect(folderPage.cursor).toBe('folder-next')
    expect(searchPage.folders).toBeUndefined()
    expect(listMountEntries).toHaveBeenNthCalledWith(1, 'input', { path: 'photos', recursive: false, limit: 24, signal })
    expect(listMountEntries).toHaveBeenNthCalledWith(2, 'input', { q: 'moon', path: 'photos', recursive: true, cursor: 'search-cursor', limit: 24 })
    expect(listMountEntries).toHaveBeenNthCalledWith(3, 'input', { path: 'photos', recursive: false, limit: 24 })
  })
})

describe('metadata inspection ownership (AP10)', () => {
  beforeEach(() => clearMetadataCache())

  const sourceWith = (loadMetadata: AssetSourceAdapter['loadMetadata']): AssetSourceAdapter => ({
    id: 'mount:m', label: 'm', sourceLabel: 'm',
    capabilities: { folders: false, query: true, kindFilter: true, thumbnails: true, actions: false },
    page: () => Promise.resolve({ items: [] }),
    ...(loadMetadata ? { loadMetadata } : {}),
  })

  const run = async (p: {
    readonly outcome: Promise<unknown | undefined>
    readonly stillCurrent: boolean
    readonly digest: string
  }): Promise<ReturnType<typeof vi.fn>> => {
    const apply = vi.fn()
    await inspectAssetMetadata({
      backendId: 'b1',
      source: sourceWith(() => p.outcome),
      item: { ...item, digest: p.digest },
      stillCurrent: () => p.stillCurrent,
      apply,
    })
    return apply
  }

  it('applies metadata while its item is still the selection', async () => {
    const apply = await run({ outcome: Promise.resolve({ tensorCount: 17 }), stillCurrent: true, digest: 'blake3:own' })
    expect(apply).toHaveBeenCalledWith('ready', { tensorCount: 17 })
  })

  it('a stale completion never touches the rail (selection moved on)', async () => {
    const apply = await run({ outcome: Promise.resolve({ tensorCount: 17 }), stillCurrent: false, digest: 'blake3:stale' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('a stale failure never writes its message over the new selection', async () => {
    const apply = await run({ outcome: Promise.reject(new Error('boom')), stillCurrent: false, digest: 'blake3:stale-fail' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('an owned failure surfaces its message', async () => {
    const apply = await run({ outcome: Promise.reject(new Error('boom')), stillCurrent: true, digest: 'blake3:own-fail' })
    expect(apply).toHaveBeenCalledWith('boom', undefined)
  })

})
