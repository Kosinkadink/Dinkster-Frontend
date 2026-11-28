/**
 * Supervisor status client tests: probe trichotomy (status/absent/
 * unreachable), strict-enough status parsing, restart outcomes, and the
 * 503 engine-not-ready gate surfacing as EngineNotReadyError from
 * DinksterConnection.fetchSchemas.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId } from '@dinkster/core'
import { DinksterConnection, EngineNotReadyError, fetchSupervisorEngineLog, noEngineOpen, parseSupervisorStatus, probeSupervisorStatus, restartSupervisorEngine, type FetchLike } from '../src/index.js'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('probeSupervisorStatus', () => {

  it('reports absent on 404 (standalone dinkster-serve)', async () => {
    const probe = await probeSupervisorStatus('http://test', async () =>
      jsonResponse(404, { error: 'not found' }),
    )
    expect(probe).toEqual({ kind: 'absent' })
  })

  it('FR-1 a transient server failure is unreachable, never absent (the poll must not stop)', async () => {
    for (const status of [500, 503, 401]) {
      const probe = await probeSupervisorStatus('http://test', async () =>
        jsonResponse(status, { error: 'broken' }),
      )
      expect(probe).toEqual({
        kind: 'unreachable',
        error: status === 401 ? 'You do not have access.' : 'The engine reported an error.',
      })
    }
  })

  it('reports unreachable on a network failure', async () => {
    const probe = await probeSupervisorStatus('http://test', async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(probe).toEqual({ kind: 'unreachable', error: 'The engine did not answer.' })
  })
})

describe('parseSupervisorStatus from the always-on process', () => {
  it('keeps role, installations and the open engine', () => {
    const status = parseSupervisorStatus({
      protocol: 1, state: 'starting', role: 'home', installations: 2, open: { root: '/r', engine: 'default' },
    })
    expect(status).toEqual({ protocol: 1, state: 'starting', role: 'home', installations: 2, open: { root: '/r', engine: 'default' } })
    expect(noEngineOpen(status)).toBe(false)
  })

  it('reads no open engine only from the home role', () => {
    const home = parseSupervisorStatus({ protocol: 1, state: 'stopped', role: 'home', installations: 0, open: null })
    expect(home).toEqual({ protocol: 1, state: 'stopped', role: 'home', installations: 0 })
    expect(noEngineOpen(home)).toBe(true)
    expect(noEngineOpen(parseSupervisorStatus({ protocol: 1, state: 'stopped' }))).toBe(false)
  })
})

describe('restartSupervisorEngine', () => {

  it('shows the message a refusal gives in place of its code', async () => {
    const result = await restartSupervisorEngine('http://test', async () =>
      jsonResponse(409, { error: 'restart-unavailable', message: 'More than one installation exists and none is the default.' }),
    )
    expect(result).toEqual({ ok: false, error: 'More than one installation exists and none is the default.' })
  })

  it('maps the 409 restart-unavailable body to ok: false', async () => {
    const result = await restartSupervisorEngine('http://test', async () =>
      jsonResponse(409, { error: 'restart-unavailable' }),
    )
    expect(result).toEqual({ ok: false, error: 'restart-unavailable' })
  })

  it('maps transport failure to ok: false', async () => {
    const result = await restartSupervisorEngine('http://test', async () => {
      throw new Error('boom')
    })
    expect(result).toEqual({ ok: false, error: 'The engine did not answer.' })
  })
})

describe('fetchSupervisorEngineLog', () => {
  it('keeps the real tail and distinguishes a missing log from an empty log', async () => {
    for (const log of [
      { available: true, text: 'last engine failure\n', truncated: true },
      { available: true, text: '', truncated: false },
      { available: false, text: '', truncated: false },
    ]) {
      const result = await fetchSupervisorEngineLog('http://test', async (url, init) => {
        expect(url).toBe('http://test/supervisor/engine/log')
        expect(init?.method ?? 'GET').toBe('GET')
        return jsonResponse(200, log)
      })
      expect(result).toEqual({ ok: true, ...log })
    }
  })

  it('does not show refusal bodies or other response shapes as an engine log', async () => {
    for (const status of [403, 404, 409, 500]) {
      expect(await fetchSupervisorEngineLog('http://test', async () =>
        jsonResponse(status, { text: 'not the engine log' }),
      )).toEqual({ ok: false, error: status === 403 ? 'You do not have access.' : status === 500 ? 'The engine reported an error.' : 'The engine log could not be loaded.' })
    }
    for (const body of [null, {}, { available: true, text: 5, truncated: false }, { available: 'yes', text: '', truncated: false }, { available: true, text: '' }]) {
      expect(await fetchSupervisorEngineLog('http://test', async () => jsonResponse(200, body)))
        .toEqual({ ok: false, error: 'Invalid engine log response' })
    }
    expect(await fetchSupervisorEngineLog('http://test', async () => {
      throw new Error('connection refused')
    })).toEqual({ ok: false, error: 'The engine did not answer.' })
  })
})

describe('project startup behind a pre-ready supervisor', () => {
  it.each(['schemas', 'registration'])('%s throws EngineNotReadyError on the 503 engine-not-ready gate', async (operation) => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(503, { error: 'engine-not-ready', state: 'starting', status: '/supervisor/status' })
    const conn = new DinksterConnection({
      id: asConnectionId('c0'),
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn,
    })
    const request = operation === 'schemas' ? conn.fetchSchemas() : conn.registerProject('p-film', 'Film')
    const error = await request.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EngineNotReadyError)
    expect((error as EngineNotReadyError).state).toBe('starting')
  })

  it('keeps a plain 503 (no gate body) as a generic fetch error', async () => {
    const conn = new DinksterConnection({
      id: asConnectionId('c0'),
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn: async () => new Response('overloaded', { status: 503 }),
    })
    const error = await conn.fetchSchemas().catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(EngineNotReadyError)
    expect(String(error)).toContain('503')
  })
})
