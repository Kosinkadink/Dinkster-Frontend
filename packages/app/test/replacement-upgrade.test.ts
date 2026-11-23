import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import type { CommandOutcome, DinksterNodesPayload, JsonObject } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const payload: DinksterNodesPayload = {
  schemaVersion: 1, epoch: 1, dinkster: { version: 'migration-test', schemaWire: 2 }, packs: {},
  nodes: {
    Current: {
      displayName: 'Current', category: 'test',
      body: [{ kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 7 }],
      replacements: [{ from: 'Previous', cases: [{ to: 'Current', inputs: { amount: { kind: 'copy', input: 'oldAmount' } } }] }],
    },
  },
}

const document = () => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'migration-test', root: 'g0',
  graphs: { g0: {
    id: 'g0', name: 'root', nextOrdinal: 2, nets: {}, reroutes: {},
    nodes: {
      first: { id: 'first', type: 'Previous', values: { oldAmount: 11 } },
      second: { id: 'second', type: 'Previous', values: { oldAmount: 29 } },
    },
    links: { lost: { id: 'lost', from: { node: 'first', port: 'discarded' }, to: { node: 'second', port: 'unmapped' } } },
  } },
  view: { graphs: { g0: { nodes: {
    first: { position: { x: 100, y: 100 } }, second: { position: { x: 450, y: 150 } },
  } } } },
})

function loadSchemas(app: AppState): void {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, payload))
}

