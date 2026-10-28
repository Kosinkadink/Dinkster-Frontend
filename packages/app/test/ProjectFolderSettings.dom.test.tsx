import { render } from 'solid-js/web'
import { createSignal, type ComponentProps } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MountSettings } from '@dinkster/client'
import { ProjectFolderSettings } from '../src/ProjectFolderSettings.js'
import { MountFolderForm } from '../src/MountFolderForm.js'

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
      onMountsChanged: () => () => {},
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

  it.each([false, true])('isolates a pending reorder when switching connections (reject: %s)', async (rejectOld) => {
    type Connection = ComponentProps<typeof ProjectFolderSettings>['connection']
    let settleOld!: () => void
    const oldSave = new Promise<void>((resolve, reject) => { settleOld = () => rejectOld ? reject(new Error('Old server unavailable')) : resolve() })
    let finishNew!: () => void
    const newSave = new Promise<void>((resolve) => { finishNew = resolve })
    let nextSettings: MountSettings = { mountChangesAllowed: true, mounts: [
      { id: 'new-first', mode: 'read', state: 'ready' }, { id: 'new-second', mode: 'read', state: 'ready' },
    ] }
    const first: Connection = {
      onMountsChanged: () => () => {}, fetchMountLocations: async () => ({ mounts: [] }),
      fetchMountSettings: async () => ({ mountChangesAllowed: true, mounts: [
        { id: 'old-first', mode: 'read', state: 'ready' }, { id: 'old-second', mode: 'read', state: 'ready' },
      ] }),
      updateProjectFolders: () => oldSave, retryMount: vi.fn(), addMount: vi.fn(),
    }
    const second: Connection = { ...first, fetchMountSettings: async () => nextSettings,
      updateProjectFolders: async (ids) => {
        await newSave
        nextSettings = { ...nextSettings, mounts: ids.map((id) => nextSettings.mounts.find((mount) => mount.id === id)!) }
      },
    }
    const [connection, setConnection] = createSignal(first)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProjectFolderSettings connection={connection()} backendLabel="Studio" />, root)
    const up = (id: string) => root.querySelector<HTMLButtonElement>(`[aria-label="Move ${id} up"]`)!
    try {
      await vi.waitFor(() => expect(up('old-second')).not.toBeNull())
      up('old-second').click()
      setConnection(second)
      await vi.waitFor(() => expect(up('new-second')?.disabled).toBe(false))
      up('new-second').click()
      settleOld()
      await oldSave.catch(() => {})
      await Promise.resolve()
      expect(root.textContent).not.toContain('Old server unavailable')
      expect(root.textContent).not.toContain('old-first')
      expect(up('new-second').disabled).toBe(true)
      finishNew()
      await vi.waitFor(() => expect([...root.querySelectorAll('[data-mount-id]')].map((row) => row.getAttribute('data-mount-id'))).toEqual(['new-second', 'new-first']))
    } finally { finishNew(); dispose() }
  })

  it.each([false, true])('does not clear a new connection grant form when an older grant settles (reject: %s)', async (rejectOld) => {
    type Connection = ComponentProps<typeof ProjectFolderSettings>['connection']
    let settle!: () => void
    const pending = new Promise<Awaited<ReturnType<Connection['addMount']>>>((resolve, reject) => {
      settle = () => rejectOld ? reject(new Error('Old grant failed')) : resolve({ id: 'old', mode: 'read', state: 'ready' })
    })
    const first: Connection = {
      onMountsChanged: () => () => {}, fetchMountSettings: async () => ({ mounts: [], mountChangesAllowed: true }),
      fetchMountLocations: async () => ({ mounts: [] }), updateProjectFolders: vi.fn(), retryMount: vi.fn(), addMount: () => pending,
    }
    const [connection, setConnection] = createSignal(first)
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <MountFolderForm connection={connection()} />, root)
    const enter = (value: string) => {
      const input = root.querySelector<HTMLInputElement>('#desktop-mount-path')!
      input.value = value
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
    try {
      await vi.waitFor(() => expect(root.querySelector('form')).not.toBeNull())
      enter('/studio/old')
      root.querySelector<HTMLFormElement>('form')!.requestSubmit()
      setConnection({ ...first, addMount: vi.fn() })
      await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('#desktop-mount-path')?.value).toBe(''))
      enter('/studio/new')
      settle()
      await pending.catch(() => {})
      await Promise.resolve()
      expect(root.querySelector<HTMLInputElement>('#desktop-mount-path')!.value).toBe('/studio/new')
      expect(root.querySelector('[role="status"]')).toBeNull()
      expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false)
    } finally { dispose() }
  })

  it('shows configured and active state without permitting policy-disabled edits', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProjectFolderSettings backendLabel="Offline studio" connection={{
      onMountsChanged: () => () => {},
      fetchMountSettings: async () => ({ mountChangesAllowed: false, restartRequired: true, outputMount: 'next', activeOutputMount: 'old', pendingRemovals: ['old', 'archive'], mounts: [{ id: 'next', mode: 'readwrite', state: 'restart-required' }] }),
      fetchMountLocations: async () => { throw new Error('403') },
      updateProjectFolders: vi.fn(), retryMount: vi.fn(), addMount: vi.fn(),
    }} />, root)
    await vi.waitFor(() => expect(root.textContent).toContain('Active output: old'))
    expect(root.textContent).toContain('Server grants pending removal: old, archive. They remain active until restart. No files will be deleted.')
    expect(root.querySelector('[data-mount-id="old"]')).toBeNull()
    expect(root.textContent).toContain('disabled by server policy')
    expect(root.textContent).toContain('operator access required')
    expect(root.querySelector('form')).toBeNull()
    expect([...root.querySelectorAll<HTMLButtonElement>('li button')].every((button) => button.disabled)).toBe(true)
    dispose()
  })
})
