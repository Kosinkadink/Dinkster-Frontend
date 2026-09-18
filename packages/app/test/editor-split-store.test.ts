/**
 * Editor split layout persistence (#165): one project-scoped string setting
 * validated at the read boundary, two-way bound without feedback loops.
 */
import { describe, expect, it } from 'vitest'
import { SettingsRegistry, SETTINGS_STORAGE_KEY } from '../src/settings.js'
import { encodeEditorLayout, singleGroupLayout, splitGroup } from '../src/editor-layout.js'
import { EDITOR_SPLIT_LAYOUT_SETTING, EditorSplitStore } from '../src/editor-split-store.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[SETTINGS_STORAGE_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage
}

const splitLayout = () => splitGroup(singleGroupLayout(['a', 'b']), 'group-1', 'row', 'b')

describe('EditorSplitStore', () => {
  it('starts as a single group and never writes on construction', () => {
    const settings = new SettingsRegistry(storage())
    const store = new EditorSplitStore(settings)
    expect(store.layout.get()).toEqual(singleGroupLayout())
    expect(settings.get<string>(EDITOR_SPLIT_LAYOUT_SETTING)).toBe('')
  })

  it('persists layout changes and restores across reconstruction', () => {
    const backing = storage()
    const first = new EditorSplitStore(new SettingsRegistry(backing))
    first.layout.set(splitLayout())

    const second = new EditorSplitStore(new SettingsRegistry(backing))
    expect(second.layout.get()).toEqual(splitLayout())
  })

  it('its own writes do not echo back through the settings tick', () => {
    const settings = new SettingsRegistry(storage())
    const store = new EditorSplitStore(settings)
    let sets = 0
    const originalSet = settings.set.bind(settings)
    settings.set = (id, value) => {
      sets++
      originalSet(id, value)
    }
    store.layout.set(splitLayout())
    expect(sets).toBe(1)
    expect(store.layout.get()).toEqual(splitLayout())
  })

  it('an external settings write updates the live layout', () => {
    const settings = new SettingsRegistry(storage())
    const store = new EditorSplitStore(settings)
    settings.set(EDITOR_SPLIT_LAYOUT_SETTING, encodeEditorLayout(splitLayout()))
    expect(store.layout.get()).toEqual(splitLayout())
  })

  it('ignores a malformed external write, keeping the prior state', () => {
    const settings = new SettingsRegistry(storage())
    const store = new EditorSplitStore(settings)
    store.layout.set(splitLayout())
    settings.set(EDITOR_SPLIT_LAYOUT_SETTING, '{"v":1,broken')
    expect(store.layout.get()).toEqual(splitLayout())
  })

  it('a settings reset returns to a single group without persisting it', () => {
    const settings = new SettingsRegistry(storage())
    const store = new EditorSplitStore(settings)
    store.layout.set(splitLayout())
    expect(settings.get<string>(EDITOR_SPLIT_LAYOUT_SETTING)).not.toBe('')

    settings.reset(EDITOR_SPLIT_LAYOUT_SETTING)
    expect(store.layout.get()).toEqual(singleGroupLayout())
    expect(settings.get<string>(EDITOR_SPLIT_LAYOUT_SETTING)).toBe('')
  })

  it('a tampered stored value falls back to a single group on construction, without rewriting it', () => {
    const backing = storage()
    const writer = new SettingsRegistry(backing)
    writer.register({
      id: EDITOR_SPLIT_LAYOUT_SETTING,
      name: 'Editor split layout',
      type: 'string',
      defaultValue: '',
      projectScoped: true,
    })
    writer.set(EDITOR_SPLIT_LAYOUT_SETTING, '{"v":1,"root":{"kind":"mystery"}}')

    const settings = new SettingsRegistry(backing)
    const store = new EditorSplitStore(settings)
    expect(store.layout.get()).toEqual(singleGroupLayout())
    expect(settings.get<string>(EDITOR_SPLIT_LAYOUT_SETTING)).toBe('{"v":1,"root":{"kind":"mystery"}}')
  })
})
