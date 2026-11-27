import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDinksterRegistry } from '@dinkster/client'
import { serializeSelection, type CommandOutcome, type DinksterNodesPayload, type JsonObject } from '@dinkster/core'
import { pasteClipboardIntoTab } from '../src/clipboard-paste.js'
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
    expect(notice.adjustments.flatMap((entry) => entry.details)).toEqual([
      'Its wire from discarded was removed.', 'Its wire into unmapped was removed.',
    ])
    expect(JSON.stringify(app.exportDocument(tab.id))).not.toContain('was removed')
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

  it('corrects stored numbers on open once schemas arrive and preserves recorded Undo and Redo', async () => {
    const backend = app.backends.get()[0]!
    const numbers = { ...payload, nodes: { Current: { body: [
      { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
        widget: { type: 'NUMBER', min: 0, max: 20, step: 4 } },
    ] } } }
    const source = document()
    const input = { ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { amount: 14 } },
      second: { id: 'second', type: 'Current', values: { amount: 29 } },
    } } } }
    await app.openDocument(input, 'Numbers before schemas')
    const tab = app.activeTab()!
    const values = () => Object.values(tab.store.doc.graphs.g0!.nodes).map((node) => node.values.amount)
    expect(values()).toEqual([14, 29])
    backend.registry.set(buildDinksterRegistry(backend.id, numbers))
    await vi.waitFor(() => expect(values()).toEqual([12, 20]))
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments.map((item) => item.count)).toEqual([1, 1])
    expect(tab.store.undo()).toBe(true)
    expect(values()).toEqual([14, 29])
    expect(tab.store.canUndo).toBe(false)
    expect(tab.store.redo()).toBe(true)
    expect(values()).toEqual([12, 20])
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(values()).toEqual([14, 29])
    expect(app.scanTabNumberFixes(tab)).toEqual([])
    await app.openDocument(input, 'Really opened again')
    const reopened = app.activeTab()!
    await vi.waitFor(() => expect(Object.values(reopened.store.doc.graphs.g0!.nodes).map((node) => node.values.amount)).toEqual([12, 20]))
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    await app.openDocument(input, 'Ask before correcting')
    expect(Object.values(app.activeTab()!.store.doc.graphs.g0!.nodes).map((node) => node.values.amount)).toEqual([14, 29])
    expect(app.scanTabNumberFixes(app.activeTab()!)).toHaveLength(2)
    expect(app.adjustmentNotices.get().has(app.activeTab()!.id)).toBe(false)
  })

  it('joins numeric corrections to a personal edit without correcting unrelated existing causes', async () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: { Current: { body: [
      { kind: 'input', id: 'cap', type: { kind: 'concrete', types: ['INT'] }, default: 20,
        widget: { type: 'NUMBER', min: 0 } },
      { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
        widget: { type: 'NUMBER', min: 0, max: { formula: 'cap' }, step: 4 } },
    ] } } }))
    const source = document()
    await app.openDocument({ ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { amount: 16, cap: 20 } },
    } } } }, 'Personal edit')
    const tab = app.activeTab()!
    const values = () => tab.store.doc.graphs.g0!.nodes.first!.values
    const edit = (cap: number) => ({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: 'cap', value: cap } })
    expect((await app.dispatchEditTo(tab, { command: 'batch', params: { invocations: [edit(13)] } })).ok).toBe(true)
    expect(values()).toEqual({ amount: 12, cap: 13 })
    expect(tab.store.undo()).toBe(true)
    expect(values()).toEqual({ amount: 16, cap: 20 })
    expect(tab.store.canUndo).toBe(false)
    expect(tab.store.redo()).toBe(true)
    expect(values()).toEqual({ amount: 12, cap: 13 })
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(values()).toEqual({ amount: 16, cap: 13 })
    expect(app.scanTabNumberFixes(tab)).toEqual([])
    app.clearAdjustmentNotice(tab.id)
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    expect((await app.dispatchEditTo(tab, edit(9))).ok).toBe(true)
    expect(values()).toEqual({ amount: 16, cap: 9 })
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
    app.settings.set('automaticFixes.numberOutsideLimits', 'apply')
    const added = tab.store.predictedNodeId('g0')!
    expect((await app.dispatchEditTo(tab, { command: 'node.add', params: {
      graphId: 'g0', type: 'Current', position: { x: 20, y: 40 }, values: { amount: 14, cap: 20 },
    } })).ok).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes[added]!.values).toEqual({ amount: 12, cap: 20 })
    expect(values()).toEqual({ amount: 16, cap: 9 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes[added]).toBeUndefined()
    const text = JSON.stringify(serializeSelection(tab.store.doc, 'g0', { nodes: ['first'], reroutes: [] }))
    const pasted = tab.store.predictedNodeId('g0')!
    expect(await pasteClipboardIntoTab({
      readText: async () => text, graphId: 'g0', anchor: { x: 50, y: 60 },
      tabStillOpen: () => true, frozen: () => false, currentGraphId: () => 'g0', graphStillOwned: () => true,
      doc: () => tab.store.doc,
      dispatch: async (invocation) => (await app.dispatchEditTo(tab, invocation)).ok,
      onPasted: () => {},
    })).toBe('pasted')
    expect(tab.store.doc.graphs.g0!.nodes[pasted]!.values).toEqual({ amount: 8, cap: 9 })
    expect(values()).toEqual({ amount: 16, cap: 9 })
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes[pasted]).toBeUndefined()
    expect(values()).toEqual({ amount: 16, cap: 9 })
    const pending = app.dispatchEditTo(tab, edit(5))
    expect(tab.store.dispatch(edit(7)).ok).toBe(true)
    expect((await pending).ok).toBe(false)
    expect(values()).toEqual({ amount: 16, cap: 7 })
  })

  it('shares offered numeric corrections across views, refuses a stale batch, and undoes the rechecked batch together', async () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: { Current: {
      displayName: 'Numbers', category: 'test', body: [
        { kind: 'input', id: 'cap', type: { kind: 'concrete', types: ['INT'] }, default: 20, widget: { type: 'NUMBER', min: 0 } },
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: { formula: 'cap' }, step: 4 } },
      ],
    } } }))
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    const source = document()
    await app.openDocument({ ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { amount: 14, cap: 20 } },
      second: { id: 'second', type: 'Current', values: { amount: 29, cap: 20 } },
    } } } }, 'Shared corrections')
    const tab = app.activeTab()!
    const values = () => Object.values(tab.store.doc.graphs.g0!.nodes).map((node) => node.values)
    const offered = app.problemFixes.scan(tab)
    expect(offered.map((fix) => fix.offered.kind === 'number' ? fix.offered.after : fix.offered.label)).toEqual([12, 20])
    expect(tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: 'cap', value: 9 } }).ok).toBe(true)
    // Reading the second surface must not silently replace the first surface's offer.
    await app.problemFixes.apply(tab, app.problemFixes.scan(tab))
    expect(values()).toEqual([{ amount: 14, cap: 9 }, { amount: 29, cap: 20 }])
    expect(app.problemFixes.diagnostics(tab).map((problem) => problem.message)).toEqual([
      'Numbers: amount: Could not apply this fix. The workflow changed.',
      'Numbers: amount: Could not apply this fix. The workflow changed.',
    ])
    for (const fix of offered) app.problemFixes.recheck(tab, fix.key)
    await app.problemFixes.apply(tab, app.problemFixes.scan(tab))
    expect(values()).toEqual([{ amount: 8, cap: 9 }, { amount: 20, cap: 20 }])
    expect(app.problemFixes.diagnostics(tab)).toEqual([])
    expect(tab.store.undo()).toBe(true)
    expect(values()).toEqual([{ amount: 14, cap: 9 }, { amount: 29, cap: 20 }])
  })

  it('always offers declared fixes and stores mixed fixes as one stale-checked undo step', async () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: { Current: {
      displayName: 'Resize', body: ['width', 'cap', 'amount'].map((id) => ({
        kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, default: 0,
        ...(id === 'amount' ? { widget: { type: 'NUMBER', min: 0, max: 20, step: 4 } } : {}),
      })),
      validate: [{ check: { formula: 'width <= cap' }, message: 'Width exceeds cap.', fixLabel: 'Use less than the cap',
        fix: [{ step: 'set', field: 'width', value: { formula: 'cap - 1' } }] }],
    } } }))
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    const source = document()
    await app.openDocument({ ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { width: 17, cap: 9, amount: 14 } },
    } } } }, 'Declared fixes')
    const tab = app.activeTab()!
    const values = () => tab.store.doc.graphs.g0!.nodes.first!.values
    const diagnostics = app.problemFixes.diagnostics(tab)
    const rule = diagnostics.find((diagnostic) => diagnostic.code === 'node.rule.failed')!
    const numeric = diagnostics.find((diagnostic) => diagnostic.code === 'automatic.numberOutsideLimits')!
    expect(rule.message).toBe('Resize: Width exceeds cap.')
    app.settings.set('automaticFixes.numberOutsideLimits', 'apply')
    expect(app.problemFixes.forProblem(tab, rule)?.offered.label).toBe('Use less than the cap')
    expect(app.problemFixes.forProblem(tab, numeric)).toBeUndefined()
    expect(values()).toEqual({ width: 17, cap: 9, amount: 14 })
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    const offers = app.problemFixes.scan(tab)
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: 'cap', value: 8 } })
    await app.problemFixes.apply(tab, offers, { noWait: true })
    expect(values()).toEqual({ width: 17, cap: 8, amount: 14 })
    expect(app.problemFixes.diagnostics(tab).every((diagnostic) => diagnostic.message.includes('The workflow changed.'))).toBe(true)
    for (const fix of offers) app.problemFixes.recheck(tab, fix.key)
    await app.problemFixes.apply(tab, app.problemFixes.scan(tab), { noWait: true })
    expect(values()).toEqual({ width: 7, cap: 8, amount: 12 })
    expect(app.problemFixes.diagnostics(tab)).toEqual([])
    expect(tab.store.undo()).toBe(true)
    expect(values()).toEqual({ width: 17, cap: 8, amount: 14 })
    expect(tab.store.redo()).toBe(true)
    expect(values()).toEqual({ width: 7, cap: 8, amount: 12 })
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
  })

  it('corrects a late lookup limit once, independently of the personal Ask me choice and an earlier edit', async () => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: { Current: {
      displayName: 'Numbers', category: 'test', body: [
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: { lookup: 'test.limit', args: [] }, step: 4 } },
        { kind: 'input', id: 'unrelated', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: 100, step: 4 } },
      ],
    }, Known: {
      displayName: 'Known limit', category: 'test', body: [
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: { lookup: 'test.knownLimit', args: [] }, step: 4 } },
      ],
    } } }))
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    const source = document()
    await app.openDocument({ ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { amount: 29, unrelated: 29 } },
    } } } }, 'Late limit')
    const tab = app.activeTab()!
    const amount = () => tab.store.doc.graphs.g0!.nodes.first!.values.amount
    expect(app.scanTabNumberFixes(tab).map((fix) => fix.valueKey)).toEqual(['unrelated'])
    expect(amount()).toBe(29)
    tab.store.dispatch({ command: 'node.move', params: { graphId: 'g0', positions: { first: { x: 280, y: 190 } } } })
    let limit = 20
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answer: limit }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    const call = { nodeType: 'Current', node: 'first', function: 'test.limit', args: [] }
    await backend.lookups.request(call)
    await vi.waitFor(() => expect(amount()).toBe(20))
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments.map((change) => change.details)).toEqual([['amount: 29 to 20']])
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(amount()).toBe(29)
    expect(tab.store.doc.view.graphs.g0!.nodes.first!.position).toEqual({ x: 280, y: 190 })
    await backend.lookups.request(call)
    expect(amount()).toBe(29)
    expect(app.scanTabNumberFixes(tab).map((fix) => fix.valueKey)).toEqual(['unrelated'])
    expect(tab.store.doc.graphs.g0!.nodes.first!.values.unrelated).toBe(29)
    limit = 16
    await backend.lookups.request(call, { refresh: true })
    await vi.waitFor(() => expect(amount()).toBe(16))
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments.map((change) => change.details)).toEqual([['amount: 29 to 16']])
    expect(tab.store.doc.graphs.g0!.nodes.first!.values.unrelated).toBe(29)
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(amount()).toBe(29)
    expect(tab.store.doc.view.graphs.g0!.nodes.first!.position).toEqual({ x: 280, y: 190 })

    await backend.lookups.request({ ...call, function: 'test.knownLimit' })
    await app.openDocument({ ...source, lineage: 'known-limit', graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Known', values: { amount: 29 } },
    } } } }, 'Already known')
    const knownTab = app.activeTab()!
    expect(app.scanTabNumberFixes(knownTab).map((fix) => fix.after)).toEqual([16])
    await backend.lookups.request({ ...call, function: 'test.unrelated' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(knownTab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(29)
    expect(app.adjustmentNotices.get().has(knownTab.id)).toBe(false)

    const refreshedPayload = { ...payload, epoch: 2, nodes: {
      Current: { displayName: 'Numbers', category: 'test', body: [
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: { lookup: 'test.limit', args: [] }, step: 4 } },
        { kind: 'input', id: 'unrelated', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: 100, step: 4 } },
      ] },
      Known: { displayName: 'Known limit', category: 'test', body: [
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: 8, step: 4 } },
      ] },
    } }
    backend.registry.set(buildDinksterRegistry(backend.id, refreshedPayload))
    await vi.waitFor(() => expect(knownTab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(8))
    expect(amount()).toBe(29)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values.unrelated).toBe(29)
    const tightenedPayload = { ...refreshedPayload, epoch: 3, nodes: { ...refreshedPayload.nodes,
      Known: { ...refreshedPayload.nodes.Known, body: [{ kind: 'input', id: 'amount',
        type: { kind: 'concrete', types: ['INT'] }, default: 0, widget: { type: 'NUMBER', min: 0, max: 4, step: 4 } }] },
    } }
    backend.registry.set(buildDinksterRegistry(backend.id, tightenedPayload))
    await vi.waitFor(() => expect(knownTab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(4))
    expect(app.undoAdjustments(knownTab.id)).toBe(true)
    expect(knownTab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(29)
    backend.registry.set(buildDinksterRegistry(backend.id, { ...tightenedPayload, epoch: 4 }))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(knownTab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(29)
    expect(amount()).toBe(29)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values.unrelated).toBe(29)
  })

  it.each([false, true])('removes personally edited numeric adjustments without disturbing the others, undone=%s', async (undone) => {
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, { ...payload, nodes: { Current: {
      body: [{ kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
        widget: { type: 'NUMBER', min: 0, max: 20, step: 4 } }],
    } } }))
    const source = document()
    await app.openDocument({ ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { amount: 14 } },
      second: { id: 'second', type: 'Current', values: { amount: 29 } },
    } } } }, 'Numbers')
    const tab = app.activeTab()!
    await vi.waitFor(() => expect(app.adjustmentNotices.get().get(tab.id)?.adjustments).toHaveLength(2))
    if (undone) expect(app.undoAdjustments(tab.id)).toBe(true)
    tab.store.dispatch({ command: 'node.move', params: { graphId: 'g0', positions: { first: { x: 280, y: 190 } } } })
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments).toHaveLength(2)
    const personal = undone ? 12 : 8
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: 'amount', value: personal } })
    await vi.waitFor(() => expect(app.adjustmentNotices.get().get(tab.id)!.adjustments.map((entry) => entry.nodeId)).toEqual(['second']))
    expect(undone ? app.redoAdjustments(tab.id) : app.undoAdjustments(tab.id)).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(personal)
    expect(tab.store.doc.graphs.g0!.nodes.second!.values.amount).toBe(undone ? 20 : 29)
    // Ordinary history still restores the notice action, then the personal edit.
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.first!.values.amount).toBe(undone ? 14 : 12)
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'second', inputId: 'amount', value: 4 } })
    await vi.waitFor(() => expect(app.adjustmentNotices.get().has(tab.id)).toBe(false))
  })

  it('stores numeric fixes atomically, keeps later field edits on notice Undo, and does not repeat undone causes', async () => {
    const backend = app.backends.get()[0]!
    const numericPayload = { ...payload, nodes: { Current: { displayName: 'Numbers', category: 'test', body: [
      { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
        widget: { type: 'NUMBER', min: 0, max: 20, step: 4 } },
      { kind: 'input', id: 'other', type: { kind: 'concrete', types: ['FLOAT'] }, default: 0,
        widget: { type: 'NUMBER', min: 0, max: 10, step: 0.1 } },
    ] } } }
    backend.registry.set(buildDinksterRegistry(backend.id, numericPayload))
    app.settings.set('automaticFixes.numberOutsideLimits', 'ask')
    const source = document()
    await app.openDocument({ ...source, graphs: { g0: { ...source.graphs.g0, links: {}, nodes: {
      first: { id: 'first', type: 'Current', values: { amount: 14, other: 12.5 } },
      second: { id: 'second', type: 'Current', values: { amount: 29, other: 7.53 } },
    } } } }, 'Numbers')
    const tab = app.activeTab()!
    const values = () => Object.values(tab.store.doc.graphs.g0!.nodes).map((node) => node.values)
    const offered = app.scanTabNumberFixes(tab)
    expect(tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: 'amount', value: 18 } }).ok).toBe(true)
    expect(await app.applyProblemFixes(tab, offered)).toMatchObject({ kind: 'failed', message: 'Could not apply this fix. The workflow changed.' })
    expect(values()).toEqual([{ amount: 18, other: 12.5 }, { amount: 29, other: 7.53 }])
    expect(app.adjustmentNotices.get().has(tab.id)).toBe(false)
    const stop = tab.store.onOp((op) => {
      if (op.origin !== 'batch') return
      stop()
      tab.store.dispatch({ command: 'node.move', params: { graphId: 'g0', positions: { first: { x: 280, y: 190 } } } })
    })
    expect(await app.applyProblemFixes(tab, app.scanTabNumberFixes(tab), true)).toMatchObject({ kind: 'done' })
    expect(values()).toEqual([{ amount: 16, other: 10 }, { amount: 20, other: 7.53 }])
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments.map((change) => change.details)).toEqual([
      ['amount: 18 to 16'], ['other: 12.5 to 10'], ['amount: 29 to 20'],
    ])
    // Editing one corrected field keeps only that field, not the whole node.
    expect(tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: 'amount', value: 8 } }).ok).toBe(true)
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(values()).toEqual([{ amount: 8, other: 12.5 }, { amount: 29, other: 7.53 }])
    expect(tab.store.doc.view.graphs.g0!.nodes.first!.position).toEqual({ x: 280, y: 190 })
    expect(app.adjustmentNotices.get().get(tab.id)!.undone!.kept).toBe(1)
    expect(app.scanTabNumberFixes(tab)).toEqual([])
    expect(app.redoAdjustments(tab.id)).toBe(true)
    expect(values()).toEqual([{ amount: 8, other: 10 }, { amount: 20, other: 7.53 }])
    expect(app.undoAdjustments(tab.id)).toBe(true)
    app.clearAdjustmentNotice(tab.id)
    expect(app.scanTabNumberFixes(tab)).toEqual([])
    // A newer declaration is a different cause, even if it chooses the same endpoint.
    backend.registry.set(buildDinksterRegistry(backend.id, { ...numericPayload, nodes: { Current: {
      ...numericPayload.nodes.Current, body: numericPayload.nodes.Current.body.map((row) => row.id === 'amount'
        ? { ...row, widget: { ...row.widget, max: 16 } } : row),
    } } }))
    await vi.waitFor(() => expect(values()[1]!.amount).toBe(16))
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments.map((change) => change.details)).toEqual([['amount: 29 to 16']])
    app.clearAdjustmentNotice(tab.id)
    expect(tab.store.undo()).toBe(true)
    expect(values()[1]!.amount).toBe(29)
    expect(await app.applyProblemFixes(tab, app.scanTabNumberFixes(tab), true)).toMatchObject({ kind: 'done' })
    tab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'second', inputId: 'amount', value: 25 } })
    expect(await app.applyProblemFixes(tab, app.scanTabNumberFixes(tab), true)).toMatchObject({ kind: 'done' })
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(values()[1]!.amount).toBe(25)

    const nested = { ...source, lineage: 'nested-numbers', graphs: {
      g0: { ...source.graphs.g0, links: {}, nodes: {
        first: { id: 'first', type: '#g1', values: { shown: 14 } },
        second: { id: 'second', type: '#g1', values: { shown: 18 } },
      } },
      g1: { ...source.graphs.g0, id: 'g1', links: {}, nodes: {
        inner: { id: 'inner', type: 'Current', values: { amount: 8, other: 7.53 } },
      }, boundary: { body: [{ kind: 'input', id: 'shown',
        binds: { kind: 'port', node: 'inner', port: 'amount' }, promoted: true }] } },
    } }
    await app.openDocument(nested, 'Two uses')
    const nestedTab = app.activeTab()!
    const nestedFixes = app.scanTabNumberFixes(nestedTab)
    expect(await app.applyProblemFixes(nestedTab, nestedFixes, true)).toMatchObject({ kind: 'done' })
    expect(Object.values(nestedTab.store.doc.graphs.g0!.nodes).map((node) => node.values)).toEqual([{ shown: 12 }, { shown: 16 }])
    expect(nestedTab.store.doc.graphs.g1!.nodes.inner!.values).toEqual({ amount: 8, other: 7.53 })
    expect(app.undoAdjustments(nestedTab.id)).toBe(true)
    expect(nestedTab.store.doc.graphs).toEqual(nested.graphs)
    expect(app.scanTabNumberFixes(nestedTab)).toEqual([])
    await app.openDocument({ ...nested, lineage: 'inherited-numbers', graphs: {
      ...nested.graphs, g0: { ...nested.graphs.g0, nodes: {
        first: { id: 'first', type: '#g1', values: {} },
        second: { id: 'second', type: '#g1', values: {} },
      } }, g1: { ...nested.graphs.g1, nodes: {
        inner: { id: 'inner', type: 'Current', values: { amount: 14, other: 7.53 } },
      } },
    } }, 'Inherited numbers')
    const inheritedTab = app.activeTab()!
    expect(await app.applyProblemFixes(inheritedTab, app.scanTabNumberFixes(inheritedTab), true)).toMatchObject({ kind: 'done' })
    expect(Object.values(inheritedTab.store.doc.graphs.g0!.nodes).map((node) => node.values)).toEqual([{}, {}])
    expect(inheritedTab.store.doc.graphs.g1!.nodes.inner!.values.amount).toBe(12)
    expect(app.adjustmentNotices.get().get(inheritedTab.id)!.adjustments).toHaveLength(1)
    expect(app.undoAdjustments(inheritedTab.id)).toBe(true)
    expect(inheritedTab.store.doc.graphs.g1!.nodes.inner!.values.amount).toBe(14)
    expect(app.scanTabNumberFixes(inheritedTab)).toEqual([])

    backend.registry.set(buildDinksterRegistry(backend.id, { ...numericPayload, nodes: { Current: {
      displayName: 'Numbers', category: 'test', body: [
        { kind: 'input', id: 'limit', type: { kind: 'concrete', types: ['INT'] }, default: 20, widget: { type: 'NUMBER', min: 0 } },
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 0,
          widget: { type: 'NUMBER', min: 0, max: { formula: 'limit' }, step: 4 } },
      ],
    } } }))
    await app.openDocument({ ...nested, lineage: 'shared-limits', graphs: {
      g0: { ...nested.graphs.g0, nodes: {
        first: { id: 'first', type: '#g1', values: { cap: 20 } },
        second: { id: 'second', type: '#g1', values: { cap: 20 } },
      } }, g1: { ...nested.graphs.g1, nodes: {
        inner: { id: 'inner', type: 'Current', values: { amount: 29, limit: 20 } },
      }, boundary: { body: [{ kind: 'input', id: 'cap',
        binds: { kind: 'port', node: 'inner', port: 'limit' }, promoted: true }] } },
    } }, 'Shared limits')
    const sharedTab = app.activeTab()!
    const sharedOffers = app.scanTabNumberFixes(sharedTab)
    sharedTab.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'second', inputId: 'cap', value: 16 } })
    expect(await app.applyProblemFixes(sharedTab, sharedOffers)).toMatchObject({ kind: 'failed', message: 'Could not apply this fix. The workflow changed.' })
    expect(await app.applyProblemFixes(sharedTab, app.scanTabNumberFixes(sharedTab))).toMatchObject({ kind: 'failed' })
    expect(sharedTab.store.doc.graphs.g1!.nodes.inner!.values.amount).toBe(29)
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

  it('puts back a replaced removed choice on its own and keeps the one the user changed since on the same node', async () => {
    const choice = (id: string) => ({ kind: 'choice', id, displayName: id, required: true, shared: [],
      options: [{ key: 'a', rows: [] }, { key: 'b', rows: [] }] })
    loadSchemas(app)
    app.registerSchemas([{ type: 'Picker', displayName: 'Picker', category: 'test', source: 'v3', isOutputNode: false,
      body: [choice('mode'), choice('style')] } as never])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'removed-choices', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nextOrdinal: 2, links: {}, nets: {}, reroutes: {}, nodes: {
        p: { id: 'p', type: 'Picker', values: {}, dynamic: { mode: { selected: 'gone' }, style: { selected: 'old' } } },
      } } },
      view: { graphs: { g0: { nodes: {} } } },
    }, 'Removed choices')
    const tab = app.activeTab()!
    const dynamic = () => tab.store.doc.graphs.g0!.nodes.p!.dynamic
    await vi.waitFor(() => expect(app.adjustmentNoticeState(tab.id)).toBe('ready'))
    expect(dynamic()).toEqual({ mode: { selected: 'a' }, style: { selected: 'a' } })
    expect(app.adjustmentNotices.get().get(tab.id)!.adjustments[0]!.details).toEqual([
      'mode: gone was removed; a is used', 'style: old was removed; a is used',
    ])
    expect(tab.store.dispatch({ command: 'dynamic.selectOption', params: {
      graphId: 'g0', nodeId: 'p', construct: 'style', option: 'b',
    } }).ok).toBe(true)
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(dynamic()).toEqual({ mode: { selected: 'gone' }, style: { selected: 'b' } })
    expect(app.adjustmentNotices.get().get(tab.id)!.undone!.kept).toBe(1)
    expect(app.redoAdjustments(tab.id)).toBe(true)
    expect(dynamic()).toEqual({ mode: { selected: 'a' }, style: { selected: 'b' } })
    // Once the user changed every adjustment since, Undo puts nothing back and reports both kept.
    expect(tab.store.dispatch({ command: 'dynamic.selectOption', params: {
      graphId: 'g0', nodeId: 'p', construct: 'mode', option: 'b',
    } }).ok).toBe(true)
    const edited = tab.store.doc
    expect(app.undoAdjustments(tab.id)).toBe(true)
    expect(tab.store.doc).toBe(edited)
    expect(app.adjustmentNoticeState(tab.id)).toBe('undone')
    expect(app.adjustmentNotices.get().get(tab.id)!.undone!.kept).toBe(2)
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
