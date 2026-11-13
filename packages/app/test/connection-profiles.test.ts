import { afterEach, describe, expect, it } from 'vitest'
import { CONNECTION_PROFILES_KEY, createConnectionProfile, formatWorkflowDeepLink, listConnectionProfiles, removeConnectionProfile, resolveDeepLinkBackend, validConnectionProfileId } from '../src/connection-profiles.js'
import { initializeProjectScope } from '../src/projects.js'

afterEach(() => initializeProjectScope(undefined))

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

describe('connection profiles', () => {
  it('creates, lists, and removes profiles', () => {
    const storage = fakeStorage()
    const profile = createConnectionProfile('Studio', 'https://host:8443/', storage)!
    expect(validConnectionProfileId(profile.id)).toBe(true)
    expect(profile.name).toBe('Studio')
    expect(profile.url).toBe('https://host:8443') // canonicalized, no trailing slash
    expect(listConnectionProfiles(storage)).toEqual([profile])
    removeConnectionProfile(profile.id, storage)
    expect(listConnectionProfiles(storage)).toEqual([])
  })

  it('falls back to the address as the display name', () => {
    const storage = fakeStorage()
    expect(createConnectionProfile('   ', 'https://host', storage)!.name).toBe('https://host')
  })

  it('saves nothing for an invalid address', () => {
    const storage = fakeStorage()
    expect(createConnectionProfile('x', 'not a url', storage)).toBeUndefined()
    expect(createConnectionProfile('x', 'ftp://host', storage)).toBeUndefined()
    expect(createConnectionProfile('x', 'https://user:pass@host', storage)).toBeUndefined()
    expect(listConnectionProfiles(storage)).toEqual([])
  })

  it('reports failure and saves nothing when storage writes fail', () => {
    const ok = fakeStorage()
    const failing: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: (key) => ok.getItem(key),
      setItem: () => { throw new Error('quota exceeded') },
    }
    expect(createConnectionProfile('x', 'https://host', failing)).toBeUndefined()
    expect(listConnectionProfiles(ok)).toEqual([])
    expect(createConnectionProfile('x', 'https://host', undefined)).toBeUndefined()
    const profile = createConnectionProfile('x', 'https://host', ok)!
    expect(removeConnectionProfile(profile.id, failing)).toBe(false)
    expect(listConnectionProfiles(ok)).toEqual([profile])
    expect(removeConnectionProfile(profile.id, ok)).toBe(true)
    expect(listConnectionProfiles(ok)).toEqual([])
  })

  it('treats corrupt storage as an empty list', () => {
    const storage = fakeStorage()
    storage.data.set(CONNECTION_PROFILES_KEY, '{broken')
    expect(listConnectionProfiles(storage)).toEqual([])
    storage.data.set(CONNECTION_PROFILES_KEY, JSON.stringify({ v: 1, profiles: [{ id: 'bogus' }] }))
    expect(listConnectionProfiles(storage)).toEqual([])
  })

  it('scopes the list to the active project', () => {
    const storage = fakeStorage()
    const defaultProfile = createConnectionProfile('Default scope', 'https://host', storage)!
    initializeProjectScope('p-alpha')
    expect(listConnectionProfiles(storage)).toEqual([])
    const scoped = createConnectionProfile('Alpha scope', 'https://other', storage)!
    expect(listConnectionProfiles(storage)).toEqual([scoped])
    expect(storage.data.has(`dinkster.p.p-alpha.${CONNECTION_PROFILES_KEY.slice('dinkster.'.length)}`)).toBe(true)
    initializeProjectScope(undefined)
    expect(listConnectionProfiles(storage)).toEqual([defaultProfile])
  })
})

describe('formatWorkflowDeepLink', () => {

  it('carries project and backend as encoded parameters', () => {
    expect(formatWorkflowDeepLink({ projectId: 'p-alpha', workflowId: 'wf 1', backendUrl: 'https://host:8443' }))
      .toBe('dinkster://open/workflow?workflow=wf+1&project=p-alpha&backend=https%3A%2F%2Fhost%3A8443')
  })
})

describe('resolveDeepLinkBackend', () => {
  const backends = [
    { id: 'b-1', baseUrl: 'https://host:8443' },
    { id: 'b-2', baseUrl: 'http://other:8188/' },
  ]

  it('matches a connected backend by canonical url', () => {
    expect(resolveDeepLinkBackend(backends, 'https://host:8443/')).toBe('b-1')
    expect(resolveDeepLinkBackend(backends, 'http://other:8188')).toBe('b-2')
  })

  it('never resolves a server the user has not connected', () => {
    expect(resolveDeepLinkBackend(backends, 'https://unknown')).toBeUndefined()
    expect(resolveDeepLinkBackend([], 'https://host:8443')).toBeUndefined()
  })
})
