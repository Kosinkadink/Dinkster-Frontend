import { describe, expect, it, vi } from 'vitest'
import { ingestLogicalModels } from '../src/asset-browser/logical-model-merge.js'
import { localMountScanAdapter } from '../src/asset-browser/local-mount-logical-model.js'
import type { AssetBrowserItem, AssetSourceAdapter } from '../src/asset-browser/types.js'

const A = `blake3:${'a'.repeat(64)}`
const B = `blake3:${'b'.repeat(64)}`
const C = `blake3:${'c'.repeat(64)}`

function item(sourceId: string, label: string, digest: string, name: string, virtualPath = name): AssetBrowserItem {
  return {
    id: `${sourceId}:${virtualPath}`,
    name,
    kind: 'model/checkpoint',
    digest,
    size: 1024,
    mediaType: 'application/x-safetensors',
    virtualPath,
    source: { id: sourceId, label, path: virtualPath },
  }
}

function source(id: string, label: string, pages: readonly (readonly AssetBrowserItem[])[]): AssetSourceAdapter {
  return {
    id,
    label,
    sourceLabel: label,
    capabilities: { folders: true, query: true, kindFilter: true, thumbnails: false, actions: false },
    page: vi.fn(async (request) => {
      const index = request.cursor === undefined ? 0 : Number(request.cursor)
      return {
        items: pages[index] ?? [],
        ...(index + 1 < pages.length ? { cursor: String(index + 1) } : {}),
      }
    }),
  }
}

describe('localMountScanAdapter', () => {
  it('canonicalizes a digest across mounts and renamed paths before V1 ingestion', async () => {
    const left = source('mount:left', 'Left', [[item('mount:left', 'Left', A, 'zeta.safetensors')]])
    const right = source('mount:right', 'Right', [[item('mount:right', 'Right', A, 'alpha.safetensors', 'renamed/alpha.safetensors')]])
    const adapter = await localMountScanAdapter([left, right], 'model/checkpoint')
    const result = ingestLogicalModels([adapter])

    expect(result.diagnostics).toEqual([])
    expect(result.models).toHaveLength(1)
    expect(result.models[0]).toMatchObject({
      logicalId: 'local-name:alpha.safetensors',
      displayName: 'alpha.safetensors',
      aliases: ['alpha.safetensors', 'renamed/alpha.safetensors', 'zeta.safetensors'],
    })
    expect(result.models[0]!.variants).toHaveLength(1)
    expect(result.models[0]!.variants[0]).toMatchObject({
      variantId: A,
      digest: A,
      availability: 'installed',
      compatibility: { status: 'unknown' },
      localRef: { digest: A, name: 'alpha.safetensors', virtualPath: 'renamed/alpha.safetensors' },
    })
    expect(result.models[0]!.variants[0]!.providers.map((provider) => provider.sourceId)).toEqual(['mount:left', 'mount:right'])
    expect(left.page).toHaveBeenCalledWith(expect.objectContaining({ kind: 'model/checkpoint', recursive: true }))
    expect(right.page).toHaveBeenCalledWith(expect.objectContaining({ kind: 'model/checkpoint', recursive: true }))
  })

  it('puts same-primary-name digests under one model so V1 marks both conflicts', async () => {
    const adapter = await localMountScanAdapter([
      source('mount:models', 'Models', [[
        item('mount:models', 'Models', A, 'shared.safetensors', 'a/shared.safetensors'),
        item('mount:models', 'Models', B, 'shared.safetensors', 'b/shared.safetensors'),
      ]]),
    ], 'model/checkpoint')
    const result = ingestLogicalModels([adapter])

    expect(result.models).toHaveLength(1)
    expect(result.models[0]!.variants).toHaveLength(2)
    expect(result.models[0]!.variants.map((variant) => variant.conflicts)).toEqual([
      [{ code: 'basename-digest-conflict', basename: 'shared.safetensors', otherVariantId: B }],
      [{ code: 'basename-digest-conflict', basename: 'shared.safetensors', otherVariantId: A }],
    ])
    expect(result.models[0]!.variants.map((variant) => variant.localRef?.virtualPath)).toEqual([
      'a/shared.safetensors',
      'b/shared.safetensors',
    ])
  })

  it('pins the interim non-primary alias collision limitation without merging models', async () => {
    const adapter = await localMountScanAdapter([
      source('mount:one', 'One', [[
        item('mount:one', 'One', A, 'alpha.safetensors'),
        item('mount:one', 'One', A, 'shared.safetensors'),
        item('mount:one', 'One', C, 'shared.safetensors'),
      ]]),
    ], 'model/checkpoint')
    const result = ingestLogicalModels([adapter])

    expect(result.models.map((model) => model.logicalId)).toEqual([
      'local-name:alpha.safetensors',
      'local-name:shared.safetensors',
    ])
    expect(result.models.flatMap((model) => model.variants).every((variant) => variant.conflicts.length === 0)).toBe(true)
  })

  it('is idempotent across refreshes and cannot claim one digest under two logical ids', async () => {
    const mounted = source('mount:models', 'Models', [[item('mount:models', 'Models', A, 'stable.safetensors')]])
    const first = await localMountScanAdapter([mounted], 'model/checkpoint')
    const second = await localMountScanAdapter([mounted], 'model/checkpoint')

    expect(ingestLogicalModels([first])).toEqual(ingestLogicalModels([second]))
    expect(first.descriptions).toHaveLength(1)
    expect((first.descriptions[0] as { variants: readonly unknown[] }).variants).toHaveLength(1)
    expect(ingestLogicalModels([first]).diagnostics.some((entry) => entry.code === 'digest-logical-conflict')).toBe(false)
  })

  it('retains the flat picker compatibility boundary when a source over-returns', async () => {
    const valid = item('mount:models', 'Models', A, 'valid.safetensors')
    const wrongKind = { ...item('mount:models', 'Models', B, 'image.safetensors'), kind: 'media/image' }
    const wrongMime = { ...item('mount:models', 'Models', C, 'archive.safetensors'), mediaType: 'application/zip' }
    const adapter = await localMountScanAdapter(
      [source('mount:models', 'Models', [[valid, wrongKind, wrongMime]])],
      'model/checkpoint',
      ['application/x-safetensors'],
    )

    expect(ingestLogicalModels([adapter]).models.map((model) => model.displayName)).toEqual(['valid.safetensors'])
  })

  it('rejects malformed and uppercase digests without suppressing a valid sibling row', async () => {
    const adapter = await localMountScanAdapter([
      source('mount:models', 'Models', [[
        item('mount:models', 'Models', A, 'shared.safetensors', 'valid/shared.safetensors'),
        item('mount:models', 'Models', `blake3:${'A'.repeat(64)}`, 'shared.safetensors', 'invalid/shared.safetensors'),
        item('mount:models', 'Models', 'not-a-digest', 'shared.safetensors', 'invalid/other.safetensors'),
      ]]),
    ], 'model/checkpoint')
    const result = ingestLogicalModels([adapter])

    expect(result.diagnostics).toEqual([])
    expect(result.models).toHaveLength(1)
    expect(result.models[0]!.variants.map((variant) => variant.digest)).toEqual([A])
  })

  it('rejects entries with empty basenames before creating local identity', async () => {
    const adapter = await localMountScanAdapter([
      source('mount:models', 'Models', [[item('mount:models', 'Models', A, '', '')]]),
    ], 'model/checkpoint')

    expect(ingestLogicalModels([adapter]).models).toEqual([])
  })
})
