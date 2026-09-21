/**
 * URL-only backend add + native-first default: addBackendByUrl adds with
 * the DISCOVERED protocol (no manual choice), refuses unreachable/
 * unrecognized URLs with named problems instead of dead
 * rows, and the constructor's defaultProtocol option makes the same-origin
 * default native when main's discovery says so.
 */
import { describe, expect, it } from 'vitest'
import type { BackendDiscovery } from '@dinkster/client'
import { AppState } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const discovered =
  (result: BackendDiscovery) =>
  (_url: string): Promise<BackendDiscovery> =>
    Promise.resolve(result)

describe('addBackendByUrl', () => {
  it('adds a native backend when discovery says dinkster', async () => {
    const app = new AppState()
    const added = await app.addBackendByUrl('http://engine:3639/', {
      discover: discovered({ kind: 'dinkster', supervised: false }),
      start: false,
    })
    expect(added).toMatchObject({ baseUrl: 'http://engine:3639', protocol: 'dinkster' })
    expect(app.backends.get()).toHaveLength(2)
  })

  it('adds a legacy bridge when discovery says v1', async () => {
    const app = new AppState()
    const added = await app.addBackendByUrl('http://legacy:8188', {
      discover: discovered({ kind: 'v1' }),
      start: false,
    })
    expect(added).toMatchObject({ protocol: 'v1' })
  })

  it('refuses unreachable and unrecognized URLs with their detail', async () => {
    const app = new AppState()
    expect(
      await app.addBackendByUrl('http://down:1', {
        discover: discovered({ kind: 'unreachable', detail: 'ECONNREFUSED' }),
        start: false,
      }),
    ).toBeUndefined()
    expect(
      await app.addBackendByUrl('/spa', {
        discover: discovered({ kind: 'unrecognized', detail: 'server answered with HTML' }),
        start: false,
      }),
    ).toBeUndefined()
    const codes = app.problems.get().map((p) => p.code)
    expect(codes).toContain('backend.unreachable')
    expect(codes).toContain('backend.unrecognized')
    expect(app.backends.get()).toHaveLength(1)
  })

  it('a discovery rejection becomes a named problem, never an unhandled throw', async () => {
    const app = new AppState()
    expect(
      await app.addBackendByUrl('http://weird:1', {
        discover: () => Promise.reject(new Error('probe exploded')),
        start: false,
      }),
    ).toBeUndefined()
    const problem = app.problems.get().find((p) => p.code === 'backend.discovery-failed')
    expect(problem?.message).toContain('probe exploded')
    expect(app.backends.get()).toHaveLength(1)
  })

  it('still rejects duplicates through the underlying add', async () => {
    const app = new AppState()
    const opts = { discover: discovered({ kind: 'dinkster', supervised: false } as const), start: false }
    await app.addBackendByUrl('http://engine:3639', opts)
    expect(await app.addBackendByUrl('http://engine:3639', opts)).toBeUndefined()
    expect(app.problems.get().some((p) => p.code === 'backend.duplicate')).toBe(true)
  })
})

describe('defaultProtocol option', () => {
  it('defaults the same-origin backend to v1 when unset (compatibility)', () => {
    const app = new AppState()
    expect(app.backends.get()[0]!.protocol).toBe('v1')
  })

  it('makes the same-origin default native when discovery said dinkster', () => {
    const app = new AppState({ defaultProtocol: 'dinkster' })
    const local = app.backends.get()[0]!
    expect(local.protocol).toBe('dinkster')
    expect(local.id).toBe('local')
    expect(app.connection).toBe(local.connection)
  })
})
