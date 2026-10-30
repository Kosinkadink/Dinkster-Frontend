import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { coreCommandRegistry, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import type { AppState, Tab } from '../src/app-state.js'
import { WidgetEditor } from '../src/WidgetEditor.js'

const fixtures = vi.hoisted(() => ({
  camera: { position: { x: 3, y: 2, z: 7 }, target: { x: 1, y: 0, z: -2 }, zoom: 1.5, cameraType: 'perspective', fov: 53 },
  transform: { position: { x: 2, y: -1, z: 4 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 2, z: 3 } },
}))
vi.mock('../src/model3d-viewer.js', () => ({
  mountModel3dViewer: async () => ({
    dispose() {},
    cameraState: () => fixtures.camera,
    setCameraState: (state: typeof fixtures.camera) => { fixtures.camera = state },
    modelTransform: () => fixtures.transform,
    setModelTransform: (state: typeof fixtures.transform) => { fixtures.transform = state },
    capture: async () => ({ image: new Blob(['scene']), mask: new Blob(['alpha']), normal: new Blob(['normals']) }),
  }),
}))

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('keeps authored state on upload failure and cancel; successful capture is undoable and reopens', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Load3DFixture', { interface: [
    { role: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [], kind: 'model/3d' } },
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
  ] }).schema!
  const initial = { recording: '', custom: { retained: true }, camera_info: fixtures.camera, model_3d_info: [fixtures.transform] }
  const model = { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'model/gltf-binary', name: 'fixture.glb', size: 1, virtualPath: 'fixture.glb' }
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [model, initial] }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  let fail = true
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    backendForTab: () => ({ protocol: 'dinkster', connection: {
      fetchAssetBytes: async () => new Uint8Array([1]),
      uploadMediaAsset: async (file: File) => {
        if (fail && file.name.includes('mask')) throw new Error('upload denied')
        return { ...model, name: file.name, mediaType: file.type }
      },
    } }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const open = () => render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'image' }, label: 'Viewport',
    spec: inputsOf(schema)[1]!.widget, declaredType: inputsOf(schema)[1]!.type,
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial: store.doc.graphs.g0!.nodes.n1!.values.image,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  const button = (name: string) => Array.from(document.querySelectorAll('button')).find((element) => element.textContent === name)!
  let dispose = open()
  await vi.waitFor(() => expect(document.querySelector('#load3d-position-x')).not.toBeNull())
  const input = document.querySelector<HTMLInputElement>('#load3d-position-x')!
  input.value = '9'; input.dispatchEvent(new Event('change', { bubbles: true }))
  button('Apply').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('upload denied'))
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(initial)
  button('Cancel').click(); dispose()
  fail = false
  dispose = open()
  await vi.waitFor(() => expect(document.querySelector('#load3d-position-x')).not.toBeNull())
  expect(document.querySelector<HTMLInputElement>('#load3d-position-x')!.value).toBe('2')
  button('Apply').click()
  await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.image).toMatchObject({
    custom: { retained: true }, camera_info: initial.camera_info, recording: '',
    image: { name: 'viewport-image.png' }, mask: { name: 'viewport-mask.png' }, normal: { name: 'viewport-normal.png' },
  }))
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(initial)
  dispose()
})
