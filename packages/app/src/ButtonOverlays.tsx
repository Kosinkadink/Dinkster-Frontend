import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import Info from 'lucide-solid/icons/info'
import TriangleAlert from 'lucide-solid/icons/triangle-alert'
import { formatWidgetValue, type AskRequest, type InputSpec, type IntegerWidgetValue, type Json, type WidgetKind, type WidgetSpec } from '@dinkster/core'
import { CanvasRowFocus, CanvasSideActions, CanvasSideRow } from '@dinkster/ui'
import { placeRow, rowPlacement, visibleCanvas, type RowBox } from './editors/row-placement.js'
import { resolveTypedNumber, stepTypedNumber } from './widget-commit.js'
import type { ButtonBox } from './button-presses.js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import { ProductActionFooter } from './ProductForm.js'

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
 * An Ask step's form: the side part of the button's row, one outline around
 * both, holding the step's rows as a node draws them, then Cancel and
 * Apply. A row opens as a row on a node opens, checks its value the same
 * way and hands the value back to the form; a number's minus and plus step
 * it and a toggle flips. A menu button has no row, so its form hangs under
 * the node where the menu's work shows.
 */
export function ButtonAskForm(props: {
  readonly request: AskRequest
  /** The button's field, or for a menu button the place under its node. */
  readonly box: RowBox
  readonly menu: boolean
  readonly viewport: () => { readonly x: number; readonly y: number; readonly scale: number }
  readonly boundary: HTMLElement
  readonly widgetKind: (type: string) => WidgetKind | undefined
  /** Opens a row's editor over `row`, the side part being `form`. */
  readonly editRow: (row: InputSpec, at: { readonly row: DOMRect; readonly form: DOMRect }, value: Json | undefined, set: (value: Json) => void) => void
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
  const kindOf = (row: InputSpec): 'number' | 'choice' | 'toggle' | 'text' => {
    const spec = row.widget
    if (spec === undefined) return 'text'
    const kind = props.widgetKind(spec.widgetType)
    if (toggles(kind, spec)) return 'toggle'
    const view = kind?.defaultView(spec)
    if (view === 'core.number' || view === 'core.slider') return 'number'
    return view === 'core.select' ? 'choice' : 'text'
  }
  const shown = (row: InputSpec): string => {
    const value = values()[row.id]
    if (value === undefined) return 'Choose...'
    return row.widget === undefined ? JSON.stringify(value) : formatWidgetValue(value, row.widget)
  }

  let form!: HTMLDivElement
  const content = (
    <div
      ref={form}
      class="button-ask-form"
      role="group"
      data-testid="button-ask-form"
      aria-label={props.request.title}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); props.onAnswer(undefined) } }}
    >
      <p class="button-ask-title">{props.request.title}</p>
      <For each={props.request.rows}>{(row) => {
        const kind = kindOf(row)
        const spec = row.widget
        const step = (direction: -1 | 1, fast: boolean): void => {
          const stored = (values()[row.id] ?? 0) as IntegerWidgetValue
          const text = stepTypedNumber(String(stored), spec!, stored, direction, fast)
          const next = resolveTypedNumber(text, spec!, stored)
          if (next.kind === 'store') set(row.id, next.value as Json)
        }
        return (
          <CanvasSideRow
            label={row.displayName ?? row.id}
            value={shown(row)}
            kind={kind}
            on={values()[row.id] === true}
            testId={`button-ask-${row.id}`}
            {...(kind === 'number' ? { onStep: step } : {})}
            onOpen={(element) => {
              if (kind === 'toggle') { set(row.id, values()[row.id] !== true); return }
              props.editRow(row, { row: element.getBoundingClientRect(), form: form.getBoundingClientRect() }, values()[row.id], (value) => set(row.id, value))
            }}
          />
        )
      }}</For>
      <Show when={missing().length > 0}><p class="button-ask-missing">{`Choose ${missing().join(', ')}.`}</p></Show>
      <CanvasSideActions actions={[
        { label: message('common.cancel'), onClick: () => props.onAnswer(undefined), testId: 'button-ask-cancel' },
        { label: message('common.apply'), onClick: apply, primary: true, disabled: missing().length > 0, testId: 'button-ask-apply' },
      ]} />
    </div>
  )

  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  const bounds = visibleCanvas(props.boundary)
  const placement = createMemo(() => rowPlacement(props.box, props.viewport(), bounds(), sideSize()))
  let frame!: HTMLDivElement
  createEffect(() => placeRow(frame, placement()))
  return (
    <div class="palette-layer widget-popover-layer button-ask-layer">
      <div ref={frame} class="widget-row-focus button-ask-frame">
        <Show
          when={!props.menu}
          fallback={
            <div class="dinkster-canvas-field" data-look={props.box.look}>
              <div class="dinkster-canvas-field-side" data-place="below-node">{content}</div>
            </div>
          }
        >
          <CanvasRowFocus
            rowWidth={placement().rowWidth}
            look={props.box.look}
            zoomed={placement().scale > 1}
            place={placement().place}
            sideTop={placement().sideTop}
            {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
            onSideSize={setSideSize}
            side={content}
          />
        </Show>
      </div>
    </div>
  )
}
