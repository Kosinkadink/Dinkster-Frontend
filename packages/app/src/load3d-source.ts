import { asPortId, buildRerouteIndex, companionSourcesOf, defaultValuesOf, inputsOf, occurrencesForView, parseAssetTypeId, parseTypedLiteralWire, portRefKey, type ExecutionRef, type Json, type WidgetParts } from '@dinkster/core'
import { viewInstancePath, type AppState, type Tab } from './app-state.js'
import { liveExactnessFor } from './companion-display.js'
import { validFile3dAsset as validAsset, file3dFormatFromBytes as formatFromBytes } from './file3d-preview.js'
import type { Model3dLoadOptions } from './model3d-viewer.js'

/**
 * Why a Load 3D viewport has no model to show: the backend has no 3D
 * authoring, no model is chosen, a wired model is not known until a run
 * brings it, or the model cannot be read.
 */
export type Load3dSourceProblem = 'native' | 'noModel' | 'notKnown' | 'unavailable'

export class Load3dSourceError extends Error {
  constructor(readonly problem: Load3dSourceProblem) {
    super(problem)
  }
}

/** A Load 3D viewport's model, read and ready to mount. */
export interface Load3dSource {
  readonly src: string
  readonly mime: string
  readonly options: Model3dLoadOptions
  /** A row the viewport reads, by the part its widget names: the node's own value, or what its wire brought. */
  readonly inputValue: (part: string) => Json | undefined
  /** Whether what was read still holds: the same backend, the same run and, for a dialog, the same document. */
  readonly current: () => boolean
  /** Releases the model's object URLs, once nothing reads them any more. */
  readonly release: () => void
}

const object = (value: unknown): Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, Json> : {}

const FILE_3D_TYPES = ['FILE_3D', 'FILE_3D_GLB', 'FILE_3D_GLTF', 'FILE_3D_FBX', 'FILE_3D_OBJ', 'FILE_3D_STL', 'FILE_3D_USDZ',
  'FILE_3D_PLY', 'FILE_3D_SPLAT', 'FILE_3D_SPZ', 'FILE_3D_KSPLAT', 'FILE_3D_SPLAT_ANY', 'FILE_3D_POINT_CLOUD_ANY']

/**
 * Reads the model a Load 3D viewport shows: the node's model file, or the
 * model, camera and placement a wire brought in the last run, which must be
 * exactly the run of the current workflow. `stable` adds the caller's own
 * condition for what was read to stay current. Aborting `signal` stops the
 * read; a read that fails releases what it fetched, and one that succeeds
 * leaves that to the caller.
 */
