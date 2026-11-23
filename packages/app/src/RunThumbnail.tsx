import { createEffect, createMemo, createSignal, Show } from 'solid-js'

/** A paused video frame or image; unavailable media leaves no placeholder. */
export function RunThumbnail(props: { readonly url: string; readonly mediaType: string }) {
  const [failed, setFailed] = createSignal(false)
  const [ready, setReady] = createSignal(false)
  // Backend refreshes can invalidate props without changing the loaded media.
  const url = createMemo(() => props.url)
  const mediaType = createMemo(() => props.mediaType)
  createEffect(() => {
    url()
    mediaType()
    setFailed(false)
    setReady(false)
  })
  return <Show when={!failed()}>
    <Show when={props.mediaType.startsWith('video/')} fallback={
      <img class="run-thumbnail" data-testid="run-thumbnail" data-ready={ready()} src={props.url} alt=""
        loading="lazy" decoding="async" onLoad={() => setReady(true)} onError={() => setFailed(true)} />
    }>
      <video class="run-thumbnail" data-testid="run-thumbnail" data-ready={ready()} src={props.url}
        aria-hidden="true" muted playsinline preload="auto"
        onLoadedData={() => setReady(true)} onError={() => setFailed(true)} />
    </Show>
  </Show>
}
