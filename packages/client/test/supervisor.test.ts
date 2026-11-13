/**
 * Supervisor status client tests: probe trichotomy (status/absent/
 * unreachable), strict-enough status parsing, restart outcomes, and the
 * 503 engine-not-ready gate surfacing as EngineNotReadyError from
 * DinksterConnection.fetchSchemas.
 */
import { describe, expect, it } from 'vitest'
import { asConnectionId } from '@dinkster/core'
import { DinksterConnection, EngineNotReadyError, probeSupervisorStatus, restartSupervisorEngine, type FetchLike } from '../src/index.js'

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
        error: `GET /supervisor/status failed: ${status}`,
      })
    }
  })

  it('reports unreachable on a network failure', async () => {
    const probe = await probeSupervisorStatus('http://test', async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(probe).toEqual({ kind: 'unreachable', error: 'ECONNREFUSED' })
  })
})

describe('restartSupervisorEngine', () => {

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
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})

describe('fetchSchemas behind a pre-ready supervisor', () => {
  it('throws EngineNotReadyError on the 503 engine-not-ready gate', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse(503, { error: 'engine-not-ready', state: 'starting', status: '/supervisor/status' })
    const conn = new DinksterConnection({
      id: asConnectionId('c0'),
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn,
    })
    const error = await conn.fetchSchemas().catch((e: unknown) => e)
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
