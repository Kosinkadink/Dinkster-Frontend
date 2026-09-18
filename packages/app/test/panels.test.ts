import { afterEach, describe, expect, it } from 'vitest'
import { aggregatePanelIndicators, PanelRegistry, type PanelDescriptor, type PanelIndicator } from '../src/panels.js'
import { initializeProjectScope } from '../src/projects.js'

const desc = (over: Partial<PanelDescriptor>): PanelDescriptor => ({
  id: 'p',
  title: 'Panel',
  placement: 'dock',
  allowedPlacements: ['dock'],
  order: 10,
  component: () => undefined,
  ...over,
})

describe('PanelRegistry', () => {
  afterEach(() => initializeProjectScope(undefined))

  it('persists floating placement under the active project scope', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage
    initializeProjectScope('p-alpha')
    const reg = new PanelRegistry(store)
    reg.register(desc({ id: 'f', allowedPlacements: ['dock', 'floating'] }))
    expect(reg.setPlacement('f', 'floating')).toBe(true)
    expect(data.get('dinkster.p.p-alpha.floatingPanels')).toBe(JSON.stringify(['f']))
    expect(data.has('dinkster.floatingPanels')).toBe(false)
    // A registry in another project scope does not see the placement.
    initializeProjectScope(undefined)
    const other = new PanelRegistry(store)
    other.register(desc({ id: 'f', allowedPlacements: ['dock', 'floating'] }))
    expect(other.placementOf('f')).toBe('dock')
  })

  it('registers, lists by placement in order, and unregisters', () => {
    const reg = new PanelRegistry()
    const un = reg.register(desc({ id: 'b', order: 20 }))
    reg.register(desc({ id: 'a', order: 10 }))
    reg.register(desc({ id: 'r', order: 5, placement: 'rail', allowedPlacements: ['rail'] }))
    expect(reg.inPlacement('dock').map((p) => p.id)).toEqual(['a', 'b'])
    expect(reg.inPlacement('rail').map((p) => p.id)).toEqual(['r'])
    un()
    expect(reg.inPlacement('dock').map((p) => p.id)).toEqual(['a'])
    expect(reg.get('b')).toBeUndefined()
  })

  it('refuses duplicate ids loudly', () => {
    const reg = new PanelRegistry()
    reg.register(desc({ id: 'dup' }))
    expect(() => reg.register(desc({ id: 'dup' }))).toThrow(/already registered/)
  })

  it('refuses a default placement outside allowedPlacements', () => {
    const reg = new PanelRegistry()
    expect(() =>
      reg.register(desc({ id: 'bad', placement: 'rail', allowedPlacements: ['dock'] })),
    ).toThrow(/not in allowedPlacements/)
  })

  it('moves a panel only within allowed, hosted placements', () => {
    const reg = new PanelRegistry()
    reg.register(desc({ id: 'm', placement: 'dock', allowedPlacements: ['dock', 'rail', 'window'] }))
    expect(reg.placementOf('m')).toBe('dock')
    expect(reg.setPlacement('m', 'rail')).toBe(true)
    expect(reg.placementOf('m')).toBe('rail')
    expect(reg.inPlacement('rail').map((p) => p.id)).toEqual(['m'])
    expect(reg.inPlacement('dock')).toEqual([])
    expect(reg.setPlacement('m', 'window')).toBe(true)
    expect(reg.placementOf('m')).toBe('window')
    expect(reg.setPlacement('m', 'rail')).toBe(true)
    // hosted placement, but this panel never declared it
    expect(reg.setPlacement('m', 'bottom')).toBe(false)
    // not declared at all
    expect(reg.setPlacement('m', 'modal')).toBe(false)
    expect(reg.placementOf('m')).toBe('rail')
    // back to the default clears the override
    expect(reg.setPlacement('m', 'dock')).toBe(true)
    expect(reg.placementOf('m')).toBe('dock')
    expect(reg.setPlacement('missing', 'dock')).toBe(false)
  })

  it('hosts the modal placement: default residency and runtime moves', () => {
    const reg = new PanelRegistry()
    reg.register(desc({ id: 'settings', placement: 'modal', allowedPlacements: ['modal'] }))
    expect(reg.inPlacement('modal').map((p) => p.id)).toEqual(['settings'])
    reg.register(desc({ id: 'movable', placement: 'dock', allowedPlacements: ['dock', 'modal'] }))
    expect(reg.setPlacement('movable', 'modal')).toBe(true)
    expect(reg.inPlacement('modal').map((p) => p.id)).toEqual(['movable', 'settings'])
  })

  it('hosts the bottom placement: default residency and runtime moves', () => {
    const reg = new PanelRegistry()
    reg.register(desc({ id: 'logs', placement: 'bottom', allowedPlacements: ['dock', 'bottom'] }))
    expect(reg.inPlacement('bottom').map((p) => p.id)).toEqual(['logs'])
    expect(reg.setPlacement('logs', 'dock')).toBe(true)
    expect(reg.inPlacement('bottom')).toEqual([])
    expect(reg.setPlacement('logs', 'bottom')).toBe(true)
    expect(reg.placementOf('logs')).toBe('bottom')
  })

  it('bumps changed on register, unregister, and placement change', () => {
    const reg = new PanelRegistry()
    const before = reg.changed.get()
    const un = reg.register(desc({ id: 'c', allowedPlacements: ['dock', 'rail'] }))
    reg.setPlacement('c', 'rail')
    un()
    expect(reg.changed.get()).toBe(before + 3)
  })

  it('restores floating overlays without persisting native-window placement', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    } as Storage
    const first = new PanelRegistry(storage)
    first.register(desc({ id: 'm', allowedPlacements: ['dock', 'floating', 'window'] }))
    expect(first.setPlacement('m', 'floating')).toBe(true)

    const restored = new PanelRegistry(storage)
    restored.register(desc({ id: 'm', allowedPlacements: ['dock', 'floating', 'window'] }))
    expect(restored.placementOf('m')).toBe('floating')
    expect(restored.setPlacement('m', 'window')).toBe(true)

    const afterWindow = new PanelRegistry(storage)
    afterWindow.register(desc({ id: 'm', allowedPlacements: ['dock', 'floating', 'window'] }))
    expect(afterWindow.placementOf('m')).toBe('dock')
  })
})

describe('aggregatePanelIndicators', () => {
  const indicator = (count: number, severity: PanelIndicator['severity'], label = `${count} things`): PanelIndicator =>
    ({ count, severity, label })

  it('answers undefined when nothing is indicated', () => {
    expect(aggregatePanelIndicators([])).toBeUndefined()
    expect(aggregatePanelIndicators([undefined, undefined])).toBeUndefined()
    expect(aggregatePanelIndicators([indicator(0, 'error')])).toBeUndefined()
  })

  it('passes a single active indicator through, keeping its label', () => {
    const only = indicator(3, 'warning', '3 problems, worst severity warning')
    expect(aggregatePanelIndicators([undefined, only, indicator(0, 'error')])).toEqual(only)
  })

  it('sums counts and keeps the worst severity across panels', () => {
    const combined = aggregatePanelIndicators([indicator(2, 'info'), indicator(1, 'error'), indicator(4, 'warning')])
    expect(combined).toEqual({ count: 7, severity: 'error', label: '7 notifications' })
  })
})
