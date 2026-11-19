import { afterEach, describe, expect, it } from 'vitest'
import { createProject, DEFAULT_PROJECT_ID, initializeProjectScope, listProjects, migrateBrowserProjects, projectIdFromSearch, PROJECTS_KEY, renameProject, scopedSharedName, scopedStorageKey, validProjectId } from '../src/projects.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[PROJECTS_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) } as Storage
}

afterEach(() => initializeProjectScope(undefined))

describe('project registry', () => {
  it('synthesizes the default project even when storage is corrupt or empty', () => {
    expect(listProjects(storage()).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(listProjects(storage('{broken')).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(listProjects(storage(JSON.stringify({ v: 99, projects: [] }))).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(listProjects(undefined).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
  })

  it('creates, lists in creation order, and renames projects', () => {
    const store = storage()
    const first = createProject('  Research  ', store)
    const second = createProject('', store)
    expect(validProjectId(first.id)).toBe(true)
    expect(first.name).toBe('Research')
    expect(second.name).toBe('Untitled project')
    expect(listProjects(store).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, first.id, second.id])
    renameProject(first.id, 'Production', store)
    renameProject(first.id, '   ', store)
    expect(listProjects(store).find((p) => p.id === first.id)?.name).toBe('Production')
  })

  it('renames the synthesized default project through the envelope override', () => {
    const store = storage()
    renameProject(DEFAULT_PROJECT_ID, 'Personal', store)
    expect(listProjects(store)[0]).toEqual({ id: DEFAULT_PROJECT_ID, name: 'Personal', createdAt: 0 })
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

  it.each(['abort', 'concurrent edit', 'unreadable project'])('keeps the original browser records on %s', async (reason) => {
    const original = JSON.stringify({ v: 1, projects: reason === 'unreadable project' ? [{ id: 'INVALID' }] : [] })
    const store = storage(original)
    const controller = new AbortController()
    const connection = { registerProject: async (id: string, name: string) => {
      if (reason === 'abort') controller.abort()
      if (reason === 'concurrent edit') store.setItem(PROJECTS_KEY, 'new browser data')
      return { id, name, created: '2026-11-18T12:34:56Z', revision: 1, deleted: false }
    } }
    await expect(migrateBrowserProjects(connection, store, controller.signal)).rejects.toThrow()
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
