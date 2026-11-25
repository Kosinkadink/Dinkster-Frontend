// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import type { LibraryProject } from '@dinkster/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsDialog } from '../src/ProjectsDialog.js'
import { PROJECTS_KEY } from '../src/projects.js'

type ProjectClient = Parameters<typeof ProjectsDialog>[0]['connection']
const row = (id: string, name: string, revision = 1): LibraryProject => ({ id, name, revision, created: '2026-11-18T12:34:56Z', deleted: false })
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function engine(): ProjectClient & { readonly records: Map<string, LibraryProject> } {
  const records = new Map([['default', row('default', 'Default')]])
  return {
    records,
    accountStatus: async () => ({ available: false, canStartSignIn: false, signInUnavailableReason: 'account-unavailable', signedIn: false, profile: null, signIn: 'idle' }),
    accountProjects: async () => ({ issuer: 'https://identity.test', projects: [] }),
    getProject: async (id) => records.get(id)!,
    setProjectAccountLink: async () => { throw new Error('Account unavailable') },
    listProjects: async () => ({ items: [...records.values()], cursor: null }),
    registerProject: async (id, name) => {
      const project = records.get(id) ?? row(id, name)
      records.set(id, project)
      return project
    },
    renameProject: async (id, name, revision) => {
      const previous = records.get(id)!
      if (previous.revision !== revision) throw new Error('Project changed elsewhere. Refresh before renaming.')
      const project = row(id, name, revision + 1)
      records.set(id, project)
      return project
    },
  }
}

function mount(options: { readonly withOpenWindow?: boolean; readonly connection?: ProjectClient } = {}) {
  const onSwitch = vi.fn()
  const onOpenWindow = vi.fn()
  const connection = options.connection ?? engine()
  const [client, setClient] = createSignal(connection)
  const [backendStatus, setBackendStatus] = createSignal(0)
  const currentClient = (): ProjectClient => { backendStatus(); return client() }
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => (options.withOpenWindow === true
    ? <ProjectsDialog connection={currentClient()} onSwitch={onSwitch} onOpenWindow={onOpenWindow} />
    : <ProjectsDialog connection={currentClient()} onSwitch={onSwitch} />
  ), root)
  return { root, onSwitch, onOpenWindow, unmount, setClient, refreshBackendStatus: () => setBackendStatus((value) => value + 1) }
}

function rows(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('li[data-project-id]')]
}
function actionButton(row: HTMLElement, label: string): HTMLButtonElement {
  const button = [...row.querySelectorAll('button')].find((b) => b.textContent === label)
  if (button === undefined) throw new Error(`no ${label} button`)
  return button
}

