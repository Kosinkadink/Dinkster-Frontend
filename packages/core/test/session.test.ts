/**
 * DocumentSession seam (platform-plan 2.3): the local implementation over
 * DocumentStore, its envelope-shaped op feed, and the collab wire patch
 * conversion (Dinkster ca01157: add|remove|replace, segment-array paths,
 * value absent on remove, no oldValue).
 */
import { describe, expect, it } from 'vitest'
import { diag } from '../src/diagnostics.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import type { PatchOp } from '../src/commands/patch.js'
import { createLocalSession, toWirePatch, type SessionOp } from '../src/commands/session.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId } from '../src/ids.js'

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

function makeSession(actorId?: string) {
  const ops: SessionOp[] = []
  const session = createLocalSession(
    doc({
      g0: graph({
        id: 'g0',
        nodes: { n1: node('n1'), n2: node('n2') },
        links: { l4: { id: asLinkId('l4'), from: port('n1', 'out0'), to: port('n2', 'model') } },
      }),
    }),
    coreCommandRegistry(),
    { ...(actorId !== undefined ? { actorId } : {}), clock: () => 12345 },
  )
  session.onOp((op) => ops.push(op))
  return { session, ops }
}

const addNode = { command: 'node.add', params: { graphId: 'g0', type: 'X', position: { x: 0, y: 0 } } }

describe('local DocumentSession', () => {
  it.each(['dispatch', 'prepared', 'undo', 'redo'] as const)('refuses %s before publication without losing history', (route) => {
    let blocked = false
    const session = createLocalSession(doc({ g0: graph({ id: 'g0' }) }), coreCommandRegistry(), {
      validateCommit: () => blocked ? [diag('error', 'command', 'test.refused', 'Publication refused')] : [],
    })
    if (route === 'undo' || route === 'redo') session.dispatch(addNode)
    if (route === 'redo') session.undo()
    const candidate = route === 'prepared' ? session.prepareDispatch!(addNode) : undefined
    const original = session.doc
    const history = session.historySnapshot()
    const published: WorkflowDocument[] = []
    const operations: SessionOp[] = []
    session.document.subscribe((document) => published.push(document))
    session.onOp((operation) => operations.push(operation))
    blocked = true
    const outcome = route === 'dispatch' ? session.dispatch(addNode)
      : route === 'prepared' ? candidate!.ok ? candidate!.commit() : candidate!
        : route === 'undo' ? session.undo() : session.redo()
    if (typeof outcome === 'boolean') expect(outcome).toBe(false)
    else expect(outcome).toMatchObject({ ok: false, diagnostics: [{ code: 'test.refused' }] })
    expect(session.doc).toBe(original)
    expect(session.historySnapshot()).toEqual(history)
    expect(published).toEqual([])
    expect(operations).toEqual([])
    blocked = false
    if (route === 'undo') expect(session.undo()).toBe(true)
    else if (route === 'redo') expect(session.redo()).toBe(true)
    else expect(session.dispatch(addNode).ok).toBe(true)
    expect(operations).toHaveLength(1)
  })

  it('predicts the same solo node id that node.add mints, and reports a missing graph', () => {
    const { session } = makeSession()
    expect(session.predictedNodeId('missing')).toBeUndefined()
    const predicted = session.predictedNodeId('g0')
    expect(predicted).toBe('n100')
    expect(session.dispatch(addNode).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes[predicted!]).toBeDefined()
  })

  it('clearHistory adopts the current document as baseline: no undo/redo, doc and revision untouched, no op emitted', () => {
    const { session, ops } = makeSession()
    session.dispatch(addNode)
    session.undo()
    expect(session.canRedo).toBe(true)
    const docBefore = session.doc
    const revisionBefore = session.revision
    const opsBefore = ops.length
    session.clearHistory()
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(false)
    expect(session.undo()).toBe(false)
    expect(session.redo()).toBe(false)
    expect(session.doc).toBe(docBefore) // the document did not change...
    expect(session.revision).toBe(revisionBefore) // ...and neither did its revision
    expect(ops.length).toBe(opsBefore) // nothing rode the op feed
  })

})

describe('toWirePatch', () => {
  it('keeps value on add/replace, strips it from remove, and never carries oldValue', () => {
    const forward: PatchOp[] = [
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n9'], value: { id: 'n9' } },
      { op: 'replace', path: ['graphs', 'g0', 'nextOrdinal'], value: 101, oldValue: 100 },
      { op: 'remove', path: ['graphs', 'g0', 'links', 'l4'], oldValue: { id: 'l4' } },
    ]
    expect(toWirePatch(forward)).toEqual([
      { op: 'add', path: ['graphs', 'g0', 'nodes', 'n9'], value: { id: 'n9' } },
      { op: 'replace', path: ['graphs', 'g0', 'nextOrdinal'], value: 101 },
      { op: 'remove', path: ['graphs', 'g0', 'links', 'l4'] },
    ])
    for (const wireOp of toWirePatch(forward)) {
      expect('oldValue' in wireOp).toBe(false)
    }
  })
})
