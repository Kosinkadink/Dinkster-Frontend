/**
 * Durable run history orchestration: the runs collection source maps the
 * search box onto the server's EXACT filter vocabulary (never filtering a
 * loaded page), activation reopens the exact producing workflow via
 * sourceDocument, and the delete/clear affordances remove RECORDS only.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asPromptId, diag, type DinksterNodesPayload, type ExecutionRef } from '@dinkster/core'
import { buildDinksterRegistry, type HistoryRunRecord } from '@dinkster/client'
import { AppState, LIBRARY_SCOPE, type Backend, type Tab } from '../src/app-state.js'
import { groupNoOpHistoryRuns, historySource, runIdOfEntry, runsFilterOf, runsSource } from '../src/collections.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes.json'), 'utf8'),
) as DinksterNodesPayload

const DIGEST = 'blake3:' + 'a'.repeat(64)

const run = (over: Partial<HistoryRunRecord> = {}): HistoryRunRecord => ({
  runId: 'run-1',
  scope: LIBRARY_SCOPE,
  clientId: 'cid',
  jobId: 'job-1',
  state: 'completed',
  priority: 0,
  submittedAt: 1,
  finishedAt: 3,
  executed: 2,
  cached: 1,
  skipped: 0,
  sourceDocument: DIGEST,
  ...over,
})

/** A run recorded from an unstamped submission (sourceDocument OMITTED). */
const unstamped = (over: Partial<HistoryRunRecord> = {}): HistoryRunRecord => {
  const { sourceDocument: _omitted, ...rest } = run(over)
  return rest
}

const CHAIN_DOC = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-history-test',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: { n0: { id: 'n0', type: 'std.math.add_ints', values: { a: 3, b: 4 } } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    },
  },
  view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } } } } } },
}

let app: AppState

beforeEach(() => {
  app = new AppState()
})

