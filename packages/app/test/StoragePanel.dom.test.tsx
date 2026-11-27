import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { DinksterConnection, ModelSettingsState, MountDescriptor, MountSettings } from '@dinkster/client'
import { canvasTypePaintForTheme } from '@dinkster/canvas'
import { semanticTokensForTheme } from '@dinkster/core'
import { RequestFailure } from '@dinkster/client'
import { StorageFolders, StoragePanel } from '../src/StoragePanel.js'
import { AppState } from '../src/app-state.js'

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks() })

it('keeps failed folders visible with their actual reasons and retries only the selected grant', async () => {
  let mounts = [
    { id: 'archive', path: '/offline/archive', mode: 'read' as const, state: 'failed', error: 'asset library root is not a directory: /offline/archive' },
    { id: 'restricted', path: '/restricted', mode: 'read' as const, state: 'failed', error: 'Permission denied: /restricted' },
    { id: 'models-lora', mode: 'read' as const, state: 'failed', source: 'shared-models', error: 'model root unavailable' },
  ]
  const location = { id: 'models', path: '/models', mode: 'read' as const, visibility: 'default-on' as const }
  const connection = {
    fetchMountSettings: async () => ({ mounts, mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts: mounts.map((row) => ({ ...row, path: row.path ?? '/models/loras' })) }),
    fetchModelSettings: async () => ({ settings: { version: 1, locations: [location], downloadLocation: null }, locations: [{ ...location, enabled: true, active: true, mounts: ['models-lora'] }], changesAllowed: true }),
    onMountsChanged: () => () => {},
    retryMount: async (id: string) => { mounts = mounts.map((row) => row.id === id ? { ...row, state: 'ready', error: '' } : row) },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} />, root))
  await vi.waitFor(() => expect(root.textContent).toContain('asset library root is not a directory: /offline/archive'))
  expect(root.querySelector('[data-mount-id="restricted"]')?.textContent).toContain('Permission denied: /restricted')
  expect(root.querySelector('[data-model-location="models"]')?.textContent).toContain('model root unavailable')
  const retry = (row: Element) => [...row.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Try again')!.click()
  retry(root.querySelector('[data-mount-id="archive"]')!)
  await vi.waitFor(() => expect(root.textContent).not.toContain('asset library root is not a directory'))
  expect(root.querySelector('[data-mount-id="archive"]')).not.toBeNull()
  expect(root.textContent).toContain('Permission denied: /restricted')
  expect(root.textContent).toContain('model root unavailable')
  retry(root.querySelector('[data-model-location="models"]')!)
  await vi.waitFor(() => expect(root.textContent).not.toContain('model root unavailable'))
  expect(root.textContent).toContain('Permission denied: /restricted')
})

it.each([true, false])('adds a model folder with download destination enabled: %s', async (download) => {
  const existing = { id: 'models', path: '/existing/models', mode: 'readwrite' as const, visibility: 'default-on' as const }
  let state: ModelSettingsState = {
    settings: { version: 1, locations: [existing], downloadLocation: 'models' },
    locations: [{ ...existing, enabled: true, active: true, mounts: [] }], revision: 'before', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
  }
  let refused = true
  const connection = {
    fetchMountSettings: async () => ({ mounts: [], mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts: [] }),
    fetchModelSettings: async () => state,
    onMountsChanged: () => () => {},
    updateModelSettings: async (settings: ModelSettingsState['settings'], revision: string) => {
      expect(revision).toBe('before')
      if (refused) throw new RequestFailure('PUT', '/api/models/settings', 400, 'Folder is unavailable')
      state = { ...state, settings, revision: 'after', locations: settings.locations.map((row) => ({ ...row, active: false, enabled: true, mounts: [] })) }
      return state
    },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} focus={{ addModelFolder: true }} />, root))
  await vi.waitFor(() => expect(root.querySelector('[role="combobox"]')).not.toBeNull())
  const folderLabel = [...root.querySelectorAll('label')].find((label) => label.textContent === 'Folder')!
  const folder = root.querySelector<HTMLInputElement>(`#${folderLabel.htmlFor}`)!
  folder.value = '/archive/models'; folder.dispatchEvent(new Event('input', { bubbles: true }))
  const usedBy = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
  expect(usedBy.textContent).toContain('Every project')
  usedBy.click()
  const option = [...document.querySelectorAll<HTMLDivElement>('[role="option"]')].find((row) => row.textContent?.includes('Opt in - projects must enable'))!
  option.click()
  const toggle = root.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  if (download) toggle.click()
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Folder is unavailable'))
  expect(folder.value).toBe('/archive/models')
  expect(usedBy.textContent).toContain('Opt in - projects must enable')
  expect(toggle.getAttribute('aria-checked')).toBe(String(download))
  refused = false
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(root.querySelector('[data-model-location="models-2"]')).not.toBeNull())
  expect(state.settings.locations).toEqual([existing, { id: 'models-2', path: '/archive/models', mode: download ? 'readwrite' : 'read', visibility: 'opt-in' }])
  expect(state.settings.downloadLocation).toBe(download ? 'models-2' : 'models')
})

