/**
 * Dock zone layout state (#105, #169): the left, right, and bottom shell
 * regions as tabbed dock zones. Each zone hosts one or two independently
 * tabbed SECTIONS (stacked halves for the side zones, side-by-side halves
 * for the bottom zone), each with an ordered tab list and one active body,
 * plus a zone-level open/closed switch and a split ratio between the two
 * sections.
 *
 * This module is the pure state layer only: section membership, tab order,
 * active tabs, split, and open state. It persists as ONE versioned,
 * project-scoped setting validated at the read boundary (FR11) - malformed
 * input falls back, never crashes, never rewrites the stored value.
 * Panel-id validity stays a render-time concern (zoneTabsView in
 * panel-location.ts), matching ShellLayout: panels register after this
 * state is constructed, so a stored id whose panel is gone simply hosts
 * nothing.
 *
 * Placement legality keeps the existing PanelDescriptor vocabulary: a panel
 * may dock in a zone when the zone's placement (left -> 'dock',
 * right -> 'rail', bottom -> 'bottom') is in its allowedPlacements.
 * PanelRegistry.setPlacement remains the mutation gate for floating/window
 * moves; this state never contains floating or windowed panels.
 *
 * Section invariants: a zone holds one or two sections; only a lone
 * section may be empty; a second section that loses its last tab is
 * dropped; a zone whose tabs all leave closes.
 *
 * Binding follows the ShellLayout loop-breaker: `seen` holds the encoded
 * value last observed in settings. Writers update `seen` BEFORE
 * settings.set so their own changed tick pulls nothing; an external write
 * (settings dialog, another shell instance) changes the stored value first,
 * so the tick pulls it into the live signal.
 */
import { createSignal, type Signal } from '@dinkster/core'
import type { PanelPlacement } from './panels.js'
import type { SettingsRegistry } from './settings.js'

export type DockZoneId = 'left' | 'right' | 'bottom'

export const DOCK_ZONE_IDS: readonly DockZoneId[] = ['left', 'right', 'bottom']

export const DOCK_LAYOUT_SETTING = 'shell.dock.layout'

/** Zones host at most this many sections. */
export const MAX_ZONE_SECTIONS = 2

/** Split clamp bounds: the first section's share of the zone axis. */
export const MIN_ZONE_SPLIT = 0.1
export const MAX_ZONE_SPLIT = 0.9
export const DEFAULT_ZONE_SPLIT = 0.5

export interface DockSectionState {
  /** Panel ids in tab order. A panel id appears in at most one section. */
  readonly tabs: readonly string[]
  /** The section's one visible body; undefined only when the section is empty. */
  readonly activeTab: string | undefined
}

export interface DockZoneState {
  /** One or two independently tabbed sections, in visual order. */
  readonly sections: readonly DockSectionState[]
  /** First section's share of the zone axis when two sections render. */
  readonly split: number
  readonly open: boolean
}

export interface PanelDockState {
  readonly zones: Readonly<Record<DockZoneId, DockZoneState>>
}

const EMPTY_SECTION: DockSectionState = { tabs: [], activeTab: undefined }

const EMPTY_ZONE: DockZoneState = { sections: [EMPTY_SECTION], split: DEFAULT_ZONE_SPLIT, open: false }

export const emptyDockState = (): PanelDockState => ({
  zones: { left: EMPTY_ZONE, right: EMPTY_ZONE, bottom: EMPTY_ZONE },
})

/** All panel ids in a zone, section order then tab order. */
export const zoneTabs = (zone: DockZoneState): readonly string[] =>
  zone.sections.flatMap((section) => section.tabs)

export const clampZoneSplit = (split: number): number =>
  Math.min(MAX_ZONE_SPLIT, Math.max(MIN_ZONE_SPLIT, split))

/** The PanelDescriptor placement a zone corresponds to. */
export const zonePlacement = (zone: DockZoneId): PanelPlacement =>
  zone === 'left' ? 'dock' : zone === 'right' ? 'rail' : 'bottom'

