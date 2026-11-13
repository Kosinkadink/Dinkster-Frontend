/**
 * Actor-scoped id allocation (multiplayer prerequisite; commands/alloc.ts).
 *
 * Two collab actors dispatching concurrently from one graph-wide cursor
 * would mint the same id, and server ordering cannot repair that. With an
 * actor on the invocation, ids mint as `<prefix><ordinal>-<actor>` from that
 * actor's own cursor (GraphDef.actorCursors), and each actor writes only
 * its own cursor key.
 *
 * Solo mode (no actor) must remain byte-for-byte unchanged.
 */
import { describe, expect, it } from 'vitest'
import { planClipboardPaste, serializeSelection } from '../src/clipboard.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asSelectorCandidateId, asSelectorId } from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })

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

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, type = 'KSampler') => ({ id: asNodeId(id), type, values: {} })

const makeStore = (d?: WorkflowDocument) =>
  new DocumentStore(d ?? doc({ g0: graph({ id: 'g0' }) }), coreCommandRegistry())

const addNode = (store: DocumentStore, actor?: string) =>
  store.dispatch({
    command: 'node.add',
    params: { graphId: 'g0', type: 'CLIPTextEncode', position: { x: 0, y: 0 } },
    ...(actor !== undefined ? { actor } : {}),
  })

describe('actor-scoped allocation', () => {
  it('two actors from the same document state mint DIFFERENT ids', () => {
    // Same base document for both stores: this is exactly the concurrent
    // collab race (both actors at the same revision). Solo allocation
    // would mint n100 twice.
    const a = makeStore()
    const b = makeStore()
    const outA = addNode(a, 'alice')
    const outB = addNode(b, 'bob')
    expect(outA.ok && outB.ok).toBe(true)
    expect(Object.keys(a.doc.graphs.g0!.nodes)).toEqual(['n0-alice'])
    expect(Object.keys(b.doc.graphs.g0!.nodes)).toEqual(['n0-bob'])
  })

  it('each actor advances ONLY its own cursor key; solo cursor untouched', () => {
    const store = makeStore()
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(addNode(store, 'bob').ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.actorCursors).toEqual({ alice: 2, bob: 1 })
    expect(g.nextOrdinal).toBe(100) // never consumed by actor allocation
    expect(Object.keys(g.nodes).sort()).toEqual(['n0-alice', 'n1-alice', 'n0-bob'].sort())
  })

  it('solo and actor allocation coexist on one graph without interference', () => {
    const store = makeStore()
    expect(addNode(store).ok).toBe(true) // n100 (solo)
    expect(addNode(store, 'alice').ok).toBe(true) // n0-alice
    expect(addNode(store).ok).toBe(true) // n101 (solo)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes).sort()).toEqual(['n100', 'n101', 'n0-alice'].sort())
    expect(g.nextOrdinal).toBe(102)
    expect(g.actorCursors).toEqual({ alice: 1 })
  })

  it('multi-id commands advance one actor cursor across all mints (reroute.insert)', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1'), n2: node('n2') },
          links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'reroute.insert',
      params: { graphId: 'g0', linkId: 'l4', position: { x: 1, y: 2 } },
      actor: 'alice',
    })
    expect(out.ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.reroutes['r0-alice']).toBeDefined()
    expect(g.links['l1-alice']).toBeDefined()
    expect(g.links['l2-alice']).toBeDefined()
    expect(g.actorCursors).toEqual({ alice: 3 })
  })

  it('rejects an invalid actor id atomically at dispatch ingress', () => {
    const store = makeStore()
    for (const bad of ['', 'a.b', 'a b', 'a/b', '$region']) {
      const out = addNode(store, bad)
      expect(out.ok, JSON.stringify(bad)).toBe(false)
      if (!out.ok) expect(out.diagnostics[0]!.code).toBe('command.actor.invalid')
    }
    expect(store.revision).toBe(0)
  })
})

describe('undo/redo: actor cursors are never rewound (CO3)', () => {
  it('undoing the FIRST actor allocation keeps the cursor high-water mark', () => {
    const store = makeStore()
    expect(addNode(store, 'alice').ok).toBe(true) // creates actorCursors map
    expect(store.undo()).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes['n0-alice']).toBeUndefined() // the node IS un-added
    expect(g.actorCursors).toEqual({ alice: 1 }) // the cursor is NOT
    // Re-allocating after undo mints a FRESH id - never n0-alice again.
    expect(addNode(store, 'alice').ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes['n1-alice']).toBeDefined()
    expect(store.doc.graphs.g0!.nodes['n0-alice']).toBeUndefined()
  })

})

