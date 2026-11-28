import { afterEach, expect, it, vi } from 'vitest'
import { asLinkId, asNetId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, importLitegraph, parseDinksterSchema } from '@dinkster/core'
import type { CompileArtifact } from '@dinkster/core'
import type { ExecutionState, ValueQuery } from '@dinkster/client'
import type { AppState, Tab } from '../src/app-state.js'
import { openLoad3dSource } from '../src/load3d-source.js'

const camera = { position: { x: 3, y: 2, z: 7 }, target: { x: 1, y: 0, z: -2 }, zoom: 1.5, cameraType: 'perspective', fov: 53 }
const transform = { position: { x: 2, y: -1, z: 4 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 2, z: 3 } }

// The rows a LOAD_3D widget names: it reads each viewport row by its own name
// and writes its own row when that row is the separate viewport state.
const viewportParts = (own: string) => ({
  writes: own === 'viewport_state' ? { state: own } : {},
  reads: Object.fromEntries(['model_3d', 'model_file', 'camera_info', 'model_3d_info', 'width', 'height'].map((row) => [row, row])),
})

afterEach(() => { vi.restoreAllMocks() })

it.each(['dinkster.3d.preview_point_cloud', 'dinkster.3d.save_point_cloud'])('opens %s as a point cloud', async (type) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cloud')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema(type, { body: [
    { kind: 'input', id: 'model_3d', type: { kind: 'union', types: ['FILE_3D_POINT_CLOUD_ANY', 'FILE_3D_PLY'] } },
    { kind: 'input', id: 'viewport_state', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
  ] }).schema!
  const model = { digest: `blake3:${'a'.repeat(64)}`, name: 'cloud.ply', size: 1, mediaType: 'application/octet-stream', virtualPath: 'cloud.ply' }
  const store = new DocumentStore(importLitegraph({ nodes: [{ id: 1, type }], links: [] }, () => schema).document!, coreCommandRegistry())
  const manifest = { format: 'ply', source: model, resources: {} }
  const value = type.endsWith('save_point_cloud') ? { $typed: { type: 'FILE_3D_PLY', value: manifest } } : manifest
  store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'model_3d', value } })
  const connection = { fetchAssetBytes: async () => new Uint8Array([1]) }
  const app = {
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection }),
  } as unknown as AppState
  const source = await openLoad3dSource(app, { store } as unknown as Tab,
    { graphId: 'g0', nodeId: 'n1', parts: viewportParts('viewport_state') }, new AbortController().signal)
  expect(source.options.pointCloud).toBe(true)
  source.release()
})

it.each(['stored', 'tap', 'broken-link', 'broken-net'] as const)('reads the model file from %s', async (from) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('dinkster.3d.load3_d', { body: [
    { kind: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [], kind: 'model/3d' } },
    { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
  ] }).schema!
  const model = { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'model/gltf-binary', name: 'fixture.glb', size: 1, virtualPath: 'fixture.glb' }
  const doc = importLitegraph({ nodes: [{ id: 1, type: schema.type, widgets_values: [model, {}] }], links: [] }, () => schema).document!
  const graph = doc.graphs.g0!
  const linkedModel = { ...model, digest: `blake3:${'b'.repeat(64)}` }
  const to = { node: asNodeId('n1'), port: asPortId('model_file') }
  const store = new DocumentStore({ ...doc, graphs: { ...doc.graphs, g0: {
    ...graph,
    nodes: { ...graph.nodes, source: { id: asNodeId('source'), type: schema.type, values: { model_file: linkedModel } } },
    links: from === 'stored' || from === 'broken-net' ? graph.links : { l1: {
      id: asLinkId('l1'), from: { node: asNodeId(from === 'tap' ? 'source' : 'missing'), tap: asPortId('model_file') }, to,
    } },
    nets: from !== 'broken-net' ? graph.nets : { net: { id: asNetId('net'), name: 'model', source: { node: asNodeId('missing'), port: asPortId('out') }, sinks: [to] } },
  } } }, coreCommandRegistry())
  const reads: string[] = []
  const connection = {
    fetchAssetBytes: async (digest: string) => {
      reads.push(digest)
      return digest === (from === 'tap' ? linkedModel.digest : model.digest) ? new Uint8Array([1]) : undefined
    },
  }
  const app = {
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection }),
  } as unknown as AppState
  const opened = openLoad3dSource(app, { store } as unknown as Tab, { graphId: 'g0', nodeId: 'n1', parts: viewportParts('image') }, new AbortController().signal)
  if (from.startsWith('broken')) {
    await expect(opened).rejects.toMatchObject({ problem: 'unavailable' })
    return
  }
  const source = await opened
  expect(reads).toEqual([from === 'tap' ? linkedModel.digest : model.digest])
  expect(source.options.pointCloud).toBe(false)
  source.release()
})