/** Legality gate for docking moves; callers check before mutating. */
export const canDockInZone = (
  allowedPlacements: readonly PanelPlacement[],
  zone: DockZoneId,
): boolean => allowedPlacements.includes(zonePlacement(zone))

/** The zone whose tab lists hold `id`, if any. */
export const zoneOf = (state: PanelDockState, id: string): DockZoneId | undefined =>
  DOCK_ZONE_IDS.find((zone) => zoneTabs(state.zones[zone]).includes(id))

/** The zone and section index holding `id`, if any. */
export const sectionOf = (
  state: PanelDockState,
  id: string,
): { readonly zone: DockZoneId; readonly section: number } | undefined => {
  for (const zone of DOCK_ZONE_IDS) {
    const section = state.zones[zone].sections.findIndex((s) => s.tabs.includes(id))
    if (section !== -1) return { zone, section }
  }
  return undefined
}

const withZone = (
  state: PanelDockState,
  zone: DockZoneId,
  next: DockZoneState,
): PanelDockState => ({ zones: { ...state.zones, [zone]: next } })

/** Active tab after removing `id`: the next tab, else the previous one. */
const activeAfterRemoval = (
  tabs: readonly string[],
  removed: string,
  active: string | undefined,
): string | undefined => {
  const remaining = tabs.filter((tab) => tab !== removed)
  if (active !== removed) return active
  const index = tabs.indexOf(removed)
  return remaining[Math.min(index, remaining.length - 1)]
}

const removeFromZone = (state: PanelDockState, id: string): PanelDockState => {
  const at = sectionOf(state, id)
  if (at === undefined) return state
  const current = state.zones[at.zone]
  const section = current.sections[at.section]!
  const tabs = section.tabs.filter((tab) => tab !== id)
  // A second section that loses its last tab is dropped; the split resets
  // so a later re-split starts balanced.
  const sections = tabs.length === 0 && current.sections.length > 1
    ? current.sections.filter((_, index) => index !== at.section)
    : current.sections.map((existing, index) =>
        index === at.section
          ? { tabs, activeTab: activeAfterRemoval(section.tabs, id, section.activeTab) }
          : existing,
      )
  const empty = sections.every((existing) => existing.tabs.length === 0)
  return withZone(state, at.zone, {
    sections,
    split: sections.length < current.sections.length ? DEFAULT_ZONE_SPLIT : current.split,
    open: empty ? false : current.open,
  })
}

/**
 * Dock a panel into a zone section at `index` (clamped; appended when
 * omitted), removing it from any other spot. `section` past the current
 * section count creates a new trailing section when the zone has room;
 * otherwise it clamps to the last section. When `section` is omitted the
 * panel keeps its current section if it is already in the zone, else it
 * joins the first section. The docked panel becomes its section's active
 * tab and the zone opens. Pure structural move: placement legality is the
 * caller's gate (canDockInZone).
 */
export function dockPanelTab(
  state: PanelDockState,
  id: string,
  zone: DockZoneId,
  index?: number,
  section?: number,
): PanelDockState {
  const origin = sectionOf(state, id)
  // Moving the sole tab of a section within that same section cannot
  // change the layout; return unchanged rather than letting the removal
  // collapse the section out from under the reinsertion.
  if (
    origin !== undefined &&
    origin.zone === zone &&
    (section === undefined || section === origin.section) &&
    state.zones[zone].sections[origin.section]!.tabs.length === 1
  ) {
    return setZoneOpen(state, zone, true)
  }
  const removed = removeFromZone(state, id)
  const current = removed.zones[zone]
  let target = section ?? (origin?.zone === zone ? origin.section : 0)
  // Removal may have collapsed the origin section in this zone; section
  // indices past it shift down by one.
  if (
    origin?.zone === zone &&
    removed.zones[zone].sections.length < state.zones[zone].sections.length &&
    origin.section < target
  ) {
    target -= 1
  }
  target = Math.max(0, target)
  if (target >= current.sections.length) {
    const room = current.sections.length < MAX_ZONE_SECTIONS
    const occupied = current.sections.every((existing) => existing.tabs.length > 0)
    if (room && occupied) {
      const sections = [...current.sections, { tabs: [id], activeTab: id }]
      return withZone(removed, zone, { ...current, sections, open: true })
    }
    target = current.sections.length - 1
  }
  const into = current.sections[target]!
  const at = Math.max(0, Math.min(index ?? into.tabs.length, into.tabs.length))
  const tabs = [...into.tabs.slice(0, at), id, ...into.tabs.slice(at)]
  const sections = current.sections.map((existing, i) =>
    i === target ? { tabs, activeTab: id } : existing,
  )
  return withZone(removed, zone, { ...current, sections, open: true })
}

