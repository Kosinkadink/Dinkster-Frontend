/**
 * Badge-popover content resolvers (badge-info.ts, framework-free): what each
 * node-badge popover branch derives from plain document/registry state.
 * Pins subgraph definition lookup and name-only successor guidance.
 */
import { describe, expect, it } from 'vitest'
import type { NodeSchema, WorkflowDocument } from '@dinkster/core'
import { deprecationBadgeInfo, subgraphBadgeInfo } from '../src/badge-info.js'

// The resolvers only read graphs/nodes/type/name; fixtures carry exactly
// those (cast through unknown - full documents would drag in link/net state
// irrelevant to badge content).
const doc = (graphs: Record<string, { name?: string; nodes: Record<string, { type: string }> }>): WorkflowDocument =>
  ({
    root: 'g0',
    graphs: Object.fromEntries(
      Object.entries(graphs).map(([id, g]) => [id, { id, name: g.name ?? id, nodes: g.nodes }]),
    ),
  }) as unknown as WorkflowDocument

const schema = (s: { type: string; pack?: string; deprecation?: { message: string; since?: string; replacement?: string } }): NodeSchema =>
  s as unknown as NodeSchema

describe('subgraphBadgeInfo', () => {
  const d = doc({
    g0: { nodes: { n1: { type: '#sub' }, n2: { type: 'core.plain' } } },
    sub: { name: 'My Subgraph', nodes: { a: { type: 'x' }, b: { type: 'y' }, c: { type: 'z' } } },
  })

  it('resolves the definition behind a subgraph node with name and node count', () => {
    expect(subgraphBadgeInfo(d, 'g0', 'n1')).toEqual({ defId: 'sub', name: 'My Subgraph', nodeCount: 3 })
  })

})

describe('deprecationBadgeInfo', () => {
  const d = doc({ g0: { nodes: { n1: { type: 'old.Node' } } } })

  it('carries the schema deprecation and resolves the successor pointer transitively', () => {
    const schemas: Record<string, NodeSchema> = {
      'old.Node': schema({ type: 'old.Node', deprecation: { message: 'use B', since: '2.0', replacement: 'mid.B' } }),
      'mid.B': schema({ type: 'mid.B', deprecation: { message: 'use C', replacement: 'new.C' } }),
      'new.C': schema({ type: 'new.C' }),
    }
    const info = deprecationBadgeInfo({
      doc: d, graphId: 'g0', nodeId: 'n1', resolve: (t) => schemas[t],
    })
    expect(info?.deprecation).toEqual({ message: 'use B', since: '2.0', replacement: 'mid.B' })
    expect(info?.pointer).toEqual({ terminal: 'new.C', path: ['mid.B', 'new.C'], status: 'ok' })
  })

})
