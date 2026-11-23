import { Show, createEffect, createMemo, createSignal, onCleanup, type Component } from 'solid-js'
import { effectiveWidgetDefault, formatWidgetValue, type Json } from '@dinkster/core'
import {
  CanvasListSideLink,
  CanvasRowList,
  CanvasSidePart,
  canvasListLayout,
  type CanvasListAction,
  type CanvasListOption,
  type CanvasListStatus,
} from '@dinkster/ui'
import { comboOptions } from '../app-view-rows.js'
import { comboMenuEntries, comboRenderWindow, type ComboOption } from '../combo-search.js'
import type { WidgetEditorImplementationProps } from '../WidgetEditorController.js'
import { createComboImplementation } from './ComboEditorImplementation.js'
import { placeRow, rowPlacement, visibleCanvas } from './row-placement.js'

/**
 * What a declared lookup has for the open row, owned by the host. The list
 * shows it and asks for a refresh; it never calls the lookup itself and
 * never changes the stored value from a result. `state` always answers for
 * the row's current stored arguments.
 */
export type RowListLookupState =
  /** An input's value is not known yet, or with `check` its file is not checked yet. */
  | { readonly kind: 'waiting'; readonly input: string; readonly check?: true }
  /** The first call for these arguments, with nothing to show. */
  | { readonly kind: 'loading' }
  /** `refreshing` marks an answer shown while it is asked again. */
  | { readonly kind: 'ready' | 'stale'; readonly options: readonly ComboOption[]; readonly refreshing: boolean }
  | { readonly kind: 'unavailable'; readonly reason: RowListLookupFailure; readonly refreshing: boolean }
  /** Asked too often: keeps what it showed; Refresh may be tried again. */
  | { readonly kind: 'paused'; readonly options?: readonly ComboOption[] }
  | { readonly kind: 'off' }

export type RowListLookupFailure = 'failed' | 'timeout' | 'wrong-shape' | 'offline'

/** One sentence per failure; the details go to the doctor. */
const FAILURE_TEXT: Readonly<Record<RowListLookupFailure, string>> = {
  failed: 'The pack could not provide this list',
  timeout: 'The pack took too long to answer',
  'wrong-shape': 'The pack answered with something other than a list',
  offline: 'The backend is not connected',
}

export interface RowListLookup {
  readonly state: () => RowListLookupState
  /** The one request behind Refresh and Try again. */
  readonly refresh: () => void
}

type LookupProvider = (props: WidgetEditorImplementationProps) => RowListLookup | undefined
let lookupProvider: LookupProvider | undefined

/** Lets the host's lookup service feed lists from declared lookups. */
export function provideRowListLookups(provider: LookupProvider | undefined): void {
  lookupProvider = provider
}

const ComboAuthoring = createComboImplementation(false)

/** Where the keyboard is besides the filter: Alt+Down and Alt+Up walk these. */
type Zone = { readonly kind: 'list' } | { readonly kind: 'action'; readonly id: string } | { readonly kind: 'default' } | { readonly kind: 'filter' }

/**
 * A choice row edited in its own row on the canvas: the row's value becomes a
 * filter and one list opens with it. Opening, filtering, moving the
 * highlight, refreshing or leaving with Tab never stores; Enter or a click on
 * an entry stores that entry once, as one undo step, and the keyboard stays
 * on the row. A stored value missing from the options is kept and marked in
 * the side part, never added as an option.
 */
