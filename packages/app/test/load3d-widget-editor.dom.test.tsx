import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { asLinkId, asNetId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, importLitegraph, inputsOf, parseDinksterSchema } from '@dinkster/core'
import type { CompileArtifact } from '@dinkster/core'
import type { ExecutionState, ValueQuery } from '@dinkster/client'
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
    animationClips: () => [],
    capture: async () => ({ image: new Blob(['scene']), mask: new Blob(['alpha']), normal: new Blob(['normals']) }),
    recordingStream: () => ({ stream: {}, stop() {} }),
  }),
}))

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['stored', 'tap', 'broken-link', 'broken-net'] as const)('keeps authored state on failure and cancel and captures undoably from %s', async (source) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Load3DFixture', { interface: [
    { role: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [], kind: 'model/3d' } },
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
  ] }).schema!
  const initial = { recording: '', custom: { retained: true }, camera_info: fixtures.camera,
    model_3d_info: [{ ...fixtures.transform, customModel: 'retained' }, { name: 'second-model' }] }
  const model = { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'model/gltf-binary', name: 'fixture.glb', size: 1, virtualPath: 'fixture.glb' }
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [model, initial] }], links: [] }, () => schema)
  const doc = imported.document!
  const graph = doc.graphs.g0!
  const linkedModel = { ...model, digest: `blake3:${'b'.repeat(64)}` }
  const to = { node: asNodeId('n1'), port: asPortId('model_file') }
  const store = new DocumentStore({ ...doc, graphs: { ...doc.graphs, g0: {
    ...graph,
    nodes: { ...graph.nodes, source: { id: asNodeId('source'), type: schema.type, values: { model_file: linkedModel } } },
    links: source === 'stored' || source === 'broken-net' ? graph.links : { l1: {
      id: asLinkId('l1'), from: { node: asNodeId(source === 'tap' ? 'source' : 'missing'), tap: asPortId('model_file') }, to,
    } },
    nets: source !== 'broken-net' ? graph.nets : { net: { id: asNetId('net'), name: 'model', source: { node: asNodeId('missing'), port: asPortId('out') }, sinks: [to] } },
  } } }, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  let fail = true
  const connection = {
    fetchAssetBytes: async (digest: string) => digest === (source === 'tap' ? linkedModel.digest : model.digest) ? new Uint8Array([1]) : undefined,
    uploadMediaAsset: async (file: File) => {
      if (fail && file.name.includes('mask')) throw new Error('upload denied')
      return { ...model, name: file.name, mediaType: file.type }
    },
  }
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection }),
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
  if (source.startsWith('broken')) {
    await vi.waitFor(() => expect(document.body.textContent).toContain('The selected model file is unavailable.'))
    expect(button('Apply').disabled).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(initial)
    dispose()
    return
  }
  await vi.waitFor(() => expect(document.querySelector('#load3d-position-x')).not.toBeNull())
  if (source === 'stored') {
    vi.stubGlobal('MediaRecorder', class {
      state = 'inactive'
      mimeType = 'video/webm'
      onstop?: () => void
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.onstop?.() }
    })
    const projection = document.querySelector<HTMLButtonElement>('#load3d-camera-type')!
    expect(projection.disabled).toBe(false)
    button('Record viewport').click()
    expect(projection.disabled).toBe(true)
    button('Stop recording').click()
    expect(projection.disabled).toBe(false)
  }
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
  const rotation = document.querySelector<HTMLInputElement>('#load3d-quaternion-y')!
  rotation.value = '0.5'; rotation.dispatchEvent(new Event('change', { bubbles: true }))
  button('Apply').click()
  await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.image).toMatchObject({
    custom: { retained: true }, camera_info: initial.camera_info, recording: '',
    model_3d_info: [{ customModel: 'retained', quaternion: { y: 0.5 } }, { name: 'second-model' }],
    image: { name: 'viewport-image.png' }, mask: { name: 'viewport-mask.png' }, normal: { name: 'viewport-normal.png' },
  }))
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(initial)
  dispose()
})