/** A native backend with live schemas and an open tab targeted at it. */
function nativeSetup(): { backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab } {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect(app.openDocument(CHAIN_DOC, 'Chain')).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('runsFilterOf', () => {
  it('maps the query onto exact server filters, never free text', () => {
    expect(runsFilterOf('')).toEqual({})
    expect(runsFilterOf('  ')).toEqual({})
    expect(runsFilterOf('completed')).toEqual({ state: 'completed' })
    expect(runsFilterOf('FAIL')).toEqual({ state: 'failed' })
    expect(runsFilterOf('can')).toEqual({ state: 'cancelled' })
    expect(runsFilterOf('int')).toEqual({ state: 'interrupted' })
    expect(runsFilterOf(DIGEST)).toEqual({ sourceDocument: DIGEST })
  })

  it('ambiguous or unmatchable text maps to nothing (empty result, not a fake search)', () => {
    expect(runsFilterOf('c')).toBeUndefined() // completed/cancelled both match
    expect(runsFilterOf('xyz')).toBeUndefined()
    expect(runsFilterOf('blake3:tooshort')).toBeUndefined()
  })
})

describe('groupNoOpHistoryRuns', () => {
  const noop = (id: string, over: Partial<HistoryRunRecord> = {}): HistoryRunRecord =>
    run({ runId: id, jobId: id, executed: 0, cached: 3, ...over })

  it('groups consecutive successful no-op runs by exact source document and keeps newest-first chronology', () => {
    const rows = groupNoOpHistoryRuns([
      noop('newest', { finishedAt: 30 }),
      noop('middle', { finishedAt: 20 }),
      noop('oldest', { finishedAt: 10 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.latest.runId).toBe('newest')
    expect(rows[0]!.members.map((member) => member.runId)).toEqual(['newest', 'middle', 'oldest'])
    expect(rows[0]!.id).toBe(`noop:${DIGEST}:oldest`)
  })

  it('keeps the group id stable when a newer member arrives within the retained page', () => {
    const before = groupNoOpHistoryRuns([noop('middle'), noop('oldest')])
    const after = groupNoOpHistoryRuns([noop('newest'), noop('middle'), noop('oldest')])
    expect(before[0]!.id).toBe(after[0]!.id)
    expect(after[0]!.members).toHaveLength(3)
  })

  it('breaks groups at an intervening executed run, even for the same document', () => {
    const rows = groupNoOpHistoryRuns([
      noop('new'),
      run({ runId: 'executed', jobId: 'executed', sourceDocument: DIGEST }),
      noop('old'),
    ])
    expect(rows.map((row) => row.members.map((member) => member.runId))).toEqual([
      ['new'], ['executed'], ['old'],
    ])
  })

  it('does not classify a zero-executed, zero-cached completion as a no-op group member', () => {
    const rows = groupNoOpHistoryRuns([
      noop('new'),
      run({ runId: 'empty', jobId: 'empty', executed: 0, cached: 0 }),
      noop('old'),
    ])
    expect(rows.map((row) => row.members.map((member) => member.runId))).toEqual([
      ['new'], ['empty'], ['old'],
    ])
  })

  it('does not group different document identities or unstamped no-op runs', () => {
    const other = 'blake3:' + 'b'.repeat(64)
    const rows = groupNoOpHistoryRuns([
      noop('a'),
      noop('b', { sourceDocument: other }),
      unstamped({ runId: 'c', jobId: 'c', executed: 0, cached: 2 }),
      unstamped({ runId: 'd', jobId: 'd', executed: 0, cached: 2 }),
    ])
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.members.length === 1)).toBe(true)
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)('keeps %s runs individual and makes them a group boundary', (state) => {
    const rows = groupNoOpHistoryRuns([
      noop('new'),
      run({ runId: state, jobId: state, state, executed: 0, cached: 3 }),
      noop('old'),
    ])
    expect(rows.map((row) => [row.latest.state, row.members.length])).toEqual([
      ['completed', 1], [state, 1], ['completed', 1],
    ])
  })

  it('keeps a running live execution out because durable history accepts terminal records only', async () => {
    const ref: ExecutionRef = {
      connection: asConnectionId('http://live'),
      prompt: asPromptId('still-running'),
    }
    app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
    const durable = groupNoOpHistoryRuns([noop('done')])
    const live = await historySource(app).page({ query: '', limit: 10 })
    expect(durable[0]!.members.map((member) => member.runId)).toEqual(['done'])
    expect(live.items).toHaveLength(1)
    expect(live.items[0]!.badges).toContain('running')
  })
})

describe('runsSource', () => {
  it('pages /api/history with the mapped filter and maps records to entries', async () => {
    const { backend } = nativeSetup()
    const list = vi.spyOn(backend.connection, 'listHistory').mockResolvedValue({
      records: [
        run({ principalId: 'queue-agent', principalKind: 'agent', nodeReceipts: [
          { nodeId: 'loader', disposition: 'executed', executionArm: 'native', worker: 'local' },
          { nodeId: 'sampler', disposition: 'cached', executionArm: 'comfyui', provider: 'vision.depth.v3', pack: 'dinkster-vision-depth-anything-v3', worker: 'render-box' },
        ] }),
        unstamped({ runId: 'run-2', state: 'failed', error: { kind: 'execution', message: 'node blew up' } }),
      ],
      cursor: 'c1',
    })
    // Cursors are backend-owned (AP6): the source hands out an encoded
    // continuation and decodes it back to the raw server cursor.
    const page = await runsSource(app).page({
      query: 'completed',
      limit: 24,
      cursor: JSON.stringify([backend.id, 'c0']),
    })
    expect(list).toHaveBeenCalledWith({
      scope: LIBRARY_SCOPE,
      state: 'completed',
      limit: 24,
      cursor: 'c0',
    })
    expect(page.cursor).toBe(JSON.stringify([backend.id, 'c1']))
    expect(page.items.map((i) => i.id)).toEqual(['run-1', 'run-2'])
    const stamped = page.items[0]!
    expect(stamped.badges).toContain('completed')
    expect(stamped.badges).toContain('Durable record')
    expect(stamped.badges).toContain('Source recorded')
    expect(stamped.badges).toEqual(expect.arrayContaining(['queued by queue-agent', 'agent']))
    expect(stamped.badges).toEqual(expect.arrayContaining(['1 Native', '1 ComfyUI']))
    expect(stamped.badges).toEqual(expect.arrayContaining(['1 on local', '1 on render-box']))
    expect(stamped.details).toContainEqual({
      label: 'node sampler',
      text: 'cached - ComfyUI - provider vision.depth.v3 - pack dinkster-vision-depth-anything-v3 - render-box',
    })
    // Stamped runs carry the explicit open action (click is select-only:
    // click-as-activation would make delete unreachable); unstamped runs
    // have nothing to open, so delete stands alone.
    expect(stamped.actions).toEqual([
      { id: 'open', label: 'Open workflow' },
      { id: 'delete', label: 'Delete record' },
    ])
    const failed = page.items[1]!
    expect(failed.actions).toEqual([{ id: 'delete', label: 'Delete record' }])
    expect(failed.badges).toContain('failed')
    expect(failed.badges).not.toContain('stamped')
    expect(failed.details).toContainEqual({ label: 'error', text: 'node blew up' })
    expect(failed.details).toContainEqual({
      label: 'source document',
      text: 'none (unstamped submission)',
    })
  })

  it('projects a collapsed no-op row with a count and expandable individual entries', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'listHistory').mockResolvedValue({
      records: [
        run({ runId: 'run-new', jobId: 'job-new', finishedAt: 30, executed: 0, cached: 2 }),
        run({ runId: 'run-old', jobId: 'job-old', finishedAt: 20, executed: 0, cached: 2 }),
      ],
    })
    const page = await runsSource(app).page({ query: '', limit: 24 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.subtitle).toContain('job-new')
    expect(page.items[0]!.badges).toContain('No-op group')
    expect(page.items[0]!.badges).toContain('2 runs')
    expect(page.items[0]!.children?.map((entry) => entry.id)).toEqual(['run-new', 'run-old'])
    expect(runIdOfEntry(page.items[0]!)).toBe('run-new')
  })

  it('renders interrupted records with phase text and a stamped-only Resubmit action', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'listHistory').mockResolvedValue({
      records: [
        run({
          runId: 'int-running', jobId: 'int-running', state: 'interrupted', executed: 0, cached: 0,
          error: { kind: 'interrupted', phase: 'running', message: 'the server exited while this job was running; it was not re-run - resubmit it to run it' },
        }),
        unstamped({
          runId: 'int-queued', jobId: 'int-queued', state: 'interrupted', executed: 0, cached: 0,
          error: { kind: 'interrupted', phase: 'queued', message: 'the server exited before this job started; it was not re-run - resubmit it to run it' },
        }),
      ],
    })
    const page = await runsSource(app).page({ query: '', limit: 24 })
    const wasRunning = page.items[0]!
    expect(wasRunning.title).toBe('Interrupted run')
    expect(wasRunning.badges).toEqual(expect.arrayContaining(['interrupted', 'was running']))
    expect(wasRunning.details).toContainEqual({ label: 'interrupted', text: 'was running' })
    // Resubmit only on stamped records: unstamped ones have no document to resubmit.
    expect(wasRunning.actions).toEqual([
      { id: 'resubmit', label: 'Resubmit' },
      { id: 'open', label: 'Open workflow' },
      { id: 'delete', label: 'Delete record' },
    ])
    const neverStarted = page.items[1]!
    expect(neverStarted.badges).toEqual(expect.arrayContaining(['interrupted', 'never started']))
    expect(neverStarted.details).toContainEqual({ label: 'interrupted', text: 'never started' })
    expect(neverStarted.actions).toEqual([{ id: 'delete', label: 'Delete record' }])
  })

  it('an unmatchable query returns empty WITHOUT calling the server', async () => {
    const { backend } = nativeSetup()
    const list = vi.spyOn(backend.connection, 'listHistory')
    expect(await runsSource(app).page({ query: 'xyz', limit: 24 })).toEqual({ owner: backend.id, items: [], total: 0 })
    expect(list).not.toHaveBeenCalled()
  })

  it('renders the empty state when no native backend is active', async () => {
    expect(await runsSource(app).page({ query: '', limit: 24 })).toEqual({ items: [], total: 0 })
  })
})

