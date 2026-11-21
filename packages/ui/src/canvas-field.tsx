import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { ArrowDown, ArrowUp, Dice5, Lock, Minus, Plus } from 'lucide-solid'

/** A box in screen pixels. */
export interface CanvasBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where an open row field's side part goes: beside the node on the right, on
 * the left when the right has no room, under the node when neither side has
 * room, and under the field when the canvas is zoomed out so far that the
 * field is drawn larger than its row.
 */
export type CanvasSidePlace = 'right' | 'left' | 'below-node' | 'below-field'

export function canvasSidePlace(
  row: CanvasBox,
  bounds: CanvasBox,
  sideWidth: number,
  scale: number,
): CanvasSidePlace {
  if (scale < 1) return 'below-field'
  if (row.x + row.width + sideWidth <= bounds.x + bounds.width) return 'right'
  if (row.x - sideWidth >= bounds.x) return 'left'
  return 'below-node'
}

/**
 * The outline around an open field and its side part, as one path: an L
 * when the side part sits beside the row, one box when it sits under the
 * field. Coordinates are local to the field, whose top left is 0,0.
 */
export function canvasFieldOutline(
  field: { readonly width: number; readonly height: number },
  side: { readonly width: number; readonly height: number } | undefined,
  place: CanvasSidePlace,
  radius: number,
  inset: number,
): string {
  const w = field.width
  const h = field.height
  let points: [number, number][]
  if (side === undefined || place === 'below-node')
    points = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]
  else if (place === 'below-field')
    points = [
      [0, 0],
      [w, 0],
      [w, h + side.height],
      [0, h + side.height],
    ]
  else if (place === 'right') {
    const bottom = Math.max(h, side.height)
    points = [
      [0, 0],
      [w + side.width, 0],
      [w + side.width, bottom],
      [w, bottom],
      [w, h],
      [0, h],
    ]
  } else {
    const bottom = Math.max(h, side.height)
    points = [
      [-side.width, 0],
      [w, 0],
      [w, h],
      [0, h],
      [0, bottom],
      [-side.width, bottom],
    ]
  }
  // A side part no taller than the field leaves repeated and straight-through
  // points; drop them so every remaining point is a real corner.
  const distinct = points.filter(
    (point, index) =>
      point[0] !== points[(index + points.length - 1) % points.length]![0] ||
      point[1] !== points[(index + points.length - 1) % points.length]![1],
  )
  const cleaned = distinct.filter((point, index) => {
    const before = distinct[(index + distinct.length - 1) % distinct.length]!
    const after = distinct[(index + 1) % distinct.length]!
    return (
      (point[0] - before[0]) * (after[1] - point[1]) !==
      (point[1] - before[1]) * (after[0] - point[0])
    )
  })
  // Keep the stroke inside the shape on every edge, the inside corner of an
  // L included: move each edge inward along its normal. The points run
  // clockwise on screen, so the inside is to the right of each edge.
  const normal = (from: [number, number], to: [number, number]) => [
    -Math.sign(to[1] - from[1]),
    Math.sign(to[0] - from[0]),
  ]
  const inside = cleaned.map(([x, y], index): [number, number] => {
    const before = normal(
      cleaned[(index + cleaned.length - 1) % cleaned.length]!,
      [x, y],
    )
    const after = normal([x, y], cleaned[(index + 1) % cleaned.length]!)
    return [
      x + inset * (before[0]! + after[0]!),
      y + inset * (before[1]! + after[1]!),
    ]
  })
  // Round only the outer corners; the inside corner of an L stays square.
  const convex = (index: number) => {
    const [ax, ay] = inside[(index + inside.length - 1) % inside.length]!
    const [bx, by] = inside[index]!
    const [cx, cy] = inside[(index + 1) % inside.length]!
    return (bx - ax) * (cy - by) - (by - ay) * (cx - bx) > 0
  }
  const segments = inside.map(([x, y], index) => {
    const [px, py] = inside[(index + inside.length - 1) % inside.length]!
    const [nx, ny] = inside[(index + 1) % inside.length]!
    if (!convex(index)) return `L ${x} ${y}`
    const toward = (tx: number, ty: number) => {
      const length = Math.hypot(tx - x, ty - y) || 1
      const r = Math.min(radius, length / 2)
      return [x + ((tx - x) / length) * r, y + ((ty - y) / length) * r]
    }
    const [sx, sy] = toward(px, py)
    const [ex, ey] = toward(nx, ny)
    return `L ${sx} ${sy} Q ${x} ${y} ${ex} ${ey}`
  })
  return `M${segments.join(' ').slice(1)} Z`
}

