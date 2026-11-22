import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { deriveBoundarySchema, documentResolver, type NodeSchema } from '@dinkster/core'
import { createWorkflowApp } from './fixtures/workflow-app.js'

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const primitive = (type: string, name: 'FLOAT' | 'INT' | 'BOOLEAN', output = 'value'): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'value',
      type: { kind: 'concrete', name },
      optional: false,
      ...(name === 'FLOAT' ? { widget: { widgetType: 'NUMBER', options: { step: 0.1 }, default: 0 } } : {}),
    },
    { kind: 'output', id: output, type: { kind: 'concrete', name } },
  ],
})

describe('region creation actions', () => {

  it.each(['map', 'while'] as const)('derives and lowers a real %s region with same-id primitive ports', async (kind) => {
    const app = createWorkflowApp()
    const schemas = new Map([
      ['dinkster.utilities.primitive_float', primitive('dinkster.utilities.primitive_float', 'FLOAT')],
      ['dinkster.utilities.primitive_boolean', primitive('dinkster.utilities.primitive_boolean', 'BOOLEAN')],
    ])
    app.registry.set({
      connection: app.connection.id,
      schemas,
      diagnostics: [],
      resolve: (type) => schemas.get(type),
      hash: 'same-id-region-test',
      graphFeatures: ['regions'],
    })
    const tab = app.createWorkflow()

    expect((await app.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, kind)).ok).toBe(true)
    const occurrence = Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes)[0]!
    const definition = tab.store.doc.graphs[occurrence.type.slice(1)]!
    for (const [itemId, node] of kind === 'while' ? [['result', 'n0'], ['continue', 'n1']] : [['result', 'n0']]) {
      expect(tab.store.dispatch({ command: 'boundary.setBinding', params: {
        graphId: definition.id, side: 'outputs', itemId: itemId!, node: node!, port: 'value',
      } }).ok).toBe(true)
    }
    const resolve = documentResolver(tab.store.doc, (type) => schemas.get(type))
    expect(deriveBoundarySchema(tab.store.doc.graphs[definition.id]!, resolve, occurrence.region).diagnostics).toEqual([])

    const compiled = app.compileTab(tab)
    expect(compiled?.ok).toBe(true)
    if (compiled?.ok === true) {
      expect(compiled.artifact.dinksterGraph?.nodes[occurrence.id]).toEqual(expect.objectContaining({ region: expect.objectContaining({ kind }) }))
      expect(compiled.artifact.diagnostics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'boundary.ambiguousBind' }),
        expect.objectContaining({ code: 'boundary.sideMismatch' }),
        expect.objectContaining({ code: 'compile.schema.unknown' }),
        expect.objectContaining({ code: 'compile.scope.missingTarget' }),
      ]))
    }
  })

})
