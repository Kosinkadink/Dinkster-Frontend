
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, scopeClosure, type CompileInput } from '../src/compile/compile.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { Diagnostic } from '../src/diagnostics.js'
import type {
  GraphDef,
  SelectorData,
  SelectorPolicy,
  ValueSourceData,
  WorkflowDocument,
} from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { checkDocument } from '../src/invariants.js'
import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
  asSelectorCandidateId,
  asSelectorId,
  asValueSourceId,
} from '../src/ids.js'
import { traceEndpoint, type SelectorResolution } from '../src/reroute.js'
import { historicalSchemas as schemas } from './fixtures/historical-schemas.js'
import { valueSourceConsumersOf } from '../src/value-source.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const resolve = (type: string) => schemas.get(type)

const codesOf = (d: readonly Diagnostic[]) => d.map((x) => x.code)
const errorsOf = (d: readonly Diagnostic[]) => d.filter((x) => x.severity === 'error')

// -- synthetic builders (mirrors value-source.test.ts) ------------------------

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const rr = (id: string) => ({ reroute: asRerouteId(id) })
const vsrc = (id: string) => ({ valueSource: asValueSourceId(id) })
/** Selector OUTPUT endpoint. */
const selOut = (id: string) => ({ selector: asSelectorId(id) })
/** Selector CANDIDATE endpoint. */
const selCand = (id: string, candidate: string) => ({
  selector: asSelectorId(id),
  candidate: asSelectorCandidateId(candidate),
})

const fixed = (candidate: string): SelectorPolicy => ({ kind: 'fixed', candidate: asSelectorCandidateId(candidate) })
const random: SelectorPolicy = { kind: 'random' }

function selector(id: string, candidateIds: readonly string[], policy?: SelectorPolicy, extra: Partial<SelectorData> = {}): SelectorData {
  return {
    id: asSelectorId(id),
    candidates: candidateIds.map((c) => ({ id: asSelectorCandidateId(c) })),
    policy: policy ?? fixed(candidateIds[0]!),
    ...extra,
  }
}

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function doc(graphs: Record<string, GraphDef>, rootId = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(rootId),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, type = 'KSampler', values: Record<string, unknown> = {}) =>
  ({ id: asNodeId(id), type, values }) as GraphDef['nodes'][string]
const reroute = (id: string) => ({ id: asRerouteId(id) })
const source = (id: string, value: unknown, extra: Partial<ValueSourceData> = {}): ValueSourceData =>
  ({ id: asValueSourceId(id), value, ...extra }) as ValueSourceData
const emptyImage = (id: string, color: number) =>
  node(id, 'EmptyImage', { width: 64, height: 64, batch_size: 1, color })

const link = (id: string, from: unknown, to: unknown) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]

