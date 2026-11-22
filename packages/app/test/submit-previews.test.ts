/**
 * The execution.previews setting rides every native submit as the job's
 * previews policy: the user's spend choice is explicit on the wire, never
 * implied by a server default the client cannot see.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry, type RetainedAssets } from '@dinkster/client'
import { AppState, type Backend, type Tab } from '../src/app-state.js'
import { asPromptId, diag, type DinksterNodesPayload } from '@dinkster/core'
import { retainExecutionAssets } from '../src/workflow-asset-retention.js'
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
  vi.spyOn(added.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect((await app.openDocument(CHAIN_DOC, 'Chain'))).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('live preview policy on submit', () => {
  it.each(['direct', 'consent', 'rejected', 'disconnected', 'reconnected-before-ack'] as const)(
    'keeps cached source receipts until their own result replaces them: %s', async (route) => {
      const { backend, tab } = await nativeSetup()
      const digest = `blake3:${'a'.repeat(64)}`
      vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(digest)
      const receipts = new Map<string, RetainedAssets>()
      vi.spyOn(backend.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const receipt = { ...owner, revision: revision + 1, complete: true, digests: [] }
        receipts.set(owner.ownerId, receipt)
        return receipt
      })
      let sequence = 0
      vi.spyOn(backend.connection, 'submit').mockImplementation(async () => {
        if (route === 'rejected') return { ok: false, diagnostics: [] }
        if (route === 'reconnected-before-ack') {
          ;(backend.connection.status as unknown as { set(value: string): void })
            .set(sequence === 0 ? 'reconnecting' : 'disconnected')
        }
        const accepted = { ok: true as const,
          execution: { connection: backend.id, prompt: asPromptId(`source-${++sequence}`) } }
        return route === 'consent' ? { ok: false as const, diagnostics: [],
          assetsMissing: { error: 'assets-missing' as const,
            assets: [{ digest, name: 'Source', status: 'missing' as const, sources: [], fetchable: false }] },
          retryWithAssets: async () => accepted } : accepted
      })
      const sources = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
        .filter((key) => key.includes('workflow-retentions.'))
        .map((key) => ({ key, value: JSON.parse(localStorage.getItem(key)!) }))
        .filter(({ value }) => value.owner.ownerKind === 'document' && value.digests.includes(digest))
      for (let index = 0; index < 2; index++) {
        await app.queue(tab)
        if (route === 'consent') await app.assetConsent.get()!.retry([digest])
      }
      const captured = sources()
      expect(captured).toHaveLength(2)
      expect(captured.every(({ value }) => value.acknowledgedRevision === 1 && value.releaseRevision === undefined)).toBe(true)
      const executions = [...app.store.executions.get().values()]
      if (route === 'rejected') {
        expect(executions).toHaveLength(0)
        return
      }
      expect(executions).toHaveLength(2)
      expect(executions.map((state) => state.sourceDocument)).toEqual([digest, digest])
      if (route === 'disconnected') {
        ;(backend.connection.status as unknown as { set(value: string): void }).set('reconnecting')
      }
      const first = executions[0]!.ref
      const uncovered = await retainExecutionAssets(backend.connection, first, { complete: true, digests: [] })
      app.store.recordAssetRetentions(first, [uncovered])
      expect(sources().every(({ value }) => value.releaseRevision === undefined)).toBe(true)
      const incomplete = await retainExecutionAssets(backend.connection, first, { complete: false, digests: [digest] })
      app.store.recordAssetRetentions(first, [incomplete])
      expect(sources().every(({ value }) => value.releaseRevision === undefined)).toBe(true)
      const complete = await retainExecutionAssets(backend.connection, first, { complete: true, digests: [digest] })
      app.store.recordAssetRetentions(first, [complete])
      if (route === 'disconnected' || route === 'reconnected-before-ack') {
        expect(sources().every(({ value }) => value.releaseRevision === undefined)).toBe(true)
      } else {
        await vi.waitFor(() => {
          expect(localStorage.getItem(captured[0]!.key)).toBeNull()
          expect(receipts.get(captured[0]!.value.owner.ownerId)).toEqual({ ...captured[0]!.value.owner,
            revision: captured[0]!.value.acknowledgedRevision + 1, complete: true, digests: [] })
        })
        expect(JSON.parse(localStorage.getItem(captured[1]!.key)!).releaseRevision).toBeUndefined()
        const second = executions[1]!.ref
        const replacement = await retainExecutionAssets(backend.connection, second, { complete: true, digests: [digest] })
        app.store.recordAssetRetentions(second, [replacement])
        await vi.waitFor(() => {
          expect(localStorage.getItem(captured[1]!.key)).toBeNull()
          expect(receipts.get(captured[1]!.value.owner.ownerId)).toEqual({ ...captured[1]!.value.owner,
            revision: captured[1]!.value.acknowledgedRevision + 1, complete: true, digests: [] })
        })
      }
    },
  )

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
