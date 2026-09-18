/**
 * Bounded async cache of GPU-computed image estimates. The overlay pass asks
 * synchronously for an estimate of a mirrored node given its upstream
 * preview imagery and derived glsl binding; a hit returns a decoded bitmap
 * immediately, a miss kicks one background compute (GL draw + bitmap
 * decode) and reports through `onComputed` so the host re-derives overlays,
 * at which point the same key hits. Failures are cached too - a shader or
 * upload that failed once would fail identically every frame.
 *
 * Each node holds at most one slot (its current inputs have exactly one
 * estimate), so a changed key replaces that node's entry in place and the
 * cache never competes across nodes that are all on screen. Admitting a new
 * node when every slot was requested within the last `CACHE_LIMIT` calls
 * would evict a live entry and re-render it next pass forever; such a miss
 * is refused instead, so an over-capacity working set degrades to "no
 * estimate" for the overflow nodes. Entries pin GPU-backed ImageBitmaps:
 * every replaced, reclaimed, or disposed entry closes its bitmap, and a
 * compute whose slot moved on closes its own result. Keys capture
 * everything the output depends on: the full shader source, upstream
 * imagery identity and dimensions, and every scalar uniform value.
 */
import { sha256Hex, type GlslMirrorBinding, type GlslScalarUniform } from '@dinkster/core'
import type { GlslDisplayDraw } from './mirror-glsl-runner.js'

export interface MirrorImageEstimate {
  readonly image: ImageBitmap
  readonly width: number
  readonly height: number
}

export interface MirrorImageEstimateRequest {
  /** Scene node the estimate is for; each node owns one cache slot. */
  readonly nodeId: string
  /** Node type of the mirrored node (schema identity for the shader). */
  readonly nodeType: string
  readonly binding: GlslMirrorBinding
  /** Decoded upstream imagery for the binding's single image uniform. */
  readonly image: CanvasImageSource
  /** Upstream preview-source identity (content-addressed where possible). */
  readonly imageKey: string
  /** Output dimensions; pointwise shaders use the upstream decoded size. */
  readonly width: number
  readonly height: number
}

export interface MirrorImageEstimator {
  /**
   * The cached estimate for `request`, or undefined while one is being
   * computed (or after its compute failed). Never blocks.
   */
  estimate(request: MirrorImageEstimateRequest): MirrorImageEstimate | undefined
  /** Close every cached bitmap and drop the cache. */
  dispose(): void
}

type CacheEntry =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly estimate: MirrorImageEstimate }
  | { readonly state: 'failed' }

interface CacheSlot {
  key: string
  /** Compute claims: a completion applies only while its entry is current. */
  entry: CacheEntry
  lastAccess: number
}

const CACHE_LIMIT = 64

const scalarPairs = (scalars: readonly GlslScalarUniform[]): unknown[] =>
  scalars.map((scalar) => [scalar.name, scalar.glslType, scalar.value])

const cacheKeyOf = (request: MirrorImageEstimateRequest): string => JSON.stringify([
  request.nodeType,
  request.binding.source,
  request.imageKey,
  request.width,
  request.height,
  scalarPairs(request.binding.scalars),
])

/** Compact content identity for feeding one estimate into another mirror. */
export const mirrorImageEstimateIdentity = (request: MirrorImageEstimateRequest): string =>
  `sha256:${sha256Hex(cacheKeyOf(request))}`

/** Every CanvasImageSource except SVGImageElement is a valid GL upload. */
const asTexImageSource = (image: CanvasImageSource): TexImageSource | undefined =>
  typeof SVGImageElement !== 'undefined' && image instanceof SVGImageElement
    ? undefined
    : (image as TexImageSource)

export function createMirrorImageEstimator(seams: {
  /** GPU draw seam (a runner's renderDisplay); undefined = fail soft. */
  readonly render: (draw: GlslDisplayDraw) => ImageData | undefined
  /** Decode seam; defaults to createImageBitmap. Tests stub both. */
  readonly toBitmap?: (data: ImageData) => Promise<ImageBitmap>
  /** A miss finished computing; the host should re-derive overlays. */
  readonly onComputed: () => void
}): MirrorImageEstimator {
  const toBitmap = seams.toBitmap ?? ((data: ImageData) => createImageBitmap(data))
  const slots = new Map<string, CacheSlot>()
  let ticks = 0
  let disposed = false

  const retire = (entry: CacheEntry): void => {
    if (entry.state === 'ready') entry.estimate.image.close()
  }

  const compute = async (nodeId: string, claim: CacheEntry, request: MirrorImageEstimateRequest): Promise<void> => {
    let result: CacheEntry = { state: 'failed' }
    try {
      const upload = asTexImageSource(request.image)
      const drawn = upload === undefined ? undefined : seams.render({
        source: request.binding.source,
        images: [{ name: request.binding.images[0]!.name, image: upload }],
        scalars: request.binding.scalars,
        width: request.width,
        height: request.height,
      })
      if (drawn !== undefined) {
        const image = await toBitmap(drawn)
        result = { state: 'ready', estimate: { image, width: request.width, height: request.height } }
      }
    } catch {
      result = { state: 'failed' }
    }
    const slot = slots.get(nodeId)
    if (disposed || slot === undefined || slot.entry !== claim) {
      // The slot was replaced, reclaimed, or disposed while computing; the
      // result belongs to nobody, so release it here.
      retire(result)
      return
    }
    slot.entry = result
    seams.onComputed()
  }

  return {
    estimate(request) {
      if (disposed || request.binding.images.length !== 1) return undefined
      const key = cacheKeyOf(request)
      const tick = ++ticks
      const entry: CacheEntry = { state: 'pending' }
      const slot = slots.get(request.nodeId)
      if (slot !== undefined) {
        slots.delete(request.nodeId)
        slots.set(request.nodeId, slot)
        slot.lastAccess = tick
        if (slot.key === key) return slot.entry.state === 'ready' ? slot.entry.estimate : undefined
        // The node's inputs changed: its one slot recomputes in place.
        retire(slot.entry)
        slot.key = key
        slot.entry = entry
      } else {
        if (slots.size >= CACHE_LIMIT) {
          const [oldestId, oldest] = slots.entries().next().value!
          // Reclaim only a slot no overlay pass still touches; evicting a
          // live one would re-render the working set every pass.
          if (tick - oldest.lastAccess <= CACHE_LIMIT) return undefined
          retire(oldest.entry)
          slots.delete(oldestId)
        }
        slots.set(request.nodeId, { key, entry, lastAccess: tick })
      }
      // The slot is installed before the compute starts: a compute that
      // finishes synchronously must find its own claim current.
      void compute(request.nodeId, entry, request)
      return undefined
    },
    dispose() {
      disposed = true
      for (const slot of slots.values()) retire(slot.entry)
      slots.clear()
    },
  }
}
