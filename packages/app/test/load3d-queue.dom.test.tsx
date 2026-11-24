import { afterEach, expect, it, vi } from 'vitest'
import { asNodeId, diag, DINKSTER_SCHEMA_WIRE_VERSION } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { createWorkflowApp } from './fixtures/workflow-app.js'

const viewer = vi.hoisted(() => ({ mounts: [] as { camera?: unknown }[] }))
vi.mock('../src/model3d-viewer.js', () => ({
  mountModel3dViewer: async (_host: HTMLElement, _url: string, _mime: string, options: { camera?: { fov?: number } }) => {
    viewer.mounts.push(options.camera === undefined ? {} : { camera: options.camera })
    const camera = { position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 }, zoom: 1, cameraType: 'perspective', fov: 40, ...options.camera }
    return {
      dispose() {},
      cameraState: () => camera,
      modelTransform: () => ({ position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }),
      capture: async () => ({ image: new Blob(['scene']), mask: new Blob(['alpha']), normal: new Blob(['normals']) }),
    }
  },
}))

afterEach(() => { document.body.replaceChildren(); viewer.mounts.length = 0; vi.restoreAllMocks() })

const asset = (letter: string, name: string) =>
  ({ digest: `blake3:${letter.repeat(64)}`, name, size: 8, mediaType: 'image/png', virtualPath: `input/${name}` })

async function queueSetup() {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:model')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const app = createWorkflowApp()
  const backend = app.backends.get()[0]!
  const type = 'dinkster.3d.load3_d'
  backend.registry.set(buildDinksterRegistry(backend.id, { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: { [type]: { body: [
    { kind: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] } },
    { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['LOAD_3D'] },
      widget: { type: 'LOAD_3D', reads: { model_file: 'model_file', width: 'width', height: 'height' } } },
    { kind: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] }, default: 320 },
    { kind: 'input', id: 'height', type: { kind: 'concrete', types: ['INT'] }, default: 240 },
    { kind: 'output', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
  ] } } }))
  await app.importWorkflowFile({ name: 'load3d.json', text: async () => JSON.stringify({ nodes: [{ id: 1, type }], links: [] }) })
  const tab = app.activeTab()!
  const model = { ...asset('a', 'model.glb'), mediaType: 'model/gltf-binary' }
  tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'model_file', value: model } })
  // A view stored in the node, as letting go of the camera stores it, with no pictures yet.
  tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'image', value: {
    camera_info: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, zoom: 1, cameraType: 'perspective', fov: 50 },
  } } })
  vi.spyOn(backend.connection, 'fetchAssetBytes').mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
  let uploaded = 0
  const upload = vi.spyOn(backend.connection, 'uploadMediaAsset').mockImplementation(async (file) =>
    asset(String.fromCharCode(98 + (uploaded++ % 20)), (file as File).name))
  vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(`blake3:${'c'.repeat(64)}`)
  const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
    ok: false, diagnostics: [diag('error', 'validation', 'submit.test', 'stop after submission')],
  })
  const queue = () => app.queue(tab, { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }] })
  return { app, tab, upload, submit, queue }
}

it('takes a 3D view\'s pictures at queue only when the view changed since they were taken', async () => {
  const state = await queueSetup()
  try {
    await state.queue()
    expect(state.submit, JSON.stringify(state.app.problems.get())).toHaveBeenCalledOnce()
    expect(state.upload.mock.calls.map(([file]) => (file as File).name)).toEqual(['viewport-image.png', 'viewport-mask.png', 'viewport-normal.png'])
    // The pictures are of the stored view, and the run receives them.
    expect(viewer.mounts[0]).toMatchObject({ camera: { fov: 50 } })
    const sent = Object.values(state.submit.mock.calls[0]![0].prompt)[0]!.inputs['image'] as Record<string, { name?: string }>
    expect([sent['image']?.name, sent['mask']?.name, sent['normal']?.name]).toEqual(['viewport-image.png', 'viewport-mask.png', 'viewport-normal.png'])
    expect(sent['recording']).toBe('')

    // Queued again with the view unchanged: no pictures are taken, the stored ones are sent.
    await state.queue()
    expect(state.submit).toHaveBeenCalledTimes(2)
    expect(state.upload).toHaveBeenCalledTimes(3)
    expect(Object.values(state.submit.mock.calls[1]![0].prompt)[0]!.inputs['image']).toEqual(sent)

    // A turned camera is a changed view: the next queue takes its pictures again.
    const stored = state.tab.store.doc.graphs['g0']!.nodes['n1']!.values['image'] as Record<string, unknown>
    state.tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'image', value: {
      ...stored, camera_info: { ...(stored['camera_info'] as object), fov: 30 },
    } as never } })
    await state.queue()
    expect(state.upload).toHaveBeenCalledTimes(6)
    expect(viewer.mounts.at(-1)).toMatchObject({ camera: { fov: 30 } })
  } finally { state.app.dispose() }
})
