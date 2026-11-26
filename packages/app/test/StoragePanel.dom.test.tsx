import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { DinksterConnection, ModelSettingsState, MountDescriptor, MountSettings } from '@dinkster/client'
import { StorageFolders, StoragePanel } from '../src/StoragePanel.js'
import { AppState } from '../src/app-state.js'

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks() })

it.each([true, false])('keeps a refused mount form and adds with saving allowed: %s', async (writable) => {
  const mounts: MountDescriptor[] = []
  let refused = true
  const connection = {
    fetchMountSettings: async () => ({ mounts, mountChangesAllowed: true }),
    fetchMountLocations: async () => ({ mounts }),
    fetchModelSettings: async () => ({ locations: [], settings: { locations: [] }, changesAllowed: true }),
    onMountsChanged: () => () => {},
    addMount: async (id: string, path: string, mode: 'read' | 'readwrite') => {
      if (refused) throw new Error('Folder cannot be written to')
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
    { id: 'input', mode: 'readwrite', state: 'scanning', scanProgress: { filesDone: 7, filesTotal: 10, bytesDone: 4096, bytesTotal: 16384, elapsedSeconds: 1 } },
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
  expect(model.textContent).toContain('2.0 KiB of 10 KiB read')
  expect(model.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0.2')
  const input = root.querySelector('[data-mount-id="input"]')!
  expect(input.textContent).toContain('Reading, 7 of 10')
  expect(input.textContent).toContain('4.0 KiB of 16 KiB read')
  expect(input.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0.25')
  mounts = mounts.map(({ scanProgress: _, ...mount }) => ({ ...mount, state: 'ready', entryCount: 12 }))
  changed()
  await vi.waitFor(() => expect(root.querySelectorAll('[role="progressbar"]')).toHaveLength(0))
  expect(root.textContent).not.toContain('Reading,')
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
  const connection = {
    fetchMountSettings: async () => settings,
    fetchMountLocations: async () => ({ mounts: all }),
    fetchModelSettings: async () => models,
    onMountsChanged: () => () => {},
    updateProjectFolders: async (ids: readonly string[], output: string) => {
      settings = { mounts: ids.map((id) => all.find((row) => row.id === id)!), outputMount: output, mountChangesAllowed: true }
    },
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  disposers.push(render(() => <StorageFolders connection={connection} backendUrl="" onOpenAssets={() => {}} />, root))
  await vi.waitFor(() => expect(root.querySelectorAll('[data-model-location]')).toHaveLength(1))
  expect([...root.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(['Model folders', 'Mounts'])
  expect([...root.querySelectorAll('button')].some((button) => button.textContent === 'Default save folder')).toBe(false)
  expect(root.querySelectorAll('[data-mount-id]')).toHaveLength(2)
  const model = root.querySelector('[data-model-location="models"]')!
  expect(model.textContent).toContain('Checkpoints3')
  expect(model.textContent).toContain('LoRAs7')
  expect(model.textContent).not.toContain('VAEs0')
  expect(root.textContent).not.toContain('GB')
  const unused = [...root.querySelectorAll('details')].find((element) => element.querySelector('summary')?.textContent?.includes('not used by this project'))!
  expect(unused.open).toBe(false)
  unused.open = true
  root.querySelector<HTMLButtonElement>('[data-mount-id="plates"] [aria-haspopup="menu"]')!.click()
  const use = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Use in this project')!
  use.click()
  await vi.waitFor(() => expect(root.querySelector('[data-mount-id="plates"]')?.textContent).toContain('Open in Assets'))
  expect(root.textContent).toContain('3 folders used by this project')
  root.querySelector<HTMLButtonElement>('[data-mount-id="plates"] [aria-haspopup="menu"]')!.click()
  ;[...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === 'Stop using')!.click()
  expect(root.textContent).toContain('No files will be deleted')
  ;[...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Stop using this folder')!.click()
  await vi.waitFor(() => expect(root.textContent).toContain('2 folders used by this project'))
  expect(root.querySelector('[data-mount-id="plates"]')?.textContent).not.toContain('Open in Assets')
  expect(root.querySelector('[data-mount-id="renders"]')?.textContent).toContain('New saves go here')
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
