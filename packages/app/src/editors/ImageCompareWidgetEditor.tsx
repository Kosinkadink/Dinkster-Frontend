import type { PreviewData } from '@dinkster/client'
import { occurrencesForView } from '@dinkster/core'
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { viewInstancePath } from '../app-state.js'
import { liveExactnessFor } from '../companion-display.js'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { ProductSlider } from '../ProductSlider.js'
import { useAppMessage } from '../locale.js'
import { useSignal } from '../solid-adapter.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './image-compare-widget-editor.css'

const sides = ['image_a', 'image_b'] as const

const ImageCompareImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const app = props.editor.app
  const message = useAppMessage()
  const executions = useSignal(app.store.executions)
  const document = useSignal(ed.tab.store.document)
  const path = useSignal(ed.tab.instancePath)
  const stack = useSignal(ed.tab.graphStack)
  const [split, setSplit] = createSignal(50)
  const [selected, setSelected] = createSignal({ image_a: 0, image_b: 0 })
  const [images, setImages] = createSignal<Partial<Record<typeof sides[number], ImageBitmap>>>({})
  let canvas!: HTMLCanvasElement
  const source = createMemo(() => {
    executions(); document(); path(); stack()
    if (ed.target.kind !== 'input') return undefined
    const execution = app.executionForTab(ed.tab)
    const compiled = app.compileTabCached(ed.tab)
    const backend = app.backendForTab(ed.tab)
    const graphId = ed.target.familyOwner?.graphId ?? ed.graphId
    const nodeId = ed.target.familyOwner?.nodeId ?? ed.target.nodeId
    const depth = stack().lastIndexOf(graphId)
    const navigation = viewInstancePath(ed.tab)
    if (!execution?.artifact || !compiled?.ok || !navigation || depth < 0
      || execution.ref.connection !== backend.id || compiled.artifact.connection !== backend.id
      || execution.artifact.snapshot.lineage !== document().lineage) return undefined
    const ids = occurrencesForView({ instancePath: navigation.slice(0, depth),
      runtimeIds: new Set([...Object.keys(execution.nodes), ...Object.keys(execution.previews)]),
      toSource: execution.artifact.provenance.toSource }).own.get(nodeId) ?? []
    const runtimeId = ids.length === 1 ? ids[0] : undefined
    if (!runtimeId || liveExactnessFor(compiled.artifact, execution.artifact)?.(runtimeId) !== true) return undefined
    return { execution, runtimeId }
  })
  const frames = (side: typeof sides[number]): readonly PreviewData[] => {
    const current = source()
    if (!current) return []
    const ring = current.execution.previewRings?.[current.runtimeId]?.[side]
    const still = current.execution.previews[current.runtimeId]?.[side]
    return ring ? Object.entries(ring.frames).sort(([a], [b]) => Number(a) - Number(b)).map(([, frame]) => frame)
      : still ? [still] : []
  }
  for (const side of sides) createEffect(() => {
    const available = frames(side)
    const frame = available.find((entry) => (entry.frameIndex ?? 0) === selected()[side]) ?? available[0]
    let live = true
    let bitmap: ImageBitmap | undefined
    setImages((previous) => ({ ...previous, [side]: undefined }))
    onCleanup(() => { live = false; bitmap?.close() })
    if (!frame || !(frame.payload instanceof Blob || frame.payload instanceof ArrayBuffer)) return
    const blob = frame.payload instanceof Blob ? frame.payload : new Blob([frame.payload])
    if (blob.size > 64 * 1024 * 1024) return
    void createImageBitmap(blob).then((image) => {
      if (!live) { image.close(); return }
      bitmap = image
      setImages((previous) => ({ ...previous, [side]: image }))
    }).catch(() => {})
  })
  createEffect(() => {
    const loaded = images()
    const divider = split()
    const context = canvas?.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    const draw = (image: ImageBitmap): void => {
      const scale = Math.min(canvas.width / image.width, canvas.height / image.height)
      const width = image.width * scale; const height = image.height * scale
      context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
    }
    if (loaded.image_b) draw(loaded.image_b)
    if (loaded.image_a) {
      context.save()
      if (loaded.image_b) { context.beginPath(); context.rect(0, 0, canvas.width * divider / 100, canvas.height); context.clip() }
      draw(loaded.image_a)
      context.restore()
    }
    if (loaded.image_a && loaded.image_b) {
      context.fillStyle = '#ffffff'
      context.fillRect(canvas.width * divider / 100, 0, 2, canvas.height)
    }
  })
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })
  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover image-compare-editor" data-testid="image-compare-editor" role="dialog" aria-label={message('imageCompareWidget.title')}>
    <props.header type="IMAGECOMPARE" />
    <canvas ref={canvas} width={640} height={360} class="image-compare-preview" classList={{ 'is-ready': Boolean(images().image_a || images().image_b) }} role="img" aria-label={message('imageCompareWidget.preview')} />
    <Show when={!images().image_a && !images().image_b}><ProductNotice tone="info">{message('imageCompareWidget.empty')}</ProductNotice></Show>
    <ProductField controlId="image-compare-divider" label={message('imageCompareWidget.divider')} layout="stack">
      <ProductSlider value={split()} min={0} max={100} ariaLabel={message('imageCompareWidget.divider')}
        disabled={!images().image_a || !images().image_b} onInput={setSplit} />
    </ProductField>
    <For each={sides}>{(side) => <ProductField controlId={`image-compare-${side}`} label={message(`imageCompareWidget.${side}`)} layout="compact">
      <ProductSelect id={`image-compare-${side}`} ariaLabel={message(`imageCompareWidget.${side}`)}
        selectedId={frames(side).length === 0 ? message('imageCompareWidget.noFrames') : String(frames(side).some((frame) => (frame.frameIndex ?? 0) === selected()[side]) ? selected()[side] : frames(side)[0]?.frameIndex ?? 0)}
        disabled={frames(side).length === 0} options={frames(side).map((frame) => ({
          id: String(frame.frameIndex ?? 0), value: frame.frameIndex ?? 0,
          label: message('imageCompareWidget.frame', { index: (frame.frameIndex ?? 0) + 1, count: frame.frameCount ?? 1 }),
        }))} onSelect={(option) => setSelected((previous) => ({ ...previous, [side]: option.value }))} />
    </ProductField>}</For>
    <ProductActionFooter><ProductButton type="button" onClick={props.close}>{message('common.close')}</ProductButton></ProductActionFooter>
  </div>
}

export const ImageCompareWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={ImageCompareImplementation} />
)
