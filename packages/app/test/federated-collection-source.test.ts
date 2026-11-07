import { describe, expect, it, vi } from 'vitest'
import type { AssetDtoV1Client, CandidateV1 } from '@dinkster/client'
import { federatedCollectionSource } from '../src/asset-browser/federated-collection-source.js'

const digest = `blake3:${'a'.repeat(64)}`
const candidate: CandidateV1 = {
  logicalId: 'alpha', family: 'flux', assetKind: 'model/checkpoint', variantId: 'fp16',
  dtype: 'fp16', quantization: 'none', format: 'safetensors', role: 'base',
  requirements: { loaders: [], runtimes: [], hardware: [] }, digest,
  availability: { status: 'local', reason: '' }, compatibility: { status: 'compatible', reason: '' },
  assetRef: { digest, name: 'alpha.safetensors', size: 123, mediaType: 'application/octet-stream', virtualPath: 'models/alpha.safetensors' },
  providerSources: [{ source: { providerId: 'alpha', sourceId: 'local' }, status: 'available', reason: '', requires: {} }],
}

describe('federated collection source', () => {
  it('prefers a non-empty AssetRef name and keeps candidate identity in details', async () => {
    const source = federatedCollectionSource({ catalog: vi.fn().mockResolvedValue({ items: [candidate] }) } as unknown as AssetDtoV1Client)
    const item = (await source.page({ query: '', limit: 10 })).items[0]!
    expect(item.title).toBe('alpha.safetensors')
    expect(item.subtitle).toBeUndefined()
    expect(item.badges).toEqual(['123 B'])
    expect(item.details).toEqual(expect.arrayContaining([
      { label: 'Kind', text: 'model/checkpoint' },
      { label: 'Logical ID', text: 'alpha' },
      { label: 'Variant ID', text: 'fp16' },
      { label: 'Availability', text: 'local: ' },
      { label: 'Compatibility', text: 'compatible: ' },
      { label: 'Provider', text: 'alpha' },
      { label: 'Virtual path', text: 'models/alpha.safetensors' },
    ]))
  })

  it('falls back to logical and variant identity when AssetRef name is absent or empty', async () => {
    const rows = [
      { ...candidate, logicalId: 'absent', assetRef: undefined },
      { ...candidate, logicalId: 'empty', assetRef: { ...candidate.assetRef!, name: '' } },
    ]
    const source = federatedCollectionSource({ catalog: vi.fn().mockResolvedValue({ items: rows }) } as unknown as AssetDtoV1Client)
    const page = await source.page({ query: '', limit: 10 })
    expect(page.items.map((item) => item.title)).toEqual(['absent / fp16', 'empty / fp16'])
  })

  it('keeps declared size and media type for a non-local candidate without an AssetRef', async () => {
    const { assetRef: _assetRef, ...withoutAssetRef } = candidate
    const downloadable: CandidateV1 = {
      ...withoutAssetRef,
      logicalId: 'downloadable',
      size: 456,
      mediaType: 'application/x-safetensors',
      availability: { status: 'downloadable', reason: 'remote only' },
    }
    const source = federatedCollectionSource({ catalog: vi.fn().mockResolvedValue({ items: [downloadable] }) } as unknown as AssetDtoV1Client)
    const item = (await source.page({ query: '', limit: 10 })).items[0]!
    expect(item.title).toBe('downloadable / fp16')
    expect(item.subtitle).toBeUndefined()
    expect(item.badges).toEqual(['456 B'])
    expect(item.ref).toEqual({ digest, size: 456, mediaType: 'application/x-safetensors' })
    expect(item.details).toEqual(expect.arrayContaining([
      { label: 'Size', text: '456' },
      { label: 'Media type', text: 'application/x-safetensors' },
      { label: 'Availability', text: 'downloadable: remote only' },
    ]))
  })

  it('maps wire filters exactly, keeps opaque cursors and duplicate digests in server order', async () => {
    const catalog = vi.fn().mockResolvedValue({ items: [candidate, { ...candidate, logicalId: 'beta', assetRef: { ...candidate.assetRef!, name: 'beta.safetensors' } }], nextCursor: 'opaque.+/==' })
    const source = federatedCollectionSource({ catalog } as unknown as AssetDtoV1Client)
    const page = await source.page({ query: 'flux', cursor: 'input.cursor', limit: 7, filters: { assetKind: 'model/checkpoint', availability: 'local', compatibility: 'compatible' } })
    expect(catalog).toHaveBeenCalledWith({ query: 'flux', assetKind: 'model/checkpoint', availability: ['local'], compatibility: ['compatible'], cursor: 'input.cursor', limit: 7 }, undefined)
    expect(page.cursor).toBe('opaque.+/==')
    expect(page.items.map((item) => item.title)).toEqual(['alpha.safetensors', 'beta.safetensors'])
  })

  it('preserves local provenance and uses CollectionEntry.ref', async () => {
    const source = federatedCollectionSource({ catalog: vi.fn().mockResolvedValue({ items: [candidate] }) } as unknown as AssetDtoV1Client)
    const item = (await source.page({ query: '', limit: 10 })).items[0]!
    expect(item.ref).toEqual(candidate.assetRef)
    expect(item.details).toEqual(expect.arrayContaining([
      { label: 'Kind', text: 'model/checkpoint' },
      { label: 'Virtual path', text: 'models/alpha.safetensors' },
      { label: 'Provider', text: 'alpha' },
    ]))
  })

  it('does not send provider presentation filters and exposes folder/error states', async () => {
    const catalog = vi.fn().mockResolvedValue({ items: [candidate] })
    const source = federatedCollectionSource({ catalog } as unknown as AssetDtoV1Client)
    expect((await source.page({ query: '', limit: 10, folder: 'models' })).items[0]?.title).toBe('Folder browsing unsupported')
    await source.page({ query: '', limit: 10, filters: { providerId: 'alpha' } })
    expect(catalog.mock.calls[0]?.[0]).not.toHaveProperty('providerId')
  })

  it('learns provider filters from pages and retains candidates without sources when filters are inactive', async () => {
    const withoutSources = { ...candidate, logicalId: 'aardvark', providerSources: [] }
    const source = federatedCollectionSource({ catalog: vi.fn().mockResolvedValue({ items: [withoutSources, candidate] }) } as unknown as AssetDtoV1Client)
    const page = await source.page({ query: '', limit: 10 })
    expect(page.items.map((item) => item.title)).toEqual(['alpha.safetensors', 'alpha.safetensors'])
    expect(source.filters?.find((filter) => filter.id === 'providerId')?.options()).toEqual([{ value: 'alpha', label: 'alpha' }])
    expect(source.filters?.find((filter) => filter.id === 'sourceId')?.options()).toEqual([{ value: 'local', label: 'local' }])
  })

  it('uses injective entry identities when candidate identifiers contain delimiters', async () => {
    const rows = [
      { ...candidate, logicalId: 'a', variantId: 'b:c' },
      { ...candidate, logicalId: 'a:b', variantId: 'c' },
    ]
    const source = federatedCollectionSource({ catalog: vi.fn().mockResolvedValue({ items: rows }) } as unknown as AssetDtoV1Client)
    const page = await source.page({ query: '', limit: 10 })
    expect(new Set(page.items.map((item) => item.id)).size).toBe(2)
  })

  it('reports catalog failures to a host-owned health surface instead of minting an asset row', async () => {
    const onFailure = vi.fn()
    const source = federatedCollectionSource({
      catalog: vi.fn().mockRejectedValue(new Error('catalog offline')),
    } as unknown as AssetDtoV1Client, onFailure)

    await expect(source.page({ query: '', limit: 10 })).rejects.toThrow('catalog offline')
    expect(onFailure).toHaveBeenCalledWith('catalog offline')
  })

  it('does not report a superseded request cancellation as a source failure', async () => {
    const onFailure = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const source = federatedCollectionSource({
      catalog: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    } as unknown as AssetDtoV1Client, onFailure)

    await expect(source.page({ query: '', limit: 10, signal: controller.signal })).rejects.toThrow('aborted')
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('does not clear source failure when an abort-ignoring catalog succeeds after cancellation', async () => {
    let resolveCancelled!: (page: { items: CandidateV1[] }) => void
    const catalog = vi.fn()
      .mockRejectedValueOnce(new Error('catalog offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveCancelled = resolve }))
    const onFailure = vi.fn()
    const source = federatedCollectionSource({ catalog } as unknown as AssetDtoV1Client, onFailure)

    await expect(source.page({ query: '', limit: 10 })).rejects.toThrow('catalog offline')
    const controller = new AbortController()
    const cancelled = source.page({ query: 'new', limit: 10, signal: controller.signal })
    controller.abort()
    resolveCancelled({ items: [candidate] })

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith('catalog offline')
  })

  it('does not let a stale failure replace newer source health', async () => {
    let rejectOld!: (reason: Error) => void
    const catalog = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
      .mockResolvedValueOnce({ items: [candidate] })
    const onFailure = vi.fn()
    const source = federatedCollectionSource({ catalog } as unknown as AssetDtoV1Client, onFailure)

    const stale = source.page({ query: 'old', limit: 10 })
    await source.page({ query: 'new', limit: 10 })
    rejectOld(new Error('stale catalog failure'))

    await expect(stale).rejects.toThrow('stale catalog failure')
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(undefined)
  })
})
