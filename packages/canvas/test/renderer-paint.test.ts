/**
 * Renderer paint regression: drives the REAL CanvasRenderer through its
 * public renderNow() seam with a recording 2D context, proving diagnostic
 * paint reaches the canvas. Scene-side flag derivation (mismatch verdicts,
 * warned pins) is covered in scene.test.ts / dynamic-scene.test.ts; this
 * file owns "given those flags, the right pixels get the right color".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
  documentResolver,
  loadDocument,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  boundarySceneId,
  buildScene,
  GROUP_HEADER_HEIGHT,
  REROUTE_RADIUS,
  REROUTE_SOCKET_OFFSET,
  REROUTE_SOCKET_RADIUS,
  selectorBadgeRect,
  valueSourceBadgeRect,
  VS_BADGE_SIZE,
  type Scene,
  type SceneNode,
} from '../src/scene.js'
import { canvasGridLayer, CanvasRenderer, dropTargetKey, PIN_DIAMOND_SCALE, PIN_SLICE_DIVIDER_SCREEN_PX, previewSurfaceAffordanceRect, rerouteTargetKey, sceneVisualBounds, widgetRowAffordanceRect, type PresenceActor } from '../src/renderer.js'
import {
  BADGE_SIZE,
  badgeRect,
  BYPASSED_BADGE,
  ERROR_BADGE,
  MUTED_BADGE,
  PROBLEM_BLOCKING_WARNING_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  SUBGRAPH_BADGE,
  subgraphBadge,
} from '../src/badges.js'
import { controllerChipRect, controllerChipTextRight } from '../src/controller-chip.js'
import { hitTest } from '../src/hit.js'
import { auditScene } from '../src/scene-audit.js'
import { CANVAS_DETAIL_MIN_SCALE, defaultTokens, presentedType, typeColor, type DesignTokens } from '../src/tokens.js'
import { projectNodeLayoutHeight, widgetChromeRect, withPreviewRegion, type TextMeasurer, type WidgetMeasure } from '../src/layout.js'
import { splitPreviewRect } from '../src/previews.js'
import { TOOLBOX_GAP_FROM_ATTACHED_BADGE } from '../src/toolbox.js'

// The renderer's rAF loop is irrelevant here: renderNow() paints
// synchronously. Stub the scheduler so construction works under node.
beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('Path2D', class Path2D {
    constructor(readonly d: string) {}
  })
  vi.stubGlobal('OffscreenCanvas', class OffscreenCanvas {
    getContext() { return recordingCtx().ctx }
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

interface PaintCall {
  readonly method: string
  readonly args: readonly unknown[]
  readonly strokeStyle: string
  readonly fillStyle: string
  readonly lineWidth: number
  readonly lineCap: CanvasLineCap
  readonly lineDash: readonly number[]
  readonly lineDashOffset: number
  readonly shadowColor: string
  readonly shadowBlur: number
  readonly globalAlpha: number
  readonly font: string
}

/**
 * Proxy-based recording context: the full renderer touches a wide 2D API
 * surface (roundRect, clip, setLineDash, text...), so rather than stubbing
 * each method, record EVERY call with a snapshot of the styles active at
 * call time - which is exactly what would hit the screen. save/restore
 * maintain a real state stack so alpha/style snapshots stay faithful for
 * paths that scope their changes (groups, boundary dashes) - without it a
 * scoped globalAlpha would leak into every later snapshot.
 */
function recordingCtx(): { ctx: CanvasRenderingContext2D; calls: PaintCall[] } {
  const calls: PaintCall[] = []
  let state: Record<string, unknown> = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineDash: [],
    lineDashOffset: 0,
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  }
  const stack: Record<string, unknown>[] = []
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop in state) return state[prop]
      if (prop === 'measureText') return (text: unknown) => ({ width: String(text).length * 6 })
      return (...args: unknown[]) => {
        if (prop === 'save') stack.push({ ...state })
        calls.push({
          method: prop,
          args,
          strokeStyle: String(state.strokeStyle),
          fillStyle: String(state.fillStyle),
          lineWidth: Number(state.lineWidth),
          lineCap: state.lineCap as CanvasLineCap,
          lineDash: state.lineDash as readonly number[],
          lineDashOffset: Number(state.lineDashOffset),
          shadowColor: String(state.shadowColor),
          shadowBlur: Number(state.shadowBlur),
          globalAlpha: Number(state.globalAlpha),
          font: String(state.font),
        })
        if (prop === 'setLineDash') state.lineDash = [...(args[0] as readonly number[])]
        if (prop === 'restore') state = stack.pop() ?? state
        if (prop === 'createPattern') return { toString: () => 'checkerboard' }
        return undefined
      }
    },
    set(_t, prop, value) {
      if (typeof prop === 'string') state[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function fakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  const canvas = {
    getContext: () => ctx,
    clientWidth: 1600,
    clientHeight: 1200,
    width: 0,
    height: 0,
  }
  return canvas as unknown as HTMLCanvasElement
}

function mutableCanvas(ctx: CanvasRenderingContext2D, clientWidth: number, clientHeight: number): {
  canvas: HTMLCanvasElement
  size: { clientWidth: number; clientHeight: number }
  assignments: { width: number; height: number }
} {
  const size = { clientWidth, clientHeight }
  const assignments = { width: 0, height: 0 }
  let width = 0
  let height = 0
  const canvas = {
    getContext: () => ctx,
    get clientWidth() { return size.clientWidth },
    get clientHeight() { return size.clientHeight },
    get width() { return width },
    set width(value: number) { assignments.width += 1; width = value },
    get height() { return height },
    set height(value: number) { assignments.height += 1; height = value },
  }
  return { canvas: canvas as unknown as HTMLCanvasElement, size, assignments }
}

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

// Two producers and two LATENT sinks: link 'bad' (IMAGE -> LATENT) is a
// proven mismatch, link 'good' (LATENT -> LATENT) is healthy.
const typed = (name: string): { kind: 'concrete'; name: string } => ({ kind: 'concrete', name })
const synthetic = new Map<string, NodeSchema>([
  ['PIMG', {
    type: 'PIMG', displayName: 'ImgSrc', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'output', id: 'out', type: typed('IMAGE') }],
  }],
  ['PLAT', {
    type: 'PLAT', displayName: 'LatSrc', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'output', id: 'out', type: typed('LATENT') }],
  }],
  ['dinkster.string_to_combo', {
    type: 'dinkster.string_to_combo', displayName: 'Convert String to Combo', category: 'string', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'string', type: typed('core.string'), optional: false },
      { kind: 'output', id: 'choice', type: typed('core.combo') },
    ],
  }],
  ['dinkster.combo_to_string', {
    type: 'dinkster.combo_to_string', displayName: 'Convert Combo to String', category: 'string', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'choice', type: typed('core.combo'), optional: false },
      { kind: 'output', id: 'text', type: typed('core.string') },
    ],
  }],
  ['SinkLatent', {
    type: 'SinkLatent', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'in', type: typed('LATENT'), optional: false }],
  }],
  ['SinkOpt', {
    type: 'SinkOpt', displayName: 'OptSink', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'in', type: typed('LATENT'), optional: true }],
  }],
  ['FSink', {
    type: 'FSink', displayName: 'FloatSink', category: 'test', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'f', type: typed('FLOAT'), optional: true,
      widget: { widgetType: 'FLOAT', options: {}, default: 1 },
    }],
  }],
  // Nested-only autogrow template: the trailing ghost renders nothing, so
  // the node carries a growth affordance row instead (dynamic-scene tests
  // prove the derivation; here we pin its paint).
  ['PNest', {
    type: 'PNest', displayName: 'PureNest', category: 'test', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [{
          kind: 'input', id: 'sub', type: typed('IMAGE'), optional: true,
          dynamic: {
            kind: 'autogrow',
            template: [{ kind: 'input', id: 's', type: typed('IMAGE'), optional: true }],
            naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 4 },
          },
        }],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 5 },
      },
    }],
  }],
])

function fixtureScene(kind: 'withMismatch' | 'clean' = 'withMismatch'): Scene {
  const doc: WorkflowDocument = {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'g',
        nodes: {
          img: { id: asNodeId('img'), type: 'PIMG', values: {} },
          lat: { id: asNodeId('lat'), type: 'PLAT', values: {} },
          c1: { id: asNodeId('c1'), type: 'SinkLatent', values: {} },
          c2: { id: asNodeId('c2'), type: 'SinkLatent', values: {} },
        },
        links: {
          ...(kind === 'withMismatch'
            ? { bad: { id: asLinkId('bad'), from: { node: asNodeId('img'), port: asPortId('out') }, to: { node: asNodeId('c1'), port: asPortId('in') } } }
            : {}),
          good: { id: asLinkId('good'), from: { node: asNodeId('lat'), port: asPortId('out') }, to: { node: asNodeId('c2'), port: asPortId('in') } },
        },
        nets: {},
        reroutes: {},
        nextOrdinal: 100,
      },
    },
    view: {
      graphs: {
        g0: {
          nodes: {
            img: { position: { x: 40, y: 40 } },
            lat: { position: { x: 40, y: 240 } },
            c1: { position: { x: 420, y: 40 } },
            c2: { position: { x: 420, y: 240 } },
          },
        },
      },
    },
  }
  return buildScene({
    document: doc,
    graphId: 'g0',
    resolve: (t) => synthetic.get(t),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

function comboRerouteScene(): Scene {
  const doc: WorkflowDocument = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('combo-reroute'), root: asGraphDefId('g0'),
    graphs: { g0: {
      id: asGraphDefId('g0'), name: 'combo reroute',
      nodes: {
        src: { id: asNodeId('src'), type: 'dinkster.string_to_combo', values: {} },
        sink: { id: asNodeId('sink'), type: 'dinkster.combo_to_string', values: {} },
      },
      links: {
        into: {
          id: asLinkId('into'), from: { node: asNodeId('src'), port: asPortId('choice') },
          to: { reroute: asRerouteId('r1') },
        },
        out: {
          id: asLinkId('out'), from: { reroute: asRerouteId('r1') },
          to: { node: asNodeId('sink'), port: asPortId('choice') },
        },
      },
      nets: {}, reroutes: { r1: { id: asRerouteId('r1') } }, nextOrdinal: 10,
    } },
    view: { graphs: { g0: {
      nodes: { src: { position: { x: 40, y: 40 } }, sink: { position: { x: 500, y: 40 } } },
      reroutes: { r1: { position: { x: 300, y: 100 } } },
    } } },
  }
  return buildScene({
    document: doc, graphId: 'g0', resolve: (type) => synthetic.get(type),
    tokens: defaultTokens, measure, widgetMeasure,
  })
}

function paintWithTokens(scene: Scene, tokens: DesignTokens, setup?: (r: CanvasRenderer) => void): PaintCall[] {
  const { ctx, calls } = recordingCtx()
  const renderer = new CanvasRenderer(fakeCanvas(ctx), tokens)
  renderer.setScene(scene)
  setup?.(renderer)
  renderer.renderNow()
  renderer.dispose()
  return calls
}

const paintWith = (scene: Scene, setup?: (r: CanvasRenderer) => void): PaintCall[] =>
  paintWithTokens(scene, defaultTokens, setup)

const paint = (scene: Scene): PaintCall[] => paintWith(scene)

const emptyScene = (parts: Partial<Scene> = {}): Scene => ({
  graphId: 'bounds', nodes: [], links: [], reroutes: [], valueSources: [], selectors: [],
  netStubs: [], groups: [], boundaryNodes: [], diagnostics: [], ...parts,
})

describe('expanded section enclosure', () => {
  it('paints a continuous tint and dark border without an accent rail', () => {
    const base = fixtureScene('clean')
    const source = base.nodes[0]!
    const scene: Scene = {
      ...base,
      nodes: [{
        ...source,
        layout: { ...source.layout, advancedGroup: { y: 28, height: 72 } },
      }],
      links: [],
    }
    const calls = paint(scene)
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'fillRect', args: [source.x, source.y + 28, source.layout.width, 72], fillStyle: 'rgba(255, 255, 255, 0.035)' }),
      expect.objectContaining({ method: 'strokeRect', args: [source.x + 0.5, source.y + 28.5, source.layout.width - 1, 71] }),
    ]))
    expect(calls).not.toContainEqual(expect.objectContaining({
      method: 'fillRect',
      args: [source.x + 1, source.y + 29, 3, 70],
      fillStyle: defaultTokens.colors.selection,
    }))
  })
})

const typedLensLink = (
  id: string,
  typeName: string,
  x1 = 100,
  y1 = 100,
  x2 = 200,
  y2 = 100,
): Scene['links'][number] => ({
  id,
  from: { kind: 'reroute', reroute: `${id}-from` },
  to: { kind: 'reroute', reroute: `${id}-to` },
  x1,
  y1,
  x2,
  y2,
  typeName,
})

describe('typed overview detail', () => {
  it('switches painted text and link controls at the shared detail boundary', () => {
    const scene = fixtureScene('clean')
    const node = scene.nodes[0]!
    const link = scene.links[0]!
    for (const [scale, contentDetail] of [[0.49, false], [0.5, true]] as const) {
      const calls = paintWith(scene, (renderer) => renderer.setViewport({ x: 0, y: 0, scale }))
      expect(calls.some((call) => call.method === 'fillText' && call.args[0] === node.layout.title)).toBe(contentDetail)
      expect(calls.some((call) =>
        call.method === 'arc' &&
        call.args[0] === (link.x1 + link.x2) / 2 &&
        call.args[1] === (link.y1 + link.y2) / 2 &&
        call.args[2] === 3.5,
      )).toBe(contentDetail)
    }
  })

  it('omits text controls while retaining screen-sized structure, type, state, and selection cues', () => {
    const scene = fixtureScene('clean')
    const selected = scene.nodes.find((node) => node.id === 'c1')!
    const pending = scene.nodes.find((node) => node.id === 'c2')!
    const scale = 0.1
    const calls = paintWith(scene, (renderer) => {
      renderer.setViewport({ x: 0, y: 0, scale })
      renderer.setNodeStates({ c1: { state: 'error' }, c2: { state: 'pending' } })
      renderer.setOverlay({ selection: new Set([selected.id]) })
    })

    for (const node of scene.nodes) {
      expect(calls).not.toContainEqual(expect.objectContaining({ method: 'fillText', args: expect.arrayContaining([node.layout.title]) }))
    }
    for (const link of scene.links) {
      expect(calls).not.toContainEqual(expect.objectContaining({
        method: 'arc',
        args: [(link.x1 + link.x2) / 2, (link.y1 + link.y2) / 2, 3.5, 0, Math.PI * 2],
      }))
    }
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'stroke', strokeStyle: defaultTokens.colors.nodeOutline, lineWidth: 1 / scale,
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'arc', args: expect.arrayContaining([2 / scale]),
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'stroke', strokeStyle: defaultTokens.stateColors.error, lineWidth: 2 / scale,
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'stroke', strokeStyle: defaultTokens.colors.nodeSelectedBorder, lineWidth: 2 / scale,
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'setLineDash', args: [[4 / scale, 2 / scale]],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'setLineDash', args: [[2 / scale, 3 / scale]],
    }))
    expect(pending.layout.rows.length).toBeGreaterThan(0)
  })

  it('adds non-color line styles for execution and mode state', () => {
    const base = fixtureScene('clean')
    const node = base.nodes[0]!
    const scene = { ...base, nodes: [node], links: [] }
    for (const [state, dash] of [
      ['pending', [2, 3]],
      ['cached', [7, 3]],
      ['skipped', [2, 4]],
      ['error', [4, 2]],
    ] as const) {
      const calls = paintWith(scene, (renderer) => renderer.setNodeStates({ [node.id]: { state } }))
      expect(calls).toContainEqual(expect.objectContaining({ method: 'setLineDash', args: [dash] }))
    }
    for (const [mode, dash] of [
      ['muted', [2, 3]],
      ['bypassed', [8, 3]],
    ] as const) {
      const modeScene = {
        ...scene,
        nodes: [{ ...node, node: { ...node.node, mode } }],
      }
      expect(paint(modeScene)).toContainEqual(expect.objectContaining({ method: 'setLineDash', args: [dash] }))
    }
    expect(nodeBorder(
      paintWith(scene, (renderer) => renderer.setNodeStates({ [node.id]: { state: 'done' } })),
      node,
    )?.lineWidth).toBe(2.5)
  })
})

describe('armed placement ghost', () => {
  it('paints the pending node after the scene at 60 percent alpha with its display name', () => {
    const scene = fixtureScene('clean')
    const calls = paintWith(scene, (renderer) => renderer.setOverlay({
      placementGhost: { x: 100, y: 120, width: 180, height: 88, title: 'KSampler' },
    }))
    const bodyIndex = calls.findIndex((call) => call.method === 'roundRect' && call.args[0] === 100 && call.args[1] === 120 && call.args[2] === 180 && call.args[3] === 88)
    const sceneNodeIndex = calls.findIndex((call) => call.method === 'roundRect' && call.args[0] === scene.nodes[0]?.x && call.args[1] === scene.nodes[0]?.y)
    const body = calls[bodyIndex]
    const title = calls.find((call) => call.method === 'fillText' && call.args[0] === 'KSampler')
    expect(bodyIndex).toBeGreaterThan(sceneNodeIndex)
    expect(body?.globalAlpha).toBeCloseTo(0.6)
    expect(title?.globalAlpha).toBeCloseTo(0.6)
  })
})

describe('canvas hover affordance paint', () => {
  const hoverScene = (): Scene => emptyScene({
    nodes: [{
      id: 'hover-node',
      x: 100,
      y: 100,
      node: { id: 'hover-node', type: 'Hover', values: { amount: 1 } },
      layout: {
        width: 140,
        height: 68,
        headerHeight: 20,
        title: 'Hover',
        rows: [{
          kind: 'widget', inputId: 'amount', valueKey: 'amount', label: 'amount',
          y: 20, height: 24, inset: 9.5, spec: { widgetType: 'FLOAT', options: {} },
        }],
        pins: [
          { portId: 'in', address: { port: 'in' }, direction: 'in', y: 56, type: typed('FLOAT') },
          { portId: 'out', address: { port: 'out' }, direction: 'out', y: 56, type: typed('IMAGE') },
        ],
      },
    } as unknown as SceneNode],
  })

  it('enlarges only the hovered node pin to 1.35 times its base radius', () => {
    const scene = hoverScene()
    const calls = paintWith(scene, (renderer) => renderer.setOverlay({
      hoveredPin: { nodeId: 'hover-node', portId: 'in', direction: 'in' },
    }))
    const hovered = calls.find((call) =>
      call.method === 'arc' && call.args[0] === 100 && call.args[1] === 156 &&
      call.args[2] === defaultTokens.pinRadius * 1.35,
    )
    const ordinary = calls.find((call) =>
      call.method === 'arc' && call.args[0] === 240 && call.args[1] === 156 &&
      call.args[2] === defaultTokens.pinRadius,
    )
    expect(hovered).toBeDefined()
    expect(ordinary).toBeDefined()
  })

  it('enlarges every shared match pin when one is hovered or keyboard-focused', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const matchScene: Scene = {
      ...scene,
      nodes: [{
        ...node,
        layout: {
          ...node.layout,
          pins: node.layout.pins.map((pin) => ({ ...pin, matchVariable: 'T' })),
        },
      }],
    }
    const assertAssociated = (calls: readonly PaintCall[]) => {
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'arc', args: [100, 156, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
      }))
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'arc', args: [240, 156, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
      }))
    }
    assertAssociated(paintWith(matchScene, (renderer) => renderer.setOverlay({
      hoveredPin: { nodeId: 'hover-node', portId: 'in', direction: 'in' },
    })))
    assertAssociated(paintWith(matchScene, (renderer) => renderer.setOverlay({
      focusedPin: { nodeId: 'hover-node', portId: 'out', direction: 'out' },
    })))
  })

  it('keeps focused match peers enlarged while an unrelated pin is hovered', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const matchScene: Scene = {
      ...scene,
      nodes: [{
        ...node,
        layout: {
          ...node.layout,
          pins: [
            { ...node.layout.pins[0]!, matchVariable: 'Hovered' },
            { ...node.layout.pins[1]!, matchVariable: 'Focused' },
            { ...node.layout.pins[0]!, portId: 'focused-peer', y: 32, matchVariable: 'Focused' },
          ],
        },
      }],
    }
    const calls = paintWith(matchScene, (renderer) => renderer.setOverlay({
      hoveredPin: { nodeId: 'hover-node', portId: 'in', direction: 'in' },
      focusedPin: { nodeId: 'hover-node', portId: 'out', direction: 'out' },
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'arc', args: [100, 132, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
    }))
  })

  it('does not enlarge a same-id widget tap when the real output is keyboard-focused', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const withTap = {
      ...scene,
      nodes: [{
        ...node,
        layout: {
          ...node.layout,
          pins: [
            ...node.layout.pins,
            { portId: 'out', address: { port: 'out' }, direction: 'out' as const, y: 32, type: typed('IMAGE'), widgetTap: true as const },
          ],
        },
      }],
    }
    const calls = paintWith(withTap, (renderer) => renderer.setOverlay({
      hoveredNode: 'hover-node',
      focusedPin: { nodeId: 'hover-node', portId: 'out', direction: 'out' },
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'arc', args: [240, 156, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'arc', args: [240, 132, defaultTokens.pinRadius, 0, Math.PI * 2],
    }))
    expect(calls).not.toContainEqual(expect.objectContaining({
      method: 'arc', args: [240, 132, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
    }))
  })

  it('enlarges a hovered widget tap to 1.35 times its base radius without enlarging the same-id real output', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const withTap = {
      ...scene,
      nodes: [{
        ...node,
        layout: {
          ...node.layout,
          pins: [
            ...node.layout.pins,
            { portId: 'out', address: { port: 'out' }, direction: 'out' as const, y: 32, type: typed('IMAGE'), widgetTap: true as const },
          ],
        },
      }],
    }
    const calls = paintWith(withTap, (renderer) => renderer.setOverlay({
      hoveredNode: 'hover-node',
      hoveredPin: { nodeId: 'hover-node', portId: 'out', direction: 'out', widgetTap: true },
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'arc', args: [240, 132, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'arc', args: [240, 156, defaultTokens.pinRadius, 0, Math.PI * 2],
    }))
    expect(calls).not.toContainEqual(expect.objectContaining({
      method: 'arc', args: [240, 156, defaultTokens.pinRadius * 1.35, 0, Math.PI * 2],
    }))
  })

  it('keeps a hovered diamond diagnostic ring outside the enlarged glyph', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const listType = { kind: 'list' as const, element: typed('IMAGE') }
    const withDiamond: Scene = {
      ...scene,
      nodes: [{
        ...node,
        layout: {
          ...node.layout,
          pins: node.layout.pins.map((pin) => pin.portId === 'in' ? { ...pin, type: listType, warn: true as const } : pin),
        },
      }],
    }
    const calls = paintWith(withDiamond, (renderer) => renderer.setOverlay({
      hoveredPin: { nodeId: 'hover-node', portId: 'in', direction: 'in' },
    }))
    const vertexRadius = defaultTokens.pinRadius * 1.35 * PIN_DIAMOND_SCALE
    const ringRadius = defaultTokens.pinRadius + 3.5 +
      (defaultTokens.pinRadius * 1.35 - defaultTokens.pinRadius) * PIN_DIAMOND_SCALE
    expect(ringRadius).toBeGreaterThan(vertexRadius)
    const ring = calls.findIndex((call) =>
      call.method === 'arc' && call.args[0] === 100 && call.args[1] === 156 && call.args[2] === ringRadius,
    )
    expect(ring).toBeGreaterThanOrEqual(0)
    expect(calls.slice(ring + 1).find((call) => call.method === 'stroke'))
      .toMatchObject({ strokeStyle: defaultTokens.colors.error })
  })

  it('keeps an associated scalar-list ghost and diagnostic ring at square geometry', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const variable = { kind: 'variable' as const, templateId: 'T' }
    const withScalarListGhost: Scene = {
      ...scene,
      nodes: [{
        ...node,
        layout: {
          ...node.layout,
          pins: node.layout.pins.map((pin) => ({
            ...pin,
            type: variable,
            matchVariable: 'T',
            ...(pin.direction === 'in' ? { ghost: true as const, warn: true as const } : {}),
          })),
        },
      }],
    }
    const calls = paintWith(withScalarListGhost, (renderer) => renderer.setOverlay({
      hoveredPin: { nodeId: 'hover-node', portId: 'out', direction: 'out' },
    }))
    const radius = defaultTokens.pinRadius * 1.35
    const normalCornerGap = defaultTokens.pinRadius + 3.5 - Math.SQRT2 * defaultTokens.pinRadius
    const ringRadius = Math.SQRT2 * radius + normalCornerGap
    expect(ringRadius - Math.SQRT2 * radius).toBeCloseTo(normalCornerGap)
    const ring = calls.findIndex((call) =>
      call.method === 'arc' && call.args[0] === 100 && call.args[1] === 156 && call.args[2] === ringRadius,
    )
    expect(ring).toBeGreaterThanOrEqual(0)
    expect(calls.slice(ring + 1).find((call) => call.method === 'stroke'))
      .toMatchObject({ strokeStyle: defaultTokens.colors.error })
    const circle = calls.findIndex((call, index) => index > ring &&
      call.method === 'arc' && call.args[0] === 100 && call.args[1] === 156 && call.args[2] === radius)
    expect(circle).toBeGreaterThan(ring)
    expect(calls.slice(circle).some((call) =>
      call.method === 'moveTo' && call.args[0] === 100 - radius && call.args[1] === 156 - radius)).toBe(true)
    expect(calls.slice(circle).some((call) =>
      call.method === 'lineTo' && call.args[0] === 100 + radius && call.args[1] === 156 - radius)).toBe(true)
    expect(calls.slice(circle).some((call) =>
      call.method === 'lineTo' && call.args[0] === 100 + radius && call.args[1] === 156 + radius)).toBe(true)
    expect(calls.slice(circle).some((call) =>
      call.method === 'lineTo' && call.args[0] === 100 - radius && call.args[1] === 156 + radius)).toBe(true)
    const ghostPaint = calls.slice(circle).find((call) => call.method === 'stroke' || call.method === 'fill')
    expect(ghostPaint?.method).toBe('stroke')
    expect(ghostPaint?.globalAlpha).toBeCloseTo(0.45)
  })

  it('paints numeric minus and plus strokes for INT and FLOAT without filled triangle paths', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const floatRow = node.layout.rows[0]!
    const intRow = {
      ...floatRow,
      inputId: 'count', valueKey: 'count', label: 'count',
      y: 44, spec: { widgetType: 'INT' as const, options: {} },
    }
    const numericScene = {
      ...scene,
      nodes: [{
        ...node,
        node: { ...node.node, values: { amount: 1, count: 2 } },
        layout: { ...node.layout, height: 92, rows: [floatRow, intRow] },
      }],
    }
    const calls = paint(numericScene)
    const line = (from: readonly [number, number], to: readonly [number, number]) => {
      const start = calls.findIndex((call) => call.method === 'moveTo' && call.args[0] === from[0] && call.args[1] === from[1])
      expect(start).toBeGreaterThanOrEqual(0)
      expect(calls.slice(start + 1).find((call) => call.method === 'lineTo')).toEqual(expect.objectContaining({ args: to }))
      const stroke = calls.slice(start + 1).find((call) => call.method === 'stroke')
      expect(stroke).toEqual(expect.objectContaining({
        strokeStyle: defaultTokens.colors.label,
        lineWidth: 1.5,
        lineCap: 'round',
      }))
      expect(calls.slice(start + 1, calls.indexOf(stroke!))).not.toContainEqual(expect.objectContaining({ method: 'closePath' }))
      expect(calls.slice(start + 1, calls.indexOf(stroke!))).not.toContainEqual(expect.objectContaining({ method: 'fill' }))
    }
    for (const cy of [132, 156]) {
      line([112.5, cy], [118.5, cy])
      line([221.5, cy], [227.5, cy])
      line([224.5, cy - 3], [224.5, cy + 3])
      // Reject every non-tip vertex of both former filled triangles. This
      // covers each numeric row even if an implementation also paints the
      // new strokes before or after a stale triangle path.
      expect(calls).not.toContainEqual(expect.objectContaining({ method: 'lineTo', args: [118.5, cy - 4] }))
      expect(calls).not.toContainEqual(expect.objectContaining({ method: 'lineTo', args: [118.5, cy + 4] }))
      expect(calls).not.toContainEqual(expect.objectContaining({ method: 'lineTo', args: [221.5, cy - 4] }))
      expect(calls).not.toContainEqual(expect.objectContaining({ method: 'lineTo', args: [221.5, cy + 4] }))
    }
  })

  it('paints hover and diagnostic states on the numeric widget chrome path', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const row = node.layout.rows[0]!
    const markedController = {
      ...scene,
      nodes: [{ ...node, layout: { ...node.layout, rows: [{ ...row, controllerMode: 'fixed' as const }] } }],
    }
    const calls = paintWith(markedController, (renderer) => {
      renderer.setOverlay({ hoveredWidget: { nodeId: 'hover-node', valueKey: 'amount' } })
      renderer.setRowMarks({ 'hover-node': new Set(['amount']) })
    })
    const washPath = calls.findIndex((call) =>
      call.method === 'roundRect' && call.args[0] === 109.5 && call.args[1] === 122 &&
      call.fillStyle === defaultTokens.colors.label && call.globalAlpha === 0.12,
    )
    expect(calls[washPath]).toEqual(expect.objectContaining({
      method: 'roundRect',
      args: [109.5, 122, 121, defaultTokens.rowHeight - 4, 4],
      fillStyle: defaultTokens.colors.label,
      globalAlpha: 0.12,
    }))
    expect(calls[washPath - 1]?.method).toBe('beginPath')
    const wash = washPath + 1
    expect(calls[wash]).toEqual(expect.objectContaining({
      method: 'fill',
      fillStyle: defaultTokens.colors.label,
      globalAlpha: 0.12,
    }))
    expect(calls).not.toContainEqual(expect.objectContaining({
      method: 'fillRect',
      args: [109.5, 120, 121, defaultTokens.rowHeight],
      fillStyle: defaultTokens.colors.label,
      globalAlpha: 0.12,
    }))
    const diagnosticPath = calls.findIndex((call) =>
      call.method === 'roundRect' && call.args[0] === 109.5 && call.args[1] === 122 &&
      call.strokeStyle === defaultTokens.colors.error,
    )
    expect(calls[diagnosticPath]).toEqual(expect.objectContaining({
      args: [109.5, 122, 121, defaultTokens.rowHeight - 4, 4],
      lineWidth: 1.5,
      globalAlpha: 1,
    }))
    expect(calls[diagnosticPath - 1]?.method).toBe('beginPath')
    const diagnostic = diagnosticPath + 1
    expect(calls[diagnostic]).toEqual(expect.objectContaining({
      method: 'stroke',
      strokeStyle: defaultTokens.colors.error,
      lineWidth: 1.5,
      globalAlpha: 1,
    }))
    const controller = calls.findIndex((call, index) =>
      index > wash && call.method === 'strokeRect' && call.strokeStyle === defaultTokens.colors.selection,
    )
    expect(diagnostic).toBeGreaterThan(wash)
    expect(controller).toBeGreaterThan(wash)
    expect(calls[controller]?.globalAlpha).toBe(1)
  })

  it('wraps the full multiline widget chrome after row-height reflow without overhang', () => {
    const scene = hoverScene()
    const node = scene.nodes[0]!
    const row = node.layout.rows[0]!
    const multiline = {
      ...scene,
      nodes: [{
        ...node,
        node: { ...node.node, values: { text: 'first\nsecond' } },
        layout: {
          ...node.layout,
          height: 120,
          minWidth: 140,
          minHeight: 120,
          headerHeight: 20,
          rows: [{
            ...row,
            inputId: 'text', valueKey: 'text', label: 'text', height: 76,
            viewId: 'core.text', rows: 2,
            spec: { widgetType: 'STRING' as const, options: {}, multiline: true },
          }],
        },
      }],
    }
    for (const [height, resizeHeight] of [[76, undefined], [98, 144]] as const) {
      const calls = paintWith(multiline, (renderer) => {
        renderer.setOverlay({
          hoveredWidget: { nodeId: 'hover-node', valueKey: 'text' },
          ...(resizeHeight === undefined ? {} : {
            resizePreview: {
              nodeId: 'hover-node', x: node.x, y: node.y,
              width: node.layout.width, height: resizeHeight,
            },
          }),
        })
        renderer.setRowMarks({ 'hover-node': new Set(['text']) })
      })
      const chrome = [109.5, 122, 121, height - 4, 4]
      const hoverPath = calls.findIndex((call) =>
        call.method === 'roundRect' && call.args.every((arg, index) => arg === chrome[index]) &&
        call.fillStyle === defaultTokens.colors.label && call.globalAlpha === 0.12,
      )
      expect(hoverPath).toBeGreaterThanOrEqual(0)
      expect(calls[hoverPath - 1]?.method).toBe('beginPath')
      expect(calls[hoverPath + 1]).toEqual(expect.objectContaining({
        method: 'fill', fillStyle: defaultTokens.colors.label, globalAlpha: 0.12,
      }))
      const diagnosticPath = calls.findIndex((call) =>
        call.method === 'roundRect' && call.args.every((arg, index) => arg === chrome[index]) &&
        call.strokeStyle === defaultTokens.colors.error && call.lineWidth === 1.5,
      )
      expect(diagnosticPath).toBeGreaterThanOrEqual(0)
      expect(calls[diagnosticPath - 1]?.method).toBe('beginPath')
      expect(calls[diagnosticPath + 1]).toEqual(expect.objectContaining({
        method: 'stroke', strokeStyle: defaultTokens.colors.error, lineWidth: 1.5, globalAlpha: 1,
      }))
      expect(calls).not.toContainEqual(expect.objectContaining({
        method: 'fillRect', args: [109.5, 120, 121, height],
        fillStyle: defaultTokens.colors.label, globalAlpha: 0.12,
      }))
    }
  })
})

