import { describe, expect, it } from 'vitest'
import { asNodeId, diag, type Diagnostic } from '@dinkster/core'
import {
  contextProblems,
  deriveFocusContext,
  hasOwningContext,
  type FocusSnapshot,
} from '../src/problem-context.js'

const snapshot = (over: Partial<FocusSnapshot> = {}): FocusSnapshot => ({
  widget: undefined,
  nodes: [],
  links: [],
  groups: [],
  graphId: 'g0',
  rootGraphId: 'g0',
  instancePath: [],
  ...over,
})

const widget = { nodeId: 'n1', valueKey: 'steps', label: 'Steps' }
const group = { id: 'grp1', title: 'Samplers', members: ['n1', 'n2'] }

describe('deriveFocusContext', () => {
  it('maps an empty snapshot at the root to the document context', () => {
    expect(deriveFocusContext(snapshot())).toEqual({ kind: 'document' })
  })

  it('maps each single focus fact to its context kind', () => {
    expect(deriveFocusContext(snapshot({ widget }))).toEqual({ kind: 'widget', ...widget })
    expect(deriveFocusContext(snapshot({ nodes: ['n1'] }))).toEqual({ kind: 'node', nodeIds: ['n1'] })
    expect(deriveFocusContext(snapshot({ links: ['l1'] }))).toEqual({ kind: 'link', linkIds: ['l1'] })
    expect(deriveFocusContext(snapshot({ groups: [group] }))).toEqual({ kind: 'group', groups: [group] })
    expect(deriveFocusContext(snapshot({ graphId: 'g1', instancePath: ['sub1'] })))
      .toEqual({ kind: 'subgraph', graphId: 'g1', instancePath: ['sub1'] })
  })

  it('applies the documented priority order: widget > node > link > group > subgraph > document', () => {
    const everything = snapshot({
      widget,
      nodes: ['n1'],
      links: ['l1'],
      groups: [group],
      graphId: 'g1',
      instancePath: ['sub1'],
    })
    expect(deriveFocusContext(everything).kind).toBe('widget')
    expect(deriveFocusContext({ ...everything, widget: undefined }).kind).toBe('node')
    expect(deriveFocusContext({ ...everything, widget: undefined, nodes: [] }).kind).toBe('link')
    expect(deriveFocusContext({ ...everything, widget: undefined, nodes: [], links: [] }).kind).toBe('group')
    expect(deriveFocusContext({ ...everything, widget: undefined, nodes: [], links: [], groups: [] }).kind).toBe('subgraph')
  })

  it('treats a subgraph view with an out-of-sync instance path as the document', () => {
    // instancePath undefined = navigation signals mid-transition; no
    // occurrence-exact claim can be made, so focus falls to the document.
    expect(deriveFocusContext(snapshot({ graphId: 'g1', instancePath: undefined })))
      .toEqual({ kind: 'document' })
  })

  it('is deterministic: the same snapshot always yields the same context', () => {
    const facts = snapshot({ nodes: ['n2', 'n1'], links: ['l9'] })
    expect(deriveFocusContext(facts)).toEqual(deriveFocusContext(facts))
  })
})

const view = { graphId: 'g0', instancePath: [] as readonly string[] }

const occurrenceDiag = (node: string, instancePath: readonly string[] = []): Diagnostic =>
  diag('error', 'schema', 'test.occ', `occ ${node}`, {
    anchor: { occurrence: { instancePath: instancePath.map(asNodeId), node: asNodeId(node) } },
  })

const portDiag = (node: string, port: string): Diagnostic =>
  diag('warning', 'schema', 'test.port', `port ${node}.${port}`, {
    anchor: { port: { node: asNodeId(node), port: port as never } },
  })

const linkDiag = (link: string): Diagnostic =>
  diag('error', 'schema', 'test.link', `link ${link}`, { anchor: { link: link as never } })

const refDiag = (nodeId: string, graphId?: string): Diagnostic =>
  diag('info', 'schema', 'test.ref', `ref ${nodeId}`, {
    refs: [{ nodeId, ...(graphId === undefined ? {} : { graphId }) }],
  })

const unanchoredDiag = diag('error', 'command', 'test.global', 'no owner at all')