export async function openLoad3dSource(app: AppState, tab: Tab, at: {
  readonly graphId: string
  readonly nodeId: string
  readonly parts: WidgetParts | undefined
}, signal: AbortSignal, stable: () => boolean = () => true): Promise<Load3dSource> {
  const backend = app.backendForTab(tab)
  if (backend.protocol !== 'dinkster') throw new Load3dSourceError('native')
  const graph = tab.store.doc.graphs[at.graphId]
  const node = graph?.nodes[at.nodeId]
  const resolveSchema = app.registryForTab(tab)?.resolve
  const index = graph === undefined ? undefined : buildRerouteIndex(graph)
  const sources = graph === undefined ? undefined : companionSourcesOf(graph, index, (sourceId, inputId) => {
    const source = graph.nodes[sourceId]
    const schema = source === undefined ? undefined : resolveSchema?.(source.type)
    return schema === undefined ? undefined : (defaultValuesOf(schema) as Record<string, Json>)[inputId]
  }, resolveSchema).get(at.nodeId)
  const parts = at.parts
  const rowOf = (part: string): string | undefined => parts === undefined ? undefined
    : Object.hasOwn(parts.writes, part) ? parts.writes[part] : Object.hasOwn(parts.reads, part) ? parts.reads[part] : undefined
  const resolved = new Map<string, Json>()
  const inputValue = (part: string): Json | undefined => {
    const row = rowOf(part)
    if (row === undefined) return undefined
    const source = sources?.get(row)
    if (source === undefined && node !== undefined && index !== undefined) {
      const key = portRefKey({ node: node.id, port: asPortId(row) })
      if (index.inputDriverOf.has(key) || index.netSourceOf.has(key)) return undefined
    }
    const value = source === undefined ? node?.values[row] : source.kind === 'literal' ? source.value : resolved.get(part)
    const typed = value === undefined ? undefined : parseTypedLiteralWire(value)
    return typed === undefined ? value : typed.value
  }
  const urls: string[] = []
  const release = (): void => { urls.splice(0).forEach((url) => URL.revokeObjectURL(url)) }
  const backendCurrent = (): boolean => app.backendForTab(tab).connection === backend.connection
  let current = (): boolean => !signal.aborted && stable() && backendCurrent()
  const unavailable = () => new Load3dSourceError('unavailable')
  try {
    const inputs = ['model_3d', 'model_file', 'camera_info', 'model_3d_info', 'width', 'height']
    const producers = inputs.flatMap((inputId) => {
      const row = rowOf(inputId)
      const source = row === undefined ? undefined : sources?.get(row)
      return source?.kind === 'producer' ? [{ inputId, source }] : []
    })
    let producerExecution: ExecutionRef | undefined
    if (producers.length > 0) {
      if (producers.some(({ source }) => graph?.nodes[source.node] === undefined)) throw unavailable()
      const execution = app.executionForTab(tab)
      const ran = execution?.artifact
      if (!execution || execution.status !== 'completed' || !ran) throw new Load3dSourceError('notKnown')
      const compiled = app.compileTabCached(tab)
      const compiledArtifact = compiled?.ok ? compiled.artifact : undefined
      const path = viewInstancePath(tab)
      const ownerDepth = tab.graphStack.get().lastIndexOf(at.graphId)
      const exact = liveExactnessFor(compiledArtifact, ran)
      if (!compiledArtifact || !exact || !path || ownerDepth < 0
        || execution.ref.connection !== backend.id || ran.connection !== backend.id || compiledArtifact.connection !== backend.id
        || ran.snapshot.lineage !== tab.store.doc.lineage || compiledArtifact.snapshot.lineage !== tab.store.doc.lineage) throw unavailable()
      producerExecution = execution.ref
      const values = backend.connection.values()
      current = () => {
        const navigation = viewInstancePath(tab)
        const fresh = app.compileTabCached(tab)
        return !signal.aborted && stable() && navigation?.length === path.length
          && navigation.every((id, at) => id === path[at])
          && fresh?.ok === true && fresh.artifact.schemaHash === compiledArtifact.schemaHash
          && app.executionForTab(tab)?.key === execution.key
          && backendCurrent() && backend.connection.values() === values
      }
      const occurrences = occurrencesForView({
        instancePath: path.slice(0, ownerDepth),
        runtimeIds: new Set([
          ...Object.keys(ran.prompt), ...Object.keys(execution.nodes), ...Object.keys(execution.outputs),
          ...Object.keys(execution.previews), ...Object.keys(execution.blockedNodes ?? {}), ...Object.keys(execution.expandedNodes ?? {}),
          ...execution.activities.map((entry) => entry.nodeId), ...execution.artifacts.map((entry) => entry.nodeId),
          ...execution.logs.flatMap((entry) => entry.runtimeNodeId === undefined ? [] : [entry.runtimeNodeId]),
          ...(execution.valueDiagnostics ?? []).map((entry) => entry.nodeId),
        ]),
        toSource: ran.provenance.toSource,
      })
      for (const { inputId, source } of producers) {
        const ids = occurrences.own.get(source.node) ?? []
        if (!current() || !ids.length || ids.some((id) => !exact(id)
          || compiledArtifact.provenance.toSource[id] === undefined || compiledArtifact.provenance.toSource[id] !== ran.provenance.toSource[id])) throw unavailable()
        const candidates = await Promise.all(ids.map(async (id) => {
          const query = { jobId: execution.ref.prompt, nodeId: id, outputId: ran.provenance.outputAliases?.[id]?.[source.output] ?? source.output }
          const peek = await values.peek(query, { signal })
          if (!peek.available) throw unavailable()
          return { query, peek }
        }))
        if (!current()) throw unavailable()
        const first = candidates[0]!
        if (candidates.some(({ peek }) => peek.descriptor.fingerprint !== first.peek.descriptor.fingerprint
          || peek.descriptor.typeId !== first.peek.descriptor.typeId)) throw unavailable()
        if (inputId === 'model_file') {
          const descriptor = first.peek.descriptor
          const ref = descriptor.meta
          if ((descriptor.typeId !== 'ASSET' && parseAssetTypeId(descriptor.typeId) === undefined) || !validAsset(ref)
            || candidates.some(({ peek }) => !validAsset(peek.descriptor.meta) || Object.keys(object(ref)).some((key) =>
              object(peek.descriptor.meta)[key] !== object(ref)[key]))) throw unavailable()
          resolved.set(inputId, ref as Json)
        } else if (inputId === 'width' || inputId === 'height') {
          const value = first.peek.descriptor.value
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4096
            || candidates.some(({ peek }) => peek.descriptor.value !== value)) throw unavailable()
          resolved.set(inputId, value)
        } else {
          const kind = inputId === 'model_3d' ? 'manifest' : 'json'
          const advertised = first.peek.renditions.find((entry) => entry.kind === kind && entry.mime === 'application/json')
          if (!advertised || (inputId === 'model_3d' ? !FILE_3D_TYPES.includes(first.peek.descriptor.typeId)
            : first.peek.descriptor.typeId !== (inputId === 'camera_info' ? 'LOAD3D_CAMERA' : 'LOAD3D_MODEL_INFO'))) throw unavailable()
          const value = await values.read(first.query, first.peek.descriptor, async () => {
            if (!current()) throw unavailable()
            const result = await values.rendition(first.query, kind, { signal, descriptor: first.peek.descriptor,
              ...(advertised.version === undefined ? {} : { rendererVersion: advertised.version }) })
            if (!current() || !result.available || result.mime !== 'application/json'
              || result.fingerprint !== first.peek.descriptor.fingerprint) throw unavailable()
            return JSON.parse(new TextDecoder().decode(result.bytes)) as Json
          })
          if (!current()) throw unavailable()
          resolved.set(inputId, value)
        }
        if (!current()) throw unavailable()
      }
    }
    for (const inputId of inputs) {
      const row = rowOf(inputId)
      const key = node === undefined || row === undefined ? undefined : portRefKey({ node: node.id, port: asPortId(row) })
      if (key !== undefined && (index?.inputDriverOf.has(key) || index?.netSourceOf.has(key)) && inputValue(inputId) === undefined) throw unavailable()
    }
    const manifest = inputValue('model_3d')
    const file3d = object(manifest)
    const resourcesValue = file3d.resources
    const resourceRefs = Object.entries(object(resourcesValue))
    if (manifest !== undefined && (
      typeof file3d.format !== 'string' || !/^[a-z0-9]*$/.test(file3d.format)
      || Object.keys(file3d).some((key) => !['format', 'source', 'resources'].includes(key))
      || [file3d.source, ...resourceRefs.map(([, ref]) => ref)].some((ref) => !validAsset(ref))
      || (resourcesValue !== undefined && (resourcesValue === null || typeof resourcesValue !== 'object' || Array.isArray(resourcesValue)))
      || resourceRefs.some(([name]) => !name || name.split('/').some((part) => !part || part === '.' || part === '..')
        || /[\\:%?#\u0000]/.test(name))
    )) throw unavailable()
    const model = object(manifest === undefined ? inputValue('model_file') : file3d.source)
    const modelRow = rowOf(manifest === undefined ? 'model_file' : 'model_3d')
    const modelExecution = modelRow !== undefined && sources?.get(modelRow)?.kind === 'producer' ? producerExecution : undefined
    const assetUrl = async (ref: Record<string, Json>) => {
      if (ref.verification === 'unverified' && (typeof ref.localBinding !== 'string' || !ref.localBinding || 'digest' in ref)) throw unavailable()
      if (ref.verification !== 'unverified' && typeof ref.digest !== 'string') throw new Load3dSourceError('noModel')
      if (!current()) throw unavailable()
      const bytes = modelExecution !== undefined
        ? await app.readFile3dAssetForExecution(modelExecution, ref, signal)
        : ref.verification === 'unverified'
          ? await backend.connection.fetchLocalAssetBytes(ref.localBinding as string, signal)
          : await backend.connection.fetchAssetBytes(ref.digest as string, signal)
      if (!current() || !bytes) throw unavailable()
      const url = URL.createObjectURL(new Blob([bytes], { type: String(ref.mediaType ?? 'application/octet-stream') }))
      urls.push(url)
      return { url, bytes: new Uint8Array(bytes) }
    }
    const primary = await assetUrl(model)
    const unspecified = manifest !== undefined && file3d.format === ''
    const format = unspecified ? formatFromBytes(primary.bytes)
      : typeof file3d.format === 'string' ? file3d.format : String(model.name ?? '').split('.').pop()?.toLowerCase()
    if (unspecified && !format) throw unavailable()
    const resources: Record<string, string> = Object.create(null)
    for (const [name, ref] of resourceRefs) resources[name] = (await assetUrl(object(ref))).url
    const lines: string[] = []
    if (unspecified && format === 'ply') {
      const decoder = new TextDecoder()
      for (let start = 0; start < primary.bytes.length;) {
        const end = primary.bytes.indexOf(10, start)
        if (end < 0) break
        const line = decoder.decode(primary.bytes.subarray(start, end))
        if (line.trim() === 'end_header') break
        lines.push(line)
        start = end + 1
      }
    }
    const header = lines.join('\n')
    const gaussian = /^property\s+float\s+f_dc_0\s*$/m.test(header)
      && /^property\s+float\s+scale_0\s*$/m.test(header)
      && /^property\s+float\s+rot_0\s*$/m.test(header)
    const mime = format === 'gltf' ? 'model/gltf+json' : unspecified ? gaussian ? 'model/ply' : 'application/octet-stream' : String(model.mediaType ?? 'model/gltf-binary')
    const schema = node === undefined ? undefined : resolveSchema?.(node.type)
    const pointCloud = schema !== undefined && inputsOf(schema).some((input) =>
      input.id === rowOf('model_3d') && (input.type.kind === 'concrete' ? input.type.name === 'FILE_3D_POINT_CLOUD_ANY'
        : input.type.kind === 'union' && input.type.names.includes('FILE_3D_POINT_CLOUD_ANY')))
    if (!current()) throw unavailable()
    return { src: primary.url, mime, options: { resources, ...(format ? { format } : {}), pointCloud }, inputValue, current, release }
  } catch (reason) {
    release()
    throw reason
  }
}
