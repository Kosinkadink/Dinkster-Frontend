import { For, Show, createSignal, type JSX } from 'solid-js'
import {
  Camera,
  Circle,
  Play,
  RotateCcw,
  Square,
  Trash2,
  type LucideIcon,
} from 'lucide-solid'
import { CanvasClosedRow, CanvasRowField, CanvasSidePart } from './canvas-field.js'
import { CanvasRowList } from './canvas-list.js'
import { ProductButton, ProductIcon, ProductIconButton, ProductSpinner } from './controls.js'

/**
 * The controls of an editor shown in the node, laid over the space the
 * canvas leaves for it under its editor button row. Everything here is drawn
 * at the canvas's normal size; the host places it on the space and scales it
 * with the canvas. The text comes from the caller.
 */
export function CanvasEditorSpace(props: {
  ref?: (element: HTMLDivElement) => void
  /** The editor's state, for the look of what it holds (for example dimmed rows). */
  state?: string
  children: JSX.Element
}) {
  return (
    <div class="dinkster-canvas-editor" data-state={props.state} ref={(element) => props.ref?.(element)}>
      {props.children}
    </div>
  )
}

/**
 * The picture area of an editor. Its content is the caller's (a still, a live
 * view, a drawing); `message` covers it in a few words when there is nothing
 * to show, with a spinner while something loads. The bar on its bottom edge
 * is dragged to change its height.
 */
export function CanvasEditorPicture(props: {
  ref?: (element: HTMLDivElement) => void
  message?: string
  loading?: boolean
  /** Controls drawn on the picture, at its top right. */
  actions?: JSX.Element
  onResizeStart?: (event: PointerEvent) => void
  resizeLabel?: string
  children?: JSX.Element
}) {
  return (
    <div class="dinkster-canvas-editor-picture" ref={(element) => props.ref?.(element)}>
      {props.children}
      <Show when={props.message !== undefined || props.loading}>
        <div class="dinkster-canvas-editor-picture-message" role="status">
          <Show when={props.loading}>
            <ProductSpinner />
          </Show>
          <span>{props.message}</span>
        </div>
      </Show>
      <Show when={props.actions}>
        <div class="dinkster-canvas-editor-picture-actions">{props.actions}</div>
      </Show>
      <div
        class="dinkster-canvas-editor-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={props.resizeLabel}
        onPointerDown={(event) => props.onResizeStart?.(event)}
      />
    </div>
  )
}

/** One line of an editor's own controls, as tall as a canvas row. */
export function CanvasEditorLine(props: { dimmed?: boolean; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-line" data-dimmed={props.dimmed === true ? 'true' : undefined}>
      {props.children}
    </div>
  )
}

/** A line naming what the editor stores, or a message about it; `tone` colors a problem. */
export function CanvasEditorNote(props: { tone?: 'problem' | 'muted' | undefined; wrap?: boolean; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-note" data-tone={props.tone} data-wrap={props.wrap === true ? 'true' : undefined}>
      {props.children}
    </div>
  )
}

/** A closed or open section of an editor's own rows, its header drawn as the node draws a section's header. */
export function CanvasEditorSection(props: {
  label: string
  open: boolean
  onToggle?: (open: boolean) => void
  children?: JSX.Element
}) {
  return (
    <details
      class="dinkster-canvas-editor-section"
      open={props.open}
      onToggle={(event) => {
        const open = event.currentTarget.open
        if (open !== props.open) props.onToggle?.(open)
      }}
    >
      <summary>
        <svg class="dinkster-canvas-editor-section-arrow" viewBox="0 0 4 6" aria-hidden="true">
          <path d="M0 0L4 3L0 6Z" />
        </svg>
        {props.label}
      </summary>
      <div class="dinkster-canvas-editor-section-rows">{props.children}</div>
    </details>
  )
}

/** The action icons the brief names, so every editor uses the same ones. */
export const canvasEditorIcons = {
  record: Circle,
  stop: Square,
  play: Play,
  remove: Trash2,
  capture: Camera,
  retry: RotateCcw,
} as const satisfies Record<string, LucideIcon>

/**
 * The recorder's strip: the round button (Record, or Stop while recording),
 * the status over the time, the waveform and the action icons at the right.
 */
