/**
 * Node preview loading: picks the imagery source for a scene node (live
 * sampling frame, output thumbnail, or native peek) and owns the decode
 * pipeline - a bounded decode-once cache, in-flight dedupe, and a negative
 * cache for definitive peek misses. This module is framework-free: the host
 * decides which nodes want previews and re-assembles the preview
 * map when a decode lands (onDecoded); this module never subscribes to
 * anything and touches no reactive state.
 */

import type { NodePreview, NodePreviewAnimation } from '@dinkster/canvas'
import type { DinksterValuesClient, ExecutionState, PreviewData, PreviewRing } from '@dinkster/client'
import {
  parseListTypeId,
  type CompanionSourceMap,
  type Json,
  type NodeSchema,
  type WidgetRegistry,
} from '@dinkster/core'
import { recordedTextOutputForNode, type RecordedTextOutput } from './data-lens.js'
import { isModel3dMime } from './model3d-mime.js'
import { declaredPreviewCandidates, fetchPeekRendition, ImageBatchUnsupportedError, MEDIA_VALIDATION_BUDGET_MS, peekCandidatesFor, type PeekCandidate } from './peek-preview.js'
import { executedImageInventory, type ExecutedImage, type ExecutedImageBatch } from './executed-image-inventory.js'
import { videoInspectionFor } from './video-preview.js'
import { audioPreview } from './audio-preview.js'

// Sized for animated live previews: one video node's frame ring can hold
// ~20 decoded slots alongside the ordinary per-node stills and thumbnails.
const PREVIEW_CACHE_MAX = 160

/**
 * Each bitmap costs one unit per MiB of RGBA pixels, rounded up to at least one.
 * Animation frames share this budget with stills and IMAGE batch pages.
 */
const PREVIEW_CACHE_WEIGHT_MAX = 256
const PEEK_MISS_MAX = 512
const IMAGE_MISS_MAX = 512
const framePayloadIds = new WeakMap<Blob | ArrayBuffer, number>()
let nextFramePayloadId = 1

const directMediaKey = (digest: string, mediaType: string, url: string): string =>
  `asset:${digest}:media:${mediaType}:url:${url}`

const recordedMediaKey = (digest: string, mediaType: string, url: string, name: string): string =>
  `recorded:${directMediaKey(digest, mediaType, url)}:name:${encodeURIComponent(name)}`

const isUrlBackedSourceKey = (key: string): boolean =>
  key.startsWith('asset:') || key.startsWith('img:') || key.startsWith('recorded:')

const safeDownloadName = (name: string, fallback: string): string => {
  const safe = name
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 240)
  return safe || fallback
}

const downloadNameForRendition = (output: string, mime: string): string => {
  const safeOutput = output.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'output'
  const subtype = mime.split('/', 2)[1]?.split(/[;+]/, 1)[0]?.toLowerCase()
  const extension = subtype === 'gltf-binary'
    ? 'glb'
    : subtype === 'jpeg'
      ? 'jpg'
      : subtype === 'x-wav'
        ? 'wav'
        : subtype?.match(/^[a-z0-9]+$/)?.[0] ?? 'bin'
  return `${safeOutput}.${extension}`
}

/**
 * Confirm browser-decodable metadata before committing to an AV candidate.
 * `deadline` (absolute ms timestamp) bounds the wait; a candidate sequence
 * passes one shared deadline so the total wait stays a single budget.
 */
export function validateBrowserMediaRendition(
  result: { readonly bytes: ArrayBuffer; readonly mime: string },
  deadline: number = Date.now() + MEDIA_VALIDATION_BUDGET_MS,
): Promise<boolean> {
  if (result.mime !== 'video/mp4' && result.mime !== 'video/webm' && result.mime !== 'audio/wav') return Promise.resolve(true)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve(false)
  const media = document.createElement(result.mime.startsWith('video/') ? 'video' : 'audio')
  const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }))
  return new Promise((resolve) => {
    let settled = false
    const finish = (valid: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      media.removeAttribute('src')
      media.load()
      URL.revokeObjectURL(url)
      resolve(valid)
    }
    const timer = window.setTimeout(() => finish(false), remaining)
    media.preload = 'metadata'
    media.addEventListener('loadedmetadata', () => finish(true), { once: true })
    media.addEventListener('error', () => finish(false), { once: true })
    media.src = url
    media.load()
  })
}

function framePayloadId(payload: Blob | ArrayBuffer): number {
  const known = framePayloadIds.get(payload)
  if (known !== undefined) return known
  const id = nextFramePayloadId++
  framePayloadIds.set(payload, id)
  return id
}

/** One preview source with explicit positive and failure cache identities. */
export interface PreviewSource {
  /** Content-addressed decoded asset images use digest identity; direct audio/video includes MIME and its owning URL. */
  readonly key: string
  /** Backend/URL-specific failure identity for sources that depend on an owning backend. */
  readonly failureKey?: string
  /** Exact runtime occurrence selected for a frame or recorded output. */
  readonly runtimeId?: string | undefined
  readonly declaredIntent?: true
  readonly mediaKind?: 'image' | 'video' | 'audio' | 'model3d'
  readonly output?: { readonly index: number; readonly count: number }
  /** Exact schema output the imagery is attributed to, where known. */
  readonly outputId?: string
  readonly imageBatch?: ExecutedImageBatch | undefined
  readonly refusal?: string | undefined
  readonly cancellationKey?: string
  load(signal?: AbortSignal): Promise<NodePreview>
}

