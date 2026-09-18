/**
 * InteractionController depends on a real canvas, DOM pointer capture, and a
 * renderer. There is no interaction event harness in this package, so keep
 * modifier precedence covered through the pure decision used by pointerdown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InteractionController,
  connectedInputDragMode,
  connectivityRangeSelection,
  endpointDragMode,
  resizedNodeBounds,
  type InteractionHost,
} from '../src/interaction.js'
import { hitTestBoundaryPin, PIN_HIT_RADIUS } from '../src/hit.js'
import { BOUNDARY_ADD_SLOT } from '../src/layout.js'
import { CanvasRenderer, previewSurfaceAffordanceRect, widgetRowAffordanceRect, type RendererLensCapabilities } from '../src/renderer.js'
import { portEndKey, REROUTE_SOCKET_OFFSET, type Scene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { ToolboxLayout } from '../src/toolbox.js'

function interactionHarness(
  scene: Scene,
  hostOverrides: Partial<InteractionHost> = {},
  badges: Record<string, readonly any[]> = {},
  toolbox?: ToolboxLayout | (() => ToolboxLayout | undefined),
  lensCapabilities: RendererLensCapabilities = {},
) {
  const listeners = new Map<string, (event: any) => void>()
  const windowListeners = new Map<string, (event: any) => void>()
  const sceneReplacedListeners: Array<(scene: Scene) => void> = []
  const capturedPointers = new Set<number>()
  const setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId))
  const releasePointerCapture = vi.fn((pointerId: number) => {
    capturedPointers.delete(pointerId)
    // Browsers synchronously report capture loss, including during cleanup.
    listeners.get('lostpointercapture')?.({ pointerId })
  })
  const canvas = {
    style: {},
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    removeEventListener: () => undefined,
    setPointerCapture,
    hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
    releasePointerCapture,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLCanvasElement
  const overlays: unknown[] = []
  let overlay: Record<string, unknown> = {}
  let viewportOffset = { x: 0, y: 0 }
  let viewportScale = 1
  let currentScene = scene
  const renderer = {
    getScene: () => currentScene,
    measureWidgetText: (text: string) => text.length * 6,
    toWorld: (x: number, y: number) => ({ x: x / viewportScale + viewportOffset.x, y: y / viewportScale + viewportOffset.y }),
    getViewport: () => ({ x: -viewportOffset.x * viewportScale, y: -viewportOffset.y * viewportScale, scale: viewportScale }),
    getDetailLevel: () => viewportScale < 0.5 ? 'overview' : viewportScale < 0.75 ? 'content' : 'controls',
    setViewport: vi.fn(),
    setScene: (next: Scene) => {
      currentScene = next
      for (const listener of sceneReplacedListeners) listener(next)
    },
    getToolboxLayout: () => typeof toolbox === 'function' ? toolbox() : toolbox,
    getBadges: () => badges,
    getLensCapabilities: () => lensCapabilities,
    getDesignTokens: () => defaultTokens,
    getOverlay: () => overlay,
    setOverlay: (next: Record<string, unknown>) => {
      overlay = next
      overlays.push(next)
    },
    onSceneReplaced: (listener: (scene: Scene) => void) => {
      sceneReplacedListeners.push(listener)
      return () => undefined
    },
  } as unknown as CanvasRenderer
  const dispatched: unknown[] = []
  const host: InteractionHost = {
    dispatch: (invocation) => { dispatched.push(invocation); return { ok: true } },
    ...hostOverrides,
  }
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: (event: any) => void) => windowListeners.set(name, listener),
    removeEventListener: () => undefined,
  })
  vi.stubGlobal('HTMLElement', class {})
  const controller = new InteractionController(canvas, renderer, host)
  const fire = (name: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    listeners.get(name)?.({
      type: name, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: '',
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      timeStamp: 0, target: canvas,
      preventDefault: () => undefined, ...extra,
    })
  const fireWindow = (name: string, extra: Record<string, unknown> = {}) =>
    windowListeners.get(name)?.({
      type: name, clientX: 0, clientY: 0, button: 0, pointerId: 1, pointerType: '',
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      timeStamp: 0, target: {}, preventDefault: () => undefined, ...extra,
    })
  const swapScene = (next: Scene) => { currentScene = next }
  const replaceScene = (next: Scene) => {
    currentScene = next
    for (const l of sceneReplacedListeners) l(next)
  }
  return {
    controller, renderer, fire, fireWindow, dispatched, overlays, replaceScene, swapScene,
    setViewportOffset: (x: number, y: number) => { viewportOffset = { x, y } },
    setViewportTransform: (x: number, y: number, scale: number) => { viewportOffset = { x, y }; viewportScale = scale },
    setPointerCapture, releasePointerCapture,
  }
}

describe('lens widget-row affordance', () => {
  it('claims its registered row region and activates without opening the widget editor', () => {
    const scene = interactionScene()
    const activateAffordance = vi.fn()
    const activateWidget = vi.fn()
    const row = scene.nodes[0]!.layout.rows[0]!
    if (row.kind !== 'widget') throw new Error('expected widget row')
    const rect = widgetRowAffordanceRect(
      scene.nodes[0]!.layout.width - row.inset * 2,
      defaultTokens.rowHeight,
      row,
    )
    const harness = interactionHarness(
      scene,
      { onWidgetRowAffordanceActivate: activateAffordance, onWidgetActivate: activateWidget },
      {},
      undefined,
      { widgetRowAffordance: () => ({ active: false, label: 'Expose in app view' }) },
    )
    const x = scene.nodes[0]!.x + row.inset + rect.x + rect.width / 2
    const y = scene.nodes[0]!.y + row.y + rect.y + rect.height / 2
    harness.fire('pointerdown', x, y)
    harness.fire('pointerup', x, y)

    expect(activateAffordance).toHaveBeenCalledOnce()
    expect(activateWidget).not.toHaveBeenCalled()
    expect(harness.dispatched).toEqual([])
  })

})

describe('lens preview-surface affordance', () => {
  it('claims its preview control and activates without starting a node drag', () => {
    const base = interactionScene()
    const node = base.nodes[0]!
    const previewNode = {
      ...node,
      layout: {
        ...node.layout,
        height: 140,
        preview: { x: 10, y: 56, width: 80, height: 72 },
      },
    }
    const scene = { ...base, nodes: [previewNode, ...base.nodes.slice(1)] } as Scene
    const activate = vi.fn()
    const rect = previewSurfaceAffordanceRect(previewNode)!
    const harness = interactionHarness(
      scene,
      { onPreviewSurfaceAffordanceActivate: activate },
      {},
      undefined,
      { previewSurfaceAffordance: () => ({ active: false, label: 'Expose preview in app view' }) },
    )
    const x = previewNode.x + rect.x + rect.width / 2
    const y = previewNode.y + rect.y + rect.height / 2
    harness.fire('pointerdown', x, y)
    harness.fire('pointerup', x, y)

    expect(activate).toHaveBeenCalledOnce()
    expect(harness.dispatched).toEqual([])
  })
})

function interactionScene(): Scene {
  const widget = (inputId: string, widgetType: 'INT' | 'FLOAT', value: number, options: Record<string, number> = {}) => ({
    kind: 'widget' as const,
    inputId,
    valueKey: inputId,
    label: inputId,
    type: { kind: 'concrete' as const, name: widgetType },
    y: 20,
    height: 24,
    inset: 9.5,
    spec: { widgetType, options, default: value },
  })
  const node = (id: string, x: number, row = widget('amount', 'FLOAT', 0.2, { step: 0.1, min: 0, max: 0.3 })) => ({
    id, x, y: 10, node: { id, type: 'Numeric', values: { amount: 0.2 } },
    layout: {
      width: 100, height: 44, minWidth: 80, minHeight: 40,
      headerHeight: 20, rows: [row], pins: [], title: id,
    },
  })
  return {
    graphId: 'g0',
    nodes: [node('n1', 10), node('n2', 200)],
    links: [],
    reroutes: [{ id: 'r1', x: 400, y: 100, typeName: 'FLOAT' }],
    valueSources: [{ id: 'v1', x: 500, y: 100, width: 80, height: 30, value: 1, effective: { widgetType: 'FLOAT', type: { kind: 'concrete', name: 'FLOAT' } } }],
    selectors: [{ id: 's1', x: 600, y: 100, width: 100, height: 50, headerHeight: 20, candidates: [], policy: { kind: 'fixed', candidate: 'x' } }],
    netStubs: [], groups: [], boundaryNodes: [], diagnostics: [],
  } as unknown as Scene
}

describe('persistent host overlays', () => {
  it('preserves an armed placement ghost across selection overlay updates', () => {
    const { controller, renderer } = interactionHarness(interactionScene())
    const ghost = { x: 10, y: 20, width: 180, height: 88, title: 'KSampler' }
    controller.setPlacementGhost(ghost)
    controller.setSelection(['n1'])
    expect(renderer.getOverlay().placementGhost).toEqual(ghost)
    controller.setPlacementGhost(undefined)
    expect(renderer.getOverlay().placementGhost).toBeUndefined()
    controller.dispose()
  })
})

function paintedGhostStrokes(scene: Scene, ghostLink: NonNullable<ReturnType<CanvasRenderer['getOverlay']>['ghostLink']>): string[] {
  const strokes: string[] = []
  let strokeStyle = ''
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, property) => property === 'measureText'
      ? (text: string) => ({ width: text.length * 6 })
      : property === 'stroke'
        ? () => strokes.push(strokeStyle)
        : () => undefined,
    set: (_target, property, value) => {
      if (property === 'strokeStyle') strokeStyle = String(value)
      return true
    },
  })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('Path2D', class Path2D {})
  const canvas = {
    getContext: () => ctx, clientWidth: 800, clientHeight: 600, width: 0, height: 0,
  } as unknown as HTMLCanvasElement
  const renderer = new CanvasRenderer(canvas, defaultTokens)
  renderer.setScene(scene)
  renderer.setOverlay({ ghostLink })
  renderer.renderNow()
  renderer.dispose()
  return strokes
}

function controllerScene(mode: 'fixed' | 'increment' | 'decrement' | 'randomize', connected = false): Scene {
  const scene = interactionScene() as any
  scene.nodes[0].layout.rows[0].controllerMode = mode
  if (connected) scene.links = [{
    id: 'l1', from: { kind: 'port', node: 'n2', port: 'out' },
    to: { kind: 'port', node: 'n1', port: 'amount' }, x1: 0, y1: 0, x2: 0, y2: 0,
  }]
  return scene
}

afterEach(() => vi.unstubAllGlobals())

describe('node resize geometry', () => {
  const start = { x: 100, y: 80, width: 200, height: 120 }

  it('moves both NW edges while their opposite edges stay anchored', () => {
    expect(resizedNodeBounds(start, 300, 200, 130, 100, 'nw', 80, 60)).toEqual({ x: 130, y: 100, width: 170, height: 100 })
  })

  it('clamps moving edges without moving the anchored corner', () => {
    const nw = resizedNodeBounds(start, 300, 200, 600, 580, 'nw', 80, 60)
    expect(nw).toEqual({ x: 220, y: 140, width: 80, height: 60 })
    expect(nw.x + nw.width).toBe(300)
    expect(nw.y + nw.height).toBe(200)
    const se = resizedNodeBounds(start, 100, 80, -400, -420, 'se', 80, 60)
    expect(se).toEqual({ x: 100, y: 80, width: 80, height: 60 })
  })

  it('preserves a captured NW anchor exactly across many zoomed moves and clamping', () => {
    const scale = 0.7
    const anchorX = start.x + start.width
    const anchorY = start.y + start.height
    let bounds = resizedNodeBounds(start, anchorX, anchorY, start.x, start.y, 'nw', 80, 60)
    for (let screen = 0.7; screen <= 49; screen += 0.7) {
      const world = screen / scale
      bounds = resizedNodeBounds(start, anchorX, anchorY, start.x - world, start.y - world, 'nw', 80, 60)
      expect(bounds.x + bounds.width).toBe(anchorX)
      expect(bounds.y + bounds.height).toBe(anchorY)
    }
    bounds = resizedNodeBounds(start, anchorX, anchorY, anchorX + 1000, anchorY + 1000, 'nw', 80, 60)
    expect(bounds.x + bounds.width).toBe(anchorX)
    expect(bounds.y + bounds.height).toBe(anchorY)
  })
})

describe('connected input drag modifiers', () => {
  it('normally grabs the existing link for a rewire', () => {
    expect(connectedInputDragMode(false, false)).toBe('rewire')
  })

  it('Shift starts a replacement candidate without selecting the rewire path', () => {
    expect(connectedInputDragMode(true, false)).toBe('replace-candidate')
  })

  it('Alt retains fan-out precedence when Shift is also held', () => {
    expect(connectedInputDragMode(false, true)).toBe('fan-out')
    expect(connectedInputDragMode(true, true)).toBe('fan-out')
  })

  it('shares Shift interpretation across connected real and pseudo endpoints', () => {
    expect(endpointDragMode('out', true, true)).toBe('move-source')
    expect(endpointDragMode('in', true, true)).toBe('replace-candidate')
    expect(endpointDragMode('out', false, true)).toBe('fresh')
    expect(endpointDragMode('in', false, true)).toBe('fresh')
  })
})

describe('node selection modifiers', () => {
  const linkedScene = (): Scene => {
    const scene = interactionScene() as any
    const base = scene.nodes[1]
    scene.nodes.push(
      { ...base, id: 'n3', x: 390, node: { ...base.node, id: 'n3' } },
      { ...base, id: 'n4', x: 580, node: { ...base.node, id: 'n4' } },
    )
    scene.links = [
      { id: 'l1', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'port', node: 'n2', port: 'in' }, x1: 0, y1: 0, x2: 0, y2: 0 },
      { id: 'l2', from: { kind: 'port', node: 'n2', port: 'out' }, to: { kind: 'port', node: 'n3', port: 'in' }, x1: 0, y1: 0, x2: 0, y2: 0 },
    ]
    return scene
  }

  it('Shift-click selects every node on the directed path between endpoints', () => {
    const changed = vi.fn()
    const harness = interactionHarness(linkedScene(), { onSelectionChange: changed })
    harness.controller.setSelection(['n1'])

    harness.fire('pointerdown', 410, 15, { shiftKey: true })

    expect(new Set(changed.mock.calls.at(-1)![0])).toEqual(new Set(['n1', 'n2', 'n3']))
  })

  it('Shift-click with an empty selection toggles the clicked node', () => {
    const changed = vi.fn()
    const harness = interactionHarness(linkedScene(), { onSelectionChange: changed })

    harness.fire('pointerdown', 410, 15, { shiftKey: true })

    expect(changed).toHaveBeenLastCalledWith(
      new Set(['n3']), new Set(), new Set(), new Set(), new Set(), new Set(),
    )
  })

  it('Ctrl and Meta clicks still toggle nodes additively', () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const changed = vi.fn()
      const harness = interactionHarness(interactionScene(), { onSelectionChange: changed })
      harness.controller.setSelection(['n1'])
      harness.fire('pointerdown', 220, 15, modifier)
      expect(changed).toHaveBeenLastCalledWith(
        new Set(['n1', 'n2']), new Set(), new Set(), new Set(), new Set(), new Set(),
      )
    }
  })

  it('Ctrl+Shift remains an alias for the directed connectivity range', () => {
    const scene = linkedScene()
    expect([...connectivityRangeSelection(scene, new Set(['n1']), 'n3')!.nodes]).toEqual(['n1', 'n2', 'n3'])
    expect([...connectivityRangeSelection(scene, new Set(['n3']), 'n1')!.nodes]).toEqual(['n3', 'n1', 'n2'])

    const changed = vi.fn()
    const harness = interactionHarness(scene, { onSelectionChange: changed })
    harness.controller.setSelection(['n1'])
    harness.fire('pointerdown', 410, 15, { ctrlKey: true, shiftKey: true })
    expect(new Set(changed.mock.calls.at(-1)![0])).toEqual(new Set(['n1', 'n2', 'n3']))
  })

  it('Shift-click on an unconnected node falls back to additive toggle', () => {
    const changed = vi.fn()
    const harness = interactionHarness(linkedScene(), { onSelectionChange: changed })
    harness.controller.setSelection(['n1'])
    harness.fire('pointerdown', 600, 15, { shiftKey: true })
    expect(changed).toHaveBeenLastCalledWith(
      new Set(['n1', 'n4']), new Set(), new Set(), new Set(), new Set(), new Set(),
    )
  })

  it('Shift-click on a selected unconnected node toggles it off', () => {
    const changed = vi.fn()
    const harness = interactionHarness(linkedScene(), { onSelectionChange: changed })
    harness.controller.setSelection(['n1', 'n4'])

    harness.fire('pointerdown', 600, 15, { shiftKey: true })

    expect(changed).toHaveBeenLastCalledWith(
      new Set(['n1']), new Set(), new Set(), new Set(), new Set(), new Set(),
    )
  })

  it('Shift-click keeps previously selected nodes outside the connecting path', () => {
    const changed = vi.fn()
    const harness = interactionHarness(linkedScene(), { onSelectionChange: changed })
    harness.controller.setSelection(['n1', 'n4'])

    harness.fire('pointerdown', 410, 15, { shiftKey: true })

    expect(new Set(changed.mock.calls.at(-1)![0])).toEqual(new Set(['n1', 'n2', 'n3', 'n4']))
  })

  it('a drag started by Shift-click moves the whole connectivity range', () => {
    const harness = interactionHarness(linkedScene())
    harness.controller.setSelection(['n1'])

    harness.fire('pointerdown', 410, 15, { shiftKey: true })
    harness.fire('pointermove', 420, 25, { shiftKey: true })
    harness.fire('pointerup', 420, 25, { shiftKey: true })

    expect(harness.dispatched).toEqual([{
      command: 'node.move',
      params: {
        graphId: 'g0',
        positions: {
          n1: { x: 20, y: 20 },
          n2: { x: 210, y: 20 },
          n3: { x: 400, y: 20 },
        },
      },
    }])
  })

  it('Shift-click selects reroutes on the connecting path but not unrelated reroutes', () => {
    const scene = linkedScene() as any
    scene.reroutes.push({ id: 'r2', x: 500, y: 100, typeName: 'FLOAT' })
    scene.links = [
      { id: 'l1', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'reroute', reroute: 'r1' }, x1: 0, y1: 0, x2: 0, y2: 0 },
      { id: 'l2', from: { kind: 'reroute', reroute: 'r1' }, to: { kind: 'port', node: 'n2', port: 'in' }, x1: 0, y1: 0, x2: 0, y2: 0 },
    ]
    const changed = vi.fn()
    const harness = interactionHarness(scene, { onSelectionChange: changed })
    harness.controller.setSelection(['n1'])

    harness.fire('pointerdown', 220, 15, { shiftKey: true })

    expect(changed).toHaveBeenLastCalledWith(
      new Set(['n1', 'n2']), new Set(), new Set(['r1']), new Set(), new Set(), new Set(),
    )
  })

  it('a drag started by a rerouted Shift-click range moves its reroutes', () => {
    const scene = linkedScene() as any
    scene.reroutes.push({ id: 'r2', x: 500, y: 100, typeName: 'FLOAT' })
    scene.links = [
      { id: 'l1', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'reroute', reroute: 'r1' }, x1: 0, y1: 0, x2: 0, y2: 0 },
      { id: 'l2', from: { kind: 'reroute', reroute: 'r1' }, to: { kind: 'port', node: 'n2', port: 'in' }, x1: 0, y1: 0, x2: 0, y2: 0 },
    ]
    const harness = interactionHarness(scene)
    harness.controller.setSelection(['n1'])

    harness.fire('pointerdown', 220, 15, { shiftKey: true })
    harness.fire('pointermove', 230, 25, { shiftKey: true })
    harness.fire('pointerup', 230, 25, { shiftKey: true })

    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: { n1: { x: 20, y: 20 }, n2: { x: 210, y: 20 } },
        reroutes: { r1: { x: 410, y: 110 } },
      },
    }])
  })
})

describe('marquee selection', () => {
  it('includes reroute dots inside the rectangle', () => {
    const changed = vi.fn()
    const harness = interactionHarness(interactionScene(), { onSelectionChange: changed })

    harness.fire('pointerdown', 380, 80, { ctrlKey: true })
    harness.fire('pointermove', 420, 120, { ctrlKey: true })
    harness.fire('pointerup', 420, 120, { ctrlKey: true })

    expect(changed).toHaveBeenLastCalledWith(
      new Set(), new Set(), new Set(['r1']), new Set(), new Set(), new Set(),
    )
  })

  it('Select All matches a full-canvas marquee across every selectable citizen kind', () => {
    const scene = interactionScene() as any
    scene.groups = [{ id: 'grp0', title: 'all', x: 0, y: 0, width: 700, height: 200 }]
    scene.boundaryNodes = [{
      side: 'inputs', x: 720, y: 20,
      layout: { width: 100, height: 80, headerHeight: 24, pins: [], rows: [], title: 'Inputs' },
    }]
    const changed = vi.fn()
    const harness = interactionHarness(scene, { onSelectionChange: changed })

    harness.fire('pointerdown', -100, -100, { ctrlKey: true })
    harness.fire('pointermove', 900, 300, { ctrlKey: true })
    harness.fire('pointerup', 900, 300, { ctrlKey: true })
    const marquee = changed.mock.calls.at(-1)

    harness.controller.setSelection([])
    harness.controller.selectAll()
    const selectAll = changed.mock.calls.at(-1)

    expect(selectAll).toEqual(marquee)
    expect(selectAll).toEqual([
      new Set(['n1', 'n2', '@boundary:inputs']),
      new Set(),
      new Set(['r1']),
      new Set(['v1']),
      new Set(['s1']),
      new Set(['grp0']),
    ])
  })

  it('Select All reads only the current graph scene after entering a subgraph', () => {
    const root = interactionScene()
    const changed = vi.fn()
    const harness = interactionHarness(root, { onSelectionChange: changed })
    const subgraph = {
      ...interactionScene(),
      graphId: 'gSub',
      nodes: [interactionScene().nodes[0]!],
      reroutes: [],
      valueSources: [],
      selectors: [],
      groups: [],
      boundaryNodes: [],
    }

    harness.controller.selectAll()
    harness.replaceScene(subgraph)
    expect(changed).toHaveBeenLastCalledWith(
      new Set(), new Set(), new Set(), new Set(), new Set(), new Set(),
    )
    harness.controller.selectAll()

    expect(changed).toHaveBeenLastCalledWith(
      new Set(['n1']), new Set(), new Set(), new Set(), new Set(), new Set(),
    )
  })

  it('Select All keeps the node-only move fast path when a scene has only nodes', () => {
    const scene = { ...interactionScene(), nodes: [interactionScene().nodes[0]!], reroutes: [], valueSources: [], selectors: [] }
    const harness = interactionHarness(scene)
    harness.controller.selectAll()

    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    harness.fire('pointerup', 40, 25)

    expect(harness.dispatched).toEqual([{
      command: 'node.move',
      params: { graphId: 'g0', positions: { n1: { x: 20, y: 20 } } },
    }])
  })
})

describe('canvas hover targets', () => {
  const sceneWithPins = (): Scene => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.pins = [
      {
        portId: 'input', address: { port: 'input' }, label: 'input', direction: 'in',
        y: 20, type: { kind: 'concrete', name: 'INT' },
      },
      {
        portId: 'output', address: { port: 'output' }, label: 'output', direction: 'out',
        y: 20, type: { kind: 'concrete', name: 'FLOAT' },
      },
    ]
    scene.nodes[1].layout.pins = [{
      portId: 'input', address: { port: 'input' }, label: 'input', direction: 'in',
      y: 20, type: { kind: 'concrete', name: 'FLOAT' },
    }]
    return scene
  }

  const sceneWithWidgetTap = (): Scene => {
    const scene = sceneWithPins() as any
    scene.nodes[0].layout.pins.push({
      portId: 'amount', address: { port: 'amount' }, label: 'Amount value', direction: 'out',
      y: 32, type: { kind: 'concrete', name: 'FLOAT' }, widgetTap: true,
    })
    return scene
  }

  it('sets distinct input and output pin hover identities only when they change', () => {
    const harness = interactionHarness(sceneWithPins())

    harness.fire('pointermove', 10, 30)
    expect(harness.overlays.at(-1)).toMatchObject({
      hoveredPin: { nodeId: 'n1', portId: 'input', direction: 'in' },
    })
    const inputPaints = harness.overlays.length
    harness.fire('pointermove', 11, 30)
    expect(harness.overlays).toHaveLength(inputPaints)

    harness.fire('pointermove', 110, 30)
    expect(harness.overlays.at(-1)).toMatchObject({
      hoveredPin: { nodeId: 'n1', portId: 'output', direction: 'out' },
    })
  })

  it('retains keyboard-focused pin identity across pointer overlay updates', () => {
    const harness = interactionHarness(sceneWithPins())
    harness.controller.setFocusedPin({ nodeId: 'n1', portId: 'input', direction: 'in' })
    expect(harness.overlays.at(-1)).toMatchObject({ focusedPin: { nodeId: 'n1', portId: 'input', direction: 'in' } })
    harness.fire('pointermove', 110, 30)
    expect(harness.overlays.at(-1)).toMatchObject({
      focusedPin: { nodeId: 'n1', portId: 'input', direction: 'in' },
      hoveredPin: { nodeId: 'n1', portId: 'output', direction: 'out' },
    })
    const paints = harness.overlays.length
    harness.controller.setFocusedPin({ nodeId: 'n1', portId: 'input', direction: 'in', widgetTap: true })
    expect(harness.overlays).toHaveLength(paints + 1)
    expect(harness.overlays.at(-1)).toMatchObject({
      focusedPin: { nodeId: 'n1', portId: 'input', direction: 'in', widgetTap: true },
    })
    harness.controller.setFocusedPin(undefined)
    expect(harness.overlays.at(-1)).not.toHaveProperty('focusedPin')
  })

  it('sets widget-row hover and clears detailed hover on leave and scene replacement', () => {
    const harness = interactionHarness(sceneWithPins())

    harness.fire('pointermove', 50, 35)
    expect(harness.overlays.at(-1)).toMatchObject({
      hoveredWidget: { nodeId: 'n1', valueKey: 'amount' },
    })
    harness.fire('pointerleave', 50, 35)
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredWidget')

    harness.fire('pointermove', 10, 30)
    expect(harness.overlays.at(-1)).toHaveProperty('hoveredPin')
    harness.replaceScene(sceneWithPins())
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredPin')
  })

  it('uses the full multiline row rectangle for widget hover', () => {
    const scene = sceneWithPins() as any
    // Leave ordinary node body below the row so the outside sample proves
    // the row boundary, not merely the node boundary.
    scene.nodes[0].layout.height = 110
    scene.nodes[0].layout.rows[0].height = 72
    scene.nodes[0].layout.rows[0].viewId = 'core.text'
    scene.nodes[0].layout.rows[0].rows = 2
    scene.nodes[0].layout.rows[0].spec = { widgetType: 'STRING', options: {}, multiline: true }
    const harness = interactionHarness(scene)

    harness.fire('pointermove', 50, 99)
    expect(harness.overlays.at(-1)).toMatchObject({
      hoveredWidget: { nodeId: 'n1', valueKey: 'amount' },
    })
    harness.fire('pointermove', 50, 103)
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredWidget')
  })

  it('idle hover over a visible widget tap sets tap identity on the second tap move and clears on leave and scene replacement', () => {
    const hover = vi.fn()
    const harness = interactionHarness(sceneWithWidgetTap(), { onHoverTarget: hover })

    harness.fire('pointermove', 110, 42)
    harness.fire('pointermove', 110, 42)
    expect(harness.overlays.at(-1)).toMatchObject({
      hoveredPin: { nodeId: 'n1', portId: 'amount', direction: 'out', widgetTap: true },
    })
    expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'widgetTap',
      hit: expect.objectContaining({ input: 'amount' }),
    }))
    const tapPaints = harness.overlays.length
    harness.fire('pointermove', 110, 42)
    expect(harness.overlays).toHaveLength(tapPaints)

    harness.fire('pointerleave', 110, 42)
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredPin')
    harness.fire('pointermove', 50, 35)
    harness.fire('pointermove', 110, 42)
    harness.replaceScene(sceneWithWidgetTap())
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredPin')
  })

  it('clears pin hover at gesture ownership and does not churn it during the drag', () => {
    const harness = interactionHarness(sceneWithPins())
    harness.fire('pointermove', 110, 30)
    harness.fire('pointerdown', 110, 30)
    const afterOwnership = harness.overlays.length
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredPin')

    harness.fire('pointermove', 200, 30, { buttons: 1 })
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredPin')
    expect((harness.overlays.at(-1) as any).dropTargets).toContain('n2:input:in')
    expect(harness.overlays.length).toBeGreaterThanOrEqual(afterOwnership)
    expect(harness.overlays.slice(afterOwnership)).not.toContainEqual(
      expect.objectContaining({ hoveredPin: expect.anything() }),
    )
  })

  it('toolbox separator and padding suppress graph hover targets underneath', () => {
    const hover = vi.fn()
    const nodeHover = vi.fn()
    const toolbox: ToolboxLayout = {
      x: 5,
      y: 5,
      width: 100,
      height: 35,
      rows: [{
        x: 10,
        y: 8,
        width: 90,
        height: 28,
        panel: { x: 5, y: 5, width: 100, height: 35 },
        entries: [{ kind: 'separator', x: 50, y: 14, width: 1, height: 16.8 }],
      }],
      buttons: [],
    }
    const harness = interactionHarness(interactionScene(), { onHoverTarget: hover, onNodeHover: nodeHover }, {}, toolbox)

    harness.fire('pointermove', 50.5, 20)

    expect(hover).toHaveBeenLastCalledWith(undefined)
    expect(nodeHover).not.toHaveBeenCalledWith('n1')
    expect(harness.overlays.at(-1)).not.toMatchObject({ hoveredNode: 'n1' })
  })

  it('carries warned-pin metadata through the existing hover hit-test path', () => {
    const hover = vi.fn()
    const scene = interactionScene() as any
    scene.nodes[0].layout.pins = [{
      portId: 'input', address: { port: 'input' }, label: 'input', direction: 'in',
      y: 20, type: { kind: 'concrete', name: 'INT' }, warn: true,
    }]
    const harness = interactionHarness(scene, { onHoverTarget: hover })

    harness.fire('pointermove', 10, 30)

    expect(hover).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pin',
      hit: expect.objectContaining({ portId: 'input', pin: expect.objectContaining({ warn: true }) }),
    }))
  })

  it('emits proven-mismatch noodle bodies and midpoint grab dots but not healthy noodles', () => {
    const hover = vi.fn()
    const scene = interactionScene() as any
    scene.links = [
      {
        id: 'bad', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'port', node: 'n2', port: 'in' },
        x1: 110, y1: 70, x2: 200, y2: 70, mismatch: true,
        diagnostics: [{ severity: 'warning', message: 'types do not match' }],
      },
      {
        id: 'good', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'port', node: 'n2', port: 'in' },
        x1: 110, y1: 90, x2: 200, y2: 90,
      },
    ]
    const harness = interactionHarness(scene, { onHoverTarget: hover })

    harness.fire('pointermove', 155, 70)
    expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'link',
      hit: expect.objectContaining({ midpoint: true, link: expect.objectContaining({ id: 'bad' }) }),
    }))

    harness.fire('pointermove', 125, 70)
    expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'link',
      hit: expect.objectContaining({ midpoint: false, link: expect.objectContaining({ id: 'bad' }) }),
    }))

    harness.fire('pointermove', 155, 90)
    expect(hover).toHaveBeenLastCalledWith(undefined)
  })

  it('refreshHover re-announces the stationary pointer hover against the replaced scene', () => {
    const hover = vi.fn()
    const scene = interactionScene() as any
    scene.links = [{
      id: 'bad', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'port', node: 'n2', port: 'in' },
      x1: 110, y1: 70, x2: 200, y2: 70, mismatch: true,
      diagnostics: [{ severity: 'warning', message: 'types do not match' }],
    }]
    const harness = interactionHarness(scene, { onHoverTarget: hover })

    harness.fire('pointermove', 155, 70)
    const rebuilt = structuredClone(scene)
    harness.replaceScene(rebuilt)
    hover.mockClear()

    harness.controller.refreshHover()
    expect(hover).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'link',
      hit: expect.objectContaining({ midpoint: true, link: expect.objectContaining({ id: 'bad' }) }),
    }))
    // The re-announced hit must belong to the replaced scene, not the stale one.
    expect((hover.mock.calls.at(-1)![0] as any).hit.link).toBe(rebuilt.links[0])

    harness.fire('pointerleave', 155, 70)
    hover.mockClear()
    harness.controller.refreshHover()
    expect(hover).not.toHaveBeenCalled()
  })

  it('refreshHover stays silent after a gesture: the pre-drag idle position is stale', () => {
    const hover = vi.fn()
    const scene = interactionScene() as any
    scene.links = [{
      id: 'bad', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'port', node: 'n2', port: 'in' },
      x1: 110, y1: 70, x2: 200, y2: 70, mismatch: true,
      diagnostics: [{ severity: 'warning', message: 'types do not match' }],
    }]
    const harness = interactionHarness(scene, { onHoverTarget: hover })

    harness.fire('pointermove', 155, 70) // idle hover over the midpoint
    harness.fire('pointerdown', 400, 300) // a gesture takes ownership elsewhere
    harness.fire('pointermove', 420, 320)
    harness.fire('pointerup', 420, 320)
    hover.mockClear()

    // The idle position predates the gesture; re-announcing it would hover
    // whatever happens to sit at the pre-drag coordinates.
    harness.controller.refreshHover()
    expect(hover).not.toHaveBeenCalled()
  })

  it('emits a badge before the underlying node header', () => {
    const hover = vi.fn()
    const badge = { id: 'core.error', glyph: '!', color: '#f00' }
    const harness = interactionHarness(interactionScene(), { onHoverTarget: hover }, { n1: [badge] })

    // n1 badge rect: x=88..102, y=13..27. This is also inside the header.
    harness.fire('pointermove', 95, 20)

    expect(hover).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'badge', x: 95, y: 20,
      hit: expect.objectContaining({ badge, node: expect.objectContaining({ id: 'n1' }) }),
    }))
  })

  it('FR5 scene replacement clears hover for a departed node', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointermove', 50, 15)
    expect(harness.overlays.at(-1)).toMatchObject({ hoveredNode: 'n1' })
    harness.replaceScene({ ...interactionScene(), nodes: [] })
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredNode')
  })

  it('FR5 a cross-graph replacement stales hover even when the id survives', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointermove', 50, 15)
    expect(harness.overlays.at(-1)).toMatchObject({ hoveredNode: 'n1' })
    harness.replaceScene({ ...interactionScene(), graphId: 'g1' })
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredNode')
  })

  it('FR5 a surviving marquee keeps its rectangle when hover is pruned', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointermove', 50, 15)
    harness.fire('pointerdown', 800, 500, { ctrlKey: true })
    harness.fire('pointermove', 830, 540, { ctrlKey: true })
    const marquee = (harness.overlays.at(-1) as any).marquee
    expect(marquee).toEqual({ x1: 800, y1: 500, x2: 830, y2: 540 })

    harness.replaceScene({ ...interactionScene(), nodes: [] })
    expect(harness.overlays.at(-1)).toEqual(expect.objectContaining({ marquee }))
    expect(harness.overlays.at(-1)).not.toHaveProperty('hoveredNode')

    harness.fire('pointermove', 850, 560, { ctrlKey: true })
    expect(harness.overlays.at(-1)).toMatchObject({
      marquee: { x1: 800, y1: 500, x2: 850, y2: 560 },
    })
  })
})

describe('context menus', () => {
  it('selects an unselected group before resolving its context menu', () => {
    const menu = vi.fn()
    const scene = interactionScene() as any
    scene.groups = [{ id: 'group', title: 'Group', x: 320, y: 10, width: 120, height: 100 }]
    const harness = interactionHarness(scene, { onContextMenu: menu })
    harness.controller.setSelection(['n1'])
    harness.fire('contextmenu', 350, 20)
    expect(harness.controller.getSelection()).toEqual(new Set())
    expect(harness.controller.getGroupSelection()).toEqual(new Set(['group']))
    expect(menu.mock.calls[0]![0]).toMatchObject({ kind: 'group-header', group: { id: 'group' } })
  })

  it('FR4 context menu re-resolves the hit when selection notification replaces the scene', () => {
    const menu = vi.fn()
    let harness: ReturnType<typeof interactionHarness>
    const next = { ...interactionScene(), nodes: [] }
    harness = interactionHarness(interactionScene(), {
      onSelectionChange: () => harness.renderer.setScene(next),
      onContextMenu: menu,
    })
    harness.fire('contextmenu', 50, 15)
    expect(menu).toHaveBeenCalledWith({ kind: 'empty' }, 50, 15, 50, 15)
  })

  it('FR4 a pin revealed by the new selection is not the menu target', () => {
    const menu = vi.fn()
    const initial = interactionScene() as any
    initial.nodes[0].layout.pins = [{
      portId: 'amount', address: { port: 'amount' }, direction: 'in', x: 0, y: 22,
      type: { kind: 'concrete', name: 'FLOAT' }, widgetBacked: true,
    }]
    let harness: ReturnType<typeof interactionHarness>
    let current: Scene
    harness = interactionHarness(initial, {
      onSelectionChange: () => {
        current = structuredClone(initial)
        harness.renderer.setScene(current)
      },
      onContextMenu: menu,
    })
    const staleNode = initial.nodes[0]
    harness.fire('contextmenu', 10, 32)
    const hit = menu.mock.calls[0]![0]
    expect(hit).toMatchObject({ kind: 'body', node: { id: 'n1' } })
    expect(hit.node).toBe(current!.nodes[0])
    expect(hit.node).not.toBe(staleNode)
  })

  it('FR4 a graph switch never targets a same-id entity in the new graph', () => {
    const menu = vi.fn()
    let harness: ReturnType<typeof interactionHarness>
    // Same node ids at the same positions, but a DIFFERENT graph: an id
    // collision across graphs is an unrelated entity, so no menu target
    // survives - not the re-hit, not the clicked node's body.
    const next = { ...interactionScene(), graphId: 'g1' }
    harness = interactionHarness(interactionScene(), {
      onSelectionChange: () => harness.renderer.setScene(next),
      onContextMenu: menu,
    })
    harness.fire('contextmenu', 50, 15)
    expect(menu).toHaveBeenCalledWith({ kind: 'empty' }, 50, 15, 50, 15)
  })

  it('FR4 a different pin on the same node degrades to the node body', () => {
    const menu = vi.fn()
    const pin = (port: string, y: number) => ({
      portId: port, address: { port }, direction: 'in', x: 0, y,
      type: { kind: 'concrete', name: 'FLOAT' },
    })
    const initial = interactionScene() as any
    initial.nodes[0].layout.pins = [pin('a', 12), pin('b', 30)]
    let harness: ReturnType<typeof interactionHarness>
    let current: Scene
    harness = interactionHarness(initial, {
      onSelectionChange: () => {
        current = structuredClone(initial)
        harness.renderer.setScene(current)
        // The recomputed world point now lands on pin 'b' - same kind, same
        // node, but a DIFFERENT menu target (menus are built per address).
        harness.setViewportOffset(0, 18)
      },
      onContextMenu: menu,
    })
    harness.fire('contextmenu', 10, 22)
    const hit = menu.mock.calls[0]![0]
    expect(hit).toMatchObject({ kind: 'body', node: { id: 'n1' } })
    expect(hit.node).toBe(current!.nodes[0])
  })

  it('FR4 identity encoding cannot collide across address fields', () => {
    const menu = vi.fn()
    const initial = interactionScene() as any
    // These two pins are DIFFERENT document targets, but a naive delimiter
    // join of (port, ...members) would encode both identically. JSON
    // escaping keeps them distinct, so the drifted re-hit must degrade.
    initial.nodes[0].layout.pins = [
      { portId: 'a', address: { port: 'p\u0000m' }, direction: 'in', x: 0, y: 12,
        type: { kind: 'concrete', name: 'FLOAT' } },
      { portId: 'b', address: { port: 'p', members: ['m'] }, direction: 'in', x: 0, y: 30,
        type: { kind: 'concrete', name: 'FLOAT' } },
    ]
    let harness: ReturnType<typeof interactionHarness>
    let current: Scene
    harness = interactionHarness(initial, {
      onSelectionChange: () => {
        current = structuredClone(initial)
        harness.renderer.setScene(current)
        harness.setViewportOffset(0, 18)
      },
      onContextMenu: menu,
    })
    harness.fire('contextmenu', 10, 22)
    const hit = menu.mock.calls[0]![0]
    expect(hit).toMatchObject({ kind: 'body', node: { id: 'n1' } })
    expect(hit.node).toBe(current!.nodes[0])
  })

  it('FR4 recomputes world coordinates when the callback moves the viewport', () => {
    const menu = vi.fn()
    let harness: ReturnType<typeof interactionHarness>
    harness = interactionHarness(interactionScene(), {
      onSelectionChange: () => {
        harness.renderer.setScene(structuredClone(interactionScene()))
        harness.setViewportOffset(100, 200)
      },
      onContextMenu: menu,
    })
    harness.fire('contextmenu', 50, 15)
    expect(menu).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'body', node: expect.objectContaining({ id: 'n1' }) }),
      150, 215, 50, 15,
    )
  })
})

describe('occurrence-owned family pins', () => {
  it('connects the derived region index through the occurrence planner in either drag direction', () => {
    const regionScene = (): Scene => {
      const scene = interactionScene() as any
      scene.occurrence = { owner: { instancePath: [], node: 'region' }, bodyGraph: 'g0' }
      scene.nodes[0].layout.pins = [{
        portId: 'count', address: { port: 'count' }, direction: 'in', y: 22,
        type: { kind: 'concrete', name: 'core.int' },
      }]
      scene.nodes.slice(1).forEach((node: any) => { node.layout.pins = [] })
      scene.reroutes = []
      scene.valueSources = []
      scene.selectors = []
      scene.boundaryNodes = [{
        side: 'inputs', x: -200, y: 10,
        layout: {
          width: 100, height: 44, minWidth: 80, minHeight: 40, headerHeight: 20, title: 'Inputs',
          rows: [{
            kind: 'ports', y: 20, height: 24,
            output: {
              portId: '@region:index', label: 'Index', address: { port: '@region:index' }, index: 0,
              type: { kind: 'concrete', name: 'core.int' }, regionIndex: true,
            },
          }],
          pins: [{
            portId: '@region:index', address: { port: '@region:index' }, direction: 'out', y: 32,
            type: { kind: 'concrete', name: 'core.int' }, regionIndex: true,
          }],
        },
      }]
      return scene
    }
    const expected = {
      kind: 'connect', owner: { instancePath: [], node: 'region' }, bodyGraph: 'g0',
      from: { kind: 'body', endpoint: { node: '$region', port: 'index' } },
      to: { kind: 'body', endpoint: { node: 'n1', port: 'count' } },
    }
    for (const reverse of [false, true]) {
      const intentions: unknown[] = []
      const harness = interactionHarness(regionScene(), {
        dispatchOccurrenceMutation: (intention) => { intentions.push(intention); return { ok: true } },
      })
      const [fromX, toX] = reverse ? [10, -100] : [-100, 10]
      const [fromY, toY] = reverse ? [32, 42] : [42, 32]
      if (!reverse) expect(hitTestBoundaryPin(regionScene(), fromX, 42)).toMatchObject({ regionIndex: true })
      harness.fire('pointerdown', fromX, fromY)
      harness.fire('pointermove', toX, toY)
      harness.fire('pointerup', toX, toY)
      expect(intentions, `reverse=${reverse}`).toEqual([expected])
      expect(harness.dispatched).toEqual([])
      harness.controller.dispose()
    }

    const rename = vi.fn()
    const readonly = interactionHarness(regionScene(), { onBoundaryRenameRequest: rename })
    readonly.fire('dblclick', -100, 42)
    expect(rename).not.toHaveBeenCalled()
    readonly.controller.dispose()
  })

  it('are legal drag origins and drop targets at the command-dispatch seam', () => {
    const scene = interactionScene() as any
    scene.occurrence = { owner: { instancePath: [], node: 'instance' }, bodyGraph: 'g0' }
    scene.valueSources = []
    scene.selectors = []
    scene.reroutes = []
    scene.nodes[0].layout.pins = [{
      portId: 'out', address: { port: 'out' }, direction: 'out', x: 100, y: 22,
      type: { kind: 'concrete', name: 'FLOAT' },
    }]
    scene.nodes[1].layout.pins = [{
      portId: 'owned', address: { port: 'weights.w', members: ['s0'] }, direction: 'in', x: 0, y: 22,
      type: { kind: 'concrete', name: 'FLOAT' },
      familyOwner: {
        graphId: 'root', nodeId: 'instance', construct: 'forwarded', socketed: true,
        occurrence: { instancePath: [], node: 'instance' }, familyPath: 'weights', sourceMember: 's0',
        route: [{ graph: 'g0', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n2', port: 'weights' } }],
        sourceEndpoint: {
          kind: 'boundary', occurrence: { instancePath: [], node: 'instance' },
          address: { port: 'forwarded.w', members: ['s0'] },
          route: [{ graph: 'g0', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n2', port: 'weights' } }],
        },
      },
    }]
    scene.nodes.slice(2).forEach((node: any) => { node.layout.pins = [] })
    const intentions: any[] = []
    const harness = interactionHarness(scene, {
      dispatchOccurrenceMutation: (intention) => { intentions.push(intention); return { ok: true } },
    })

    harness.fire('pointerdown', 200, 32)
    harness.fire('pointermove', 110, 32)
    harness.fire('pointerup', 110, 32)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 32)
    harness.fire('pointerup', 200, 32)

    expect(intentions).toEqual([
      {
        kind: 'connect', owner: { instancePath: [], node: 'instance' }, bodyGraph: 'g0',
        from: { kind: 'body', endpoint: { node: 'n1', port: 'out' } },
        to: {
          kind: 'boundary', occurrence: { instancePath: [], node: 'instance' },
          address: { port: 'forwarded.w', members: ['s0'] },
          route: [{ graph: 'g0', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n2', port: 'weights' } }],
        },
      },
      {
        kind: 'connect', owner: { instancePath: [], node: 'instance' }, bodyGraph: 'g0',
        from: { kind: 'body', endpoint: { node: 'n1', port: 'out' } },
        to: {
          kind: 'boundary', occurrence: { instancePath: [], node: 'instance' },
          address: { port: 'forwarded.w', members: ['s0'] },
          route: [{ graph: 'g0', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n2', port: 'weights' } }],
        },
      },
    ])
    expect(harness.dispatched).toEqual([])
  })
})

describe('node-body link drops', () => {
  const typedScene = (): Scene => {
    const scene = interactionScene() as any
    const type = (name: string) => ({ kind: 'concrete', name })
    scene.reroutes = []
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: type('FLOAT') },
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 38, type: type('FLOAT') },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'first', address: { port: 'first' }, direction: 'in', y: 24, type: type('FLOAT') },
      { portId: 'second', address: { port: 'second' }, direction: 'in', y: 38, type: type('FLOAT') },
      { portId: 'firstOut', address: { port: 'firstOut' }, direction: 'out', y: 24, type: type('FLOAT') },
      { portId: 'secondOut', address: { port: 'secondOut' }, direction: 'out', y: 38, type: type('FLOAT') },
    ]
    return scene
  }

  it.each([
    ['left/input', { x: 110, y: 32 }, { x: 200 + PIN_HIT_RADIUS, y: 41 }],
    ['right/output', { x: 10, y: 48 }, { x: 300 - PIN_HIT_RADIUS, y: 41 }],
  ] as const)('excludes the %s between-socket lane from body autosnap preview and commit', (_side, from, lane) => {
    const harness = interactionHarness(typedScene())
    harness.fire('pointerdown', from.x, from.y)
    harness.fire('pointermove', lane.x, lane.y)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.bodyDropNode).toBeUndefined()
    expect(overlay.ghostLink).toMatchObject({
      ...(from.x > 100 ? { x2: lane.x, y2: lane.y } : { x1: lane.x, y1: lane.y }),
    })
    harness.fire('pointerup', lane.x, lane.y)
    expect(harness.dispatched).toEqual([])
  })

  it.each([
    ['input', 8.9, 8.9, false],
    ['input', PIN_HIT_RADIUS, PIN_HIT_RADIUS + 1 / 65_536, false],
    ['input', 9.1, 9.1, true],
    ['output', 8.9, 8.9, false],
    ['output', PIN_HIT_RADIUS, PIN_HIT_RADIUS + 1 / 65_536, false],
    ['output', 9.1, 9.1, true],
  ] as const)('keeps the %s fractional socket-lane boundary stable at depth %s', (side, depth, quantizedDepth, eligible) => {
    const scene = typedScene() as any
    scene.nodes[1].layout.width = 175.32069396972656
    const viewport = { x: 17.25, y: -11.5, scale: 2 }
    const screen = (world: { x: number; y: number }) => ({
      x: (world.x - viewport.x) * viewport.scale,
      y: (world.y - viewport.y) * viewport.scale,
    })

    const harness = interactionHarness(scene)
    harness.setViewportTransform(viewport.x, viewport.y, viewport.scale)
    const from = screen(side === 'input' ? { x: 110, y: 32 } : { x: 10, y: 48 })
    const localX = side === 'input'
      ? quantizedDepth
      : scene.nodes[1].layout.width - quantizedDepth
    const point = screen({ x: scene.nodes[1].x + localX, y: scene.nodes[1].y + 31 })

    harness.fire('pointerdown', from.x, from.y)
    harness.fire('pointermove', point.x, point.y)
    expect((harness.overlays.at(-1) as any).bodyDropNode, `${side} depth ${depth} preview`).toBe(
      eligible ? 'n2' : undefined,
    )
    harness.fire('pointerup', point.x, point.y)
    expect(harness.dispatched, `${side} depth ${depth} release`).toHaveLength(eligible ? 1 : 0)
  })

  it('keeps true-body preview and commit aligned through a non-identity viewport transform', () => {
    const harness = interactionHarness(typedScene())
    harness.setViewportTransform(20, -10, 2)
    const screen = (world: { x: number; y: number }) => ({ x: (world.x - 20) * 2, y: (world.y + 10) * 2 })
    const from = screen({ x: 110, y: 32 })
    const body = screen({ x: 250, y: 35 })
    harness.fire('pointerdown', from.x, from.y)
    harness.fire('pointermove', body.x, body.y)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.bodyDropNode).toBe('n2')
    expect(overlay.ghostLink).toMatchObject({ x2: 200, y2: 34 })
    expect([...overlay.dropTargets]).toEqual(['n2:first:in'])
    harness.fire('pointerup', body.x, body.y)
    expect(harness.dispatched.at(-1)).toMatchObject({
      command: 'link.connect', params: { to: { node: 'n2', port: 'first' } },
    })
  })

  it.each([
    ['inside edge', 200, 20],
    ['proxy overhang', 197, 20],
    ['compact body', 250, 45],
  ] as const)('keeps the expanded compatible body-drop targets at the minimized %s', (_surface, x, y) => {
    const scene = typedScene() as any
    scene.nodes[1].layout = {
      ...scene.nodes[1].layout,
      height: 60,
      rows: [],
      minimized: true,
      pins: scene.nodes[1].layout.pins.map((pin: any) => ({
        ...pin,
        y: scene.nodes[1].layout.headerHeight / 2,
        minimized: true,
      })),
    }
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', x, y)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.bodyDropNode).toBe('n2')
    expect([...overlay.dropTargets]).toEqual(['n2:first:in'])
    harness.fire('pointerup', x, y)
    expect(harness.dispatched.at(-1)).toMatchObject({
      command: 'link.connect', params: { to: { node: 'n2', port: 'first' } },
    })
  })

  it('derives the lane only from currently revealed real pins', () => {
    const scene = typedScene() as any
    scene.nodes[1].layout.height = 100
    scene.nodes[1].layout.pins = [
      { portId: 'first', address: { port: 'first' }, direction: 'in', y: 24, type: { kind: 'concrete', name: 'FLOAT' } },
      {
        portId: 'hiddenWidget', address: { port: 'hiddenWidget' }, direction: 'in', y: 70,
        type: { kind: 'concrete', name: 'IMAGE' }, widgetBacked: true,
      },
    ]
    const laneDepthPoint = { x: 200 + PIN_HIT_RADIUS, y: 75 }

    const hidden = interactionHarness(structuredClone(scene))
    hidden.fire('pointerdown', 110, 32)
    hidden.fire('pointermove', laneDepthPoint.x, laneDepthPoint.y)
    expect((hidden.overlays.at(-1) as any).bodyDropNode).toBe('n2')

    const revealed = interactionHarness(scene)
    revealed.controller.setSelection(['n2'])
    revealed.fire('pointerdown', 110, 32)
    revealed.fire('pointermove', laneDepthPoint.x, laneDepthPoint.y)
    expect((revealed.overlays.at(-1) as any).bodyDropNode).toBeUndefined()
  })

  it('recomputes lane geometry and the ranked candidate after a same-id layout replacement', () => {
    const harness = interactionHarness(typedScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 250, 35)
    expect((harness.overlays.at(-1) as any).ghostLink).toMatchObject({ x2: 200, y2: 34 })

    const replacement = structuredClone(typedScene()) as any
    replacement.nodes[1].layout.height = 100
    replacement.nodes[1].layout.pins = replacement.nodes[1].layout.pins.map((pin: any) => ({ ...pin, y: pin.y + 36 }))
    harness.swapScene(replacement)

    // This point occupied the old between-socket lane, but is ordinary body
    // under the replacement layout. Both eligibility and the cached ranking
    // must follow the replacement SceneNode rather than its surviving id.
    harness.fire('pointermove', 200 + PIN_HIT_RADIUS, 41)
    expect((harness.overlays.at(-1) as any)).toMatchObject({
      bodyDropNode: 'n2',
      ghostLink: { x2: 200, y2: 70 },
    })

    harness.fire('pointermove', 200 + PIN_HIT_RADIUS, 77)
    expect((harness.overlays.at(-1) as any).bodyDropNode).toBeUndefined()
    harness.fire('pointerup', 200 + PIN_HIT_RADIUS, 77)
    expect(harness.dispatched).toEqual([])
  })

  it('uses declared order among free slots, but ranks a free slot before an occupied one', () => {
    const scene = typedScene() as any
    scene.links = [{
      id: 'old', from: { kind: 'port', node: 'other', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'first' }, x1: 0, y1: 0, x2: 0, y2: 0,
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 250, 35)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.ghostLink).toMatchObject({ x2: 200, y2: 48 })
    expect([...overlay.dropTargets]).toEqual(['n2:second:in'])
    harness.fire('pointerup', 250, 35)
    expect(harness.dispatched.at(-1)).toMatchObject({
      command: 'link.connect', params: { to: { node: 'n2', port: 'second' } },
    })
  })

  it('iterates past an early structurally incompatible slot', () => {
    const scene = typedScene() as any
    scene.nodes[1].layout.pins[0].type = { kind: 'concrete', name: 'IMAGE' }
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 250, 35)
    harness.fire('pointerup', 250, 35)
    expect(harness.dispatched.at(-1)).toMatchObject({
      command: 'link.connect', params: { to: { node: 'n2', port: 'second' } },
    })
  })

  it('gives an explicitly hovered pin priority over the body-ranked slot', () => {
    const harness = interactionHarness(typedScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 48)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.ghostLink).toMatchObject({ x2: 200, y2: 48 })
    expect([...overlay.dropTargets]).toEqual(['n2:second:in'])
  })

  it('leaves the ghost at the pointer and cancels when the body has no candidate', () => {
    const scene = typedScene() as any
    scene.nodes[1].layout.pins.forEach((pin: any) => { pin.type = { kind: 'concrete', name: 'IMAGE' } })
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 250, 35)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.ghostLink).toMatchObject({ x2: 250, y2: 35 })
    expect(overlay.bodyDropNode).toBeUndefined()
    harness.fire('pointerup', 250, 35)
    expect(harness.dispatched).toEqual([])
  })
})

describe('core.combo link gesture regressions', () => {
  const STRING = { kind: 'concrete', name: 'core.string' }
  const COMBO = { kind: 'concrete', name: 'core.combo' }
  const comboScene = (): Scene => {
    const scene = interactionScene() as any
    scene.reroutes = []
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: STRING },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'mode', address: { port: 'mode' }, direction: 'in', y: 24, type: COMBO },
      { portId: 'text', address: { port: 'text' }, direction: 'in', y: 38, type: STRING },
    ]
    return scene
  }
  const lastTargets = (harness: ReturnType<typeof interactionHarness>): string[] =>
    [...(((harness.overlays.at(-1) as any).dropTargets ?? new Set()) as Set<string>)].sort()

  it('string output drag excludes combo inputs from dropTargets', () => {
    const harness = interactionHarness(comboScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 150, 40)
    expect(lastTargets(harness)).toEqual(['n2:text:in'])
  })

  it('string output pointer-up over combo input does not connect', () => {
    const harness = interactionHarness(comboScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 34)
    harness.fire('pointerup', 200, 34)
    expect(harness.dispatched).toEqual([])
  })

  it('combo output drag excludes string inputs and pointer-up does not connect', () => {
    const scene = comboScene() as any
    scene.nodes[0].layout.pins[0].type = COMBO
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 150, 40)
    expect(lastTargets(harness)).toEqual(['n2:mode:in'])
    harness.fire('pointermove', 200, 48)
    harness.fire('pointerup', 200, 48)
    expect(harness.dispatched).toEqual([])
  })

  it('combo-to-combo with differing choice lists connects', () => {
    const scene = comboScene() as any
    scene.nodes[0].layout.pins[0].type = COMBO
    scene.nodes[0].layout.rows = [{ kind: 'widget', spec: { widgetType: 'COMBO', options: { options: ['red'] } } }]
    scene.nodes[1].layout.rows = [{ kind: 'widget', spec: { widgetType: 'COMBO', options: { options: ['blue'] } } }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 34)
    harness.fire('pointerup', 200, 34)
    expect(harness.dispatched).toContainEqual(expect.objectContaining({ command: 'link.connect' }))
  })
})

describe('modifier parity across link endpoint kinds', () => {
  const FLOAT = { kind: 'concrete', name: 'FLOAT' } as const

  const tapBoundaryScene = (connected: boolean): Scene => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'amount', address: { port: 'amount' }, direction: 'out', y: 22, type: FLOAT, widgetTap: true },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.boundaryNodes = [{
      side: 'outputs', x: 300, y: 10,
      layout: {
        width: 140, height: 80, headerHeight: 20, rows: [], title: 'Outputs',
        pins: [
          { portId: 'result', address: { port: 'result' }, direction: 'in', y: 22, type: FLOAT },
          { portId: BOUNDARY_ADD_SLOT, address: { port: BOUNDARY_ADD_SLOT }, direction: 'in', y: 45, type: FLOAT },
        ],
      },
    }]
    scene.links = connected ? [{
      id: 'tap-link', from: { kind: 'widgetTap', node: 'n1', input: 'amount' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }] : []
    return scene
  }

  const tapBoundaryExposureCases = [
    { name: 'fresh tap drag', connected: false, startX: 110, altKey: false },
    { name: 'Alt fan-out from a tap link', connected: true, startX: 200, altKey: true },
  ].flatMap((gesture) => [
    { ...gesture, surface: 'existing pin', dropX: 300, dropY: 32, itemId: 'result' },
    { ...gesture, surface: 'add pin', dropX: 300, dropY: 55, itemId: undefined },
    { ...gesture, surface: 'panel body', dropX: 350, dropY: 75, itemId: 'result' },
    { ...gesture, surface: 'panel header', dropX: 350, dropY: 15, itemId: 'result' },
  ])

  it.each([
    { kind: 'valueSource' as const, id: 'v1', start: { x: 580, y: 115 } },
    { kind: 'selector' as const, id: 's1', start: { x: 700, y: 110 } },
    { kind: 'reroute' as const, id: 'r1', start: { x: 400 + REROUTE_SOCKET_OFFSET, y: 100 }, hover: { x: 400, y: 100 } },
  ])('refuses a $kind as a direct boundary output producer', ({ kind, id, start, hover }) => {
    const scene: Scene = {
      ...interactionScene(),
      boundaryNodes: [{
        side: 'outputs', x: 800, y: 100,
        layout: {
          width: 140, height: 80, minWidth: 80, minHeight: 40, headerHeight: 20, rows: [], title: 'Outputs',
          pins: [{ portId: BOUNDARY_ADD_SLOT, address: { port: BOUNDARY_ADD_SLOT }, direction: 'in', y: 45, type: FLOAT }],
        },
      }],
    }
    const refused = vi.fn()
    const harness = interactionHarness(scene, { onBoundaryExposureRefused: refused })
    if (hover) harness.fire('pointermove', hover.x, hover.y)
    harness.fire('pointerdown', start.x, start.y)
    harness.fire('pointermove', 850, 150)
    harness.fire('pointerup', 850, 150)

    expect(harness.dispatched).toEqual([])
    expect(refused).toHaveBeenCalledWith(
      'boundary.structuralProducerUnsupported',
      { kind, id },
      'outputs',
    )
  })

  it.each(tapBoundaryExposureCases)('$name exposes the exact widget tap on the $surface', ({
    connected, startX, altKey, dropX, dropY, itemId,
  }) => {
    const refused = vi.fn()
    const harness = interactionHarness(tapBoundaryScene(connected), { onBoundaryExposureRefused: refused })
    harness.fire('pointermove', 50, 30)
    harness.fire('pointerdown', startX, 32, { altKey })
    harness.fire('pointermove', dropX, dropY, { altKey })
    harness.fire('pointerup', dropX, dropY, { altKey })

    expect(harness.dispatched).toEqual([{
      command: itemId === undefined ? 'boundary.addItem' : 'boundary.setBinding',
      params: {
        graphId: 'g0', side: 'outputs',
        ...(itemId === undefined ? {} : { itemId }),
        node: 'n1', tap: 'amount',
      },
    }])
    expect(refused).not.toHaveBeenCalled()
  })

  it('drags an output boundary item onto a widget tap and unbinds it from empty canvas', () => {
    const scene: Scene = {
      ...tapBoundaryScene(false),
      links: [{
        id: 'boundary:outputs:result', boundary: true,
        from: { kind: 'widgetTap', node: 'n1', input: 'amount' },
        to: { kind: 'boundary', side: 'outputs', item: 'result' },
        x1: 110, y1: 32, x2: 300, y2: 32, typeName: 'FLOAT',
      }],
    }

    const bind = interactionHarness(scene)
    bind.fire('pointerdown', 300, 32)
    bind.fire('pointermove', 110, 32)
    bind.fire('pointerup', 110, 32)
    expect(bind.dispatched).toEqual([{
      command: 'boundary.setBinding',
      params: { graphId: 'g0', side: 'outputs', itemId: 'result', node: 'n1', tap: 'amount' },
    }])

    const unbind = interactionHarness(scene)
    unbind.fire('pointerdown', 300, 32)
    unbind.fire('pointermove', 700, 300)
    unbind.fire('pointerup', 700, 300)
    expect(unbind.dispatched).toEqual([{
      command: 'boundary.unbind',
      params: { graphId: 'g0', side: 'outputs', itemId: 'result', node: 'n1', tap: 'amount' },
    }])
  })

  it('Shift-grabbing a connected widget tap re-sources its whole fan-out', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'amount', address: { port: 'amount' }, direction: 'out', y: 22, type: FLOAT, widgetTap: true },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.nodes.push({
      id: 'n3', x: 390, y: 10, node: { id: 'n3', type: 'Numeric', values: {} },
      layout: {
        width: 100, height: 44, headerHeight: 20, rows: [], title: 'n3',
        pins: [{ portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT }],
      },
    })
    scene.links = [{
      id: 'tap-link', from: { kind: 'widgetTap', node: 'n1', input: 'amount' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointermove', 50, 30)
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 490, 32, { shiftKey: true })
    harness.fire('pointerup', 490, 32, { shiftKey: true })
    expect(harness.dispatched).toEqual([{
      command: 'link.rewireSource',
      params: { graphId: 'g0', linkIds: ['tap-link'], from: { node: 'n3', port: 'out' } },
    }])
  })

  it('Shift-moving a connected widget tap onto empty canvas disconnects it', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'amount', address: { port: 'amount' }, direction: 'out', y: 22, type: FLOAT, widgetTap: true },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.links = [{
      id: 'tap-link', from: { kind: 'widgetTap', node: 'n1', input: 'amount' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointermove', 50, 30)
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'tap-link' } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it('Shift-moving an output fan-out onto empty canvas disconnects every link in one batch', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.nodes.push({
      id: 'n3', x: 390, y: 10, node: { id: 'n3', type: 'Numeric', values: {} },
      layout: {
        width: 100, height: 44, headerHeight: 20, rows: [], title: 'n3',
        pins: [{ portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT }],
      },
    })
    scene.links = [{
      id: 'first', from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }, {
      id: 'second', from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n3', port: 'in' }, x1: 110, y1: 32, x2: 390, y2: 32,
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'first' } },
        { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'second' } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n3' } },
      ] },
    }])
  })

  it('Shift-moving an all-definition fan-out stays on definition commands while drilled', () => {
    const scene = interactionScene() as any
    scene.occurrence = { owner: { instancePath: [], node: 'instance' }, bodyGraph: 'g0' }
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.links = [{
      id: 'first', from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }]
    const intentions: unknown[] = []
    const harness = interactionHarness(scene, {
      dispatchOccurrenceMutation: (intention: unknown) => { intentions.push(intention); return { ok: true } },
    })
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(intentions).toEqual([])
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'first' } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it('Shift-moving a fan-out mixing definition and occurrence links refuses while drilled', () => {
    const scene = interactionScene() as any
    scene.occurrence = { owner: { instancePath: [], node: 'instance' }, bodyGraph: 'g0' }
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.links = [{
      id: 'first', from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }, {
      id: '@effective:{"kind":"occurrence"}', from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
      effectiveIdentity: { kind: 'occurrence', owner: { instancePath: [], node: 'instance' }, linkId: 'local' },
    }]
    const intentions: unknown[] = []
    const harness = interactionHarness(scene, {
      dispatchOccurrenceMutation: (intention: unknown) => { intentions.push(intention); return { ok: true } },
    })
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(intentions).toEqual([])
    expect(harness.dispatched).toEqual([])
  })

  for (const terminalEvent of ['pointercancel', 'lostpointercapture'] as const) {
    it(`${terminalEvent} during a Shift move-source gesture preserves the grabbed link`, () => {
      const scene = interactionScene() as any
      scene.valueSources = []
      scene.selectors = []
      scene.nodes[0].layout.pins = [
        { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
      ]
      scene.nodes[1].layout.pins = [
        { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
      ]
      scene.links = [{
        id: 'moved', from: { kind: 'port', node: 'n1', port: 'out' },
        to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
      }]
      const harness = interactionHarness(scene)
      harness.fire('pointerdown', 110, 32, { shiftKey: true })
      harness.fire('pointermove', 700, 300, { shiftKey: true })
      harness.fire(terminalEvent, 0, 0, { pointerId: 1, pointerType: 'mouse' })
      expect(harness.dispatched).toEqual([])
      expect(harness.overlays.at(-1)).not.toHaveProperty('ghostLink')
    })
  }

  it('Shift-grabbing a reroute output socket re-sources its whole fan-out', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.links = [{
      id: 'reroute-link', from: { kind: 'reroute', reroute: 'r1' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 400, y1: 100, x2: 200, y2: 32,
    }]
    const socketX = 400 + REROUTE_SOCKET_OFFSET
    const harness = interactionHarness(scene)
    harness.fire('pointermove', socketX, 100)
    harness.fire('pointerdown', socketX, 100, { shiftKey: true })
    harness.fire('pointermove', 110, 32, { shiftKey: true })
    harness.fire('pointerup', 110, 32, { shiftKey: true })
    expect(harness.dispatched).toEqual([{
      command: 'link.rewireSource',
      params: { graphId: 'g0', linkIds: ['reroute-link'], from: { node: 'n1', port: 'out' } },
    }])
  })

  it('Shift-grabbing a driven reroute input preserves its driver on an empty drop', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.links = [{
      id: 'driver', from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'reroute', reroute: 'r1' }, x1: 110, y1: 32, x2: 400, y2: 100,
    }]
    const palette = vi.fn()
    const socketX = 400 - REROUTE_SOCKET_OFFSET
    const harness = interactionHarness(scene, { onLinkDropOnEmpty: palette })
    harness.fire('pointermove', socketX, 100)
    harness.fire('pointerdown', socketX, 100, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(harness.dispatched).toEqual([])
    expect(palette).not.toHaveBeenCalled()
  })

  it('Shift-grabbing a bound Outputs pseudo-input preserves its binding on an empty drop', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.boundaryNodes = [{
      side: 'outputs', x: 300, y: 100,
      layout: {
        width: 140, height: 60, headerHeight: 20, rows: [], title: 'Outputs',
        pins: [{ portId: 'result', address: { port: 'result' }, direction: 'in', y: 30, type: FLOAT }],
      },
    }]
    scene.links = [{
      id: 'boundary:outputs:result', boundary: true,
      from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'boundary', side: 'outputs', item: 'result' },
      x1: 110, y1: 32, x2: 300, y2: 130,
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 300, 130, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(harness.dispatched).toEqual([])
  })

  it('Shift replaces a boundary-driven real input atomically and preserves it on cancellation', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.links = [{
      id: 'boundary:inputs:value', boundary: true,
      from: { kind: 'boundary', side: 'inputs', item: 'value' },
      to: { kind: 'port', node: 'n2', port: 'in' },
      x1: 0, y1: 32, x2: 200, y2: 32,
    }]

    const cancelled = interactionHarness(scene)
    cancelled.fire('pointerdown', 200, 32, { shiftKey: true })
    cancelled.fire('pointermove', 700, 300, { shiftKey: true })
    cancelled.fire('pointerup', 700, 300, { shiftKey: true })
    expect(cancelled.dispatched).toEqual([])

    const replaced = interactionHarness(scene)
    replaced.fire('pointerdown', 200, 32, { shiftKey: true })
    replaced.fire('pointermove', 110, 32, { shiftKey: true })
    replaced.fire('pointerup', 110, 32, { shiftKey: true })
    expect(replaced.dispatched).toEqual([{
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'boundary.unbind',
            params: { graphId: 'g0', side: 'inputs', itemId: 'value', node: 'n2', port: 'in' },
          },
          {
            command: 'link.connect',
            params: { graphId: 'g0', from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } },
          },
        ],
      },
    }])
  })

  it('unbinds and compacts a boundary-driven destination in one batch', () => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[1].layout.pins = [
      {
        portId: portEndKey({ port: 'pairs.image', members: ['m0'] as any }),
        address: { port: 'pairs.image', members: ['m0'] }, direction: 'in', y: 22, type: FLOAT,
      },
    ]
    scene.links = [{
      id: 'boundary:inputs:value', boundary: true,
      from: { kind: 'boundary', side: 'inputs', item: 'value' },
      to: { kind: 'port', node: 'n2', port: 'pairs.image', members: ['m0'] },
      x1: 0, y1: 32, x2: 200, y2: 32,
    }]

    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 200, 32)
    harness.fire('pointermove', 700, 300)
    harness.fire('pointerup', 700, 300)
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        {
          command: 'boundary.unbind',
          params: {
            graphId: 'g0', side: 'inputs', itemId: 'value',
            node: 'n2', port: 'pairs.image', members: ['m0'],
          },
        },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })
})

describe('heterogeneous selection movement', () => {
  it('moves selected nodes, reroutes, value sources, and selectors in one selection.move command', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.setSelection(['n1', 'n2'], [], ['r1'], ['v1'], ['s1'])
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: { n1: { x: 20, y: 20 }, n2: { x: 210, y: 20 } },
        reroutes: { r1: { x: 410, y: 110 } },
        valueSources: { v1: { x: 510, y: 110 } },
        selectors: { s1: { x: 610, y: 110 } },
      },
    }])
  })

  it('dragging an unselected node moves only that node', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.setSelection(['n2'], [], ['r1'], ['v1'], ['s1'])
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([{
      command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 20, y: 20 } } },
    }])
  })

  it('keeps overview node interiors draggable instead of activating omitted rows or resize handles', () => {
    const harness = interactionHarness(interactionScene())
    harness.setViewportTransform(0, 0, 0.1)
    harness.fire('pointerdown', 6, 4.2)
    harness.fire('pointermove', 16, 14.2)
    harness.fire('pointerup', 16, 14.2)
    expect(harness.dispatched).toEqual([{
      command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 110, y: 110 } } },
    }])
  })

  it('moves selected groups and their explicitly selected contents once', () => {
    const scene = interactionScene() as any
    scene.groups = [{ id: 'grp0', title: 'mixed', x: 0, y: 0, width: 350, height: 80 }]
    const harness = interactionHarness(scene)
    harness.controller.setSelection(['n1', 'n2'], [], [], [], [], ['grp0'])

    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    harness.fire('pointerup', 40, 25)

    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: { n1: { x: 20, y: 20 }, n2: { x: 210, y: 20 } },
        groups: { grp0: { x: 10, y: 10 } },
      },
    }])
  })

  it('moves a groups-only multi-selection through selection.move', () => {
    const scene = interactionScene() as any
    scene.groups = [
      { id: 'grp0', title: 'one', x: 0, y: 300, width: 200, height: 100 },
      { id: 'grp1', title: 'two', x: 300, y: 300, width: 200, height: 100 },
    ]
    const harness = interactionHarness(scene)
    harness.controller.setSelection([], [], [], [], [], ['grp0', 'grp1'])

    harness.fire('pointerdown', 50, 310)
    harness.fire('pointermove', 60, 320)
    harness.fire('pointerup', 60, 320)

    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: {},
        groups: { grp0: { x: 10, y: 310 }, grp1: { x: 310, y: 310 } },
      },
    }])
  })

  it('drags a Select All selection from a reroute as one heterogeneous move', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.selectAll()

    harness.fire('pointerdown', 400, 100)
    harness.fire('pointermove', 410, 110)
    harness.fire('pointerup', 410, 110)

    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: { n1: { x: 20, y: 20 }, n2: { x: 210, y: 20 } },
        reroutes: { r1: { x: 410, y: 110 } },
        valueSources: { v1: { x: 510, y: 110 } },
        selectors: { s1: { x: 610, y: 110 } },
      },
    }])
  })

  it('drags a non-node mixed selection from a reroute', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.setSelection([], [], ['r1'], ['v1'], ['s1'])

    harness.fire('pointerdown', 400, 100)
    harness.fire('pointermove', 410, 110)
    harness.fire('pointerup', 410, 110)

    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: {},
        reroutes: { r1: { x: 410, y: 110 } },
        valueSources: { v1: { x: 510, y: 110 } },
        selectors: { s1: { x: 610, y: 110 } },
      },
    }])
  })

  it('keeps value-source click activation for a heterogeneous selection', () => {
    const activate = vi.fn()
    const harness = interactionHarness(interactionScene(), { onValueSourceActivate: activate })
    harness.controller.setSelection(['n1'], [], [], ['v1'])

    harness.fire('pointerdown', 520, 110)
    harness.fire('pointerup', 520, 110)

    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }), 520, 110)
    expect(harness.dispatched).toEqual([])
  })

  it('cancels an active gesture when selection ownership changes between tabs', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.setSelectionOwner('tab-a:g0')
    harness.controller.setSelection(['n1'])
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)

    harness.controller.setSelectionOwner('tab-b:g0')
    harness.fire('pointerup', 40, 25)

    expect(harness.dispatched).toEqual([])
    expect(harness.controller.getSelection()).toEqual(new Set())
  })

  it('moves a boundary pseudo-node alone with view.moveBoundaryNode', () => {
    const scene = interactionScene() as any
    scene.boundaryNodes = [{
      side: 'inputs', x: 300, y: 20,
      layout: { width: 100, height: 100, headerHeight: 24, pins: [], rows: [], title: 'Inputs' },
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 320, 30)
    harness.fire('pointermove', 330, 40)
    harness.fire('pointerup', 330, 40)
    expect(harness.dispatched).toEqual([{
      command: 'view.moveBoundaryNode',
      params: { graphId: 'g0', side: 'inputs', position: { x: 310, y: 30 } },
    }])
  })
})

describe('gesture ownership and cancellation', () => {
  const beginNodeDrag = (harness: ReturnType<typeof interactionHarness>) => {
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
  }

  const linkDropScene = (): Scene => {
    const scene = interactionScene() as any
    const type = { kind: 'concrete', name: 'FLOAT' }
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 24, type },
    ]
    return scene
  }

  const connectedLinkScene = (): Scene => {
    const scene = linkDropScene() as any
    scene.links = [{
      id: 'l1',
      from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'in' },
      x1: 110, y1: 32, x2: 200, y2: 34,
    }]
    return scene
  }

  it('publishes every SE resize preview without dispatching, then commits one rounded command', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 110, 54)
    harness.fire('pointermove', 120.2, 64.3)
    harness.fire('pointermove', 130.4, 74.6)

    const previews = harness.overlays
      .map((overlay: any) => overlay.resizePreview)
      .filter((preview) => preview !== undefined)
    expect(previews).toEqual([
      { nodeId: 'n1', x: 10, y: 10, width: 110.2, height: 54.3 },
      { nodeId: 'n1', x: 10, y: 10, width: 120.4, height: 64.6 },
    ])
    expect(harness.dispatched).toEqual([])

    harness.fire('pointerup', 130.4, 74.6)
    expect(harness.dispatched).toEqual([{
      command: 'view.setNodeSize',
      params: {
        graphId: 'g0', nodeId: 'n1',
        size: { width: 120, height: 65 },
        position: { x: 10, y: 10 },
      },
    }])
    expect(harness.overlays.at(-1)).not.toHaveProperty('resizePreview')
  })

  it('removes transient preview expansion from a committed node height', () => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.resizeHeightOffset = 20
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 54)
    harness.fire('pointermove', 120, 64)
    harness.fire('pointerup', 120, 64)
    expect(harness.dispatched).toEqual([{
      command: 'view.setNodeSize',
      params: {
        graphId: 'g0', nodeId: 'n1',
        size: { width: 110, height: 34 },
        position: { x: 10, y: 10 },
      },
    }])
  })

  it('preserves the visible north edge when compact layout maps to an expanded height', () => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.resizeHeightOffset = -20
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 10, 10)
    harness.fire('pointermove', 0, 0)
    harness.fire('pointerup', 0, 0)
    expect(harness.dispatched).toEqual([{
      command: 'view.setNodeSize',
      params: {
        graphId: 'g0', nodeId: 'n1',
        size: { width: 110, height: 74 },
        position: { x: 0, y: 0 },
      },
    }])
  })

  it('commits one anchored rounded NW resize and cancel dispatches nothing', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 10, 10)
    harness.fire('pointermove', -5.6, -6.4)
    expect(harness.dispatched).toEqual([])
    harness.fire('pointerup', -5.6, -6.4)
    expect(harness.dispatched).toEqual([{
      command: 'view.setNodeSize',
      params: {
        graphId: 'g0', nodeId: 'n1',
        size: { width: 116, height: 60 },
        position: { x: -6, y: -6 },
      },
    }])

    const cancelled = interactionHarness(interactionScene())
    cancelled.fire('pointerdown', 110, 54)
    cancelled.fire('pointermove', 125, 69)
    cancelled.fire('pointercancel', 125, 69, { pointerType: 'touch' })
    expect(cancelled.dispatched).toEqual([])
    expect(cancelled.overlays.at(-1)).not.toHaveProperty('resizePreview')
  })

  const boundOutputScene = (): Scene => {
    const scene = linkDropScene() as any
    scene.boundaryNodes = [{
      side: 'outputs', x: 300, y: 100,
      layout: {
        width: 140, height: 60, headerHeight: 20, rows: [], title: 'Outputs',
        pins: [{ portId: 'result', address: { port: 'result' }, direction: 'in', y: 30, type: { kind: 'concrete', name: 'FLOAT' } }],
      },
    }]
    scene.links = [{
      id: 'boundary:outputs:result', boundary: true,
      from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'boundary', side: 'outputs', item: 'result' },
      x1: 110, y1: 32, x2: 300, y2: 130,
    }]
    return scene
  }

  const differentGraph = (): Scene => ({ ...interactionScene(), graphId: 'g1' })

  it('rewires away and compacts the old destination in one batch', () => {
    const scene = connectedLinkScene() as any
    const type = { kind: 'concrete', name: 'FLOAT' }
    scene.nodes.push({
      id: 'n3', x: 400, y: 10, node: { id: 'n3', type: 'Numeric', values: {} },
      layout: {
        width: 100, height: 44, headerHeight: 20, rows: [], title: 'n3',
        pins: [{ portId: 'in', address: { port: 'in' }, direction: 'in', y: 24, type }],
      },
    })
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 200, 34)
    harness.fire('pointermove', 400, 34)
    harness.fire('pointerup', 400, 34)
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.rewire', params: { graphId: 'g0', linkId: 'l1', to: { node: 'n3', port: 'in' } } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it.each([
    ['inside edge', 400],
    ['proxy overhang', 397],
  ] as const)('rewires onto a minimized input at the %s without disconnecting', (_surface, x) => {
    const scene = connectedLinkScene() as any
    const type = { kind: 'concrete', name: 'FLOAT' }
    scene.nodes.push({
      id: 'n3', x: 400, y: 10, node: { id: 'n3', type: 'Numeric', values: {} },
      layout: {
        width: 100, height: 44, minWidth: 80, minHeight: 44, headerHeight: 20,
        rows: [], title: 'n3', minimized: true,
        pins: [{
          portId: 'in', address: { port: 'in' }, direction: 'in', y: 10, type, minimized: true,
        }],
      },
    })
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 200, 34)
    harness.fire('pointermove', x, 20)
    harness.fire('pointerup', x, 20)
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.rewire', params: { graphId: 'g0', linkId: 'l1', to: { node: 'n3', port: 'in' } } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it('keeps a node drag owned by its first pointer', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { pointerId: 1 })
    harness.fire('pointerdown', 210, 15, { pointerId: 2 })
    harness.fire('pointermove', 80, 65, { pointerId: 2 })
    harness.fire('pointerup', 80, 65, { pointerId: 2 })
    expect(harness.dispatched).toEqual([])
    expect(harness.setPointerCapture).toHaveBeenCalledTimes(1)
    harness.fire('pointermove', 40, 25, { pointerId: 1 })
    harness.fire('pointerup', 40, 25, { pointerId: 1 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 20, y: 20 } } } },
    ])
  })

  it('cancels a node drag on Escape and clears its overlay', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fireWindow('keydown', { code: 'Escape' })
    expect(harness.overlays.at(-1)).not.toHaveProperty('dragOffsets')
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([])
  })

  it('cancels a node drag on window blur and clears its overlay', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fireWindow('blur')
    expect(harness.overlays.at(-1)).not.toHaveProperty('dragOffsets')
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([])
  })

  it('cancels only when pointercancel belongs to the owning pointer', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fire('pointercancel', 40, 25, { pointerId: 2 })
    harness.fire('pointerup', 40, 25, { pointerId: 1 })
    expect(harness.dispatched).toHaveLength(1)

    const cancelled = interactionHarness(interactionScene())
    beginNodeDrag(cancelled)
    cancelled.fire('pointercancel', 40, 25, { pointerId: 1, pointerType: 'touch' })
    cancelled.fire('pointerup', 40, 25, { pointerId: 1 })
    expect(cancelled.dispatched).toEqual([])
  })

  it('a moved node drag whose capture is lost commits from the last pointer position (RG-1)', () => {
    // macOS trackpads can revoke pointer capture at release without ever
    // delivering the pointerup: the drag must complete where the user last
    // saw it, not snap back. The event carries no useful coordinates - the
    // commit position is the last TRACKED move.
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 20, y: 20 } } } },
    ])
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toHaveLength(1)
  })

  it('capture loss after a viewport change commits the last RENDERED position, not a reprojection (RG-1)', () => {
    // The viewport can move between the last pointermove and the capture
    // loss (wheel zoom, camera animation). The drag ghost stayed at the
    // world position of the last move, so completion must use that world
    // point - reprojecting the stale screen point through the NEW viewport
    // would commit somewhere the ghost never was.
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness) // last move at screen (40,25) -> world (40,25)
    harness.setViewportOffset(100, 100)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 20, y: 20 } } } },
    ])
  })

  it('a moved resize whose capture is lost commits from the last pointer position (RG-1)', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 110, 54) // n1 SE corner handle
    harness.fire('pointermove', 120, 64)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    expect(harness.dispatched).toEqual([
      expect.objectContaining({
        command: 'view.setNodeSize',
        params: expect.objectContaining({ graphId: 'g0', nodeId: 'n1' }),
      }),
    ])
  })

  it('commits a link over its valid last position on capture loss exactly once', () => {
    const harness = interactionHarness(linkDropScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 34)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    expect(harness.dispatched).toEqual([{
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } },
    }])
    harness.fire('pointerup', 200, 34)
    expect(harness.dispatched).toHaveLength(1)
  })

  it('cancels a link on capture loss when its last position is not a valid target', () => {
    const onLinkDropOnEmpty = vi.fn()
    const harness = interactionHarness(linkDropScene(), { onLinkDropOnEmpty })
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 700, 300)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    expect(harness.dispatched).toEqual([])
    expect(onLinkDropOnEmpty).not.toHaveBeenCalled()
  })

  it('touch pointercancel commits a link over its valid last position', () => {
    const harness = interactionHarness(linkDropScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 34)
    harness.fire('pointercancel', 0, 0, { pointerId: 1, pointerType: 'touch' })
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.dispatched[0]).toMatchObject({ command: 'link.connect' })
  })

  it('touch pointercancel cleanly cancels a link away from a valid target', () => {
    const onLinkDropOnEmpty = vi.fn()
    const harness = interactionHarness(linkDropScene(), { onLinkDropOnEmpty })
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 700, 300)
    harness.fire('pointercancel', 0, 0, { pointerId: 1, pointerType: 'touch' })
    expect(harness.dispatched).toEqual([])
    expect(onLinkDropOnEmpty).not.toHaveBeenCalled()
    expect(harness.overlays.at(-1)).not.toHaveProperty('ghostLink')
  })

  for (const terminalEvent of ['pointercancel', 'lostpointercapture'] as const) {
    it(`${terminalEvent} away from a target does not disconnect an ordinary rewire`, () => {
      const control = interactionHarness(connectedLinkScene())
      control.fire('pointerdown', 200, 34)
      control.fire('pointermove', 700, 300)
      control.fire('pointerup', 700, 300)
      expect(control.dispatched).toEqual([{
        command: 'batch',
        params: { invocations: [
          { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l1' } },
          { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
        ] },
      }])

      const harness = interactionHarness(connectedLinkScene())
      harness.fire('pointerdown', 200, 34)
      harness.fire('pointermove', 700, 300)
      harness.fire(terminalEvent, 0, 0, { pointerType: 'touch' })
      expect(harness.dispatched).toEqual([])
    })

    it(`${terminalEvent} away from a target does not unbind an exposed output`, () => {
      const control = interactionHarness(boundOutputScene())
      control.fire('pointerdown', 300, 130)
      control.fire('pointermove', 700, 300)
      control.fire('pointerup', 700, 300)
      expect(control.dispatched).toEqual([expect.objectContaining({
        command: 'boundary.unbind',
      })])

      const harness = interactionHarness(boundOutputScene())
      harness.fire('pointerdown', 300, 130)
      harness.fire('pointermove', 700, 300)
      harness.fire(terminalEvent, 0, 0, { pointerType: 'touch' })
      expect(harness.dispatched).toEqual([])
    })
  }

  it('continues a link drag through window events when pointer capture throws', () => {
    const harness = interactionHarness(linkDropScene())
    harness.setPointerCapture.mockImplementationOnce(() => { throw new Error('capture rejected') })
    expect(() => harness.fire('pointerdown', 110, 32)).not.toThrow()
    harness.fireWindow('pointermove', { clientX: 200, clientY: 34, buttons: 0 })
    harness.fireWindow('pointerup', { clientX: 200, clientY: 34, button: 2 })
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.dispatched[0]).toMatchObject({ command: 'link.connect' })
  })

  it('a pointermove reporting buttons zero commits the link like a release at that position', () => {
    const harness = interactionHarness(linkDropScene())
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 200, 34, { buttons: 0 })
    expect(harness.dispatched).toHaveLength(1)
    harness.fire('pointerup', 200, 34, { buttons: 0 })
    harness.fire('pointercancel', 0, 0, { pointerType: 'mouse' })
    harness.fire('lostpointercapture', 0, 0)
    expect(harness.dispatched).toHaveLength(1)
    expect(harness.dispatched[0]).toMatchObject({ command: 'link.connect' })
  })

  it('a buttons-zero move commits a moved node drag at that position', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 50, 35, { buttons: 0 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('idle hover moves with buttons zero dispatch nothing and start nothing', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointermove', 30, 15, { buttons: 0 })
    expect(harness.dispatched).toEqual([])
    expect(harness.controller.dumpPointerTrace().filter((entry) => 'gestureKind' in entry)).toEqual([])
  })

  it('a buttons-zero Space-pan preserves selection below the drag threshold', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.setSelection(['n1'])
    harness.fireWindow('keydown', { code: 'Space' })
    harness.fire('pointerdown', 30, 15, { buttons: 1 })
    harness.fire('pointermove', 32, 16, { buttons: 0 })
    harness.fire('pointerup', 32, 16, { buttons: 0 })
    expect(harness.controller.getSelection()).toEqual(new Set(['n1']))
    expect(harness.renderer.setViewport).toHaveBeenCalledTimes(1)
    expect(harness.dispatched).toEqual([])
  })

  it('mouse pointercancel on a moved node drag commits at the last tracked position', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fire('pointercancel', 0, 0, { pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 20, y: 20 } } } },
    ])
  })

  it('mouse pointercancel on a moved fresh link over empty opens the palette', () => {
    const onLinkDropOnEmpty = vi.fn()
    const harness = interactionHarness(linkDropScene(), { onLinkDropOnEmpty })
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 700, 300)
    harness.fire('pointercancel', 0, 0, { pointerType: 'mouse' })
    expect(onLinkDropOnEmpty).toHaveBeenCalledTimes(1)
    expect(onLinkDropOnEmpty).toHaveBeenCalledWith(expect.any(Object), 700, 300)
  })

  it('does not open an accept-all palette from an untyped dangling end', () => {
    const scene = linkDropScene() as any
    scene.nodes[0].layout.pins[0].type = { kind: 'wildcard' }
    const onLinkDropOnEmpty = vi.fn()
    const harness = interactionHarness(scene, { onLinkDropOnEmpty })
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointermove', 700, 300)
    harness.fire('pointerup', 700, 300)
    expect(onLinkDropOnEmpty).not.toHaveBeenCalled()
    expect(harness.dispatched).toEqual([])
  })

  it('mouse pointercancel on a moved rewire over empty disconnects', () => {
    const harness = interactionHarness(connectedLinkScene())
    harness.fire('pointerdown', 200, 34)
    harness.fire('pointermove', 700, 300)
    harness.fire('pointercancel', 0, 0, { pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l1' } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it('mouse pointercancel on a motionless press cancels cleanly', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointercancel', 0, 0, { pointerType: 'mouse' })
    harness.fire('pointerup', 30, 15)
    expect(harness.dispatched).toEqual([])
  })

  it('touch pointercancel keeps the strict policy', () => {
    const rewire = interactionHarness(connectedLinkScene())
    rewire.fire('pointerdown', 200, 34)
    rewire.fire('pointermove', 700, 300)
    rewire.fire('pointercancel', 0, 0, { pointerType: 'touch' })
    expect(rewire.dispatched).toEqual([])

    const node = interactionHarness(interactionScene())
    beginNodeDrag(node)
    node.fire('pointercancel', 0, 0, { pointerType: 'touch' })
    expect(node.dispatched).toEqual([])
  })

  it('a re-press after a dropped release commits the stale drag and starts fresh', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    // The release was dropped while the pointer was stationary; the next
    // press of the same button arrives over empty canvas.
    harness.fire('pointerdown', 150, 15, { buttons: 1, pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
    const gestures = harness.controller.dumpPointerTrace().filter((entry) => 'gestureKind' in entry)
    expect(gestures[0]).toMatchObject({ gestureKind: 'node', event: 'start', reason: 'pointerdown' })
    expect(gestures[1]).toMatchObject({ gestureKind: 'node', event: 'commit', reason: 'pointerdown-repress' })
    expect(gestures[2]).toMatchObject({ event: 'start', reason: 'pointerdown' })
    // The press owns a fresh gesture: its motionless release adds nothing.
    harness.fire('pointerup', 150, 15, { pointerType: 'mouse' })
    expect(harness.dispatched).toHaveLength(1)
  })

  it('a re-press on a stuck motionless press cancels the stale gesture', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([])
    expect(harness.controller.dumpPointerTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({ gestureKind: 'node', event: 'cancel', reason: 'pointerdown-repress' }),
    ]))
  })

  it('another-button press whose snapshot lacks the held button recovers', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    // A right-button press whose buttons snapshot no longer contains the
    // left button proves the left release was dropped.
    harness.fire('pointerdown', 50, 35, { button: 2, buttons: 2, pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('a genuine chorded second-button press does not steal the drag', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    // Left is still held in the snapshot (buttons 3): not a missed release.
    harness.fire('pointerdown', 50, 35, { button: 2, buttons: 3, pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([])
    harness.fire('pointerup', 60, 45, { pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 40, y: 40 } } } },
    ])
  })

  it('a wheel with no buttons held recovers a stuck mouse drag before zooming', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    harness.fire('wheel', 50, 35, { deltaY: -100, buttons: 0 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
    expect(harness.renderer.setViewport).toHaveBeenCalled()
  })

  it('a wheel while the drag button is still held leaves the drag active', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    harness.fire('wheel', 50, 35, { deltaY: -100, buttons: 1 })
    expect(harness.dispatched).toEqual([])
    harness.fire('pointerup', 50, 35, { pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('a wheel does not recover a stuck touch gesture', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'touch' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'touch' })
    harness.fire('wheel', 50, 35, { deltaY: -100, buttons: 0 })
    expect(harness.dispatched).toEqual([])
  })

  it('a window mouseup for the held button commits the drag at its position', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 40, 25, { buttons: 1, pointerType: 'mouse' })
    harness.fireWindow('mouseup', { clientX: 50, clientY: 35 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
    expect(harness.controller.dumpPointerTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({ gestureKind: 'node', event: 'commit', reason: 'mouseup-fallback' }),
    ]))
  })

  it('a window mouseup keeps full tap semantics for a motionless press', () => {
    const activate = vi.fn()
    const harness = interactionHarness(interactionScene(), { onValueSourceActivate: activate })
    harness.controller.setSelection(['n1'], [], [], ['v1'])
    harness.fire('pointerdown', 520, 110, { buttons: 1, pointerType: 'mouse' })
    harness.fireWindow('mouseup', { clientX: 520, clientY: 110 })
    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }), 520, 110)
    expect(harness.dispatched).toEqual([])
  })

  it('a window mouseup for a different button leaves the drag active', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    harness.fireWindow('mouseup', { button: 2, clientX: 50, clientY: 35 })
    expect(harness.dispatched).toEqual([])
    harness.fire('pointerup', 50, 35, { pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('a window mouseup never touches a touch-typed gesture', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'touch' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'touch' })
    harness.fireWindow('mouseup', { clientX: 50, clientY: 35 })
    expect(harness.dispatched).toEqual([])
  })

  it('the compatibility mouseup after a normal pointerup is a no-op', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointerup', 50, 35, { pointerType: 'mouse' })
    harness.fireWindow('mouseup', { clientX: 50, clientY: 35 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('foreign mouse events never end a pen drag; a re-press recovers it', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'pen' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'pen' })
    // A physical mouse's mouseup or wheel is indistinguishable from pen
    // compatibility events and must not commit the held pen drag.
    harness.fireWindow('mouseup', { clientX: 50, clientY: 35 })
    harness.fire('wheel', 50, 35, { deltaY: -100, buttons: 0 })
    expect(harness.dispatched).toEqual([])
    // The pen's own re-press proves its release was dropped.
    harness.fire('pointerdown', 50, 35, { buttons: 1, pointerType: 'pen' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('a captured press that starts no gesture releases ownership immediately', () => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.pins = [{
      portId: 'out', address: { port: 'out' }, direction: 'out', y: 22,
      type: { kind: 'concrete', name: 'FLOAT' },
      familyOwner: { socketed: false },
    }]
    const harness = interactionHarness(scene)
    // Press on the inert family-owned pin: the pointer is captured but no
    // gesture starts, and the release is then dropped.
    harness.fire('pointerdown', 110, 32, { buttons: 1, pointerType: 'mouse' })
    // The next press must start a fresh gesture instead of being swallowed
    // by stale ownership.
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointerup', 50, 35, { pointerType: 'mouse' })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('records raw events and termination reasons when enabled', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse' })
    harness.fire('pointermove', 40, 25, { buttons: 0, pointerType: 'mouse' })
    const entries = harness.controller.dumpPointerTrace()
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'pointerdown', pointerType: 'mouse', viaWindow: false }),
      expect.objectContaining({ type: 'pointermove', buttons: 0, viaWindow: false }),
      expect.objectContaining({ gestureKind: 'node', event: 'start', reason: 'pointerdown' }),
      expect.objectContaining({ gestureKind: 'node', event: 'commit', reason: 'synthetic-buttons0' }),
    ]))
  })

  it('records strict pointercancel commit and cancellation outcomes accurately', () => {
    const legal = interactionHarness(linkDropScene())
    legal.controller.enablePointerTrace()
    legal.fire('pointerdown', 110, 32)
    legal.fire('pointermove', 200, 34)
    legal.fire('pointercancel', 0, 0, { pointerType: 'touch' })
    expect(legal.controller.dumpPointerTrace()).toContainEqual(expect.objectContaining({
      gestureKind: 'link', event: 'commit', reason: 'pointercancel-strict-commit',
    }))

    const illegal = interactionHarness(linkDropScene())
    illegal.controller.enablePointerTrace()
    illegal.fire('pointerdown', 110, 32)
    illegal.fire('pointermove', 700, 300)
    illegal.fire('pointercancel', 0, 0, { pointerType: 'touch' })
    expect(illegal.controller.dumpPointerTrace()).toContainEqual(expect.objectContaining({
      gestureKind: 'link', event: 'cancel', reason: 'pointercancel-cancel',
    }))
  })

  it('records strict lost-capture commit and cancellation outcomes accurately', () => {
    const legal = interactionHarness(linkDropScene())
    legal.controller.enablePointerTrace()
    legal.fire('pointerdown', 110, 32)
    legal.fire('pointermove', 200, 34)
    legal.fire('lostpointercapture', 0, 0)
    expect(legal.controller.dumpPointerTrace()).toContainEqual(expect.objectContaining({
      gestureKind: 'link', event: 'commit', reason: 'lostpointercapture-commit',
    }))

    const illegal = interactionHarness(linkDropScene())
    illegal.controller.enablePointerTrace()
    illegal.fire('pointerdown', 110, 32)
    illegal.fire('pointermove', 700, 300)
    illegal.fire('lostpointercapture', 0, 0)
    expect(illegal.controller.dumpPointerTrace()).toContainEqual(expect.objectContaining({
      gestureKind: 'link', event: 'cancel', reason: 'lostpointercapture-cancel',
    }))
  })

  it('records nothing when disabled', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1 })
    harness.fire('pointermove', 40, 25, { buttons: 0 })
    expect(harness.controller.dumpPointerTrace()).toEqual([])
  })

  it('ring buffer caps at 512', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    for (let i = 0; i < 513; i++)
      harness.fire('pointermove', 700 + i, 300, { pointerId: i + 1, buttons: 0 })
    const entries = harness.controller.dumpPointerTrace()
    expect(entries).toHaveLength(512)
    expect(entries[0]).toMatchObject({ seq: 2 })
    expect(entries.at(-1)).toMatchObject({ seq: 513 })
  })

  it('cancels a Ctrl-left press when macOS synthesizes contextmenu before release', () => {
    const onContextMenu = vi.fn()
    const harness = interactionHarness(linkDropScene(), { onContextMenu })
    harness.fire('pointerdown', 110, 32, { ctrlKey: true })
    harness.fire('contextmenu', 110, 32, { ctrlKey: true, button: 2 })
    harness.fire('pointerup', 200, 34, { ctrlKey: true, button: 2 })
    expect(harness.dispatched).toEqual([])
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it('a motionless press that loses capture dispatches nothing (RG-1)', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    harness.fire('pointerup', 30, 15)
    expect(harness.dispatched).toEqual([])
  })

  it('capture loss on a non-owning pointer neither completes nor cancels (RG-1)', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fire('lostpointercapture', 0, 0, { pointerId: 2 })
    expect(harness.dispatched).toEqual([])
    harness.fire('pointermove', 50, 35, { pointerId: 1 })
    harness.fire('pointerup', 50, 35, { pointerId: 1 })
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } } },
    ])
  })

  it('a genuine platform cancel still cancels: pointercancel precedes the capture loss (RG-1)', () => {
    // Spec order for an abnormal end is pointercancel THEN lostpointercapture:
    // the cancel clears ownership first, so the capture loss can never turn
    // an OS-revoked drag into a commit.
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.fire('pointercancel', 40, 25, { pointerId: 1 })
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([])
  })

  it('completes once despite synchronous capture-loss reentrancy and cancellation is idempotent', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    expect(() => harness.fire('pointerup', 40, 25)).not.toThrow()
    expect(harness.dispatched.filter((d: any) => d.command === 'node.move')).toHaveLength(1)
    expect(() => {
      harness.controller.cancelGesture()
      harness.controller.cancelGesture()
    }).not.toThrow()
  })

  it('cancels a node drag when replacement changes graphId', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.replaceScene(differentGraph())
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([])
  })

  it('a node drag survives a same-graph scene replacement and commits against the new scene', () => {
    // Background document mutations (an execution tick, a post-run seed
    // advancement, a collaboration patch) rebuild the scene mid-drag. The
    // drag carries only ids + press geometry and commits against the
    // commit-time scene, so a same-graph rebuild must not eat it - even one
    // that moved the dragged node underneath the gesture.
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    const rebuilt = interactionScene() as any
    rebuilt.nodes[0].x = 50 // a background mutation moved n1
    harness.replaceScene(rebuilt)
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([
      { command: 'node.move', params: { graphId: 'g0', positions: { n1: { x: 60, y: 20 } } } },
    ])
  })

  it('a node drag whose every capture vanished mid-drag dispatches nothing', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    const rebuilt = interactionScene() as any
    rebuilt.nodes = rebuilt.nodes.filter((n: any) => n.id !== 'n1')
    harness.replaceScene(rebuilt)
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([])
  })

  it('a node resize survives a same-graph scene replacement but not its node vanishing', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 110, 54) // n1 SE corner handle
    harness.fire('pointermove', 120, 64)
    harness.replaceScene({ ...interactionScene() })
    harness.fire('pointerup', 140, 84)
    expect(harness.dispatched).toEqual([
      expect.objectContaining({
        command: 'view.setNodeSize',
        params: expect.objectContaining({ graphId: 'g0', nodeId: 'n1' }),
      }),
    ])

    const vanished = interactionHarness(interactionScene())
    vanished.fire('pointerdown', 110, 54)
    vanished.fire('pointermove', 120, 64)
    const rebuilt = interactionScene() as any
    rebuilt.nodes = rebuilt.nodes.filter((n: any) => n.id !== 'n1')
    vanished.replaceScene(rebuilt)
    expect(vanished.overlays.at(-1)).not.toHaveProperty('resizePreview')
    vanished.fire('pointerup', 140, 84)
    expect(vanished.dispatched).toEqual([])
  })

  it('a link drag still cancels on a same-graph scene replacement', () => {
    // Link gestures capture scene objects (pin layouts, drop-target sets),
    // not just ids: a rebuild invalidates those captures, so the ghost
    // noodle drops rather than committing against stale geometry.
    const scene = interactionScene() as any
    scene.nodes[0].layout.pins = [{
      direction: 'out', x: 100, y: 30, address: { port: 'out' },
      type: 'FLOAT', typeName: 'FLOAT', label: 'out',
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 40) // n1 output pin (pins overhang)
    harness.fire('pointermove', 150, 60)
    harness.replaceScene({ ...interactionScene() })
    harness.fire('pointerup', 210, 15) // over n2: would connect if alive
    expect(harness.dispatched).toEqual([])
  })

  it('lets a marquee survive a same-graph scene replacement but cancels cross-graph', () => {
    // Marquees select by world rectangle against the CURRENT scene at
    // release, so a same-graph rebuild (execution tick, preview arrival)
    // must not eat an in-flight sweep; a different graph must.
    const selections: string[][] = []
    const harness = interactionHarness(interactionScene(), {
      onSelectionChange: (nodes) => selections.push([...nodes].sort()),
    })
    harness.fire('pointerdown', 150, 80, { ctrlKey: true })
    harness.fire('pointermove', 320, 5, { ctrlKey: true })
    harness.replaceScene({ ...interactionScene() })
    harness.fire('pointerup', 320, 5, { ctrlKey: true })
    expect(selections.at(-1)).toEqual(['n2'])

    const crossGraph = interactionHarness(interactionScene(), {
      onSelectionChange: (nodes) => selections.push([...nodes].sort()),
    })
    selections.length = 0
    crossGraph.fire('pointerdown', 150, 80, { ctrlKey: true })
    crossGraph.fire('pointermove', 320, 5, { ctrlKey: true })
    crossGraph.replaceScene(differentGraph())
    crossGraph.fire('pointerup', 320, 5, { ctrlKey: true })
    expect(selections.flat()).toEqual([])
  })

  it('lets a pure pan survive scene replacement', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { button: 1 })
    harness.replaceScene(differentGraph())
    expect(() => {
      harness.fire('pointermove', 40, 25)
      harness.fire('pointerup', 40, 25)
    }).not.toThrow()
    expect(harness.dispatched).toEqual([])
  })

  it('refuses a cross-graph commit when replacement notification is missed', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    harness.swapScene(differentGraph())
    harness.fire('pointerup', 40, 25)
    expect(harness.dispatched).toEqual([])
  })

  it('dispose cancels an active gesture and releases pointer capture', () => {
    const harness = interactionHarness(interactionScene())
    beginNodeDrag(harness)
    expect(() => harness.controller.dispose()).not.toThrow()
    expect(harness.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(harness.dispatched).toEqual([])
  })

  it('group drag carries contained value sources and selectors', () => {
    const scene = interactionScene() as any
    scene.nodes = [scene.nodes[0]]
    scene.reroutes = []
    scene.groups = [{ id: 'g', title: 'Group', x: 0, y: 0, width: 750, height: 200 }]
    const harness = interactionHarness(scene)

    // This is in the title band but clear of every member and resize handle.
    harness.fire('pointerdown', 350, 13)
    harness.fire('pointermove', 365, 23)
    const overlay = harness.overlays.at(-1) as any
    expect(overlay.dragOffsets.get('v1')).toEqual({ dx: 15, dy: 10 })
    expect(overlay.dragOffsets.get('s1')).toEqual({ dx: 15, dy: 10 })
    harness.fire('pointerup', 365, 23)

    expect(harness.dispatched).toEqual([{
      command: 'view.moveGroup',
      params: {
        graphId: 'g0', groupId: 'g', bounds: { x: 15, y: 10 },
        positions: { n1: { x: 25, y: 20 } },
        valueSources: { v1: { x: 515, y: 110 } },
        selectors: { s1: { x: 615, y: 110 } },
      },
    }])
  })
})

describe('presence egress callbacks (onDragOffsets / onNodeHover / onLinkDragPresence)', () => {
  const widgetTapScene = (connected: boolean): Scene => {
    const scene = interactionScene() as any
    const FLOAT = { kind: 'concrete', name: 'FLOAT' }
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'amount', address: { port: 'amount' }, direction: 'out', y: 22, type: FLOAT, widgetTap: true },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    scene.links = connected ? [{
      id: 'tap-link', from: { kind: 'widgetTap', node: 'n1', input: 'amount' },
      to: { kind: 'port', node: 'n2', port: 'in' }, x1: 110, y1: 32, x2: 200, y2: 32,
    }] : []
    return scene
  }

  it('ordinary port and reroute drag presence origins remain unchanged and clear each on end', () => {
    const scene = interactionScene() as any
    const FLOAT = { kind: 'concrete', name: 'FLOAT' }
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 22, type: FLOAT },
    ]
    const origins: unknown[] = []
    const harness = interactionHarness(scene, { onLinkDragPresence: (origin) => origins.push(origin) })

    harness.fire('pointerdown', 110, 32)
    harness.fire('pointerup', 150, 60)
    harness.fire('pointerdown', 200, 32)
    harness.fireWindow('keydown', { code: 'Escape' })
    harness.fire('pointermove', 400 + REROUTE_SOCKET_OFFSET, 100)
    harness.fire('pointerdown', 400 + REROUTE_SOCKET_OFFSET, 100)
    harness.fire('pointerup', 450, 140)
    harness.fire('pointermove', 400 - REROUTE_SOCKET_OFFSET, 100)
    harness.fire('pointerdown', 400 - REROUTE_SOCKET_OFFSET, 100)
    harness.fireWindow('keydown', { code: 'Escape' })

    expect(origins).toEqual([
      { kind: 'port', node: 'n1', port: 'out', side: 'out' },
      undefined,
      { kind: 'port', node: 'n2', port: 'in', side: 'in' },
      undefined,
      { kind: 'reroute', reroute: 'r1', side: 'out' },
      undefined,
      { kind: 'reroute', reroute: 'r1', side: 'in' },
      undefined,
    ])
  })

  it('fresh widget tap drag publishes its widget input presence origin', () => {
    const origins: unknown[] = []
    const harness = interactionHarness(widgetTapScene(false), {
      onLinkDragPresence: (origin) => origins.push(origin),
    })
    harness.fire('pointermove', 50, 30)
    harness.fire('pointerdown', 110, 32)
    harness.fire('pointerup', 150, 60)

    expect(origins).toEqual([
      { kind: 'widgetTap', node: 'n1', input: 'amount' },
      undefined,
    ])
  })

  it('widget tap source rewire publishes the same widget input presence origin', () => {
    const origins: unknown[] = []
    const harness = interactionHarness(widgetTapScene(true), {
      onLinkDragPresence: (origin) => origins.push(origin),
    })
    harness.fire('pointerdown', 200, 32)
    harness.fireWindow('keydown', { code: 'Escape' })

    expect(origins).toEqual([
      { kind: 'widgetTap', node: 'n1', input: 'amount' },
      undefined,
    ])
  })

  it('a node drag emits live offset maps per move and exactly one undefined on commit', () => {
    const calls: (ReadonlyMap<string, { dx: number; dy: number }> | undefined)[] = []
    const harness = interactionHarness(interactionScene(), {
      onDragOffsets: (offsets) => calls.push(offsets as ReadonlyMap<string, { dx: number; dy: number }> | undefined),
    })
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    harness.fire('pointermove', 50, 35)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.get('n1')).toEqual({ dx: 10, dy: 10 })
    expect(calls[1]!.get('n1')).toEqual({ dx: 20, dy: 20 })
    harness.fire('pointerup', 50, 35)
    expect(calls).toHaveLength(3)
    expect(calls[2]).toBeUndefined()
    // Idle pointer traffic after the drag must not re-emit the clear.
    harness.fire('pointermove', 900, 400)
    expect(calls).toHaveLength(3)
  })

  it('cancelling a drag (Escape) also clears the offsets exactly once', () => {
    const calls: unknown[] = []
    const harness = interactionHarness(interactionScene(), {
      onDragOffsets: (offsets) => calls.push(offsets),
    })
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    harness.fireWindow('keydown', { code: 'Escape' })
    expect(calls).toEqual([expect.any(Map), undefined])
    expect(harness.dispatched).toEqual([])
  })

  it('a scene replacement mid-drag does not re-emit the same live offsets', () => {
    const calls: unknown[] = []
    const harness = interactionHarness(interactionScene(), {
      onDragOffsets: (offsets) => calls.push(offsets),
    })
    harness.fire('pointerdown', 30, 15)
    harness.fire('pointermove', 40, 25)
    expect(calls).toHaveLength(1)
    // Same-graph rebuild (a background collab patch): the drag survives and
    // the carried-through overlay reuses the SAME map - no duplicate emit.
    harness.replaceScene(interactionScene())
    expect(calls).toHaveLength(1)
  })

  it('reports the node under the idle pointer and hover-off, each once', () => {
    const hovers: (string | undefined)[] = []
    const harness = interactionHarness(interactionScene(), {
      onNodeHover: (nodeId) => hovers.push(nodeId),
    })
    harness.fire('pointermove', 30, 15) // over n1
    harness.fire('pointermove', 35, 18) // still n1: no re-emit
    harness.fire('pointermove', 900, 400) // empty canvas
    expect(hovers).toEqual(['n1', undefined])
  })

  it('clears the hover when the hovered node leaves the scene', () => {
    const hovers: (string | undefined)[] = []
    const harness = interactionHarness(interactionScene(), {
      onNodeHover: (nodeId) => hovers.push(nodeId),
    })
    harness.fire('pointermove', 30, 15)
    expect(hovers).toEqual(['n1'])
    const scene = interactionScene()
    harness.replaceScene({ ...scene, nodes: scene.nodes.filter((n) => n.id !== 'n1') } as Scene)
    expect(hovers).toEqual(['n1', undefined])
  })
})

describe('group movement', () => {
  it('carries contained nodes, reroutes, and boundary pseudo-nodes in one command', () => {
    const scene = interactionScene() as any
    scene.groups = [{ id: 'g', title: 'Group', x: 0, y: 0, width: 500, height: 300 }]
    scene.boundaryNodes = [{
      side: 'inputs', x: 300, y: 20,
      layout: { width: 100, height: 100, headerHeight: 24, pins: [], rows: [] },
    }]
    const harness = interactionHarness(scene)

    harness.fire('pointerdown', 480, 13)
    harness.fire('pointermove', 490, 23)
    harness.fire('pointerup', 490, 23)

    expect(harness.dispatched).toEqual([{
      command: 'view.moveGroup',
      params: {
        graphId: 'g0',
        groupId: 'g',
        bounds: { x: 10, y: 10 },
        positions: { n1: { x: 20, y: 20 }, n2: { x: 210, y: 20 } },
        reroutes: { r1: { x: 410, y: 110 } },
        boundary: { inputs: { x: 310, y: 30 } },
      },
    }])
  })
})

describe('group resizing', () => {
  it('resizes NW from the captured opposite corner, clamps at 60, and never moves members', () => {
    const scene = interactionScene() as any
    scene.groups = [{ id: 'g', title: 'Group', x: -20, y: -20, width: 500, height: 300 }]
    const harness = interactionHarness(scene)

    harness.fire('pointerdown', -20, -20)
    harness.fire('pointermove', -37.5, -21.25)
    harness.fire('pointermove', 1000, 1000)
    harness.fire('pointerup', 1000, 1000)

    expect(harness.dispatched).toEqual([{
      command: 'view.setGroupBounds',
      params: {
        graphId: 'g0', groupId: 'g',
        bounds: { x: 420, y: 220, width: 60, height: 60 },
      },
    }])
    const bounds = (harness.dispatched[0] as any).params.bounds
    expect(bounds.x + bounds.width).toBe(480)
    expect(bounds.y + bounds.height).toBe(280)
    expect((harness.dispatched[0] as any).params.positions).toBeUndefined()
  })

  it('grows from SE while keeping NW fixed', () => {
    const scene = interactionScene() as any
    scene.groups = [{ id: 'g', title: 'Group', x: 0, y: 0, width: 500, height: 300 }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 500, 300)
    harness.fire('pointermove', 580, 350)
    harness.fire('pointerup', 580, 350)
    expect(harness.dispatched).toEqual([{
      command: 'view.setGroupBounds',
      params: { graphId: 'g0', groupId: 'g', bounds: { x: 0, y: 0, width: 580, height: 350 } },
    }])
  })
})

describe('numeric widget steppers', () => {
  it('routes a forwarded suffix member value to its occurrence owner', () => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.rows[0].valueKey = 'weights.w#rebased'
    scene.nodes[0].layout.rows[0].familyOwner = {
      graphId: 'g0', nodeId: 'instance', construct: 'forwarded', valueKey: 'forwarded.w#member',
    }
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([{
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'instance', inputId: 'forwarded.w#member', value: 0.3 },
    }])
  })

  it('steps at both edges with float rounding and min/max clamping while the center activates the editor', () => {
    const activate = vi.fn()
    const harness = interactionHarness(interactionScene(), { onWidgetActivate: activate })
    harness.fire('pointerdown', 20, 35)
    harness.fire('pointerup', 20, 35)
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    harness.fire('pointerdown', 60, 35)
    harness.fire('pointerup', 60, 35)
    expect(harness.dispatched).toEqual([
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: 0.1 } },
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: 0.3 } },
    ])
    expect(activate).toHaveBeenCalledOnce()
  })

  it('applies every rapid INT edge activation once from the latest stored value', () => {
    const scene = interactionScene() as any
    const start = Number.MAX_SAFE_INTEGER - 30
    const count = 20
    scene.nodes[0].node.values.amount = start
    scene.nodes[0].layout.rows[0].spec = {
      widgetType: 'INT',
      options: { min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 },
      default: 0,
    }
    scene.nodes[0].layout.rows[0].controllerMode = 'increment'
    const values: number[] = []
    const harness = interactionHarness(scene, {
      dispatch: (invocation) => {
        const value = (invocation.params as any).value as number
        values.push(value)
        // CanvasHost rebuilds the scene synchronously from the committed
        // document. Mirror that boundary so the next physical activation
        // cannot read the previous paint's stale value.
        scene.nodes[0].node.values.amount = value
        return { ok: true }
      },
    })
    for (let i = 0; i < count; i++) {
      harness.fire('pointerdown', 100, 35)
      harness.fire('pointerup', 100, 35)
    }
    expect(values).toHaveLength(count)
    expect(values).toEqual(Array.from({ length: count }, (_, index) => start + index + 1))
    expect(values.every(Number.isSafeInteger)).toBe(true)
  })

  it('steps an unsafe INT edge exactly and clamps at uint64 max', () => {
    const scene = interactionScene() as any
    scene.nodes[0].node.values.amount = '18446744073709551614'
    scene.nodes[0].layout.rows[0].spec = {
      widgetType: 'INT',
      options: { min: 0, max: '18446744073709551615', step: 1 },
      default: 0,
    }
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([{
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: '18446744073709551615' },
    }])
  })

  it('steps from the same intrinsic default the compact renderer paints and never opens the editor from an edge', () => {
    const scene = interactionScene() as any
    delete scene.nodes[0].node.values.amount
    delete scene.nodes[0].layout.rows[0].spec.default
    scene.nodes[0].layout.rows[0].spec.options = { min: 2, max: 4, step: 1 }
    const activate = vi.fn()
    const harness = interactionHarness(scene, {
      resolveWidgetDefault: (spec) => spec.options['min'] as number,
      onWidgetActivate: activate,
    })
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([{
      command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: 3 },
    }])
    expect(activate).not.toHaveBeenCalled()
  })

  it('keeps an unresolved numeric edge inert instead of falling through to body activation', () => {
    const scene = interactionScene() as any
    delete scene.nodes[0].node.values.amount
    delete scene.nodes[0].layout.rows[0].spec.default
    const activate = vi.fn()
    const harness = interactionHarness(scene, { onWidgetActivate: activate })
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([])
    expect(activate).not.toHaveBeenCalled()
  })

  it('routes an unmaterialized ghost edge through normal editor activation instead of writing a hidden value', () => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.rows[0].ghost = true
    delete scene.nodes[0].node.values.amount
    delete scene.nodes[0].layout.rows[0].spec.default
    const activate = vi.fn()
    const harness = interactionHarness(scene, {
      resolveWidgetDefault: () => 2,
      onWidgetActivate: activate,
    })
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([])
    expect(activate).toHaveBeenCalledOnce()
  })

  it('does nothing in a stepper zone when a real link drives the row', () => {
    const scene = interactionScene()
    const connected = { ...scene, links: [{ id: 'l1', from: { kind: 'port', node: 'n2', port: 'out' }, to: { kind: 'port', node: 'n1', port: 'amount' }, x1: 0, y1: 0, x2: 0, y2: 0 }] } as unknown as Scene
    const activate = vi.fn()
    const harness = interactionHarness(connected, { onWidgetActivate: activate })
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([])
    expect(activate).not.toHaveBeenCalled()
  })

  it('allows a selector row stepper when its only incoming link is a boundary binding', () => {
    const scene = interactionScene() as any
    scene.nodes[0].layout.rows[0].selector = 'occurrence-selector'
    scene.links = [{ id: 'boundary:inputs:x', boundary: true, from: { kind: 'boundary', side: 'inputs', item: 'x' }, to: { kind: 'port', node: 'n1', port: 'amount' }, x1: 0, y1: 0, x2: 0, y2: 0 }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([
      { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: 0.3 } },
    ])
  })
})

describe('after-generate controller chip', () => {
  it('reports the chip as its own tooltip target', () => {
    const targets: unknown[] = []
    const harness = interactionHarness(controllerScene('fixed'), { onHoverTarget: (target) => targets.push(target) })
    harness.fire('pointermove', 81, 35)
    expect(targets.at(-1)).toMatchObject({ kind: 'controller' })
  })

  it.each(['fixed', 'increment', 'decrement', 'randomize'] as const)('opens the detail menu from the %s chip', (current) => {
    const activated: unknown[] = []
    const harness = interactionHarness(controllerScene(current), { onControllerActivate: (hit) => activated.push(hit) })
    harness.fire('pointerdown', 81, 35)
    harness.fire('pointerup', 81, 35)
    expect(activated).toHaveLength(1)
    expect(harness.dispatched).toEqual([])
  })

  it('keeps a link-driven controller chip inert because advancement skips linked values', () => {
    const harness = interactionHarness(controllerScene('increment', true))
    harness.fire('pointerdown', 81, 35)
    harness.fire('pointerup', 81, 35)
    expect(harness.dispatched).toEqual([])
  })

  it('keeps the right edge stepper distinct from the controller chip', () => {
    const harness = interactionHarness(controllerScene('increment'))
    harness.fire('pointerdown', 100, 35)
    harness.fire('pointerup', 100, 35)
    expect(harness.dispatched).toEqual([{
      command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: 0.3 },
    }])
  })
})

describe('boundary row rename interaction', () => {
  it('double-clicking a boundary slot label requests a rename', () => {
    const scene = interactionScene() as any
    scene.boundaryNodes = [{
      side: 'inputs', x: 10, y: 100,
      layout: {
        width: 140, height: 50, headerHeight: 20, pins: [], title: 'Inputs',
        rows: [{ kind: 'ports', y: 20, height: 24, input: { portId: 'exposed', type: { kind: 'wildcard' } } }],
      },
    }]
    const rename = vi.fn()
    const harness = interactionHarness(scene, { onBoundaryRenameRequest: rename })
    harness.fire('dblclick', 70, 132)
    expect(rename).toHaveBeenCalledWith('inputs', 'exposed', 70, 132)
  })
})

describe('node title double-click minimization', () => {
  it('minimizes or restores the selected nodes with one view command', () => {
    const scene = interactionScene()
    const harness = interactionHarness(scene)
    harness.controller.setSelection(['n1', 'n2'])
    harness.fire('dblclick', 50, 15)
    expect(harness.dispatched).toEqual([{
      command: 'view.setNodeCollapsed',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], collapsed: true },
    }])

    const minimized = {
      ...scene,
      nodes: scene.nodes.map((node) => ({
        ...node,
        layout: { ...node.layout, minimized: true as const },
      })),
    }
    harness.swapScene(minimized)
    harness.fire('dblclick', 50, 15)
    expect(harness.dispatched.at(-1)).toEqual({
      command: 'view.setNodeCollapsed',
      params: { graphId: 'g0', nodeIds: ['n1', 'n2'], collapsed: false },
    })
  })

  it('keeps subgraph opening ahead of minimization', () => {
    const scene = interactionScene()
    const subgraph = { ...scene.nodes[0]!, isSubgraph: true }
    const open = vi.fn()
    const harness = interactionHarness({ ...scene, nodes: [subgraph, ...scene.nodes.slice(1)] }, {
      onOpenSubgraph: open,
    })
    harness.fire('dblclick', 50, 15)
    expect(open).toHaveBeenCalledWith(subgraph)
    expect(harness.dispatched).toEqual([])
  })

  it('does not minimize from a body double-click', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('dblclick', 50, 40)
    expect(harness.dispatched).toEqual([])
  })
})

describe('link double-click interaction', () => {
  const linkScene = (): Scene => {
    const scene = interactionScene() as any
    scene.links = [{
      id: 'l1', from: { kind: 'port', node: 'n1', port: 'out' }, to: { kind: 'port', node: 'n2', port: 'in' },
      x1: 100, y1: 100, x2: 200, y2: 100,
      fromType: { kind: 'concrete', name: 'IMAGE' }, toType: { kind: 'concrete', name: 'IMAGE' },
    }]
    return scene
  }

  it('a midpoint click opens the link menu with the double-click payload', () => {
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
    harness.fire('pointerdown', 150, 100)
    harness.fire('pointerup', 150, 100)
    expect(onLinkDoubleClick).toHaveBeenCalledWith(expect.objectContaining({
      linkId: 'l1', position: { x: 150, y: 100 },
      fixedFrom: { node: 'n1', port: 'out' }, fixedInto: { node: 'n2', port: 'in' },
    }), 150, 100)
  })

  it('a non-midpoint link click only selects the link', () => {
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
    harness.fire('pointerdown', 120, 100)
    harness.fire('pointerup', 120, 100)
    expect(harness.controller.getLinkSelection()).toEqual(new Set(['l1']))
    expect(onLinkDoubleClick).not.toHaveBeenCalled()
  })

  it('Ctrl, Meta, Shift, and Alt midpoint clicks keep selection-only semantics', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
      const onLinkDoubleClick = vi.fn()
      const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
      harness.fire('pointerdown', 150, 100, { [modifier]: true })
      harness.fire('pointerup', 150, 100, { [modifier]: true })
      expect(onLinkDoubleClick, modifier).not.toHaveBeenCalled()
    }
  })

  it('a midpoint press exceeding the drag threshold does not open the menu', () => {
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
    harness.fire('pointerdown', 150, 100)
    harness.fire('pointermove', 155, 100)
    harness.fire('pointerup', 155, 100)
    expect(onLinkDoubleClick).not.toHaveBeenCalled()
  })

  it('a midpoint click resolves the current link and release position after scene churn', () => {
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
    harness.fire('pointerdown', 150, 100)
    const rebuilt = linkScene() as any
    rebuilt.links[0].from = { kind: 'reroute', reroute: 'r1' }
    harness.replaceScene(rebuilt)
    harness.fire('pointermove', 152, 101)
    harness.fire('pointerup', 152, 101)
    expect(onLinkDoubleClick).toHaveBeenCalledWith(expect.objectContaining({
      position: { x: 152, y: 101 },
      fixedFrom: { reroute: 'r1' },
    }), 152, 101)
  })

  it('net delivery noodles open no splice menu on midpoint click or double-click', () => {
    const scene = linkScene() as any
    scene.links[0] = { ...scene.links[0], id: 'net100:0', netId: 'net100', netName: 'latents' }
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(scene, { onLinkDoubleClick })
    // A midpoint click still selects the noodle, like any curve click.
    harness.fire('pointerdown', 150, 100)
    harness.fire('pointerup', 150, 100)
    expect(harness.controller.getLinkSelection()).toEqual(new Set(['net100:0']))
    expect(onLinkDoubleClick).not.toHaveBeenCalled()
    harness.fire('dblclick', 150, 100)
    expect(onLinkDoubleClick).not.toHaveBeenCalled()
  })

  it('a midpoint click whose link vanished during scene churn opens nothing', () => {
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
    harness.fire('pointerdown', 150, 100)
    const rebuilt = linkScene() as any
    rebuilt.links = []
    harness.replaceScene(rebuilt)
    harness.fire('pointerup', 150, 100)
    expect(onLinkDoubleClick).not.toHaveBeenCalled()
  })

  it('double-clicking anywhere on a link still emits splice context', () => {
    const onLinkDoubleClick = vi.fn()
    const harness = interactionHarness(linkScene(), { onLinkDoubleClick })
    harness.fire('dblclick', 120, 100)
    expect(harness.dispatched).toEqual([])
    expect(onLinkDoubleClick).toHaveBeenCalledWith(expect.objectContaining({
      linkId: 'l1', position: { x: 120, y: 100 },
      fixedFrom: { node: 'n1', port: 'out' }, fixedInto: { node: 'n2', port: 'in' },
    }), 120, 100)
  })
})

describe('selection toolbox double-click isolation', () => {
  it('swallows separator clicks without invoking an action or canvas gesture', () => {
    const action = vi.fn()
    const preventDefault = vi.fn()
    const toolbox: ToolboxLayout = {
      x: 300,
      y: 200,
      width: 80,
      height: 40,
      rows: [{
        x: 305,
        y: 206,
        width: 70,
        height: 28,
        panel: { x: 300, y: 200, width: 80, height: 40 },
        entries: [{ kind: 'separator', x: 339, y: 212, width: 1, height: 16.8 }],
      }],
      buttons: [],
    }
    const harness = interactionHarness(interactionScene(), { onToolboxAction: action }, {}, toolbox)
    harness.fire('pointerdown', 339.5, 220, { preventDefault })
    expect(action).not.toHaveBeenCalled()
    expect(harness.dispatched).toEqual([])
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(harness.setPointerCapture).not.toHaveBeenCalled()
  })

  it('swallows disabled button clicks without invoking the host action', () => {
    const action = vi.fn()
    const toolbox: ToolboxLayout = {
      x: 300,
      y: 200,
      width: 80,
      height: 32,
      rows: [],
      buttons: [{
        button: { id: 'core.queueBetween', label: 'Execute between', disabled: true },
        x: 305,
        y: 205,
        size: 22,
      }],
    }
    const harness = interactionHarness(interactionScene(), { onToolboxAction: action }, {}, toolbox)
    harness.fire('pointerdown', 310, 210)
    expect(action).not.toHaveBeenCalled()
    expect(harness.dispatched).toEqual([])
  })

  it('never leaks a toolbox double-click after its first action removes the toolbox', () => {
    const palette = vi.fn()
    const preventDefault = vi.fn()
    let toolbox: ToolboxLayout | undefined = {
      x: 300,
      y: 200,
      width: 80,
      height: 32,
      rows: [],
      buttons: [{
        button: { id: 'core.mode.bypassed', label: 'Bypass' },
        x: 305,
        y: 205,
        size: 22,
      }],
    }
    const harness = interactionHarness(
      interactionScene(),
      {
        onOpenPalette: palette,
        onToolboxAction: () => { toolbox = undefined },
      },
      {},
      () => toolbox,
    )
    harness.fire('pointerdown', 310, 210, { timeStamp: 100 })
    expect(toolbox).toBeUndefined()
    harness.fire('dblclick', 310, 210, { preventDefault, timeStamp: 300 })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(palette).not.toHaveBeenCalled()
  })
})

describe('authorable net views', () => {
  const netViewScene = (): Scene => ({
    ...interactionScene(),
    netStubs: [{
      id: '["netView","net1","sink","n2","in0",[]]',
      netId: 'net1',
      name: 'latents',
      role: 'sink',
      nodeId: 'n2',
      portId: 'in0',
      pinX: 620,
      pinY: 200,
      x: 500,
      y: 420,
      width: 80,
      height: 18,
      authored: true,
    }],
  })

  it('selects and moves a Get view through one selection.move command', () => {
    const harness = interactionHarness(netViewScene())
    harness.fire('pointerdown', 540, 429)
    expect([...harness.controller.getNetViewSelection()]).toEqual(['["netView","net1","sink","n2","in0",[]]'])
    harness.fire('pointermove', 570, 459)
    harness.fire('pointerup', 570, 459)
    expect(harness.dispatched).toEqual([{
      command: 'selection.move',
      params: {
        graphId: 'g0',
        nodes: {},
        netViews: [{
          netId: 'net1',
          role: 'sink',
          to: { node: 'n2', port: 'in0' },
          position: { x: 530, y: 450 },
        }],
      },
    }])
  })

  it('includes net views in marquee and select-all selection', () => {
    const harness = interactionHarness(netViewScene())
    harness.fire('pointerdown', 490, 410, { ctrlKey: true })
    harness.fire('pointermove', 590, 450, { ctrlKey: true })
    harness.fire('pointerup', 590, 450, { ctrlKey: true })
    expect(harness.controller.getNetViewSelection().size).toBe(1)
    harness.controller.setSelection([])
    harness.controller.selectAll()
    expect(harness.controller.getNetViewSelection().size).toBe(1)
  })

  it('preserves a selected net view while panning empty canvas', () => {
    const harness = interactionHarness(netViewScene())
    harness.fire('pointerdown', 540, 429)
    harness.fire('pointerup', 540, 429)
    harness.fire('pointerdown', 900, 700)
    harness.fire('pointermove', 920, 720)
    harness.fire('pointerup', 920, 720)
    expect(harness.controller.getNetViewSelection().size).toBe(1)
  })

  it('clears a selected net view when context-click replaces selection', () => {
    const harness = interactionHarness(netViewScene())
    harness.fire('pointerdown', 540, 429)
    harness.fire('pointerup', 540, 429)
    harness.fire('contextmenu', 50, 15, { button: 2 })
    expect(harness.controller.getSelection()).toEqual(new Set(['n1']))
    expect(harness.controller.getNetViewSelection()).toEqual(new Set())
  })
})

describe('net delivery gestures', () => {
  const FLOAT = { kind: 'concrete', name: 'FLOAT' }

  // n1.out feeds net netA into n2.in. n3 offers both pin directions so it
  // can serve as the drop target for sink moves (in) and source moves (out).
  const netScene = (hidden = false): Scene => {
    const scene = interactionScene() as any
    scene.valueSources = []
    scene.selectors = []
    scene.nodes[0].layout.pins = [
      { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
    ]
    scene.nodes[1].layout.pins = [
      { portId: 'in', address: { port: 'in' }, direction: 'in', y: 24, type: FLOAT },
    ]
    scene.nodes.push({
      id: 'n3', x: 390, y: 10, node: { id: 'n3', type: 'Numeric', values: {} },
      layout: {
        width: 100, height: 44, headerHeight: 20, rows: [], title: 'n3',
        pins: [
          { portId: 'in', address: { port: 'in' }, direction: 'in', y: 24, type: FLOAT },
          { portId: 'out', address: { port: 'out' }, direction: 'out', y: 22, type: FLOAT },
        ],
      },
    })
    scene.links = [{
      id: 'netA:0', netId: 'netA', netName: 'feed',
      from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n2', port: 'in' },
      x1: 110, y1: 32, x2: 200, y2: 34, typeName: 'FLOAT',
      ...(hidden ? { hidden: true } : {}),
    }]
    return scene
  }

  it.each([{ state: 'expanded', hidden: false }, { state: 'collapsed', hidden: true }])(
    'dragging a $state net sink onto another input moves the membership in one batch',
    ({ hidden }) => {
      const harness = interactionHarness(netScene(hidden))
      harness.fire('pointerdown', 200, 34)
      harness.fire('pointermove', 390, 34)
      harness.fire('pointerup', 390, 34)
      expect(harness.dispatched).toEqual([{
        command: 'batch',
        params: { invocations: [
          { command: 'net.connectInput', params: { graphId: 'g0', netId: 'netA', to: { node: 'n3', port: 'in' } } },
          { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'in' } } },
          { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
        ] },
      }])
    },
  )

  it('dropping a net sink on moved empty canvas detaches that sink only', () => {
    const harness = interactionHarness(netScene())
    harness.fire('pointerdown', 200, 34)
    harness.fire('pointermove', 700, 300)
    harness.fire('pointerup', 700, 300)
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'in' } } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it('dropping a net sink on a reroute detaches the sink and connects an ordinary link from the net source', () => {
    const harness = interactionHarness(netScene())
    harness.fire('pointerdown', 200, 34)
    harness.fire('pointermove', 400, 100)
    harness.fire('pointerup', 400, 100)
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'net.disconnectInput', params: { graphId: 'g0', to: { node: 'n2', port: 'in' } } },
        { command: 'link.connect', params: { graphId: 'g0', from: { node: 'n1', port: 'out' }, to: { reroute: 'r1' } } },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n2' } },
      ] },
    }])
  })

  it('releasing a net sink back on its own pin dispatches nothing', () => {
    const harness = interactionHarness(netScene())
    harness.fire('pointerdown', 200, 34)
    harness.fire('pointermove', 210, 40)
    harness.fire('pointermove', 200, 34)
    harness.fire('pointerup', 200, 34)
    expect(harness.dispatched).toEqual([])
  })

  it('Shift-grabbing a net source re-points the net via net.setSource', () => {
    const harness = interactionHarness(netScene())
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 490, 32, { shiftKey: true })
    harness.fire('pointerup', 490, 32, { shiftKey: true })
    expect(harness.dispatched).toEqual([{
      command: 'net.setSource',
      params: { graphId: 'g0', netId: 'netA', source: { node: 'n3', port: 'out' } },
    }])
  })

  it('Shift-moving a mixed doc-link and net fan-out re-sources both in one batch', () => {
    const scene = netScene() as any
    scene.nodes.push({
      id: 'n4', x: 200, y: 200, node: { id: 'n4', type: 'Numeric', values: {} },
      layout: {
        width: 100, height: 44, headerHeight: 20, rows: [], title: 'n4',
        pins: [{ portId: 'in', address: { port: 'in' }, direction: 'in', y: 24, type: FLOAT }],
      },
    })
    scene.links = [...scene.links, {
      id: 'l1',
      from: { kind: 'port', node: 'n1', port: 'out' },
      to: { kind: 'port', node: 'n4', port: 'in' },
      x1: 110, y1: 32, x2: 200, y2: 224, typeName: 'FLOAT',
    }]
    const harness = interactionHarness(scene)
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 490, 32, { shiftKey: true })
    harness.fire('pointerup', 490, 32, { shiftKey: true })
    expect(harness.dispatched).toEqual([{
      command: 'batch',
      params: { invocations: [
        { command: 'link.rewireSource', params: { graphId: 'g0', linkIds: ['l1'], from: { node: 'n3', port: 'out' } } },
        { command: 'net.setSource', params: { graphId: 'g0', netId: 'netA', source: { node: 'n3', port: 'out' } } },
      ] },
    }])
  })

  it('Shift-moving an all-net fan-out onto empty canvas dispatches nothing: a net always keeps a source', () => {
    const harness = interactionHarness(netScene())
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 700, 300, { shiftKey: true })
    harness.fire('pointerup', 700, 300, { shiftKey: true })
    expect(harness.dispatched).toEqual([])
  })

  it('a fan-out carrying net membership refuses a reroute as its new source', () => {
    const harness = interactionHarness(netScene())
    harness.fire('pointerdown', 110, 32, { shiftKey: true })
    harness.fire('pointermove', 400, 100, { shiftKey: true })
    harness.fire('pointerup', 400, 100, { shiftKey: true })
    expect(harness.dispatched).toEqual([])
  })

  it('pruneSelection drops a delivery selected before its net collapsed', () => {
    const harness = interactionHarness(netScene())
    harness.controller.setSelection([], ['netA:0'])
    expect([...harness.controller.getLinkSelection()]).toEqual(['netA:0'])
    // Collapsing keeps the delivery in the scene but flags it hidden; the
    // stale selection must not survive, or Delete would disconnect an
    // invisible link.
    harness.replaceScene(netScene(true))
    harness.controller.pruneSelection()
    expect([...harness.controller.getLinkSelection()]).toEqual([])
  })
})

describe('two-finger touch navigation', () => {
  const touch = { pointerType: 'touch', buttons: 1 }
  const setViewportMock = (harness: ReturnType<typeof interactionHarness>) =>
    harness.renderer.setViewport as unknown as ReturnType<typeof vi.fn>

  it('pinching apart zooms about the finger midpoint', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('pointermove', 300, 100, { ...touch, pointerId: 2 })
    expect(setViewportMock(harness).mock.calls).toEqual([[{ x: -100, y: -100, scale: 2 }]])
    expect(harness.dispatched).toEqual([])
  })

  it('a second finger cancels a one-finger touch drag instead of committing it', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 30, 15, { ...touch, pointerId: 1 })
    harness.fire('pointermove', 50, 35, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 300, 300, { ...touch, pointerId: 2 })
    harness.fire('pointermove', 320, 300, { ...touch, pointerId: 2 })
    expect(setViewportMock(harness)).toHaveBeenCalledTimes(1)
    harness.fire('pointerup', 50, 35, { pointerType: 'touch', pointerId: 1 })
    harness.fire('pointerup', 320, 300, { pointerType: 'touch', pointerId: 2 })
    // The interrupted node drag never dispatches: cancelled, not committed.
    expect(harness.dispatched).toEqual([])
    const gestures = harness.controller.dumpPointerTrace().filter((entry) => 'gestureKind' in entry)
    expect(gestures[0]).toMatchObject({ gestureKind: 'node', event: 'start' })
    expect(gestures[1]).toMatchObject({ gestureKind: 'node', event: 'cancel', reason: 'touch-nav-takeover' })
    expect(gestures[2]).toMatchObject({ gestureKind: 'touch-nav', event: 'start', reason: 'pointerdown' })
    expect(gestures[3]).toMatchObject({ gestureKind: 'touch-nav', event: 'commit', reason: 'pointerup' })
  })

  it('lifting a participant ends navigation; a new second touch re-pairs', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('pointerup', 200, 100, { pointerType: 'touch', pointerId: 2 })
    // The remaining finger is inert until a new second touch re-pairs.
    harness.fire('pointermove', 150, 150, { ...touch, pointerId: 1 })
    expect(setViewportMock(harness)).not.toHaveBeenCalled()
    harness.fire('pointerdown', 250, 150, { ...touch, pointerId: 3 })
    harness.fire('pointermove', 350, 150, { ...touch, pointerId: 3 })
    expect(setViewportMock(harness)).toHaveBeenCalledTimes(1)
    expect(harness.dispatched).toEqual([])
  })

  it('touches never interrupt a mouse-owned gesture', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse', pointerId: 1 })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse', pointerId: 1 })
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 2 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 3 })
    harness.fire('pointermove', 300, 100, { ...touch, pointerId: 3 })
    expect(setViewportMock(harness)).not.toHaveBeenCalled()
    harness.fire('pointerup', 50, 35, { pointerType: 'mouse', pointerId: 1 })
    expect(harness.dispatched).toEqual([{
      command: 'node.move',
      params: { graphId: 'g0', positions: { n1: { x: 30, y: 30 } } },
    }])
  })

  it('extra fingers during navigation are inert', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('pointerdown', 50, 50, { ...touch, pointerId: 3 })
    harness.fire('pointermove', 60, 60, { ...touch, pointerId: 3 })
    expect(setViewportMock(harness)).not.toHaveBeenCalled()
    harness.fire('pointerup', 60, 60, { pointerType: 'touch', pointerId: 3 })
    // Navigation survives the extra finger's lift.
    harness.fire('pointermove', 300, 100, { ...touch, pointerId: 2 })
    expect(setViewportMock(harness).mock.calls).toEqual([[{ x: -100, y: -100, scale: 2 }]])
    expect(harness.dispatched).toEqual([])
  })

  it('a mouse press during navigation is swallowed', () => {
    const harness = interactionHarness(interactionScene())
    const preventDefault = vi.fn()
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('pointerdown', 30, 15, { buttons: 1, pointerType: 'mouse', pointerId: 4, preventDefault })
    harness.fire('pointermove', 50, 35, { buttons: 1, pointerType: 'mouse', pointerId: 4 })
    harness.fire('pointerup', 50, 35, { pointerType: 'mouse', pointerId: 4 })
    expect(harness.dispatched).toEqual([])
    expect(preventDefault).toHaveBeenCalled()
    // Navigation is still live afterwards.
    harness.fire('pointermove', 300, 100, { ...touch, pointerId: 2 })
    expect(setViewportMock(harness)).toHaveBeenCalledTimes(1)
  })

  it('context menu and double click are inert during navigation', () => {
    const menu = vi.fn()
    const palette = vi.fn()
    const harness = interactionHarness(interactionScene(), { onContextMenu: menu, onOpenPalette: palette })
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('contextmenu', 30, 15, { button: 2 })
    harness.fire('dblclick', 300, 300)
    expect(menu).not.toHaveBeenCalled()
    expect(palette).not.toHaveBeenCalled()
    // Navigation is still live afterwards.
    harness.fire('pointermove', 300, 100, { ...touch, pointerId: 2 })
    expect(setViewportMock(harness)).toHaveBeenCalledTimes(1)
  })

  it('unexpected capture loss of a participant cancels navigation; the survivor re-pairs', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('lostpointercapture', 0, 0, { pointerId: 2 })
    harness.fire('pointermove', 150, 150, { ...touch, pointerId: 1 })
    expect(setViewportMock(harness)).not.toHaveBeenCalled()
    expect(harness.controller.dumpPointerTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({ gestureKind: 'touch-nav', event: 'cancel', reason: 'lostpointercapture-cancel' }),
    ]))
    // The lost finger's entry is gone; the survivor re-pairs with a new touch.
    harness.fire('pointerdown', 250, 150, { ...touch, pointerId: 3 })
    harness.fire('pointermove', 350, 150, { ...touch, pointerId: 3 })
    expect(setViewportMock(harness)).toHaveBeenCalledTimes(1)
  })

  it('capture loss ending a one-finger touch drag drops its touch tracking', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 30, 15, { ...touch, pointerId: 1 })
    harness.fire('pointermove', 50, 35, { ...touch, pointerId: 1 })
    harness.fire('lostpointercapture', 0, 0, { pointerId: 1 })
    // The finger's tracking entry is gone: a later touch is a lone first
    // finger, not the second of a pair.
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 2 })
    expect(harness.controller.dumpPointerTrace()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ gestureKind: 'touch-nav', event: 'start' }),
    ]))
  })

  it('a participant pointercancel ends navigation without committing', () => {
    const harness = interactionHarness(interactionScene())
    harness.controller.enablePointerTrace()
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fire('pointercancel', 200, 100, { pointerType: 'touch', pointerId: 2 })
    harness.fire('pointermove', 150, 150, { ...touch, pointerId: 1 })
    expect(setViewportMock(harness)).not.toHaveBeenCalled()
    expect(harness.controller.dumpPointerTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({ gestureKind: 'touch-nav', event: 'cancel', reason: 'pointercancel-cancel' }),
    ]))
  })

  it('window blur drops all touch tracking; a fresh pair navigates cleanly', () => {
    const harness = interactionHarness(interactionScene())
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 1 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 2 })
    harness.fireWindow('blur')
    harness.fire('pointermove', 150, 150, { ...touch, pointerId: 1 })
    expect(setViewportMock(harness)).not.toHaveBeenCalled()
    // Stale entries were cleared: exactly two fresh touches pair again.
    harness.fire('pointerdown', 100, 100, { ...touch, pointerId: 5 })
    harness.fire('pointerdown', 200, 100, { ...touch, pointerId: 6 })
    harness.fire('pointermove', 300, 100, { ...touch, pointerId: 6 })
    expect(setViewportMock(harness)).toHaveBeenCalledTimes(1)
  })
})