describe('openRunWorkflow', () => {
  it('fetches the exact source document and opens it targeted at the run backend', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(run())
    const fetchAsset = vi
      .spyOn(backend.connection, 'fetchAssetText')
      .mockResolvedValue(JSON.stringify(CHAIN_DOC))

    expect(await app.openRunWorkflow('run-1', backend.id)).toBe(true)
    expect(fetchAsset).toHaveBeenCalledWith(DIGEST)
    const tab = app.activeTab()!
    expect(tab.title).toBe('Run job-1') // no meta.title in the document
    expect(app.backendForTab(tab).id).toBe(backend.id)
  })

  it('an unstamped run surfaces a visible problem instead of silently doing nothing', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(unstamped())
    const fetchAsset = vi.spyOn(backend.connection, 'fetchAssetText')
    expect(await app.openRunWorkflow('run-1', backend.id)).toBe(false)
    expect(fetchAsset).not.toHaveBeenCalled()
    expect(app.problems.get().some((d) => d.code === 'history.unstamped')).toBe(true)
  })

  it('a missing run or missing bytes returns false without a crash', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(undefined)
    expect(await app.openRunWorkflow('run-x', backend.id)).toBe(false)

    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(run())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(undefined)
    expect(await app.openRunWorkflow('run-1', backend.id)).toBe(false)
  })

  it('transport failures land in Problems', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockRejectedValue(new Error('boom'))
    expect(await app.openRunWorkflow('run-1', backend.id)).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'history.openFailed')).toBe(true)
  })
})

