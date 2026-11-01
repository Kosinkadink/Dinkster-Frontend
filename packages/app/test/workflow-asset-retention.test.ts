import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MASK_PAINT_SOURCE_EXT_KEY, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asValueSourceId, coreCommandRegistry, createLocalSession,
  type GraphDef, type NodeSchema, type WorkflowDocument,
} from '@dinkster/core'
import type { DinksterConnection, RetainedAssets, RetainedAssetOwner, RetainedAssetDeclaration } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { admitWorkflowDispatch, workflowAssetRoots } from '../src/workflow-asset-retention.js'

const asset = (letter: string) => ({ digest: `blake3:${letter.repeat(64)}`, name: `${letter}.bin`,
  size: 7, mediaType: 'application/octet-stream', virtualPath: '' })
const schema: NodeSchema = {
  type: 'Loader', displayName: 'Loader', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'files', optional: false,
    type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } } }],
}
const resolve = (type: string) => type === 'Loader' ? schema : undefined
function session() {
  const document: WorkflowDocument = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('retention'), root: asGraphDefId('g0'),
    graphs: { g0: { id: asGraphDefId('g0'), name: 'Root', nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: { files: [asset('a')] } },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } }, view: { graphs: {} },
  }
  return createLocalSession(document, coreCommandRegistry([], resolve))
}
const replace = (letter: string) => ({ command: 'node.setValue', params: {
  graphId: 'g0', nodeId: 'n0', inputId: 'files', value: [asset(letter)],
} })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('retained app dispatch', () => {
  let app: AppState | undefined
  afterEach(() => {
    app?.dispose()
    app = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['accepted', 'edited', 'registry', 'target', 'closed', 'unwanted', 'refused'] as const)(
    'publishes only a current acknowledged candidate: %s', async (scenario) => {
      const storage = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        get length() { return storage.size },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => [...storage.keys()][index] ?? null,
        removeItem: (key: string) => { storage.delete(key) },
        setItem: (key: string, value: string) => { storage.set(key, value) },
      } satisfies Storage)
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = new AppState()
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      const registry = {
        connection: backend.id, diagnostics: [], hash: 'test',
        schemas: new Map([[schema.type, schema]]), resolve,
      }
      backend.registry.set(registry)
      expect(app.openDocument(session().doc, 'Retained workflow')).toEqual([])
      const tab = app.activeTab()!
      app.setTabTarget(tab.id, backend.id)
      const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
      const acknowledged = deferred<RetainedAssets>()
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        requested.resolve({ owner, declaration })
        return acknowledged.promise
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      let wanted = true
      const before = tab.store.doc
      const operation = app.dispatchRetainedTo(tab, replace('b'), () => wanted)
      const { owner, declaration } = await requested.promise
      expect(declaration.digests).toEqual([asset('a').digest, asset('b').digest])
      expect(tab.store.doc).toBe(before)
      expect(tab.store.canUndo).toBe(false)
      if (scenario === 'edited') expect(tab.store.dispatch(replace('c')).ok).toBe(true)
      if (scenario === 'registry') backend.registry.set({ ...registry, hash: 'changed' })
      if (scenario === 'target') {
        const other = app.addBackend('http://other:8000', 'Other', false, 'dinkster')!
        other.registry.set({ ...registry, connection: other.id })
        app.setTabTarget(tab.id, other.id)
      }
      if (scenario === 'closed') app.closeTab(tab.id)
      if (scenario === 'unwanted') wanted = false
      acknowledged.resolve({ ...owner, ...declaration, revision: 1,
        ...(scenario === 'refused' ? { complete: false } : {}) })
      expect((await operation).ok).toBe(scenario === 'accepted')
      expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(
        scenario === 'accepted' ? 'b' : scenario === 'edited' ? 'c' : 'a',
      )])
      expect(tab.store.canUndo).toBe(scenario === 'accepted' || scenario === 'edited')
      if (scenario === 'accepted') {
        expect(tab.store.undo()).toBe(true)
        expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
        expect(tab.store.redo()).toBe(true)
        expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
      }
    },
  )
})

