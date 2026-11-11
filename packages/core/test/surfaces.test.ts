import { describe, expect, it } from 'vitest'
import {
  asControlSurfaceId,
  asGraphDefId,
  asLineageId,
  asNodeId,
  coreCommandRegistry,
  decodeModePanelConfig,
  DocumentStore,
  loadDocument,
  MODE_PANEL_TYPE,
  semanticHashOf,
  type JsonObject,
  type WorkflowDocument,
} from '../src/index.js'

function doc(overrides: Partial<WorkflowDocument> = {}): WorkflowDocument {
  return {
    format: 'dinkster-workflow', formatVersion: 1,
    lineage: asLineageId('saved-surfaces'), root: asGraphDefId('g0'),
    graphs: { g0: {
      id: asGraphDefId('g0'), name: 'root',
      nodes: { n1: { id: asNodeId('n1'), type: 'KSampler', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    } },
    view: { graphs: { g0: {
      nodes: {},
      groups: { grp0: { id: 'grp0', title: 'Group', bounds: { x: 0, y: 0, width: 100, height: 100 } } },
    } } },
    surfaces: { s0: {
      id: asControlSurfaceId('s0'), type: MODE_PANEL_TYPE,
      config: { bindings: [{ kind: 'group', graphId: 'g0', groupId: 'grp0' }] },
    } },
    ...overrides,
  }
}

describe('saved control surfaces', () => {
  it('keeps known and unknown surface data through load, ordinary edits and save', () => {
    const original = doc({ surfaceSeq: 9, surfaces: {
      s0: {
        id: asControlSurfaceId('s0'), type: MODE_PANEL_TYPE,
        config: { title: 'My panel', bindings: [
          { kind: 'node', graphId: 'g0', nodeId: 'n1' },
          { kind: 'future', nested: { keep: [false, 7, 'raw'] } },
        ], extra: { untouched: true } }, ext: { owner: { keep: 'raw' } },
      },
      s8: { id: asControlSurfaceId('s8'), type: 'future.panel', config: { payload: [1, 'two'] } },
    }, view: { graphs: { g0: { nodes: {} } }, surfaces: {
      s0: { position: { x: 13, y: -27 }, custom: [true, 'keep'] },
      s8: { position: { x: 400, y: 8 } },
    } } })
    const loaded = loadDocument(JSON.parse(JSON.stringify(original)))
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const store = new DocumentStore(loaded.document!, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.setMode', params: { graphId: 'g0', nodeIds: ['n1'], mode: 'muted' } }).ok).toBe(true)
    const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(reopened.document?.surfaces).toEqual(original.surfaces)
    expect(reopened.document?.view.surfaces).toEqual(original.view.surfaces)
    expect(reopened.document?.surfaceSeq).toBe(9)
    expect(reopened.document?.graphs.g0?.nodes.n1?.mode).toBe('muted')
    expect(semanticHashOf(original)).toBe(semanticHashOf({ ...original, surfaces: {}, surfaceSeq: 0 }))
  })

  it('does not register parked surface commands', () => {
    const registry = coreCommandRegistry()
    for (const command of ['surface.add', 'surface.update', 'surface.remove', 'surface.mode.apply', 'view.moveSurface']) {
      expect(registry.get(command)).toBeUndefined()
    }
  })

  it('a pre-cursor document with only a broken binding never remints its group id', () => {
    const store = new DocumentStore(doc({ view: { graphs: { g0: { nodes: {} } } } }), coreCommandRegistry())
    expect(store.dispatch({ command: 'view.createGroup', params: {
      graphId: 'g0', title: 'unrelated', bounds: { x: 0, y: 0, width: 50, height: 50 },
    } }).ok).toBe(true)
    expect(Object.keys(store.doc.view.graphs.g0!.groups!)).toEqual(['grp1'])
    expect(store.doc.view.graphs.g0!.groupSeq).toBe(2)
    expect(store.doc.surfaces).toEqual(doc().surfaces)
  })

  it('a removed group binding stays broken after a new group is created', () => {
    const store = new DocumentStore(doc(), coreCommandRegistry())
    expect(store.dispatch({ command: 'view.removeGroup', params: { graphId: 'g0', groupId: 'grp0' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'view.createGroup', params: {
      graphId: 'g0', title: 'unrelated', bounds: { x: 0, y: 0, width: 50, height: 50 },
    } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0?.groups?.grp0).toBeUndefined()
    expect(store.doc.view.graphs.g0?.groups?.grp1).toBeDefined()
    expect(store.doc.surfaces).toEqual(doc().surfaces)
  })
})

describe('decodeModePanelConfig', () => {
  it('decodes node and group bindings with an optional title', () => {
    const r = decodeModePanelConfig({ title: 'Fast Muter', bindings: [
      { kind: 'node', graphId: 'g0', nodeId: 'n1' },
      { kind: 'group', graphId: 'g0', groupId: 'grp0' },
    ] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.title).toBe('Fast Muter')
    expect(r.config.bindings).toHaveLength(2)
  })

  it('malformed shapes yield error diagnostics, never throw', () => {
    for (const bad of [
      { bindings: 'nope' },
      { bindings: [{ kind: 'node', graphId: 'g0' }] },
      { bindings: [{ kind: 'group', groupId: 'grp0' }] },
      { bindings: [null] },
      { title: 5, bindings: [] },
    ]) {
      const r = decodeModePanelConfig(bad as unknown as JsonObject)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.diagnostics[0]?.code).toBe('surface.config.invalid')
    }
  })

  it('unknown binding kinds are preserved as data', () => {
    const raw = { kind: 'tagQuery', tag: 'loaders' }
    const r = decodeModePanelConfig({ bindings: [{ kind: 'node', graphId: 'g0', nodeId: 'n1' }, raw] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.bindings[1]).toEqual({ kind: 'unknown', raw })
  })
})
