import { colorsKind, hexToHsv, hsvToHex } from '@dinkster/widgets'
import { createSignal, Index, onCleanup, Show, type Component } from 'solid-js'
import { ProductButton, ProductColorInput, ProductTextInput } from '../ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../ProductForm.js'
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
  const commit = (): void => {
    if (!valid()) return
    if (draft().length === initial.length && draft().every((color, i) => color === initial[i])) props.close()
    else props.commitValue([...draft()])
  }
  props.editor.bindClickAway?.(props.close)
  onCleanup(() => props.editor.bindClickAway?.(undefined))

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover colors-editor" data-testid="colors-editor" data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} COLORS`}>
    <props.header type="COLORS" />
    <div class="colors-editor-list">
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
    </div>
    <Show when={!valid()}><ProductNotice tone="error">{message('colorsWidget.invalid')}</ProductNotice></Show>
    <ProductActionFooter>
      <ProductButton type="button" disabled={draft().length >= 16} onClick={() => setDraft((values) => [...values, '#ffffff'])}>{message('colorsWidget.add')}</ProductButton>
      <ProductButton type="button" onClick={props.close}>{message('common.cancel')}</ProductButton>
      <ProductButton type="button" variant="primary" disabled={!valid()} onClick={commit}>{message('colorsWidget.commit')}</ProductButton>
    </ProductActionFooter>
  </div>
}

export const ColorsWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={ColorsImplementation} />
)
