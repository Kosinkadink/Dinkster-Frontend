import { describe, expect, it, vi } from 'vitest'
import type { ExecutionState } from '@dinkster/client'
import { executedImageInventory } from '../src/executed-image-inventory.js'
import type { PeekValues } from '../src/peek-preview.js'

const digest = (char: string): string => `blake3:${char.repeat(64)}`
const asset = (value: string, name: string) => ({
  typeId: 'ASSET',
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
  it('loads native batch images from their owning execution and preserves refusals', async () => {
    const outputs = { preview: { images: { typeId: 'IMAGE', fingerprint: 'batch', meta: { shape: [3, 8, 16, 4] } } } }
    const values: PeekValues = {
      peek: async () => ({ available: true, descriptor: outputs.preview.images, renditions: [
        { kind: 'png', mime: 'image/png', parameters: ['batch'], version: 'renderer-2' },
      ] }),
      rendition: async (query, kind, options) => ({
        available: true, mime: 'image/png', kind, fingerprint: 'batch',
        bytes: new TextEncoder().encode(JSON.stringify({ query, kind, batch: options?.batch, version: options?.rendererVersion })).buffer,
      }),
    }
    const images = executedImageInventory(execution(outputs), { values, assetUrlForExecution: () => '' })
    expect(images.map((image) => image.batchIndex)).toEqual([0, 1, 2])
    const result = await images[2]!.load!(new AbortController().signal)
    expect(result.available).toBe(true)
    if (result.available) expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual({
      query: { jobId: 'run-7', nodeId: 'preview', outputId: 'images' }, kind: 'png', batch: 2, version: 'renderer-2',
    })
    const refused = executedImageInventory(execution(outputs), {
      values: { ...values, peek: async () => ({ available: false, status: 410, reason: 'evicted', error: 'Gone' }) },
      assetUrlForExecution: () => '',
    })
    expect(await refused[0]!.load!(new AbortController().signal)).toMatchObject({ available: false, reason: 'evicted' })
    const unsupported = executedImageInventory(execution(outputs), {
      values: { ...values, peek: async () => ({ available: true, descriptor: outputs.preview.images, renditions: [{ kind: 'png', mime: 'image/png' }] }) },
      assetUrlForExecution: () => '',
    })
    expect(await unsupported[1]!.load!(new AbortController().signal)).toMatchObject({ available: false, reason: 'no-rendition' })
  })

  it('loads typed assets and saved images through their original execution with cancellation', async () => {
    const state = { ...execution({ node: { image: asset(digest('a'), 'typed.png') } }),
      artifacts: [{ nodeId: 'save', digest: digest('b'), name: 'saved.webp', mediaType: 'image/webp', size: 3, virtualPath: '' }] }
    const controller = new AbortController()
    const images = executedImageInventory(state, {
      assetUrlForExecution: () => 'http://must-not-be-fetched',
      readAsset: async (ref, value, signal) => {
        signal.throwIfAborted()
        return new TextEncoder().encode(`${ref.connection}/${ref.prompt}/${value}`).buffer
      },
    })
    for (const [index, char] of ['a', 'b'].entries()) {
      const result = await images[index]!.load!(controller.signal)
      expect(result).toMatchObject({ available: true, mime: index === 0 ? 'image/png' : 'image/webp' })
      if (result.available) expect(new TextDecoder().decode(result.bytes)).toBe(`backend-b/run-7/${digest(char)}`)
    }
    controller.abort(new Error('Viewer closed'))
    await expect(images[0]!.load!(controller.signal)).rejects.toThrow('Viewer closed')
  })

  it('orders runtime ids, native keys, and descriptor refs without provenance dedupe', () => {
    const a = digest('a')
    const b = digest('b')
    const assetUrl = vi.fn((_ref, value: string) => `own/assets/${value}`)
    const result = executedImageInventory(execution({
      z9: {
        zeta: { typeId: 'list<ASSET>', elements: [asset(b, 'b.png'), asset(a, 'a-again.png')] },
        alpha: { typeId: 'list<ASSET>', elements: [asset(a, 'a.png'), asset(a, 'a-copy.png')] },
      },
      a2: { images: { typeId: 'list<ASSET>', elements: [asset(b, 'second.png'), asset(a, 'first.png')] } },
    }), { assetUrlForExecution: assetUrl })

    expect(result.map((item) => [item.runtimeId, item.outputId, item.name, item.digest, item.mediaType])).toEqual([
      ['a2', 'images', 'second.png', b, 'image/png'],
      ['a2', 'images', 'first.png', a, 'image/png'],
      ['z9', 'alpha', 'a.png', a, 'image/png'],
      ['z9', 'alpha', 'a-copy.png', a, 'image/png'],
      ['z9', 'zeta', 'b.png', b, 'image/png'],
      ['z9', 'zeta', 'a-again.png', a, 'image/png'],
    ])
    expect(result[1]).toMatchObject({ descriptorIndex: 1 })
    expect(result.map((item) => item.url)).toEqual([
      `own/assets/${b}`, `own/assets/${a}`,
      `own/assets/${a}`, `own/assets/${a}`, `own/assets/${b}`, `own/assets/${a}`,
    ])
    expect(assetUrl).toHaveBeenCalledWith(expect.objectContaining({ connection: 'backend-b' }), a)
  })

  it('filters to the supplied occurrence runtime ids and ignores malformed/non-image values', () => {
    const result = executedImageInventory(execution({
      a: { images: [{ filename: '' }, {}] },
      b: { image: asset(digest('b'), 'b.png') },
      c: { file: { ...asset(digest('c'), 'c.json'), meta: { digest: digest('c'), mediaType: 'application/json' } } },
    }), {
      runtimeIds: ['b', 'c'],
      assetUrlForExecution: (_ref, value) => `asset/${value}`,
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ runtimeId: 'b', outputId: 'image', name: 'b.png' })
  })

  it('includes saved files beside tensor renditions without repeating typed assets or other nodes', () => {
    const saved = { nodeId: 'save', digest: digest('a'), name: 'saved.png', size: 7,
      mediaType: 'image/png', virtualPath: 'mounts/renders/saved.png' }
    const state = { ...execution({ save: { images: { typeId: 'IMAGE', meta: { shape: [1, 8, 16, 3] } } } }),
      artifacts: [saved, { ...saved, nodeId: 'other' }, { ...saved, mediaType: 'audio/wav', digest: digest('b') },
        { ...saved, name: 'original.exr', mediaType: 'image/x-exr', digest: digest('c'), size: 2 ** 30 + 1,
          preview: { digest: digest('d'), name: 'preview.png', size: 128, mediaType: 'image/png', virtualPath: 'previews/preview.png' } }] }
    const options = { runtimeIds: ['save'], assetUrlForExecution: (_ref: unknown, value: string) => `asset/${value}` }
    const result = executedImageInventory(state, options)
    expect(result).toEqual([expect.objectContaining({ kind: 'artifact', runtimeId: 'save',
      digest: digest('a'), virtualPath: 'mounts/renders/saved.png', url: `asset/${digest('a')}` })])
    const typed = { ...state, outputs: { save: { assets: asset(digest('a'), 'saved.png') } } }
    expect(executedImageInventory(typed, options)).toHaveLength(1)
  })

})
