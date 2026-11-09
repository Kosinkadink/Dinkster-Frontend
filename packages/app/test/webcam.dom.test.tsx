import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { asNodeId, coreCommandRegistry, diag, DINKSTER_SCHEMA_WIRE_VERSION, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { createWidgetRegistry } from '@dinkster/widgets'
import { AppState, type Tab } from '../src/app-state.js'
import { captureWebcamFrame } from '../src/webcam.js'
import { WidgetEditor } from '../src/WidgetEditor.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

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
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
    callback(this.width && this.height ? new Blob([`${this.width}x${this.height}`], { type: 'image/png' }) : null)
  })
  return { stop, stream, open }
}

it('resizes a PNG to requested dimensions and releases tracks, including a late permission grant', async () => {
  const device = camera()
  const file = await captureWebcamFrame({ width: 640, height: 180 })
  expect(file.name).toBe('webcam.png')
  expect(file.type).toBe('image/png')
  expect(await file.text()).toBe('640x180')
  expect(device.open).toHaveBeenCalledWith({ audio: false, video: true })
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

it('uses native dimensions for zero width and rejects a zero-height requested canvas', async () => {
  camera()
  expect(await (await captureWebcamFrame({ width: 0, height: 96 })).text()).toBe('320x240')
  await expect(captureWebcamFrame({ width: 640, height: 0 })).rejects.toThrow('Camera PNG encoding failed.')
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
    { role: 'input', id: 'height', type: { kind: 'concrete', types: ['INT'] }, default: 180 },
  ] }).schema!
  const saved = { digest: `blake3:${'a'.repeat(64)}`, name: 'saved.png', size: 8, mediaType: 'image/png', virtualPath: 'input/saved.png' }
  const captured = { ...saved, digest: `blake3:${'b'.repeat(64)}`, name: 'webcam.png' }
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [saved, 640, 180] }], links: [] }, () => schema)
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

async function queueSetup(captureOnQueue = true) {
  const app = createWorkflowApp()
  const backend = app.backends.get()[0]!
  const type = 'dinkster.image.webcam_capture'
  backend.registry.set(buildDinksterRegistry(backend.id, { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: { [type]: { interface: [
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['WEBCAM'] }, widget: { type: 'WEBCAM' } },
    { role: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] }, default: 640 },
    { role: 'input', id: 'height', type: { kind: 'concrete', types: ['INT'] }, default: 180 },
    { role: 'input', id: 'capture_on_queue', type: { kind: 'concrete', types: ['BOOLEAN'] }, default: true },
    { role: 'output', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
  ] }, 'test.frame': { interface: [
    { role: 'output', id: 'frame', type: { kind: 'concrete', types: ['WEBCAM'] } },
  ] } } }))
  const saved = { digest: `blake3:${'a'.repeat(64)}`, name: 'saved.png', size: 8, mediaType: 'image/png', virtualPath: 'input/saved.png' }
  await app.importWorkflowFile({ name: 'camera.json', text: async () => JSON.stringify({ nodes: [
    { id: 1, type, widgets_values: [saved, 640, 180, captureOnQueue] },
    { id: 2, type, widgets_values: [saved, 640, 180, true] },
  ], links: [] }) })
  const tab = app.activeTab()!
  const captured = { ...saved, digest: `blake3:${'b'.repeat(64)}`, name: 'webcam.png' }
  const upload = vi.spyOn(backend.connection, 'uploadMediaAsset').mockResolvedValue(captured)
  const sourceUpload = vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(`blake3:${'c'.repeat(64)}`)
  const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
    ok: false, diagnostics: [diag('error', 'validation', 'submit.test', 'stop after submission')],
  })
  const queue = () => app.queue(tab, { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }] })
  return { app, backend, tab, saved, captured, upload, sourceUpload, submit, queue }
}

