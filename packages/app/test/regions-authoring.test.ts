import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  checkDocument,
  deriveBoundarySchema,
  documentResolver,
  type NodeSchema,
  type RegionContract,
} from '@dinkster/core'
import { AppState, pushGraph } from '../src/app-state.js'
import { commitRegionCreation } from '../src/CanvasHost.js'
import { registerCoreSearchProviders, runSearchAction } from '../src/universal-search.js'

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true })
})

const regionProblems = (app: AppState) =>
  checkDocument(app.activeTab()!.store.doc).filter((problem) =>
    problem.code.startsWith('doc.region.') || problem.origin === 'invariant',
  )

const sameIdPrimitive = (type: string, name: 'core.float' | 'core.boolean'): NodeSchema => ({
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
      ...(name === 'core.float' ? { widget: { widgetType: 'NUMBER', options: { step: 0.1 }, default: 0 } } : {}),
    },
    { kind: 'output', id: 'value', type: { kind: 'concrete', name } },
  ],
})

describe('region creation actions', () => {
  it.each([
    ['map', 'region.createMap'],
    ['fold', 'region.createFold'],
    ['while', 'region.createWhile'],
  ] as const)('creates one valid %s region batch and drills through the ordinary occurrence path', (kind, commandId) => {
    const app = new AppState()
    const tab = app.createWorkflow()
    const root = tab.store.doc.root

    const selected: string[] = []
    const outcome = commitRegionCreation(app, tab, root, { x: 12, y: 34 }, kind, (nodeId) => selected.push(nodeId))
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

  it('uses the real catalog primitive shapes for the map, fold, and while templates', () => {
    const app = new AppState()
    const expected = {
      map: ['dinkster.float'],
      fold: ['std.math.add_ints'],
      while: ['dinkster.float', 'dinkster.boolean'],
    } as const
    for (const kind of ['map', 'fold', 'while'] as const) {
      const tab = app.createWorkflow()
      expect(app.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, kind).ok).toBe(true)
      const occurrence = Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes)[0]!
      const definition = tab.store.doc.graphs[occurrence.type.slice(1)]!
      expect(Object.values(definition.nodes).map((node) => node.type)).toEqual(expected[kind])
      if (kind === 'while') {
        const region = occurrence.region as RegionContract
        expect(region.continueOutput).toBe('continue')
        expect(definition.boundary!.outputs.find((item) => item.id === 'continue')?.binds).toMatchObject({
          node: 'n1', port: 'value',
        })
      }
    }
  })

  it.each(['map', 'while'] as const)('derives and lowers a real %s region with same-id primitive ports', (kind) => {
    const app = new AppState()
    const schemas = new Map([
      ['dinkster.float', sameIdPrimitive('dinkster.float', 'core.float')],
      ['dinkster.boolean', sameIdPrimitive('dinkster.boolean', 'core.boolean')],
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

    expect(app.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, kind).ok).toBe(true)
    const occurrence = Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes)[0]!
    const definition = tab.store.doc.graphs[occurrence.type.slice(1)]!
    const resolve = documentResolver(tab.store.doc, (type) => schemas.get(type))
    expect(deriveBoundarySchema(definition, resolve, occurrence.region).diagnostics).toEqual([])

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

  it('disables every region action for a frozen tab', () => {
    const app = new AppState()
    const tab = app.createWorkflow()
    ;(tab as { execution?: unknown }).execution = { connection: 'test', prompt: 'frozen' }
    for (const id of ['region.createMap', 'region.createFold', 'region.createWhile']) {
      expect(app.commands.get(id)?.enabled?.()).toBe(false)
    }
    expect(app.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, 'map').ok).toBe(false)
  })

  it('exposes and invokes all three actions through universal search', () => {
    const app = new AppState()
    const dispose = registerCoreSearchProviders(app)
    const createRegion = vi.fn(() => true)
    app.canvasBridge.set({ createRegion } as never)
    const provider = app.searchRegistry.list().find((item) => item.id === 'core.commands')!
    for (const [label, id, kind] of [
      ['Create map region', 'region.createMap', 'map'],
      ['Create fold region', 'region.createFold', 'fold'],
      ['Create while region', 'region.createWhile', 'while'],
    ] as const) {
      const rows = provider.query(label, { selection: { nodes: [] }, signal: new AbortController().signal }) as unknown as readonly { id: string; action: never }[]
      const row = rows.find((item) => item.id === id)!
      expect(row).toBeDefined()
      expect(runSearchAction(app, row.action)).toBe(true)
      expect(createRegion).toHaveBeenLastCalledWith(kind)
    }
    dispose.forEach((fn) => fn())
  })
})
