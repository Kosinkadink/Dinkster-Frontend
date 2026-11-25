import { render } from 'solid-js/web'
import { createSignal, type ComponentProps } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import type { ModelSettingsState } from '@dinkster/client'
import { ModelSettings } from '../src/ModelSettings.js'

afterEach(() => { document.body.replaceChildren(); delete window.dinksterDesktop })

const initial: ModelSettingsState = {
  settings: { version: 1, downloadLocation: null, locations: [
    { id: 'studio', path: '/existing/checkpoints', mode: 'read', kind: 'model/checkpoint', visibility: 'opt-in' },
    { id: 'required', path: '/shared/models', mode: 'read', visibility: 'always-on' },
  ] },
  locations: [
    { id: 'studio', path: '/existing/checkpoints', mode: 'read', kind: 'model/checkpoint', visibility: 'opt-in', mounts: ['studio-checkpoint'], enabled: false, active: true },
    { id: 'required', path: '/shared/models', mode: 'read', visibility: 'always-on', mounts: ['required-checkpoint'], enabled: true, active: true },
  ], revision: 'first', project: 'commercial', changesAllowed: true, restartRequired: false, pendingRemovals: [],
}

it('switches whole locations, preserves read-only category roots, and removes registration without deleting files', async () => {
  let state = structuredClone(initial)
  const connection: ComponentProps<typeof ModelSettings>['connection'] = {
    fetchModelSettings: async () => state,
    onMountsChanged: () => () => {},
    setModelLocationEnabled: async (id, enabled) => {
      state = { ...state, locations: state.locations.map((row) => row.id === id ? { ...row, enabled } : row) }
      return state
    },
    updateModelSettings: async (settings, revision) => {
      expect(revision).toBe(state.revision)
      state = { ...state, settings, revision: 'next', locations: settings.locations.map((row) => ({ ...row, mounts: [`${row.id}-checkpoint`], active: false, enabled: true })), restartRequired: true }
      return state
    },
  }
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection} backendLabel="Studio engine" />, root)
  try {
    await vi.waitFor(() => expect(root.textContent).toContain('/existing/checkpoints'))
    const enabled = (id: string) => root.querySelector<HTMLButtonElement>(`[aria-label="Enable ${id} for this project"]`)!
    expect(enabled('required').disabled).toBe(true)
    expect(enabled('studio').getAttribute('aria-checked')).toBe('false')
    enabled('studio').click()
    await vi.waitFor(() => expect(enabled('studio').getAttribute('aria-checked')).toBe('true'))
    const input = (id: string, value: string) => {
      const field = root.querySelector<HTMLInputElement>(`#${id}`)!
      field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    input('model-location-id', 'archive')
    input('model-location-path', '/archive/checkpoints')
    input('model-location-kind', 'model/checkpoint')
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(state.settings.locations).toHaveLength(3))
    expect(state.settings.locations[2]).toEqual({ id: 'archive', path: '/archive/checkpoints', kind: 'model/checkpoint', mode: 'read', visibility: 'default-on' })
    expect(state.settings.downloadLocation).toBeNull()
    expect(root.textContent).toContain('Restart the engine')
    const removeButton = [...root.querySelectorAll<HTMLButtonElement>('[data-model-location="studio"] .project-folder-actions button')].find((button) => button.textContent === 'Remove shared location')!
    removeButton.click()
    expect(root.textContent).toContain('No model files will be deleted')
    const confirm = [...root.querySelectorAll<HTMLButtonElement>('.project-folder-removal button')].find((button) => button.textContent === 'Remove shared location')!
    confirm.click()
    await vi.waitFor(() => expect(state.settings.locations.map((row) => row.id)).toEqual(['required', 'archive']))
  } finally { dispose() }
})