it('queues a fresh scoped frame and a matching snapshot, while disabled capture reuses the saved asset', async () => {
  const device = camera()
  for (const enabled of [true, false]) {
    const state = await queueSetup(enabled)
    try {
      await state.queue()
      expect(state.submit, JSON.stringify(state.app.problems.get())).toHaveBeenCalledOnce()
      const artifact = state.submit.mock.calls[0]![0]
      const expected = enabled ? state.captured : state.saved
      expect(Object.values(artifact.prompt).map((node) => node.inputs.image)).toEqual([expected])
      expect(artifact.snapshot.graphs.g0!.nodes.n1!.values.image).toEqual(expected)
      expect(state.tab.store.doc.graphs.g0!.nodes.n2!.values.image).toEqual(state.saved)
      if (enabled) {
        expect(await state.upload.mock.calls[0]![0].text()).toBe('640x180')
        expect(state.tab.store.undo()).toBe(true)
        expect(state.tab.store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(state.saved)
      } else expect(state.upload).not.toHaveBeenCalled()
    } finally { state.app.dispose() }
  }
  expect(device.open).toHaveBeenCalledOnce()
})

it('refuses queue on device failure or edits during capture without replacing a saved frame', async () => {
  const device = camera()
  for (const failure of ['device', 'edited', 'closed']) {
    const state = await queueSetup()
    try {
      if (failure === 'device') {
        device.open.mockRejectedValueOnce(new DOMException('Requested device not found', 'NotFoundError'))
        await state.queue()
        expect(state.app.problems.get().some((problem) => problem.message.includes('NotFoundError')), JSON.stringify(state.app.problems.get())).toBe(true)
      } else {
        let grant!: (stream: MediaStream) => void
        device.open.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve }))
        const pending = state.queue()
        await vi.waitFor(() => expect(grant).toBeDefined())
        if (failure === 'closed') state.app.closeTab(state.tab.id)
        else state.app.dispatchTo(state.tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'width', value: 96 } })
        grant(device.stream)
        await pending
      }
      expect(state.submit).not.toHaveBeenCalled()
      expect(state.tab.store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(state.saved)
    } finally { state.app.dispose() }
  }
})

it('does not replace connected literal camera inputs with unused captures', async () => {
  const device = camera()
  for (const kind of ['valueSource', 'tap', 'net']) {
    const state = await queueSetup()
    try {
      const document = state.tab.store.doc
      const graph = document.graphs.g0!
      const connected = { ...state.saved, digest: `blake3:${'d'.repeat(64)}`, name: 'connected.png' }
      expect(state.app.openDocument({ ...document, graphs: { ...document.graphs, g0: {
        ...graph,
        nodes: { ...graph.nodes, n2: kind === 'net'
          ? { ...graph.nodes.n2!, type: 'test.frame', values: {} }
          : { ...graph.nodes.n2!, values: { ...graph.nodes.n2!.values, image: connected } } },
        valueSources: { v0: { id: 'v0', value: connected, type: { kind: 'concrete', types: ['WEBCAM'] } } },
        links: kind === 'net' ? {} : { l0: {
          id: 'l0', from: kind === 'tap' ? { node: 'n2', tap: 'image' } : { valueSource: 'v0' }, to: { node: 'n1', port: 'image' },
        } },
        nets: kind === 'net' ? { net0: { id: 'net0', name: 'camera', source: { node: 'n2', port: 'frame' }, sinks: [{ node: 'n1', port: 'image' }] } } : {},
      } } }, 'Connected camera')).toEqual([])
      const tab = state.app.activeTab()!
      await state.app.queue(tab, { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }] })
      expect(state.submit, JSON.stringify(state.app.problems.get())).toHaveBeenCalledOnce()
      const prompt = state.submit.mock.calls[0]![0].prompt
      const expected = kind === 'net' ? [Object.entries(prompt).find(([, node]) => node.class_type === 'test.frame')![0], 0] : connected
      expect(Object.values(prompt).find((node) => node.class_type === 'dinkster.image.webcam_capture')?.inputs.image).toEqual(expected)
      expect(state.upload).not.toHaveBeenCalled()
      expect(tab.store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(state.saved)
    } finally { state.app.dispose() }
  }
  expect(device.open).not.toHaveBeenCalled()
})

it('rejects edits and undo notified by saving a capture instead of submitting a different document', async () => {
  camera()
  for (const timing of ['synchronous', 'microtask']) {
    const state = await queueSetup()
    let scheduled = false
    const unsubscribe = state.tab.store.document.subscribe(() => {
      if (scheduled) return
      scheduled = true
      if (timing === 'microtask') queueMicrotask(() => state.tab.store.undo())
      else state.app.dispatchTo(state.tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'width', value: 96 } })
    })
    try {
      await state.queue()
      expect(scheduled).toBe(true)
      expect(state.submit).not.toHaveBeenCalled()
      expect(state.app.problems.get().some((problem) => problem.code === 'submit.webcamCaptureFailed')).toBe(true)
    } finally { unsubscribe(); state.app.dispose() }
  }
})

