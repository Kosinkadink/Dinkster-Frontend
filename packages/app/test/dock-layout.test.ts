/**
 * Dock zone layout model (#105, #169): tabbed zones as pure state, each
 * hosting one or two tabbed sections, persisted as one versioned
 * project-scoped setting validated at the read boundary, with default
 * membership derived from the registered panels until the first mutation
 * persists.
 */
import { describe, expect, it } from 'vitest'
import { SettingsRegistry, SETTINGS_STORAGE_KEY } from '../src/settings.js'
import {
  activatePanelTab,
  canDockInZone,
  clampZoneSplit,
  decodeDockState,
  defaultZoneOf,
  DockLayout,
  DOCK_LAYOUT_SETTING,
  dockPanelTab,
  effectiveDockState,
  emptyDockState,
  encodeDockState,
  removePanelTab,
  sectionOf,
  setZoneOpen,
  setZoneSplit,
  zonePlacement,
  zoneTabs,
  type DockablePanel,
  type PanelDockState,
} from '../src/dock-layout.js'
import type { PanelPlacement } from '../src/panels.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[SETTINGS_STORAGE_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage
}

const panel = (
  id: string,
  placement: PanelPlacement,
  order: number,
  allowedPlacements: readonly PanelPlacement[] = [placement],
): DockablePanel => ({ id, placement, allowedPlacements, order })

const docked = (): PanelDockState =>
  dockPanelTab(dockPanelTab(dockPanelTab(emptyDockState(), 'library', 'right'), 'collections', 'right'), 'problems', 'bottom')

/** docked() plus a second right-zone section holding 'memory'. */
const sectioned = (): PanelDockState => dockPanelTab(docked(), 'memory', 'right', undefined, 1)

describe('dock state mutations', () => {
  it('docks into a zone: appended, active, and open', () => {
    const state = docked()
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library', 'collections'])
    expect(state.zones.right.sections[0]!.activeTab).toBe('collections')
    expect(state.zones.right.open).toBe(true)
    expect(state.zones.bottom.sections[0]!.tabs).toEqual(['problems'])
  })

  it('docking at an index inserts there and clamps out-of-range indexes', () => {
    const state = dockPanelTab(docked(), 'memory', 'right', 1)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library', 'memory', 'collections'])
    expect(dockPanelTab(docked(), 'memory', 'right', 99).zones.right.sections[0]!.tabs).toEqual([
      'library',
      'collections',
      'memory',
    ])
    expect(dockPanelTab(docked(), 'memory', 'right', -5).zones.right.sections[0]!.tabs).toEqual([
      'memory',
      'library',
      'collections',
    ])
  })

  it('a panel lives in at most one zone: docking elsewhere moves it', () => {
    const state = dockPanelTab(docked(), 'library', 'bottom')
    expect(state.zones.right.sections[0]!.tabs).toEqual(['collections'])
    expect(state.zones.bottom.sections[0]!.tabs).toEqual(['problems', 'library'])
    expect(state.zones.bottom.sections[0]!.activeTab).toBe('library')
  })

  it('re-docking within the same zone reorders without duplicating', () => {
    const state = dockPanelTab(docked(), 'collections', 'right', 0)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['collections', 'library'])
  })

  it('removing the active tab activates its neighbor; the last removal closes the zone', () => {
    const afterActive = removePanelTab(docked(), 'collections')
    expect(afterActive.zones.right.sections[0]!.tabs).toEqual(['library'])
    expect(afterActive.zones.right.sections[0]!.activeTab).toBe('library')
    expect(afterActive.zones.right.open).toBe(true)

    const emptied = removePanelTab(afterActive, 'library')
    expect(emptied.zones.right.sections[0]!.tabs).toEqual([])
    expect(emptied.zones.right.sections[0]!.activeTab).toBeUndefined()
    expect(emptied.zones.right.open).toBe(false)
  })

  it('removing an inactive tab keeps the active one', () => {
    const state = removePanelTab(docked(), 'library')
    expect(state.zones.right.sections[0]!.activeTab).toBe('collections')
  })

  it('activate refuses ids outside the zone', () => {
    const state = docked()
    expect(activatePanelTab(state, 'right', 'problems')).toBe(state)
    expect(activatePanelTab(state, 'right', 'library').zones.right.sections[0]!.activeTab).toBe('library')
  })

  it('an empty zone never opens', () => {
    const state = setZoneOpen(emptyDockState(), 'bottom', true)
    expect(state.zones.bottom.open).toBe(false)
    const closed = setZoneOpen(docked(), 'right', false)
    expect(closed.zones.right.open).toBe(false)
    expect(setZoneOpen(closed, 'right', true).zones.right.open).toBe(true)
  })
})

