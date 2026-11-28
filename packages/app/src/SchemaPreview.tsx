import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { inputsOf, outputsOf, type NodeSchema, type TypeDisplayNames, type WidgetRegistry } from '@dinkster/core'
import { typeExprCanonicalLabel } from '@dinkster/canvas'
import { paintSchemaPreview } from './palette-node-preview.js'
import { useAppMessage } from './locale.js'

export function SchemaPreview(props: { readonly schema: NodeSchema; readonly widgets: WidgetRegistry; readonly maximize?: boolean; readonly subgraph?: boolean; readonly typeDisplayNames?: TypeDisplayNames | undefined }) {
  let canvas!: HTMLCanvasElement
  const message = useAppMessage()
  const [failure, setFailure] = createSignal(false)
  const paint = () => {
    try { paintSchemaPreview(canvas, props.schema, props.widgets, props.subgraph, props.maximize, props.typeDisplayNames); setFailure(false) }
    catch { setFailure(true) }
  }
  createEffect(() => { props.schema; props.widgets; paint() })
  onMount(() => {
    const observer = new ResizeObserver(paint)
    if (canvas.parentElement) observer.observe(canvas.parentElement)
    const themeObserver = new MutationObserver(paint)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    onCleanup(() => { observer.disconnect(); themeObserver.disconnect() })
  })
  return <>
    <canvas ref={canvas} class="palette-node-preview" data-testid="search-node-preview" role="img" aria-label={message('palette.preview.aria', { name: props.schema.displayName })}
      aria-description={props.typeDisplayNames === undefined ? undefined : [...inputsOf(props.schema), ...outputsOf(props.schema)]
        .map((port) => `${port.displayName ?? port.id}: ${typeExprCanonicalLabel(port.type)}`).join('; ')} />
    <Show when={failure()}><p role="status">{message('search.previewUnavailable')}</p></Show>
  </>
}
