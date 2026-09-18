import { describe, expect, it } from 'vitest'
import type { ViewBookmark, WorkflowDocument } from '@dinkster/core'
import {
  bookmarkJumpMode,
  bookmarkJumpPlan,
  bookmarkMarkerWorldPoint,
  bookmarkSaveMode,
  bookmarkViewFromViewport,
  bookmarkViewportForView,
  createCameraAnimator,
  interpolateBookmarkViewport,
  viewportCenteredOnNode,
} from '../src/bookmark-camera.js'

describe('bookmark camera gestures', () => {
  it('saves first and deletes only a quick second Shift press of the same slot', () => {
    expect(bookmarkSaveMode(undefined, 2, 100)).toBe('save')
    expect(bookmarkSaveMode({ slot: 2, at: 100 }, 2, 599)).toBe('delete')
    expect(bookmarkSaveMode({ slot: 2, at: 100 }, 3, 200)).toBe('save')
    expect(bookmarkSaveMode({ slot: 2, at: 100 }, 2, 601)).toBe('save')
  })

  it('animates normal same-canvas jumps and snaps repeated or cross-canvas jumps', () => {
    expect(bookmarkJumpMode(undefined, 1, 100, true)).toBe('animate')
    expect(bookmarkJumpMode({ slot: 1, at: 100 }, 1, 450, true)).toBe('instant')
    expect(bookmarkJumpMode({ slot: 1, at: 100 }, 2, 200, true)).toBe('animate')
    expect(bookmarkJumpMode(undefined, 1, 100, false)).toBe('instant')
  })

  it('interpolates scale logarithmically and preserves exact endpoints', () => {
    const from = { x: 0, y: 0, scale: 1 }
    const to = { x: -600, y: -300, scale: 4 }
    expect(interpolateBookmarkViewport(from, to, 0, 800, 600)).toEqual(from)
    expect(interpolateBookmarkViewport(from, to, 1, 800, 600)).toEqual(to)
    expect(interpolateBookmarkViewport(from, to, 0.5, 800, 600).scale).toBeCloseTo(2)
  })

  it('centers a node without changing the current zoom', () => {
    expect(viewportCenteredOnNode(
      { x: 10, y: 20, scale: 2 },
      { x: 100, y: 50, width: 80, height: 40 },
      { width: 800, height: 600 },
    )).toEqual({ x: 120, y: 160, scale: 2 })
  })

  it('refuses bookmark capture and restore with unusable canvas geometry', () => {
    const view = { x: 0, y: 0, width: 100, height: 100 }
    expect(bookmarkViewportForView(view, { width: 0, height: 600 })).toBeUndefined()
    expect(bookmarkViewportForView(view, { width: 800, height: 0 })).toBeUndefined()
    expect(bookmarkViewportForView(view, { width: Number.NaN, height: 600 })).toBeUndefined()
    expect(bookmarkViewFromViewport({ x: 0, y: 0, scale: 1 }, { width: 0, height: 600 })).toBeUndefined()
    expect(bookmarkViewFromViewport({ x: 0, y: 0, scale: 1 }, { width: 800, height: Number.POSITIVE_INFINITY })).toBeUndefined()
  })
})

// The planner only reads root/graphs/nodes/type; fixtures carry exactly those
// (cast through unknown - full documents would drag in link/net state
// irrelevant to navigation validation).
const doc = (graphs: Record<string, { nodes: Record<string, { type: string }> }>): WorkflowDocument =>
  ({ root: 'g0', graphs }) as unknown as WorkflowDocument

const legacyBm = (graphStack: string[], instancePath: string[], viewport = { x: 10, y: 20, scale: 2 }): ViewBookmark => ({
  graphStack,
  instancePath,
  viewport,
})
const rectBm = (
  graphStack: string[],
  instancePath: string[],
  view = { x: 100, y: -50, width: 400, height: 200 },
): ViewBookmark => ({ graphStack, instancePath, view })
const canvas = { width: 800, height: 600 }