export interface PreviewLoader {
  /**
   * Pick the preview source for one scene node. `runtimeIds` is the view's
   * occurrence mapping for the node (own occurrence + everything nested
   * beneath it): a subgraph instance shows imagery from ANY inner occurrence
   * (latest frame wins), mirroring nodeStatesForGraph's aggregation.
   */
  sourceFor(
    exec: ExecutionState,
    runtimeIds: readonly string[],
    running: boolean,
    outputIndex?: number,
  ): PreviewSource | undefined
  inventoryFor?(exec: ExecutionState, runtimeIds: readonly string[]): readonly ExecutedImage[]
  /** Selected renderable ASSET input, independent of execution state. */
  inputAssetSource?(digest: string, mediaType: string, mediaKind: 'image' | 'video' | 'audio' | 'model3d'): PreviewSource | undefined
  /**
   * Native peek source (GET /api/values) for recorded outputs the event
   * stream never carried. Returns undefined when the key is negative-cached
   * (a prior definitive miss: scalar-only, no renditions, not retained) so
   * the caller never refetches it on every overlay refresh; a rewire
   * changes the key and retries naturally.
   */
  peekSource(
    values: DinksterValuesClient,
    exec: ExecutionState,
    candidates: readonly PeekCandidate[],
    sceneNodeId: string,
    batchIndex?: number,
  ): PreviewSource | undefined
  /**
   * Cached decode for the source, or undefined while one is kicked off
   * (deduped). When an async decode lands, onDecoded fires so the host can
   * re-assemble its preview map. Undecodable frames are dropped silently;
   * DEFINITIVE peek failures are negative-cached, transient transport
   * failures stay retryable.
   */
  resolve(source: PreviewSource): NodePreview | undefined
  /**
   * Cached decode of one ring-addressed live animation frame; kicks the
   * decode (and later onDecoded) when absent. Shares the bounded
   * decode-once cache, so ring slots age out with everything else.
   */
  resolveFrame?(key: string, payload: Blob | ArrayBuffer): CanvasImageSource | undefined
  /** True after a content-addressed asset decode failed definitively. */
  unavailable?(source: PreviewSource): boolean
  /** Record a definitive host media-element failure for this exact source URL. */
  markUnavailable?(source: PreviewSource): void
  dispose?(): void
}

export interface SelectedPreviewAsset {
  readonly digest: string
  readonly name: string
  readonly count: number
  readonly mediaType: string
  readonly mediaKind: 'image' | 'video' | 'model3d'
  /** Exact represented output when this asset is a schema-declared estimate. */
  readonly outputId?: string
}

/** MIME family that must own an asset's mediaType for its preview kind. */
const mimeFamilyOfKind = (mediaKind: 'image' | 'video' | 'model3d'): string =>
  mediaKind === 'model3d' ? 'model' : mediaKind

/** First stored ASSET value claimed by a registered image/video/model3d renderer. */
export function selectedPreviewAssetForRows(
  values: Readonly<Record<string, Json>>,
  rows: readonly { readonly widgetType: string; readonly valueKey: string }[],
  previewRendererFor: WidgetRegistry['previewRendererFor'],
): SelectedPreviewAsset | undefined {
  for (const row of rows) {
    if (row.widgetType !== 'ASSET') continue
    const stored = values[row.valueKey]
    const first = Array.isArray(stored) ? stored[0] : stored
    if (typeof first !== 'object' || first === null || Array.isArray(first)) continue
    const asset = first as { digest?: unknown; name?: unknown; size?: unknown; mediaType?: unknown; virtualPath?: unknown }
    if (typeof asset.digest !== 'string' || !/^blake3:[0-9a-f]{64}$/.test(asset.digest) ||
        typeof asset.name !== 'string' || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0 ||
        typeof asset.mediaType !== 'string' || typeof asset.virtualPath !== 'string') continue
    const mediaKind = previewRendererFor(asset.mediaType)?.mediaKind
    if (mediaKind !== 'image' && mediaKind !== 'video' && mediaKind !== 'model3d') continue
    if (!asset.mediaType.startsWith(`${mimeFamilyOfKind(mediaKind)}/`)) continue
    return {
      digest: asset.digest,
      name: asset.name,
      count: Array.isArray(stored) ? stored.length : 1,
      mediaType: asset.mediaType,
      mediaKind,
    }
  }
  return undefined
}

export interface NodePreviewExecutionOutput {
  readonly key: string
  readonly images: readonly ExecutedImage[]
  readonly batch?: ExecutedImageBatch
  readonly refusal?: string
  readonly index: number
  readonly count: number
  readonly mediaKind?: 'image' | 'video' | 'audio' | 'model3d'
}

export interface NodePreviewSurface {
  readonly preview?: NodePreview
  readonly source?: PreviewSource
  readonly refusal?: string
  readonly executedOutput?: NodePreviewExecutionOutput
  readonly selectedInput?: {
    readonly name: string
    readonly count: number
    readonly preview: NodePreview
  }
  readonly text?: RecordedTextOutput
}

// Largest ring worth animating: the frames array allocates frameCount slots,
// so an absurd frameCount from a buggy backend must not exhaust memory.
// Oversized rings degrade to the ordinary newest-frame still.
const ANIMATION_RING_MAX = 256

// Image containers that can carry a whole animation in one live frame
// (the backend's encoded-animation preview transport ships animated WebP).
const ANIMATED_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/webp', 'image/gif'])
// Cycling rate when the container declares no frame timing.
const ANIMATED_IMAGE_FALLBACK_FPS = 8

/**
 * The one live frame a node's preview surface shows, across the node's
 * latent streams. A stream that is animating (has a live frame ring)
 * wins, non-audio outranking audio; without rings the freshest non-audio
 * still wins, falling back to audio when nothing else previews.
 */
function selectedPreviewFrame(
  streams: Readonly<Record<string, PreviewData>> | undefined,
  rings: Readonly<Record<string, PreviewRing>> | undefined,
): PreviewData | undefined {
  if (streams === undefined) return undefined
  let chosen: PreviewData | undefined
  let chosenRank = -1
  let chosenAt = -1
  for (const [key, frame] of Object.entries(streams)) {
    const audio = key === 'audio'
    const rank = rings?.[key] !== undefined ? (audio ? 2 : 3) : audio ? 0 : 1
    if (rank < chosenRank || (rank === chosenRank && frame.timestamp <= chosenAt)) continue
    chosen = frame
    chosenRank = rank
    chosenAt = frame.timestamp
  }
  return chosen
}

