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
import { createMirrorImageEstimator, mirrorImageEstimateIdentity, type MirrorImageEstimateRequest } from '../src/mirror-image-previews.js'

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

  it('caches draw failures instead of retrying every pass', async () => {
    const h = harness(() => undefined)
    const done = h.computed()
    expect(h.estimator.estimate(request())).toBeUndefined()
    await done
    expect(h.estimator.estimate(request())).toBeUndefined()
    expect(h.render).toHaveBeenCalledTimes(1)
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

  it('gives chained estimates a compact identity over the exact cache inputs', () => {
    const baseline = mirrorImageEstimateIdentity(request())
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(mirrorImageEstimateIdentity(request())).toBe(baseline)
    expect(mirrorImageEstimateIdentity(request({ imageKey: 'preview:other' }))).not.toBe(baseline)
    expect(mirrorImageEstimateIdentity(request({
      binding: binding({ scalars: [{ name: 'factor', glslType: 'float', value: 2 }] }),
    }))).not.toBe(baseline)
  })

  it('keys on exact shader source, not a hash of it', async () => {
    // Equal-length sources colliding under 32-bit FNV-1a: a key reduced to
    // such a hash serves one shader's image for the other.
    const sourceA = 'void main() { out_color = vec4(0.269118); }'
    const sourceB = 'void main() { out_color = vec4(1.229382); }'
    const fnv1a = (text: string): number => {
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
      return hash >>> 0
    }
    expect(sourceA.length).toBe(sourceB.length)
    expect(fnv1a(sourceA)).toBe(fnv1a(sourceB))
    const h = harness()
    const done = h.computed()
    h.estimator.estimate(request({ binding: binding({ source: sourceA }) }))
    await done
    expect(h.estimator.estimate(request({ binding: binding({ source: sourceB }) }))).toBeUndefined()
    expect(h.render).toHaveBeenCalledTimes(2)
    expect(h.render).toHaveBeenLastCalledWith(expect.objectContaining({ source: sourceB }))
  })

  it('refuses bindings without exactly one image uniform', () => {
    const h = harness()
    expect(h.estimator.estimate(request({ binding: binding({ images: [] }) }))).toBeUndefined()
    expect(h.render).not.toHaveBeenCalled()
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

  it('refuses admission past capacity instead of thrashing live slots', async () => {
    const h = harness()
    const scan = (): number[] => {
      const served: number[] = []
      for (let index = 0; index < 65; index++) {
        const hit = h.estimator.estimate(request({ nodeId: `n${index}`, imageKey: `preview:${index}` }))
        if (hit !== undefined) served.push(index)
      }
      return served
    }
    expect(scan()).toEqual([])
    await flush()
    // The 65th node found every slot live and was refused, not admitted by
    // evicting a live entry.
    expect(h.render).toHaveBeenCalledTimes(64)
    expect(h.onComputed).toHaveBeenCalledTimes(64)
    // Second and third scans: the 64 admitted nodes hit, nothing recomputes,
    // no bitmap is closed, and the overflow node stays refused.
    expect(scan()).toEqual([...Array(64).keys()])
    expect(scan()).toEqual([...Array(64).keys()])
    await flush()
    expect(h.render).toHaveBeenCalledTimes(64)
    expect(h.onComputed).toHaveBeenCalledTimes(64)
    for (const bitmap of h.bitmaps) expect(bitmap.close).not.toHaveBeenCalled()
  })

  it('reclaims a slot once no pass requests its node anymore', async () => {
    const h = harness()
    for (let index = 0; index < 64; index++) {
      h.estimator.estimate(request({ nodeId: `n${index}`, imageKey: `preview:${index}` }))
    }
    await flush()
    expect(h.render).toHaveBeenCalledTimes(64)
    // n0 left the graph; passes now cover n1..n63 plus the new n64.
    for (let index = 1; index < 64; index++) {
      h.estimator.estimate(request({ nodeId: `n${index}`, imageKey: `preview:${index}` }))
    }
    expect(h.estimator.estimate(request({ nodeId: 'n64', imageKey: 'preview:64' }))).toBeUndefined()
    await flush()
    expect(h.render).toHaveBeenCalledTimes(65)
    expect(h.bitmaps[0]!.close).toHaveBeenCalledTimes(1)
    expect(h.estimator.estimate(request({ nodeId: 'n64', imageKey: 'preview:64' }))?.image).toBe(h.bitmaps[64])
  })

  it('closes every cached bitmap on dispose and refuses further work', async () => {
    const h = harness()
    const done = h.computed()
    h.estimator.estimate(request())
    await done
    h.estimator.dispose()
    expect(h.bitmaps[0]!.close).toHaveBeenCalled()
    expect(h.estimator.estimate(request())).toBeUndefined()
    expect(h.render).toHaveBeenCalledTimes(1)
  })

  it('closes results that finish only after dispose', async () => {
    const resolvers: ((bitmap: ImageBitmap) => void)[] = []
    const onComputed = vi.fn()
    const estimator = createMirrorImageEstimator({
      render: () => fakeImageData,
      toBitmap: () => new Promise<ImageBitmap>((resolve) => resolvers.push(resolve)),
      onComputed,
    })
    expect(estimator.estimate(request())).toBeUndefined()
    estimator.dispose()
    const lateBitmap = fakeBitmap()
    resolvers[0]!(lateBitmap)
    await flush()
    expect(lateBitmap.close).toHaveBeenCalledTimes(1)
    expect(onComputed).not.toHaveBeenCalled()
  })
})