/** Remove a panel from whichever section holds it; an emptied zone closes. */
export function removePanelTab(state: PanelDockState, id: string): PanelDockState {
  return removeFromZone(state, id)
}

/** Make `id` its section's visible body; unknown ids are refused unchanged. */
export function activatePanelTab(
  state: PanelDockState,
  zone: DockZoneId,
  id: string,
): PanelDockState {
  const current = state.zones[zone]
  const at = current.sections.findIndex((section) => section.tabs.includes(id))
  if (at === -1 || current.sections[at]!.activeTab === id) return state
  const sections = current.sections.map((section, index) =>
    index === at ? { ...section, activeTab: id } : section,
  )
  return withZone(state, zone, { ...current, sections })
}

/** Open or close a zone; an empty zone never opens. */
export function setZoneOpen(
  state: PanelDockState,
  zone: DockZoneId,
  open: boolean,
): PanelDockState {
  const current = state.zones[zone]
  const next = open && zoneTabs(current).length > 0
  if (next === current.open) return state
  return withZone(state, zone, { ...current, open: next })
}

/** Set the first section's share of a zone's axis, clamped. */
export function setZoneSplit(
  state: PanelDockState,
  zone: DockZoneId,
  split: number,
): PanelDockState {
  const current = state.zones[zone]
  const next = clampZoneSplit(split)
  if (next === current.split) return state
  return withZone(state, zone, { ...current, split: next })
}

/** The registry facts membership derivation needs from a registered panel. */
export interface DockablePanel {
  readonly id: string
  /** The descriptor's DEFAULT placement, not any live override. */
  readonly placement: PanelPlacement
  readonly allowedPlacements: readonly PanelPlacement[]
  readonly order: number
}

/** The zone a default placement maps to; undefined for modal/floating/window. */
export const defaultZoneOf = (placement: PanelPlacement): DockZoneId | undefined =>
  placement === 'dock' ? 'left' : placement === 'rail' ? 'right' : placement === 'bottom' ? 'bottom' : undefined

/** Zones a fresh (never-persisted) layout opens once they gain tabs. */
const OPEN_BY_DEFAULT: Readonly<Record<DockZoneId, boolean>> = { left: false, right: true, bottom: false }

/**
 * Membership as the shell uses it: the stored state plus every registered
 * zone-default panel that is stored in no legal zone, appended to its
 * default zone's first section in `order`. A registered panel is removed
 * from stored zones its descriptor no longer permits; an unregistered id
 * keeps its place so registration order never destroys persisted
 * membership. A fresh state (never persisted) opens zones per
 * OPEN_BY_DEFAULT once they have tabs; a persisted open/closed choice is
 * respected, so newly registered panels never pop a closed zone open.
 */