describe('link midpoint affordance', () => {
  it('enlarges and highlights the hovered midpoint handle', () => {
    const scene = emptyScene({
      links: [{
        id: 'link-hover',
        from: { kind: 'port', node: 'a', port: 'out' },
        to: { kind: 'port', node: 'b', port: 'in' },
        x1: 100, y1: 100, x2: 300, y2: 100,
      }],
    } as Partial<Scene>)
    const calls = paintWith(scene, (renderer) => renderer.setOverlay({ hoveredLinkMidpoint: 'link-hover' }))
    const arc = calls.find((call) =>
      call.method === 'arc' && call.args[0] === 200 && call.args[1] === 100 && call.args[2] === 5,
    )
    expect(arc).toBeDefined()
    const stroke = calls.slice(calls.indexOf(arc!) + 1).find((call) => call.method === 'stroke')
    expect(stroke).toMatchObject({ strokeStyle: defaultTokens.colors.dropTarget, lineWidth: 1.5 })
  })

  it('paints no midpoint dot on a net delivery noodle, only its name label', () => {
    const scene = emptyScene({
      links: [{
        id: 'net100:0',
        netId: 'net100',
        netName: 'latents',
        from: { kind: 'port', node: 'a', port: 'out' },
        to: { kind: 'port', node: 'b', port: 'in' },
        x1: 100, y1: 100, x2: 300, y2: 100,
      }],
    } as Partial<Scene>)
    const calls = paint(scene)
    // No dot arc at the midpoint at either the idle or hovered radius.
    expect(calls.some((call) =>
      call.method === 'arc' && call.args[0] === 200 && call.args[1] === 100 &&
      (call.args[2] === 3.5 || call.args[2] === 5),
    )).toBe(false)
    // The name label still marks the midpoint.
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'latents')).toBe(true)
  })
})

describe('renderer sizing and scene replacement', () => {
  it('keeps the rounded fractional-DPR backing store stable across renders', () => {
    const previous = globalThis.devicePixelRatio
    vi.stubGlobal('devicePixelRatio', 1.25)
    try {
      const { ctx } = recordingCtx()
      const tracked = mutableCanvas(ctx, 801, 601)
      const renderer = new CanvasRenderer(tracked.canvas, defaultTokens)
      renderer.renderNow()
      expect(tracked.canvas.width).toBe(Math.round(801 * 1.25))
      expect(tracked.canvas.height).toBe(Math.round(601 * 1.25))
      expect(Number.isInteger(tracked.canvas.width)).toBe(true)
      expect(Number.isInteger(tracked.canvas.height)).toBe(true)
      renderer.renderNow()
      expect(tracked.assignments).toEqual({ width: 1, height: 1 })
      renderer.dispose()
    } finally {
      vi.stubGlobal('devicePixelRatio', previous)
    }
  })

  it('skips a zero-size canvas and resumes painting after it expands', () => {
    const { ctx, calls } = recordingCtx()
    const tracked = mutableCanvas(ctx, 0, 601)
    const renderer = new CanvasRenderer(tracked.canvas, defaultTokens)
    renderer.renderNow()
    expect(calls).toEqual([])
    expect(tracked.assignments.width).toBe(0)
    tracked.size.clientWidth = 801
    tracked.size.clientHeight = 601
    renderer.renderNow()
    expect(calls.length).toBeGreaterThan(0)
    expect(tracked.assignments).toEqual({ width: 1, height: 1 })
    renderer.dispose()
  })

  it('maps CSS dimensions to the rounded backing store rather than raw DPR', () => {
    const previous = globalThis.devicePixelRatio
    vi.stubGlobal('devicePixelRatio', 1.25)
    try {
      const { ctx, calls } = recordingCtx()
      const tracked = mutableCanvas(ctx, 801, 601)
      const renderer = new CanvasRenderer(tracked.canvas, defaultTokens)
      renderer.renderNow()
      const transform = calls.find((call) => call.method === 'setTransform')!
      expect(transform.args[0]).toBeCloseTo(Math.round(801 * 1.25) / 801)
      expect(transform.args[3]).toBeCloseTo(Math.round(601 * 1.25) / 601)
      expect(transform.args[0]).not.toBe(1.25)
      renderer.dispose()
    } finally {
      vi.stubGlobal('devicePixelRatio', previous)
    }
  })

  it('notifies scene replacement after installation and honors unsubscribe and dispose', () => {
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    const first = emptyScene({ graphId: 'first' })
    const second = emptyScene({ graphId: 'second' })
    const observed: Scene[] = []
    const unsubscribe = renderer.onSceneReplaced((scene) => {
      expect(renderer.getScene()).toBe(scene)
      observed.push(scene)
    })
    renderer.setScene(first)
    unsubscribe()
    renderer.setScene(second)
    expect(observed).toEqual([first])
    renderer.onSceneReplaced((scene) => observed.push(scene))
    renderer.dispose()
    renderer.setScene(first)
    expect(observed).toEqual([first])
  })

  it('FR6 dispose drops viewport listeners', () => {
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    const listener = vi.fn()
    renderer.onViewportChange(listener)
    renderer.dispose()
    renderer.setViewport({ x: 10, y: 20, scale: 2 })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('scene visual bounds and fitting', () => {
  const base = fixtureScene('clean')
  const node = base.nodes[0]!

  it('returns undefined for an empty scene and the exact rect for one node', () => {
    expect(sceneVisualBounds(emptyScene())).toBeUndefined()
    expect(sceneVisualBounds(emptyScene({ nodes: [node] }))).toEqual({
      minX: node.x, minY: node.y, maxX: node.x + node.layout.width, maxY: node.y + node.layout.height,
    })
  })

  it('includes reroutes, groups, value sources, selectors, net stubs, and boundary nodes', () => {
    const reroute = { id: 'r', x: -100, y: 50 }
    const group = { id: 'g', title: 'g', x: 10, y: -80, width: 900, height: 700 }
    const valueSource = { x: 950, y: 10, width: 20, height: 20 }
    const selector = { x: 20, y: 750, width: 30, height: 40 }
    const netStub = { x: 1000, y: 800, width: 50, height: 10 }
    const boundary = { ...base.nodes[1]!, side: 'inputs' as const }
    expect(sceneVisualBounds(emptyScene({ reroutes: [reroute] }))).toEqual({
      minX: -100 - REROUTE_RADIUS, minY: 50 - REROUTE_RADIUS,
      maxX: -100 + REROUTE_RADIUS, maxY: 50 + REROUTE_RADIUS,
    })
    expect(sceneVisualBounds(emptyScene({ groups: [group] }))).toEqual({ minX: 10, minY: -80, maxX: 910, maxY: 620 })
    expect(sceneVisualBounds(emptyScene({ valueSources: [valueSource as Scene['valueSources'][number]] })))
      .toEqual({ minX: 950, minY: 10, maxX: 970, maxY: 30 })
    expect(sceneVisualBounds(emptyScene({ selectors: [selector as Scene['selectors'][number]] })))
      .toEqual({ minX: 20, minY: 750, maxX: 50, maxY: 790 })
    expect(sceneVisualBounds(emptyScene({ netStubs: [netStub as Scene['netStubs'][number]] })))
      .toEqual({ minX: 1000, minY: 800, maxX: 1050, maxY: 810 })
    expect(sceneVisualBounds(emptyScene({ boundaryNodes: [boundary] }))).toEqual({
      minX: boundary.x, minY: boundary.y,
      maxX: boundary.x + boundary.layout.width, maxY: boundary.y + boundary.layout.height,
    })
    const bounds = sceneVisualBounds(emptyScene({
      reroutes: [reroute], groups: [group], valueSources: [valueSource as Scene['valueSources'][number]],
      selectors: [selector as Scene['selectors'][number]], netStubs: [netStub as Scene['netStubs'][number]],
      boundaryNodes: [boundary],
    }))!
    expect(bounds).toEqual({ minX: -100 - REROUTE_RADIUS, minY: -80, maxX: 1050, maxY: 810 })
  })

  it('includes a reverse link control-hull bulge so fit never crops a noodle', () => {
    // Endpoints inside a compact rect, but the reverse cubic bulges far
    // past both horizontally (linkBounds control hull). LINK_PAINT_PAD = 4
    // in renderer.ts covers stroke/dot thickness.
    const reverse = { id: 'rev', x1: 400, y1: 100, x2: 0, y2: 300, from: { kind: 'free' }, to: { kind: 'free' } }
    const bounds = sceneVisualBounds(emptyScene({ links: [reverse as unknown as Scene['links'][number]] }))!
    // dx = max(40, 400*0.5) = 200: hull spans [-200, 600] horizontally.
    expect(bounds).toEqual({ minX: -204, minY: 96, maxX: 604, maxY: 304 })
  })

  it('does not add detached preview bounds outside the node', () => {
    const preview = { image: {} as CanvasImageSource, width: 100, height: 100 }
    expect(sceneVisualBounds(emptyScene({ nodes: [node] }), { [node.id]: preview })!.maxY)
      .toBe(node.y + node.layout.height)
  })

  it('includes above-node badge lanes in scene visual bounds', () => {
    const badge = { id: 'test.arm', glyph: 'COMFYUI', variant: 'label' as const, placement: 'above' as const, color: '#6a4fa3' }
    const rect = badgeRect(node, 0, [badge])

    expect(sceneVisualBounds(emptyScene({ nodes: [node] }), {}, { [node.id]: [badge] })!.minY).toBe(rect.y)
  })

  it('includes below-node badge lanes in scene visual bounds', () => {
    const badge = { id: 'core.error', glyph: 'Error', variant: 'label' as const, placement: 'below' as const, color: '#8a2a2a' }
    const rect = badgeRect(node, 0, [badge])

    expect(sceneVisualBounds(emptyScene({ nodes: [node] }), {}, { [node.id]: [badge] })!.maxY)
      .toBe(rect.y + rect.height)
  })

  it('fits known visual bounds and leaves empty or zero-size canvases unchanged', () => {
    const { ctx } = recordingCtx()
    const tracked = mutableCanvas(ctx, 800, 600)
    const renderer = new CanvasRenderer(tracked.canvas, defaultTokens)
    const scene = emptyScene({ groups: [{ id: 'g', title: 'g', x: 100, y: 200, width: 400, height: 100 }] })
    renderer.setScene(scene)
    renderer.fitToScene(50)
    const expectedScale = Math.min(2, Math.max(0.1, Math.min(700 / 400, 500 / 100)))
    expect(renderer.getViewport()).toEqual({
      x: (800 - 400 * expectedScale) / 2 - 100 * expectedScale,
      y: (600 - 100 * expectedScale) / 2 - 200 * expectedScale,
      scale: expectedScale,
    })
    const fitted = renderer.getViewport()
    renderer.setScene(emptyScene())
    renderer.fitToScene()
    expect(renderer.getViewport()).toEqual(fitted)
    tracked.size.clientWidth = 0
    renderer.setScene(scene)
    renderer.fitToScene()
    expect(renderer.getViewport()).toEqual(fitted)
    renderer.dispose()
  })

  it('clamps a degenerate visual span and produces a finite viewport', () => {
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(emptyScene({ groups: [{ id: 'point', title: '', x: 7, y: 9, width: 0, height: 0 }] }))
    renderer.fitToScene()
    expect(Object.values(renderer.getViewport()).every(Number.isFinite)).toBe(true)
    expect(renderer.getViewport().scale).toBe(2)
    renderer.dispose()
  })
})

describe('viewport culling regressions', () => {
  it('batches large overview link and reroute paths by type', () => {
    const links = Array.from({ length: 300 }, (_, index) => ({
      id: `link-${index}`,
      from: { kind: 'reroute' as const, reroute: `from-${index}` },
      to: { kind: 'reroute' as const, reroute: `to-${index}` },
      x1: 10,
      y1: 10 + index,
      x2: 200,
      y2: 10 + index,
      typeName: 'IMAGE',
    }))
    const reroutes = Array.from({ length: 300 }, (_, index) => ({
      id: `reroute-${index}`,
      x: 100,
      y: 10 + index,
      typeName: 'IMAGE',
    }))
    const calls = paintWith(emptyScene({ links, reroutes }), (renderer) => {
      renderer.setGridVisible(false)
      renderer.setViewport({ x: 0, y: 0, scale: 0.05 })
    })

    expect(calls.filter((call) => call.method === 'bezierCurveTo')).toHaveLength(300)
    expect(calls.filter((call) => call.method === 'arc')).toHaveLength(300)
    expect(calls.filter((call) => call.method === 'stroke')).toHaveLength(2)
  })

  it('keeps nodes within the 12px PIN_OVERHANG and culls nodes beyond it', () => {
    const original = fixtureScene('clean').nodes[0]!
    const near = { ...original, id: 'near', x: 100 - original.layout.width - 6, y: 100 }
    const far = { ...original, id: 'far', x: 100 - original.layout.width - 13, y: 300 }
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setGridVisible(false)
    renderer.setViewport({ x: -100, y: 0, scale: 1 })
    renderer.setScene(emptyScene({ nodes: [near, far] }))
    renderer.renderNow()
    expect(calls.some((call) => call.method === 'roundRect' && call.args[0] === near.x)).toBe(true)
    expect(calls.some((call) => call.method === 'roundRect' && call.args[0] === far.x)).toBe(false)
    renderer.dispose()
  })

  it('includes low-zoom pin and reroute status-ring strokes in culling', () => {
    const original = fixtureScene('clean').nodes.find((node) =>
      node.layout.pins.some((pin) => pin.direction === 'out'))!
    const output = original.layout.pins.find((pin) => pin.direction === 'out')!
    const near = { ...original, id: 'near', x: -original.layout.width - 45, y: 100 }
    const far = { ...original, id: 'far', x: -original.layout.width - 85, y: 300 }
    const nearReroute = { id: 'near-reroute', x: -45, y: 600, typeName: 'IMAGE' }
    const farReroute = { id: 'far-reroute', x: -64, y: 800, typeName: 'IMAGE' }
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setGridVisible(false)
    renderer.setViewport({ x: 0, y: 0, scale: 0.05 })
    renderer.setScene(emptyScene({ nodes: [near, far], reroutes: [nearReroute, farReroute] }))
    renderer.setOverlay({
      dropTargets: new Set([
        dropTargetKey(near.id, output.portId, 'out'),
        dropTargetKey(far.id, output.portId, 'out'),
        rerouteTargetKey(nearReroute.id),
        rerouteTargetKey(farReroute.id),
      ]),
    })
    renderer.renderNow()

    for (const [x, y] of [[-45, near.y + output.y], [-45, nearReroute.y]]) {
      const ring = calls.findIndex((call) =>
        call.method === 'arc' && call.args[0] === x && call.args[1] === y && call.args[2] === 43.5)
      expect(ring).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(calls, ring, 'stroke')).toMatchObject({
        strokeStyle: defaultTokens.colors.dropTarget,
        lineWidth: 40,
      })
    }
    expect(calls.some((call) => call.method === 'roundRect' && call.args[0] === far.x)).toBe(false)
    expect(calls.some((call) => call.method === 'arc' && call.args[0] === farReroute.x && call.args[1] === farReroute.y)).toBe(false)
    renderer.dispose()
  })

  it('paints a reverse link whose control hull enters the viewport and culls a far link', () => {
    const reverse = { id: 'reverse', from: { kind: 'reroute' as const, reroute: 'a' }, to: { kind: 'reroute' as const, reroute: 'b' }, x1: 90, y1: 100, x2: -300, y2: 100 }
    const far = { ...reverse, id: 'far', x1: -1000, x2: -1200 }
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setGridVisible(false)
    renderer.setViewport({ x: -100, y: 0, scale: 1 })
    renderer.setScene(emptyScene({ links: [reverse, far] }))
    renderer.renderNow()
    expect(calls.filter((call) => call.method === 'bezierCurveTo')).toHaveLength(1)
    renderer.dispose()
  })

  it('FR6 paints a net-stub lead whose tag is outside the viewport', () => {
    const stub = {
      netId: 'net', name: 'outside', role: 'source', nodeId: 'node', portId: 'out',
      pinX: 110, pinY: 100, x: 70, y: 92, width: 20, height: 16, typeName: 'FLOAT',
    } as Scene['netStubs'][number]
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setGridVisible(false)
    renderer.setViewport({ x: -100, y: 0, scale: 1 })
    renderer.setScene(emptyScene({ netStubs: [stub] }))
    renderer.renderNow()
    expect(calls.some((call) => call.method === 'moveTo' && call.args[0] === 110 && call.args[1] === 100)).toBe(true)
    expect(calls.some((call) => call.method === 'stroke' && call.lineWidth === 2)).toBe(true)
    renderer.dispose()
  })

  it('paints Set-to-Get guide curves only for stubs marked guide', () => {
    const source = {
      id: 'setTag', netId: 'net', name: 'latents', role: 'source', nodeId: 'p', portId: 'out',
      pinX: 60, pinY: 100, x: 70, y: 92, width: 20, height: 16, typeName: 'FLOAT',
    } as Scene['netStubs'][number]
    const sink = {
      id: 'getTag', netId: 'net', name: 'latents', role: 'sink', nodeId: 'c', portId: 'in',
      pinX: 240, pinY: 100, x: 200, y: 92, width: 20, height: 16, typeName: 'FLOAT',
    } as Scene['netStubs'][number]

    const hidden = paintWith(emptyScene({ netStubs: [source, sink] }), () => undefined)
    expect(hidden.filter((call) => call.method === 'bezierCurveTo')).toHaveLength(0)

    const scene = emptyScene({ netStubs: [{ ...source, guide: true }, { ...sink, guide: true }] })
    const shown = paintWith(scene, () => undefined)
    // One casing pass plus one colored pass, both dashed, from the Set
    // tag's free edge (90, 100) to the Get tag's free edge (200, 100).
    const curves = shown.filter((call) => call.method === 'bezierCurveTo')
    expect(curves).toHaveLength(2)
    for (const curve of curves) {
      expect(curve.lineDash).toEqual([7, 5])
      expect(curve.args.slice(-2)).toEqual([200, 100])
    }
    expect(shown.some((call) => call.method === 'moveTo' && call.args[0] === 90 && call.args[1] === 100 &&
      call.lineDash.length === 2)).toBe(true)
    expect(curves.some((curve) => curve.strokeStyle === defaultTokens.colors.canvasBackground)).toBe(true)
    expect(curves.some((curve) => curve.strokeStyle === typeColor(defaultTokens, 'FLOAT'))).toBe(true)
  })

  it('uses the shared detail threshold for named-net labels', () => {
    const scene = emptyScene({ links: [{ ...typedLensLink('net', 'FLOAT'), netName: 'feed' }] })
    const paintAt = (scale: number) => paintWith(scene, (renderer) =>
      renderer.setViewport({ x: 0, y: 0, scale }))

    expect(paintAt(CANVAS_DETAIL_MIN_SCALE - 0.01)
      .some((call) => call.method === 'fillText' && call.args[0] === 'feed')).toBe(false)
    expect(paintAt(CANVAS_DETAIL_MIN_SCALE)
      .some((call) => call.method === 'fillText' && call.args[0] === 'feed')).toBe(true)
  })
})

describe('lens capability paint', () => {
  it('paints retained type adornments only when the capability is active', () => {
    const scene = emptyScene({ links: [typedLensLink('typed', 'FLOAT')] })
    const active = paintWith(scene, (renderer) => renderer.setLensCapabilities({ typeAdornments: true }))
    expect(active.some((call) => call.method === 'fillText' && call.args[0] === 'FLOAT' &&
      call.args[1] === 150 && call.args[2] === 93 && call.fillStyle === defaultTokens.colors.title)).toBe(true)

    const inactive = paintWith(scene, (renderer) => renderer.setLensCapabilities({}))
    expect(inactive.some((call) => call.method === 'fillText' && call.args[0] === 'FLOAT')).toBe(false)
  })

  it('keeps type adornments bounded, culled, and attached to live link geometry', () => {
    const longType = 'T'.repeat(600)
    const scene = emptyScene({
      links: [
        typedLensLink('a', longType),
        typedLensLink('hidden', 'HIDDEN', 100, 140, 200, 140),
        typedLensLink('far', 'FAR', 10_000, 100, 10_100, 100),
        typedLensLink('edge', 'E'.repeat(600), -100, 100, -10, 100),
      ],
    })
    const calls = paintWith(scene, (renderer) => {
      renderer.setLensCapabilities({ typeAdornments: true })
      renderer.setOverlay({
        hiddenLinkIds: new Set(['hidden']),
        dragOffsets: new Map([
          ['a-from', { dx: 20, dy: 10 }],
          ['a-to', { dx: 40, dy: 30 }],
        ]),
      })
    })
    const label = `${'T'.repeat(509)}...`
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === label &&
      call.args[1] === 180 && call.args[2] === 113)).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'HIDDEN')).toBe(false)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'FAR')).toBe(false)
    expect(calls.some((call) => call.method === 'fillText' && String(call.args[0]).startsWith('EEE'))).toBe(false)

    const lowZoom = paintWith(scene, (renderer) => {
      renderer.setLensCapabilities({ typeAdornments: true })
      renderer.setViewport({ x: 0, y: 0, scale: CANVAS_DETAIL_MIN_SCALE - 0.01 })
    })
    expect(lowZoom.some((call) => call.method === 'fillText' && call.args[0] === label)).toBe(false)

    const thresholdZoom = paintWith(scene, (renderer) => {
      renderer.setLensCapabilities({ typeAdornments: true })
      renderer.setViewport({ x: 0, y: 0, scale: CANVAS_DETAIL_MIN_SCALE })
    })
    expect(thresholdZoom.some((call) => call.method === 'fillText' && call.args[0] === label)).toBe(true)
  })

  it('preserves scene order and caps visible type adornments per frame', () => {
    const links = Array.from({ length: 8193 }, (_, index) => {
      const suffix = String(index).padStart(4, '0')
      const reverseId = String(8192 - index).padStart(4, '0')
      return typedLensLink(`link-${reverseId}`, `TYPE_${suffix}`)
    })
    const calls = paintWith(emptyScene({ links }), (renderer) =>
      renderer.setLensCapabilities({ typeAdornments: true }))
    const labels = calls
      .filter((call) => call.method === 'fillText' && String(call.args[0]).startsWith('TYPE_'))
      .map((call) => call.args[0])
    expect(labels).toHaveLength(8192)
    expect(labels[0]).toBe('TYPE_0000')
    expect(labels.at(-1)).toBe('TYPE_8191')
  })

  it('keeps node-output labels on their layout rows while nodes move', () => {
    const scene = fixtureScene('clean')
    const node = scene.nodes.find((candidate) =>
      candidate.layout.rows.some((row) => row.kind === 'ports' && row.output !== undefined))
    const row = node?.layout.rows.find((candidate) => candidate.kind === 'ports' && candidate.output !== undefined)
    if (node === undefined || row?.kind !== 'ports' || row.output === undefined) {
      throw new Error('fixture needs a node output row')
    }
    const label = presentedType(defaultTokens, row.output.type).label
    const dx = 17
    const dy = -9
    const calls = paintWith(scene, (renderer) => {
      renderer.setLensCapabilities({ typeAdornments: true })
      renderer.setOverlay({ dragOffsets: new Map([[node.id, { dx, dy }]]) })
    })
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === label &&
      call.args[1] === node.x + dx + node.layout.width - defaultTokens.padX - defaultTokens.pinRadius - 4 &&
      call.args[2] === node.y + dy + row.y + row.height / 2 + 10 &&
      call.font === `600 ${Math.max(8, defaultTokens.fontSize - 2)}px ${defaultTokens.fontFamily}` &&
      call.fillStyle === defaultTokens.colors.title)).toBe(true)
  })

  it('paints an active widget-row affordance at the shared hit geometry', () => {
    const scene = controllerPaintScene()
    const node = scene.nodes.find((candidate) => candidate.layout.rows.some((row) => row.kind === 'widget'))!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget')!
    const width = node.layout.width - row.inset * 2
    const rect = widgetRowAffordanceRect(width, defaultTokens.rowHeight, row)
    const calls = paintWith(scene, (renderer) => renderer.setLensCapabilities({
      widgetRowAffordance: (candidateNode, candidateRow) =>
        candidateNode === node && candidateRow === row ? { active: true, label: 'Remove from app view' } : undefined,
    }))

    const path = calls.findIndex((call) => call.method === 'roundRect' &&
      call.args[0] === node.x + row.inset + rect.x && call.args[1] === node.y + row.y + rect.y &&
      call.args[2] === rect.width && call.args[3] === rect.height)
    expect(path).toBeGreaterThanOrEqual(0)
    expect(calls.slice(path).some((call) => call.method === 'fill' &&
      call.fillStyle === defaultTokens.colors.widgetAffordanceActive)).toBe(true)
  })

  it('paints an active preview-surface affordance at the shared hit geometry', () => {
    const base = controllerPaintScene()
    const target = base.nodes[0]!
    const previewNode = { ...target, layout: withPreviewRegion(target.layout, defaultTokens) }
    const scene = {
      ...base,
      nodes: [previewNode, ...base.nodes.slice(1)],
    } as Scene
    const rect = previewSurfaceAffordanceRect(previewNode)!
    const calls = paintWith(scene, (renderer) => renderer.setLensCapabilities({
      previewSurfaceAffordance: (candidate) =>
        candidate === previewNode ? { active: true, label: 'Remove preview from app view' } : undefined,
    }))

    const path = calls.findIndex((call) => call.method === 'roundRect' &&
      call.args[0] === previewNode.x + rect.x && call.args[1] === previewNode.y + rect.y &&
      call.args[2] === rect.width && call.args[3] === rect.height)
    expect(path).toBeGreaterThanOrEqual(0)
    expect(calls.slice(path).some((call) => call.method === 'fill' &&
      call.fillStyle === defaultTokens.colors.widgetAffordanceActive)).toBe(true)
  })
})