describe('zone sections', () => {
  it('docking into a new trailing section creates it, active and open', () => {
    const state = sectioned()
    expect(state.zones.right.sections).toHaveLength(2)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library', 'collections'])
    expect(state.zones.right.sections[1]!.tabs).toEqual(['memory'])
    expect(state.zones.right.sections[1]!.activeTab).toBe('memory')
    expect(state.zones.right.open).toBe(true)
    expect(zoneTabs(state.zones.right)).toEqual(['library', 'collections', 'memory'])
  })

  it('a section index past the maximum clamps to the last section', () => {
    const state = dockPanelTab(sectioned(), 'problems', 'right', undefined, 5)
    expect(state.zones.right.sections).toHaveLength(2)
    expect(state.zones.right.sections[1]!.tabs).toEqual(['memory', 'problems'])
  })

  it('never splits a zone whose only section is empty', () => {
    const state = dockPanelTab(emptyDockState(), 'library', 'right', undefined, 1)
    expect(state.zones.right.sections).toHaveLength(1)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library'])
  })

  it('sections tab independently: activating one leaves the other alone', () => {
    const state = activatePanelTab(sectioned(), 'right', 'library')
    expect(state.zones.right.sections[0]!.activeTab).toBe('library')
    expect(state.zones.right.sections[1]!.activeTab).toBe('memory')
  })

  it('a second section losing its last tab collapses and resets the split', () => {
    const wide = setZoneSplit(sectioned(), 'right', 0.7)
    const state = removePanelTab(wide, 'memory')
    expect(state.zones.right.sections).toHaveLength(1)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library', 'collections'])
    expect(state.zones.right.split).toBe(0.5)
    expect(state.zones.right.open).toBe(true)
  })

  it('moving a tab between sections of one zone keeps zone membership', () => {
    const state = dockPanelTab(sectioned(), 'library', 'right', undefined, 1)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['collections'])
    expect(state.zones.right.sections[1]!.tabs).toEqual(['memory', 'library'])
    expect(state.zones.right.sections[1]!.activeTab).toBe('library')
  })

  it('a first section emptied by a move collapses; the target index follows', () => {
    // right: [[library], [memory]] -- move library into section 1.
    const base = dockPanelTab(
      dockPanelTab(emptyDockState(), 'library', 'right'),
      'memory', 'right', undefined, 1,
    )
    const state = dockPanelTab(base, 'library', 'right', undefined, 1)
    expect(state.zones.right.sections).toHaveLength(1)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['memory', 'library'])
  })

  it('moving a section\'s sole tab within its own section is a no-op that opens the zone', () => {
    const closed = setZoneOpen(dockPanelTab(emptyDockState(), 'library', 'right'), 'right', false)
    const state = dockPanelTab(closed, 'library', 'right')
    expect(state.zones.right.sections).toHaveLength(1)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library'])
    expect(state.zones.right.open).toBe(true)
  })

  it('sectionOf finds the zone and section holding an id', () => {
    const state = sectioned()
    expect(sectionOf(state, 'library')).toEqual({ zone: 'right', section: 0 })
    expect(sectionOf(state, 'memory')).toEqual({ zone: 'right', section: 1 })
    expect(sectionOf(state, 'problems')).toEqual({ zone: 'bottom', section: 0 })
    expect(sectionOf(state, 'ghost')).toBeUndefined()
  })

  it('setZoneSplit clamps and is identity for an unchanged value', () => {
    const state = sectioned()
    expect(setZoneSplit(state, 'right', 0.02).zones.right.split).toBe(0.1)
    expect(setZoneSplit(state, 'right', 0.98).zones.right.split).toBe(0.9)
    expect(setZoneSplit(state, 'right', 0.5)).toBe(state)
    expect(clampZoneSplit(0.3)).toBe(0.3)
  })
})

describe('placement legality', () => {
  it('maps zones onto the existing placement vocabulary', () => {
    expect(zonePlacement('left')).toBe('dock')
    expect(zonePlacement('right')).toBe('rail')
    expect(zonePlacement('bottom')).toBe('bottom')
  })

  it('gates docking on allowedPlacements', () => {
    expect(canDockInZone(['rail'], 'right')).toBe(true)
    expect(canDockInZone(['rail'], 'bottom')).toBe(false)
    expect(canDockInZone(['dock', 'bottom', 'floating'], 'bottom')).toBe(true)
  })
})

