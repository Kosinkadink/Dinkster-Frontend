import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount, splitProps, untrack, type ComponentProps, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  Camera,
  Circle,
  Play,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-solid'
import { CanvasClosedRow, CanvasRowField, CanvasSideLink, CanvasSidePart } from './canvas-field.js'
import { CanvasRowList, canvasListBox, canvasListLayout } from './canvas-list.js'
import { ProductButton, ProductIcon, ProductIconButton, ProductSpinner } from './controls.js'
import { ProductProgress } from './messages.js'

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
  message?: JSX.Element
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
          {props.message}
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

/** Reports the natural height of controls whose rows change with the editor state. */
export function CanvasEditorControls(props: { measured?: ((height: number) => void) | undefined; children: JSX.Element }) {
  return <div class="dinkster-canvas-editor-controls" ref={(element) => {
    if (props.measured === undefined) return
    const observer = new ResizeObserver(() => props.measured?.(element.offsetHeight))
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }}>{props.children}</div>
}

/** One line of an editor's own controls, as tall as a canvas row. */
export function CanvasEditorLine(props: { dimmed?: boolean; readOnly?: boolean | undefined; children: JSX.Element }) {
  return (
    <div class="dinkster-canvas-editor-line" data-dimmed={props.dimmed === true ? 'true' : undefined} inert={props.dimmed === true || props.readOnly === true}>
      {props.children}
    </div>
  )
}

export type CanvasFileCopyState = {
  readonly phase: 'copying'
  readonly label: string
  readonly mount?: string | undefined
  readonly amount?: string | undefined
  readonly description: string
  readonly value?: number | undefined
  readonly stopLabel: string
  readonly onStop: () => void
} | {
  readonly phase: 'waiting'
  readonly label: string
  readonly shortLabel: string
  readonly stopLabel: string
  readonly onStop: () => void
} | {
  readonly phase: 'checking'
  readonly label: string
  readonly shortLabel: string
}

/** Copying and waiting can be stopped; checking waits for the engine's canonical answer. */
export function CanvasFileCopy(props: { state: CanvasFileCopyState }) {
  const stoppable = () => props.state.phase !== 'checking' ? props.state : undefined
  const copying = () => props.state.phase === 'copying' ? props.state : undefined
  const description = () => copying()?.description ?? props.state.label
  const [hideDestination, setHideDestination] = createSignal(false)
  const [useShortLabel, setUseShortLabel] = createSignal(false)
  const shortLabel = () => props.state.phase !== 'copying' && useShortLabel() ? props.state.shortLabel : undefined
  let heading!: HTMLDivElement
  let prefix!: HTMLSpanElement
  let amount!: HTMLSpanElement
  onMount(() => {
    const observer = new ResizeObserver(() => {
      const gap = Number.parseFloat(getComputedStyle(heading).columnGap) || 0
      const mount = heading.querySelector<HTMLElement>('.dinkster-canvas-file-copy-mount')
      const mountSpace = mount === null ? 0 : Number.parseFloat(getComputedStyle(mount).minWidth) + Number.parseFloat(getComputedStyle(mount).marginLeft)
      setHideDestination(amount.offsetWidth > 0 && prefix.offsetWidth + mountSpace + amount.offsetWidth + gap > heading.clientWidth)
      setUseShortLabel(prefix.offsetWidth > heading.clientWidth)
    })
    for (const element of [heading, prefix, amount]) observer.observe(element)
    onCleanup(() => observer.disconnect())
  })
  return <div class="dinkster-canvas-file-copy" data-phase={props.state.phase} role="status">
    <div class="dinkster-canvas-file-copy-heading" ref={heading} title={description()}>
      <span class="dinkster-canvas-file-copy-label" data-hidden={hideDestination() ? 'true' : undefined}>
        <span class="dinkster-canvas-file-copy-prefix" data-measuring={shortLabel() !== undefined ? 'true' : undefined} ref={prefix}>{props.state.label}</span>
        <Show when={shortLabel()}>{(label) => <span>{label()}</span>}</Show>
        <Show when={copying()?.mount}>{(mount) => <span class="dinkster-canvas-file-copy-mount">{mount()}</span>}</Show>
      </span>
      <span class="dinkster-canvas-file-copy-amount" ref={amount}>{copying()?.amount}</span>
    </div>
    <div class="dinkster-canvas-file-copy-controls">
      <ProductProgress label={description()} value={copying()?.value} />
      <Show when={stoppable()}>{(state) => <CanvasSideLink onClick={() => state().onStop()}>{state().stopLabel}</CanvasSideLink>}</Show>
    </div>
  </div>
}

