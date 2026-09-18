import { activeLocale, setLocale } from '@dinkster/core'
import { afterEach, describe, expect, it } from 'vitest'
import { bindLocale, bindPersistedLocale, LOCALE_SETTING_ID, registerLocaleSetting } from '../src/locale.js'
import { SETTINGS_STORAGE_KEY, SettingsRegistry } from '../src/settings.js'

function registry(value?: string): SettingsRegistry {
  const stored = value === undefined
    ? null
    : JSON.stringify({ v: 1, values: { [LOCALE_SETTING_ID]: value } })
  const settings = new SettingsRegistry({ getItem: () => stored, setItem: () => undefined })
  registerLocaleSetting(settings)
  return settings
}

afterEach(() => setLocale('en'))

describe('app locale', () => {
  it('registers the global locale setting', () => {
    const settings = registry()
    const definition = settings.list().find((entry) => entry.id === LOCALE_SETTING_ID)
    expect(definition).toMatchObject({ defaultValue: 'auto' })
    expect(definition?.projectScoped).toBeUndefined()
    expect(definition?.options).toEqual([
      { value: 'auto', label: 'Automatic' },
      { value: 'en', label: 'English' },
      { value: 'zh', label: 'Chinese' },
    ])
  })

  it('uses desktop locale before browser locale in automatic mode', () => {
    const settings = registry()
    const root = { lang: '', dir: '' }
    const dispose = bindLocale(settings, root, 'en-US', 'zh-CN')
    expect(activeLocale.get().tag).toBe('zh-CN')
    expect(root).toEqual({ lang: 'zh-CN', dir: 'ltr' })
    dispose()
  })

  it('applies an explicit setting and updates the root language', () => {
    const settings = registry('en')
    const root = { lang: '', dir: '' }
    const dispose = bindLocale(settings, root, 'zh-CN')
    expect(activeLocale.get().tag).toBe('en')
    expect(root).toEqual({ lang: 'en', dir: 'ltr' })
    dispose()
  })

  it('binds the desktop default and persisted overrides until the setup owner disposes', () => {
    let stored = JSON.stringify({ v: 1, values: { [LOCALE_SETTING_ID]: 'auto' } })
    const storage = { getItem: () => stored, setItem: () => undefined }
    const listeners = new Set<(event: StorageEvent) => void>()
    const events = {
      addEventListener: (_type: 'storage', listener: (event: StorageEvent) => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'storage', listener: (event: StorageEvent) => void) => { listeners.delete(listener) },
    }
    const root = { lang: '', dir: '' }

    const dispose = bindPersistedLocale(storage, root, 'en-US', 'zh-CN', events)
    expect(root).toEqual({ lang: 'zh-CN', dir: 'ltr' })
    expect(listeners.size).toBe(1)

    stored = JSON.stringify({ v: 1, values: { [LOCALE_SETTING_ID]: 'en' } })
    for (const listener of listeners) listener({ key: SETTINGS_STORAGE_KEY } as StorageEvent)
    expect(root).toEqual({ lang: 'en', dir: 'ltr' })

    dispose()
    expect(listeners.size).toBe(0)
  })

  it('binds an automatic RTL pseudo-locale to root language and direction', () => {
    const settings = registry()
    const root = { lang: '', dir: '' }
    const dispose = bindLocale(settings, root, 'ar-XB')
    expect(root).toEqual({ lang: 'ar-XB', dir: 'rtl' })
    dispose()
  })
})