const compileInput = (document: WorkflowDocument, extra: Partial<CompileInput> = {}): CompileInput => ({
  document,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
  ...extra,
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())
const clone = <T>(v: T): T => structuredClone(v)

/**
 * The canonical branch document: two producers, one selector, one consumer.
 *   a(EmptyImage color=1) -> s1/ca
 *   b(EmptyImage color=2) -> s1/cb
 *   s1 -> p(PreviewImage).images
 */
function branchDoc(policy: SelectorPolicy = fixed('ca')): WorkflowDocument {
  return doc({
    g0: graph({
      id: 'g0',
      nodes: { a: emptyImage('a', 1), b: emptyImage('b', 2), p: node('p', 'PreviewImage') },
      selectors: { s1: selector('s1', ['ca', 'cb'], policy) },
      links: {
        l1: link('l1', port('a', 'out0'), selCand('s1', 'ca')),
        l2: link('l2', port('b', 'out0'), selCand('s1', 'cb')),
        l3: link('l3', selOut('s1'), port('p', 'images')),
      },
    }),
  })
}

// ---------------------------------------------------------------------------
// tracing (traceEndpoint + index helpers)
// ---------------------------------------------------------------------------

describe('selector tracing', () => {
  const def = branchDoc().graphs['g0']!

  it('a selector chain (selector feeding a selector) traces end to end', () => {
    const g = graph({
      id: 'g0',
      nodes: { a: emptyImage('a', 1) },
      selectors: { s1: selector('s1', ['ca']), s2: selector('s2', ['cx']) },
      links: {
        l1: link('l1', port('a', 'out0'), selCand('s1', 'ca')),
        l2: link('l2', selOut('s1'), selCand('s2', 'cx')),
      },
    })
    const res: SelectorResolution = new Map([
      ['s1', asSelectorCandidateId('ca')],
      ['s2', asSelectorCandidateId('cx')],
    ])
    const trace = traceEndpoint(g, selOut('s2'), undefined, res)
    expect(trace).toMatchObject({ kind: 'output', ref: port('a', 'out0') })
  })

})

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('selector commands', () => {
  it('selector.add creates def + view state from the graph cursor; ONE undo removes both', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0' }) }))
    const out = store.dispatch({
      command: 'selector.add',
      params: { graphId: 'g0', position: { x: 10, y: 20 }, title: 'branch' },
    })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.selectors?.s100).toEqual({
      id: 's100',
      candidates: [{ id: 'c101' }, { id: 'c102' }],
      policy: { kind: 'fixed', candidate: 'c101' },
      title: 'branch',
    })
    expect(g.nextOrdinal).toBe(103)
    expect(store.doc.view.graphs.g0!.selectors?.s100?.position).toEqual({ x: 10, y: 20 })
    expect(errorsOf(checkDocument(store.doc))).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.selectors?.s100).toBeUndefined()
    expect(store.doc.view.graphs.g0?.selectors?.s100).toBeUndefined()
  })

  it('selector.add validates the candidate count', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0' }) }))
    for (const candidates of [0, 65, 1.5]) {
      const out = store.dispatch({ command: 'selector.add', params: { graphId: 'g0', position: { x: 0, y: 0 }, candidates } })
      expect(out.ok).toBe(false)
    }
    const ok = store.dispatch({ command: 'selector.add', params: { graphId: 'g0', position: { x: 0, y: 0 }, candidates: 1 } })
    expect(ok.ok).toBe(true)
    expect(store.doc.graphs.g0!.selectors?.s100?.candidates).toHaveLength(1)
  })

  it('selector.addCandidate appends a cursor-allocated id; undo restores', () => {
    const store = makeStore(branchDoc())
    const out = store.dispatch({ command: 'selector.addCandidate', params: { graphId: 'g0', selectorId: 's1', title: 'draft' } })
    expect(out.ok).toBe(true)
    const sel = store.doc.graphs.g0!.selectors!.s1!
    expect(sel.candidates.map((c) => c.id)).toEqual(['ca', 'cb', 'c100'])
    expect(sel.candidates[2]!.title).toBe('draft')
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(101)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.candidates).toHaveLength(2)
  })

  it('selector.removeCandidate drops the branch, cascades its incoming link, and repairs a fixed policy deterministically', () => {
    const store = makeStore(branchDoc(fixed('ca')))
    const out = store.dispatch({ command: 'selector.removeCandidate', params: { graphId: 'g0', selectorId: 's1', candidateId: 'ca' } })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.selectors!.s1!.candidates.map((c) => c.id)).toEqual(['cb'])
    // Fixed policy pointed at the removed candidate: repointed to the FIRST
    // remaining candidate (deterministic, never silent-random).
    expect(g.selectors!.s1!.policy).toEqual({ kind: 'fixed', candidate: 'cb' })
    expect(g.links.l1).toBeUndefined() // incoming feed cascaded
    expect(g.links.l2).toBeDefined()
    expect(g.links.l3).toBeDefined() // output fan-out untouched
    expect(errorsOf(checkDocument(store.doc))).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.links.l1).toBeDefined()
    expect(store.doc.graphs.g0!.selectors!.s1!.policy).toEqual({ kind: 'fixed', candidate: 'ca' })
  })

  it('selector.removeCandidate keeps an unrelated fixed policy untouched', () => {
    const store = makeStore(branchDoc(fixed('ca')))
    const out = store.dispatch({ command: 'selector.removeCandidate', params: { graphId: 'g0', selectorId: 's1', candidateId: 'cb' } })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.policy).toEqual({ kind: 'fixed', candidate: 'ca' })
  })

  it('selector.removeCandidate rejects removing the LAST candidate', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', selectors: { s1: selector('s1', ['ca']) } }) }))
    const out = store.dispatch({ command: 'selector.removeCandidate', params: { graphId: 'g0', selectorId: 's1', candidateId: 'ca' } })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(codesOf(out.diagnostics)).toContain('selector.lastCandidate')
  })

  it('selector.reorderCandidates requires a true permutation and keeps ids stable', () => {
    const store = makeStore(branchDoc())
    for (const order of [['ca'], ['ca', 'ca'], ['ca', 'nope'], ['ca', 'cb', 'cc']]) {
      expect(store.dispatch({ command: 'selector.reorderCandidates', params: { graphId: 'g0', selectorId: 's1', order } }).ok).toBe(false)
    }
    const out = store.dispatch({ command: 'selector.reorderCandidates', params: { graphId: 'g0', selectorId: 's1', order: ['cb', 'ca'] } })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.candidates.map((c) => c.id)).toEqual(['cb', 'ca'])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.candidates.map((c) => c.id)).toEqual(['ca', 'cb'])
  })

  it('selector.setPolicy validates fixed candidates; random is always acceptable', () => {
    const store = makeStore(branchDoc())
    expect(store.dispatch({ command: 'selector.setPolicy', params: { graphId: 'g0', selectorId: 's1', policy: { kind: 'fixed', candidate: 'nope' } } }).ok).toBe(false)
    expect(store.dispatch({ command: 'selector.setPolicy', params: { graphId: 'g0', selectorId: 's1', policy: { kind: 'chaos' } } }).ok).toBe(false)
    const out = store.dispatch({ command: 'selector.setPolicy', params: { graphId: 'g0', selectorId: 's1', policy: { kind: 'random' } } })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.policy).toEqual({ kind: 'random' })
  })

  it('selector.setTitle / setCandidateTitle / move behave and undo', () => {
    const store = makeStore(branchDoc())
    expect(store.dispatch({ command: 'selector.setTitle', params: { graphId: 'g0', selectorId: 's1', title: 'quality' } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.title).toBe('quality')
    expect(store.dispatch({ command: 'selector.setCandidateTitle', params: { graphId: 'g0', selectorId: 's1', candidateId: 'cb', title: 'draft' } }).ok).toBe(true)
    expect(store.doc.graphs.g0!.selectors!.s1!.candidates[1]!.title).toBe('draft')
    expect(store.dispatch({ command: 'selector.move', params: { graphId: 'g0', positions: { s1: { x: 5, y: 6 } } } }).ok).toBe(true)
    expect(store.doc.view.graphs.g0!.selectors?.s1?.position).toEqual({ x: 5, y: 6 })
    expect(store.undo()).toBe(true)
    expect(store.doc.view.graphs.g0?.selectors?.s1).toBeUndefined()
  })

  it('selector.remove cascades feeds, fan-out, and view state in ONE transaction', () => {
    const store = makeStore(branchDoc())
    store.dispatch({ command: 'selector.move', params: { graphId: 'g0', positions: { s1: { x: 1, y: 2 } } } })
    const out = store.dispatch({ command: 'selector.remove', params: { graphId: 'g0', selectorIds: ['s1'] } })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.selectors?.s1).toBeUndefined()
    expect(g.links.l1).toBeUndefined()
    expect(g.links.l2).toBeUndefined()
    expect(g.links.l3).toBeUndefined()
    expect(store.doc.view.graphs.g0?.selectors?.s1).toBeUndefined()
    expect(errorsOf(checkDocument(store.doc))).toEqual([])
    expect(store.undo()).toBe(true) // ONE undo restores everything
    expect(store.doc.graphs.g0!.selectors?.s1).toBeDefined()
    expect(store.doc.graphs.g0!.links.l1).toBeDefined()
    expect(store.doc.graphs.g0!.links.l3).toBeDefined()
    expect(store.doc.view.graphs.g0!.selectors?.s1?.position).toEqual({ x: 1, y: 2 })
  })

  it('graph.deleteItems with selectorIds matches selector.remove', () => {
    const store = makeStore(branchDoc())
    const out = store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', selectorIds: ['s1'] } })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.selectors?.s1).toBeUndefined()
    expect(Object.keys(g.links)).toEqual([])
    expect(errorsOf(checkDocument(store.doc))).toEqual([])
  })

  it('deleting a producer node cascades its candidate-feed link but keeps the selector', () => {
    const store = makeStore(branchDoc())
    const out = store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', nodeIds: ['a'] } })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.links.l1).toBeUndefined()
    expect(g.selectors?.s1).toBeDefined()
    expect(errorsOf(checkDocument(store.doc))).toEqual([])
  })
})

