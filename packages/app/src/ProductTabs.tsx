import { createRenderEffect, createSignal, createUniqueId, For, type JSX } from 'solid-js'

export interface ProductTab {
  readonly id: string
  readonly label: JSX.Element
  readonly panel: JSX.Element
  readonly disabled?: boolean
}

interface ProductTabsBaseProps {
  readonly tabs: readonly ProductTab[]
  readonly orientation?: 'horizontal' | 'vertical'
  readonly id?: string
  readonly class?: string
  /** Actions rendered in the tab row, after the tablist (e.g. host chrome). */
  readonly trailing?: JSX.Element
}

type ProductTabsAccessibleName =
  | { readonly ariaLabel: string; readonly ariaLabelledBy?: never }
  | { readonly ariaLabel?: never; readonly ariaLabelledBy: string }

type ProductTabsSelection =
  | {
      readonly selectedId: string | undefined
      readonly defaultSelectedId?: never
      readonly onSelect: (id: string) => void
    }
  | {
      readonly selectedId?: never
      readonly defaultSelectedId?: string
      readonly onSelect?: (id: string) => void
    }

export type ProductTabsProps = ProductTabsBaseProps & ProductTabsAccessibleName & ProductTabsSelection

const enabled = (tabs: readonly ProductTab[], id: string | undefined): id is string =>
  id !== undefined && tabs.some((tab) => tab.id === id && tab.disabled !== true)

const nearestEnabled = (tabs: readonly ProductTab[], index: number): string | undefined => {
  if (tabs.length === 0) return undefined
  const anchor = Math.max(0, Math.min(index, tabs.length - 1))
  for (let distance = 0; distance < tabs.length; distance += 1) {
    const after = tabs[anchor + distance]
    if (after !== undefined && after.disabled !== true) return after.id
    const before = tabs[anchor - distance]
    if (before !== undefined && before.disabled !== true) return before.id
  }
  return undefined
}

const assertUniqueIds = (tabs: readonly ProductTab[]): void => {
  const ids = new Set<string>()
  for (const tab of tabs) {
    if (ids.has(tab.id)) throw new Error(`ProductTabs requires unique tab ids: ${tab.id}`)
    ids.add(tab.id)
  }
}

export function ProductTabs(props: ProductTabsProps) {
  assertUniqueIds(props.tabs)
  const generatedId = createUniqueId()
  const baseId = () => props.id ?? `product-tabs-${generatedId}`
  const initial = enabled(props.tabs, props.defaultSelectedId)
    ? props.defaultSelectedId
    : nearestEnabled(props.tabs, 0)
  const [uncontrolledSelected, setUncontrolledSelected] = createSignal(initial)
  const [resolvedSelected, setResolvedSelected] = createSignal(
    enabled(props.tabs, props.selectedId) ? props.selectedId : initial,
  )
  let root!: HTMLDivElement
  let tablist!: HTMLDivElement
  let previousTabs = props.tabs
  let previousSelected = resolvedSelected()
  let focusedId: string | undefined
  let reportedRepair: string | undefined
  const isControlled = Object.prototype.hasOwnProperty.call(props, 'selectedId')

  const tabId = (id: string): string => `${baseId()}-tab-${encodeURIComponent(id)}`
  const panelId = (id: string): string => `${baseId()}-panel-${encodeURIComponent(id)}`
  const tabIds = (): readonly string[] => props.tabs.map((tab) => tab.id)
  const tabOf = (id: string): ProductTab => props.tabs.find((tab) => tab.id === id)!

  const select = (id: string): void => {
    if (!enabled(props.tabs, id) || resolvedSelected() === id) return
    if (!isControlled) {
      setUncontrolledSelected(id)
      setResolvedSelected(id)
    }
    props.onSelect?.(id)
  }

  const focusTab = (fromId: string, direction: -1 | 1 | 'first' | 'last'): void => {
    const available = props.tabs.filter((tab) => tab.disabled !== true)
    if (available.length === 0) return
    const current = available.findIndex((tab) => tab.id === fromId)
    const next = direction === 'first'
      ? available[0]
      : direction === 'last'
        ? available.at(-1)
        : available[(current + direction + available.length) % available.length]
    tablist.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(next!.id)}"]`)?.focus()
  }

  createRenderEffect(() => {
    const tabs = props.tabs
    assertUniqueIds(tabs)
    const desired = isControlled ? props.selectedId : uncontrolledSelected()
    if (enabled(tabs, desired)) {
      setResolvedSelected(desired)
      previousTabs = tabs
      previousSelected = desired
      reportedRepair = undefined
      return
    }

    const previousIndex = Math.max(0, previousTabs.findIndex((tab) => tab.id === previousSelected))
    const replacement = nearestEnabled(tabs, previousIndex)
    const repairFocus = focusedId === previousSelected
    setResolvedSelected(replacement)
    if (!isControlled) setUncontrolledSelected(replacement)

    const repairKey = `${desired ?? ''}:${replacement ?? ''}`
    if (replacement !== undefined && reportedRepair !== repairKey) {
      reportedRepair = repairKey
      props.onSelect?.(replacement)
    }
    if (repairFocus && replacement !== undefined) {
      focusedId = replacement
      queueMicrotask(() => {
        const active = document.activeElement
        if (active !== null && active !== document.body && !root.contains(active)) return
        root.querySelector<HTMLButtonElement>(`[data-tab-id="${CSS.escape(replacement)}"]`)?.focus()
      })
    }
    previousTabs = tabs
    previousSelected = replacement
  })

  createRenderEffect(() => {
    const selected = resolvedSelected()
    if (selected === undefined) return
    queueMicrotask(() => {
      tablist
        .querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(selected)}"]`)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  })

  const tablistRow = (
    <div
      ref={tablist}
      class="product-tablist"
      role="tablist"
      aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy}
      aria-orientation={props.orientation ?? 'horizontal'}
    >
        <For each={tabIds()}>
          {(id) => (
            <button
              id={tabId(id)}
              type="button"
              class="product-tab"
              data-tab-id={id}
              role="tab"
              aria-selected={resolvedSelected() === id}
              aria-controls={panelId(id)}
              disabled={tabOf(id).disabled}
              tabindex={resolvedSelected() === id ? 0 : -1}
              onFocus={() => {
                focusedId = id
                select(id)
              }}
              onFocusOut={() => {
                if (focusedId === id) focusedId = undefined
              }}
              onClick={() => select(id)}
              onKeyDown={(event) => {
                const orientation = props.orientation ?? 'horizontal'
                const direction = event.key === (orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown')
                  ? 1
                  : event.key === (orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp')
                    ? -1
                    : event.key === 'Home'
                      ? 'first'
                      : event.key === 'End'
                        ? 'last'
                        : undefined
                if (direction === undefined) return
                event.preventDefault()
                focusTab(id, direction)
              }}
            >
              {tabOf(id).label}
            </button>
          )}
        </For>
      </div>
  )
  return (
    <div ref={root} id={props.id} class={`product-tabs${props.class ? ` ${props.class}` : ''}`}>
      {props.trailing !== undefined
        ? <div class="product-tabs-header">{tablistRow}{props.trailing}</div>
        : tablistRow}
      <For each={tabIds()}>
        {(id) => (
          <div
            id={panelId(id)}
            class="product-tabpanel"
            role="tabpanel"
            aria-labelledby={tabId(id)}
            tabindex={resolvedSelected() === id ? 0 : -1}
            hidden={resolvedSelected() !== id}
          >
            {tabOf(id).panel}
          </div>
        )}
      </For>
    </div>
  )
}