/**
 * The decoded animation for one running node's preview frame ring, or
 * undefined when the node has no usable ring (no ring, no fps, or a
 * single-slot or oversized ring that a plain still serves just as well).
 * Undecoded slots stay undefined; each resolveFrame call kicks the decode.
 */
function ringAnimationFor(
  exec: ExecutionState,
  runtimeId: string,
  loader: PreviewLoader,
): NodePreviewAnimation | undefined {
  const nodeRings = exec.previewRings?.[runtimeId]
  // The ring must belong to the same stream the surface's still came from,
  // so the animation never cycles a different stream over the shown frame.
  const frame = selectedPreviewFrame(exec.previews[runtimeId], nodeRings)
  const ring = frame === undefined ? undefined : nodeRings?.[frame.stream ?? '']
  if (ring === undefined || ring.fps === undefined) return undefined
  if (ring.frameCount < 2 || ring.frameCount > ANIMATION_RING_MAX) return undefined
  if (loader.resolveFrame === undefined) return undefined
  const frames: (CanvasImageSource | undefined)[] = Array.from({ length: ring.frameCount }, () => undefined)
  for (const [slot, frame] of Object.entries(ring.frames)) {
    const index = Number(slot)
    if (!Number.isInteger(index) || index < 0 || index >= ring.frameCount) continue
    const payload = frame.payload
    if (!(payload instanceof Blob) && !(payload instanceof ArrayBuffer)) continue
    frames[index] = loader.resolveFrame(
      `frame:${exec.key}:${runtimeId}:ring:${index}:${framePayloadId(payload)}`,
      payload,
    )
  }
  return { frames, fps: ring.fps }
}

/**
 * Derives the preview surface shared by the graph and App views. A media
 * source wins over recorded text, and the source order is owned by the same
 * loader and peek candidate helpers used by the canvas.
 */
