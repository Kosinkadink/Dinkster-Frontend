import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import type { NodePreview } from '@dinkster/canvas'
import { desktopSaveBridge } from './desktop-bridge.js'
import { requestFetch, requestFailure } from '@dinkster/client'
import { failureMessage } from './request-failure.js'

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
    const native = desktopSaveBridge()
    if (!download.load && !native) return
    event.preventDefault()
    if (busy()) return
    release()
    const controller = new AbortController()
    request = controller
    setBusy(true); setError('')
    try {
      const blob = download.load ? await download.load(controller.signal) : await (async () => {
        const response = await requestFetch(fetch)(download.src, { signal: controller.signal })
        if (!response.ok) throw await requestFailure(response)
        return response.blob()
      })()
      if (controller.signal.aborted) return
      if (native) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!controller.signal.aborted) await native.saveFile(bytes, download.name)
        return
      }
      url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = download.name
      document.body.append(link)
      link.click(); link.remove()
    } catch (cause) {
      if (!controller.signal.aborted) setError(failureMessage(cause, 'The download could not be completed.'))
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