const nodeOf = (scene: Scene, id: string): SceneNode => {
  const n = scene.nodes.find((x) => x.id === id)
  expect(n, `scene node '${id}'`).toBeDefined()
  return n!
}

/** The first stroke/fill painted after the call at `index` (what styles that path). */
const paintedAfter = (calls: PaintCall[], index: number, method: 'stroke' | 'fill'): PaintCall | undefined =>
  calls.slice(index + 1).find((c) => c.method === method)

const nodeBorder = (calls: PaintCall[], node: SceneNode): PaintCall | undefined => {
  const path = calls.findIndex((call, index) =>
    call.method === 'roundRect' &&
    call.args[0] === node.x &&
    call.args[1] === node.y &&
    call.args[2] === node.layout.width &&
    call.args[3] === node.layout.height &&
    calls[index + 1]?.method === 'stroke')
  return path < 0 ? undefined : calls[path + 1]
}

const ERR = defaultTokens.colors.error

function controllerPaintScene(mode?: 'fixed' | 'increment' | 'decrement' | 'randomize'): Scene {
  const schema: NodeSchema = {
    type: 'Seed', displayName: 'Seed', category: 'test', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'seed', type: typed('INT'), optional: false,
      widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
    }, {
      kind: 'input', id: 'plain', type: typed('INT'), optional: false,
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }],
  }
  const doc: WorkflowDocument = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('controller-paint'), root: asGraphDefId('g0'),
    graphs: { g0: { id: asGraphDefId('g0'), name: 'g', nodes: {
      seed: { id: asNodeId('seed'), type: 'Seed', values: {}, ...(mode ? { controllers: { seed: mode } } : {}) },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {} } } },
  }
  return buildScene({ document: doc, graphId: 'g0', resolve: (type) => type === 'Seed' ? schema : undefined, tokens: defaultTokens, measure, widgetMeasure })
}

describe('after-generate controller paint', () => {
  it.each(['fixed', 'increment', 'decrement', 'randomize'] as const)(
    'paints the %s mode as an icon without a status word', (mode) => {
      const texts = paint(controllerPaintScene(mode)).filter((call) => call.method === 'fillText').map((call) => call.args[0])
      expect(texts).not.toContain(mode)
      expect(texts).not.toContain('random')
    },
  )

  it('paints one compact icon chip for the derived default and none on the plain row', () => {
    const calls = paint(controllerPaintScene())
    const chips = calls.filter((call) => call.method === 'strokeRect' && call.strokeStyle === defaultTokens.colors.selection)
    expect(chips).toHaveLength(1)
    expect(calls.some((call) => call.method === 'translate')).toBe(true)
    expect(calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])).not.toContain('random')
    const node = controllerPaintScene().nodes[0]!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget') as Extract<(typeof node.layout.rows)[number], { kind: 'widget' }>
    const chip = controllerChipRect(node.layout.width - row.inset * 2, row.height)
    expect(chips[0]!.args).toEqual([
      node.x + row.inset + chip.x,
      node.y + row.y + chip.y,
      chip.width,
      chip.height,
    ])
    expect(Number(chips[0]!.args[0])).toBeGreaterThan(
      node.x + row.inset + controllerChipTextRight(node.layout.width - row.inset * 2, row.height),
    )
  })
})

describe('diagnostic paint on the live renderer', () => {
  it('a mismatch noodle strokes in error red; a healthy one keeps its type color', () => {
    const scene = fixtureScene()
    expect(scene.links.find((l) => l.id === 'bad')!.mismatch).toBe(true)
    const calls = paint(scene)
    const strokes = calls.filter((c) => c.method === 'stroke')
    // Mismatch noodle: error color at the widened link width.
    expect(strokes.some((c) => c.strokeStyle === ERR && c.lineWidth === 3)).toBe(true)
    // Healthy noodle: LATENT's type color at the normal link width.
    const latent = typeColor(defaultTokens, 'LATENT')
    expect(strokes.some((c) => c.strokeStyle === latent && c.lineWidth === 2.5)).toBe(true)
    // The mismatch noodle's grab dot follows the error paint.
    expect(calls.some((c) => c.method === 'fill' && c.fillStyle === ERR)).toBe(true)
  })

  it('a core.combo noodle uses the pinned COMBO presentation color', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      links: base.links.map((link) => link.typeName === 'LATENT' ? { ...link, typeName: 'core.combo' } : link),
    }
    const calls = paint(scene)
    expect(calls.some((call) =>
      call.method === 'stroke' && call.strokeStyle === defaultTokens.typeColors['core.combo'] && call.lineWidth === 2.5,
    )).toBe(true)
  })

  it('a core.combo noodle keeps COMBO presentation through reroutes', () => {
    const scene = comboRerouteScene()
    const source = scene.nodes.find((node) => node.node.type === 'dinkster.string_to_combo')!
    const sink = scene.nodes.find((node) => node.node.type === 'dinkster.combo_to_string')!
    expect(source.layout.pins.find((pin) => pin.portId === 'string')?.type).toEqual(typed('core.string'))
    expect(source.layout.pins.find((pin) => pin.portId === 'choice')?.type).toEqual(typed('core.combo'))
    expect(sink.layout.pins.find((pin) => pin.portId === 'choice')?.type).toEqual(typed('core.combo'))
    expect(sink.layout.pins.find((pin) => pin.portId === 'text')?.type).toEqual(typed('core.string'))
    expect(typeColor(defaultTokens, 'core.combo')).toBe('#5D4037')
    expect(scene.links.find((link) => link.id === 'out')?.typeName).toBe('core.combo')
    const calls = paint(scene)
    expect(calls.some((call) =>
      call.method === 'stroke' && call.strokeStyle === defaultTokens.typeColors['core.combo'] && call.lineWidth === 2.5,
    )).toBe(true)
  })

  it('a warned pin draws an error ring WITHOUT dropping its normal pin fill', () => {
    const base = fixtureScene()
    // Scene->warn derivation is proven in dynamic-scene.test.ts; here inject
    // the flag to test the renderer contract in isolation.
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'c2'
          ? {
              ...n,
              layout: {
                ...n.layout,
                pins: n.layout.pins.map((p) => (p.portId === 'in' ? { ...p, warn: true as const } : p)),
              },
            }
          : n,
      ),
    }
    const calls = paint(scene)
    const ringRadius = defaultTokens.pinRadius + 3.5
    // The ring: an arc at ring radius stroked with the error color.
    const ringArcIdx = calls.findIndex((c) => c.method === 'arc' && c.args[2] === ringRadius)
    expect(ringArcIdx).toBeGreaterThanOrEqual(0)
    const ringStroke = calls.slice(ringArcIdx + 1).find((c) => c.method === 'stroke')
    expect(ringStroke?.strokeStyle).toBe(ERR)
    // The pin body still paints at the same coordinates with its type color.
    const [rx, ry] = calls[ringArcIdx]!.args as [number, number]
    const bodyIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === rx && c.args[1] === ry && c.args[2] === defaultTokens.pinRadius,
    )
    expect(bodyIdx).toBeGreaterThan(ringArcIdx)
    const bodyFill = calls.slice(bodyIdx + 1).find((c) => c.method === 'fill' || c.method === 'stroke')
    expect(bodyFill?.method).toBe('fill')
    expect(bodyFill?.fillStyle).toBe(typeColor(defaultTokens, 'LATENT'))
  })

  it.each([
    ['error', defaultTokens.colors.error],
    ['blocking-warning', defaultTokens.colors.blockingWarning],
    ['warning', PROBLEM_WARNING_BADGE.color],
  ] as const)('paints an exact input problem ring for %s severity', (kind, color) => {
    const scene = fixtureScene('clean')
    const sink = nodeOf(scene, 'c2')
    const pin = sink.layout.pins.find((candidate) => candidate.direction === 'in' && candidate.portId === 'in')!
    const px = sink.x
    const py = sink.y + pin.y
    const calls = paintWith(scene, (renderer) => renderer.setPortProblems({ c2: { in: kind } }))
    const ring = calls.findIndex((call) =>
      call.method === 'arc' && call.args[0] === px && call.args[1] === py &&
      call.args[2] === defaultTokens.pinRadius + 3.5)

    expect(ring).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, ring, 'stroke')?.strokeStyle).toBe(color)
    expect(calls.some((call) =>
      call.method === 'arc' && call.args[0] === px && call.args[1] === py &&
      call.args[2] === defaultTokens.pinRadius)).toBe(true)
  })

  it('keeps an exact input problem ring visible with selection and hover', () => {
    const scene = constructsScene()
    const node = nodeOf(scene, 'fs2')
    const pin = node.layout.pins.find((candidate) => candidate.widgetBacked === true && candidate.direction === 'in')!
    const calls = paintWith(scene, (renderer) => {
      renderer.setPortProblems({ fs2: { [pin.portId]: 'error' } })
      renderer.setOverlay({ selection: new Set(['fs2']), hoveredNode: 'fs2' })
    })
    const ring = calls.findIndex((call) =>
      call.method === 'arc' && call.args[0] === node.x && call.args[1] === node.y + pin.y &&
      call.args[2] === defaultTokens.pinRadius + 3.5)
    const halo = calls.findIndex((call) =>
      call.method === 'roundRect' && call.args[0] === node.x - 3 && call.args[1] === node.y - 3)

    expect(ring).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, ring, 'stroke')?.strokeStyle).toBe(defaultTokens.colors.error)
    expect(halo).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, halo, 'stroke')?.strokeStyle).toBe(defaultTokens.colors.nodeSelectedBorder)
  })

  it('grid dots: world-anchored, geometric spacing growth, and toggleable', () => {
    // Empty scene: every painted arc is a grid dot, so geometry assertions
    // need no filtering.
    const empty: Scene = {
      graphId: 'g0', nodes: [], links: [], reroutes: [], valueSources: [],
      selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [],
    }
    const gridDot = defaultTokens.colors.gridDot
    const frame = (setup?: (r: CanvasRenderer) => void) => {
      const { ctx, calls } = recordingCtx()
      const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
      renderer.setCanvasLayers([canvasGridLayer(defaultTokens)])
      renderer.setScene(empty)
      setup?.(renderer)
      renderer.renderNow()
      renderer.dispose()
      return calls
    }
    const dotXs = (calls: PaintCall[]) =>
      calls.filter((c) => c.method === 'arc').map((c) => c.args[0] as number)

    // Default viewport {x:40,y:40,scale:1}: base spacing 32, dots anchored
    // to WORLD multiples of 32 (panning must not slide the grid).
    const base = frame()
    expect(base.some((c) => c.method === 'fill' && c.fillStyle === gridDot)).toBe(true)
    const xs = dotXs(base)
    expect(xs.length).toBeGreaterThan(0)
    for (const x of xs) expect(Math.abs(x % 32)).toBe(0)

    // Zoomed out to 0.2: 32 world units shrink under the 12px screen floor,
    // so spacing doubles geometrically (32 -> 64) to bound dot density.
    const zoomed = frame((r) => r.setViewport({ x: 0, y: 0, scale: 0.2 }))
    const zoomedXs = dotXs(zoomed)
    expect(zoomedXs.length).toBeGreaterThan(0)
    for (const x of zoomedXs) expect(Math.abs(x % 64)).toBe(0)

    // Preference off: no grid paint at all.
    const hidden = frame((r) => r.setGridVisible(false))
    expect(hidden.some((c) => c.method === 'fill' && c.fillStyle === gridDot)).toBe(false)
    expect(dotXs(hidden)).toHaveLength(0)
  })

  it('paints isolated background and foreground layers on opposite sides of the graph', () => {
    const scene = fixtureScene('clean')
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(scene)
    renderer.setCanvasLayers([
      {
        id: 'test.background', position: 'background',
        draw: ({ context }) => {
          context.globalAlpha = 0.25
          context.fillStyle = '#010203'
          context.fillRect(-11, -12, 1, 1)
        },
      },
      {
        id: 'test.background-after', position: 'background',
        draw: ({ context }) => {
          context.fillStyle = '#040506'
          context.fillRect(-13, -14, 1, 1)
        },
      },
      {
        id: 'test.foreground', position: 'foreground',
        draw: ({ context }) => {
          context.fillStyle = '#070809'
          context.fillRect(-15, -16, 1, 1)
        },
      },
    ])
    renderer.renderNow()
    renderer.dispose()

    const background = calls.findIndex((call) => call.method === 'fillRect' && call.args[0] === -11)
    const isolatedBackground = calls.findIndex((call) => call.method === 'fillRect' && call.args[0] === -13)
    const graph = calls.findIndex((call) =>
      call.method === 'fillText' && call.args[0] === scene.nodes[0]!.layout.title)
    const foreground = calls.findIndex((call) => call.method === 'fillRect' && call.args[0] === -15)

    expect(background).toBeGreaterThanOrEqual(0)
    expect(graph).toBeGreaterThan(background)
    expect(foreground).toBeGreaterThan(graph)
    expect(calls[background]!.globalAlpha).toBe(0.25)
    expect(calls[isolatedBackground]!.globalAlpha).toBe(1)
  })

  it('freezes layer geometry and reports a failed layer once without stopping siblings', () => {
    const scene = fixtureScene('clean')
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    const failures: string[] = []
    renderer.setScene(scene)
    renderer.setCanvasLayers([
      {
        id: 'test.failure', position: 'background',
        draw: () => { throw new Error('paint failed') },
      },
      {
        id: 'test.geometry', position: 'background',
        draw: ({ context, viewport, nodes }) => {
          expect(Object.isFrozen(viewport)).toBe(true)
          expect(Object.isFrozen(nodes)).toBe(true)
          expect(Object.isFrozen(nodes[0])).toBe(true)
          expect(nodes[0]).toEqual(expect.objectContaining({
            id: scene.nodes[0]!.id,
            x: scene.nodes[0]!.x,
            y: scene.nodes[0]!.y,
            width: scene.nodes[0]!.layout.width,
            height: scene.nodes[0]!.layout.height,
          }))
          context.fillRect(-17, -18, 1, 1)
        },
      },
    ], (id) => failures.push(id))

    renderer.renderNow()
    renderer.renderNow()
    renderer.dispose()

    expect(failures).toEqual(['test.failure'])
    expect(calls.filter((call) => call.method === 'fillRect' && call.args[0] === -17)).toHaveLength(2)
  })

  it('a clean document paints nothing in the error color', () => {
    const scene = fixtureScene('clean')
    expect(scene.diagnostics).toEqual([])
    const calls = paint(scene)
    expect(calls.some((c) => c.method === 'stroke' && c.strokeStyle === ERR)).toBe(false)
    expect(calls.some((c) => c.method === 'fill' && c.fillStyle === ERR)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Construct fixture: one real document carrying every non-node construct
// (reroute chain, value source, selector, collapsed net, view groups) so
// each paint contract is proven against buildScene output, not hand-cast
// scene objects. Variants (derived spec, random policy) clone-and-tweak.
// ---------------------------------------------------------------------------

const constructsJson = () => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'paint-constructs',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'g',
      nodes: {
        lat: { id: 'lat', type: 'PLAT', values: {} },
        lat2: { id: 'lat2', type: 'PLAT', values: {} },
        c1: { id: 'c1', type: 'SinkLatent', values: {} },
        c2: { id: 'c2', type: 'SinkLatent', values: {} },
        fs: { id: 'fs', type: 'FSink', values: {} },
        fs2: { id: 'fs2', type: 'FSink', values: {} },
        opt: { id: 'opt', type: 'SinkOpt', values: {} },
        opt2: { id: 'opt2', type: 'SinkOpt', values: {} },
      },
      links: {
        lv: { id: 'lv', from: { valueSource: 'vs' }, to: { node: 'fs', port: 'f' } },
        s1: { id: 's1', from: { node: 'lat', port: 'out' }, to: { selector: 'sel', candidate: 'p1' } },
        s2: { id: 's2', from: { node: 'lat2', port: 'out' }, to: { selector: 'sel', candidate: 'p2' } },
        s3: { id: 's3', from: { selector: 'sel' }, to: { node: 'c1', port: 'in' } },
        ra: { id: 'ra', from: { node: 'lat', port: 'out' }, to: { reroute: 'rr' } },
        rb: { id: 'rb', from: { reroute: 'rr' }, to: { node: 'c2', port: 'in' } },
      },
      nets: {
        n1: { id: 'n1', name: 'feed', source: { node: 'lat2', port: 'out' }, sinks: [{ node: 'opt', port: 'in' }] },
      },
      reroutes: { rr: { id: 'rr' } },
      valueSources: { vs: { id: 'vs', value: 2.5, spec: { widgetType: 'FLOAT' } } },
      selectors: {
        sel: { id: 'sel', candidates: [{ id: 'p1' }, { id: 'p2' }], policy: { kind: 'fixed', candidate: 'p1' } },
      },
      nextOrdinal: 100,
    },
  },
  view: {
    graphs: {
      g0: {
        nodes: {
          lat: { position: { x: 60, y: 60 } },
          lat2: { position: { x: 60, y: 260 } },
          c1: { position: { x: 760, y: 60 } },
          c2: { position: { x: 760, y: 260 } },
          fs: { position: { x: 760, y: 460 } },
          fs2: { position: { x: 760, y: 640 } },
          opt: { position: { x: 460, y: 640 } },
          opt2: { position: { x: 60, y: 640 } },
        },
        groups: {
          ga: { id: 'ga', title: 'Stage A', bounds: { x: 20, y: 20, width: 380, height: 320 }, color: '#3fa34d' },
          gb: { id: 'gb', title: 'Stage B', bounds: { x: 20, y: 380, width: 200, height: 150 } },
        },
        valueSources: { vs: { position: { x: 460, y: 470 } } },
        selectors: { sel: { position: { x: 460, y: 80 } } },
        reroutes: { rr: { position: { x: 460, y: 300 } } },
        collapsedNets: ['n1'],
      },
    },
  },
})