it.each(['read', 'upload'] as const)('refuses a stored-source backend retarget during %s', async (phase) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Load3DFixture', { interface: [
    { role: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [], kind: 'model/3d' } },
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
  ] }).schema!
  const model = { digest: `blake3:${'e'.repeat(64)}`, name: 'scene.glb', size: 1, mediaType: 'model/gltf-binary', virtualPath: 'scene.glb' }
  const initial = { custom: 'unchanged' }
  const doc = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [model, initial] }], links: [] }, () => schema).document!
  const store = new DocumentStore(doc, coreCommandRegistry())
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const connection = {
    fetchAssetBytes: async () => { if (phase === 'read') { entered = true; await pending }; return new Uint8Array([1]) },
    uploadMediaAsset: async () => { entered = true; await pending; return model },
  }
  let current = connection
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection: current }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'image' }, label: 'Viewport',
    spec: inputsOf(schema)[1]!.widget, declaredType: inputsOf(schema)[1]!.type,
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  if (phase === 'upload') {
    await vi.waitFor(() => expect(document.querySelector('#load3d-position-x')).not.toBeNull())
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply')!.click()
  }
  await vi.waitFor(() => expect(entered).toBe(true))
  current = { ...connection }
  release()
  if (phase === 'read') await vi.waitFor(() => expect(document.body.textContent).toContain('The selected model file is unavailable.'))
  else await vi.waitFor(() => expect(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply')!.disabled).toBe(false))
  expect(store.doc.graphs.g0!.nodes.n1!.values.image).toEqual(initial)
  expect(store.undo()).toBe(false)
  dispose()
})

