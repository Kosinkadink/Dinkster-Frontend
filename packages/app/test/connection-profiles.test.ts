import { afterEach, describe, expect, it } from 'vitest'
import {
  CONNECTION_PROFILES_KEY,
  createConnectionProfile,
  formatWorkflowDeepLink,
  listConnectionProfiles,
  removeConnectionProfile,
  resolveDeepLinkBackend,
  validConnectionProfileId,
  withConnectionProfilesLock,
} from '../src/connection-profiles.js'
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
  it('omits the default project and the same-origin default backend', () => {
    expect(formatWorkflowDeepLink({ projectId: 'default', workflowId: 'wf-1' }))
      .toBe('dinkster://open/workflow?workflow=wf-1')
    expect(formatWorkflowDeepLink({ projectId: 'default', workflowId: 'wf-1', backendUrl: '' }))
      .toBe('dinkster://open/workflow?workflow=wf-1')
  })

  it('carries project and backend as encoded parameters', () => {
    expect(formatWorkflowDeepLink({ projectId: 'p-alpha', workflowId: 'wf 1', backendUrl: 'https://host:8443' }))
      .toBe('dinkster://open/workflow?workflow=wf+1&project=p-alpha&backend=https%3A%2F%2Fhost%3A8443')
  })
})

describe('withConnectionProfilesLock', () => {
  type FakeLocks = { request: (name: string, task: () => Promise<unknown>) => Promise<unknown> }
  const installLocks = (locks: FakeLocks): void => {
    Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: locks })
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, 'locks')
  })

  it('serializes tasks through the project-scoped Web Lock when available', async () => {
    const names: string[] = []
    let chain: Promise<unknown> = Promise.resolve()
    installLocks({
      request: (name, task) => {
        names.push(name)
        const run = chain.then(() => task())
        chain = run.then(() => undefined, () => undefined)
        return run
      },
    })
    const events: string[] = []
    let releaseFirst!: () => void
    const first = withConnectionProfilesLock(async () => {
      events.push('first-start')
      await new Promise<void>((resolve) => { releaseFirst = resolve })
      events.push('first-end')
    })
    const second = withConnectionProfilesLock(async () => { events.push('second') })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
    expect(names).toEqual(['dinkster.connectionProfiles.mutation', 'dinkster.connectionProfiles.mutation'])
  })

  it('runs the task directly when Web Locks are unavailable', async () => {
    await expect(withConnectionProfilesLock(async () => 'ran')).resolves.toBe('ran')
  })

  it('propagates task rejections', async () => {
    installLocks({ request: (_name, task) => task() })
    await expect(withConnectionProfilesLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
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
