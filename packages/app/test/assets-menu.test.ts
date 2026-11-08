import { describe, expect, it, vi } from 'vitest'
import type { CollectionPageRequest } from '@dinkster/core'
import type { AssetBrowserItem, AssetSourceAdapter } from '../src/asset-browser/types.js'
import { allAssetsCollectionSource, mountPresentationClass } from '../src/asset-browser/cross-mount-collection-source.js'
import { assetItemOf } from '../src/asset-browser/collection-adapter.js'

const asset = (source: string, name: string, virtualPath = name): AssetBrowserItem => ({
  id: `${source}:${virtualPath}`,
  name,
  virtualPath,
  digest: `blake3:${name}`,
  size: 10,
  mediaType: 'image/png',
  source: { id: source, label: source, path: virtualPath },
})

const adapter = (id: string, page: AssetSourceAdapter['page']): AssetSourceAdapter => ({
  id,
  label: id,
  sourceLabel: id,
  capabilities: { folders: true, query: true, kindFilter: true, thumbnails: true, actions: false },
  page,
})

describe('All assets collection source', () => {
  it('classifies only the shared trusted input and output presentation identities', () => {
    expect(mountPresentationClass({ id: 'comfy-input', kind: 'media/image' })).toBe('input')
    expect(mountPresentationClass({ id: 'team-input-cache', kind: 'media/image' })).toBe('input')
    expect(mountPresentationClass({ id: 'comfy-output', kind: 'media/image' })).toBe('output')
    expect(mountPresentationClass({ id: 'team-output-cache', kind: 'media/image' })).toBe('output')
    expect(mountPresentationClass({ id: 'withoutput-token', kind: 'media/image' })).toBe('unclassified')
    expect(mountPresentationClass({ id: 'custom-media', kind: 'media/image' })).toBe('unclassified')
  })

  it('forwards a fixed picker kind without taking query, folder, or cursor ownership from mounts', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ items: [], cursor: 'mount-page-2' })
      .mockResolvedValueOnce({ items: [] })
    const source = allAssetsCollectionSource(
      [adapter('mount:input', page)],
      [],
      undefined,
      { id: 'imported-assets', label: 'Imported', fixedKind: 'media/image' },
    )
    const first = await source.page({ query: 'cat', folder: 'nested', limit: 24 })
    await source.page({ query: 'cat', folder: 'nested', limit: 24, cursor: first.cursor! })
    expect(source).toMatchObject({ id: 'imported-assets', label: 'Imported' })
    expect(page).toHaveBeenNthCalledWith(1, expect.objectContaining({
      query: 'cat', folder: 'nested', kind: 'media/image',
    }))
    expect(page).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'mount-page-2' }))
  })

  it('fans out, merges deterministically, and advances every mount cursor', async () => {
    const left = vi.fn()
      .mockResolvedValueOnce({ items: [asset('left', 'same.png', 'z/same.png'), asset('left', 'z.png')], cursor: 'left-2' })
      .mockResolvedValueOnce({ items: [asset('left', 'b.png')] })
    const right = vi.fn()
      .mockResolvedValueOnce({ items: [asset('right', 'same.png', 'a/same.png'), asset('right', 'a.png')] })
      .mockResolvedValueOnce({ items: [asset('right', 'c.png')] })
    const source = allAssetsCollectionSource([adapter('left', left), adapter('right', right)])

    const first = await source.page({ query: '', limit: 24 })
    expect(first.items.map((entry) => `${entry.title}:${assetItemOf(entry)?.virtualPath}`)).toEqual([
      'a.png:a.png', 'same.png:a/same.png', 'same.png:z/same.png', 'z.png:z.png',
    ])
    // Compact rows: the mount path lives in the detail rail, not on the row.
    expect(first.items.every((entry) => entry.subtitle === undefined)).toBe(true)
    expect(first.cursor).toBeTypeOf('string')
    const second = await source.page({ query: '', limit: 24, cursor: first.cursor! })
    expect(second.items.map((entry) => entry.title)).toEqual(['b.png'])
    expect(left).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'left-2' }))
    expect(right).toHaveBeenCalledTimes(1)
  })

  it('binds composite cursors to the exact query and refuses stale pages', async () => {
    const source = allAssetsCollectionSource([adapter('mount:a', vi.fn().mockResolvedValue({ items: [], cursor: 'next' }))])
    const first = await source.page({ query: 'old', limit: 24 })
    await expect(source.page({ query: 'new', limit: 24, cursor: first.cursor! })).rejects.toThrow('stale All assets cursor')
  })

  it('drops a stale in-flight fan-out result after a newer query starts', async () => {
    let release!: (page: { items: AssetBrowserItem[] }) => void
    const page = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockResolvedValueOnce({ items: [asset('mount:a', 'new.png')] })
    const source = allAssetsCollectionSource([adapter('mount:a', page)])
    const oldRequest = source.page({ query: 'old', limit: 24 })
    const fresh = await source.page({ query: 'new', limit: 24 })
    release({ items: [asset('mount:a', 'old.png')] })
    expect(fresh.items.map((entry) => entry.title)).toEqual(['new.png'])
    await expect(oldRequest).rejects.toThrow('stale All assets response')
  })

  it('degrades one failed mount to a visible note without failing the catalog', async () => {
    const source = allAssetsCollectionSource([
      adapter('good', vi.fn().mockResolvedValue({ items: [asset('good', 'ok.png')] })),
      adapter('offline', vi.fn().mockRejectedValue(new Error('index unavailable'))),
    ])
    const result = await source.page({ query: '', limit: 24 } as CollectionPageRequest)
    expect(result.items.map((entry) => entry.title)).toContain('ok.png')
    expect(result.items).toContainEqual(expect.objectContaining({
      id: 'all-assets:error:offline',
      title: 'offline unavailable',
      details: [{ label: 'Reason', text: 'index unavailable' }],
    }))
  })

  it('reports partial source failures separately when the host owns health presentation', async () => {
    const onSourceFailures = vi.fn()
    const source = allAssetsCollectionSource([
      adapter('good', vi.fn().mockResolvedValue({ items: [asset('good', 'ok.png')] })),
      adapter('offline', vi.fn().mockRejectedValue(new Error('index unavailable'))),
    ], [], undefined, { onSourceFailures })

    const result = await source.page({ query: '', limit: 24 })
    expect(result.items.map((entry) => entry.title)).toEqual(['ok.png'])
    expect(onSourceFailures).toHaveBeenCalledWith([
      { sourceId: 'offline', label: 'offline', message: 'index unavailable' },
    ])
  })

  it('does not report a cancelled fan-out as source failures', async () => {
    const onSourceFailures = vi.fn()
    const source = allAssetsCollectionSource([
      adapter('cancelled', vi.fn((request) => new Promise<never>((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }))),
    ], [], undefined, { onSourceFailures })
    const controller = new AbortController()

    const pending = source.page({ query: '', limit: 24, signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toThrow('aborted')
    expect(onSourceFailures).not.toHaveBeenCalled()
  })

  it('does not clear source failures when an abort-ignoring fan-out succeeds after cancellation', async () => {
    let resolveCancelled!: (page: { items: AssetBrowserItem[] }) => void
    const page = vi.fn()
      .mockRejectedValueOnce(new Error('index unavailable'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCancelled = resolve }))
    const onSourceFailures = vi.fn()
    const source = allAssetsCollectionSource([
      adapter('unstable', page),
    ], [], undefined, { onSourceFailures })

    await expect(source.page({ query: '', limit: 24 })).rejects.toThrow('unstable: index unavailable')
    const controller = new AbortController()
    const cancelled = source.page({ query: 'new', limit: 24, signal: controller.signal })
    controller.abort()
    resolveCancelled({ items: [asset('unstable', 'late.png')] })

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(onSourceFailures).toHaveBeenCalledOnce()
    expect(onSourceFailures).toHaveBeenCalledWith([
      { sourceId: 'unstable', label: 'unstable', message: 'index unavailable' },
    ])
  })

  it('fails truthfully when every ready mount listing fails', async () => {
    const source = allAssetsCollectionSource([
      adapter('left', vi.fn().mockRejectedValue(new Error('request failed (500)'))),
      adapter('right', vi.fn().mockRejectedValue(new Error('offline'))),
    ], [], undefined, { failWhenAllSourcesFail: true })

    await expect(source.page({ query: '', limit: 24 })).rejects.toThrow(
      'left: request failed (500); right: offline',
    )
  })

  it('does not duplicate unavailable mount notes on appended pages', async () => {
    const source = allAssetsCollectionSource(
      [adapter('ready', vi.fn()
        .mockResolvedValueOnce({ items: [asset('ready', 'one.png')], cursor: 'next' })
        .mockResolvedValueOnce({ items: [asset('ready', 'two.png')] }))],
      [{ id: 'offline', state: 'offline' }],
    )
    const first = await source.page({ query: '', limit: 24 })
    const second = await source.page({ query: '', limit: 24, cursor: first.cursor! })
    expect([...first.items, ...second.items].map((entry) => entry.id)).toEqual([
      'ready:one.png', 'all-assets:error:offline', 'ready:two.png',
    ])
  })
})