describe('contextProblems', () => {
  it('keeps every entry for the document context', () => {
    const all = [occurrenceDiag('n1'), linkDiag('l1'), unanchoredDiag]
    expect(contextProblems({ kind: 'document' }, all, view)).toEqual(all)
  })

  it('node context: matches occurrence anchors, port anchors, and refs by node id', () => {
    const mine = [occurrenceDiag('n1'), portDiag('n1', 'model'), refDiag('n1', 'g0')]
    const others = [occurrenceDiag('n2'), portDiag('n2', 'model'), refDiag('n2'), linkDiag('l1'), unanchoredDiag]
    const result = contextProblems({ kind: 'node', nodeIds: ['n1'] }, [...mine, ...others], view)
    expect(result).toEqual(mine)
  })

  it('node context: occurrence anchors must match the view instance path exactly', () => {
    const atRoot = occurrenceDiag('n1', [])
    const inSub = occurrenceDiag('n1', ['sub1'])
    const context = { kind: 'node', nodeIds: ['n1'] } as const
    expect(contextProblems(context, [atRoot, inSub], view)).toEqual([atRoot])
    expect(contextProblems(context, [atRoot, inSub], { graphId: 'g1', instancePath: ['sub1'] })).toEqual([inSub])
    // Unknown path: matching abstains from path checks rather than dropping entries.
    expect(contextProblems(context, [atRoot, inSub], { graphId: 'g0', instancePath: undefined })).toEqual([atRoot, inSub])
  })

  it('node context: refs match only when their graph id agrees with the view', () => {
    const here = refDiag('n1', 'g0')
    const elsewhere = refDiag('n1', 'g1')
    const unscoped = refDiag('n1')
    const result = contextProblems({ kind: 'node', nodeIds: ['n1'] }, [here, elsewhere, unscoped], view)
    expect(result).toEqual([here, unscoped])
  })

  it('widget context: matches the node AND that value key only', () => {
    const minePort = portDiag('n1', 'steps')
    const mineRef = diag('warning', 'schema', 'test.vk', 'value key ref', {
      refs: [{ nodeId: 'n1', valueKey: 'steps' }],
    })
    const otherKey = portDiag('n1', 'model')
    const otherNode = portDiag('n2', 'steps')
    const wholeNode = occurrenceDiag('n1')
    const result = contextProblems(
      { kind: 'widget', nodeId: 'n1', valueKey: 'steps', label: 'Steps' },
      [minePort, mineRef, otherKey, otherNode, wholeNode, unanchoredDiag],
      view,
    )
    expect(result).toEqual([minePort, mineRef])
  })

  it('link context: matches link anchors by id', () => {
    const mine = linkDiag('l1')
    const result = contextProblems(
      { kind: 'link', linkIds: ['l1'] },
      [mine, linkDiag('l2'), occurrenceDiag('n1'), unanchoredDiag],
      view,
    )
    expect(result).toEqual([mine])
  })

  it('group context: matches problems of any member node', () => {
    const groups = [{ id: 'grp1', title: 'Samplers', members: ['n1', 'n2'] }]
    const mine = [occurrenceDiag('n1'), portDiag('n2', 'model')]
    const result = contextProblems(
      { kind: 'group', groups },
      [...mine, occurrenceDiag('n3'), unanchoredDiag],
      view,
    )
    expect(result).toEqual(mine)
  })

  it('subgraph context: keeps occurrence anchors at or below the view path and graph-scoped refs', () => {
    const inside = occurrenceDiag('n1', ['sub1'])
    const deeper = occurrenceDiag('n1', ['sub1', 'sub2'])
    const outside = occurrenceDiag('n1', [])
    const sibling = occurrenceDiag('n1', ['other'])
    const hereRef = refDiag('n1', 'g1')
    const elsewhereRef = refDiag('n1', 'g0')
    const result = contextProblems(
      { kind: 'subgraph', graphId: 'g1', instancePath: ['sub1'] },
      [inside, deeper, outside, sibling, hereRef, elsewhereRef, unanchoredDiag],
      { graphId: 'g1', instancePath: ['sub1'] },
    )
    expect(result).toEqual([inside, deeper, hereRef])
  })
})

describe('hasOwningContext', () => {
  it('answers true exactly for occurrence or port anchors', () => {
    expect(hasOwningContext(occurrenceDiag('n1'))).toBe(true)
    expect(hasOwningContext(portDiag('n1', 'model'))).toBe(true)
    expect(hasOwningContext(linkDiag('l1'))).toBe(false)
    expect(hasOwningContext(refDiag('n1'))).toBe(false)
    expect(hasOwningContext(unanchoredDiag)).toBe(false)
  })
})