export function deriveNodePreviewSurface(args: {
  readonly nodeId: string
  readonly isSubgraph: boolean
  readonly schema: NodeSchema | undefined
  readonly exec: ExecutionState | undefined
  /** Own and nested runtime occurrences accepted by live/output imagery. */
  readonly runtimeIds: readonly string[]
  /** Own occurrences used by recorded output and producer attribution. */
  readonly runtimeIdsOf: ((nodeId: string) => readonly string[]) | undefined
  readonly running: boolean
  readonly frozen: boolean
  readonly exactProducer: ((runtimeId: string) => boolean) | undefined
  readonly retainedRuntimeIds?: ReadonlySet<string>
  readonly companionSources: CompanionSourceMap
  readonly values: DinksterValuesClient | undefined
  readonly selectedAsset: SelectedPreviewAsset | undefined
  readonly loader: PreviewLoader
  readonly outputKey: string
  readonly outputIndex?: (key: string) => number
}): NodePreviewSurface {
  const { exec } = args
  let selectedInput: SelectedPreviewAsset | undefined
  let selectedAsset: SelectedPreviewAsset | undefined
  let representedOutput = false
  let retainedSource = false
  let source: PreviewSource | undefined
  let executedOutput: NodePreviewExecutionOutput | undefined
  if (exec !== undefined) {
    const currentRuntimeIds = args.runtimeIds.filter((runtimeId) => args.retainedRuntimeIds?.has(runtimeId) !== true)
    const retainedRuntimeIds = args.runtimeIds.filter((runtimeId) => args.retainedRuntimeIds?.has(runtimeId) === true)
    const currentImages = args.loader.inventoryFor?.(exec, currentRuntimeIds) ?? []
    source = args.loader.sourceFor(exec, currentRuntimeIds, args.running, args.outputIndex?.(args.outputKey))
    if (source?.output !== undefined) {
      executedOutput = {
        key: args.outputKey,
        images: currentImages,
        index: source.output.index,
        count: source.output.count,
        ...(source.mediaKind === undefined ? {} : { mediaKind: source.mediaKind }),
      }
    }
    if (source === undefined && retainedRuntimeIds.length > 0) {
      const retainedKey = `${args.outputKey}\u0000retained`
      const retainedImages = args.loader.inventoryFor?.(exec, retainedRuntimeIds) ?? []
      source = args.loader.sourceFor(exec, retainedRuntimeIds, false, args.outputIndex?.(retainedKey))
      if (source?.output !== undefined) {
        executedOutput = {
          key: retainedKey,
          images: retainedImages,
          index: source.output.index,
          count: source.output.count,
          ...(source.mediaKind === undefined ? {} : { mediaKind: source.mediaKind }),
        }
      }
      retainedSource = source !== undefined
    }
    if (source === undefined && args.values !== undefined) {
      const outputOrder = args.schema?.items
        .filter((item) => item.kind === 'output')
        .map((item) => item.id) ?? []
      const aliases = exec.artifact?.provenance.outputAliases
      const recorded = peekCandidatesFor({
        sources: args.companionSources,
        execNodes: exec.nodes,
        execOutputs: exec.outputs,
        nodeId: args.nodeId,
        runtimeIdsOf: args.runtimeIdsOf,
        outputOrder,
        ...(aliases === undefined ? {} : { outputAliases: aliases }),
      })
      const images = recorded.filter((candidate) => {
        const descriptor = exec.nodes[candidate.node]?.outputs?.[candidate.output] ?? exec.outputs[candidate.node]?.[candidate.output]
        const typeId = typeof descriptor === 'object' && descriptor !== null
          ? (descriptor as { typeId?: unknown }).typeId
          : undefined
        if (typeof typeId !== 'string') return false
        let base = typeId
        for (let inner = parseListTypeId(base); inner !== undefined; inner = parseListTypeId(base)) base = inner
        return /(?:^|\.)(?:image|mask|audio)$/i.test(base)
      })
      const ownIds = args.runtimeIdsOf?.(args.nodeId) ?? []
      const declared = declaredPreviewCandidates(args.schema, ownIds).map((candidate) => ({
        ...candidate,
        output: aliases?.[candidate.node]?.[candidate.output] ?? candidate.output,
      })).filter((candidate) =>
        exec.nodes[candidate.node]?.outputs?.[candidate.output] !== undefined ||
        exec.outputs[candidate.node]?.[candidate.output] !== undefined)
      const candidates = images.map((image) => {
        const intent = declared.find((candidate) => candidate.node === image.node && candidate.output === image.output)
        return intent === undefined
          ? image
          : { ...image, declaredIntent: true as const, ...(intent.mediaKind === undefined ? {} : { mediaKind: intent.mediaKind }) }
      })
      candidates.push(...declared.filter((candidate) =>
        !images.some((image) => image.node === candidate.node && image.output === candidate.output)))
      if (candidates.length > 0) source = args.loader.peekSource(args.values, exec, candidates, args.nodeId, args.outputIndex?.(args.outputKey))
    }
  }
  const selected = args.selectedAsset
  const representedOutputId = selected?.outputId
  if (selected !== undefined && representedOutputId !== undefined && (source === undefined || retainedSource)) {
    const inputSource = args.loader.inputAssetSource?.(selected.digest, selected.mediaType, selected.mediaKind)
    if (inputSource !== undefined) {
      source = { ...inputSource, outputId: representedOutputId }
      selectedAsset = selected
      representedOutput = true
      retainedSource = false
      executedOutput = undefined
    }
  }
  if (source === undefined && selected !== undefined && selected.outputId === undefined) {
    const inputSource = args.loader.inputAssetSource?.(selected.digest, selected.mediaType, selected.mediaKind)
    if (inputSource !== undefined) {
      source = inputSource
      selectedAsset = selected
      selectedInput = selected
    }
  }
  if (source === undefined) {
    const text = recordedTextOutputForNode(
      { id: args.nodeId, isSubgraph: args.isSubgraph },
      {
        execNodes: exec?.nodes,
        runtimeIdsOf: args.runtimeIdsOf,
        frozen: args.frozen,
        exactProducer: args.exactProducer,
      },
    )
    return text === null ? {} : { text }
  }
  const decoded = args.loader.resolve(source)
  const batch = source.imageBatch
  const refusal = source.refusal
  const batchShape = batch?.imageAt(0).descriptor?.meta?.['shape'] as readonly number[] | undefined
  if (refusal !== undefined) executedOutput = { key: args.outputKey, images: [], count: 1, index: 0, mediaKind: 'image', refusal }
  if (batch !== undefined) {
    executedOutput = {
      key: args.outputKey, images: [], batch, count: batch.count,
      index: Math.max(0, Math.min(args.outputIndex?.(args.outputKey) ?? 0, batch.count - 1)), mediaKind: 'image',
    }
  }
  const base = decoded !== undefined
    ? selectedAsset !== undefined
      ? { ...decoded, count: selectedAsset.count }
      : source.output !== undefined
        ? { ...decoded, count: source.output.count, index: source.output.index }
        : batch !== undefined ? { ...decoded, count: batch.count, index: executedOutput!.index } : decoded
    : {
        status: args.loader.unavailable?.(source) === true ? 'unavailable' as const : 'loading' as const,
        ...(source.mediaKind === undefined ? {} : { kind: source.mediaKind }),
        ...(source.output === undefined ? {} : { count: source.output.count, index: source.output.index }),
        ...(selectedAsset === undefined ? {} : { count: selectedAsset.count }),
        ...(batch === undefined || batchShape === undefined ? {} : { count: batch.count, index: executedOutput!.index, width: batchShape[2]!, height: batchShape[1]! }),
      }
  // A live frame that belongs to a ring animates: the canvas cycles the
  // ring's decoded slots at fps while its running-node frame loop runs.
  const animation =
    args.running && exec !== undefined && source.runtimeId !== undefined && source.key.startsWith('frame:')
      ? ringAnimationFor(exec, source.runtimeId, args.loader)
      : undefined
  const animatedPreview = animation === undefined ? base : { ...base, animation }
  const preview = representedOutput
    ? { ...animatedPreview, state: 'estimate' as const }
    : animatedPreview
  const retainedPreview = source.runtimeId !== undefined && args.retainedRuntimeIds?.has(source.runtimeId) === true
    ? { ...preview, state: 'cached' as const }
    : preview
  return {
    preview: retainedPreview,
    source,
    ...(refusal === undefined ? {} : { refusal }),
    ...(executedOutput === undefined ? {} : { executedOutput }),
    ...(selectedInput?.mediaKind === 'image'
      ? { selectedInput: { name: selectedInput.name, count: selectedInput.count, preview: retainedPreview } }
      : {}),
  }
}

