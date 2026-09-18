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
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  app = new AppState()
})

/** Two native backends plus an open tab targeted at A. */
function twoBackends(): {
  a: Extract<Backend, { protocol: 'dinkster' }>
  b: Extract<Backend, { protocol: 'dinkster' }>
  tab: Tab
} {
  const a = app.addBackend('http://native-a:8000', 'A', false, 'dinkster')
  const b = app.addBackend('http://native-b:8000', 'B', false, 'dinkster')
  if (!a || a.protocol !== 'dinkster' || !b || b.protocol !== 'dinkster') throw new Error('addBackend rejected')
  a.registry.set(buildDinksterRegistry(a.id, nodesPayload))
  b.registry.set(buildDinksterRegistry(b.id, nodesPayload))
  expect(app.openDocument(DOC, 'Doc')).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, a.id)
  return { a, b, tab }
}

describe('owned collection pages', () => {
  it('a continuation cursor minted by one backend is refused against another', async () => {
    const { a, b, tab } = twoBackends()
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
    const { a } = twoBackends()
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
  it('openFromLibrary resolves the record on its owner, not the active backend', async () => {
    const { a, b, tab } = twoBackends()
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
    const { a, b } = twoBackends()
    const delA = vi.spyOn(a.connection, 'deleteHistoryRun')
    const delB = vi.spyOn(b.connection, 'deleteHistoryRun')

    expect(await app.deleteHistoryRun('run-1', 'backend-that-never-existed')).toBe(false)
    expect(delA).not.toHaveBeenCalled()
    expect(delB).not.toHaveBeenCalled()
    expect(app.problems.get().some((d) => d.code === 'library.ownerGone')).toBe(true)
  })

  it('clearRunHistory clears the owner scope even when another backend is active', async () => {
    const { a, b, tab } = twoBackends()
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
    const { a } = twoBackends()
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
    const { a, tab } = twoBackends()
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
    const { a } = twoBackends()
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
    const { a } = twoBackends()
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

  it('a run whose backend vanishes mid-open installs no target', async () => {
    const { a } = twoBackends()
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
