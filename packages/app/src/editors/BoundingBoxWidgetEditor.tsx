import { boundingBoxKind, type BoundingBox } from '@dinkster/widgets'
import { createSignal, For, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const fields = ['x', 'y', 'width', 'height'] as const

const BoundingBoxImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const message = useAppMessage()
  const initial = boundingBoxKind.valueSchema.validate(ed.initial) ? ed.initial : boundingBoxKind.defaultValue(ed.spec!)
  const [draft, setDraft] = createSignal<Record<keyof BoundingBox, string>>({
    x: String(initial.x), y: String(initial.y), width: String(initial.width), height: String(initial.height),
  })
  const box = (): BoundingBox => ({ x: Number(draft().x), y: Number(draft().y), width: Number(draft().width), height: Number(draft().height) })
  const valid = () => fields.every((field) => draft()[field].trim() !== '') && boundingBoxKind.validate(box(), ed.spec!).length === 0
  const commit = (): void => { if (valid()) void props.commitValue(box()) }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => { props.editor.bindClickAway?.(undefined) })

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover" data-testid="bounding-box-editor" data-editor-surface="popover" role="dialog" aria-label={message('boundingBoxWidget.title')}>
    <props.header type="BOUNDING_BOX" />
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
