/**
 * Problems ownership: every entry belongs to a tab id or an app-scoped
 * symbol. The panel shows visible tabs plus every app-scoped owner, so one
 * workflow's diagnostics never bleed into another tab even when both
 * documents use the same graph ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry, type ModelPresence } from '@dinkster/client'
import { AppState, GLOBAL_PROBLEMS_OWNER, visibleProblems, type Backend, type Tab } from '../src/app-state.js'
import { asNodeId, diag, DINKSTER_SCHEMA_WIRE_VERSION, type DinksterNodesPayload, type InputSpec, type Json, type NodeSchema } from '@dinkster/core'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { deriveProblemProjection } from '../src/problem-display.js'

const INT = { kind: 'concrete', types: ['INT'] }
const nodesPayload: DinksterNodesPayload = {
  schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
  nodes: {
    'std.math.add_ints': {
      nodeType: 'std.math.add_ints', schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, version: 1,
      displayName: 'Add Ints', category: 'math', description: '', idempotent: true,
      body: [
        { kind: 'input', id: 'a', required: true, type: INT },
        { kind: 'input', id: 'b', required: true, default: 1, type: INT },
        { kind: 'output', id: 'sum', type: INT },
      ],
    },
  },
}

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

describe('workflow model presence', () => {
  const field = (id: string, kind = 'model/checkpoint'): InputSpec => ({
    kind: 'input', id, optional: false, type: { kind: 'concrete', name: 'ASSET' },
    widget: { widgetType: 'ASSET', kind, options: {} },
  })
  const setup = async (values: Record<string, Json>, body: NodeSchema['body'] = Object.keys(values).map((id) => field(id))) => {
    const { backend } = await nativeSetup()
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'guessAssets').mockResolvedValue([])
    const schema: NodeSchema = { type: 'ModelLoader', displayName: 'Load model', category: 'test', source: 'v3', isOutputNode: false, body }
    backend.registry.set({ ...backend.registry.get()!, resolve: (type) => type === schema.type ? schema : undefined,
      schemas: new Map([[schema.type, schema]]) })
    const presence = vi.spyOn(backend.connection, 'checkModelPresence').mockImplementation(async (wanted) =>
      wanted.map((model) => ({ ...model, status: 'missing', plannable: true })))
    await app.openDocument({ ...CHAIN_DOC, lineage: 'models', graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: { n0: { id: 'n0', type: schema.type, values } }, links: {},
    } } }, 'Models')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    return { backend, tab, presence }
  }
  const models = (tab: Tab) => app.problems.get().filter((entry) => entry.owner === tab.id && entry.code.startsWith('model.availability.'))

  it('keeps every affected row when two fields and two nodes use the same missing model', async () => {
    const { backend } = await setup({ first: 'same.safetensors', second: 'same.safetensors' })
    await app.openDocument({ ...CHAIN_DOC, lineage: 'repeated-model', graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: {
        n0: { id: 'n0', type: 'ModelLoader', values: { first: 'same.safetensors', second: 'same.safetensors' } },
        n1: { id: 'n1', type: 'ModelLoader', values: { first: 'same.safetensors', second: 'same.safetensors' } },
      }, links: {},
    } } }, 'Repeated model')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await vi.waitFor(() => expect(models(tab)).toHaveLength(4))
    const projection = deriveProblemProjection({ diagnostics: models(tab), document: tab.store.doc, graphId: 'g0', instancePath: [] })
    expect(projection.rows).toEqual({ n0: { first: 'error', second: 'error' }, n1: { first: 'error', second: 'error' } })
    for (const diagnostic of models(tab)) {
      app.reviewModelDownload(tab, diagnostic)
      expect(app.assetConsent.get()?.models?.[0]?.requirement).toEqual({ name: 'same.safetensors', kind: 'model/checkpoint' })
      app.assetConsent.set(undefined)
    }
  })

  it.each([true, false])('checks each subgraph instance value and excludes wired and unused values (promoted: %s)', async (promoted) => {
    const { backend, presence } = await setup({ model: 'source.safetensors' }, [field('model'),
      { kind: 'input', id: 'strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
        widget: { widgetType: 'FLOAT', options: {}, default: 1 } },
      { kind: 'output', id: 'asset', type: { kind: 'concrete', name: 'ASSET' } },
    ])
    presence.mockImplementation(async (wanted) => wanted.map((model) => ({ ...model,
      status: model.name === 'left.safetensors' ? 'missing' as const : 'local' as const, plannable: true })))
    const inner = { id: 'inner', name: 'Model group', nodes: {
      loader: { id: 'loader', type: 'ModelLoader', values: { model: 'unused-definition.safetensors', strength: 1 } },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      boundary: { inputs: [{ id: 'model', promoted, binds: { kind: 'port', node: 'loader', port: 'model' } },
        { id: 'strength', promoted: true, binds: { kind: 'port', node: 'loader', port: 'strength' } }], outputs: [] } }
    await app.openDocument({ ...CHAIN_DOC, lineage: 'instance-models', graphs: {
      g0: { ...CHAIN_DOC.graphs.g0, nodes: {
        source: { id: 'source', type: 'ModelLoader', values: { model: 'source.safetensors' } },
        left: { id: 'left', type: '#inner', values: { model: 'left.safetensors', strength: 0.5 } },
        right: { id: 'right', type: '#inner', values: { model: 'right.safetensors', strength: 0.75 } },
        wired: { id: 'wired', type: '#inner', values: { model: 'ignored-wired.safetensors' } },
        muted: { id: 'muted', type: '#inner', mode: 'muted', values: { model: 'ignored-muted.safetensors' } },
      }, links: { l1: { id: 'l1', from: { node: 'source', port: 'asset' }, to: { node: 'wired', port: 'model' } } } },
      inner, unused: { ...inner, id: 'unused' },
    } }, 'Instance models')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await vi.waitFor(() => expect(models(tab).map((entry) => entry.data?.['name'])).toEqual(['left.safetensors']))
    expect(models(tab)[0]?.anchor?.occurrence).toEqual({ instancePath: ['left'], node: 'loader' })
    expect(presence.mock.calls.at(-1)?.[0].map((entry) => entry.name)).toEqual([
      'source.safetensors', 'left.safetensors', 'right.safetensors',
    ])
    const projection = (instance: string) => deriveProblemProjection({ diagnostics: models(tab), document: tab.store.doc,
      graphId: 'inner', instancePath: [instance] }).rows
    expect(projection('left')).toEqual({ loader: { model: 'error' } })
    expect(projection('right')).toEqual({})
    expect(projection('wired')).toEqual({})
  })

  it('reports the model binding reason on its row without submitting a run or creating a review', async () => {
    const { backend, tab, presence } = await setup({ missing: 'absent.safetensors', hidden: 'hidden.safetensors',
      disabled: 'disabled.safetensors', duplicate: 'duplicate.safetensors', invalid: '../bad', local: 'local.safetensors' })
    presence.mockImplementation(async (wanted) => wanted.map((model): ModelPresence => {
      if (model.name === 'hidden.safetensors') return { ...model, status: 'model-hidden' }
      if (model.name === 'disabled.safetensors') return { ...model, status: 'folder-disabled', disabledLocations: ['Archive', 'Shared'] }
      if (model.name === 'duplicate.safetensors') return { ...model, status: 'duplicate' }
      if (model.name === 'local.safetensors') return { ...model, status: 'local' }
      return { ...model, status: 'missing', plannable: true }
    }))
    backend.connection.ingest({ type: 'mounts_changed' })
    await vi.waitFor(() => expect(models(tab).map((entry) => entry.code).sort()).toEqual([
      'model.availability.duplicate', 'model.availability.folder-disabled', 'model.availability.invalid',
      'model.availability.missing', 'model.availability.model-hidden',
    ]))
    expect(models(tab).find((entry) => entry.code === 'model.availability.folder-disabled')?.message)
      .toBe('disabled.safetensors is in a folder this project does not use: Archive and 1 more.')
    const missing = models(tab).find((entry) => entry.code === 'model.availability.missing')!
    expect(missing.severity).toBe('error')
    expect(missing.message).toBe('absent.safetensors is not in a model folder this project uses on Native.')
    expect(missing.refs).toEqual([{ graphId: 'g0', nodeId: 'n0', valueKey: 'missing', direction: 'input' }])
    expect(missing.anchor).toEqual({ occurrence: { instancePath: [], node: 'n0' } })
    expect(app.assetConsent.get()).toBeUndefined()
    expect(app.store.executions.get().size).toBe(0)
  })

  it('reviews only the selected model without a run and cancels when its document changes', async () => {
    const { backend, tab } = await setup({ first: 'first.safetensors', second: 'second.safetensors' })
    await vi.waitFor(() => expect(models(tab)).toHaveLength(2))
    const diagnostic = models(tab).find((entry) => entry.data?.['name'] === 'second.safetensors')!
    vi.spyOn(backend.connection, 'planModelDownload').mockResolvedValue({ status: 'destination-required' })
    vi.spyOn(backend.connection, 'fetchModelDownloads').mockResolvedValue({ instance: 'test', jobs: [] })
    app.reviewModelDownload(tab, diagnostic)
    const request = app.assetConsent.get()!
    expect(request.models).toHaveLength(1)
    expect(request.models?.[0]?.requirement).toEqual({ name: 'second.safetensors', kind: 'model/checkpoint' })
    expect(request.retry).toBeUndefined()
    expect(app.store.executions.get().size).toBe(0)
    await app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'second', value: 'replacement.safetensors',
    } })
    expect(app.assetConsent.get()).toBeUndefined()
    app.reviewModelDownload(tab, diagnostic)
    expect(app.assetConsent.get()).toBeUndefined()
  })

  it('checks active flattened model fields, not dormant choices, media, selections or digest references', async () => {
    const { tab } = await setup({ 'files.model': 'active.safetensors', media: 'picture.png', selection: 'baked-in',
      digest: { digest: 'blake3:' + 'a'.repeat(64), name: 'stored.safetensors', size: 1, mediaType: 'application/octet-stream', virtualPath: 'models/stored.safetensors' },
      'mode.offline': 'dormant.safetensors',
    }, [
      { kind: 'group', id: 'files', value: field('file'), keys: { kind: 'named', names: ['model'] }, grows: 'button', minMembers: 1, maxMembers: 1 }, field('media', 'media/image'),
      { ...field('selection', 'model/vae'), widget: { ...field('selection').widget!, selection: true } }, field('digest'),
      { kind: 'choice', id: 'mode', shared: [], required: true, options: [{ key: 'online', label: 'Online', rows: [] }, { key: 'offline', label: 'Offline', rows: [field('offline')] }], default: 'online' },
    ])
    await vi.waitFor(() => expect(models(tab).filter((entry) => entry.code === 'model.availability.missing')).toHaveLength(1))
    expect(models(tab)[0]?.data?.['input']).toBe('files.model')
    expect(models(tab)[0]?.data?.['name']).toBe('active.safetensors')
  })

  it('ignores an old document response and refreshes mount changes without acquiring anything', async () => {
    const { backend, tab, presence } = await setup({ model: 'first.safetensors' })
    await vi.waitFor(() => expect(models(tab)[0]?.data?.['name']).toBe('first.safetensors'))
    const old = deferred<readonly ModelPresence[]>()
    presence.mockReturnValueOnce(old.promise)
    backend.connection.ingest({ type: 'mounts_changed' })
    expect(models(tab)[0]?.data?.['name']).toBe('first.safetensors')
    await app.dispatchTo(tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n0', inputId: 'model', value: 'second.safetensors' } })
    await vi.waitFor(() => expect(models(tab)[0]?.data?.['name']).toBe('second.safetensors'))
    old.resolve([{ name: 'first.safetensors', kind: 'model/checkpoint', status: 'missing', plannable: true }])
    await Promise.resolve()
    expect(models(tab)[0]?.data?.['name']).toBe('second.safetensors')
    presence.mockImplementation(async (wanted) => wanted.map((model) => ({ ...model, status: 'local' })))
    backend.connection.ingest({ type: 'mounts_changed' })
    await vi.waitFor(() => expect(models(tab)).toEqual([]))
    expect(tab.store.doc.graphs['g0']?.nodes['n0']?.values['model']).toBe('second.safetensors')
    expect(app.assetConsent.get()).toBeUndefined()
  })

  it('ignores a wired model field even when its stored name is missing', async () => {
    const { backend } = await setup({ model: 'source.safetensors' }, [field('model'),
      { kind: 'output', id: 'asset', type: { kind: 'concrete', name: 'ASSET' } },
    ])
    await app.openDocument({ ...CHAIN_DOC, lineage: 'wired-models', graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: {
        n0: { id: 'n0', type: 'ModelLoader', values: { model: 'source.safetensors' } },
        n1: { id: 'n1', type: 'ModelLoader', values: { model: 'ignored.safetensors' } },
      },
      links: { l2: { id: 'l2', from: { node: 'n0', port: 'asset' }, to: { node: 'n1', port: 'model' } } },
    } } }, 'Wired models')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await vi.waitFor(() => expect(models(tab).map((entry) => entry.data?.['name'])).toEqual(['source.safetensors']))
    expect(models(tab)[0]?.data?.['node']).toBe('n0')
  })

  it('cancels standalone review and rejects its old actions after changing the target backend', async () => {
    const { backend, tab } = await setup({ model: 'first.safetensors' })
    await vi.waitFor(() => expect(models(tab)).toHaveLength(1))
    const diagnostic = models(tab)[0]!
    app.reviewModelDownload(tab, diagnostic)
    const request = app.assetConsent.get()!
    expect(request.models?.[0]?.requirement.name).toBe('first.safetensors')
    const other = app.backends.get().find((entry) => entry.id !== backend.id)!
    app.setTabTarget(tab.id, other.id)
    expect(app.assetConsent.get()).toBeUndefined()
    await request.reviewModel!(0)
    app.reviewModelDownload(tab, diagnostic)
    expect(app.assetConsent.get()).toBeUndefined()
    expect(models(tab)).toEqual([])
    expect(app.store.executions.get().size).toBe(0)
  })
})

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

  it('refreshes peer asset changes without replacing dirty documents or unrelated diagnostics', async () => {
    const { backend } = await nativeSetup()
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    const check = vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue([
      { digest: first.digest, status: 'missing' }, { digest: other.digest, status: 'missing' },
    ])
    vi.spyOn(backend.connection, 'fetchAssetLocations').mockResolvedValue(['/peer/portrait.png'])
    await app.openDocument(document, 'Assets')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    await app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'a', value: 37,
    } })
    await vi.waitFor(() => expect(shownCodes(tab.id)).toContain('asset.availability.missing'))
    app.reportProblems(tab.id, [diag('info', 'command', 'unrelated.notice', 'Keep me')])
    const before = JSON.stringify(tab.store.doc)
    const revision = tab.store.revision
    expect(app.dirtyTabs.get().has(tab.id)).toBe(true)

    const unrelated = app.addBackend('http://other:8000', 'Other library', false, 'dinkster')!
    if (unrelated.protocol !== 'dinkster') throw new Error('native backend required')
    check.mockResolvedValue([
      { digest: first.digest, status: 'available' }, { digest: other.digest, status: 'available' },
    ])
    unrelated.connection.ingest({ type: 'library_changed' })
    expect(shownCodes(tab.id)).toContain('asset.availability.missing')
    backend.connection.ingest({ type: 'library_changed' })
    await vi.waitFor(() => expect(shownCodes(tab.id)).not.toContain('asset.availability.missing'))
    expect(shownCodes(tab.id)).toContain('unrelated.notice')
    expect(JSON.stringify(tab.store.doc)).toBe(before)
    expect(tab.store.revision).toBe(revision)
    expect(app.dirtyTabs.get().has(tab.id)).toBe(true)

    check.mockResolvedValue([
      { digest: first.digest, status: 'missing' }, { digest: other.digest, status: 'missing' },
    ])
    backend.connection.ingest({ type: 'library_changed' })
    await vi.waitFor(() => expect(shownCodes(tab.id)).toContain('asset.availability.missing'))
    expect(JSON.stringify(tab.store.doc)).toBe(before)
    expect(tab.store.revision).toBe(revision)
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
    await request!.retry!(['blake3:model'])
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
