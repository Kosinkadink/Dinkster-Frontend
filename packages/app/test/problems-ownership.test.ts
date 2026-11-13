/**
 * Problems ownership: every entry belongs to a tab id or an app-scoped
 * symbol. The panel shows visible tabs plus every app-scoped owner, so one
 * workflow's diagnostics never bleed into another tab even when both
 * documents use the same graph ids.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, GLOBAL_PROBLEMS_OWNER, visibleProblems, type Backend, type Tab } from '../src/app-state.js'
import { asNodeId, diag, type DinksterNodesPayload } from '@dinkster/core'
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

/** Minimal native document; every document uses root graph 'g0' ON PURPOSE. */
const docJson = (lineage: string): unknown => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage,
  root: 'g0',
  graphs: {
    g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
  },
  view: { graphs: { g0: { nodes: {} } } },
  meta: { title: lineage },
})

const open = async (lineage: string): Promise<Tab> => {
  expect((await app.openDocument(docJson(lineage), lineage))).toEqual([])
  return app.activeTab()!
}

/** The projection a single-visible-canvas shell renders for one active tab. */
const shownCodes = (activeTabId: string): readonly string[] =>
  visibleProblems(app.problems.get(), new Set([activeTabId])).map((d) => d.code)

describe('problems ownership', () => {
  it('dismisses only the selected workflow import notices', async () => {
    const a = (await open('lin-import-a'))
    const b = (await open('lin-import-b'))
    app.reportProblems(a.id, [diag('info', 'import', 'import.notice', 'Seed format is upgraded')])
    app.reportProblems(b.id, [
      diag('info', 'import', 'import.notice', 'Seed format is upgraded'),
      diag('error', 'compile', 'compile.input.missing', 'Sampler model: required input has no connection'),
    ])
    app.dismissImportProblems()
    expect(shownCodes(a.id)).toEqual(['import.notice'])
    expect(shownCodes(b.id)).toEqual(['compile.input.missing'])
  })

  it('deduplicates report ingress and accepts an entry again after clearing', async () => {
    const tab = (await open('lin-dedupe'))
    const diagnostic = diag('warning', 'command', 'boundary.bindKind', 'family forwarding cannot fan out')
    app.reportProblems(tab.id, [diagnostic])
    app.reportProblems(tab.id, [diagnostic])
    expect(app.problems.get().filter((entry) => entry.code === diagnostic.code)).toHaveLength(1)

    await open('lin-dedupe')
    expect(app.problems.get().filter((entry) => entry.code === diagnostic.code)).toHaveLength(0)
    app.reportProblems(tab.id, [diagnostic])
    expect(app.problems.get().filter((entry) => entry.code === diagnostic.code)).toHaveLength(1)
  })

  it('replacement batches retain anchor-distinct diagnostics with identical codes and messages', async () => {
    const tab = (await open('lin-replace-anchors'))
    const first = diag('error', 'compile', 'compile.schema.unknown', "unknown node type 'Missing'", { anchor: { occurrence: { instancePath: [], node: asNodeId('a') } } })
    const second = diag('error', 'compile', 'compile.schema.unknown', "unknown node type 'Missing'", { anchor: { occurrence: { instancePath: [], node: asNodeId('b') } } })
    app.replaceProblems(tab.id, [first, second])
    const retained = app.problems.get().filter((entry) => entry.code === 'compile.schema.unknown')
    expect(retained).toHaveLength(2)
    expect(retained.map((entry) => entry.anchor?.occurrence?.node)).toEqual(['a', 'b'])
  })

  it('hides an inactive workflow\'s diagnostics and shows them again on switch', async () => {
    const a = (await open('lin-a'))
    const b = (await open('lin-b'))
    app.reportProblems(a.id, [diag('error', 'compile', 'compile.tap.novalue', 'from A')])
    app.reportProblems(b.id, [diag('warning', 'compile', 'compile.input.missing', 'from B')])
    expect(shownCodes(a.id)).toEqual(['compile.tap.novalue'])
    expect(shownCodes(b.id)).toEqual(['compile.input.missing'])
  })

  it('keeps app-scoped globals visible regardless of the active tab', async () => {
    const a = (await open('lin-a'))
    const b = (await open('lin-b'))
    app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'schema', 'schema.fetchFailed', 'backend down')])
    expect(shownCodes(a.id)).toContain('schema.fetchFailed')
    expect(shownCodes(b.id)).toContain('schema.fetchFailed')
  })

  it('replaces and clears an independent symbol-owned app snapshot', async () => {
    const appOwner = Symbol('provider-problems')
    const otherOwner = Symbol('other-app-problems')
    const tab = (await open('lin-symbol-owner'))
    app.reportProblems(tab.id, [diag('warning', 'compile', 'tab.problem', 'tab stays')])
    app.reportProblems(otherOwner, [diag('error', 'schema', 'other.problem', 'other app stays')])

    app.replaceProblems(appOwner, [diag('error', 'extension', 'host-ui.provider-failed', 'first failure')])
    expect(visibleProblems(app.problems.get(), new Set())).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: appOwner, message: 'first failure' }),
      expect.objectContaining({ owner: otherOwner, message: 'other app stays' }),
    ]))
    expect(visibleProblems(app.problems.get(), new Set([tab.id])).map((entry) => entry.message)).toEqual(expect.arrayContaining([
      'tab stays', 'other app stays', 'first failure',
    ]))

    app.replaceProblems(appOwner, [diag('error', 'extension', 'host-ui.provider-failed', 'second failure')])
    expect(app.problems.get().filter((entry) => entry.owner === appOwner)).toEqual([
      expect.objectContaining({ message: 'second failure' }),
    ])
    expect(app.problems.get().some((entry) => entry.owner === otherOwner)).toBe(true)
    expect(app.problems.get().some((entry) => entry.owner === tab.id)).toBe(true)

    app.replaceProblems(appOwner, [])
    expect(app.problems.get().some((entry) => entry.owner === appOwner)).toBe(false)
    expect(app.problems.get().some((entry) => entry.owner === otherOwner)).toBe(true)
    expect(app.problems.get().some((entry) => entry.owner === tab.id)).toBe(true)
  })

  it('publishes node decoration failures only when their result changes', () => {
    app.reportNodeDecorationResult('pack.decorator', new Error('failed'))
    const failed = app.problems.get()
    expect(failed).toEqual([
      expect.objectContaining({
        code: 'extension.node-decoration-failed',
        message: "Node decoration 'pack.decorator' failed: failed",
      }),
    ])

    app.reportNodeDecorationResult('pack.decorator', new Error('failed'))
    expect(app.problems.get()).toBe(failed)

    app.reportNodeDecorationResult('pack.decorator')
    expect(app.problems.get()).toEqual([])
  })

  it('drops a closed tab\'s diagnostics and keeps everyone else\'s', async () => {
    const a = (await open('lin-a'))
    const b = (await open('lin-b'))
    app.reportProblems(a.id, [diag('error', 'compile', 'a.problem', 'A')])
    app.reportProblems(b.id, [diag('error', 'compile', 'b.problem', 'B'), diag('info', 'import', 'import.notice', 'B: saved seed format is upgraded')])
    app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'schema', 'global.problem', 'G')])
    app.closeTab(b.id)
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).toContain('a.problem')
    expect(codes).toContain('global.problem')
    expect(codes).not.toContain('b.problem')
    expect(codes).not.toContain('import.notice')
  })

  it('replacing a document (same lineage) replaces its diagnostics, not others\'', async () => {
    const a = (await open('lin-a'))
    const b = (await open('lin-b'))
    app.reportProblems(a.id, [diag('error', 'compile', 'a.stale', 'stale A')])
    app.reportProblems(b.id, [diag('error', 'compile', 'b.keeps', 'B keeps this')])
    await open('lin-a') // same lineage -> same tab id -> entries replaced by load diagnostics ([])
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).not.toContain('a.stale')
    expect(codes).toContain('b.keeps')
  })

  it('rejected commands land under the dispatching tab', async () => {
    const a = (await open('lin-a'))
    await open('lin-b')
    const outcome = await app.dispatchTo(a, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'missing', inputId: 'x', value: 1 } })
    expect(outcome.ok).toBe(false)
    const owned = app.problems.get().filter((d) => d.owner === a.id)
    expect(owned.length).toBeGreaterThan(0)
    // ... and the OTHER tab's projection does not show them.
    expect(visibleProblems(app.problems.get(), new Set([app.activeTabId.get()]))).toEqual([])
  })

})