describe('bookmarkJumpPlan', () => {
  const d = doc({
    g0: { nodes: { s1: { type: '#sub' }, plain: { type: 'core.plain' } } },
    sub: { nodes: { inner: { type: 'core.plain' } } },
  })
  const atRoot = { graphStack: ['g0'], instancePath: [] as string[] }

  it('keeps a legacy root-level viewport verbatim', () => {
    const saved = legacyBm(['g0'], [])
    const plan = bookmarkJumpPlan(d, atRoot, saved, canvas)
    expect(plan).toEqual({ target: 'g0', viewport: { x: 10, y: 20, scale: 2 }, sameCanvas: true })
    expect(plan!.viewport).not.toBe(saved.viewport)
  })

  it('refuses a rect jump on a zero-sized canvas without changing legacy behavior', () => {
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['g0'], []), { width: 0, height: 600 })).toBeUndefined()
    expect(bookmarkJumpPlan(d, atRoot, legacyBm(['g0'], []), { width: 0, height: 0 })!.viewport).toEqual({
      x: 10, y: 20, scale: 2,
    })
  })

  it.each([
    { width: 1600, height: 900 },
    { width: 900, height: 1600 },
    { width: 800, height: 800 },
  ])('contains and centers a saved world rect on a $width x $height canvas', (size) => {
    const saved = rectBm(['g0'], [])
    const plan = bookmarkJumpPlan(d, atRoot, saved, size)!
    const view = saved.view!
    for (const x of [view.x, view.x + view.width]) {
      for (const y of [view.y, view.y + view.height]) {
        const cx = x * plan.viewport.scale + plan.viewport.x
        const cy = y * plan.viewport.scale + plan.viewport.y
        expect(cx).toBeGreaterThanOrEqual(-1e-9)
        expect(cx).toBeLessThanOrEqual(size.width + 1e-9)
        expect(cy).toBeGreaterThanOrEqual(-1e-9)
        expect(cy).toBeLessThanOrEqual(size.height + 1e-9)
      }
    }
    expect((view.x + view.width / 2) * plan.viewport.scale + plan.viewport.x).toBeCloseTo(size.width / 2)
    expect((view.y + view.height / 2) * plan.viewport.scale + plan.viewport.y).toBeCloseTo(size.height / 2)
  })

  it('validates a subgraph drill-in path against the current document', () => {
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['g0', 'sub'], ['s1']), canvas)).toEqual({
      target: 'sub',
      viewport: { x: -200, y: 200, scale: 2 },
      sameCanvas: false,
    })
  })

  it('marks sameCanvas only when the full stack AND instance path match the view', () => {
    const inSub = { graphStack: ['g0', 'sub'], instancePath: ['s1'] }
    expect(bookmarkJumpPlan(d, inSub, rectBm(['g0', 'sub'], ['s1']), canvas)!.sameCanvas).toBe(true)
    expect(bookmarkJumpPlan(d, inSub, rectBm(['g0'], []), canvas)!.sameCanvas).toBe(false)
    // Desynced navigation (undefined instance path) is never same-canvas.
    expect(bookmarkJumpPlan(d, { graphStack: ['g0'], instancePath: undefined }, rectBm(['g0'], []), canvas)!.sameCanvas).toBe(false)
  })

  it('rejects orphaned bookmarks instead of guessing', () => {
    // Root mismatch, missing def, missing instance node, non-subgraph hop,
    // wrong def behind the hop, and malformed stack/path lengths.
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['other'], []), canvas)).toBeUndefined()
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['g0', 'gone'], ['s1']), canvas)).toBeUndefined()
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['g0', 'sub'], ['ghost']), canvas)).toBeUndefined()
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['g0', 'sub'], ['plain']), canvas)).toBeUndefined()
    expect(bookmarkJumpPlan(d, atRoot, rectBm([], []), canvas)).toBeUndefined()
    expect(bookmarkJumpPlan(d, atRoot, rectBm(['g0', 'sub'], []), canvas)).toBeUndefined()
  })
})

describe('bookmarkMarkerWorldPoint', () => {
  it('uses the saved rect center independently of current canvas size', () => {
    const saved = rectBm(['g0'], [], { x: -100, y: 50, width: 500, height: 300 })
    expect(bookmarkMarkerWorldPoint(saved, { width: 1600, height: 900 })).toEqual({ x: 150, y: 200 })
    expect(bookmarkMarkerWorldPoint(saved, { width: 900, height: 1600 })).toEqual({ x: 150, y: 200 })
  })

  it('preserves legacy current-canvas marker behavior', () => {
    const saved = legacyBm(['g0'], [], { x: 100, y: -50, scale: 2 })
    expect(bookmarkMarkerWorldPoint(saved, { width: 800, height: 600 })).toEqual({ x: 150, y: 175 })
  })
})