describe('workflow candidate admission', () => {
  const assetType = { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } as const
  const assetInput = (id: string, letter: string) => ({ kind: 'input' as const, id,
    type: assetType, optional: true, widget: { widgetType: 'ASSET' as const, options: {}, default: asset(letter) } })
  const dynamicSchema: NodeSchema = { ...schema, items: [
    { kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
      dynamic: { kind: 'dynamicCombo', options: [
        { key: 'a', inputs: [assetInput('file', 'a')] },
        { key: 'b', inputs: [assetInput('file', 'b')] },
      ] } },
    { kind: 'input', id: 'slot', type: assetType, optional: true,
      dynamic: { kind: 'dynamicSlot', slotType: assetType, inputs: [assetInput('file', 'c')] } },
    { kind: 'input', id: 'items', type: assetType, optional: true,
      dynamic: { kind: 'autogrow', template: [assetInput('file', 'd')],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 } } },
  ] }

  it('retains inactive branch, disconnected slot and family values but only effective defaults', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
        values: { 'mode.[b].file': asset('e'), 'slot.file': asset('f'), 'items.file#m0': asset('c') } },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => dynamicSchema))
      .toEqual({ complete: true, digests: ['a', 'c', 'e', 'f'].map((letter) => asset(letter).digest) })
  })

  it.each(['metadata', 'nested-metadata', 'unknown-value', 'budget', 'wire15'] as const)(
    'keeps unsupported dynamic census incomplete: %s', (scenario) => {
      const local = session()
      const node = { id: asNodeId('n0'), type: 'Loader', values: scenario === 'unknown-value' ? { unknown: asset('e') } : {},
        dynamic: scenario === 'metadata' ? { mode: { hidden: asset('e') } }
          : scenario === 'nested-metadata' ? { items: { members: ['m0'], memberState: { m0: { mode: { hidden: asset('e') } } } } }
            : scenario === 'budget' ? { items: { members: Array.from({ length: 600 }, (_, index) => `m${index}`) } } : {} }
      const document = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: { n0: node } } } } as WorkflowDocument
      const candidate: NodeSchema = scenario === 'wire15' ? { ...dynamicSchema, items: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'a', inputs: [assetInput('file', 'a')] }] },
      }] } : dynamicSchema
      expect(workflowAssetRoots(document, local.historySnapshot(), () => candidate).complete).toBe(false)
    },
  )

  it('rechecks shared dynamic nodes when historical connectivity activates slot defaults', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: {} },
      n1: { id: asNodeId('n1'), type: 'Loader', values: {} },
    } } } }
    const history = { revision: 1, redo: [], undo: [{ forward: [], inverse: [{ op: 'add' as const,
      path: ['graphs', 'g0', 'links', 'l0'], value: { id: 'l0', from: { node: 'n1', port: 'out' }, to: { node: 'n0', port: 'slot' } },
    }] }] }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => dynamicSchema).digests).toEqual([asset('a').digest])
    expect(workflowAssetRoots(document, history, () => dynamicSchema))
      .toEqual({ complete: true, digests: ['a', 'c'].map((letter) => asset(letter).digest) })
  })

  it.each(['asset', 'scalar', 'disconnected', 'unknown-port', 'mixed'] as const)(
    'requires supported types from every literal consumer: %s', (scenario) => {
      const local = session()
      const source = { id: asValueSourceId('literal'), value: scenario === 'scalar' ? 7 : [asset('e')] }
      const loader: NodeSchema = scenario === 'scalar' ? { ...schema, items: [{
        kind: 'input', id: 'files', optional: false, type: { kind: 'concrete', name: 'INT' },
      }] } : schema
      const opaque: NodeSchema = { ...schema, type: 'Opaque', items: [{
        kind: 'input', id: 'files', optional: false, type: { kind: 'wildcard' },
      }] }
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!,
        nodes: {
          n0: { id: asNodeId('n0'), type: 'Loader', values: {} },
          ...(scenario === 'mixed' ? { n1: { id: asNodeId('n1'), type: 'Opaque', values: {} } } : {}),
        },
        valueSources: { literal: source },
        links: scenario === 'disconnected' ? {} : {
          l0: { id: asLinkId('l0'), from: { valueSource: source.id },
            to: { node: asNodeId('n0'), port: asPortId(scenario === 'unknown-port' ? 'missing' : 'files') } },
          ...(scenario === 'mixed' ? { l1: { id: asLinkId('l1'), from: { valueSource: source.id },
            to: { node: asNodeId('n1'), port: asPortId('files') } } } : {}),
        },
      } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] },
        (type) => type === 'Loader' ? loader : type === 'Opaque' ? opaque : undefined)
      expect(roots.complete).toBe(scenario === 'asset' || scenario === 'scalar')
      if (scenario === 'asset') expect(roots.digests).toEqual([asset('e').digest])
      if (scenario === 'scalar') expect(roots.digests).toEqual([])
    },
  )

  it('rechecks a shared literal source when historical node edits change its consumer type', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!,
      nodes: { n0: { id: asNodeId('n0'), type: 'Loader', values: {} } },
      valueSources: { literal: { id: asValueSourceId('literal'), value: [asset('e')] } },
      links: { l0: { id: asLinkId('l0'), from: { valueSource: asValueSourceId('literal') },
        to: { node: asNodeId('n0'), port: asPortId('files') } } },
    } } }
    const strings: NodeSchema = { ...schema, type: 'StringLoader', items: [{
      kind: 'input', id: 'files', optional: false, type: { kind: 'concrete', name: 'STRING' },
    }] }
    const schemas = (type: string) => type === 'StringLoader' ? strings : resolve(type)
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, schemas))
      .toEqual({ complete: true, digests: [asset('e').digest] })
    expect(workflowAssetRoots(document, { revision: 1, redo: [], undo: [{ forward: [], inverse: [{
      op: 'replace', path: ['graphs', 'g0', 'nodes', 'n0', 'type'], oldValue: 'Loader', value: 'StringLoader',
    }] }] }, schemas).complete).toBe(false)
  })

  it('includes shared confirmed and pending document roots outside local history', async () => {
    const local = session()
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    const retained = { ...prepared.currentDocument, graphs: { g0: { ...prepared.currentDocument.graphs.g0!, nodes: {
      n0: { ...prepared.currentDocument.graphs.g0!.nodes.n0!, values: { files: [asset('e')] } },
    } } } }
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(declaration.digests).toEqual(['a', 'b', 'e'].map((letter) => asset(letter).digest))
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    const outcome = await admitWorkflowDispatch(connection, { ...prepared, retainedDocuments: [retained] }, resolve,
      () => true, { setItem: () => {} })
    expect(outcome.ok).toBe(true)
  })

  it('journals current and undo/redo roots before acknowledgment, then publishes once', async () => {
    const local = session()
    local.dispatch(replace('b'))
    local.dispatch(replace('c'))
    local.undo()
    const prepared = local.prepareDispatch!(replace('d'))
    if (!prepared.ok) throw new Error('candidate rejected')
    const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
    const acknowledged = deferred<RetainedAssets>()
    const journal = new Map<string, string>()
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        requested.resolve({ owner, declaration })
        return acknowledged.promise
      },
    } as unknown as DinksterConnection
    const operation = admitWorkflowDispatch(connection, prepared, resolve, () => true,
      { setItem: (key, value) => { journal.set(key, value) } })
    const { owner, declaration } = await requested.promise
    expect(declaration.digests).toEqual(['a', 'b', 'c', 'd'].map((letter) => asset(letter).digest))
    expect([...journal.values()].map((value) => JSON.parse(value))).toEqual([{
      version: 2, connectionId: 'backend', assetBaseUrl: 'http://assets.test/', owner, digests: declaration.digests,
      documentLineage: local.doc.lineage, documentRevision: prepared.history.revision,
    }])
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
    acknowledged.resolve({ ...owner, ...declaration, revision: 1 })
    expect((await operation).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('d')])
    expect(local.canRedo).toBe(false)
    expect(prepared.commit().ok).toBe(false)
    expect(journal.size).toBe(1)
  })

  it('keeps mismatched, stale and lost-response ownership without replay or early publication', async () => {
    for (const scenario of ['mismatch', 'stale', 'lost', 'gone']) {
      const local = session()
      const prepared = local.prepareDispatch!(replace('b'))
      if (!prepared.ok) throw new Error('candidate rejected')
      let writes = 0
      let stored: RetainedAssets | undefined
      const journal = new Map<string, string>()
      const connection = {
        id: 'backend', assetUrl: () => 'http://assets.test/',
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
          writes++
          stored = { ...owner, ...declaration, revision: 1 }
          if (scenario === 'stale') local.dispatch(replace('c'))
          if (scenario === 'lost') throw new Error('response lost')
          return scenario === 'mismatch' ? { ...stored, scope: 'wrong' } : stored
        },
        fetchRetainedAssets: async () => scenario === 'mismatch' ? undefined : stored,
      } as unknown as DinksterConnection
      const operation = admitWorkflowDispatch(connection, prepared, resolve, () => scenario !== 'gone',
        { setItem: (key, value) => { journal.set(key, value) } })
      if (scenario === 'mismatch' || scenario === 'gone') await expect(operation).rejects.toThrow()
      else expect((await operation).ok).toBe(scenario === 'lost')
      expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(
        scenario === 'lost' ? 'b' : scenario === 'stale' ? 'c' : 'a',
      )])
      expect(writes).toBe(1)
      expect(journal.size).toBe(1)
    }
  })

  it('refuses publication when durable intent cannot be written', async () => {
    const local = session()
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    let writes = 0
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async () => { writes++; throw new Error('unexpected request') },
    } as unknown as DinksterConnection
    await expect(admitWorkflowDispatch(connection, prepared, resolve, () => true,
      { setItem: () => { throw new Error('storage unavailable') } })).rejects.toThrow('storage unavailable')
    expect(writes).toBe(0)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
  })

  it('admits large documents without duplicating document bytes in the owner journal', async () => {
    const local = session()
    expect(local.dispatch({ command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n0', title: 'x'.repeat(50_000),
    } }).ok).toBe(true)
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    let stored = ''
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(JSON.parse(stored)).toMatchObject({ owner, digests: [asset('a').digest, asset('b').digest] })
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    expect((await admitWorkflowDispatch(connection, prepared, resolve, () => true, { setItem: (_key, value) => {
      if (value.length > 2048) throw new Error('storage quota')
      stored = value
    } })).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
  })

  it('ignores overridden selection-name defaults but refuses unresolved effective names', () => {
    const local = session()
    const node = local.doc.graphs.g0!.nodes.n0!
    const document = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...node, values: { files: asset('e') } },
    } } } }
    const selectionSchema: NodeSchema = { ...schema, items: [{
      kind: 'input', id: 'files', optional: false,
      type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } },
      widget: { widgetType: 'ASSET', kind: 'model/vae', selection: true, options: {}, default: 'nested/source' },
    }] }
    const resolveSelection = () => selectionSchema
    const history = { revision: 0, undo: [], redo: [] }
    expect(workflowAssetRoots(document, history, resolveSelection)).toEqual({ complete: true, digests: [asset('e').digest] })
    const withoutOverride = { ...document, graphs: { g0: { ...document.graphs.g0, nodes: {
      n0: { ...node, values: {} },
    } } } }
    expect(workflowAssetRoots(withoutOverride, history, resolveSelection).complete).toBe(false)
  })

  it('rechecks an unchanged instance when historical graph edits change its derived schema', () => {
    const local = session()
    const root = local.doc.graphs.g0!
    const inner = { ...root, id: asGraphDefId('g1'), nodes: {
      inner: { id: asNodeId('inner'), type: 'Loader', values: {} },
    }, boundary: { inputs: [{ id: 'files', binds: { kind: 'port', node: 'inner', port: 'files' } }], outputs: [] } } as unknown as GraphDef
    const document = { ...local.doc, graphs: {
      g0: { ...root, nodes: { n0: { ...root.nodes.n0!, type: '#g1' } } }, g1: inner,
    } }
    const strings: NodeSchema = { ...schema, type: 'StringLoader', items: [{
      kind: 'input', id: 'files', optional: false, type: { kind: 'concrete', name: 'STRING' },
    }] }
    const resolveBoth = (type: string) => type === 'StringLoader' ? strings : resolve(type)
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, resolveBoth))
      .toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(document, { revision: 1, redo: [], undo: [{ forward: [], inverse: [{
      op: 'replace', path: ['graphs', 'g1', 'nodes', 'inner', 'type'], oldValue: 'Loader', value: 'StringLoader',
    }] }] }, resolveBoth).complete).toBe(false)
  })

  it('keeps historical extensions and stale replay incomplete when node objects are shared', () => {
    const local = session()
    for (const inverse of [
      { op: 'add' as const, path: ['ext'], value: { unknown: { digest: asset('e').digest } } },
      { op: 'replace' as const, path: ['graphs', 'g0', 'nodes', 'n0', 'values', 'files'], oldValue: [], value: [asset('f')] },
    ]) {
      expect(workflowAssetRoots(local.doc, { revision: 1, redo: [], undo: [{ forward: [], inverse: [inverse] }] }, resolve).complete).toBe(false)
    }
  })

  it('includes nodes restored by history and typed sources added outside the node-only path', () => {
    const local = session()
    const roots = workflowAssetRoots(local.doc, { revision: 2, redo: [], undo: [
      { forward: [], inverse: [{ op: 'add', path: ['graphs', 'g0', 'valueSources'], value: {
        literal: { value: { $typed: { type: 'asset<DATA>', value: asset('f') } } },
      } }] },
      { forward: [], inverse: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1'], value: {
        id: 'n1', type: 'Loader', values: { files: [asset('e')] },
      } }] },
    ] }, resolve)
    expect(roots).toEqual({ complete: true, digests: ['a', 'e', 'f'].map((letter) => asset(letter).digest) })
  })

  it('certifies only the exact asset-free mask source association on mask nodes', () => {
    const local = session()
    const marker = { nodeId: 'source', outputId: 'mask' }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...local.doc.graphs.g0!.nodes.n0!, ext: { [MASK_PAINT_SOURCE_EXT_KEY]: marker } },
    } } } }
    const maskResolve = (type: string) => type === schema.type ? { ...schema, editorRole: 'mask-paint' as const } : undefined
    expect(workflowAssetRoots(document, local.historySnapshot(), maskResolve))
      .toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(document, local.historySnapshot(), resolve).complete).toBe(false)
    for (const ext of [
      { [MASK_PAINT_SOURCE_EXT_KEY]: { ...marker, hidden: asset('e') } },
      { [MASK_PAINT_SOURCE_EXT_KEY]: { ...marker, nodeId: asset('e') } },
      { [MASK_PAINT_SOURCE_EXT_KEY]: { ...marker, outputId: 'image' } },
      { [MASK_PAINT_SOURCE_EXT_KEY]: marker, unknown: asset('e') },
    ]) {
      const opaque: WorkflowDocument = { ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
        n0: { ...document.graphs.g0!.nodes.n0!, ext },
      } } } }
      expect(workflowAssetRoots(opaque, local.historySnapshot(), maskResolve).complete).toBe(false)
      expect(workflowAssetRoots(document, local.historySnapshot(), maskResolve, [opaque]).complete).toBe(false)
    }
  })

  it('does not certify unknown schemas, opaque values, dormant extensions or truncated lists', () => {
    const local = session()
    const document = local.doc
    expect(workflowAssetRoots(document, local.historySnapshot(), resolve)).toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(document, local.historySnapshot(), () => undefined).complete).toBe(false)
    expect(workflowAssetRoots({ ...document, ext: { unknown: { nested: asset('e') } } }, local.historySnapshot(), resolve).complete).toBe(false)
    local.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n0', inputId: 'files',
      value: Array.from({ length: 300 }, (_, index) => asset(index === 299 ? 'f' : 'a')) } })
    expect(workflowAssetRoots(local.doc, local.historySnapshot(), resolve).digests).toEqual([asset('a').digest, asset('f').digest])
    local.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n0', inputId: 'files', value: [{ digest: asset('a').digest }] } })
    expect(workflowAssetRoots(local.doc, local.historySnapshot(), resolve).complete).toBe(false)
  })
})
