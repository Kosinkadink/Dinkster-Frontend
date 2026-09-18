/** Registry behavior is tested without Solid or a browser storage implementation. */
import { describe, expect, it } from 'vitest'
import { captureKeydown, initialSettingsCategory, isNativeTextScopeTarget, KeybindingRegistry, SettingsRegistry, SETTINGS_STORAGE_KEY, shortcutSuppressed } from '../src/settings.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[SETTINGS_STORAGE_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage
}
const setting = { id: 'canvas.grid.visible', name: 'Grid', type: 'boolean' as const, defaultValue: true }

describe('settings registry', () => {
  it('registers, derives categories, reacts, and persists only non-default values', () => {
    const store = storage()
    const registry = new SettingsRegistry(store)
    registry.register(setting)
    expect(registry.categoryOf(setting)).toBe('canvas.grid')
    expect(registry.get('canvas.grid.visible')).toBe(true)
    registry.set('canvas.grid.visible', false)
    expect(new SettingsRegistry(store)).toBeDefined()
    expect(JSON.parse(store.getItem(SETTINGS_STORAGE_KEY)!).values).toEqual({ 'canvas.grid.visible': false })
    registry.set('canvas.grid.visible', true)
    expect(JSON.parse(store.getItem(SETTINGS_STORAGE_KEY)!).values).toEqual({})
  })

  it('stores project-scoped overrides in the project envelope and global ones globally', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage
    const projectKey = 'dinkster.p.p-alpha.settings'
    const registry = new SettingsRegistry(store, projectKey)
    registry.register(setting)
    registry.register({ id: 'shell.layout.right.open', name: 'Right rail open', type: 'boolean', defaultValue: true, projectScoped: true })
    registry.set('canvas.grid.visible', false)
    registry.set('shell.layout.right.open', false)
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY)!).values).toEqual({ 'canvas.grid.visible': false })
    expect(JSON.parse(data.get(projectKey)!).values).toEqual({ 'shell.layout.right.open': false })
    // A registry on the default envelope sees the global override but not the project one.
    const defaultRegistry = new SettingsRegistry(store)
    defaultRegistry.register(setting)
    defaultRegistry.register({ id: 'shell.layout.right.open', name: 'Right rail open', type: 'boolean', defaultValue: true, projectScoped: true })
    expect(defaultRegistry.get('canvas.grid.visible')).toBe(false)
    expect(defaultRegistry.get('shell.layout.right.open')).toBe(true)
  })

  it('persists only the envelope owning the changed setting', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage
    const projectKey = 'dinkster.p.p-alpha.settings'
    const scoped = { id: 'shell.layout.right.open', name: 'Right rail open', type: 'boolean' as const, defaultValue: true, projectScoped: true }
    // Window A and window B share storage but hold independent in-memory copies.
    const windowA = new SettingsRegistry(store, projectKey)
    windowA.register(setting)
    windowA.register(scoped)
    const windowB = new SettingsRegistry(store, projectKey)
    windowB.register(setting)
    windowB.register(scoped)
    windowB.set('shell.layout.right.open', false)
    windowA.set('canvas.grid.visible', false) // A's global change must not rewrite B's newer project value
    expect(JSON.parse(data.get(projectKey)!).values).toEqual({ 'shell.layout.right.open': false })
    windowB.set('shell.layout.right.open', true) // B's project change must not rewrite A's newer global value
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY)!).values).toEqual({ 'canvas.grid.visible': false })
  })

  it('patches single settings into the shared envelope instead of rewriting it', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage
    const left = { id: 'shell.layout.left.open', name: 'Left rail open', type: 'boolean' as const, defaultValue: true, projectScoped: true }
    const right = { id: 'shell.layout.right.open', name: 'Right rail open', type: 'boolean' as const, defaultValue: true, projectScoped: true }
    const projectKey = 'dinkster.p.p-alpha.settings'
    // Two windows on the SAME project hold independent in-memory copies.
    const windowA = new SettingsRegistry(store, projectKey)
    windowA.register(left)
    windowA.register(right)
    const windowB = new SettingsRegistry(store, projectKey)
    windowB.register(left)
    windowB.register(right)
    windowA.set('shell.layout.left.open', false)
    windowB.set('shell.layout.right.open', false) // must not erase A's newer left value
    expect(JSON.parse(data.get(projectKey)!).values).toEqual({
      'shell.layout.left.open': false,
      'shell.layout.right.open': false,
    })
    windowA.set('shell.layout.left.open', true) // back to default: removes only its own key
    expect(JSON.parse(data.get(projectKey)!).values).toEqual({ 'shell.layout.right.open': false })
  })

  it('aliases project overrides to the global envelope in the default project', () => {
    const store = storage()
    const registry = new SettingsRegistry(store, SETTINGS_STORAGE_KEY)
    registry.register({ id: 'shell.layout.right.open', name: 'Right rail open', type: 'boolean', defaultValue: true, projectScoped: true })
    registry.set('shell.layout.right.open', false)
    expect(JSON.parse(store.getItem(SETTINGS_STORAGE_KEY)!).values).toEqual({ 'shell.layout.right.open': false })
    expect(registry.get('shell.layout.right.open')).toBe(false)
  })

  it('reloads global and project envelopes changed by another window', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage
    const projectKey = 'dinkster.p.p-alpha.settings'
    const registry = new SettingsRegistry(store, projectKey)
    registry.register(setting)
    registry.register({ id: 'shell.layout.right.open', name: 'Right rail open', type: 'boolean', defaultValue: true, projectScoped: true })
    const initialTick = registry.changed.get()

    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ v: 1, values: { 'canvas.grid.visible': false } }))
    registry.refreshFromStorage(SETTINGS_STORAGE_KEY)
    expect(registry.get('canvas.grid.visible')).toBe(false)
    expect(registry.get('shell.layout.right.open')).toBe(true)

    store.setItem(projectKey, JSON.stringify({ v: 1, values: { 'shell.layout.right.open': false } }))
    registry.refreshFromStorage(projectKey)
    expect(registry.get('canvas.grid.visible')).toBe(false)
    expect(registry.get('shell.layout.right.open')).toBe(false)
    expect(registry.changed.get()).toBe(initialTick + 2)
  })

  it('discards unknown versions and falls back to the registered default', () => {
    const registry = new SettingsRegistry(storage(JSON.stringify({ v: 99, values: { 'canvas.grid.visible': false } })))
    registry.register(setting)
    expect(registry.get('canvas.grid.visible')).toBe(true)
  })

  it('FR11 persisted overrides are validated against their definitions', () => {
    const seeded = storage(JSON.stringify({ v: 1, values: {
      'test.boolean': 'false',
      'test.low': -1,
      'test.high': 11,
      'test.combo': 'missing',
      'test.valid': 7,
      'test.custom': { legacy: true },
    } }))
    const registry = new SettingsRegistry(seeded)
    registry.register({ id: 'test.boolean', name: 'Boolean', type: 'boolean', defaultValue: true })
    registry.register({ id: 'test.low', name: 'Low', type: 'number', defaultValue: 5, min: 0, max: 10 })
    registry.register({ id: 'test.high', name: 'High', type: 'number', defaultValue: 5, min: 0, max: 10 })
    registry.register({ id: 'test.combo', name: 'Combo', type: 'combo', defaultValue: 'one', options: [{ value: 'one', label: 'One' }] })
    registry.register({ id: 'test.valid', name: 'Valid', type: 'number', defaultValue: 5, min: 0, max: 10 })
    registry.register({ id: 'test.custom', name: 'Custom', type: 'extension-value', defaultValue: null })
    expect(registry.isUsableValue('test.valid', 7)).toBe(true)
    expect(registry.isUsableValue('test.valid', 11)).toBe(false)
    expect(registry.isUsableValue('test.missing', true)).toBe(false)
    expect(registry.get('test.boolean')).toBe(true)
    expect(registry.get('test.low')).toBe(5)
    expect(registry.get('test.high')).toBe(5)
    expect(registry.get('test.combo')).toBe('one')
    expect(registry.get('test.valid')).toBe(7)
    expect(registry.get('test.custom')).toEqual({ legacy: true })

    registry.set('test.valid', Number.NaN)
    expect(registry.get('test.valid')).toBe(5)
    registry.set('test.valid', Number.POSITIVE_INFINITY)
    expect(registry.get('test.valid')).toBe(5)
  })

  it('selects the first populated derived category initially', () => {
    expect(initialSettingsCategory([setting], (definition) => new SettingsRegistry(storage()).categoryOf(definition))).toBe('canvas.grid')
    expect(initialSettingsCategory([], () => 'unused')).toBe('keybindings')
  })
})

