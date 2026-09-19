import { colorKind, hexToHsv, hsvToHex } from '@dinkster/widgets'
import { Check, X } from 'lucide-solid'
import { createSignal, onCleanup, type Component } from 'solid-js'
import { Icon } from '../Icon.js'
import { ProductActionFooter, ProductField, productFieldIds } from '../ProductForm.js'
import {
  WidgetEditorController,
  type WidgetEditorImplementationProps,
  type WidgetEditorProps,
} from '../WidgetEditorController.js'

const ColorImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const ed = props.editor.ed
  const initial = typeof ed.initial === 'string'
    ? ed.initial
    : typeof ed.spec?.default === 'string'
      ? ed.spec.default
      : '#ffffff'
  const [text, setText] = createSignal(initial)
  const [hue, setHue] = createSignal(hexToHsv(initial)?.h ?? 0)
  const [error, setError] = createSignal<string | undefined>()
  const fieldIds = productFieldIds('color-editor-value')

  const commit = (): void => {
    if (ed.spec === undefined) return
    const diagnostics = colorKind.validate(text(), ed.spec)
    if (diagnostics.length > 0) {
      setError(diagnostics[0]!.message)
      return
    }
    props.commitValue(text())
  }
  const pick = (h: number, s: number, v: number): void => {
    setHue(h)
    setText(hsvToHex(h, s, v, text()))
    setError(undefined)
  }
  const pickSaturationValue = (event: PointerEvent): void => {
    const el = event.currentTarget as HTMLElement
    if (event.type === 'pointerdown') el.setPointerCapture(event.pointerId)
    if (event.type !== 'pointerdown' && !el.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    const rect = el.getBoundingClientRect()
    pick(hue(), Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height)))
  }
  const pickHue = (event: PointerEvent): void => {
    const el = event.currentTarget as HTMLElement
    if (event.type === 'pointerdown') el.setPointerCapture(event.pointerId)
    if (event.type !== 'pointerdown' && !el.hasPointerCapture(event.pointerId)) return
    event.preventDefault()
    const rect = el.getBoundingClientRect()
    const hsv = hexToHsv(text()) ?? { h: hue(), s: 0, v: 1 }
    pick(Math.max(0, Math.min(359.999, ((event.clientX - rect.left) / rect.width) * 360)), hsv.s, hsv.v)
  }
  const clickAway = (): void => {
    const value = text()
    if (value === String(ed.initial ?? '') || ed.spec === undefined || colorKind.validate(value, ed.spec).length > 0) {
      props.close()
      return
    }
    props.commitValue(value)
  }
  props.editor.bindClickAway?.(clickAway)
  onCleanup(() => props.editor.bindClickAway?.(undefined))

  return <div ref={props.bindPopover} class="widget-editor floating-surface widget-editor-popover color-editor" data-testid="color-editor" data-editor-surface="popover" role="dialog" aria-label={`Edit ${ed.label} COLOR`} style={props.popoverStyle}>
    <props.header type="COLOR" />
    <div class="color-saturation-value" data-testid="color-saturation-value" data-editor-interactive style={{ 'background-color': `hsl(${hue()} 100% 50%)` }} onPointerDown={pickSaturationValue} onPointerMove={pickSaturationValue} />
    <div class="color-hue" data-testid="color-hue" data-editor-interactive onPointerDown={pickHue} onPointerMove={pickHue} />
    <ProductField controlId="color-editor-value" label="Color value" layout="compact" class="color-value-field" message={error()} messageTestId="color-error" invalid={error() !== undefined}>
      <input id="color-editor-value" data-testid="color-text" aria-labelledby={fieldIds.label} aria-describedby={error() === undefined ? undefined : fieldIds.message} aria-invalid={error() === undefined ? undefined : 'true'} value={text()} ref={(el) => queueMicrotask(() => { el.focus(); el.select() })} onInput={(event) => { setText(event.currentTarget.value); setError(undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') { if (event.isComposing) return; event.preventDefault(); commit() } }} />
    </ProductField>
    <ProductActionFooter class="color-editor-footer">
      <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={props.close}><Icon icon={X} /> Cancel</button>
      <button type="button" class="primary" onPointerDown={(event) => event.preventDefault()} onClick={commit}><Icon icon={Check} /> Commit</button>
    </ProductActionFooter>
  </div>
}

export const ColorWidgetEditor: Component<WidgetEditorProps> = (props) => (
  <WidgetEditorController {...props} implementation={ColorImplementation} />
)