it.each([true, false])('keeps a refused mount form and adds with saving allowed: %s', async (writable) => {
  const mounts: MountDescriptor[] = []
  let refused = true
  const connection = {
    fetchMountSettings: async () => ({ mounts, mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts }),
    fetchModelSettings: async () => ({ locations: [], settings: { locations: [] }, changesAllowed: true }),
    onMountsChanged: () => () => {},
    addMount: async (id: string, path: string, mode: 'read' | 'readwrite') => {
      if (refused) throw new RequestFailure('POST', '/api/mounts', 400, 'Folder cannot be written to')
      const mount: MountDescriptor = { id, path, mode, state: 'ready' }
      mounts.push(mount)
      return mount
    },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} />, root))
  await vi.waitFor(() => expect(root.querySelectorAll('.storage-group-heading')).toHaveLength(2))
  root.querySelectorAll<HTMLButtonElement>('.storage-group-heading button')[1]!.click()
  expect(root.textContent).toContain('Add a mount')
  const field = (label: string) => root.querySelector<HTMLInputElement>(`#${[...root.querySelectorAll('label')].find((row) => row.textContent === label)!.htmlFor}`)!
  const folder = field('Folder'); folder.value = '/archive/plates'; folder.dispatchEvent(new Event('input', { bubbles: true }))
  const name = field('Name'); name.value = 'footage'; name.dispatchEvent(new Event('input', { bubbles: true }))
  const saving = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(saving.checked).toBe(true)
  expect(saving.closest('label')?.textContent).toBe('Allow saving to this folder')
  if (!writable) saving.click()
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('Folder cannot be written to'))
  expect(folder.value).toBe('/archive/plates')
  expect(name.value).toBe('footage')
  expect(saving.checked).toBe(writable)
  refused = false
  root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="footage"]')).not.toBeNull())
  expect(root.querySelector('[data-mount-id="footage"]')?.textContent?.includes('Read only')).toBe(!writable)
  expect(root.querySelector('[data-mount-id="footage"]')?.textContent).toContain('/archive/plates')
})

it('shows live file and byte reading progress for mounts and grouped model folders', async () => {
  let mounts: MountDescriptor[] = [
    { id: 'models-lora', mode: 'read', state: 'scanning', source: 'shared-models', kind: 'model/lora', scanProgress: { filesDone: 3, filesTotal: 12, bytesDone: 1024, bytesTotal: 8192, elapsedSeconds: 1 } },
    { id: 'models-vae', mode: 'read', state: 'scanning', source: 'shared-models', kind: 'model/vae', scanProgress: { filesDone: 2, filesTotal: 8, bytesDone: 1024, bytesTotal: 2048, elapsedSeconds: 1 } },
    { id: 'input', mode: 'readwrite', state: 'scanning', scanProgress: { filesDone: 7, filesTotal: 10, bytesDone: 512, bytesTotal: 16384, elapsedSeconds: 1 } },
  ]
  const location = { id: 'models', path: '/models', mode: 'read' as const, visibility: 'default-on' as const }
  let changed = () => {}
  const connection = {
    fetchMountSettings: async () => ({ mounts, mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts: mounts.map((mount) => ({ ...mount, path: `/${mount.id}` })) }),
    fetchModelSettings: async () => ({ settings: { version: 1, locations: [location], downloadLocation: null },
      locations: [{ ...location, enabled: true, active: true, mounts: ['models-lora', 'models-vae'] }], changesAllowed: true }),
    onMountsChanged: (listener: () => void) => { changed = listener; return () => {} },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} />, root))
  await vi.waitFor(() => expect(root.textContent).toContain('Reading, 5 of 20'))
  const model = root.querySelector('[data-model-location="models"]')!
  expect(model.textContent).toContain('2 of 10 KB read')
  expect(model.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0.2')
  const input = root.querySelector('[data-mount-id="input"]')!
  expect(input.textContent).toContain('Reading, 7 of 10')
  expect(input.textContent).toContain('0.5 of 16 KB read')
  expect(input.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0.03125')
  mounts = mounts.map(({ scanProgress: _, ...mount }) => ({ ...mount, state: 'ready', entryCount: 12 }))
  changed()
  await vi.waitFor(() => expect(root.querySelectorAll('[role="progressbar"]')).toHaveLength(0))
  expect(root.textContent).not.toContain('Reading,')
  expect(root.querySelector('[data-model-location="models"]')?.textContent).toContain('24 models')
  expect(root.querySelector('[data-mount-id="input"]')?.textContent).toContain('12 files')
})

