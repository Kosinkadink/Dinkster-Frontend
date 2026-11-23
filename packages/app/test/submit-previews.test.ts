/**
 * The execution.previews setting rides every native submit as the job's
 * previews policy: the user's spend choice is explicit on the wire, never
 * implied by a server default the client cannot see.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, type Backend, type Tab } from '../src/app-state.js'
import { asPromptId, diag, type DinksterNodesPayload } from '@dinkster/core'
import { createWorkflowApp } from './fixtures/workflow-app.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes.json'), 'utf8'),
) as DinksterNodesPayload

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

let app: AppState

beforeEach(() => {
  app = createWorkflowApp(null)
})

afterEach(() => {
  app.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Compilable chain document for backend-coupled async tests. */
const CHAIN_DOC = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-previews-test',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {
        n0: { id: 'n0', type: 'std.math.add_ints', values: { a: 3, b: 4 } },
        n1: { id: 'n1', type: 'std.math.add_ints', values: { b: 10 } },
      },
      links: {
        l2: { id: 'l2', from: { node: 'n0', port: 'sum' }, to: { node: 'n1', port: 'a' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 3,
    },
  },
  view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } }, n1: { position: { x: 200, y: 0 } } } } } },
}

/** A native backend with live schemas, plus the CHAIN_DOC tab targeted at it. */
async function nativeSetup(): Promise<{ backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab }> {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect((await app.openDocument(CHAIN_DOC, 'Chain'))).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('live preview policy on submit', () => {
  it('sends the execution.previews setting as the previews mode', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [diag('error', 'validation', 'submit.expected', 'stop after POST')],
    })

    // Live previews default to off; enabling the setting changes the wire mode.
    await app.queue(tab)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![1]).toMatchObject({ previews: { mode: 'off' } })

    app.settings.set('execution.previews', 'cheap')
    await app.queue(tab)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1]![1]).toMatchObject({ previews: { mode: 'cheap' } })
  })

  it('a workflow document override replaces the global setting', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [diag('error', 'validation', 'submit.expected', 'stop after POST')],
    })
    expect((await app.dispatchTo(tab, { command: 'workflow.setPreviews', params: { previews: 'quality' } })).ok).toBe(true)

    await app.queue(tab)
    expect(submit).toHaveBeenCalledTimes(1)
    const previews = (submit.mock.calls[0]![1] as { previews?: unknown }).previews
    expect(previews).toEqual({ mode: 'quality' })
  })

  it('per-node overrides ride the nodes map keyed by runtime id', async () => {
    const { backend, tab } = (await nativeSetup())
    app.settings.set('execution.previews', 'cheap')
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [diag('error', 'validation', 'submit.expected', 'stop after POST')],
    })
    expect((await app.dispatchTo(tab, {
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n1'], previews: 'off' },
    })).ok).toBe(true)
    // Equal to the base mode: must be omitted from the wire.
    expect((await app.dispatchTo(tab, {
      command: 'node.setPreviews',
      params: { graphId: 'g0', nodeIds: ['n0'], previews: 'cheap' },
    })).ok).toBe(true)

    await app.queue(tab)
    expect(submit).toHaveBeenCalledTimes(1)
    const previews = (submit.mock.calls[0]![1] as { previews?: unknown }).previews
    expect(previews).toEqual({ mode: 'cheap', nodes: { n1: 'off' } })
  })
})
