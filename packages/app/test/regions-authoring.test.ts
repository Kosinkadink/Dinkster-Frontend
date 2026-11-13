import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkDocument, deriveBoundarySchema, documentResolver, type NodeSchema } from '@dinkster/core'
import { pushGraph, type AppState } from '../src/app-state.js'
import { commitRegionCreation } from '../src/CanvasHost.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const regionProblems = (app: AppState) =>
  checkDocument(app.activeTab()!.store.doc).filter((problem) =>
    problem.code.startsWith('doc.region.') || problem.origin === 'invariant',
  )

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

const regionSchemas: readonly NodeSchema[] = [
  primitive('dinkster.utilities.primitive_float', 'FLOAT', 'FLOAT'),
  primitive('dinkster.utilities.primitive_boolean', 'BOOLEAN', 'BOOLEAN'),
  primitive('dinkster.utilities.primitive_int', 'INT', 'INT'),
  { type: 'dinkster.utilities.comfy_math_expression', displayName: 'Math Expression', category: 'utilities', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'expression', type: { kind: 'concrete', name: 'STRING' }, optional: false,
        widget: { widgetType: 'STRING', options: { multiline: true }, default: 'a + b' } },
      { kind: 'input', id: 'values', type: { kind: 'wildcard' }, optional: false, dynamic: {
        kind: 'autogrow', naming: { kind: 'names', names: ['a', 'b', 'c'], min: 1 },
        template: [{ kind: 'input', id: 'value', type: { kind: 'union', names: ['FLOAT', 'INT', 'BOOLEAN'] }, optional: false }],
        optionalAfterMinimum: true, materialization: 'wire15',
      } },
      { kind: 'output', id: 'INT', type: { kind: 'concrete', name: 'INT' } },
    ] },
]

describe('region creation actions', () => {

  it.each([
    ['map', 'region.createMap'],
    ['fold', 'region.createFold'],
    ['while', 'region.createWhile'],
  ] as const)('creates one valid %s region batch and drills through the ordinary occurrence path', async (kind, commandId) => {
    const app = createWorkflowApp(regionSchemas)
    const tab = app.createWorkflow()
    const root = tab.store.doc.root

    const selected: string[] = []
    const outcome = await commitRegionCreation(app, tab, root, { x: 12, y: 34 }, kind, (nodeId) => selected.push(nodeId))
    expect(outcome.ok).toBe(true)
    const occurrenceId = Object.keys(tab.store.doc.graphs[root]!.nodes)[0]!
    const occurrence = tab.store.doc.graphs[root]!.nodes[occurrenceId]!
    const definitionId = occurrence.type.slice(1)
    expect(occurrence.region?.kind).toBe(kind)
    expect(occurrence.type).toBe(`#${definitionId}`)
    expect(tab.graphStack.get()).toEqual([root])
    expect(tab.instancePath.get()).toEqual([])
    expect(selected).toEqual([occurrenceId])
    pushGraph(tab, definitionId, occurrenceId)
    expect(tab.graphStack.get()).toEqual([root, definitionId])
    expect(tab.instancePath.get()).toEqual([occurrenceId])
    expect(regionProblems(app)).toEqual([])
    expect(app.commands.get(commandId)).toBeDefined()

    app.commands.get('edit.undo')!.run()
    expect(tab.store.doc.graphs[definitionId]).toBeUndefined()
    expect(tab.store.doc.graphs[root]!.nodes[occurrenceId]).toBeUndefined()
    expect(tab.graphStack.get()).toEqual([root])
  })

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

  it('disables every region action for a frozen tab', async () => {
    const app = createWorkflowApp()
    const tab = app.createWorkflow()
    ;(tab as { execution?: unknown }).execution = { connection: 'test', prompt: 'frozen' }
    for (const id of ['region.createMap', 'region.createFold', 'region.createWhile']) {
      expect(app.commands.get(id)?.enabled?.()).toBe(false)
    }
    expect((await app.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, 'map')).ok).toBe(false)
  })

})