it('edits access explicitly, preserves the shared visibility, and ignores canceled native folder choices', async () => {
  let state = structuredClone(initial)
  let selected: string | undefined
  window.dinksterDesktop = { fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: false }), chooseDirectory: async () => selected }
  const connection: ComponentProps<typeof ModelSettings>['connection'] = {
    onMountsChanged: () => () => {}, fetchModelSettings: async () => state,
    setModelLocationEnabled: vi.fn(), updateModelSettings: async (settings) => {
      state = { ...state, settings, revision: 'second', locations: settings.locations.map((row) => ({ ...row, mounts: [row.id], enabled: true, active: true })) }
      return state
    },
  }
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection} backendLabel="Engine" backendUrl="" />, root)
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === text)!
  const path = () => root.querySelector<HTMLInputElement>('#model-location-path')!
  try {
    await vi.waitFor(() => expect(button('Choose folder')).toBeDefined())
    button('Edit model folder').click()
    expect(path().value).toBe('/existing/checkpoints')
    expect(root.querySelector<HTMLInputElement>('#model-location-id')!.readOnly).toBe(true)
    button('Choose folder').click()
    await vi.waitFor(() => expect(button('Choose folder').disabled).toBe(false))
    expect(path().value).toBe('/existing/checkpoints')
    selected = '/second/checkpoints'
    button('Choose folder').click()
    await vi.waitFor(() => expect(path().value).toBe('/second/checkpoints'))
    root.querySelector<HTMLButtonElement>('[aria-label="Allow downloads into this folder"]')!.click()
    button('Save model folder').click()
    await vi.waitFor(() => expect(state.settings.downloadLocation).toBe('studio'))
    expect(state.settings.locations[0]).toEqual({ id: 'studio', path: '/second/checkpoints', mode: 'readwrite', kind: 'model/checkpoint', visibility: 'opt-in' })
    button('Edit model folder').click()
    root.querySelector<HTMLButtonElement>('[aria-label="Allow downloads into this folder"]')!.click()
    button('Save model folder').click()
    await vi.waitFor(() => expect(state.settings.downloadLocation).toBeNull())
    expect(state.settings.locations[0]!.mode).toBe('read')
  } finally { dispose() }
})

it('refuses a stale open editor after a shared update and preserves its draft until refresh', async () => {
  let state = structuredClone(initial)
  let notify!: () => void
  let saves = 0
  const connection: ComponentProps<typeof ModelSettings>['connection'] = {
    onMountsChanged: (callback) => { notify = callback; return () => {} }, fetchModelSettings: async () => state,
    setModelLocationEnabled: vi.fn(), updateModelSettings: async () => { saves++; return state },
  }
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection} backendLabel="Engine" />, root)
  const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === text)!
  try {
    await vi.waitFor(() => expect(button('Edit model folder')).toBeDefined())
    root.querySelector<HTMLButtonElement>('#model-visibility-studio')!.click()
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    state = structuredClone(state)
    notify()
    await Promise.resolve(); await Promise.resolve()
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    button('Edit model folder').click()
    const draft = root.querySelector<HTMLInputElement>('#model-location-path')!
    expect(button('Save model folder').disabled).toBe(true)
    draft.value = '/edited/checkpoints'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    expect(button('Save model folder').disabled).toBe(false)
    state = { ...state, revision: 'changed-elsewhere' }
    notify()
    await Promise.resolve(); await Promise.resolve()
    button('Save model folder').click()
    await vi.waitFor(() => expect(root.textContent).toContain('changed while you were editing'))
    expect(saves).toBe(0)
    expect(root.querySelector<HTMLInputElement>('#model-location-path')!.value).toBe('/edited/checkpoints')
    button('Refresh folders').click()
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('#model-location-path')!.value).toBe(''))
  } finally { dispose() }
})

it('shows unavailable hidden selections and restores visibility only on explicit action', async () => {
  const hidden = { name: 'offline.safetensors', kind: 'model/checkpoint', identities: ['local-revision:opaque'] }
  let state = { ...initial, hiddenModels: [hidden] }
  const connection = { fetchModelSettings: async () => state, onMountsChanged: () => () => {},
    updateModelSettings: vi.fn(), setModelLocationEnabled: vi.fn(),
    unhideModel: async (identity: string) => { expect(identity).toBe(hidden.identities[0]); state = { ...state, hiddenModels: [] }; return state } }
  const changed = vi.fn()
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection} visibilityConnection={connection} backendLabel="Engine" onChanged={changed} />, root)
  try {
    await vi.waitFor(() => expect(root.textContent).toContain(hidden.name))
    expect(changed).not.toHaveBeenCalled()
    root.querySelector<HTMLButtonElement>('[data-testid="hidden-models"] button')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('No individual models are hidden'))
    expect(root.textContent).not.toContain(hidden.name)
    expect(changed).toHaveBeenCalledTimes(1)
  } finally { dispose() }
})

