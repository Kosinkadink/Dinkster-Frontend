import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import type { CommandOutcome, DinksterNodesPayload, JsonObject } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const payload: DinksterNodesPayload = {
  schemaVersion: 1, epoch: 1, dinkster: { version: 'migration-test', schemaWire: 1 }, packs: {},
  nodes: {
    Current: {
      displayName: 'Current', category: 'test',
      interface: [{ role: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 7 }],
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
    const resizeApp = new AppState()
    const backend = resizeApp.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: {
      Source: { interface: [{ role: 'output', id: 'IMAGE', type: { kind: 'concrete', types: ['IMAGE'] } }] },
      Sink: { outputNode: true, interface: [{ role: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } }] },
      ImageScaleToMaxDimension: {
        interface: [
          { role: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
          { role: 'input', id: 'largest_size', type: { kind: 'concrete', types: ['INT'] }, default: 512, widget: { type: 'INT' } },
          { role: 'input', id: 'upscale_method', type: { kind: 'concrete', types: ['COMBO'] }, default: 'nearest-exact', widget: { type: 'COMBO', options: ['nearest-exact', 'lanczos'] } },
          { role: 'output', id: 'IMAGE', type: { kind: 'concrete', types: ['IMAGE'] } },
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
    expect(resizeApp.openDocument(source, 'Deprecated resize')).toEqual([])
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
    await vi.waitFor(() => expect(resizeApp.migrationNotices.get().has(tab.id)).toBe(true))
    expect(resizeApp.migrationNotices.get().get(tab.id)!.entries).toHaveLength(1)
    expect(resizeApp.undoMigrationNotice(tab.id)).toBe(true)
    const restored = tab.store.doc.graphs[nested ? 'inner' : 'g0']!
    expect(restored.nodes.n2!.type).toBe('ResizeImagesByLongerEdge')
    expect(restored.nodes.n2!.values).toEqual({ longer_edge: 1536 })
    expect(restored.links.l1!.to).toEqual({ node: 'n2', port: 'images' })
    expect(restored.links.l2!.from).toEqual({ node: 'n2', port: 'images' })
    expect(tab.store.canUndo).toBe(false)
    resizeApp.dispose()
  })

  it.each([false, true])('applies lossy plans together with schemas initially available=%s', async (available) => {
    expect(app.registry.get()).toBeUndefined()
    if (available) loadSchemas(app)
    const original = document()
    expect(app.openDocument(original, 'Historical document')).toEqual([])
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
    await vi.waitFor(() => expect(app.migrationNotices.get().has(tab.id)).toBe(true))
    const notice = app.migrationNotices.get().get(tab.id)!
    expect(notice.entries).toHaveLength(2)
    expect(notice.entries.map((entry) => entry.anchor?.occurrence?.node)).toEqual(['first', 'second'])
    expect(notice.entries.flatMap((entry) => entry.data!.warnings as string[]).join(' ')).toContain('will be removed')
    expect(JSON.stringify(app.exportDocument(tab.id))).not.toContain('replace.applied')
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    expect(tab.store.doc.graphs.g0!.links.lost).toEqual(original.graphs.g0.links.lost)
    expect(tab.store.canUndo).toBe(false)
    loadSchemas(app)
    expect(tab.store.doc.graphs.g0!.nodes.second!.type).toBe('Previous')
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.second!.values).toEqual({ amount: 29 })
    app.dismissMigrationNotice(tab.id)
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
  })

  it('holds migrations only in opt-in review and applies through the existing command', async () => {
    loadSchemas(app)
    app.reviewReplacements.set(true)
    expect(app.openDocument(document(), 'Review')).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
    const items = app.scanTabReplacements(tab)
    expect(items).toHaveLength(2)
    expect(await app.applyReplacements(tab, items), JSON.stringify({ items, problems: app.problems.get() })).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values).toEqual({ amount: 11 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.canUndo).toBe(false)
  })

  it('undoes the upgrade batch from its notice without undoing later edits', async () => {
    loadSchemas(app)
    const original = document()
    app.openDocument(original, 'Historical document')
    const tab = app.activeTab()!
    await vi.waitFor(() => expect(app.canUndoMigrationNotice(tab.id)).toBe(true))
    expect(app.canUndoMigrationNotice(tab.id)).toBe(true)
    expect(tab.store.dispatch({ command: 'node.move', params: {
      graphId: 'g0', positions: { first: { x: 280, y: 190 } },
    } }).ok).toBe(true)
    const edited = tab.store.doc
    expect(app.canUndoMigrationNotice(tab.id)).toBe(false)
    expect(app.undoMigrationNotice(tab.id)).toBe(false)
    expect(tab.store.doc).toBe(edited)
    expect(tab.store.undo()).toBe(true)
    expect(app.canUndoMigrationNotice(tab.id)).toBe(true)
    expect(app.undoMigrationNotice(tab.id)).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values).toEqual({ oldAmount: 11 })
    expect(tab.store.doc.graphs.g0!.nodes.second!.values).toEqual({ oldAmount: 29 })
    expect(tab.store.doc.graphs.g0!.links.lost).toEqual(original.graphs.g0.links.lost)
    expect(tab.store.canUndo).toBe(false)
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
    expect(app.undoMigrationNotice(tab.id)).toBe(false)
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values).toEqual({ amount: 11 })
  })

  it('clears the transient notice on tab close', async () => {
    loadSchemas(app)
    app.openDocument(document(), 'Historical document')
    const tab = app.activeTab()!
    await vi.waitFor(() => expect(app.migrationNotices.get().has(tab.id)).toBe(true))
    expect(app.migrationNotices.get().has(tab.id)).toBe(true)
    app.closeTab(tab.id)
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
  })

  it.each([false, true])('waits for explicit replacement acceptance=%s', async (accepted) => {
    loadSchemas(app)
    app.reviewReplacements.set(true)
    app.openDocument(document(), 'Review')
    const tab = app.activeTab()!
    const dispatch = app.dispatchTo.bind(app)
    let finish!: () => void
    vi.spyOn(app, 'dispatchTo').mockImplementation((owner, invocation) => new Promise<CommandOutcome>((resolve) => {
      finish = () => resolve(accepted ? dispatch(owner, invocation) : { ok: false, diagnostics: [] })
    }) as unknown as CommandOutcome)
    let settled = false
    const result = app.applyReplacements(tab, app.scanTabReplacements(tab)).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    finish()
    expect(await result).toBe(accepted)
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe(accepted ? 'Current' : 'Previous')
    expect(tab.store.canUndo).toBe(accepted)
  })

  it.each(['refused', 'closed', 'replaced', 'later edit', 'accepted'])('publishes only the accepted live upgrade notice: %s', async (completion) => {
    app.openDocument(document(), 'Historical document')
    const tab = app.activeTab()!
    const dispatch = app.dispatchTo.bind(app)
    let finish!: () => Promise<void>
    let delivered!: Promise<CommandOutcome>
    vi.spyOn(app, 'dispatchTo').mockImplementation((owner, invocation) => {
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
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    if (completion === 'closed') app.closeTab(tab.id)
    if (completion === 'replaced') {
      app.reviewReplacements.set(true)
      app.openDocument(document(), 'Replacement')
    }
    await finish()
    await delivered
    await Promise.resolve()
    await Promise.resolve()
    expect(app.migrationNotices.get().has(tab.id)).toBe(completion === 'accepted')
    if (completion === 'accepted') expect(app.undoMigrationNotice(tab.id)).toBe(true)
    if (completion === 'later edit') expect(app.undoMigrationNotice(tab.id)).toBe(false)
    if (completion === 'replaced') expect(app.activeTab()!.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
  })
})
