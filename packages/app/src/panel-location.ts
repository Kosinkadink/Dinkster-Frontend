/**
 * The one shell move boundary (#105): every panel transition between dock
 * zones, floating, and window placement validates and commits here, in one
 * call. PanelRegistry owns descriptors, placement legality, and whether a
 * panel is floating/windowed; DockLayout owns durable zone membership, tab
 * order, active tab, and open state. A floating or windowed panel keeps its
 * zone membership - the tab simply does not render while the panel is away,
 * and returning restores the saved spot.
 */
import {
  canDockInZone,
  sectionOf,
  zoneOf,
  zonePlacement,
  type DockLayout,
  type DockSectionState,
  type DockZoneId,
  defaultZoneOf,
} from './dock-layout.js'
import type { PanelDescriptor, PanelRegistry } from './panels.js'

export type PanelMoveTarget =
  | { readonly kind: 'zone'; readonly zone: DockZoneId; readonly index?: number; readonly section?: number }
  | { readonly kind: 'floating' }
  | { readonly kind: 'window' }

const storedDockZone = (
  panels: PanelRegistry,
  layout: DockLayout,
  id: string,
): DockZoneId | undefined => {
  const desc = panels.get(id)
  if (desc === undefined) return undefined
  const zone = zoneOf(layout.effective(), id)
  return zone !== undefined && canDockInZone(desc.allowedPlacements, zone) ? zone : undefined
}

/** The zone currently hosting a docked panel; detached placement suppresses it. */
export function panelDockZone(
  panels: PanelRegistry,
  layout: DockLayout,
  id: string,
): DockZoneId | undefined {
  const placement = panels.placementOf(id)
  return placement === 'floating' || placement === 'window'
    ? undefined
    : storedDockZone(panels, layout, id)
}

/**
 * Move a panel; refused (false) when the panel is unknown or the target is
 * not in its allowedPlacements. Refusal mutates nothing.
 */
export function movePanel(
  panels: PanelRegistry,
  layout: DockLayout,
  id: string,
  target: PanelMoveTarget,
): boolean {
  const desc = panels.get(id)
  if (!desc) return false
  if (target.kind === 'zone') {
    if (!canDockInZone(desc.allowedPlacements, target.zone)) return false
    // Clear any floating/window override before committing the durable zone.
    // setPlacement refuses only placements outside allowedPlacements, which
    // canDockInZone already ruled out.
    if (!panels.setPlacement(id, zonePlacement(target.zone))) return false
    // Without an explicit section, a panel already in the zone keeps its
    // section and tab position (a floating/window return restores the saved
    // spot) instead of being re-appended at the end of the first section.
    const effective = layout.effective()
    let section = target.section
    let index = target.index
    if (section === undefined) {
      const saved = sectionOf(effective, id)
      if (saved !== undefined && saved.zone === target.zone) {
        section = saved.section
        index ??= effective.zones[target.zone].sections[saved.section]!.tabs.indexOf(id)
      }
    }
    layout.dock(id, target.zone, index, section)
    return true
  }
  return panels.setPlacement(id, target.kind)
}

/** Open one panel as the active tab, or close the zone that currently hosts it. */
export function setPanelOpen(
  panels: PanelRegistry,
  layout: DockLayout,
  id: string,
  zone: DockZoneId,
  open: boolean,
): boolean {
  if (open) {
    const placement = panels.placementOf(id)
    if (placement === 'floating' || placement === 'window') return true
    return movePanel(panels, layout, id, { kind: 'zone', zone })
  }
  if (!zoneSectionsView(panels, layout, zone).some((section) => section.activeId === id)) return false
  layout.setOpen(zone, false)
  return true
}

export interface ZoneTabsView {
  /** Renderable panels in tab order. */
  readonly panels: readonly PanelDescriptor[]
  /** The tab whose body renders; undefined only when nothing is visible. */
  readonly activeId: string | undefined
}

export interface ZoneSectionView extends ZoneTabsView {
  /** Index of this section in the zone's DockZoneState.sections. */
  readonly section: number
}

const sectionTabsView = (
  panels: PanelRegistry,
  zone: DockZoneId,
  section: DockSectionState,
  isHidden: (id: string) => boolean,
): ZoneTabsView => {
  const visible = section.tabs.flatMap((id) => {
    const desc = panels.get(id)
    const placement = panels.placementOf(id)
    return desc !== undefined
      && placement !== 'floating'
      && placement !== 'window'
      && canDockInZone(desc.allowedPlacements, zone)
      && !isHidden(id)
      && (desc.when?.() ?? true)
      ? [desc]
      : []
  })
  const active = section.activeTab
  return {
    panels: visible,
    activeId: visible.some((desc) => desc.id === active) ? active : visible[0]?.id,
  }
}

/**
 * The zone's renderable projection per section - the ONE place membership
 * becomes tab rows. A stored tab renders only while its panel is
 * registered, allowed in that zone, not floating/windowed/detached, and
 * visible per its `when` gate. Hidden or unregistered ids keep their stored
 * place for when they come back; a section with nothing visible does not
 * render at all (but keeps its stored membership).
 *
 * The stored active tab stays authoritative: while it is hidden, the first
 * visible tab of its section renders as active WITHOUT persisting a
 * reselection, so the stored choice becomes active again the moment its
 * panel reappears.
 */
export function zoneSectionsView(
  panels: PanelRegistry,
  layout: DockLayout,
  zone: DockZoneId,
  isHidden: (id: string) => boolean = () => false,
): readonly ZoneSectionView[] {
  const state = layout.effective().zones[zone]
  return state.sections
    .map((section, index) => ({ section: index, ...sectionTabsView(panels, zone, section, isHidden) }))
    .filter((view) => view.panels.length > 0)
}

/**
 * The zone's renderable panels flattened across sections, with the first
 * visible section's active tab. Zone-level consumers (activity bar pressed
 * state, indicator aggregation, the active-panel attribute) use this;
 * rendering uses zoneSectionsView.
 */
export function zoneTabsView(
  panels: PanelRegistry,
  layout: DockLayout,
  zone: DockZoneId,
  isHidden: (id: string) => boolean = () => false,
): ZoneTabsView {
  const sections = zoneSectionsView(panels, layout, zone, isHidden)
  return {
    panels: sections.flatMap((section) => section.panels),
    activeId: sections[0]?.activeId,
  }
}

/**
 * Return a floating or windowed panel to its saved zone spot: the zone that
 * still holds its tab, else its descriptor's default zone.
 */
export function returnPanelToZone(
  panels: PanelRegistry,
  layout: DockLayout,
  id: string,
): boolean {
  const desc = panels.get(id)
  if (!desc) return false
  const zone = storedDockZone(panels, layout, id) ?? defaultZoneOf(desc.placement)
  if (zone === undefined) return false
  return movePanel(panels, layout, id, { kind: 'zone', zone })
}
