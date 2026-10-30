import type { Json } from '@dinkster/core'
import { createSignal, For, onCleanup, onMount, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { useAppMessage } from '../locale.js'
import { mountModel3dViewer, type Model3dCameraState, type Model3dTransform, type Model3dViewerHandle } from '../model3d-viewer.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const object = (value: unknown): Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, Json> : {}

const Load3dImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const graphId = ed.target.kind === 'input' ? ed.target.familyOwner?.graphId ?? ed.graphId : ed.graphId
  const nodeId = ed.target.kind === 'input' ? ed.target.familyOwner?.nodeId ?? ed.target.nodeId : undefined
  const node = nodeId === undefined ? undefined : ed.tab.store.doc.graphs[graphId]?.nodes[nodeId]
  const initial = object(ed.initial === undefined ? ed.spec?.default : ed.initial)
  const revision = ed.tab.store.revision
  const [camera, setCamera] = createSignal<Model3dCameraState>()
  const [transform, setTransform] = createSignal<Model3dTransform>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [recording, setRecording] = createSignal(false)
  let viewport!: HTMLDivElement
  let viewer: Model3dViewerHandle | undefined
  let live = true
  let url: string | undefined
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let video: Blob | undefined
  const abort = new AbortController()
  onCleanup(() => {
    live = false
    abort.abort()
    if (recorder?.state === 'recording') recorder.stop()
    stream?.getTracks().forEach((track) => track.stop())
    viewer?.dispose()
    if (url) URL.revokeObjectURL(url)
  })
  onMount(() => {
    void (async () => {
      if (backend.protocol !== 'dinkster') throw new Error(message('load3dWidget.native'))
      const model = object(node?.values.model_file)
      if (typeof model.digest !== 'string') throw new Error(message('load3dWidget.chooseModel'))
      const bytes = await backend.connection.fetchAssetBytes(model.digest)
      if (!live) return
      if (!bytes) throw new Error(message('load3dWidget.unavailable'))
      url = URL.createObjectURL(new Blob([bytes], { type: String(model.mediaType ?? 'model/gltf-binary') }))
      const mounted = await mountModel3dViewer(viewport, url, String(model.mediaType ?? 'model/gltf-binary'))
      if (!live) { mounted.dispose(); return }
      viewer = mounted
      if (initial.camera_info) viewer.setCameraState(initial.camera_info as unknown as Model3dCameraState)
      const models = initial.model_3d_info
      if (Array.isArray(models) && models[0]) viewer.setModelTransform(models[0] as unknown as Model3dTransform)
      setCamera(viewer.cameraState())
      setTransform(viewer.modelTransform())
    })().catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
  })

  const record = (): void => {
    if (recording()) { recorder?.stop(); return }
    try {
      stream = viewport.querySelector('canvas')!.captureStream(30)
      recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = () => {
        video = new Blob(chunks, { type: recorder!.mimeType })
        stream?.getTracks().forEach((track) => track.stop())
        if (live) setRecording(false)
      }
      recorder.start()
      setRecording(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const apply = async (): Promise<void> => {
    if (!viewer || backend.protocol !== 'dinkster' || recording()) return
    if (ed.tab.execution || ed.tab.store.revision !== revision) { props.close(); return }
    setBusy(true)
    setError(undefined)
    try {
      const capture = await viewer.capture(Number(node?.values.width ?? 1024), Number(node?.values.height ?? 1024))
      const next: Record<string, Json> = {
        ...initial,
        camera_info: { ...object(initial.camera_info), ...JSON.parse(JSON.stringify(viewer.cameraState())) },
        model_3d_info: [JSON.parse(JSON.stringify(viewer.modelTransform()))],
      }
      for (const name of ['image', 'mask', 'normal'] as const) {
        const file = new File([capture[name]], `viewport-${name}.png`, { type: 'image/png' })
        const ref = await backend.connection.uploadMediaAsset(file, { scope: 'local', kind: 'media/image', name: file.name, signal: abort.signal })
        next[name] = JSON.parse(JSON.stringify(ref)) as Json
      }
      if (video) {
        const file = new File([video], 'viewport-recording.webm', { type: video.type })
        const ref = await backend.connection.uploadMediaAsset(file, { scope: 'local', kind: 'media/video', name: file.name, signal: abort.signal })
        next.recording = JSON.parse(JSON.stringify(ref)) as Json
      } else if (next.recording === undefined) next.recording = ''
      if (!live || abort.signal.aborted) return
      if (ed.tab.execution || ed.tab.store.revision !== revision) { props.close(); return }
      props.commitValue(next)
    } catch (reason) {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (live) setBusy(false) }
  }
  const changeCamera = (update: Partial<Model3dCameraState>): void => {
    if (!viewer) return
    viewer.setCameraState({ ...viewer.cameraState(), ...update })
    setCamera(viewer.cameraState())
  }
  const changeTransform = (field: 'position' | 'scale', axis: 'x' | 'y' | 'z', value: number): void => {
    if (!viewer || !Number.isFinite(value)) return
    const state = viewer.modelTransform()
    viewer.setModelTransform({ ...state, [field]: { ...state[field], [axis]: value } })
    setTransform(viewer.modelTransform())
  }
  return <div class="widget-editor widget-modal-editor" data-testid="load3d-widget-editor">
    <props.header type="LOAD_3D" />
    <div ref={viewport} class="load3d-widget-viewport" data-testid="load3d-viewport" />
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    <Show when={camera()}>{(state) => <>
      <ProductField layout="compact" controlId="load3d-camera-type" label={message('load3dWidget.camera')}>
        <ProductSelect id="load3d-camera-type" ariaLabel={message('load3dWidget.camera')} selectedId={state().cameraType}
          options={[
            { id: 'perspective', value: 'perspective' as const, label: message('load3dWidget.perspective') },
            { id: 'orthographic', value: 'orthographic' as const, label: message('load3dWidget.orthographic') },
          ]} onSelect={(option) => changeCamera({ cameraType: option.value })} />
      </ProductField>
      <ProductField layout="compact" controlId="load3d-fov" label={message('load3dWidget.fov')}>
        <ProductTextInput id="load3d-fov" value={String(state().fov ?? 40)} disabled={busy() || state().cameraType === 'orthographic'}
          onChange={(event) => { const fov = Number(event.currentTarget.value); if (fov > 0 && fov < 180) changeCamera({ fov }) }} />
      </ProductField>
    </>}</Show>
    <Show when={transform()}>{(state) => <For each={['position', 'scale'] as const}>{(field) =>
      <For each={['x', 'y', 'z'] as const}>{(axis) => <ProductField layout="compact" controlId={`load3d-${field}-${axis}`} label={`${message(field === 'position' ? 'load3dWidget.position' : 'load3dWidget.scale')} ${axis.toUpperCase()}`}>
        <ProductTextInput id={`load3d-${field}-${axis}`} value={String(state()[field][axis])} disabled={busy()}
          onChange={(event) => changeTransform(field, axis, Number(event.currentTarget.value))} />
      </ProductField>}</For>
    }</For>}</Show>
    <ProductActionFooter>
      <ProductButton type="button" disabled={!camera() || busy()} onClick={record}>{message(recording() ? 'load3dWidget.stopRecording' : 'load3dWidget.record')}</ProductButton>
      <ProductButton type="button" disabled={busy()} onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={!camera() || busy() || recording()} onClick={() => void apply()}>{message('common.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const Load3dWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const message = useAppMessage()
  return <WidgetEditorController {...props} implementation={Load3dImplementation}
    modal={{ type: 'LOAD_3D', help: <>{message('load3dWidget.help')}</> }} />
}
