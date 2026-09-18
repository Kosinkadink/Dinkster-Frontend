/**
 * setupMinimap pointer-gesture tests (FR13): browser-cancelled gestures
 * (pointercancel, capture loss) must end a drag, capture release is guarded
 * behind actually holding it, and the cancellation listeners are removed on
 * dispose. Canvas, renderer, and settings are all injected fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { minimapToWorld, minimapTransform, type CanvasRenderer, type MinimapInput } from '@dinkster/canvas'
import type { NodeProgress } from '@dinkster/core'
import { setupMinimap } from '../src/minimap.js'
import type { SettingsRegistry } from '../src/settings.js'

const drawInputs = vi.hoisted(() => [] as MinimapInput[])
vi.mock('@dinkster/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dinkster/canvas')>()
  return {
    ...actual,
    drawMinimap: (ctx: CanvasRenderingContext2D, input: MinimapInput) => {
      drawInputs.push(input)
      return actual.drawMinimap(ctx, input)
    },
  }
})

interface Harness {
  readonly listeners: Map<string, (event: unknown) => void>
  readonly canvas: {
    width: number
    height: number
    removeEventListener: ReturnType<typeof vi.fn>
    setPointerCapture: ReturnType<typeof vi.fn>
    releasePointerCapture: ReturnType<typeof vi.fn>
  }
  readonly setViewport: ReturnType<typeof vi.fn>
  readonly handle: { paint(): void; setStates(states: Readonly<Record<string, NodeProgress>>): void; dispose(): void }
}

function harness(opts?: {
  hasCapture?: boolean
  dpr?: number
  width?: number
  height?: number
  origin?: { x: number; y: number }
  border?: number
  scene?: ReturnType<CanvasRenderer['getScene']>
  settings?: Record<string, boolean>
}): Harness {
  const listeners = new Map<string, (event: unknown) => void>()
  const context = new Proxy({}, { get: () => vi.fn() })
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: opts?.width ?? 250,
    clientHeight: opts?.height ?? 200,
    clientLeft: opts?.border ?? 0,
    clientTop: opts?.border ?? 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ left: opts?.origin?.x ?? 0, top: opts?.origin?.y ?? 0 }),
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    // Model DOM semantics: removal only unregisters when the CALLBACK
    // identity matches what was added - removing a different function is a
    // silent no-op, exactly like the real EventTarget.
    removeEventListener: vi.fn((name: string, listener: (event: unknown) => void) => {
      if (listeners.get(name) === listener) listeners.delete(name)
    }),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => opts?.hasCapture ?? true,
    releasePointerCapture: vi.fn(),
  }
  const setViewport = vi.fn()
  const renderer = {
    getScene: () => opts?.scene ?? ({ nodes: [], groups: [], links: [], reroutes: [] }),
    getViewport: () => ({ x: 0, y: 0, scale: 1 }),
    getPresence: () => [],
    setViewport,
    onViewportChange: () => vi.fn(),
  } as unknown as CanvasRenderer
  vi.stubGlobal('window', { devicePixelRatio: opts?.dpr ?? 1 })
  const handle = setupMinimap({
    canvas: canvas as unknown as HTMLCanvasElement,
    mainCanvas: { clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement,
    renderer,
    settings: { get: (key: string) => opts?.settings?.[key] ?? false } as unknown as SettingsRegistry,
    markers: () => [],
  })
  return { listeners, canvas, setViewport, handle }
}

const pointer = { clientX: 20, clientY: 20, pointerId: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() }

describe('minimap pointer gestures', () => {
  afterEach(() => {
    drawInputs.length = 0
    vi.unstubAllGlobals()
  })

  it('forwards node colors, all node geometry, and independent paint settings', () => {
    const scene = {
      nodes: [{ id: 'n1', x: 100, y: 200, layout: { width: 300, height: 160 }, node: { mode: 'bypassed' }, color: '#5b4a92' }],
      groups: [{ id: 'g1', x: -500, y: -400, width: 200, height: 100, color: '#f00' }],
      links: [],
      reroutes: [],
    } as unknown as ReturnType<CanvasRenderer['getScene']>
    const h = harness({
      scene,
      settings: {
        'canvas.minimap.nodes': false,
        'canvas.minimap.bypass': false,
        'canvas.minimap.errors': false,
        'canvas.minimap.groups': true,
      },
    })
    h.handle.setStates({ n1: { state: 'error' } })
    h.handle.paint()
    const input = drawInputs.at(-1)!
    expect(input.nodes).toEqual([{ x: 100, y: 200, width: 300, height: 160, bypassed: true, color: '#5b4a92', state: 'error' }])
    expect(input.groups).toEqual([{ x: -500, y: -400, width: 200, height: 100, color: '#f00' }])
    expect(input.nodeColors).toBe(false)
    expect(input.renderBypassState).toBe(false)
    expect(input.renderErrorState).toBe(false)
    expect(input.visibility).toEqual({ groups: true })
    h.handle.dispose()
  })

  it('forwards minimized node geometry and its reanchored links', () => {
    const scene = {
      nodes: [{
        id: 'n1', x: 100, y: 200,
        layout: { width: 80, height: 56, minimized: true },
        node: { mode: 'active' },
      }],
      groups: [],
      links: [{ x1: 180, y1: 214, x2: 300, y2: 214 }],
      reroutes: [],
    } as unknown as ReturnType<CanvasRenderer['getScene']>
    const h = harness({ scene, settings: { 'canvas.minimap.noodles': true } })
    const input = drawInputs.at(-1)!
    expect(input.nodes).toEqual([{ x: 100, y: 200, width: 80, height: 56, bypassed: false }])
    expect(input.links).toEqual([{ from: { x: 180, y: 214 }, to: { x: 300, y: 214 } }])
    h.handle.dispose()
  })

  it('keeps links, groups, and reroutes independently configurable', () => {
    const scene = {
      nodes: [{ id: 'n1', x: 0, y: 0, layout: { width: 100, height: 60 }, node: { mode: 'active' } }],
      groups: [{ id: 'g1', x: -10, y: -10, width: 120, height: 80 }],
      links: [{ x1: 1, y1: 2, x2: 3, y2: 4 }],
      reroutes: [{ x: 5, y: 6 }],
    } as unknown as ReturnType<CanvasRenderer['getScene']>
    const h = harness({
      scene,
      settings: {
        'canvas.minimap.noodles': false,
        'canvas.minimap.groups': false,
        'canvas.minimap.reroutes': true,
      },
    })
    const input = drawInputs.at(-1)!
    expect(input.links).toEqual([])
    expect(input.groups).toHaveLength(1)
    expect(input.visibility).toEqual({ groups: false })
    expect(input.reroutes).toEqual([{ x: 5, y: 6 }])
    h.handle.dispose()
  })

  it('sizes the backing store by DPR while retaining CSS-coordinate geometry', () => {
    const h = harness({ dpr: 2 })
    expect(h.canvas.width).toBe(500)
    expect(h.canvas.height).toBe(400)
    expect(drawInputs.at(-1)).toMatchObject({ width: 250, height: 200 })
    h.handle.dispose()
  })

  it('uses the responsive CSS size for backing store and minimap geometry', () => {
    const h = harness({ dpr: 2, width: 200, height: 160 })
    expect(h.canvas.width).toBe(400)
    expect(h.canvas.height).toBe(320)
    expect(drawInputs.at(-1)).toMatchObject({ width: 200, height: 160 })
    h.handle.dispose()
  })

  it('maps border-box pointer events from the content-box origin', () => {
    const node = { id: 'n1', x: 100, y: 200, layout: { width: 300, height: 160 }, node: { mode: 'active' } }
    const h = harness({
      origin: { x: 40, y: 70 },
      border: 1,
      scene: { nodes: [node], groups: [], links: [], reroutes: [] } as unknown as ReturnType<CanvasRenderer['getScene']>,
    })
    const contentPoint = { x: 30, y: 45 }
    const transform = minimapTransform([{ x: 100, y: 200, width: 300, height: 160 }], 250, 200)!
    const world = minimapToWorld(transform, contentPoint.x, contentPoint.y)
    h.listeners.get('pointerdown')?.({
      ...pointer,
      clientX: 40 + 1 + contentPoint.x,
      clientY: 70 + 1 + contentPoint.y,
    })
    expect(h.setViewport).toHaveBeenLastCalledWith({
      x: 400 - world.x,
      y: 300 - world.y,
      scale: 1,
    })
    h.handle.dispose()
  })

  it('FR13 pointercancel ends a minimap drag', () => {
    const h = harness()
    h.listeners.get('pointerdown')?.(pointer)
    h.listeners.get('pointercancel')?.(pointer)
    const calls = h.setViewport.mock.calls.length
    h.listeners.get('pointermove')?.({ ...pointer, clientX: 40 })
    expect(h.setViewport).toHaveBeenCalledTimes(calls)
    h.handle.dispose()
  })

  it('FR13 losing pointer capture ends a minimap drag', () => {
    const h = harness()
    h.listeners.get('pointerdown')?.(pointer)
    h.listeners.get('lostpointercapture')?.(pointer)
    const calls = h.setViewport.mock.calls.length
    h.listeners.get('pointermove')?.({ ...pointer, clientX: 40 })
    expect(h.setViewport).toHaveBeenCalledTimes(calls)
    h.handle.dispose()
  })

  it('FR13 pointerup without held capture never calls releasePointerCapture', () => {
    const h = harness({ hasCapture: false })
    h.listeners.get('pointerdown')?.(pointer)
    h.listeners.get('pointerup')?.(pointer)
    expect(h.canvas.releasePointerCapture).not.toHaveBeenCalled()
  })

  it('FR13 dispose removes the cancellation listeners', () => {
    const h = harness()
    expect(h.listeners.has('pointercancel')).toBe(true)
    expect(h.listeners.has('lostpointercapture')).toBe(true)
    h.handle.dispose()
    // Identity-checked removal (see the harness fake): these only disappear
    // when production removed the exact callbacks it registered.
    expect(h.listeners.has('pointercancel')).toBe(false)
    expect(h.listeners.has('lostpointercapture')).toBe(false)
  })
})
