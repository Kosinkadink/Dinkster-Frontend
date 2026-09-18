import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  coreCommandRegistry,
  createLocalSession,
  type GraphDef,
  type WorkflowDocument,
} from '@dinkster/core'
import { describe, expect, it } from 'vitest'
import { planDemoEdits } from '../src/edits.js'
import { runDemoEdits } from '../src/run.js'

const graph = (nodes: GraphDef['nodes'], links: GraphDef['links'] = {}): GraphDef => ({
  id: asGraphDefId('g0'),
  name: 'Demo',
  nodes,
  links,
  nets: {},
  reroutes: {},
  nextOrdinal: 10,
})

const node = (id: string, type: string, values: Record<string, string | number> = {}) => ({
  id: asNodeId(id),
  type,
  values,
})

const document = (definition: GraphDef): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('headless-test'),
  root: asGraphDefId('g0'),
  graphs: { g0: definition },
  view: {
    graphs: {
      g0: {
        nodes: {
          a: { position: { x: 10, y: 20 } },
          b: { position: { x: 300, y: 20 } },
        },
      },
    },
  },
})

describe('headless demo edits', () => {
  it('adds linked copies, marks the first, and moves it', async () => {
    const initial = document(graph(
      { a: node('a', 'Source', { label: 'original' }), b: node('b', 'Target', { count: 4 }) },
      {
        l1: {
          id: asLinkId('l1'),
          from: { node: asNodeId('a'), port: 'image' as never },
          to: { node: asNodeId('b'), port: 'input' as never },
        },
      },
    ))
    const session = createLocalSession(initial, coreCommandRegistry())

    const result = await runDemoEdits(session, { delayMs: 0 })

    expect(Object.keys(session.doc.graphs.g0!.nodes)).toHaveLength(4)
    expect(result.secondNodeId).toBeDefined()
    expect(session.doc.graphs.g0!.nodes[result.firstNodeId]!.values.label).toBe('original [headless]')
    expect(Object.values(session.doc.graphs.g0!.links)).toContainEqual(expect.objectContaining({
      from: { node: result.firstNodeId, port: 'image' },
      to: { node: result.secondNodeId, port: 'input' },
    }))
    expect(session.doc.view.graphs.g0!.nodes[result.firstNodeId]!.position).toEqual({ x: 410, y: 140 })
    expect(result.dispatchCount).toBe(8)
  })

  it('falls back to one existing node', async () => {
    const initial = document(graph({ a: node('a', 'Solo') }))
    const session = createLocalSession(initial, coreCommandRegistry())

    const result = await runDemoEdits(session, { delayMs: 0 })

    expect(Object.keys(session.doc.graphs.g0!.nodes)).toHaveLength(2)
    expect(result.secondNodeId).toBeUndefined()
    expect(session.doc.graphs.g0!.nodes[result.firstNodeId]!.values.headlessDemo).toBe(1)
    expect(session.doc.view.graphs.g0!.nodes[result.firstNodeId]!.position).toEqual({ x: 410, y: 140 })
    expect(result.dispatchCount).toBe(6)
  })

  it('requires a type for an empty document', () => {
    expect(() => planDemoEdits(document(graph({})))).toThrow('pass --type')
  })

  it('uses the requested type for an empty document', async () => {
    const session = createLocalSession(document(graph({})), coreCommandRegistry())
    const result = await runDemoEdits(session, { type: 'EmptyDemoNode', delayMs: 0 })

    expect(session.doc.graphs.g0!.nodes[result.firstNodeId]!.type).toBe('EmptyDemoNode')
    expect(session.doc.graphs.g0!.nodes[result.firstNodeId]!.values.headlessDemo).toBe(1)
  })
})
