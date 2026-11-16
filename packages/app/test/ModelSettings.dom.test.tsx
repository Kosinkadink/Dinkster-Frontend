import { render } from 'solid-js/web'
import { createSignal, type ComponentProps } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import type { ModelSettingsState } from '@dinkster/client'
import { ModelSettings } from '../src/ModelSettings.js'

afterEach(() => { document.body.replaceChildren() })

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
    root.querySelector<HTMLButtonElement>('[data-model-location="studio"] .project-folder-actions button')!.click()
    expect(root.textContent).toContain('No model files will be deleted')
    const confirm = [...root.querySelectorAll<HTMLButtonElement>('.project-folder-removal button')].find((button) => button.textContent === 'Remove shared location')!
    confirm.click()
    await vi.waitFor(() => expect(state.settings.locations.map((row) => row.id)).toEqual(['required', 'archive']))
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