it.each(['valid', 'explicit-precedence', 'empty-gltf', 'empty-glb', 'empty-obj', 'empty-ply', 'empty-gaussian-ply', 'empty-splat', 'empty-spz', 'empty-ksplat', 'empty-unsupported', 'empty-local', 'local-source', 'local-resource', 'revoked-local', 'empty-binding', 'missing-format', 'array-resources', 'null-source', 'scalar-manifest', 'parent-resource', 'null-resource', 'unverified-source', 'negative-size', 'unknown-field'] as const)('handles %s FILE_3D preview metadata without reading a dormant file', async (variant) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Preview3DAdvancedFixture', { body: [
    { kind: 'input', id: 'model_3d', type: { kind: 'concrete', types: ['FILE_3D'] } },
    { kind: 'input', id: 'viewport_state', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
    { kind: 'input', id: 'camera_info', type: { kind: 'concrete', types: ['LOAD3D_CAMERA'] } },
    { kind: 'input', id: 'model_3d_info', type: { kind: 'concrete', types: ['LOAD3D_MODEL_INFO'] } },
    { kind: 'input', id: 'model_file', type: { kind: 'concrete', types: ['ASSET'] } },
  ] }).schema!
  const initial = { image: '', mask: null, normal: '', recording: null, custom: 'keep', camera_info: { ...camera, fov: 19 }, model_3d_info: [transform] }
  const cameraInfo = { ...camera, fov: 67, cameraExtra: 'explicit' }
  const models = [{ ...transform, position: { x: 7, y: -3, z: 1 }, modelExtra: 'explicit' }, { name: 'second' }]
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type }], links: [] }, () => schema)
  const store = new DocumentStore(imported.document!, coreCommandRegistry())
  const primary = { digest: `blake3:${'c'.repeat(64)}`, name: 'scene.gltf', size: 31, mediaType: 'model/gltf+json', virtualPath: 'scene.gltf' }
  const sidecar = { ...primary, digest: `blake3:${'d'.repeat(64)}`, name: 'mesh.bin', size: 17, mediaType: 'application/octet-stream', virtualPath: 'mesh.bin' }
  const manifest = { format: 'gltf', source: primary, resources: { 'buffers/mesh.bin': sidecar } }
  const local = { verification: 'unverified', localBinding: 'granted-revision', name: 'local.gltf', size: 31, mediaType: 'model/gltf+json', virtualPath: 'local.gltf' }
  const selected = variant === 'missing-format' ? { source: manifest.source, resources: manifest.resources }
    : variant.startsWith('empty-') && variant !== 'empty-binding' ? { ...manifest, format: '',
      source: variant === 'empty-local' ? local : { ...primary, name: 'misleading.obj', mediaType: 'text/plain' } }
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
  const reads: string[] = []
  const localReads: string[] = []
  const bytes = variant === 'empty-glb' || variant === 'explicit-precedence' ? new TextEncoder().encode('glTF\u0002\u0000\u0000\u0000')
    : variant === 'empty-obj' ? new TextEncoder().encode(`# ${'preamble '.repeat(100)}\nmtllib scene.mtl\nv -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3\n`)
    : variant === 'empty-ply' ? new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n')
    : variant === 'empty-gaussian-ply' ? new TextEncoder().encode(`ply\ncomment ${'x'.repeat(600)}\nproperty float f_dc_0\nproperty float scale_0\nproperty float rot_0\nend_header\n`)
    : variant === 'empty-splat' ? new Uint8Array(32)
    : variant === 'empty-spz' ? new Uint8Array([0x1f, 0x8b, 8])
    : variant === 'empty-ksplat' ? new Uint8Array([0, 1, 0])
    : variant === 'empty-unsupported' ? new Uint8Array([7])
    : variant === 'empty-gltf' ? new TextEncoder().encode(`${' '.repeat(700)}{"asset":{"version":"2.0"}}`)
    : new TextEncoder().encode('{"asset":{"version":"2.0"}}')
  const connection = {
    fetchAssetBytes: async (digest: string) => { reads.push(digest); return bytes.buffer },
    fetchLocalAssetBytes: async (binding: string) => { localReads.push(binding); return variant === 'revoked-local' ? undefined : bytes.buffer },
  }
  const app = {
    registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ protocol: 'dinkster', connection }),
  } as unknown as AppState
  const opened = openLoad3dSource(app, { store } as unknown as Tab,
    { graphId: 'g0', nodeId: 'n1', parts: viewportParts('viewport_state') }, new AbortController().signal)
  if (variant !== 'valid' && variant !== 'explicit-precedence' && variant !== 'local-source' && variant !== 'local-resource' && !(variant.startsWith('empty-') && variant !== 'empty-binding' && variant !== 'empty-unsupported')) {
    await expect(opened).rejects.toMatchObject({ problem: 'unavailable' })
    expect(reads).toEqual(variant === 'empty-unsupported' ? [primary.digest] : [])
    expect(localReads).toEqual(variant === 'revoked-local' ? [local.localBinding] : [])
    return
  }
  const source = await opened
  expect(reads).toEqual(variant === 'local-source' || variant === 'empty-local' ? [sidecar.digest] : variant === 'local-resource' ? [primary.digest] : [primary.digest, sidecar.digest])
  expect(localReads).toEqual(variant === 'local-source' || variant === 'local-resource' || variant === 'empty-local' ? [local.localBinding] : [])
  expect(source.options.format).toBe(variant === 'empty-gaussian-ply' ? 'ply' : variant.startsWith('empty-') && variant !== 'empty-local' ? variant.slice(6) : 'gltf')
  if (variant === 'empty-gaussian-ply') expect(source.mime).toBe('model/ply')
  if (variant === 'empty-ply') expect(source.mime).toBe('application/octet-stream')
  expect(source.options.resources).toEqual({ 'buffers/mesh.bin': 'blob:fixture' })
  // The camera and placement rows the view starts from are the node's own.
  expect(source.inputValue('camera_info')).toEqual(cameraInfo)
  expect(source.inputValue('model_3d_info')).toEqual(models)
  source.release()
})

