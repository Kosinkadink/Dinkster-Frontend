/**
 * Badge-popover content resolvers (badge-info.ts, framework-free): what each
 * node-badge popover branch derives from plain document/registry state.
 * Pins the subgraph definition lookup and the deprecation branch's
 * chain-scoped advisory-problem filter plus transitive successor pointer.
 */
import { describe, expect, it } from 'vitest'
import type { NodeSchema, ReplacementScanItem, WorkflowDocument } from '@dinkster/core'
import { replacementBadgeInfo, subgraphBadgeInfo } from '../src/badge-info.js'

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

const item = (i: { terminalType: string; hops?: { plan: { to: string } }[] }): ReplacementScanItem =>
  ({ hops: [], ...i }) as unknown as ReplacementScanItem

describe('subgraphBadgeInfo', () => {
  const d = doc({
    g0: { nodes: { n1: { type: '#sub' }, n2: { type: 'core.plain' } } },
    sub: { name: 'My Subgraph', nodes: { a: { type: 'x' }, b: { type: 'y' }, c: { type: 'z' } } },
  })

  it('resolves the definition behind a subgraph node with name and node count', () => {
    expect(subgraphBadgeInfo(d, 'g0', 'n1')).toEqual({ defId: 'sub', name: 'My Subgraph', nodeCount: 3 })
  })

  it('returns undefined for a non-subgraph node, a missing node, and a missing graph', () => {
    expect(subgraphBadgeInfo(d, 'g0', 'n2')).toBeUndefined()
    expect(subgraphBadgeInfo(d, 'g0', 'ghost')).toBeUndefined()
    expect(subgraphBadgeInfo(d, 'nope', 'n1')).toBeUndefined()
  })

  it('returns undefined when the referenced definition was edited away', () => {
    const dangling = doc({ g0: { nodes: { n1: { type: '#gone' } } } })
    expect(subgraphBadgeInfo(dangling, 'g0', 'n1')).toBeUndefined()
  })
})

describe('replacementBadgeInfo', () => {
  const d = doc({ g0: { nodes: { n1: { type: 'old.Node' } } } })

  it('returns undefined when the node is missing', () => {
    expect(
      replacementBadgeInfo({ doc: d, graphId: 'g0', nodeId: 'ghost', resolve: undefined, item: undefined, problems: [] }),
    ).toBeUndefined()
  })

  it('keeps only advisory problems whose predecessor the migration chain passes through', () => {
    const chain = item({ terminalType: 'new.C', hops: [{ plan: { to: 'new.B' } }, { plan: { to: 'new.C' } }] })
    const problems = [
      { from: 'old.Node', message: 'source rule invalid' },
      { from: 'new.B', message: 'intermediate rule invalid' },
      { from: 'new.C', message: 'terminal rule invalid' },
      { from: 'unrelated.Type', message: 'noise' },
    ]
    const info = replacementBadgeInfo({ doc: d, graphId: 'g0', nodeId: 'n1', resolve: undefined, item: chain, problems })
    expect(info?.problems.map((p) => p.from)).toEqual(['old.Node', 'new.B', 'new.C'])
  })

  it('without a scan item filters problems to the node type alone', () => {
    const problems = [
      { from: 'old.Node', message: 'kept' },
      { from: 'new.B', message: 'dropped without a chain' },
    ]
    const info = replacementBadgeInfo({ doc: d, graphId: 'g0', nodeId: 'n1', resolve: undefined, item: undefined, problems })
    expect(info?.problems.map((p) => p.message)).toEqual(['kept'])
  })

  it('carries the schema deprecation and resolves the successor pointer transitively', () => {
    const schemas: Record<string, NodeSchema> = {
      'old.Node': schema({ type: 'old.Node', deprecation: { message: 'use B', since: '2.0', replacement: 'mid.B' } }),
      'mid.B': schema({ type: 'mid.B', deprecation: { message: 'use C', replacement: 'new.C' } }),
      'new.C': schema({ type: 'new.C' }),
    }
    const info = replacementBadgeInfo({
      doc: d, graphId: 'g0', nodeId: 'n1', resolve: (t) => schemas[t], item: undefined, problems: [],
    })
    expect(info?.deprecation).toEqual({ message: 'use B', since: '2.0', replacement: 'mid.B' })
    expect(info?.pointer).toEqual({ terminal: 'new.C', path: ['mid.B', 'new.C'], status: 'ok' })
  })

  it('yields no deprecation and no pointer when the schema is unresolved', () => {
    const info = replacementBadgeInfo({
      doc: d, graphId: 'g0', nodeId: 'n1', resolve: () => undefined, item: undefined, problems: [],
    })
    expect(info?.type).toBe('old.Node')
    expect(info?.deprecation).toBeUndefined()
    expect(info?.pointer).toBeUndefined()
  })
})
