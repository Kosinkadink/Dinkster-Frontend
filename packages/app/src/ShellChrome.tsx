import { createEffect, createRoot, createSignal, createUniqueId, For, Index, getOwner, on, onCleanup, onMount, Show, type Component, type JSX } from 'solid-js'
import type { MenuActionItem, MenuItem, ResolvedMenuGroup } from '@dinkster/core'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import X from 'lucide-solid/icons/x'
import SlidersHorizontal from 'lucide-solid/icons/sliders-horizontal'
import { ContextMenu } from './ContextMenu.js'
import { Icon } from './Icon.js'
import {
  clampZoneSplit,
  MAX_ZONE_SPLIT,
  MIN_ZONE_SPLIT,
  zonePlacement,
  type DockZoneId,
} from './dock-layout.js'
import { aggregatePanelIndicators, type PanelDescriptor, type PanelIndicator } from './panels.js'
import { ProductTabs, type ProductTab } from './ProductTabs.js'
import type { ShellRegion } from './shell-layout.js'
import type { CommandRegistry } from './settings.js'
import { useAppMessage } from './locale.js'

export function TransientStatus(props: { readonly message: string | undefined }) {
  return (
    <span class="status-announcer" data-testid="transient-status" aria-live="polite" role="status">
      {props.message ?? ''}
    </span>
  )
}

export function CustomizeLayoutButton(props: { readonly commands: CommandRegistry }) {
  const message = useAppMessage()
  return (
    <button
      class="settings-button customize-layout-button"
      data-testid="customize-layout-button"
      data-tooltip-label={message('command.layout.customize')}
      aria-label={message('command.layout.customize')}
      onClick={() => props.commands.get('layout.customize')?.run()}
    >
      <Icon icon={SlidersHorizontal} />
    </button>
  )
}

export function ShellRegionIcon(props: { readonly region: ShellRegion; readonly active: boolean }) {
  const panelRect = () => props.region === 'left'
    ? { x: 2, y: 2, width: 5, height: 16 }
    : props.region === 'right'
      ? { x: 17, y: 2, width: 5, height: 16 }
      : { x: 2, y: 13, width: 20, height: 5 }
  return (
    <svg class="shell-region-icon" viewBox="0 0 24 20" aria-hidden="true">
      <rect class="shell-region-icon-frame" x="2" y="2" width="20" height="16" rx="1.5" />
      <rect
        class="shell-region-icon-panel"
        data-region={props.region}
        data-active={props.active ? 'true' : 'false'}
        {...panelRect()}
      />
      <Show when={props.region === 'left'}><path d="M7 2v16" /></Show>
      <Show when={props.region === 'right'}><path d="M17 2v16" /></Show>
      <Show when={props.region === 'bottom'}><path d="M2 13h20" /></Show>
    </svg>
  )
}

