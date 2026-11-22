import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import type { DinksterConnection, ModelSettingsState, MountDescriptor, MountSettings } from '@dinkster/client'
import { StorageFolders, StoragePanel } from '../src/StoragePanel.js'
import { AppState } from '../src/app-state.js'

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren(); vi.restoreAllMocks() })

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