export function effectiveDockState(
  stored: PanelDockState,
  panels: readonly DockablePanel[],
  fresh: boolean,
): PanelDockState {
  const registered = new Map(panels.map((panel) => [panel.id, panel]))
  let next = stored
  for (const zone of DOCK_ZONE_IDS) {
    for (const id of zoneTabs(stored.zones[zone])) {
      const panel = registered.get(id)
      if (panel !== undefined && !canDockInZone(panel.allowedPlacements, zone)) {
        next = removeFromZone(next, id)
      }
    }
  }
  const placed = new Set(DOCK_ZONE_IDS.flatMap((zone) => zoneTabs(next.zones[zone])))
  const appended = new Map<DockZoneId, string[]>()
  for (const panel of [...panels].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const zone = defaultZoneOf(panel.placement)
    if (zone === undefined || !canDockInZone(panel.allowedPlacements, zone) || placed.has(panel.id)) continue
    const list = appended.get(zone) ?? []
    list.push(panel.id)
    appended.set(zone, list)
  }
  for (const zone of DOCK_ZONE_IDS) {
    const current = next.zones[zone]
    const extra = appended.get(zone) ?? []
    const open = fresh
      ? OPEN_BY_DEFAULT[zone] && zoneTabs(current).length + extra.length > 0
      : current.open
    if (extra.length === 0 && open === current.open) continue
    const first = current.sections[0]!
    const tabs = extra.length === 0 ? first.tabs : [...first.tabs, ...extra]
    const sections = extra.length === 0
      ? current.sections
      : current.sections.map((section, index) =>
          index === 0 ? { tabs, activeTab: first.activeTab ?? tabs[0] } : section,
        )
    next = withZone(next, zone, { ...current, sections, open })
  }
  return next
}

export const encodeDockState = (state: PanelDockState): string =>
  JSON.stringify({ v: 2, zones: state.zones })

const decodeSectionTabs = (value: unknown, claimed: Set<string>): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  if (!value.every((tab): tab is string => typeof tab === 'string' && tab.length > 0)) return undefined
  const tabs: string[] = []
  for (const tab of value) {
    if (claimed.has(tab)) continue
    claimed.add(tab)
    tabs.push(tab)
  }
  return tabs
}

const decodeSection = (value: unknown, claimed: Set<string>): DockSectionState | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const tabs = decodeSectionTabs(row['tabs'], claimed)
  if (tabs === undefined) return undefined
  const active = row['activeTab']
  if (active !== undefined && typeof active !== 'string') return undefined
  const activeTab = typeof active === 'string' && tabs.includes(active) ? active : tabs[0]
  return { tabs, activeTab }
}

const decodeZoneV1 = (value: unknown, claimed: Set<string>): DockZoneState | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row['open'] !== 'boolean') return undefined
  const section = decodeSection(value, claimed)
  if (section === undefined) return undefined
  return {
    sections: [section],
    split: DEFAULT_ZONE_SPLIT,
    open: row['open'] && section.tabs.length > 0,
  }
}

const decodeZoneV2 = (value: unknown, claimed: Set<string>): DockZoneState | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (typeof row['open'] !== 'boolean') return undefined
  const sectionsRaw = row['sections']
  if (!Array.isArray(sectionsRaw)) return undefined
  if (sectionsRaw.length < 1 || sectionsRaw.length > MAX_ZONE_SECTIONS) return undefined
  const decoded: DockSectionState[] = []
  for (const sectionRaw of sectionsRaw) {
    const section = decodeSection(sectionRaw, claimed)
    if (section === undefined) return undefined
    decoded.push(section)
  }
  // Duplicate-id repair may have emptied a section; only a lone section
  // may be empty.
  const nonEmpty = decoded.filter((section) => section.tabs.length > 0)
  const sections = nonEmpty.length > 0 ? nonEmpty : [EMPTY_SECTION]
  const split = typeof row['split'] === 'number' && Number.isFinite(row['split'])
    ? clampZoneSplit(row['split'])
    : DEFAULT_ZONE_SPLIT
  const tabCount = sections.reduce((sum, section) => sum + section.tabs.length, 0)
  return { sections, split, open: row['open'] && tabCount > 0 }
}

/**
 * Read-boundary decode (FR11): anything structurally wrong yields undefined
 * so the caller falls back. Accepts the current v2 envelope and the
 * pre-section v1 envelope, which loads as one section per zone. Duplicate
 * ids keep their first spot; the active-tab, lone-empty-section, and
 * empty-zone-closed invariants are restored; the split clamps.
 */
