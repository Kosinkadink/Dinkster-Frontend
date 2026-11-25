import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { defaultTokens, type WidgetMeasure } from '@dinkster/canvas'
import { createInNodeEditorScene } from '../../canvas/gallery/in-node-editors.js'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { AudioRecordController, AudioRecordSpace, CurveSpace, editorSpaceItems } from '../src/InNodeEditorSpaces.js'

const registry = createWidgetRegistry()
registerCoreWidgets(widgetRegistrationDoors(registry))
const measure: WidgetMeasure = (spec) => {
  const kind = registry.kind(spec.widgetType)
  const view = registry.viewsFor(spec.widgetType).find((entry) => entry.id === kind?.defaultView(spec))
  return view === undefined ? undefined : { viewId: view.id, rows: view.measure(spec).rows }
}
let dispose: (() => void) | undefined
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('shows the carried curve in a wired space, never the dormant curve, and restores it when unwired', () => {
  const stored = { interpolation: 'linear', points: [{ position: 0, value: 0.1 }, { position: 1, value: 0.2 }] }
  const carried = { interpolation: 'linear' as const, points: [{ position: 0, value: 0.8 }, { position: 1, value: 0.9 }] }
  const scene = createInNodeEditorScene(defaultTokens, (text) => text.length * 6, measure, {
    id: 'curve', card: 35, caption: '', type: 'Curve editor', values: { curve: stored }, wired: { curve: 'CURVE' },
    view: { editors: { curve: { unfolded: true } } },
  }, { x: 0, y: 0 })
  const items = (wired: boolean, value = carried) => editorSpaceItems(scene.nodes, { wired: () => wired, carried: () => value })
  expect(items(true)[0]?.value).toEqual(carried)
  expect(editorSpaceItems(scene.nodes, { wired: () => true, carried: () => undefined })[0]?.value).toBeUndefined()
  expect(items(false)[0]?.value).toEqual(stored)
  expect(scene.nodes.find((node) => node.id === 'curve')?.node.values.curve).toEqual(stored)
  dispose = render(() => <CurveSpace value={carried} wired options={{}} histogram={undefined} histogramInput="none"
    commit={() => { throw new Error('a wired curve cannot commit') }} />, document.body)
  const plot = document.querySelector('svg.dinkster-canvas-curve')!
  expect(plot.getAttribute('role')).toBe('img')
  expect(plot.hasAttribute('tabindex')).toBe(false)
  expect(plot.querySelectorAll('circle.dinkster-canvas-curve-point')).toHaveLength(2)
  expect([...document.querySelectorAll('.dinkster-canvas-editor-line')].every((line) => line.hasAttribute('inert'))).toBe(true)
  expect([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Delete point'))?.disabled).toBe(true)
  plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  plot.dispatchEvent(new MouseEvent('dblclick', { clientX: 40, clientY: 40, bubbles: true }))
})

it('shows a wired clip with playback enabled and recording and removal disabled even without a microphone', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => [] } })
  const clip = { digest: `blake3:${'a'.repeat(64)}`, name: 'Carried clip', size: 12, mediaType: 'audio/wav', virtualPath: 'clip.wav' }
  const recorder = new AudioRecordController({ upload: undefined, fetchBytes: undefined,
    commit: () => { throw new Error('a wired recording cannot commit') } })
  dispose = render(() => <AudioRecordSpace controller={recorder} value={clip} wired />, document.body)
  await recorder.findMicrophones()
  expect(document.body.textContent).toContain('Carried clip')
  expect(document.body.textContent).not.toContain('Nothing stored')
  const buttons = [...document.querySelectorAll('button')]
  expect(buttons.find((button) => button.getAttribute('aria-label') === 'Record')?.disabled).toBe(true)
  expect(buttons.find((button) => button.getAttribute('aria-label') === 'Play')?.disabled).toBe(false)
  expect(buttons.find((button) => button.getAttribute('aria-label') === 'Remove clip')?.disabled).toBe(true)
  expect([...document.querySelectorAll('.dinkster-canvas-editor-line')].every((line) => line.hasAttribute('inert'))).toBe(true)
  recorder.dispose()
})
