import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { NodeSchema, WidgetRegistry } from '@dinkster/core'
import { paintSchemaPreview } from './palette-node-preview.js'
import { useAppMessage } from './locale.js'

export function SchemaPreview(props: { readonly schema: NodeSchema; readonly widgets: WidgetRegistry }) {
  let canvas!: HTMLCanvasElement
  const message = useAppMessage()
  const [failure, setFailure] = createSignal(false)
  const paint = () => {
    try { paintSchemaPreview(canvas, props.schema, props.widgets); setFailure(false) }
    catch { setFailure(true) }
  }
  createEffect(() => { props.schema; props.widgets; paint() })
  onMount(() => {
    const observer = new ResizeObserver(paint)
    if (canvas.parentElement) observer.observe(canvas.parentElement)
    onCleanup(() => observer.disconnect())
  })
  return <>
    <canvas ref={canvas} class="palette-node-preview" data-testid="search-node-preview" role="img" aria-label={message('palette.preview.aria', { name: props.schema.displayName })} />
    <Show when={failure()}><p role="status">{message('search.previewUnavailable')}</p></Show>
  </>
}
