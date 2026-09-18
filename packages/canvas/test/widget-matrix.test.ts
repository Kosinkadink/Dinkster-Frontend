/**
 * Widget row canvas matrix: what the CANVAS layer owns for every widget
 * kind - registry-painter plumbing (state forwarding, builder mapping),
 * row hit testing, click activation, and the connected-row editor
 * suppression rule. Per-kind DISPLAY truth (what each real core view
 * draws) lives in packages/widgets/test/widget-matrix.test.ts against the
 * real registered views; the fake view here exists only to prove the
 * painter's side of the contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompactState, Json, WidgetKind, WidgetRegistry, WidgetView } from '@dinkster/core'
import { hitTest } from '../src/hit.js'
import { InteractionController } from '../src/interaction.js'
import { createRegistryPainter } from '../src/registry-painter.js'
import { defaultTokens } from '../src/tokens.js'
import type { LayoutRow } from '../src/layout.js'
import type { Scene, SceneLink } from '../src/scene.js'

const entries: Array<[string, Json]> = [
  ['INT', 7], ['FLOAT', 1.25], ['STRING line', 'hello'],
  ['STRING text', 'first\nsecond'], ['BOOLEAN', true],
  ['COMBO static', 'euler'], ['COMBO remote', 'server-model'],
  ['COMBO static plus remote', 'fresh-model'], ['COLOR', '#123456'],
  ['ASSET', { name: 'cat.png' }],
  ['SAVE_TARGET', { mount: 'output', prefix: 'jobs/cat' }],
]

const widgetType = (name: string) => name.split(' ')[0]!
const row = (name: string): Extract<LayoutRow, { kind: 'widget' }> => ({
  kind: 'widget', y: 20, height: 24, inset: 9.5, inputId: 'port', valueKey: 'stored_key',
  address: { port: 'port' }, label: `${name} label`, type: { kind: 'concrete', name: widgetType(name) },
  viewId: `test.${name}`, rows: 1, spec: { widgetType: widgetType(name), options: {} },
})

function registryFor(name: string, state: CompactState[]): WidgetRegistry {
  const type = widgetType(name)
  const kind: WidgetKind = {
    type, valueSchema: { version: 1, validate: (_v): _v is Json => true }, defaultValue: () => '',
    validate: () => [], defaultView: () => `test.${name}`,
  }
  const view: WidgetView = {
    id: `test.${name}`, kind: type, isCompatible: () => true, measure: () => ({ rows: 1 }),
    drawCompact: (builder, value, _spec, compact) => {
      state.push(compact)
      builder.text(1, 0, String(value), { align: 'right', width: 1 })
    },
  }
  return {
    registerKind: () => () => {}, registerView: () => () => {}, registerPreviewRenderer: () => () => {},
    kind: (candidate) => candidate === type ? kind : undefined,
    viewsFor: (candidate) => candidate === type ? [view] : [], previewRendererFor: () => undefined,
  }
}

function context() {
  const texts: Array<{ run: string; x: number; align: string }> = []
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', beginPath: () => {}, roundRect: () => {}, fill: () => {}, fillRect: () => {},
    moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    measureText: (text: string) => ({ width: text.length * 6 }),
    save: () => {}, restore: () => {}, rect: () => {}, clip: () => {},
    fillText(text: string, x: number) {
      texts.push({ run: text, x, align: String(this.textAlign) })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts }
}

const sceneFor = (name: string, value: Json, links: SceneLink[] = []): Scene => ({
  graphId: 'g0', nodes: [{
    id: 'n0', x: 10, y: 10, node: { id: 'n0', type: 'WidgetNode', values: { stored_key: value } },
    layout: { width: 180, height: 54, headerHeight: 20, rows: [row(name)], pins: [], title: 'node' },
  }], links, reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [],
} as unknown as Scene)

/** A minimal canvas + controller pair for click-driven tests. */
function controllerFor(scene: Scene, activate: (hit: unknown, x: number, y: number) => void) {
  const listeners = new Map<string, (event: any) => void>()
  const canvas = {
    style: {}, addEventListener: (event: string, fn: (event: any) => void) => listeners.set(event, fn),
    removeEventListener: () => {}, setPointerCapture: () => {}, hasPointerCapture: () => false,
    releasePointerCapture: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLCanvasElement
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('HTMLElement', class {})
  const controller = new InteractionController(canvas, {
    getScene: () => scene, toWorld: (x: number, y: number) => ({ x, y }), getViewport: () => ({ x: 0, y: 0, scale: 1 }),
    getDetailLevel: () => 'controls',
    getOverlay: () => ({}), setOverlay: () => {}, onSceneReplaced: () => () => {}, getBadges: () => ({}),
    getToolboxLayout: () => undefined,
  } as never, { dispatch: () => ({ ok: true }), onWidgetActivate: activate })
  const click = (x: number, y: number) => {
    const event = { clientX: x, clientY: y, button: 0, pointerId: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} }
    listeners.get('pointerdown')!(event)
    listeners.get('pointerup')!(event)
  }
  return { controller, click }
}

