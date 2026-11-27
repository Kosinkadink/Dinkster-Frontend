// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import type { LibraryStorage, PackSettings } from '@dinkster/client'
import { registerCatalog, setLocale, t } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../src/locale.js'
import { SettingsDialog } from '../src/SettingsDialog.js'
import { LibraryStorageSettings } from '../src/LibraryStorageSettings.js'
import { CommandRegistry, KeybindingRegistry, SettingsRegistry, SETTINGS_STORAGE_KEY } from '../src/settings.js'

const isolatedSettings = (): SettingsRegistry => new SettingsRegistry({ getItem: () => null, setItem: () => {} })

const mountDialog = () => {
  const settings = isolatedSettings()
  const commands = new CommandRegistry()
  const keybindings = new KeybindingRegistry(settings)
  settings.register({ id: 'canvas.grid.visible', name: 'Show grid', category: 'canvas', type: 'boolean', defaultValue: true })
  settings.register({ id: 'canvas.quality', name: 'Canvas quality', category: 'canvas', description: 'Balance rendering speed and quality', type: 'combo', defaultValue: 'balanced', options: [{ value: 'balanced', label: 'Balanced' }, { value: 'quality', label: 'Quality' }] })
  const unregisterShell = settings.register({ id: 'shell.gridGuide', name: 'Grid guide', category: 'shell', description: 'Show layout guides', type: 'boolean', defaultValue: false })
  commands.register({ id: 'workflow.open', label: 'Open workflow library', run: () => {} })
  commands.register({ id: 'workflow.save', label: 'Save workflow', run: () => {} })
  keybindings.register({ command: 'workflow.open', combo: 'Ctrl+O' })
  keybindings.register({ command: 'workflow.save', combo: 'Ctrl+S' })
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)
  root.querySelector<HTMLAnchorElement>('a[href="#canvas"]')!.click()
  return { root, settings, keybindings, unregisterShell, unmount }
}

const mountRequestedDialog = (onConsumed: () => void) => {
  const settings = isolatedSettings()
  const commands = new CommandRegistry()
  const keybindings = new KeybindingRegistry(settings)
  settings.register({ id: 'canvas.grid.visible', name: 'Show grid', category: 'canvas', type: 'boolean', defaultValue: true })
  settings.register({ id: 'shell.gridGuide', name: 'Grid guide', category: 'shell', type: 'boolean', defaultValue: false })
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <SettingsDialog
    settings={settings}
    commands={commands}
    keybindings={keybindings}
    request={{ category: 'shell', id: 'shell.gridGuide' }}
    onRequestConsumed={onConsumed}
  />, root)
  return { root, unmount }
}

const searchFor = (root: HTMLElement, query: string): void => {
  const search = root.querySelector<HTMLInputElement>('.dinkster-search-input')!
  search.value = query
  search.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
})

