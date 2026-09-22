/**
 * Problems ownership: every entry belongs to a tab id or an app-scoped
 * symbol. The panel shows visible tabs plus every app-scoped owner, so one
 * workflow's diagnostics never bleed into another tab even when both
 * documents use the same graph ids.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, GLOBAL_PROBLEMS_OWNER, visibleProblems, type Backend, type Tab } from '../src/app-state.js'
import { asNodeId, diag, type DinksterNodesPayload } from '@dinkster/core'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes.json'), 'utf8'),
) as DinksterNodesPayload

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

let app: AppState

beforeEach(() => {
  app = new AppState()
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

const open = (lineage: string): Tab => {
  expect(app.openDocument(docJson(lineage), lineage)).toEqual([])
  return app.activeTab()!
}

/** The projection a single-visible-canvas shell renders for one active tab. */
const shownCodes = (activeTabId: string): readonly string[] =>
  visibleProblems(app.problems.get(), new Set([activeTabId])).map((d) => d.code)

describe('problems ownership', () => {
  it('deduplicates report ingress and accepts an entry again after clearing', () => {
    const tab = open('lin-dedupe')
    const diagnostic = diag('warning', 'command', 'boundary.bindKind', 'family forwarding cannot fan out')
    app.reportProblems(tab.id, [diagnostic])
    app.reportProblems(tab.id, [diagnostic])
    expect(app.problems.get().filter((entry) => entry.code === diagnostic.code)).toHaveLength(1)

    open('lin-dedupe')
    expect(app.problems.get().filter((entry) => entry.code === diagnostic.code)).toHaveLength(0)
    app.reportProblems(tab.id, [diagnostic])
    expect(app.problems.get().filter((entry) => entry.code === diagnostic.code)).toHaveLength(1)
  })

  it('replacement batches retain anchor-distinct diagnostics with identical codes and messages', () => {
    const tab = open('lin-replace-anchors')
    const first = diag('error', 'compile', 'compile.schema.unknown', "unknown node type 'Missing'", { anchor: { occurrence: { instancePath: [], node: asNodeId('a') } } })
    const second = diag('error', 'compile', 'compile.schema.unknown', "unknown node type 'Missing'", { anchor: { occurrence: { instancePath: [], node: asNodeId('b') } } })
    app.replaceProblems(tab.id, [first, second])
    const retained = app.problems.get().filter((entry) => entry.code === 'compile.schema.unknown')
    expect(retained).toHaveLength(2)
    expect(retained.map((entry) => entry.anchor?.occurrence?.node)).toEqual(['a', 'b'])
  })

  it('hides an inactive workflow\'s diagnostics and shows them again on switch', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    app.reportProblems(a.id, [diag('error', 'compile', 'compile.tap.novalue', 'from A')])
    app.reportProblems(b.id, [diag('warning', 'compile', 'compile.input.missing', 'from B')])
    expect(shownCodes(a.id)).toEqual(['compile.tap.novalue'])
    expect(shownCodes(b.id)).toEqual(['compile.input.missing'])
  })

  it('does not cross-contaminate two documents that both use graph g0', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    // Both diagnostics NAME the same graph id; ownership is the tab, never
    // the graph id, so each panel shows exactly its own entry.
    app.reportProblems(a.id, [diag('error', 'compile', 'compile.tap.novalue', "widget tap 'n15.value' in graph 'g0' has no value")])
    app.reportProblems(b.id, [diag('error', 'compile', 'compile.tap.novalue', "widget tap 'n2.value' in graph 'g0' has no value")])
    const shownForA = visibleProblems(app.problems.get(), new Set([a.id]))
    expect(shownForA).toHaveLength(1)
    expect(shownForA[0]!.message).toContain('n15')
  })

  it('keeps app-scoped globals visible regardless of the active tab', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'schema', 'schema.fetchFailed', 'backend down')])
    expect(shownCodes(a.id)).toContain('schema.fetchFailed')
    expect(shownCodes(b.id)).toContain('schema.fetchFailed')
  })

  it('replaces and clears an independent symbol-owned app snapshot', () => {
    const appOwner = Symbol('provider-problems')
    const otherOwner = Symbol('other-app-problems')
    const tab = open('lin-symbol-owner')
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

  it('drops a closed tab\'s diagnostics and keeps everyone else\'s', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    app.reportProblems(a.id, [diag('error', 'compile', 'a.problem', 'A')])
    app.reportProblems(b.id, [diag('error', 'compile', 'b.problem', 'B')])
    app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'schema', 'global.problem', 'G')])
    app.closeTab(b.id)
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).toContain('a.problem')
    expect(codes).toContain('global.problem')
    expect(codes).not.toContain('b.problem')
  })

  it('replacing a document (same lineage) replaces its diagnostics, not others\'', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    app.reportProblems(a.id, [diag('error', 'compile', 'a.stale', 'stale A')])
    app.reportProblems(b.id, [diag('error', 'compile', 'b.keeps', 'B keeps this')])
    open('lin-a') // same lineage -> same tab id -> entries replaced by load diagnostics ([])
    const codes = app.problems.get().map((d) => d.code)
    expect(codes).not.toContain('a.stale')
    expect(codes).toContain('b.keeps')
  })

  it('a multi-visible owner set shows both workflows\' diagnostics at once', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    app.reportProblems(a.id, [diag('error', 'compile', 'a.problem', 'A')])
    app.reportProblems(b.id, [diag('error', 'compile', 'b.problem', 'B')])
    const codes = visibleProblems(app.problems.get(), new Set([a.id, b.id])).map((d) => d.code)
    expect(codes).toContain('a.problem')
    expect(codes).toContain('b.problem')
  })

  it('rejected commands land under the dispatching tab', () => {
    const a = open('lin-a')
    open('lin-b')
    const outcome = app.dispatchTo(a, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'missing', inputId: 'x', value: 1 } })
    expect(outcome.ok).toBe(false)
    const owned = app.problems.get().filter((d) => d.owner === a.id)
    expect(owned.length).toBeGreaterThan(0)
    // ... and the OTHER tab's projection does not show them.
    expect(visibleProblems(app.problems.get(), new Set([app.activeTabId.get()]))).toEqual([])
  })

  it('a tab whose lineage spells an app-ish sentinel is still just a tab, never global', () => {
    // The global owner is a unique symbol, so no document lineage (which
    // becomes the tab id) can collide with it - not even one named '#app'.
    const impostor = open('#app')
    app.reportProblems(impostor.id, [diag('error', 'compile', 'impostor.problem', 'not global')])
    app.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'schema', 'really.global', 'global')])
    // With NO visible canvases, only true globals project.
    const codes = visibleProblems(app.problems.get(), new Set()).map((d) => d.code)
    expect(codes).toEqual(['really.global'])
    // Another tab's projection does not show the impostor's entry either.
    const b = open('lin-b')
    expect(shownCodes(b.id)).toEqual(['really.global'])
  })

  it('owner-scoped replacement does not re-log other owners\' retained entries', () => {
    const a = open('lin-a')
    const b = open('lin-b')
    app.reportProblems(a.id, [diag('error', 'compile', 'a.stale', 'stale A message')])
    app.reportProblems(b.id, [diag('error', 'compile', 'b.keeps', 'B retained message')])
    const logged = (): number => app.logs.get().filter((l) => l.message.includes('B retained message')).length
    expect(logged()).toBe(1)
    // Same-lineage replacement replaces A's entries (reordering the problems
    // array); B's retained entry object must not be logged a second time.
    open('lin-a')
    expect(logged()).toBe(1)
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
function nativeSetup(): { backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab } {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect(app.openDocument(CHAIN_DOC, 'Chain')).toEqual([])
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

describe('late async results and dead owners', () => {
  it('blocks a stale wire-15 artifact before POST when mode changes during source upload', async () => {
    const { backend, tab } = nativeSetup()
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
    expect(app.dispatchTo(tab, {
      command: 'node.setMode',
      params: { graphId: 'g0', nodeIds: ['n0'], mode: 'bypassed' },
    }).ok).toBe(true)
    upload.resolve('blake3:' + 'a'.repeat(64))
    await queueing

    expect(compileSpy).toHaveBeenCalledTimes(2)
    expect(submitSpy).not.toHaveBeenCalled()
    expect(shownCodes(tab.id)).toEqual(['compile.wire15.modesUnsupported'])
  })

  it('does not recompile before POST while the compiled document object is unchanged', async () => {
    const { backend, tab } = nativeSetup()
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [diag('error', 'validation', 'submit.expected', 'stop after POST')],
    })
    const compileSpy = vi.spyOn(app, 'compileTab')
    await app.queueSelection(tab, ['n1'])
    expect(compileSpy).toHaveBeenCalledOnce()
  })

  it('blocks a retired session artifact before POST even when its revision is unchanged', async () => {
    const { backend, tab } = nativeSetup()
    const upload = deferred<string>()
    const uploadSpy = vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const submitSpy = vi.spyOn(backend.connection, 'submit')
    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(uploadSpy)
    expect(app.openDocument(CHAIN_DOC, 'replacement')).toEqual([])
    expect(app.activeTab()).not.toBe(tab)
    upload.resolve('blake3:' + 'a'.repeat(64))
    await queueing
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('blocks a captured asset-consent retry when current state enters the wire-15 mode gate', async () => {
    const { backend, tab } = nativeSetup()
    const clean = app.compileTab(tab, {
      kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }],
    })
    expect(clean?.ok).toBe(true)
    if (!clean?.ok) return
    const gate = diag('error', 'compile', 'compile.wire15.modesUnsupported', 'wire-15 mode gate')
    const compileSpy = vi.spyOn(app, 'compileTab').mockImplementation(() =>
      tab.store.revision === 0 ? clean : { ok: false, diagnostics: [gate] })
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
    expect(app.assetConsent.get()).toBeDefined()
    expect(app.dispatchTo(tab, {
      command: 'node.setMode',
      params: { graphId: 'g0', nodeIds: ['n0'], mode: 'bypassed' },
    }).ok).toBe(true)
    await app.assetConsent.get()!.retry(['blake3:model'])

    expect(compileSpy).toHaveBeenCalledTimes(2)
    expect(retryWithAssets).not.toHaveBeenCalled()
    expect(app.assetConsent.get()).toBeUndefined()
    expect(shownCodes(tab.id)).toEqual(['compile.wire15.modesUnsupported'])
  })

  it('blocks a retired session captured-body retry before transport', async () => {
    const { backend, tab } = nativeSetup()
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
    expect(app.openDocument(CHAIN_DOC, 'replacement')).toEqual([])
    expect(app.activeTab()).not.toBe(tab)
    await request!.retry(['blake3:model'])
    expect(retryWithAssets).not.toHaveBeenCalled()
    expect(app.assetConsent.get()).toBeUndefined()
  })

  it('a submit rejection retains compile warnings alongside validation errors', async () => {
    const { backend, tab } = nativeSetup()
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
    const { backend, tab } = nativeSetup()
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

  it('a save failing after a same-lineage replacement does not blame the replacement', async () => {
    const { backend, tab } = nativeSetup()
    const upload = deferred<string>()
    const spy = vi.spyOn(backend.connection, 'uploadAsset').mockReturnValue(upload.promise)
    const saving = app.saveWorkflow(tab.id)
    await callStarted(spy)
    // Same lineage -> same tab id, but a NEW Tab object (new session).
    expect(app.openDocument(CHAIN_DOC, 'Chain (reopened)')).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)
    expect(replacement).not.toBe(tab)
    upload.reject(new Error('network died late'))
    expect(await saving).toBe(false)
    // The replacement session owns no entry from the dead session's save.
    expect(app.problems.get().some((d) => d.code === 'library.saveFailed')).toBe(false)
  })

  it('a queue transport failure after its tab closed reports nothing', async () => {
    const { backend, tab } = nativeSetup()
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = deferred<never>()
    const submitSpy = vi.spyOn(backend.connection, 'submit').mockReturnValue(submit.promise)
    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(submitSpy)
    app.closeTab(tab.id)
    submit.reject(new Error('socket dropped late'))
    await queueing
    expect(app.problems.get().some((d) => d.code === 'submit.transportFailed')).toBe(false)
    expect(app.problems.get().some((d) => d.owner === tab.id)).toBe(false)
  })

  it('a queue rejection landing after a same-lineage replacement does not clobber it', async () => {
    const { backend, tab } = nativeSetup()
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue('blake3:' + 'a'.repeat(64))
    const submit = deferred<{ ok: false; diagnostics: readonly unknown[] }>()
    const submitSpy = vi.spyOn(backend.connection, 'submit').mockReturnValue(submit.promise as never)
    const queueing = app.queueSelection(tab, ['n1'])
    await callStarted(submitSpy)
    expect(app.openDocument(CHAIN_DOC, 'Chain (reopened)')).toEqual([])
    const replacement = app.activeTab()!
    app.reportProblems(replacement.id, [diag('info', 'command', 'replacement.keeps', 'stays')])
    submit.resolve({ ok: false, diagnostics: [diag('error', 'validation', 'late.rejection', 'from the dead session')] })
    await queueing
    const owned = app.problems.get().filter((d) => d.owner === replacement.id).map((d) => d.code)
    expect(owned).toContain('replacement.keeps') // late replace did not clobber
    expect(owned).not.toContain('late.rejection') // ... nor inject
  })

  it('a late assetsMissing response never installs a consent dialog for a dead session', async () => {
    const { backend, tab } = nativeSetup()
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
