/**
 * AP6: library/template/run entries and their paging cursors are OWNED by
 * the backend that served them. Entry actions route back to that owner -
 * never to whatever backend the active tab targets when the click lands -
 * and a continuation cursor minted by one backend is refused, not
 * replayed, against another. An owner that is no longer connected fails
 * loudly into Problems instead of silently retargeting.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry, type HistoryRunRecord, type LibraryRecord } from '@dinkster/client'
import {
  AppState,
  LIBRARY_SCOPE,
  WORKFLOW_LABEL,
  WORKFLOW_MEDIA_TYPE,
  type Backend,
  type Tab,
} from '../src/app-state.js'
import { runsSource, templatesSource, workflowsSource } from '../src/collections.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes.json'), 'utf8'),
) as DinksterNodesPayload

const DIGEST = 'blake3:' + 'a'.repeat(64)

const record = (over: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id: 'r1',
  scope: LIBRARY_SCOPE,
  name: 'Saved Flow',
  digest: DIGEST,
  mediaType: WORKFLOW_MEDIA_TYPE,
  labels: [WORKFLOW_LABEL],
  created: 1,
  modified: 2,
  revision: 1,
  ...over,
})

const run = (over: Partial<HistoryRunRecord> = {}): HistoryRunRecord => ({
  runId: 'run-1',
  scope: LIBRARY_SCOPE,
  clientId: 'cid',
  jobId: 'job-1',
  state: 'completed',
  priority: 0,
  submittedAt: 1,
  finishedAt: 3,
  executed: 1,
  cached: 0,
  skipped: 0,
  sourceDocument: DIGEST,
  ...over,
})

const DOC = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-ownership-test',
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
  app = createWorkflowApp(null)
})

afterEach(() => {
  app.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Two native backends plus an open tab targeted at A. */
async function twoBackends(): Promise<{
  a: Extract<Backend, { protocol: 'dinkster' }>
  b: Extract<Backend, { protocol: 'dinkster' }>
  tab: Tab
}> {
  const a = app.addBackend('http://native-a:8000', 'A', false, 'dinkster')
  const b = app.addBackend('http://native-b:8000', 'B', false, 'dinkster')
  if (!a || a.protocol !== 'dinkster' || !b || b.protocol !== 'dinkster') throw new Error('addBackend rejected')
  a.templatesEnabled.set(true)
  b.templatesEnabled.set(true)
  a.registry.set(buildDinksterRegistry(a.id, nodesPayload))
  b.registry.set(buildDinksterRegistry(b.id, nodesPayload))
  for (const backend of [a, b]) vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  expect((await app.openDocument(DOC, 'Doc'))).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, a.id)
  return { a, b, tab }
}

describe('owned collection pages', () => {
  it('a continuation cursor minted by one backend is refused against another', async () => {
    const { a, b, tab } = (await twoBackends())
    const listA = vi
      .spyOn(a.connection, 'listLibrary')
      .mockResolvedValue({ records: [record()], cursor: 'pageA2' })
    const src = workflowsSource(app)

    const page = await src.page({ query: '', limit: 24 })
    expect(page.items[0]!.owner).toBe(a.id)
    expect(page.items[0]!.subtitle).toMatch(/^Modified /)
    expect(page.items[0]!.details).toContainEqual({ label: 'workflow id', text: 'r1' })
    expect(page.items[0]!.details).toContainEqual({ label: 'backend', text: 'A' })
    expect(page.cursor).toBeDefined()

    // Same backend: the continuation decodes back to the raw server cursor.
    await src.page({ query: '', limit: 24, cursor: page.cursor! })
    expect(listA.mock.calls[1]![0]).toMatchObject({ cursor: 'pageA2' })

    // Retargeted to B: the stale continuation is refused - B is never
    // handed A's cursor, and no mixed-backend page is served.
    app.setTabTarget(tab.id, b.id)
    const listB = vi.spyOn(b.connection, 'listLibrary')
    await expect(src.page({ query: '', limit: 24, cursor: page.cursor! })).rejects.toThrow(
      /another backend/,
    )
    expect(listB).not.toHaveBeenCalled()
  })

  it('run and template entries AND their pages carry the serving backend as owner', async () => {
    const { a } = (await twoBackends())
    vi.spyOn(a.connection, 'listHistory').mockResolvedValue({ records: [run()] })
    vi.spyOn(a.connection, 'listTemplates').mockResolvedValue({
      templates: [{ pack: 'core', id: 't1', name: 'Starter', digest: 'sha256:x' }],
    })
    const runs = await runsSource(app).page({ query: '', limit: 24 })
    expect(runs.owner).toBe(a.id)
    expect(runs.items[0]!.owner).toBe(a.id)
    const templates = await templatesSource(app).page({ query: '', limit: 24 })
    expect(templates.owner).toBe(a.id)
    expect(templates.items[0]!.owner).toBe(a.id)
    expect(templates.items[0]!.details).toEqual([
      { label: 'template id', text: 't1' },
      { label: 'pack', text: 'core' },
      { label: 'backend', text: 'A' },
      { label: 'digest', text: 'sha256:x' },
    ])
    // Empty pages carry the owner too - PAGE-scoped operations (clear all)
    // need a target even when the corpus is empty or the query matched
    // nothing.
    const empty = await runsSource(app).page({ query: 'no-such-state', limit: 24 })
    expect(empty.items).toEqual([])
    expect(empty.owner).toBe(a.id)
  })
})