it('repeats a backend jump after a manual folder-server choice without retargeting execution', async () => {
  const app = new AppState()
  const local = app.backends.get()[0]!
  const remote = app.addBackend('http://studio.test:8188', 'Studio', false, 'dinkster')!
  for (const backend of [local, remote]) {
    if (backend.protocol === 'dinkster') vi.spyOn(backend.connection, 'fetchMountSettings').mockRejectedValue(new Error('Folders unavailable'))
  }
  const [focus, setFocus] = createSignal({ id: local.id })
  const targets = [...app.tabTargets.get()]
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <StoragePanel app={app} focusBackend={focus()} activeBackend={() => local} onOpenAssets={() => {}} />, root)
  disposers.push(() => { unmount(); app.dispose(); localStorage.clear() })
  const picker = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
  for (let repeat = 0; repeat < 2; repeat++) {
    picker.click()
    document.querySelector<HTMLElement>(`[role="option"][data-option-id="${remote.id}"]`)!.click()
    expect(picker.textContent).toContain('Studio')
    setFocus({ id: local.id })
    await vi.waitFor(() => expect(picker.textContent).toContain('Local'))
  }
  expect([...app.tabTargets.get()]).toEqual(targets)
})

it('groups model grants under one folder and switches project membership without removing known folders', async () => {
  const all: (MountDescriptor & { path: string })[] = [
    { id: 'models-checkpoint', path: '/models/checkpoints', mode: 'read', state: 'ready', source: 'shared-models', kind: 'model/checkpoint', entryCount: 3 },
    { id: 'models-lora', path: '/models/loras', mode: 'read', state: 'ready', source: 'shared-models', kind: 'model/lora', entryCount: 7 },
    { id: 'models-vae', path: '/models/vae', mode: 'read', state: 'pending', source: 'shared-models', kind: 'model/vae' },
    { id: 'renders', path: '/renders', mode: 'readwrite', state: 'ready', entryCount: 11 },
    { id: 'plates', path: '/plates', mode: 'read', state: 'ready', entryCount: 5 },
  ]
  let settings: MountSettings = { mounts: all.slice(0, 4), outputMount: 'renders', mountChangesAllowed: true }
  const location = { id: 'models', path: '/models', mode: 'read' as const, visibility: 'default-on' as const }
  const models: ModelSettingsState = {
    settings: { version: 1, locations: [location], downloadLocation: null },
    locations: [{ ...location, enabled: true, active: true, mounts: all.slice(0, 3).map((row) => row.id) }],
    revision: 'revision', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
  }
  let refuseRemoval = true
  const connection = {
    fetchMountSettings: async () => settings,
    fetchMountLocations: async () => ({ mounts: all }),
    fetchModelSettings: async () => models,
    onMountsChanged: () => () => {},
    updateProjectFolders: async (ids: readonly string[], output: string) => {
      if (!ids.includes('plates') && refuseRemoval) throw new RequestFailure('PUT', '/api/projects/default/folders', 503, 'Folder changes are temporarily unavailable.')
      settings = { mounts: ids.map((id) => all.find((row) => row.id === id)!), outputMount: output, mountChangesAllowed: true }
    },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  const opened: string[] = []
  const assetsOpened: string[] = []
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={(id) => assetsOpened.push(id!)} focus={{ modelLocationId: 'models' }} onOpenModels={(id) => opened.push(id)} />, root))
  await vi.waitFor(() => expect(root.querySelectorAll('[data-model-location]')).toHaveLength(1))
  expect([...root.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(['Model folders', 'Mounts'])
  expect([...root.querySelectorAll('button')].some((button) => button.textContent === 'Default save folder')).toBe(false)
  expect(root.querySelectorAll('[data-mount-id]')).toHaveLength(2)
  const model = root.querySelector('[data-model-location="models"]')!
  const disclosure = model.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  disclosure.click()
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  expect(model.textContent).not.toContain('Show these models')
  disclosure.click()
  ;[...model.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Show these models')!.click()
  expect(opened).toEqual(['models'])
  expect(model.textContent).toContain('Checkpoints3')
  expect(model.textContent).toContain('LoRAs7')
  expect(model.textContent).not.toContain('VAEs0')
  expect(root.textContent).not.toContain('GB')
  const renders = root.querySelector('[data-mount-id="renders"]')!
  const navigate = renders.querySelector<HTMLButtonElement>('button:not([aria-haspopup])')!
  expect(navigate.textContent).toContain('11 files')
  expect(navigate.hasAttribute('aria-expanded')).toBe(false)
  navigate.click()
  expect(assetsOpened).toEqual(['renders'])
  expect([...renders.querySelectorAll('button')].some((button) => button.textContent === 'Open in Assets')).toBe(false)
  const unused = [...root.querySelectorAll('details')].find((element) => element.querySelector('summary')?.textContent?.includes('not used by this project'))!
  expect(unused.open).toBe(false)
  unused.open = true
  root.querySelector<HTMLButtonElement>('[data-mount-id="plates"] [aria-haspopup="menu"]')!.click()
  const use = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Use in this project')!
  use.click()
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="plates"] button:not([aria-haspopup])')).not.toBeNull())
  expect(root.textContent).toContain('3 folders used by this project')
  root.querySelector<HTMLButtonElement>('[data-mount-id="plates"] button:not([aria-haspopup])')!.click()
  expect(assetsOpened).toEqual(['renders', 'plates'])
  root.querySelector<HTMLButtonElement>('[data-mount-id="plates"] [aria-haspopup="menu"]')!.click()
  ;[...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Stop using')!.click()
  expect(root.textContent).toContain('No files are deleted')
  expect(root.querySelector('[data-mount-id="renders"]')?.textContent).toContain('New saves go here')
  expect(root.querySelector('[data-model-location="models"]')?.textContent).toContain('Checkpoints3')
  ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Stop using this folder')!.click()
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="plates"]')?.textContent).toContain('Folder changes are temporarily unavailable.'))
  expect(root.querySelector('[data-mount-id="plates"]')?.textContent).toContain('"plates" is still used by this project.')
  expect(root.textContent).toContain('3 folders used by this project')
  expect(root.querySelector('[data-mount-id="renders"]')?.textContent).toContain('New saves go here')
  refuseRemoval = false
  ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Stop using this folder')!.click()
  await vi.waitFor(() => expect(root.textContent).toContain('2 folders used by this project'))
  expect(root.querySelector('[data-mount-id="plates"] button:not([aria-haspopup])')).toBeNull()
  expect(root.querySelector('[data-mount-id="renders"]')?.textContent).toContain('New saves go here')
})

it('aggregates model kinds by count with Other last and updates the pin colors with the theme', async () => {
  const app = new AppState()
  const backend = app.addBackend('http://studio.test:8188', 'Studio', false, 'dinkster', false)!
  if (backend.protocol !== 'dinkster') throw new Error('Native backend missing')
  app.settings.set('dinkster.theme', 'dark')
  const mounts: MountDescriptor[] = [
    { id: 'lora-a', mode: 'read', state: 'ready', kind: 'model/lora', entryCount: 2 },
    { id: 'lora-b', mode: 'read', state: 'ready', kind: 'model/lora', entryCount: 5 },
    { id: 'checkpoint', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 4 },
    { id: 'vae', mode: 'read', state: 'ready', kind: 'model/vae', entryCount: 4 },
    { id: 'future', mode: 'read', state: 'ready', kind: 'model/future', entryCount: 12 },
    { id: 'unnamed', mode: 'read', state: 'ready', entryCount: 3 },
    { id: 'empty', mode: 'read', state: 'ready', kind: 'model/controlnet', entryCount: 0 },
    { id: 'unknown-count', mode: 'read', state: 'pending', kind: 'model/text-encoder' },
  ]
  const location = { id: 'models', path: '/models', mode: 'read' as const, visibility: 'default-on' as const }
  let changed = () => {}
  backend.connection.fetchMountSettings = async () => ({ mounts, mountChangesAllowed: true })
  backend.connection.fetchMountLocations = async () => ({ mounts: mounts.map((row) => ({ ...row, path: `/models/${row.id}` })) })
  backend.connection.fetchModelSettings = async () => ({
    settings: { version: 1, locations: [location], downloadLocation: null },
    locations: [{ ...location, enabled: true, active: true, mounts: mounts.map((row) => row.id) }],
    revision: 'revision', project: 'default', changesAllowed: true, restartRequired: false, pendingRemovals: [],
  })
  backend.connection.onMountsChanged = (listener) => { changed = listener; return () => {} }
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <StoragePanel app={app} focusBackend={{ id: backend.id, modelLocationId: 'models' }} activeBackend={() => backend} onOpenAssets={() => {}} />, root)
  disposers.push(() => { unmount(); app.dispose(); localStorage.clear() })
  const legend = () => root.querySelector('dl[aria-label="Model kinds"]')!
  const rows = () => [...legend().querySelectorAll('dt')].map((row) => row.textContent)
  const values = () => [...legend().querySelectorAll('dd')].map((row) => row.textContent)
  await vi.waitFor(() => expect(rows()).toEqual(['LoRAs', 'Checkpoints', 'VAEs', 'Other']))
  expect(values()).toEqual(['7', '4', '4', '15'])
  const colors = () => [...legend().querySelectorAll('rect')].map((row) => row.getAttribute('fill'))
  const dark = colors()
  const darkPins = canvasTypePaintForTheme('dark').typeColors
  expect(dark).toEqual([darkPins.LATENT, darkPins.MODEL, darkPins.VAE, semanticTokensForTheme('dark').text.muted])
  app.settings.set('dinkster.theme', 'light')
  await vi.waitFor(() => expect(colors().every((color, index) => color !== dark[index])).toBe(true))
  const lightPins = canvasTypePaintForTheme('light').typeColors
  expect(colors()).toEqual([lightPins.LATENT, lightPins.MODEL, lightPins.VAE, semanticTokensForTheme('light').text.muted])
  expect(rows()).toEqual(['LoRAs', 'Checkpoints', 'VAEs', 'Other'])
  mounts[0] = { ...mounts[0]!, entryCount: 1 }
  mounts[1] = { ...mounts[1]!, entryCount: 1 }
  changed()
  await vi.waitFor(() => expect(rows()).toEqual(['Checkpoints', 'VAEs', 'LoRAs', 'Other']))
  expect(values()).toEqual(['4', '4', '2', '15'])
  mounts[0] = { id: 'lora-a', mode: 'read', state: 'pending', kind: 'model/lora' }
  changed()
  await vi.waitFor(() => expect(rows()).toEqual(['Checkpoints', 'VAEs', 'Other']))
  expect(values()).toEqual(['4', '4', '15'])
})