it('saves a nested camera on its promoted owner and preserves a connected boundary literal', async () => {
  const device = camera()
  for (const connected of [false, true]) {
    const state = await queueSetup()
    try {
      const document = state.tab.store.doc
      const root = document.graphs.g0!
      const frame = { ...state.saved, digest: `blake3:${'e'.repeat(64)}`, name: 'boundary.png' }
      expect(state.app.openDocument({ ...document, graphs: {
        g0: { ...root, nodes: { n1: { id: 'n1', type: '#camera', values: { frame: state.saved } } },
          valueSources: { v0: { id: 'v0', value: frame, type: { kind: 'concrete', types: ['WEBCAM'] } } },
          links: connected ? { l0: { id: 'l0', from: { valueSource: 'v0' }, to: { node: 'n1', port: 'frame' } } } : {},
        },
        camera: { id: 'camera', name: 'Camera', nodes: { inner: { ...root.nodes.n1!, id: 'inner' } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: {
            inputs: [{ id: 'frame', promoted: true, binds: { kind: 'port', node: 'inner', port: 'image' } }],
            outputs: [{ id: 'result', binds: { kind: 'port', node: 'inner', port: 'image' } }],
          },
        },
      } }, 'Nested camera')).toEqual([])
      const tab = state.app.activeTab()!
      await state.app.queue(tab, { kind: 'partial', targets: [{ instancePath: [asNodeId('n1')], node: asNodeId('inner') }] })
      expect(state.submit, JSON.stringify(state.app.problems.get())).toHaveBeenCalledOnce()
      expect(Object.values(state.submit.mock.calls[0]![0].prompt)[0]!.inputs.image, JSON.stringify({ upload: state.upload.mock.calls.length, prompt: state.submit.mock.calls[0]![0].prompt, document: tab.store.doc })).toEqual(connected ? frame : state.captured)
      expect(tab.store.doc.graphs.g0!.nodes.n1!.values.frame).toEqual(connected ? state.saved : state.captured)
      expect(tab.store.doc.graphs.camera!.nodes.inner!.values.image).toEqual(state.saved)
      expect(state.upload.mock.calls).toHaveLength(connected ? 0 : 1)
    } finally { state.app.dispose() }
  }
  expect(device.open).toHaveBeenCalledOnce()
})

it('keeps disabled-camera submission and source-document serialization synchronous with compilation', async () => {
  camera()
  const state = await queueSetup(false)
  try {
    const pending = state.queue()
    state.app.dispatchTo(state.tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'width', value: 96 } })
    await pending
    expect(state.submit).toHaveBeenCalledOnce()
    expect(Object.values(state.submit.mock.calls[0]![0].prompt)[0]!.inputs.width).toBe(640)
    const source = JSON.parse(state.sourceUpload.mock.calls[0]![0] as string)
    expect(source.graphs.g0.nodes.n1.values.width).toBe(640)
    expect(state.tab.store.doc.graphs.g0!.nodes.n1!.values.width).toBe(96)
  } finally { state.app.dispose() }
})

it.each([false, true])('validates shared-frame dimensions with native sizing %s', async (native) => {
  const device = camera()
  const state = await queueSetup()
  try {
    const document = state.tab.store.doc
    const root = document.graphs.g0!
    expect(state.app.openDocument({ ...document, graphs: {
      g0: { ...root, nodes: {
        n1: { id: 'n1', type: '#camera', values: { width: native ? 0 : 640, height: 180 } },
        n2: { id: 'n2', type: '#camera', values: { width: native ? 0 : 320, height: 240 } },
      } },
      camera: { id: 'camera', name: 'Camera', nodes: { inner: { ...root.nodes.n1!, id: 'inner' } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        boundary: {
          inputs: ['width', 'height'].map((id) => ({ id, promoted: true, binds: { kind: 'port', node: 'inner', port: id } })),
          outputs: [{ id: 'result', binds: { kind: 'port', node: 'inner', port: 'image' } }],
        },
      },
    } }, 'Shared camera')).toEqual([])
    const tab = state.app.activeTab()!
    await state.app.queue(tab, { kind: 'partial', targets: ['n1', 'n2'].map((id) => ({ instancePath: [asNodeId(id)], node: asNodeId('inner') })) })
    if (native) {
      expect(state.submit, JSON.stringify(state.app.problems.get())).toHaveBeenCalledOnce()
      expect(state.upload).toHaveBeenCalledOnce()
      expect(device.open).toHaveBeenCalledOnce()
      expect(tab.store.doc.graphs.camera!.nodes.inner!.values.image).toEqual(state.captured)
      for (const node of Object.values(state.submit.mock.calls[0]![0].prompt)) expect(node.inputs.image).toEqual(state.captured)
      return
    }
    expect(state.submit).not.toHaveBeenCalled()
    expect(state.app.problems.get().some((problem) => problem.message.includes('matching dimensions'))).toBe(true)
    expect(tab.store.doc.graphs.camera!.nodes.inner!.values.image).toEqual(state.saved)
    expect(state.upload).not.toHaveBeenCalled()
    expect(device.open).not.toHaveBeenCalled()
  } finally { state.app.dispose() }
})