afterEach(() => vi.unstubAllGlobals())

describe.each(entries)('%s canvas matrix', (name, value) => {
  it('registry painter forwards connected/read-only state and paints the view output', () => {
    const states: CompactState[] = []
    const { ctx, texts } = context()
    createRegistryPainter(registryFor(name, states))({
      ctx, row: row(name), value, x: 0, y: 0, width: 240, rowHeight: 24, connected: true, tokens: defaultTokens,
    })
    // The painter must hand the view the exact stored value and map its
    // right-aligned builder text into a real right-aligned fillText. The
    // painter renders the FIRST LINE and may ellipsize when the label zone
    // squeezes the value - but never an empty run, never invented text.
    const painted = texts.find((t) => t.align === 'right')
    expect(painted).toBeDefined()
    const firstLine = String(value).split('\n')[0]!
    const run = painted!.run
    const core = run.endsWith('...') ? run.slice(0, -3) : run
    expect(core.length).toBeGreaterThan(0)
    expect(firstLine.startsWith(core)).toBe(true)
    if (!run.endsWith('...')) expect(run).toBe(firstLine)
    expect(states).toEqual([{ focused: false, connected: true, readonly: true }])
  })

  it('hits the widget row with the right kind spec and valueKey', () => {
    const scene = sceneFor(name, value)
    const hit = hitTest(scene, 100, 42)
    expect(hit.kind).toBe('widget')
    if (hit.kind === 'widget') {
      expect(hit.row).toMatchObject({ inputId: 'port', valueKey: 'stored_key' })
      expect(hit.row.spec.widgetType).toBe(widgetType(name))
      expect(hit.row.viewId).toBe(`test.${name}`)
    }
  })

  it('activates the editor callback on a click', () => {
    const activate = vi.fn()
    const { controller, click } = controllerFor(sceneFor(name, value), activate)
    click(100, 42)
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'widget',
        row: expect.objectContaining({ valueKey: 'stored_key', spec: expect.objectContaining({ widgetType: widgetType(name) }) }),
      }),
      100, 42,
    )
    controller.dispose()
  })

  it('a CONNECTED row never activates the editor: the wire owns the value', () => {
    const link: SceneLink = {
      id: 'l0', x1: 0, y1: 0, x2: 10, y2: 42, type: { kind: 'concrete', name: widgetType(name) },
      from: { kind: 'port', node: 'other', port: 'out' }, to: { kind: 'port', node: 'n0', port: 'port' },
    } as unknown as SceneLink
    const activate = vi.fn()
    const { controller, click } = controllerFor(sceneFor(name, value, [link]), activate)
    click(100, 42)
    expect(activate).not.toHaveBeenCalled()
    controller.dispose()
  })
})
