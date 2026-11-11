import { boundingBoxKind, type BoundingBox } from '@dinkster/widgets'
import { defaultRenditionOf } from '@dinkster/client'
import { asNodeId, companionSourcesOf, occurrencesForView } from '@dinkster/core'
import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component } from 'solid-js'
import { viewInstancePath } from '../app-state.js'
import { liveExactnessFor } from '../companion-display.js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './bounding-box-widget-editor.css'

const fields = ['x', 'y', 'width', 'height'] as const

const BoundingBoxImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const message = useAppMessage()
  const initial = boundingBoxKind.valueSchema.validate(ed.initial) ? ed.initial : boundingBoxKind.defaultValue(ed.spec!)
  const [draft, setDraft] = createSignal<Record<keyof BoundingBox, string>>({
    x: String(initial.x), y: String(initial.y), width: String(initial.width), height: String(initial.height),
  })
  const box = (): BoundingBox => ({ x: Number(draft().x), y: Number(draft().y), width: Number(draft().width), height: Number(draft().height) })
  const valid = (): boolean => {
    return fields.every((field) => draft()[field].trim() !== '') && boundingBoxKind.validate(box(), ed.spec!).length === 0
  }
  const [preview, setPreview] = createSignal<ImageBitmap>()
  const [loading, setLoading] = createSignal(false)
  const abort = new AbortController()
  const revision = ed.tab.store.revision
  let canvas!: HTMLCanvasElement
  onCleanup(() => { abort.abort(); preview()?.close() })
  onMount(() => {
    void (async () => {
      const target = ed.target
      if (target.kind !== 'input') return
      const app = props.editor.app
      const graphId = target.familyOwner?.graphId ?? ed.graphId
      const nodeId = target.familyOwner?.nodeId ?? target.nodeId
      const graph = ed.tab.store.doc.graphs[graphId]
      const source = graph && companionSourcesOf(graph, undefined, undefined, app.registryForTab?.(ed.tab)?.resolve).get(nodeId)?.get('image')
      const execution = app.executionForTab?.(ed.tab)
      const compiled = app.compileTabCached?.(ed.tab)
      const backend = app.backendForTab?.(ed.tab)
      if (source?.kind !== 'producer' || execution?.status !== 'completed' || !execution.artifact || !compiled?.ok || backend?.protocol !== 'dinkster'
        || compiled.artifact.connection !== backend.id || execution.ref.connection !== backend.id
        || execution.artifact.snapshot.lineage !== ed.tab.store.doc.lineage) return
      const path = viewInstancePath(ed.tab)
      const ownerDepth = ed.tab.graphStack.get().lastIndexOf(graphId)
      if (!path || ownerDepth < 0) return
      const runtimeIds = occurrencesForView({ instancePath: path.slice(0, ownerDepth).map(asNodeId),
        runtimeIds: new Set([...Object.keys(execution.nodes), ...Object.keys(execution.outputs)]),
        toSource: execution.artifact.provenance.toSource }).own.get(asNodeId(source.node)) ?? []
      const runtimeId = runtimeIds.length === 1 ? runtimeIds[0] : undefined
      if (!runtimeId || liveExactnessFor(compiled.artifact, execution.artifact)?.(runtimeId) !== true) return
      const current = () => !abort.signal.aborted && ed.tab.store.revision === revision
        && app.backendForTab(ed.tab).connection === backend.connection && app.executionForTab(ed.tab)?.key === execution.key
        && viewInstancePath(ed.tab)?.length === path.length
        && viewInstancePath(ed.tab)?.every((id, index) => id === path[index]) === true
      const values = backend.connection.values()
      const query = { jobId: execution.ref.prompt, nodeId: runtimeId,
        outputId: execution.artifact.provenance.outputAliases?.[runtimeId]?.[source.output] ?? source.output }
      setLoading(true)
      const peek = await values.peek(query, { signal: abort.signal })
      if (!peek.available || peek.descriptor.typeId !== 'IMAGE' || !current()) return
      const rendition = defaultRenditionOf(peek.renditions.filter((entry) => entry.mime === 'image/png'))
      if (!rendition) return
      await values.read(query, peek.descriptor, async () => {
        const result = await values.rendition(query, rendition.kind, { signal: abort.signal, descriptor: peek.descriptor,
          ...(rendition.parameters?.includes('batch') ? { batch: 0 } : {}),
          ...(rendition.version === undefined ? {} : { rendererVersion: rendition.version }) })
        if (!result.available || result.mime !== 'image/png' || result.bytes.byteLength > 64 * 1024 * 1024 || !current()) return
        const bitmap = await createImageBitmap(new Blob([result.bytes], { type: result.mime }))
        if (!current()) { bitmap.close(); return }
        try {
          await values.read(query, peek.descriptor, async () => {
            if (!current()) return
            canvas.width = bitmap.width; canvas.height = bitmap.height
            setPreview(bitmap)
          })
        } finally { if (preview() !== bitmap) bitmap.close() }
      })
    })().catch(() => {}).finally(() => { if (!abort.signal.aborted) setLoading(false) })
  })
  createEffect(() => {
    const image = preview()
    const region = box()
    if (!image) return
    const context = canvas?.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)
    if (!valid()) return
    const x = Math.min(region.x, image.width - 1)
    const y = Math.min(region.y, image.height - 1)
    const width = Math.min(region.width, image.width - x)
    const height = Math.min(region.height, image.height - y)
    context.fillStyle = '#00000080'
    context.beginPath()
    context.rect(0, 0, image.width, image.height)
    context.rect(x, y, width, height)
    context.fill('evenodd')
    context.strokeStyle = '#ffffff'
    context.lineWidth = Math.max(1, image.width / 300)
    context.strokeRect(x, y, width, height)
  })
  const commit = (): void => { if (valid()) void props.commitValue(box()) }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="bounding-box-editor" data-editor-surface="popover" role="dialog" aria-label={message('boundingBoxWidget.title')}>
    <props.header type="BOUNDING_BOX" />
    <canvas ref={canvas} class="bounding-box-preview" classList={{ 'is-ready': preview() !== undefined }} role="img" aria-label={message('boundingBoxWidget.preview')} />
    <Show when={!preview()}><ProductNotice tone="info">{loading() ? message('boundingBoxWidget.loading') : message('boundingBoxWidget.sourceUnavailable')}</ProductNotice></Show>
    <For each={fields}>{(field) => {
      const id = `bounding-box-${field}`
      return <ProductField controlId={id} label={message(`boundingBoxWidget.${field}`)} layout="compact">
        <ProductTextInput id={id} aria-labelledby={productFieldIds(id).label} value={draft()[field]} inputmode="numeric" disabled={props.commitPending()}
          ref={(element) => { if (field === 'x') queueMicrotask(() => { if (element.isConnected) { element.focus(); element.select() } }) }}
          onInput={(event) => { const value = event.currentTarget.value; setDraft((previous) => ({ ...previous, [field]: value })) }} />
      </ProductField>
    }}</For>
    <Show when={!valid()}><ProductNotice tone="error">{message('boundingBoxWidget.invalid')}</ProductNotice></Show>
    <ProductActionFooter>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={!valid() || props.commitPending()} onClick={commit}>{message('boundingBoxWidget.apply')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const BoundingBoxWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={BoundingBoxImplementation} />
)