function constructsScene(mutate?: (json: ReturnType<typeof constructsJson>) => void): Scene {
  const json = constructsJson()
  mutate?.(json)
  const loaded = loadDocument(json)
  expect(
    loaded.diagnostics.filter((d) => d.severity === 'error'),
    JSON.stringify(loaded.diagnostics),
  ).toEqual([])
  const doc = loaded.document as WorkflowDocument
  return buildScene({
    document: doc,
    graphId: 'g0',
    resolve: (t) => synthetic.get(t),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

const LATENT = typeColor(defaultTokens, 'LATENT')
const FLOATC = typeColor(defaultTokens, 'FLOAT')
const SEL = defaultTokens.colors.selection

describe('drop-target rings', () => {
  it('paints compatible-target rings white (dropTarget), never the blue selection accent', () => {
    const scene = fixtureScene('clean')
    const sink = nodeOf(scene, 'c2')
    const pin = sink.layout.pins.find((p) => p.portId === 'in')!
    const calls = paintWith(scene, (r) =>
      r.setOverlay({ dropTargets: new Set([dropTargetKey('c2', 'in', 'in')]) }))
    const ringArc = calls.findIndex((c) =>
      c.method === 'arc' && c.args[0] === sink.x && c.args[1] === sink.y + pin.y &&
      c.args[2] === defaultTokens.pinRadius + 3.5)
    expect(ringArc).toBeGreaterThanOrEqual(0)
    const ring = calls.slice(ringArc + 1).find((c) => c.method === 'stroke')
    expect(ring?.strokeStyle).toBe(defaultTokens.colors.dropTarget)
    expect(ring?.strokeStyle).not.toBe(defaultTokens.colors.selection)
  })
})

describe('node chrome paint on the live renderer', () => {
  it('projects minimized nodes with one connected proxy per side and an always-visible compact preview', () => {
    const base = fixtureScene('clean')
    const source = nodeOf(base, 'img')
    const output = source.layout.pins.find((pin) => pin.direction === 'out')!
    const minimizedSource = {
      ...source,
      layout: {
        ...source.layout,
        width: 100,
        height: source.layout.headerHeight + defaultTokens.padBottom,
        minWidth: 80,
        minHeight: source.layout.headerHeight + defaultTokens.padBottom,
        rows: [],
        minimized: true as const,
        pins: [
          { ...output, y: source.layout.headerHeight / 2, minimized: true as const },
          {
            ...output,
            portId: 'out2',
            address: { port: 'out2' },
            y: source.layout.headerHeight / 2,
            minimized: true as const,
          },
        ],
      },
    }
    const sinks = [nodeOf(base, 'c1'), nodeOf(base, 'c2')]
    const scene = emptyScene({
      graphId: base.graphId,
      nodes: [minimizedSource, ...sinks],
      links: sinks.map((sink, index) => ({
        id: `link-${index}`,
        from: { kind: 'port' as const, node: minimizedSource.id, port: index === 0 ? 'out' : 'out2' },
        to: { kind: 'port' as const, node: sink.id, port: 'in' },
        x1: 0,
        y1: 0,
        x2: sink.x,
        y2: sink.y,
      })),
    })
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(scene)
    const projected = nodeOf(renderer.getScene(), minimizedSource.id)
    expect(projected.layout.preview).toMatchObject({ compact: true, height: defaultTokens.rowHeight })
    expect(renderer.getScene().links.every((link) =>
      link.x1 === projected.x + projected.layout.width &&
      link.y1 === projected.y + projected.layout.headerHeight / 2)).toBe(true)
    renderer.renderNow()
    const proxyArcs = calls.filter((call) =>
      call.method === 'arc' &&
      call.args[0] === projected.x + projected.layout.width &&
      call.args[1] === projected.y + projected.layout.headerHeight / 2 &&
      call.args[2] === defaultTokens.pinRadius)
    // One circular proxy contributes one fill path and one outline path.
    expect(proxyArcs).toHaveLength(2)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'Preview')).toBe(true)
    renderer.dispose()
  })

  it('keeps minimized previews compact when real imagery and header badges arrive', () => {
    const base = fixtureScene('clean')
    const source = nodeOf(base, 'img')
    const minimized = {
      ...source,
      layout: {
        ...source.layout,
        width: 80,
        height: source.layout.headerHeight + defaultTokens.padBottom,
        minWidth: 80,
        minHeight: source.layout.headerHeight + defaultTokens.padBottom,
        rows: [],
        minimized: true as const,
        pins: source.layout.pins.map((pin) => ({
          ...pin,
          y: source.layout.headerHeight / 2,
          minimized: true as const,
        })),
      },
    }
    const image = {} as CanvasImageSource
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(emptyScene({ nodes: [minimized] }))
    renderer.setBadges({ [minimized.id]: [MUTED_BADGE] })
    renderer.setNodePreviews({ [minimized.id]: { image, width: 320, height: 240 } })
    const projected = nodeOf(renderer.getScene(), minimized.id)
    expect(projected.layout.width).toBeGreaterThan(80)
    expect(projected.layout.preview).toMatchObject({ compact: true, height: defaultTokens.rowHeight })
    renderer.renderNow()
    expect(calls.some((call) => call.method === 'drawImage' && call.args[0] === image)).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === '320 x 240')).toBe(false)
    renderer.dispose()
  })

  it('paints capped wrapped output text and a token-driven stale mark', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const calls = paintWith(scene, (renderer) => renderer.setNodeOutputTexts({
      [node.id]: { text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight', stale: true },
    }))
    expect(calls.filter((call) => call.method === 'fillText' && ['one', 'two', 'three', 'four', 'five'].includes(String(call.args[0])))).toHaveLength(5)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === '+3 more')).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'one' && call.fillStyle === defaultTokens.colors.companionUnproven)).toBe(true)
    expect(calls.some((call) => call.method === 'setLineDash' && JSON.stringify(call.args[0]) === '[1,2]')).toBe(true)
  })

  it('paints locally estimated text with the estimate token', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const calls = paintWith(scene, (renderer) => renderer.setNodeOutputTexts({
      [node.id]: { text: 'Estimated locally\nfloat: 3.5', estimate: true },
    }))
    expect(calls.some((call) =>
      call.method === 'fillText' && call.args[0] === 'float: 3.5' &&
      call.fillStyle === defaultTokens.colors.companionEstimate,
    )).toBe(true)
  })

  it('paints preview errors with the error token', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const calls = paintWith(scene, (renderer) => renderer.setNodeOutputTexts({
      [node.id]: { text: 'Preview error\nInvalid expression: unexpected token', error: true },
    }))
    expect(calls.some((call) =>
      call.method === 'fillText' && call.args[0] === 'Preview error' &&
      call.fillStyle === defaultTokens.colors.error,
    )).toBe(true)
  })

  it('suppresses the text region when an image preview is active', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const calls = paintWith(scene, (renderer) => {
      renderer.setNodeOutputTexts({ [node.id]: { text: 'hidden by image' } })
      renderer.setNodePreviews({ [node.id]: { status: 'loading' } })
    })
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'loading preview...')).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'hidden by image')).toBe(false)
    const projectedLayout = nodeOf((() => {
      const { ctx } = recordingCtx()
      const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
      renderer.setScene(scene)
      renderer.setNodeOutputTexts({ [node.id]: { text: 'hidden by image' } })
      renderer.setNodePreviews({ [node.id]: { status: 'loading' } })
      const projected = renderer.getScene()
      renderer.dispose()
      return projected
    })(), node.id).layout
    expect(projectedLayout.preview).toEqual(expect.any(Object))
    expect(projectedLayout).not.toHaveProperty('textOutput')
  })

  it('paints in-body loading/unavailable placeholders and the actual list page', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const loading = paintWith(scene, (renderer) => renderer.setNodePreviews({
      [node.id]: { status: 'loading', count: 3, index: 1 },
    }))
    expect(loading.some((call) => call.method === 'fillText' && call.args[0] === 'loading preview...')).toBe(true)
    expect(loading.some((call) => call.method === 'fillText' && call.args[0] === '2/3')).toBe(true)
    const unavailable = paintWith(scene, (renderer) => renderer.setNodePreviews({
      [node.id]: { status: 'unavailable' },
    }))
    expect(unavailable.some((call) => call.method === 'fillText' && call.args[0] === 'preview unavailable')).toBe(true)
  })

  it('reserves image pixels above the always-visible caption strip', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const image = {} as CanvasImageSource
    const calls = paintWith(scene, (renderer) => renderer.setNodePreviews({
      [node.id]: { image, width: 640, height: 480 },
    }))
    const preview = withPreviewRegion(node.layout, defaultTokens).preview!
    const panel = splitPreviewRect({
      x: node.x + preview.x,
      y: node.y + preview.y,
      width: preview.width,
      height: preview.height,
    }, defaultTokens.previewCaptionHeight)
    const draw = calls.find((call) => call.method === 'drawImage' && call.args[0] === image)
    expect(draw).toBeDefined()
    const checker = calls.find((call) => call.method === 'fillRect' && call.fillStyle === 'checkerboard')
    expect(checker?.args).toEqual(draw!.args.slice(1))
    expect(calls.indexOf(checker!)).toBeLessThan(calls.indexOf(draw!))
    expect(Number(draw!.args[2]) + Number(draw!.args[4])).toBeLessThanOrEqual(panel.caption.y)
    expect(calls.some((call) =>
      call.method === 'fillRect' && call.fillStyle === defaultTokens.colors.nodeBody &&
      call.args[0] === panel.caption.x && call.args[1] === panel.caption.y &&
      call.args[2] === panel.caption.width && call.args[3] === panel.caption.height,
    )).toBe(true)
    const dimensions = calls.find((call) => call.method === 'fillText' && call.args[0] === '640 x 480')
    expect(dimensions?.args[2]).toBe(panel.caption.y + panel.caption.height * 0.75)
  })

  it.each([undefined, 'PQ to sRGB'])('paints cached state, media count and color conversion %s in the caption', (colorTransform) => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const calls = paintWith(scene, (renderer) => renderer.setNodePreviews({
      [node.id]: {
        kind: 'video', src: '/preview.webm', width: 640, height: 480,
        count: 4, index: 1, state: 'cached',
        ...(colorTransform === undefined ? {} : { colorTransform }),
      },
    }))
    const preview = withPreviewRegion(node.layout, defaultTokens).preview!
    const caption = splitPreviewRect({
      x: node.x + preview.x,
      y: node.y + preview.y,
      width: preview.width,
      height: preview.height,
    }, defaultTokens.previewCaptionHeight).caption
    const labels = new Map(calls
      .filter((call) => call.method === 'fillText')
      .map((call) => [call.args[0], call]))
    const cachedY = Number(labels.get('last resolved')?.args[2])
    const countY = Number(labels.get('2/4')?.args[2])
    const metadata = colorTransform === undefined ? '640 x 480' : `640 x 480 | Preview color: ${colorTransform}`
    const dimensionsY = Number(labels.get(metadata)?.args[2])
    for (const y of [cachedY, countY, dimensionsY]) {
      expect(y).toBeGreaterThan(caption.y)
      expect(y).toBeLessThan(caption.y + caption.height)
    }
    expect(cachedY).toBe(countY)
    expect(dimensionsY).not.toBe(cachedY)
    expect(calls.some((call) => call.method === 'drawImage')).toBe(false)
  })

  it('sizes a short text result to one row', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(scene)
    renderer.setNodeOutputTexts({ [node.id]: { text: '42' } })
    expect(nodeOf(renderer.getScene(), node.id).layout.textOutput?.height).toBe(defaultTokens.rowHeight)
    renderer.dispose()
  })

  it('projects preview geometry into scene hit testing and keeps noodle anchors audited', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(scene)
    renderer.setNodePreviews({ [node.id]: { status: 'loading' } })
    const projected = renderer.getScene()
    const projectedNode = nodeOf(projected, node.id)
    const region = projectedNode.layout.preview!
    expect(hitTest(projected, projectedNode.x + region.x + 2, projectedNode.y + region.y + 2)).toMatchObject({
      kind: 'body', node: { id: node.id },
    })
    expect(auditScene(projected)).toEqual([])
    renderer.dispose()
  })

  it('projects live resize height into the multiline widget row before commit', () => {
    const node = {
      id: 'text-node',
      x: 100,
      y: 80,
      node: { id: 'text-node', type: 'TextNode', values: { text: 'one\ntwo\nthree' } },
      isSubgraph: false,
      layout: {
        width: 220,
        height: 136,
        minWidth: 140,
        minHeight: 136,
        headerHeight: 28,
        title: 'Text node',
        rows: [
          {
            kind: 'widget', inputId: 'text', valueKey: 'text', label: 'text',
            y: 28, height: 76, inset: 9.5, rows: 2, viewId: 'core.text',
            type: typed('STRING'), address: { port: 'text' },
            spec: { widgetType: 'STRING', options: { multiline: true } },
          },
          { kind: 'ports', y: 104, height: 24, input: { portId: 'after', label: 'after', type: typed('FLOAT'), address: { port: 'after' } } },
        ],
        pins: [
          { portId: 'text', direction: 'in', y: 40, type: typed('STRING'), address: { port: 'text' }, widgetBacked: true },
          { portId: 'after', direction: 'in', y: 116, type: typed('FLOAT'), address: { port: 'after' } },
        ],
      },
    } as unknown as SceneNode
    const scene = emptyScene({ nodes: [node] })
    const paintedRows: Array<{ y: number; height: number; hovered: boolean | undefined }> = []
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens, (args) => {
      paintedRows.push({ y: args.y, height: args.row.height, hovered: args.hovered })
    })
    renderer.setScene(scene)
    renderer.setOverlay({
      hoveredWidget: { nodeId: node.id, valueKey: 'text' },
      resizePreview: {
        nodeId: node.id,
        x: node.x,
        y: node.y,
        width: node.layout.width,
        height: node.layout.height + 61,
      },
    })
    renderer.renderNow()
    renderer.dispose()

    expect(paintedRows).toEqual([{
      y: node.y + 28,
      height: 4 + defaultTokens.multilineText.labelHeight + 2 * defaultTokens.multilineText.lineHeight +
        2 * defaultTokens.multilineText.padding + 61,
      hovered: true,
    }])
    const projected = projectNodeLayoutHeight(node.layout, node.layout.height + 61, defaultTokens)
    expect(projected.rows[1]!.y).toBe(104 + 59)
    expect(projected.pins.map((pin) => pin.y)).toEqual([40, 116 + 59])
  })

  it('projects live resize width into the text result region and rewraps against it', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const resizedWidth = 90
    const calls = paintWith(scene, (renderer) => {
      renderer.setNodeOutputTexts({ [node.id]: { text: 'abcdefghijklmnopqrstuv' } })
      renderer.setOverlay({
        resizePreview: {
          nodeId: node.id,
          x: node.x,
          y: node.y,
          width: resizedWidth,
          height: node.layout.height + defaultTokens.previewGap + defaultTokens.rowHeight * 6,
        },
      })
    })
    expect(calls.some((call) =>
      call.method === 'roundRect' && call.args[2] === resizedWidth - defaultTokens.padX * 2,
    )).toBe(true)
    expect(calls.some((call) =>
      call.method === 'fillText' && String(call.args[0]).startsWith('abc') &&
      call.args[0] !== 'abcdefghijklmnopqrstuv',
    )).toBe(true)
  })

  it('paints a resizing node only at live geometry with live chrome and selection', () => {
    const scene = fixtureScene('withMismatch')
    const node = nodeOf(scene, 'img')
    const image = {} as CanvasImageSource
    const nodePreview = { image, width: 320, height: 180 }
    const preview = {
      nodeId: node.id,
      x: node.x - 35,
      y: node.y - 20,
      width: node.layout.width + 90,
      height: node.layout.height + defaultTokens.previewGap + defaultTokens.previewMinHeight + 70,
    }
    const calls = paintWith(scene, (renderer) => {
      renderer.setNodePreviews({ [node.id]: nodePreview })
      renderer.setOverlay({
        selection: new Set([node.id]),
        resizePreview: preview,
      })
    })

    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === preview.x && call.args[1] === preview.y &&
      call.args[2] === preview.width && call.args[3] === preview.height,
    )).toBe(true)
    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === node.x && call.args[1] === node.y &&
      call.args[2] === node.layout.width && call.args[3] === node.layout.height,
    )).toBe(false)
    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === preview.x - 3 && call.args[1] === preview.y - 3 &&
      call.args[2] === preview.width + 6 && call.args[3] === preview.height + 6,
    )).toBe(true)
    const outputPin = node.layout.pins.find((pin) => pin.direction === 'out')!
    expect(calls.some((call) =>
      call.method === 'arc' &&
      call.args[0] === preview.x + preview.width && call.args[1] === preview.y + outputPin.y,
    )).toBe(true)
    const link = scene.links.find((candidate) => candidate.from.kind === 'port' && candidate.from.node === node.id)!
    const linkCurveIndex = calls.findIndex((call) =>
      call.method === 'bezierCurveTo' && call.args[4] === link.x2 && call.args[5] === link.y2,
    )
    expect(linkCurveIndex).toBeGreaterThan(0)
    expect(calls[linkCurveIndex - 1]).toMatchObject({
      method: 'moveTo',
      args: [preview.x + preview.width, preview.y + outputPin.y],
    })
    expect(calls.some((call) =>
      call.method === 'moveTo' && call.args[0] === link.x1 && call.args[1] === link.y1,
    )).toBe(false)
    const projectedLayout = projectNodeLayoutHeight(withPreviewRegion(node.layout, defaultTokens), preview.height, defaultTokens)
    const panel = { ...projectedLayout.preview!, width: preview.width - defaultTokens.padX * 2 }
    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === preview.x + panel.x && call.args[1] === preview.y + panel.y &&
      call.args[2] === panel.width && call.args[3] === panel.height,
    )).toBe(true)
    expect(calls.some((call) =>
      call.method === 'setLineDash' && JSON.stringify(call.args[0]) === '[6,4]',
    )).toBe(false)
  })

  it('draws one padded dashed union outline only for multiple selected items', () => {
    const scene = constructsScene()
    const node = nodeOf(scene, 'c1')
    const reroute = scene.reroutes.find((r) => r.id === 'rr')!
    const multi = paintWith(scene, (r) => r.setOverlay({
      selection: new Set(['c1']),
      rerouteSelection: new Set(['rr']),
    }))
    const x1 = Math.min(node.x, reroute.x - REROUTE_RADIUS) - 8
    const y1 = Math.min(node.y, reroute.y - REROUTE_RADIUS) - 8
    const x2 = Math.max(node.x + node.layout.width, reroute.x + REROUTE_RADIUS) + 8
    const y2 = Math.max(node.y + node.layout.height, reroute.y + REROUTE_RADIUS) + 8
    const outline = multi.find((c) =>
      c.method === 'strokeRect' && c.args[0] === x1 && c.args[1] === y1 &&
      c.args[2] === x2 - x1 && c.args[3] === y2 - y1)
    expect(outline).toMatchObject({ strokeStyle: defaultTokens.colors.nodeSelectedBorder, lineWidth: 1 })
    const outlineIndex = multi.indexOf(outline!)
    expect(multi.slice(0, outlineIndex).filter((c) => c.method === 'setLineDash').at(-1)?.args).toEqual([[5, 4]])

    const single = paintWith(scene, (r) => r.setOverlay({ selection: new Set(['c1']) }))
    expect(single.some((c) => c.method === 'setLineDash' && JSON.stringify(c.args[0]) === '[5,4]')).toBe(false)
  })

  it('dims connected widget rows and strikes only stored values without companions', () => {
    const scene = constructsScene((json) => {
      json.graphs.g0.nodes.fs.values = { f: 3.5 }
    })
    const fs = nodeOf(scene, 'fs')
    const row = fs.layout.rows.find((candidate) => candidate.kind === 'widget')!
    const calls = paint(scene)
    const connectedText = calls.find((c) => c.method === 'fillText' && c.args[1] === fs.x + row.inset + 6)
    expect(connectedText?.globalAlpha).toBeCloseTo(0.45)
    const valueText = calls.find((c) => c.method === 'fillText' && c.args[0] === '3.5')!
    const strike = calls.slice(calls.indexOf(valueText) + 1).find((c) => c.method === 'stroke')!
    const strikeIndex = calls.indexOf(strike)
    expect(strike).toMatchObject({
      strokeStyle: defaultTokens.colors.value,
      lineWidth: 1.5,
      globalAlpha: 0.45,
    })
    expect(calls[strikeIndex - 2]).toMatchObject({
      method: 'moveTo',
      args: [(valueText.args[1] as number) - 18, valueText.args[2]],
    })
    expect(calls[strikeIndex - 1]).toMatchObject({
      method: 'lineTo',
      args: [valueText.args[1], valueText.args[2]],
    })

    const companionCalls = paintWith(scene, (renderer) => {
      renderer.setCompanions({ fs: { f: { value: 2.5 } } })
    })
    expect(companionCalls.some((c) => c.method === 'fillText' && c.args[0] === '3.5')).toBe(false)
    const companionText = companionCalls.find((c) => c.method === 'fillText' && c.args[0] === '2.5')!
    expect(companionText).toMatchObject({
      fillStyle: defaultTokens.colors.companionValue,
      globalAlpha: 1,
    })
    expect(companionCalls.some((c) =>
      c.method === 'stroke' && c.strokeStyle === defaultTokens.colors.value && c.lineWidth === 1.5,
    )).toBe(false)

    const unprovenCalls = paintWith(scene, (renderer) => {
      renderer.setCompanions({ fs: { f: { value: 2.5, state: 'stale' } } })
    })
    expect(unprovenCalls.find((c) => c.method === 'fillText' && c.args[0] === '2.5')).toMatchObject({
      fillStyle: defaultTokens.colors.companionUnproven,
      globalAlpha: 1,
    })
    expect(unprovenCalls.find((c) =>
      c.method === 'stroke' && c.strokeStyle === defaultTokens.colors.companionUnproven,
    )).toMatchObject({ lineWidth: 1, globalAlpha: 1 })

    const boundaryOnly: Scene = {
      ...scene,
      links: scene.links.map((link) => link.id === 'lv' ? { ...link, boundary: true } : link),
      nodes: scene.nodes.map((node) => node.id === 'fs' ? {
        ...node,
        layout: {
          ...node.layout,
          rows: node.layout.rows.map((candidate) => candidate === row ? {
            ...candidate,
            selector: { construct: 'occurrence-selector', ancestors: [] },
          } : candidate),
        },
      } : node),
    }
    const bright = paint(boundaryOnly)
    const brightText = bright.find((c) => c.method === 'fillText' && c.args[1] === fs.x + row.inset + 6)
    expect(brightText?.globalAlpha).toBe(1)
  })

  it('keeps numeric stepper glyphs visible but muted on connected rows', () => {
    const scene = constructsScene()
    const free = nodeOf(scene, 'fs2')
    const connected = nodeOf(scene, 'fs')
    const freeRow = free.layout.rows.find((row) => row.kind === 'widget')!
    const connectedRow = connected.layout.rows.find((row) => row.kind === 'widget')!
    const calls = paint(scene)
    const minusGlyph = (node: SceneNode, row: Extract<(typeof node.layout.rows)[number], { kind: 'widget' }>) => calls.find((c) =>
      c.method === 'moveTo' && c.args[0] === node.x + row.inset + 3 && c.args[1] === node.y + row.y + defaultTokens.rowHeight / 2)
    const plusGlyph = (node: SceneNode, row: Extract<(typeof node.layout.rows)[number], { kind: 'widget' }>) => calls.find((c) =>
      c.method === 'moveTo' && c.args[0] === node.x + node.layout.width - row.inset - 9 && c.args[1] === node.y + row.y + defaultTokens.rowHeight / 2)
    expect(minusGlyph(free, freeRow)).toBeDefined()
    expect(plusGlyph(free, freeRow)).toBeDefined()
    expect(minusGlyph(connected, connectedRow)).toBeDefined()
    expect(plusGlyph(connected, connectedRow)).toBeDefined()
    expect(minusGlyph(connected, connectedRow)!.globalAlpha).toBeLessThan(minusGlyph(free, freeRow)!.globalAlpha)
  })

  it('a selected node paints a WHITE selection outline (never the blue accent)', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (r) => r.setOverlay({ selection: new Set(['c1']) }))
    const haloIdx = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === n.x - 3 && c.args[1] === n.y - 3 && c.args[2] === n.layout.width + 6,
    )
    expect(haloIdx).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, haloIdx, 'stroke')
    expect(stroke?.strokeStyle).toBe(defaultTokens.colors.nodeSelectedBorder)
    expect(stroke?.strokeStyle).toBe('#ffffff')
    expect(stroke?.strokeStyle).not.toBe(SEL)
    expect(stroke?.lineWidth).toBe(2)
  })

  it('paints region identity with a loop glyph, kind label, and doubled border without changing plain nodes', () => {
    const scene = fixtureScene('clean')
    const ordinary = nodeOf(scene, 'c1')
    const region: SceneNode = {
      ...ordinary,
      node: { ...ordinary.node, region: { kind: 'map', elementPorts: ['value'] } },
      regionKind: 'map',
    }
    const regionScene = { ...scene, nodes: scene.nodes.map((node) => node.id === region.id ? region : node) }
    const regionCalls = paint(regionScene)
    expect(regionCalls.some((call) => call.method === 'fillText' && call.args[0] === 'map')).toBe(true)
    expect(regionCalls.filter((call) =>
      call.method === 'roundRect' && call.args[0] === region.x && call.args[1] === region.y &&
      call.args[2] === region.layout.width && call.args[3] === region.layout.height
    ).length).toBeGreaterThanOrEqual(2)
    expect(regionCalls.some((call) =>
      call.method === 'roundRect' && call.args[0] === region.x + 3 && call.args[1] === region.y + 3 &&
      call.args[2] === region.layout.width - 6 && call.args[3] === region.layout.height - 6
    )).toBe(true)
    expect(regionCalls.some((call) => call.method === 'arc' && call.strokeStyle === defaultTokens.colors.title)).toBe(true)

    const ordinaryCalls = paint(scene)
    expect(ordinaryCalls.some((call) => call.method === 'fillText' && call.args[0] === 'map')).toBe(false)
    expect(ordinaryCalls.some((call) =>
      call.method === 'roundRect' && call.args[0] === ordinary.x + 3 && call.args[1] === ordinary.y + 3 &&
      call.args[2] === ordinary.layout.width - 6 && call.args[3] === ordinary.layout.height - 6
    )).toBe(false)
  })

  it('keeps selected-node outline geometry aligned past every viewport edge', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const edge = (viewport: { x: number; y: number; scale: number }, dpr: number) => {
      vi.stubGlobal('devicePixelRatio', dpr)
      const calls = paintWith(scene, (renderer) => {
        renderer.setViewport(viewport)
        renderer.setOverlay({ selection: new Set(['c1']) })
      })
      const strokeIndex = calls.findIndex((call) =>
        call.method === 'stroke' &&
        call.strokeStyle === defaultTokens.colors.nodeSelectedBorder &&
        call.lineWidth === Math.max(2, 2 / viewport.scale),
      )
      expect(strokeIndex).toBeGreaterThanOrEqual(0)
      const outline = calls.slice(0, strokeIndex).reverse().find((call) => call.method === 'roundRect')
      expect(outline?.args).toEqual([
        n.x - 3,
        n.y - 3,
        n.layout.width + 6,
        n.layout.height + 6,
        defaultTokens.cornerRadius + 3,
      ])
    }

    for (const dpr of [1, 1.25, 2]) {
      for (const scale of [0.1, 0.75, 1.75, 4]) {
        const leftView = n.x
        const rightView = n.x + n.layout.width
        const topView = n.y
        const bottomView = n.y + n.layout.height
        const centeredX = 800 - (n.x + n.layout.width / 2) * scale
        const centeredY = 600 - (n.y + n.layout.height / 2) * scale
        edge({ x: -leftView * scale, y: centeredY, scale }, dpr)
        edge({ x: 1600 - rightView * scale, y: centeredY, scale }, dpr)
        edge({ x: centeredX, y: -topView * scale, scale }, dpr)
        edge({ x: centeredX, y: 1200 - bottomView * scale, scale }, dpr)
      }
    }
    vi.stubGlobal('devicePixelRatio', 1)
  })

  it('paints one bounded full-height outline for a partially visible tall node and culls an invisible selection', () => {
    const original = nodeOf(fixtureScene('clean'), 'c1')
    const tall = { ...original, id: 'tall', x: 100, y: 100, layout: { ...original.layout, height: 20_500 } }
    const invisible = { ...original, id: 'invisible', x: 5000, y: 5000 }
    const calls = paintWith(emptyScene({ nodes: [tall, invisible] }), (renderer) => {
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.setBadges({ tall: [MUTED_BADGE] })
      renderer.setOverlay({ selection: new Set(['tall', 'invisible']) })
    })
    const selectedStrokes = calls.filter((call) =>
      call.method === 'stroke' && call.strokeStyle === defaultTokens.colors.nodeSelectedBorder && call.lineWidth === 2,
    )
    expect(selectedStrokes).toHaveLength(1)
    const strokeIndex = calls.indexOf(selectedStrokes[0]!)
    expect(calls.slice(0, strokeIndex).reverse().find((call) => call.method === 'roundRect')?.args).toEqual([
      tall.x - 3,
      tall.y - 3,
      tall.layout.width + 6,
      tall.layout.height + 6,
      defaultTokens.cornerRadius + 3,
    ])
    expect(calls.some((call) => call.method === 'roundRect' && call.args[0] === invisible.x)).toBe(false)
    expect(calls.some((call) => call.method === 'arc' && call.args[0] === tall.x)).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === MUTED_BADGE.glyph)).toBe(true)
  })

  it('paints a custom node color as a strong header and subtle body tint', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1' ? { ...node, color: '#355c7d' } : node),
    }
    const calls = paint(scene)
    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#293036' && call.globalAlpha === 1)).toBe(true)
    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#2f4b63' && call.globalAlpha === 1)).toBe(true)
  })

  it('keeps state outline precedence on a colored node', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1' ? { ...node, color: '#355c7d' } : node),
    }
    const node = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (renderer) => {
      renderer.setNodeStates({ c1: { state: 'running', value: 0.5 } })
      renderer.setBadges({ c1: [PROBLEM_ERROR_BADGE] })
    })
    expect(nodeBorder(calls, node)?.strokeStyle).toBe(defaultTokens.colors.error)
    expect(nodeBorder(calls, node)?.lineWidth).toBe(2.5)
  })

  it('keeps custom-colored muted and bypassed nodes distinguishable', () => {
    const base = fixtureScene('clean')
    const withMode = (mode: 'muted' | 'bypassed'): Scene => ({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1'
        ? { ...node, color: '#355c7d', node: { ...node.node, mode } }
        : node),
    })
    const mutedCalls = paint(withMode('muted'))
    expect(mutedCalls.filter((call) => call.method === 'fill' && (call.fillStyle === '#293036' || call.fillStyle === '#2f4b63'))
      .every((call) => call.globalAlpha === 0.45)).toBe(true)
    expect(mutedCalls.some((call) => call.method === 'fill' && call.fillStyle === defaultTokens.colors.bypassWash)).toBe(false)

    const bypassedCalls = paint(withMode('bypassed'))
    expect(bypassedCalls.filter((call) => call.method === 'fill' && (call.fillStyle === '#293036' || call.fillStyle === '#2f4b63'))
      .every((call) => call.globalAlpha === 0.45)).toBe(true)
    expect(bypassedCalls.some((call) => call.method === 'fill' && call.fillStyle === defaultTokens.colors.bypassWash)).toBe(true)
  })

  it('keeps colored-node title and lens overlays above identity paint without replacing the header', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1' ? { ...node, color: '#355c7d' } : node),
    }
    const calls = paintWith(scene, (renderer) => renderer.setLensCapabilities({
      nodeBodyContent: (node) => node.id === 'c1' ? [{ label: 'value', text: '42' }] : null,
      typeAdornments: true,
    }))
    const node = nodeOf(scene, 'c1')
    const outputRow = scene.nodes.flatMap((candidate) => candidate.layout.rows)
      .find((row) => row.kind === 'ports' && row.output !== undefined)
    expect(outputRow).toBeDefined()
    if (outputRow?.kind !== 'ports' || outputRow.output === undefined) throw new Error('fixture needs an output row')
    const typeLabel = presentedType(defaultTokens, outputRow.output.type).label
    const header = calls.findIndex((call) => call.method === 'fill' && call.fillStyle === '#2f4b63')
    const title = calls.findIndex((call) => call.method === 'fillText' && call.fillStyle === defaultTokens.colors.title &&
      call.args[1] === node.x + defaultTokens.padX)
    const dataPanelOffset = calls.slice(header + 1)
      .findIndex((call) => call.method === 'fillRect' && call.fillStyle === defaultTokens.colors.canvasBackground)
    const dataPanel = dataPanelOffset < 0 ? -1 : header + 1 + dataPanelOffset
    const overlay = calls.findIndex((call) => call.method === 'fillText' && call.args[0] === typeLabel &&
      call.font === `600 ${Math.max(8, defaultTokens.fontSize - 2)}px ${defaultTokens.fontFamily}`)
    expect(header).toBeGreaterThanOrEqual(0)
    expect(title).toBeGreaterThan(header)
    expect(dataPanel).toBeGreaterThan(header)
    expect(overlay).toBeGreaterThan(dataPanel)
    expect(calls.filter((call) => call.method === 'fill' && call.fillStyle === '#2f4b63')).toHaveLength(1)
  })

  it('muted and bypassed dim the whole node; bypassed also gets the purple wash', () => {
    // Mode->paint is the renderer's contract; mode storage is document
    // state proven elsewhere, so inject the mode on the scene node.
    const base = fixtureScene('clean')
    const withMode = (id: string, mode: 'muted' | 'bypassed'): Scene => ({
      ...base,
      nodes: base.nodes.map((n) => (n.id === id ? { ...n, node: { ...n.node, mode } } : n)),
    })

    const muted = withMode('c1', 'muted')
    const mNode = nodeOf(muted, 'c1')
    const mCalls = paint(muted)
    const mBodyIdx = mCalls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === mNode.x && c.args[1] === mNode.y && c.args[3] === mNode.layout.height,
    )
    expect(mBodyIdx).toBeGreaterThanOrEqual(0)
    const mFill = paintedAfter(mCalls, mBodyIdx, 'fill')
    expect(mFill?.fillStyle).toBe(defaultTokens.colors.nodeBody)
    expect(mFill?.globalAlpha).toBeCloseTo(0.45)

    const byp = withMode('c1', 'bypassed')
    const bNode = nodeOf(byp, 'c1')
    const bCalls = paint(byp)
    const bBodyIdx = bCalls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === bNode.x && c.args[1] === bNode.y && c.args[3] === bNode.layout.height,
    )
    expect(bBodyIdx).toBeGreaterThanOrEqual(0)
    const bFill = paintedAfter(bCalls, bBodyIdx, 'fill')
    expect(bFill?.fillStyle).toBe(defaultTokens.colors.nodeBody)
    expect(bFill?.globalAlpha).toBeCloseTo(0.45)
    const wash = bCalls.find((c) => c.method === 'fill' && c.fillStyle === defaultTokens.colors.bypassWash)
    expect(wash).toBeDefined()
    expect(wash?.globalAlpha).toBeCloseTo(0.45)
  })

  it('an unrecognized node paints red-hued fills and a triple-width error border', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'c1' ? { ...n, unrecognized: true, missingSchema: true } : n)),
    }
    const n = nodeOf(scene, 'c1')
    const calls = paint(scene)
    const bodyIdx = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === n.x && c.args[1] === n.y && c.args[3] === n.layout.height,
    )
    expect(paintedAfter(calls, bodyIdx, 'fill')?.fillStyle).toBe('#4e2f2e')
    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#683231')).toBe(true)
    expect(nodeBorder(calls, n)).toMatchObject({
      strokeStyle: defaultTokens.colors.error,
      lineWidth: 3.75,
    })
  })

  it('paints an unrecognized error border beneath the selection outline', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1'
        ? { ...node, unrecognized: true, node: { ...node.node, mode: 'muted' } }
        : node),
    }
    const node = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (renderer) => renderer.setOverlay({ selection: new Set(['c1']) }))
    const errorStrokeIndex = calls.findIndex((call) =>
      call.method === 'stroke' && call.strokeStyle === defaultTokens.colors.error && call.lineWidth === 3.75)
    const selectionStrokeIndex = calls.findIndex((call) =>
      call.method === 'stroke' && call.strokeStyle === defaultTokens.colors.nodeSelectedBorder && call.lineWidth === 2)
    const bodyFill = calls.find((call) => call.method === 'fill' && call.fillStyle === '#4e2f2e')
    const headerFill = calls.find((call) => call.method === 'fill' && call.fillStyle === '#683231')
    const errorStroke = calls[errorStrokeIndex]
    const selectionStroke = calls[selectionStrokeIndex]
    const titleIndex = calls.findIndex((call) => call.method === 'fillText' && call.args[1] === node.x + defaultTokens.padX)
    const title = calls[titleIndex]
    expect(errorStrokeIndex).toBeGreaterThanOrEqual(0)
    expect(selectionStrokeIndex).toBeGreaterThan(errorStrokeIndex)
    expect(titleIndex).toBeGreaterThan(selectionStrokeIndex)
    expect([bodyFill, headerFill, errorStroke, title].every((call) => call?.globalAlpha === 0.45)).toBe(true)
    expect(selectionStroke?.globalAlpha).toBe(1)
  })

  it('lets unrecognized paint override a custom node identity color', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1'
        ? { ...node, color: '#355c7d', unrecognized: true }
        : node),
    }
    const calls = paint(scene)
    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#4e2f2e')).toBe(true)
    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#683231')).toBe(true)
    expect(calls.some((call) => call.method === 'fill' && (call.fillStyle === '#293036' || call.fillStyle === '#2f4b63'))).toBe(false)
  })

  it('a recognized node paints no unrecognized error color', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const calls = paint(scene)
    expect(calls.some((call) => call.method === 'fill' && (call.fillStyle === '#4e2f2e' || call.fillStyle === '#683231'))).toBe(false)
    expect(nodeBorder(calls, node)?.strokeStyle).toBe(defaultTokens.colors.nodeOutline)
  })

  it('a document-error badge wins over running with an emphasized red node outline', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (renderer) => {
      renderer.setNodeStates({ c1: { state: 'running', value: 0.5 } })
      renderer.setBadges({ c1: [PROBLEM_ERROR_BADGE] })
    })
    expect(nodeBorder(calls, node)?.strokeStyle).toBe(defaultTokens.colors.error)
    expect(nodeBorder(calls, node)?.lineWidth).toBe(2.5)
  })

  it('a blocking-warning badge wins over a completed run with an emphasized orange node outline', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const tokens: DesignTokens = {
      ...defaultTokens,
      colors: { ...defaultTokens.colors, blockingWarning: '#d47728' },
    }
    const calls = paintWithTokens(scene, tokens, (renderer) => {
      renderer.setNodeStates({ c1: { state: 'done' } })
      renderer.setBadges({ c1: [PROBLEM_BLOCKING_WARNING_BADGE] })
    })
    expect(PROBLEM_BLOCKING_WARNING_BADGE.color).toBe(defaultTokens.colors.blockingWarning)
    expect(nodeBorder(calls, node)?.strokeStyle).toBe(tokens.colors.blockingWarning)
    expect(nodeBorder(calls, node)?.lineWidth).toBe(2.5)
    const rect = badgeRect(node, 0)
    const chip = calls.findIndex((call) =>
      call.method === 'roundRect' && call.args[0] === rect.x && call.args[1] === rect.y)
    expect(paintedAfter(calls, chip, 'fill')?.fillStyle).toBe(tokens.colors.blockingWarning)
  })

  it('an advisory-warning badge keeps the default node outline', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [PROBLEM_WARNING_BADGE] }))
    expect(nodeBorder(calls, node)?.strokeStyle).toBe(defaultTokens.colors.nodeOutline)
    expect(nodeBorder(calls, node)?.lineWidth).toBe(1.25)
  })

  it('error outlines own their dash over blocking warnings', () => {
    const base = fixtureScene('clean')
    const tokens: DesignTokens = {
      ...defaultTokens,
      colors: { ...defaultTokens.colors, error: '#f44336' },
      stateColors: { ...defaultTokens.stateColors, error: '#d50000' },
    }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1' ? { ...node, missingSchema: true } : node),
    }
    const missing = nodeOf(scene, 'c1')
    const missingCalls = paintWithTokens(scene, tokens, (renderer) => {
      renderer.setNodeStates({ c1: { state: 'error' } })
      renderer.setBadges({ c1: [PROBLEM_BLOCKING_WARNING_BADGE] })
    })
    expect(nodeBorder(missingCalls, missing)).toMatchObject({
      strokeStyle: tokens.colors.error,
      lineDash: [4, 2],
    })

    const normal = nodeOf(base, 'c1')
    const runtimeCalls = paintWithTokens(base, tokens, (renderer) => {
      renderer.setNodeStates({ c1: { state: 'error' } })
      renderer.setBadges({ c1: [PROBLEM_ERROR_BADGE, PROBLEM_BLOCKING_WARNING_BADGE] })
    })
    expect(nodeBorder(runtimeCalls, normal)).toMatchObject({
      strokeStyle: tokens.stateColors.error,
      lineWidth: 2.5,
      lineDash: [4, 2],
    })

    const documentCalls = paintWithTokens(base, tokens, (renderer) => {
      renderer.setBadges({ c1: [PROBLEM_ERROR_BADGE, PROBLEM_BLOCKING_WARNING_BADGE] })
    })
    expect(nodeBorder(documentCalls, normal)).toMatchObject({
      strokeStyle: tokens.colors.error,
      lineDash: [4, 2],
    })
  })

  it('running state wins over a blocking-warning outline', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (renderer) => {
      renderer.setNodeStates({ c1: { state: 'running', value: 0.5 } })
      renderer.setBadges({ c1: [PROBLEM_BLOCKING_WARNING_BADGE] })
    })
    expect(nodeBorder(calls, node)).toMatchObject({
      strokeStyle: defaultTokens.stateColors.running,
      lineWidth: 2.5,
      lineDash: [],
    })
  })

  it('a fallback value row paints its stored key and value text', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'c1'
          ? {
              ...n,
              missingSchema: true,
              layout: {
                ...n.layout,
                rows: [{ kind: 'fallback' as const, y: n.layout.headerHeight, height: 24, label: 'steps', text: '20' }],
                pins: [],
              },
            }
          : n,
      ),
    }
    const texts = paint(scene).filter((c) => c.method === 'fillText').map((c) => c.args[0])
    expect(texts).toContain('steps')
    expect(texts).toContain('20')
  })

  it('a diagnosed widget row paints a red outline; undiagnosed rows never do', () => {
    const scene = constructsScene()
    const free = nodeOf(scene, 'fs2')
    const row = free.layout.rows.find((candidate) => candidate.kind === 'widget')!
    const marked = paintWith(scene, (r) => r.setRowMarks({ fs2: new Set([row.valueKey]) }))
    const chrome = widgetChromeRect(
      free.x + row.inset,
      free.y + row.y,
      free.layout.width - row.inset * 2,
      row.height,
    )
    const outline = marked.find(
      (c) =>
        c.method === 'roundRect' &&
        c.strokeStyle === defaultTokens.colors.error &&
        c.args[0] === chrome.x &&
        c.args[1] === chrome.y &&
        c.args[2] === chrome.width &&
        c.args[3] === chrome.height &&
        c.args[4] === chrome.radius,
    )
    expect(outline).toBeDefined()
    expect(outline?.lineWidth).toBe(1.5)
    // No marks installed: no widget row paints the red outline.
    const unmarked = paint(scene)
    expect(
      unmarked.some((c) => c.method === 'roundRect' && c.strokeStyle === defaultTokens.colors.error),
    ).toBe(false)
  })

  it('a diagnosed fallback value row paints a red outline keyed by its stored key', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'c1'
          ? {
              ...n,
              missingSchema: true,
              layout: {
                ...n.layout,
                rows: [{ kind: 'fallback' as const, y: n.layout.headerHeight, height: 24, label: 'steps', text: '20' }],
                pins: [],
              },
            }
          : n,
      ),
    }
    const n = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (r) => r.setRowMarks({ c1: new Set(['steps']) }))
    const outline = calls.find(
      (c) =>
        c.method === 'strokeRect' &&
        c.strokeStyle === defaultTokens.colors.error &&
        c.args[1] === n.y + n.layout.headerHeight + 2,
    )
    expect(outline).toBeDefined()
    // A mark for a DIFFERENT key outlines nothing.
    const other = paintWith(scene, (r) => r.setRowMarks({ c1: new Set(['cfg']) }))
    expect(
      other.some(
        (c) =>
          c.method === 'strokeRect' &&
          c.strokeStyle === defaultTokens.colors.error &&
          c.args[1] === n.y + n.layout.headerHeight + 2,
      ),
    ).toBe(false)
  })

  it('run states drive the border: running widens + colors it and draws the progress bar', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (r) =>
      r.setNodeStates({ c1: { state: 'running', value: 0.5, max: 20 }, c2: { state: 'error' } }),
    )
    const running = defaultTokens.stateColors.running
    expect(calls.some((c) => c.method === 'stroke' && c.strokeStyle === running && c.lineWidth === 2.5)).toBe(true)
    expect(calls.some((c) =>
      c.method === 'stroke' && c.strokeStyle === running && c.shadowColor === running && c.shadowBlur > 8,
    )).toBe(true)
    expect(calls.some((c) =>
      c.method === 'stroke' && c.strokeStyle === defaultTokens.progressBar && c.lineDash.length > 0,
    )).toBe(true)
    expect(
      calls.some((c) => c.method === 'stroke' && c.strokeStyle === defaultTokens.stateColors.error && c.lineWidth === 2.5),
    ).toBe(true)
    // Determinate progress: a bar under the header at exactly value * width.
    const bar = calls.find(
      (c) =>
        c.method === 'fillRect' &&
        c.fillStyle === defaultTokens.progressBar &&
        c.args[0] === n.x &&
        c.args[1] === n.y + n.layout.headerHeight - 3,
    )
    expect(bar).toBeDefined()
    expect(bar!.args[2]).toBeCloseTo(n.layout.width * 0.5)
    expect(bar!.args[3]).toBe(3)
  })

  it('schedules flowing-border frames only while a node is running', () => {
    let pending: FrameRequestCallback | undefined
    let requests = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pending = callback
      requests += 1
      return requests
    })
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    const runFrame = (timestamp: number) => {
      const callback = pending
      pending = undefined
      if (callback === undefined) throw new Error('animation frame was not scheduled')
      callback(timestamp)
    }
    try {
      renderer.setScene(fixtureScene('clean'))
      runFrame(100)
      expect(requests).toBe(1)
      expect(pending).toBeUndefined()

      calls.length = 0
      renderer.setNodeStates({ c1: { state: 'running', value: 0.5 } })
      expect(requests).toBe(2)
      runFrame(200)
      const first = calls.find((call) =>
        call.method === 'stroke' && call.strokeStyle === defaultTokens.progressBar && call.lineDash.length > 0)
      expect(first).toBeDefined()
      expect(pending).toBeDefined()

      calls.length = 0
      runFrame(700)
      const second = calls.find((call) =>
        call.method === 'stroke' && call.strokeStyle === defaultTokens.progressBar && call.lineDash.length > 0)
      expect(second).toBeDefined()
      expect(second!.lineDashOffset).not.toBe(first!.lineDashOffset)

      renderer.setNodeStates({ c1: { state: 'done' } })
      calls.length = 0
      runFrame(800)
      expect(calls.some((call) =>
        call.method === 'stroke' && call.strokeStyle === defaultTokens.progressBar && call.lineDash.length > 0,
      )).toBe(false)
      expect(pending).toBeUndefined()
    } finally {
      renderer.dispose()
      vi.stubGlobal('requestAnimationFrame', () => 0)
    }
  })

  it('uses a static glow without scheduling animation under reduced motion', () => {
    let pending: FrameRequestCallback | undefined
    let requests = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pending = callback
      requests += 1
      return requests
    })
    const { ctx, calls } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    try {
      renderer.setScene(fixtureScene('clean'))
      renderer.setReducedMotion(true)
      renderer.setNodeStates({ c1: { state: 'running', value: 0.5 } })
      const callback = pending
      pending = undefined
      if (callback === undefined) throw new Error('initial frame was not scheduled')
      callback(200)

      const running = defaultTokens.stateColors.running
      expect(calls.some((call) =>
        call.method === 'stroke' && call.strokeStyle === running && call.shadowColor === running && call.shadowBlur > 0,
      )).toBe(true)
      expect(calls.some((call) =>
        call.method === 'stroke' && call.strokeStyle === defaultTokens.progressBar && call.lineDash.length > 0,
      )).toBe(false)
      expect(requests).toBe(1)
      expect(pending).toBeUndefined()
    } finally {
      renderer.dispose()
      vi.stubGlobal('requestAnimationFrame', () => 0)
    }
  })

  it('FR6 a non-finite or negative progress value never paints a NaN or reverse bar', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const bars = (value: number) => paintWith(scene, (renderer) =>
      renderer.setNodeStates({ c1: { state: 'running', value } }),
    ).filter((call) =>
      call.method === 'fillRect' && call.fillStyle === defaultTokens.progressBar &&
      call.args[0] === n.x && call.args[1] === n.y + n.layout.headerHeight - 3,
    )
    expect(bars(Number.NaN)).toEqual([])
    expect(bars(Number.POSITIVE_INFINITY)).toEqual([])
    expect(bars(Number.NEGATIVE_INFINITY)).toEqual([])
    const negative = bars(-0.5)
    expect(negative.length === 0 || negative[0]!.args[2] === 0).toBe(true)
    expect(bars(2)[0]!.args[2]).toBe(n.layout.width)
  })

  it('an unconnected optional input paints the donut: filled type-color disc with a hollow center', () => {
    const scene = constructsScene()
    const n = nodeOf(scene, 'opt2')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    // Outer disc: FILLED with the type color (not a stroked ring).
    const discIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius,
    )
    expect(discIdx).toBeGreaterThanOrEqual(0)
    const disc = paintedAfter(calls, discIdx, 'fill')
    expect(disc?.fillStyle).toBe(LATENT)
    // Center hole: punched in the canvas background, so the donut reads as
    // a colored body with a hollow middle - never a ring around a color dot.
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    const holeIdx = calls.findIndex((c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === dotR)
    expect(holeIdx).toBeGreaterThan(discIdx)
    expect(paintedAfter(calls, holeIdx, 'fill')?.fillStyle).toBe(defaultTokens.colors.canvasBackground)
  })

  it('a collapsed net keeps the optional sink donut and no bare noodle label', () => {
    const scene = constructsScene()
    // opt.in is fed by the collapsed net n1; opt2.in is genuinely unconnected.
    const calls = paint(scene)
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    const fed = nodeOf(scene, 'opt')
    const fedPin = fed.layout.pins.find((p) => p.direction === 'in')!
    const fx = fed.x
    const fy = fed.y + fedPin.y
    const discIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === fx && c.args[1] === fy && c.args[2] === defaultTokens.pinRadius,
    )
    expect(discIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, discIdx, 'fill')?.fillStyle).toBe(LATENT)
    expect(calls.some((c) => c.method === 'arc' && c.args[0] === fx && c.args[1] === fy && c.args[2] === dotR)).toBe(true)
    // The truly unconnected twin keeps its hollow center.
    const bare = nodeOf(scene, 'opt2')
    const barePin = bare.layout.pins.find((p) => p.direction === 'in')!
    expect(
      calls.some((c) => c.method === 'arc' && c.args[0] === bare.x && c.args[1] === bare.y + barePin.y && c.args[2] === dotR),
    ).toBe(true)
    // The hidden link paints no midpoint net name: only Set/Get tags label it.
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'feed')).toBe(false)
  })

  it('a connected required Autogrow member keeps a hollow family-growth center', () => {
    const scene = constructsScene()
    const node = nodeOf(scene, 'c1')
    const pin = node.layout.pins.find((candidate) => candidate.direction === 'in')!
    expect(pin.optional).toBeUndefined()
    ;(pin as { familyMember?: true }).familyMember = true
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    const calls = paint(scene)
    expect(calls.some((call) =>
      call.method === 'arc' && call.args[0] === node.x && call.args[1] === node.y + pin.y && call.args[2] === dotR,
    )).toBe(true)
  })

  it('a required single-type pin remains a solid type-colored circle without a center hole', () => {
    const scene = constructsScene()
    const n = nodeOf(scene, 'c1')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const outerIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius,
    )
    expect(paintedAfter(calls, outerIdx, 'fill')?.fillStyle).toBe(LATENT)
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    expect(calls.some((c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === dotR)).toBe(false)
  })

  it('a maybe-absent output stays type-colored and hollow even when connected', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'lat'
        ? {
            ...node,
            layout: {
              ...node.layout,
              pins: node.layout.pins.map((pin) => pin.direction === 'out'
                ? { ...pin, maybeAbsent: true as const }
                : pin),
            },
          }
        : node),
    }
    const maybeNode = nodeOf(scene, 'lat')
    const maybePin = maybeNode.layout.pins.find((pin) => pin.direction === 'out')!
    const maybeX = maybeNode.x + maybeNode.layout.width
    const maybeY = maybeNode.y + maybePin.y
    const ordinaryNode = nodeOf(scene, 'img')
    const ordinaryPin = ordinaryNode.layout.pins.find((pin) => pin.direction === 'out')!
    const ordinaryX = ordinaryNode.x + ordinaryNode.layout.width
    const ordinaryY = ordinaryNode.y + ordinaryPin.y
    const calls = paint(scene)
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)

    const discIdx = calls.findIndex((call) =>
      call.method === 'arc' && call.args[0] === maybeX && call.args[1] === maybeY && call.args[2] === defaultTokens.pinRadius)
    expect(discIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, discIdx, 'fill')?.fillStyle).toBe(LATENT)
    const holeIdx = calls.findIndex((call) =>
      call.method === 'arc' && call.args[0] === maybeX && call.args[1] === maybeY && call.args[2] === dotR)
    expect(holeIdx).toBeGreaterThan(discIdx)
    expect(paintedAfter(calls, holeIdx, 'fill')?.fillStyle).toBe(defaultTokens.colors.canvasBackground)
    expect(calls.some((call) =>
      call.method === 'arc' && call.args[0] === ordinaryX && call.args[1] === ordinaryY && call.args[2] === dotR)).toBe(false)
  })

  it('a three-type pin paints three colored slices with background divider radii', () => {
    const base = constructsScene()
    const union = { kind: 'union' as const, names: ['IMAGE', 'MASK', 'LATENT'] }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'c1'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: union })) } }
        : n),
    }
    const n = nodeOf(scene, 'c1')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const sliceFills = calls.filter((c) => c.method === 'fill' && [
      typeColor(defaultTokens, 'IMAGE'),
      typeColor(defaultTokens, 'MASK'),
      LATENT,
    ].includes(c.fillStyle))
    expect(new Set(sliceFills.map((c) => c.fillStyle))).toEqual(new Set([
      typeColor(defaultTokens, 'IMAGE'),
      typeColor(defaultTokens, 'MASK'),
      LATENT,
    ]))
    // Divider lines overshoot the outline (r * 2) and clip to the pin shape.
    const dividerLines = calls.filter((c) =>
      c.method === 'lineTo' &&
      Math.abs(Math.hypot(Number(c.args[0]) - px, Number(c.args[1]) - py) - defaultTokens.pinRadius * 2) < 1e-9)
    expect(dividerLines).toHaveLength(3)
    for (const line of dividerLines) {
      const stroke = calls.slice(calls.indexOf(line) + 1).find((c) => c.method === 'stroke')
      expect(stroke?.strokeStyle).toBe(defaultTokens.colors.canvasBackground)
      expect(stroke?.lineWidth).toBe(PIN_SLICE_DIVIDER_SCREEN_PX)
    }
  })

  it('an optional MultiType input composes a segmented ring with a hollow center', () => {
    const base = constructsScene()
    const union = { kind: 'union' as const, names: ['IMAGE', 'MASK', 'LATENT'] }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'opt2'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: union })) } }
        : n),
    }
    const n = nodeOf(scene, 'opt2')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    const holeIdx = calls.findIndex((c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === dotR)
    expect(holeIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, holeIdx, 'fill')?.fillStyle).toBe(defaultTokens.colors.canvasBackground)
    const fillsBeforeHole = calls.slice(0, holeIdx).filter((c) => c.method === 'fill').map((c) => c.fillStyle)
    expect(fillsBeforeHole).toContain(typeColor(defaultTokens, 'IMAGE'))
    expect(fillsBeforeHole).toContain(typeColor(defaultTokens, 'MASK'))
    expect(fillsBeforeHole).toContain(LATENT)
    expect(calls.slice(0, holeIdx).filter((c) =>
      c.method === 'lineTo' &&
      Math.abs(Math.hypot(Number(c.args[0]) - px, Number(c.args[1]) - py) - defaultTokens.pinRadius * 2) < 1e-9,
    )).toHaveLength(3)
  })

  it('a definitely-list pin paints a diamond in the element type color', () => {
    const base = constructsScene()
    const list = { kind: 'list' as const, element: { kind: 'concrete' as const, name: 'LATENT' } }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'c1'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: list })) } }
        : n),
    }
    const n = nodeOf(scene, 'c1')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const r = defaultTokens.pinRadius * PIN_DIAMOND_SCALE
    // Diamond outline: top vertex moveTo, then the three remaining vertices.
    const topIdx = calls.findIndex((c) => c.method === 'moveTo' && c.args[0] === px && c.args[1] === py - r)
    expect(topIdx).toBeGreaterThanOrEqual(0)
    expect(calls.some((c) => c.method === 'lineTo' && c.args[0] === px + r && c.args[1] === py)).toBe(true)
    expect(calls.some((c) => c.method === 'lineTo' && c.args[0] === px && c.args[1] === py + r)).toBe(true)
    expect(calls.some((c) => c.method === 'lineTo' && c.args[0] === px - r && c.args[1] === py)).toBe(true)
    // Color stays the ELEMENT type's: shape carries cardinality, color data.
    expect(paintedAfter(calls, topIdx, 'fill')?.fillStyle).toBe(LATENT)
    // No circular body at this pin: the diamond replaces the disc outright.
    expect(calls.some((c) =>
      c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius,
    )).toBe(false)
  })

  it('an optional list input composes a hollow diamond', () => {
    const base = constructsScene()
    const list = { kind: 'list' as const, element: { kind: 'concrete' as const, name: 'LATENT' } }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'opt2'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: list })) } }
        : n),
    }
    const n = nodeOf(scene, 'opt2')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const r = defaultTokens.pinRadius * PIN_DIAMOND_SCALE
    // Shape axis: diamond body in the element color...
    const topIdx = calls.findIndex((c) => c.method === 'moveTo' && c.args[0] === px && c.args[1] === py - r)
    expect(topIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, topIdx, 'fill')?.fillStyle).toBe(LATENT)
    // ...optionality axis: the center hole still punches through.
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    const holeIdx = calls.findIndex((c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === dotR)
    expect(holeIdx).toBeGreaterThan(topIdx)
    expect(paintedAfter(calls, holeIdx, 'fill')?.fillStyle).toBe(defaultTokens.colors.canvasBackground)
  })

  it('a list of a union segments the diamond into element-colored wedges', () => {
    const base = constructsScene()
    const listOfUnion = {
      kind: 'list' as const,
      element: { kind: 'union' as const, names: ['IMAGE', 'MASK'] },
    }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'c1'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: listOfUnion })) } }
        : n),
    }
    const n = nodeOf(scene, 'c1')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const r = defaultTokens.pinRadius * PIN_DIAMOND_SCALE
    // Diamond outline present...
    const topIdx = calls.findIndex((c) => c.method === 'moveTo' && c.args[0] === px && c.args[1] === py - r)
    expect(topIdx).toBeGreaterThanOrEqual(0)
    // ...MultiType axis: one wedge fill per union member, in element colors.
    const fills = calls.filter((c) => c.method === 'fill').map((c) => c.fillStyle)
    expect(fills).toContain(typeColor(defaultTokens, 'IMAGE'))
    expect(fills).toContain(typeColor(defaultTokens, 'MASK'))
    // Dividers overshoot to r * 2 so the clip trims them at the diamond edge.
    const dividerLines = calls.filter((c) =>
      c.method === 'lineTo' &&
      Math.abs(Math.hypot(Number(c.args[0]) - px, Number(c.args[1]) - py) - r * 2) < 1e-9)
    expect(dividerLines).toHaveLength(2)
  })

  it('MultiType divider orientation follows the pin direction', () => {
    // Three members break the symmetry: exactly one divider points straight
    // at the noodle side (west for inputs, east for outputs) and none points
    // the opposite way.
    const base = constructsScene()
    const union = { kind: 'union' as const, names: ['IMAGE', 'MASK', 'LATENT'] }
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'c1' || n.id === 'lat'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: union })) } }
        : n),
    }
    const calls = paint(scene)
    const sink = nodeOf(scene, 'c1')
    const src = nodeOf(scene, 'lat')
    const inPin = sink.layout.pins.find((p) => p.direction === 'in')!
    const outPin = src.layout.pins.find((p) => p.direction === 'out')!
    const inX = sink.x
    const inY = sink.y + inPin.y
    const outX = src.x + src.layout.width
    const outY = src.y + outPin.y
    const r2 = defaultTokens.pinRadius * 2
    const endsAt = (cx: number, cy: number, dx: number) => calls.some((c) =>
      c.method === 'lineTo' &&
      Math.abs(Number(c.args[0]) - (cx + dx)) < 1e-6 &&
      Math.abs(Number(c.args[1]) - cy) < 1e-6)
    expect(endsAt(inX, inY, -r2)).toBe(true) // input divider points west
    expect(endsAt(inX, inY, r2)).toBe(false)
    expect(endsAt(outX, outY, r2)).toBe(true) // output divider points east
    expect(endsAt(outX, outY, -r2)).toBe(false)
  })

  it('an unresolved match input uses a tangent circle inside an axis-aligned square', () => {
    const variable = { kind: 'variable' as const, templateId: 'T' }
    const base = constructsScene()
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1' || node.id === 'lat'
        ? {
            ...node,
            layout: {
              ...node.layout,
              pins: node.layout.pins.map((pin) => ({ ...pin, type: variable, matchVariable: 'T' })),
            },
          }
        : node),
    }
    const inputNode = nodeOf(scene, 'c1')
    const input = inputNode.layout.pins[0]!
    const inputX = inputNode.x
    const inputY = inputNode.y + input.y
    const outputNode = nodeOf(scene, 'lat')
    const output = outputNode.layout.pins[0]!
    const outputX = outputNode.x + outputNode.layout.width
    const outputY = outputNode.y + output.y
    const radius = defaultTokens.pinRadius
    const calls = paint(scene)

    expect(calls.some((call) => call.method === 'arc' && call.args[0] === inputX &&
      call.args[1] === inputY && call.args[2] === radius)).toBe(true)
    expect(calls.some((call) => call.method === 'moveTo' && call.args[0] === inputX - radius &&
      call.args[1] === inputY - radius)).toBe(true)
    expect(calls.some((call) => call.method === 'lineTo' && call.args[0] === inputX + radius &&
      call.args[1] === inputY - radius)).toBe(true)
    expect(calls.some((call) => call.method === 'lineTo' && call.args[0] === inputX + radius &&
      call.args[1] === inputY + radius)).toBe(true)
    expect(calls.some((call) => call.method === 'lineTo' && call.args[0] === inputX - radius &&
      call.args[1] === inputY + radius)).toBe(true)
    expect(calls.some((call) => call.method === 'moveTo' && call.args[0] === inputX &&
      call.args[1] === inputY - radius * PIN_DIAMOND_SCALE)).toBe(false)
    expect(calls.some((call) => call.method === 'lineTo' && call.args[0] === inputX + radius * PIN_DIAMOND_SCALE &&
      call.args[1] === inputY)).toBe(false)
    expect(calls.some((call) => call.method === 'arc' && call.args[0] === outputX &&
      call.args[1] === outputY && call.args[2] === radius)).toBe(true)
    expect(calls.some((call) => call.method === 'moveTo' && call.args[0] === outputX - radius &&
      call.args[1] === outputY - radius)).toBe(false)
  })

  it('a resolved match pin uses the standard dark solid outline', () => {
    const base = constructsScene()
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1'
        ? {
            ...node,
            layout: {
              ...node.layout,
              pins: node.layout.pins.map((pin) => ({
                ...pin,
                matchVariable: 'T',
                inferred: true as const,
              })),
            },
          }
        : node),
    }
    const node = nodeOf(scene, 'c1')
    const pin = node.layout.pins[0]!
    const px = node.x
    const py = node.y + pin.y
    const calls = paint(scene)
    const outlines = calls.filter((call) =>
      call.method === 'arc' && call.args[0] === px && call.args[1] === py &&
      call.args[2] === defaultTokens.pinRadius)
    const outline = calls.slice(calls.indexOf(outlines.at(-1)!) + 1).find((call) => call.method === 'stroke')
    expect(outline?.strokeStyle).toBe(defaultTokens.colors.canvasBackground)
    expect(outline?.lineWidth).toBe(1)
    expect(outline?.lineDash).toEqual([])
  })

  it('Any input and output pins use a neutral fill and dashed outer ring', () => {
    const base = constructsScene()
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'c1'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: { kind: 'wildcard' as const } })) } }
        : n),
    }
    const n = nodeOf(scene, 'c1')
    const calls = paint(scene)
    for (const pin of n.layout.pins) {
      const px = pin.direction === 'in' ? n.x : n.x + n.layout.width
      const py = n.y + pin.y
      const arc = calls.findIndex((c) =>
        c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius)
      expect(arc).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(calls, arc, 'fill')?.fillStyle).toBe(defaultTokens.colors.linkDefault)
      expect(calls.slice(arc).some((c) => c.method === 'setLineDash' && (c.args[0] as number[]).length > 0)).toBe(true)
    }
  })

  it('an optional Any input composes the dashed ring with a hollow center', () => {
    const base = constructsScene()
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) => n.id === 'opt2'
        ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, type: { kind: 'wildcard' as const } })) } }
        : n),
    }
    const n = nodeOf(scene, 'opt2')
    const pin = n.layout.pins.find((p) => p.direction === 'in')!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const dotR = Math.max(1.5, defaultTokens.pinRadius * 0.32)
    const hole = calls.findIndex((c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === dotR)
    expect(hole).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, hole, 'fill')?.fillStyle).toBe(defaultTokens.colors.canvasBackground)
    expect(calls.slice(0, hole).some((c) => c.method === 'setLineDash' && (c.args[0] as number[]).length > 0)).toBe(true)
  })

  it('a ghost pin renders hollow and dimmed, never filled', () => {
    const base = fixtureScene('clean')
    // Ghost derivation (dynamic affordances) is proven in dynamic-scene
    // tests; inject the flag to pin the renderer's hollow-paint contract.
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'c2'
          ? { ...n, layout: { ...n.layout, pins: n.layout.pins.map((p) => ({ ...p, ghost: true as const })) } }
          : n,
      ),
    }
    const n = nodeOf(scene, 'c2')
    const pin = n.layout.pins[0]!
    const px = n.x
    const py = n.y + pin.y
    const calls = paint(scene)
    const arcIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius,
    )
    expect(arcIdx).toBeGreaterThanOrEqual(0)
    const next = calls.slice(arcIdx + 1).find((c) => c.method === 'stroke' || c.method === 'fill')
    expect(next?.method).toBe('stroke')
    expect(next?.strokeStyle).toBe(LATENT)
    expect(next?.lineWidth).toBe(1.5)
    expect(next?.globalAlpha).toBeCloseTo(0.45)
  })

  it('a growth row paints a dashed ghost-alpha capsule with the "+ label" text', () => {
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: asLineageId('lin1'),
      root: asGraphDefId('g0'),
      graphs: {
        g0: {
          id: asGraphDefId('g0'),
          name: 'g',
          nodes: { p: { id: asNodeId('p'), type: 'PNest', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 100,
        },
      },
      view: { graphs: { g0: { nodes: { p: { position: { x: 100, y: 100 } } } } } },
    }
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (t) => synthetic.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const n = nodeOf(scene, 'p')
    const row = n.layout.rows.find((r) => r.kind === 'growth')!
    expect(row).toBeDefined()
    const t = defaultTokens
    const calls = paint(scene)
    // Dashed capsule: setLineDash([3,3]) precedes the strokeRect at the row
    // rect, dimmed to ghost alpha; the dash resets afterwards so nothing
    // downstream inherits it.
    const rectIdx = calls.findIndex(
      (c) =>
        c.method === 'strokeRect' &&
        c.args[0] === n.x + t.padX &&
        c.args[1] === n.y + row.y + 3 &&
        c.args[2] === n.layout.width - t.padX * 2 &&
        c.args[3] === row.height - 6,
    )
    expect(rectIdx).toBeGreaterThanOrEqual(0)
    expect(calls[rectIdx]!.globalAlpha).toBeCloseTo(0.45)
    const dashBefore = calls.slice(0, rectIdx).filter((c) => c.method === 'setLineDash')
    expect(dashBefore.at(-1)?.args).toEqual([[3, 3]])
    const dashAfter = calls.slice(rectIdx + 1).find((c) => c.method === 'setLineDash')
    expect(dashAfter?.args).toEqual([[]])
    // The affordance text: centered '+ items' at the same dimmed alpha.
    const text = calls.find((c) => c.method === 'fillText' && c.args[0] === '+ items')
    expect(text).toBeDefined()
    expect(text!.globalAlpha).toBeCloseTo(0.45)
  })

  it('a widget-backed pin hides until connected or the node is selected', () => {
    const scene = constructsScene()
    // fs is driven by the value source (pin shows); fs2 is dormant (hidden).
    const hidden = nodeOf(scene, 'fs2')
    const shown = nodeOf(scene, 'fs')
    const hPin = hidden.layout.pins.find((p) => p.widgetBacked === true)!
    const sPin = shown.layout.pins.find((p) => p.widgetBacked === true)!
    const at = (calls: PaintCall[], n: SceneNode, pinY: number) =>
      calls.some((c) => c.method === 'arc' && c.args[0] === n.x && c.args[1] === n.y + pinY)
    const calls = paint(scene)
    expect(at(calls, shown, sPin.y)).toBe(true)
    expect(at(calls, hidden, hPin.y)).toBe(false)
    // Selecting the dormant node reveals its widget-backed pin for wiring.
    const selCalls = paintWith(scene, (r) => r.setOverlay({ selection: new Set(['fs2']) }))
    expect(at(selCalls, hidden, hPin.y)).toBe(true)
    // Hovering the node (no selection) reveals it too: the wiring affordance
    // is discoverable by pointing, not only by selecting first.
    const hovCalls = paintWith(scene, (r) => r.setOverlay({ hoveredNode: 'fs2' }))
    expect(at(hovCalls, hidden, hPin.y)).toBe(true)
    // Hovering a DIFFERENT node leaves it hidden.
    const otherCalls = paintWith(scene, (r) => r.setOverlay({ hoveredNode: 'fs' }))
    expect(at(otherCalls, hidden, hPin.y)).toBe(false)
  })
})

