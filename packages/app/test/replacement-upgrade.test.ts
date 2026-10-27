import { describe, expect, it } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import type { DinksterNodesPayload } from '@dinkster/core'
import { AppState } from '../src/app-state.js'

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
  it.each([false, true])('applies lossy plans together with schemas initially available=%s', (available) => {
    const app = new AppState()
    if (available) loadSchemas(app)
    const original = document()
    expect(app.openDocument(original, 'Historical document')).toEqual([])
    const tab = app.activeTab()!
    if (!available) {
      expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
      loadSchemas(app)
    }
    const graph = tab.store.doc.graphs.g0!
    expect([graph.nodes.first!.type, graph.nodes.second!.type]).toEqual(['Current', 'Current'])
    expect([graph.nodes.first!.values, graph.nodes.second!.values]).toEqual([{ amount: 11 }, { amount: 29 }])
    expect(graph.links).toEqual({})
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

  it('holds migrations only in opt-in review and applies through the existing command', () => {
    const app = new AppState()
    loadSchemas(app)
    app.reviewReplacements.set(true)
    expect(app.openDocument(document(), 'Review')).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.doc.graphs.g0!.nodes.first!.type).toBe('Previous')
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
    const items = app.scanTabReplacements(tab)
    expect(items).toHaveLength(2)
    expect(app.applyReplacements(tab, items), JSON.stringify({ items, problems: app.problems.get() })).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values).toEqual({ amount: 11 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.canUndo).toBe(false)
  })

  it('undoes the upgrade batch from its notice without undoing later edits', () => {
    const app = new AppState()
    loadSchemas(app)
    const original = document()
    app.openDocument(original, 'Historical document')
    const tab = app.activeTab()!
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

  it('clears the transient notice on tab close', () => {
    const app = new AppState()
    loadSchemas(app)
    app.openDocument(document(), 'Historical document')
    const tab = app.activeTab()!
    expect(app.migrationNotices.get().has(tab.id)).toBe(true)
    app.closeTab(tab.id)
    expect(app.migrationNotices.get().has(tab.id)).toBe(false)
  })
})
