import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount, untrack, type JSX } from 'solid-js'
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
        tabindex={0}
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

/** A curve's point: where it sits along the input and the value it gives there, each from 0 to 1. */
export interface CanvasCurvePoint {
  readonly position: number
  readonly value: number
}

/** A strip's two colors, the low end first. */
export type CanvasCurveStrip = readonly [string, string]

/** How near a point, in pixels, the pointer must be to take it. */
const CURVE_POINT_REACH = 8

/**
 * A curve drawn large inside its plot. The border is where a point may go,
 * grid lines in quarters run from border to border, a dashed line shows the
 * curve that changes nothing, and a histogram sits behind the grid. A strip
 * runs under the plot along the input and at its left along the output.
 * Inside the plot and off a point, a dashed point shows where a double-click
 * adds one, with its position and value.
 *
 * The points are the caller's: pressing a point selects it and dragging
 * moves it between its neighbours, a double-click adds a point, and Delete
 * or Backspace removes the selected one. The line is drawn from `sample`, the
 * curve's own interpolation, which holds the end points' values beyond them.
 */
export function CanvasCurvePlot(props: {
  points: readonly CanvasCurvePoint[]
  sample: (position: number) => number
  selected?: number | undefined
  /** Bar heights from 0 to 1, from the low end of the input. */
  histogram?: readonly number[] | undefined
  inputStrip?: CanvasCurveStrip | undefined
  outputStrip?: CanvasCurveStrip | undefined
  /** Where the pointer starts, for a still picture. */
  hover?: CanvasCurvePoint
  label?: string
  /** The product's tooltip on the plot. */
  tooltip?: string
  onSelect?: (index: number | undefined) => void
  /** A point dragged to a new place; `onMoveEnd` follows when the drag ends. */
  onMove?: (index: number, point: CanvasCurvePoint) => void
  onMoveEnd?: () => void
  onAdd?: (point: CanvasCurvePoint) => void
  onDelete?: (index: number) => void
}) {
  const id = createUniqueId()
  // The plot and its strips sit at one margin on every side; the border sits
  // on the half pixel so it stays one pixel wide.
  const [size, setSize] = createSignal({ width: 320, height: 180 })
  let svgElement: SVGSVGElement | undefined
  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (svgElement) setSize({ width: svgElement.clientWidth, height: svgElement.clientHeight })
    })
    observer.observe(svgElement!)
    onCleanup(() => observer.disconnect())
  })
  const edge = 8.5
  const stripRoom = 9
  const left = () => edge + (props.outputStrip ? stripRoom : 0)
  const right = () => size().width - edge
  const top = edge
  const bottom = () => size().height - edge - (props.inputStrip ? stripRoom : 0)
  const x = (position: number) => left() + position * (right() - left())
  const y = (value: number) => bottom() - value * (bottom() - top)
  const curveRuns = () => {
    const first = props.points[0]
    const last = props.points.at(-1)
    if (first === undefined || last === undefined) return []
    const run = (from: number, to: number, held: boolean) => {
      const samples = Math.max(2, Math.ceil((x(to) - x(from)) / 2))
      const points = Array.from({ length: samples + 1 }, (_, index) => {
        const position = from + (to - from) * index / samples
        return `${x(position)},${y(Math.max(0, Math.min(1, props.sample(position))))}`
      }).join(' ')
      return { held, points }
    }
    return [
      ...(first.position > 0 ? [run(0, first.position, true)] : []),
      run(first.position, last.position, false),
      ...(last.position < 1 ? [run(last.position, 1, true)] : []),
    ]
  }
  const [hover, setHover] = createSignal(untrack(() => props.hover))
  let drag: { readonly pointerId: number; readonly index: number } | undefined
  const local = (event: MouseEvent) => {
    const matrix = svgElement?.getScreenCTM()
    if (!matrix) return undefined
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
  }
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const plotPoint = (at: DOMPoint): CanvasCurvePoint => ({
    position: (at.x - left()) / (right() - left()),
    value: (bottom() - at.y) / (bottom() - top),
  })
  // The scale the plot is drawn at on screen, so a point is as easy to take at every zoom.
  const reach = () => CURVE_POINT_REACH / (svgElement?.getScreenCTM()?.a ?? 1)
  const pointAt = (at: DOMPoint): number | undefined => {
    let nearest: number | undefined
    let distance = reach()
    props.points.forEach((point, index) => {
      const away = Math.hypot(x(point.position) - at.x, y(point.value) - at.y)
      if (away <= distance) {
        nearest = index
        distance = away
      }
    })
    return nearest
  }
  const track = (event: PointerEvent) => {
    const at = local(event)
    if (!at) return
    if (drag !== undefined && drag.pointerId === event.pointerId) {
      const point = plotPoint(at)
      const before = props.points[drag.index - 1]?.position
      const after = props.points[drag.index + 1]?.position
      // A point stays between its neighbours, so the points keep their order.
      const gap = 1e-3
      const position = Math.max(before === undefined ? 0 : before + gap, Math.min(after === undefined ? 1 : after - gap, point.position))
      props.onMove?.(drag.index, { position, value: clamp(point.value) })
      setHover(undefined)
      return
    }
    const point = plotPoint(at)
    const inside = point.position >= 0 && point.position <= 1 && point.value >= 0 && point.value <= 1
    setHover(inside && pointAt(at) === undefined ? point : undefined)
  }
  const press = (event: PointerEvent) => {
    if (event.button !== 0) return
    svgElement?.focus({ preventScroll: true })
    const at = local(event)
    if (!at) return
    const index = pointAt(at)
    props.onSelect?.(index)
    if (index === undefined || props.onMove === undefined) return
    drag = { pointerId: event.pointerId, index }
    svgElement?.setPointerCapture(event.pointerId)
  }
  const release = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return
    drag = undefined
    props.onMoveEnd?.()
  }
  const add = (event: MouseEvent) => {
    const at = local(event)
    if (!at || pointAt(at) !== undefined) return
    const point = plotPoint(at)
    if (point.position < 0 || point.position > 1 || point.value < 0 || point.value > 1) return
    // The new point is under the pointer, where no dashed point shows.
    setHover(undefined)
    props.onAdd?.(point)
  }
  const key = (event: KeyboardEvent) => {
    const index = props.selected
    if ((event.key !== 'Delete' && event.key !== 'Backspace') || index === undefined || props.onDelete === undefined) return
    // The key is the curve's: the canvas behind it must not also delete the node.
    event.preventDefault()
    event.stopPropagation()
    props.onDelete(index)
  }
  const label = (h: CanvasCurvePoint) => `${h.position.toFixed(2)}, ${h.value.toFixed(2)}`
  return (
    <svg ref={svgElement} viewBox={`0 0 ${size().width} ${size().height}`} class="dinkster-canvas-curve"
      tabindex={props.onSelect === undefined ? undefined : 0} role={props.onSelect === undefined ? 'img' : 'application'}
      aria-label={props.label} data-tooltip-label={props.tooltip}
      onPointerDown={press} onPointerMove={track} onPointerUp={release} onPointerCancel={release}
      onLostPointerCapture={release} onPointerLeave={() => setHover(undefined)} onDblClick={add} on:keydown={key}>
      <defs>
        <Show when={props.inputStrip}>
          {(strip) => (
            <linearGradient id={`${id}-in`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color={strip()[0]} /><stop offset="1" stop-color={strip()[1]} />
            </linearGradient>
          )}
        </Show>
        <Show when={props.outputStrip}>
          {(strip) => (
            <linearGradient id={`${id}-out`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stop-color={strip()[0]} /><stop offset="1" stop-color={strip()[1]} />
            </linearGradient>
          )}
        </Show>
      </defs>
      <rect class="dinkster-canvas-curve-plot" x={left()} y={top} width={right() - left()} height={bottom() - top} />
      <Show when={props.histogram}>
        {(bars) => (
          <For each={bars()}>
            {(bar, index) => {
              const width = () => (right() - left()) / bars().length
              const height = () => clamp(bar) * (bottom() - top)
              return <rect class="dinkster-canvas-curve-histogram" x={left() + index() * width()} y={bottom() - height()}
                width={Math.max(0, width() - (bars().length > 64 ? 0 : 1))} height={height()} />
            }}
          </For>
        )}
      </Show>
      <For each={[0.25, 0.5, 0.75]}>
        {(at) => (
          <>
            <line class="dinkster-canvas-curve-grid" x1={x(at)} y1={top} x2={x(at)} y2={bottom()} />
            <line class="dinkster-canvas-curve-grid" x1={left()} y1={y(at)} x2={right()} y2={y(at)} />
          </>
        )}
      </For>
      <line class="dinkster-canvas-curve-identity" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
      <rect class="dinkster-canvas-curve-border" x={left()} y={top} width={right() - left()} height={bottom() - top} />
      <Show when={props.inputStrip}>
        <rect class="dinkster-canvas-curve-strip" x={left()} y={bottom() + 3} width={right() - left()} height="6" fill={`url(#${id}-in)`} />
      </Show>
      <Show when={props.outputStrip}>
        <rect class="dinkster-canvas-curve-strip" x={edge} y={top} width="6" height={bottom() - top} fill={`url(#${id}-out)`} />
      </Show>
      {/* Before the first point and after the last the curve holds that point's value, drawn fainter. */}
      <For each={curveRuns()}>
        {(run) => <polyline class="dinkster-canvas-curve-line" data-held={run.held ? 'true' : 'false'} points={run.points} />}
      </For>
      <For each={props.points}>
        {(point, index) => (
          <circle class="dinkster-canvas-curve-point" data-selected={index() === props.selected ? 'true' : 'false'}
            cx={x(point.position)} cy={y(point.value)} r="5" />
        )}
      </For>
      <Show when={hover()}>
        {(h) => {
          const hx = () => x(h().position)
          const hy = () => y(h().value)
          const flip = () => hx() > right() - 70
          // The readout sits on the plot's fill, 2 px around the text, so no grid line runs through it.
          const [box, setBox] = createSignal<DOMRect>()
          let text: SVGTextElement | undefined
          createEffect(() => {
            label(h())
            flip()
            if (text) setBox(text.getBBox())
          })
          return (
            <g class="dinkster-canvas-curve-hover">
              <line x1={left()} y1={hy()} x2={hx()} y2={hy()} />
              <line x1={hx()} y1={hy()} x2={hx()} y2={bottom()} />
              <circle cx={hx()} cy={hy()} r="5" />
              <Show when={box()}>
                {(b) => <rect class="dinkster-canvas-curve-readout" x={b().x - 2} y={b().y - 2} width={b().width + 4} height={b().height + 4} />}
              </Show>
              <text ref={text} x={flip() ? hx() - 9 : hx() + 9} y={hy() - 8} text-anchor={flip() ? 'end' : 'start'}>{label(h())}</text>
            </g>
          )
        }}
      </Show>
    </svg>
  )
}

/** One angle of a camera angle picture: its degrees when known, and whether a drag may change it. */
export interface CanvasAngle {
  readonly degrees: number | undefined
  readonly fixed: boolean
}

export type CanvasAnglePart = 'horizontal' | 'vertical'

/** The lowest and highest elevation the side view draws and a drag reaches. */
const CANVAS_ANGLE_ELEVATION = { min: -30, max: 60 } as const

const ANGLE_ORBIT = { x: 80, y: 75, radius: 55 }
const ANGLE_SIDE = { x: 172, y: 92, radius: 86 }

/**
 * A camera angle seen two ways: the orbit from above, whose dot on the ring
 * is the horizontal angle (0 nearest the viewer, 90 at the right), and the
 * elevation from the side, whose dot on the arc is the vertical angle.
 * Pressing either half moves its dot to the pointer and dragging follows it,
 * in whole degrees; `onMoveEnd` follows when the drag ends. A fixed angle is
 * drawn hollow and does not move; an angle that is not known has no dot.
 */
export function CanvasAnglePicture(props: {
  horizontal: CanvasAngle
  vertical: CanvasAngle
  label?: string
  onMove?: (part: CanvasAnglePart, degrees: number) => void
  onMoveEnd?: () => void
}) {
  let svgElement: SVGSVGElement | undefined
  let drag: { readonly pointerId: number; readonly part: CanvasAnglePart } | undefined
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const orbitAt = (degrees: number) => ({
    x: ANGLE_ORBIT.x + Math.sin(radians(degrees)) * ANGLE_ORBIT.radius,
    y: ANGLE_ORBIT.y + Math.cos(radians(degrees)) * ANGLE_ORBIT.radius,
  })
  const sideAt = (degrees: number) => ({
    x: ANGLE_SIDE.x + Math.cos(radians(degrees)) * ANGLE_SIDE.radius,
    y: ANGLE_SIDE.y - Math.sin(radians(degrees)) * ANGLE_SIDE.radius,
  })
  const movable = (part: CanvasAnglePart) => props.onMove !== undefined && !props[part].fixed && props[part].degrees !== undefined
  const follow = (event: PointerEvent, part: CanvasAnglePart) => {
    const matrix = svgElement?.getScreenCTM()
    if (!matrix) return
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    if (part === 'horizontal') {
      const degrees = Math.round((Math.atan2(at.x - ANGLE_ORBIT.x, at.y - ANGLE_ORBIT.y) * 180) / Math.PI)
      props.onMove?.(part, ((degrees % 360) + 360) % 360)
    } else {
      const degrees = Math.round((Math.atan2(ANGLE_SIDE.y - at.y, at.x - ANGLE_SIDE.x) * 180) / Math.PI)
      props.onMove?.(part, Math.max(CANVAS_ANGLE_ELEVATION.min, Math.min(CANVAS_ANGLE_ELEVATION.max, degrees)))
    }
  }
  const press = (event: PointerEvent) => {
    if (event.button !== 0 || !svgElement) return
    const box = svgElement.getBoundingClientRect()
    const matrix = svgElement.getScreenCTM()
    if (!matrix || box.width <= 0) return
    const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    // The left half is the orbit, the right half the elevation.
    const part: CanvasAnglePart = at.x < (ANGLE_ORBIT.x + ANGLE_ORBIT.radius + ANGLE_SIDE.x) / 2 ? 'horizontal' : 'vertical'
    if (!movable(part)) return
    event.preventDefault()
    drag = { pointerId: event.pointerId, part }
    svgElement.setPointerCapture(event.pointerId)
    follow(event, part)
  }
  const track = (event: PointerEvent) => {
    if (drag?.pointerId === event.pointerId) follow(event, drag.part)
  }
  const release = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return
    drag = undefined
    props.onMoveEnd?.()
  }
  const orbitDot = () => orbitAt(props.horizontal.degrees ?? 0)
  const sideDot = () => sideAt(props.vertical.degrees ?? 0)
  const low = sideAt(CANVAS_ANGLE_ELEVATION.min)
  const high = sideAt(CANVAS_ANGLE_ELEVATION.max)
  return (
    <svg ref={svgElement} viewBox="0 0 300 150" class="dinkster-canvas-angle" role="img" aria-label={props.label}
      data-movable={movable('horizontal') || movable('vertical') ? 'true' : 'false'}
      onPointerDown={press} onPointerMove={track} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}>
      <circle class="dinkster-canvas-angle-line" cx={ANGLE_ORBIT.x} cy={ANGLE_ORBIT.y} r={ANGLE_ORBIT.radius} />
      <rect class="dinkster-canvas-angle-subject" x={ANGLE_ORBIT.x - 7} y={ANGLE_ORBIT.y - 7} width="14" height="14" />
      <line class="dinkster-canvas-angle-line" x1={ANGLE_SIDE.x} y1={ANGLE_SIDE.y} x2={ANGLE_SIDE.x + ANGLE_SIDE.radius + 12} y2={ANGLE_SIDE.y} />
      <path class="dinkster-canvas-angle-line" d={`M ${low.x} ${low.y} A ${ANGLE_SIDE.radius} ${ANGLE_SIDE.radius} 0 0 0 ${high.x} ${high.y}`} />
      <rect class="dinkster-canvas-angle-subject" x={ANGLE_SIDE.x - 7} y={ANGLE_SIDE.y - 14} width="14" height="14" />
      <Show when={props.horizontal.degrees !== undefined}>
        <line class="dinkster-canvas-angle-sight" x1={ANGLE_ORBIT.x} y1={ANGLE_ORBIT.y} x2={orbitDot().x} y2={orbitDot().y} />
        <circle class="dinkster-canvas-angle-dot" data-part="horizontal" data-fixed={props.horizontal.fixed ? 'true' : 'false'}
          cx={orbitDot().x} cy={orbitDot().y} r="6" />
      </Show>
      <Show when={props.vertical.degrees !== undefined}>
        <line class="dinkster-canvas-angle-sight" x1={ANGLE_SIDE.x} y1={ANGLE_SIDE.y - 7} x2={sideDot().x} y2={sideDot().y} />
        <circle class="dinkster-canvas-angle-dot" data-part="vertical" data-fixed={props.vertical.fixed ? 'true' : 'false'}
          cx={sideDot().x} cy={sideDot().y} r="6" />
      </Show>
    </svg>
  )
}