export function CanvasRecorderStrip(props: {
  recording: boolean
  /** The round button's label: Record or Stop. */
  roundLabel: string
  roundDisabled?: boolean
  onRound?: () => void
  status: string
  /** The time and rounded size, such as "0:07, 47 KB". */
  detail?: string
  /** Samples from -1 to 1; empty draws a flat line. */
  waveform: readonly number[]
  actions?: readonly { label: string; icon: LucideIcon; intent?: 'remove'; disabled?: boolean; onClick?: () => void }[]
}) {
  const points = () => {
    const samples = props.waveform.length > 1 ? props.waveform : [0, 0]
    return samples.map((value, index) => `${(index / (samples.length - 1)) * 100},${50 - Math.max(-1, Math.min(1, value)) * 45}`).join(' ')
  }
  return (
    <div class="dinkster-canvas-recorder" data-recording={props.recording ? 'true' : 'false'}>
      <ProductIconButton
        label={props.roundLabel}
        icon={props.recording ? canvasEditorIcons.stop : canvasEditorIcons.record}
        intent={props.recording ? 'remove' : 'add'}
        disabled={props.roundDisabled === true}
        onClick={() => props.onRound?.()}
      />
      <div class="dinkster-canvas-recorder-status">
        <span>{props.status}</span>
        <Show when={props.detail}>
          <span class="dinkster-canvas-recorder-detail">{props.detail}</span>
        </Show>
      </div>
      <svg class="dinkster-canvas-recorder-wave" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points()} />
      </svg>
      <For each={props.actions ?? []}>
        {(action) => (
          <ProductIconButton
            label={action.label}
            icon={action.icon}
            {...(action.intent === 'remove' ? { intent: 'remove' as const } : {})}
            disabled={action.disabled === true}
            onClick={() => action.onClick?.()}
          />
        )}
      </For>
    </div>
  )
}

/** A row of an editor's buttons, each with its icon and label; `iconOnly` names the button only for assistive technology. */
export function CanvasEditorButtons(props: {
  buttons: readonly { label: string; icon?: LucideIcon; iconOnly?: boolean; intent?: 'add' | 'remove'; disabled?: boolean; pending?: boolean; onClick?: () => void }[]
}) {
  return (
    <div class="dinkster-canvas-editor-buttons">
      <For each={props.buttons}>
        {(button) => button.iconOnly === true && button.icon !== undefined ? (
          <ProductIconButton
            label={button.label}
            icon={button.icon}
            {...(button.intent === 'remove' ? { intent: 'remove' as const } : {})}
            disabled={button.disabled === true}
            onClick={() => button.onClick?.()}
          />
        ) : (
          <ProductButton
            {...(button.intent === undefined ? {} : { intent: button.intent })}
            disabled={button.disabled === true}
            pending={button.pending === true}
            onClick={() => button.onClick?.()}
          >
            <Show when={button.icon}>{(icon) => <ProductIcon icon={icon()} />}</Show>
            {button.label}
          </ProductButton>
        )}
      </For>
    </div>
  )
}

/**
 * A number of an editor's own, drawn as the node's number row is: the minus,
 * the name, the value and the plus. The steppers step it; pressing the row
 * opens it in place as the node's row opens, typed in with the same keys:
 * Enter stores, Escape leaves, the arrow keys step and Shift steps ten
 * times. A typed value is kept within the row's limits.
 */
export function CanvasEditorNumber(props: {
  label: string
  /** No value shows no number; the steppers then do nothing. */
  value: number | undefined
  min?: number
  max?: number
  step?: number
  /** Digits after the point the value shows. */
  precision?: number
  onChange?: (value: number) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal('')
  const [width, setWidth] = createSignal(0)
  let slot!: HTMLDivElement
  const format = (value: number | undefined) => value === undefined ? '' : value.toFixed(props.precision ?? 0)
  const clamp = (value: number) => Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, value))
  const store = (value: number) => {
    if (Number.isFinite(value)) props.onChange?.(clamp(value))
  }
  const stepped = (from: number, direction: -1 | 1, fast: boolean) =>
    clamp(from + direction * (props.step ?? 1) * (fast ? 10 : 1))
  const step = (direction: -1 | 1, fast: boolean) => {
    if (props.value !== undefined) store(stepped(props.value, direction, fast))
  }
  // While open, a step changes the typed text; Enter or leaving stores it.
  const stepText = (direction: -1 | 1, fast: boolean) => {
    const next = stepped(Number(text()), direction, fast)
    if (Number.isFinite(next)) setText(format(next))
  }
  const begin = () => {
    // The open field is the row's field grown by one pixel on every side.
    setWidth(slot.offsetWidth + 2)
    setText(format(props.value))
    setOpen(true)
  }
  return (
    <div class="dinkster-canvas-editor-field-slot" ref={slot}
      onFocusOut={(event) => {
        if (open() && !slot.contains(event.relatedTarget as Node | null)) { store(Number(text())); setOpen(false) }
      }}>
      <CanvasClosedRow label={props.label} value={format(props.value)} onOpen={begin} onStep={step} />
      <Show when={open()}>
        <CanvasRowField
          look="flat-title"
          rowWidth={width()}
          place="right"
          label={props.label}
          value={text()}
          inputLabel={props.label}
          onInput={setText}
          onStep={stepText}
          inputRef={(element) => queueMicrotask(() => { element.focus(); element.select() })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { store(Number(text())); setOpen(false) }
            else if (event.key === 'Escape') setOpen(false)
            else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              stepText(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)
            }
          }}
        />
      </Show>
    </div>
  )
}

