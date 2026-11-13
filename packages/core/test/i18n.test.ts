import { beforeEach, describe, expect, it } from 'vitest'
import { activeLocale, formatDate, formatNumber, formatRelativeTime, registerCatalog, setLocale, t, tPlural } from '../src/i18n/index.js'

const english = {
  greeting: 'Hello, {name}',
  items: '{count, plural, one {# item for {name}} other {# items for {name}}}',
  fallback: 'English fallback',
}

describe('i18n', () => {
  beforeEach(() => {
    registerCatalog('en', english)
    registerCatalog('zh', {})
    setLocale('en')
  })

  it('interpolates values and retains a missing parameter', () => {
    expect(t('greeting', { name: 'Ada' })).toBe('Hello, Ada')
    expect(t('greeting')).toBe('Hello, {name}')
  })

  it('selects plural categories with interpolation', () => {
    expect(tPlural('items', 1, { name: 'Ada' })).toBe('1 item for Ada')
    expect(tPlural('items', 2, { name: 'Ada' })).toBe('2 items for Ada')
  })

  it('falls back by base language, English, and then key', () => {
    registerCatalog('zh', { greeting: 'Ni hao, {name}' })
    setLocale('zh-CN')
    expect(t('greeting', { name: 'Ada' })).toBe('Ni hao, Ada')
    expect(t('fallback')).toBe('English fallback')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('publishes canonical locale changes', () => {
    const seen: string[] = []
    const unsubscribe = activeLocale.subscribe((locale) => seen.push(locale.tag))
    setLocale('zh-cn')
    setLocale('zh-CN')
    unsubscribe()
    expect(activeLocale.get()).toEqual({ tag: 'zh-CN', dir: 'ltr' })
    expect(seen).toEqual(['zh-CN'])
  })

  it('binds all Intl wrappers to the active locale', () => {
    setLocale('en-US')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatDate(new Date(Date.UTC(2026, 0, 2)), { timeZone: 'UTC', dateStyle: 'medium' })).toBe('Jan 2, 2026')
    expect(formatRelativeTime(-1, 'day', { numeric: 'auto' })).toBe('yesterday')

    setLocale('zh-CN')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatDate(new Date(Date.UTC(2026, 0, 2)), { timeZone: 'UTC', dateStyle: 'medium' })).toBe('2026\u5e741\u67082\u65e5')
    expect(formatRelativeTime(-1, 'day', { numeric: 'auto' })).toBe('\u6628\u5929')

    setLocale('de-DE')
    expect(formatNumber(1234.5)).toBe('1.234,5')
  })
})