it('selects the default save folder from a writable mount menu', async () => {
  const mounts: MountDescriptor[] = [
    { id: 'renders', mode: 'readwrite', state: 'ready' },
    { id: 'exports', mode: 'readwrite', state: 'ready' },
    { id: 'reference', mode: 'read', state: 'ready' },
  ]
  let outputMount = 'renders'
  const connection = {
    fetchMountSettings: async () => ({ mounts, outputMount, mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts }),
    fetchModelSettings: async () => ({ locations: [], settings: { locations: [] }, changesAllowed: true }),
    onMountsChanged: () => () => {},
    selectOutputMount: async (id: string) => { outputMount = id },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} />, root))
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="renders"]')?.textContent).toContain('New saves go here'))
  root.querySelector<HTMLButtonElement>('[data-mount-id="reference"] [aria-haspopup="menu"]')!.click()
  expect([...root.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'Save new files here')).toBe(false)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  root.querySelector<HTMLButtonElement>('[data-mount-id="exports"] [aria-haspopup="menu"]')!.click()
  ;[...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Save new files here')!.click()
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="exports"]')?.textContent).toContain('New saves go here'))
  expect(root.querySelector('[data-mount-id="renders"]')?.textContent).not.toContain('New saves go here')
})

it('keeps a pending folder removal visible when edit controls are activated', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const mounts: MountDescriptor[] = [
    { id: 'renders', mode: 'readwrite', state: 'ready' },
    { id: 'plates', mode: 'read', state: 'ready' },
  ]
  const connection = {
    fetchMountSettings: async () => ({ mounts, outputMount: 'renders', mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts }),
    fetchModelSettings: async () => ({ settings: { locations: [] }, locations: [], changesAllowed: true }),
    onMountsChanged: () => () => {},
    updateProjectFolders: async () => gate,
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} />, root))
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="plates"]')).not.toBeNull())
  root.querySelector<HTMLButtonElement>('[data-mount-id="plates"] [aria-haspopup="menu"]')!.click()
  ;[...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Stop using')!.click()
  ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Stop using this folder')!.click()
  try {
    for (const control of [...root.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Default save folder' || button.textContent === 'Add').reverse()) {
      control.click()
      expect(root.querySelector('.dinkster-confirmation [aria-busy="true"]')).not.toBeNull()
    }
  } finally {
    finish()
    await vi.waitFor(() => expect(root.querySelector('.dinkster-confirmation')).toBeNull())
  }
})