describe('selector connections', () => {
  it('link.connect drives a candidate and displaces its previous driver (one driver, I11)', () => {
    const store = makeStore(branchDoc())
    const out = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'b', port: 'out0' }, to: { selector: 's1', candidate: 'ca' } },
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.links.l1).toBeUndefined() // displaced
    const added = Object.values(g.links).find((l) => 'selector' in l.to && l.to.candidate === 'ca')
    expect(added?.from).toEqual({ node: 'b', port: 'out0' })
    expect(errorsOf(checkDocument(store.doc))).toEqual([])
  })

  it('rejects a candidate as a link SOURCE and an output as a link TARGET', () => {
    const store = makeStore(branchDoc())
    const asSource = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { selector: 's1', candidate: 'ca' }, to: { node: 'p', port: 'images' } },
    })
    expect(asSource.ok).toBe(false)
    if (!asSource.ok) expect(codesOf(asSource.diagnostics)).toContain('link.selectorCandidateSource')
    const asTarget = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'a', port: 'out0' }, to: { selector: 's1' } },
    })
    expect(asTarget.ok).toBe(false)
    if (!asTarget.ok) expect(codesOf(asTarget.diagnostics)).toContain('link.selectorOutputTarget')
  })

  it('rejects self-loops and mixed selector/reroute cycles atomically', () => {
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        reroutes: { r1: reroute('r1') },
        selectors: { s1: selector('s1', ['ca', 'cb']), s2: selector('s2', ['cx']) },
        links: {
          l1: link('l1', selOut('s1'), selCand('s2', 'cx')),
          l2: link('l2', selOut('s2'), rr('r1')),
        },
      }),
    }))
    const self = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { selector: 's1' }, to: { selector: 's1', candidate: 'ca' } },
    })
    expect(self.ok).toBe(false)
    if (!self.ok) expect(codesOf(self.diagnostics)).toContain('link.selfLoop')
    // r1 <- s2 <- s1: closing r1 -> s1/cb loops through BOTH junction kinds,
    // and cb is not even the currently chosen branch - still rejected.
    const mixed = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { reroute: 'r1' }, to: { selector: 's1', candidate: 'cb' } },
    })
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(codesOf(mixed.diagnostics)).toContain('selector.cycle')
  })

  it('unknown selector/candidate endpoints are rejected', () => {
    const store = makeStore(branchDoc())
    const badSel = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'a', port: 'out0' }, to: { selector: 'nope', candidate: 'ca' } },
    })
    expect(badSel.ok).toBe(false)
    const badCand = store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { node: 'a', port: 'out0' }, to: { selector: 's1', candidate: 'nope' } },
    })
    expect(badCand.ok).toBe(false)
    if (!badCand.ok) expect(codesOf(badCand.diagnostics)).toContain('selector.candidateMissing')
  })
})

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

