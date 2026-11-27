import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import {
  asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, boundaryOf, coreCommandRegistry,
  compile, createLocalSession, documentResolver, occurrenceDynamicView, parseDinksterSchema, semanticHashOf,
  type NodeSchema, type OccurrenceListCountEstimate, type WorkflowDocument,
} from '@dinkster/core'
import { listCountOffers, useListCountEstimate } from '../src/list-count-offers.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import type { ExecutionState } from '@dinkster/client'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('reports unknown-to-known corrections per occurrence and undoes the whole causing edit atomically', async () => {
  vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
  const list = { kind: 'list' as const, element: { kind: 'concrete' as const, name: 'INT' } }
  const source: NodeSchema = { type: 'Source', displayName: 'List', category: 'test', source: 'v3', isOutputNode: false, body: [
    { kind: 'input', id: 'values', type: list, optional: false,
      widget: { widgetType: 'LIST', options: {}, element: { widgetType: 'INT', options: {} }, default: [] } },
  ] }
  const wire = JSON.parse(readFileSync(new URL('../../core/test/fixtures/flow_schemas.json', import.meta.url), 'utf8'))
  const parsed = parseDinksterSchema('Unpack', wire['dinkster.utilities.unpack']).schema!
  const unpack: NodeSchema = { ...parsed, body: parsed.body.map(row => row.kind === 'input' && row.id === 'count'
    ? { ...row, listCountOf: 'list' } : row) }
  for (const nested of [false, true]) {
    const app = createWorkflowApp([source, unpack])
    try {
      const document: WorkflowDocument = { format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('corrections'), root: asGraphDefId('root'),
        graphs: { root: { id: asGraphDefId('root'), name: 'Root', nextOrdinal: 4, nets: {}, reroutes: {}, links: {}, nodes: {
          source: { id: asNodeId('source'), type: source.type, values: { values: [19] } },
          ...Object.fromEntries([['shrinks', 3], ['grows', 1], ['equal', 2]].map(([id, count]) => [id,
            { id: asNodeId(String(id)), type: nested ? `#${id}` : unpack.type, values: nested ? {} : { count } }])),
        } }, ...Object.fromEntries(nested ? [['shrinks', 3], ['grows', 1], ['equal', 2]].map(([id, count]) => [id, {
          id: asGraphDefId(String(id)), name: String(id), nextOrdinal: 1, nets: {}, reroutes: {}, links: {},
          nodes: { unpack: { id: asNodeId('unpack'), type: unpack.type, values: { count } } },
          boundary: boundaryOf([{ id: asPortId('list'), binds: { kind: 'port', node: asNodeId('unpack'), port: asPortId('list') } }], []),
        }]) : []) }, view: { graphs: {} },
      }
      await app.openDocument(document, 'Count corrections')
      const tab = app.activeTab()!
      const before = tab.store.doc
      const connect = () => app.dispatchTo(tab, { command: 'batch', params: { invocations: [
        { command: 'node.setValue', params: { graphId: 'root', nodeId: 'source', inputId: 'values', value: [11, 37] } },
        ...['shrinks', 'grows', 'equal'].map(node => ({ command: 'link.connect', params: { graphId: 'root',
          from: { node: 'source', tap: 'values' }, to: { node, port: 'list' } } })),
      ] } })
      const outcome = await connect()
      expect(outcome.ok).toBe(true)
      const corrected = tab.store.doc
      const entries = app.adjustmentNotices.get().get(tab.id)?.adjustments
      expect(entries?.map(entry => [entry.kind, entry.details, entry.anchor?.occurrence])).toEqual([
        ['outputCount', ['Output count changed from 3 to 2.'], { instancePath: nested ? ['shrinks'] : [], node: nested ? 'unpack' : 'shrinks' }],
        ['outputCount', ['Output count changed from 1 to 2.'], { instancePath: nested ? ['grows'] : [], node: nested ? 'unpack' : 'grows' }],
      ])
      expect(app.adjustmentNoticeState(tab.id)).toBe('ready')
      expect(app.undoAdjustments(tab.id)).toBe(true)
      expect(tab.store.doc.graphs.root!.nodes).toEqual(before.graphs.root!.nodes)
      expect(tab.store.doc.graphs.root!.links).toEqual(before.graphs.root!.links)
      expect(tab.store.doc.occurrenceListCounts).toEqual(before.occurrenceListCounts)
      expect(app.redoAdjustments(tab.id)).toBe(true)
      expect(tab.store.doc).toEqual(corrected)
      expect(tab.store.undo()).toBe(true)
      expect(app.adjustmentNoticeState(tab.id)).toBe('undone')
      expect((await connect()).ok).toBe(true)
      expect(app.adjustmentNotices.get().get(tab.id)?.adjustments).toHaveLength(2)
      expect(app.adjustmentNoticeState(tab.id)).toBe('ready')
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'root', nodeId: 'source', inputId: 'values', value: [97],
      } })).ok).toBe(true)
      const changed = tab.store.doc
      expect(app.undoAdjustments(tab.id)).toBe(false)
      expect(tab.store.doc).toBe(changed)
    } finally { app.dispose() }
  }
})

