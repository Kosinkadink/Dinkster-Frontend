import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'

export function FolderPath(props: { readonly value: string }) {
  const split = () => {
    const separator = Math.max(props.value.lastIndexOf('/'), props.value.lastIndexOf('\\'))
    return separator < 0 ? Math.ceil(props.value.length / 2) : separator
  }
  const [shortened, setShortened] = createSignal(false)
  let path!: HTMLElement
  let prefix!: HTMLSpanElement
  let suffix!: HTMLSpanElement
  const measure = () => setShortened(prefix.scrollWidth + suffix.scrollWidth > path.clientWidth)
  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(path)
    void document.fonts?.ready.then(measure)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => { props.value; queueMicrotask(measure) })
  return <code ref={path} class="storage-folder-path" title={props.value}>
    <span ref={prefix}>{props.value.slice(0, split())}</span>
    <Show when={shortened()}><span>...</span></Show>
    <span ref={suffix}><span dir="ltr">{props.value.slice(split())}</span></span>
  </code>
}
