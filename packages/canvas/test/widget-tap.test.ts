import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeSchema, WorkflowDocument } from '@dinkster/core'
import { InteractionController, type InteractionHost } from '../src/interaction.js'
import { CanvasRenderer, dropTargetKey } from '../src/renderer.js'
import { buildScene, type Scene } from '../src/scene.js'
import { defaultTokens, typeColor } from '../src/tokens.js'

const concrete = (name: string) => ({ kind: 'concrete' as const, name })

function tapScene(options: { linked?: boolean; targetType?: string } = {}): Scene {
  const tap = {
    portId: 'amount', address: { port: 'amount' }, direction: 'out' as const,
    y: 32, type: concrete('FLOAT'), widgetTap: true as const,
  }
  const input = {
    portId: 'value', address: { port: 'value' }, direction: 'in' as const,
    y: 32, type: concrete(options.targetType ?? 'FLOAT'),
  }
  const node = (id: string, x: number, pins: readonly any[]) => ({
    id, x, y: 10, node: { id, type: id, values: {} },
    layout: { width: 100, height: 56, headerHeight: 20, rows: [], pins, title: id },
  })
  return {
    graphId: 'g0', nodes: [node('source', 10, [tap]), node('sink', 200, [input])],
    links: options.linked ? [{
      id: 'l1', from: { kind: 'widgetTap', node: 'source', input: 'amount' },
      to: { kind: 'port', node: 'sink', port: 'value' },
      x1: 110, y1: 42, x2: 200, y2: 42, typeName: 'FLOAT',
    }] : [],
    reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [],
    boundaryNodes: [], diagnostics: [],
  } as unknown as Scene
}

interface PaintCall { method: string; args: unknown[]; fillStyle: string }

function paint(scene: Scene, overlay: Parameters<CanvasRenderer['setOverlay']>[0] = {}): PaintCall[] {
  const calls: PaintCall[] = []
  let fillStyle = ''
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'fillStyle') return fillStyle
      if (prop === 'measureText') return (text: unknown) => ({ width: String(text).length * 6 })
      return (...args: unknown[]) => { calls.push({ method: String(prop), args, fillStyle }) }
    },
    set(_target, prop, value) {
      if (prop === 'fillStyle') fillStyle = String(value)
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  const canvas = {
    getContext: () => ctx, clientWidth: 800, clientHeight: 600, width: 0, height: 0,
  } as unknown as HTMLCanvasElement
  const renderer = new CanvasRenderer(canvas, defaultTokens)
  renderer.setScene(scene)
  renderer.setOverlay(overlay)
  renderer.renderNow()
  renderer.dispose()
  return calls
}

function tapFill(calls: readonly PaintCall[]): PaintCall | undefined {
  const arc = calls.findIndex((c) => c.method === 'arc' && c.args[0] === 110 && c.args[1] === 42 && c.args[2] === defaultTokens.pinRadius)
  return arc < 0 ? undefined : calls.slice(arc + 1).find((c) => c.method === 'fill')
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('Path2D', class Path2D { constructor(readonly d: string) {} })
})

describe('widget tap renderer paint', () => {
  it('does not paint an idle widget tap by default', () => {
    expect(tapFill(paint(tapScene()))).toBeUndefined()
  })

  it('paints a widget tap when a tap-sourced link exists', () => {
    expect(tapFill(paint(tapScene({ linked: true })))).toBeDefined()
  })

  it('paints a widget tap while its node is hovered', () => {
    expect(tapFill(paint(tapScene(), { hoveredNode: 'source' }))).toBeDefined()
  })

  it('paints a compatible widget tap during an input-seeking gesture', () => {
    const targets = new Set([dropTargetKey('source', 'amount', 'out', true)])
    expect(tapFill(paint(tapScene(), { dropTargets: targets }))).toBeDefined()
  })

  it('fills a widget tap with its declared input type color', () => {
    expect(tapFill(paint(tapScene(), { hoveredNode: 'source' }))?.fillStyle)
      .toBe(typeColor(defaultTokens, 'FLOAT'))
  })
})