export interface CanvasSideFact {
  readonly key: string
  readonly value: JSX.Element
}

interface CanvasRowFrameProps {
  /** Width of the row at normal size. */
  rowWidth: number
  place: CanvasSidePlace
  /** Distance from the row's top to the side part, under the node. */
  sideTop?: number
  side?: JSX.Element
  onSideSize?: (size: { width: number; height: number }) => void
  ref?: (element: HTMLDivElement) => void
  /** The flat-title node look moves the steppers inward, as the canvas does. */
  look?: 'original' | 'flat-title'
}

/**
 * What an open field and a row the keyboard is on share: the outline around
 * the row's box and its side part, and the side part's place.
 */
function CanvasRowFrame(
  props: CanvasRowFrameProps & {
    focus?: boolean
    steppers?: boolean
    children?: JSX.Element
  },
) {
  // Made once: the row's content keeps its own bindings, and an input made
  // again on every change would lose its cursor.
  const content = untrack(() => props.children)
  let root!: HTMLDivElement
  let row!: HTMLDivElement
  let side: HTMLDivElement | undefined
  const [rowHeight, setRowHeight] = createSignal(0)
  const [sideSize, setSideSize] = createSignal<{
    width: number
    height: number
  }>()
  const measure = () => {
    root.style.width = `${props.rowWidth}px`
    setRowHeight(row.offsetHeight)
    if (!side) {
      setSideSize(undefined)
      return
    }
    side.style.top =
      props.place === 'below-node' ? `${props.sideTop ?? 0}px` : ''
    const size = { width: side.offsetWidth, height: side.offsetHeight }
    const previous = sideSize()
    if (previous?.width !== size.width || previous.height !== size.height) {
      setSideSize(size)
      props.onSideSize?.(size)
    }
  }
  createEffect(() => {
    void [props.rowWidth, props.place, props.sideTop, props.side]
    measure()
  })
  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    if (side) observer.observe(side)
    onCleanup(() => observer.disconnect())
  })
  const outline = () =>
    canvasFieldOutline(
      { width: props.rowWidth, height: rowHeight() },
      sideSize(),
      props.place,
      4,
      1,
    )
  return (
    <div
      ref={(element) => {
        root = element
        props.ref?.(element)
      }}
      class="dinkster-canvas-field"
      data-place={props.place}
      data-side={props.side !== undefined}
      data-look={props.look ?? 'original'}
      data-focus={props.focus === true}
      data-testid={props.focus === true ? 'canvas-row-focus' : 'canvas-row-field'}
    >
      <div
        ref={(element) => (row = element)}
        class="dinkster-canvas-field-row"
        data-steppers={props.steppers === true}
      >
        {content}
      </div>
      <Show when={props.side}>
        <div
          ref={(element) => (side = element)}
          class="dinkster-canvas-field-side"
          data-place={props.place}
        >
          {props.side}
        </div>
      </Show>
      <svg class="dinkster-canvas-field-outline" aria-hidden="true">
        <path d={outline()} />
      </svg>
    </div>
  )
}

/**
 * A number, text or seed row edited in place on the canvas, drawn at the
 * row's own size with its side part. The caller positions the element at
 * the row's top left and scales it with the canvas when zoomed in.
 */
