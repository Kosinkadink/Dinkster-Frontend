import { beforeAll, describe, expect, it } from 'vitest'
import type { NodeSchema, WorkflowDocument } from '@dinkster/core'
import { AppState } from '../src/app-state.js'

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: new URL('http://localhost/'),
    configurable: true,
  })
})

const schema: NodeSchema = {
  type: 'CountedOutput',
  displayName: 'Counted output',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'count',
      type: { kind: 'concrete', name: 'core.int' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 3 },
    },
    {
      kind: 'input',
      id: 'ordinary',
      type: { kind: 'concrete', name: 'core.int' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 0 },
    },
    {
      kind: 'output',
      id: 'results',
      type: { kind: 'concrete', name: 'core.int' },
      dynamic: {
        kind: 'autogrow',
        template: [{
          kind: 'input',
          id: 'result',
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
        }],
        materialization: 'wire15',
        naming: { kind: 'prefix', prefix: '', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ],
}

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'count-edit' as never,
  root: 'g0' as never,
  graphs: {
    g0: {
      id: 'g0' as never,
      name: 'root',
      nextOrdinal: 1,
      nodes: {
        split: { id: 'split' as never, type: schema.type, values: { count: 3, ordinary: 0 } },
        sink: { id: 'sink' as never, type: 'Sink', values: {} },
      },
      links: {
        departing: {
          id: 'departing' as never,
          from: { node: 'split' as never, port: 'results' as never, members: ['2' as never] },
          to: { node: 'sink' as never, port: 'in' as never },
        },
      },
      nets: {},
      reroutes: {},
    },
  },
  view: { graphs: {} },
})

const subgraphDocument = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'promoted-count-edit' as never,
  root: 'g0' as never,
  graphs: {
    g0: {
      id: 'g0' as never,
      name: 'root',
      nextOrdinal: 1,
      nodes: {
        left: { id: 'left' as never, type: '#sub', values: {} },
        right: { id: 'right' as never, type: '#sub', values: {} },
      },
      links: {},
      nets: {},
      reroutes: {},
    },
    sub: {
      id: 'sub' as never,
      name: 'sub',
      nextOrdinal: 1,
      nodes: {
        split: { id: 'split' as never, type: schema.type, values: { count: 3, ordinary: 0 } },
      },
      links: {},
      nets: {},
      reroutes: {},
      boundary: {
        inputs: [{ id: 'amount', binds: { kind: 'port', node: 'split' as never, port: 'count' as never }, promoted: true }],
        outputs: [{ id: 'results', binds: { kind: 'family', node: 'split' as never, port: 'results' as never } }],
      },
    },
  },
  view: { graphs: {} },
})

const appWithSchema = (): AppState => {
  const app = new AppState()
  ;(app.registry as unknown as { set(value: unknown): void }).set({
    connection: app.connection.id,
    schemas: new Map(),
    diagnostics: [],
    resolve: () => undefined,
    hash: 'count-edit-test',
    graphFeatures: [],
  })
  app.registerSchemas([schema])
  return app
}

describe('AppState count-aware value edits', () => {
  it('routes count widgets through the explicit preserving command while ordinary widgets stay generic', () => {
    const app = appWithSchema()
    expect(app.openDocument(document(), 'Count edit')).toEqual([])
    const tab = app.activeTab()!
    const origins: string[] = []
    tab.store.onOp((op) => origins.push(op.origin))

    expect(app.dispatchTo(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'split', inputId: 'count', value: 1 },
    }).ok).toBe(true)
    expect(origins).toEqual(['node.setOutputCount'])
    expect(tab.store.doc.graphs.g0!.links.departing).toBeDefined()

    expect(app.dispatchTo(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'split', inputId: 'ordinary', value: 2 },
    }).ok).toBe(true)
    expect(origins).toEqual(['node.setOutputCount', 'node.setValue'])

    expect(app.dispatchTo(tab, {
      command: 'batch',
      params: { invocations: [
        {
          command: 'node.setValue',
          params: { graphId: 'g0', nodeId: 'split', inputId: 'count', value: 2 },
        },
        {
          command: 'node.setValue',
          params: { graphId: 'g0', nodeId: 'split', inputId: 'ordinary', value: 3 },
        },
      ] },
    }).ok).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.split!.values).toEqual({ count: 2, ordinary: 3 })

    const revision = tab.store.revision
    expect(app.dispatchTo(tab, {
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'split', values: { count: 3, ordinary: 4 } },
    }).ok).toBe(true)
    expect(tab.store.revision).toBe(revision + 1)
    expect(tab.store.doc.graphs.g0!.nodes.split!.values).toEqual({ count: 3, ordinary: 4 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.split!.values).toEqual({ count: 2, ordinary: 3 })
  })

  it('validates promoted count edits against the derived occurrence schema', () => {
    const app = appWithSchema()
    expect(app.openDocument(subgraphDocument(), 'Promoted count edit')).toEqual([])
    const tab = app.activeTab()!
    const origins: string[] = []
    tab.store.onOp((op) => origins.push(op.origin))

    expect(app.dispatchTo(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'left', inputId: 'amount', value: 4 },
    }).ok).toBe(true)
    expect(origins).toEqual(['node.setOutputCount'])
    expect(tab.store.doc.graphs.g0!.nodes.left!.values).toEqual({ amount: 4 })
    expect(tab.store.doc.graphs.g0!.nodes.right!.values).toEqual({})
    expect(tab.store.doc.graphs.sub!.nodes.split!.values.count).toBe(3)

    for (const invocation of [
      {
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'right', inputId: 'amount', value: 5 },
      },
      {
        command: 'node.setValues',
        params: { graphId: 'g0', nodeId: 'right', values: { amount: 5 } },
      },
    ]) {
      const bypass = tab.store.dispatch(invocation)
      expect(bypass.ok).toBe(false)
      if (!bypass.ok) expect(bypass.diagnostics[0]?.code).toBe('outputCount.commandRequired')
    }
    expect(tab.store.doc.graphs.g0!.nodes.right!.values).toEqual({})

    const rejected = app.dispatchTo(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'left', inputId: 'amount', value: 5 },
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe('outputCount.outOfRange')
    expect(origins).toEqual(['node.setOutputCount'])
    expect(tab.store.doc.graphs.g0!.nodes.left!.values).toEqual({ amount: 4 })
  })
})
