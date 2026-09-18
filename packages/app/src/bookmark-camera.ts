import { subgraphDefIdOf, type ViewBookmark, type WorkflowDocument } from '@dinkster/core'
import type { Viewport } from '@dinkster/canvas'

/** Duration choices for a numbered bookmark press. Kept pure so keyboard timing is testable without a DOM. */
export function bookmarkJumpMode(
  previous: { readonly slot: number; readonly at: number } | undefined,
  slot: number,
  now: number,
  sameCanvas: boolean,
): 'animate' | 'instant' {
  if (!sameCanvas) return 'instant'
  return previous?.slot === slot && now - previous.at <= 350 ? 'instant' : 'animate'
}

/** A second Shift+digit inside the gesture window removes the slot saved by the first press. */
export function bookmarkSaveMode(
  previous: { readonly slot: number; readonly at: number } | undefined,
  slot: number,
  now: number,
): 'save' | 'delete' {
  return previous?.slot === slot && now - previous.at <= 500 ? 'delete' : 'save'
}

/**
 * Interpolate zoom logarithmically, while interpolating the world point under
 * the screen center. Linear x/y interpolation makes a simultaneous deep zoom
 * feel as if the target slides away; center-space interpolation keeps the
 * subject stable and gives pan plus zoom one coherent motion.
 */
export function interpolateBookmarkViewport(
  from: Viewport,
  to: Viewport,
  progress: number,
  width: number,
  height: number,
): Viewport {
  const t = Math.min(1, Math.max(0, progress))
  const scale = Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * t)
  const fromCenter = { x: (width / 2 - from.x) / from.scale, y: (height / 2 - from.y) / from.scale }
  const toCenter = { x: (width / 2 - to.x) / to.scale, y: (height / 2 - to.y) / to.scale }
  const center = {
    x: fromCenter.x + (toCenter.x - fromCenter.x) * t,
    y: fromCenter.y + (toCenter.y - fromCenter.y) * t,
  }
  return { x: width / 2 - center.x * scale, y: height / 2 - center.y * scale, scale }
}

/** Preserve zoom while placing a node's visual center at the canvas center. */
export function viewportCenteredOnNode(
  viewport: Viewport,
  node: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
): Viewport {
  const centerX = node.x + node.width / 2
  const centerY = node.y + node.height / 2
  return {
    x: view.width / 2 - centerX * viewport.scale,
    y: view.height / 2 - centerY * viewport.scale,
    scale: viewport.scale,
  }
}

type BookmarkView = Extract<ViewBookmark, { readonly view: unknown }>['view']

/** Convert a saved world rect to a centered, fully containing viewport. */
export function bookmarkViewportForView(
  view: BookmarkView,
  canvas: { readonly width: number; readonly height: number },
): Viewport | undefined {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0)
    return undefined
  const scale = Math.min(canvas.width / view.width, canvas.height / view.height)
  const centerX = view.x + view.width / 2
  const centerY = view.y + view.height / 2
  const viewport = {
    x: canvas.width / 2 - centerX * scale,
    y: canvas.height / 2 - centerY * scale,
    scale,
  }
  return Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.scale) && viewport.scale > 0
    ? viewport
    : undefined
}

/** Capture the current canvas transform as a finite positive world rect. */
export function bookmarkViewFromViewport(
  viewport: Viewport,
  canvas: { readonly width: number; readonly height: number },
): BookmarkView | undefined {
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.scale) || viewport.scale <= 0)
    return undefined
  const view = {
    x: -viewport.x / viewport.scale,
    y: -viewport.y / viewport.scale,
    width: canvas.width / viewport.scale,
    height: canvas.height / viewport.scale,
  }
  return Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.width) &&
    Number.isFinite(view.height) && view.width > 0 && view.height > 0
    ? view
    : undefined
}

/** Where a validated bookmark jump lands. */
export interface BookmarkJumpPlan {
  /** Graph definition the jump drills into (last stack entry). */
  readonly target: string
  /** Fresh viewport copy, safe to store in per-graph viewport memory. */
  readonly viewport: { readonly x: number; readonly y: number; readonly scale: number }
  /** The bookmark names the view already on screen (may animate). */
  readonly sameCanvas: boolean
}

/**
 * Revalidate a bookmark's navigation context against the CURRENT document
 * (nodes/defs may have been edited away since the save) and decide whether
 * it targets the canvas already on screen. An orphaned bookmark yields
 * undefined - it is ignored, never guessed at. The host applies the plan:
 * seed viewport memory, restore navigation, then animate (same-canvas) or
 * set the viewport immediately (cross-canvas).
 */