describe('I6 invariant: actor-suffixed ids check against their actor cursor', () => {

  it('actor ids never check against nextOrdinal (disjoint id spaces)', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nextOrdinal: 0, // way below the actor ordinal - must not matter
        nodes: { 'n5-alice': node('n5-alice') },
        actorCursors: { alice: 6 },
      }),
    })
    expect(checkDocument(d).some((d2) => d2.code === 'doc.id.aboveCursor')).toBe(false)
  })

  it('candidate identity stays selector-scoped: cross-selector reuse is legal, same-selector repeats are not', () => {
    // Legitimate producers (format/synthetic.ts among them) reuse candidate
    // ids across selectors - candidates are addressed as (selector,
    // candidate) pairs, so this is NOT a duplicate.
    const sel = (sid: string) => ({
      id: asSelectorId(sid),
      candidates: [{ id: asSelectorCandidateId('ca') }],
      policy: { kind: 'fixed', candidate: asSelectorCandidateId('ca') } as const,
    })
    const shared = doc({ g0: graph({ id: 'g0', selectors: { sel1: sel('sel1'), sel2: sel('sel2') } }) })
    expect(checkDocument(shared).filter((d) => d.severity === 'error')).toEqual([])
    // Same-selector repeats stay flagged.
    const duped = doc({
      g0: graph({
        id: 'g0',
        selectors: {
          sel1: {
            id: asSelectorId('sel1'),
            candidates: [{ id: asSelectorCandidateId('ca') }, { id: asSelectorCandidateId('ca') }],
            policy: { kind: 'fixed', candidate: asSelectorCandidateId('ca') } as const,
          },
        },
      }),
    })
    expect(checkDocument(duped).some((d) => d.code === 'doc.selector.candidateDuplicate')).toBe(true)
  })

  it("an actor named 'constructor' allocates from zero and advances its OWN cursor", () => {
    const store = makeStore()
    expect(addNode(store, 'constructor').ok).toBe(true)
    expect(addNode(store, 'constructor').ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes).sort()).toEqual(['n0-constructor', 'n1-constructor'])
    expect(Object.hasOwn(g.actorCursors!, 'constructor')).toBe(true)
    expect(g.actorCursors!['constructor']).toBe(2)
    expect(checkDocument(store.doc).some((d) => d.code === 'doc.id.aboveCursor')).toBe(false)
  })
})

describe('clipboard paste under actor allocation', () => {
  const source = (): WorkflowDocument =>
    doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
      }),
    }) as WorkflowDocument & { view: { graphs: Record<string, unknown> } }

  const withView = (): WorkflowDocument => {
    const d = source()
    return {
      ...d,
      view: {
        graphs: {
          g0: { nodes: { n1: { position: { x: 0, y: 0 } }, n2: { position: { x: 50, y: 0 } } } },
        },
      },
    } as WorkflowDocument
  }

  it('predicts actor-suffixed ids that dispatch then mints EXACTLY', () => {
    const d = withView()
    const envelope = serializeSelection(d, 'g0', { nodes: ['n1', 'n2'], reroutes: [] })!
    const plan = planClipboardPaste(d, 'g0', envelope, { x: 10, y: 10 }, 'alice')!
    expect(plan.nodeIds).toEqual(['n0-alice', 'n1-alice'])
    expect(plan.invocation.actor).toBe('alice')
    const store = makeStore(d)
    expect(store.dispatch(plan.invocation).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes['n0-alice']).toBeDefined()
    expect(g.nodes['n1-alice']).toBeDefined()
    expect(g.links['l2-alice']).toBeDefined() // retained link, same allocator
    expect(g.actorCursors).toEqual({ alice: 3 })
    expect(g.nextOrdinal).toBe(100) // untouched
  })

  it('two actors pasting the same envelope from the same base cannot collide', () => {
    const d = withView()
    const envelope = serializeSelection(d, 'g0', { nodes: ['n1', 'n2'], reroutes: [] })!
    const planA = planClipboardPaste(d, 'g0', envelope, { x: 10, y: 10 }, 'alice')!
    const planB = planClipboardPaste(d, 'g0', envelope, { x: 20, y: 20 }, 'bob')!
    const ids = [...planA.nodeIds, ...planB.nodeIds]
    expect(new Set(ids).size).toBe(ids.length)
    // Apply both to ONE store (the server-ordered outcome): no overwrites.
    const store = makeStore(withView())
    expect(store.dispatch(planA.invocation).ok).toBe(true)
    expect(store.dispatch(planB.invocation).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(Object.keys(g.nodes).sort()).toEqual(
      ['n1', 'n2', 'n0-alice', 'n1-alice', 'n0-bob', 'n1-bob'].sort(),
    )
    expect(g.actorCursors).toEqual({ alice: 3, bob: 3 })
  })

})
