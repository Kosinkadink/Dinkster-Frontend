import { createEffect, createSignal, For, Show } from 'solid-js'
import Info from 'lucide-solid/icons/info'
import TriangleAlert from 'lucide-solid/icons/triangle-alert'
import type { AskRequest, InputSpec, Json, WidgetKind, WidgetSpec } from '@dinkster/core'
import type { ButtonBox } from './button-presses.js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import { ProductActionFooter, ProductField } from './ProductForm.js'

/** A client-space rectangle: the button's whole line, or the node beside a form. */
export interface ScreenRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Follows `place` on every camera or layout change; positions are data, not styling. */
function placed(place: () => { readonly left: number; readonly top: number; readonly width?: number }) {
  return (el: HTMLElement): void => {
    createEffect(() => {
      const at = place()
      el.style.left = `${at.left}px`
      el.style.top = `${at.top}px`
      if (at.width !== undefined) el.style.width = `${at.width}px`
    })
  }
}

/** A result, skip or reason box under a button's line, with its icon in the text. */
export function ButtonBoxView(props: { readonly box: ButtonBox; readonly under: ScreenRect; readonly testId?: string; readonly onCancel?: () => void }) {
  const message = useAppMessage()
  return (
    <div
      class="button-box"
      data-tone={props.box.tone}
      data-testid={props.testId ?? 'button-box'}
      role={props.box.tone === 'warn' ? 'alert' : 'status'}
      ref={placed(() => ({ left: props.under.x, top: props.under.y + props.under.height + 4, width: Math.max(180, props.under.width) }))}
    >
      <span class="button-box-icon" aria-hidden="true">
        <Show when={props.box.tone === 'warn'} fallback={<Info size={14} />}><TriangleAlert size={14} /></Show>
      </span>
      <span>{props.box.message}</span>
      <Show when={props.onCancel}>
        {(cancel) => <ProductButton size="compact" variant="ghost" class="button-box-cancel" onClick={() => cancel()()}>{message('common.cancel')}</ProductButton>}
      </Show>
    </div>
  )
}

/** Shows a field-built address before its tab opens. */
export function ButtonLinkConfirm(props: {
  readonly url: string
  readonly under: ScreenRect
  readonly onAnswer: (open: boolean) => void
}) {
  const message = useAppMessage()
  return (
    <div
      class="button-box button-link-confirm floating-surface"
      data-tone="info"
      data-testid="button-link-confirm"
      role="dialog"
      aria-label={message('buttonLink.label')}
      ref={placed(() => ({ left: props.under.x, top: props.under.y + props.under.height + 4, width: Math.max(240, props.under.width) }))}
    >
      <span class="button-box-icon" aria-hidden="true"><Info size={14} /></span>
      <div class="button-link-body">
        <span>{message('buttonLink.question')}</span>
        <code class="button-link-address">{props.url}</code>
        <ProductActionFooter>
          <ProductButton size="compact" onClick={() => props.onAnswer(false)}>{message('common.cancel')}</ProductButton>
          <ProductButton size="compact" variant="primary" onClick={() => props.onAnswer(true)}>{message('common.open')}</ProductButton>
        </ProductActionFooter>
      </div>
    </div>
  )
}

/** A field whose only values are true and false toggles in place, as it does on a node. */
const toggles = (kind: WidgetKind | undefined, spec: WidgetSpec): boolean =>
  kind !== undefined && kind.valueSchema.validate(true, spec) && kind.valueSchema.validate(false, spec) &&
  !kind.valueSchema.validate('', spec) && !kind.valueSchema.validate(0, spec)

/**
 * An Ask step's form: the side part beside the node, holding its rows,
 * Cancel and Apply. A row opens the field's ordinary editor, which checks
 * the value as it does on a node, and hands the value back to the form.
 */
export function ButtonAskForm(props: {
  readonly request: AskRequest
  readonly beside: ScreenRect
  readonly widgetKind: (type: string) => WidgetKind | undefined
  readonly editRow: (row: InputSpec, at: DOMRect, value: Json | undefined, set: (value: Json) => void) => void
  readonly onAnswer: (values: Readonly<Record<string, Json>> | undefined) => void
}) {
  const message = useAppMessage()
  const initial = (row: InputSpec): Json | undefined => {
    const spec = row.widget
    const value = spec?.default ?? spec?.options['default']
    return value === undefined ? undefined : value as Json
  }
  const [values, setValues] = createSignal<Readonly<Record<string, Json | undefined>>>(
    Object.fromEntries(props.request.rows.map((row) => [row.id, initial(row)])),
  )
  const set = (id: string, value: Json): void => { setValues({ ...values(), [id]: value }) }
  const missing = (): readonly string[] => props.request.rows.filter((row) => values()[row.id] === undefined).map((row) => row.displayName ?? row.id)
  const apply = (): void => {
    if (missing().length > 0) return
    props.onAnswer(values() as Readonly<Record<string, Json>>)
  }
  const shown = (value: Json | undefined): string =>
    value === undefined ? 'Choose...' : typeof value === 'string' ? value : JSON.stringify(value)

  return (
    <form
      class="button-ask-form floating-surface"
      data-testid="button-ask-form"
      aria-label={props.request.title}
      ref={placed(() => ({ left: props.beside.x + props.beside.width + 8, top: props.beside.y }))}
      onSubmit={(event) => { event.preventDefault(); apply() }}
      onKeyDown={(event) => { if (event.key === 'Escape' && event.target === event.currentTarget) { event.preventDefault(); props.onAnswer(undefined) } }}
    >
      <h3 class="button-ask-title">{props.request.title}</h3>
      <For each={props.request.rows}>{(row) => {
        const id = `button-ask-${row.id}`
        const label = row.displayName ?? row.id
        const open = (event: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
          const spec = row.widget
          if (spec !== undefined && toggles(props.widgetKind(spec.widgetType), spec)) {
            set(row.id, values()[row.id] !== true)
            return
          }
          props.editRow(row, event.currentTarget.getBoundingClientRect(), values()[row.id], (value) => set(row.id, value))
        }
        return (
          <ProductField controlId={id} label={label} layout="compact">
            <ProductButton id={id} type="button" size="compact" class="button-ask-value" data-testid={id} onClick={open}>
              {shown(values()[row.id])}
            </ProductButton>
          </ProductField>
        )
      }}</For>
      <ProductActionFooter status={<Show when={missing().length > 0}><span>{`Choose ${missing().join(', ')}.`}</span></Show>}>
        <ProductButton size="compact" type="button" data-testid="button-ask-cancel" onClick={() => props.onAnswer(undefined)}>{message('common.cancel')}</ProductButton>
        <ProductButton size="compact" type="submit" variant="primary" data-testid="button-ask-apply" disabled={missing().length > 0}>{message('common.apply')}</ProductButton>
      </ProductActionFooter>
    </form>
  )
}
