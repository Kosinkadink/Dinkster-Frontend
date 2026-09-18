/**
 * Backend persistence tests: user-added backends (URL, label, discovered
 * protocol) survive a reload via the dinkster.backends envelope; the
 * same-origin default is never stored; removal persists; corrupt storage
 * degrades to "no extra backends".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AppState,
  BACKENDS_KEY,
  rebaseBackendLists,
  type PersistedBackend,
} from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const KEY = BACKENDS_KEY

let storageListener: ((event: StorageEvent) => void) | undefined

/** Minimal in-memory localStorage for the node test env. */
const makeStorage = (): Storage => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const stored = (): { v: number; backends: { baseUrl: string; label: string; protocol: string }[] } =>
  JSON.parse(globalThis.localStorage.getItem(KEY) ?? '{"v":1,"backends":[]}') as never

beforeEach(() => {
  ;(globalThis as { localStorage: Storage }).localStorage = makeStorage()
  storageListener = undefined
  ;(globalThis as unknown as { addEventListener: typeof globalThis.addEventListener }).addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== 'storage') return
      storageListener = (event) => {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    },
  ) as typeof globalThis.addEventListener
})

afterEach(() => {
  delete (globalThis as unknown as { addEventListener?: typeof globalThis.addEventListener }).addEventListener
  vi.restoreAllMocks()
})

const envelope = (backends: readonly PersistedBackend[]): string => JSON.stringify({ v: 1, backends })

const storageChange = (
  oldBackends: readonly PersistedBackend[],
  newBackends: readonly PersistedBackend[],
): void => {
  storageListener?.({
    key: KEY,
    oldValue: envelope(oldBackends),
    newValue: envelope(newBackends),
  } as StorageEvent)
}

describe('backend-list rebase', () => {
  const a = { baseUrl: 'http://a:1', label: 'A', protocol: 'v1' } as const
  const b = { baseUrl: 'http://b:2', label: 'B', protocol: 'dinkster' } as const
  const c = { baseUrl: 'http://c:3', label: 'C', protocol: 'v1' } as const

  it('derives adds, removes, and keeps by canonical backend identity', () => {
    expect(rebaseBackendLists([a, b], [b, c])).toEqual({
      adds: [c],
      removes: [a],
      keeps: [b],
    })
  })

  it('keeps the current identity record when incoming metadata differs', () => {
    const renamed = { ...a, label: 'Renamed', protocol: 'dinkster' } as const
    expect(rebaseBackendLists([a], [renamed])).toEqual({ adds: [], removes: [], keeps: [a] })
  })
})