describe('ProjectsDialog', () => {
  beforeEach(() => { localStorage.removeItem(PROJECTS_KEY) })
  afterEach(() => { document.body.innerHTML = '' })

  it('creates in the engine registry and switches without creating browser descriptors', async () => {
    const client = engine()
    const { root, onSwitch, unmount } = mount({ connection: client })
    await flush()
    const draft = root.querySelector<HTMLInputElement>('input[aria-label="New project name"]')!
    const create = root.querySelector<HTMLButtonElement>('[data-testid="projects-create"]')!
    expect(create.disabled).toBe(true)
    draft.value = 'Video experiments'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    create.click()
    await flush()
    const created = rows(root)[1]!
    expect(created.textContent).toContain('Video experiments')
    expect(client.records.get(created.dataset['projectId']!)?.name).toBe('Video experiments')
    expect(localStorage.getItem(PROJECTS_KEY)).toBeNull()
    actionButton(created, 'Switch').click()
    expect(onSwitch).toHaveBeenCalledWith(created.dataset['projectId'])
    unmount()
  })

  it('keeps an unsaved name when backend status changes on the same connection', async () => {
    const mounted = mount()
    await flush()
    const draft = mounted.root.querySelector<HTMLInputElement>('input[aria-label="New project name"]')!
    draft.value = 'Unsaved studio'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    mounted.refreshBackendStatus()
    await flush()
    expect(draft.value).toBe('Unsaved studio')
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-testid="projects-create"]')!.disabled).toBe(false)
    mounted.unmount()
  })

  it('preserves another window rename on conflict and uses its refreshed revision on retry', async () => {
    const client = engine()
    const { root, unmount } = mount({ connection: client })
    await flush()
    actionButton(rows(root)[0]!, 'Rename').click()
    await flush()
    client.records.set('default', row('default', 'Other window', 7))
    const input = root.querySelector<HTMLInputElement>('input[aria-label^="Rename"]')!
    expect(input.classList.contains('product-text-input')).toBe(true)
    expect(document.activeElement).toBe(input)
    input.value = 'Main studio'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('changed elsewhere')
    expect(client.records.get('default')?.name).toBe('Other window')
    const retry = root.querySelector<HTMLInputElement>('input[aria-label^="Rename"]')!
    retry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(client.records.get('default')).toMatchObject({ name: 'Main studio', revision: 8 })
    expect(root.querySelector('[role="alert"]')).toBeNull()
    unmount()
  })

  it('offers a new-window action only when the host provides one', async () => {
    const { root, onOpenWindow, unmount } = mount({ withOpenWindow: true })
    await flush()
    actionButton(rows(root)[0]!, 'New window').click()
    expect(onOpenWindow).toHaveBeenCalledWith('default')
    unmount()
    const bare = mount()
    await flush()
    expect([...bare.root.querySelectorAll('button')].some((b) => b.textContent === 'New window')).toBe(false)
    bare.unmount()
  })

  it.each(['choices', 'preflight', 'acknowledgment'] as const)('ignores retired account %s work after the engine changes', async (pendingStage) => {
    const old = engine()
    const accountId = '48bb018e-5b17-4e68-bd81-c6412c4bcd72'
    const issuer = 'https://identity.test'
    old.records.set('default', { ...row('default', 'Retired engine'), uid: '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457', accountProject: null })
    old.accountStatus = async () => ({ available: true, canStartSignIn: true, signInUnavailableReason: null, signedIn: true, profile: null, signIn: 'idle' })
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    old.accountProjects = async () => {
      if (pendingStage === 'choices') await pending
      return { issuer, projects: [{ id: accountId, displayName: 'Retired account choice' }] }
    }
    let preflight = false
    old.getProject = async (id) => {
      if (preflight && pendingStage === 'preflight') await pending
      return old.records.get(id)!
    }
    old.setProjectAccountLink = async (id) => {
      if (pendingStage === 'acknowledgment') await pending
      const saved = { ...old.records.get(id)!, revision: 2, accountProject: { issuer, id: accountId } }
      old.records.set(id, saved)
      return saved
    }
    const mounted = mount({ connection: old })
    await flush()
    actionButton(rows(mounted.root)[0]!, 'Account link').click()
    await flush()
    if (pendingStage !== 'choices') {
      const select = document.querySelector<HTMLSelectElement>('select')!
      select.value = accountId
      select.dispatchEvent(new Event('change', { bubbles: true }))
      preflight = true
      const save = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save link')!
      expect(save.disabled).toBe(false)
      save.click()
      await flush()
    }
    const current = engine()
    current.records.set('default', row('default', 'Current engine', 9))
    mounted.setClient(current)
    await flush()
    release()
    await flush()
    expect(rows(mounted.root).map((entry) => entry.textContent)).toEqual([expect.stringContaining('Current engine')])
    expect(document.body.textContent).not.toContain('Retired account choice')
    expect(document.body.textContent).not.toContain('Account link saved.')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(current.records.get('default')).toEqual(row('default', 'Current engine', 9))
    expect(old.records.get('default')?.accountProject).toEqual(pendingStage === 'acknowledgment' ? { issuer, id: accountId } : null)
    mounted.unmount()
  })

  it('loads all pages, migrates browser names and ignores a retired connection response', async () => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify({ v: 1, projects: [{ id: 'p-film', name: 'Browser film', createdAt: 1 }] }))
    const old = engine()
    let answer!: (value: { items: readonly LibraryProject[]; cursor: null }) => void
    old.listProjects = () => new Promise((resolve) => { answer = resolve })
    const mounted = mount({ connection: old })
    await flush()
    expect(mounted.root.textContent).toContain('Loading projects')
    expect(old.records.get('p-film')?.name).toBe('Browser film')
    const current = engine()
    current.listProjects = async (cursor) => cursor === undefined
      ? { items: [row('default', 'Current engine')], cursor: 'page-two' }
      : { items: [row('p-last', 'Last page')], cursor: null }
    mounted.setClient(current)
    await flush()
    answer({ items: [row('p-stale', 'Retired engine')], cursor: null })
    await flush()
    expect(rows(mounted.root).map((entry) => entry.dataset['projectId'])).toEqual(['default', 'p-last'])
    expect(mounted.root.textContent).not.toContain('Retired engine')
    mounted.unmount()
  })
})
