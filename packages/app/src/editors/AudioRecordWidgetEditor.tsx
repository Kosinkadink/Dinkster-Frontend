import { audioRecordKind } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { AudioRecorder } from '../AudioRecorder.js'
import { AudioTransport } from '../AudioTransport.js'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductNotice } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const AudioRecordImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const initial = audioRecordKind.defaultValue({ ...ed.spec!, default: ed.initial === undefined ? ed.spec?.default : ed.initial })
  const [draft, setDraft] = createSignal(initial)
  const [uploading, setUploading] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let live = true
  let abort: AbortController | undefined
  onCleanup(() => { live = false; abort?.abort() })
  const save = async (file: File): Promise<boolean> => {
    if (backend.protocol !== 'dinkster') return false
    const request = new AbortController()
    abort = request
    setUploading(true)
    setError(undefined)
    try {
      const ref = await backend.connection.uploadMediaAsset(file, { scope: 'local', kind: 'media/audio', name: file.name, signal: request.signal })
      if (!live || request.signal.aborted) return false
      setDraft(ref)
      return true
    } catch (reason) {
      if (live) setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      if (live) setUploading(false)
    }
  }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => props.editor.bindClickAway?.(undefined))

  return <div class="widget-editor audio-record-editor" data-testid="audio-record-editor">
    <Show when={draft()} keyed>{(ref) => {
      const [src, setSrc] = createSignal<string>()
      const [failed, setFailed] = createSignal(false)
      let current = true
      let ownedUrl: string | undefined
      if (backend.protocol === 'dinkster') {
        void backend.connection.fetchAssetBytes(ref.digest).then((bytes) => {
          if (!current) return
          if (bytes === undefined) { setFailed(true); return }
          ownedUrl = URL.createObjectURL(new Blob([bytes], { type: ref.mediaType }))
          setSrc(ownedUrl)
        }).catch(() => { if (current) setFailed(true) })
      }
      onCleanup(() => { current = false; if (ownedUrl) URL.revokeObjectURL(ownedUrl) })
      return <>
        <p>{ref.name}</p>
        <Show when={src()}>{(url) => <AudioTransport media={{ kind: 'audio', src: url() }} />}</Show>
        <Show when={failed()}><ProductNotice tone="error">{message('audioRecordWidget.previewUnavailable')}</ProductNotice></Show>
        <ProductButton type="button" disabled={uploading()} onClick={() => setDraft(null)}>{message('audioRecordWidget.remove')}</ProductButton>
      </>
    }}</Show>
    <Show when={backend.protocol === 'dinkster'} fallback={<ProductNotice tone="error">{message('audioRecordWidget.native')}</ProductNotice>}>
      <AudioRecorder disabled={uploading()} onPendingChange={setPending} onSave={save} />
    </Show>
    <Show when={error()}>{(detail) => <ProductNotice tone="error">{detail()}</ProductNotice>}</Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={pending() || uploading() || backend.protocol !== 'dinkster'} onClick={() => props.commitValue(draft())}>{message('audioRecordWidget.use')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const AudioRecordWidgetEditor: Component<WidgetEditorProps> = (props) => {
  const message = useAppMessage()
  return <WidgetEditorController {...props} implementation={AudioRecordImplementation}
    modal={{ type: 'AUDIO_RECORD', help: <>{message('audioRecordWidget.help')}</> }} />
}