describe('backend persistence', () => {
  it('persists an added backend with its protocol; the default is never stored', () => {
    const app = new AppState()
    app.addBackend('http://engine:3639', 'Engine', false, 'dinkster')
    expect(stored().backends).toEqual([
      { baseUrl: 'http://engine:3639', label: 'Engine', protocol: 'dinkster' },
    ])
    app.addBackend('http://legacy:8188', undefined, false, 'v1')
    expect(stored().backends).toEqual([
      { baseUrl: 'http://engine:3639', label: 'Engine', protocol: 'dinkster' },
      { baseUrl: 'http://legacy:8188', label: 'http://legacy:8188', protocol: 'v1' },
    ])
  })

  it('persists removal', () => {
    const app = new AppState()
    const engine = app.addBackend('http://engine:3639', 'Engine', false, 'dinkster')!
    app.addBackend('http://legacy:8188', 'Legacy', false)
    app.removeBackend(engine.id)
    expect(stored().backends).toEqual([
      { baseUrl: 'http://legacy:8188', label: 'Legacy', protocol: 'v1' },
    ])
  })

  it('rebases local writes over unseen external edits already in storage', () => {
    const app = new AppState()
    const external = { baseUrl: 'http://external:8188', label: 'External', protocol: 'v1' } as const
    globalThis.localStorage.setItem(KEY, envelope([external]))

    const local = app.addBackend('http://local:3639', 'Local', false, 'dinkster')!
    expect(stored().backends).toEqual([
      external,
      { baseUrl: local.baseUrl, label: local.label, protocol: local.protocol },
    ])

    // A local removal also preserves the unrelated external identity.
    app.removeBackend(local.id)
    expect(stored().backends).toEqual([external])
  })

  it('restores persisted backends on construction, protocol intact, not started', () => {
    const first = new AppState()
    first.addBackend('http://engine:3639', 'Engine', false, 'dinkster')
    first.addBackend('http://legacy:8188', 'Legacy', false)

    const second = new AppState()
    const backends = second.backends.get()
    expect(backends).toHaveLength(3)
    expect(backends[0]!.id).toBe('local') // default first, re-derived
    expect(backends[1]).toMatchObject({
      baseUrl: 'http://engine:3639',
      label: 'Engine',
      protocol: 'dinkster',
    })
    expect(backends[2]).toMatchObject({
      baseUrl: 'http://legacy:8188',
      label: 'Legacy',
      protocol: 'v1',
    })
    expect(backends[1]!.connection.status.get()).toBe('disconnected')
  })

  it('ignores corrupt or wrong-version storage', () => {
    globalThis.localStorage.setItem(KEY, 'not json')
    expect(new AppState().backends.get()).toHaveLength(1)
    globalThis.localStorage.setItem(KEY, JSON.stringify({ v: 2, backends: [{ baseUrl: 'x' }] }))
    expect(new AppState().backends.get()).toHaveLength(1)
  })

  it('drops malformed entries and empty baseUrls (never a shadow default)', () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        backends: [
          { baseUrl: '', label: 'shadow', protocol: 'v1' },
          { baseUrl: 'http://ok:3639', label: 'OK', protocol: 'dinkster' },
          { baseUrl: 'http://bad:1', label: 'bad', protocol: 'other' },
          'garbage',
        ],
      }),
    )
    const app = new AppState()
    expect(app.backends.get()).toHaveLength(2)
    expect(app.backends.get()[1]).toMatchObject({ baseUrl: 'http://ok:3639', protocol: 'dinkster' })
  })

  it('an absolute URL aliasing this origin collides with the default and is never persisted', () => {
    ;(globalThis.location as { origin?: string }).origin = 'http://test'
    try {
      const app = new AppState()
      // Root aliases in any spelling collide with the same-origin default.
      for (const alias of ['http://test', 'http://test/', 'HTTP://test']) {
        expect(app.addBackend(alias, undefined, false, 'dinkster')).toBeUndefined()
      }
      expect(app.backends.get()).toHaveLength(1)
      expect(stored().backends).toEqual([])
      // A PATH on this origin is a genuinely different backend and stays.
      expect(app.addBackend('http://test/b2', undefined, false)).toBeDefined()
      expect(stored().backends).toEqual([
        { baseUrl: 'http://test/b2', label: 'http://test/b2', protocol: 'v1' },
      ])
    } finally {
      delete (globalThis.location as { origin?: string }).origin
    }
  })

  it('silently skips a stale stored record aliasing the same-origin default', () => {
    ;(globalThis.location as { origin?: string }).origin = 'http://test'
    try {
      globalThis.localStorage.setItem(
        KEY,
        JSON.stringify({
          v: 1,
          backends: [
            { baseUrl: 'http://test', label: 'stale alias', protocol: 'dinkster' },
            { baseUrl: 'http://engine:3639', label: 'Engine', protocol: 'dinkster' },
          ],
        }),
      )
      const app = new AppState()
      expect(app.backends.get()).toHaveLength(2) // default + Engine, no alias
      expect(app.backends.get()[1]).toMatchObject({ baseUrl: 'http://engine:3639' })
      expect(app.problems.get()).toEqual([]) // skipped, not a startup problem
    } finally {
      delete (globalThis.location as { origin?: string }).origin
    }
  })

  it('round-trips through remove: a restored backend can be removed and stays removed', () => {
    const first = new AppState()
    const added = first.addBackend('http://engine:3639', 'Engine', false, 'dinkster')!
    first.removeBackend(added.id)
    const second = new AppState()
    expect(second.backends.get()).toHaveLength(1)
  })

  it('applies an external add through the normal connection lifecycle', () => {
    const app = new AppState()
    const start = vi
      .spyOn(app as unknown as { startBackend(backend: unknown): Promise<void> }, 'startBackend')
      .mockResolvedValue()
    const remote = { baseUrl: 'http://remote:3639', label: 'Remote', protocol: 'dinkster' } as const

    storageChange([], [remote])
    storageChange([], [remote]) // duplicate delivery is idempotent

    expect(app.backends.get()[1]).toMatchObject(remote)
    expect(app.backends.get()).toHaveLength(2)
    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(app.backends.get()[1])
    expect(app.problems.get()).toEqual([])
  })

  it('applies an external removal through disposal without a persist echo', () => {
    const app = new AppState()
    const remote = app.addBackend('http://remote:3639', 'Remote', false, 'dinkster')!
    const disconnect = vi.spyOn(remote.connection, 'disconnect')
    const dispose = vi.spyOn(remote, 'dispose')
    const persist = vi.spyOn(globalThis.localStorage, 'setItem')
    persist.mockClear()

    storageChange([{ baseUrl: remote.baseUrl, label: remote.label, protocol: remote.protocol }], [])

    expect(app.backends.get()).toHaveLength(1)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(persist).not.toHaveBeenCalled()
  })

  it('ignores a corrupt or mismatched external payload', () => {
    const app = new AppState()
    storageListener?.({ key: KEY, oldValue: envelope([]), newValue: 'not json' } as StorageEvent)
    storageListener?.({ key: KEY, oldValue: envelope([]), newValue: JSON.stringify({ v: 2, backends: [] }) } as StorageEvent)
    expect(app.backends.get()).toHaveLength(1)
  })

  it('rebases an external add over a simultaneous local add without losing either', () => {
    const app = new AppState()
    vi.spyOn(app as unknown as { startBackend(backend: unknown): Promise<void> }, 'startBackend').mockResolvedValue()
    const local = app.addBackend('http://local-edit:8188', 'Local edit', false)!
    const remote = { baseUrl: 'http://remote-edit:3639', label: 'Remote edit', protocol: 'dinkster' } as const
    const persist = vi.spyOn(globalThis.localStorage, 'setItem')
    persist.mockClear()

    // The other tab's write began from [] before this tab's add landed. The
    // event delta is only the remote add, so this tab's newer local edit stays.
    storageChange([], [remote])

    expect(app.backends.get().map((backend) => backend.baseUrl)).toEqual([
      '',
      local.baseUrl,
      remote.baseUrl,
    ])
    expect(persist).not.toHaveBeenCalled()
  })
})
