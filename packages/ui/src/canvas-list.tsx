import {
  For,
  Show,
  createEffect,
  createUniqueId,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { Check, ChevronLeft, ChevronRight, CircleAlert } from 'lucide-solid'
import {
  CanvasRowField,
  canvasSideLayout,
  type CanvasBox,
  type CanvasSideLayout,
  type CanvasSidePlace,
  type CanvasSideSize,
} from './canvas-field.js'

/** One entry of a list opened in a row. */
export interface CanvasListOption {
  /** Unique among the entries; names the entry's element. */
  readonly key: string
  readonly label: string
  /** A second line, such as the folder or information of a matching leaf. */
  readonly detail?: string
  /** A folder opens without storing; "back" returns to its parent. */
  readonly kind?: 'option' | 'folder' | 'back'
  /** The stored value: drawn with a check. */
  readonly saved?: boolean
}

/** A text action at the foot of a list or on its status line. */
export interface CanvasListAction {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly onClick: () => void
}

/**
 * The line that says what the list is doing: on the footer line before the
 * actions while there are options, in the options' place while there are none.
 */
export interface CanvasListStatus {
  readonly tone: 'busy' | 'notice' | 'warning' | 'error'
  readonly text: string
  readonly action?: CanvasListAction
}

/** The most entries a list shows before it scrolls. */
export const CANVAS_LIST_ROWS = 8

/** Where a list opened in a row goes and how it fits the visible canvas. */
export interface CanvasListLayout extends CanvasSideLayout {
  readonly listPlace: 'below' | 'above'
  /** The height the list may take before it scrolls, at normal size. */
  readonly listMaxHeight?: number
}

/**
 * Lays out a list opened in a row and the row's side part on the visible
 * canvas, which never moves for them. The list goes under the row, or over
 * it when the room under it is too short and the room over it is larger,
 * and takes the room there is. The side part stays beside the row, touching
 * it, as `canvasSideLayout` places it; under or over the field it goes past
 * the list, never over it. The side part's top is measured from the top of
 * the row and list together, as the row field's frame places it.
 *
 * `row` and `bounds` are screen boxes; `list` and `side` are at normal size.
 * `nodeBelow` and `nodeAbove` are the distances, at normal size, from the
 * row's top down to where a side part starts under the node and up to
 * where it ends over the node.
 */
export function canvasListLayout(
  row: CanvasBox,
  bounds: CanvasBox,
  list: number,
  side: CanvasSideSize,
  scale: number,
  nodeBelow: number,
  nodeAbove: number,
): CanvasListLayout {
  const zoom = Math.max(1, scale)
  const fieldHeight = row.height / zoom
  const roomBelow = Math.max(0, (bounds.y + bounds.height - row.y) / zoom - fieldHeight)
  const roomAbove = Math.max(0, (row.y - bounds.y) / zoom)
  const listPlace = list <= roomBelow || roomBelow >= roomAbove ? 'below' : 'above'
  const room = listPlace === 'below' ? roomBelow : roomAbove
  const listHeight = Math.min(list, room)
  const fits = list <= room ? {} : { listMaxHeight: room }
  // The side part's top is measured from the column of row and list.
  const offset = listPlace === 'above' ? listHeight : 0
  const beside = canvasSideLayout(row, bounds, side, scale, nodeBelow, nodeAbove)
  if (beside.place === 'right' || beside.place === 'left')
    return { ...beside, sideTop: beside.sideTop + offset, listPlace, ...fits }
  // Under or over: the side part goes past the list.
  const box = {
    x: row.x,
    y: row.y - offset * zoom,
    width: row.width,
    height: row.height + listHeight * zoom,
  }
  const around = canvasSideLayout(
    box,
    bounds,
    side,
    scale,
    Math.max(nodeBelow + offset, fieldHeight + listHeight),
    Math.max(nodeAbove - offset, 0),
  )
  return { ...around, listPlace, ...fits }
}

/**
 * A choice row opened on the canvas: the row's value area
 * becomes a filter and one list opens with it, at the row's width. A check
 * marks the stored entry and the grey highlight marks the candidate;
 * nothing here stores, the caller does on a pick. The list shows at most
 * eight entries and scrolls; when the canvas has less room, the entries
 * take what is left after the status line and the actions, and when even
 * one entry does not fit the whole list scrolls as one.
 */
export function CanvasRowList(
  props: {
    /** Width of the row at normal size. */
    rowWidth: number
    place: CanvasSidePlace
    /** The side part's top, from the top of the row and list together, at normal size. */
    sideTop?: number
    sideMaxHeight?: number
    side?: JSX.Element
    onSideSize?: (size: CanvasSideSize) => void
    ref?: (element: HTMLDivElement) => void
    look?: 'original' | 'flat-title'
    zoomed?: boolean
    label: string
    query: string
    onQuery: (text: string) => void
    onKeyDown?: (event: KeyboardEvent) => void
    inputRef?: (element: HTMLInputElement) => void
    inputLabel: string
    placeholder?: string
    options: readonly CanvasListOption[]
    /** Index of the candidate in `options`, when there is one. */
    highlight?: number
    onHighlight?: (index: number) => void
    onPick?: (index: number) => void
    /** Entries left out before and after `options` by a bounded window. */
    hiddenBefore?: number
    hiddenAfter?: number
    onPage?: (direction: -1 | 1) => void
    status?: CanvasListStatus
    /** What the list says when it has no entries and nothing is loading. */
    empty?: string
    actions?: readonly CanvasListAction[]
    /** The action the keyboard is on, by id; the list's own actions only. */
    focusedAction?: string
    listPlace?: 'below' | 'above'
    /** The list's height limit, from `canvasListLayout`. */
    listMaxHeight?: number
    /** The list's height without a limit, at normal size. */
    onListSize?: (height: number) => void
    /** A store is in flight: nothing in the list can be pressed. */
    frozen?: boolean
  },
) {
  const listboxId = createUniqueId()
  const optionId = (index: number) => `${listboxId}-${index}`
  let input: HTMLInputElement | undefined
  let body!: HTMLDivElement
  let status: HTMLElement | undefined
  let entries!: HTMLDivElement
  let actions: HTMLDivElement | undefined
  let reported = -1
  const measure = () => {
    if (!body) return
    entries.style.maxHeight = ''
    body.style.maxHeight = ''
    const items = [...entries.children] as HTMLElement[]
    const cap = items.length > CANVAS_LIST_ROWS
      ? items[CANVAS_LIST_ROWS]!.offsetTop - items[0]!.offsetTop
      : entries.scrollHeight
    const fixed = (status?.offsetHeight ?? 0) + (actions?.offsetHeight ?? 0)
    const natural = fixed + Math.min(cap, entries.scrollHeight)
    if (natural !== reported) {
      reported = natural
      props.onListSize?.(natural)
    }
    const limit = props.listMaxHeight
    const first = items[0]?.offsetHeight ?? 0
    if (limit !== undefined && limit < natural && limit - fixed < first) {
      body.dataset['scroll'] = 'whole'
      body.style.maxHeight = `${limit}px`
    } else {
      body.dataset['scroll'] = 'entries'
      entries.style.maxHeight = `${limit !== undefined && limit < natural ? limit - fixed : cap}px`
    }
  }
  createEffect(() => {
    void [props.options, props.status, props.actions, props.listMaxHeight, props.empty, props.hiddenBefore, props.hiddenAfter]
    queueMicrotask(measure)
  })
  onMount(() => {
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    onCleanup(() => observer.disconnect())
  })
  // The candidate stays in view as the keyboard moves it, without scrolling
  // anything outside the list.
  createEffect(() => {
    const index = props.highlight
    void props.options
    queueMicrotask(() => {
      const scroller = body?.dataset['scroll'] === 'whole' ? body : entries
      const element = index === undefined ? undefined : document.getElementById(optionId(index))
      if (!scroller || !element) return
      // Offsets, not screen boxes: the list is scaled with the canvas zoomed in.
      let within = 0
      for (let at: HTMLElement | null = element; at && at !== scroller; at = at.offsetParent as HTMLElement | null)
        within += at.offsetTop
      if (within < scroller.scrollTop) scroller.scrollTop = within
      else if (within + element.offsetHeight > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = within + element.offsetHeight - scroller.clientHeight
    })
  })
  createEffect(() => {
    if (!input) return
    const index = props.highlight
    if (index === undefined || props.options[index] === undefined) input.removeAttribute('aria-activedescendant')
    else input.setAttribute('aria-activedescendant', optionId(index))
  })
  const action = (item: CanvasListAction) => (
    <button
      type="button"
      class="dinkster-canvas-list-action"
      data-action={item.id}
      data-focused={props.focusedAction === item.id}
      disabled={props.frozen === true || item.disabled === true}
      tabindex="-1"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => item.onClick()}
    >
      {item.label}
    </button>
  )
  const page = (direction: -1 | 1, count: number) => (
    <button
      type="button"
      class="dinkster-canvas-list-page"
      tabindex="-1"
      disabled={props.frozen === true}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => props.onPage?.(direction)}
    >
      {direction < 0 ? `${count} earlier options` : `${count} more options`}
    </button>
  )
  const statusLine = (current: CanvasListStatus, onTop: boolean) => (
    <p
      ref={(element) => { if (onTop) status = element }}
      class="dinkster-canvas-list-status"
      data-tone={current.tone}
      role="status"
    >
      <Show when={current.tone === 'busy'}>
        <span class="dinkster-spinner dinkster-canvas-list-spinner" aria-hidden="true" />
      </Show>
      <Show when={current.tone === 'warning' || current.tone === 'error'}>
        <CircleAlert class="dinkster-canvas-list-glyph" aria-hidden="true" />
      </Show>
      <span class="dinkster-canvas-list-status-text">{current.text}</span>
      <Show when={current.action}>{(item) => action(item())}</Show>
    </p>
  )
  // With options to show, the status sits on the footer line beside the
  // actions, so the options never move when a refresh starts, fails or
  // pauses; with none, it stands where the options would be.
  const statusBelow = (): boolean => props.status !== undefined && props.options.length > 0
  const listBody = (
    <div ref={(element) => (body = element)} class="dinkster-canvas-list" data-frozen={props.frozen === true}>
      <Show when={!statusBelow() && props.status}>{(current) => statusLine(current(), true)}</Show>
      <div
        ref={(element) => (entries = element)}
        id={listboxId}
        class="dinkster-canvas-list-entries"
        role="listbox"
        aria-label={`${props.inputLabel} options`}
      >
        <Show when={(props.hiddenBefore ?? 0) > 0}>{page(-1, props.hiddenBefore!)}</Show>
        <For each={props.options}>
          {(option, index) => (
            <div
              id={optionId(index())}
              class="dinkster-canvas-list-option"
              role="option"
              aria-selected={props.highlight === index()}
              data-kind={option.kind ?? 'option'}
              data-active={props.highlight === index()}
              data-saved={option.saved === true}
              data-detail={option.detail !== undefined}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => { if (props.highlight !== index()) props.onHighlight?.(index()) }}
              onClick={() => { if (props.frozen !== true) props.onPick?.(index()) }}
            >
              <Show when={option.kind === 'back'}>
                <ChevronLeft class="dinkster-canvas-list-glyph" aria-hidden="true" />
              </Show>
              <span class="dinkster-canvas-list-copy">
                <span class="dinkster-canvas-list-label">{option.label}</span>
                <Show when={option.detail}>
                  <span class="dinkster-canvas-list-detail">{option.detail}</span>
                </Show>
              </span>
              <Show when={option.kind === 'folder'}>
                <ChevronRight class="dinkster-canvas-list-glyph" aria-hidden="true" />
              </Show>
              <Show when={option.saved === true}>
                <Check class="dinkster-canvas-list-check" aria-label="saved" role="img" />
              </Show>
            </div>
          )}
        </For>
        <Show when={(props.hiddenAfter ?? 0) > 0}>{page(1, props.hiddenAfter!)}</Show>
        <Show when={props.options.length === 0 && props.empty !== undefined}>
          <p class="dinkster-canvas-list-empty">{props.empty}</p>
        </Show>
      </div>
      <Show when={(props.actions?.length ?? 0) > 0 || statusBelow()}>
        <div ref={(element) => (actions = element)} class="dinkster-canvas-list-actions">
          <Show when={statusBelow() && props.status}>{(current) => statusLine(current(), false)}</Show>
          <For each={props.actions}>{(item) => action(item)}</For>
        </div>
      </Show>
    </div>
  ) as JSX.Element
  return (
    <CanvasRowField
      rowWidth={props.rowWidth}
      place={props.place}
      {...(props.sideTop === undefined ? {} : { sideTop: props.sideTop })}
      {...(props.sideMaxHeight === undefined ? {} : { sideMaxHeight: props.sideMaxHeight })}
      {...(props.side === undefined ? {} : { side: props.side })}
      {...(props.onSideSize === undefined ? {} : { onSideSize: props.onSideSize })}
      {...(props.ref === undefined ? {} : { ref: props.ref })}
      {...(props.look === undefined ? {} : { look: props.look })}
      {...(props.zoomed === undefined ? {} : { zoomed: props.zoomed })}
      panel={listBody}
      panelPlace={props.listPlace ?? 'below'}
      label={props.label}
      value={props.query}
      onInput={(text) => props.onQuery(text)}
      {...(props.onKeyDown === undefined ? {} : { onKeyDown: props.onKeyDown })}
      inputLabel={props.inputLabel}
      placeholder={props.placeholder ?? 'Filter options'}
      inputRef={(element) => {
        input = element
        // The filter controls the list: a combobox whose options are the entries.
        element.setAttribute('role', 'combobox')
        element.setAttribute('aria-expanded', 'true')
        element.setAttribute('aria-controls', listboxId)
        element.setAttribute('aria-autocomplete', 'list')
        props.inputRef?.(element)
      }}
    />
  )
}

/**
 * The side part's link the keyboard can reach from the list, such as the
 * default that stores the declared default.
 */
export function CanvasListSideLink(props: {
  children: JSX.Element
  focused?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="dinkster-canvas-side-link"
      data-focused={props.focused === true}
      disabled={props.disabled === true}
      tabindex="-1"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => props.onClick()}
    >
      <span>{props.children}</span>
    </button>
  )
}
