import { describe, expect, it, vi } from 'vitest'
import type { ValueDescriptor } from '@dinkster/client'
import { fetchPeekRendition, imageBatchCount, type PeekValues } from '../src/peek-preview.js'

const descriptor: ValueDescriptor = { typeId: 'comfy.IMAGE', fingerprint: 'batch', meta: { shape: [9, 32, 48, 3] } }
const png = { kind: 'png', mime: 'image/png', default: true, version: 'png-test-v1', parameters: ['batch'], defaults: { batch: '0' }, limits: { maxEdge: 1024 } }
const colorTransform = 'PQ-to-sRGB; reinhard; reference-display'

describe('native IMAGE batch axis', () => {
  it('uses only the declared IMAGE batch shape, never list length or channel layout', () => {
    expect(imageBatchCount(descriptor)).toBe(9)
    expect(imageBatchCount({ ...descriptor, meta: { shape: [9, 32, 48, 3], channels: { layout: 'rgb' } } })).toBe(9)
    expect(imageBatchCount({ ...descriptor, meta: { shape: [9, 32, 48, 2], channels: { layout: 'gray_alpha', alpha: 'straight' } } })).toBe(9)
    for (const invalid of [
      { ...descriptor, typeId: 'list<comfy.IMAGE>', length: 99 },
      { ...descriptor, typeId: 'comfy.VIDEO' },
      { ...descriptor, meta: { shape: [7, 3, 32, 48], layout: 'BCHW' } },
      { ...descriptor, meta: { shape: [0, 32, 48, 3], layout: 'BHWC' } },
      { ...descriptor, meta: { shape: [Infinity, 32, 48, 3], layout: 'BHWC' } },
    ]) expect(imageBatchCount(invalid)).toBeUndefined()
  })

  it('keeps batch separate from nested list descent and retains exact identity', async () => {
    const peek = vi.fn<PeekValues['peek']>(async (query) => ({ available: true, renditions: [png],
      descriptor: (query.element?.length ?? 0) < 2 ? { typeId: 'list<comfy.IMAGE>', fingerprint: 'list', length: 2 } : descriptor,
    }))
    const rendition = vi.fn<PeekValues['rendition']>(async () => ({ available: true, bytes: new ArrayBuffer(1), mime: 'image/png', kind: 'png', fingerprint: 'batch', colorTransform }))
    const controller = new AbortController()
    const result = await fetchPeekRendition({ peek, rendition }, 'job-on-owner', [{ node: 'region[3]/image', output: 'IMAGE.OUT' }], undefined, { batchIndex: 3, signal: controller.signal })
    expect(result.count).toBe(9)
    expect(result.imageBatch?.query.element).toEqual([0, 0])
    expect(result.imageBatch?.descriptor).toBe(descriptor)
    expect(result.imageBatch?.rendition).toBe(png)
    expect(result.colorTransform).toBe(colorTransform)
    expect(rendition.mock.calls[0]?.[0]).toEqual({ jobId: 'job-on-owner', nodeId: 'region[3]/image', outputId: 'IMAGE.OUT', element: [0, 0] })
    expect(rendition.mock.calls[0]?.[2]?.batch).toBe(3)
    expect(rendition.mock.calls[0]?.[2]?.rendererVersion).toBe(png.version)
    expect(rendition.mock.calls[0]?.[2]?.signal).toBe(controller.signal)
  })

  it('does not issue a rendition after cancellation during metadata loading', async () => {
    const controller = new AbortController()
    const rendition = vi.fn<PeekValues['rendition']>()
    const values: PeekValues = { peek: async () => {
      controller.abort()
      return { available: true, descriptor, renditions: [png] }
    }, rendition }
    await expect(fetchPeekRendition(values, 'job', [{ node: 'n', output: 'o' }], undefined, { signal: controller.signal })).rejects.toThrow()
    expect(rendition).not.toHaveBeenCalled()
  })

  it('refuses an oversized batch image before requesting bytes and never negotiates raw tensors', async () => {
    const rendition = vi.fn<PeekValues['rendition']>()
    const oversized: PeekValues = { peek: async () => ({ available: true,
      descriptor: { ...descriptor, meta: { shape: [1000, 8192, 8192, 4] } }, renditions: [{ ...png, limits: {} }],
    }), rendition }
    await expect(fetchPeekRendition(oversized, 'job', [{ node: 'n', output: 'o' }])).rejects.toThrow('preview budget')
    const rawOnly: PeekValues = { peek: async () => ({ available: true, descriptor,
      renditions: [{ kind: 'raw', mime: 'application/octet-stream', default: true }],
    }), rendition }
    await expect(fetchPeekRendition(rawOnly, 'job', [{ node: 'n', output: 'o' }])).rejects.toThrow('does not advertise the PNG batch parameter')
    expect(rendition).not.toHaveBeenCalled()
  })

  it('uses the advertised maxEdge to admit a bounded preview of a large source', async () => {
    const source = { ...descriptor, meta: { shape: [1000, 8192, 8192, 4] } }
    const rendition = vi.fn<PeekValues['rendition']>(async () => ({ available: true, bytes: new ArrayBuffer(1), mime: 'image/png', kind: 'png', fingerprint: 'batch' }))
    const values: PeekValues = { peek: async () => ({ available: true, descriptor: source, renditions: [png] }), rendition }
    const result = await fetchPeekRendition(values, 'job', [{ node: 'n', output: 'o' }])
    expect(result.imageBatch?.descriptor).toBe(source)
    expect(result.imageBatch?.rendition.limits?.['maxEdge']).toBe(1024)
    expect(rendition).toHaveBeenCalledTimes(1)
    expect(rendition.mock.calls[0]?.[2]).toMatchObject({ batch: 0, rendererVersion: png.version })
    const unbounded: PeekValues = { peek: async () => ({ available: true, descriptor: source, renditions: [{ ...png, limits: { maxEdge: 8192 } }] }), rendition }
    await expect(fetchPeekRendition(unbounded, 'job', [{ node: 'n', output: 'o' }])).rejects.toThrow('preview budget')
    expect(rendition).toHaveBeenCalledTimes(1)
  })

  it('retains legacy singleton PNG previews without sending an unadvertised batch selector', async () => {
    const rendition = vi.fn<PeekValues['rendition']>(async () => ({ available: true, bytes: new ArrayBuffer(1), mime: 'image/png', kind: 'png', fingerprint: 'single' }))
    const values: PeekValues = { peek: async () => ({ available: true,
      descriptor: { ...descriptor, meta: { shape: [1, 32, 48, 4] } },
      renditions: [{ kind: 'png', mime: 'image/png', default: true }],
    }), rendition }
    const result = await fetchPeekRendition(values, 'job', [{ node: 'n', output: 'o' }])
    expect(result.mime).toBe('image/png')
    expect(result.imageBatch).toBeUndefined()
    expect(rendition).toHaveBeenCalledWith({ jobId: 'job', nodeId: 'n', outputId: 'o' }, 'png', {})
  })

  it('never infers batch capability from PNG, shape, or structural element advertisement', async () => {
    const rendition = vi.fn<PeekValues['rendition']>()
    for (const parameters of [undefined, [], ['element']]) {
      const values: PeekValues = { peek: async () => ({ available: true, descriptor,
        renditions: [{ kind: 'png', mime: 'image/png', default: true, ...(parameters === undefined ? {} : { parameters }) }],
      }), rendition }
      await expect(fetchPeekRendition(values, 'job', [{ node: 'n', output: 'o' }])).rejects.toThrow('does not advertise the PNG batch parameter')
    }
    expect(rendition).not.toHaveBeenCalled()
  })
})