describe('selector compile', () => {
  it('fixed policy: chosen branch lowers, unchosen branch VANISHES from the prompt', () => {
    const result = compile(compileInput(branchDoc(fixed('ca'))))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'p'])
    expect(result.artifact.prompt['p']!.inputs['images']).toEqual(['a', 0])
    expect(result.artifact.choices).toEqual([
      { graph: 'g0', selector: 's1', policy: 'fixed', candidate: 'ca' },
    ])
  })

  it('switching the fixed candidate switches the branch', () => {
    const result = compile(compileInput(branchDoc(fixed('cb'))))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['b', 'p'])
    expect(result.artifact.prompt['p']!.inputs['images']).toEqual(['b', 0])
  })

  it.each([fixed('cb'), random])('replays an exact candidate over a %s live policy', (policy) => {
    const result = compile(compileInput(branchDoc(policy), {
      candidateOverride: ({ graph, selector, candidates }) => {
        expect({ graph, selector, candidates }).toEqual({ graph: 'g0', selector: 's1', candidates: ['ca', 'cb'] })
        return 'ca'
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'p'])
    expect(result.artifact.prompt.p!.inputs.images).toEqual(['a', 0])
  })

  it('rejects a candidate override that is not present', () => {
    const result = compile(compileInput(branchDoc(), { candidateOverride: () => 'missing' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(codesOf(result.diagnostics)).toContain('compile.selector.overrideDangling')
  })

  it('random policy uses the INJECTED chooser and records the exact outcome', () => {
    const calls: { graph: string; selector: string; count: number }[] = []
    const result = compile(compileInput(branchDoc(random), {
      pickCandidate: (ctx) => {
        calls.push(ctx)
        return 1
      },
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toEqual([{ graph: 'g0', selector: 's1', count: 2 }])
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['b', 'p'])
    expect(result.artifact.choices).toEqual([
      { graph: 'g0', selector: 's1', policy: 'random', candidate: 'cb' },
    ])
    expect(result.artifact.provenance.randomSelectorInputs).toEqual({ p: ['images'] })
  })

  it('random policy WITHOUT a chooser is a compile error - no ambient randomness', () => {
    const result = compile(compileInput(branchDoc(random)))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(codesOf(result.diagnostics)).toContain('compile.selector.noChooser')
  })

  it('a dangling fixed policy errors EVEN when the selector is unconsumed (eager resolution)', () => {
    const d = clone(branchDoc(fixed('ca'))) as unknown as {
      graphs: Record<string, { links: Record<string, unknown>; selectors: Record<string, { policy: { candidate: string } }> }>
    }
    delete d.graphs['g0']!.links['l3'] // selector output feeds nothing now
    d.graphs['g0']!.selectors['s1']!.policy.candidate = 'nope'
    const result = compile(compileInput(d as unknown as WorkflowDocument))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(codesOf(result.diagnostics)).toContain('compile.selector.policyDangling')
  })

  it('an undriven CHOSEN candidate drops the edge with a warning', () => {
    const d = clone(branchDoc(fixed('ca'))) as unknown as { graphs: Record<string, { links: Record<string, unknown> }> }
    delete d.graphs['g0']!.links['l1'] // chosen branch has no feed
    const result = compile(compileInput(d as unknown as WorkflowDocument))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(codesOf(result.artifact.diagnostics)).toContain('compile.selector.undriven')
    expect(result.artifact.prompt['p']!.inputs['images']).toBeUndefined()
  })

  it('reroutes before AND after the selector compose in the lowered prompt', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { a: emptyImage('a', 1), b: emptyImage('b', 2), p: node('p', 'PreviewImage') },
        reroutes: { r1: reroute('r1'), r2: reroute('r2') },
        selectors: { s1: selector('s1', ['ca', 'cb'], fixed('ca')) },
        links: {
          l1: link('l1', port('a', 'out0'), rr('r1')),
          l2: link('l2', rr('r1'), selCand('s1', 'ca')),
          l3: link('l3', port('b', 'out0'), selCand('s1', 'cb')),
          l4: link('l4', selOut('s1'), rr('r2')),
          l5: link('l5', rr('r2'), port('p', 'images')),
        },
      }),
    })
    const result = compile(compileInput(d))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'p'])
    expect(result.artifact.prompt['p']!.inputs['images']).toEqual(['a', 0])
  })

  it('value sources bake THROUGH the chosen branch and not the unchosen one', () => {
    const build = (policy: SelectorPolicy) => doc({
      g0: graph({
        id: 'g0',
        nodes: { e: node('e', 'EmptyImage', { width: 64, height: 64, batch_size: 1, color: 0 }), p: node('p', 'PreviewImage') },
        valueSources: { v1: source('v1', 123), v2: source('v2', 55) },
        selectors: { s1: selector('s1', ['ca', 'cb'], policy) },
        links: {
          l1: link('l1', vsrc('v1'), selCand('s1', 'ca')),
          l2: link('l2', vsrc('v2'), selCand('s1', 'cb')),
          l3: link('l3', selOut('s1'), port('e', 'color')),
          l4: link('l4', port('e', 'out0'), port('p', 'images')),
        },
      }),
    })
    const first = compile(compileInput(build(fixed('ca'))))
    expect(first.ok, JSON.stringify(!first.ok && first.diagnostics)).toBe(true)
    if (first.ok) expect(first.artifact.prompt['e']!.inputs['color']).toBe(123)
    const second = compile(compileInput(build(fixed('cb'))))
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.artifact.prompt['e']!.inputs['color']).toBe(55)
  })

  it('partial scope excludes the unchosen branch; scopeClosure agrees with compile', () => {
    const d = branchDoc(fixed('ca'))
    const closure = scopeClosure(compileInput(d, {
      scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('p') }] },
    }))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['a', 'p'])
  })

  it('per-DEFINITION resolution: all occurrences of a subgraph share ONE choice', () => {
    // g1 owns producers + selector + its own PreviewImage; instantiated twice.
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { i0: node('i0', '#g1'), i1: node('i1', '#g1') },
      }),
      g1: graph({
        id: 'g1',
        name: 'branchy',
        boundary: { inputs: [], outputs: [] },
        nodes: { a: emptyImage('a', 1), b: emptyImage('b', 2), p: node('p', 'PreviewImage') },
        selectors: { s1: selector('s1', ['ca', 'cb'], random) },
        links: {
          l1: link('l1', port('a', 'out0'), selCand('s1', 'ca')),
          l2: link('l2', port('b', 'out0'), selCand('s1', 'cb')),
          l3: link('l3', selOut('s1'), port('p', 'images')),
        },
      }),
    })
    let calls = 0
    const result = compile(compileInput(d, {
      pickCandidate: () => {
        calls += 1
        return 1
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    // ONE draw for the definition, shared by both occurrences - exactly like
    // occurrences share widget values and dynamic state.
    expect(calls).toBe(1)
    expect(result.artifact.choices).toEqual([
      { graph: 'g1', selector: 's1', policy: 'random', candidate: 'cb' },
    ])
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['i0.b', 'i0.p', 'i1.b', 'i1.p'])
    expect(result.artifact.prompt['i0.p']!.inputs['images']).toEqual(['i0.b', 0])
    expect(result.artifact.prompt['i1.p']!.inputs['images']).toEqual(['i1.b', 0])
  })

  it('a muted chosen producer drops the edge like any muted producer', () => {
    const d = clone(branchDoc(fixed('ca'))) as unknown as {
      graphs: Record<string, { nodes: Record<string, { mode?: string }> }>
    }
    d.graphs['g0']!.nodes['a']!.mode = 'muted'
    const result = compile(compileInput(d as unknown as WorkflowDocument))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a']).toBeUndefined()
    expect(result.artifact.prompt['p']!.inputs['images']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// semantic hash
// ---------------------------------------------------------------------------

describe('selector semantic hash', () => {
  const base = semanticHashOf(branchDoc(fixed('ca')))

  it('changing the fixed candidate changes the hash', () => {
    expect(semanticHashOf(branchDoc(fixed('cb')))).not.toBe(base)
  })

  it('selector and candidate TITLES are hash-neutral (display chrome)', () => {
    const d = clone(branchDoc(fixed('ca'))) as unknown as {
      graphs: Record<string, { selectors: Record<string, { title?: string; candidates: { title?: string }[] }> }>
    }
    d.graphs['g0']!.selectors['s1']!.title = 'quality'
    d.graphs['g0']!.selectors['s1']!.candidates[0]!.title = 'hires'
    expect(semanticHashOf(d as unknown as WorkflowDocument)).toBe(base)
  })

  it('changing which producer feeds a branch changes the hash', () => {
    const d = clone(branchDoc(fixed('ca')))
    const l1 = d.graphs['g0']!.links['l1']! as { from: unknown }
    l1.from = port('b', 'out0') // both branches now fed by b
    expect(semanticHashOf(d)).not.toBe(base)
  })

})

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

describe('selector invariants', () => {

  it('flags dangling fixed policy, duplicate candidates, and multi-drivers', () => {
    const d = clone(branchDoc()) as unknown as {
      graphs: Record<string, {
        links: Record<string, unknown>
        selectors: Record<string, { policy: { candidate: string }; candidates: { id: string }[] }>
      }>
    }
    d.graphs['g0']!.selectors['s1']!.policy.candidate = 'nope'
    d.graphs['g0']!.selectors['s1']!.candidates.push({ id: 'ca' })
    d.graphs['g0']!.links['lX'] = { id: 'lX', from: port('b', 'out0'), to: selCand('s1', 'ca') }
    const codes = codesOf(checkDocument(d as unknown as WorkflowDocument))
    expect(codes).toContain('doc.selector.policyDangling')
    expect(codes).toContain('doc.selector.candidateDuplicate')
    expect(codes).toContain('doc.selector.multiDriver')
  })

  it('flags a structural selector cycle across ALL candidates', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        selectors: { s1: selector('s1', ['ca', 'cb'], fixed('ca')), s2: selector('s2', ['cx']) },
        links: {
          l1: link('l1', selOut('s1'), selCand('s2', 'cx')),
          // Cycle through the branch the fixed policy does NOT pick.
          l2: link('l2', selOut('s2'), selCand('s1', 'cb')),
        },
      }),
    })
    expect(codesOf(checkDocument(d))).toContain('doc.selector.cycle')
  })

})