it.each(['valid', 'local-source', 'local-resource', 'revoked-local', 'empty-binding', 'missing-format', 'array-resources', 'null-source', 'scalar-manifest', 'parent-resource', 'null-resource', 'unverified-source', 'negative-size', 'unknown-field'] as const)('handles %s FILE_3D preview metadata without reading a dormant file', async (variant) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Preview3DAdvancedFixture', { interface: [
    { role: 'input', id: 'model_3d', type: { kind: 'concrete', types: ['FILE_3D_GLTF'] } },
    { role: 'input', id: 'viewport_state', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
    { role: 'input', id: 'camera_info', type: { kind: 'concrete', types: ['LOAD3D_CAMERA'] } },
    { role: 'input', id: 'model_3d_info', type: { kind: 'concrete', types: ['LOAD3D_MODEL_INFO'] } },
    { role: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] } },
  ] }).schema!
  const initial = { image: '', mask: null, normal: '', recording: null, custom: 'keep',
    camera_info: { ...fixtures.camera, fov: 19 }, model_3d_info: [fixtures.transform] }
  const cameraInfo = { ...fixtures.camera, fov: 67, cameraExtra: 'explicit' }
  const models = [{ ...fixtures.transform, position: { x: 7, y: -3, z: 1 }, modelExtra: 'explicit' }, { name: 'second' }]
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const primary = { digest: `blake3:${'c'.repeat(64)}`, name: 'scene.gltf', size: 31, mediaType: 'model/gltf+json', virtualPath: 'scene.gltf' }
  const sidecar = { ...primary, digest: `blake3:${'d'.repeat(64)}`, name: 'mesh.bin', size: 17, mediaType: 'application/octet-stream', virtualPath: 'mesh.bin' }
  const manifest = { format: 'gltf', source: primary, resources: { 'buffers/mesh.bin': sidecar } }
  const local = { verification: 'unverified', localBinding: 'granted-revision', name: 'local.gltf', size: 31, mediaType: 'model/gltf+json', virtualPath: 'local.gltf' }
  const selected = variant === 'missing-format' ? { source: manifest.source, resources: manifest.resources }
    : variant === 'local-source' || variant === 'revoked-local' ? { ...manifest, source: local }
    : variant === 'local-resource' ? { ...manifest, resources: { 'buffers/mesh.bin': { ...local, name: 'local.bin', mediaType: 'application/octet-stream' } } }
    : variant === 'empty-binding' ? { ...manifest, source: { ...local, localBinding: '' } }
    : variant === 'array-resources' ? { ...manifest, resources: [] }
    : variant === 'null-source' ? { ...manifest, source: null }
    : variant === 'parent-resource' ? { ...manifest, resources: { '../mesh.bin': sidecar } }
    : variant === 'null-resource' ? { ...manifest, resources: { 'buffers/mesh.bin': null } }
    : variant === 'unverified-source' ? { ...manifest, source: { ...manifest.source, verification: 'unverified', localBinding: 'local-only' } }
    : variant === 'negative-size' ? { ...manifest, source: { ...primary, size: -1 } }
    : variant === 'unknown-field' ? { ...manifest, source: { ...primary, path: '/ungranted/scene.gltf' } }
    : variant === 'scalar-manifest' ? 'not a file manifest' : manifest
  for (const [inputId, value] of Object.entries({ viewport_state: initial, camera_info: cameraInfo, model_3d_info: models,
    model_3d: selected, model_file: { digest: 'dormant', name: 'unused.glb' } })) {
    store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId, value } })
  }
  const tab = { store } as unknown as Tab
  const registry = createWidgetRegistry()
  const reads: string[] = []
  const localReads: string[] = []
  const connection = {
    fetchAssetBytes: async (digest: string) => { reads.push(digest); return new Uint8Array([1]) },
    fetchLocalAssetBytes: async (binding: string) => { localReads.push(binding); return variant === 'revoked-local' ? undefined : new Uint8Array([7]) },
    uploadMediaAsset: async () => { throw new Error('metadata must not upload captures') },
  }
  const app = {
    widgetRegistry: registry, widgetRegistryForTab: () => registry,
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <WidgetEditor app={app} ed={{
    tab, graphId: 'g0', target: { kind: 'input', nodeId: 'n1', valueKey: 'viewport_state' }, label: 'Viewport',
    spec: inputsOf(schema)[1]!.widget, declaredType: inputsOf(schema)[1]!.type,
    multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  if (variant !== 'valid' && variant !== 'local-source' && variant !== 'local-resource') {
    await vi.waitFor(() => expect(document.body.textContent).toContain('The selected model file is unavailable.'))
    expect(Array.from(document.querySelectorAll('button')).find((element) => element.textContent === 'Apply')!.disabled).toBe(true)
    expect(store.doc.graphs.g0!.nodes.n1!.values.viewport_state).toEqual(initial)
    expect(reads).toEqual([])
    expect(localReads).toEqual(variant === 'revoked-local' ? [local.localBinding] : [])
    dispose()
    return
  }
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#load3d-fov')?.value).toBe('67'))
  expect(reads).toEqual(variant === 'local-source' ? [sidecar.digest] : variant === 'local-resource' ? [primary.digest] : [primary.digest, sidecar.digest])
  expect(localReads).toEqual(variant === 'valid' ? [] : [local.localBinding])
  expect(document.querySelector<HTMLInputElement>('#load3d-position-x')!.value).toBe('7')
  expect(document.body.textContent).not.toContain('Record viewport')
  Array.from(document.querySelectorAll('button')).find((element) => element.textContent === 'Apply')!.click()
  await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.viewport_state).toEqual({ ...initial,
    camera_info: cameraInfo, model_3d_info: models,
  }))
  expect(store.undo()).toBe(true)
  expect(store.doc.graphs.g0!.nodes.n1!.values.viewport_state).toEqual(initial)
  dispose()
})

