// @vitest-environment happy-dom

import { registerCatalog, setLocale } from '@dinkster/core'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityLog, formatActivityTimestamp } from '../src/ActivityLog.js'
import type { AppLogEntry } from '../src/app-state.js'

const entry = (
  index: number,
  severity: AppLogEntry['severity'] = 'info',
): AppLogEntry => ({
  timestamp: Date.UTC(2026, 7, 16, 12, 30, index),
  severity,
  source: index === 2 ? 'Disconnected backend / a-very-long-identifier' : 'Local backend',
  message: index === 2
    ? 'A deliberately long message that remains selectable and wraps instead of clipping.'
    : `Activity message ${index + 1}`,
})

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
})

describe('ActivityLog', () => {
  it('renders a deterministic empty state', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ActivityLog entries={() => []} clearArmed={() => false} />, root)

    expect(root.querySelector('[data-testid="activity-log-empty"]')?.textContent).toContain('No activity yet')
    expect(root.querySelector('[role="log"]')?.tagName).toBe('DIV')
    dispose()
  })

  it('separates exact timestamps, severity, source, and message without color-only meaning', () => {
    const entries = [entry(0), entry(1, 'warn'), entry(2, 'error')]
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ActivityLog entries={() => entries} clearArmed={() => true} />, root)

    const log = root.querySelector<HTMLElement>('[role="log"]')!
    const rows = [...root.querySelectorAll<HTMLElement>('.activity-log-row')]
    expect(log.getAttribute('aria-label')).toBe('Activity events')
    expect(rows.map((row) => row.dataset['severity'])).toEqual(['info', 'warn', 'error'])
    expect(rows[2]!.querySelector('.activity-log-time')?.textContent).toBe('2026-08-16 12:30:02.000 UTC')
    expect(rows[2]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-16T12:30:02.000Z')
    expect(rows[2]!.querySelector('.activity-log-severity')?.textContent).toBe('error')
    expect(rows[2]!.querySelector('.activity-log-source')?.textContent).toContain('Disconnected backend')
    expect(rows[2]!.querySelector('.activity-log-message')?.textContent).toContain('remains selectable')
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Choose Clear again within 4 seconds')
    log.focus()
    expect(document.activeElement).toBe(log)
    dispose()
  })

  it('reactively translates mounted chrome without replacing log facts or reader state', async () => {
    registerCatalog('de-DE', {
      'activityLog.aria.contents': '[Aktivitatsinhalt]',
      'activityLog.aria.events': '[Aktivitatsereignisse]',
      'activityLog.clearArmed': '[Loschen aktiv: {count, plural, one {# Eintrag} other {# Eintrage}}]',
      'activityLog.empty.description': '[Verbindungs- und Ausfuhrungsereignisse erscheinen hier.]',
      'activityLog.empty.title': '[Noch keine Aktivitat]',
      'error': '[Nicht ubersetzen]',
      'Local backend': '[Nicht ubersetzen]',
    })
    const [entries, setEntries] = createSignal<readonly AppLogEntry[]>([entry(2, 'error')])
    const [clearArmed, setClearArmed] = createSignal(true)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ActivityLog entries={entries} clearArmed={clearArmed} />, root)
    const log = root.querySelector<HTMLDivElement>('[role="log"]')!
    const row = root.querySelector<HTMLElement>('.activity-log-row')!
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 200 })
    await flush()
    log.scrollTop = 25
    log.dispatchEvent(new Event('scroll'))
    log.focus()

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('[data-testid="logs-panel"]')?.getAttribute('aria-label')).toBe('[Aktivitatsinhalt]')
    expect(log.getAttribute('aria-label')).toBe('[Aktivitatsereignisse]')
    expect(root.querySelector('[role="log"]')).toBe(log)
    expect(root.querySelector('.activity-log-row')).toBe(row)
    expect(document.activeElement).toBe(log)
    expect(log.scrollTop).toBe(25)
    expect(root.querySelector('[role="status"]')?.textContent).toBe('[Loschen aktiv: 1 Eintrag]')
    expect(row.querySelector('.activity-log-time')?.textContent).toBe('2026-08-16 12:30:02.000 UTC')
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-16T12:30:02.000Z')
    expect(row.querySelector('.activity-log-severity')?.textContent).toBe('error')
    expect(row.querySelector('.activity-log-source')?.textContent).toBe('Disconnected backend / a-very-long-identifier')
    expect(row.querySelector('.activity-log-message')?.textContent).toContain('remains selectable')

    setClearArmed(false)
    setEntries([])
    await flush()
    expect(root.querySelector('[data-testid="activity-log-empty"]')?.textContent).toBe('[Noch keine Aktivitat][Verbindungs- und Ausfuhrungsereignisse erscheinen hier.]')
    expect(root.querySelector('[role="log"]')).toBe(log)
    dispose()
  })

  it('follows appended entries only while the reader remains at the tail', async () => {
    const [entries, setEntries] = createSignal<readonly AppLogEntry[]>(Array.from({ length: 6 }, (_, index) => entry(index)))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ActivityLog entries={entries} clearArmed={() => false} />, root)
    const log = root.querySelector<HTMLDivElement>('[role="log"]')!
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => entries().length * 20 })
    await flush()
    expect(log.scrollTop).toBe(120)

    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    await flush()
    setEntries((current) => [...current, entry(6)])
    await flush()
    expect(log.scrollTop).toBe(0)

    log.scrollTop = 40
    log.dispatchEvent(new Event('scroll'))
    await flush()
    setEntries((current) => [...current, entry(7)])
    await flush()
    expect(log.scrollTop).toBe(160)

    setEntries([])
    await flush()
    expect(log.scrollTop).toBe(0)
    setEntries([entry(0)])
    await flush()
    expect(root.querySelector<HTMLDivElement>('[role="log"]')).toBe(log)
    dispose()
  })

  it('formats timestamps independently of the browser locale', () => {
    expect(formatActivityTimestamp(Date.UTC(2026, 7, 16, 1, 2, 3, 4))).toBe('2026-08-16 01:02:03.004 UTC')
  })
})