/** A line naming what the editor stores, or a message about it; `tone` colors a problem. */
export function CanvasEditorNote(props: {
  tone?: 'problem' | 'warning' | 'muted' | undefined
  wrap?: boolean
  children: JSX.Element
  details?: {
    readonly label: string
    readonly title: string
    readonly body?: string
    readonly action?: { readonly label: string; readonly onClick: () => void }
  } | undefined
}) {
  const [open, setOpen] = createSignal(false)
  const [keyboard, setKeyboard] = createSignal(false)
  const id = createUniqueId()
  let link!: HTMLButtonElement
  return (
    <div class="dinkster-canvas-editor-note" data-tone={props.tone} data-wrap={props.wrap === true ? 'true' : undefined}>
      <Show when={props.details} fallback={props.children}>{(details) => <>
        <TriangleAlert class="dinkster-canvas-editor-note-icon" aria-hidden="true" />
        <span class="dinkster-canvas-editor-note-summary">{props.children}</span>
        <CanvasSideLink ref={(element) => { link = element }} expanded={open()} controls={open() ? id : undefined}
          onClick={(event) => { setKeyboard(event.detail === 0); setOpen(!open()) }}>{details().label}</CanvasSideLink>
        <Show when={open()}>
          <CanvasEditorProblemNote anchor={link} id={id} keyboard={keyboard()} tone={props.tone} title={details().title}
            body={details().body} action={details().action} onClose={() => setOpen(false)} />
        </Show>
      </>}</Show>
    </div>
  )
}