export function CanvasRowField(
  props: CanvasRowFrameProps & {
    label: string
    value: string
    onInput: (text: string) => void
    onKeyDown?: (event: KeyboardEvent) => void
    inputRef?: (element: HTMLInputElement) => void
    inputLabel: string
    placeholder?: string
    /** A number gets the minus and plus steppers. */
    onStep?: (direction: -1 | 1, fast: boolean) => void
    /** A slider's fill, from 0 to 1. */
    fill?: number
    /** A mark about the value, such as a seed's mode icon, shown before it. */
    mark?: JSX.Element
  },
) {
  let fill: HTMLDivElement | undefined
  const flat = () => props.look === 'flat-title'
  // In the flat-title look the open field is its row's field grown by one
  // pixel on every side, so the fill spans the row's field inside that.
  createEffect(() => {
    if (fill)
      fill.style.width = flat()
        ? `${Math.max(0, Math.min(1, props.fill ?? 0)) * (props.rowWidth - 2)}px`
        : `${Math.max(0, Math.min(1, props.fill ?? 0)) * 100}%`
  })
  return (
    <CanvasRowFrame
      rowWidth={props.rowWidth}
      place={props.place}
      {...(props.sideTop === undefined ? {} : { sideTop: props.sideTop })}
      {...(props.side === undefined ? {} : { side: props.side })}
      {...(props.onSideSize === undefined ? {} : { onSideSize: props.onSideSize })}
      {...(props.ref === undefined ? {} : { ref: props.ref })}
      {...(props.look === undefined ? {} : { look: props.look })}
      steppers={props.onStep !== undefined}
    >
      <Show when={props.fill !== undefined}>
        <div
          ref={(element) => (fill = element)}
          class="dinkster-canvas-field-fill"
        />
      </Show>
      <Show when={props.onStep}>
        {(step) => (
          <button
            type="button"
            class="dinkster-canvas-field-step"
            tabindex="-1"
            aria-label="Decrease"
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => step()(-1, event.shiftKey)}
          >
            <Show
              when={flat()}
              fallback={
                <Minus
                  class="dinkster-canvas-field-glyph"
                  aria-hidden="true"
                />
              }
            >
              <StepGlyph path={MINUS_PATH} />
            </Show>
          </button>
        )}
      </Show>
      <span class="dinkster-canvas-field-label">{props.label}</span>
      <Show when={props.mark}>
        <span class="dinkster-canvas-field-mark">{props.mark}</span>
      </Show>
      <input
        ref={props.inputRef}
        class="dinkster-canvas-field-input"
        type="text"
        value={props.value}
        aria-label={props.inputLabel}
        placeholder={props.placeholder}
        autocomplete="off"
        spellcheck={false}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => props.onKeyDown?.(event)}
      />
      <Show when={props.onStep}>
        {(step) => (
          <button
            type="button"
            class="dinkster-canvas-field-step"
            tabindex="-1"
            aria-label="Increase"
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => step()(1, event.shiftKey)}
          >
            <Show
              when={flat()}
              fallback={
                <Plus
                  class="dinkster-canvas-field-glyph"
                  aria-hidden="true"
                />
              }
            >
              <StepGlyph path={PLUS_PATH} />
            </Show>
          </button>
        )}
      </Show>
    </CanvasRowFrame>
  )
}

/**
 * The keyboard is on a row and nothing is open: the open field's outline on
 * the row's box, with the row's side part. The canvas still draws the row,
 * so the frame is clear over it and leaves the pointer to the canvas.
 */
export function CanvasRowFocus(props: CanvasRowFrameProps) {
  return <CanvasRowFrame {...props} focus />
}

/*
 * The canvas draws the minus and plus as round-capped 1px lines, centred
 * 12.5px from the field's ends and half a pixel below its middle, so each
 * lands on whole pixels. These paths draw the same lines in the 24px stepper
 * zones at each end of the row's field.
 */
const MINUS_PATH = 'M9.5 12.5H15.5'
const PLUS_PATH = 'M8.5 12.5H14.5M11.5 9.5V15.5'

function StepGlyph(props: { path: string }) {
  return (
    <svg
      class="dinkster-canvas-field-step-glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={props.path} />
    </svg>
  )
}

