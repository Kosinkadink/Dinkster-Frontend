import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DinksterConnection } from '@dinkster/client'
import { assetSourcesStatus, committableAssetRef, isBrowserPreviewable, isCompatible, mediaKindForAccept } from '../src/asset-browser/helpers.js'
import { assetCollectionSource, assetEntryKindOf, assetEntryOf, assetEntryPickable, assetItemOf, assetKindOf } from '../src/asset-browser/collection-adapter.js'
import { clearMetadataCache, inspectAssetMetadata } from '../src/asset-browser/metadata.js'
import { mountAssetSource, mountAssetSources, normalizeMountEntry } from '../src/asset-browser/mountAssetSource.js'
import type { AssetBrowserItem, AssetSourceAdapter } from '../src/asset-browser/types.js'

const item = normalizeMountEntry('mount:m', 'm', { virtualPath: 'images/a.png', name: 'a.png', digest: 'blake3:a', size: 12, mediaType: 'image/png', kind: 'media/image' })
describe('asset browser helpers', () => {
  it('normalizes mount identity from adapter and virtual path', () => expect(item.id).toBe('mount:m:images/a.png'))
  it('intersects MIME and semantic kind and rejects unprovable rows', () => {
    expect(isCompatible(item, ['image/*'], 'media/*')).toBe(true)
    expect(isCompatible(item, ['video/*'], 'media/*')).toBe(false)
    const { mediaType: _mediaType, ...withoutMediaType } = item
    expect(isCompatible(withoutMediaType, [], undefined)).toBe(false)
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
  const extensionKindCases: readonly (readonly [string, string | undefined])[] = [
    ...['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].map((extension): [string, string] => [`preview.${extension}`, 'image']),
    ...['mp4', 'webm', 'mov', 'avi'].map((extension): [string, string] => [`clip.${extension}`, 'video']),
    ...['wav', 'mp3', 'flac', 'ogg'].map((extension): [string, string] => [`voice.${extension}`, 'audio']),
    ...['safetensors', 'ckpt', 'pt', 'gguf'].map((extension): [string, string] => [`weights.${extension}`, 'model']),
    ['UPPER.PNG', 'image'],
    ['README', undefined], ['archive.zip', undefined],
  ]
  it.each(extensionKindCases)('derives the display kind for %s as %s', (name, expected) => {
    expect(assetKindOf({ name })).toBe(expected)
  })
  it('keeps a truthy backend kind authoritative and omits an unknown kind badge', () => {
    expect(assetKindOf({ name: 'preview.png', kind: 'custom/rendition' })).toBe('custom/rendition')
    const { kind: _kind, ...kindless } = item
    const entry = assetEntryOf({ ...kindless, name: 'archive.zip' })
    expect(entry.badges).not.toContain('unknown')
    expect(entry.badges).not.toContain('image')
  })
  it('reads an external entry kind from details before presentation badges', () => {
    expect(assetEntryKindOf({
      id: 'federated',
      title: 'model.safetensors',
      badges: ['12 B'],
      details: [{ label: 'Kind', text: 'model/checkpoint' }],
    })).toBe('model/checkpoint')
  })
  it('carries the whole asset item as the entry ref and narrows it back', () => {
    const entry = assetEntryOf(item)
    expect(entry.id).toBe(item.id)
    expect(entry.folder).toBeUndefined()
    expect(assetItemOf(entry)).toBe(item)
    expect(assetItemOf(undefined)).toBeUndefined()
    expect(assetItemOf({ id: 'x', title: 'no ref' })).toBeUndefined()
  })
  it('thumbnails only browser-previewable entries, through the digest URL', () => {
    const url = (digest: string): string => `/assets/${digest}`
    expect(assetEntryOf(item, url).thumbUrl).toBe('/assets/blake3:a')
    expect(assetEntryOf({ ...item, kind: 'model/lora' }, url).thumbUrl).toBeUndefined()
    expect(assetEntryOf(item).thumbUrl).toBeUndefined()
  })
  it('maps folder rows to navigation entries without a ref (AP10)', () => {
    const folder: AssetBrowserItem = { id: 'mount:m:sub', name: 'sub', folder: true, childCount: 3, virtualPath: 'sub', source: { id: 'mount:m', label: 'm' } }
    const entry = assetEntryOf(folder)
    expect(entry.folder).toEqual({ path: 'sub' })
    expect(entry.ref).toBeUndefined()
    expect(entry.badges).toEqual(['folder', '3 items'])
    // and therefore the pick predicate can never accept it
    expect(assetEntryPickable([], undefined)(entry)).toBe(false)
  })
  it('pick predicate intersects MIME accept and semantic kind on the ref', () => {
    const pickable = assetEntryPickable(['image/*'], 'media/*')
    expect(pickable(assetEntryOf(item))).toBe(true)
    const { kind: _kind, ...kindless } = item
    expect(pickable(assetEntryOf(kindless))).toBe(true)
    expect(pickable(assetEntryOf({ ...item, mediaType: 'video/mp4' }))).toBe(false)
    expect(pickable(assetEntryOf({ ...item, kind: 'model/lora' }))).toBe(false)
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

  it('forwards query, kind filter, folder, cursor, and abort signal to the adapter', async () => {
    const page = vi.fn().mockResolvedValue({ items: [item], cursor: 'next', total: 9 })
    const listFolder = vi.fn().mockResolvedValue({ folders: [] })
    const source = assetCollectionSource(adapterWith(page, listFolder))
    const signal = new AbortController().signal
    const result = await source.page({ query: 'cat', limit: 24, filters: { kind: 'media/image' }, folder: 'sub', cursor: 'c1', signal })
    expect(page).toHaveBeenCalledWith({ query: 'cat', limit: 24, kind: 'media/image', folder: 'sub', cursor: 'c1', signal })
    expect(result.cursor).toBe('next')
    expect(result.total).toBe(9)
    expect(assetItemOf(result.items[0])).toBe(item)
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

  it('never lists folders for a folderless adapter', async () => {
    const page = vi.fn().mockResolvedValue({ items: [item] })
    const source = assetCollectionSource(adapterWith(page))
    expect(source.folders).toBeUndefined()
    const result = await source.page({ query: '', limit: 24 })
    expect(result.items.map((e) => e.id)).toEqual([item.id])
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

  it('an owned unsupported result says so', async () => {
    const apply = await run({ outcome: Promise.resolve(undefined), stillCurrent: true, digest: 'blake3:unsupported' })
    expect(apply).toHaveBeenCalledWith('Metadata inspection is unsupported.', undefined)
  })
})