describe('keybindings', () => {
  const event = (key: string, over: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...over }) as KeyboardEvent
  it('reloads remote overrides from the settings envelope', () => {
    const store = storage()
    const settings = new SettingsRegistry(store)
    const keys = new KeybindingRegistry(settings)
    keys.register({ command: 'save', combo: 'Ctrl+S' })

    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      v: 1,
      values: { 'keybindings.overrides': JSON.stringify({ save: 'alt+s' }) },
    }))
    settings.refreshFromStorage(SETTINGS_STORAGE_KEY)

    expect(keys.combo('save')).toBe('alt+s')
    expect(keys.match(event('s', { altKey: true }))).toBe('save')
    expect(keys.match(event('s', { ctrlKey: true }))).toBeUndefined()
  })

  it('does not retain a local keybinding after a remote reset', () => {
    const store = storage()
    const settings = new SettingsRegistry(store)
    const keys = new KeybindingRegistry(settings)
    keys.register({ command: 'save', combo: 'Ctrl+S' })
    expect(keys.combo('save')).toBe('ctrl+s')
    keys.set('save', 'Alt+S')

    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ v: 1, values: {} }))
    settings.refreshFromStorage(SETTINGS_STORAGE_KEY)

    expect(keys.combo('save')).toBe('ctrl+s')
  })

  it('keeps modifiers pending, completes chords, and reserves Escape for cancel', () => {
    expect(captureKeydown(event('Control'))).toEqual({ kind: 'pending', combo: 'ctrl' })
    expect(captureKeydown(event('k', { ctrlKey: true }))).toEqual({ kind: 'complete', combo: 'ctrl+k' })
    expect(captureKeydown(event('Escape'))).toEqual({ kind: 'cancel' })
  })
  it('matches normalized modifiers and gives overrides precedence', () => {
    const settings = new SettingsRegistry(storage())
    const keys = new KeybindingRegistry(settings)
    keys.register({ command: 'save', combo: 'Ctrl+S' })
    expect(keys.match(event('s', { ctrlKey: true }))).toBe('save')
    keys.set('save', 'Alt+S')
    expect(keys.match(event('s', { ctrlKey: true }))).toBeUndefined()
    expect(keys.match(event('s', { altKey: true }))).toBe('save')
  })

  it('suppresses text-input events unless a binding explicitly opts in', () => {
    const keys = new KeybindingRegistry(new SettingsRegistry(storage()))
    keys.register({ command: 'ordinary', combo: 'Ctrl+K' })
    keys.register({ command: 'input-safe', combo: 'Ctrl+L', allowInInput: true })
    const input = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget
    expect(keys.match(event('k', { ctrlKey: true, target: input }))).toBeUndefined()
    expect(keys.match(event('l', { ctrlKey: true, target: input }))).toBe('input-safe')
  })

  it('detects rebind conflicts and supports clear/reset', () => {
    const keys = new KeybindingRegistry(new SettingsRegistry(storage()))
    keys.register({ command: 'one', combo: 'Ctrl+1' })
    keys.register({ command: 'two', combo: 'Ctrl+2' })
    keys.set('two', 'Ctrl+1')
    expect(keys.conflicts().get('ctrl+1')).toEqual(['one', 'two'])
    keys.set('two', null)
    expect(keys.combo('two')).toBeUndefined()
    keys.reset('two')
    expect(keys.combo('two')).toBe('ctrl+2')
  })
})