it.each(['current', 'nested', 'stale', 'foreign', 'unknown-path', 'refused', 'no-rendition', 'changed-result', 'close', 'divergent', 'width-overflow', 'rendition-mismatch', 'values-invalidated', 'asset-producer', 'malformed-asset', 'base-file', 'splat-file', 'cloud-file', 'bytes-held', 'bytes-refused', 'bytes-close', 'bytes-result', 'stored-manifest'] as const)('resolves exact producer metadata or abstains for %s', async (variant) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:producer')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const schema = parseDinksterSchema('Preview3DProducerFixture', { body: [
    { kind: 'input', id: 'model_3d', type: { kind: 'concrete', types: ['FILE_3D_GLTF'] } },
    { kind: 'input', id: 'viewport_state', type: { kind: 'concrete', types: ['LOAD_3D'] }, widget: { type: 'LOAD_3D' } },
    { kind: 'input', id: 'camera_info', type: { kind: 'concrete', types: ['LOAD3D_CAMERA'] } },
    { kind: 'input', id: 'model_3d_info', type: { kind: 'concrete', types: ['LOAD3D_MODEL_INFO'] } },
    { kind: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] } },
  ] }).schema!
  const imported = importLitegraph({ nodes: [{ id: 1, type: schema.type }], links: [] }, () => schema)
  const graph = imported.document!.graphs.g0!
  const primary = { digest: `blake3:${'e'.repeat(64)}`, name: 'linked.gltf', size: 21, mediaType: 'model/gltf+json', virtualPath: 'linked.gltf' }
  const initial = { camera_info: { ...camera, fov: 11 }, model_3d_info: [transform], recording: '' }
  const cameraInfo = { ...camera, fov: 79, extension: 'linked-camera' }
  const models = [{ ...transform, position: { x: -8, y: 4, z: 1 }, extension: 'linked-model' }, { name: 'second-linked' }]
  const assetProducer = variant === 'asset-producer' || variant === 'malformed-asset' || variant === 'stored-manifest'
  const store = new DocumentStore({ ...imported.document!, graphs: { g0: { ...graph,
    nodes: { ...graph.nodes, n1: { ...graph.nodes.n1!, values: { viewport_state: initial, model_file: { ...primary, digest: `blake3:${'f'.repeat(64)}` },
      ...(variant === 'stored-manifest' ? { model_3d: { format: 'gltf', source: primary, resources: {} } } : {}) } },
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
  let release: (() => void) | undefined
  const paused = new Promise<void>((resolve) => { release = resolve })
  let started = false
  let byteAdmissionStarted = false
  let renditionCount = 0
  const reads: string[] = []
  let values = {
    read: async <T,>(_query: ValueQuery, _descriptor: unknown, consume: () => Promise<T>): Promise<T> => consume(),
    peek: async (query: ValueQuery) => {
      started = true
      if (variant === 'close') await paused
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
      renditionCount++
      if (variant === 'values-invalidated') await paused
      if (nested && query.nodeId !== 'current') throw new Error('wrong instance')
      if (variant === 'changed-result') execution = { ...execution, key: 'owner:new-job' }
      const value = query.outputId === 'model_3d' ? { format: variant === 'splat-file' || variant === 'cloud-file' ? 'ply' : 'gltf', source: primary,
        resources: variant === 'bytes-held' ? { 'buffers/mesh.bin': { ...primary, digest: `blake3:${'a'.repeat(64)}`, name: 'mesh.bin' } } : {} }
        : query.outputId === 'camera-output' ? cameraInfo : models
      return { available: true, mime: 'application/json', fingerprint: variant === 'rendition-mismatch' ? 'different' : 'same', bytes: new TextEncoder().encode(JSON.stringify(value)).buffer }
    },
  }
  const connection = {
    values: () => values,
    fetchAssetBytes: async (digest: string) => { reads.push(digest); return new Uint8Array([1]) },
  }
  const app = { registryForTab: () => ({ resolve: () => schema }),
    backendForTab: () => ({ id: 'owner', protocol: 'dinkster', connection }),
    file3dAssetReaderForExecution: () => {
      if (variant === 'stored-manifest') throw new Error('Stored viewer must not borrow an unrelated producer')
      return { current: () => true, read: async <T,>(consume: () => Promise<T>) => consume() }
    },
    executionForTab: () => execution, compileTabCached: () => ({ ok: true, artifact: liveArtifact }),
    readFile3dAssetForExecution: async (ref: ExecutionState['ref'], asset: { digest: string }, signal: AbortSignal) => {
      if (variant === 'stored-manifest') throw new Error('Stored model must not borrow an unrelated producer')
      expect(ref).toEqual({ connection: 'owner', prompt: 'job' })
      byteAdmissionStarted = true
      if (variant.startsWith('bytes-')) await paused
      signal.throwIfAborted()
      if (variant === 'bytes-refused') throw new Error('The selected model file is unavailable.')
      return connection.fetchAssetBytes(asset.digest)
    },
  } as unknown as AppState
  const abort = new AbortController()
  const opened = openLoad3dSource(app, tab, { graphId: 'g0', nodeId: 'n1', parts: viewportParts('viewport_state') }, abort.signal)
  if (variant === 'values-invalidated') {
    await vi.waitFor(() => expect(renditionCount).toBeGreaterThan(0))
    values = { ...values }
    release!()
  }
  if (variant.startsWith('bytes-')) {
    await vi.waitFor(() => expect(byteAdmissionStarted).toBe(true))
    expect(reads).toEqual([])
    if (variant === 'bytes-close') abort.abort()
    else if (variant === 'bytes-result') execution = { ...execution, key: 'owner:new-job' }
    release!()
  }
  if (variant === 'close') {
    await vi.waitFor(() => expect(started).toBe(true))
    abort.abort()
    release!()
  }
  if (!['current', 'nested', 'asset-producer', 'base-file', 'splat-file', 'cloud-file', 'bytes-held', 'stored-manifest'].includes(variant)) {
    // A view closed while the backend reads the bytes stops with the read;
    // a refused read passes the backend's reason on; anything else abstains.
    await expect(opened).rejects.toMatchObject(variant === 'bytes-close' ? { name: 'AbortError' }
      : variant === 'bytes-refused' ? { message: 'The selected model file is unavailable.' } : { problem: 'unavailable' })
    expect(reads).toEqual(variant === 'bytes-result' ? [primary.digest] : [])
    return
  }
  const source = await opened
  expect(reads).toEqual(variant === 'bytes-held' ? [primary.digest, `blake3:${'a'.repeat(64)}`] : [primary.digest])
  expect(source.inputValue('camera_info')).toEqual(cameraInfo)
  expect(source.inputValue('model_3d_info')).toEqual(models)
  source.release()
})
