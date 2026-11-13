/**
 * Widget row canvas matrix: what the CANVAS layer owns for every widget
 * kind - click activation and the connected-row editor suppression rule.
 * Per-kind display behavior lives in packages/widgets/test/widget-matrix.test.ts
 * against the real registered views.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Json } from '@dinkster/core'
import { InteractionController } from '../src/interaction.js'
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
