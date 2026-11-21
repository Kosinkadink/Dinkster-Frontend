/**
 * A pin's hit circle reaches over the end of its node's field rows. Where it
 * covers a field's control, a click belongs to the control and a drag that
 * starts there belongs to the pin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeSchema, WorkflowDocument } from '@dinkster/core'
import { hitTest } from '../src/hit.js'
import { InteractionController, type InteractionHost } from '../src/interaction.js'
import { dropTargetKey, type CanvasRenderer } from '../src/renderer.js'
import { buildScene, type Scene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'

const concrete = (name: string) => ({ kind: 'concrete' as const, name })
const numberSchema: NodeSchema = {
  type: 'Number', displayName: 'Number', category: 'test', source: 'v3', isOutputNode: false,
  items: [{
    kind: 'input', id: 'steps', type: concrete('INT'), optional: false,
    widget: { widgetType: 'INT', options: { min: 1, max: 100 }, default: 20 },
  }],
}
const sinkSchema: NodeSchema = {
  type: 'Sink', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'value', type: concrete('INT'), optional: false }],
}

function scene(): Scene {
  const document = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'g', nodes: {
      source: { id: 'source', type: 'Number', values: { steps: 20 } },
      sink: { id: 'sink', type: 'Sink', values: {} },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {
      source: { position: { x: 40, y: 50 }, size: { width: 280, height: 0 } },
      sink: { position: { x: 500, y: 50 } },
    } } } },
  } as unknown as WorkflowDocument
  return buildScene({
    document, graphId: 'g0',
    resolve: (type) => type === 'Number' ? numberSchema : type === 'Sink' ? sinkSchema : undefined,
    tokens: defaultTokens, measure: (text) => text.length * 6,
    widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
  })
}

function harness(scene: Scene) {
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
    getDetailLevel: () => 'controls', getDesignTokens: () => defaultTokens,
    cancelViewportAnimation: () => undefined,
    getBadges: () => ({}), setOverlay: (value: any) => overlays.push(value),
    onSceneReplaced: () => () => undefined,
  } as unknown as CanvasRenderer
  const host: InteractionHost = { dispatch: (value) => { dispatched.push(value); return { ok: true } } }
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('HTMLElement', class {})
  new InteractionController(canvas, renderer, host)
  const fire = (name: string, x: number, y: number) => listeners.get(name)?.({
    clientX: x, clientY: y, button: 0, pointerId: 1, shiftKey: false, altKey: false,
    ctrlKey: false, metaKey: false, preventDefault: () => undefined,
  })
  return { overlays, dispatched, fire }
}

afterEach(() => vi.unstubAllGlobals())

/** The node, its steps row's middle, and the field's two ends. */
function geometry(built: Scene) {
  const node = built.nodes.find((candidate) => candidate.id === 'source')!
  const row = node.layout.rows.find((candidate) => candidate.kind === 'widget')!
  return {
    node,
    y: node.y + row.y + row.height / 2,
    fieldStart: node.x + row.inset,
    fieldEnd: node.x + node.layout.width - row.inset,
  }
}

describe('a pin over the end of a field row', () => {
  it('gives a click on the plus under the output pin to the plus', () => {
    const built = scene()
    const { node, y, fieldEnd } = geometry(built)
    const x = fieldEnd - 0.5
    // The press really lands inside the revealed output pin's hit circle.
    expect(hitTest(built, x, y, { widgetTaps: new Set([dropTargetKey('source', 'steps', 'out', true)]) }).kind)
      .toBe('widgetTap')
    const h = harness(built)
    h.fire('pointermove', node.x + 60, y)
    h.fire('pointerdown', x, y)
    // A jitter under the drag threshold is still a click.
    h.fire('pointermove', x - 2, y)
    h.fire('pointerup', x - 2, y)
    expect(h.dispatched).toEqual([{
      command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'steps', value: 21 },
    }])
    expect(h.overlays.some((overlay) => overlay.ghostLink !== undefined)).toBe(false)
  })

  it('starts a wire from the output pin when a press on the plus moves', () => {
    const built = scene()
    const { node, y, fieldEnd } = geometry(built)
    const sink = built.nodes.find((candidate) => candidate.id === 'sink')!
    const target = sink.layout.pins.find((pin) => pin.direction === 'in')!
    const h = harness(built)
    h.fire('pointermove', node.x + 60, y)
    h.fire('pointerdown', fieldEnd - 0.5, y)
    h.fire('pointermove', fieldEnd + 40, y)
    expect(h.overlays.at(-1)?.ghostLink).toBeDefined()
    h.fire('pointermove', sink.x, sink.y + target.y)
    h.fire('pointerup', sink.x, sink.y + target.y)
    expect(h.dispatched).toContainEqual(expect.objectContaining({
      command: 'link.connect', params: expect.objectContaining({
        from: { node: 'source', tap: 'steps' }, to: { node: 'sink', port: 'value' },
      }),
    }))
    expect(h.dispatched.some((invocation) => invocation.command === 'node.setValue')).toBe(false)
  })

  it('gives a click on the minus under the input pin to the minus, and a drag there to the pin', () => {
    const built = scene()
    const { node, y, fieldStart } = geometry(built)
    const x = fieldStart + 0.5
    const click = harness(built)
    click.fire('pointermove', node.x + 60, y)
    click.fire('pointerdown', x, y)
    click.fire('pointerup', x, y)
    expect(click.dispatched).toEqual([{
      command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'steps', value: 19 },
    }])
    const drag = harness(built)
    drag.fire('pointermove', node.x + 60, y)
    drag.fire('pointerdown', x, y)
    drag.fire('pointermove', x - 60, y)
    expect(drag.overlays.at(-1)?.ghostLink).toBeDefined()
    expect(drag.dispatched).toEqual([])
  })
})