describe('registry-derived default membership', () => {
  it('maps default placements onto zones; overlay placements have none', () => {
    expect(defaultZoneOf('dock')).toBe('left')
    expect(defaultZoneOf('rail')).toBe('right')
    expect(defaultZoneOf('bottom')).toBe('bottom')
    expect(defaultZoneOf('modal')).toBeUndefined()
    expect(defaultZoneOf('floating')).toBeUndefined()
    expect(defaultZoneOf('window')).toBeUndefined()
  })

  it('appends unstored zone-default panels to their default zone in order', () => {
    const state = effectiveDockState(emptyDockState(), [
      panel('memory', 'rail', 20),
      panel('library', 'dock', 10),
      panel('collections', 'rail', 10),
      panel('collab', 'modal', 0),
    ], true)
    expect(state.zones.left.sections[0]!.tabs).toEqual(['library'])
    expect(state.zones.right.sections[0]!.tabs).toEqual(['collections', 'memory'])
    expect(state.zones.right.sections[0]!.activeTab).toBe('collections')
  })

  it('appends to the FIRST section, leaving a second section alone', () => {
    const stored = dockPanelTab(dockPanelTab(emptyDockState(), 'a', 'right'), 'b', 'right', undefined, 1)
    const state = effectiveDockState(stored, [
      panel('a', 'rail', 0),
      panel('b', 'rail', 1),
      panel('c', 'rail', 2),
    ], false)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['a', 'c'])
    expect(state.zones.right.sections[1]!.tabs).toEqual(['b'])
  })

  it('a fresh layout opens only the right zone, and only when it has tabs', () => {
    const withRail = effectiveDockState(emptyDockState(), [panel('a', 'rail', 0), panel('b', 'dock', 0)], true)
    expect(withRail.zones.right.open).toBe(true)
    expect(withRail.zones.left.open).toBe(false)
    const withoutRail = effectiveDockState(emptyDockState(), [panel('b', 'dock', 0)], true)
    expect(withoutRail.zones.right.open).toBe(false)
  })

  it('a persisted open choice is respected: new panels never pop a closed zone open', () => {
    const stored = setZoneOpen(dockPanelTab(emptyDockState(), 'a', 'right'), 'right', false)
    const state = effectiveDockState(stored, [panel('a', 'rail', 0), panel('b', 'rail', 1)], false)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['a', 'b'])
    expect(state.zones.right.open).toBe(false)
  })

  it('stored membership wins: a stored tab keeps its zone and position', () => {
    const stored = dockPanelTab(emptyDockState(), 'memory', 'bottom')
    const state = effectiveDockState(stored, [
      panel('memory', 'rail', 0, ['rail', 'bottom']),
      panel('library', 'rail', 1),
    ], false)
    expect(state.zones.bottom.sections[0]!.tabs).toEqual(['memory'])
    expect(state.zones.right.sections[0]!.tabs).toEqual(['library'])
  })

  it('moves a registered panel out of a stored zone its descriptor no longer permits', () => {
    const stored = dockPanelTab(emptyDockState(), 'memory', 'right')
    const state = effectiveDockState(stored, [panel('memory', 'bottom', 0)], false)
    expect(state.zones.right.sections[0]!.tabs).toEqual([])
    expect(state.zones.right.sections[0]!.activeTab).toBeUndefined()
    expect(state.zones.right.open).toBe(false)
    expect(state.zones.bottom.sections[0]!.tabs).toEqual(['memory'])
    expect(state.zones.bottom.sections[0]!.activeTab).toBe('memory')
  })

  it('stored ids without a registered panel keep their place', () => {
    const stored = dockPanelTab(emptyDockState(), 'ghost', 'right')
    const state = effectiveDockState(stored, [panel('library', 'rail', 0)], false)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['ghost', 'library'])
  })

  it('is identity when nothing is derived (no signal churn)', () => {
    const stored = dockPanelTab(emptyDockState(), 'a', 'right')
    expect(effectiveDockState(stored, [panel('a', 'rail', 0)], false)).toBe(stored)
  })
})

