import { canvasPaintTokens } from '@dinkster/canvas'
import type { PreviewData } from '@dinkster/client'
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { drawImageCompare, frameBitmap, IMAGE_COMPARE_SIDES as sides, imageCompareFrames, type ImageCompareSide } from '../image-compare-frames.js'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice } from '../ProductForm.js'
import { ProductSelect } from '../ProductSelect.js'
import { ProductSlider } from '../ProductSlider.js'
import { useAppMessage } from '../locale.js'
import { useSignal } from '../solid-adapter.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'
import './image-compare-widget-editor.css'

const ImageCompareImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const app = props.editor.app
  const message = useAppMessage()
  const executions = useSignal(app.store.executions)
  const document = useSignal(ed.tab.store.document)
  const path = useSignal(ed.tab.instancePath)
  const stack = useSignal(ed.tab.graphStack)
  const [split, setSplit] = createSignal<number>(canvasPaintTokens.editor.imageCompare.initialSplit)
  const [selected, setSelected] = createSignal({ image_a: 0, image_b: 0 })
  const [images, setImages] = createSignal<Partial<Record<ImageCompareSide, ImageBitmap>>>({})
  let canvas!: HTMLCanvasElement
  const allFrames = createMemo(() => {
    executions(); document(); path(); stack()
    if (ed.target.kind !== 'input') return { image_a: [], image_b: [] }
    return imageCompareFrames(app, ed.tab, {
      graphId: ed.target.familyOwner?.graphId ?? ed.graphId,
      nodeId: ed.target.familyOwner?.nodeId ?? ed.target.nodeId,
      parts: ed.target.parts,
    })
  })
  const frames = (side: ImageCompareSide): readonly PreviewData[] => allFrames()[side]
  for (const side of sides) createEffect(() => {
    const available = frames(side)
    const frame = available.find((entry) => (entry.frameIndex ?? 0) === selected()[side]) ?? available[0]
    let live = true
    let bitmap: ImageBitmap | undefined
    setImages((previous) => ({ ...previous, [side]: undefined }))
    onCleanup(() => { live = false; bitmap?.close() })
    if (!frame) return
    void frameBitmap(frame).then((image) => {
      if (image === undefined) return
      if (!live) { image.close(); return }
      bitmap = image
      setImages((previous) => ({ ...previous, [side]: image }))
    })
  })
  createEffect(() => {
    if (canvas) drawImageCompare(canvas, images(), split(), {
      color: canvasPaintTokens.editor.imageCompare.dividerColor, width: canvasPaintTokens.editor.imageCompare.dividerWidth,
    })
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