/** The full editor problem stays over the canvas, outside clipped editor spaces. */
function CanvasEditorProblemNote(props: {
  anchor: HTMLButtonElement
  id: string
  keyboard: boolean
  tone: ComponentProps<typeof CanvasEditorNote>['tone']
  title: string
  body: string | undefined
  action: { readonly label: string; readonly onClick: () => void } | undefined
  onClose: () => void
}) {
  let popup!: HTMLDivElement
  let point!: HTMLSpanElement
  const close = (restore: boolean): void => {
    if (restore) props.anchor.focus()
    props.onClose()
  }
  onMount(() => {
    const place = (): void => {
      const anchor = props.anchor
      const row = anchor.getBoundingClientRect()
      const scale = row.width / anchor.offsetWidth
      let boundary = anchor.closest<HTMLElement>('.dinkster-canvas-example-stage')
      for (let parent = anchor.parentElement; boundary === null && parent; parent = parent.parentElement)
        boundary = parent.querySelector<HTMLElement>('canvas.graph-canvas')
      const box = boundary?.getBoundingClientRect()
      const view = window.visualViewport
      const left = Math.max(box?.left ?? 0, view?.offsetLeft ?? 0)
      const top = Math.max(box?.top ?? 0, view?.offsetTop ?? 0)
      const right = Math.min(box?.right ?? window.innerWidth, (view?.offsetLeft ?? 0) + (view?.width ?? window.innerWidth))
      const bottom = Math.min(box?.bottom ?? window.innerHeight, (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight))
      popup.style.scale = String(scale)
      popup.style.maxWidth = `${Math.max(0, right - left) / scale}px`
      popup.style.maxHeight = `${Math.max(0, bottom - top) / scale}px`
      const width = popup.offsetWidth * scale
      const height = popup.offsetHeight * scale
      const gap = 8 * scale
      const below = bottom - row.bottom
      const above = row.top - top
      const placeBelow = below >= height + gap || below >= above
      const x = Math.max(left, Math.min(row.left, right - width))
      const y = Math.max(top, Math.min(placeBelow ? row.bottom + gap : row.top - height - gap, bottom - height))
      popup.style.left = `${x}px`
      popup.style.top = `${y}px`
      point.style.left = `${Math.max(12, Math.min((row.left + row.width / 2 - x) / scale, popup.offsetWidth - 12))}px`
      popup.dataset.place = placeBelow ? 'below' : 'above'
    }
    const outside = (event: Event): void => {
      if (event.target instanceof Node && !popup.contains(event.target) && !props.anchor.contains(event.target)) close(false)
    }
    const entering = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && popup.contains(event.relatedTarget)) event.stopPropagation()
    }
    const keydown = (event: KeyboardEvent): void => {
      popup.dataset.keyboard = 'true'
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
    }
    const owner = props.anchor.parentElement!
    owner.addEventListener('focusout', entering as EventListener)
    popup.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    let frame = 0
    const follow = (): void => { place(); frame = requestAnimationFrame(follow) }
    place()
    frame = requestAnimationFrame(follow)
    ;(popup.querySelector<HTMLButtonElement>('button') ?? popup).focus()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      owner.removeEventListener('focusout', entering as EventListener)
      popup.removeEventListener('keydown', keydown)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    })
  })
  return <Portal><div ref={popup} id={props.id} class="dinkster-canvas-editor-problem-note" data-tone={props.tone} data-keyboard={props.keyboard}
    role="dialog" aria-labelledby={`${props.id}-title`} tabindex={-1}>
    <span ref={point} class="dinkster-canvas-editor-problem-point" aria-hidden="true" />
    <div class="dinkster-canvas-editor-problem-note-content">
    <strong id={`${props.id}-title`}>{props.title}</strong>
    <Show when={props.body}>{(body) => <p>{body()}</p>}</Show>
    <Show when={props.action}>{(action) => <CanvasEditorButtons buttons={[{
      get label() { return action().label }, onClick: () => { close(true); action().onClick() },
    }]} />}</Show>
    </div>
  </div></Portal>
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

