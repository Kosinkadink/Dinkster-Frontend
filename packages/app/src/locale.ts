import { activeLocale, registerCatalog, setLocale, t, type MessageCatalog, type MessageParams } from '@dinkster/core'
import english from './locales/en.json'
import chinese from './locales/zh.json'
import { SettingsRegistry } from './settings.js'
import { useSignal } from './solid-adapter.js'

export const LOCALE_SETTING_ID = 'dinkster.locale'

registerCatalog('en', english satisfies MessageCatalog)
registerCatalog('zh', chinese satisfies MessageCatalog)

type AppMessageKey = keyof typeof english
type MessageGroupKey<Prefix extends string> = Extract<AppMessageKey, `${Prefix}.${string}`> extends `${Prefix}.${infer Key}` ? Key : never

export function useAppMessage(): (key: string, params?: MessageParams) => string {
  const locale = useSignal(activeLocale)
  return (key, params) => {
    locale()
    return t(key, params)
  }
}

export function useAppMessageGroup<Prefix extends string>(prefix: Prefix): () => Readonly<Record<MessageGroupKey<Prefix>, string>> {
  const message = useAppMessage()
  const messages = new Proxy({}, {
    get: (_target, key: string) => message(`${prefix}.${key}`),
  }) as Readonly<Record<MessageGroupKey<Prefix>, string>>
  return () => messages
}

export function registerLocaleSetting(settings: SettingsRegistry): void {
  settings.register({
    id: LOCALE_SETTING_ID,
    get name() { return t('settings.language.name') },
    category: 'dinkster',
    type: 'combo',
    defaultValue: 'auto',
    get description() { return t('settings.language.description') },
    get options() {
      return [
        { value: 'auto', label: t('settings.language.option.auto') },
        { value: 'en', label: t('settings.language.option.en') },
        { value: 'zh', label: t('settings.language.option.zh') },
      ]
    },
  })
}

export function bindLocale(
  settings: SettingsRegistry,
  root: Pick<HTMLElement, 'dir' | 'lang'>,
  browserLocale: string,
  desktopLocale?: string,
): () => void {
  const update = () => {
    const selected = settings.get<string>(LOCALE_SETTING_ID)
    setLocale(selected === 'auto' ? (desktopLocale ?? browserLocale) : selected)
    root.lang = activeLocale.get().tag
    root.dir = activeLocale.get().dir
  }
  update()
  return settings.changed.subscribe(update)
}

export function bindPersistedLocale(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  root: Pick<HTMLElement, 'dir' | 'lang'>,
  browserLocale: string,
  desktopLocale?: string,
  events: {
    addEventListener(type: 'storage', listener: (event: StorageEvent) => void): void
    removeEventListener(type: 'storage', listener: (event: StorageEvent) => void): void
  } = globalThis,
): () => void {
  const settings = new SettingsRegistry(storage)
  registerLocaleSetting(settings)
  const disposeLocale = bindLocale(settings, root, browserLocale, desktopLocale)
  const receiveStorage = (event: StorageEvent) => settings.refreshFromStorage(event.key)
  events.addEventListener('storage', receiveStorage)
  return () => {
    events.removeEventListener('storage', receiveStorage)
    disposeLocale()
  }
}
