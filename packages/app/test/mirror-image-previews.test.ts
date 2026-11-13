/**
 * Estimator cache behavior over stubbed GL and bitmap seams: a miss kicks
 * one async compute and reports through onComputed, a hit returns the
 * decoded bitmap synchronously, failures are cached, each node owns one
 * slot keyed on the exact shader/imagery/scalar identity, over-capacity
 * working sets degrade without thrashing, and every replaced, reclaimed,
 * stale, or disposed bitmap is closed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GlslMirrorBinding } from '@dinkster/core'
import { createMirrorImageEstimator, type MirrorImageEstimateRequest } from '../src/mirror-image-previews.js'

const fakeBitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> }
const fakeImage = {} as CanvasImageSource
const fakeImageData = {} as ImageData

const binding = (over: Partial<GlslMirrorBinding> = {}): GlslMirrorBinding => ({
  source: 'void main() {}',
  images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
  scalars: [{ name: 'factor', glslType: 'float', value: 1.5 }],
  ...over,
})

const request = (over: Partial<MirrorImageEstimateRequest> = {}): MirrorImageEstimateRequest => ({
  nodeId: 'a1',
  nodeType: 'dinkster.image.adjust',
  binding: binding(),
  image: fakeImage,
  imageKey: 'preview:src',
  width: 4,
  height: 3,
  ...over,
})

/** Settle every in-flight compute (they only await resolved promises). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Estimator whose seams resolve instantly; computed() awaits onComputed. */
function harness(render: (draw: unknown) => ImageData | undefined = () => fakeImageData) {
  const bitmaps: ReturnType<typeof fakeBitmap>[] = []
  let notify: (() => void) | undefined
  const renderSpy = vi.fn(render)
  const onComputed = vi.fn(() => notify?.())
  const estimator = createMirrorImageEstimator({
    render: renderSpy as never,
    toBitmap: async () => {
      const bitmap = fakeBitmap()
      bitmaps.push(bitmap)
      return bitmap
    },
    onComputed,
  })
  const computed = () => new Promise<void>((resolve) => { notify = resolve })
  return { estimator, render: renderSpy, bitmaps, computed, onComputed }
}

describe('createMirrorImageEstimator', () => {
  it('computes a miss asynchronously and serves it from cache afterwards', async () => {
    const h = harness()
    const done = h.computed()
    expect(h.estimator.estimate(request())).toBeUndefined()
    await done
    const hit = h.estimator.estimate(request())
    expect(hit).toEqual({ image: h.bitmaps[0], width: 4, height: 3 })
    expect(h.render).toHaveBeenCalledTimes(1)
    expect(h.render).toHaveBeenCalledWith({
      source: 'void main() {}',
      images: [{ name: 'u_image', image: fakeImage }],
      scalars: [{ name: 'factor', glslType: 'float', value: 1.5 }],
      width: 4,
      height: 3,
    })
  })

  it('recomputes on changed scalars, imagery, or dimensions, closing the stale bitmap', async () => {
    const h = harness()
    const variants = [
      request(),
      request({ binding: binding({ scalars: [{ name: 'factor', glslType: 'float', value: 2 }] }) }),
      request({ imageKey: 'preview:other' }),
      request({ width: 8, height: 6 }),
    ]
    for (const [index, variant] of variants.entries()) {
      const done = h.computed()
      expect(h.estimator.estimate(variant)).toBeUndefined()
      await done
      expect(h.estimator.estimate(variant)?.image).toBe(h.bitmaps[index])
      expect(h.render).toHaveBeenCalledTimes(index + 1)
    }
    // The node holds one slot: each variant replaced its predecessor.
    for (const stale of h.bitmaps.slice(0, 3)) expect(stale.close).toHaveBeenCalledTimes(1)
    expect(h.bitmaps[3]!.close).not.toHaveBeenCalled()
  })

  it('caches per node: distinct nodes never share or displace each other', async () => {
    const h = harness()
    h.estimator.estimate(request({ nodeId: 'a1' }))
    h.estimator.estimate(request({ nodeId: 'a2' }))
    await flush()
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.estimator.estimate(request({ nodeId: 'a1' }))?.image).toBe(h.bitmaps[0])
    expect(h.estimator.estimate(request({ nodeId: 'a2' }))?.image).toBe(h.bitmaps[1])
  })

  it('closes an in-flight result whose slot recomputed before completion', async () => {
    const resolvers: ((bitmap: ImageBitmap) => void)[] = []
    const onComputed = vi.fn()
    const estimator = createMirrorImageEstimator({
      render: () => fakeImageData,
      toBitmap: () => new Promise<ImageBitmap>((resolve) => resolvers.push(resolve)),
      onComputed,
    })
    const first = request()
    const second = request({ imageKey: 'preview:other' })
    expect(estimator.estimate(first)).toBeUndefined()
    expect(estimator.estimate(second)).toBeUndefined()
    const staleBitmap = fakeBitmap()
    const currentBitmap = fakeBitmap()
    resolvers[0]!(staleBitmap)
    resolvers[1]!(currentBitmap)
    await flush()
    // The first compute's slot moved on: its bitmap is released, and only
    // the current compute reports.
    expect(staleBitmap.close).toHaveBeenCalledTimes(1)
    expect(currentBitmap.close).not.toHaveBeenCalled()
    expect(onComputed).toHaveBeenCalledTimes(1)
    expect(estimator.estimate(second)?.image).toBe(currentBitmap)
    estimator.dispose()
  })

})
