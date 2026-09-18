import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import type { NodePreview } from '@dinkster/canvas'

export function PreviewDownload(props: {
  readonly download: NonNullable<NodePreview['download']>
  readonly class: string
  readonly label: string
  readonly testId?: string
}) {
  let request: AbortController | undefined
  let url: string | undefined
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const release = () => {
    request?.abort()
    if (url) URL.revokeObjectURL(url)
    url = undefined
  }
  createEffect(on(() => props.download, () => { release(); setBusy(false); setError('') }))
  onCleanup(release)
  const save = async (event: MouseEvent) => {
    const download = props.download
    if (!download.load) return
    event.preventDefault()
    if (busy()) return
    release()
    const controller = new AbortController()
    request = controller
    setBusy(true); setError('')
    try {
      const blob = await download.load(controller.signal)
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = download.name
      document.body.append(link)
      link.click(); link.remove()
    } catch (cause) {
      if (!controller.signal.aborted) setError(`Download failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <>
    <a class={props.class} data-testid={props.testId} href={props.download.src} download={props.download.name}
      aria-disabled={busy()} onClick={(event) => void save(event)}>{busy() ? 'Downloading...' : props.label}</a>
    <Show when={error()}><span role="alert">{error()}</span></Show>
  </>
}
