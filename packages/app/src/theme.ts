import { t } from '@dinkster/core'
import { SettingsRegistry } from './settings.js'

export function registerThemeSetting(settings: SettingsRegistry): void {
  settings.register({
    id: 'dinkster.theme',
    category: 'dinkster',
    type: 'combo',
    defaultValue: 'dark',
    get name() {
      return t('settings.theme.name')
    },
    get options() {
      return [
        { value: 'dark', label: t('settings.theme.dark') },
        { value: 'light', label: t('settings.theme.light') },
      ]
    },
  })
}

export function bindTheme(settings: SettingsRegistry): () => void {
  const update = () => {
    document.documentElement.dataset['theme'] =
      settings.get<string>('dinkster.theme')
  }
  update()
  return settings.changed.subscribe(update)
}

export function bindPersistedTheme(): () => void {
  const settings = new SettingsRegistry()
  registerThemeSetting(settings)
  const dispose = bindTheme(settings)
  const receive = (event: StorageEvent) =>
    settings.refreshFromStorage(event.key)
  window.addEventListener('storage', receive)
  return () => {
    dispose()
    window.removeEventListener('storage', receive)
  }
}