describe('resubmitRunWorkflow', () => {
  const interrupted = (over: Partial<HistoryRunRecord> = {}): HistoryRunRecord =>
    run({
      state: 'interrupted', executed: 0, cached: 0,
      error: { kind: 'interrupted', phase: 'queued', message: 'the server exited before this job started; it was not re-run - resubmit it to run it' },
      ...over,
    })

  it('reopens the producing document and queues a FRESH submission through the normal pipeline', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(interrupted())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(CHAIN_DOC))
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'c'.repeat(64))
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [diag('error', 'validation', 'submit.expected', 'stop after POST')],
    })
    expect(await app.resubmitRunWorkflow('run-1', backend.id)).toBe(true)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(app.activeTab()?.title).toBe('Run job-1')
  })

  it('a compile refusal keeps the reopened tab and its problems without submitting', async () => {
    const { backend } = nativeSetup()
    // The producing document opens cleanly but its executed output depends
    // on a node type this backend does not resolve, so the queue refuses.
    const comfyPayload = JSON.parse(readFileSync(
      join(coreRoot, 'fixtures/dinkster-nodes-comfy.json'), 'utf8',
    )) as DinksterNodesPayload
    backend.registry.set(buildDinksterRegistry(backend.id, comfyPayload))
    const unresolvedDoc = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), 'fixtures/unresolved-output-dependency.json',
    ), 'utf8')
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(interrupted())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(unresolvedDoc)
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'c'.repeat(64))
    const submit = vi.spyOn(backend.connection, 'submit')

    expect(await app.resubmitRunWorkflow('run-1', backend.id)).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    // The reopened tab stays active so the user can inspect the refusal.
    expect(app.activeTab()?.title).toBe('Unresolved node feeding the executed output')
    expect(app.problems.get().some((d) => d.code === 'compile.schema.unknown')).toBe(true)
  })

  it('an unstamped interrupted run refuses with the visible unstamped problem and never submits', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(
      unstamped({ state: 'interrupted', executed: 0, cached: 0 }),
    )
    const submit = vi.spyOn(backend.connection, 'submit')
    expect(await app.resubmitRunWorkflow('run-1', backend.id)).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(app.problems.get().some((d) => d.code === 'history.unstamped')).toBe(true)
  })

  it('a failed open (missing run) never submits', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue(undefined)
    const submit = vi.spyOn(backend.connection, 'submit')
    expect(await app.resubmitRunWorkflow('run-x', backend.id)).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('delete and clear', () => {
  it('deleteHistoryRun removes the record and re-pages open collections', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'deleteHistoryRun').mockResolvedValue(true)
    const before = app.backendsTick.get()
    expect(await app.deleteHistoryRun('run-1', backend.id)).toBe(true)
    expect(app.backendsTick.get()).toBe(before + 1)
  })

  it('an already-gone record is not an error and does not re-page', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'deleteHistoryRun').mockResolvedValue(false)
    const before = app.backendsTick.get()
    expect(await app.deleteHistoryRun('run-1', backend.id)).toBe(false)
    expect(app.backendsTick.get()).toBe(before)
    expect(app.problems.get()).toEqual([])
  })

  it('delete failures land in Problems', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'deleteHistoryRun').mockRejectedValue(new Error('boom'))
    expect(await app.deleteHistoryRun('run-1', backend.id)).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'history.deleteFailed')).toBe(true)
  })

  it('clearRunHistory clears the whole scope and returns the count', async () => {
    const { backend } = nativeSetup()
    const clear = vi.spyOn(backend.connection, 'clearHistory').mockResolvedValue(7)
    const before = app.backendsTick.get()
    expect(await app.clearRunHistory(backend.id)).toBe(7)
    expect(clear).toHaveBeenCalledWith({ scope: LIBRARY_SCOPE })
    expect(app.backendsTick.get()).toBe(before + 1)
  })

  it('clear failures land in Problems and report zero', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'clearHistory').mockRejectedValue(new Error('boom'))
    expect(await app.clearRunHistory(backend.id)).toBe(0)
    expect(app.problems.get().some((d) => d.code === 'history.clearFailed')).toBe(true)
  })
})