/** A choice list shared by editor rows, outside their clipped editor space. */
export function CanvasEditorChoiceList(props: Omit<ComponentProps<typeof CanvasRowList>, 'rowWidth' | 'place' | 'listPlace' | 'listMaxHeight' | 'onListSize'> & {
  anchor: HTMLElement
  onClose: () => void
}) {
  const [local, list] = splitProps(props, ['anchor', 'onClose', 'onPick', 'onKeyDown'])
  const [height, setHeight] = createSignal(0)
  const [headingSize, setHeadingSize] = createSignal({ width: 0, height: 0 }, {
    equals: (a, b) => a.width === b.width && a.height === b.height,
  })
  const [position, setPosition] = createSignal({ x: 0, y: 0, width: 0, scale: 1, listPlace: 'below' as 'above' | 'below', listMaxHeight: 0 })
  let popup!: HTMLDivElement
  const close = (restore = true): void => {
    if (restore) (local.anchor.matches('button') ? local.anchor : local.anchor.querySelector('button'))?.focus()
    local.onClose()
  }
  const place = (): void => {
    const anchor = local.anchor
    const row = anchor.getBoundingClientRect()
    const scale = row.width / anchor.offsetWidth
    let boundary = anchor.closest<HTMLElement>('.dinkster-canvas-example-stage')
    for (let parent = anchor.parentElement; boundary === null && parent; parent = parent.parentElement)
      boundary = parent.querySelector<HTMLElement>('canvas.graph-canvas')
    const box = boundary?.getBoundingClientRect()
    const view = window.visualViewport
    const left = Math.max(box?.left ?? 0, view?.offsetLeft ?? 0)
    const top = Math.max(box?.top ?? 0, view?.offsetTop ?? 0)
    const right = Math.min(box?.right ?? window.innerWidth, (view?.offsetLeft ?? 0) + (view?.width ?? window.innerWidth))
    const bottom = Math.min(box?.bottom ?? window.innerHeight, (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight))
    const bounds = { x: left, y: top, width: right - left, height: bottom - top }
    const menu = canvasListBox(row, bounds, headingSize(), scale)
    const width = menu.width
    const filterHeight = (popup?.querySelector<HTMLElement>('.dinkster-canvas-field-row')?.offsetHeight ?? anchor.offsetHeight) * scale
    const y = Math.max(top, Math.min(row.y, bottom - filterHeight))
    const layout = canvasListLayout({ x: row.x, y, width, height: filterHeight },
      { x: left, y: top, width: right - left, height: bottom - top }, height() * scale, { width: 0, height: 0 }, 1, 0, 0)
    const next = { x: menu.x, y, width: width / scale, scale,
      listPlace: layout.listPlace, listMaxHeight: (layout.listMaxHeight ?? height() * scale) / scale }
    setPosition((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
  }
  createEffect(() => { height(); headingSize(); queueMicrotask(place) })
  createEffect(() => {
    const current = position()
    if (popup) {
      popup.style.left = `${current.x}px`
      popup.style.top = `${current.y}px`
      popup.style.scale = String(current.scale)
    }
  })
  onMount(() => {
    const outside = (event: Event): void => {
      if (event.target instanceof Node && !local.anchor.contains(event.target) && !popup.contains(event.target)) close(event.type === 'pointerdown')
    }
    // Focus moving from the row into its portal is still inside this editor.
    const entering = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && popup.contains(event.relatedTarget)) event.stopPropagation()
    }
    const observer = new ResizeObserver(place)
    observer.observe(local.anchor)
    let frame = 0
    const follow = (): void => { place(); frame = requestAnimationFrame(follow) }
    frame = requestAnimationFrame(follow)
    const owner = local.anchor.closest('.dinkster-canvas-target-box') ?? local.anchor
    owner.addEventListener('focusout', entering as EventListener)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      owner.removeEventListener('focusout', entering as EventListener)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    })
  })
  return <Portal><div ref={popup} class="dinkster-canvas-editor-choice-list">
    <CanvasRowList {...list} rowWidth={position().width} place="right"
      onHeadingSize={setHeadingSize}
      listPlace={position().listPlace} listMaxHeight={position().listMaxHeight} onListSize={setHeight}
      onPick={(index) => { close(); local.onPick?.(index) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        else local.onKeyDown?.(event)
      }} />
  </div></Portal>
}

