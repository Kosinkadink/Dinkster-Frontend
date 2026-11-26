import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from 'solid-js/web'
import { defaultTokens, type WidgetMeasure } from '@dinkster/canvas'
import { createInNodeEditorScene } from '../../canvas/gallery/in-node-editors.js'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { AudioRecordController, AudioRecordSpace, CameraAngleSpace, CurveSpace, WebcamSpace, editorSpaceItems } from '../src/InNodeEditorSpaces.js'
import { Load3dSpace } from '../src/InNodeLoad3dSpace.js'
import { Load3dSourceError } from '../src/load3d-source.js'

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
  expect(document.body.textContent).not.toContain('Stored:')
  expect(document.body.textContent).not.toContain('Ready')
  const buttons = [...document.querySelectorAll('button')]
  expect(buttons.find((button) => button.getAttribute('aria-label') === 'Record')?.disabled).toBe(true)
  expect(buttons.find((button) => button.getAttribute('aria-label') === 'Play')?.disabled).toBe(false)
  expect(buttons.find((button) => button.getAttribute('aria-label') === 'Remove clip')?.disabled).toBe(true)
  expect([...document.querySelectorAll('.dinkster-canvas-editor-line')].every((line) => line.hasAttribute('inert'))).toBe(true)
  recorder.dispose()
})

it('describes unknown wired values once without implying recording or known angles', () => {
  const recorder = new AudioRecordController({ upload: undefined, fetchBytes: undefined, commit: () => {} })
  dispose = render(() => <>
    <section data-editor="audio"><AudioRecordSpace controller={recorder} value={undefined} wired /></section>
    <section data-editor="curve"><CurveSpace value={undefined} wired options={{}} histogram={undefined} histogramInput="none" commit={() => {}} /></section>
    <section data-editor="webcam"><WebcamSpace value={undefined} carried={undefined} wired covered={false}
      ports={{ upload: undefined, fetchBytes: undefined, size: () => ({ width: 32, height: 32 }), commit: () => {} }} /></section>
    <section data-editor="angle"><CameraAngleSpace fields={{ horizontal_angle: { value: undefined, wired: true },
      vertical_angle: { value: 20, wired: false }, zoom: { value: 5, wired: false } }} commit={() => {}} /></section>
  </>, document.body)
  for (const editor of document.querySelectorAll('section')) {
    expect(editor.textContent?.match(/Not known yet/g)).toHaveLength(1)
  }
  expect(document.body.textContent).not.toContain('Microphone off')
  expect(document.body.textContent).not.toContain('Comes by wire')
  expect(document.querySelectorAll('.dinkster-canvas-angle-dot')).toHaveLength(0)
  recorder.dispose()
})

it('stops a camera stream whose permission arrives after its editor closes', async () => {
  let grant!: (stream: MediaStream) => void
  const stop = vi.fn()
  const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  dispose = render(() => <WebcamSpace value={undefined} carried={undefined} wired={false} covered={false}
    ports={{ upload: vi.fn(), fetchBytes: undefined, size: () => ({ width: 32, height: 32 }), commit: vi.fn() }} />, document.body)
  const start = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Start camera'))!
  start.click()
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  dispose()
  dispose = undefined
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream)
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
})

it.each([false, true])('distinguishes an empty model from an unknown wired model (wired=%s)', async (wired) => {
  dispose = render(() => <Load3dSpace value={undefined} wired={wired} sourceKey="empty" captures={false} live={false}
    onWake={() => {}} openSections={[]} cameraWired={wired} placementWired={wired}
    ports={{ open: async () => { throw new Load3dSourceError('noModel') }, upload: undefined, commit: () => {}, setSection: () => {} }} />, document.body)
  await vi.waitFor(() => expect(document.body.textContent).toContain(wired ? 'Not known yet' : 'No model chosen'))
  expect(document.body.textContent).not.toContain(wired ? 'No model chosen' : 'Not known yet')
})

it.each(['recorder', 'webcam', 'load3d'] as const)('opens the full %s failure from its short editor note', async (editor) => {
  vi.stubGlobal('navigator', { mediaDevices: {
    getUserMedia: async () => { throw new DOMException('Permission was refused by the browser.', 'NotAllowedError') },
  } })
  vi.stubGlobal('MediaRecorder', class {})
  let recorder: AudioRecordController | undefined
  if (editor === 'recorder') {
    recorder = new AudioRecordController({ upload: vi.fn(), fetchBytes: undefined, commit: vi.fn() })
    dispose = render(() => <AudioRecordSpace controller={recorder!} value={undefined} />, document.body)
    document.querySelector<HTMLButtonElement>('button[aria-label="Record"]')!.click()
  } else if (editor === 'webcam') {
    dispose = render(() => <WebcamSpace value={undefined} carried={undefined} wired={false} covered={false}
      ports={{ upload: vi.fn(), fetchBytes: undefined, size: () => ({}), commit: vi.fn() }} />, document.body)
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Start camera'))!.click()
  } else {
    dispose = render(() => <Load3dSpace value={undefined} sourceKey="missing" captures={false} live={false}
      onWake={() => {}} openSections={[]} cameraWired={false} placementWired={false}
      ports={{ open: async () => { throw new Load3dSourceError('unavailable') }, upload: undefined, commit: vi.fn(), setSection: vi.fn() }} />, document.body)
  }
  try {
    const summary = editor === 'recorder' ? 'Permission denied.' : editor === 'webcam' ? 'Camera unavailable.' : 'Model unavailable.'
    await vi.waitFor(() => expect(document.querySelector('.dinkster-canvas-editor-note-summary')?.textContent).toBe(summary))
    expect(document.querySelector('.dinkster-canvas-editor-picture-message')?.textContent ?? '').toBe(editor === 'webcam' ? 'No frame stored yet' : '')
    const details = [...document.querySelectorAll('button')].find(button => button.textContent === 'Details')!
    expect(details).toBeDefined()
    details.click()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain(editor === 'load3d' ? 'The model could not be shown.' : 'Permission was refused by the browser.')
    expect(dialog.querySelector('strong')?.textContent).toBe(
      editor === 'recorder' ? 'The browser was not allowed to use the microphone.' : editor === 'webcam' ? 'The camera could not be started.' : 'The model could not be shown.',
    )
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(details)
  } finally {
    recorder?.dispose()
  }
})
