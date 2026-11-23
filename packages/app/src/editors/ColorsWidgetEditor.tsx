import { colorsKind, hexToHsv, hsvToHex } from '@dinkster/widgets'
import { createSignal, Index, Show, type Component } from 'solid-js'
import { ProductButton, ProductColorInput, ProductTextInput } from '../ProductControls.js'
import { ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
import { useAppMessage } from '../locale.js'
import { WidgetEditorController, type WidgetEditorImplementationProps, type WidgetEditorProps } from '../WidgetEditorController.js'

const ColorsImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const message = useAppMessage()
  const initial = colorsKind.valueSchema.validate(ed.initial) ? ed.initial : colorsKind.defaultValue(ed.spec!)
  const [draft, setDraft] = createSignal([...initial])
  const valid = () => draft().every((color) => hexToHsv(color) !== undefined)
  const update = (index: number, color: string): void => {
    setDraft((values) => values.map((value, i) => i === index ? color : value))
  }
  const move = (index: number, direction: -1 | 1): void => {
    const next = [...draft()]
    const destination = index + direction
    if (destination < 0 || destination >= next.length) return
    ;[next[index], next[destination]] = [next[destination]!, next[index]!]
    setDraft(next)
  }
  props.bindFrame({
    phase: () => !valid() ? 'invalid'
      : draft().length === initial.length && draft().every((color, i) => color === initial[i]) ? 'unchanged' : 'changed',
    apply: () => props.commitValue([...draft()]),
  })

  return <div class="widget-frame-body" data-testid="colors-editor" data-editor-surface="frame">
    <div class="dinkster-editor-frame-toolbar">
      <ProductButton type="button" disabled={draft().length >= 16} onClick={() => setDraft((values) => [...values, '#ffffff'])}>{message('colorsWidget.add')}</ProductButton>
    </div>
    <div class="widget-frame-scroll colors-editor-list">
      <Index each={draft()}>{(color, index) => {
        const id = `palette-color-${index}`
        const ids = productFieldIds(id)
        const pickerValue = () => {
          const hsv = hexToHsv(color())
          return hsv === undefined ? '#000000' : hsvToHex(hsv.h, hsv.s, hsv.v).slice(0, 7)
        }
        return <ProductField controlId={id} label={message('colorsWidget.color', { index: index + 1 })} layout="stack">
          <div class="colors-editor-controls">
            <ProductColorInput aria-label={message('colorsWidget.pick', { index: index + 1 })} value={pickerValue()}
              onInput={(event) => update(index, event.currentTarget.value + (/^#[0-9a-f]{8}$/i.test(color()) ? color().slice(7) : ''))} />
            <ProductTextInput id={id} aria-labelledby={ids.label} value={color()} invalid={hexToHsv(color()) === undefined}
              onInput={(event) => update(index, event.currentTarget.value)} />
            <ProductButton type="button" size="compact" disabled={index === 0} aria-label={message('colorsWidget.earlier', { index: index + 1 })} onClick={() => move(index, -1)}>{message('colorsWidget.up')}</ProductButton>
            <ProductButton type="button" size="compact" disabled={index === draft().length - 1} aria-label={message('colorsWidget.later', { index: index + 1 })} onClick={() => move(index, 1)}>{message('colorsWidget.down')}</ProductButton>
            <ProductButton type="button" size="compact" aria-label={message('colorsWidget.remove', { index: index + 1 })} onClick={() => setDraft((values) => values.filter((_, i) => i !== index))}>{message('colorsWidget.removeAction')}</ProductButton>
          </div>
        </ProductField>
      }}</Index>
      <Show when={draft().length === 0}><ProductNotice tone="info">{message('colorsWidget.empty')}</ProductNotice></Show>
      <Show when={!valid()}><ProductNotice tone="error">{message('colorsWidget.invalid')}</ProductNotice></Show>
    </div>
  </div>
}

export const ColorsWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={ColorsImplementation}
    modal={{ type: 'COLORS' }} />
)
