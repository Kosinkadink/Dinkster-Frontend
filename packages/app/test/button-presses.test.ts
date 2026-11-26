import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry, createLocalSession, parseDinksterSchema, type CallAnswer, type DinksterWireSchema, type WorkflowDocument } from '@dinkster/core'
import { createLookupClient, valueFromWire, type LookupClient } from '@dinkster/client'
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
