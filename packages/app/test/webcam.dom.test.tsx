import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { coreCommandRegistry, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import type { AppState, Tab } from '../src/app-state.js'
import { captureWebcamFrame } from '../src/webcam.js'
import { WidgetEditor } from '../src/WidgetEditor.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function camera() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  const open = vi.fn().mockResolvedValue(stream)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: open } })
  vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 320 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 240 })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(new Blob(['frame'], { type: 'image/png' })))
  return { stop, stream, open }
}

it('captures a PNG using camera constraints and releases tracks, including a late permission grant', async () => {
  const device = camera()
  const file = await captureWebcamFrame({ width: 640, height: 480 })
  expect(file.name).toBe('webcam.png')
  expect(file.type).toBe('image/png')
  expect(await file.text()).toBe('frame')
  expect(device.open).toHaveBeenCalledWith({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 } } })
  expect(device.stop).toHaveBeenCalledOnce()
  let grant!: (stream: MediaStream) => void
  device.open.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve }))
  const abort = new AbortController()
  const pending = captureWebcamFrame({}, abort.signal)
  abort.abort()
  grant(device.stream)
  await expect(pending).rejects.toHaveProperty('name', 'AbortError')
  expect(device.stop).toHaveBeenCalledTimes(2)
})

it('preserves named browser errors without inventing a frame', async () => {
  const device = camera()
  device.open.mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'))
  await expect(captureWebcamFrame()).rejects.toMatchObject({ name: 'NotFoundError', message: 'Requested device not found' })
  expect(device.stop).not.toHaveBeenCalled()
})

it('stages capture, preserves the saved frame on cancel or device failure, and applies undoably', async () => {
  const device = camera()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:camera')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('dinkster.image.webcam_capture', { interface: [
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['WEBCAM'] }, widget: { type: 'WEBCAM' } },
    { role: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] }, default: 640 },
  ] }).schema!
  const saved = { digest: `blake3:${'a'.repeat(64)}`, name: 'saved.png', size: 8, mediaType: 'image/png', virtualPath: 'input/saved.png' }
  const captured = { ...saved, digest: `blake3:${'b'.repeat(64)}`, name: 'webcam.png' }
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [saved, 640] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const upload = vi.fn().mockResolvedValue(captured)
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    backendForTab: () => ({ protocol: 'dinkster', connection: { uploadMediaAsset: upload } }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const open = () => render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'image' }, label: 'Camera frame',
    spec: inputsOf(schema)[0]!.widget, declaredType: inputsOf(schema)[0]!.type,
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial: store.doc.graphs.g0!.nodes.n1!.values.image,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((element) => element.textContent === label)!
  let dispose = open()
  button('Capture frame').click()
  await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(root.querySelector('img')).not.toBeNull())
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(saved)
  button('Cancel').click(); dispose()
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(saved)
  dispose = open()
  device.open.mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'))
  button('Capture frame').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('NotFoundError: Requested device not found'))
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(saved)
  button('Capture frame').click()
  await vi.waitFor(() => expect(root.querySelector('img')).not.toBeNull())
  button('Use frame').click()
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(captured)
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(saved)
  dispose()
})