export function bookmarkJumpPlan(
  doc: WorkflowDocument,
  current: { readonly graphStack: readonly string[]; readonly instancePath: readonly string[] | undefined },
  bm: ViewBookmark,
  canvas: { readonly width: number; readonly height: number },
): BookmarkJumpPlan | undefined {
  const stack = bm.graphStack
  if (stack.length < 1 || stack[0] !== doc.root) return undefined
  if (bm.instancePath.length !== stack.length - 1) return undefined
  for (let i = 0; i < stack.length; i++) {
    const def = doc.graphs[stack[i]!]
    if (!def) return undefined
    if (i < bm.instancePath.length) {
      const node = def.nodes[bm.instancePath[i]!]
      if (!node || subgraphDefIdOf(node.type) !== stack[i + 1]) return undefined
    }
  }
  const sameCanvas =
    current.instancePath !== undefined &&
    current.graphStack.length === stack.length &&
    current.graphStack.every((id, i) => id === stack[i]) &&
    current.instancePath.length === bm.instancePath.length &&
    current.instancePath.every((id, i) => id === bm.instancePath[i])
  const viewport = 'view' in bm && bm.view !== undefined
    ? bookmarkViewportForView(bm.view, canvas)
    : { ...bm.viewport }
  if (!viewport) return undefined
  return { target: stack[stack.length - 1]!, viewport, sameCanvas }
}

/** World point painted for a bookmark marker. Legacy transforms need the current canvas size. */
export function bookmarkMarkerWorldPoint(
  bm: ViewBookmark,
  canvas: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  if ('view' in bm && bm.view !== undefined) {
    return { x: bm.view.x + bm.view.width / 2, y: bm.view.y + bm.view.height / 2 }
  }
  return {
    x: (canvas.width / 2 - bm.viewport.x) / bm.viewport.scale,
    y: (canvas.height / 2 - bm.viewport.y) / bm.viewport.scale,
  }
}

export interface CameraAnimator {
  /** Ease the camera to the target over 300ms (smoothstep, log-scale zoom). */
  animateTo(to: Viewport | (() => Viewport | undefined)): void
  cancel(): void
  /** Cancel and detach the viewport-change subscription. */
  dispose(): void
}

/**
 * Camera animation state machine. Owns the rAF loop and the "manual input
 * wins" rule: viewport notifications include controller pan and wheel
 * navigation, so any change NOT produced by our own frame cancels the
 * animation and leaves the user's camera authoritative.
 */
export function createCameraAnimator(deps: {
  getViewport(): Viewport
  setViewport(vp: Viewport): void
  /** Subscribe to viewport changes; returns the unsubscribe. */
  onViewportChange(cb: () => void): () => void
  /** Current canvas CSS size, sampled per frame. */
  viewSize(): { readonly width: number; readonly height: number }
  /** Clock/scheduler seams; default to performance/window (tests inject fakes). */
  now?: () => number
  raf?: (cb: (now: number) => void) => number
  caf?: (handle: number) => void
}): CameraAnimator {
  const now = deps.now ?? (() => performance.now())
  const raf = deps.raf ?? ((cb) => requestAnimationFrame(cb))
  const caf = deps.caf ?? ((h) => cancelAnimationFrame(h))
  let animation: number | undefined
  let settingAnimatedViewport = false

  const cancel = (): void => {
    if (animation !== undefined) caf(animation)
    animation = undefined
  }

  const unsubscribe = deps.onViewportChange(() => {
    if (!settingAnimatedViewport) cancel()
  })

  return {
    animateTo(to: Viewport | (() => Viewport | undefined)): void {
      cancel()
      const from = { ...deps.getViewport() }
      const started = now()
      const frame = (frameNow: number): void => {
        const linear = Math.min(1, (frameNow - started) / 300)
        const eased = linear * linear * (3 - 2 * linear)
        const { width, height } = deps.viewSize()
        const target = typeof to === 'function' ? to() : to
        if (!target) {
          animation = undefined
          return
        }
        settingAnimatedViewport = true
        deps.setViewport(interpolateBookmarkViewport(from, target, eased, width, height))
        settingAnimatedViewport = false
        if (linear < 1) animation = raf(frame)
        else animation = undefined
      }
      animation = raf(frame)
    },
    cancel,
    dispose(): void {
      cancel()
      unsubscribe()
    },
  }
}