function interactionHarness(scene: Scene) {
  const listeners = new Map<string, (event: any) => void>()
  const overlays: any[] = []
  const dispatched: any[] = []
  const canvas = {
    style: {}, addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn),
    removeEventListener: () => undefined, setPointerCapture: () => undefined,
    hasPointerCapture: () => true, releasePointerCapture: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLCanvasElement
  const renderer = {
    getScene: () => scene, toWorld: (x: number, y: number) => ({ x, y }),
    getViewport: () => ({ x: 0, y: 0, scale: 1 }), getToolboxLayout: () => undefined,
    getDetailLevel: () => 'controls',
    getBadges: () => ({}), setOverlay: (value: any) => overlays.push(value),
    onSceneReplaced: () => () => undefined,
  } as unknown as CanvasRenderer
  const host: InteractionHost = { dispatch: (value) => { dispatched.push(value); return { ok: true } } }
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('HTMLElement', class {})
  const controller = new InteractionController(canvas, renderer, host)
  const fire = (name: string, x: number, y: number) => listeners.get(name)?.({
    clientX: x, clientY: y, button: 0, pointerId: 1, shiftKey: false, altKey: false,
    ctrlKey: false, metaKey: false, preventDefault: () => undefined,
  })
  return { controller, overlays, dispatched, fire }
}

afterEach(() => vi.unstubAllGlobals())

describe('widget tap interaction', () => {
  it('drags from a revealed widget tap to a compatible input', () => {
    const h = interactionHarness(tapScene())
    h.fire('pointermove', 50, 30)
    h.fire('pointerdown', 110, 42)
    h.fire('pointermove', 200, 42)
    h.fire('pointerup', 200, 42)
    expect(h.dispatched).toContainEqual(expect.objectContaining({
      command: 'link.connect', params: expect.objectContaining({
        from: { node: 'source', tap: 'amount' }, to: { node: 'sink', port: 'value' },
      }),
    }))
  })

  it('drags from an input to a revealed compatible widget tap', () => {
    const h = interactionHarness(tapScene())
    h.fire('pointerdown', 200, 42)
    h.fire('pointermove', 110, 42)
    h.fire('pointerup', 110, 42)
    expect(h.dispatched).toContainEqual(expect.objectContaining({
      command: 'link.connect', params: expect.objectContaining({
        from: { node: 'source', tap: 'amount' }, to: { node: 'sink', port: 'value' },
      }),
    }))
  })

  it('does not include an incompatible widget tap in the target set', () => {
    const h = interactionHarness(tapScene({ targetType: 'IMAGE' }))
    h.fire('pointerdown', 200, 42)
    const targets = h.overlays.at(-1)?.dropTargets as ReadonlySet<string> | undefined
    expect(targets?.has(dropTargetKey('source', 'amount', 'out', true)) ?? false).toBe(false)
  })
})

const widgetSchema: NodeSchema = {
  type: 'Widget', displayName: 'Widget', category: 'test', source: 'v3', isOutputNode: false,
  items: [{
    kind: 'input', id: 'amount', type: concrete('FLOAT'), optional: true,
    widget: { widgetType: 'FLOAT', options: {}, default: 1 },
  }],
}
const sinkSchema: NodeSchema = {
  type: 'Sink', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'value', type: concrete('FLOAT'), optional: false }],
}
const matchType = { kind: 'variable' as const, templateId: 'item_type' }
const createListSchema: NodeSchema = {
  type: 'CreateList', displayName: 'Create List', category: 'test', source: 'v3', isOutputNode: false,
  items: [
    {
      kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'item', type: matchType, optional: false }],
        naming: { kind: 'prefix', prefix: 'items', min: 1, max: 8 },
      },
    },
    { kind: 'output', id: 'list', type: { kind: 'list', element: matchType } },
  ],
}