describe('shared shortcut suppression', () => {
  it('keeps copy, paste, and cut native in every text editor surface', () => {
    const originalDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } })
    try {
      const editors = [
        { tagName: 'INPUT', isContentEditable: false },
        { tagName: 'TEXTAREA', isContentEditable: false },
        { tagName: 'DIV', isContentEditable: true },
      ] as unknown as EventTarget[]
      const modifiers = [
        { ctrlKey: true, metaKey: false },
        { ctrlKey: false, metaKey: true },
      ]

      for (const editor of editors) {
        for (const key of ['c', 'v', 'x']) {
          for (const modifier of modifiers) {
            const event = {
              key, ...modifier, altKey: false, shiftKey: false, target: editor,
            } as KeyboardEvent
            expect(shortcutSuppressed(event)).toBe(true)
          }
        }
      }
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: Document }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }
  })

  it('lets a native text scope own every key while preserving canvas shortcuts elsewhere', () => {
    const originalDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelector: () => null },
    })
    try {
      const inProblems = { closest: (selector: string) => selector.includes('[data-native-text-scope]') ? {} : null } as unknown as EventTarget
      const onCanvas = { closest: () => null } as unknown as EventTarget
      const event = (target: EventTarget, metaKey = false) => ({
        key: 'c', ctrlKey: !metaKey, metaKey, altKey: false, shiftKey: false, target,
      }) as KeyboardEvent

      expect(shortcutSuppressed(event(inProblems))).toBe(true)
      expect(shortcutSuppressed(event(inProblems, true))).toBe(true)
      expect(isNativeTextScopeTarget(inProblems)).toBe(true)
      expect(shortcutSuppressed(event(onCanvas))).toBe(false)
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: Document }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }
  })

  it('lets widgets and the Problems sidebar own mod+Shift+V connected paste', () => {
    const originalDocument = globalThis.document
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } })
    try {
      const widget = { tagName: 'INPUT', closest: () => null } as unknown as EventTarget
      const problems = { closest: (selector: string) => selector.includes('[data-native-text-scope]') ? {} : null } as unknown as EventTarget
      const event = (target: EventTarget) => ({
        key: 'v', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, target,
      }) as KeyboardEvent
      expect(shortcutSuppressed(event(widget))).toBe(true)
      expect(shortcutSuppressed(event(problems))).toBe(true)
    } finally {
      if (originalDocument === undefined) delete (globalThis as { document?: Document }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }
  })
})
