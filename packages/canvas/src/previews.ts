/**
 * Node preview content and contain-fit geometry. The host decides what to
 * show; layout owns the in-body region that drawing and hit-testing share.
 */

/** Ring-addressed live animation cycled by the render loop. */
export interface NodePreviewAnimation {
  /** Ring slot -> decoded frame; undefined slots have not arrived yet. */
  readonly frames: ReadonlyArray<CanvasImageSource | undefined>
  /** Display rate in frames per second; always positive. */
  readonly fps: number
}

/** Decoded content or an explicit pending/unavailable placeholder. */
export interface NodePreview {
  readonly kind?: 'image' | 'video' | 'audio' | 'model3d'
  readonly image?: CanvasImageSource
  /** Live sampling animation; `image` stays the newest frame fallback. */
  readonly animation?: NodePreviewAnimation
  /** Host-owned DOM media source. Canvas only paints its region/status. */
  readonly src?: string
  readonly mime?: string
  /** Bounded audio transport supplied by the host's preview loader. */
  readonly audio?: {
    readonly identity: string
    readonly meta: Readonly<Record<string, unknown>>
    readonly canScrub?: boolean
    readonly canSelectBatch?: boolean
    readonly initialBatch?: number
    readonly load: (start: number, batch: number, signal: AbortSignal) => Promise<{
      readonly start: number
      readonly duration: number
      readonly window?: ArrayBuffer
      readonly waveform?: ArrayBuffer
      readonly diagnostics: readonly string[]
    }>
  }
  /** Server-declared display conversion, never applied to the source value. */
  readonly colorTransform?: string
  /** Downloadable recorded output. Live frames and selected inputs omit it. */
  readonly download?: {
    readonly src: string
    readonly name: string
    readonly previewOnly?: true
    readonly load?: (signal: AbortSignal) => Promise<Blob>
  }
  readonly width?: number
  readonly height?: number
  readonly status?: 'loading' | 'unavailable' | 'failed'
  readonly statusMessage?: string
  /** Total image count for a list or pageable execution output. */
  readonly count?: number
  /** Zero-based page for a pageable execution output. */
  readonly index?: number
  /** Recipe-proven imagery retained from an older run, or a locally
   * computed mirror estimate standing in until real output arrives. */
  readonly state?: 'cached' | 'estimate'
}

/** node id -> preview panel content. */
export type PreviewMap = Readonly<Record<string, NodePreview>>

/** One unambiguous text or scalar result projected into a node body. */
export interface NodeOutputText {
  readonly text: string
  /** Existing execution value is no longer proven current for this document. */
  readonly stale?: true
  /** Value computed locally from a schema-declared mirror, not executed. */
  readonly estimate?: true
  /** A schema-declared mirror could not render the current value. */
  readonly error?: true
}

/** node id -> automatic Standard-view text or scalar result surface. */
export type OutputTextMap = Readonly<Record<string, NodeOutputText>>

export interface PreviewRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Reserve a bottom caption while retaining a distinct media region. */
export function splitPreviewRect(
  rect: PreviewRect,
  captionHeight: number,
): { readonly media: PreviewRect; readonly caption: PreviewRect } {
  const height = Math.max(0, Math.min(rect.height, captionHeight))
  const mediaHeight = rect.height - height
  return {
    media: { ...rect, height: mediaHeight },
    caption: { x: rect.x, y: rect.y + mediaHeight, width: rect.width, height },
  }
}

/** True when both preview dimensions are finite and positive. Decoded image
 * metadata is external data: NaN passes every `<= 0` guard and would poison
 * rect geometry (and through it scene visual bounds). */
const usableDims = (p: NodePreview): boolean =>
  Number.isFinite(p.width) && (p.width ?? 0) > 0 && Number.isFinite(p.height) && (p.height ?? 0) > 0

/**
 * The animation frame on display at `timeMs`, cycling the ring at its fps.
 * Empty ring slots fall back to the nearest earlier filled slot (frames
 * arrive a few at a time), and a fully empty ring yields undefined.
 */
export function animationFrameAt(
  animation: NodePreviewAnimation,
  timeMs: number,
): CanvasImageSource | undefined {
  const count = animation.frames.length
  if (count < 1 || !Number.isFinite(timeMs)) return undefined
  const slot = Math.floor((Math.max(0, timeMs) / 1000) * animation.fps) % count
  for (let back = 0; back < count; back++) {
    const frame = animation.frames[(slot - back + count) % count]
    if (frame !== undefined) return frame
  }
  return undefined
}

/** Contain-fit placement of the source image inside the panel rect. The
 * source scales up as well as down so a low-resolution preview fills the
 * panel instead of floating at its native size. */
export function containRect(rect: PreviewRect, preview: NodePreview): PreviewRect {
  if (!usableDims(preview)) return rect
  const width = preview.width!
  const height = preview.height!
  const scale = Math.min(rect.width / width, rect.height / height)
  const w = width * scale
  const h = height * scale
  return { x: rect.x + (rect.width - w) / 2, y: rect.y + (rect.height - h) / 2, width: w, height: h }
}