describe('encode/decode read boundary (FR11)', () => {
  it('round-trips, sections included', () => {
    const state = sectioned()
    expect(decodeDockState(encodeDockState(state))).toEqual(state)
  })

  it('refuses garbage, wrong versions, and structural tampering', () => {
    expect(decodeDockState('')).toBeUndefined()
    expect(decodeDockState('not json')).toBeUndefined()
    expect(decodeDockState('{"v":2,"zones":{}}')).toBeUndefined()
    expect(decodeDockState('{"v":3,"zones":{}}')).toBeUndefined()
    expect(decodeDockState('{"v":1}')).toBeUndefined()
    expect(decodeDockState('{"v":1,"zones":{"left":{"tabs":"x","open":true},"right":{"tabs":[],"open":false},"bottom":{"tabs":[],"open":false}}}')).toBeUndefined()
    expect(decodeDockState('{"v":1,"zones":{"left":{"tabs":[1],"open":true},"right":{"tabs":[],"open":false},"bottom":{"tabs":[],"open":false}}}')).toBeUndefined()
  })

  it('loads a v1 value as one section per zone with the default split', () => {
    const raw = JSON.stringify({
      v: 1,
      zones: {
        left: { tabs: [], activeTab: undefined, open: false },
        right: { tabs: ['library', 'memory'], activeTab: 'memory', open: true },
        bottom: { tabs: ['problems'], activeTab: 'problems', open: false },
      },
    })
    const state = decodeDockState(raw)!
    expect(state.zones.right.sections).toEqual([{ tabs: ['library', 'memory'], activeTab: 'memory' }])
    expect(state.zones.right.split).toBe(0.5)
    expect(state.zones.right.open).toBe(true)
    expect(state.zones.bottom.sections[0]!.tabs).toEqual(['problems'])
    expect(state.zones.bottom.open).toBe(false)
  })

  it('restores invariants: duplicate ids keep their first zone, stray active falls back, empty zones close', () => {
    const raw = JSON.stringify({
      v: 1,
      zones: {
        left: { tabs: ['library'], activeTab: 'ghost', open: true },
        right: { tabs: ['library', 'memory'], activeTab: 'memory', open: true },
        bottom: { tabs: [], activeTab: undefined, open: true },
      },
    })
    const state = decodeDockState(raw)!
    expect(state.zones.left.sections).toEqual([{ tabs: ['library'], activeTab: 'library' }])
    expect(state.zones.left.open).toBe(true)
    expect(state.zones.right.sections[0]!.tabs).toEqual(['memory'])
    expect(state.zones.right.sections[0]!.activeTab).toBe('memory')
    expect(state.zones.bottom.open).toBe(false)
  })

  it('keeps only the first of duplicate ids within one zone', () => {
    const raw = JSON.stringify({
      v: 1,
      zones: {
        left: { tabs: ['library', 'library', 'memory'], activeTab: 'library', open: true },
        right: { tabs: [], activeTab: undefined, open: false },
        bottom: { tabs: [], activeTab: undefined, open: false },
      },
    })
    expect(decodeDockState(raw)!.zones.left.sections[0]!.tabs).toEqual(['library', 'memory'])
  })

  it('refuses a v2 zone with zero or too many sections', () => {
    const zone = (sections: unknown): string => JSON.stringify({
      v: 2,
      zones: {
        left: { sections, split: 0.5, open: false },
        right: { sections: [{ tabs: [], activeTab: undefined }], split: 0.5, open: false },
        bottom: { sections: [{ tabs: [], activeTab: undefined }], split: 0.5, open: false },
      },
    })
    expect(decodeDockState(zone([]))).toBeUndefined()
    expect(decodeDockState(zone([
      { tabs: ['a'] }, { tabs: ['b'] }, { tabs: ['c'] },
    ]))).toBeUndefined()
    expect(decodeDockState(zone('nope'))).toBeUndefined()
  })

  it('repairs v2 values: cross-section duplicates, emptied sections, bad splits', () => {
    const raw = JSON.stringify({
      v: 2,
      zones: {
        left: { sections: [{ tabs: [], activeTab: undefined }], split: 0.5, open: false },
        right: {
          // The duplicate 'library' empties the second section, which drops.
          sections: [
            { tabs: ['library', 'memory'], activeTab: 'ghost' },
            { tabs: ['library'], activeTab: 'library' },
          ],
          split: 7,
          open: true,
        },
        bottom: { sections: [{ tabs: [], activeTab: undefined }], split: 'wide', open: true },
      },
    })
    const state = decodeDockState(raw)!
    expect(state.zones.right.sections).toEqual([{ tabs: ['library', 'memory'], activeTab: 'library' }])
    expect(state.zones.right.split).toBe(0.9)
    expect(state.zones.bottom.split).toBe(0.5)
    expect(state.zones.bottom.open).toBe(false)
  })
})

