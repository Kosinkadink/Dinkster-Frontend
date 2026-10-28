import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MountSettings } from '@dinkster/client'
import { ProjectFolderSettings } from '../src/ProjectFolderSettings.js'

afterEach(() => { document.body.replaceChildren() })

describe('project folder management', () => {
  it('persists keyboard order and requires replacement before removing output membership', async () => {
    let settings: MountSettings = {
      mountChangesAllowed: true, outputMount: 'renders', activeOutputMount: 'renders',
      mounts: [
        { id: 'plates', mode: 'read', state: 'failed' },
        { id: 'renders', mode: 'readwrite', state: 'ready' },
        { id: 'backup', mode: 'readwrite', state: 'ready' },
      ],
    }
    const connection = {
      fetchMountSettings: async () => settings,
      fetchMountLocations: async () => ({ mounts: settings.mounts.map((mount) => ({ id: mount.id, path: `/studio/${mount.id}` })) }),
      updateProjectFolders: async (ids: readonly string[], outputMount: string | null) => {
        settings = { ...settings, mounts: ids.map((id) => settings.mounts.find((row) => row.id === id)!), ...(outputMount ? { outputMount } : {}) }
      },
      retryMount: async (id: string) => { settings = { ...settings, mounts: settings.mounts.map((row) => row.id === id ? { ...row, state: 'ready' } : row) } },
      addMount: vi.fn(),
    }
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProjectFolderSettings connection={connection} backendLabel="Studio server" />, root)
    const row = (id: string) => root.querySelector<HTMLElement>(`[data-mount-id="${id}"]`)!
    const button = (element: HTMLElement, text: string) => [...element.querySelectorAll('button')].find((item) => item.textContent === text)!
    await vi.waitFor(() => expect(row('plates').textContent).toContain('/studio/plates'))
    button(row('plates'), 'Retry / rescan').click()
    await vi.waitFor(() => expect(row('plates').textContent).toContain('ready'))
    button(row('backup'), 'Move up').click()
    await vi.waitFor(() => expect([...root.querySelectorAll('[data-mount-id]')].map((item) => item.getAttribute('data-mount-id'))).toEqual(['plates', 'backup', 'renders']))
    button(row('renders'), 'Stop using').click()
    expect(root.textContent).toContain('No files will be deleted')
    const confirm = button(root, 'Stop using this folder')
    expect(confirm.disabled).toBe(true)
    root.querySelector<HTMLButtonElement>('#folder-replacement')!.click()
    document.querySelector<HTMLElement>('[data-option-id="backup"]')!.click()
    confirm.click()
    await vi.waitFor(() => expect(root.querySelector('[data-mount-id="renders"]')).toBeNull())
    expect(settings.outputMount).toBe('backup')
    expect(settings.mounts.map((mount) => mount.id)).toEqual(['plates', 'backup'])
    dispose()
  })

  it('shows configured and active state without permitting policy-disabled edits', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProjectFolderSettings backendLabel="Offline studio" connection={{
      fetchMountSettings: async () => ({ mountChangesAllowed: false, restartRequired: true, outputMount: 'next', activeOutputMount: 'old', mounts: [{ id: 'next', mode: 'readwrite', state: 'restart-required' }] }),
      fetchMountLocations: async () => { throw new Error('403') },
      updateProjectFolders: vi.fn(), retryMount: vi.fn(), addMount: vi.fn(),
    }} />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('Active output: old'))
    expect(root.textContent).toContain('disabled by server policy')
    expect(root.textContent).toContain('operator access required')
    expect(root.querySelector('form')).toBeNull()
    expect([...root.querySelectorAll<HTMLButtonElement>('li button')].every((button) => button.disabled)).toBe(true)
    dispose()
  })
})
