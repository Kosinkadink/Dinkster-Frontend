import { afterEach, describe, expect, it } from 'vitest'
import {
  activeProjectId, createProject, DEFAULT_PROJECT_ID, initializeProjectScope, listProjects,
  projectIdFromSearch, PROJECTS_KEY, renameProject, scopedSharedName, scopedStorageKey, validProjectId,
} from '../src/projects.js'

function storage(seed?: string): Storage {
  const data = new Map<string, string>(seed ? [[PROJECTS_KEY, seed]] : [])
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) } as Storage
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

  it('drops malformed and reserved entries from a persisted envelope', () => {
    const store = storage(JSON.stringify({ v: 1, projects: [
      { id: 'p-good', name: 'Good', createdAt: 5 },
      { id: 'default', name: 'Impostor', createdAt: 1 },
      { id: 'BAD ID', name: 'Bad', createdAt: 2 },
      { id: 'p-noname', name: '', createdAt: 3 },
      { id: 'p-notime', name: 'No time', createdAt: 'soon' },
    ] }))
    expect(listProjects(store).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'p-good'])
  })
})

describe('project scope', () => {
  it('falls back to the default project for unknown or malformed ids', () => {
    expect(initializeProjectScope('Invalid Id!')).toBe(DEFAULT_PROJECT_ID)
    expect(initializeProjectScope(null)).toBe(DEFAULT_PROJECT_ID)
    expect(initializeProjectScope('p-alpha')).toBe('p-alpha')
    expect(activeProjectId()).toBe('p-alpha')
  })

  it('reads and validates the project id from a window URL', () => {
    expect(projectIdFromSearch('?dinksterProject=p-alpha')).toBe('p-alpha')
    expect(projectIdFromSearch('?dinksterProject=NOT%20VALID')).toBe(DEFAULT_PROJECT_ID)
    expect(projectIdFromSearch('')).toBe(DEFAULT_PROJECT_ID)
  })

  it('keeps legacy unprefixed names for the default project', () => {
    initializeProjectScope(DEFAULT_PROJECT_ID)
    expect(scopedStorageKey('dinkster.openTabs')).toBe('dinkster.openTabs')
    expect(scopedSharedName('dinkster-workspace-tabs')).toBe('dinkster-workspace-tabs')
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