describe('badge and toolbox paint on the live renderer', () => {
  it('hides the selection toolbox throughout a live resize preview', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const { ctx } = recordingCtx()
    const renderer = new CanvasRenderer(fakeCanvas(ctx), defaultTokens)
    renderer.setScene(scene)
    renderer.setToolbox([[
      { kind: 'button', button: { id: 'core.delete', icon: 'trash-2', label: 'Delete' } },
    ]])
    renderer.setOverlay({
      selection: new Set([node.id]),
      resizePreview: {
        nodeId: node.id,
        x: node.x,
        y: node.y,
        width: node.layout.width + 20,
        height: node.layout.height + 20,
      },
    })
    expect(renderer.getToolboxLayout()).toBeUndefined()
    renderer.dispose()
  })

  it('paints only genuinely renamed node titles in italic', () => {
    const base = fixtureScene('clean')
    const target = nodeOf(base, 'c1')
    const renamed = {
      ...base,
      nodes: base.nodes.map((node) => node.id === target.id
        ? { ...node, layout: { ...node.layout, title: 'Custom', titleRenamed: true } }
        : node),
    }
    const italic = paint(renamed).find((call) => call.method === 'fillText' && call.args[0] === 'Custom')
    expect(italic?.font).toBe(`italic 600 ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`)

    const normal = paint(base).find((call) => call.method === 'fillText' && call.args[0] === target.layout.title)
    expect(normal?.font).toBe(`600 ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`)
  })

  it('scope preview accents included nodes and only mildly dims excluded nodes', () => {
    const scene = fixtureScene('clean')
    const included = nodeOf(scene, 'c1')
    const calls = paintWith(scene, (r) => r.setScopeHighlight({
      nodes: new Set(['c1']),
      reroutes: new Set(),
      selectors: new Set(),
      selectorCandidates: new Set(),
      valueSources: new Set(),
    }))
    expect(calls.some((c) =>
      c.method === 'stroke' &&
      c.strokeStyle === defaultTokens.colors.selection &&
      c.lineWidth === 2.5
    )).toBe(true)
    const excludedBody = calls.find((c) =>
      c.method === 'roundRect' && c.args[0] !== included.x && c.globalAlpha === 0.72
    )
    expect(excludedBody).toBeDefined()
    expect(excludedBody!.globalAlpha).toBeGreaterThan(0.45)
  })

  it('dims only compiler-derived lazy-switch inactive nodes without a topology walk', () => {
    const scene = fixtureScene('clean')
    const inactive = nodeOf(scene, 'c1')
    const active = scene.nodes.find((node) => node.id !== inactive.id)!
    const calls = paintWith(scene, (renderer) => renderer.setInactiveNodes(new Set([inactive.id])))
    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === inactive.x &&
      call.args[1] === inactive.y &&
      call.globalAlpha === 0.72
    )).toBe(true)
    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === active.x &&
      call.args[1] === active.y &&
      call.globalAlpha === 1
    )).toBe(true)
    expect(calls.some((call) => call.method === 'stroke' && call.globalAlpha === 0.72)).toBe(true)

    const cleared = paintWith(scene, (renderer) => {
      renderer.setInactiveNodes(new Set([inactive.id]))
      renderer.setInactiveNodes(undefined)
    })
    expect(cleared.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === inactive.x &&
      call.args[1] === inactive.y &&
      call.globalAlpha === 0.72
    )).toBe(false)
  })

  it('header badges draw at badgeRect positions: chip fill then glyph, index 0 rightmost', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const badges = [ERROR_BADGE, SUBGRAPH_BADGE]
    const calls = paintWith(scene, (r) => r.setBadges({ c1: badges }))
    const r0 = badgeRect(n, 0, badges)
    const r1 = badgeRect(n, 1, badges)
    expect(r0.x).toBeGreaterThan(r1.x)
    for (const [rect, badge] of [
      [r0, ERROR_BADGE],
      [r1, SUBGRAPH_BADGE],
    ] as const) {
      const chipIdx = calls.findIndex(
        (c) => c.method === 'roundRect' && c.args[0] === rect.x && c.args[1] === rect.y && c.args[2] === rect.width,
      )
      expect(chipIdx, `chip for ${badge.id}`).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(calls, chipIdx, 'fill')?.fillStyle).toBe(badge.color)
      if (badge.icon === undefined) {
        expect(calls.some((c) =>
          c.method === 'fillText' && c.args[0] === badge.glyph &&
          c.args[1] === rect.x + rect.width / 2 && c.fillStyle === defaultTokens.colors.title,
        )).toBe(true)
      } else {
        expect(calls.some((c) => c.method === 'stroke' && c.strokeStyle === defaultTokens.colors.title)).toBe(true)
        expect(calls.some((c) => c.method === 'fillText' && c.args[0] === badge.glyph)).toBe(false)
      }
    }
  })

  it('draws attached policy and observed-state badges with distinct solid fills', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const policy = { id: 'test.policy', glyph: 'Native', variant: 'label' as const, appearance: 'policy' as const, placement: 'above' as const, color: '#23483e' }
    const observed = { id: 'test.observed', glyph: 'Native', variant: 'label' as const, placement: 'above' as const, color: '#286a55' }

    const policyRect = badgeRect(node, 0, [policy])
    const policyCalls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [policy] }))
    const policyPath = policyCalls.findIndex((call) =>
      call.method === 'roundRect' && call.args[0] === policyRect.x && call.args[1] === policyRect.y,
    )
    expect(policyRect.y + policyRect.height).toBe(node.y)
    expect(paintedAfter(policyCalls, policyPath, 'fill')?.fillStyle).toBe(policy.color)
    expect(policyCalls.slice(policyPath + 1).find((call) => call.method === 'fill' || call.method === 'stroke')?.method).toBe('fill')
    const title = policyCalls.find((call) => call.method === 'fillText' && call.args[0] === node.layout.title)
    expect(title?.args[3]).toBe(node.layout.width - defaultTokens.padX * 2 - 4)

    const observedRect = badgeRect(node, 0, [observed])
    const observedCalls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [observed] }))
    const observedPath = observedCalls.findIndex((call) =>
      call.method === 'roundRect' && call.args[0] === observedRect.x && call.args[1] === observedRect.y,
    )
    expect(paintedAfter(observedCalls, observedPath, 'fill')?.fillStyle).toBe(observed.color)
    expect(observedCalls.slice(observedPath + 1).find((call) => call.method === 'fill' || call.method === 'stroke')?.method).toBe('fill')
  })

  it('paints the subgraph badge vector icon while retaining its fallback glyph', () => {
    const scene = fixtureScene('clean')
    const calls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [SUBGRAPH_BADGE] }))
    expect(SUBGRAPH_BADGE.glyph).toBe('S')
    expect(SUBGRAPH_BADGE.icon).toBe('boxes')
    expect(calls.some((call) => call.method === 'stroke' && call.strokeStyle === defaultTokens.colors.title)).toBe(true)
    expect(calls.some((call) => call.method === 'fillText' && call.args[0] === 'S')).toBe(false)
  })

  it('centers the subgraph fallback glyph when vector painting fails', () => {
    const original = globalThis.Path2D
    vi.stubGlobal('Path2D', class Path2D { constructor() { throw new Error('paint failed') } })
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const rect = badgeRect(node, 0, [SUBGRAPH_BADGE])
    const calls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [SUBGRAPH_BADGE] }))
    vi.stubGlobal('Path2D', original)
    expect(calls.some((call) =>
      call.method === 'fillText' && call.args[0] === 'S' && call.args[1] === rect.x + rect.width / 2,
    )).toBe(true)
  })

  it('retains the subgraph fallback glyph on a linked-count badge', () => {
    const original = globalThis.Path2D
    vi.stubGlobal('Path2D', class Path2D { constructor() { throw new Error('paint failed') } })
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const badge = subgraphBadge(2)
    const rect = badgeRect(node, 0, [badge])
    const calls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [badge] }))
    vi.stubGlobal('Path2D', original)
    expect(calls.some((call) =>
      call.method === 'fillText' && call.args[0] === 'S' && call.args[1] === rect.x + rect.width / 2,
    )).toBe(true)
  })

  it('paints explicit mode and error words in readable header chips', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const badges = [ERROR_BADGE, MUTED_BADGE, BYPASSED_BADGE]
    const calls = paintWith(scene, (renderer) => renderer.setBadges({ c1: badges }))

    for (const [index, badge] of badges.entries()) {
      const rect = badgeRect(n, index, badges)
      expect(rect.width).toBeGreaterThan(BADGE_SIZE)
      expect(calls.some((call) =>
        call.method === 'fillText' &&
        call.args[0] === badge.glyph &&
        call.args[1] === rect.x + rect.width / 2
      )).toBe(true)
    }

    const leftmost = badgeRect(n, badges.length - 1, badges)
    const title = calls.find((call) => call.method === 'fillText' && call.args[0] === n.layout.title)
    expect(title?.args[3]).toBe(Math.max(0, leftmost.x - n.x - defaultTokens.padX - 4))

    const singleCalls = paintWith(scene, (renderer) => renderer.setBadges({ c1: [MUTED_BADGE] }))
    const singleRect = badgeRect(n, 0, [MUTED_BADGE])
    const singleTitle = singleCalls.find((call) => call.method === 'fillText' && call.args[0] === n.layout.title)
    expect(singleTitle?.args[3]).toBe(singleRect.x - n.x - defaultTokens.padX - 4)
  })

  it('paints mode badges with the active theme tokens', () => {
    const scene = fixtureScene('clean')
    const tokens: DesignTokens = {
      ...defaultTokens,
      colors: {
        ...defaultTokens.colors,
        mutedBadge: '#123456',
        bypassedBadge: '#654321',
      },
    }
    const calls = paintWithTokens(scene, tokens, (renderer) =>
      renderer.setBadges({ c1: [MUTED_BADGE, BYPASSED_BADGE] }))

    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#123456')).toBe(true)
    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === '#654321')).toBe(true)
  })

  it('keeps attached badges opaque without brightening the rest of a dimmed node', () => {
    const base = fixtureScene('clean')
    const scene: Scene = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'c1'
        ? { ...node, node: { ...node.node, mode: 'muted' } }
        : node),
    }
    const arm = { id: 'test.arm', glyph: 'COMFYUI', variant: 'label' as const, placement: 'above' as const, color: '#6a4fa3' }
    const calls = paintWith(scene, (renderer) => {
      renderer.setBadges({ c1: [arm] })
      renderer.setNodeStates({ c1: { state: 'running', value: 0.5 } })
    })

    expect(calls.some((call) => call.method === 'fill' && call.fillStyle === arm.color && call.globalAlpha === 1)).toBe(true)
    expect(calls.some((call) => call.method === 'fillRect' && call.fillStyle === defaultTokens.progressBar && call.globalAlpha === 0.45)).toBe(true)
  })

  it('the selection toolbox draws above the selection; active buttons fill, plain ones stay flat', () => {
    const scene = fixtureScene('clean')
    const n = nodeOf(scene, 'c1')
    const buttons = [
      { id: 'core.mode.muted', icon: 'volume-x' as const, label: 'Mute', active: true },
      { id: 'core.delete', icon: 'trash-2' as const, label: 'Delete' },
    ]
    let panel: { x: number; y: number; width: number; height: number } | undefined
    const calls = paintWith(scene, (r) => {
      r.setOverlay({ selection: new Set(['c1']) })
      r.setToolbox([buttons.map((button) => ({ kind: 'button' as const, button }))])
      panel = r.getToolboxLayout()!.rows[0]!.panel
    })
    const mIdx = calls.length - 1 - [...calls].reverse().findIndex(
      (c) => c.method === 'stroke' && c.strokeStyle === defaultTokens.colors.canvasBackground,
    )
    expect(mIdx).toBeGreaterThanOrEqual(0)
    // Active: filled with the selection color, icon inverted for contrast.
    const mFill = calls.slice(0, mIdx).reverse().find((c) => c.method === 'fill')
    expect(mFill?.fillStyle).toBe(SEL)
    const xIdx = calls.findIndex((c, index) => index > mIdx && c.method === 'stroke' && c.strokeStyle === defaultTokens.colors.label)
    expect(xIdx).toBeGreaterThan(mIdx)
    const xFill = calls.slice(0, xIdx).reverse().find((c) => c.method === 'fill')
    expect(xFill?.fillStyle).toBe(defaultTokens.colors.widgetBackground)
    // The painted panel stays wholly outside the white selection outline,
    // with the layout's exact 16 screen-pixel clearance at identity zoom.
    expect(panel!.y + panel!.height).toBe(n.y - 4 - 16)
    expect(calls.some((call) =>
      call.method === 'roundRect' &&
      call.args[0] === panel!.x && call.args[1] === panel!.y &&
      call.args[2] === panel!.width && call.args[3] === panel!.height
    )).toBe(true)
    const iconTranslate = calls.slice(0, mIdx).reverse().find((c) => c.method === 'translate')
    expect(iconTranslate?.args[1] as number).toBeLessThan(n.y)
  })

  it('raises the selection toolbox above an attached badge lane', () => {
    const scene = fixtureScene('clean')
    const node = nodeOf(scene, 'c1')
    const arm = { id: 'test.arm', glyph: 'COMFYUI', variant: 'label' as const, placement: 'above' as const, color: '#6a4fa3' }
    let panel: { y: number; height: number } | undefined
    paintWith(scene, (renderer) => {
      renderer.setViewport({ x: 0, y: 0, scale: 4 })
      renderer.setBadges({ c1: [arm] })
      renderer.setOverlay({ selection: new Set(['c1']) })
      renderer.setToolbox([[
        { kind: 'button', button: { id: 'core.delete', icon: 'trash-2', label: 'Delete' } },
      ]])
      panel = renderer.getToolboxLayout()!.rows[0]!.panel
    })

    const badgeTop = node.y - BADGE_SIZE
    expect((badgeTop - (panel!.y + panel!.height)) * 4).toBe(TOOLBOX_GAP_FROM_ATTACHED_BADGE)
  })

  it('keeps normal toolbox clearance when an unbadged selection reaches above an attached badge', () => {
    const scene = fixtureScene('clean')
    const badged = nodeOf(scene, 'c2')
    const unbadged = nodeOf(scene, 'c1')
    const arm = { id: 'test.arm', glyph: 'COMFYUI', variant: 'label' as const, placement: 'above' as const, color: '#6a4fa3' }
    let panel: { y: number; height: number } | undefined
    paintWith(scene, (renderer) => {
      renderer.setBadges({ [badged.id]: [arm] })
      renderer.setOverlay({ selection: new Set([badged.id, unbadged.id]) })
      renderer.setToolbox([[
        { kind: 'button', button: { id: 'core.delete', icon: 'trash-2', label: 'Delete' } },
      ]])
      panel = renderer.getToolboxLayout()!.rows[0]!.panel
    })

    const unionOuterTop = unbadged.y - 8 - 0.5
    expect(unionOuterTop - (panel!.y + panel!.height)).toBe(16)
  })

  it('keeps the painted toolbox 16 screen pixels above the multi-selection union outline at zoom 4', () => {
    const scene = fixtureScene('clean')
    const selected = scene.nodes.slice(0, 2)
    const minY = Math.min(...selected.map((node) => node.y))
    let panel: { x: number; y: number; width: number; height: number } | undefined
    const calls = paintWith(scene, (renderer) => {
      renderer.setViewport({ x: 0, y: 0, scale: 4 })
      renderer.setOverlay({ selection: new Set(selected.map((node) => node.id)) })
      renderer.setToolbox([[
        { kind: 'button', button: { id: 'core.delete', glyph: 'X', label: 'Delete' } },
      ]])
      panel = renderer.getToolboxLayout()!.rows[0]!.panel
    })
    const unionPathTop = minY - 8
    const unionOuterTop = unionPathTop - 0.5 / 4
    expect((unionOuterTop - (panel!.y + panel!.height)) * 4).toBeCloseTo(16, 12)
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'strokeRect',
      args: expect.arrayContaining([expect.any(Number), unionPathTop]),
      lineWidth: 0.25,
      strokeStyle: defaultTokens.colors.nodeSelectedBorder,
    }))
    expect(calls.some((call) =>
      call.method === 'roundRect' && call.args[0] === panel!.x && call.args[1] === panel!.y &&
      call.args[2] === panel!.width && call.args[3] === panel!.height
    )).toBe(true)
  })

  it('keeps the toolbox above the heterogeneous node-and-reroute union outline at zoom 4', () => {
    const scene = constructsScene()
    const node = nodeOf(scene, 'c1')
    const reroute = scene.reroutes.find((item) => item.id === 'rr')!
    const unionPathTop = Math.min(node.y, reroute.y - REROUTE_RADIUS) - 8
    let panel: { x: number; y: number; width: number; height: number } | undefined
    const calls = paintWith(scene, (renderer) => {
      renderer.setViewport({ x: 0, y: 0, scale: 4 })
      renderer.setOverlay({ selection: new Set([node.id]), rerouteSelection: new Set([reroute.id]) })
      renderer.setToolbox([[
        { kind: 'button', button: { id: 'core.delete', glyph: 'X', label: 'Delete' } },
      ]])
      panel = renderer.getToolboxLayout()!.rows[0]!.panel
    })
    const unionOuterTop = unionPathTop - 0.5 / 4
    expect((unionOuterTop - (panel!.y + panel!.height)) * 4).toBeCloseTo(16, 12)
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'strokeRect',
      args: expect.arrayContaining([expect.any(Number), unionPathTop]),
      lineWidth: 0.25,
      strokeStyle: defaultTokens.colors.nodeSelectedBorder,
    }))
  })

  it('fills color-selector circles from the real fallback, shared-color, and active-contrast paths', () => {
    const scene = fixtureScene('clean')
    const calls = paintWith(scene, (r) => {
      r.setOverlay({ selection: new Set(['c1']) })
      r.setToolbox([[
        { kind: 'button', button: { id: 'fallback', icon: 'circle', label: 'Fallback' } },
        { kind: 'button', button: { id: 'shared', icon: 'circle', label: 'Shared', iconColor: '#355c7d' } },
        { kind: 'button', button: { id: 'active', icon: 'circle', label: 'Active', active: true } },
      ]])
    })
    const circleFills = calls.flatMap((call, index) =>
      call.method === 'arc' ? [calls.slice(index + 1).find((candidate) => candidate.method === 'fill')] : [],
    ).filter((call): call is PaintCall => call !== undefined).slice(-3)
    expect(circleFills.map((call) => call.fillStyle)).toEqual([
      defaultTokens.colors.label,
      '#355c7d',
      defaultTokens.colors.canvasBackground,
    ])
  })

  it('dims disabled selection toolbox buttons', () => {
    const scene = fixtureScene('clean')
    let separator: { x: number; y: number; width: number; height: number } | undefined
    const calls = paintWith(scene, (r) => {
      r.setOverlay({ selection: new Set(['c1']) })
      r.setToolbox([[{
        kind: 'button', button: { id: 'core.queueUpToHere', glyph: 'U', label: 'Execute up to' },
      }, {
        kind: 'separator',
      }, {
        kind: 'button', button: { id: 'core.queueBetween', glyph: 'B', label: 'Execute between', disabled: true },
      }]])
      const entry = r.getToolboxLayout()!.rows[0]!.entries[1]!
      if (entry.kind === 'separator') separator = entry
    })
    const enabled = calls.find((call) => call.method === 'fillText' && call.args[0] === 'U')
    const disabled = calls.find((call) => call.method === 'fillText' && call.args[0] === 'B')
    expect(enabled?.globalAlpha).toBe(1)
    expect(disabled?.globalAlpha).toBe(0.4)
    expect(separator).toBeDefined()
    const separatorX = separator!.x + separator!.width / 2
    const separatorStart = calls.findIndex((call) => call.method === 'moveTo'
      && call.args[0] === separatorX && call.args[1] === separator!.y)
    expect(separatorStart).toBeGreaterThanOrEqual(0)
    expect(calls.slice(separatorStart + 1).find((call) => call.method === 'lineTo')).toMatchObject({
      args: [separatorX, separator!.y + separator!.height],
    })
    expect(calls.slice(separatorStart + 1).find((call) => call.method === 'stroke')).toMatchObject({
      strokeStyle: defaultTokens.colors.nodeBorder,
      lineWidth: separator!.width,
    })
  })

  it('paints chrome behind every row when rows cannot form a joined T', () => {
    const scene = fixtureScene('clean')
    let panels: readonly { x: number; y: number; width: number; height: number }[] = []
    const calls = paintWith(scene, (renderer) => {
      renderer.setOverlay({ selection: new Set(['c1']) })
      renderer.setToolbox([
        [{ kind: 'button', button: { id: 'top', glyph: 'T', label: 'Top' } }],
        [{ kind: 'button', button: { id: 'bottom', glyph: 'B', label: 'Bottom' } }],
        [{ kind: 'button', button: { id: 'third', glyph: '3', label: 'Third' } }],
      ])
      panels = renderer.getToolboxLayout()!.rows.map((row) => row.panel)
    })

    for (const panel of panels) {
      expect(calls.some((call) =>
        call.method === 'roundRect' &&
        call.args[0] === panel.x &&
        call.args[1] === panel.y &&
        call.args[2] === panel.width &&
        call.args[3] === panel.height
      )).toBe(true)
    }
  })

  it('no selection, no toolbox; buttons alone never paint', () => {
    const scene = fixtureScene('clean')
    const calls = paintWith(scene, (r) => r.setToolbox([[
      { kind: 'button', button: { id: 'core.delete', glyph: 'X', label: 'Delete' } },
    ]]))
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'X')).toBe(false)
  })
})