describe('native open-time replacement', () => {
  let app: AppState
  beforeEach(() => { app = createWorkflowApp(null) })
  afterEach(() => { app.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('imports the deprecated resize with size and image links intact, nested=%s, stale metadata=%s', async (nested, staleMetadata) => {
    const resizeApp = prepareWorkflowApp(new AppState())
    const backend = resizeApp.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: {
      Source: { body: [{ kind: 'output', id: 'IMAGE', type: { kind: 'concrete', types: ['IMAGE'] } }] },
      Sink: { outputNode: true, body: [{ kind: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } }] },
      ImageScaleToMaxDimension: {
        body: [
          { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
          { kind: 'input', id: 'largest_size', type: { kind: 'concrete', types: ['INT'] }, default: 512, widget: { type: 'INT' } },
          { kind: 'input', id: 'upscale_method', type: { kind: 'concrete', types: ['COMBO'] }, default: 'nearest-exact', widget: { type: 'COMBO', options: ['nearest-exact', 'lanczos'] } },
          { kind: 'output', id: 'IMAGE', type: { kind: 'concrete', types: ['IMAGE'] } },
        ],
        replacements: [{ from: 'ResizeImagesByLongerEdge', cases: [{
          to: 'ImageScaleToMaxDimension', inputs: {
            image: { kind: 'copy', input: 'images' },
            largest_size: { kind: 'copy', input: 'longer_edge' },
            upscale_method: { kind: 'constant', value: 'lanczos' },
          }, outputs: { IMAGE: 'images' },
        }] }],
      },
    } }))
    if (staleMetadata) backend.comfyTranslations.set([{
      schema: backend.registry.get()!.resolve('ImageScaleToMaxDimension')!,
      rule: { from: 'ResizeImagesByLongerEdge', cases: [{
        to: 'ImageScaleToMaxDimension', inputs: {
          largest_size: { kind: 'constant', value: 29 },
        },
      }] },
    }])
    const graph: JsonObject = {
      nodes: [
        { id: 1, type: 'Source', pos: [0, 0], outputs: [{ name: 'IMAGE', links: [1] }] },
        { id: 2, type: 'ResizeImagesByLongerEdge', pos: [300, 0], properties: { ver: '0.5.1' },
          widgets_values: [1536], inputs: [{ name: 'images', link: 1 }, { name: 'longer_edge', widget: { name: 'longer_edge' } }],
          outputs: [{ name: 'images', links: [2] }] },
        { id: 3, type: 'Sink', pos: [600, 0], inputs: [{ name: 'image', link: 2 }] },
      ], links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 2, 0, 3, 0, 'IMAGE']],
    }
    const source: JsonObject = nested ? { nodes: [{ id: 4, type: 'inner' }], links: [], definitions: { subgraphs: [
      { ...graph, id: 'inner', name: 'inner', inputs: [], outputs: [] },
    ] } } : graph
    const original = JSON.stringify(source)
    expect((await resizeApp.openDocument(source, 'Deprecated resize'))).toEqual([])
    const tab = resizeApp.activeTab()!
    const imported = tab.store.doc.graphs[nested ? 'inner' : 'g0']!
    expect(imported.nodes.n2!.type).toBe('ImageScaleToMaxDimension')
    expect(imported.nodes.n2!.values).toEqual({ largest_size: 1536, upscale_method: 'lanczos' })
    expect(Object.values(imported.links)).toEqual([
      { id: 'l1', from: { node: 'n1', port: 'IMAGE' }, to: { node: 'n2', port: 'image' } },
      { id: 'l2', from: { node: 'n2', port: 'IMAGE' }, to: { node: 'n3', port: 'image' } },
    ])
    const compiled = resizeApp.compileTab(tab)!
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true)
    if (compiled.ok) expect(Object.values(compiled.artifact.prompt).find((node) => node.class_type === 'ImageScaleToMaxDimension')!.inputs)
      .toMatchObject({ largest_size: 1536, upscale_method: 'lanczos' })
    expect(tab.store.doc.ext!['importer.comfyWorkflow']).toEqual(source)
    expect(JSON.stringify(source)).toBe(original)
    await vi.waitFor(() => expect(resizeApp.adjustmentNotices.get().has(tab.id)).toBe(true))
    expect(resizeApp.adjustmentNotices.get().get(tab.id)!.adjustments).toHaveLength(1)
    expect(resizeApp.undoAdjustments(tab.id)).toBe(true)
    const restored = tab.store.doc.graphs[nested ? 'inner' : 'g0']!
    expect(restored.nodes.n2!.type).toBe('ResizeImagesByLongerEdge')
    expect(restored.nodes.n2!.values).toEqual({ longer_edge: 1536 })
    expect(restored.links.l1!.to).toEqual({ node: 'n2', port: 'images' })
    expect(restored.links.l2!.from).toEqual({ node: 'n2', port: 'images' })
    expect(resizeApp.adjustmentNoticeState(tab.id)).toBe('undone')
    resizeApp.dispose()
  })

  it.each([false, true])('applies lossy plans together with schemas initially available=%s', async (available) => {
    expect(app.registry.get()).toBeUndefined()
    if (available) loadSchemas(app)
    const original = document()
    expect((await app.openDocument(original, 'Historical document'))).toEqual([])
    const tab = app.activeTab()!
    if (!available) {
      expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
      loadSchemas(app)
    }
    await expect.poll(() => [tab.store.doc.graphs.g0!.nodes.first!.type, tab.store.doc.graphs.g0!.nodes.second!.type])
      .toEqual(['Current', 'Current'])
    const graph = tab.store.doc.graphs.g0!
    expect([graph.nodes.first!.type, graph.nodes.second!.type]).toEqual(['Current', 'Current'])
    expect([graph.nodes.first!.values, graph.nodes.second!.values]).toEqual([{ amount: 11 }, { amount: 29 }])
    expect(graph.links).toEqual({})
    await vi.waitFor(() => expect(app.adjustmentNotices.get().has(tab.id)).toBe(true))
    const notice = app.adjustmentNotices.get().get(tab.id)!
    expect(notice.adjustments).toHaveLength(2)
    expect(notice.adjustments.map((entry) => entry.anchor?.occurrence?.node)).toEqual(['first', 'second'])
    expect(notice.adjustments.flatMap((entry) => entry.details).join(' ')).toContain('will be removed')
    expect(JSON.stringify(app.exportDocument(tab.id))).not.toContain('will be removed')
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    expect(tab.store.doc.graphs.g0!.links.lost).toEqual(original.graphs.g0.links.lost)
    expect(tab.store.canUndo).toBe(false)
    loadSchemas(app)
    expect(tab.store.doc.graphs.g0!.nodes.second!.type).toBe('Previous')
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.second!.values).toEqual({ amount: 29 })
    app.clearAdjustmentNotice(tab.id)
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
  })

  it('holds migrations only in opt-in review and applies through the existing command', async () => {
    loadSchemas(app)
    app.settings.set('execution.reviewUpgrades', true)
    expect((await app.openDocument(document(), 'Review'))).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
    const items = app.scanTabReplacements(tab)
    expect(items).toHaveLength(2)
    expect(await app.applyReplacements(tab, items), JSON.stringify({ items, problems: app.problems.get() })).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values).toEqual({ amount: 11 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.canUndo).toBe(false)
  })

  it('takes back every upgrade in one step, keeps later edits, and keeps a node whose upgraded value the user changed', async () => {
    loadSchemas(app)
    const original = document()
    await app.openDocument(original, 'Historical document')
    const tab = app.activeTab()!
    await vi.waitFor(() => expect(app.adjustmentNoticeState(tab.id)).toBe('ready'))
    expect(tab.store.dispatch({ command: 'node.move', params: {
      graphId: 'g0', positions: { first: { x: 280, y: 190 } },
    } }).ok).toBe(true)
    expect(app.adjustmentNoticeState(tab.id)).toBe('ready')
    expect(app.undoAdjustments(tab.id)).toBe(true)
    const graph = () => tab.store.doc.graphs.g0!
    expect([graph().nodes.first!.values, graph().nodes.second!.values]).toEqual([{ oldAmount: 11 }, { oldAmount: 29 }])
    expect(graph().links.lost).toEqual(original.graphs.g0.links.lost)
    expect(tab.store.doc.view.graphs.g0!.nodes.first!.position).toEqual({ x: 280, y: 190 })
    expect(app.adjustmentNoticeState(tab.id)).toBe('undone')
    // The notice's Undo is one ordinary undo step: undoing it puts both upgrades back at once.
    expect(tab.store.undo()).toBe(true)
    expect([graph().nodes.first!.type, graph().nodes.second!.type]).toEqual(['Current', 'Current'])
    expect(app.adjustmentNoticeState(tab.id)).toBe('ready')
    expect(tab.store.dispatch({ command: 'node.setValues', params: {
      graphId: 'g0', nodeId: 'second', values: { amount: 30 },
    } }).ok).toBe(true)
    // The user's own edit of an upgraded value: Undo takes back the other node and keeps this one as edited.
    expect(app.adjustmentNoticeState(tab.id)).toBe('ready')
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect([graph().nodes.first!.type, graph().nodes.second!.type]).toEqual(['Previous', 'Current'])
    expect([graph().nodes.first!.values, graph().nodes.second!.values]).toEqual([{ oldAmount: 11 }, { amount: 30 }])
    expect(graph().links.lost).toBeUndefined()
    expect(app.adjustmentNoticeState(tab.id)).toBe('undone')
    expect(app.adjustmentNotices.get().get(tab.id)!.undone!.kept).toBe(1)
    expect(app.redoAdjustments(tab.id)).toBe(true)
    expect([graph().nodes.first!.type, graph().nodes.first!.values]).toEqual(['Current', { amount: 11 }])
    expect(graph().nodes.second!.values).toEqual({ amount: 30 })
    expect(app.adjustmentNoticeState(tab.id)).toBe('ready')
  })

  it.each(['refused', 'closed', 'replaced', 'later edit', 'accepted'])('publishes the notice only for a batch stored in the open tab: %s', async (completion) => {
    await app.openDocument(document(), 'Historical document')
    const tab = app.activeTab()!
    const dispatch = app.dispatchTo.bind(app)
    let finish!: () => Promise<void>
    let delivered!: Promise<CommandOutcome>
    vi.spyOn(app, 'dispatchTo').mockImplementation((owner, invocation) => {
      // Only the upgrade batch is held; storing start choices on load passes through.
      if (invocation.command !== 'batch') return dispatch(owner, invocation)
      delivered = new Promise<CommandOutcome>((resolve) => {
        finish = async () => {
          const outcome = completion === 'refused' ? { ok: false as const, diagnostics: [] } : await dispatch(owner, invocation)
          if (completion === 'later edit') {
            expect((await dispatch(owner, { command: 'node.move', params: { graphId: 'g0', positions: { first: { x: 900, y: 300 } } } })).ok).toBe(true)
          }
          resolve(outcome)
        }
      })
      return delivered as unknown as CommandOutcome
    })
    loadSchemas(app)
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    if (completion === 'closed') app.closeTab(tab.id)
    if (completion === 'replaced') {
      app.settings.set('execution.reviewUpgrades', true)
      await app.openDocument(document(), 'Replacement')
    }
    await finish()
    await delivered
    await Promise.resolve()
    await Promise.resolve()
    const published = completion === 'accepted' || completion === 'later edit'
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(published)
    // A move made after the batch touches nothing it changed, so Undo still takes the batch back.
    if (published) expect(app.undoAdjustments(tab.id)).toBe(true)
    if (completion === 'replaced') expect(app.activeTab()!.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
  })
})
