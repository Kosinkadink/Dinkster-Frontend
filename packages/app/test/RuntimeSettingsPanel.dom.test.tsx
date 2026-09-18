// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeSettingsError, type RuntimeSettingSection, type RuntimeSettings } from '@dinkster/client'
import { registerCatalog, setLocale } from '@dinkster/core'
import { RuntimeSettingsPanel } from '../src/RuntimeSettingsPanel.js'

const section = (value: unknown, overrides: Partial<RuntimeSettingSection> = {}): RuntimeSettingSection => ({
  value,
  source: 'default',
  mutability: 'live',
  writable: true,
  persistence: { available: true, persisted: true },
  ...overrides,
})

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function mount(response: RuntimeSettings, update = vi.fn()) {
  const connection = { fetchRuntimeSettings: vi.fn(async () => response), updateRuntimeSetting: update }
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <RuntimeSettingsPanel connection={connection} />, root)
  return { root, connection, unmount }
}

afterEach(() => {
  document.body.replaceChildren()
  setLocale('en')
})

describe('RuntimeSettingsPanel', () => {
  it('updates mounted runtime settings from the active locale catalog', async () => {
    registerCatalog('de-DE', {
      'runtimeSettings.category.jobs': '[Auftragsparallelitat]',
      'runtimeSettings.editor.legend': '[Bearbeite {category}]',
      'runtimeSettings.jobs.maximumRunning': '[Maximal laufende Auftrage]',
      'runtimeSettings.panel.description': '[Wirksame Werte und Berechtigungen]',
      'runtimeSettings.panel.title': '[Laufzeiteinstellungen]',
    })
    const { root } = mount({
      categories: { granted: ['jobs'], available: ['jobs'] },
      settings: { jobs: section({ maxRunningJobs: 2 }) },
    })
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click()
    await flush()
    expect(root.textContent).toContain('Runtime settings')
    expect(root.textContent).toContain('Maximum running jobs')

    setLocale('de-DE')

    expect(root.textContent).toContain('[Laufzeiteinstellungen]')
    expect(root.textContent).toContain('[Maximal laufende Auftrage]')
    expect(root.querySelector('legend')?.textContent).toBe('[Bearbeite [Auftragsparallelitat]]')
  })

  it('fetches only when expanded, refreshes manually, and renders dynamic metadata plus unknown categories', async () => {
    const { root, connection } = mount({
      categories: { granted: [], available: ['memory-headroom', 'comfy-args'] },
      settings: {
        'memory-headroom': section('256M', { mutability: 'on-worker-restart' }),
        'comfy-args': section({ preview: 'latent2rgb' }),
      },
    })
    expect(connection.fetchRuntimeSettings).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click()
    await flush()
    expect(connection.fetchRuntimeSettings).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-category="comfy-args"] code')?.textContent).toBe('{"preview":"latent2rgb"}')
    expect(root.textContent).toContain('Changes apply to workers started later.')
    expect(root.querySelector('.runtime-settings-editor')).toBeNull()
    root.querySelector<HTMLButtonElement>('[aria-label="Refresh backend runtime settings"]')!.click()
    await flush()
    expect(connection.fetchRuntimeSettings).toHaveBeenCalledTimes(2)
  })

  it('refuses an older refresh result after a setting update starts', async () => {
    const initial = { categories: { granted: ['jobs'], available: ['jobs'] }, settings: { jobs: section({ maxRunningJobs: 2 }) } }
    let resolveRefresh!: (value: RuntimeSettings) => void
    const connection = {
      fetchRuntimeSettings: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockImplementationOnce(() => new Promise<RuntimeSettings>((resolve) => { resolveRefresh = resolve })),
      updateRuntimeSetting: vi.fn(async () => section({ maxRunningJobs: 4 }, { source: 'runtime' })),
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <RuntimeSettingsPanel connection={connection} />, root)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click()
    await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="Refresh backend runtime settings"]')!.click()
    const input = root.querySelector<HTMLInputElement>('[aria-label="Maximum running jobs"]')!
    input.value = '4'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('form[data-category="jobs"]')!.requestSubmit()
    await flush()
    expect(root.querySelector('[data-category="jobs"] code')?.textContent).toBe('{"maxRunningJobs":4}')

    resolveRefresh(initial)
    await flush()

    expect(root.querySelector('[data-category="jobs"] code')?.textContent).toBe('{"maxRunningJobs":4}')
  })

  it('renders editors only for categories that are both granted and writable', async () => {
    const { root } = mount({
      categories: { granted: ['jobs', 'logging'], available: ['jobs', 'logging', 'aimdo-policy'] },
      settings: {
        jobs: section({ maxRunningJobs: 2 }),
        logging: section({ level: 'info', overrides: { 'dinkster.pack': 'debug' } }, { writable: false }),
        'aimdo-policy': section('auto'),
      },
    })
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click()
    await flush()
    expect(root.querySelectorAll('.runtime-settings-editor')).toHaveLength(1)
    expect(root.querySelector('.runtime-settings-editor')?.getAttribute('data-category')).toBe('jobs')
  })

  it('keeps field associations unique across simultaneous backend panels', async () => {
    const response = { categories: { granted: ['jobs'], available: ['jobs'] }, settings: { jobs: section({ maxRunningJobs: 2 }) } }
    const connection = { fetchRuntimeSettings: vi.fn(async () => response), updateRuntimeSetting: vi.fn() }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <><RuntimeSettingsPanel connection={connection} alwaysOpen /><RuntimeSettingsPanel connection={connection} alwaysOpen /></>, root)
    await flush()

    const fields = [...root.querySelectorAll<HTMLElement>('.product-field')]
    const labels = fields.map((field) => field.querySelector<HTMLLabelElement>('label')!.htmlFor)
    expect(fields).toHaveLength(2)
    expect(new Set(labels).size).toBe(2)
    expect(fields.every((field) => field.querySelector('label')?.htmlFor === field.querySelector('input')?.id)).toBe(true)
  })

  it('mounts the worker-comfy-args editor only when granted and writable', async () => {
    const writable = mount({ categories: { granted: ['worker-comfy-args'], available: ['worker-comfy-args'] }, settings: { 'worker-comfy-args': section(['--preview-size', '321']) } })
    writable.root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    expect(writable.root.querySelector('form[data-category="worker-comfy-args"]')).not.toBeNull()
    writable.unmount(); writable.root.remove()

    const ungranted = mount({ categories: { granted: [], available: ['worker-comfy-args'] }, settings: { 'worker-comfy-args': section(['--preview-size', '321']) } })
    ungranted.root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    expect(ungranted.root.querySelector('[data-category="worker-comfy-args"] code')?.textContent).toBe('["--preview-size","321"]')
    expect(ungranted.root.querySelector('.runtime-settings-editor')).toBeNull()
    ungranted.unmount(); ungranted.root.remove()

    const readonly = mount({ categories: { granted: ['worker-comfy-args'], available: ['worker-comfy-args'] }, settings: { 'worker-comfy-args': section(['--preview-size', '321'], { writable: false }) } })
    readonly.root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    expect(readonly.root.querySelector('[data-category="worker-comfy-args"] code')?.textContent).toBe('["--preview-size","321"]')
    expect(readonly.root.querySelector('.runtime-settings-editor')).toBeNull()
  })

  it('edits component dtypes independently and exposes the FP8 control', async () => {
    const update = vi.fn(async (_category: string, value: unknown) => section(value, { source: 'runtime' }))
    const categories = ['dtype-policy', 'fp8-matmul']
    const { root } = mount({
      categories: { granted: categories, available: categories },
      settings: {
        'dtype-policy': section({ diffusion: 'auto', textEncoder: 'float16', vae: 'float32' }, { mutability: 'on-worker-restart' }),
        'fp8-matmul': section(false, { mutability: 'on-worker-restart' }),
      },
    }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()

    root.querySelector<HTMLButtonElement>('[aria-label="Diffusion model dtype"]')!.click()
    document.querySelector<HTMLElement>('[role="option"][data-option-id="bfloat16"]')!.click()
    root.querySelector<HTMLFormElement>('form[data-category="dtype-policy"]')!.requestSubmit(); await flush()

    const fp8 = root.querySelector<HTMLInputElement>('[aria-label="Native FP8 matrix multiplication"]')!
    fp8.click()
    root.querySelector<HTMLFormElement>('form[data-category="fp8-matmul"]')!.requestSubmit(); await flush()

    expect(update.mock.calls).toEqual([
      ['dtype-policy', { diffusion: 'bfloat16', textEncoder: 'float16', vae: 'float32' }],
      ['fp8-matmul', true],
    ])
  })

  it('submits the typed jobs body, replaces the returned section, and reports in-memory persistence', async () => {
    const updated = section({ maxRunningJobs: 4 }, { source: 'runtime', persistence: { available: false, persisted: false } })
    const update = vi.fn(async () => updated)
    const { root } = mount({ categories: { granted: ['jobs'], available: ['jobs'] }, settings: { jobs: section({ maxRunningJobs: 2 }) } }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    const input = root.querySelector<HTMLInputElement>('[aria-label="Maximum running jobs"]')!
    input.value = '4'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('form')!.requestSubmit(); await flush()
    expect(update).toHaveBeenCalledWith('jobs', { maxRunningJobs: 4 })
    expect(root.querySelector('[data-category="jobs"] code')?.textContent).toBe('{"maxRunningJobs":4}')
    expect(root.textContent).toContain('This change is in-memory only')
  })

  it('keeps product budget inputs and sliders synchronized without saving before Apply', async () => {
    const update = vi.fn(async (_category: string, value: unknown) => section(value))
    const connection = {
      fetchRuntimeSettings: vi.fn(async () => ({
        categories: { granted: ['memory-budgets'], available: ['memory-budgets'] },
        settings: { 'memory-budgets': section({ 'cuda:0': 512 * 1024 ** 2 }) },
      })),
      updateRuntimeSetting: update,
    }
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <RuntimeSettingsPanel connection={connection} alwaysOpen memoryControls />, root)
    await flush()

    const number = root.querySelector<HTMLInputElement>('[aria-label="cuda:0 memory budget"]')!
    const slider = root.querySelector<HTMLElement>('[aria-label="cuda:0 memory budget slider"]')!
    expect(number.value).toBe('512')
    expect(slider.getAttribute('aria-valuenow')).toBe('512')
    number.value = '768'
    number.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(slider.getAttribute('aria-valuenow')).toBe('768')
    expect(update).not.toHaveBeenCalled()
    number.value = '-'
    number.dispatchEvent(new InputEvent('input', { bubbles: true }))
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(number.value).toBe('832')
    expect(update).not.toHaveBeenCalled()
    root.querySelector<HTMLFormElement>('form[data-category="memory-budgets"]')!.requestSubmit()
    await flush()
    expect(update).toHaveBeenCalledWith('memory-budgets', { 'cuda:0': 832 * 1024 ** 2 })
  })

  it('submits every category shape and keeps map-row focus through multi-character edits', async () => {
    const update = vi.fn(async (_category: string, value: unknown) => section(value, { source: 'runtime' }))
    const categories = ['memory-budgets', 'memory-headroom', 'aimdo-policy', 'logging']
    const { root } = mount({ categories: { granted: categories, available: categories }, settings: {
      'memory-budgets': section({ ram: '8G' }),
      'memory-headroom': section('256M', { mutability: 'live' }),
      'aimdo-policy': section('auto'),
      logging: section({ level: 'info', overrides: { 'dinkster.old': 'debug' } }),
    } }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()

    const budget = root.querySelector<HTMLInputElement>('[aria-label="ram memory budget"]')!
    budget.focus()
    for (const value of ['2', '24', '24G']) { budget.value = value; budget.dispatchEvent(new InputEvent('input', { bubbles: true })); expect(document.activeElement).toBe(budget) }
    root.querySelector<HTMLFormElement>('form[data-category="memory-budgets"]')!.requestSubmit(); await flush()

    const headroom = root.querySelector<HTMLInputElement>('[aria-label="Memory headroom"]')!
    headroom.value = '512M'; headroom.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('form[data-category="memory-headroom"]')!.requestSubmit(); await flush()

    const policy = root.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Aimdo policy"]')!
    const callsBeforePolicy = update.mock.calls.length
    policy.click()
    document.querySelector<HTMLElement>('[role="option"][data-option-id="off"]')!.click()
    expect(update).toHaveBeenCalledTimes(callsBeforePolicy)
    root.querySelector<HTMLFormElement>('form[data-category="aimdo-policy"]')!.requestSubmit(); await flush()

    const logger = root.querySelector<HTMLInputElement>('[aria-label="Logger name"]')!
    logger.focus()
    for (const value of ['d', 'dinkster', 'dinkster.new']) { logger.value = value; logger.dispatchEvent(new InputEvent('input', { bubbles: true })); expect(document.activeElement).toBe(logger) }
    const loggerLevel = root.querySelector<HTMLInputElement>('[aria-label="dinkster.new log level"]')!
    loggerLevel.value = 'warning'; loggerLevel.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('form[data-category="logging"]')!.requestSubmit(); await flush()

    expect(update.mock.calls.map(([category, body]) => [category, body])).toEqual([
      ['memory-budgets', { ram: '24G' }],
      ['memory-headroom', '512M'],
      ['aimdo-policy', 'off'],
      ['logging', { level: 'info', overrides: { 'dinkster.new': 'warning' } }],
    ])
  })

  it('keeps an unknown logging level draft representable in the product listbox', async () => {
    const update = vi.fn(async (_category: string, value: unknown) => section(value))
    const { root } = mount({ categories: { granted: ['logging'], available: ['logging'] }, settings: {
      logging: section({ level: 'trace', overrides: {} }),
    } }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    const trigger = root.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Default log level"]')!
    expect(trigger.textContent).toContain('trace')
    trigger.click()
    expect(document.querySelector('[role="option"][data-option-id="trace"]')?.getAttribute('aria-selected')).toBe('true')
    document.querySelector<HTMLElement>('[role="option"][data-option-id="warning"]')!.click()
    expect(update).not.toHaveBeenCalled()
    root.querySelector<HTMLFormElement>('form[data-category="logging"]')!.requestSubmit(); await flush()
    expect(update).toHaveBeenCalledWith('logging', { level: 'warning', overrides: {} })
  })

  it('edits worker args in row order, drops empty rows, preserves verbatim values and replaces only its section', async () => {
    const updated = section(['--server-value'], { source: 'runtime', mutability: 'on-worker-restart' })
    const update = vi.fn(async () => updated)
    const { root } = mount({
      categories: { granted: ['worker-comfy-args'], available: ['worker-comfy-args', 'jobs'] },
      settings: {
        'worker-comfy-args': section(['--preview-size', '321', '--remove-me'], { mutability: 'on-worker-restart' }),
        jobs: section({ maxRunningJobs: 2 }),
      },
    }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()

    const second = root.querySelector<HTMLInputElement>('[aria-label="Worker argument 2"]')!
    second.focus()
    for (const value of [' ', '  spaced', '  spaced value  ']) {
      second.value = value
      second.dispatchEvent(new InputEvent('input', { bubbles: true }))
      expect(document.activeElement).toBe(second)
    }
    root.querySelector<HTMLButtonElement>('[aria-label="Remove worker argument 3"]')!.click()
    const add = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Add argument')!
    add.click()
    let inputs = root.querySelectorAll<HTMLInputElement>('form[data-category="worker-comfy-args"] input')
    inputs[2]!.value = '   '; inputs[2]!.dispatchEvent(new InputEvent('input', { bubbles: true }))
    add.click()
    inputs = root.querySelectorAll<HTMLInputElement>('form[data-category="worker-comfy-args"] input')
    inputs[3]!.value = '--flag=value'; inputs[3]!.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('form[data-category="worker-comfy-args"]')!.requestSubmit(); await flush()

    expect(update).toHaveBeenCalledWith('worker-comfy-args', ['--preview-size', '  spaced value  ', '--flag=value'])
    expect(root.querySelector('[data-category="worker-comfy-args"] code')?.textContent).toBe('["--server-value"]')
    expect(root.querySelector('[data-category="jobs"] code')?.textContent).toBe('{"maxRunningJobs":2}')
  })

  it('submits an empty worker args array when every row is empty', async () => {
    const update = vi.fn(async (_category: string, value: unknown) => section(value))
    const { root } = mount({ categories: { granted: ['worker-comfy-args'], available: ['worker-comfy-args'] }, settings: { 'worker-comfy-args': section(['', '   ']) } }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    root.querySelector<HTMLFormElement>('form[data-category="worker-comfy-args"]')!.requestSubmit(); await flush()
    expect(update).toHaveBeenCalledWith('worker-comfy-args', [])
  })

  it('keeps granted writable unknown categories read-only', async () => {
    const { root } = mount({ categories: { granted: ['future'], available: ['future'] }, settings: { future: section({ enabled: true }) } })
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    expect(root.querySelector('[data-category="future"] code')?.textContent).toBe('{"enabled":true}')
    expect(root.querySelector('.runtime-settings-editor')).toBeNull()
  })

  it('keeps structured validation and permission failures inline until the next edit', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new RuntimeSettingsError(400, { error: 'invalid-settings', category: 'jobs', message: 'must be at least 1' }))
      .mockRejectedValueOnce(new RuntimeSettingsError(403, { error: 'settings-changes-disabled', category: 'jobs', granted: ['logging'] }))
    const { root } = mount({ categories: { granted: ['jobs'], available: ['jobs'] }, settings: { jobs: section({ maxRunningJobs: 2 }) } }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    const form = root.querySelector<HTMLFormElement>('form')!
    const input = root.querySelector<HTMLInputElement>('[aria-label="Maximum running jobs"]')!
    input.value = '3'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    form.requestSubmit(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('must be at least 1')
    input.value = '4'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(root.querySelector('[role="alert"]')).toBeNull()
    form.requestSubmit(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Changes to jobs are not granted (granted: logging)')
  })

  it('renders worker deny-list details only when complete and clears them on edit or success', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new RuntimeSettingsError(400, { error: 'invalid-settings', category: 'worker-comfy-args', message: 'flag only', offendingFlag: '--port' }))
      .mockRejectedValueOnce(new RuntimeSettingsError(400, { error: 'invalid-settings', category: 'worker-comfy-args', message: 'owner only', owner: 'Dinkster server' }))
      .mockRejectedValueOnce(new RuntimeSettingsError(400, { error: 'invalid-settings', category: 'worker-comfy-args', message: 'Dinkster owns --port', offendingFlag: '--port', owner: 'Dinkster server' }))
      .mockResolvedValueOnce(section(['--preview-size'], { source: 'runtime' }))
    const { root } = mount({ categories: { granted: ['worker-comfy-args'], available: ['worker-comfy-args'] }, settings: { 'worker-comfy-args': section(['--port']) } }, update)
    root.querySelector<HTMLButtonElement>('.runtime-settings-toggle')!.click(); await flush()
    const form = root.querySelector<HTMLFormElement>('form')!
    const input = root.querySelector<HTMLInputElement>('[aria-label="Worker argument 1"]')!

    input.value = '--preview-size'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    form.requestSubmit(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('flag only')
    input.value = '--owner-check'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(root.querySelector('[role="alert"]')).toBeNull()

    form.requestSubmit(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('owner only')
    input.value = '--deny-check'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(root.querySelector('[role="alert"]')).toBeNull()

    form.requestSubmit(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Dinkster owns --portRejected flag: --port (owned by Dinkster server).')
    input.value = '--server-value'; input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    form.requestSubmit(); await flush()
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(root.querySelector('[data-category="worker-comfy-args"] code')?.textContent).toBe('["--preview-size"]')
  })
})
