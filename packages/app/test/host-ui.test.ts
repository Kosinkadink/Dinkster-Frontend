import { describe, expect, it } from 'vitest'
import { createMenuRegistry, ExtensionHost, HOST_UI_MAX_VISIBLE_STRING_LENGTH, type ExtensionHostUiSlot, type HostUiProviderV1 } from '@dinkster/core'
import { createWidgetRegistry } from '@dinkster/widgets'
import { HostUiContributionRegistry } from '../src/host-ui.js'
import { SettingsRegistry } from '../src/settings.js'

const provider = () => ({ version: 1, root: { kind: 'text', key: 'status', text: 'ready' } })

describe('host UI contribution registry', () => {
  it('orders declarative contributions deterministically', () => {
    const registry = new HostUiContributionRegistry()
    registry.register('pack.monitor.status', 'status.trailing', provider, 20)
    registry.register('pack.alpha.status', 'status.trailing', provider, 10)
    expect(registry.list('status.trailing').map((item) => item.id)).toEqual(['pack.alpha.status', 'pack.monitor.status'])
  })

  it('owns immutable contribution metadata', () => {
    const registry = new HostUiContributionRegistry()
    registry.register('pack.monitor.status', 'status.trailing', provider, 20, 'Monitor')
    const stored = registry.list('status.trailing')[0]!
    expect(stored).toMatchObject({ id: 'pack.monitor.status', slot: 'status.trailing', order: 20, provider })
    expect(Object.isFrozen(stored)).toBe(true)
    expect(() => Object.assign(stored as unknown as Record<string, unknown>, { id: 'changed', order: -20 })).toThrow()
    expect(stored).toMatchObject({ id: 'pack.monitor.status', order: 20 })
  })

  it('exposes only a positional registration boundary', () => {
    const registry = new HostUiContributionRegistry()
    const objectForm = { id: 'pack.object.status', slot: 'status.trailing', provider }
    expect(() => registry.register(objectForm as never, undefined as never, undefined as never)).toThrow('invalid metadata')
    expect(() => registry.register('invalid', 'status.trailing', provider)).toThrow('invalid metadata')
    expect(registry.list('status.trailing')).toEqual([])
  })

  it('gates, unregisters, and restores a host UI contribution independently', () => {
    const registry = new HostUiContributionRegistry()
    const host = new ExtensionHost({ menus: createMenuRegistry(), widgets: createWidgetRegistry(), registerHostUi: (...args) => registry.register(...args) })
    expect(host.register({ id: 'pack.monitor', contributions: [{ id: 'pack.monitor.status', category: 'hostUi' }] }, (api) => {
      api.hostUi('pack.monitor.status', 'status.trailing', provider)
    })).toEqual([])
    expect(registry.list('status.trailing')).toHaveLength(1)
    host.setContributionEnabled('pack.monitor.status', false)
    expect(registry.list('status.trailing')).toEqual([])
    host.setContributionEnabled('pack.monitor.status', true)
    expect(registry.list('status.trailing')).toHaveLength(1)
    host.unregister('pack.monitor')
    expect(registry.list('status.trailing')).toEqual([])
  })

  it('publishes no staged registry changes when a collision rolls back the batch', () => {
    const registry = new HostUiContributionRegistry()
    const settings = new SettingsRegistry({ getItem: () => null, setItem: () => {} })
    registry.register('pack.fail.ui', 'status.trailing', provider)
    let changes = 0
    registry.changed.subscribe(() => changes += 1)
    const host = new ExtensionHost({
      menus: createMenuRegistry(), widgets: createWidgetRegistry(),
      registerSetting: (setting) => settings.register(setting), registerHostUi: (...args) => registry.register(...args),
      beginRegistryBatch: () => {
        const finishSettings = settings.beginBatch()
        const finishHostUi = registry.beginBatch()
        return (commit) => { finishHostUi(commit); finishSettings(commit) }
      },
    })
    const diagnostics = host.register({ id: 'pack.fail', contributions: [
      { id: 'pack.fail.setting', category: 'setting' }, { id: 'pack.fail.ui', category: 'hostUi' },
    ] }, (api) => {
      api.setting('pack.fail.setting', { id: 'pack.fail.setting', name: 'Staged', type: 'boolean', defaultValue: false })
      api.hostUi('pack.fail.ui', 'status.trailing', provider)
    })
    expect(diagnostics.map((item) => item.code)).toEqual(['extension.contribution-conflict', 'extension.rollback-complete'])
    expect(settings.list()).toEqual([])
    expect(changes).toBe(0)
  })

  it.each([
    ['slot', ['other', provider]],
    ['provider', ['status.trailing', null]],
    ['order', ['status.trailing', provider, Number.POSITIVE_INFINITY]],
    ['empty title', ['status.trailing', provider, undefined, '']],
    ['long title', ['status.trailing', provider, undefined, 'x'.repeat(HOST_UI_MAX_VISIBLE_STRING_LENGTH + 1)]],
  ])('rolls back a transaction with malformed %s metadata', (_name, invalid) => {
    const registry = new HostUiContributionRegistry()
    const settings = new SettingsRegistry({ getItem: () => null, setItem: () => {} })
    const host = new ExtensionHost({
      menus: createMenuRegistry(), widgets: createWidgetRegistry(),
      registerSetting: (setting) => settings.register(setting), registerHostUi: (...args) => registry.register(...args),
      beginRegistryBatch: () => {
        const finishSettings = settings.beginBatch()
        const finishHostUi = registry.beginBatch()
        return (commit) => { finishHostUi(commit); finishSettings(commit) }
      },
    })
    const diagnostics = host.register({ id: 'pack.invalid', contributions: [
      { id: 'pack.invalid.setting', category: 'setting' }, { id: 'pack.invalid.ui', category: 'hostUi' },
    ] }, (api) => {
      api.setting('pack.invalid.setting', { id: 'pack.invalid.setting', name: 'Staged', type: 'boolean', defaultValue: false })
      api.hostUi('pack.invalid.ui', ...(invalid as [ExtensionHostUiSlot, HostUiProviderV1, number?, string?]))
    })
    expect(diagnostics.map((item) => item.code)).toEqual(['extension.activate-failed', 'extension.rollback-complete'])
    expect(settings.list()).toEqual([])
    expect(registry.list('status.trailing')).toEqual([])
  })

})