/** Compilable chain document for backend-coupled async tests. */
const CHAIN_DOC = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-async-test',
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

/** A promise whose settlement the test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Wait until a spied call has been entered (saves chain via a microtask). */
async function callStarted(spy: { mock: { calls: unknown[][] } }): Promise<void> {
  for (let i = 0; i < 50 && spy.mock.calls.length === 0; i++) await Promise.resolve()
  if (spy.mock.calls.length === 0) throw new Error('spied call was never entered')
}

describe('workflow asset presence', () => {
  const first = { digest: 'blake3:' + 'a'.repeat(64), name: 'portrait.png', size: 17,
    mediaType: 'image/png', virtualPath: 'mounts/original/portrait.png' }
  const other = { ...first, digest: 'blake3:' + 'b'.repeat(64) }
  const document = {
    ...CHAIN_DOC,
    graphs: { g0: { ...CHAIN_DOC.graphs.g0, nodes: {
      n0: { ...CHAIN_DOC.graphs.g0.nodes.n0, values: { a: first, b: [other, first] } },
    }, links: {} } },
  }

  it('exports last-known paths per occurrence and displays them read-only after reopen on an empty library', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'available' }, { digest: other.digest, status: 'available' },
    ])
    vi.spyOn(backend.connection, 'fetchAssetLocations').mockImplementation(async (digest) =>
      digest === first.digest ? ['/original/portrait.png', '/relocated/portrait.png'] : ['/other/portrait.png'])
    await app.openDocument({ ...document, meta: { ext: { unrelated: { keep: true } } } }, 'Assets')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    const before = JSON.stringify(tab.store.doc)
    await vi.waitFor(() => expect(app.exportDocument(tab.id)?.meta?.ext?.['dinkster.assetLocations']).toEqual({
      version: 1, observations: [
        { graph: 'g0', node: 'n0', input: 'a', index: 0, digest: first.digest,
          machine: 'Native', paths: ['/original/portrait.png', '/relocated/portrait.png'] },
        { graph: 'g0', node: 'n0', input: 'b', index: 0, digest: other.digest,
          machine: 'Native', paths: ['/other/portrait.png'] },
        { graph: 'g0', node: 'n0', input: 'b', index: 1, digest: first.digest,
          machine: 'Native', paths: ['/original/portrait.png', '/relocated/portrait.png'] },
      ],
    }))
    const saved = app.exportDocument(tab.id)!
    expect(saved.meta?.ext?.['unrelated']).toEqual({ keep: true })
    expect(JSON.stringify(tab.store.doc)).toBe(before)
    expect(tab.store.revision).toBe(0)
    const empty = app.addBackend('http://empty:8000', 'Empty library', false, 'dinkster')!
    if (empty.protocol !== 'dinkster') throw new Error('native backend required')
    vi.spyOn(empty.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(empty.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'missing' }, { digest: other.digest, status: 'missing' },
    ])
    const paths = vi.spyOn(empty.connection, 'fetchAssetLocations')
    await app.openDocument(saved, 'Reopened')
    const reopened = app.activeTab()!
    const reopenedBefore = JSON.stringify(reopened.store.doc)
    app.setTabTarget(reopened.id, empty.id)
    await vi.waitFor(() => expect(app.problems.get().filter((entry) => entry.code === 'asset.availability.missing')).toHaveLength(3))
    const hint = app.problems.get().find((entry) => entry.data?.['input'] === 'a')
    expect(hint?.data).toMatchObject({ name: 'portrait.png', backend: 'Empty library',
      lastKnownMachine: 'Native', lastKnownPaths: ['/original/portrait.png', '/relocated/portrait.png'] })
    expect(paths).not.toHaveBeenCalled()
    expect(JSON.stringify(reopened.store.doc)).toBe(reopenedBefore)
    expect(reopened.store.revision).toBe(0)
    expect(reopened.store.doc.graphs['g0']!.nodes['n0']!.values).toEqual(document.graphs.g0.nodes.n0.values)
    app.dispose()
  })

  it('anchors a missing shared-definition input to a reachable instance', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue([{ digest: first.digest, status: 'missing' }])
    expect((await app.openDocument({ ...CHAIN_DOC, graphs: {
      g0: { ...CHAIN_DOC.graphs.g0, nodes: {
        left: { id: 'left', type: '#child', values: {} }, right: { id: 'right', type: '#child', values: {} },
      }, links: {} },
      child: { ...CHAIN_DOC.graphs.g0, id: 'child', nodes: {
        reader: { id: 'reader', type: 'std.math.add_ints', values: { a: first } },
      }, links: {} },
    }, view: { graphs: {} } }, 'Nested missing asset'))).toEqual([])
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await vi.waitFor(() => expect(app.problems.get().filter((entry) => entry.code === 'asset.availability.missing')).toHaveLength(1))
    expect(app.problems.get().find((entry) => entry.code === 'asset.availability.missing')?.anchor).toEqual({
      occurrence: { instancePath: ['left'], node: 'reader' },
    })
    expect(tab.store.revision).toBe(0)
    app.dispose()
  })

  it('discards stale path reads after retarget and ignores hints for a different digest', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'available' }, { digest: other.digest, status: 'available' },
    ])
    const pending = deferred<readonly string[]>()
    const paths = vi.spyOn(backend.connection, 'fetchAssetLocations').mockReturnValue(pending.promise)
    await app.openDocument({ ...document, meta: { ext: { 'dinkster.assetLocations': { version: 1, observations: [{
      graph: 'g0', node: 'n0', input: 'a', index: 0, digest: other.digest, machine: 'Wrong identity', paths: ['/do/not/read'],
    }] } } } }, 'Assets')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await callStarted(paths)
    const empty = app.addBackend('http://empty:8000', 'Empty library', false, 'dinkster')!
    if (empty.protocol !== 'dinkster') throw new Error('native backend required')
    vi.spyOn(empty.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(empty.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'missing' }, { digest: other.digest, status: 'missing' },
    ])
    app.setTabTarget(tab.id, empty.id)
    pending.resolve(['/stale/location'])
    await vi.waitFor(() => expect(app.problems.get().filter((entry) => entry.code === 'asset.availability.missing')).toHaveLength(3))
    expect(app.problems.get().some((entry) => entry.data?.['lastKnownMachine'] !== undefined)).toBe(false)
    expect(JSON.stringify(app.exportDocument(tab.id))).not.toContain('/stale/location')
    app.dispose()
  })

  it('checks exact identities on reopen and retarget without mutating refs or unrelated problems', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'available' }, { digest: other.digest, status: 'missing' },
    ])
    expect((await app.openDocument(document, 'Assets'))).toEqual([])
    const tab = app.activeTab()!
    const before = JSON.stringify(tab.store.doc)
    const revision = tab.store.revision
    app.reportProblems(tab.id, [diag('info', 'command', 'unrelated.notice', 'Keep me')])
    app.setTabTarget(tab.id, backend.id)
    await vi.waitFor(() => expect(shownCodes(tab.id)).toContain('asset.availability.missing'))
    const missing = app.problems.get().filter((problem) => problem.code === 'asset.availability.missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({
      message: 'portrait.png is missing on Native: g0/n0/b [1].',
      refs: [{ graphId: 'g0', nodeId: 'n0', valueKey: 'b', direction: 'input' }],
      data: { digest: other.digest, index: 0 },
    })
    const empty = app.addBackend('http://empty:8000', 'Empty library', false, 'dinkster')!
    if (empty.protocol !== 'dinkster') throw new Error('native backend required')
    vi.spyOn(empty.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(empty.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'missing' }, { digest: other.digest, status: 'available' },
    ])
    app.setTabTarget(tab.id, empty.id)
    await vi.waitFor(() => expect(app.problems.get().filter((problem) => problem.code === 'asset.availability.missing')).toHaveLength(2))
    expect(shownCodes(tab.id)).toContain('unrelated.notice')
    expect(JSON.stringify(tab.store.doc)).toBe(before)
    expect(tab.store.revision).toBe(revision)
    expect(app.assetConsent.get()).toBeUndefined()
    app.dispose()
  })

  it('does not interpret failed checks as missing or publish late responses after edits and close', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    const pending = deferred<readonly { digest: string; status: 'missing' }[]>()
    const check = vi.spyOn(backend.connection, 'checkAssetAvailability').mockReturnValue(pending.promise)
    await app.openDocument(document, 'Assets')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await callStarted(check)
    check.mockRejectedValue(new Error('network unavailable'))
    expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'a', value: other,
    } })).ok).toBe(true)
    await vi.waitFor(() => expect(shownCodes(tab.id)).toContain('asset.availability.unchecked'))
    pending.resolve([{ digest: first.digest, status: 'missing' }])
    await pending.promise
    expect(shownCodes(tab.id)).not.toContain('asset.availability.missing')
    const closed = deferred<readonly { digest: string; status: 'missing' }[]>()
    check.mockReturnValue(closed.promise)
    await app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'a', value: first,
    } })
    app.closeTab(tab.id)
    closed.resolve([{ digest: first.digest, status: 'missing' }])
    await closed.promise
    expect(app.problems.get().filter((problem) => problem.owner === tab.id)).toEqual([])
    app.dispose()
  })
})

