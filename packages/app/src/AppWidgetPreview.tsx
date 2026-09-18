import { Show, createEffect, onCleanup, onMount } from 'solid-js'
import { createRegistryPainter, defaultTokens, multilineWidgetHeight, type LayoutRow } from '@dinkster/canvas'
import type { WidgetRegistry } from '@dinkster/core'
import { appViewWidgetPresentation, type ParamRow } from './app-view-rows.js'

export function AppWidgetPreview(props: {
  readonly row: Extract<ParamRow, { kind: 'live' }>
  readonly registry: WidgetRegistry
}) {
  const presentation = () => {
    const resolved = appViewWidgetPresentation(props.row, props.registry)
    if (resolved === undefined) return undefined
    const rows = Number.isFinite(resolved.rows) ? Math.max(1, Math.floor(resolved.rows)) : 1
    return { ...resolved, rows }
  }
  let canvas: HTMLCanvasElement | undefined
  let observer: ResizeObserver | undefined

  const paint = (): void => {
    const element = canvas
    const resolved = presentation()
    const spec = props.row.spec
    if (element === undefined || resolved === undefined || spec === undefined) return
    const width = Math.max(1, element.clientWidth || element.parentElement?.clientWidth || 320)
    const height = resolved.view.id === 'core.text'
      ? multilineWidgetHeight(resolved.rows, defaultTokens)
      : resolved.rows * defaultTokens.rowHeight
    const dpr = window.devicePixelRatio || 1
    element.style.height = `${height}px`
    element.width = Math.max(1, Math.round(width * dpr))
    element.height = Math.max(1, Math.round(height * dpr))
    const ctx = element.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.font = `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`
    ctx.textBaseline = 'middle'
    const row: Extract<LayoutRow, { kind: 'widget' }> = {
      kind: 'widget',
      y: 0,
      height,
      inset: 0,
      inputId: props.row.entry.inputId,
      valueKey: props.row.valueKey,
      label: props.row.label,
      type: props.row.item.spec.type,
      viewId: resolved.view.id,
      rows: resolved.rows,
      spec,
      address: props.row.item.address,
      ...(props.row.item.spec.optional ? { optional: true } : {}),
      ...(props.row.item.derivedValue !== undefined ? { derivedValue: props.row.item.derivedValue } : {}),
    }
    createRegistryPainter(props.registry)({
      ctx,
      row,
      value: props.row.item.derivedValue ?? props.row.node.values[props.row.valueKey],
      x: 0,
      y: 0,
      width,
      rowHeight: defaultTokens.rowHeight,
      connected: props.row.linked,
      tokens: defaultTokens,
    })
  }

  createEffect(() => {
    props.row.value
    props.row.label
    props.row.linked
    presentation()
    queueMicrotask(paint)
  })
  onMount(() => {
    if (canvas === undefined) return
    observer = new ResizeObserver(paint)
    observer.observe(canvas)
    paint()
  })
  onCleanup(() => observer?.disconnect())

  return (
    <Show when={presentation()}>
      {(resolved) => (
        <canvas
          ref={canvas}
          class="app-view-widget-preview"
          data-testid="app-view-widget-preview"
          data-widget-view={resolved().view.id}
          aria-hidden="true"
        />
      )}
    </Show>
  )
}