/**
 * A choice of an editor's own, drawn as the node's choice row is: the name,
 * the chosen entry and the chevron. Pressing the row opens it in place as
 * the node's choice row opens: the value becomes a filter and the entries
 * open over the canvas at its width, flipping or shifting to stay inside.
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
  let slot!: HTMLDivElement
  const shown = () => props.options.filter((option) => option.toLowerCase().includes(query().toLowerCase()))
  const pick = (index: number) => {
    const chosen = shown()[index]
    slot.querySelector('button')?.focus()
    if (chosen !== undefined) props.onChange?.(chosen)
    setOpen(false)
  }
  const begin = () => {
    setQuery('')
    setHighlight(Math.max(0, props.options.indexOf(props.value)))
    setOpen(true)
    props.onOpen?.()
  }
  return (
    <div class="dinkster-canvas-editor-field-slot" ref={slot}>
      <CanvasClosedRow label={props.label} value={props.value} onOpen={begin} choice />
      <Show when={open()}>
        <CanvasEditorChoiceList anchor={slot} onClose={() => setOpen(false)}
          look="flat-title"
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
            if (event.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); pick(highlight()) }
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
  /** Hold each point until the next, with a vertical jump at that next point. */
  step?: boolean
  disabled?: boolean | undefined
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
  const [pointerFocus, setPointerFocus] = createSignal(false)
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
      if (props.step) {
        const path = [{ position: from, value: props.sample(from) }]
        for (const point of props.points) {
          if (point.position <= from || point.position > to) continue
          path.push({ position: point.position, value: path.at(-1)!.value }, point)
        }
        path.push({ position: to, value: props.sample(to) })
        return { held, points: path.map((point) => `${x(point.position)},${y(Math.max(0, Math.min(1, point.value)))}`).join(' ') }
      }
      const samples = Math.max(2, Math.ceil((x(to) - x(from)) / 2))
      const points = Array.from({ length: samples + 1 }, (_, index) => {
        const position = from + (to - from) * index / samples
        return `${x(position)},${y(Math.max(0, Math.min(1, props.sample(position))))}`
      }).join(' ')
      return { held, points }
    }
    const start = Math.max(0, Math.min(1, first.position))
    const end = Math.max(0, Math.min(1, last.position))
    return [
      ...(start > 0 ? [run(0, start, true)] : []),
      run(start, end, false),
      ...(end < 1 ? [run(end, 1, true)] : []),
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
    if (props.disabled) return
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
    if (props.disabled || event.button !== 0) return
    setPointerFocus(true)
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
    if (props.disabled) { drag = undefined; return }
    if (drag?.pointerId !== event.pointerId) return
    drag = undefined
    props.onMoveEnd?.()
  }
  const add = (event: MouseEvent) => {
    if (props.disabled) return
    const at = local(event)
    if (!at || pointAt(at) !== undefined) return
    const point = plotPoint(at)
    if (point.position < 0 || point.position > 1 || point.value < 0 || point.value > 1) return
    // The new point is under the pointer, where no dashed point shows.
    setHover(undefined)
    props.onAdd?.(point)
  }
  const key = (event: KeyboardEvent) => {
    if (props.disabled) return
    setPointerFocus(false)
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
      data-disabled={props.disabled ? 'true' : undefined}
      tabindex={props.disabled || props.onSelect === undefined ? undefined : 0} role={props.disabled || props.onSelect === undefined ? 'img' : 'application'}
      aria-label={props.label} data-tooltip-label={props.tooltip}
      data-tooltip-trigger="hover" data-tooltip-place="above"
      data-pointer-focus={pointerFocus() ? 'true' : undefined} onBlur={() => setPointerFocus(false)}
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
          <Show when={point.position >= 0 && point.position <= 1 && point.value >= 0 && point.value <= 1}>
            <circle class="dinkster-canvas-curve-point" data-selected={index() === props.selected ? 'true' : 'false'}
              cx={x(point.position)} cy={y(point.value)} r="5" />
          </Show>
        )}
      </For>
      <Show when={props.disabled ? undefined : hover()}>
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
 * elevation from the side, whose dot on the arc is the vertical angle; the
 * side view's line is level with the subject's middle, so 0 sits on it.
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
      <rect class="dinkster-canvas-angle-subject" x={ANGLE_SIDE.x - 7} y={ANGLE_SIDE.y - 7} width="14" height="14" />
      <Show when={props.horizontal.degrees !== undefined}>
        <line class="dinkster-canvas-angle-sight" x1={ANGLE_ORBIT.x} y1={ANGLE_ORBIT.y} x2={orbitDot().x} y2={orbitDot().y} />
        <circle class="dinkster-canvas-angle-dot" data-part="horizontal" data-fixed={props.horizontal.fixed ? 'true' : 'false'}
          cx={orbitDot().x} cy={orbitDot().y} r="6" />
      </Show>
      <Show when={props.vertical.degrees !== undefined}>
        <line class="dinkster-canvas-angle-sight" x1={ANGLE_SIDE.x} y1={ANGLE_SIDE.y} x2={sideDot().x} y2={sideDot().y} />
        <circle class="dinkster-canvas-angle-dot" data-part="vertical" data-fixed={props.vertical.fixed ? 'true' : 'false'}
          cx={sideDot().x} cy={sideDot().y} r="6" />
      </Show>
    </svg>
  )
}
