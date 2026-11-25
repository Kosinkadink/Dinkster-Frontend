import {
  For,
  Match,
  Show,
  Switch,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import {
  CanvasSideLink,
  CanvasSidePart,
  canvasSideLayout,
  type CanvasBox,
  type CanvasPanelPlace,
  type CanvasSideLayout,
  type CanvasSideSize,
} from './canvas-field.js'

/** A color with opacity: a `#rrggbbaa` code short of fully opaque. */
const hasOpacity = (code: string): boolean =>
  /^#[\da-f]{6}[\da-f]{2}$/i.test(code) && !/ff$/i.test(code)

/**
 * The checker pattern drawn under a color with opacity, in cells of
 * `cell` pixels, as the canvas draws it under a row's color square.
 */
function Checker(props: { id: string; cell: number }) {
  return (
    <pattern
      id={props.id}
      width={props.cell * 2}
      height={props.cell * 2}
      patternUnits="userSpaceOnUse"
    >
      <rect
        class="dinkster-canvas-color-checker-light"
        width={props.cell * 2}
        height={props.cell * 2}
      />
      <rect
        class="dinkster-canvas-color-checker-dark"
        width={props.cell}
        height={props.cell}
      />
      <rect
        class="dinkster-canvas-color-checker-dark"
        x={props.cell}
        y={props.cell}
        width={props.cell}
        height={props.cell}
      />
    </pattern>
  )
}

/**
 * A color's square: 10 pixels, over a checker when the color has opacity,
 * with a one-pixel edge inside it so white, black and colors near the
 * background still show their bounds.
 */
export function CanvasColorSquare(props: { color: string; size?: number }) {
  const id = createUniqueId()
  const size = () => props.size ?? 10
  return (
    <svg
      class="dinkster-canvas-color-square"
      width={size()}
      height={size()}
      viewBox={`0 0 ${size()} ${size()}`}
      aria-hidden="true"
    >
      <Show when={hasOpacity(props.color)}>
        <defs>
          <Checker id={id} cell={3} />
        </defs>
        <rect width={size()} height={size()} rx={2} fill={`url(#${id})`} />
      </Show>
      <rect width={size()} height={size()} rx={2} fill={props.color} />
      <rect
        class="dinkster-canvas-color-square-edge"
        x={0.5}
        y={0.5}
        width={size() - 1}
        height={size() - 1}
        rx={1.5}
        fill="none"
      />
    </svg>
  )
}

/** A color's square directly before its code; the two never wrap apart. */
export function CanvasColorCode(props: { color: string; code?: string }) {
  return (
    <span class="dinkster-canvas-color-code">
      <CanvasColorSquare color={props.color} />
      <span>{props.code ?? props.color}</span>
    </span>
  )
}

/** A point of the picker: hue in degrees, saturation and value from 0 to 1, opacity from 0 to 255. */
export interface CanvasColorPoint {
  readonly h: number
  readonly s: number
  readonly v: number
  readonly a: number
}

/** The picker's controls the keyboard can reach, in Alt+Down order. */
export type CanvasColorControl = 'square' | 'hue' | 'opacity' | 'swatches'

/** A ring's outer radius, its one-pixel contrast rim included. */
const RING = 6
/** Half a bar's width, its contrast rims included. */
const BAR = 3
const clampTo = (at: number, length: number, half: number): number =>
  Math.min(Math.max(at, half), Math.max(half, length - half))
const bounded = (value: number, max: number): number =>
  Math.min(max, Math.max(0, value))

/**
 * The ring marking the chosen point on the square, where saturation and
 * value are picked at once: a 10 pixel ring with a contrast rim, kept
 * wholly inside the square. `light` and `dark` are the ring's and the
 * rim's colors, which do not change with the theme.
 */
function Ring(props: { x: number; y: number; light: string; dark: string }) {
  return (
    <g class="dinkster-canvas-color-handle" data-shape="ring" data-x={props.x} data-y={props.y}>
      <circle
        cx={props.x}
        cy={props.y}
        r={RING - 0.5}
        fill="none"
        stroke={props.dark}
        stroke-width={1}
      />
      <circle
        cx={props.x}
        cy={props.y}
        r={RING - 2}
        fill="none"
        stroke={props.light}
        stroke-width={2}
      />
    </g>
  )
}

/**
 * The bar marking a strip's value: an upright bar the strip's full height,
 * light with a dark rim on each side, kept wholly inside the strip.
 */
function Bar(props: { x: number; height: number; light: string; dark: string }) {
  return (
    <g class="dinkster-canvas-color-handle" data-shape="bar" data-x={props.x} data-y={props.height / 2}>
      <rect x={props.x - BAR} width={BAR * 2} height={props.height} rx={1.5} fill={props.dark} />
      <rect x={props.x - BAR + 1} y={1} width={BAR * 2 - 2} height={Math.max(0, props.height - 2)} rx={1} fill={props.light} />
    </g>
  )
}

/** Measures an element's box as it resizes. */
function useSize(): [
  (element: HTMLElement) => void,
  () => { width: number; height: number },
] {
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  let element: HTMLElement | undefined
  onMount(() => {
    if (!element) return
    const target = element
    const update = () =>
      setSize({ width: target.clientWidth, height: target.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(target)
    onCleanup(() => observer.disconnect())
  })
  return [(el) => (element = el), size]
}

/**
 * A color picker hung under an open color field: a saturation and value
 * square, a hue strip, an opacity strip when the field has opacity, then
 * the swatches. A click or drag changes the draft; nothing here stores.
 * The keyboard reaches each control from the field; arrows change it, and
 * the caller's `onKeyDown` decides where Enter, Escape, Tab and Alt+Up go.
 */
export function CanvasColorPicker(props: {
  point: CanvasColorPoint
  /** The field has opacity, so the picker shows its strip. */
  opacity: boolean
  /** The color at a hue, saturation and value, as a code: the picker draws with the field's own color math. */
  hex: (h: number, s: number, v: number) => string
  /** Swatch codes, the default first. */
  swatches: readonly string[]
  /** The field has no default, so the first swatch is a used color. */
  noDefault?: boolean
  /** The swatch matching the draft, if one does. */
  chosen?: string
  /** The swatch the keyboard is on while the swatch row has focus. */
  candidate?: number
  onPick?: (point: CanvasColorPoint) => void
  onSwatch?: (code: string) => void
  onCandidate?: (index: number) => void
  onKeyDown?: (event: KeyboardEvent, control: CanvasColorControl) => void
  /** The controls by name, so the caller can move the keyboard to one. */
  controls?: (controls: Partial<Record<CanvasColorControl, HTMLElement>>) => void
  /** The control the keyboard is on, outlined. */
  focused?: CanvasColorControl
  disabled?: boolean
}) {
  const id = createUniqueId()
  const [squareRef, square] = useSize()
  const [hueRef, hue] = useSize()
  const [opacityRef, opacity] = useSize()
  const elements: Partial<Record<CanvasColorControl, HTMLElement>> = {}
  const register =
    (control: CanvasColorControl, measure?: (element: HTMLElement) => void) =>
    (element: HTMLElement) => {
      elements[control] = element
      measure?.(element)
      props.controls?.(elements)
    }
  const white = () => props.hex(0, 0, 1)
  const black = () => props.hex(0, 0, 0)
  const color = () => props.hex(props.point.h, props.point.s, props.point.v)

  // A press takes the pointer, so a drag past the control's edge keeps
  // changing it, and keeps the keyboard in the field.
  const drag =
    (pick: (x: number, y: number) => void) =>
    (event: PointerEvent): void => {
      if (props.disabled) return
      const element = event.currentTarget as HTMLElement
      if (event.type === 'pointerdown') {
        event.preventDefault()
        element.setPointerCapture(event.pointerId)
      } else if (!element.hasPointerCapture(event.pointerId)) return
      const box = element.getBoundingClientRect()
      pick(
        bounded((event.clientX - box.left) / (box.width || 1), 1),
        bounded((event.clientY - box.top) / (box.height || 1), 1),
      )
    }
  const set = (change: Partial<CanvasColorPoint>) =>
    props.onPick?.({ ...props.point, ...change })
  const pickSquare = drag((x, y) => set({ s: x, v: 1 - y }))
  const pickHue = drag((x) => set({ h: Math.min(x * 360, 359.999) }))
  const pickOpacity = drag((x) => set({ a: Math.round(x * 255) }))

  const keys =
    (control: CanvasColorControl) =>
    (event: KeyboardEvent): void => {
      const step = event.shiftKey ? 10 : 1
      const arrow = (
        { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, [number, number]>
      )[event.key]
      if (arrow && !event.altKey && !event.ctrlKey && !event.metaKey && !props.disabled) {
        event.preventDefault()
        const [dx, dy] = arrow
        const point = props.point
        if (control === 'square')
          set({
            s: bounded(Math.round(point.s * 100 + dx * step) / 100, 1),
            v: bounded(Math.round(point.v * 100 + dy * step) / 100, 1),
          })
        else if (control === 'hue')
          set({ h: bounded(Math.round(point.h) + (dx || dy) * step, 359) })
        else if (control === 'opacity')
          set({ a: bounded(point.a + (dx || dy) * step, 255) })
        else if (dx !== 0 && props.swatches.length > 0)
          props.onCandidate?.(
            bounded((props.candidate ?? 0) + dx, props.swatches.length - 1),
          )
        return
      }
      props.onKeyDown?.(event, control)
    }

  const percent = (value: number) => `${Math.round(value * 100)}%`
  return (
    <div class="dinkster-canvas-color-picker" data-disabled={props.disabled === true}>
      <div
        ref={register('square', squareRef)}
        class="dinkster-canvas-color-area"
        role="slider"
        tabindex="-1"
        aria-label="Saturation and value"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.point.s * 100)}
        aria-valuetext={`Saturation ${percent(props.point.s)}, value ${percent(props.point.v)}`}
        aria-disabled={props.disabled === true}
        data-testid="color-picker-square"
        data-focused={props.focused === 'square'}
        onPointerDown={pickSquare}
        onPointerMove={pickSquare}
        onKeyDown={keys('square')}
      >
        <svg width={square().width} height={square().height} aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-white`}>
              <stop offset="0" stop-color={white()} />
              <stop offset="1" stop-color={white()} stop-opacity="0" />
            </linearGradient>
            <linearGradient id={`${id}-black`} x2="0" y2="1">
              <stop offset="0" stop-color={black()} stop-opacity="0" />
              <stop offset="1" stop-color={black()} />
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" rx={2} fill={props.hex(props.point.h, 1, 1)} />
          <rect width="100%" height="100%" rx={2} fill={`url(#${id}-white)`} />
          <rect width="100%" height="100%" rx={2} fill={`url(#${id}-black)`} />
          <Show when={square().width > 0}>
            <Ring
              x={clampTo(props.point.s * square().width, square().width, RING)}
              y={clampTo((1 - props.point.v) * square().height, square().height, RING)}
              light={white()}
              dark={black()}
            />
          </Show>
        </svg>
      </div>
      <div
        ref={register('hue', hueRef)}
        class="dinkster-canvas-color-strip"
        role="slider"
        tabindex="-1"
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(props.point.h)}
        aria-valuetext={`Hue ${Math.round(props.point.h)} degrees`}
        aria-disabled={props.disabled === true}
        data-testid="color-picker-hue"
        data-focused={props.focused === 'hue'}
        onPointerDown={pickHue}
        onPointerMove={pickHue}
        onKeyDown={keys('hue')}
      >
        <svg width={hue().width} height={hue().height} aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-hue`}>
              <For each={[0, 60, 120, 180, 240, 300, 360]}>
                {(degrees) => (
                  <stop offset={degrees / 360} stop-color={props.hex(degrees, 1, 1)} />
                )}
              </For>
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" rx={2} fill={`url(#${id}-hue)`} />
          <Show when={hue().width > 0}>
            <Bar
              x={clampTo((props.point.h / 360) * hue().width, hue().width, BAR)}
              height={hue().height}
              light={white()}
              dark={black()}
            />
          </Show>
        </svg>
      </div>
      <Show when={props.opacity}>
        <div
          ref={register('opacity', opacityRef)}
          class="dinkster-canvas-color-strip"
          role="slider"
          tabindex="-1"
          aria-label="Opacity"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((props.point.a / 255) * 100)}
          aria-valuetext={`Opacity ${percent(props.point.a / 255)}`}
          aria-disabled={props.disabled === true}
          data-testid="color-picker-opacity"
          data-focused={props.focused === 'opacity'}
          onPointerDown={pickOpacity}
          onPointerMove={pickOpacity}
          onKeyDown={keys('opacity')}
        >
          <svg width={opacity().width} height={opacity().height} aria-hidden="true">
            <defs>
              <Checker id={`${id}-checker`} cell={4} />
              <linearGradient id={`${id}-opacity`}>
                <stop offset="0" stop-color={color()} stop-opacity="0" />
                <stop offset="1" stop-color={color()} />
              </linearGradient>
            </defs>
            <rect width="100%" height="100%" rx={2} fill={`url(#${id}-checker)`} />
            <rect width="100%" height="100%" rx={2} fill={`url(#${id}-opacity)`} />
            <Show when={opacity().width > 0}>
              <Bar
                x={clampTo((props.point.a / 255) * opacity().width, opacity().width, BAR)}
                height={opacity().height}
                light={white()}
                dark={black()}
              />
            </Show>
          </svg>
        </div>
      </Show>
      <Show when={props.swatches.length > 0}>
        <div
          ref={register('swatches')}
          class="dinkster-canvas-color-swatches"
          role="listbox"
          tabindex="-1"
          aria-label="Swatches"
          aria-disabled={props.disabled === true}
          aria-activedescendant={
            props.candidate === undefined ? undefined : `${id}-swatch-${props.candidate}`
          }
          data-testid="color-picker-swatches"
        data-focused={props.focused === 'swatches'}
          onKeyDown={keys('swatches')}
        >
          <For each={props.swatches}>
            {(code, index) => (
              <div
                id={`${id}-swatch-${index()}`}
                class="dinkster-canvas-color-swatch"
                role="option"
                aria-label={index() === 0 && !props.noDefault ? `${code}, default` : code}
                aria-selected={code === props.chosen}
                data-candidate={index() === props.candidate}
                data-default={index() === 0 && !props.noDefault}
                onPointerDown={(event) => {
                  event.preventDefault()
                  if (!props.disabled) props.onSwatch?.(code)
                }}
              >
                <CanvasColorSquare color={code} size={24} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** One line of a color field's side part, such as "Enter stores" and a color. */
export function CanvasColorLine(props: { children: JSX.Element }) {
  return <p class="dinkster-canvas-color-line">{props.children}</p>
}

/**
 * The lines of a wired color row's side part: the color the wire brings and,
 * when the field drops its opacity, the color the field uses instead.
 */
export function CanvasColorArriving(props: { arriving: string; used: string }) {
  return (
    <>
      <CanvasColorLine>
        The wire brings <CanvasColorCode color={props.arriving} />.
      </CanvasColorLine>
      <Show when={props.used !== props.arriving}>
        <CanvasColorLine>
          This field does not use opacity, so <CanvasColorCode color={props.used} /> is used.
        </CanvasColorLine>
      </Show>
    </>
  )
}

/** What the keyboard does on the picker control it is on, for the side part. */
export function CanvasColorKeys(props: { control: CanvasColorControl; point: CanvasColorPoint }) {
  const percent = (value: number) => Math.round(value * 100)
  return (
    <Switch>
      <Match when={props.control === 'square'}>
        <CanvasColorLine>
          Saturation {percent(props.point.s)}%, value {percent(props.point.v)}%
        </CanvasColorLine>
        <CanvasColorLine>Arrows change the square. Enter goes back to the text.</CanvasColorLine>
      </Match>
      <Match when={props.control === 'hue'}>
        <CanvasColorLine>Hue {Math.round(props.point.h)} degrees</CanvasColorLine>
        <CanvasColorLine>Arrows change the hue. Enter goes back to the text.</CanvasColorLine>
      </Match>
      <Match when={props.control === 'opacity'}>
        <CanvasColorLine>Opacity {percent(props.point.a / 255)}%</CanvasColorLine>
        <CanvasColorLine>Arrows change the opacity. Enter goes back to the text.</CanvasColorLine>
      </Match>
      <Match when={props.control === 'swatches'}>
        <CanvasColorLine>
          Left and Right choose a swatch. Enter puts it in the field.
        </CanvasColorLine>
      </Match>
    </Switch>
  )
}

/**
 * An open color field's side part: a refusal or "Not a color." first, then
 * what leaving the field does with its color, the saved color while the
 * draft differs from it and the default, each a link that puts its color in
 * the field, and the field's help.
 */
export function CanvasColorSide(props: {
  problem?: string
  problemId?: string
  /** A store is in flight. */
  pending?: boolean
  /** The text had an opacity this field does not keep. */
  droppedOpacity?: boolean
  /** What Enter, Tab or a click elsewhere does: store this color, or keep the stored one. */
  enter?: { readonly verb: 'stores' | 'keeps'; readonly color: string }
  /** The last valid color, which the preview holds while the text is not a color. */
  preview?: string
  /** The stored color, shown while the draft differs from it, as a link that puts it back in the field. */
  saved?: string
  onSaved?: () => void
  defaultColor?: string
  onDefault?: () => void
  help?: string
  /** Lines about the picker control the keyboard is on. */
  children?: JSX.Element
}) {
  return (
    <CanvasSidePart
      {...(props.problem === undefined ? {} : { problem: props.problem })}
      {...(props.problemId === undefined ? {} : { problemId: props.problemId })}
      facts={[
        ...(props.saved === undefined
          ? []
          : [
              {
                key: 'saved',
                value: (
                  <span data-color-link="saved">
                    <CanvasSideLink onClick={() => props.onSaved?.()}>
                      <CanvasColorCode color={props.saved} />
                    </CanvasSideLink>
                  </span>
                ),
              },
            ]),
        ...(props.defaultColor === undefined
          ? []
          : [
              {
                key: 'default',
                value: (
                  <span data-color-link="default">
                    <CanvasSideLink onClick={() => props.onDefault?.()}>
                      <CanvasColorCode color={props.defaultColor} />
                    </CanvasSideLink>
                  </span>
                ),
              },
            ]),
      ]}
      {...(props.help === undefined ? {} : { help: props.help })}
    >
      <Show when={props.pending}>
        <CanvasColorLine>
          <span class="dinkster-spinner" aria-hidden="true" />
          Storing the color
        </CanvasColorLine>
      </Show>
      <Show when={props.droppedOpacity}>
        <CanvasColorLine>This field does not use opacity.</CanvasColorLine>
      </Show>
      <Show when={props.enter}>
        {(enter) => (
          <CanvasColorLine>
            Enter {enter().verb} <CanvasColorCode color={enter().color} />
          </CanvasColorLine>
        )}
      </Show>
      <Show when={props.preview}>
        {(preview) => (
          <CanvasColorLine>
            Preview holds <CanvasColorCode color={preview()} />
          </CanvasColorLine>
        )}
      </Show>
      {props.children}
    </CanvasSidePart>
  )
}

/**
 * Where an open color field's picker and side part go. The picker hangs
 * under the field, or over it when only there is room, at the field's
 * normal size; when neither holds it whole it takes the larger room and
 * scrolls. The field and picker are one column, and the side part sits
 * beside the column, or under or over it, as `canvasSideLayout` places
 * it; never over or under the node, where the picker already hangs.
 * `row` and `bounds` are screen boxes; `panelHeight` and `side` are at
 * normal size.
 */
export function canvasColorLayout(
  row: CanvasBox,
  bounds: CanvasBox,
  panelHeight: number,
  side: CanvasSideSize,
  scale: number,
): CanvasSideLayout & {
  readonly panelPlace: CanvasPanelPlace
  readonly panelMaxHeight?: number
} {
  const zoom = Math.max(1, scale)
  const panel = panelHeight * zoom
  const below = bounds.y + bounds.height - (row.y + row.height)
  const above = row.y - bounds.y
  const panelPlace: CanvasPanelPlace =
    below >= panel || (above < panel && below >= above) ? 'below' : 'above'
  const room = panelPlace === 'below' ? below : above
  const shown = Math.min(panel, Math.max(0, room))
  const column = {
    x: row.x,
    y: panelPlace === 'below' ? row.y : row.y - shown,
    width: row.width,
    height: row.height + shown,
  }
  return {
    panelPlace,
    ...(shown < panel ? { panelMaxHeight: shown / zoom } : {}),
    ...canvasSideLayout(column, bounds, side, scale, Infinity, Infinity),
  }
}