// ---------------------------------------------------------------------------
// value sources
// ---------------------------------------------------------------------------

describe('value sources through selectors', () => {
  it('consumer discovery follows candidate feeds to the selector output fan-out (conservative: policy can change)', () => {
    const def = doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        reroutes: { r1: reroute('r1') },
        valueSources: { v1: source('v1', 7) },
        selectors: { s1: selector('s1', ['ca', 'cb'], fixed('cb')) },
        links: {
          // v1 feeds the branch the policy does NOT currently pick - the
          // consumers must still be discovered for spec derivation.
          l1: link('l1', vsrc('v1'), selCand('s1', 'ca')),
          l2: link('l2', selOut('s1'), rr('r1')),
          l3: link('l3', rr('r1'), port('n1', 'steps')),
          l4: link('l4', selOut('s1'), port('n2', 'steps')),
        },
      }),
    }).graphs['g0']!
    const consumers = valueSourceConsumersOf(def, asValueSourceId('v1'))
    expect(consumers.map((c) => `${c.node}.${c.port}`).sort()).toEqual(['n1.steps', 'n2.steps'])
  })
})

// ---------------------------------------------------------------------------
// format: validation + round-trip
// ---------------------------------------------------------------------------

describe('selector format', () => {
  it('a selector document round-trips through JSON + loadDocument, preserving ext', () => {
    const d = clone(branchDoc(random)) as unknown as {
      graphs: Record<string, { selectors: Record<string, { ext?: unknown }> }>
      view: { graphs: Record<string, unknown> }
    }
    d.graphs['g0']!.selectors['s1']!.ext = { 'com.example': { note: 'keep me' } }
    d.view.graphs['g0'] = { nodes: {}, selectors: { s1: { position: { x: 3, y: 4 } } } }
    const json = JSON.parse(JSON.stringify(d)) as unknown
    const loaded = loadDocument(json)
    expect(errorsOf(loaded.diagnostics ?? [])).toEqual([])
    expect(loaded.document).toBeDefined()
    expect(loaded.document).toEqual(d)
  })

  it('rejects malformed selector records', () => {
    const bad = clone(branchDoc()) as unknown as {
      graphs: Record<string, { selectors: Record<string, { policy: unknown }> }>
    }
    bad.graphs['g0']!.selectors['s1']!.policy = { kind: 'chaos' }
    const loaded = loadDocument(JSON.parse(JSON.stringify(bad)))
    expect(loaded.document).toBeUndefined()
    expect(errorsOf(loaded.diagnostics ?? []).length).toBeGreaterThan(0)
  })

})

