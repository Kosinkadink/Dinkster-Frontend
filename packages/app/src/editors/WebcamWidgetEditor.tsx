import { webcamKind } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton } from '../ProductControls.js'
import { ProductNotice } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { captureWebcamFrame, webcamError } from '../webcam.js'
import { activeProjectId } from '../projects.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './webcam-widget-editor.css'

const WebcamImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const project = activeProjectId()
  const initial = webcamKind.defaultValue({ ...ed.spec!, default: ed.initial })
  const [draft, setDraft] = createSignal(initial)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [preview, setPreview] = createSignal<string>()
  const abort = new AbortController()
  let ownedUrl: string | undefined
  onCleanup(() => { abort.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl) })
  props.bindFrame({
    phase: () => backend.protocol !== 'dinkster' ? 'unavailable' : busy() ? 'invalid'
      : (draft()?.digest ?? null) !== (initial?.digest ?? null) ? 'changed' : 'unchanged',
    status: () => busy() ? message('webcam.capturing') : undefined,
    unavailable: () => backend.protocol !== 'dinkster' ? message('webcam.native') : undefined,
    apply: () => props.commitValue(draft()),
  })
  const capture = async () => {
    if (backend.protocol !== 'dinkster' || busy()) return
    const session = ed.tab.store
    const current = (): boolean => !abort.signal.aborted && ed.tab.store === session &&
      props.editor.app.backendForTab(ed.tab) === backend && activeProjectId() === project
    setBusy(true)
    setError(undefined)
    try {
      const target = ed.target
      const owner = target.kind === 'input' ? target.familyOwner : undefined
      const values = target.kind === 'input'
        ? ed.tab.store.doc.graphs[owner?.graphId ?? ed.graphId]?.nodes[owner?.nodeId ?? target.nodeId]?.values
        : undefined
      const file = await captureWebcamFrame({
        width: typeof values?.['width'] === 'number' ? values['width'] : 0,
        height: typeof values?.['height'] === 'number' ? values['height'] : 0,
      }, abort.signal)
      if (!current()) return
      const ref = await backend.connection.uploadMediaAsset(file, {
        scope: 'local', kind: 'media/image', name: file.name, signal: abort.signal,
      })
      if (!current()) return
      const previousUrl = ownedUrl
      ownedUrl = URL.createObjectURL(file)
      setPreview(ownedUrl)
      setDraft(ref)
      if (previousUrl) URL.revokeObjectURL(previousUrl)
    } catch (reason) {
      if (current()) setError(webcamError(reason))
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return <div class="widget-frame-body webcam-editor" data-testid="webcam-editor" data-editor-surface="frame">
    <div class="dinkster-editor-frame-toolbar">
      <ProductButton type="button" disabled={busy() || backend.protocol !== 'dinkster'} onClick={() => void capture()}>
        {message(busy() ? 'webcam.capturing' : 'webcam.capture')}
      </ProductButton>
    </div>
    <div class="dinkster-editor-frame-work">
      <Show when={preview()}>{(url) => <img src={url()} alt={message('webcam.preview')} />}</Show>
      <Show when={draft()}>{(ref) => <p>{ref().name}</p>}</Show>
      <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    </div>
  </div>
}

export const WebcamWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const message = useAppMessage()
  return <WidgetEditorController {...props} implementation={WebcamImplementation}
    modal={{ form: true, type: 'WEBCAM', help: <>{message('webcam.help')}</> }} />
}