describe('construct paint on the live renderer', () => {
  it('groups: tinted body, denser title band, border and title in the group color', () => {
    const scene = constructsScene()
    expect(scene.groups.map((g) => g.id)).toEqual(['ga', 'gb'])
    const calls = paint(scene)
    // Colored group: every band uses the declared color at its own alpha.
    const bodyIdx = calls.findIndex((c) => c.method === 'roundRect' && c.args[0] === 20 && c.args[1] === 20 && c.args[2] === 380)
    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    const body = paintedAfter(calls, bodyIdx, 'fill')
    expect(body?.fillStyle).toBe('#3fa34d')
    expect(body?.globalAlpha).toBeCloseTo(0.14)
    const bandIdx = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === 20 && c.args[1] === 20 && c.args[3] === GROUP_HEADER_HEIGHT,
    )
    expect(paintedAfter(calls, bandIdx, 'fill')?.globalAlpha).toBeCloseTo(0.45)
    expect(
      calls.some((c) => c.method === 'stroke' && c.strokeStyle === '#3fa34d' && Math.abs(c.globalAlpha - 0.8) < 1e-9),
    ).toBe(true)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'Stage A')).toBe(true)
    // Uncolored group falls back to the semantic neutral default.
    expect(calls.some((c) => c.method === 'fill' && c.fillStyle === defaultTokens.colors.groupDefault)).toBe(true)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'Stage B')).toBe(true)

    const selected = paintWith(scene, (renderer) => renderer.setOverlay({ groupSelection: new Set(['gb']) }))
    const outline = selected.findIndex((c) =>
      c.method === 'strokeRect' && c.args[0] === 18 && c.args[1] === 378 && c.args[2] === 204 && c.args[3] === 154,
    )
    expect(outline).toBeGreaterThanOrEqual(0)
    expect(selected[outline]).toMatchObject({ strokeStyle: defaultTokens.colors.nodeSelectedBorder, lineWidth: 2 })
    expect(selected.slice(0, outline).filter((c) => c.method === 'setLineDash').at(-1)?.args).toEqual([[6, 4]])
  })

  it('a reroute paints as a large junction dot in the traced type color', () => {
    const scene = constructsScene()
    const rr = scene.reroutes.find((r) => r.id === 'rr')!
    expect(rr.typeName).toBe('LATENT')
    const calls = paint(scene)
    const dotIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === rr.x && c.args[1] === rr.y && c.args[2] === REROUTE_RADIUS,
    )
    expect(dotIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, dotIdx, 'fill')?.fillStyle).toBe(LATENT)
  })

  it('a hovered reroute reveals ghost sockets left and right; unhovered paints none', () => {
    const scene = constructsScene()
    const rr = scene.reroutes.find((r) => r.id === 'rr')!
    const socketArc = (calls: PaintCall[], x: number) =>
      calls.findIndex(
        (c) => c.method === 'arc' && c.args[0] === x && c.args[1] === rr.y && c.args[2] === REROUTE_SOCKET_RADIUS,
      )
    // Unhovered: no socket circles anywhere near the junction.
    const idle = paint(scene)
    expect(socketArc(idle, rr.x - REROUTE_SOCKET_OFFSET)).toBe(-1)
    expect(socketArc(idle, rr.x + REROUTE_SOCKET_OFFSET)).toBe(-1)
    // Hovered: hollow sockets on both sides, stroked in the traced type
    // color over a canvas-background fill (they read as empty pins).
    const hovered = paintWith(scene, (r) => r.setOverlay({ hoveredReroute: 'rr' }))
    for (const dir of [-1, 1]) {
      const idx = socketArc(hovered, rr.x + dir * REROUTE_SOCKET_OFFSET)
      expect(idx, `socket at dir ${dir}`).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(hovered, idx, 'fill')?.fillStyle).toBe(defaultTokens.colors.canvasBackground)
      expect(paintedAfter(hovered, idx, 'stroke')?.strokeStyle).toBe(LATENT)
      // The stem connecting dot edge to socket, in the same color.
      const stemIdx = hovered.findIndex(
        (c, i) =>
          c.method === 'moveTo' &&
          c.args[0] === rr.x + dir * REROUTE_RADIUS &&
          c.args[1] === rr.y &&
          hovered[i + 1]?.method === 'lineTo' &&
          hovered[i + 1]?.args[0] === rr.x + dir * (REROUTE_SOCKET_OFFSET - REROUTE_SOCKET_RADIUS),
      )
      expect(stemIdx, `stem at dir ${dir}`).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(hovered, stemIdx, 'stroke')?.strokeStyle).toBe(LATENT)
    }
    // Hovering ANOTHER id paints nothing here.
    const other = paintWith(scene, (r) => r.setOverlay({ hoveredReroute: 'nope' }))
    expect(socketArc(other, rr.x + REROUTE_SOCKET_OFFSET)).toBe(-1)
  })

  it('a collapsed net paints endpoint tags: lead line, tag body, and the net name at both ends', () => {
    const scene = constructsScene()
    expect(scene.netStubs).toHaveLength(2)
    expect(new Set(scene.netStubs.map((s) => s.role))).toEqual(new Set(['source', 'sink']))
    const calls = paint(scene)
    for (const stub of scene.netStubs) {
      // Lead line from the pin, stroked in the net's type color. The pin
      // may also anchor noodle beziers, so require the stub's signature:
      // a horizontal lineTo straight to the tag edge right after the move.
      const edge = stub.role === 'source' ? stub.x : stub.x + stub.width
      const leadIdx = calls.findIndex(
        (c, i) =>
          c.method === 'moveTo' &&
          c.args[0] === stub.pinX &&
          c.args[1] === stub.pinY &&
          calls[i + 1]?.method === 'lineTo' &&
          calls[i + 1]?.args[0] === edge &&
          calls[i + 1]?.args[1] === stub.pinY,
      )
      expect(leadIdx, `lead for ${stub.role}`).toBeGreaterThanOrEqual(0)
      const lead = paintedAfter(calls, leadIdx, 'stroke')
      expect(lead?.strokeStyle).toBe(LATENT)
      expect(lead?.lineWidth).toBe(2)
      // Tag body + centered name.
      const tagIdx = calls.findIndex(
        (c) => c.method === 'roundRect' && c.args[0] === stub.x && c.args[1] === stub.y && c.args[2] === stub.width,
      )
      expect(tagIdx, `tag for ${stub.role}`).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(calls, tagIdx, 'fill')?.fillStyle).toBe(defaultTokens.colors.widgetBackground)
      expect(
        calls.some((c) => c.method === 'fillText' && c.args[0] === `${stub.role === 'source' ? 'Set' : 'Get'} feed` && c.args[1] === stub.x + stub.width / 2),
      ).toBe(true)
    }
  })

  it('a mismatched endpoint tag uses error paint while a healthy tag keeps its type color', () => {
    const base = constructsScene()
    const scene: Scene = {
      ...base,
      netStubs: base.netStubs.map((stub) =>
        stub.role === 'source' ? { ...stub, mismatch: true } : stub,
      ),
    }
    const source = scene.netStubs.find((stub) => stub.role === 'source')!
    const sink = scene.netStubs.find((stub) => stub.role === 'sink')!
    const calls = paint(scene)

    const leadAfter = (stub: Scene['netStubs'][number]) => {
      const edge = stub.role === 'source' ? stub.x : stub.x + stub.width
      const index = calls.findIndex((call, i) =>
        call.method === 'moveTo' && call.args[0] === stub.pinX && call.args[1] === stub.pinY &&
        calls[i + 1]?.method === 'lineTo' && calls[i + 1]?.args[0] === edge,
      )
      expect(index).toBeGreaterThanOrEqual(0)
      return paintedAfter(calls, index, 'stroke')!
    }
    expect(leadAfter(source)).toMatchObject({ strokeStyle: ERR, lineWidth: 3 })
    expect(leadAfter(sink)).toMatchObject({ strokeStyle: LATENT, lineWidth: 2 })

    const tagStroke = (stub: Scene['netStubs'][number]) => {
      const index = calls.findIndex((call) =>
        call.method === 'roundRect' && call.args[0] === stub.x && call.args[1] === stub.y &&
        call.args[2] === stub.width && call.args[3] === stub.height,
      )
      expect(index).toBeGreaterThanOrEqual(0)
      return paintedAfter(calls, index, 'stroke')!
    }
    expect(tagStroke(source)).toMatchObject({ strokeStyle: ERR, lineWidth: 2 })
    expect(tagStroke(sink)).toMatchObject({ strokeStyle: LATENT, lineWidth: 1 })
  })

  it('a declared value source pills with a FILLED spec badge, its value text, and a typed output pin', () => {
    const scene = constructsScene()
    const vs = scene.valueSources[0]!
    expect(vs.specState).toBe('declared')
    const calls = paint(scene)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === vs.title)).toBe(true)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === vs.valueText)).toBe(true)
    // Declared spec: the badge dot fills with the selection color.
    const badge = valueSourceBadgeRect(vs)
    const badgeIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[2] === VS_BADGE_SIZE / 2 - 2 && c.args[0] === badge.x + badge.width / 2,
    )
    expect(badgeIdx).toBeGreaterThanOrEqual(0)
    const dot = calls.slice(badgeIdx + 1).find((c) => c.method === 'fill' || c.method === 'stroke')
    expect(dot?.method).toBe('fill')
    expect(dot?.fillStyle).toBe(SEL)
    // Output pin in the derived FLOAT color.
    const pinIdx = calls.findIndex(
      (c) =>
        c.method === 'arc' &&
        c.args[0] === vs.x + vs.width &&
        c.args[1] === vs.y + vs.height / 2 &&
        c.args[2] === defaultTokens.pinRadius,
    )
    expect(pinIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, pinIdx, 'fill')?.fillStyle).toBe(FLOATC)
  })

  it('a derived spec renders the badge HOLLOW; a conflict renders "!" over an error border', () => {
    // Derived: same document, spec removed - consumers still imply FLOAT.
    const derived = constructsScene((json) => {
      delete (json.graphs.g0.valueSources.vs as { spec?: unknown }).spec
    })
    const dvs = derived.valueSources[0]!
    expect(dvs.specState).toBe('derived')
    const dCalls = paint(derived)
    const dBadge = valueSourceBadgeRect(dvs)
    const dIdx = dCalls.findIndex(
      (c) => c.method === 'arc' && c.args[2] === VS_BADGE_SIZE / 2 - 2 && c.args[0] === dBadge.x + dBadge.width / 2,
    )
    expect(dIdx).toBeGreaterThanOrEqual(0)
    const dDot = dCalls.slice(dIdx + 1).find((c) => c.method === 'fill' || c.method === 'stroke')
    expect(dDot?.method).toBe('stroke')
    expect(dDot?.strokeStyle).toBe(defaultTokens.colors.label)

    // Conflict derivation is proven in scene tests; inject the flag to pin
    // the renderer's warning paint.
    const base = constructsScene()
    const scene: Scene = { ...base, valueSources: base.valueSources.map((v) => ({ ...v, conflict: true })) }
    const cCalls = paint(scene)
    expect(cCalls.some((c) => c.method === 'fillText' && c.args[0] === '!')).toBe(true)
    expect(
      cCalls.some((c) => c.method === 'stroke' && c.strokeStyle === defaultTokens.stateColors.error && c.lineWidth === 2),
    ).toBe(true)
  })

  it('a fixed selector badges the active ordinal and accents only the active candidate row', () => {
    const scene = constructsScene()
    const sel = scene.selectors[0]!
    expect(sel.random).toBe(false)
    expect(sel.typeName).toBe('LATENT')
    const calls = paint(scene)
    const badge = selectorBadgeRect(sel)
    expect(
      calls.some((c) => c.method === 'fillText' && c.args[0] === '1' && c.args[1] === badge.x + badge.width / 2),
    ).toBe(true)
    // Exactly one accent bar: the active candidate's.
    const accents = calls.filter((c) => c.method === 'fillRect' && c.args[0] === sel.x + 1.5 && c.fillStyle === SEL)
    expect(accents).toHaveLength(1)
    const active = sel.candidates.find((c) => c.id === 'p1')!
    expect(accents[0]!.args[1]).toBeCloseTo(sel.y + active.y - (defaultTokens.rowHeight / 2 - 3))
    // Candidate and output pins carry the traced type color.
    for (const [px, py] of [
      [sel.x, sel.y + sel.candidates[0]!.y],
      [sel.x + sel.width, sel.y + sel.headerHeight / 2],
    ] as const) {
      const pinIdx = calls.findIndex(
        (c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius,
      )
      expect(pinIdx).toBeGreaterThanOrEqual(0)
      expect(paintedAfter(calls, pinIdx, 'fill')?.fillStyle).toBe(LATENT)
    }
  })

  it('a random selector badges "?" until a recorded resolution names the branch that ran', () => {
    const scene = constructsScene((json) => {
      json.graphs.g0.selectors.sel.policy = { kind: 'random' } as never
    })
    const sel = scene.selectors[0]!
    expect(sel.random).toBe(true)
    const badge = selectorBadgeRect(sel)
    const atBadge = (calls: PaintCall[], glyph: string) =>
      calls.find((c) => c.method === 'fillText' && c.args[0] === glyph && c.args[1] === badge.x + badge.width / 2)

    const unresolved = paint(scene)
    expect(atBadge(unresolved, '?')).toBeDefined()
    // Random badge keeps its accent tint (distinct from fixed's flat chip).
    const chipIdx = unresolved.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === badge.x && c.args[1] === badge.y && c.args[2] === badge.width,
    )
    expect(paintedAfter(unresolved, chipIdx, 'fill')?.fillStyle).toBe(SEL)

    // A frozen/execution view's recorded resolution replaces '?' with the
    // ordinal of the branch that ACTUALLY ran.
    const resolved = paintWith(scene, (r) => r.setSelectorResolutions(new Map([['sel', 'p2']])))
    expect(atBadge(resolved, '2')).toBeDefined()
    expect(atBadge(resolved, '?')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Boundary pseudo-node fixture: a subgraph definition whose Inputs/Outputs
// panels must render with the dashed derived-not-real border, the trailing
// hollow expose affordance, and binding noodles that advertise no grab dot.
// ---------------------------------------------------------------------------

function boundaryScene(): Scene {
  const json = {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'paint-boundary',
    root: 'g0',
    graphs: {
      g0: {
        id: 'g0',
        name: 'g',
        nodes: { inst: { id: 'inst', type: '#sub', values: {} } },
        links: {},
        nets: {},
        reroutes: {},
        nextOrdinal: 10,
      },
      sub: {
        id: 'sub',
        name: 'sub',
        nodes: {
          lat: { id: 'lat', type: 'PLAT', values: {} },
          snk: { id: 'snk', type: 'SinkLatent', values: {} },
        },
        links: {},
        nets: {},
        reroutes: {},
        boundary: {
          inputs: [{ id: 'image-in', binds: { kind: 'port', node: 'snk', port: 'in' } }],
          outputs: [{ id: 'image-out', binds: { kind: 'port', node: 'lat', port: 'out' } }],
        },
        nextOrdinal: 10,
      },
    },
    view: {
      graphs: {
        g0: { nodes: {} },
        sub: {
          nodes: { lat: { position: { x: 700, y: 60 } }, snk: { position: { x: 300, y: 60 } } },
          boundary: { inputs: { position: { x: 40, y: 60 } }, outputs: { position: { x: 1000, y: 60 } } },
        },
      },
    },
  }
  const loaded = loadDocument(json)
  expect(
    loaded.diagnostics.filter((d) => d.severity === 'error'),
    JSON.stringify(loaded.diagnostics),
  ).toEqual([])
  const doc = loaded.document as WorkflowDocument
  return buildScene({
    document: doc,
    graphId: 'sub',
    resolve: documentResolver(doc, (t) => synthetic.get(t)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

describe('boundary pseudo-node paint on the live renderer', () => {
  it('both panels draw dashed borders, their titles, and hollow expose-affordance pins', () => {
    const scene = boundaryScene()
    expect(scene.boundaryNodes.map((b) => b.side).sort()).toEqual(['inputs', 'outputs'])
    const calls = paint(scene)
    // The derived-not-real signal: one [5,3] dash per panel border.
    const dashes = calls.filter(
      (c) => c.method === 'setLineDash' && JSON.stringify(c.args[0]) === JSON.stringify([5, 3]),
    )
    expect(dashes.length).toBeGreaterThanOrEqual(2)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'Inputs')).toBe(true)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'Outputs')).toBe(true)
    // Every boundary panel ends with the trailing ghost pin, drawn hollow.
    for (const bn of scene.boundaryNodes) {
      const ghost = bn.layout.pins.find((p) => p.ghost === true)
      expect(ghost, `${bn.side} expose pin`).toBeDefined()
      const px = ghost!.direction === 'in' ? bn.x : bn.x + bn.layout.width
      const py = bn.y + ghost!.y
      const arcIdx = calls.findIndex(
        (c) => c.method === 'arc' && c.args[0] === px && c.args[1] === py && c.args[2] === defaultTokens.pinRadius,
      )
      expect(arcIdx, `${bn.side} expose arc`).toBeGreaterThanOrEqual(0)
      const next = calls.slice(arcIdx + 1).find((c) => c.method === 'stroke' || c.method === 'fill')
      expect(next?.method).toBe('stroke')
      expect(next?.globalAlpha).toBeCloseTo(0.45)
    }
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'expose input...')).toBe(true)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'expose output...')).toBe(true)
  })

  it('binding noodles paint as typed links WITH a grab dot (they select and delete like any noodle)', () => {
    const scene = boundaryScene()
    const boundaryLinks = scene.links.filter((l) => l.boundary === true)
    expect(boundaryLinks.length).toBe(2)
    const calls = paint(scene)
    // The noodles themselves paint in the bound type's color.
    expect(calls.some((c) => c.method === 'stroke' && c.strokeStyle === LATENT && c.lineWidth === 2.5)).toBe(true)
    // Each boundary noodle advertises the midpoint grab dot: click/Shift-click
    // selection parity with ordinary noodles (deletion lowers to
    // boundary.unbind; only reroute insertion stays gated at dblclick).
    for (const link of boundaryLinks) {
      const mx = (link.x1 + link.x2) / 2
      expect(
        calls.some((c) => c.method === 'arc' && c.args[2] === 3.5 && c.args[0] === mx),
        `grab dot for ${link.id}`,
      ).toBe(true)
    }
  })

  it('keeps boundary selection geometry aligned past all viewport edges', () => {
    const scene = boundaryScene()
    const node = scene.boundaryNodes[0]!
    const id = boundarySceneId(node.side)
    const edge = (viewport: { x: number; y: number; scale: number }) => {
      const calls = paintWith(scene, (renderer) => {
        renderer.setViewport(viewport)
        renderer.setOverlay({ selection: new Set([id]) })
      })
      const strokeIndex = calls.findIndex((call) =>
        call.method === 'stroke' &&
        call.strokeStyle === defaultTokens.colors.nodeSelectedBorder &&
        call.lineWidth === Math.max(2, 2 / viewport.scale),
      )
      expect(strokeIndex).toBeGreaterThanOrEqual(0)
      return calls.slice(0, strokeIndex).reverse().find((call) => call.method === 'roundRect')!
    }

    const normal = edge({ x: 0, y: 0, scale: 1 })
    expect(normal.args.slice(0, 4)).toEqual([node.x - 2, node.y - 2, node.layout.width + 4, node.layout.height + 4])
    for (const scale of [0.75, 1.75]) {
      const leftView = node.x
      const rightView = node.x + node.layout.width
      const topView = node.y
      const bottomView = node.y + node.layout.height
      const centeredX = 800 - (node.x + node.layout.width / 2) * scale
      const centeredY = 600 - (node.y + node.layout.height / 2) * scale
      for (const outline of [
        edge({ x: -leftView * scale, y: centeredY, scale }),
        edge({ x: 1600 - rightView * scale, y: centeredY, scale }),
        edge({ x: centeredX, y: -topView * scale, scale }),
        edge({ x: centeredX, y: 1200 - bottomView * scale, scale }),
      ]) {
        expect(outline.args).toEqual([
          node.x - 2,
          node.y - 2,
          node.layout.width + 4,
          node.layout.height + 4,
          defaultTokens.cornerRadius + 2,
        ])
      }
    }
  })
})