describe('SettingsDialog search', () => {
  it('groups shortcuts by area and searches their translated group names', () => {
    const settings = isolatedSettings()
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    for (const [id, label] of [['view.fit', 'Fit selection'], ['edit.undo', 'Undo'], ['workflow.save', 'Save workflow']]) {
      commands.register({ id: id!, label: label!, run: () => {} })
      keybindings.register({ command: id!, combo: 'Ctrl+S' })
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)
    root.querySelector<HTMLAnchorElement>('a[href="#shortcuts"]')!.click()
    expect([...root.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['Workflow', 'Edit', 'View'])
    expect(root.querySelector('[data-command-id="edit.undo"] [role="status"]')?.textContent).toBe('Also used by Fit selection, Save workflow.')
    setLocale('zh')
    searchFor(root, '\u89c6\u56fe')
    expect([...root.querySelectorAll('[data-command-id]')].map((row) => row.getAttribute('data-command-id'))).toEqual(['view.fit'])
    expect(root.querySelector('.dinkster-search-row')?.textContent).toContain('\u5feb\u6377\u952e - \u89c6\u56fe')
    unmount()
  })

  it.each([
    ['en', 'Wheel'],
    ['zh', '\u6eda\u8f6e'],
  ])('renders complete %s shortcut names without consuming adjacent prose', (locale, wheel) => {
    setLocale(locale)
    const settings = isolatedSettings()
    settings.register({ id: 'canvas.scrollBehavior', name: t('settings.canvas.scrollBehavior.name'), category: 'canvas', description: t('settings.canvas.scrollBehavior.description'), type: 'boolean', defaultValue: false })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={new CommandRegistry()} keybindings={new KeybindingRegistry(settings)} />, root)
    root.querySelector<HTMLAnchorElement>('a[href="#canvas"]')!.click()
    const description = root.querySelector('#setting-canvas\\.scrollBehavior-description')!
    expect([...description.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual([`Ctrl+${wheel}`])
    expect(description.textContent).toBe(t('settings.canvas.scrollBehavior.description').replace(/`/g, '').replace('Ctrl+wheel', 'Ctrl+Wheel'))
    expect(root.querySelector('#setting-canvas\\.scrollBehavior')?.getAttribute('aria-describedby')).toContain(description.id)
    unmount()
  })

  it('discards pending accounting from a replaced backend', async () => {
    const settings = isolatedSettings()
    const status: LibraryStorage = { temporaryBytes: 37, vaultBytes: 313, adoptedBytes: 211,
      reclaimableBytes: null, blocked: ['owner_completeness_unknown'], collectionEnabled: false,
      policyAvailable: true, limitBytes: 8193 }
    let resolve!: (value: LibraryStorage) => void
    const pending = new Promise<LibraryStorage>((done) => { resolve = done })
    const [connection, setConnection] = createSignal({ fetchLibraryStorage: () => pending,
      updateLibraryStorageLimit: async () => {}, clearLibraryStorage: async () => { throw new Error('Clear must remain blocked') } })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={new CommandRegistry()}
      keybindings={new KeybindingRegistry(settings)} storageConnection={connection()}
      request={{ category: 'storage', id: 'library-storage-limit' }} />, root)
    expect(root.textContent).toContain('Loading storage accounting')
    setConnection({ fetchLibraryStorage: async () => status, updateLibraryStorageLimit: async () => {},
      clearLibraryStorage: async () => { throw new Error('Clear must remain blocked') } })
    await vi.waitFor(() => expect(root.querySelector('#library-storage-temporaryBytes')?.textContent).toBe('37 bytes'))
    resolve({ ...status, temporaryBytes: 999 })
    await Promise.resolve()
    expect(root.querySelector('#library-storage-temporaryBytes')?.textContent).toBe('37 bytes')
    expect(root.querySelector('#library-storage-vaultBytes')).toBeNull()
    unmount()
  })

  it('distinguishes unknown storage from zero and saves a limit without enabling Clear', async () => {
    let limit: number | null = 8193
    const connection = {
      fetchLibraryStorage: async () => ({ temporaryBytes: 8193, vaultBytes: 8193, adoptedBytes: 0,
        reclaimableBytes: null, blocked: ['owner_completeness_unknown'], collectionEnabled: false,
        policyAvailable: true, limitBytes: limit }),
      updateLibraryStorageLimit: async (next: number | null) => { limit = next },
      clearLibraryStorage: async () => { throw new Error('Clear must remain blocked') },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <LibraryStorageSettings connection={connection} />, root)
    await vi.waitFor(() => expect(root.querySelector('#library-storage-adoptedBytes')?.textContent).toBe('0 bytes'))
    expect(root.querySelector('#library-storage-reclaimableBytes')?.textContent).toBe('Unknown')
    const clear = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Clear')!
    expect(clear.disabled).toBe(true)
    const overLimit = 'Files in use are kept, so the total can stay above the limit.'
    expect(root.textContent).not.toContain(overLimit)
    const input = root.querySelector<HTMLInputElement>('#library-storage-limit')!
    for (const [raw, above] of [['4097', true], ['8193', false]] as const) {
      await vi.waitFor(() => expect(input.disabled).toBe(false))
      input.value = `${raw} B`
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await vi.waitFor(() => expect(limit).toBe(Number(raw)))
      expect(root.textContent?.includes(overLimit)).toBe(above)
    }
    await vi.waitFor(() => expect(input.disabled).toBe(false))
    root.querySelector<HTMLButtonElement>('#library-storage-limited')!.click()
    await vi.waitFor(() => expect(limit).toBeNull())
    await vi.waitFor(() => expect(root.querySelector('#library-storage-limit')).toBeNull())
    expect(clear.disabled).toBe(true)
    expect(root.textContent).toContain('The backend cannot confirm which files are in use.')
    expect(root.querySelector('dialog')).toBeNull()
    expect(root.textContent).not.toContain('Apply limit')
    unmount()
  })

  it('shows cleanup progress, server byte totals, explicit retry and backend refusal', async () => {
    let enabled = true
    let finish!: () => void
    let fail = true
    let clearRequests = 0
    let pending = new Promise<void>((resolve) => { finish = resolve })
    const connection = {
      fetchLibraryStorage: async () => ({ temporaryBytes: 37, vaultBytes: 513, adoptedBytes: 299,
        reclaimableBytes: enabled ? 113 : null, blocked: enabled ? [] : ['owner_completeness_unknown'],
        collectionEnabled: enabled, policyAvailable: true, limitBytes: 21474836480 }),
      updateLibraryStorageLimit: async () => {},
      clearLibraryStorage: async () => {
        clearRequests += 1
        await pending
        if (fail) throw new Error('Cleanup unavailable')
        return { collectionEnabled: enabled, blocked: enabled ? [] : ['owner_completeness_unknown'],
          reclaimedBytes: enabled ? 113 : 0, reclaimedFiles: enabled ? 2 : 0 }
      },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <LibraryStorageSettings connection={connection} />, root)
    await vi.waitFor(() => expect(root.querySelector('#library-storage-reclaimableBytes')?.textContent).toBe('113 bytes'))
    const clear = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Clear')!
    await vi.waitFor(() => expect(clear.disabled).toBe(false))
    clear.click()
    expect(root.querySelector('dialog')?.textContent).toContain('Removes 113 bytes of files that no run or project is using. This cannot be undone.')
    ;[...root.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent === 'Cancel')!.click()
    expect(clearRequests).toBe(0)
    expect(root.querySelector('dialog')).toBeNull()
    const confirm = () => [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent === 'Clear')!
    clear.click()
    confirm().click()
    expect(confirm().getAttribute('aria-disabled')).toBe('true')
    confirm().click()
    expect(clearRequests).toBe(1)
    finish()
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe('Cleanup unavailable'))
    expect(clear.disabled).toBe(false)
    fail = false
    pending = Promise.resolve()
    clear.click()
    confirm().click()
    await vi.waitFor(() => expect(root.textContent).toContain('113 bytes freed across 2 files'))
    await vi.waitFor(() => expect(clear.disabled).toBe(false))
    enabled = false
    clear.click()
    confirm().click()
    await vi.waitFor(() => expect(root.textContent).toContain('The backend cannot confirm which files are in use.'))
    expect(clear.disabled).toBe(true)
    expect(root.querySelector('dialog')).toBeNull()
    expect(root.textContent).not.toContain('owner_completeness_unknown')
    unmount()
  })

  it('does not present an unavailable policy as unlimited or accept a failed write', async () => {
    let available = false
    const connection = {
      fetchLibraryStorage: async () => ({ temporaryBytes: null, vaultBytes: null, adoptedBytes: null,
        reclaimableBytes: null, blocked: ['reference_state_unavailable'], collectionEnabled: false,
        policyAvailable: available, limitBytes: available ? 8193 : null }),
      updateLibraryStorageLimit: async () => { throw new Error('Operator permission denied') },
      clearLibraryStorage: async () => { throw new Error('Clear must remain blocked') },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <LibraryStorageSettings connection={connection} />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('The saved policy is unavailable'))
    const limited = root.querySelector<HTMLButtonElement>('#library-storage-limited')!
    expect(limited.getAttribute('aria-checked')).toBe('false')
    expect(limited.disabled).toBe(true)
    available = true
    ;[...root.querySelectorAll('button')].find((button) => button.textContent === 'Refresh')!.click()
    await vi.waitFor(() => expect(limited.disabled).toBe(false))
    limited.click()
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe('Operator permission denied'))
    expect(limited.getAttribute('aria-checked')).toBe('true')
    expect(root.querySelector('#library-storage-temporaryBytes')?.textContent).toBe('Unknown')
    const input = root.querySelector<HTMLInputElement>('#library-storage-limit')!
    input.value = '4097 B'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(root.querySelector('#library-storage-limit-error')?.textContent).toBe('Operator permission denied'))
    expect(input.value).toBe('0 GB')
    unmount()
  })

  it('updates mounted settings fields, search, and command labels when the locale changes', () => {
    registerCatalog('de-DE', {
      'command.workflow.open': '[Arbeitsablaufbibliothek offnen]',
      'settings.canvas.scrollBehavior.description': '[Mausradverhalten auswahlen]',
      'settings.canvas.scrollBehavior.name': '[Leinwandlauf Wellenflug]',
      'settings.canvas.scrollBehavior.option.pan': '[Verschieben]',
      'settings.canvas.scrollBehavior.option.zoom': '[Vergrossern]',
    })
    const settings = isolatedSettings()
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({
      id: 'canvas.scrollBehavior',
      get name() { return t('settings.canvas.scrollBehavior.name') },
      category: 'canvas',
      get description() { return t('settings.canvas.scrollBehavior.description') },
      type: 'combo',
      defaultValue: 'pan',
      get options() {
        return [
          { value: 'pan', label: t('settings.canvas.scrollBehavior.option.pan') },
          { value: 'zoom', label: t('settings.canvas.scrollBehavior.option.zoom') },
        ]
      },
    })
    commands.register({ id: 'workflow.open', get label() { return t('command.workflow.open') }, run: () => {} })
    settings.set('canvas.scrollBehavior', 'zoom')
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)

    root.querySelector<HTMLAnchorElement>('a[href="#canvas"]')!.click()
    expect(root.textContent).toContain('Canvas scroll behavior')
    expect(root.textContent).toContain('Zoom')
    setLocale('de-DE')

    const row = root.querySelector<HTMLElement>('[data-setting-id="canvas.scrollBehavior"]')!
    expect(row.textContent).toContain('[Leinwandlauf Wellenflug]')
    expect(row.textContent).toContain('[Mausradverhalten auswahlen]')
    expect(row.textContent).toContain('[Vergrossern]')
    expect(row.querySelector('button')?.textContent).toBe('Reset')
    row.querySelector<HTMLButtonElement>('[role="combobox"]')!.click()
    expect([...document.querySelectorAll('[role="listbox"] [role="option"]')].map((option) => option.textContent)).toEqual(['[Verschieben]', '[Vergrossern]'])
    row.querySelector<HTMLButtonElement>('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    searchFor(root, 'Wellenflug')
    expect(root.querySelector('[data-setting-id="canvas.scrollBehavior"]')).not.toBeNull()
    searchFor(root, 'Arbeitsablaufbibliothek')
    const command = root.querySelector<HTMLElement>('[data-command-id="workflow.open"]')!
    expect(command.closest('.dinkster-search-row')?.textContent).toContain('[Arbeitsablaufbibliothek offnen]')
    expect(command.querySelector('button')?.getAttribute('aria-label')).toContain('Shortcut for [Arbeitsablaufbibliothek offnen]')
    unmount()
  })

  it('opens General and exposes derived canvas settings under Canvas', () => {
    const settings = isolatedSettings()
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({ id: 'canvas.grid.visible', name: 'Show grid', type: 'boolean', defaultValue: true })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)

    expect(root.querySelector('a[aria-current="page"]')?.textContent).toBe('General')
    root.querySelector<HTMLAnchorElement>('a[href="#canvas"]')!.click()
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Show grid')
    unmount()
  })

  it('clears search when choosing a group and keeps browsing there', () => {
    const { root, unmount } = mountDialog()
    expect(root.querySelectorAll('[data-setting-id]')).toHaveLength(2)
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Show grid')
    const shellNav = root.querySelector<HTMLAnchorElement>('a[href="#general"]')!
    shellNav.click()
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Grid guide')
    searchFor(root, 'open')
    searchFor(root, '')
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Grid guide')
    unmount()
  })

  it('finds settings and shortcuts across groups without marking a group', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'open')
    expect(root.querySelector('.dinkster-search-row')?.textContent).toContain('Open workflow library')

    searchFor(root, 'grid')
    expect(root.querySelectorAll('[data-setting-id]')).toHaveLength(2)
    expect(root.querySelector('.dinkster-search-list')?.textContent).toContain('General - Workspace')
    expect(root.querySelector('.dinkster-search-list')?.textContent).toContain('Canvas - View')
    expect(root.querySelector('a[aria-current]')).toBeNull()

    searchFor(root, 'show')
    const descriptionMatch = root.querySelector('[data-setting-id="shell.gridGuide"]')!.closest('.dinkster-search-row')!
    expect(descriptionMatch.querySelector('.dinkster-search-row-note')?.textContent).toContain('Show layout guides')
    expect(descriptionMatch.querySelector('.dinkster-search-row-note mark')?.textContent).toBe('Show')
    expect([...root.querySelectorAll('.dinkster-search-row')].every((row) => row.querySelector('mark') !== null)).toBe(true)

    searchFor(root, 'canvas.quality')
    expect(root.querySelector('.dinkster-search-row-detail mark')?.textContent).toBe('canvas.quality')
    searchFor(root, 'workspace')
    expect(root.querySelectorAll('.dinkster-search-row')).toHaveLength(1)
    expect(root.querySelector('.dinkster-search-row')?.textContent).toContain('Grid guide')
    expect(root.querySelector('.dinkster-search-row-detail mark')?.textContent).toBe('Workspace')
    setLocale('zh')
    searchFor(root, '\u5de5\u4f5c\u533a')
    expect(root.querySelectorAll('.dinkster-search-row')).toHaveLength(1)
    expect(root.querySelector('.dinkster-search-row')?.textContent).toContain('Grid guide')
    expect(root.querySelector('.dinkster-search-row-detail mark')?.textContent).toBe('\u5de5\u4f5c\u533a')
    searchFor(root, 'keybinding')
    expect(root.querySelectorAll('.dinkster-search-row')).toHaveLength(0)
    unmount()
  })

  it('presents an authoritative empty result and lets Escape clear search without leaving the editor', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'no such setting')
    const search = root.querySelector<HTMLInputElement>('.dinkster-search-input')!
    expect(root.textContent).toContain('No matching settings')
    expect(root.querySelectorAll('.dinkster-search-row')).toHaveLength(0)
    expect(root.querySelectorAll('a[aria-current]')).toHaveLength(0)

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    search.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
    expect(root.textContent).not.toContain('No matching settings')
    unmount()
  })

  it('preserves focused controls when a searched setting changes', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'grid')
    const checkbox = root.querySelector<HTMLButtonElement>('[data-setting-id="canvas.grid.visible"] [role="switch"]')!
    checkbox.focus()
    checkbox.click()
    expect(document.activeElement).toBe(checkbox)
    unmount()
  })

  it('writes combo settings immediately and preserves trigger focus through the rerender', () => {
    const { root, settings, unmount } = mountDialog()
    const trigger = root.querySelector<HTMLButtonElement>('[data-setting-id="canvas.quality"] [role="combobox"]')!
    expect(trigger.getAttribute('aria-labelledby')).toBe('setting-canvas.quality-label')
    expect(trigger.getAttribute('aria-describedby')).toBe('setting-canvas.quality-description')
    trigger.focus()
    trigger.click()
    ;[...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find((option) => option.textContent === 'Quality')!.click()
    expect(settings.get('canvas.quality')).toBe('quality')
    expect(document.activeElement).toBe(trigger)
    expect(root.querySelector('[data-setting-id="canvas.quality"] [role="combobox"]')).toBe(trigger)
    unmount()
  })

  it('writes a labelled product number setting immediately on commit', () => {
    const settings = isolatedSettings()
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({ id: 'proof.count', name: 'Proof count', category: 'proof', description: 'Number of proofs to retain', type: 'number', defaultValue: 2, min: 1, max: 9, step: 2 })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)

    root.querySelector<HTMLAnchorElement>('a[href="#packs"]')!.click()
    const control = root.querySelector<HTMLInputElement>('[role="spinbutton"]')!
    expect(control.getAttribute('aria-labelledby')).toBe('setting-proof.count-label')
    expect(control.getAttribute('aria-describedby')).toBe('setting-proof.count-description')
    expect(control.getAttribute('aria-valuemin')).toBe('1')
    control.value = '6'
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(settings.get('proof.count')).toBe(2)
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(settings.get('proof.count')).toBe(6)
    unmount()
  })

  it('keeps an in-progress number draft over a remote base change', () => {
    const data = new Map<string, string>()
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }
    const settings = new SettingsRegistry(store)
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({ id: 'proof.count', name: 'Proof count', category: 'proof', type: 'number', defaultValue: 2 })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)
    root.querySelector<HTMLAnchorElement>('a[href="#packs"]')!.click()
    const control = root.querySelector<HTMLInputElement>('[role="spinbutton"]')!

    control.value = '7'
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ v: 1, values: { 'proof.count': 4 } }))
    settings.refreshFromStorage(SETTINGS_STORAGE_KEY)

    expect(settings.get('proof.count')).toBe(4)
    expect(control.value).toBe('7')
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(control.value).toBe('4')
    unmount()
  })

  it('keeps an in-progress string draft over a remote base change', () => {
    const data = new Map<string, string>()
    const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }
    const settings = new SettingsRegistry(store)
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({ id: 'proof.label', name: 'Proof label', category: 'proof', type: 'string', defaultValue: 'initial' })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)
    root.querySelector<HTMLAnchorElement>('a[href="#packs"]')!.click()
    const control = root.querySelector<HTMLInputElement>('[data-setting-id="proof.label"] input')!

    control.value = 'local draft'
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ v: 1, values: { 'proof.label': 'remote base' } }))
    settings.refreshFromStorage(SETTINGS_STORAGE_KEY)

    expect(settings.get('proof.label')).toBe('remote base')
    expect(control.value).toBe('local draft')
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(control.value).toBe('remote base')

    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    control.dispatchEvent(new FocusEvent('blur'))
    store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ v: 1, values: { 'proof.label': 'new remote base' } }))
    settings.refreshFromStorage(SETTINGS_STORAGE_KEY)
    expect(control.value).toBe('new remote base')
    unmount()
  })

  it('does not write nonnumeric text from a number setting', () => {
    const settings = isolatedSettings()
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({ id: 'proof.count', name: 'Proof count', category: 'proof', type: 'number', defaultValue: 2 })
    const write = vi.spyOn(settings, 'set')
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)
    root.querySelector<HTMLAnchorElement>('a[href="#packs"]')!.click()
    const control = root.querySelector<HTMLInputElement>('[role="spinbutton"]')!

    control.value = 'invalid'
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    control.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    expect(write).not.toHaveBeenCalled()
    expect(settings.get('proof.count')).toBe(2)
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(control.getAttribute('aria-describedby')).toBe('setting-proof.count-error')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Enter a finite number.')
    setLocale('zh')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('\u8bf7\u8f93\u5165\u6709\u9650\u6570\u5b57\u3002')

    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(control.value).toBe('2')
    expect(control.getAttribute('aria-invalid')).toBeNull()
    expect(control.getAttribute('aria-describedby')).toBeNull()
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(write).not.toHaveBeenCalled()

    control.value = '3'
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(settings.get('proof.count')).toBe(3)
    expect(control.getAttribute('aria-invalid')).toBeNull()
    expect(root.querySelector('[role="alert"]')).toBeNull()
    unmount()
  })

  it('shows reset only for an override and commits the default through the settings registry', () => {
    const { root, settings, unmount } = mountDialog()
    const row = root.querySelector<HTMLElement>('[data-setting-id="canvas.grid.visible"]')!
    expect(row.querySelector('.dinkster-text-button')).toBeNull()

    const checkbox = row.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(checkbox.getAttribute('aria-label')).toBe('Show grid')
    checkbox.click()
    const reset = row.querySelector<HTMLButtonElement>('.dinkster-text-button')!
    expect(reset.textContent).toBe('Reset')
    reset.click()

    expect(settings.get('canvas.grid.visible')).toBe(true)
    expect(row.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    expect(row.querySelector('.dinkster-text-button')).toBeNull()
    unmount()
  })

  it('captures a complete chord, reports its conflict, and resets to the command default', () => {
    const { root, keybindings, unmount } = mountDialog()
    const keybindingsNav = root.querySelector<HTMLAnchorElement>('a[href="#shortcuts"]')!
    keybindingsNav.click()
    const saveRow = root.querySelector<HTMLElement>('[data-command-id="workflow.save"]')!
    const capture = saveRow.querySelector<HTMLButtonElement>('[id="keybinding-workflow.save"]')!
    capture.click()

    capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }))
    expect([...capture.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl'])
    expect(keybindings.combo('workflow.save')).toBe('ctrl+s')
    capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }))

    expect(keybindings.combo('workflow.save')).toBe('ctrl+o')
    expect([...capture.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl+O'])
    expect(capture.getAttribute('aria-invalid')).toBeNull()
    expect(capture.getAttribute('aria-describedby')).toBe('keybinding-workflow.save-warning')
    expect(saveRow.querySelector('[role="status"]')?.textContent).toContain('Open workflow library')
    const reset = [...saveRow.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reset')!
    reset.click()
    expect(keybindings.combo('workflow.save')).toBe('ctrl+s')
    expect(saveRow.querySelector('[role="status"]')).toBeNull()
    unmount()
  })

  it('focuses a requested setting within its category and consumes the one-shot request', async () => {
    let consumed = 0
    const { root, unmount } = mountRequestedDialog(() => { consumed++ })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Grid guide')
    expect(document.activeElement).toBe(root.querySelector('[data-setting-id="shell.gridGuide"] [role="switch"]'))
    expect(consumed).toBe(1)
    unmount()
  })

  it('resets project layout without resetting bar visibility or another project', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }
    const settings = new SettingsRegistry(storage, 'project.one')
    const other = new SettingsRegistry(storage, 'project.two')
    for (const registry of [settings, other]) {
      registry.register({ id: 'shell.layout.left.width', name: 'Left panel size', type: 'number', defaultValue: 380, projectScoped: true })
      registry.register({ id: 'shell.layout.activityBar.visible', name: 'Activity bar visible', type: 'boolean', defaultValue: true, projectScoped: true })
      registry.register({ id: 'shell.dock.layout', name: 'Dock layout', type: 'string', defaultValue: '', projectScoped: true })
    }
    settings.set('shell.layout.left.width', 512)
    settings.set('shell.layout.activityBar.visible', false)
    settings.set('shell.dock.layout', 'stored layout')
    other.set('shell.layout.left.width', 417)
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={new CommandRegistry()} keybindings={new KeybindingRegistry(settings)} />, root)
    expect(root.querySelector('[data-setting-id="shell.dock.layout"]')).toBeNull()
    const search = root.querySelector<HTMLInputElement>('[role="combobox"]')!
    search.value = 'shell.dock.layout'
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(root.querySelector('[data-setting-id="shell.dock.layout"]')).toBeNull()
    expect(root.querySelector('.dinkster-search-empty-title')?.textContent).toBe('No matching settings')
    search.value = ''
    search.dispatchEvent(new InputEvent('input', { bubbles: true }))
    ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reset layout')!.click()
    expect(settings.get('shell.layout.left.width')).toBe(380)
    expect(settings.get('shell.dock.layout')).toBe('')
    expect(settings.get('shell.layout.activityBar.visible')).toBe(false)
    expect(other.get('shell.layout.left.width')).toBe(417)
    expect(JSON.parse(data.get('project.one')!).values).toEqual({ 'shell.layout.activityBar.visible': false })
    unmount()
  })

  it('discovers pack categories and saves complete declared settings objects', async () => {
    const packSettings: PackSettings = {
      packId: 'render.pack', displayName: 'Render Pack',
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', title: 'Enable enhancement', description: 'Use the pack enhancement.', default: true },
          quality: { type: 'integer', title: 'Quality level', default: 2, minimum: 1, maximum: 5 },
        },
        required: ['enabled', 'quality'],
      },
      values: { enabled: true, quality: 2 },
    }
    const fetchPackSettings = vi.fn(async () => packSettings)
    const updatePackSettings = vi.fn(async (_packId: string, values: Readonly<Record<string, string | number | boolean>>) => ({ ...packSettings, values }))
    const settings = isolatedSettings()
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={new CommandRegistry()} keybindings={new KeybindingRegistry(settings)} packSettings={{ client: { fetchPackSettings, updatePackSettings }, packs: () => [{ id: 'render.pack', displayName: 'Render Pack' }] }} />, root)

    root.querySelector<HTMLAnchorElement>('a[href="#packs"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-pack-id="render.pack"]')).not.toBeNull())
    const enabled = root.querySelector<HTMLButtonElement>('[data-pack-setting-id="enabled"] [role="switch"]')!
    expect(enabled.getAttribute('aria-describedby')).toBe('pack-setting-render.pack-enabled-description')
    enabled.click()
    await vi.waitFor(() => expect(updatePackSettings).toHaveBeenCalledWith('render.pack', { enabled: false, quality: 2 }))
    const quality = root.querySelector<HTMLInputElement>('[data-pack-setting-id="quality"] [role="spinbutton"]')!
    quality.value = '4'
    quality.dispatchEvent(new InputEvent('input', { bubbles: true }))
    quality.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(updatePackSettings).toHaveBeenLastCalledWith('render.pack', { enabled: false, quality: 4 }))
    expect(fetchPackSettings).toHaveBeenCalledWith('render.pack')
    unmount()
  })

  it('shows a pack settings load failure without rendering controls', async () => {
    const settings = isolatedSettings()
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={new CommandRegistry()} keybindings={new KeybindingRegistry(settings)} packSettings={{
      client: {
        fetchPackSettings: async () => { throw new Error('pack is unavailable') },
        updatePackSettings: async () => { throw new Error('unexpected update') },
      },
      packs: () => [{ id: 'broken', displayName: 'Broken Pack' }],
    }} />, root)
    root.querySelector<HTMLAnchorElement>('a[href="#packs"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('.pack-settings-status')?.textContent).toBe('pack is unavailable'))
    expect(root.querySelector('[data-pack-setting-id]')).toBeNull()
    unmount()
  })
})