function builtTapScene(includeSource = true, rerouteCount: 0 | 1 | 2 = 0): Scene {
  const links = rerouteCount === 0
    ? { l1: { id: 'l1', from: { node: 'source', tap: 'amount' }, to: { node: 'sink', port: 'value' } } }
    : rerouteCount === 1
      ? {
          l1: { id: 'l1', from: { node: 'source', tap: 'amount' }, to: { reroute: 'r1' } },
          l2: { id: 'l2', from: { reroute: 'r1' }, to: { node: 'sink', port: 'value' } },
        }
      : {
          l1: { id: 'l1', from: { node: 'source', tap: 'amount' }, to: { reroute: 'r1' } },
          l2: { id: 'l2', from: { reroute: 'r1' }, to: { reroute: 'r2' } },
          l3: { id: 'l3', from: { reroute: 'r2' }, to: { node: 'sink', port: 'value' } },
        }
  const reroutes = rerouteCount === 0
    ? {}
    : rerouteCount === 1
      ? { r1: { id: 'r1' } }
      : { r1: { id: 'r1' }, r2: { id: 'r2' } }
  const document = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'g', nodes: {
      ...(includeSource ? { source: { id: 'source', type: 'Widget', values: { amount: 2 } } } : {}),
      sink: { id: 'sink', type: 'Sink', values: {} },
    }, links, nets: {}, reroutes, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {
      source: { position: { x: 40, y: 50 } }, sink: { position: { x: 400, y: 50 } },
    }, reroutes: {
      ...(rerouteCount >= 1 ? { r1: { position: { x: 180, y: 80 } } } : {}),
      ...(rerouteCount >= 2 ? { r2: { position: { x: 280, y: 80 } } } : {}),
    } } } },
  } as unknown as WorkflowDocument
  return buildScene({
    document, graphId: 'g0', resolve: (type) => type === 'Widget' ? widgetSchema : type === 'Sink' ? sinkSchema : undefined,
    tokens: defaultTokens, measure: (text) => text.length * 6,
    widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
  })
}

describe('widget tap scene links', () => {
  it('anchors a tap-sourced link at the widget row on the node right edge', () => {
    const scene = builtTapScene()
    const source = scene.nodes.find((node) => node.id === 'source')!
    const tap = source.layout.pins.find((pin) => pin.widgetTap === true && pin.portId === 'amount')!
    expect(scene.links[0]).toMatchObject({
      from: { kind: 'widgetTap', node: 'source', input: 'amount' },
      x1: source.x + source.layout.width, y1: source.y + tap.y, typeName: 'FLOAT',
    })
  })

  it('silently omits a tap link whose source node was deleted', () => {
    expect(() => builtTapScene(false)).not.toThrow()
    expect(builtTapScene(false).links).toEqual([])
  })

  it.each([1, 2] as const)('keeps a tap type through %i reroute(s)', (rerouteCount) => {
    const scene = builtTapScene(true, rerouteCount)
    expect(scene.reroutes).toHaveLength(rerouteCount)
    expect(scene.reroutes.every((reroute) => reroute.typeName === 'FLOAT')).toBe(true)
    expect(scene.links).toHaveLength(rerouteCount + 1)
    expect(scene.links.every((link) => link.typeName === 'FLOAT')).toBe(true)
  })

  it('resolves a Create List family and output from a widget output', () => {
    const document = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'g', nodes: {
        source: { id: 'source', type: 'Widget', values: { amount: 2 } },
        list: {
          id: 'list', type: 'CreateList', values: {},
          dynamic: { items: { members: ['m0'], seq: 1 } },
        },
      }, links: {
        l1: {
          id: 'l1',
          from: { node: 'source', tap: 'amount' },
          to: { node: 'list', port: 'items.item', members: ['m0'] },
        },
      }, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 40, y: 50 } }, list: { position: { x: 400, y: 50 } },
      } } } },
    } as unknown as WorkflowDocument
    const scene = buildScene({
      document,
      graphId: 'g0',
      resolve: (type) => type === 'Widget'
        ? widgetSchema
        : type === 'CreateList'
          ? createListSchema
          : undefined,
      tokens: defaultTokens,
      measure: (text) => text.length * 6,
      widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
    })
    const list = scene.nodes.find((node) => node.id === 'list')!
    const connected = list.layout.pins.find((pin) =>
      pin.direction === 'in' && pin.address.members?.[0] === 'm0')!
    const offered = list.layout.pins.find((pin) =>
      pin.direction === 'in' && pin.address.members?.[0] !== 'm0')!
    const output = list.layout.pins.find((pin) => pin.direction === 'out')!
    expect(connected.type).toEqual(concrete('FLOAT'))
    expect(connected.ghost).not.toBe(true)
    expect(offered.type).toEqual(concrete('FLOAT'))
    expect(offered.ghost).toBe(true)
    expect(output.type).toEqual({ kind: 'list', element: concrete('FLOAT') })
    expect(scene.links[0]).toMatchObject({
      from: { kind: 'widgetTap', node: 'source', input: 'amount' },
      to: { kind: 'port', node: 'list', port: 'items.item', members: ['m0'] },
      typeName: 'FLOAT',
    })
    expect(scene.links[0]?.mismatch).not.toBe(true)
  })
})