describe('createCameraAnimator', () => {
  /** Deterministic harness: manual clock, rAF queue, subscribable viewport. */
  function harness() {
    let clock = 0
    let nextHandle = 1
    const frames = new Map<number, (now: number) => void>()
    const listeners = new Set<() => void>()
    let viewport = { x: 0, y: 0, scale: 1 }
    let viewSize = { width: 800, height: 600 }
    const setCalls: { x: number; y: number; scale: number }[] = []
    const animator = createCameraAnimator({
      getViewport: () => viewport,
      setViewport: (vp) => {
        viewport = vp
        setCalls.push(vp)
        for (const cb of listeners) cb()
      },
      onViewportChange: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      viewSize: () => viewSize,
      now: () => clock,
      raf: (cb) => {
        const h = nextHandle++
        frames.set(h, cb)
        return h
      },
      caf: (h) => frames.delete(h),
    })
    const step = (ms: number): void => {
      clock += ms
      const pending = [...frames.values()]
      frames.clear()
      for (const cb of pending) cb(clock)
    }
    return {
      animator,
      step,
      setCalls,
      get viewport() {
        return viewport
      },
      get pendingFrames() {
        return frames.size
      },
      externalChange: (): void => {
        for (const cb of listeners) cb()
      },
      resize: (width: number, height: number): void => {
        viewSize = { width, height }
      },
      get size() {
        return viewSize
      },
      get listenerCount() {
        return listeners.size
      },
    }
  }

  it('eases to the target over 300ms and stops scheduling frames at the end', () => {
    const h = harness()
    h.animator.animateTo({ x: -600, y: -300, scale: 4 })
    h.step(150)
    expect(h.viewport.scale).toBeGreaterThan(1)
    expect(h.viewport.scale).toBeLessThan(4)
    h.step(300)
    expect(h.viewport).toEqual({ x: -600, y: -300, scale: 4 })
    expect(h.pendingFrames).toBe(0)
  })

  it('does not cancel itself: its own setViewport notifications keep the animation alive', () => {
    const h = harness()
    h.animator.animateTo({ x: -600, y: -300, scale: 4 })
    h.step(100)
    h.step(100)
    expect(h.setCalls.length).toBe(2)
    expect(h.pendingFrames).toBe(1)
  })

  it('cancels when a manual viewport change wins', () => {
    const h = harness()
    h.animator.animateTo({ x: -600, y: -300, scale: 4 })
    h.step(100)
    h.externalChange() // user pan/wheel arrives between frames
    h.step(100)
    expect(h.setCalls.length).toBe(1) // no further animated frames applied
    expect(h.pendingFrames).toBe(0)
  })

  it('restarting an animation cancels the previous run', () => {
    const h = harness()
    h.animator.animateTo({ x: -600, y: -300, scale: 4 })
    h.step(100)
    h.animator.animateTo({ x: 50, y: 50, scale: 1 })
    h.step(300)
    expect(h.viewport).toEqual({ x: 50, y: 50, scale: 1 })
    expect(h.pendingFrames).toBe(0)
  })

  it('recomputes a rect target when the canvas resizes during animation', () => {
    const h = harness()
    const view = { x: 100, y: -50, width: 400, height: 200 }
    h.animator.animateTo(() => bookmarkViewportForView(view, h.size))
    h.step(100)
    h.resize(900, 1600)
    h.step(300)
    const expected = bookmarkViewportForView(view, { width: 900, height: 1600 })!
    expect(h.viewport).toEqual(expected)
  })

  it('dispose cancels the animation and detaches the viewport subscription', () => {
    const h = harness()
    h.animator.animateTo({ x: -600, y: -300, scale: 4 })
    h.animator.dispose()
    expect(h.pendingFrames).toBe(0)
    expect(h.listenerCount).toBe(0)
  })
})