describe('late async results and dead owners', () => {
  it('blocks a stale wire-15 artifact before POST when mode changes during source upload', async () => {
    const { backend, tab } = (await nativeSetup())
    const clean = app.compileTab(tab, {
      kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }],
    })
    expect(clean?.ok).toBe(true)
    if (!clean?.ok) return
    const gate = diag(
      'error',
      'compile',
      'compile.wire15.modesUnsupported',
      'wire-15 mode gate',
      { anchor: { occurrence: { instancePath: [], node: asNodeId('n1') } } },
    )
    const compileSpy = vi.spyOn(app, 'compileTab').mockImplementation(() =>
      tab.store.revision === 0 ? clean : { ok: false, diagnostics: [gate] })
    const upload = deferred<string>()
    const uploadSpy = vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const submitSpy = vi.spyOn(backend.connection, 'submit')

    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(uploadSpy)
    expect((await app.dispatchTo(tab, {
      command: 'node.setMode',
      params: { graphId: 'g0', nodeIds: ['n0'], mode: 'bypassed' },
    })).ok).toBe(true)
    upload.resolve('blake3:' + 'a'.repeat(64))
    await queueing

    expect(compileSpy).toHaveBeenCalledTimes(2)
    expect(submitSpy).not.toHaveBeenCalled()
    expect(shownCodes(tab.id)).toEqual(['compile.wire15.modesUnsupported'])
  })

  it('blocks a retired session artifact before POST even when its revision is unchanged', async () => {
    const { backend, tab } = (await nativeSetup())
    const upload = deferred<string>()
    const uploadSpy = vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const submitSpy = vi.spyOn(backend.connection, 'submit')
    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(uploadSpy)
    expect((await app.openDocument(CHAIN_DOC, 'replacement'))).toEqual([])
    expect(app.activeTab()).not.toBe(tab)
    upload.resolve('blake3:' + 'a'.repeat(64))
    await queueing
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('blocks a retired session captured-body retry before transport', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const retryWithAssets = vi.fn()
    vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [],
      assetsMissing: {
        error: 'assets-missing',
        assets: [{ digest: 'blake3:model', name: 'Model', status: 'missing', sources: [], fetchable: false }],
      },
      retryWithAssets,
    })
    await app.queueSelection(tab, ['n1'])
    const request = app.assetConsent.get()
    expect(request).toBeDefined()
    expect((await app.openDocument(CHAIN_DOC, 'replacement'))).toEqual([])
    expect(app.activeTab()).not.toBe(tab)
    await request!.retry(['blake3:model'])
    expect(retryWithAssets).not.toHaveBeenCalled()
    expect(app.assetConsent.get()).toBeUndefined()
  })

  it('a submit rejection retains compile warnings alongside validation errors', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const compiled = app.compileTab(tab, {
      kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }],
    })
    expect(compiled?.ok).toBe(true)
    if (!compiled?.ok) return
    const warning = diag('warning', 'compile', 'compile.input.missing', 'compile warning', { blocksExecution: true })
    vi.spyOn(app, 'compileTab').mockReturnValue({
      ok: true,
      artifact: { ...compiled.artifact, diagnostics: [warning] },
    })
    vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [diag('error', 'validation', 'validation.bad-input', 'runtime validation error')],
    })

    await app.queueSelection(tab, ['n1'])

    expect(shownCodes(tab.id)).toEqual(['compile.input.missing', 'validation.bad-input'])
  })

  it('a save failing after its tab closed reports nothing (no resurrected owner)', async () => {
    const { backend, tab } = (await nativeSetup())
    const upload = deferred<string>()
    const spy = vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const saving = app.saveWorkflow(tab.id)
    await callStarted(spy)
    app.closeTab(tab.id)
    upload.reject(new Error('network died late'))
    expect(await saving).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'library.saveFailed')).toBe(false)
    expect(app.problems.get().some((d) => d.owner === tab.id)).toBe(false)
  })

  it('a queue rejection landing after a same-lineage replacement does not clobber it', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = deferred<{ ok: false; diagnostics: readonly unknown[] }>()
    const submitSpy = vi.spyOn(backend.connection, 'submit').mockReturnValue(submit.promise as never)
    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(submitSpy)
    expect((await app.openDocument(CHAIN_DOC, 'Chain (reopened)'))).toEqual([])
    const replacement = app.activeTab()!
    app.reportProblems(replacement.id, [diag('info', 'command', 'replacement.keeps', 'stays')])
    submit.resolve({ ok: false, diagnostics: [diag('error', 'validation', 'late.rejection', 'from the dead session')] })
    await queueing
    const owned = app.problems.get().filter((d) => d.owner === replacement.id).map((d) => d.code)
    expect(owned).toContain('replacement.keeps') // late replace did not clobber
    expect(owned).not.toContain('late.rejection') // ... nor inject
  })

  it('a late assetsMissing response never installs a consent dialog for a dead session', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = deferred<unknown>()
    const submitSpy = vi.spyOn(backend.connection, 'submit').mockReturnValue(submit.promise as never)
    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(submitSpy)
    app.closeTab(tab.id)
    submit.resolve({
      ok: false,
      diagnostics: [],
      assetsMissing: { assets: [{ digest: 'blake3:abc', name: 'Model', status: 'missing', sources: [], fetchable: false }] },
      retryWithAssets: async () => { throw new Error('never retried') },
    })
    await queueing
    expect(app.assetConsent.get()).toBeUndefined()
  })
})