it.each(['current', 'nested', 'stale', 'foreign', 'unknown-path', 'refused', 'no-rendition', 'changed-result', 'close', 'edited', 'divergent', 'width-overflow', 'rendition-mismatch', 'asset-producer', 'malformed-asset', 'base-file', 'splat-file', 'cloud-file'] as const)('resolves exact producer metadata or abstains for %s', async (variant) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:producer')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Preview3DProducerFixture', { interface: [
    { role: 'input', id: 'model_3d', type: { kind: 'concrete', types: ['FILE_3D_GLTF'] } },
    { role: 'input', id: 'viewport_state', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
    { role: 'input', id: 'camera_info', type: { kind: 'concrete', types: ['LOAD3D_CAMERA'] } },
    { role: 'input', id: 'model_3d_info', type: { kind: 'concrete', types: ['LOAD3D_MODEL_INFO'] } },
    { role: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] } },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type }], links: [] }, () => schema)
  const graph = imported.document!.graphs.g0!
  const primary = { digest: `blake3:${'e'.repeat(64)}`, name: 'linked.gltf', size: 21, mediaType: 'model/gltf+json', virtualPath: 'linked.gltf' }
  const initial = { camera_info: { ...fixtures.camera, fov: 11 }, model_3d_info: [fixtures.transform], recording: '' }
  const cameraInfo = { ...fixtures.camera, fov: 79, extension: 'linked-camera' }
  const models = [{ ...fixtures.transform, position: { x: -8, y: 4, z: 1 }, extension: 'linked-model' }, { name: 'second-linked' }]
  const assetProducer = variant === 'asset-producer' || variant === 'malformed-asset'
  const store = new DocumentStore({ ...imported.document!, graphs: { g0: { ...graph,
    nodes: { ...graph.nodes, n1: { ...graph.nodes.n1!, values: { viewport_state: initial, model_file: { ...primary, digest: `blake3:${'f'.repeat(64)}` } } },
      source: { id: asNodeId('source'), type: 'Source', values: {} } },
    links: Object.fromEntries([assetProducer ? 'model_file' : 'model_3d', 'camera_info', 'model_3d_info', 'width'].map((port) => [port, {
      id: asLinkId(port), from: { node: asNodeId('source'), port: asPortId(port) }, to: { node: asNodeId('n1'), port: asPortId(port) },
    }])),
  } } }, coreCommandRegistry())
  const nested = variant === 'nested'
  const art = { snapshot: store.doc, schemaHash: 'schema', connection: 'owner',
    prompt: { current: { class_type: 'Source', inputs: { value: 3 } }, other: { class_type: 'Source', inputs: { value: 5 } } },
    provenance: { toSource: { current: nested ? 'instanceA.source' : 'source', other: nested ? 'instanceB.source' : 'source' },
      fromSource: {}, outputAliases: { current: { camera_info: 'camera-output' }, other: { camera_info: 'camera-output' } } },
  } as unknown as CompileArtifact
  const liveArtifact = variant === 'stale' ? { ...art, prompt: { current: { class_type: 'Source', inputs: { value: 99 } } } } : art
  let execution = { key: 'owner:job', ref: { connection: variant === 'foreign' ? 'foreign' : 'owner', prompt: 'job' },
    status: 'completed', artifact: art, nodes: {}, outputs: {}, previews: {}, activities: [], artifacts: [], logs: [],
  } as unknown as ExecutionState
  const tab = { store, graphStack: { get: () => nested ? ['root', 'g0'] : ['g0'] },
    instancePath: { get: () => nested || variant === 'unknown-path' ? ['instanceA'] : [] },
  } as unknown as Tab
  const registry = createWidgetRegistry()
  let release: (() => void) | undefined
  const paused = new Promise<void>((resolve) => { release = resolve })
  let started = false
  const reads: string[] = []
  const connection = {
    values: () => ({
      peek: async (query: ValueQuery) => {
        started = true
        if (variant === 'close' || variant === 'edited') await paused
        if (variant === 'refused') return { available: false, status: 404, reason: 'evicted' }
        if (query.outputId === 'model_file') return { available: true, descriptor: { typeId: 'ASSET', fingerprint: primary.digest,
          meta: variant === 'malformed-asset' ? { ...primary, size: -1 } : primary }, renditions: [] }
        const fileType = variant === 'base-file' ? 'FILE_3D' : variant === 'splat-file' ? 'FILE_3D_SPLAT_ANY' : variant === 'cloud-file' ? 'FILE_3D_POINT_CLOUD_ANY' : 'FILE_3D_GLTF'
        const typeId = query.outputId === 'width' ? 'INT' : query.outputId === 'model_3d' ? fileType : query.outputId === 'model_3d_info' ? 'LOAD3D_MODEL_INFO' : 'LOAD3D_CAMERA'
        return { available: true, descriptor: { typeId, fingerprint: variant === 'divergent' && query.nodeId === 'other' ? 'different' : 'same' },
          ...(query.outputId === 'width' ? { descriptor: { typeId, fingerprint: 'same', value: variant === 'width-overflow' ? 4097 : 257 } } : {}),
          renditions: variant === 'no-rendition' ? [] : [{ kind: query.outputId === 'model_3d' ? 'manifest' : 'json', mime: 'application/json' }] }
      },
      rendition: async (query: ValueQuery) => {
        if (nested && query.nodeId !== 'current') throw new Error('wrong instance')
        if (variant === 'changed-result') execution = { ...execution, key: 'owner:new-job' }
        const value = query.outputId === 'model_3d' ? { format: variant === 'splat-file' || variant === 'cloud-file' ? 'ply' : 'gltf', source: primary, resources: {} }
          : query.outputId === 'camera-output' ? cameraInfo : models
        return { available: true, mime: 'application/json', fingerprint: variant === 'rendition-mismatch' ? 'different' : 'same', bytes: new TextEncoder().encode(JSON.stringify(value)).buffer }
      },
    }),
    fetchAssetBytes: async (digest: string) => { reads.push(digest); return new Uint8Array([1]) },
  }
  const app = { widgetRegistry: registry, widgetRegistryForTab: () => registry, registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ id: 'owner', protocol: 'dinkster', connection }),
    executionForTab: () => execution, compileTabCached: () => ({ ok: true, artifact: liveArtifact }),
    dispatchTo: (_tab: Tab, command: Parameters<DocumentStore['dispatch']>[0]) => store.dispatch(command),
  } as unknown as AppState
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <WidgetEditor app={app} ed={{ tab, graphId: 'g0',
    target: { kind: 'input', nodeId: 'n1', valueKey: 'viewport_state' }, label: 'Viewport', spec: inputsOf(schema)[1]!.widget,
    declaredType: inputsOf(schema)[1]!.type, multiline: false, rect: { x: 0, y: 0, width: 180, height: 24 }, initial,
  }} viewport={() => ({ x: 0, y: 0, scale: 1 })} onClose={() => {}} />, root)
  if (variant === 'close' || variant === 'edited') {
    await vi.waitFor(() => expect(started).toBe(true))
    if (variant === 'close') dispose()
    else store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'value', value: 4 } })
    release!()
  }
  if (!['current', 'nested', 'asset-producer', 'base-file', 'splat-file', 'cloud-file'].includes(variant)) {
    if (variant !== 'close') await vi.waitFor(() => expect(document.body.textContent).toContain('The selected model file is unavailable.'))
    else await paused
    expect(reads).toEqual([])
    expect(store.doc.graphs.g0!.nodes.n1!.values.viewport_state).toEqual(initial)
    if (variant !== 'close') dispose()
    return
  }
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#load3d-fov')?.value).toBe('79'))
  expect(document.querySelector<HTMLInputElement>('#load3d-position-x')!.value).toBe('-8')
  expect(reads).toEqual([primary.digest])
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Apply')!.click()
  await vi.waitFor(() => expect(store.doc.graphs.g0!.nodes.n1!.values.viewport_state).toEqual({ ...initial, camera_info: cameraInfo, model_3d_info: models }))
  dispose()
})