/**
 * A choice of an editor's own, drawn as the node's choice row is: the name,
 * the chosen entry and the chevron. Pressing the row opens it in place as
 * the node's choice row opens: the value becomes a filter and the entries
 * hang under the row at its width, inside one outline.
 */
export function CanvasEditorChoice(props: {
  label: string
  value: string
  options: readonly string[]
  onChange?: (value: string) => void
  /** Called as the list opens, so a host can refresh the entries it lists. */
  onOpen?: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal(0)
  const [width, setWidth] = createSignal(0)
  let slot!: HTMLDivElement
  const shown = () => props.options.filter((option) => option.toLowerCase().includes(query().toLowerCase()))
  const pick = (index: number) => {
    const chosen = shown()[index]
    if (chosen !== undefined) props.onChange?.(chosen)
    setOpen(false)
  }
  const begin = () => {
    setWidth(slot.offsetWidth + 2)
    setQuery('')
    setHighlight(Math.max(0, props.options.indexOf(props.value)))
    setOpen(true)
    props.onOpen?.()
  }
  return (
    <div class="dinkster-canvas-editor-field-slot" ref={slot}
      onFocusOut={(event) => {
        if (open() && !slot.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}>
      <CanvasClosedRow label={props.label} value={props.value} onOpen={begin} choice />
      <Show when={open()}>
        <CanvasRowList
          look="flat-title"
          rowWidth={width()}
          place="right"
          label={props.label}
          query={query()}
          onQuery={(text) => { setQuery(text); setHighlight(0) }}
          inputLabel={props.label}
          placeholder={props.value}
          inputRef={(element) => queueMicrotask(() => element.focus())}
          options={shown().map((option) => ({ key: option, label: option, ...(option === props.value ? { saved: true } : {}) }))}
          highlight={highlight()}
          onHighlight={setHighlight}
          onPick={pick}
          onKeyDown={(event) => {
            if (event.key === 'Enter') pick(highlight())
            else if (event.key === 'Escape') setOpen(false)
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const count = shown().length
              if (count > 0) setHighlight((highlight() + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
            }
          }}
        />
      </Show>
    </div>
  )
}

/**
 * A few numbers of an editor's own kept as one value, such as a position X
 * Y Z, drawn as one row with the numbers separated by commas. Pressing it
 * opens it in place as the node's open line field: Enter stores the numbers
 * at once, Escape leaves. A text that is not exactly `count` numbers is
 * refused in place, saying so, and nothing is stored.
 */
export function CanvasEditorNumbers(props: {
  label: string
  value: readonly number[]
  count: number
  onChange?: (value: readonly number[]) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal('')
  const [problem, setProblem] = createSignal<string>()
  const [width, setWidth] = createSignal(0)
  let slot!: HTMLDivElement
  const shown = () => props.value.join(', ')
  const parse = (typed: string): readonly number[] | undefined => {
    const parts = typed.split(',').map((part) => part.trim())
    const numbers = parts.map(Number)
    return parts.length === props.count && parts.every((part) => part !== '') && numbers.every(Number.isFinite)
      ? numbers : undefined
  }
  const begin = () => {
    setWidth(slot.offsetWidth + 2)
    setText(shown())
    setProblem(undefined)
    setOpen(true)
  }
  const commit = () => {
    const numbers = parse(text())
    if (numbers === undefined) {
      setProblem(`Type ${props.count} numbers separated by commas`)
      return
    }
    props.onChange?.(numbers)
    setOpen(false)
  }
  return (
    <div class="dinkster-canvas-editor-field-slot" ref={slot}
      onFocusOut={(event) => {
        if (open() && !slot.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}>
      <CanvasClosedRow label={props.label} value={shown()} onOpen={begin} />
      <Show when={open()}>
        <CanvasRowField
          look="flat-title"
          rowWidth={width()}
          place="below-field"
          label={props.label}
          value={text()}
          inputLabel={props.label}
          onInput={(typed) => { setText(typed); setProblem(undefined) }}
          inputRef={(element) => queueMicrotask(() => { element.focus(); element.select() })}
          {...(problem() !== undefined ? { side: <CanvasSidePart problem={problem()!} /> } : {})}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') setOpen(false)
          }}
        />
      </Show>
    </div>
  )
}

/** A name and its value on one editor line, such as "Image A frame: 3". */
export function CanvasEditorFact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-fact">
      <span class="dinkster-canvas-editor-fact-label">{props.label}</span>
      <span class="dinkster-canvas-editor-fact-value">{props.children}</span>
    </div>
  )
}