describe('DockLayout persistence', () => {
  it('persists mutations and restores across reconstruction', () => {
    const store = storage()
    const first = new DockLayout(new SettingsRegistry(store))
    first.dock('library', 'right')
    first.dock('problems', 'bottom')
    first.setOpen('bottom', false)

    const second = new DockLayout(new SettingsRegistry(store))
    expect(second.state.get().zones.right.sections[0]!.tabs).toEqual(['library'])
    expect(second.state.get().zones.bottom.sections[0]!.tabs).toEqual(['problems'])
    expect(second.state.get().zones.bottom.open).toBe(false)
  })

  it('persists sections and the split across reconstruction', () => {
    const store = storage()
    const first = new DockLayout(new SettingsRegistry(store))
    first.dock('library', 'right')
    first.dock('memory', 'right', undefined, 1)
    first.setSplit('right', 0.3)

    const second = new DockLayout(new SettingsRegistry(store))
    expect(second.state.get().zones.right.sections).toHaveLength(2)
    expect(second.state.get().zones.right.sections[1]!.tabs).toEqual(['memory'])
    expect(second.state.get().zones.right.split).toBe(0.3)
  })

  it('construction never writes: derived membership persists on the first mutation', () => {
    const store = storage()
    const settings = new SettingsRegistry(store)
    const panels = (): readonly DockablePanel[] => [panel('memory', 'rail', 0), panel('library', 'dock', 1)]
    const layout = new DockLayout(settings, panels)
    expect(layout.fresh()).toBe(true)
    expect(layout.effective().zones.right.sections[0]!.tabs).toEqual(['memory'])
    expect(layout.effective().zones.left.sections[0]!.tabs).toEqual(['library'])
    expect(settings.get<string>(DOCK_LAYOUT_SETTING)).toBe('')

    layout.dock('memory', 'bottom')
    expect(settings.get<string>(DOCK_LAYOUT_SETTING)).not.toBe('')
    const second = new DockLayout(new SettingsRegistry(store), panels)
    expect(second.fresh()).toBe(false)
    expect(second.state.get().zones.bottom.sections[0]!.tabs).toEqual(['memory'])
    // The first persisted value already contains the derived membership.
    expect(second.state.get().zones.left.sections[0]!.tabs).toEqual(['library'])
  })

  it('mutations rebase on the effective state, keeping derived tab order', () => {
    const store = storage()
    const layout = new DockLayout(new SettingsRegistry(store), () =>
      [panel('library', 'rail', 0), panel('memory', 'rail', 1)])
    layout.activate('right', 'memory')
    const restored = new DockLayout(new SettingsRegistry(store))
    expect(restored.state.get().zones.right.sections[0]!.tabs).toEqual(['library', 'memory'])
    expect(restored.state.get().zones.right.sections[0]!.activeTab).toBe('memory')
    expect(restored.state.get().zones.right.open).toBe(true)
  })

  it('a stored value wins over derived defaults; unstored panels still append', () => {
    const store = storage()
    const first = new DockLayout(new SettingsRegistry(store))
    first.dock('problems', 'bottom')
    const second = new DockLayout(new SettingsRegistry(store), () => [panel('library', 'rail', 0)])
    expect(second.state.get().zones.bottom.sections[0]!.tabs).toEqual(['problems'])
    expect(second.effective().zones.bottom.sections[0]!.tabs).toEqual(['problems'])
    expect(second.effective().zones.right.sections[0]!.tabs).toEqual(['library'])
  })

  it('an external settings write updates the live state; a tampered one is ignored', () => {
    const settings = new SettingsRegistry(storage())
    const layout = new DockLayout(settings)
    settings.set(DOCK_LAYOUT_SETTING, encodeDockState(dockPanelTab(emptyDockState(), 'library', 'left')))
    expect(layout.state.get().zones.left.sections[0]!.tabs).toEqual(['library'])
    expect(layout.fresh()).toBe(false)

    settings.set(DOCK_LAYOUT_SETTING, '{"v":1,broken')
    expect(layout.state.get().zones.left.sections[0]!.tabs).toEqual(['library'])
    expect(layout.fresh()).toBe(false)
  })

  it('a v1 external write loads cleanly into the sectioned model', () => {
    const settings = new SettingsRegistry(storage())
    const layout = new DockLayout(settings)
    settings.set(DOCK_LAYOUT_SETTING, JSON.stringify({
      v: 1,
      zones: {
        left: { tabs: [], activeTab: undefined, open: false },
        right: { tabs: ['library'], activeTab: 'library', open: true },
        bottom: { tabs: [], activeTab: undefined, open: false },
      },
    }))
    expect(layout.state.get().zones.right.sections).toEqual([{ tabs: ['library'], activeTab: 'library' }])
    expect(layout.state.get().zones.right.split).toBe(0.5)
    expect(layout.fresh()).toBe(false)
  })

  it('a tampered external write onto a FRESH layout keeps it fresh', () => {
    const settings = new SettingsRegistry(storage())
    const layout = new DockLayout(settings, () => [panel('library', 'rail', 0)])
    expect(layout.fresh()).toBe(true)
    expect(layout.effective().zones.right.open).toBe(true)

    settings.set(DOCK_LAYOUT_SETTING, '{"v":1,broken')
    expect(layout.fresh()).toBe(true)
    expect(layout.effective().zones.right.open).toBe(true)
  })

  it('its own writes do not echo back through the settings tick (no feedback loop)', () => {
    const settings = new SettingsRegistry(storage())
    const layout = new DockLayout(settings)
    let sets = 0
    const originalSet = settings.set.bind(settings)
    settings.set = (id, value) => {
      sets++
      originalSet(id, value)
    }
    layout.dock('library', 'right')
    expect(sets).toBe(1)
    expect(layout.state.get().zones.right.sections[0]!.tabs).toEqual(['library'])
  })

  it('a settings reset restores the fresh derived state without persisting it', () => {
    const settings = new SettingsRegistry(storage())
    const layout = new DockLayout(settings, () => [panel('library', 'rail', 0)])
    layout.dock('problems', 'bottom')
    expect(settings.get<string>(DOCK_LAYOUT_SETTING)).not.toBe('')

    settings.reset(DOCK_LAYOUT_SETTING)
    expect(layout.state.get()).toEqual(emptyDockState())
    expect(layout.fresh()).toBe(true)
    expect(layout.effective().zones.right.sections[0]!.tabs).toEqual(['library'])
    expect(layout.effective().zones.bottom.sections[0]!.tabs).toEqual([])
    expect(settings.get<string>(DOCK_LAYOUT_SETTING)).toBe('')

    layout.dock('memory', 'right')
    expect(settings.get<string>(DOCK_LAYOUT_SETTING)).not.toBe('')
  })

  it('resetOpen restores default zone visibility without touching membership', () => {
    const store = storage()
    const layout = new DockLayout(new SettingsRegistry(store), () =>
      [panel('library', 'rail', 0), panel('memory', 'rail', 1)])
    layout.activate('right', 'memory')
    layout.setOpen('right', false)
    expect(layout.effective().zones.right.open).toBe(false)

    layout.resetOpen()
    expect(layout.effective().zones.right.open).toBe(true)
    expect(layout.effective().zones.right.sections[0]!.tabs).toEqual(['library', 'memory'])
    expect(layout.effective().zones.right.sections[0]!.activeTab).toBe('memory')
    expect(layout.effective().zones.left.open).toBe(false)

    const restored = new DockLayout(new SettingsRegistry(store))
    expect(restored.state.get().zones.right.open).toBe(true)
  })

  it('FR11: tampered stored state falls back to empty on construction, without rewriting it', () => {
    const store = storage()
    const writer = new SettingsRegistry(store)
    writer.register({ id: DOCK_LAYOUT_SETTING, name: 'Dock layout', type: 'string', defaultValue: '' })
    writer.set(DOCK_LAYOUT_SETTING, '{"v":1,"zones":{"left":42}}')

    const settings = new SettingsRegistry(store)
    const layout = new DockLayout(settings, () => [panel('library', 'rail', 0)])
    expect(layout.state.get()).toEqual(emptyDockState())
    expect(settings.get<string>(DOCK_LAYOUT_SETTING)).toBe('{"v":1,"zones":{"left":42}}')
    // The malformed value is not persistence: fresh defaults still apply.
    expect(layout.fresh()).toBe(true)
    expect(layout.effective().zones.right.open).toBe(true)
  })
})