it('uses a larger estimate atomically and remembers a manual answer per occurrence across reload', async () => {
  vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
  const wire = JSON.parse(readFileSync(new URL('../../core/test/fixtures/flow_schemas.json', import.meta.url), 'utf8'))
  const parsed = parseDinksterSchema('dinkster.utilities.unpack', wire['dinkster.utilities.unpack']).schema!
  const unpack = { ...parsed, body: parsed.body.map(row => row.kind === 'input' && row.id === 'count'
    ? { ...row, listCountOf: 'list' } : row) }
  const source: NodeSchema = { ...parsed, type: 'source', body: [
    { kind: 'output', id: 'out', type: { kind: 'list', element: { kind: 'concrete', name: 'INT' } } },
  ] }
  const schemas = (type: string) => type === unpack.type ? unpack : type === source.type ? source : undefined
  for (const nested of [false, true]) {
    const body = { id: asGraphDefId('body'), name: 'Body', nextOrdinal: 1, nets: {}, reroutes: {},
      nodes: { source: { id: asNodeId('source'), type: source.type, values: {} },
        unpack: { id: asNodeId('unpack'), type: unpack.type, values: { count: 3 } } },
      links: { l: { id: asLinkId('l'), from: { node: asNodeId('source'), port: asPortId('out') },
        to: { node: asNodeId('unpack'), port: asPortId('list') } } }, boundary: boundaryOf([], []) }
    const document: WorkflowDocument = { format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('offers'),
      root: asGraphDefId(nested ? 'root' : 'body'), graphs: { body, ...(nested ? { root: {
        id: asGraphDefId('root'), name: 'Root', nextOrdinal: 1, nets: {}, reroutes: {}, links: {}, nodes: {
          left: { id: asNodeId('left'), type: '#body', values: {} },
          right: { id: asNodeId('right'), type: '#body', values: {} },
        },
      } } : {}) }, view: { graphs: {} } }
    const path = nested ? ['left'] : []
    const session = createLocalSession(document, coreCommandRegistry([], schemas), { schemaResolverFor: doc => documentResolver(doc, schemas) })
    const read = (doc: WorkflowDocument, count: number | undefined, at = path) => {
      const estimate: OccurrenceListCountEstimate = () => count === undefined ? undefined
        : { kind: 'estimate', count, sources: ['last-run'] }
      return listCountOffers(doc, documentResolver(doc, schemas), 'body', at, estimate)
    }
    const offer = read(session.doc, 85)[0]!
    expect(offer).toMatchObject({ nodeId: 'unpack', inputId: 'count', count: 85 })
    expect(session.dispatch(useListCountEstimate('body', path, offer)).ok).toBe(true)
    expect(occurrenceDynamicView(session.doc, schemas, path, session.doc.root).values.get('unpack')?.['count']
      ?? session.doc.graphs.body!.nodes.unpack!.values['count']).toBe(85)
    expect(read(session.doc, 85)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(document)
    const hash = semanticHashOf(session.doc)
    expect(session.dispatch({ command: 'view.answerListCountEstimate', params: {
      graphId: 'body', nodeId: 'unpack', instancePath: path, inputId: 'count', count: 85,
    } }).ok).toBe(true)
    expect(semanticHashOf(session.doc)).toBe(hash)
    const reloaded = JSON.parse(JSON.stringify(session.doc)) as WorkflowDocument
    expect(read(reloaded, 85)).toEqual([])
    expect(read(reloaded, 86)[0]?.count).toBe(86)
    expect(read(reloaded, 900)[0]).toMatchObject({ count: 900, limit: 512 })
    for (const count of [3, 1, 0, undefined]) expect(read(reloaded, count)).toEqual([])
    if (nested) expect(read(reloaded, 85, ['right'])[0]?.count).toBe(85)

    const promoted: WorkflowDocument = nested ? { ...document, graphs: { ...document.graphs,
      body: { ...body, boundary: boundaryOf([{ id: asPortId('chosen'), promoted: true,
        binds: { kind: 'port', node: asNodeId('unpack'), port: asPortId('count') } }], []) },
    } } : document
    const app = createWorkflowApp([unpack, source])
    try {
      await app.openDocument(promoted, 'Count choices')
      const tab = app.activeTab()!
      const compiled = compile({ document: tab.store.doc, revision: 1, resolve: documentResolver(tab.store.doc, schemas),
        scope: { kind: 'full' }, connection: app.connection.id, schemaHash: 'workflow-test' })
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) continue
      const execution = { ref: { connection: app.connection.id }, artifact: compiled.artifact,
        nodes: Object.fromEntries(Object.keys(compiled.artifact.prompt).filter(id => id.endsWith('source')).map(id => [id,
          { state: 'done', outputs: { out: { typeId: 'list<INT>', length: 85 } } }])) } as unknown as ExecutionState
      vi.spyOn(app, 'executionForTab').mockReturnValue(execution)
      vi.spyOn(app, 'previewComparisonCompile').mockReturnValue(compiled)
      if (nested) {
        expect(tab.store.dispatch({ command: 'occurrence.setListCount', params: {
          graphId: 'body', nodeId: 'unpack', instancePath: path, inputId: 'count', value: 2,
        } }).ok).toBe(true)
        expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
          graphId: 'root', nodeId: 'left', inputId: 'chosen', value: 7,
        } })).ok).toBe(true)
        expect(read(tab.store.doc, 85)[0]?.count).toBe(85)
        expect(tab.store.undo()).toBe(true)
        expect(tab.store.undo()).toBe(true)
      }
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: nested ? 'root' : 'body', nodeId: nested ? 'left' : 'unpack', inputId: nested ? 'chosen' : 'count', value: 2,
      } })).ok).toBe(true)
      const saved = JSON.parse(JSON.stringify(tab.store.doc)) as WorkflowDocument
      expect(read(saved, 85)).toEqual([])
      expect(read(saved, 86)[0]?.count).toBe(86)
      if (nested) expect(read(saved, 85, ['right'])[0]?.count).toBe(85)
      expect(tab.store.undo()).toBe(true)
      expect(read(tab.store.doc, 85)[0]?.count).toBe(85)
      expect((await app.dispatchTo(tab, useListCountEstimate('body', path, read(tab.store.doc, 85)[0]!))).ok).toBe(true)
      expect(occurrenceDynamicView(tab.store.doc, schemas, path, tab.store.doc.root).values.get('unpack')?.['count']
        ?? tab.store.doc.graphs.body!.nodes.unpack!.values['count']).toBe(85)
      expect(read(tab.store.doc, 85)).toEqual([])
      expect(tab.store.undo()).toBe(true)
      expect(read(tab.store.doc, 85)[0]?.count).toBe(85)
    } finally { app.dispose() }
  }
})
