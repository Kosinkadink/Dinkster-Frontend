import { describe, expect, it, vi } from 'vitest'
import type { ExecutionState } from '@dinkster/client'
import { executedImageInventory } from '../src/executed-image-inventory.js'

const digest = (char: string): string => `blake3:${char.repeat(64)}`
const asset = (value: string, name: string) => ({
  typeId: 'dinkster.asset',
  fingerprint: value,
  meta: { digest: value, mediaType: 'image/png', name },
})

const execution = (outputs: ExecutionState['outputs']): ExecutionState => ({
  ref: { connection: 'backend-b', prompt: 'run-7' },
  key: 'backend-b\u0000run-7',
  outputs,
  previews: {},
} as unknown as ExecutionState)

describe('executedImageInventory', () => {
  it('orders runtime ids, V1 arrays, native keys, and descriptor refs without provenance dedupe', () => {
    const a = digest('a')
    const b = digest('b')
    const viewUrl = vi.fn((_ref, file: { filename: string }) => `own/view/${file.filename}`)
    const assetUrl = vi.fn((_ref, value: string) => `own/assets/${value}`)
    const result = executedImageInventory(execution({
      z9: {
        zeta: { typeId: 'list<dinkster.asset>', elements: [asset(b, 'b.png'), asset(a, 'a-again.png')] },
        alpha: { typeId: 'list<dinkster.asset>', elements: [asset(a, 'a.png'), asset(a, 'a-copy.png')] },
      },
      a2: { images: [{ filename: 'second.png' }, { filename: 'first.png', subfolder: 'x', type: 'output' }] },
    }), { viewUrlForExecution: viewUrl, assetUrlForExecution: assetUrl })

    expect(result.map((item) => [item.runtimeId, item.outputId, item.name, item.digest, item.mediaType])).toEqual([
      ['a2', 'images', 'second.png', undefined, 'image (legacy descriptor)'],
      ['a2', 'images', 'first.png', undefined, 'image (legacy descriptor)'],
      ['z9', 'alpha', 'a.png', a, 'image/png'],
      ['z9', 'alpha', 'a-copy.png', a, 'image/png'],
      ['z9', 'zeta', 'b.png', b, 'image/png'],
      ['z9', 'zeta', 'a-again.png', a, 'image/png'],
    ])
    expect(result[1]).toMatchObject({ subfolder: 'x', fileType: 'output', descriptorIndex: 1 })
    expect(result.map((item) => item.url)).toEqual([
      'own/view/second.png', 'own/view/first.png',
      `own/assets/${a}`, `own/assets/${a}`, `own/assets/${b}`, `own/assets/${a}`,
    ])
    expect(viewUrl).toHaveBeenCalledWith(expect.objectContaining({ connection: 'backend-b' }), expect.anything())
    expect(assetUrl).toHaveBeenCalledWith(expect.objectContaining({ connection: 'backend-b' }), a)
  })

  it('filters to the supplied occurrence runtime ids and ignores malformed/non-image values', () => {
    const result = executedImageInventory(execution({
      a: { images: [{ filename: '' }, {}] },
      b: { image: asset(digest('b'), 'b.png') },
      c: { file: { ...asset(digest('c'), 'c.json'), meta: { digest: digest('c'), mediaType: 'application/json' } } },
    }), {
      runtimeIds: ['b', 'c'],
      viewUrlForExecution: () => 'view',
      assetUrlForExecution: (_ref, value) => `asset/${value}`,
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ runtimeId: 'b', outputId: 'image', name: 'b.png' })
  })

  it('rejects malformed typed assets and falls back from unusable V1 entries to native output', () => {
    const valid = digest('d')
    const nested = { ...asset(digest('f'), 'nested.png'), typeId: 'asset<list<comfy.IMAGE>>' }
    const malformed = { ...asset(digest('e'), 'bad.png'), typeId: 'asset<comfy.IMAGE' }
    const result = executedImageInventory(execution({
      node: {
        images: [{}, { filename: '' }],
        native: { typeId: 'list<dinkster.asset>', elements: [malformed, nested, asset(valid, 'valid.png')] },
      },
    }), {
      viewUrlForExecution: () => 'view',
      assetUrlForExecution: (_ref, value) => `asset/${value}`,
    })
    expect(result.map((item) => item.name)).toEqual(['nested.png', 'valid.png'])
  })
})
