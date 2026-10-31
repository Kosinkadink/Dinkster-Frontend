/**
 * Legacy boolean migration (wire v10): documents saved before the flip store
 * the two-option combo STRING ("enable"/"disable", "on"/"off", ...) on inputs
 * the backend now types BOOLEAN. The once-per-tab open pass rewrites
 * exactly the recognized tokens to real booleans; anything else is left for
 * the badValue advisory (value-never-hostage).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import { DINKSTER_SCHEMA_WIRE_VERSION, type CommandOutcome, type DinksterNodesPayload } from '@dinkster/core'
import { AppState, type Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const nodesPayload: DinksterNodesPayload = {
  schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
  nodes: {
    GrowMask: { interface: [
      { role: 'input', id: 'mask', type: { kind: 'concrete', types: ['MASK'] }, required: true },
      { role: 'input', id: 'expand', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 0 },
      { role: 'input', id: 'tapered_corners', type: { kind: 'concrete', types: ['BOOLEAN'] }, required: true, default: true },
      { role: 'output', id: 'MASK', type: { kind: 'concrete', types: ['MASK'] } },
    ] },
  },
}

let app: AppState

beforeEach(() => {
  app = new AppState()
})

const loadSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
}

/** GrowMask.tapered_corners is a BOOLEAN-widget input in the fixture. */
const growMask = (values: Record<string, unknown>): Record<string, unknown> => ({
  id: 'n0',
  type: 'GrowMask',
  values,
})

/** Two graphs (root + subgraph def) so the pass provably walks BOTH. */
const docJson = (lineage: string, rootValues: Record<string, unknown>, subValues?: Record<string, unknown>): unknown => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage,
  root: 'g0',
  graphs: {
    g0: { id: 'g0', name: 'root', nodes: { n0: growMask(rootValues) }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 9 },
    ...(subValues !== undefined
      ? { g1: { id: 'g1', name: 'sub', nodes: { n0: growMask(subValues) }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 9 } }
      : {}),
  },
  view: { graphs: { g0: { nodes: {} } } },
  meta: { title: lineage },
})

const valueOf = (tab: Tab, graphId: string): unknown =>
  tab.store.doc.graphs[graphId]!.nodes.n0!.values.tapered_corners

describe('legacy boolean normalization on open', () => {
  it('rewrites recognized tokens to real booleans in every graph, one undo step', async () => {
    loadSchemas()
    expect(app.openDocument(docJson('lin-lb-a', { tapered_corners: 'enable' }, { tapered_corners: 'OFF' }), 'T')).toEqual([])
    const tab = app.activeTab()!
    expect(valueOf(tab, 'g0')).toBe(true) // 'enable' -> true
    expect(valueOf(tab, 'g1')).toBe(false) // case-insensitive: 'OFF' -> false
    await Promise.resolve()
    expect(app.problems.get().some((d) => d.code === 'upgrade.legacyBoolean')).toBe(true)
    expect(tab.store.undo()).toBe(true) // ONE step restores both strings
    expect(valueOf(tab, 'g0')).toBe('enable')
    expect(valueOf(tab, 'g1')).toBe('OFF')
  })

  it('leaves unrecognized strings and real booleans alone', () => {
    loadSchemas()
    expect(app.openDocument(docJson('lin-lb-b', { tapered_corners: 'maybe' }, { tapered_corners: true }), 'T')).toEqual([])
    const tab = app.activeTab()!
    expect(valueOf(tab, 'g0')).toBe('maybe') // advisory keeps reporting it
    expect(valueOf(tab, 'g1')).toBe(true) // no-op, no rewrite command
    expect(tab.store.revision).toBe(0) // nothing dispatched at all
    expect(app.problems.get().some((d) => d.code === 'upgrade.legacyBoolean')).toBe(false)
  })

  it('defers until schemas arrive when the document opens first', () => {
    expect(app.openDocument(docJson('lin-lb-c', { tapered_corners: 'yes' }), 'T')).toEqual([])
    const tab = app.activeTab()!
    expect(valueOf(tab, 'g0')).toBe('yes') // nothing to resolve against yet
    loadSchemas()
    expect(valueOf(tab, 'g0')).toBe(true)
  })

  it('re-arms on retarget but never on a mere schema refresh', async () => {
    // Open against a registry where the node type does NOT resolve: the pass
    // runs (a registry exists), converts nothing, and is consumed.
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...nodesPayload, nodes: {} }))
    expect(app.openDocument(docJson('lin-lb-d', { tapered_corners: 'enable' }), 'T')).toEqual([])
    const tab = app.activeTab()!
    expect(valueOf(tab, 'g0')).toBe('enable')
    // A schema refresh alone must not re-run the pass (an undone migration
    // would be silently re-applied otherwise).
    loadSchemas()
    expect(valueOf(tab, 'g0')).toBe('enable')
    // An explicit retarget re-arms it; the new target's schemas convert.
    app.setTabTarget(tab.id, backend.id)
    expect(valueOf(tab, 'g0')).toBe(true)
    await Promise.resolve()
    expect(app.problems.get().some((d) => d.code === 'upgrade.legacyBoolean')).toBe(true)
  })

  it.each(['accepted', 'refused', 'closed', 'replaced'])('waits for live normalization before reporting: %s', async (completion) => {
    app.openDocument(docJson('delayed-boolean', { tapered_corners: 'enable' }), 'T')
    const tab = app.activeTab()!
    const dispatch = app.dispatchTo.bind(app)
    let finish!: () => void
    let delivered!: Promise<CommandOutcome>
    vi.spyOn(app, 'dispatchTo').mockImplementation((owner, invocation) => {
      delivered = new Promise<CommandOutcome>((resolve) => {
        finish = () => resolve(completion === 'refused' ? { ok: false, diagnostics: [] } : dispatch(owner, invocation))
      })
      return delivered as unknown as CommandOutcome
    })
    loadSchemas()
    expect(valueOf(tab, 'g0')).toBe('enable')
    expect(app.problems.get().some((d) => d.code === 'upgrade.legacyBoolean')).toBe(false)
    if (completion === 'closed') app.closeTab(tab.id)
    if (completion === 'replaced') app.openDocument(docJson('delayed-boolean', { tapered_corners: false }), 'Replacement')
    finish()
    await delivered
    await Promise.resolve()
    expect(app.problems.get().some((d) => d.code === 'upgrade.legacyBoolean')).toBe(completion === 'accepted')
    expect(valueOf(tab, 'g0')).toBe(completion === 'refused' ? 'enable' : true)
    if (completion === 'accepted') {
      expect(tab.store.undo()).toBe(true)
      expect(valueOf(tab, 'g0')).toBe('enable')
    }
    if (completion === 'replaced') expect(valueOf(app.activeTab()!, 'g0')).toBe(false)
  })
})