/**
 * The side part's lines: arithmetic result, a problem, the row's own
 * controls (such as a seed's modes), then labelled facts and help.
 */
export function CanvasSidePart(props: {
  result?: string
  problem?: string
  /** Id of the problem line, so the field can name it as its error. */
  problemId?: string
  children?: JSX.Element
  facts?: readonly CanvasSideFact[]
  help?: string
}) {
  return (
    <>
      <Show when={props.result}>
        <p class="dinkster-canvas-side-result">{props.result}</p>
      </Show>
      <Show when={props.problem}>
        <p
          class="dinkster-canvas-side-problem"
          role="alert"
          id={props.problemId}
        >
          {props.problem}
        </p>
      </Show>
      {props.children}
      <Show when={props.facts?.length}>
        <dl class="dinkster-canvas-side-facts">
          <For each={props.facts}>
            {(fact) => (
              <div class="dinkster-canvas-side-fact">
                <dt>{fact.key}</dt>
                <dd>{fact.value}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      <Show when={props.help}>
        <p class="dinkster-canvas-side-help">{props.help}</p>
      </Show>
    </>
  )
}

/** The side part's link, such as the default that puts the default back. */
export function CanvasSideLink(props: {
  children: JSX.Element
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="dinkster-canvas-side-link"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  )
}

export type CanvasSeedMode = 'fixed' | 'increment' | 'decrement' | 'randomize'

/** A seed's after-run mode as the icon drawn before its value. */
export function CanvasSeedModeIcon(props: { mode: CanvasSeedMode }) {
  return (
    <Dynamic
      component={SEED_MODE_ICONS[props.mode]}
      class="dinkster-canvas-field-glyph"
      aria-label={props.mode}
      role="img"
    />
  )
}

const SEED_MODES: readonly CanvasSeedMode[] = [
  'fixed',
  'increment',
  'decrement',
  'randomize',
]

const SEED_MODE_ICONS = {
  fixed: Lock,
  increment: ArrowUp,
  decrement: ArrowDown,
  randomize: Dice5,
} as const

/**
 * A seed's four after-run modes as one line of icons, the current one marked,
 * with the meaning of the current mode, or of the icon under the pointer or
 * keyboard focus, on the line below. Then "new seed".
 */
export function CanvasSideModes(props: {
  current: CanvasSeedMode
  /** The field's step, as shown in "1 more after each run". */
  step: string
  onMode: (mode: CanvasSeedMode) => void
  onNewSeed: () => void
}) {
  const [pointed, setPointed] = createSignal<CanvasSeedMode>()
  const meaning = (mode: CanvasSeedMode) =>
    mode === 'randomize'
      ? 'randomize: a new seed after each run'
      : mode === 'fixed'
        ? 'fixed: the seed stays as it is'
        : `${mode}: ${props.step} ${mode === 'increment' ? 'more' : 'less'} after each run`
  return (
    <div class="dinkster-canvas-side-modes">
      <div
        class="dinkster-canvas-side-mode-icons"
        role="group"
        aria-label="After each run"
      >
        <For each={SEED_MODES}>
          {(mode) => {
            const Icon = SEED_MODE_ICONS[mode]
            return (
              <button
                type="button"
                class="dinkster-canvas-side-mode"
                aria-label={mode}
                aria-pressed={mode === props.current}
                onPointerDown={(event) => event.preventDefault()}
                onPointerEnter={() => setPointed(mode)}
                onPointerLeave={() => setPointed(undefined)}
                onFocus={() => setPointed(mode)}
                onBlur={() => setPointed(undefined)}
                onClick={() => props.onMode(mode)}
              >
                <Icon
                  class="dinkster-canvas-side-mode-glyph"
                  aria-hidden="true"
                />
              </button>
            )
          }}
        </For>
      </div>
      <p class="dinkster-canvas-side-mode-meaning">
        {meaning(pointed() ?? props.current)}
      </p>
      <CanvasSideLink onClick={() => props.onNewSeed()}>
        new seed
      </CanvasSideLink>
    </div>
  )
}
