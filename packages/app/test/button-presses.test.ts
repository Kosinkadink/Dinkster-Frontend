import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { coreCommandRegistry, createLocalSession, documentResolver, parseDinksterSchema, type CallAnswer, type DinksterWireSchema, type WorkflowDocument } from '@dinkster/core'
import { createLookupClient, valueFromWire, type LookupClient } from '@dinkster/client'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { createButtonPresses, type ButtonSurfaces } from '../src/button-presses.js'
import type { AppState, Tab } from '../src/app-state.js'

const fixtures = JSON.parse(readFileSync(new URL('../../core/test/fixtures/button_schemas.json', import.meta.url), 'utf8')) as Record<string, DinksterWireSchema>
const schema = parseDinksterSchema('dev.buttons.call_probe', fixtures['dev.buttons.call_probe']!).schema!
function setup(call: () => Promise<CallAnswer>, nodeSchema = schema, lookups?: LookupClient) {
  const resolve = (type: string) => type === nodeSchema.type ? nodeSchema : undefined
  const doc = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin1', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nextOrdinal: 100, nodes: {
      n1: { id: 'n1', type: nodeSchema.type, values: { first: 'old', second: 1 } },
    }, links: {}, nets: {}, reroutes: {} } },
    view: { graphs: { g0: { nodes: { n1: { position: { x: 0, y: 0 } } } } } },
  } as unknown as WorkflowDocument
  const store = createLocalSession(doc, coreCommandRegistry([], resolve), { schemaResolverFor: () => resolve })
  const tab = { id: 'tab', store } as Tab
  let tabs = [tab]
  let schemaState = { status: 'ready' }
  const makeBackend = () => ({ connection: { callPackFunction: call }, lookups, schemaState: { get: () => schemaState } })
  let backend = makeBackend()
  let registry = { resolve }
  const app = {
    backendForTab: () => backend,
    registryForTab: () => registry,
    tabs: { get: () => tabs },
    recordHostLog: () => undefined,
  } as unknown as AppState
  return {
    store,
    place: { tab, graphId: 'g0', nodeId: 'n1', button: 'call' },
    presses: createButtonPresses(app, {} as ButtonSurfaces),
    retarget: () => { backend = makeBackend() },
    reload: () => { registry = { resolve } },
    refreshing: () => { schemaState = { status: 'loading' } },
    close: () => { tabs = [] },
  }
}