describe('owned entry actions', () => {

  it.each(['library', 'run'] as const)('admits %s payloads before reading and refuses obsolete publication', async (source) => {
    const { a, tab } = (await twoBackends())
    vi.spyOn(a.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(a.connection, 'getHistoryRun').mockResolvedValue(run())
    let admit!: () => void
    const admission = new Promise<void>((resolve) => { admit = resolve })
    let finish!: () => void
    const body = new Promise<string>((resolve) => { finish = () => resolve(JSON.stringify({ ...DOC, lineage: 'payload-opened' })) })
    const retain = vi.spyOn(a.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
      if (owner.ownerKind === 'preview') await admission
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    const fetch = vi.spyOn(a.connection, 'fetchAssetText').mockReturnValue(body)
    let settled = false
    const opening = (source === 'library' ? app.openFromLibrary('r1', a.id) : app.openRunWorkflow('run-1', a.id))
      .finally(() => { settled = true })
    await vi.waitFor(() => expect(retain).toHaveBeenCalled())
    expect(fetch).not.toHaveBeenCalled()
    expect(retain.mock.calls[0]).toMatchObject([{ ownerKind: 'preview' }, { complete: false, digests: [DIGEST] }])
    expect(app.activeTab()).toBe(tab)
    admit()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(DIGEST))
    await app.openDocument({ ...DOC, lineage: 'newer-open' }, 'Newer document')
    const newer = app.activeTab()
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    expect(await opening).toBe(false)
    expect(app.activeTab()).toBe(newer)
    expect(app.tabs.get().some((candidate) => candidate.store.doc.lineage === 'payload-opened')).toBe(false)
    expect(app.problems.get().some((problem) => ['library.openFailed', 'history.openFailed'].includes(problem.code))).toBe(false)
  })

  it('openFromLibrary resolves the record on its owner, not the active backend', async () => {
    const { a, b, tab } = (await twoBackends())
    app.setTabTarget(tab.id, b.id) // the click lands while B is active
    const getA = vi
      .spyOn(a.connection, 'getLibraryRecord')
      .mockResolvedValue(record({ name: 'From A' }))
    vi.spyOn(a.connection, 'fetchAssetText').mockResolvedValue(
      JSON.stringify({ ...DOC, lineage: 'lineage-opened-from-a' }),
    )
    const getB = vi.spyOn(b.connection, 'getLibraryRecord')

    expect(await app.openFromLibrary('r1', a.id)).toBe(true)
    expect(getA).toHaveBeenCalledWith('r1', LIBRARY_SCOPE)
    expect(getB).not.toHaveBeenCalled()
    // The opened tab follows its workflow HOME (owner), not the old target.
    const opened = app.activeTab()!
    expect(opened.title).toBe('From A')
    expect(app.backendForTab(opened).id).toBe(a.id)
  })

  it('an entry whose owner backend is gone fails into Problems, never another backend', async () => {
    const { a, b } = (await twoBackends())
    const delA = vi.spyOn(a.connection, 'deleteHistoryRun')
    const delB = vi.spyOn(b.connection, 'deleteHistoryRun')

    expect(await app.deleteHistoryRun('run-1', 'backend-that-never-existed')).toBe(false)
    expect(delA).not.toHaveBeenCalled()
    expect(delB).not.toHaveBeenCalled()
    expect(app.problems.get().some((d) => d.code === 'library.ownerGone')).toBe(true)
  })

  it('clearRunHistory clears the owner scope even when another backend is active', async () => {
    const { a, b, tab } = (await twoBackends())
    app.setTabTarget(tab.id, b.id)
    const clearA = vi.spyOn(a.connection, 'clearHistory').mockResolvedValue(3)
    const clearB = vi.spyOn(b.connection, 'clearHistory')

    expect(await app.clearRunHistory(a.id)).toBe(3)
    expect(clearA).toHaveBeenCalledWith({ scope: LIBRARY_SCOPE })
    expect(clearB).not.toHaveBeenCalled()
  })
})

describe('mid-flight owner loss', () => {
  // Removal retires the backend OBJECT but does not abort its in-flight
  // HTTP; a late response must not install tabs, targets, or links.
  it('a backend removed while its record fetch is in flight opens nothing', async () => {
    const { a } = (await twoBackends())
    let release!: (r: ReturnType<typeof record>) => void
    vi.spyOn(a.connection, 'getLibraryRecord').mockReturnValue(
      new Promise((resolve) => { release = resolve }),
    )
    const fetchA = vi.spyOn(a.connection, 'fetchAssetText')
    const tabsBefore = app.tabs.get()

    const opening = app.openFromLibrary('r1', a.id)
    app.removeBackend(a.id)
    release(record({ name: 'Late From A' }))

    expect(await opening).toBe(false)
    expect(fetchA).not.toHaveBeenCalled() // aborted before the second fetch
    expect(app.tabs.get()).toEqual(tabsBefore)
    expect(app.problems.get().some((d) => d.code === 'library.ownerGone')).toBe(true)
  })

  it('a same-URL replacement backend never inherits a retired backend\'s late response', async () => {
    const { a, tab } = (await twoBackends())
    vi.spyOn(a.connection, 'getLibraryRecord').mockResolvedValue(record({ name: 'From A' }))
    let releaseText!: (text: string) => void
    const fetchA = vi.spyOn(a.connection, 'fetchAssetText').mockReturnValue(
      new Promise((resolve) => { releaseText = resolve }),
    )

    const opening = app.openFromLibrary('r1', a.id)
    await vi.waitFor(() => expect(fetchA).toHaveBeenCalled())
    // Retire A and immediately re-add the same URL: the ID is reused on a
    // NEW object - identity-based revalidation must still refuse the late
    // response instead of targeting/linking the replacement by ID match.
    app.removeBackend(a.id)
    const replacement = app.addBackend('http://native-a:8000', 'A again', false, 'dinkster')
    expect(replacement?.id).toBe(a.id)
    const tabsBefore = app.tabs.get()

    releaseText(JSON.stringify({ ...DOC, lineage: 'lineage-late-response' }))
    expect(await opening).toBe(false)
    expect(app.tabs.get()).toEqual(tabsBefore) // no tab opened
    expect(app.activeTab()).toBe(tab) // the active tab is untouched
    expect(app.problems.get().some((d) => d.code === 'library.ownerGone')).toBe(true)
  })

  it('an EMPTY answer from a retired backend still reports ownerGone', async () => {
    // Liveness is checked before payload checks: a miss (undefined) from a
    // backend removed mid-request must not short-circuit into a silent
    // return that skips the ownership diagnosis.
    const { a } = (await twoBackends())
    let release!: (r: undefined) => void
    vi.spyOn(a.connection, 'getLibraryRecord').mockReturnValue(
      new Promise((resolve) => { release = resolve }),
    )
    const opening = app.openFromLibrary('r1', a.id)
    app.removeBackend(a.id)
    release(undefined)

    expect(await opening).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'library.ownerGone')).toBe(true)
  })

  it('a template fetch rejected by removal reports ownerGone, not a transport failure', async () => {
    const { a } = (await twoBackends())
    let reject!: (e: Error) => void
    vi.spyOn(a.connection, 'fetchTemplateBody').mockReturnValue(
      new Promise((_resolve, rej) => { reject = rej }),
    )
    const opening = app.openTemplate('core', 't1', 'Starter', a.id)
    app.removeBackend(a.id)
    reject(new Error('socket hang up'))

    expect(await opening).toBe(false)
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).toContain('library.ownerGone')
    expect(codes).not.toContain('template.openFailed')
  })

  it('opens region templates with a readable left-to-right layout', async () => {
    const { a } = (await twoBackends())
    const template = structuredClone(DOC) as any
    template.lineage = 'region-template-layout'
    template.graphs.g0.nodes = {
      source: { id: 'source', type: 'std.math.add_ints', values: { a: 1, b: 2 } },
      loop: { id: 'loop', type: '#body', values: {}, region: { kind: 'map', elementPorts: ['value'] } },
      sink: { id: 'sink', type: 'std.math.add_ints', values: { b: 0 } },
    }
    template.graphs.g0.links = {
      first: { id: 'first', from: { node: 'source', port: 'sum' }, to: { node: 'loop', port: 'value' } },
      second: { id: 'second', from: { node: 'loop', port: 'result' }, to: { node: 'sink', port: 'a' } },
    }
    template.graphs.g0.nextOrdinal = 3
    template.graphs.body = {
      id: 'body', name: 'Body',
      nodes: { work: { id: 'work', type: 'std.math.add_ints', values: { b: 1 } } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: {
        inputs: [{ id: 'value', binds: { kind: 'port', node: 'work', port: 'a' } }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'work', port: 'sum' } }],
      },
    }
    template.view.graphs = {
      g0: { nodes: {
        source: { position: { x: 0, y: 0 } },
        loop: { position: { x: 100, y: 0 } },
        sink: { position: { x: 100, y: 0 } },
      } },
      body: { nodes: {} },
    }
    const fetchTemplate = vi.spyOn(a.connection, 'fetchTemplateBody').mockResolvedValueOnce(template)

    expect(await app.openTemplate('core', 'loop', 'Loop', a.id)).toBe(true)
    expect(app.activeTab()!.store.doc.view.graphs.g0!.nodes).toMatchObject({
      source: { position: { x: 80, y: 120 } },
      loop: { position: { x: 600, y: 120 } },
      sink: { position: { x: 1120, y: 120 } },
    })
    expect(app.activeTab()!.store.doc.view.graphs.body!.nodes.work).toMatchObject({
      position: { x: 80, y: 120 },
    })

    const grouped = structuredClone(template)
    grouped.lineage = 'region-template-grouped'
    grouped.view.graphs.g0.groups = {
      keep: { id: 'keep', title: 'Keep', bounds: { x: -10, y: -10, width: 250, height: 250 } },
    }
    fetchTemplate.mockResolvedValueOnce(grouped)
    expect(await app.openTemplate('core', 'grouped', 'Grouped', a.id)).toBe(true)
    expect(app.activeTab()!.store.doc.view.graphs.g0).toEqual(grouped.view.graphs.g0)

    const cyclic = structuredClone(template)
    cyclic.lineage = 'region-template-cyclic'
    cyclic.graphs.g0.links.second.to = { node: 'source', port: 'a' }
    cyclic.graphs.g0.links.tail = {
      id: 'tail', from: { node: 'loop', port: 'result' }, to: { node: 'sink', port: 'a' },
    }
    fetchTemplate.mockResolvedValueOnce(cyclic)
    expect(await app.openTemplate('core', 'cyclic', 'Cyclic', a.id)).toBe(true)
    expect(app.activeTab()!.store.doc.view.graphs.g0).toEqual(cyclic.view.graphs.g0)
  })

  it('a run whose backend vanishes mid-open installs no target', async () => {
    const { a } = (await twoBackends())
    vi.spyOn(a.connection, 'getHistoryRun').mockResolvedValue(run())
    let releaseText!: (text: string) => void
    const fetchA = vi.spyOn(a.connection, 'fetchAssetText').mockReturnValue(
      new Promise((resolve) => { releaseText = resolve }),
    )
    const opening = app.openRunWorkflow('run-1', a.id)
    await vi.waitFor(() => expect(fetchA).toHaveBeenCalled())
    app.removeBackend(a.id)
    const tabsBefore = app.tabs.get()
    releaseText(JSON.stringify({ ...DOC, lineage: 'lineage-run-late' }))

    expect(await opening).toBe(false)
    expect(app.tabs.get()).toEqual(tabsBefore)
    expect(app.problems.get().some((d) => d.code === 'library.ownerGone')).toBe(true)
  })
})
