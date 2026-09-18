/**
 * pasteClipboardIntoTab unit tests: invocation-time
 * ownership held across the clipboard read - a tab that closed,
 * navigated, or froze during the await refuses without touching the
 * document, planner, or dispatch; a live owner commits the plan and
 * reports the fresh ids.
 */
import { describe, expect, it, vi } from 'vitest'
import { serializeSelection, type WorkflowDocument } from '@dinkster/core'
import { pasteClipboardIntoTab, type ClipboardPasteOutcome } from '../src/clipboard-paste.js'
import { clipboardSceneEndpointTypes } from '../src/CanvasHost.jsx'
import type { Scene } from '@dinkster/canvas'

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'g0' as never,
  graphs: { g0: {
    id: 'g0' as never, name: 'root', nextOrdinal: 10, nets: {}, reroutes: {}, links: {},
    nodes: { a: { id: 'a' as never, type: 'Producer', values: { seed: 7 } } },
  } },
  view: { graphs: { g0: { nodes: { a: { position: { x: 100, y: 200 } } } } } },
})

/** A real envelope produced by the same serializer the copy path uses. */
const envelopeText = (): string =>
  JSON.stringify(serializeSelection(document(), 'g0', { nodes: ['a'], reroutes: [] }))

interface Overrides {
  readonly readText?: () => Promise<string | undefined>
  readonly tabStillOpen?: () => boolean
  readonly frozen?: () => boolean
  readonly currentGraphId?: () => string
  readonly graphStillOwned?: () => boolean
  readonly dispatch?: (invocation: unknown) => boolean
  readonly connectInputs?: boolean
  readonly actor?: string
}

const run = async (overrides: Overrides = {}): Promise<{
  outcome: ClipboardPasteOutcome
  dispatch: ReturnType<typeof vi.fn>
  onPasted: ReturnType<typeof vi.fn>
  doc: ReturnType<typeof vi.fn>
}> => {
  const dispatch = vi.fn(overrides.dispatch ?? (() => true))
  const onPasted = vi.fn()
  const doc = vi.fn(() => document())
  const outcome = await pasteClipboardIntoTab({
    readText: overrides.readText ?? (() => Promise.resolve(envelopeText())),
    graphId: 'g0',
    anchor: { x: 20, y: 30 },
    ...(overrides.connectInputs !== undefined ? { connectInputs: overrides.connectInputs } : {}),
    ...(overrides.actor !== undefined ? { actor: overrides.actor } : {}),
    tabStillOpen: overrides.tabStillOpen ?? (() => true),
    frozen: overrides.frozen ?? (() => false),
    currentGraphId: overrides.currentGraphId ?? (() => 'g0'),
    graphStillOwned: overrides.graphStillOwned ?? (() => true),
    doc,
    dispatch,
    onPasted,
  })
  return { outcome, dispatch, onPasted, doc }
}

