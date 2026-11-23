import { asPortId, buildRerouteIndex, companionSourcesOf, defaultValuesOf, inputsOf, occurrencesForView, parseAssetTypeId, parseTypedLiteralWire, portRefKey, type ExecutionRef, type Json } from '@dinkster/core'
import { createSignal, For, onCleanup, onMount, Show, type Component } from 'solid-js'
import { viewInstancePath } from '../app-state.js'
import { liveExactnessFor } from '../companion-display.js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductField, ProductNotice } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { useAppMessage } from '../locale.js'
import { mountModel3dViewer, type Model3dCameraState, type Model3dTransform, type Model3dViewerHandle } from '../model3d-viewer.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import { validFile3dAsset as validAsset, file3dFormatFromBytes as formatFromBytes } from '../file3d-preview.js'

const object = (value: unknown): Record<string, Json> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, Json> : {}
}

const Load3dImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const graphId = ed.target.kind === 'input' ? ed.target.familyOwner?.graphId ?? ed.graphId : ed.graphId
  const nodeId = ed.target.kind === 'input' ? ed.target.familyOwner?.nodeId ?? ed.target.nodeId : undefined
  const graph = ed.tab.store.doc.graphs[graphId]
  const node = nodeId === undefined ? undefined : graph?.nodes[nodeId]
  const resolveSchema = props.editor.app.registryForTab(ed.tab)?.resolve
  const index = graph === undefined ? undefined : buildRerouteIndex(graph)
  const sources = graph === undefined ? undefined : companionSourcesOf(graph, index, (sourceId, inputId) => {
    const source = graph.nodes[sourceId]
    const schema = source === undefined ? undefined : resolveSchema?.(source.type)
    return schema === undefined ? undefined : (defaultValuesOf(schema) as Record<string, Json>)[inputId]
  }, resolveSchema).get(nodeId ?? '')
  const resolved = new Map<string, Json>()
  const inputValue = (inputId: string): Json | undefined => {
    const source = sources?.get(inputId)
    if (source === undefined && node !== undefined && index !== undefined) {
      const key = portRefKey({ node: node.id, port: asPortId(inputId) })
      if (index.inputDriverOf.has(key) || index.netSourceOf.has(key)) return undefined
    }
    const value = source === undefined ? node?.values[inputId] : source.kind === 'literal' ? source.value : resolved.get(inputId)
    const typed = value === undefined ? undefined : parseTypedLiteralWire(value)
    return typed === undefined ? value : typed.value
  }
  const initial = object(ed.initial === undefined ? ed.spec?.default : ed.initial)
  const metadataOnly = ed.target.kind === 'input' && (ed.target.familyOwner?.valueKey ?? ed.target.valueKey) === 'viewport_state'
  const revision = ed.tab.store.revision
  const [camera, setCamera] = createSignal(undefined as Model3dCameraState | undefined)
  const [transform, setTransform] = createSignal(undefined as Model3dTransform | undefined)
  const [error, setError] = createSignal(undefined as string | undefined)
  const [busy, setBusy] = createSignal(false)
  const [recording, setRecording] = createSignal(false)
  const [clips, setClips] = createSignal([] as readonly { name: string; duration: number }[])
  const [clip, setClip] = createSignal(0)
  const [animationTime, setAnimationTime] = createSignal(0)
  const [animationPlaying, setAnimationPlaying] = createSignal(false)
  const [animationSpeed, setAnimationSpeed] = createSignal(1)
  // Applying stores fresh captures and an undo step, so it waits for the
  // first pointer action, key or control use after the editor opened.
  const [touched, setTouched] = createSignal(false)
  const touch = (): void => { setTouched(true) }
  let viewport!: HTMLDivElement
  onMount(() => {
    for (const type of ['pointerdown', 'wheel', 'keydown'] as const) viewport.addEventListener(type, touch, true)
  })
  let viewer: Model3dViewerHandle | undefined
  let live = true
  const urls: string[] = []
  let recorder: MediaRecorder | undefined
  let stopRecording: (() => void) | undefined
  let video: Blob | undefined
  const abort = new AbortController()
  let viewerPending = false
  let settleViewer: (() => void) | undefined
  const releaseUrls = () => { urls.splice(0).forEach((url) => URL.revokeObjectURL(url)) }
  let pendingCapture: ReturnType<Model3dViewerHandle['capture']> | undefined
  let pendingRecording = Promise.resolve()
  const backendCurrent = (): boolean => props.editor.app.backendForTab(ed.tab).connection === backend.connection
  let sourcesCurrent = (): boolean => ed.tab.store.revision === revision && backendCurrent()
  onCleanup(() => {
    live = false
    abort.abort()
    if (recorder?.state === 'recording') recorder.stop()
    stopRecording?.()
    viewer?.dispose()
    viewer = undefined
    settleViewer?.()
    if (!viewerPending) releaseUrls()
  })
  onMount(() => {
    void (async () => {
      if (backend.protocol !== 'dinkster') throw new Error(message('load3dWidget.native'))
      const inputs = ['model_3d', 'model_file', 'camera_info', 'model_3d_info', 'width', 'height']
      const producers = inputs.flatMap((inputId) => {
        const source = sources?.get(inputId)
        return source?.kind === 'producer' ? [{ inputId, source }] : []
      })
      const unavailable = () => new Error(message('load3dWidget.unavailable'))
      let producerExecution: ExecutionRef | undefined
      if (producers.length > 0) {
        if (producers.some(({ source }) => { return graph?.nodes[source.node] === undefined })) throw unavailable()
        const execution = props.editor.app.executionForTab(ed.tab)
        const ran = execution?.artifact
        const compiled = props.editor.app.compileTabCached(ed.tab)
        const current = compiled?.ok ? compiled.artifact : undefined
        const path = viewInstancePath(ed.tab)
        const ownerDepth = ed.tab.graphStack.get().lastIndexOf(graphId)
        const exact = liveExactnessFor(current, ran)
        if (!execution || execution.status !== 'completed' || !ran || !current || !exact || !path || ownerDepth < 0
          || execution.ref.connection !== backend.id || ran.connection !== backend.id || current.connection !== backend.id
          || ran.snapshot.lineage !== ed.tab.store.doc.lineage || current.snapshot.lineage !== ed.tab.store.doc.lineage) throw unavailable()
        producerExecution = execution.ref
        const values = backend.connection.values()
        sourcesCurrent = () => {
          const navigation = viewInstancePath(ed.tab)
          const fresh = props.editor.app.compileTabCached(ed.tab)
          return ed.tab.store.revision === revision && navigation?.length === path.length
            && navigation.every((id, index) => id === path[index])
            && fresh?.ok === true && fresh.artifact.schemaHash === current.schemaHash
            && props.editor.app.executionForTab(ed.tab)?.key === execution.key
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
          if (!live || !sourcesCurrent() || !ids.length || ids.some((id) => !exact(id)
            || current.provenance.toSource[id] === undefined || current.provenance.toSource[id] !== ran.provenance.toSource[id])) throw unavailable()
          const candidates = await Promise.all(ids.map(async (id) => {
            const query = { jobId: execution.ref.prompt, nodeId: id, outputId: ran.provenance.outputAliases?.[id]?.[source.output] ?? source.output }
            const peek = await values.peek(query, { signal: abort.signal })
            if (!peek.available) throw unavailable()
            return { query, peek }
          }))
          if (!live || !sourcesCurrent()) throw unavailable()
          const first = candidates[0]!
          if (candidates.some(({ peek }) => peek.descriptor.fingerprint !== first.peek.descriptor.fingerprint
            || peek.descriptor.typeId !== first.peek.descriptor.typeId)) throw unavailable()
          if (inputId === 'model_file') {
            const descriptor = first.peek.descriptor
            const ref = descriptor.meta
            if ((descriptor.typeId !== 'ASSET' && parseAssetTypeId(descriptor.typeId) === undefined) || !validAsset(ref)
              || candidates.some(({ peek }) => !validAsset(peek.descriptor.meta) || Object.keys(object(ref)).some((key) => {
                return object(peek.descriptor.meta)[key] !== object(ref)[key]
              }))) throw unavailable()
            resolved.set(inputId, ref as Json)
          } else if (inputId === 'width' || inputId === 'height') {
            const value = first.peek.descriptor.value
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 4096
              || candidates.some(({ peek }) => peek.descriptor.value !== value)) throw unavailable()
            resolved.set(inputId, value)
          } else {
            const kind = inputId === 'model_3d' ? 'manifest' : 'json'
            const advertised = first.peek.renditions.find((entry) => entry.kind === kind && entry.mime === 'application/json')
            if (!advertised || (inputId === 'model_3d' ? !['FILE_3D', 'FILE_3D_GLB', 'FILE_3D_GLTF', 'FILE_3D_FBX',
              'FILE_3D_OBJ', 'FILE_3D_STL', 'FILE_3D_USDZ', 'FILE_3D_PLY', 'FILE_3D_SPLAT', 'FILE_3D_SPZ',
              'FILE_3D_KSPLAT', 'FILE_3D_SPLAT_ANY', 'FILE_3D_POINT_CLOUD_ANY'].includes(first.peek.descriptor.typeId)
              : first.peek.descriptor.typeId !== (inputId === 'camera_info' ? 'LOAD3D_CAMERA' : 'LOAD3D_MODEL_INFO'))) throw unavailable()
            const value = await values.read(first.query, first.peek.descriptor, async () => {
              if (!live || !sourcesCurrent()) throw unavailable()
              const result = await values.rendition(first.query, kind, { signal: abort.signal, descriptor: first.peek.descriptor,
                ...(advertised.version === undefined ? {} : { rendererVersion: advertised.version }) })
              if (!live || !sourcesCurrent() || !result.available || result.mime !== 'application/json'
                || result.fingerprint !== first.peek.descriptor.fingerprint) throw unavailable()
              return JSON.parse(new TextDecoder().decode(result.bytes)) as Json
            })
            if (!live || !sourcesCurrent()) throw unavailable()
            resolved.set(inputId, value)
          }
          if (!live || !sourcesCurrent()) throw unavailable()
        }
      }
      for (const inputId of inputs) {
        const key = node === undefined ? undefined : portRefKey({ node: node.id, port: asPortId(inputId) })
        if (key !== undefined && (index?.inputDriverOf.has(key) || index?.netSourceOf.has(key)) && inputValue(inputId) === undefined) throw unavailable()
      }
      const manifest = inputValue('model_3d')
      const file3d = object(manifest)
      const resourcesValue = file3d.resources
      const resourceRefs = Object.entries(object(resourcesValue))
      if (manifest !== undefined && (
        typeof file3d.format !== 'string' || !/^[a-z0-9]*$/.test(file3d.format)
        || Object.keys(file3d).some((key) => { return !['format', 'source', 'resources'].includes(key) })
        || [file3d.source, ...resourceRefs.map(([, ref]) => ref)].some((ref) => { return !validAsset(ref) })
        || (resourcesValue !== undefined && (resourcesValue === null || typeof resourcesValue !== 'object' || Array.isArray(resourcesValue)))
        || resourceRefs.some(([name]) => {
          return !name || name.split('/').some((part) => { return !part || part === '.' || part === '..' })
            || /[\\:%?#\u0000]/.test(name)
        })
      )) throw new Error(message('load3dWidget.unavailable'))
      const model = object(manifest === undefined ? inputValue('model_file') : file3d.source)
      const modelExecution = sources?.get(manifest === undefined ? 'model_file' : 'model_3d')?.kind === 'producer'
        ? producerExecution : undefined
      const assetUrl = async (ref: Record<string, Json>) => {
        if (ref.verification === 'unverified' && (typeof ref.localBinding !== 'string' || !ref.localBinding || 'digest' in ref)) {
          throw new Error(message('load3dWidget.unavailable'))
        }
        if (ref.verification !== 'unverified' && typeof ref.digest !== 'string') throw new Error(message('load3dWidget.chooseModel'))
        if (!live || !sourcesCurrent()) throw unavailable()
        const bytes = modelExecution !== undefined
          ? await props.editor.app.readFile3dAssetForExecution(modelExecution, ref, abort.signal)
          : ref.verification === 'unverified'
            ? await backend.connection.fetchLocalAssetBytes(ref.localBinding as string, abort.signal)
            : await backend.connection.fetchAssetBytes(ref.digest as string, abort.signal)
        if (!live || !sourcesCurrent() || !bytes) throw new Error(message('load3dWidget.unavailable'))
        const url = URL.createObjectURL(new Blob([bytes], { type: String(ref.mediaType ?? 'application/octet-stream') }))
        urls.push(url)
        return { url, bytes: new Uint8Array(bytes) }
      }
      const primary = await assetUrl(model)
      const unspecified = manifest !== undefined && file3d.format === ''
      const format = unspecified ? formatFromBytes(primary.bytes)
        : typeof file3d.format === 'string' ? file3d.format : String(model.name ?? '').split('.').pop()?.toLowerCase()
      if (unspecified && !format) throw new Error(message('load3dWidget.unavailable'))
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
      const mount = async () => {
        if (!live || !sourcesCurrent()) throw unavailable()
        const schema = node === undefined ? undefined : resolveSchema?.(node.type)
        const pointCloud = schema !== undefined && inputsOf(schema).some((input) =>
          input.id === 'model_3d' && (input.type.kind === 'concrete' ? input.type.name === 'FILE_3D_POINT_CLOUD_ANY'
            : input.type.kind === 'union' && input.type.names.includes('FILE_3D_POINT_CLOUD_ANY')))
        const mounted = await mountModel3dViewer(viewport, primary.url, mime, { resources,
          ...(format ? { format } : {}), pointCloud })
        if (!live || !sourcesCurrent()) { mounted.dispose(); return }
        viewer = mounted
        try {
          const cameraInfo = inputValue('camera_info') ?? initial.camera_info
          if (cameraInfo) viewer.setCameraState(cameraInfo as unknown as Model3dCameraState)
          const models = inputValue('model_3d_info') ?? initial.model_3d_info
          if (Array.isArray(models) && models[0]) viewer.setModelTransform(models[0] as unknown as Model3dTransform)
          setCamera(viewer.cameraState())
          setTransform(viewer.modelTransform())
          setClips(viewer.animationClips())
          await new Promise<void>((resolve) => { settleViewer = resolve })
        } finally {
          if (viewer === mounted) { viewer = undefined; mounted.dispose() }
          await pendingCapture?.catch(() => {})
          await pendingRecording
        }
      }
      viewerPending = true
      try {
        await mount()
      } finally {
        viewerPending = false
        if (!live) releaseUrls()
      }
    })().catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
  })

  const record = (): void => {
    touch()
    if (recording()) {
      if (recorder?.state === 'recording') recorder.stop()
      return
    }
    let settle: (() => void) | undefined
    try {
      if (!sourcesCurrent()) throw new Error(message('load3dWidget.unavailable'))
      const capture = viewer!.recordingStream(Number(inputValue('width') ?? 1024), Number(inputValue('height') ?? 1024))
      stopRecording = capture.stop
      const currentRecorder = new MediaRecorder(capture.stream)
      recorder = currentRecorder
      video = undefined
      let failed = false
      const chunks: Blob[] = []
      pendingRecording = new Promise<void>((resolve) => { settle = resolve })
      currentRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      currentRecorder.onstop = () => {
        capture.stop()
        if (live && recorder === currentRecorder) {
          if (!failed && sourcesCurrent()) video = new Blob(chunks, { type: currentRecorder.mimeType })
          setRecording(false)
        }
        settle?.()
      }
      currentRecorder.onerror = () => {
        failed = true
        capture.stop()
        if (currentRecorder.state === 'recording') currentRecorder.stop()
        if (live && recorder === currentRecorder) setError(message('load3dWidget.recordingFailed'))
      }
      currentRecorder.start()
      setRecording(true)
    } catch (reason) {
      stopRecording?.()
      settle?.()
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const apply = async (): Promise<boolean> => {
    if (!viewer || backend.protocol !== 'dinkster' || recording() || busy()) return false
    if (ed.tab.execution || !sourcesCurrent()) { props.close(); return false }
    setBusy(true)
    setError(undefined)
    try {
      const cameraInfo = inputValue('camera_info') ?? initial.camera_info
      const models = inputValue('model_3d_info') ?? initial.model_3d_info
      const modelInfo = Array.isArray(models) ? models : []
      const next: Record<string, Json> = {
        ...initial,
        camera_info: { ...object(cameraInfo), ...JSON.parse(JSON.stringify(viewer.cameraState())) },
        model_3d_info: [{ ...object(modelInfo[0]), ...JSON.parse(JSON.stringify(viewer.modelTransform())) }, ...modelInfo.slice(1)],
      }
      if (!metadataOnly) {
        pendingCapture = viewer.capture(Number(inputValue('width') ?? 1024), Number(inputValue('height') ?? 1024))
        const capture = await pendingCapture
        for (const name of ['image', 'mask', 'normal'] as const) {
          if (!live || !sourcesCurrent()) return false
          const file = new File([capture[name]], `viewport-${name}.png`, { type: 'image/png' })
          const ref = await backend.connection.uploadMediaAsset(file, { scope: 'local', kind: 'media/image', name: file.name, signal: abort.signal })
          next[name] = JSON.parse(JSON.stringify(ref)) as Json
        }
        if (video) {
          if (!live || !sourcesCurrent()) return false
          const file = new File([video], 'viewport-recording.webm', { type: video.type })
          const ref = await backend.connection.uploadMediaAsset(file, { scope: 'local', kind: 'media/video', name: file.name, signal: abort.signal })
          next.recording = JSON.parse(JSON.stringify(ref)) as Json
        } else if (next.recording === undefined) next.recording = ''
      }
      if (!live || abort.signal.aborted) return false
      if (ed.tab.execution || !sourcesCurrent()) { props.close(); return false }
      return await props.commitValue(next)
    } finally { pendingCapture = undefined; if (live) setBusy(false) }
  }
  const changeCamera = (update: Partial<Model3dCameraState>): void => {
    if (!viewer || busy()) return
    touch()
    viewer.setCameraState({ ...viewer.cameraState(), ...update })
    setCamera(viewer.cameraState())
  }
  const changeTransform = (field: 'position' | 'quaternion' | 'scale', axis: 'x' | 'y' | 'z' | 'w', value: number): void => {
    if (!viewer || busy() || !Number.isFinite(value)) return
    touch()
    const state = viewer.modelTransform()
    if (field === 'quaternion') {
      const quaternion = { ...state.quaternion, [axis]: value }
      if (Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w) === 0) return
    }
    viewer.setModelTransform({ ...state, [field]: { ...state[field], [axis]: value } })
    setTransform(viewer.modelTransform())
  }
  props.bindFrame({
    phase: () => !camera() ? (error() !== undefined ? 'unavailable' : 'loading') : recording() ? 'invalid' : touched() ? 'changed' : 'unchanged',
    status: () => recording() ? message('load3dWidget.recordingStatus') : camera() && !touched() ? message('load3dWidget.nothingChanged') : undefined,
    unavailable: () => camera() ? undefined : error(),
    apply,
  })
  return <div class="widget-frame-body" data-testid="load3d-widget-editor" data-editor-surface="frame">
    <Show when={!metadataOnly}><div class="dinkster-editor-frame-toolbar">
      <ProductButton type="button" disabled={!camera() || busy()} onClick={record}>{message(recording() ? 'load3dWidget.stopRecording' : 'load3dWidget.record')}</ProductButton>
    </div></Show>
    <div class="dinkster-editor-frame-columns">
    <div class="dinkster-editor-frame-work load3d-widget-work">
      <div ref={viewport} inert={busy()} class="load3d-widget-viewport" data-testid="load3d-viewport" />
    </div>
    <div class="dinkster-editor-frame-panel">
    <Show when={camera() && error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    <Show when={camera()}>{(state) => <>
      <ProductField layout="compact" controlId="load3d-camera-type" label={message('load3dWidget.camera')}>
        <ProductSelect id="load3d-camera-type" disabled={busy() || recording()} ariaLabel={message('load3dWidget.camera')} selectedId={state().cameraType}
          options={[
            { id: 'perspective', value: 'perspective' as const, label: message('load3dWidget.perspective') },
            { id: 'orthographic', value: 'orthographic' as const, label: message('load3dWidget.orthographic') },
          ]} onSelect={(option) => changeCamera({ cameraType: option.value })} />
      </ProductField>
      <ProductField layout="compact" controlId="load3d-fov" label={message('load3dWidget.fov')}>
        <ProductTextInput id="load3d-fov" value={String(state().fov ?? 40)} disabled={busy() || state().cameraType === 'orthographic'}
          onChange={(event) => { const fov = Number(event.currentTarget.value); if (fov < 180 && fov > 0) changeCamera({ fov }) }} />
      </ProductField>
    </>}</Show>
    <div class="load3d-widget-transforms"><Show when={transform()}>{(state) => <For each={['position', 'quaternion', 'scale'] as const}>{(field) =>
      <For each={field === 'quaternion' ? ['x', 'y', 'z', 'w'] as const : ['x', 'y', 'z'] as const}>{(axis) => <ProductField layout="compact" controlId={`load3d-${field}-${axis}`} label={`${message(field === 'position' ? 'load3dWidget.position' : field === 'quaternion' ? 'load3dWidget.rotation' : 'load3dWidget.scale')} ${axis.toUpperCase()}`}>
        <ProductTextInput id={`load3d-${field}-${axis}`} value={String((state()[field] as Record<string, number>)[axis])} disabled={busy()}
          onChange={(event) => changeTransform(field, axis, Number(event.currentTarget.value))} />
      </ProductField>}</For>
    }</For>}</Show></div>
    <Show when={clips().length > 0}><div class="load3d-widget-transforms">
      <ProductField layout="compact" controlId="load3d-animation" label={message('load3dWidget.animation')}>
        <ProductSelect id="load3d-animation" disabled={busy()} ariaLabel={message('load3dWidget.animation')} selectedId={String(clip())}
          options={clips().map((entry, index) => ({ id: String(index), value: index, label: entry.name || message('load3dWidget.animationNumber', { number: index + 1 }) }))}
          onSelect={(option) => { touch(); setClip(option.value); setAnimationTime(0); viewer?.setAnimation(option.value, 0, animationPlaying(), animationSpeed()) }} />
      </ProductField>
      <ProductField layout="compact" controlId="load3d-animation-time" label={message('load3dWidget.animationTime')}>
        <ProductTextInput id="load3d-animation-time" disabled={busy()} value={String(animationTime())} onChange={(event) => {
          const time = Number(event.currentTarget.value)
          if (Number.isFinite(time)) { touch(); viewer?.setAnimation(clip(), time, animationPlaying(), animationSpeed()); setAnimationTime(viewer?.animationTime() ?? 0) }
        }} />
      </ProductField>
      <ProductField layout="compact" controlId="load3d-animation-speed" label={message('load3dWidget.animationSpeed')}>
        <ProductTextInput id="load3d-animation-speed" disabled={busy()} value={String(animationSpeed())} onChange={(event) => {
          const speed = Number(event.currentTarget.value)
          if (Number.isFinite(speed) && speed > 0) { touch(); setAnimationSpeed(speed); viewer?.setAnimation(clip(), viewer.animationTime(), animationPlaying(), speed) }
        }} />
      </ProductField>
      <ProductButton type="button" disabled={busy()} onClick={() => {
        touch()
        const time = viewer?.animationTime() ?? 0
        setAnimationTime(time); setAnimationPlaying(!animationPlaying()); viewer?.setAnimation(clip(), time, animationPlaying(), animationSpeed())
      }}>{message(animationPlaying() ? 'load3dWidget.pauseAnimation' : 'load3dWidget.playAnimation')}</ProductButton>
    </div></Show>
    </div>
    </div>
  </div>
}

export const Load3dWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const message = useAppMessage()
  return <WidgetEditorController {...props} implementation={Load3dImplementation}
    modal={{ type: 'LOAD_3D', help: <>{message('load3dWidget.help')}</> }} />
}