describe('button press authority and typed answers', () => {
  it('reports a refused link opening without rolling back the committed undo step', async () => {
    const schema = parseDinksterSchema('test.link', {
      schemaVersion: 2, nodeType: 'test.link', displayName: 'Link', category: 'test', body: [
        { kind: 'input', id: 'first', type: { kind: 'concrete', types: ['STRING'] }, default: 'old' },
        { kind: 'button', id: 'call', label: 'Open', steps: [
          { step: 'set', field: 'first', value: { value: 'committed' } },
          { step: 'openLink', url: { value: 'https://example.com/' } },
        ] },
      ],
    }).schema!
    const { store, place, presses } = setup(async () => { throw new Error('not a Call step') }, schema)
    const before = store.doc
    vi.stubGlobal('window', { open: () => null })
    try {
      await presses.press(place)
      expect(store.doc.graphs['g0']!.nodes['n1']!.values['first']).toBe('committed')
      expect([...presses.states().values()][0]?.box).toEqual({
        tone: 'warn', message: 'The changes were made. Opening the link failed: The browser blocked the new tab.',
      })
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(before)
      expect(store.canUndo).toBe(false)
      const shownAtPointerDown = [...presses.states().values()]
      await presses.press(place)
      presses.dismissBoxes(shownAtPointerDown)
      expect([...presses.states().values()][0]?.box?.message)
        .toBe('The changes were made. Opening the link failed: The browser blocked the new tab.')
      presses.dismissBoxes()
      expect([...presses.states().values()]).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens the host editor on preceding staged writes and commits their result in one undo', async () => {
    const schema = parseDinksterSchema('test.staged_editor', {
      schemaVersion: 2, nodeType: 'test.staged_editor', displayName: 'Editor', category: 'test', body: [
        { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
        { kind: 'button', id: 'edit', label: 'Edit', steps: [
          { step: 'set', field: 'value', value: { value: 41 } },
          { step: 'openEditor', field: 'value' },
        ] },
      ],
    }).schema!
    const resolve = () => schema
    const doc = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'editor', root: 'g0', graphs: {
      g0: { id: 'g0', name: 'root', nextOrdinal: 10, nodes: { n1: { id: 'n1', type: schema.type, values: { value: 7 } } }, links: {}, nets: {}, reroutes: {} },
    }, view: { graphs: {} } } as unknown as WorkflowDocument
    const store = createLocalSession(doc, coreCommandRegistry([], resolve), { schemaResolverFor: () => resolve })
    const tab = { id: 'editor', store } as Tab
    const registry = { resolve }, state = { status: 'ready' }, backend = { schemaState: { get: () => state } }
    const app = { registryForTab: () => registry, backendForTab: () => backend, tabs: { get: () => [tab] },
      widgetRegistryForTab: () => ({ kind: () => ({}) }), recordHostLog: () => undefined } as unknown as AppState
    let initial: unknown
    const presses = createButtonPresses(app, {
      edit: async (request) => {
        expect(store.doc).toEqual(doc)
        initial = request.initial
        return request.initial
      },
      ask: async () => undefined,
      confirmLink: async () => false,
    })
    await presses.press({ tab, graphId: 'g0', nodeId: 'n1', button: 'edit' })
    expect(initial).toBe(41)
    expect(store.doc.graphs['g0']!.nodes['n1']!.values).toEqual({ value: 41 })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(doc)
    expect(store.canUndo).toBe(false)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs['g0']!.nodes['n1']!.values).toEqual({ value: 41 })
  })

  it.each([
    { targetX: 700, wired: undefined }, { targetX: 250, wired: undefined },
    { targetX: 700, wired: 'above' }, { targetX: 700, wired: 'below' },
  ])('places an added node without moving or covering existing nodes (target x: $targetX, wired: $wired)', async ({ targetX, wired }) => {
    const target = parseDinksterSchema('test.target', { schemaVersion: 2, nodeType: 'test.target', displayName: 'Target', category: 'test', body: [
      ...(wired === 'above' ? [{ kind: 'input', id: 'above', type: { kind: 'concrete', types: ['INT'] }, default: 2 }] : []),
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      ...(wired === 'below' ? [{ kind: 'input', id: 'below', type: { kind: 'concrete', types: ['INT'] }, default: 2 }] : []),
      { kind: 'button', id: 'add', label: 'Add', steps: [{ step: 'addNode', nodeType: 'test.processor', to: 'value', values: {} }] },
    ] }).schema!
    const processor = parseDinksterSchema('test.processor', { schemaVersion: 2, nodeType: 'test.processor', displayName: 'Processor with a longer title', category: 'test', body: [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
    ] }).schema!
    const resolve = (type: string) => type === target.type ? target : type === processor.type ? processor : undefined
    const doc = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'placement', root: 'g0', graphs: {
      g0: { id: 'g0', name: 'root', nextOrdinal: 100, nodes: {
        target: { id: 'target', type: target.type, values: {} }, source: { id: 'source', type: processor.type, values: {} },
      }, links: {
        ...(wired === undefined ? { feed: { id: 'feed', from: { node: 'source', port: 'out' }, to: { node: 'target', port: 'value' } } }
          : { other: { id: 'other', from: { node: 'source', port: 'out' }, to: { node: 'target', port: wired } } }),
      }, nets: {}, reroutes: {} },
    }, view: { graphs: { g0: { nodes: { target: { position: { x: targetX, y: 100 } }, source: { position: { x: 0, y: wired === 'above' ? 74 : 100 } } } } } } } as unknown as WorkflowDocument
    const store = createLocalSession(doc, coreCommandRegistry([], resolve), { schemaResolverFor: () => resolve })
    const tab = { id: 'placement', store } as Tab
    const registry = { resolve }
    const state = { status: 'ready' }
    const backend = { schemaState: { get: () => state } }
    const app = { registryForTab: () => registry, widgetRegistryForTab: () => ({ kind: () => undefined }),
      backendForTab: () => backend,
      tabs: { get: () => [tab] }, recordHostLog: () => undefined } as unknown as AppState
    await createButtonPresses(app, {} as ButtonSurfaces).press({ tab, graphId: 'g0', nodeId: 'target', button: 'add' })
    const scene = buildScene({ document: store.doc, graphId: 'g0', resolve, tokens: defaultTokens,
      measure: (text) => text.length * 6, widgetMeasure: () => undefined })
    const added = scene.nodes.find((node) => node.id !== 'target' && node.id !== 'source')!
    expect(added).toBeDefined()
    expect(store.doc.view.graphs['g0']!.nodes['source']).toEqual(doc.view.graphs['g0']!.nodes['source'])
    expect(store.doc.view.graphs['g0']!.nodes['target']).toEqual(doc.view.graphs['g0']!.nodes['target'])
    for (const node of scene.nodes.filter((node) => node !== added)) {
      expect(added.x + added.layout.width <= node.x || added.x >= node.x + node.layout.width ||
        added.y + added.layout.height <= node.y || added.y >= node.y + node.layout.height).toBe(true)
    }
    if (wired !== undefined) {
      const delivery = scene.links.find((link) => link.to.kind === 'port' && link.to.node === 'target' && link.to.port === 'value')!
      if (wired === 'above') expect(delivery.y1).toBeGreaterThan(delivery.y2)
      if (wired === 'below') expect(delivery.y1).toBeLessThan(delivery.y2)
    } else if (targetX === 700) {
      const source = scene.nodes.find((node) => node.id === 'source')!
      expect(added.x).toBeGreaterThan(source.x + source.layout.width)
      expect(added.x + added.layout.width).toBeLessThan(targetX)
      expect(added.y).toBe(100)
    } else {
      const source = scene.nodes.find((node) => node.id === 'source')!
      expect(added.x).toBe(source.x + source.layout.width + defaultTokens.rowHeight * 2)
      expect(added.y).not.toBe(100)
    }
    const after = store.doc
    expect(store.undo()).toBe(true)
    expect(Object.keys(store.doc.graphs['g0']!.nodes)).toEqual(['target', 'source'])
    expect(store.canUndo).toBe(false)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(after)
  })

  it.each(['direct', 'nested', 'edited', 'wired', 'removed', 'refused'] as const)('keeps inside-subgraph writes atomic and occurrence-owned: %s', async (scenario) => {
    const inner = parseDinksterSchema('test.inner_button', {
      schemaVersion: 2, nodeType: 'test.inner_button', displayName: 'Inner', category: 'test', body: [
        { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
        { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
        { kind: 'button', id: 'increase', label: 'Increase', steps: [
          { step: 'set', field: 'value', value: { formula: 'value + 1' } },
          { step: 'call', function: 'test.wait', args: [], writes: ['value'] },
          { step: 'set', field: 'value', value: { formula: 'value * 2' } },
        ] },
      ],
    } as unknown as DinksterWireSchema).schema!
    const resolve = (type: string) => type === inner.type ? inner : undefined
    const doc = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin1', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nextOrdinal: 100, nodes: {
          left: { id: 'left', type: '#g1', values: { shown: 41 } },
          right: { id: 'right', type: '#g1', values: { shown: 73 } },
          source: { id: 'source', type: inner.type, values: {} },
        }, links: {}, nets: {}, reroutes: {} },
        g1: { id: 'g1', name: 'inner', nextOrdinal: 100, nodes: {
          inner: { id: 'inner', type: inner.type, values: { value: 3 } },
        }, links: {}, nets: {}, reroutes: {}, boundary: {
          body: [{ kind: 'input', id: 'shown', binds: { kind: 'port', node: 'inner', port: 'value' }, promoted: true }],
        } },
      }, view: { graphs: {} },
    } as unknown as WorkflowDocument
    const nested = scenario === 'nested'
    const document = nested ? {
      ...doc,
      graphs: {
        ...doc.graphs,
        g0: { ...doc.graphs['g0']!, nodes: Object.fromEntries(Object.entries(doc.graphs['g0']!.nodes).map(([id, node]) => [id, { ...node, type: '#g2' }])) },
        g2: { ...doc.graphs['g1']!, id: 'g2', nodes: { middle: { id: 'middle', type: '#g1', values: {} } }, boundary: {
          body: [{ kind: 'input', id: 'shown', binds: { kind: 'port', node: 'middle', port: 'shown' }, promoted: true }],
        } },
      },
    } as unknown as WorkflowDocument : doc
    const store = createLocalSession(document, coreCommandRegistry([], resolve), { schemaResolverFor: (current) => documentResolver(current, resolve) })
    const tab = { id: 'tab', store } as Tab
    const state = { status: 'ready' }
    let answer!: (value: CallAnswer) => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const response = new Promise<CallAnswer>((resolve) => { answer = resolve })
    const backend = { schemaState: { get: () => state }, connection: { callPackFunction: () => { entered(); return response } } }
    const registry = { resolve }
    const app = { backendForTab: () => backend, registryForTab: () => registry, tabs: { get: () => [tab] }, recordHostLog: () => undefined } as unknown as AppState
    const presses = createButtonPresses(app, {} as ButtonSurfaces)
    const running = presses.press({ tab, graphId: 'g1', nodeId: 'inner', button: 'increase', instancePath: nested ? ['left', 'middle'] : ['left'] })
    await waiting
    expect(store.doc).toEqual(document)
    if (scenario === 'edited') expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'left', inputId: 'shown', value: 59 } }).ok).toBe(true)
    if (scenario === 'wired') expect(store.dispatch({ command: 'link.connect', params: { graphId: 'g0', from: { node: 'source', port: 'out' }, to: { node: 'left', port: 'shown' } } }).ok).toBe(true)
    if (scenario === 'removed') expect(store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['left'] } }).ok).toBe(true)
    answer(scenario === 'refused' ? { kind: 'failed', message: 'Refused' } : { kind: 'answer', fields: {}, notes: [] })
    await running
    if (scenario === 'removed') {
      expect(store.doc.graphs['g0']!.nodes['left']).toBeUndefined()
      expect(store.doc.graphs['g1']!.nodes['inner']!.values).toEqual({ value: 3 })
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(document)
      expect(store.canUndo).toBe(false)
      return
    }
    const expected = scenario === 'edited' ? 59 : scenario === 'refused' || scenario === 'wired' ? 41 : 84
    expect(store.doc.graphs['g0']!.nodes['left']!.values).toEqual({ shown: expected })
    expect(store.doc.graphs['g0']!.nodes['right']!.values).toEqual({ shown: 73 })
    expect(store.doc.graphs['g1']!.nodes['inner']!.values).toEqual({ value: 3 })
    if (scenario === 'refused') {
      expect(store.doc).toEqual(document)
      expect(store.canUndo).toBe(false)
      return
    }
    if (scenario === 'direct' || scenario === 'nested') expect(presses.states().size).toBe(0)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs['g0']!.nodes).toEqual(document.graphs['g0']!.nodes)
    expect(store.doc.graphs['g0']!.links).toEqual({})
    expect(store.doc.graphs['g1']).toEqual(document.graphs['g1'])
    expect(store.canUndo).toBe(false)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs['g0']!.nodes['left']!.values).toEqual({ shown: expected })
    expect(store.doc.graphs['g1']!.nodes['inner']!.values).toEqual({ value: 3 })
  })

  it.each([false, true])('preserves decimal Lookup arguments with a warm integer cache: %s', async (warm) => {
    const bodies: string[] = []
    const lookups = createLookupClient({ baseUrl: '', fetchFn: async (_url, init) => {
      const body = String(init?.body)
      bodies.push(body)
      return body.includes('"args":[2.0]')
        ? new Response(JSON.stringify({ error: 'lookup-invalid-arguments' }), { status: 400 })
        : new Response(JSON.stringify({ answer: 9, typedAnswer: 9 }))
    } })
    for (const formula of warm ? ['2', '2.0'] : ['2.0']) {
      const lookupSchema = parseDinksterSchema('test.lookup_argument', {
        schemaVersion: 2, nodeType: 'test.lookup_argument', displayName: 'Lookup', category: 'test', body: [
          { kind: 'input', id: 'first', type: { kind: 'concrete', types: ['STRING'] }, default: '' },
          { kind: 'input', id: 'second', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
          { kind: 'button', id: 'call', label: 'Read', steps: [
            { step: 'set', field: 'first', value: { value: 'staged' } },
            { step: 'set', field: 'second', value: { lookup: 'test.integer', args: [{ formula }] } },
          ] },
        ],
      } as unknown as DinksterWireSchema).schema!
      const test = setup(async () => { throw new Error('not a Call step') }, lookupSchema, lookups)
      await test.presses.press(test.place)
      expect(test.store.doc.graphs['g0']!.nodes['n1']!.values).toEqual(formula === '2'
        ? { first: 'staged', second: 9 } : { first: 'old', second: 1 })
      expect(test.store.canUndo).toBe(formula === '2')
    }
    expect(bodies).toHaveLength(warm ? 2 : 1)
    expect(bodies.at(-1)).toContain('"args":[2.0]')
    lookups.dispose()
  })

  it.each([{ typedAnswer: 2, accepted: true }, { typedAnswer: { $float: 2 }, accepted: false }])(
    'preserves lookup numeric kind through the HTTP decoder and press: $typedAnswer', async ({ typedAnswer, accepted }) => {
      const lookupSchema = parseDinksterSchema('test.lookup_press', {
        schemaVersion: 2, nodeType: 'test.lookup_press', displayName: 'Lookup', category: 'test', body: [
          { kind: 'input', id: 'first', type: { kind: 'concrete', types: ['STRING'] }, required: true, default: '' },
          { kind: 'input', id: 'second', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 1 },
          { kind: 'button', id: 'call', label: 'Read', steps: [
            { step: 'set', field: 'first', value: { value: 'staged' } },
            { step: 'set', field: 'second', value: { lookup: 'test.count', args: [] } },
          ] },
        ],
      } as unknown as DinksterWireSchema).schema!
      const lookups = createLookupClient({ baseUrl: '', fetchFn: async () => new Response(JSON.stringify({ answer: 2, typedAnswer })) })
      const test = setup(async () => { throw new Error('not a Call step') }, lookupSchema, lookups)
      await test.presses.press(test.place)
      expect(test.store.doc.graphs['g0']!.nodes['n1']!.values).toEqual(accepted
        ? { first: 'staged', second: 2 } : { first: 'old', second: 1 })
      expect(test.store.canUndo).toBe(accepted)
      if (accepted) {
        expect(test.store.undo()).toBe(true)
        expect(test.store.doc.graphs['g0']!.nodes['n1']!.values).toEqual({ first: 'old', second: 1 })
      }
    },
  )

  it.each(['retarget', 'reload', 'refreshing', 'close', 'unchanged'] as const)('handles a delayed answer after %s', async (change) => {
    let answer!: (value: CallAnswer) => void
    let started!: () => void
    const began = new Promise<void>((done) => { started = done })
    const pending = new Promise<CallAnswer>((done) => { answer = done })
    const test = setup(() => { started(); return pending })
    const pressing = test.presses.press(test.place)
    await began
    if (change !== 'unchanged') test[change]()
    answer({ kind: 'answer', fields: { first: 'answer', second: 7n }, notes: [] })
    await pressing
    expect(test.store.doc.graphs['g0']!.nodes['n1']!.values).toEqual(change === 'unchanged'
      ? { first: 'answer', second: 7 } : { first: 'old', second: 1 })
    expect(test.store.canUndo).toBe(change === 'unchanged')
    expect(test.presses.isBusy(test.place)).toBe(false)
    if (change === 'unchanged') {
      expect(test.store.undo()).toBe(true)
      expect(test.store.doc.graphs['g0']!.nodes['n1']!.values).toEqual({ first: 'old', second: 1 })
      expect(test.store.canUndo).toBe(false)
    }
  })

  it.each([
    { wire: 2, accepted: true },
    { wire: { $float: 2 }, accepted: false },
    { wire: { $float: 2.5 }, accepted: false },
    { wire: 'two', accepted: false },
  ])('keeps the client numeric kind for $wire', async ({ wire, accepted }) => {
    const test = setup(async () => ({ kind: 'answer', fields: { second: valueFromWire(wire) }, notes: [] }))
    await test.presses.press(test.place)
    expect(test.store.doc.graphs['g0']!.nodes['n1']!.values).toEqual(accepted
      ? { first: 'staged', second: 2 } : { first: 'old', second: 1 })
    expect(test.store.canUndo).toBe(accepted)
  })
})