export const InRowListImplementation: Component<WidgetEditorImplementationProps> = (props) => {
  const host = props.editor
  const ed = host.ed
  const spec = ed.spec!
  const inRow = ed.inRow!
  const bounds = visibleCanvas(host.boundary)
  let live = true
  onCleanup(() => { live = false })

  const lookup = lookupProvider?.(props)
  const lookupState = (): RowListLookupState | undefined => lookup?.state()
  const declared = comboOptions(spec)
  const options = createMemo<readonly ComboOption[]>(() => {
    const state = lookupState()
    if (state === undefined) return declared
    if (state.kind === 'ready' || state.kind === 'stale') return state.options
    if (state.kind === 'paused') return state.options ?? []
    return []
  })
  const stored = ed.initial
  const isStored = (option: ComboOption): boolean => option.value === stored
  const storedOption = (): ComboOption | undefined => options().find(isStored)
  const missing = (): boolean => stored !== undefined && stored !== null && storedOption() === undefined &&
    (lookupState() === undefined || ['ready', 'stale', 'paused'].includes(lookupState()!.kind))

  const [query, setQuery] = createSignal('')
  const [folder, setFolder] = createSignal<readonly string[]>([])
  const entries = createMemo(() => comboMenuEntries(options(), folder(), query()))
  // A folder's entries start with a way back to its parent while nothing is typed.
  const back = (): boolean => folder().length > 0 && query().trim() === ''
  const count = (): number => entries().length + (back() ? 1 : 0)
  const savedIndex = (): number | undefined => {
    const found = entries().findIndex((entry) => entry.kind === 'option' ? isStored(entry.option)
      : storedOption()?.folder?.split('/').slice(0, entry.path.length).join('/') === entry.path.join('/'))
    return found < 0 ? undefined : found + (back() ? 1 : 0)
  }
  const [highlight, setHighlight] = createSignal<number | undefined>(savedIndex() ?? (count() > 0 ? 0 : undefined))
  // An answer that arrives after opening highlights the saved entry, or the first.
  createEffect((previous: number | undefined) => {
    const total = count()
    if (previous === 0 && total > 0 && highlight() === undefined) setHighlight(savedIndex() ?? 0)
    else if (highlight() !== undefined && highlight()! >= total) setHighlight(total > 0 ? total - 1 : undefined)
    return total
  }, count())
  const [zone, setZone] = createSignal<Zone>({ kind: 'list' })

  const window = createMemo(() => comboRenderWindow(count(), highlight() ?? 0))
  const label = (option: ComboOption): string => option.label
  const duplicates = createMemo(() => {
    const seen = new Map<string, number>()
    for (const option of options()) seen.set(option.label, (seen.get(option.label) ?? 0) + 1)
    return seen
  })
  const shown = createMemo<readonly CanvasListOption[]>(() => {
    const all: CanvasListOption[] = []
    if (back()) all.push({ key: 'back', label: 'Back to parent folder', kind: 'back' })
    const searching = query().trim() !== ''
    entries().forEach((entry, index) => {
      if (entry.kind === 'folder') {
        all.push({ key: `folder:${entry.path.join('/')}`, label: entry.label, kind: 'folder' })
        return
      }
      const option = entry.option
      const parts = [searching ? option.folder : undefined, option.info].filter((part): part is string => part !== undefined && part !== '')
      // Two options with one label and nothing else to tell them apart show their values.
      if (parts.length === 0 && (duplicates().get(option.label) ?? 0) > 1) parts.push(String(option.value))
      all.push({
        key: `option:${index}`,
        label: label(option),
        ...(parts.length > 0 ? { detail: parts.join(' / ') } : {}),
        ...(isStored(option) ? { saved: true } : {}),
      })
    })
    return all.slice(window().start, window().end)
  })
  const entryAt = (index: number) => {
    if (back() && index === 0) return { kind: 'back' as const }
    return entries()[index - (back() ? 1 : 0)]
  }

  const target = ed.target
  const focusRow = (): void => {
    if (target.kind === 'input') host.focusRow?.({ nodeId: target.nodeId, valueKey: target.valueKey })
  }
  const [picked, setPicked] = createSignal<string>()
  const store = (value: Json, text: string): void => {
    if (props.commitPending()) return
    if (value === stored) { props.close(); focusRow(); return }
    setPicked(text)
    void props.commitValue(value).then((closed) => {
      if (closed || !live) focusRow()
    })
  }
  const openFolder = (path: readonly string[]): void => {
    setFolder(path)
    setHighlight(path.length > 0 ? 1 : 0)
  }
  const activate = (index: number): void => {
    const entry = entryAt(index)
    if (entry === undefined) return
    if (entry.kind === 'back') openFolder(folder().slice(0, -1))
    else if (entry.kind === 'folder') openFolder(entry.path)
    else store(entry.option.value, entry.option.label)
  }

  const [authoring, setAuthoring] = createSignal(false)
  const editable = spec.remote === undefined && ed.target.kind === 'input' &&
    ((spec.editableOptions === true && ed.target.optionsTarget !== undefined) || spec.optionSource !== undefined)
  const refreshing = (): boolean => {
    const state = lookupState()
    return state?.kind === 'loading' || ((state?.kind === 'ready' || state?.kind === 'stale' || state?.kind === 'unavailable') && state.refreshing)
  }
  const actions = createMemo<CanvasListAction[]>(() => {
    const list: CanvasListAction[] = []
    if (query().trim() !== '' && entries().length === 0 && options().length > 0)
      list.push({ id: 'clear', label: 'Clear filter', onClick: () => { setQuery(''); setHighlight(savedIndex() ?? 0) } })
    const state = lookupState()
    // After a failed refresh, Try again stands where Refresh stood.
    const tryAgain = state?.kind === 'stale' && !state.refreshing
    if (lookup !== undefined && state?.kind !== 'waiting' && state?.kind !== 'off' && !tryAgain)
      list.push({ id: 'refresh', label: 'Refresh', disabled: refreshing(), onClick: () => lookup.refresh() })
    if (editable) list.push({ id: 'edit', label: 'Edit options', onClick: () => setAuthoring(true) })
    return list
  })
  const status = createMemo<CanvasListStatus | undefined>(() => {
    if (props.commitPending() && picked() !== undefined) return { tone: 'busy', text: `Storing ${picked()}` }
    const state = lookupState()
    if (state === undefined || lookup === undefined) return undefined
    const tryAgain = { id: 'retry', label: 'Try again', disabled: refreshing(), onClick: () => lookup.refresh() }
    switch (state.kind) {
      case 'waiting': return { tone: 'notice', text: state.check === true ? `Waiting for ${state.input} to be checked` : `Waiting for ${state.input}` }
      case 'loading': return { tone: 'busy', text: 'Loading options' }
      case 'off': return { tone: 'notice', text: 'Options are not loaded in a preview.' }
      case 'paused': return { tone: 'notice', text: 'Too many refreshes. Wait a moment, then press Refresh.' }
      case 'unavailable': return state.refreshing ? { tone: 'busy', text: 'Loading options' } : { tone: 'error', text: FAILURE_TEXT[state.reason], action: tryAgain }
      case 'stale': return state.refreshing ? { tone: 'busy', text: 'Refreshing options' } : { tone: 'warning', text: 'Could not refresh', action: tryAgain }
      case 'ready': return state.refreshing ? { tone: 'busy', text: 'Refreshing options' } : undefined
    }
  })
  const empty = (): string | undefined => {
    const state = lookupState()
    if (state !== undefined && state.kind !== 'ready' && state.kind !== 'stale' && state.kind !== 'paused') return undefined
    return options().length === 0 ? 'No options available' : 'No matching options'
  }

  // The declared default, stored by its link even when the current options
  // do not hold it: a choice the person makes, checked like any other.
  const defaultValue = effectiveWidgetDefault(spec)
  const storeDefault = (): void => {
    if (defaultValue === undefined) return
    store(defaultValue as Json, formatWidgetValue(defaultValue, spec))
  }

  // Alt+Down walks the list, each action, the default link and the filter;
  // Alt+Up walks back.
  const zones = (): Zone[] => [
    { kind: 'list' },
    ...(status()?.action !== undefined ? [{ kind: 'action' as const, id: status()!.action!.id }] : []),
    ...actions().map((action) => ({ kind: 'action' as const, id: action.id })),
    ...(defaultValue === undefined ? [] : [{ kind: 'default' as const }]),
    { kind: 'filter' },
  ]
  const sameZone = (a: Zone, b: Zone): boolean => a.kind === b.kind && (a.kind !== 'action' || (b.kind === 'action' && a.id === b.id))
  const cycle = (direction: 1 | -1): void => {
    const all = zones()
    const at = all.findIndex((candidate) => sameZone(candidate, zone()))
    setZone(all[((at < 0 ? 0 : at) + direction + all.length) % all.length]!)
  }
  const runZone = (): boolean => {
    const current = zone()
    if (current.kind === 'default') { storeDefault(); return true }
    if (current.kind === 'action') {
      const action = [status()?.action, ...actions()].find((item) => item?.id === current.id)
      if (action !== undefined && action.disabled !== true) action.onClick()
      return true
    }
    return current.kind === 'filter'
  }

  host.bindClickAway?.(() => {
    if (props.commitPending()) return false
    props.close()
    return true
  })
  onCleanup(() => host.bindClickAway?.(undefined))

  const onKeyDown = (event: KeyboardEvent): void => {
    // A composed character is typed into the filter; its keys pick nothing.
    if (event.isComposing) return
    const total = count()
    const move = (index: number): void => {
      event.preventDefault()
      setZone({ kind: 'list' })
      if (total > 0) setHighlight(Math.max(0, Math.min(total - 1, index)))
    }
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      cycle(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'ArrowDown') move((highlight() ?? -1) + 1)
    else if (event.key === 'ArrowUp') move((highlight() ?? 1) - 1)
    else if (event.key === 'Home' && !event.shiftKey) move(0)
    else if (event.key === 'End' && !event.shiftKey) move(total - 1)
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      // Ctrl+Enter runs with the stored value; the highlight is not a pick.
      event.preventDefault()
      if (props.commitPending()) return
      props.close()
      const queue = host.app.commands.get('workflow.queue')
      if (queue?.enabled?.() !== false) queue?.run()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (zone().kind !== 'list') { runZone(); return }
      const index = highlight()
      if (index !== undefined) activate(index)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      props.close()
      focusRow()
    } else if (event.key === 'Tab') {
      // Tab keeps the stored value and moves to the next or previous row.
      event.preventDefault()
      if (props.commitPending() || target.kind !== 'input') return
      props.close()
      host.moveRow?.({ nodeId: target.nodeId, valueKey: target.valueKey }, event.shiftKey ? -1 : 1)
    } else if (event.key === 'Backspace' && query() === '' && folder().length > 0) {
      event.preventDefault()
      openFolder(folder().slice(0, -1))
    }
  }
  const onQuery = (text: string): void => {
    setQuery(text)
    setZone({ kind: 'list' })
    if (text.trim() === '') setHighlight(savedIndex() ?? (count() > 0 ? 0 : undefined))
    else setHighlight(count() > 0 ? 0 : undefined)
  }

  // The highlighted name in full, beside the list, when the list cuts it short.
  let frame!: HTMLDivElement
  const [cut, setCut] = createSignal<{ readonly label: string; readonly detail?: string }>()
  createEffect(() => {
    void [highlight(), shown()]
    queueMicrotask(() => {
      const active = frame?.querySelector<HTMLElement>('.dinkster-canvas-list-option[data-active="true"]')
      const name = active?.querySelector<HTMLElement>('.dinkster-canvas-list-label')
      const detail = active?.querySelector<HTMLElement>('.dinkster-canvas-list-detail')
      const clipped = (element: HTMLElement | null | undefined) => element != null && element.scrollWidth > element.clientWidth
      setCut(name != null && (clipped(name) || clipped(detail))
        ? { label: name.textContent ?? '', ...(detail?.textContent ? { detail: detail.textContent } : {}) }
        : undefined)
    })
  })

  const side = createMemo(() => {
    const facts = [
      ...(cut() === undefined ? [] : [{ key: 'highlighted', value: cut()!.label }]),
      ...(cut()?.detail === undefined ? [] : [{ key: 'detail', value: cut()!.detail! }]),
      ...(missing() ? [{ key: 'saved', value: String(stored) }] : []),
      ...(defaultValue === undefined ? [] : [{
        key: 'default',
        value: (
          <CanvasListSideLink focused={zone().kind === 'default'} disabled={props.commitPending()} onClick={storeDefault}>
            {formatWidgetValue(defaultValue, spec)}
          </CanvasListSideLink>
        ),
      }]),
    ]
    const problem = props.commitError() ?? (missing() ? 'Not in the current list. Kept until you choose another.' : undefined)
    // A field with nothing to say beside it has no side part.
    if (facts.length === 0 && problem === undefined && inRow.help === undefined) return undefined
    return (
      <CanvasSidePart
        facts={facts}
        {...(problem === undefined ? {} : { problem })}
        {...(inRow.help === undefined ? {} : { help: inRow.help })}
      />
    )
  })

  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  createEffect(() => { if (side() === undefined) setSideSize({ width: 0, height: 0 }) })
  const [listSize, setListSize] = createSignal(0)
  const placement = createMemo(() => {
    const row = rowPlacement(
      { rect: ed.rect, look: inRow.look, nodeTop: inRow.nodeTop, nodeBottom: inRow.nodeBottom },
      host.viewport(),
      bounds(),
      sideSize(),
    )
    const local = row.scale / Math.max(1, row.scale)
    const grow = inRow.look === 'flat-title' ? 1 : 0
    return {
      ...row,
      ...canvasListLayout(row.screen, bounds(), listSize(), sideSize(), row.scale,
        (inRow.nodeBottom - ed.rect.y) * local + grow,
        (ed.rect.y - inRow.nodeTop) * local - grow),
    }
  })
  createEffect(() => { if (!authoring()) placeRow(frame, placement()) })
  // The field cannot be used while a pick is stored; a refusal gives it back.
  let input: HTMLInputElement | undefined
  createEffect((wasPending: boolean) => {
    const pending = props.commitPending()
    if (wasPending && !pending && live) queueMicrotask(() => input?.focus())
    return pending
  }, false)

  return (
    <Show when={!authoring()} fallback={<ComboAuthoring {...props} />}>
      <div
        ref={frame}
        class="widget-in-row-field"
        data-testid="widget-editor"
        data-editor-target={ed.target.kind}
        data-editor-mode={spec.widgetType}
        data-editor-surface="in-row-list"
        data-lookup={lookupState()?.kind ?? 'static'}
      >
        <CanvasRowList
          look={inRow.look}
          rowWidth={placement().rowWidth}
          label={ed.label}
          query={query()}
          onQuery={onQuery}
          onKeyDown={onKeyDown}
          inputRef={(element) => {
            input = element
            element.setAttribute('aria-description', spec.widgetType)
            queueMicrotask(() => element.focus())
          }}
          inputLabel={ed.label}
          options={shown()}
          {...(highlight() === undefined || zone().kind !== 'list' ? {} : { highlight: highlight()! - window().start })}
          onHighlight={(index) => { setZone({ kind: 'list' }); setHighlight(index + window().start) }}
          onPick={(index) => activate(index + window().start)}
          hiddenBefore={window().hiddenBefore}
          hiddenAfter={window().hiddenAfter}
          onPage={(direction) => setHighlight(direction < 0 ? window().start - 1 : window().end)}
          {...(status() === undefined ? {} : { status: status()! })}
          {...(empty() === undefined ? {} : { empty: empty()! })}
          actions={actions()}
          {...(zone().kind === 'action' ? { focusedAction: (zone() as { id: string }).id } : {})}
          frozen={props.commitPending()}
          zoomed={placement().scale > 1}
          place={placement().place}
          sideTop={placement().sideTop}
          {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
          listPlace={placement().listPlace}
          {...(placement().listMaxHeight === undefined ? {} : { listMaxHeight: placement().listMaxHeight! })}
          onListSize={setListSize}
          onSideSize={setSideSize}
          {...(side() === undefined ? {} : { side: side() })}
        />
      </div>
    </Show>
  )
}