export function decodeDockState(raw: string): PanelDockState | undefined {
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const envelope = parsed as Record<string, unknown>
  const version = envelope['v']
  if (version !== 1 && version !== 2) return undefined
  const zonesRaw = envelope['zones']
  if (zonesRaw === null || typeof zonesRaw !== 'object') return undefined
  const zones = {} as Record<DockZoneId, DockZoneState>
  const claimed = new Set<string>()
  for (const zone of DOCK_ZONE_IDS) {
    const value = (zonesRaw as Record<string, unknown>)[zone]
    const decoded = version === 1 ? decodeZoneV1(value, claimed) : decodeZoneV2(value, claimed)
    if (decoded === undefined) return undefined
    zones[zone] = decoded
  }
  return { zones }
}

/**
 * Live dock state bound to the settings machinery. Construction never
 * writes: until the first mutation the stored value stays empty and the
 * shell renders `effective()`, which derives default membership from the
 * registered panels. Mutations rebase on the effective state, so the first
 * persisted value already contains the derived membership.
 */
export class DockLayout {
  readonly state: Signal<PanelDockState>

  /** Encoded value last observed in settings - the loop breaker. */
  private seen: string

  /**
   * Whether a VALID persisted value governs the state. Tracked apart from
   * `seen`: malformed stored text still participates in loop-breaking but
   * must not count as persistence, or it would silently drop the fresh
   * zone-open defaults.
   */
  private persisted: boolean

  /** True while applying a settings-driven fallback that must not persist. */
  private muted = false

  constructor(
    private readonly settings: SettingsRegistry,
    private readonly panelsProvider: () => readonly DockablePanel[] = () => [],
  ) {
    settings.register({
      id: DOCK_LAYOUT_SETTING,
      name: 'Dock layout',
      category: 'shell',
      type: 'string',
      defaultValue: '',
      projectScoped: true,
    })
    const stored = settings.get<string>(DOCK_LAYOUT_SETTING)
    this.seen = stored
    const decoded = decodeDockState(stored)
    this.persisted = decoded !== undefined
    this.state = createSignal(decoded ?? emptyDockState())
    this.state.subscribe((next) => this.write(next))
    settings.changed.subscribe(() => this.pull())
  }

  /** True until a mutation persists; while fresh, zone-open defaults apply. */
  fresh(): boolean {
    return !this.persisted
  }

  /** The state the shell renders and mutations rebase on. */
  effective(): PanelDockState {
    return effectiveDockState(this.state.get(), this.panelsProvider(), this.fresh())
  }

  dock(id: string, zone: DockZoneId, index?: number, section?: number): void {
    this.state.set(dockPanelTab(this.effective(), id, zone, index, section))
  }

  remove(id: string): void {
    this.state.set(removePanelTab(this.effective(), id))
  }

  activate(zone: DockZoneId, id: string): void {
    this.state.set(activatePanelTab(this.effective(), zone, id))
  }

  setOpen(zone: DockZoneId, open: boolean): void {
    this.state.set(setZoneOpen(this.effective(), zone, open))
  }

  setSplit(zone: DockZoneId, split: number): void {
    this.state.set(setZoneSplit(this.effective(), zone, split))
  }

  /** Restore default zone visibility; membership and tab order stay. */
  resetOpen(): void {
    let next = this.effective()
    for (const zone of DOCK_ZONE_IDS) next = setZoneOpen(next, zone, OPEN_BY_DEFAULT[zone])
    this.state.set(next)
  }

  private write(next: PanelDockState): void {
    if (this.muted) return
    const encoded = encodeDockState(next)
    if (encoded === this.seen) return
    this.seen = encoded
    this.persisted = true
    this.settings.set(DOCK_LAYOUT_SETTING, encoded)
  }

  private pull(): void {
    const value = this.settings.get<string>(DOCK_LAYOUT_SETTING)
    if (value === this.seen) return
    this.seen = value
    const decoded = decodeDockState(value)
    if (decoded !== undefined) {
      this.persisted = true
      this.state.set(decoded)
      return
    }
    // '' is the registered default, so it means a reset: return to the
    // empty base without persisting it, leaving the stored value empty (and
    // the state fresh) until the next real mutation. Anything else is
    // malformed and ignored - the prior state AND freshness both survive.
    if (value !== '') return
    this.persisted = false
    this.muted = true
    try {
      this.state.set(emptyDockState())
    } finally {
      this.muted = false
    }
  }
}
