import { describe, expect, it } from 'vitest'
import {
  asGraphDefId, asLineageId, asNodeId, coreCommandRegistry, createLocalSession,
  type GraphDef, type NodeSchema, type WorkflowDocument,
} from '@dinkster/core'
import type { DinksterConnection, RetainedAssets, RetainedAssetOwner, RetainedAssetDeclaration } from '@dinkster/client'
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

describe('workflow candidate admission', () => {
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
