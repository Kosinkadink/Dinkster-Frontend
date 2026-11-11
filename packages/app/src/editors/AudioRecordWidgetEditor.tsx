import { audioRecordKind } from '@dinkster/widgets'
import { createSignal, onCleanup, Show, type Component } from 'solid-js'
import { AudioRecorder } from '../AudioRecorder.js'
import { AudioTransport } from '../AudioTransport.js'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductNotice } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { activeProjectId } from '../projects.js'
import type { PreviewSource } from '../node-previews.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const AudioRecordImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const message = useAppMessage()
  const ed = props.editor.ed
  const backend = props.editor.app.backendForTab(ed.tab)
  const project = activeProjectId()
  const initial = audioRecordKind.defaultValue({ ...ed.spec!, default: ed.initial === undefined ? ed.spec?.default : ed.initial })
  const [draft, setDraft] = createSignal(initial)
  const [uploading, setUploading] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let live = true
  let abort: AbortController | undefined
  let draftReader: PreviewSource['assetReader']
  onCleanup(() => { live = false; abort?.abort() })
  const save = async (file: File): Promise<boolean> => {
    if (backend.protocol !== 'dinkster') return false
    const session = ed.tab.store
    const request = new AbortController()
    abort = request
    setUploading(true)
    setError(undefined)
    const current = (): boolean => live && !request.signal.aborted &&
      ed.tab.store === session && props.editor.app.backendForTab(ed.tab) === backend && activeProjectId() === project
    try {
      if (!current()) return false
      const ref = await backend.connection.uploadMediaAsset(file, { scope: 'local', kind: 'media/audio', name: file.name, signal: request.signal })
      if (!current()) return false
      const reader = await props.editor.app.retainPickerAssets(ed.tab, backend, ref)
      if (!current()) return false
      draftReader = reader
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
      const previewAbort = new AbortController()
      const reader = ref === initial && backend.protocol === 'dinkster'
        ? props.editor.app.workflowAssetReader(ed.tab, ref.digest) : draftReader
      if (backend.protocol === 'dinkster') {
        const load = async () => {
          if (!current || reader?.current() !== true) return
          const bytes = await backend.connection.fetchAssetBytes(ref.digest, previewAbort.signal)
          if (!current || reader?.current() !== true) return
          if (bytes === undefined) { setFailed(true); return }
          ownedUrl = URL.createObjectURL(new Blob([bytes], { type: ref.mediaType }))
          setSrc(ownedUrl)
        }
        void (reader?.read(load) ?? Promise.reject(new Error(message('audioRecordWidget.previewUnavailable'))))
          .catch(() => { if (current) setFailed(true) })
      }
      onCleanup(() => { current = false; previewAbort.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl) })
      return <>
        <p>{ref.name}</p>
        <Show when={src()}>{(url) => <AudioTransport media={{ kind: 'audio', src: url() }} assetReader={reader} />}</Show>
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
