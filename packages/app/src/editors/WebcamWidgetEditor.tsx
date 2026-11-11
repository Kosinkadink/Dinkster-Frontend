import { webcamKind } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductNotice } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { captureWebcamFrame, webcamError } from '../webcam.js'
import { activeProjectId } from '../projects.js'
import type { PreviewSource } from '../node-previews.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './webcam-widget-editor.css'

const WebcamImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const project = activeProjectId()
  const [draft, setDraft] = createSignal(webcamKind.defaultValue({ ...ed.spec!, default: ed.initial }))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [preview, setPreview] = createSignal<string>()
  const abort = new AbortController()
  let ownedUrl: string | undefined
  let draftReader: PreviewSource['assetReader']
  onCleanup(() => { abort.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl) })
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => props.editor.bindClickAway?.(undefined))
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
      const reader = await props.editor.app.retainPickerAssets(ed.tab, backend, ref)
      if (!current()) return
      const publish = (): boolean => {
        if (!current() || !reader.current()) return false
        const previousUrl = ownedUrl
        ownedUrl = URL.createObjectURL(file)
        draftReader = reader
        setPreview(ownedUrl)
        setDraft(ref)
        if (previousUrl) URL.revokeObjectURL(previousUrl)
        return true
      }
      if (draftReader) await props.editor.app.replacePickerAssets(draftReader, reader, publish)
      else publish()
    } catch (reason) {
      if (current()) setError(webcamError(reason))
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return <div class="widget-editor webcam-editor" data-testid="webcam-editor">
    <Show when={preview()}>{(url) => <img src={url()} alt={message('webcam.preview')} />}</Show>
    <Show when={draft()}>{(ref) => <p>{ref().name}</p>}</Show>
    <ProductButton type="button" disabled={busy() || backend.protocol !== 'dinkster'} onClick={() => void capture()}>
      {message(busy() ? 'webcam.capturing' : 'webcam.capture')}
    </ProductButton>
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={busy() || !draft()} onClick={() => props.commitValue(draft())}>{message('webcam.use')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const WebcamWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const message = useAppMessage()
  return <WidgetEditorController {...props} implementation={WebcamImplementation}
    modal={{ type: 'WEBCAM', help: <>{message('webcam.help')}</> }} />
}
