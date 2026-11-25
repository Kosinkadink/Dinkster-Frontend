import {
  For,
  Show,
  createEffect,
  createUniqueId,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { ChevronRight, Search, X, type LucideIcon } from 'lucide-solid'
import { ProductIcon, ProductSwitch } from './controls.js'

/** A kind of result, shown as a named tab; Tab steps through them. */
export interface ProductSearchKind {
  readonly id: string
  readonly label: string
  /** How many results of this kind match; shown after the label once typed. */
  readonly count?: number
}

/** One line of the list. */
export interface ProductSearchRow {
  /** Unique across the whole list; names the row to the caller. */
  readonly key: string
  readonly title: string
  readonly icon?: LucideIcon
  /**
   * `result` is a found thing; `more` opens the rest of its group; `folder`
   * opens a list of its own, such as a category, and shows its count.
   */
  readonly kind?: 'result' | 'more' | 'folder'
  /** Quieter words after the title on the same line, such as a setting's description. */
  readonly note?: string
  /** Where the thing lives, at the right. */
  readonly detail?: string
  readonly detailIcon?: LucideIcon
  /** Keys shown as chips at the right, such as a command's shortcut. */
  readonly keys?: readonly string[]
  /** A switch at the right that changes the thing in place without choosing the row. */
  readonly toggle?: {
    readonly checked: boolean
    readonly label: string
    readonly onChange: (next: boolean) => void
  }
  /** The count of a folder row. */
  readonly count?: number
}

export interface ProductSearchGroup {
  readonly key: string
  /** The quiet heading; a group without one runs straight on from the last. */
  readonly label?: string
  readonly count?: number
  readonly rows: readonly ProductSearchRow[]
  /** A quiet line in place of rows, such as "Searching workflows". */
  readonly note?: string
}

/** One key hint along the bottom. */
export interface ProductSearchHint {
  readonly keys: readonly string[]
  readonly label: string
}

/** The chip at the start of the field, such as the type a dropped wire carries. */
export interface ProductSearchChip {
  readonly label: string
  readonly removeLabel: string
  readonly onRemove: () => void
}

/** The keys of every row the keyboard can reach, in the order they are drawn. */
export function productSearchKeys(
  groups: readonly ProductSearchGroup[],
): readonly string[] {
  return groups.flatMap((group) => group.rows.map((row) => row.key))
}

/**
 * The row after (`step` 1) or before (`step` -1) `current`, wrapping at
 * both ends. Without a current row the first or last row is next.
 */
export function productSearchStep(
  keys: readonly string[],
  current: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (keys.length === 0) return undefined
  const at = current === undefined ? -1 : keys.indexOf(current)
  if (at < 0) return step === 1 ? keys[0] : keys.at(-1)
  return keys[(at + step + keys.length) % keys.length]
}

/**
 * Where `query`'s words appear in `text`, as [start, end) ranges in order.
 * Each word is found once, at its first place not already taken.
 */
export function productSearchMarks(
  text: string,
  query: string,
): readonly (readonly [number, number])[] {
  const lower = text.toLocaleLowerCase()
  const ranges: [number, number][] = []
  for (const word of query.toLocaleLowerCase().split(/\s+/u)) {
    if (word === '') continue
    let from = 0
    for (;;) {
      const start = lower.indexOf(word, from)
      if (start < 0) break
      const end = start + word.length
      if (ranges.every(([a, b]) => end <= a || start >= b)) {
        ranges.push([start, end])
        break
      }
      from = start + 1
    }
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

function MarkedText(props: { text: string; query: string }) {
  const parts = () => {
    const out: { text: string; marked: boolean }[] = []
    let at = 0
    for (const [start, end] of productSearchMarks(props.text, props.query)) {
      if (start > at) out.push({ text: props.text.slice(at, start), marked: false })
      out.push({ text: props.text.slice(start, end), marked: true })
      at = end
    }
    if (at < props.text.length) out.push({ text: props.text.slice(at), marked: false })
    return out
  }
  return (
    <For each={parts()}>
      {(part) =>
        part.marked ? (
          <mark class="dinkster-search-match">{part.text}</mark>
        ) : (
          part.text
        )
      }
    </For>
  )
}

/**
 * The one search surface: the field, kinds as named tabs, groups of
 * one-line rows, the key hints, and a preview of the current row beside
 * the list or floating to its right. It owns keyboard movement only: the
 * caller owns the rows, their order, what the current row is and what
 * choosing a row does, so every search in the product reads the same.
 *
 * Up and Down move the current row through every group, wrapping; Enter
 * chooses it; Tab and Shift+Tab step through the kinds; Escape asks the
 * caller to close.
 */
export function ProductSearch(props: {
  /** Names the field and the list for assistive technology. */
  label: string
  query: string
  onQuery: (text: string) => void
  placeholder?: string
  chip?: ProductSearchChip
  kinds?: readonly ProductSearchKind[]
  kind?: string
  onKind?: (id: string) => void
  /** Controls at the right of the kinds, such as type filters. */
  filters?: JSX.Element
  groups: readonly ProductSearchGroup[]
  /** The current row's key; the first row when absent or not listed. */
  current?: string
  onCurrent: (key: string) => void
  onActivate: (key: string) => void
  onClose?: () => void
  /** Words to mark in titles; the query when absent. */
  markQuery?: string
  /** Shown in the list's place while it has no rows. */
  empty?: { title: string; detail?: string }
  hints?: readonly ProductSearchHint[]
  /** The current row's preview; nothing is drawn without it. */
  preview?: JSX.Element
  /** Beside the list inside the surface, or floating to its right. */
  previewPlace?: 'beside' | 'floating'
  /** What the live region says; a count and the current row when absent. */
  status?: string
  autofocus?: boolean
  inputRef?: (element: HTMLInputElement) => void
  testId?: string
}) {
  const id = createUniqueId()
  const listId = `${id}-list`
  const optionId = (key: string) =>
    `${id}-option-${encodeURIComponent(key).replace(/%/gu, '_')}`
  let input!: HTMLInputElement
  let root!: HTMLDivElement
  let list!: HTMLDivElement
  let floating: HTMLElement | undefined
  const keys = () => productSearchKeys(props.groups)
  const rows = () => props.groups.flatMap((group) => group.rows)
  const current = () => {
    const all = keys()
    return props.current !== undefined && all.includes(props.current)
      ? props.current
      : all[0]
  }
  const currentRow = () => rows().find((row) => row.key === current())
  const status = () => {
    if (props.status !== undefined) return props.status
    const row = currentRow()
    const count = rows().filter((item) => (item.kind ?? 'result') === 'result').length
    return row === undefined
      ? props.empty?.title ?? ''
      : `${count} results. ${row.title}.`
  }
  const stepKind = (step: 1 | -1): boolean => {
    const kinds = props.kinds ?? []
    if (kinds.length < 2) return false
    const at = Math.max(0, kinds.findIndex((kind) => kind.id === props.kind))
    props.onKind?.(kinds[(at + step + kinds.length) % kinds.length]!.id)
    return true
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = productSearchStep(
        keys(),
        current(),
        event.key === 'ArrowDown' ? 1 : -1,
      )
      if (next !== undefined) props.onCurrent(next)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const key = current()
      if (key !== undefined) props.onActivate(key)
    } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (stepKind(event.shiftKey ? -1 : 1)) event.preventDefault()
    } else if (event.key === 'Escape' && props.onClose !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    } else if (
      event.key === 'Backspace' &&
      props.chip !== undefined &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      event.preventDefault()
      props.chip.onRemove()
    }
  }
  createEffect(() => {
    const key = current()
    if (key === undefined) return
    queueMicrotask(() =>
      list
        ?.querySelector<HTMLElement>(`#${CSS.escape(optionId(key))}`)
        ?.scrollIntoView?.({ block: 'nearest' }),
    )
  })
  /** The floating preview starts level with the current row and stays beside the surface. */
  const placeFloating = () => {
    const panel = floating
    const key = current()
    if (panel === undefined || key === undefined) return
    const row = list?.querySelector<HTMLElement>(`#${CSS.escape(optionId(key))}`)
    if (!row) return
    const box = root.getBoundingClientRect()
    const rowTop = row.getBoundingClientRect().top - box.top
    const lowest = Math.max(0, box.height - panel.offsetHeight)
    panel.style.top = `${Math.min(Math.max(0, rowTop - 16), lowest)}px`
  }
  createEffect(() => {
    current()
    if (props.preview !== undefined && props.previewPlace === 'floating')
      queueMicrotask(placeFloating)
  })
  onMount(() => {
    if (props.autofocus) queueMicrotask(() => input.focus())
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(placeFloating)
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  const Row = (rowProps: { row: ProductSearchRow }) => {
    const row = rowProps.row
    const kind = row.kind ?? 'result'
    const selected = () => current() === row.key
    return (
      <div
        id={optionId(row.key)}
        class="dinkster-list-row dinkster-search-row"
        role="option"
        aria-selected={selected()}
        data-kind={kind}
        data-key={row.key}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => {
          if (!selected()) props.onCurrent(row.key)
        }}
        onClick={() => props.onActivate(row.key)}
      >
        <Show when={row.icon} fallback={<span class="dinkster-search-row-icon" />}>
          {(icon) => (
            <span class="dinkster-search-row-icon" aria-hidden="true">
              <ProductIcon icon={icon()} />
            </span>
          )}
        </Show>
        <span class="dinkster-search-row-title">
          <Show when={kind === 'result'} fallback={row.title}>
            <MarkedText text={row.title} query={props.markQuery ?? props.query} />
          </Show>
          <Show when={row.note}>
            {(note) => <span class="dinkster-search-row-note"> {note()}</span>}
          </Show>
        </span>
        <span class="dinkster-search-row-end">
          <Show when={row.detail}>
            {(detail) => (
              <span class="dinkster-search-row-detail">
                <Show when={row.detailIcon}>
                  {(icon) => <ProductIcon icon={icon()} />}
                </Show>
                {detail()}
              </span>
            )}
          </Show>
          <Show when={row.keys}>
            {(chips) => (
              <span class="dinkster-search-row-keys">
                <For each={chips()}>{(key) => <kbd class="dinkster-key">{key}</kbd>}</For>
              </span>
            )}
          </Show>
          <Show when={row.toggle}>
            {(toggle) => (
              <ProductSwitch
                checked={toggle().checked}
                label={toggle().label}
                onChange={toggle().onChange}
              />
            )}
          </Show>
          <Show when={kind === 'folder'}>
            <Show when={row.count !== undefined}>
              <span class="dinkster-search-row-detail">{row.count}</span>
            </Show>
            <span class="dinkster-search-row-icon" aria-hidden="true">
              <ProductIcon icon={ChevronRight} />
            </span>
          </Show>
        </span>
      </div>
    )
  }
  return (
    <div
      ref={root}
      class="dinkster-search"
      data-preview={props.preview === undefined ? undefined : (props.previewPlace ?? 'beside')}
      data-testid={props.testId}
    >
      <div class="dinkster-search-panel">
        <div class="dinkster-search-field">
          <ProductIcon icon={Search} />
          <Show when={props.chip}>
            {(chip) => (
              <span class="dinkster-search-chip">
                <span>{chip().label}</span>
                <button
                  type="button"
                  class="dinkster-search-chip-remove"
                  aria-label={chip().removeLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    chip().onRemove()
                    input.focus()
                  }}
                >
                  <ProductIcon icon={X} />
                </button>
              </span>
            )}
          </Show>
          <input
            ref={(element) => {
              input = element
              props.inputRef?.(element)
            }}
            class="dinkster-search-input"
            type="search"
            role="combobox"
            aria-label={props.label}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              current() === undefined ? undefined : optionId(current()!)
            }
            autocomplete="off"
            spellcheck={false}
            placeholder={props.placeholder}
            value={props.query}
            onInput={(event) => props.onQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <Show when={(props.kinds?.length ?? 0) > 0 || props.filters !== undefined}>
          <div class="dinkster-search-kinds">
            <div role="tablist" aria-label={props.label} class="dinkster-search-tabs">
              <For each={props.kinds ?? []}>
                {(kind) => (
                  <button
                    type="button"
                    role="tab"
                    class="dinkster-search-tab"
                    aria-selected={kind.id === props.kind}
                    aria-controls={listId}
                    tabindex="-1"
                    data-kind={kind.id}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => props.onKind?.(kind.id)}
                  >
                    {kind.label}
                    <Show when={kind.count !== undefined}>
                      {' '}
                      <span class="dinkster-search-tab-count">{kind.count}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <Show when={props.filters}>
              <div class="dinkster-search-filters">{props.filters}</div>
            </Show>
          </div>
        </Show>
        <div class="dinkster-search-body">
          <div
            ref={list}
            id={listId}
            class="dinkster-search-list"
            role="listbox"
            aria-label={props.label}
          >
            <For each={props.groups}>
              {(group) => {
                const heading = `${id}-group-${encodeURIComponent(group.key).replace(/%/gu, '_')}`
                return (
                  <div
                    class="dinkster-search-group"
                    role="group"
                    aria-labelledby={group.label === undefined ? undefined : heading}
                  >
                    <Show when={group.label}>
                      {(label) => (
                        <div class="dinkster-search-group-heading" id={heading}>
                          <span>{label()}</span>
                          <Show when={group.count !== undefined}>
                            <span>{group.count}</span>
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={group.rows.length === 0 && group.note}>
                      {(note) => <p class="dinkster-search-note">{note()}</p>}
                    </Show>
                    <For each={group.rows}>{(row) => <Row row={row} />}</For>
                  </div>
                )
              }}
            </For>
            <Show when={keys().length === 0 && props.empty}>
              {(empty) => (
                <div class="dinkster-search-empty">
                  <p class="dinkster-search-empty-title">{empty().title}</p>
                  <Show when={empty().detail}>
                    {(detail) => <p class="dinkster-search-note">{detail()}</p>}
                  </Show>
                </div>
              )}
            </Show>
          </div>
          <Show when={props.preview !== undefined && props.previewPlace !== 'floating'}>
            <aside class="dinkster-search-preview" data-testid="search-preview">
              {props.preview}
            </aside>
          </Show>
        </div>
        <Show when={(props.hints?.length ?? 0) > 0}>
          <div class="dinkster-search-hints" aria-hidden="true">
            <For each={props.hints}>
              {(hint) => (
                <span class="dinkster-search-hint">
                  <For each={hint.keys}>{(key) => <kbd class="dinkster-key">{key}</kbd>}</For>
                  <span>{hint.label}</span>
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={props.preview !== undefined && props.previewPlace === 'floating'}>
        <aside
          ref={(element) => {
            floating = element
            queueMicrotask(placeFloating)
          }}
          class="dinkster-search-preview"
          data-place="floating"
          data-testid="search-preview"
        >
          {props.preview}
        </aside>
      </Show>
      <div class="dinkster-search-status" role="status" aria-live="polite" aria-atomic="true">
        {status()}
      </div>
    </div>
  )
}

/**
 * The preview of a node or blueprint: the node drawn, its name, what it
 * does and where it lives. The drawing is the caller's, so the product can
 * paint it with the node renderer.
 */
export function ProductSearchNodePreview(props: {
  drawing?: JSX.Element
  title: string
  description?: string
  place?: string
  /** Quiet marks after the place, such as "Not installed" or "Deprecated". */
  flags?: readonly string[]
}) {
  return (
    <div class="dinkster-search-node">
      <Show when={props.drawing}>
        <div class="dinkster-search-node-drawing">{props.drawing}</div>
      </Show>
      <h2 class="dinkster-search-node-title">{props.title}</h2>
      <Show when={props.description}>
        {(description) => <p class="dinkster-search-node-description">{description()}</p>}
      </Show>
      <Show when={props.place !== undefined || (props.flags?.length ?? 0) > 0}>
        <p class="dinkster-search-node-place">
          {props.place}
          <For each={props.flags ?? []}>
            {(flag) => <span class="dinkster-search-node-flag">{flag}</span>}
          </For>
        </p>
      </Show>
    </div>
  )
}