it('discards pending unhide completion after changing engines', async () => {
  let finish!: (state: ModelSettingsState) => void
  const hidden = { name: 'first.safetensors', kind: 'model/checkpoint', identities: ['opaque'] }
  const first = { fetchModelSettings: async () => ({ ...initial, hiddenModels: [hidden] }), onMountsChanged: () => () => {},
    updateModelSettings: vi.fn(), setModelLocationEnabled: vi.fn(), unhideModel: () => new Promise<ModelSettingsState>((resolve) => { finish = resolve }) }
  const second = { ...first, fetchModelSettings: async () => ({ ...initial, project: 'other', hiddenModels: [{ ...hidden, name: 'second.safetensors' }] }) }
  const [connection, setConnection] = createSignal(first)
  const changed = vi.fn()
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection()} visibilityConnection={connection()} backendLabel="Engine" onChanged={changed} />, root)
  try {
    await vi.waitFor(() => expect(root.textContent).toContain(hidden.name))
    root.querySelector<HTMLButtonElement>('[data-testid="hidden-models"] button')!.click()
    setConnection(second)
    await vi.waitFor(() => expect(root.textContent).toContain('second.safetensors'))
    finish({ ...initial, hiddenModels: [] }); await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('second.safetensors')
    expect(changed).not.toHaveBeenCalled()
  } finally { dispose() }
})

it('opens only the requested folder editor and requires a changed value before saving', async () => {
  let settings = initial.settings
  const connection: ComponentProps<typeof ModelSettings>['connection'] = {
    fetchModelSettings: async () => initial,
    onMountsChanged: () => () => {},
    setModelLocationEnabled: vi.fn(),
    updateModelSettings: async (next) => { settings = next; return { ...initial, settings: next } },
  }
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection} backendLabel="Engine" editLocation="studio" />, root)
  try {
    const input = () => root.querySelector<HTMLInputElement>('#model-location-path')!
    const save = () => [...root.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === 'Save model folder')!
    await vi.waitFor(() => expect(input()?.value).toBe('/existing/checkpoints'))
    expect(root.querySelector('[data-model-location]')).toBeNull()
    expect(save().disabled).toBe(true)
    input().value = '/new/checkpoints'
    input().dispatchEvent(new Event('input', { bubbles: true }))
    expect(save().disabled).toBe(false)
    save().click()
    await vi.waitFor(() => expect(settings.locations[0]?.path).toBe('/new/checkpoints'))
    await vi.waitFor(() => expect(save()?.disabled).toBe(true))
    expect(input().value).toBe('/new/checkpoints')
    expect(root.textContent).not.toContain('Add model folder')
    expect(settings.locations[1]).toEqual(initial.settings.locations[1])
  } finally { dispose() }
})

it('discards an old server response after changing connections', async () => {
  let finish!: (state: ModelSettingsState) => void
  const first: ComponentProps<typeof ModelSettings>['connection'] = { fetchModelSettings: () => new Promise((resolve) => { finish = resolve }), onMountsChanged: () => () => {}, updateModelSettings: vi.fn(), setModelLocationEnabled: vi.fn() }
  const second = { ...first, fetchModelSettings: async () => ({ ...initial, project: 'second', locations: [], settings: { ...initial.settings, locations: [] } }) }
  const [connection, setConnection] = createSignal(first)
  const root = document.createElement('div'); document.body.append(root)
  const dispose = render(() => <ModelSettings connection={connection()} backendLabel="Engine" />, root)
  try {
    setConnection(second)
    await vi.waitFor(() => expect(root.textContent).toContain('project second'))
    finish(initial)
    await Promise.resolve()
    expect(root.textContent).not.toContain('/existing/checkpoints')
    expect(root.textContent).toContain('project second')
  } finally { dispose() }
})
