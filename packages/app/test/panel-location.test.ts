/**
 * The one shell move boundary (#105): panel transitions between dock zones,
 * floating, and window placement validate and commit in one call. DockLayout
 * owns durable zone membership while PanelRegistry tracks floating/windowed
 * suppression.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppState } from '../src/app-state.js'
import { DockLayout, zoneTabs } from '../src/dock-layout.js'
import { movePanel, panelDockZone, returnPanelToZone, setPanelOpen, zoneSectionsView, zoneTabsView } from '../src/panel-location.js'
import { PanelRegistry, type PanelDescriptor, type PanelPlacement } from '../src/panels.js'
import { SettingsRegistry } from '../src/settings.js'

afterEach(() => vi.unstubAllGlobals())

function storage(): Storage {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage
}

const descriptor = (
  id: string,
  placement: PanelPlacement,
  allowedPlacements: readonly PanelPlacement[],
): PanelDescriptor => ({
  id,
  title: id,
  placement,
  allowedPlacements,
  order: 1,
  component: () => undefined,
})

function fixture(persisted = storage()) {
  const panels = new PanelRegistry(persisted)
  panels.register(descriptor('library', 'rail', ['rail', 'bottom', 'floating', 'window']))
  panels.register(descriptor('memory', 'rail', ['rail']))
  panels.register(descriptor('collab', 'modal', ['modal', 'floating']))
  panels.register(descriptor('backends', 'dock', ['dock', 'floating', 'window']))
  const layout = new DockLayout(new SettingsRegistry(persisted), () =>
    panels.all().map(({ id, placement, allowedPlacements, order }) =>
      ({ id, placement, allowedPlacements, order })))
  return { panels, layout }
}

describe('movePanel', () => {
  it('refuses unknown panels and illegal targets without mutating either authority', () => {
    const { panels, layout } = fixture()
    const before = layout.effective()
    expect(movePanel(panels, layout, 'ghost', { kind: 'zone', zone: 'right' })).toBe(false)
    expect(movePanel(panels, layout, 'memory', { kind: 'zone', zone: 'bottom' })).toBe(false)
    expect(movePanel(panels, layout, 'memory', { kind: 'floating' })).toBe(false)
    expect(layout.effective()).toEqual(before)
    expect(panels.placementOf('memory')).toBe('rail')
  })

  it('commits a zone move in both authorities atomically', () => {
    const { panels, layout } = fixture()
    expect(movePanel(panels, layout, 'library', { kind: 'zone', zone: 'bottom' })).toBe(true)
    expect(panels.placementOf('library')).toBe('bottom')
    expect(zoneTabs(layout.effective().zones.bottom)).toEqual(['library'])
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['memory'])
  })

  it('restores a cross-zone move from DockLayout membership in a fresh AppState', () => {
    const persisted = storage()
    vi.stubGlobal('localStorage', persisted)
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const first = new AppState()
    first.panels.register(descriptor('library', 'rail', ['rail', 'bottom', 'floating', 'window']))
    first.panels.register(descriptor('memory', 'rail', ['rail']))
    expect(movePanel(first.panels, first.dock, 'library', { kind: 'zone', zone: 'bottom' })).toBe(true)

    const restored = new AppState()
    restored.panels.register(descriptor('library', 'rail', ['rail', 'bottom', 'floating', 'window']))
    restored.panels.register(descriptor('memory', 'rail', ['rail']))
    expect(restored.panels.placementOf('library')).toBe('rail')
    expect(panelDockZone(restored.panels, restored.dock, 'library')).toBe('bottom')
    expect(zoneTabsView(restored.panels, restored.dock, 'bottom').panels.map(({ id }) => id)).toEqual(['library'])
    expect(zoneTabsView(restored.panels, restored.dock, 'right').panels.map(({ id }) => id)).toEqual(['memory'])
  })

  it('floating keeps zone membership; only the placement override changes', () => {
    const { panels, layout } = fixture()
    expect(movePanel(panels, layout, 'library', { kind: 'floating' })).toBe(true)
    expect(panels.placementOf('library')).toBe('floating')
    expect(panelDockZone(panels, layout, 'library')).toBeUndefined()
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['library', 'memory'])
  })

  it('a zone move clears a floating override so both authorities agree', () => {
    const { panels, layout } = fixture()
    movePanel(panels, layout, 'library', { kind: 'floating' })
    expect(movePanel(panels, layout, 'library', { kind: 'zone', zone: 'right' })).toBe(true)
    expect(panels.placementOf('library')).toBe('rail')
    expect(layout.effective().zones.right.sections[0]!.activeTab).toBe('library')
  })

  it('an explicit section target creates a second section and restores it after floating', () => {
    const { panels, layout } = fixture()
    expect(movePanel(panels, layout, 'memory', { kind: 'zone', zone: 'right', section: 1 })).toBe(true)
    expect(layout.effective().zones.right.sections).toHaveLength(2)
    expect(layout.effective().zones.right.sections[1]!.tabs).toEqual(['memory'])

    movePanel(panels, layout, 'library', { kind: 'floating' })
    expect(movePanel(panels, layout, 'library', { kind: 'zone', zone: 'right' })).toBe(true)
    // The saved spot is section 0; the floating round trip lands back there.
    expect(layout.effective().zones.right.sections[0]!.tabs).toEqual(['library'])
    expect(layout.effective().zones.right.sections[1]!.tabs).toEqual(['memory'])
  })
})

describe('setPanelOpen', () => {
  it('opens through the move boundary and closes only the active hosted panel', () => {
    const { panels, layout } = fixture()
    expect(setPanelOpen(panels, layout, 'backends', 'left', true)).toBe(true)
    expect(layout.effective().zones.left.sections[0]!.activeTab).toBe('backends')
    expect(layout.effective().zones.left.open).toBe(true)
    expect(setPanelOpen(panels, layout, 'memory', 'right', false)).toBe(false)
    expect(layout.effective().zones.right.open).toBe(true)
    expect(setPanelOpen(panels, layout, 'backends', 'left', false)).toBe(true)
    expect(layout.effective().zones.left.open).toBe(false)
  })

  it.each(['floating', 'window'] as const)('leaves an already open %s panel detached from its zone', (placement) => {
    const { panels, layout } = fixture()
    expect(movePanel(panels, layout, 'backends', { kind: placement })).toBe(true)
    const before = layout.effective()

    expect(setPanelOpen(panels, layout, 'backends', 'left', true)).toBe(true)
    expect(panels.placementOf('backends')).toBe(placement)
    expect(layout.effective()).toEqual(before)
  })
})

describe('returnPanelToZone', () => {
  it('restores the saved zone spot after floating', () => {
    const { panels, layout } = fixture()
    movePanel(panels, layout, 'library', { kind: 'zone', zone: 'bottom' })
    movePanel(panels, layout, 'library', { kind: 'floating' })
    expect(returnPanelToZone(panels, layout, 'library')).toBe(true)
    expect(panels.placementOf('library')).toBe('bottom')
    expect(zoneTabs(layout.effective().zones.bottom)).toEqual(['library'])
  })

  it('restores the saved tab position after a window round trip', () => {
    const { panels, layout } = fixture()
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['library', 'memory'])
    expect(movePanel(panels, layout, 'library', { kind: 'window' })).toBe(true)
    expect(panels.placementOf('library')).toBe('window')
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['library', 'memory'])
    expect(returnPanelToZone(panels, layout, 'library')).toBe(true)
    expect(panels.placementOf('library')).toBe('rail')
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['library', 'memory'])
  })

  it('returns a left-zone default panel through the boundary, keeping both authorities agreed', () => {
    const { panels, layout } = fixture()
    expect(movePanel(panels, layout, 'backends', { kind: 'window' })).toBe(true)
    expect(returnPanelToZone(panels, layout, 'backends')).toBe(true)
    expect(panels.placementOf('backends')).toBe('dock')
    expect(zoneTabs(layout.effective().zones.left)).toContain('backends')
  })

  it('falls back to the default zone when no membership was saved, and refuses zoneless defaults', () => {
    const { panels, layout } = fixture()
    movePanel(panels, layout, 'collab', { kind: 'floating' })
    expect(returnPanelToZone(panels, layout, 'collab')).toBe(false)
    expect(panels.placementOf('collab')).toBe('floating')
    expect(returnPanelToZone(panels, layout, 'library')).toBe(true)
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['library', 'memory'])
  })
})

describe('zoneTabsView', () => {
  const ids = (view: { panels: readonly PanelDescriptor[] }): string[] =>
    view.panels.map((panel) => panel.id)

  it('renders only zone-placed panels: floating/windowed membership keeps its spot but drops out', () => {
    const { panels, layout } = fixture()
    movePanel(panels, layout, 'library', { kind: 'window' })
    const view = zoneTabsView(panels, layout, 'right')
    expect(ids(view)).toEqual(['memory'])
    expect(view.activeId).toBe('memory')
    expect(zoneTabs(layout.effective().zones.right)).toEqual(['library', 'memory'])
  })

  it('hides detached panels via the caller predicate', () => {
    const { panels, layout } = fixture()
    const view = zoneTabsView(panels, layout, 'right', (id) => id === 'library')
    expect(ids(view)).toEqual(['memory'])
  })

  it('a stored id without a registered panel renders nothing and regains its place on registration', () => {
    const { panels, layout } = fixture()
    // Persist membership placing a not-yet-registered panel first.
    layout.dock('outputs', 'right', 0)
    layout.activate('right', 'library')
    expect(ids(zoneTabsView(panels, layout, 'right'))).toEqual(['library', 'memory'])

    panels.register(descriptor('outputs', 'rail', ['rail']))
    expect(ids(zoneTabsView(panels, layout, 'right'))).toEqual(['outputs', 'library', 'memory'])
  })

  it('unregistering removes the tab from the row; re-registering restores its saved spot', () => {
    const { panels, layout } = fixture()
    const unregister = panels.register(descriptor('outputs', 'rail', ['rail']))
    layout.dock('outputs', 'right', 1)
    expect(ids(zoneTabsView(panels, layout, 'right'))).toEqual(['library', 'outputs', 'memory'])

    unregister()
    expect(ids(zoneTabsView(panels, layout, 'right'))).toEqual(['library', 'memory'])

    panels.register(descriptor('outputs', 'rail', ['rail']))
    expect(ids(zoneTabsView(panels, layout, 'right'))).toEqual(['library', 'outputs', 'memory'])
  })

  it('re-registering with changed legality projects the panel into its new default zone', () => {
    const { panels, layout } = fixture()
    const unregister = panels.register(descriptor('outputs', 'rail', ['rail']))
    layout.dock('outputs', 'right', 1)
    unregister()

    expect(zoneTabs(layout.effective().zones.right)).toContain('outputs')
    panels.register(descriptor('outputs', 'bottom', ['bottom']))

    expect(zoneTabs(layout.effective().zones.right)).not.toContain('outputs')
    expect(zoneTabs(layout.effective().zones.bottom)).toEqual(['outputs'])
    expect(panelDockZone(panels, layout, 'outputs')).toBe('bottom')
    expect(ids(zoneTabsView(panels, layout, 'bottom'))).toEqual(['outputs'])
  })

  it('a hidden active tab falls back to the first visible one WITHOUT persisting a reselection, and reclaims active on reappearing', () => {
    const { panels, layout } = fixture()
    let visible = true
    panels.register({ ...descriptor('surfaces', 'rail', ['rail']), when: () => visible })
    layout.dock('surfaces', 'right')
    expect(zoneTabsView(panels, layout, 'right').activeId).toBe('surfaces')

    visible = false
    const hidden = zoneTabsView(panels, layout, 'right')
    expect(ids(hidden)).toEqual(['library', 'memory'])
    expect(hidden.activeId).toBe('library')
    // The stored choice is untouched - the fallback is render-time only.
    expect(layout.effective().zones.right.sections[0]!.activeTab).toBe('surfaces')

    visible = true
    expect(zoneTabsView(panels, layout, 'right').activeId).toBe('surfaces')
  })

  it('activeId is undefined only when nothing is visible', () => {
    const { panels, layout } = fixture()
    movePanel(panels, layout, 'library', { kind: 'floating' })
    const view = zoneTabsView(panels, layout, 'right', (id) => id === 'memory')
    expect(ids(view)).toEqual([])
    expect(view.activeId).toBeUndefined()
  })
})

describe('zoneSectionsView', () => {
  it('projects each section with its own tabs and active id', () => {
    const { panels, layout } = fixture()
    layout.dock('memory', 'right', undefined, 1)
    const sections = zoneSectionsView(panels, layout, 'right')
    expect(sections).toHaveLength(2)
    expect(sections[0]!.section).toBe(0)
    expect(sections[0]!.panels.map(({ id }) => id)).toEqual(['library'])
    expect(sections[0]!.activeId).toBe('library')
    expect(sections[1]!.section).toBe(1)
    expect(sections[1]!.panels.map(({ id }) => id)).toEqual(['memory'])
    expect(sections[1]!.activeId).toBe('memory')
  })

  it('a section with nothing visible does not render but keeps membership', () => {
    const { panels, layout } = fixture()
    layout.dock('library', 'right', undefined, 1)
    movePanel(panels, layout, 'library', { kind: 'floating' })
    const sections = zoneSectionsView(panels, layout, 'right')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.section).toBe(0)
    expect(sections[0]!.panels.map(({ id }) => id)).toEqual(['memory'])
    // The floating panel keeps its stored spot in the now-hidden section.
    expect(layout.effective().zones.right.sections[1]!.tabs).toEqual(['library'])
    // The flat view's activeId comes from the first VISIBLE section.
    expect(zoneTabsView(panels, layout, 'right').activeId).toBe('memory')
  })

  it('the flat zone view spans sections for indicator aggregation', () => {
    const { panels, layout } = fixture()
    layout.dock('memory', 'right', undefined, 1)
    expect(zoneTabsView(panels, layout, 'right').panels.map(({ id }) => id)).toEqual(['library', 'memory'])
  })
})