// Regression: a widget input and a real output can share an id (LoadImage:
// widget input 'image' + output 'image'). The tap pin reuses the input id on
// the 'out' side, so every real-port lookup must exclude widget taps or the
// noodle anchors/types off the widget row instead of the output row.
describe('same-id widget tap vs real output', () => {
  const loadLikeSchema: NodeSchema = {
    type: 'LoadLike', displayName: 'LoadLike', category: 'test', source: 'v3', isOutputNode: false,
    items: [
      {
        kind: 'input', id: 'image', type: concrete('STRING'), optional: false,
        widget: { widgetType: 'STRING', options: {}, default: 'a.png' },
      },
      { kind: 'output', id: 'image', type: concrete('IMAGE') },
    ],
  } as unknown as NodeSchema
  const imageSinkSchema: NodeSchema = {
    type: 'ImageSink', displayName: 'ImageSink', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'pixels', type: concrete('IMAGE'), optional: false }],
  }
  const builtScene = (from: object): Scene => {
    const document = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'g', nodes: {
        source: { id: 'source', type: 'LoadLike', values: {} },
        sink: { id: 'sink', type: 'ImageSink', values: {} },
      }, links: { l1: { id: 'l1', from, to: { node: 'sink', port: 'pixels' } } },
      nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 40, y: 50 } }, sink: { position: { x: 400, y: 50 } },
      } } } },
    } as unknown as WorkflowDocument
    return buildScene({
      document, graphId: 'g0',
      resolve: (type) => type === 'LoadLike' ? loadLikeSchema : type === 'ImageSink' ? imageSinkSchema : undefined,
      tokens: defaultTokens, measure: (text) => text.length * 6,
      widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
    })
  }

  it('anchors a real-output link at the output row, not the same-id widget tap', () => {
    const scene = builtScene({ node: 'source', port: 'image' })
    const source = scene.nodes.find((node) => node.id === 'source')!
    const outPin = source.layout.pins.find((pin) => pin.direction === 'out' && pin.portId === 'image' && pin.widgetTap !== true)!
    const tapPin = source.layout.pins.find((pin) => pin.widgetTap === true && pin.portId === 'image')!
    expect(outPin.y).not.toBe(tapPin.y) // distinct rows or the assertion is vacuous
    expect(scene.links[0]).toMatchObject({
      from: { kind: 'port', node: 'source', port: 'image' },
      x1: source.x + source.layout.width, y1: source.y + outPin.y, typeName: 'IMAGE',
    })
  })

  it('still anchors a tap-sourced link at the widget row', () => {
    const scene = builtScene({ node: 'source', tap: 'image' })
    const source = scene.nodes.find((node) => node.id === 'source')!
    const tapPin = source.layout.pins.find((pin) => pin.widgetTap === true && pin.portId === 'image')!
    expect(scene.links[0]).toMatchObject({
      from: { kind: 'widgetTap', node: 'source', input: 'image' },
      x1: source.x + source.layout.width, y1: source.y + tapPin.y, typeName: 'STRING',
    })
  })
})
