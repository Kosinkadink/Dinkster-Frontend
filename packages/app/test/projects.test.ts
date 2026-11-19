import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID, initializeProjectScope, migrateBrowserProjects, projectIdFromSearch, PROJECTS_KEY, scopedSharedName, scopedStorageKey } from '../src/projects.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[PROJECTS_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) } as Storage
}

afterEach(() => initializeProjectScope(undefined))

describe('legacy project recovery', () => {
  it.each(['{broken', JSON.stringify({ v: 99, projects: [] })])('keeps unreadable source for recovery', async (source) => {
    const store = storage(source)
    await expect(migrateBrowserProjects({ registerProject: async () => { throw new Error('unexpected registration') } }, store)).rejects.toThrow()
    expect(store.getItem(PROJECTS_KEY)).toBe(source)
  })

  it('carries the default display name into the engine without retaining a browser registry', async () => {
    const store = storage(JSON.stringify({ v: 1, projects: [], defaultName: 'Personal' }))
    const registered = new Map<string, string>()
    await migrateBrowserProjects({ registerProject: async (id, name) => {
      registered.set(id, name)
      return { id, name, created: '2026-11-18T12:34:56Z', revision: 1, deleted: false }
    } }, store)
    expect(registered.get(DEFAULT_PROJECT_ID)).toBe('Personal')
    expect(store.getItem(PROJECTS_KEY)).toBeNull()
  })
})

describe('browser project registration', () => {
  it('resumes partial registration without overwriting library names or removing per-device state', async () => {
    const original = JSON.stringify({ v: 1, projects: [
      { id: 'p-film', name: 'Browser film', createdAt: 17 },
      { id: 'p-photo', name: 'Photo', createdAt: 29 },
    ] })
    const store = storage(original)
    store.setItem('dinkster.p.p-film.openTabs', 'local draft')
    const registered = new Map([['p-film', { id: 'p-film', name: 'Library film', created: '2026-11-18T12:34:56Z', revision: 7, deleted: false }]])
    let unavailable = true
    const connection = { registerProject: async (id: string, name: string) => {
      if (id === 'p-photo' && unavailable) throw new Error('offline')
      const project = registered.get(id) ?? { id, name, created: '2026-11-18T12:34:56Z', revision: 1, deleted: false }
      registered.set(id, project)
      return project
    } }
    await expect(migrateBrowserProjects(connection, store)).rejects.toThrow('offline')
    expect(store.getItem(PROJECTS_KEY)).toBe(original)
    expect(registered.has('p-photo')).toBe(false)
    unavailable = false
    await migrateBrowserProjects(connection, store)
    expect(store.getItem(PROJECTS_KEY)).toBeNull()
    expect(registered.get('p-film')?.name).toBe('Library film')
    expect(registered.get('p-photo')?.name).toBe('Photo')
    expect(store.getItem('dinkster.p.p-film.openTabs')).toBe('local draft')
  })

  it.each(['abort', 'concurrent edit', 'unreadable project', 'retired connection'])('keeps the original browser records on %s', async (reason) => {
    const original = JSON.stringify({ v: 1, projects: reason === 'unreadable project' ? [{ id: 'INVALID' }] : [] })
    const store = storage(original)
    const controller = new AbortController()
    let current = true
    const connection = { registerProject: async (id: string, name: string) => {
      if (reason === 'retired connection') current = false
      if (reason === 'abort') controller.abort()
      if (reason === 'concurrent edit') store.setItem(PROJECTS_KEY, 'new browser data')
      return { id, name, created: '2026-11-18T12:34:56Z', revision: 1, deleted: false }
    } }
    await expect(migrateBrowserProjects(connection, store, controller.signal, () => current)).rejects.toThrow()
    expect(store.getItem(PROJECTS_KEY)).toBe(reason === 'concurrent edit' ? 'new browser data' : original)
  })
})

describe('project scope', () => {

  it('reads and validates the project id from a window URL', () => {
    expect(projectIdFromSearch('?dinksterProject=p-alpha')).toBe('p-alpha')
    expect(projectIdFromSearch('?dinksterProject=NOT%20VALID')).toBe(DEFAULT_PROJECT_ID)
    expect(projectIdFromSearch('')).toBe(DEFAULT_PROJECT_ID)
  })

  it('namespaces storage keys and shared names per project without prefix collisions', () => {
    initializeProjectScope('p-alpha')
    expect(scopedStorageKey('dinkster.openTabs')).toBe('dinkster.p.p-alpha.openTabs')
    expect(scopedStorageKey('other.key')).toBe('dinkster.p.p-alpha.other.key')
    expect(scopedSharedName('dinkster-workspace-tabs')).toBe('dinkster-workspace-tabs--p-p-alpha')
    // A default-scope prefix scan must not match another project's keys.
    expect(scopedStorageKey('dinkster.openTabsCandidate.').startsWith('dinkster.openTabsCandidate.')).toBe(false)
  })
})