export function ActivityBarButton(props: {
  readonly icon?: Component | undefined
  readonly label: string
  readonly accessibleName: string
  readonly tooltip: string
  readonly tooltipDetail?: string | undefined
  readonly pressed: boolean | undefined
  readonly panelId?: string | undefined
  readonly suppressTooltipWhenPressed?: boolean | undefined
  readonly testId?: string | undefined
  readonly class?: string | undefined
  readonly onActivate: () => void
}) {
  return (
    <button
      class={`sidebar-button${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.testId}
      data-panel-toggle={props.panelId}
      data-tooltip-label={props.suppressTooltipWhenPressed && props.pressed ? undefined : props.tooltip}
      data-tooltip-detail={props.tooltipDetail}
      aria-label={props.accessibleName}
      aria-pressed={props.pressed}
      onClick={props.onActivate}
    >
      <Show when={props.icon} keyed>{(icon) => (
        <span class="sidebar-button-icon" aria-hidden="true"><Icon icon={icon} /></span>
      )}</Show>
      <span class="sidebar-button-label">{props.label}</span>
    </button>
  )
}

/** A descriptor's live indicator, or nothing while it reports no attention. */
export const activePanelIndicator = (panel: PanelDescriptor): PanelIndicator | undefined => {
  const indicator = panel.indicator?.()
  return indicator !== undefined && indicator.count > 0 ? indicator : undefined
}

/**
 * The count/severity badge hosts render for a panel indicator. The count is
 * presentation only; the label carries the accessible text so screen readers
 * hear "3 problems, worst severity error" instead of a bare number.
 */
export function PanelIndicatorBadge(props: { readonly indicator: PanelIndicator }) {
  return (
    <span class="panel-indicator" data-severity={props.indicator.severity} data-testid="panel-indicator">
      <span aria-hidden="true">{props.indicator.count > 99 ? '99+' : props.indicator.count}</span>
      <span class="visually-hidden">{props.indicator.label}</span>
    </span>
  )
}

export const SHELL_RESIZE_KEYBOARD_STEP = 16

export function ShellResizeHandle(props: {
  readonly region: ShellRegion
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly testId: string
  readonly onPointerDown: (event: PointerEvent) => void
  readonly onResize: (value: number) => void
}) {
  const resizeFromKey = (event: KeyboardEvent): void => {
    const growKey = props.region === 'left' ? 'ArrowRight' : props.region === 'right' ? 'ArrowLeft' : 'ArrowUp'
    const shrinkKey = props.region === 'left' ? 'ArrowLeft' : props.region === 'right' ? 'ArrowRight' : 'ArrowDown'
    const next = event.key === 'Home'
      ? props.min
      : event.key === 'End'
        ? props.max
        : event.key === growKey
          ? Math.min(props.max, props.value + SHELL_RESIZE_KEYBOARD_STEP)
          : event.key === shrinkKey
            ? Math.max(props.min, props.value - SHELL_RESIZE_KEYBOARD_STEP)
            : undefined
    if (next === undefined) return
    event.preventDefault()
    props.onResize(next)
  }
  return (
    <div
      class={`${props.region === 'left' ? 'dock' : props.region === 'right' ? 'rail' : 'bottom'}-resize`}
      data-testid={props.testId}
      role="separator"
      tabindex="0"
      aria-label={props.label}
      aria-orientation={props.region === 'bottom' ? 'horizontal' : 'vertical'}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      onPointerDown={props.onPointerDown}
      onKeyDown={resizeFromKey}
    />
  )
}

/** One rendered section of a dock zone, addressed by its state index. */
export interface DockZoneSectionView {
  /** Index of this section in the zone's DockZoneState.sections. */
  readonly section: number
  /** Renderable panels in tab order (caller filters visibility). */
  readonly panels: readonly PanelDescriptor[]
  /** Always one of `panels` (caller repairs); undefined only when empty. */
  readonly activeId: string | undefined
}

/** Keyboard resize step for the section divider, as a share of the zone. */
export const DOCK_SECTION_SPLIT_STEP = 0.05

/**
 * Draggable, keyboard-operable divider between a zone's two sections. The
 * separator reports the FIRST section's share as a percentage; arrow keys
 * along the zone's section axis, Home, and End adjust it in steps and the
 * pointer drags it continuously. The parent zone element provides the axis
 * extent the pointer position maps onto.
 */
function DockSectionDivider(props: {
  readonly zone: DockZoneId
  readonly zoneLabel: string
  readonly split: number
  readonly onSplitChange: (split: number) => void
}) {
  const message = useAppMessage()
  let divider!: HTMLDivElement
  const stacked = (): boolean => props.zone !== 'bottom'
  const fractionAt = (event: PointerEvent): number => {
    const rect = divider.parentElement!.getBoundingClientRect()
    return stacked()
      ? (event.clientY - rect.top) / Math.max(1, rect.height)
      : (event.clientX - rect.left) / Math.max(1, rect.width)
  }
  const beginDrag = (event: PointerEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    divider.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent): void => {
      if (next.pointerId === event.pointerId) props.onSplitChange(clampZoneSplit(fractionAt(next)))
    }
    const stop = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', stop)
      divider.removeEventListener('pointercancel', stop)
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', stop)
    divider.addEventListener('pointercancel', stop)
  }
  const resizeFromKey = (event: KeyboardEvent): void => {
    const growKey = stacked() ? 'ArrowDown' : 'ArrowRight'
    const shrinkKey = stacked() ? 'ArrowUp' : 'ArrowLeft'
    const next = event.key === 'Home'
      ? MIN_ZONE_SPLIT
      : event.key === 'End'
        ? MAX_ZONE_SPLIT
        : event.key === growKey
          ? props.split + DOCK_SECTION_SPLIT_STEP
          : event.key === shrinkKey
            ? props.split - DOCK_SECTION_SPLIT_STEP
            : undefined
    if (next === undefined) return
    event.preventDefault()
    props.onSplitChange(clampZoneSplit(next))
  }
  return (
    <div
      ref={divider}
      class="dock-section-divider"
      data-testid={`dock-section-divider-${props.zone}`}
      role="separator"
      tabindex="0"
      aria-label={message('shell.chrome.resizeZoneSections', { zone: props.zoneLabel })}
      aria-orientation={stacked() ? 'horizontal' : 'vertical'}
      aria-valuemin={Math.round(MIN_ZONE_SPLIT * 100)}
      aria-valuemax={Math.round(MAX_ZONE_SPLIT * 100)}
      aria-valuenow={Math.round(props.split * 100)}
      onPointerDown={beginDrag}
      onKeyDown={resizeFromKey}
    />
  )
}

/**
 * One section's chrome: a tab row (ProductTabs, so the ARIA
 * tablist/roving-tabindex behavior is the shared primitive's), one visible
 * body, and a host-owned action cluster for the section's ACTIVE panel -
 * header action, plus the zone close on the first rendered section. Panels
 * render as placed tabs; bodies stay mounted while inactive (hidden by the
 * tab primitive) so panel state survives tab switches.
 */
function DockZoneSection(props: {
  readonly zone: DockZoneId
  readonly label: string
  /** Index of this section in the zone's DockZoneState.sections. */
  readonly section: number
  readonly panels: readonly PanelDescriptor[]
  readonly activeId: string | undefined
  /** This section's share of the zone axis; undefined when it is alone. */
  readonly share: number | undefined
  readonly showClose: boolean
  readonly closeLabel: string
  readonly menuOpen: () => boolean
  readonly onActivate: (id: string) => void
  readonly onRequestClose: () => void
}) {
  const message = useAppMessage()
  const [hiddenTabIds, setHiddenTabIds] = createSignal<ReadonlySet<string>>(new Set())
  // Tab entries cache per descriptor so a registry tick re-maps the array
  // without recreating entries, keeping panel bodies mounted across updates.
  // Each entry lives in its own root parented to the section (not to the
  // reactive computation that happened to first render it), so a body
  // created after a panel returns from floating/window placement is not
  // disposed - and its reactivity frozen - by the next tab-list update.
  // Eviction disposes the root so a departed body releases its
  // subscriptions instead of leaking.
  const owner = getOwner()
  const entries = new Map<PanelDescriptor, { readonly tab: ProductTab; readonly dispose: () => void }>()
  onCleanup(() => {
    for (const entry of entries.values()) entry.dispose()
    entries.clear()
  })
  const tabs = (): ProductTab[] => {
    const current = new Set(props.panels)
    for (const [key, entry] of entries) {
      if (current.has(key)) continue
      entry.dispose()
      entries.delete(key)
    }
    return props.panels.map((panel) => {
      let entry = entries.get(panel)
      if (!entry) {
        entry = createRoot((dispose) => ({
          dispose,
          tab: {
            id: panel.id,
            // The title tooltip is suppressed while the placement menu is open
            // so it cannot overlap the menu (the menu opens at the tab).
            // The badge sits outside the truncating text span so a narrow tab
            // ellipsizes its title but never clips the attention badge.
            label: <span class="tab-title" data-tooltip-label={props.menuOpen() ? undefined : panel.title}>
              <span class="tab-title-text">{panel.title}</span>
              <Show when={activePanelIndicator(panel)} keyed>{(indicator) => <PanelIndicatorBadge indicator={indicator} />}</Show>
            </span>,
            panel: panel.component({ placement: zonePlacement(props.zone), requestClose: props.onRequestClose }),
            get disabled() { return hiddenTabIds().has(panel.id) && panel.id !== props.activeId },
          },
        }), owner)
        entries.set(panel, entry)
      }
      return entry.tab
    })
  }
  const active = (): PanelDescriptor | undefined => props.panels.find((panel) => panel.id === props.activeId)

  // Tabs shrink to an ellipsis floor instead of scrolling. Tabs beyond the
  // last whole floor are hidden and remain reachable through the menu.
  const tabsClipped = (): boolean => hiddenTabIds().size > 0
  // A clipped tab's indicator would otherwise vanish with the tab; surface
  // the aggregate on the all-tabs trigger so attention stays discoverable.
  const clippedIndicator = (): PanelIndicator | undefined =>
    aggregatePanelIndicators(
      props.panels
        .filter((panel) => hiddenTabIds().has(panel.id) && panel.id !== props.activeId)
        .map((panel) => panel.indicator?.()),
    )
  const [overflowOpen, setOverflowOpen] = createSignal(false)
  let root!: HTMLDivElement
  let overflowRoot: HTMLDivElement | undefined
  let overflowButton: HTMLButtonElement | undefined
  const measureTabs = (): void => {
    const tablist = root.querySelector<HTMLElement>('[role="tablist"]')
    const tab = tablist?.querySelector<HTMLElement>('[role="tab"]')
    if (tablist === null || tab === null || tab === undefined) {
      if (hiddenTabIds().size > 0) setHiddenTabIds(new Set<string>())
      return
    }
    const count = props.panels.length
    const gap = Number.parseFloat(getComputedStyle(tablist).columnGap) || 0
    const floor = Number.parseFloat(getComputedStyle(tab).minWidth) || 64
    const actions = root.querySelector<HTMLElement>('.dock-zone-actions')
    const actionGap = actions === null ? 0 : Number.parseFloat(getComputedStyle(actions).columnGap) || 0
    const overflowWidth = overflowRoot !== undefined && root.contains(overflowRoot)
      ? overflowRoot.getBoundingClientRect().width + actionGap
      : 0
    const widthWithoutOverflow = tablist.clientWidth + overflowWidth
    const allFloorsWidth = count * floor + Math.max(0, count - 1) * gap
    const visibleCount = allFloorsWidth <= widthWithoutOverflow + 1
      ? count
      : Math.max(1, Math.min(count, Math.floor((tablist.clientWidth + gap) / (floor + gap))))
    const visibleIds = new Set(props.panels.slice(0, visibleCount).map((panel) => panel.id))
    if (props.activeId !== undefined && !visibleIds.has(props.activeId)) {
      const last = props.panels[visibleCount - 1]
      if (last !== undefined) visibleIds.delete(last.id)
      visibleIds.add(props.activeId)
    }
    const next = new Set(props.panels.filter((panel) => !visibleIds.has(panel.id)).map((panel) => panel.id))
    const previous = hiddenTabIds()
    if (previous.size === next.size && [...previous].every((id) => next.has(id))) return
    setHiddenTabIds(next)
    queueMicrotask(measureTabs)
  }
  onMount(() => {
    const tablist = root.querySelector('[role="tablist"]')
    if (tablist === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureTabs)
    observer.observe(tablist)
    onCleanup(() => observer.disconnect())
  })
  // Panel and active-tab changes can alter complete-tab fit without resizing
  // the strip itself, which the observer cannot see.
  createEffect(on([() => props.panels, () => props.activeId], () => queueMicrotask(measureTabs)))
  // When resizing clears clipping, the hidden menu must not stay logically
  // open, or the next clip would show it without user activation.
  createEffect(() => {
    if (!tabsClipped()) setOverflowOpen(false)
  })
  createEffect(() => {
    if (!overflowOpen()) return
    const dismissOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || overflowRoot?.contains(event.target) !== true) setOverflowOpen(false)
    }
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOverflowOpen(false)
      overflowButton?.focus()
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    onCleanup(() => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
    })
  })

  return (
    <div
      ref={root}
      class="dock-zone-section"
      data-testid={`dock-zone-section-${props.zone}-${props.section}`}
      data-section={props.section}
      style={props.share === undefined ? undefined : { flex: `${props.share} 1 0%` }}
    >
      <ProductTabs
        class="dock-zone-tabs"
        ariaLabel={props.label}
        selectedId={props.activeId}
        onSelect={props.onActivate}
        tabs={tabs()}
        trailing={
          <div class="dock-zone-actions">
            <Show when={tabsClipped()}>
              <div ref={overflowRoot} class="dock-zone-overflow">
                <button
                  ref={overflowButton}
                  class="shell-panel-header-action"
                  data-testid="dock-zone-overflow-button"
                  data-tooltip-label={overflowOpen() ? undefined : message('shell.chrome.allTabs')}
                  aria-label={clippedIndicator() === undefined
                    ? message('shell.chrome.allZoneTabs', { zone: props.label })
                    : message('shell.chrome.allZoneTabsWithIndicator', {
                        zone: props.label,
                        indicator: clippedIndicator()!.label,
                      })}
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen()}
                  onClick={() => setOverflowOpen((open) => !open)}
                >
                  <Icon icon={ChevronDown} />
                  <Show when={clippedIndicator()} keyed>{(indicator) => <PanelIndicatorBadge indicator={indicator} />}</Show>
                </button>
                <Show when={overflowOpen()}>
                  <div class="lens-menu dock-zone-overflow-menu" data-testid="dock-zone-overflow-menu" role="menu" aria-label={message('shell.chrome.zoneTabs', { zone: props.label })}>
                    <For each={props.panels}>{(panel) => (
                      <button
                        role="menuitemradio"
                        aria-checked={panel.id === props.activeId}
                        onClick={() => {
                          props.onActivate(panel.id)
                          setOverflowOpen(false)
                        }}
                      >
                        <strong>{panel.title}</strong>
                        <Show when={activePanelIndicator(panel)} keyed>{(indicator) => <PanelIndicatorBadge indicator={indicator} />}</Show>
                      </button>
                    )}</For>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={active()?.headerAction} keyed>{(action) => (
              <button class="shell-panel-header-action" data-testid={action.testId} onClick={() => action.run()}>
                {action.label}
              </button>
            )}</Show>
            <Show when={props.showClose}>
              <button
                class="shell-panel-close"
                data-testid="dock-zone-close"
                aria-label={props.closeLabel}
                onClick={props.onRequestClose}
              >
                <Icon icon={X} />
              </button>
            </Show>
          </div>
        }
      />
    </div>
  )
}

/**
 * Shared chrome for a tabbed dock zone hosting one or two sections, each an
 * independently tabbed DockZoneSection, with a draggable and
 * keyboard-operable divider between two rendered sections. Placement moves
 * (float, new window) live in each tab's right-click context menu rather
 * than as always-visible chrome buttons; the menu is zone-owned so every
 * section's tabs offer the same actions.
 */
export function DockZoneHost(props: {
  readonly zone: DockZoneId
  readonly ariaLabel: string
  /** Rendered sections in visual order (caller filters visibility). */
  readonly sections: readonly DockZoneSectionView[]
  /** First section's share of the zone axis when two sections render. */
  readonly split: number
  readonly onActivate: (id: string) => void
  readonly onSplitChange: (split: number) => void
  readonly onRequestClose: () => void
  readonly onOpenWindow?: ((id: string) => void) | undefined
  readonly onFloat?: ((id: string) => void) | undefined
}) {
  const message = useAppMessage()
  let zoneRoot!: HTMLElement
  const allPanels = (): readonly PanelDescriptor[] => props.sections.flatMap((section) => section.panels)
  // Rendered views placed at their STATE section index, with undefined at
  // indexes whose section currently has nothing visible. Rendering these
  // fixed slots (instead of the compressed rendered array) keeps a later
  // section's DOM alive while an earlier section hides and returns.
  const sectionSlots = (): readonly (DockZoneSectionView | undefined)[] => {
    const slots: (DockZoneSectionView | undefined)[] = []
    for (const view of props.sections) slots[view.section] = view
    return Array.from(slots, (view) => view)
  }
  const renderedCount = (): number => props.sections.length
  const firstRenderedSection = (): number | undefined => props.sections[0]?.section

  // Placement moves (float, new window) for one tab's panel, offered through
  // the shared styled context menu instead of always-visible chrome buttons.
  const [placementMenu, setPlacementMenu] = createSignal<{
    readonly panel: PanelDescriptor
    readonly x: number
    readonly y: number
  }>()
  const placementMenuGroups = (panel: PanelDescriptor): readonly ResolvedMenuGroup[] => {
    const items: MenuItem[] = []
    if (props.onFloat !== undefined && panel.allowedPlacements.includes('floating')) {
      items.push({ id: 'panel.float', label: message('shell.chrome.float'), action: { kind: 'host', action: 'panel.float' } })
    }
    if (props.onOpenWindow !== undefined && panel.allowedPlacements.includes('window')) {
      items.push({ id: 'panel.openWindow', label: message('shell.chrome.moveToNewWindow'), action: { kind: 'host', action: 'panel.openWindow' } })
    }
    return items.length === 0 ? [] : [{ group: 'panel-placement', items }]
  }
  const openPlacementMenu = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    // Only the zone's own tabs own this menu: panel bodies (and any tab
    // strips nested inside them) keep their own context-menu behavior, and
    // trailing header actions or all-tabs overflow entries keep the native
    // event rather than opening a menu for a panel the user did not click.
    if (event.target.closest('[role="tabpanel"]') !== null) return
    const tab = event.target.closest('[role="tab"]')
    if (tab === null || tab.closest('[role="tablist"]') === null) return
    const panel = allPanels().find((candidate) => candidate.id === tab.getAttribute('data-tab-id'))
    if (panel === undefined) return
    const groups = placementMenuGroups(panel)
    if (groups.length === 0) return
    event.preventDefault()
    // A keyboard-opened menu (context-menu key / Shift+F10) carries no
    // pointer position; anchor it to the tab it acts on instead.
    const keyboard = event.clientX === 0 && event.clientY === 0
    const anchor = keyboard ? tab.getBoundingClientRect() : undefined
    setPlacementMenu({
      panel,
      x: anchor === undefined ? event.clientX : anchor.left + 8,
      y: anchor === undefined ? event.clientY : anchor.bottom - 2,
    })
  }
  const focusPanelTab = (panelId: string): void => {
    zoneRoot.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(panelId)}"]`)?.focus()
  }
  const invokePlacementMenu = (panel: PanelDescriptor, item: MenuActionItem): void => {
    setPlacementMenu(undefined)
    if (item.id === 'panel.float') props.onFloat?.(panel.id)
    else if (item.id === 'panel.openWindow') props.onOpenWindow?.(panel.id)
  }

  return (
    <section
      ref={zoneRoot}
      class="dock-zone"
      data-testid={`dock-zone-${props.zone}`}
      data-zone={props.zone}
      aria-label={props.ariaLabel}
      onContextMenu={openPlacementMenu}
    >
      {/* Index (not For): section views are recomputed objects, and keying
          by state index keeps a section's DOM alive across layout updates,
          including while the other section has nothing visible. */}
      <Index each={sectionSlots()}>{(slot, index) => (
        <Show when={slot() !== undefined}>
          <Show when={index > 0 && renderedCount() > 1}>
            <DockSectionDivider
              zone={props.zone}
              zoneLabel={props.ariaLabel}
              split={props.split}
              onSplitChange={props.onSplitChange}
            />
          </Show>
          <DockZoneSection
            zone={props.zone}
            label={renderedCount() < 2
              ? props.ariaLabel
              : message(`shell.chrome.section.${props.zone === 'bottom'
                ? index === 0 ? 'left' : 'right'
                : index === 0 ? 'upper' : 'lower'}`, { zone: props.ariaLabel })}
            section={index}
            panels={slot()?.panels ?? []}
            activeId={slot()?.activeId}
            share={renderedCount() < 2 ? undefined : index === 0 ? props.split : 1 - props.split}
            showClose={firstRenderedSection() === index}
            closeLabel={message('shell.chrome.closeZone', { zone: props.ariaLabel })}
            menuOpen={() => placementMenu() !== undefined}
            onActivate={props.onActivate}
            onRequestClose={props.onRequestClose}
          />
        </Show>
      )}</Index>
      <Show when={placementMenu()} keyed>{(menu) => (
        <ContextMenu
          menu={{ x: menu.x, y: menu.y, worldX: 0, worldY: 0, get groups() { return placementMenuGroups(menu.panel) } }}
          onInvoke={(item) => invokePlacementMenu(menu.panel, item)}
          onClose={(reason) => {
            setPlacementMenu(undefined)
            if (reason === 'escape') focusPanelTab(menu.panel.id)
          }}
        />
      )}</Show>
    </section>
  )
}

