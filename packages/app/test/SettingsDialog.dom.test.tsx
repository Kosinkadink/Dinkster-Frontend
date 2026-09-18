// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { registerCatalog, setLocale, t } from '@dinkster/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../src/locale.js'
import { SettingsDialog } from '../src/SettingsDialog.js'
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
  const search = root.querySelector<HTMLInputElement>('.settings-search')!
  search.value = query
  search.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
})

describe('SettingsDialog search', () => {
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

    expect(root.textContent).toContain('Canvas scroll behavior')
    expect(root.textContent).toContain('Zoom')
    setLocale('de-DE')

    const row = root.querySelector<HTMLElement>('[data-setting-id="canvas.scrollBehavior"]')!
    expect(row.textContent).toContain('[Leinwandlauf Wellenflug]')
    expect(row.textContent).toContain('[Mausradverhalten auswahlen]')
    expect(row.textContent).toContain('[Vergrossern]')
    expect(row.querySelector('button[aria-label="Reset [Leinwandlauf Wellenflug] to default"]')).not.toBeNull()
    row.querySelector<HTMLButtonElement>('[role="combobox"]')!.click()
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(['[Verschieben]', '[Vergrossern]'])

    searchFor(root, 'Wellenflug')
    expect(root.querySelector('[data-setting-id="canvas.scrollBehavior"]')).not.toBeNull()
    searchFor(root, 'Arbeitsablaufbibliothek')
    const command = root.querySelector<HTMLElement>('[data-command-id="workflow.open"]')!
    expect(command.textContent).toContain('[Arbeitsablaufbibliothek offnen]')
    expect(command.querySelector('button[aria-label="Clear [Arbeitsablaufbibliothek offnen] shortcut"]')).not.toBeNull()
    expect(command.querySelector('.binding-capture')?.getAttribute('aria-label')).toContain('Shortcut for [Arbeitsablaufbibliothek offnen]')
    unmount()
  })

  it('updates mounted editor chrome without losing search, category, or setting state', () => {
    const { root, settings, unmount } = mountDialog()
    root.querySelector<HTMLButtonElement>('[data-setting-id="canvas.grid.visible"] [role="checkbox"]')!.click()
    root.querySelector<HTMLButtonElement>('.settings-categories button[aria-label="Shell"]')!.click()
    searchFor(root, 'grid')
    root.querySelector<HTMLButtonElement>('[data-category="shell"] .settings-result-heading')!.click()

    setLocale('zh')

    const search = root.querySelector<HTMLInputElement>('.settings-search')!
    expect(search.value).toBe('grid')
    expect(search.placeholder).toBe('\u641c\u7d22\u8bbe\u7f6e')
    expect(root.querySelector('.settings-categories button.active')?.textContent).toContain('\u754c\u9762\u5e03\u5c40')
    expect(root.querySelector('[role="status"]')?.textContent).toBe('\u754c\u9762\u5e03\u5c40\u4e2d"grid"\u67091\u4e2a\u7ed3\u679c')
    expect(root.querySelector('.settings-search-clear')?.textContent).toBe('\u6e05\u9664')
    expect(settings.get('canvas.grid.visible')).toBe(false)
    unmount()
  })

  it('updates mounted keybinding capture chrome without replacing the focused control', () => {
    const { root, keybindings, unmount } = mountDialog()
    root.querySelector<HTMLButtonElement>('.settings-categories button[aria-label="Keybindings"]')!.click()
    const capture = root.querySelector<HTMLButtonElement>('[data-command-id="workflow.save"] .binding-capture')!
    capture.focus()
    capture.click()
    expect(capture.textContent).toBe('Press keys...')

    setLocale('zh')

    expect(root.querySelector('.settings-categories button.active')?.textContent).toBe('\u5feb\u6377\u952e')
    expect(root.querySelector('[data-command-id="workflow.save"] .binding-capture')).toBe(capture)
    expect(document.activeElement).toBe(capture)
    expect(capture.textContent).toBe('\u8bf7\u6309\u5feb\u6377\u952e...')
    expect(keybindings.combo('workflow.save')).toBe('ctrl+s')
    capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }))
    expect(capture.textContent).toBe('ctrl')
    unmount()
  })

  it('opens on the first populated derived category instead of an empty canvas parent', () => {
    const settings = isolatedSettings()
    const commands = new CommandRegistry()
    const keybindings = new KeybindingRegistry(settings)
    settings.register({ id: 'canvas.grid.visible', name: 'Show grid', type: 'boolean', defaultValue: true })
    const root = document.createElement('div')
    document.body.append(root)
    const unmount = render(() => <SettingsDialog settings={settings} commands={commands} keybindings={keybindings} />, root)

    expect(root.querySelector('.settings-categories button.active')?.textContent).toBe('Canvas Grid')
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Show grid')
    unmount()
  })

  it('keeps empty-query browsing scoped to the active category', () => {
    const { root, unmount } = mountDialog()
    expect(root.querySelectorAll('[data-setting-id]')).toHaveLength(2)
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Show grid')
    expect(root.querySelector('.settings-result-group')).toBeNull()

    const shellNav = root.querySelector<HTMLButtonElement>('.settings-categories button[aria-label="Shell"]')!
    shellNav.click()
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Grid guide')
    searchFor(root, 'open')
    searchFor(root, '')
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Grid guide')
    unmount()
  })

  it('renders ranked groups across settings categories and keybindings', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'open')
    expect(root.querySelector('[data-category="keybindings"] [data-command-id]')?.textContent).toContain('Open workflow library')

    searchFor(root, 'grid')
    expect([...root.querySelectorAll('.settings-result-group')].map((group) => group.getAttribute('data-category'))).toEqual(['shell', 'canvas'])
    expect(root.querySelectorAll('[data-setting-id]')).toHaveLength(2)
    expect(root.querySelector('.settings-categories button.active')?.textContent).toContain('All results')
    unmount()
  })

  it('narrows search results from category headers and counted navigation', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'grid')
    const shellHeading = root.querySelector<HTMLButtonElement>('[data-category="shell"] .settings-result-heading')!
    shellHeading.focus()
    shellHeading.click()
    expect([...root.querySelectorAll('.settings-result-group')].map((group) => group.getAttribute('data-category'))).toEqual(['shell'])
    expect(document.activeElement).toBe(shellHeading)

    const canvasNav = root.querySelector<HTMLButtonElement>('.settings-categories button[aria-label="Canvas, 1 results"]')!
    expect(canvasNav.textContent).toContain('1')
    canvasNav.click()
    expect([...root.querySelectorAll('.settings-result-group')].map((group) => group.getAttribute('data-category'))).toEqual(['canvas'])
    unmount()
  })

  it('presents an authoritative empty result and lets Escape clear search without leaving the editor', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'no such setting')
    const search = root.querySelector<HTMLInputElement>('.settings-search')!

    expect(root.querySelector('[role="status"]')?.textContent).toBe('0 results for "no such setting"')
    expect(root.querySelector('.settings-empty-results')?.textContent).toContain('No matching settings')
    expect(root.querySelectorAll('.settings-result-group')).toHaveLength(0)
    expect([...root.querySelectorAll<HTMLButtonElement>('.settings-categories button')].slice(1).every((button) => button.disabled)).toBe(true)

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    search.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
    expect(root.querySelector('.settings-empty-results')).toBeNull()
    unmount()
  })

  it('clears a nonempty search with Escape after focus moves into its results', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'grid')
    const heading = root.querySelector<HTMLButtonElement>('.settings-result-heading')!
    const search = root.querySelector<HTMLInputElement>('.settings-search')!
    heading.focus()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    heading.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
    expect(root.querySelector('.settings-results')).toBeNull()
    unmount()
  })

  it('shows an empty result when a narrowed category unregisters its last match', () => {
    const { root, unregisterShell, unmount } = mountDialog()
    searchFor(root, 'grid')
    root.querySelector<HTMLButtonElement>('[data-category="shell"] .settings-result-heading')!.click()
    unregisterShell()

    expect(root.querySelector('[role="status"]')?.textContent).toBe('0 results for "grid" in Shell')
    expect(root.querySelector('.settings-empty-results')?.textContent).toContain('No matching settings')
    expect(root.querySelectorAll('.settings-result-group')).toHaveLength(0)
    unmount()
  })

  it('lets an expanded control consume Escape before the search fallback', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'quality')
    const search = root.querySelector<HTMLInputElement>('.settings-search')!
    const select = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
    select.click()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    select.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(select.getAttribute('aria-expanded')).toBe('false')
    expect(search.value).toBe('quality')
    expect(document.activeElement).toBe(select)
    unmount()
  })

  it('associates setting help with its labelled product control', () => {
    const { root, unmount } = mountDialog()
    root.querySelector<HTMLButtonElement>('.settings-categories button[aria-label="Shell"]')!.click()
    const row = root.querySelector<HTMLElement>('[data-setting-id="shell.gridGuide"]')!
    const checkbox = row.querySelector<HTMLElement>('[role="checkbox"]')!

    expect(checkbox.getAttribute('aria-labelledby')).toBe('setting-shell.gridGuide-label')
    expect(checkbox.getAttribute('aria-describedby')).toBe('setting-shell.gridGuide-description')
    expect(row.querySelector('#setting-shell\\.gridGuide-description')?.textContent).toBe('Show layout guides')
    unmount()
  })

  it('preserves focused controls when a searched setting changes', () => {
    const { root, unmount } = mountDialog()
    searchFor(root, 'grid')
    const checkbox = root.querySelector<HTMLButtonElement>('[data-category="canvas"] [role="checkbox"]')!
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
    document.querySelector<HTMLElement>('[role="option"][data-option-id="quality"]')!.click()
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
    const control = root.querySelector<HTMLInputElement>('[role="spinbutton"]')!

    control.value = 'invalid'
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    control.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    expect(write).not.toHaveBeenCalled()
    expect(settings.get('proof.count')).toBe(2)
    expect(control.getAttribute('aria-invalid')).toBe('true')
    expect(control.getAttribute('aria-describedby')).toBe('setting-proof.count-message')
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
    expect(row.querySelector('[aria-label="Reset Show grid to default"]')).toBeNull()

    const checkbox = row.querySelector<HTMLButtonElement>('[role="checkbox"]')!
    expect(checkbox.getAttribute('aria-labelledby')).toBe('setting-canvas.grid.visible-label')
    checkbox.click()
    const reset = row.querySelector<HTMLButtonElement>('[aria-label="Reset Show grid to default"]')!
    expect(reset.getAttribute('aria-label')).toBe('Reset Show grid to default')
    reset.click()

    expect(settings.get('canvas.grid.visible')).toBe(true)
    expect(row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    expect(row.querySelector('[aria-label="Reset Show grid to default"]')).toBeNull()
    unmount()
  })

  it('captures a complete chord, reports its conflict, and resets to the command default', () => {
    const { root, keybindings, unmount } = mountDialog()
    const keybindingsNav = root.querySelector<HTMLButtonElement>('.settings-categories button[aria-label="Keybindings"]')!
    keybindingsNav.click()
    const saveRow = root.querySelector<HTMLElement>('[data-command-id="workflow.save"]')!
    const capture = saveRow.querySelector<HTMLButtonElement>('.binding-capture')!
    capture.click()

    capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }))
    expect(capture.textContent).toBe('ctrl')
    expect(keybindings.combo('workflow.save')).toBe('ctrl+s')
    capture.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }))

    expect(keybindings.combo('workflow.save')).toBe('ctrl+o')
    expect(saveRow.classList.contains('product-field-invalid')).toBe(true)
    expect(capture.getAttribute('aria-invalid')).toBe('true')
    expect(capture.getAttribute('aria-describedby')).toBe('keybinding-workflow.save-message')
    expect(saveRow.querySelector('.product-field-message')?.textContent).toContain('workflow.open')
    const reset = [...saveRow.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reset')!
    reset.click()
    expect(keybindings.combo('workflow.save')).toBe('ctrl+s')
    expect(saveRow.classList.contains('product-field-invalid')).toBe(false)
    unmount()
  })

  it('focuses a requested setting within its category and consumes the one-shot request', async () => {
    let consumed = 0
    const { root, unmount } = mountRequestedDialog(() => { consumed++ })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(root.querySelector('[data-setting-id]')?.textContent).toContain('Grid guide')
    expect(document.activeElement).toBe(root.querySelector('[data-setting-id="shell.gridGuide"] [role="checkbox"]'))
    expect(consumed).toBe(1)
    unmount()
  })
})
