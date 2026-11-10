import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import type { CollectionEntry } from '@dinkster/core'

/** The same cancellable thumbnail lifetime serves cards and selection details. */
export function CollectionImage(props: {
  readonly entry: Pick<CollectionEntry, 'thumbUrl' | 'thumbRender'>
  readonly class: string
  readonly alt: string
  readonly fallback: JSX.Element
  readonly onError?: () => void
  readonly onLoad?: JSX.EventHandler<HTMLImageElement, Event>
}) {
  const [failed, setFailed] = createSignal(false)
  const [rendered, setRendered] = createSignal<string>()
  createEffect(() => {
    const direct = props.entry.thumbUrl
    const render = direct === undefined ? props.entry.thumbRender : undefined
    setRendered(undefined)
    setFailed(false)
    if (render === undefined) return
    let live = true
    const abort = new AbortController()
    onCleanup(() => { live = false; abort.abort() })
    render(abort.signal).then(
      (url) => { if (live) setRendered(url) },
      () => { if (live) { setFailed(true); props.onError?.() } },
    )
  })
  return <Show when={!failed() ? props.entry.thumbUrl ?? rendered() : undefined} fallback={props.fallback}>
    {(url) => <img class={props.class} src={url()} alt={props.alt} loading="lazy" decoding="async"
      onError={() => { setFailed(true); props.onError?.() }} onLoad={props.onLoad} />}
  </Show>
}