describe('presence paint (remote participants)', () => {
  const CURSOR_COLOR = 'hsl(200 70% 55%)'
  const actor = (over: Partial<PresenceActor> = {}): PresenceActor => ({
    id: 'remote-1', label: 'remote', color: CURSOR_COLOR, selection: new Set<string>(), ...over,
  })

  it('paints a selection ring in the actor color around each selected node, outside the local halo', () => {
    const scene = fixtureScene('clean')
    const n = scene.nodes.find((node) => node.id === 'img')
    if (n === undefined) throw new Error('fixture node missing')
    const calls = paintWith(scene, (r) => r.setPresence([actor({ selection: new Set(['img']) })]))
    const ringIdx = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === n.x - 7 && c.args[1] === n.y - 7 && c.args[2] === n.layout.width + 14,
    )
    expect(ringIdx).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, ringIdx, 'stroke')
    expect(stroke?.strokeStyle).toBe(CURSOR_COLOR)
    expect(stroke?.lineWidth).toBe(2)
    // No ring around unselected nodes.
    const other = scene.nodes.find((node) => node.id === 'lat')
    if (other === undefined) throw new Error('fixture node missing')
    expect(calls.some((c) => c.method === 'roundRect' && c.args[0] === other.x - 7 && c.args[1] === other.y - 7)).toBe(false)
  })

  it('a selection ring rides the local drag offset of its node', () => {
    const scene = fixtureScene('clean')
    const n = scene.nodes.find((node) => node.id === 'img')
    if (n === undefined) throw new Error('fixture node missing')
    const calls = paintWith(scene, (r) => {
      r.setOverlay({ dragOffsets: new Map([['img', { dx: 30, dy: -10 }]]) })
      r.setPresence([actor({ selection: new Set(['img']) })])
    })
    expect(calls.some(
      (c) => c.method === 'roundRect' && c.args[0] === n.x + 30 - 7 && c.args[1] === n.y - 10 - 7,
    )).toBe(true)
  })

  it('paints the cursor at its world position with the label, filled in the actor color', () => {
    const calls = paintWith(fixtureScene('clean'), (r) =>
      r.setPresence([actor({ cursor: { x: 111, y: 222 } })]))
    expect(calls.some((c) => c.method === 'translate' && c.args[0] === 111 && c.args[1] === 222)).toBe(true)
    expect(calls.some((c) => c.method === 'fill' && c.fillStyle === CURSOR_COLOR)).toBe(true)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'remote')).toBe(true)
  })

  it('an actor without a cursor paints no pointer (off-canvas peers keep only their rings)', () => {
    const calls = paintWith(fixtureScene('clean'), (r) =>
      r.setPresence([actor({ selection: new Set(['img']) })]))
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'remote')).toBe(false)
  })

  it('the cursor counter-scales by the viewport zoom (constant screen size)', () => {
    const calls = paintWith(fixtureScene('clean'), (r) => {
      r.setViewport({ x: 0, y: 0, scale: 2 })
      r.setPresence([actor({ cursor: { x: 50, y: 60 } })])
    })
    expect(calls.some((c) => c.method === 'scale' && c.args[0] === 0.5 && c.args[1] === 0.5)).toBe(true)
  })

  it('setPresence([]) clears every presence mark', () => {
    const calls = paintWith(fixtureScene('clean'), (r) => {
      r.setPresence([actor({ cursor: { x: 50, y: 60 }, selection: new Set(['img']) })])
      r.setPresence([])
    })
    expect(calls.some((c) => c.strokeStyle === CURSOR_COLOR || c.fillStyle === CURSOR_COLOR)).toBe(false)
    expect(calls.some((c) => c.method === 'fillText' && c.args[0] === 'remote')).toBe(false)
  })

  it('paints a remote presence noodle from its semantic port origin in the actor color', () => {
    const scene = fixtureScene('clean')
    const node = scene.nodes.find((candidate) => candidate.id === 'img')
    const pin = node?.layout.pins.find((candidate) => candidate.direction === 'out' && candidate.widgetTap !== true)
    if (node === undefined || pin === undefined) throw new Error('fixture output pin missing')
    const calls = paintWith(scene, (renderer) => renderer.setPresence([actor({
      link: {
        origin: { kind: 'port', node: node.id, port: pin.portId, side: 'out' },
        cursor: { x: node.x + node.layout.width + 100, y: node.y + pin.y + 40 },
      },
    })]))
    const move = calls.findIndex((call) =>
      call.method === 'moveTo' && call.args[0] === node.x + node.layout.width && call.args[1] === node.y + pin.y,
    )
    expect(move).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, move, 'stroke')
    expect(stroke?.strokeStyle).toBe(CURSOR_COLOR)
    expect(stroke?.globalAlpha).toBeCloseTo(0.55)
    const dash = [...calls.slice(0, move)].reverse().find((call) => call.method === 'setLineDash')
    expect(dash?.args).toEqual([[6, 4]])
  })

  it('paints a remote presence noodle from widget tap geometry even when the tap glyph is hidden', () => {
    const scene = fixtureScene('clean')
    const node = scene.nodes[0]
    if (node === undefined) throw new Error('fixture node missing')
    const input = 'tap-only'
    const tap = {
      portId: input,
      address: { port: input },
      direction: 'out' as const,
      y: 1,
      type: typed('FLOAT'),
      widgetTap: true as const,
    }
    const withTap = {
      ...scene,
      nodes: scene.nodes.map((candidate) => candidate.id === node.id
        ? { ...candidate, layout: { ...candidate.layout, pins: [...candidate.layout.pins, tap] } }
        : candidate),
    }
    const calls = paintWith(withTap, (renderer) => renderer.setPresence([actor({
      link: {
        origin: { kind: 'widgetTap', node: node.id, input },
        cursor: { x: node.x + node.layout.width + 100, y: node.y + tap.y + 40 },
      },
    })]))
    const move = calls.findIndex((call) =>
      call.method === 'moveTo' && call.args[0] === node.x + node.layout.width && call.args[1] === node.y + tap.y,
    )
    expect(move).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, move, 'stroke')?.strokeStyle).toBe(CURSOR_COLOR)
    expect(calls).not.toContainEqual(expect.objectContaining({
      method: 'arc', args: [node.x + node.layout.width, node.y + tap.y, defaultTokens.pinRadius, 0, Math.PI * 2],
    }))
  })

  it('missing widget tap presence origins draw no noodle and do not throw', () => {
    const scene = fixtureScene('clean')
    let calls: ReturnType<typeof paintWith> = []
    expect(() => {
      calls = paintWith(scene, (renderer) => renderer.setPresence([
        actor({
          id: 'missing-node',
          link: { origin: { kind: 'widgetTap', node: 'missing', input: 'amount' }, cursor: { x: 10, y: 20 } },
        }),
        actor({
          id: 'missing-tap',
          link: { origin: { kind: 'widgetTap', node: scene.nodes[0]!.id, input: 'missing' }, cursor: { x: 30, y: 40 } },
        }),
      ]))
    }).not.toThrow()
    expect(calls.some((call) =>
      call.method === 'stroke' && call.globalAlpha === 0.55,
    )).toBe(false)
  })

  it('orients input-side port presence noodles like local input drags', () => {
    const scene = fixtureScene('clean')
    const node = scene.nodes.find((candidate) => candidate.id === 'c2')
    const pin = node?.layout.pins.find((candidate) => candidate.direction === 'in')
    if (node === undefined || pin === undefined) throw new Error('fixture input pin missing')
    const cursor = { x: node.x - 120, y: node.y + pin.y + 40 }
    const calls = paintWith(scene, (renderer) => renderer.setPresence([actor({
      link: { origin: { kind: 'port', node: node.id, port: pin.portId, side: 'in' }, cursor },
    })]))
    expect(calls.some((call) => call.method === 'moveTo' && call.args[0] === cursor.x && call.args[1] === cursor.y)).toBe(true)
    expect(calls.some((call) =>
      call.method === 'bezierCurveTo' && call.args[4] === node.x && call.args[5] === node.y + pin.y,
    )).toBe(true)
  })

  it('orients input-side reroute presence noodles toward the fixed reroute', () => {
    const scene = constructsScene()
    const reroute = scene.reroutes.find((candidate) => candidate.id === 'rr')
    if (reroute === undefined) throw new Error('fixture reroute missing')
    const cursor = { x: reroute.x - 100, y: reroute.y + 50 }
    const calls = paintWith(scene, (renderer) => renderer.setPresence([actor({
      link: { origin: { kind: 'reroute', reroute: reroute.id, side: 'in' }, cursor },
    })]))
    expect(calls.some((call) => call.method === 'moveTo' && call.args[0] === cursor.x && call.args[1] === cursor.y)).toBe(true)
    expect(calls.some((call) =>
      call.method === 'bezierCurveTo' && call.args[4] === reroute.x && call.args[5] === reroute.y,
    )).toBe(true)
  })

  it('clearing remote noodle presence removes its paint on the next snapshot', () => {
    const scene = constructsScene()
    const reroute = scene.reroutes.find((candidate) => candidate.id === 'rr')
    if (reroute === undefined) throw new Error('fixture reroute missing')
    const calls = paintWith(scene, (renderer) => {
      renderer.setPresence([actor({
        link: { origin: { kind: 'reroute', reroute: reroute.id }, cursor: { x: reroute.x + 80, y: reroute.y + 30 } },
      })])
      renderer.setPresence([actor()])
    })
    expect(calls.some((call) =>
      call.method === 'stroke' && call.strokeStyle === CURSOR_COLOR && call.globalAlpha === 0.55,
    )).toBe(false)
  })

  it('presence noodles never participate in local hit testing or drop targets', () => {
    const scene = fixtureScene('clean')
    const node = scene.nodes.find((candidate) => candidate.id === 'img')
    const pin = node?.layout.pins.find((candidate) => candidate.direction === 'out' && candidate.widgetTap !== true)
    if (node === undefined || pin === undefined) throw new Error('fixture output pin missing')
    const wx = node.x + node.layout.width + 70
    const wy = node.y + pin.y + 30
    const before = hitTest(scene, wx, wy)
    const dropTargets = new Set(['existing-target'])
    let overlayAfter: unknown
    paintWith(scene, (renderer) => {
      renderer.setOverlay({ dropTargets })
      renderer.setPresence([actor({
        link: { origin: { kind: 'port', node: node.id, port: pin.portId, side: 'out' }, cursor: { x: wx, y: wy } },
      })])
      overlayAfter = renderer.getOverlay()
    })
    expect(hitTest(scene, wx, wy)).toEqual(before)
    expect(before.kind).toBe('empty')
    expect(overlayAfter).toEqual({ dropTargets })
  })

  it('a hovered node gets a faint thin ring, weaker than a selection ring', () => {
    const scene = fixtureScene('clean')
    const n = scene.nodes.find((node) => node.id === 'img')
    if (n === undefined) throw new Error('fixture node missing')
    const calls = paintWith(scene, (r) => r.setPresence([actor({ hover: 'img' })]))
    const ringIdx = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === n.x - 4 && c.args[1] === n.y - 4 && c.args[2] === n.layout.width + 8,
    )
    expect(ringIdx).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, ringIdx, 'stroke')
    expect(stroke?.strokeStyle).toBe(CURSOR_COLOR)
    expect(stroke?.lineWidth).toBe(1)
    expect(stroke?.globalAlpha).toBeCloseTo(0.5)
  })

  it('hover on a node the actor also selected paints no extra ring (selection wins)', () => {
    const scene = fixtureScene('clean')
    const n = scene.nodes.find((node) => node.id === 'img')
    if (n === undefined) throw new Error('fixture node missing')
    const calls = paintWith(scene, (r) =>
      r.setPresence([actor({ hover: 'img', selection: new Set(['img']) })]))
    expect(calls.some((c) => c.method === 'roundRect' && c.args[0] === n.x - 4 && c.args[1] === n.y - 4)).toBe(false)
    expect(calls.some((c) => c.method === 'roundRect' && c.args[0] === n.x - 7 && c.args[1] === n.y - 7)).toBe(true)
  })

  it('an in-progress remote drag paints a dashed ghost at the offset; the real node stays put', () => {
    const scene = fixtureScene('clean')
    const n = scene.nodes.find((node) => node.id === 'img')
    const other = scene.nodes.find((node) => node.id === 'lat')
    if (n === undefined || other === undefined) throw new Error('fixture node missing')
    const calls = paintWith(scene, (r) =>
      r.setPresence([actor({ drag: new Map([['img', { dx: 40, dy: 25 }]]) })]))
    const ghostIdx = calls.findIndex(
      (c) =>
        c.method === 'roundRect' &&
        c.args[0] === n.x + 40 && c.args[1] === n.y + 25 &&
        c.args[2] === n.layout.width && c.args[3] === n.layout.height,
    )
    expect(ghostIdx).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, ghostIdx, 'stroke')
    expect(stroke?.strokeStyle).toBe(CURSOR_COLOR)
    expect(stroke?.globalAlpha).toBeCloseTo(0.55)
    // Dashed: the ghost dash is set inside its own save/restore scope, so
    // nothing painted after the scope can inherit it.
    const dashes = calls.slice(0, ghostIdx).map((c, i) => (c.method === 'setLineDash' ? i : -1)).filter((i) => i >= 0)
    const dashIdx = dashes[dashes.length - 1] ?? -1
    expect(calls[dashIdx]?.args).toEqual([[6, 4]])
    expect(calls.slice(dashIdx, ghostIdx).some((c) => c.method === 'restore')).toBe(false) // same scope
    expect(calls.slice(ghostIdx).some((c) => c.method === 'restore')).toBe(true) // scope closes
    // The REAL node still paints at its scene position (presence never moves layout).
    expect(calls.some((c) => c.method === 'roundRect' && c.args[0] === n.x && c.args[1] === n.y)).toBe(true)
    // Nodes outside the drag map get no ghost.
    expect(calls.some(
      (c) => c.method === 'roundRect' && c.args[0] === other.x + 40 && c.args[1] === other.y + 25,
    )).toBe(false)
  })

  it('a selection ring rides the actor\'s OWN drag offset, after the dash scope closed', () => {
    const scene = fixtureScene('clean')
    const n = scene.nodes.find((node) => node.id === 'img')
    if (n === undefined) throw new Error('fixture node missing')
    const calls = paintWith(scene, (r) =>
      r.setPresence([actor({ selection: new Set(['img']), drag: new Map([['img', { dx: 40, dy: 25 }]]) })]))
    const ringIdx = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === n.x + 40 - 7 && c.args[1] === n.y + 25 - 7,
    )
    expect(ringIdx).toBeGreaterThanOrEqual(0)
    expect(paintedAfter(calls, ringIdx, 'stroke')?.lineWidth).toBe(2)
    // The ghost's dash scope (save ... restore) is fully closed before the
    // ring strokes, so the ring cannot paint dashed.
    const dashIdx = calls.findIndex((c) => c.method === 'setLineDash' && JSON.stringify(c.args[0]) === '[6,4]')
    expect(dashIdx).toBeGreaterThanOrEqual(0)
    const restoreIdx = calls.findIndex((c, i) => i > dashIdx && c.method === 'restore')
    expect(restoreIdx).toBeGreaterThan(dashIdx)
    expect(ringIdx).toBeGreaterThan(restoreIdx)
    expect(calls.slice(restoreIdx, ringIdx).some((c) => c.method === 'setLineDash')).toBe(false)
  })

  it('paints a remotely-selected reroute halo in the actor color', () => {
    const scene = constructsScene()
    const reroute = scene.reroutes.find((r) => r.id === 'rr')
    if (reroute === undefined) throw new Error('fixture reroute missing')
    const calls = paintWith(scene, (r) =>
      r.setPresence([actor({ rerouteSelection: new Set(['rr']) })]))
    const haloIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === reroute.x && c.args[1] === reroute.y && c.args[2] === REROUTE_RADIUS + 6,
    )
    expect(haloIdx).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, haloIdx, 'stroke')
    expect(stroke?.strokeStyle).toBe(CURSOR_COLOR)
    expect(stroke?.lineWidth).toBe(2)
    expect(stroke?.globalAlpha).toBeCloseTo(0.9)
  })

  it('offsets a remote reroute drag ghost while the real reroute stays put', () => {
    const scene = constructsScene()
    const reroute = scene.reroutes.find((r) => r.id === 'rr')
    if (reroute === undefined) throw new Error('fixture reroute missing')
    const calls = paintWith(scene, (r) =>
      r.setPresence([actor({ drag: new Map([['rr', { dx: 35, dy: -20 }]]) })]))
    const ghostIdx = calls.findIndex(
      (c) => c.method === 'arc' && c.args[0] === reroute.x + 35 && c.args[1] === reroute.y - 20 && c.args[2] === REROUTE_RADIUS,
    )
    expect(ghostIdx).toBeGreaterThanOrEqual(0)
    const stroke = paintedAfter(calls, ghostIdx, 'stroke')
    expect(stroke?.strokeStyle).toBe(CURSOR_COLOR)
    expect(stroke?.globalAlpha).toBeCloseTo(0.55)
    expect(calls.some(
      (c) => c.method === 'arc' && c.args[0] === reroute.x && c.args[1] === reroute.y && c.args[2] === REROUTE_RADIUS,
    )).toBe(true)
  })

  it('moves a selected reroute halo with that actor\'s drag offset', () => {
    const scene = constructsScene()
    const reroute = scene.reroutes.find((r) => r.id === 'rr')
    if (reroute === undefined) throw new Error('fixture reroute missing')
    const calls = paintWith(scene, (r) => r.setPresence([actor({
      rerouteSelection: new Set(['rr']),
      drag: new Map([['rr', { dx: 35, dy: -20 }]]),
    })]))
    expect(calls.some(
      (c) => c.method === 'arc' && c.args[0] === reroute.x + 35 && c.args[1] === reroute.y - 20 && c.args[2] === REROUTE_RADIUS + 6,
    )).toBe(true)
  })

  it('coexists across actors and preserves node presence alongside reroutes', () => {
    const scene = constructsScene()
    const node = scene.nodes.find((n) => n.id === 'lat')
    const reroute = scene.reroutes.find((r) => r.id === 'rr')
    if (node === undefined || reroute === undefined) throw new Error('fixture entity missing')
    const otherColor = 'hsl(20 70% 55%)'
    const calls = paintWith(scene, (r) => r.setPresence([
      actor({ id: 'remote-2', color: otherColor, rerouteSelection: new Set(['rr']) }),
      actor({ selection: new Set(['lat']), rerouteSelection: new Set(['rr']) }),
    ]))
    const nodeRing = calls.findIndex(
      (c) => c.method === 'roundRect' && c.args[0] === node.x - 7 && c.args[1] === node.y - 7,
    )
    expect(paintedAfter(calls, nodeRing, 'stroke')?.strokeStyle).toBe(CURSOR_COLOR)
    const rerouteHalos = calls
      .map((c, i) => c.method === 'arc' && c.args[0] === reroute.x && c.args[1] === reroute.y &&
        (c.args[2] === REROUTE_RADIUS + 6 || c.args[2] === REROUTE_RADIUS + 9) ? i : -1)
      .filter((i) => i >= 0)
    expect(rerouteHalos).toHaveLength(2)
    const colorsByRadius = new Map(rerouteHalos.map((i) => [calls[i]?.args[2], paintedAfter(calls, i, 'stroke')?.strokeStyle]))
    expect(colorsByRadius.get(REROUTE_RADIUS + 6)).toBe(CURSOR_COLOR)
    expect(colorsByRadius.get(REROUTE_RADIUS + 9)).toBe(otherColor)
  })
})