describe('pasteClipboardIntoTab (review AP8)', () => {
  it('keeps tap provenance distinct from same-named outputs and rejects missing-schema taps', () => {
    const pin = {
      portId: 'amount', address: { port: 'amount' }, direction: 'out', y: 20,
      type: { kind: 'concrete', name: 'FLOAT' }, widgetTap: true, staticWidgetTap: true,
    }
    const outputPin = { portId: 'amount', address: { port: 'amount' }, direction: 'out', y: 40, type: pin.type }
    const node = {
      id: 'source', x: 0, y: 0, node: { id: 'source', type: 'TapWidget', values: {} }, isSubgraph: false,
      layout: {
        width: 100, height: 60, headerHeight: 20, title: 'source', pins: [pin, outputPin],
        rows: [{ kind: 'ports', output: { address: { port: 'amount' }, type: pin.type } }],
      },
    }
    const scene = { nodes: [node] } as unknown as Scene
    expect([...clipboardSceneEndpointTypes(scene).keys()].sort()).toEqual([
      '["output","source","amount",[]]',
      '["tap","source","amount",[]]',
    ].sort())
    const missing = { nodes: [{ ...node, missingSchema: true }] } as unknown as Scene
    expect([...clipboardSceneEndpointTypes(missing).keys()]).not.toContain('["tap","source","amount",[]]')

    for (const port of ['selector', 'branchWidget']) {
      const dynamic = {
        nodes: [{ ...node, layout: { ...node.layout, pins: [{ ...pin, portId: port, address: { port }, staticWidgetTap: undefined }] } }],
      } as unknown as Scene
      expect([...clipboardSceneEndpointTypes(dynamic).keys()]).not.toContain(`["tap","source","${port}",[]]`)
    }
  })

  it('records widget-backed inputs and collapsed-section ports that have no ports row (audit)', () => {
    // A native Float-style node: the widget input renders as a widget row,
    // so its ONLY scene record is the widgetBacked in pin. Connected paste
    // must still recognize it as a valid external-incoming target.
    const floatType = { kind: 'concrete', name: 'core.float' }
    const widgetNode = {
      id: 'mid', x: 0, y: 0, node: { id: 'mid', type: 'dinkster.float', values: {} }, isSubgraph: false,
      layout: {
        width: 100, height: 60, headerHeight: 20, title: 'mid',
        rows: [
          { kind: 'widget', inputId: 'value' },
          { kind: 'ports', output: { address: { port: 'value' }, type: floatType } },
        ],
        pins: [
          { portId: 'value', address: { port: 'value' }, direction: 'in', y: 20, type: floatType, widgetBacked: true },
          { portId: 'value', address: { port: 'value' }, direction: 'out', y: 20, type: floatType, widgetTap: true, staticWidgetTap: true },
          { portId: 'value', address: { port: 'value' }, direction: 'out', y: 40, type: floatType },
        ],
      },
    }
    const types = clipboardSceneEndpointTypes({ nodes: [widgetNode] } as unknown as Scene)
    expect([...types.keys()].sort()).toEqual([
      '["input","mid","value",[]]',
      '["output","mid","value",[]]',
      '["tap","mid","value",[]]',
    ].sort())

    // A collapsed node keeps only collapsedSection pins; both directions
    // must survive as clipboard endpoints, and a collapsed TAP pin stays a
    // tap endpoint, never an ordinary output.
    const collapsed = {
      id: 'folded', x: 0, y: 0, node: { id: 'folded', type: 'dinkster.float', values: {} }, isSubgraph: false,
      layout: {
        width: 100, height: 24, headerHeight: 20, title: 'folded', rows: [],
        pins: [
          { portId: 'value', address: { port: 'value' }, direction: 'in', y: 10, type: floatType, collapsedSection: 's0' },
          { portId: 'value', address: { port: 'value' }, direction: 'out', y: 10, type: floatType, collapsedSection: 's0' },
          { portId: 'knob', address: { port: 'knob' }, direction: 'out', y: 10, type: floatType, collapsedSection: 's0', widgetTap: true, staticWidgetTap: true },
        ],
      },
    }
    const collapsedTypes = clipboardSceneEndpointTypes({ nodes: [collapsed] } as unknown as Scene)
    expect([...collapsedTypes.keys()].sort()).toEqual([
      '["input","folded","value",[]]',
      '["output","folded","value",[]]',
      '["tap","folded","knob",[]]',
    ].sort())
    expect([...collapsedTypes.keys()]).not.toContain('["output","folded","knob",[]]')

    // Pins carry the solver-substituted type on both the copy and paste
    // side: a scene whose ports ROW still shows the declared variable type
    // fingerprints the endpoint by its solved concrete pin type, so a
    // section collapse between copy and paste cannot flip representations.
    const solvedNode = {
      id: 'gen', x: 0, y: 0, node: { id: 'gen', type: 'Generic', values: {} }, isSubgraph: false,
      layout: {
        width: 100, height: 40, headerHeight: 20, title: 'gen',
        rows: [{ kind: 'ports', output: { address: { port: 'out' }, type: { kind: 'variable', name: 'T' } } }],
        pins: [{ portId: 'out', address: { port: 'out' }, direction: 'out', y: 20, type: floatType }],
      },
    }
    const solvedTypes = clipboardSceneEndpointTypes({ nodes: [solvedNode] } as unknown as Scene)
    expect(solvedTypes.get('["output","gen","out",[]]')).toBe(JSON.stringify(floatType))

    // A missing-schema node keeps its ordinary port endpoints but never taps.
    const missingWidget = clipboardSceneEndpointTypes({ nodes: [{ ...widgetNode, missingSchema: true }] } as unknown as Scene)
    expect([...missingWidget.keys()].sort()).toEqual([
      '["input","mid","value",[]]',
      '["output","mid","value",[]]',
    ].sort())
  })

  it('commits a live owner: plans against the owner doc and reports fresh ids', async () => {
    const { outcome, dispatch, onPasted } = await run()
    expect(outcome).toBe('pasted')
    expect(dispatch).toHaveBeenCalledTimes(1)
    // Plan ids allocate from the owner document's nextOrdinal (10).
    expect(onPasted).toHaveBeenCalledWith(['n10'], [])
  })

  it('ordinary and connected paste compact pasted dynamic nodes in one batch', async () => {
    const ordinary = await run()
    expect((ordinary.dispatch.mock.calls[0]![0] as { command: string }).command).toBe('batch')
    const connected = await run({ connectInputs: true })
    expect((connected.dispatch.mock.calls[0]![0] as { command: string }).command).toBe('batch')
  })

  it('shared connected paste plans compaction with actor-scoped ids', async () => {
    const { dispatch, onPasted } = await run({ connectInputs: true, actor: 'alice' })
    expect(onPasted).toHaveBeenCalledWith(['n0-alice'], [])
    const batch = dispatch.mock.calls[0]![0] as { params: { invocations: { command: string; params: { nodeId?: string } }[] } }
    expect(batch.params.invocations.at(-1)).toEqual({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n0-alice' } })
  })

  it('a tab closed during the read refuses without reading the doc or dispatching', async () => {
    const { outcome, dispatch, onPasted, doc } = await run({ tabStillOpen: () => false })
    expect(outcome).toBe('stale-tab')
    expect(doc).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(onPasted).not.toHaveBeenCalled()
  })

  it('a graph navigation during the read refuses (ownership before payload)', async () => {
    const { outcome, dispatch, doc } = await run({ currentGraphId: () => 'g1' })
    expect(outcome).toBe('stale-graph')
    expect(doc).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a retired graph INCARNATION refuses even when the current graph id matches again', async () => {
    // Graph ids are reusable (undo-of-import frees the id for the next
    // import): the caller's document watcher latches graphStillOwned false
    // the moment the captured graph disappears, so a same-id recreation
    // during the read must not inherit the gesture.
    const { outcome, dispatch, doc } = await run({
      graphStillOwned: () => false,
      currentGraphId: () => 'g0', // the id matches - the incarnation does not
    })
    expect(outcome).toBe('stale-graph')
    expect(doc).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a tab frozen during the read refuses', async () => {
    const { outcome, dispatch } = await run({ frozen: () => true })
    expect(outcome).toBe('frozen')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ownership is checked even when the clipboard read yields nothing', async () => {
    const { outcome } = await run({
      readText: () => Promise.resolve(undefined),
      tabStillOpen: () => false,
    })
    expect(outcome).toBe('stale-tab')
  })

  it('unreadable and non-envelope text are silent non-events', async () => {
    expect((await run({ readText: () => Promise.resolve(undefined) })).outcome).toBe('no-text')
    expect((await run({ readText: () => Promise.resolve('not json') })).outcome).toBe('unrecognized')
    expect((await run({ readText: () => Promise.resolve('{"some":"json"}') })).outcome).toBe('unrecognized')
  })

  it('an unplannable envelope (empty selection) is no-plan, not a dispatch', async () => {
    const empty = JSON.stringify({ format: 'dinkster-clipboard', version: 1, nodes: [], links: [], reroutes: [], groups: [] })
    const { outcome, dispatch } = await run({ readText: () => Promise.resolve(empty) })
    expect(outcome).toBe('no-plan')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a refused dispatch reports rejected and never announces ids', async () => {
    const { outcome, onPasted } = await run({ dispatch: () => false })
    expect(outcome).toBe('rejected')
    expect(onPasted).not.toHaveBeenCalled()
  })
})