export function createPreviewLoader(deps: {
  /** /view URL routed through the execution's OWN backend. */
  viewUrlForExecution: (
    ref: ExecutionState['ref'],
    file: { filename: string; subfolder?: string; type?: string },
  ) => string
  /** /api/assets/{digest} URL routed through the execution's OWN backend. */
  assetUrlForExecution: (ref: ExecutionState['ref'], digest: string) => string
  /** Current editable tab's native asset URL; undefined on non-native tabs. */
  assetUrlForInput: (digest: string) => string | undefined
  /** A finished async decode: re-assemble the preview map. */
  onDecoded: () => void
  /** Browser metadata validation lets corrupt AV fall through to the next candidate; the loop's shared deadline bounds the whole sequence. */
  validateMediaRendition?: (result: { readonly bytes: ArrayBuffer; readonly mime: string }, deadline?: number) => Promise<boolean>
  /** Injectable GLB poster render; the default lazy-loads three.js. Tests inject a fake (no WebGL in jsdom). */
  renderModel3dPoster?: (src: string, mime?: string) => Promise<{ readonly image: CanvasImageSource; readonly width: number; readonly height: number }>
  /** Injectable fetch for recorded outputs, which become owned blob URLs so downloads work across origins. */
  fetchRecordedOutput?: (url: string, options?: RequestInit) => Promise<Response>
}): PreviewLoader & { dispose(): void } {
  const cache = new Map<string, NodePreview>()
  const pending = new Map<string, symbol>()
  const peekMisses = new Set<string>()
  const imageMisses = new Set<string>()
  const imageBatches = new Map<string, ExecutedImageBatch>()
  const imageRefusals = new Map<string, string>()
  const requests = new Map<string, { readonly key: string; readonly controller: AbortController }>()
  let disposed = false

  const release = (preview: NodePreview): void => {
    // A Set dedupes the still against animation frame 0 (the same bitmap);
    // closing twice is an error in some engines.
    const resources = new Set([preview.image, ...(preview.animation?.frames ?? [])])
    for (const resource of resources) {
      if (typeof ImageBitmap !== 'undefined' && resource instanceof ImageBitmap) resource.close()
    }
    if (preview.src !== undefined) URL.revokeObjectURL(preview.src)
  }

  const weightOf = (preview: NodePreview): number =>
    (1 + (preview.animation?.frames.length ?? 0)) * Math.max(1, Math.ceil((preview.width ?? 1) * (preview.height ?? 1) / (256 * 1024)))
  let cacheWeight = 0

  const evict = (key: string): void => {
    const old = cache.get(key)
    if (old === undefined) return
    cache.delete(key)
    cacheWeight -= weightOf(old)
    release(old)
  }

  const put = (key: string, preview: NodePreview): void => {
    evict(key)
    cache.set(key, preview)
    cacheWeight += weightOf(preview)
    while ((cache.size > PREVIEW_CACHE_MAX || cacheWeight > PREVIEW_CACHE_WEIGHT_MAX) && cache.size > 1) {
      evict((cache.keys().next().value as string))
    }
  }

  const decodeUrl = (url: string): Promise<NodePreview> => {
    const img = new Image()
    img.src = url
    return img.decode().then(() => ({ image: img, width: img.naturalWidth, height: img.naturalHeight }))
  }

  const decodeFrame = (payload: Blob | ArrayBuffer): Promise<NodePreview> =>
    createImageBitmap(payload instanceof Blob ? payload : new Blob([payload])).then((bitmap) => ({
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
    }))

  // An animated image container (an encoded-animation live preview) decodes
  // every frame through WebCodecs so the canvas can cycle them; a missing
  // ImageDecoder, a single-frame container, or any decode failure degrades
  // to the ordinary first-frame still.
  const decodeAnimatedImage = async (payload: Blob | ArrayBuffer, mime: string): Promise<NodePreview> => {
    let decoder: ImageDecoder | undefined
    const frames: ImageBitmap[] = []
    try {
      if (typeof ImageDecoder === 'undefined' || !(await ImageDecoder.isTypeSupported(mime))) {
        return await decodeFrame(payload)
      }
      const data = payload instanceof Blob ? await payload.arrayBuffer() : payload
      decoder = new ImageDecoder({ data, type: mime })
      await decoder.tracks.ready
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1
      if (frameCount < 2 || frameCount > ANIMATION_RING_MAX) return await decodeFrame(payload)
      let totalUs = 0
      for (let index = 0; index < frameCount; index++) {
        const { image } = await decoder.decode({ frameIndex: index })
        totalUs += image.duration ?? 0
        try {
          frames.push(await createImageBitmap(image))
        }
        finally {
          image.close()
        }
      }
      const first = frames[0]!
      return {
        image: first,
        width: first.width,
        height: first.height,
        animation: {
          frames,
          // Uniform cycling over the container's total duration; a container
          // without timing falls back to a slow default rather than a blur.
          fps: totalUs > 0 ? frames.length / (totalUs / 1_000_000) : ANIMATED_IMAGE_FALLBACK_FPS,
        },
      }
    }
    catch {
      for (const frame of frames) frame.close()
      return decodeFrame(payload)
    }
    finally {
      decoder?.close()
    }
  }

  // Latest animated-frame key per execution+node. A stream of encoded
  // animations gets a unique key per frame; when a newer frame's decode has
  // started, an older frame's completion is released and dropped instead of
  // entering the cache.
  const animatedLatest = new Map<string, string>()

  const decodeLatestAnimatedImage = async (f: {
    key: string
    scope: string
    payload: Blob | ArrayBuffer
    channel: string
  }): Promise<NodePreview> => {
    animatedLatest.set(f.scope, f.key)
    try {
      const decoded = await decodeAnimatedImage(f.payload, f.channel)
      if (animatedLatest.get(f.scope) !== f.key) {
        release(decoded)
        throw Object.assign(new Error('superseded animated frame'), { transient: true })
      }
      return decoded
    }
    finally {
      // Drop the settled scope entry so a long-lived loader does not
      // accumulate one per animated execution/node pair.
      if (animatedLatest.get(f.scope) === f.key) animatedLatest.delete(f.scope)
    }
  }

  // An encoded live animation plays natively: a video/* frame through the
  // host's DOM media path (the cache revokes the object URL when the entry
  // ages out), an animatable image/* container through WebCodecs frame
  // cycling. Everything else decodes as a bitmap still.
  const liveFrameSource = (f: {
    key: string
    scope: string
    runtimeId: string
    payload: Blob | ArrayBuffer
    channel: string
  }): PreviewSource =>
    f.channel.startsWith('video/')
      ? {
          key: f.key,
          runtimeId: f.runtimeId,
          mediaKind: 'video',
          load: () =>
            Promise.resolve({
              kind: 'video' as const,
              mime: f.channel,
              src: URL.createObjectURL(
                f.payload instanceof Blob ? f.payload : new Blob([f.payload], { type: f.channel }),
              ),
            }),
        }
      : ANIMATED_IMAGE_MIMES.has(f.channel)
        ? { key: f.key, runtimeId: f.runtimeId, load: () => decodeLatestAnimatedImage(f) }
        : { key: f.key, runtimeId: f.runtimeId, load: () => decodeFrame(f.payload) }

  // A model3d preview carries BOTH a poster still (painted in-canvas) and
  // its GLB src (mounted as an orbit viewport on demand). A poster failure
  // (no WebGL, undecodable scene) degrades to a failed-status preview; the
  // src stays usable by the overlay.
  const model3dPreview = async (src: string, mime: string): Promise<NodePreview> => {
    try {
      const render = deps.renderModel3dPoster ?? (await import('./model3d-viewer.js')).renderModel3dPoster
      const poster = await render(src, mime)
      return { kind: 'model3d', mime, src, image: poster.image, width: poster.width, height: poster.height }
    } catch {
      return { kind: 'model3d', mime, src, status: 'failed' }
    }
  }

  const recordedOutputPreview = async (
    url: string,
    name: string,
    mime: string,
    kind: 'image' | 'video' | 'audio' | 'model3d',
  ): Promise<NodePreview> => {
    const response = await (deps.fetchRecordedOutput ?? fetch)(url)
    if (!response.ok) throw new Error(`recorded output request failed (${response.status})`)
    const src = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mime }))
    const download = { src, name }
    try {
      if (kind === 'image') return { ...await decodeUrl(src), src, download }
      if (kind === 'model3d') return { ...await model3dPreview(src, mime), download }
      return { kind, mime, src, download }
    } catch (error) {
      URL.revokeObjectURL(src)
      throw error
    }
  }

  const decodeRendition = async (result: Awaited<ReturnType<typeof fetchPeekRendition>>): Promise<NodePreview> => {
    const src = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }))
    const download = {
      src, name: downloadNameForRendition(result.output, result.mime),
      ...(result.previewOnly === true ? { previewOnly: true as const } : {}),
    }
    const metadata = {
      ...(result.video === undefined && result.count !== undefined ? { count: result.count } : {}),
      ...(result.colorTransform !== undefined ? { colorTransform: result.colorTransform } : {}),
    }
    if (result.mime.startsWith('image/')) {
      try {
        const decoded = await decodeFrame(result.bytes)
        return { ...decoded, src, download, ...metadata }
      } catch (error) {
        URL.revokeObjectURL(src)
        throw error
      }
    }
    if (isModel3dMime(result.mime)) {
      const preview = await model3dPreview(src, result.mime)
      return { ...preview, download, ...metadata }
    }
    const kind = result.mime.startsWith('video/') ? 'video' : result.mime === 'audio/wav' ? 'audio' : undefined
    if (kind === undefined) {
      URL.revokeObjectURL(src)
      throw Object.assign(new Error(`unsupported preview MIME ${result.mime}`), { transient: false })
    }
    return {
      kind,
      mime: result.mime,
      src,
      download,
      ...metadata,
    }
  }

  const inventoryFor = (exec: ExecutionState, runtimeIds: readonly string[]): readonly ExecutedImage[] =>
    executedImageInventory(exec, {
      runtimeIds,
      viewUrlForExecution: deps.viewUrlForExecution,
      assetUrlForExecution: deps.assetUrlForExecution,
    })

  return {
    inventoryFor,

    sourceFor(exec, runtimeIds, running, outputIndex = 0) {
      const idSet = new Set(runtimeIds)
      const matches = (runtimeId: string) => idSet.has(runtimeId)

      let frame: { key: string; scope: string; runtimeId: string; payload: Blob | ArrayBuffer; channel: string } | undefined
      let frameAt = -1
      for (const [runtimeId, streams] of Object.entries(exec.previews)) {
        if (!matches(runtimeId)) continue
        const p = selectedPreviewFrame(streams, exec.previewRings?.[runtimeId])
        if (p === undefined || p.timestamp <= frameAt) continue
        if (!(p.payload instanceof Blob) && !(p.payload instanceof ArrayBuffer)) continue
        frameAt = p.timestamp
        // Clock timestamps are not sequence ids. The store installs a new
        // Blob/ArrayBuffer object for each replacement frame.
        frame = {
          key: `frame:${exec.key}:${runtimeId}:${p.timestamp}:${framePayloadId(p.payload)}`,
          scope: `${exec.key}:${runtimeId}`,
          runtimeId,
          payload: p.payload,
          channel: p.channel,
        }
      }

      const inventory = inventoryFor(exec, runtimeIds)
      const selectedIndex = Math.max(0, Math.min(Math.trunc(outputIndex), Math.max(0, inventory.length - 1)))
      const selected = inventory[selectedIndex]
      const imageName = selected === undefined
        ? undefined
        : safeDownloadName(selected.name ?? '', `${selected.outputId}.png`)
      const image = selected === undefined || imageName === undefined
        ? undefined
        : {
            key: selected.kind === 'v1'
              ? `recorded:img:${selected.url}:name:${encodeURIComponent(imageName)}`
              : recordedMediaKey(selected.digest as string, selected.mediaType, selected.url, imageName),
            runtimeId: selected.runtimeId,
            url: selected.url,
            name: imageName,
            mediaType: selected.kind === 'v1' ? 'image/png' : selected.mediaType,
            output: { index: selectedIndex, count: inventory.length },
            outputId: selected.outputId,
          }
      const artifacts = exec.artifacts.filter((artifact) =>
        matches(artifact.nodeId) && (
          artifact.mediaType.startsWith('image/') ||
          artifact.mediaType.startsWith('audio/') ||
          isModel3dMime(artifact.mediaType)))
      const artifactIndex = Math.max(0, Math.min(Math.trunc(outputIndex), Math.max(0, artifacts.length - 1)))
      const artifact = artifacts[artifactIndex]
      const artifactKind = artifact?.mediaType.startsWith('image/') === true
        ? 'image'
        : artifact?.mediaType.startsWith('audio/') === true
          ? 'audio'
          : artifact !== undefined && isModel3dMime(artifact.mediaType)
            ? 'model3d'
            : undefined
      let artifactSource: PreviewSource | undefined
      const audioHasValue = artifactKind === 'audio' && artifact !== undefined &&
        Object.values({ ...exec.outputs[artifact.nodeId], ...exec.nodes?.[artifact.nodeId]?.outputs }).some((value) =>
          typeof value === 'object' && value !== null && 'typeId' in value &&
          typeof value.typeId === 'string' && /(?:^|\.)audio$/i.test(value.typeId))
      if (artifact !== undefined && artifactKind !== undefined && !audioHasValue) {
        const artifactUrl = deps.assetUrlForExecution(exec.ref, artifact.digest)
        const downloadName = safeDownloadName(
          artifact.name,
          downloadNameForRendition(artifact.nodeId, artifact.mediaType),
        )
        artifactSource = {
          key: recordedMediaKey(artifact.digest, artifact.mediaType, artifactUrl, downloadName),
          failureKey: `asset-url:${artifactUrl}`,
          runtimeId: artifact.nodeId,
          mediaKind: artifactKind,
          output: { index: artifactIndex, count: artifacts.length },
          load: () => artifactKind === 'audio' ? Promise.resolve({
            kind: 'audio', mime: artifact.mediaType, src: '',
            download: {
              src: artifactUrl, name: downloadName,
              load: async (signal: AbortSignal) => {
                const response = await (deps.fetchRecordedOutput ?? fetch)(artifactUrl, { signal })
                if (!response.ok) throw new Error(`Recorded output request failed (${response.status})`)
                return new Blob([await response.arrayBuffer()], { type: artifact.mediaType })
              },
            },
          }) : recordedOutputPreview(
            artifactUrl,
            downloadName,
            artifact.mediaType,
            artifactKind,
          ),
        }
      }

      if (running && frame) return liveFrameSource(frame)
      if (artifactSource && !imageMisses.has(artifactSource.failureKey ?? artifactSource.key)) return artifactSource
      if (image) {
        const i = image
        return {
          key: i.key,
          failureKey: `image-url:${i.url}`,
          runtimeId: i.runtimeId,
          output: i.output,
          outputId: i.outputId,
          load: () => recordedOutputPreview(i.url, i.name, i.mediaType, 'image'),
        }
      }
      if (artifactSource) return artifactSource
      if (frame) return liveFrameSource(frame)
      return undefined
    },

    inputAssetSource(digest, mediaType, mediaKind) {
      if (mediaKind === 'video') {
        return {
          key: `video-input:${digest}`,
          mediaKind,
          load: async () => ({ kind: 'video', status: 'unavailable', statusMessage: 'Video input preview pending server route' }),
        }
      }
      const url = deps.assetUrlForInput(digest)
      if (url === undefined) return undefined
      if (mediaKind === 'model3d') {
        return {
          key: directMediaKey(digest, mediaType, url),
          failureKey: `asset-url:${url}`,
          mediaKind,
          load: () => model3dPreview(url, mediaType),
        }
      }
      if (mediaKind !== 'image') {
        return {
          key: directMediaKey(digest, mediaType, url),
          failureKey: `asset-url:${url}`,
          mediaKind,
          load: async () => ({ kind: mediaKind, mime: mediaType, src: url }),
        }
      }
      return { key: `asset:${digest}`, failureKey: `asset-url:${url}`, load: () => decodeUrl(url) }
    },

    peekSource(values, exec, candidates, sceneNodeId, batchIndex = 0) {
      const baseKey = `peek:${JSON.stringify([exec.key, sceneNodeId, candidates.map((c) => [c.node, c.output])])}`
      const key = `${baseKey}:batch:${batchIndex}`
      const declaredIntent = candidates.some((candidate) => candidate.declaredIntent === true)
      if (peekMisses.has(key) && !declaredIntent && !imageBatches.has(baseKey) && !imageRefusals.has(baseKey)) return undefined
      return {
        key,
        cancellationKey: baseKey,
        get imageBatch() { return imageBatches.get(baseKey) },
        get refusal() { return imageRefusals.get(baseKey) },
        ...(declaredIntent ? { declaredIntent: true as const } : {}),
        ...(candidates.find((candidate) => candidate.mediaKind !== undefined)?.mediaKind !== undefined
          ? { mediaKind: candidates.find((candidate) => candidate.mediaKind !== undefined)!.mediaKind }
          : {}),
        // fetchPeekRendition throws with `transient` set: definitive misses
        // get negative-cached by resolve(); a transport hiccup stays
        // retryable.
        load: async (signal) => {
          const known = imageBatches.get(baseKey)
          if (known !== undefined) {
            const image = known.imageAt(Math.max(0, Math.min(batchIndex, known.count - 1)))
            const result = await image.load!(signal ?? new AbortController().signal)
            signal?.throwIfAborted()
            if (!result.available) throw Object.assign(new Error(`${result.reason}: ${result.error}`), { negativeCache: [400, 404, 406, 410].includes(result.status) })
            return decodeRendition({ ...result, node: image.runtimeId, output: image.outputId, count: known.count })
          }
          const result = await fetchPeekRendition(values, exec.ref.prompt, candidates, deps.validateMediaRendition, { batchIndex, ...(signal === undefined ? {} : { signal }) }).catch((error: unknown) => {
            if (error instanceof ImageBatchUnsupportedError && !disposed && !signal?.aborted) {
              if (imageRefusals.size >= PREVIEW_CACHE_MAX) imageRefusals.delete(imageRefusals.keys().next().value!)
              imageRefusals.set(baseKey, error.message)
            }
            if (error instanceof Error && 'videoNotice' in error && typeof error.videoNotice === 'string' &&
                'negativeCache' in error && error.negativeCache === true) return error.videoNotice
            throw error
          })
          if (typeof result === 'string') {
            return { kind: 'video', status: 'unavailable', statusMessage: `Video unavailable: ${result}` }
          }
          if (result.audio !== undefined) return {
            kind: 'audio', src: '',
            audio: audioPreview(values, result.audio.query, result.audio.descriptor, result.audio.renditions),
          }
          const batch = result.imageBatch
          const mediaType = result.mime
          if (batch !== undefined && !disposed && !signal?.aborted) {
            if (imageBatches.size >= PREVIEW_CACHE_MAX) imageBatches.delete(imageBatches.keys().next().value!)
            imageBatches.set(baseKey, {
              count: batch.count,
              imageAt: (index) => ({
                key: `${baseKey}:${batch.descriptor.fingerprint}:${JSON.stringify(batch.rendition.version)}:batch:${index}`,
                runtimeId: batch.query.nodeId, outputId: batch.query.outputId, descriptorIndex: 0,
                url: '', kind: 'rendition', mediaType,
                descriptor: batch.descriptor, listPath: batch.query.element ?? [], batchIndex: index,
                load: async (signal) => {
                  const result = await values.rendition(batch.query, batch.rendition.kind, {
                    batch: index, signal,
                    ...(batch.rendition.version !== undefined ? { rendererVersion: batch.rendition.version } : {}),
                  })
                  if (result.available && (result.mime !== 'image/png' || result.bytes.byteLength > 64 * 1024 * 1024)) {
                    return { available: false, status: 406, reason: 'preview-budget', error: 'Expected a PNG preview no larger than 64 MiB' }
                  }
                  return result
                },
              }),
            })
          }
          const videoInspection = await videoInspectionFor(result, values, candidates, deps.validateMediaRendition, signal)
          signal?.throwIfAborted()
          const preview = await decodeRendition(result)
          return videoInspection === undefined ? preview : { ...preview, kind: 'video', videoInspection }
        },
      }
    },

    resolveFrame(key, payload) {
      const decoded = cache.get(key)
      if (decoded !== undefined) return decoded.image
      if (pending.has(key)) return undefined
      const claim = Symbol(key)
      pending.set(key, claim)
      decodeFrame(payload)
        .then((p) => {
          if (disposed) {
            if (p.image instanceof ImageBitmap) p.image.close()
            return
          }
          put(key, p)
          deps.onDecoded()
        })
        .catch(() => {
          // Undecodable ring frame: drop; a replacement slot retries.
        })
        .finally(() => {
          if (pending.get(key) === claim) pending.delete(key)
        })
      return undefined
    },

    resolve(source) {
      const cancellationKey = source.cancellationKey ?? source.key
      const prior = requests.get(cancellationKey)
      if (prior !== undefined && prior.key !== source.key) {
        prior.controller.abort()
        pending.delete(prior.key)
        requests.delete(cancellationKey)
      }
      const decoded = cache.get(source.key)
      if (decoded) return decoded
      if (peekMisses.has(source.key)) return undefined
      if (imageMisses.has(source.failureKey ?? source.key)) return undefined
      if (pending.has(source.key)) return undefined
      const claim = Symbol(source.key)
      pending.set(source.key, claim)
      const controller = new AbortController()
      requests.set(cancellationKey, { key: source.key, controller })
      source.load(controller.signal)
        .then((p) => {
          if (disposed || controller.signal.aborted) {
            release(p)
            return
          }
          put(source.key, p)
          deps.onDecoded()
        })
        .catch((e: unknown) => {
          if (disposed || controller.signal.aborted) return
          // Undecodable frame: drop, never break the loop.
          const negativeCache = (e as { negativeCache?: boolean } | null)?.negativeCache === true
          // A miss notification can synchronously re-derive the same digest
          // through another backend. Release the shared positive-cache key
          // before notifying so that backend can start its own request.
          if (pending.get(source.key) === claim) pending.delete(source.key)
          if (source.key.startsWith('peek:') && negativeCache) {
            if (peekMisses.size >= PEEK_MISS_MAX) peekMisses.clear()
            peekMisses.add(source.key)
            deps.onDecoded()
          }
          if (isUrlBackedSourceKey(source.key) && (e as { transient?: boolean } | null)?.transient !== true) {
            if (imageMisses.size >= IMAGE_MISS_MAX) imageMisses.clear()
            imageMisses.add(source.failureKey ?? source.key)
            deps.onDecoded()
          }
        })
        .finally(() => {
          if (pending.get(source.key) === claim) pending.delete(source.key)
          if (requests.get(cancellationKey)?.controller === controller) requests.delete(cancellationKey)
        })
      return undefined
    },
    unavailable(source) {
      return source.refusal !== undefined || ((source.declaredIntent === true || source.imageBatch !== undefined) && peekMisses.has(source.key)) || imageMisses.has(source.failureKey ?? source.key)
    },
    markUnavailable(source) {
      if (!isUrlBackedSourceKey(source.key)) return
      evict(source.key)
      if (imageMisses.size >= IMAGE_MISS_MAX) imageMisses.clear()
      imageMisses.add(source.failureKey ?? source.key)
      deps.onDecoded()
    },
    dispose() {
      disposed = true
      for (const request of requests.values()) request.controller.abort()
      requests.clear()
      imageBatches.clear()
      imageRefusals.clear()
      for (const old of cache.values()) release(old)
      cache.clear()
      cacheWeight = 0
      animatedLatest.clear()
      pending.clear()
      peekMisses.clear()
      imageMisses.clear()
    },
  }
}