export function FloatingPanelHost(props: {
  readonly panel: PanelDescriptor
  readonly index: number
  readonly onDock: () => void
  readonly onOpenWindow?: (() => void) | undefined
}) {
  const message = useAppMessage()
  const [position, setPosition] = createSignal({
    x: Math.max(8, Math.min(window.innerWidth - 368, window.innerWidth - 720 + props.index * 28)),
    y: Math.max(8, Math.min(window.innerHeight - 448, 204 + props.index * 28)),
  })
  let disposeDrag: (() => void) | undefined
  const beginDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target as Element | null)?.closest('button')) return
    event.preventDefault()
    const start = position()
    const origin = { x: event.clientX, y: event.clientY }
    const move = (next: PointerEvent): void => {
      setPosition({
        x: Math.max(8, Math.min(window.innerWidth - 360, start.x + next.clientX - origin.x)),
        y: Math.max(8, Math.min(window.innerHeight - 80, start.y + next.clientY - origin.y)),
      })
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      disposeDrag = undefined
    }
    disposeDrag?.()
    disposeDrag = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  onCleanup(() => disposeDrag?.())
  // Placement moves (dock, new window) live in the header's context menu;
  // Dock stays as the one always-visible chrome action.
  const [placementMenu, setPlacementMenu] = createSignal<{
    readonly x: number
    readonly y: number
  }>()
  let dockButton: HTMLButtonElement | undefined
  const placementMenuGroups = (): readonly ResolvedMenuGroup[] => {
    const items: MenuItem[] = [
      { id: 'panel.dock', label: message('shell.chrome.dock'), action: { kind: 'host', action: 'panel.dock' } },
    ]
    if (props.onOpenWindow !== undefined) {
      items.push({ id: 'panel.openWindow', label: message('shell.chrome.moveToNewWindow'), action: { kind: 'host', action: 'panel.openWindow' } })
    }
    return [{ group: 'panel-placement', items }]
  }
  const openPlacementMenu = (event: MouseEvent): void => {
    event.preventDefault()
    // The menu must not open over a panel still moving with the pointer.
    disposeDrag?.()
    // A keyboard-opened menu (context-menu key / Shift+F10 on a focused
    // header button) carries no pointer position; anchor it to the header.
    const keyboard = event.clientX === 0 && event.clientY === 0
    const anchor = keyboard ? (event.currentTarget as Element).getBoundingClientRect() : undefined
    setPlacementMenu({
      x: anchor === undefined ? event.clientX : anchor.left + 8,
      y: anchor === undefined ? event.clientY : anchor.bottom - 2,
    })
  }
  const invokePlacementMenu = (item: MenuActionItem): void => {
    setPlacementMenu(undefined)
    if (item.id === 'panel.dock') props.onDock()
    else if (item.id === 'panel.openWindow') props.onOpenWindow?.()
  }
  return (
    <section
      class="floating-panel-window"
      classList={{ 'floating-panel-menu-open': placementMenu() !== undefined }}
      data-testid="floating-panel"
      data-panel={props.panel.id}
      style={{ left: `${position().x}px`, top: `${position().y}px` }}
    >
      <header class="floating-panel-header" onPointerDown={beginDrag} onContextMenu={openPlacementMenu}>
        <h2>
          {props.panel.title}
          <Show when={activePanelIndicator(props.panel)} keyed>
            {(indicator) => <PanelIndicatorBadge indicator={indicator} />}
          </Show>
        </h2>
        <button ref={dockButton} class="shell-panel-header-action" onClick={props.onDock}>{message('shell.chrome.dock')}</button>
      </header>
      <div class="floating-panel-content">
        {props.panel.component({ placement: 'floating', requestClose: props.onDock })}
      </div>
      <Show when={placementMenu()} keyed>{(menu) => (
        <ContextMenu
          menu={{ x: menu.x, y: menu.y, worldX: 0, worldY: 0, get groups() { return placementMenuGroups() } }}
          onInvoke={invokePlacementMenu}
          onClose={(reason) => {
            setPlacementMenu(undefined)
            if (reason === 'escape') dockButton?.focus()
          }}
        />
      )}</Show>
    </section>
  )
}