// ---------------------------------------------------------------------------
// would-run closure (scopeClosure: structural traversal + random superset)
// ---------------------------------------------------------------------------

describe('selector would-run closure', () => {
  const partial = (...nodes: string[]): CompileInput['scope'] => ({
    kind: 'partial',
    targets: nodes.map((n) => ({ instancePath: [], node: asNodeId(n) })),
  })

  it('fixed policy stays EXACT: only the chosen branch, structural records only its candidate', () => {
    const closure = scopeClosure(compileInput(branchDoc(fixed('cb')), { scope: partial('p') }))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['b', 'p'])
    const g = closure!.structural.get('g0')
    expect(g).toBeDefined()
    expect([...g!.selectors.keys()]).toEqual(['s1'])
    expect([...g!.selectors.get('s1')!]).toEqual(['cb'])
  })

  it('random policy needs NO chooser and widens to EVERY candidate (may-run superset)', () => {
    const closure = scopeClosure(compileInput(branchDoc(random), { scope: partial('p') }))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['a', 'b', 'p'])
    expect([...closure!.structural.get('g0')!.selectors.get('s1')!].sort()).toEqual(['ca', 'cb'])
  })

  it('reroutes on the CHOSEN branch and after the output register; unchosen-branch reroutes do not', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { a: emptyImage('a', 1), b: emptyImage('b', 2), p: node('p', 'PreviewImage') },
        reroutes: { r1: reroute('r1'), r2: reroute('r2'), r3: reroute('r3') },
        selectors: { s1: selector('s1', ['ca', 'cb'], fixed('ca')) },
        links: {
          l1: link('l1', port('a', 'out0'), rr('r1')),
          l2: link('l2', rr('r1'), selCand('s1', 'ca')),
          l3: link('l3', port('b', 'out0'), rr('r3')),
          l3b: link('l3b', rr('r3'), selCand('s1', 'cb')),
          l4: link('l4', selOut('s1'), rr('r2')),
          l5: link('l5', rr('r2'), port('p', 'images')),
        },
      }),
    })
    const closure = scopeClosure(compileInput(d, { scope: partial('p') }))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['a', 'p'])
    const g = closure!.structural.get('g0')!
    expect([...g.reroutes].sort()).toEqual(['r1', 'r2'])
    expect([...g.selectors.get('s1')!]).toEqual(['ca'])
  })

  it('a value source on the CHOSEN branch registers; the unchosen one does not', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { e: node('e', 'EmptyImage', { width: 64, height: 64, batch_size: 1, color: 0 }), p: node('p', 'PreviewImage') },
        valueSources: { v1: source('v1', 123), v2: source('v2', 55) },
        selectors: { s1: selector('s1', ['ca', 'cb'], fixed('ca')) },
        links: {
          l1: link('l1', vsrc('v1'), selCand('s1', 'ca')),
          l2: link('l2', vsrc('v2'), selCand('s1', 'cb')),
          l3: link('l3', selOut('s1'), port('e', 'color')),
          l4: link('l4', port('e', 'out0'), port('p', 'images')),
        },
      }),
    })
    const closure = scopeClosure(compileInput(d, { scope: partial('p') }))
    expect(closure).toBeDefined()
    const g = closure!.structural.get('g0')!
    expect([...g.valueSources]).toEqual(['v1'])
    expect([...g.selectors.get('s1')!]).toEqual(['ca'])
  })

})
