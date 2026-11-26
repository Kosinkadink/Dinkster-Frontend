/**
 * Running a button's declared steps.
 *
 * The schemas are the engine development pack's button nodes
 * (`dinkster_nodes_dev.buttons`, plus `dev.image.gradient` for AddNode), written
 * by the engine's `schema_to_wire` into fixtures/button_schemas.json. The host
 * is a fake: its calls, lookups, lists and forms answer what each test says.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buttonAvailability, CONFLICT_MESSAGE, INSIDE_ONLY_MESSAGE, NO_WAIT_MESSAGE, runPress, runSteps, type ActionHost, type CallAnswer, type LookupResult, type PressTarget, type StepPart } from '../src/actions/runner.js'
import { decodeSteps } from '../src/actions/steps.js'
import type { CommandDefinition } from '../src/commands/contract.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { createLocalSession, type DocumentSession } from '../src/commands/session.js'
import { compile, documentResolver } from '../src/compile/compile.js'
import { effectiveOccurrenceTopology } from '../src/compile/effective-topology.js'
import { diag } from '../src/diagnostics.js'
import type { GraphDef, Json, NodeData, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, isPortEndpoint } from '../src/ids.js'
import { parseDinksterSchema, type DinksterWireSchema } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const wire: Record<string, unknown> = {
  ...JSON.parse(readFileSync(new URL('./fixtures/button_schemas.json', import.meta.url), 'utf8')),
  ...JSON.parse(readFileSync(new URL('./fixtures/flow_schemas.json', import.meta.url), 'utf8')),
}
const SCHEMAS = new Map<string, NodeSchema>()
for (const [type, raw] of Object.entries(wire)) {
  const parsed = parseDinksterSchema(type, raw as DinksterWireSchema)
  if (parsed.schema === undefined) throw new Error(`${type}: ${JSON.stringify(parsed.diagnostics)}`)
  SCHEMAS.set(type, parsed.schema)
}

/** A schema written inline, in the engine's wire, for presses the development pack does not hold. */
function addSchema(type: string, body: readonly unknown[]): void {
  const parsed = parseDinksterSchema(type, { schemaVersion: 2, nodeType: type, displayName: type, category: 'test', body } as never)
  if (parsed.schema === undefined) throw new Error(`${type}: ${JSON.stringify(parsed.diagnostics)}`)
  SCHEMAS.set(type, parsed.schema)
}

const resolve = (type: string): NodeSchema | undefined => SCHEMAS.get(type)

function documentOf(nodes: Record<string, Partial<NodeData> & { type: string }>, links: GraphDef['links'] = {}): WorkflowDocument {
  const graph: GraphDef = {
    id: asGraphDefId('g0'),
    name: 'g',
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { values: {}, ...node, id: asNodeId(id) }])) as GraphDef['nodes'],
    links,
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: { g0: graph },
    view: { graphs: { g0: { nodes: Object.fromEntries(Object.keys(nodes).map((id) => [id, { position: { x: 500, y: 40 } }])) } } },
  } as WorkflowDocument
}

const sessionOf = (doc: WorkflowDocument): DocumentSession =>
  createLocalSession(doc, coreCommandRegistry([], resolve), { schemaResolverFor: () => resolve })

const link = (id: string, from: [string, string], to: [string, string]) => ({
  [id]: { id: asLinkId(id), from: { node: asNodeId(from[0]), port: asPortId(from[1]) }, to: { node: asNodeId(to[0]), port: asPortId(to[1]) } },
})

interface Fake extends ActionHost {
  readonly log: string[]
}

function hostOf(overrides: Partial<ActionHost> = {}): Fake {
  const log: string[] = []
  return {
    log,
    commands: coreCommandRegistry([], resolve),
    schemaResolverFor: () => resolve,
    schemaOf: (_doc, _graph, node) => resolve(node.type),
    lookup: async () => ({ state: 'failed', reason: 'unknown' }),
    call: async () => ({ kind: 'failed', message: 'No service in this test.' }),
    pick: async () => undefined,
    ask: async () => undefined,
    openPicker: async () => undefined,
    editorFor: () => undefined,
    pasteImage: async () => {
      throw new Error('The clipboard holds no image.')
    },
    copy: async (text) => void log.push(`copy ${text}`),
    download: async (name, content) => {
      log.push(`download ${name} ${typeof content === 'string' ? content : `${content.length} bytes`}`)
      return 'saved'
    },
    queue: async (toHere) => void log.push(`queue ${toHere === undefined ? 'all' : toHere.nodeId}`),
    interrupt: async () => void log.push('interrupt'),
    openLink: async (url, confirm) => void log.push(`open ${url} ${confirm ? 'shown first' : 'directly'}`),
    random: () => 0.5,
    ...overrides,
  }
}

const at = (button: string, nodeId = 'n1', menu = false): PressTarget =>
  ({ graphId: 'g0', nodeId, button, ...(menu ? { menu: true } : {}) })

const valuesOf = (session: DocumentSession, nodeId = 'n1'): Readonly<Record<string, Json>> =>
  session.doc.graphs['g0']!.nodes[nodeId]!.values

/** A promise the test settles later, for a call or a list that is still open. */
function later<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

describe('one press is one undo step, or nothing', () => {
  it('sets Unpack count independently in one undo step and refuses an over-limit count whole', async () => {
    const document = documentOf({
      n1: { type: 'dinkster.utilities.unpack', values: { count: 3 } },
      sibling: { type: 'dinkster.utilities.unpack', values: { count: 1 } },
    }, { later: { id: asLinkId('later'), from: { node: asNodeId('n1'), port: asPortId('items.2') },
      to: { node: asNodeId('sibling'), port: asPortId('value') } } })
    const session = sessionOf(document)
    const set = (new_count: number) => runPress(session, at('set_count'), hostOf({ ask: async () => ({ new_count }) }))
    for (const count of [0, 2, 512]) {
      expect(await set(count)).toMatchObject({ kind: 'done' })
      expect(valuesOf(session)).toEqual({ count })
      expect(valuesOf(session, 'sibling')).toEqual({ count: 1 })
      expect(session.doc.graphs.g0!.links).toEqual(document.graphs.g0!.links)
      expect(session.undo()).toBe(true)
      expect(session.doc.graphs).toEqual(document.graphs)
      expect(session.canUndo).toBe(false)
    }
    for (const count of [-1, 513, 2.5]) {
      expect(await set(count)).toMatchObject({ kind: 'failed' })
      expect(session.doc.graphs).toEqual(document.graphs)
      expect(session.canUndo).toBe(false)
    }
  })

  it('keeps multiple-choice Ask answers as list locals for later steps', async () => {
    addSchema('test.ask-list', [
      { kind: 'input', id: 'count', type: { kind: 'concrete', types: ['INT'] }, default: 0 },
      { kind: 'button', id: 'ask', label: 'Choose', steps: [
        { step: 'ask', title: 'Choose entries', rows: [{ id: 'choices', type: { kind: 'list', element: { kind: 'concrete', types: ['COMBO'] } }, default: ['alpha'], widget: { type: 'MULTI_COMBO', options: ['alpha', 'beta'] } }] },
        { step: 'set', field: 'count', value: { formula: 'len(choices)' } },
      ] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.ask-list', values: { count: 7 } } }))
    const host = hostOf({ ask: async () => ({ choices: ['alpha', 'beta'] }) })
    expect(await runPress(session, at('ask'), host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session)).toEqual({ count: 2 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({ count: 7 })
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toEqual({ count: 2 })
  })

  it.each(['ready', 'failed', 'paused'] as const)('resolves a Lookup automatic after Reset before reading it: %s', async (state) => {
    addSchema('test.lookup-reset', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, automatic: { lookup: 'test.automatic', args: [] } },
      { kind: 'input', id: 'read', type: { kind: 'concrete', types: ['INT'] }, default: 0 },
      { kind: 'button', id: 'reset', label: 'Reset', steps: [{ step: 'reset', field: 'value' }, { step: 'set', field: 'read', value: { formula: 'value' } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.lookup-reset', values: { value: 6, read: 1 } } }))
    let calls = 0
    const host = hostOf({ lookup: async () => { calls++; return state === 'ready' ? { state, value: 8n } : state === 'failed' ? { state, reason: 'unknown' } : { state } } })
    expect((await runPress(session, at('reset'), host)).kind).toBe(state === 'ready' ? 'done' : 'failed')
    expect(calls).toBe(1)
    if (state !== 'ready') {
      expect(valuesOf(session)).toEqual({ value: 6, read: 1 })
      expect(session.canUndo).toBe(false)
      return
    }
    expect(valuesOf(session)).toEqual({ read: 8 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({ value: 6, read: 1 })
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toEqual({ read: 8 })
    expect(calls).toBe(1)
  })

  it('reads dependent automatic formulas and ordered member values without freezing them', async () => {
    addSchema('test.dependent-automatic', [
      { kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 5,
        keys: { numbered: { prefix: 'item_', start: 1, pad: 0 } }, member: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, automatic: { lookup: 'test.member', args: [{ formula: 'index()' }] } },
        ] },
      { kind: 'input', id: 'count', type: { kind: 'concrete', types: ['INT'] }, default: 0, automatic: { formula: 'sum(items.value)' } },
      { kind: 'input', id: 'read', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      { kind: 'button', id: 'read', label: 'Read', steps: [{ step: 'set', field: 'read', value: { formula: 'count' } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.dependent-automatic', dynamic: { items: { members: ['item_2', 'item_1'], seq: 2 } } } }))
    const args: unknown[] = []
    const host = hostOf({ lookup: async (request) => { args.push(request.args); return { state: 'ready', value: request.args[0] === 0n ? 11n : 23n } } })
    expect(await runPress(session, at('read'), host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session)).toEqual({ read: 34 })
    expect(args).toEqual([[0n], [1n]])
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({})
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toEqual({ read: 34 })
    expect(args).toEqual([[0n], [1n]])
  })

  it('shares an automatic dependency across typed arguments and honors automatic numeric conversion', async () => {
    addSchema('test.automatic-arguments', [
      { kind: 'input', id: 'base', type: { kind: 'concrete', types: ['INT'] }, default: 1, automatic: { lookup: 'test.base', args: [] } },
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, widget: { type: 'NUMBER', min: 0, max: 10 }, automatic: { lookup: 'test.arguments', args: ['base', 'base', { formula: '2.0' }] } },
      { kind: 'input', id: 'read', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      { kind: 'button', id: 'read', label: 'Read', steps: [{ step: 'set', field: 'read', value: { formula: 'value' } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.automatic-arguments' } }))
    const calls: unknown[] = []
    const host = hostOf({ lookup: async (request) => {
      calls.push([request.function, request.args])
      return { state: 'ready', value: request.function === 'test.base' ? 3n : 20 }
    } })
    expect(await runPress(session, at('read'), host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session)).toEqual({ read: 20 })
    expect(calls).toEqual([['test.base', []], ['test.arguments', [3n, 3n, 2]]])
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({})
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toEqual({ read: 20 })
    expect(calls).toHaveLength(2)
  })

  it.each(['17 if not known(value) else value', 'value if known(value) else other', 'int(known(value)) + other'])('does not resolve a Lookup guarded with known: %s', async (formula) => {
    addSchema('test.automatic-guard', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, automatic: { lookup: 'test.automatic', args: [] } },
      { kind: 'input', id: 'other', type: { kind: 'concrete', types: ['INT'] }, default: 2, automatic: { lookup: 'test.other', args: [] } },
      { kind: 'input', id: 'read', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      { kind: 'button', id: 'read', label: 'Read', steps: [{ step: 'set', field: 'read', value: { formula } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.automatic-guard' } }))
    const calls: string[] = []
    expect(await runPress(session, at('read'), hostOf({ lookup: async (request) => {
      calls.push(request.function)
      return request.function === 'test.other' ? { state: 'ready', value: 8n } : { state: 'failed', reason: 'unknown' }
    } }))).toMatchObject({ kind: 'done' })
    expect(valuesOf(session)).toEqual({ read: formula.startsWith('17') ? 17 : 8 })
    expect(calls).toEqual(formula.startsWith('17') ? [] : ['test.other'])
  })

  it.each(['10 // value', '"wrong" if value == 0 else 2'])('uses the declared automatic default after resolving a dependency: %s', async (formula) => {
    addSchema('test.automatic-fallback', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, automatic: { lookup: 'test.automatic', args: [] } },
      { kind: 'input', id: 'derived', type: { kind: 'concrete', types: ['INT'] }, default: 7, automatic: { formula } },
      { kind: 'input', id: 'read', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      { kind: 'button', id: 'read', label: 'Read', steps: [{ step: 'set', field: 'read', value: { formula: 'derived' } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.automatic-fallback' } }))
    expect(await runPress(session, at('read'), hostOf({ lookup: async () => ({ state: 'ready', value: 0n }) }))).toMatchObject({ kind: 'done' })
    expect(valuesOf(session)).toEqual({ read: 7 })
  })

  it('resolves automatic reads of committed arguments again for outside steps', async () => {
    addSchema('test.automatic-outside', [
      { kind: 'input', id: 'arg', type: { kind: 'concrete', types: ['INT'] }, default: 3 },
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, automatic: { lookup: 'test.automatic', args: ['arg'] } },
      { kind: 'button', id: 'copy', label: 'Copy', steps: [
        { step: 'reset', field: 'value' }, { step: 'pick', name: 'chosen', options: { formula: '[str(value)]' } },
        { step: 'copy', value: { formula: 'str(value)' } },
      ] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.automatic-outside', values: { arg: 3, value: 6 } } }))
    const host = hostOf({
      lookup: async (request) => ({ state: 'ready', value: request.args[0] }),
      pick: async () => {
        expect(session.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'arg', value: 5 } }).ok).toBe(true)
        return '3'
      },
    })
    expect(await runPress(session, at('copy'), host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session)).toEqual({ arg: 5 })
    expect(host.log).toEqual(['copy 5'])
  })

  it.each(['INT', 'FLOAT'])('accepts a declared %s special outside ordinary bounds', async (type) => {
    addSchema(`test.special.${type}`, [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: [type] }, default: 2, widget: { type: 'NUMBER', min: 0, max: 10, step: 2, special: [[-1, 'Automatic']] } },
      { kind: 'button', id: 'set', label: 'Set', steps: [{ step: 'set', field: 'value', value: { value: type === 'INT' ? -1 : { float: -1 } } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: `test.special.${type}`, values: { value: 2 } } }))
    expect((await runPress(session, at('set'), hostOf())).kind).toBe('done')
    expect(valuesOf(session)).toEqual({ value: -1 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({ value: 2 })
  })

  it('validates and randomizes integers on their declared offset grid', async () => {
    addSchema('test.offset', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, widget: { type: 'NUMBER', min: 0, max: 20, step: 3, offset: 1 } },
      ...[6, 7].map((value) => ({ kind: 'button', id: `set${value}`, label: 'Set', steps: [{ step: 'set', field: 'value', value: { value } }] })),
      { kind: 'button', id: 'random', label: 'Random', steps: [{ step: 'randomize', field: 'value' }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.offset', values: { value: 4 } } }))
    expect((await runPress(session, at('set6'), hostOf())).kind).toBe('failed')
    expect(valuesOf(session)).toEqual({ value: 4 })
    expect(session.canUndo).toBe(false)
    expect((await runPress(session, at('set7'), hostOf())).kind).toBe('done')
    expect(valuesOf(session)).toEqual({ value: 7 })
    for (const [random, expected] of [[0, 1], [0.999999999999, 19]] as const) {
      expect((await runPress(session, at('random'), hostOf({ random: () => random }))).kind).toBe('done')
      expect(valuesOf(session)).toEqual({ value: expected })
    }
  })

  it('resets an automatic field by unsetting its override before later steps read it', async () => {
    addSchema('test.automatic-reset', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 4, automatic: { formula: '8' } },
      { kind: 'input', id: 'read', type: { kind: 'concrete', types: ['INT'] }, default: 0 },
      { kind: 'button', id: 'reset', label: 'Reset', steps: [{ step: 'reset', field: 'value' }, { step: 'set', field: 'read', value: { formula: 'value' } }] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.automatic-reset', values: { value: 6, read: 1 } } }))
    expect((await runPress(session, at('reset'), hostOf())).kind).toBe('done')
    expect(valuesOf(session)).toEqual({ read: 8 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({ value: 6, read: 1 })
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toEqual({ read: 8 })
  })

  it('reads a value an earlier step staged, and undo and redo move both fields together', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.field_steps', values: { width: 512, height: 768 } } }))
    const outcome = await runPress(session, at('double'), hostOf())
    expect(outcome).toEqual({ kind: 'done', skipped: [], notes: [] })
    // height = width + 64 reads the staged width 1024, not the stored 512.
    expect(valuesOf(session)).toMatchObject({ width: 1024, height: 1088 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toMatchObject({ width: 512, height: 768 })
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toMatchObject({ width: 1024, height: 1088 })
  })

  it('stores nothing and adds no undo step when a later step fails', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.field_steps', values: { title: 'draft', width: 512 } } }))
    const outcome = await runPress(session, at('too_wide'), hostOf())
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toBe('Nothing was changed. width must be at most 2048; the button gave 4096.')
    expect(valuesOf(session)).toMatchObject({ title: 'draft', width: 512 })
    expect(session.canUndo).toBe(false)
  })

  it('takes members, modes and wires back with the fields, and redo calls nothing again', async () => {
    addSchema('test.atomic', [
      { kind: 'input', id: 'seed', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 3, widget: { type: 'NUMBER', min: 0, max: 9 }, afterRun: 'fixed' },
      { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['dev.image'] }, required: false },
      {
        kind: 'group', id: 'items', keys: { numbered: { prefix: 'item_', start: 1, pad: 0 } }, grows: 'button', minMembers: 0, maxMembers: 3,
        member: [{ kind: 'input', id: 'label', type: { kind: 'concrete', types: ['STRING'] }, required: true, default: 'x' }],
      },
      { kind: 'input', id: 'answer', type: { kind: 'concrete', types: ['STRING'] }, required: true, default: '' },
      {
        kind: 'button', id: 'all', label: 'All',
        steps: [
          { step: 'addMember', group: 'items', values: { label: { value: 'new' } } },
          { step: 'setMode', field: 'seed', mode: 'increment' },
          { step: 'disconnect', input: 'image' },
          { step: 'call', function: 'test.mod.answer', args: ['seed'], writes: ['answer'] },
          { step: 'set', field: 'seed', value: { formula: 'seed + answer_len' } },
        ],
      },
    ])
    // `answer_len` is not a name of the node, so the last step fails after every other one staged.
    const doc = documentOf({ n1: { type: 'test.atomic', values: { seed: 3 } }, src: { type: 'dev.image.gradient' } }, link('l1', ['src', 'image'], ['n1', 'image']))
    const session = sessionOf(doc)
    let calls = 0
    const host = hostOf({ call: async (): Promise<CallAnswer> => (calls++, { kind: 'answer', fields: { answer: 'four' }, notes: [] }) })
    const failed = await runPress(session, at('all'), host)
    expect(failed.kind).toBe('failed')
    expect(session.canUndo).toBe(false)
    expect(Object.keys(session.doc.graphs['g0']!.links)).toEqual(['l1'])

    SCHEMAS.set('test.atomic', {
      ...SCHEMAS.get('test.atomic')!,
      body: SCHEMAS.get('test.atomic')!.body.map((row) => row.kind === 'button'
        ? { ...row, steps: row.steps.slice(0, 4) }
        : row),
    })
    const done = await runPress(session, at('all'), host)
    expect(done.kind).toBe('done')
    const node = (): NodeData => session.doc.graphs['g0']!.nodes['n1']!
    expect(node().dynamic?.['items']?.members).toEqual(['item_1'])
    expect(node().values).toMatchObject({ 'items.item_1.label': 'new', answer: 'four' })
    expect(node().controllers).toEqual({ seed: 'increment' })
    expect(session.doc.graphs['g0']!.links).toEqual({})
    expect(calls).toBe(2)

    session.undo()
    expect(node().dynamic?.['items']?.members).toBeUndefined()
    expect(node().controllers ?? {}).toEqual({})
    expect(Object.keys(session.doc.graphs['g0']!.links)).toEqual(['l1'])
    expect(session.canUndo).toBe(false)
    session.redo()
    expect(node().values['answer']).toBe('four')
    expect(calls).toBe(2)
  })
})

describe('each step', () => {
  const press = async (type: string, button: string, values: Record<string, Json>, host = hostOf(), extra: Partial<NodeData> = {}) => {
    const session = sessionOf(documentOf({ n1: { type, values, ...extra } }))
    const outcome = await runPress(session, at(button), host)
    return { session, outcome, values: valuesOf(session), node: session.doc.graphs['g0']!.nodes['n1']! }
  }

  it('Append adds the separator only after text', async () => {
    expect((await press('dev.buttons.field_steps', 'append', { title: 'draft', mode: 'best' })).values['title']).toBe('draft, best')
    expect((await press('dev.buttons.field_steps', 'append', { title: '', mode: 'best' })).values['title']).toBe('best')
  })

  it('Swap exchanges two unequal values', async () => {
    expect((await press('dev.buttons.field_steps', 'swap', { width: 512, height: 1024 })).values).toMatchObject({ width: 1024, height: 512 })
  })

  it('Swap reads a known wired operand and writes only the unwired operand atomically', async () => {
    const input = (id: string) => ({ kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, default: 0 })
    addSchema('test.swap_incoming', [
      input('a'), input('b'), input('marker'),
      { kind: 'output', id: 'unknown', type: { kind: 'concrete', types: ['INT'] } },
      { kind: 'button', id: 'only', label: 'Swap only', steps: [{ step: 'swap', a: 'a', b: 'b' }] },
      { kind: 'button', id: 'swap', label: 'Swap', steps: [
        { step: 'swap', a: 'a', b: 'b' },
        { step: 'set', field: 'marker', value: { formula: 'a + b' } },
      ] },
    ])
    for (const wired of ['a', 'b'] as const) {
      const other = wired === 'a' ? 'b' : 'a'
      for (const known of [true, false]) {
        const doc = documentOf({ n1: { type: 'test.swap_incoming', values: { a: 7, b: 41, marker: 19 } }, src: { type: 'test.swap_incoming', values: { a: 23 } } }, {
          l1: { id: asLinkId('l1'), from: known ? { node: asNodeId('src'), tap: asPortId('a') } : { node: asNodeId('src'), port: asPortId('unknown') }, to: { node: asNodeId('n1'), port: asPortId(wired) } },
        })
        const session = sessionOf(doc)
        const host = hostOf()
        expect(buttonAvailability(doc, at('swap'), host)).toEqual(known ? { enabled: true } : { enabled: false, reason: `Needs ${wired}, which is not known until a run.` })
        expect(buttonAvailability(doc, at('only'), host)).toEqual(known ? { enabled: true } : { enabled: false, reason: `Needs ${wired}, which is not known until a run.` })
        const outcome = await runPress(session, at('swap'), host)
        if (!known) {
          expect(outcome.kind).toBe('failed')
          expect(session.doc).toEqual(doc)
          expect(session.canUndo).toBe(false)
          continue
        }
        expect(outcome).toMatchObject({ kind: 'done', skipped: [{ id: wired, why: 'wired' }] })
        expect(valuesOf(session)).toEqual({ ...doc.graphs['g0']!.nodes['n1']!.values, [other]: 23, marker: 46 })
        expect(session.doc.graphs['g0']!.links).toEqual(doc.graphs['g0']!.links)
        const after = session.doc
        expect(session.undo()).toBe(true)
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
        expect(session.redo()).toBe(true)
        expect(session.doc).toEqual(after)
      }
    }
  })

  it('Randomize keeps to its bounds and the field step, and Toggle, Reset and SetMode write what they name', async () => {
    const draws = [0, 0.999999, 0.5]
    const picked: Json[] = []
    for (const draw of draws) picked.push((await press('dev.buttons.field_steps', 'random', { seed: 7 }, hostOf({ random: () => draw }))).values['seed']!)
    expect(picked).toEqual([10, 20, 15])
    expect((await press('dev.buttons.field_steps', 'toggle', { flag: false })).values['flag']).toBe(true)
    expect((await press('dev.buttons.field_steps', 'reset', { width: 1024, title: 'final' })).values).toMatchObject({ width: 512, title: 'draft' })
    expect((await press('dev.buttons.field_steps', 'increment', {})).node.controllers).toEqual({ seed: 'increment' })
  })

  it('Randomize honors supplied intervals and refuses invalid bounds without committing earlier writes', async () => {
    for (const type of ['INT', 'FLOAT']) {
      const cases = ['"not a number"', 'True', 'None'].flatMap((formula) => [
        { low: { formula }, high: { formula: '20' } },
        { low: { formula: '10' }, high: { formula } },
      ])
      cases.push(
        { low: { formula: '20.5' }, high: { formula: '10.5' } },
        { low: { formula: '101' }, high: { formula: '110' } },
        { low: { formula: '-10' }, high: { formula: '-1' } },
      )
      if (type === 'INT') cases.push({ low: { formula: '10.2' }, high: { formula: '10.8' } })
      addSchema(`test.random_bounds.${type}`, [
        { kind: 'input', id: 'value', type: { kind: 'concrete', types: [type] }, default: 5, widget: { type: 'NUMBER', min: 0, max: 100, step: 1 } },
        { kind: 'input', id: 'marker', type: { kind: 'concrete', types: ['INT'] }, default: 41 },
        ...cases.map((bounds, index) => ({ kind: 'button', id: `random${index}`, label: 'Random', steps: [
          { step: 'set', field: 'marker', value: { value: 19 } },
          { step: 'randomize', field: 'value', ...bounds },
        ] })),
      ])
      const doc = documentOf({ n1: { type: `test.random_bounds.${type}`, values: { value: 5, marker: 41 } } })
      for (const [index] of cases.entries()) {
        let draws = 0
        const session = sessionOf(doc)
        const outcome = await runPress(session, at(`random${index}`), hostOf({ random: () => { draws++; return 0.25 } }))
        expect(outcome.kind, `${type} ${index}`).toBe('failed')
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
        expect(draws).toBe(0)
      }
    }
    const intervals: { kind: 'INT' | 'FLOAT'; min?: number; max?: number; step: number; offset?: number; low?: string; high?: string; expected?: readonly number[] }[] = [
      { min: 0, max: 100, step: 1, low: '10.5', high: '20.5', expected: [11, 13, 20] },
      { min: 0, max: 100, step: 5, low: '10.5', high: '20.5', expected: [15, 15, 20] },
      { min: 0, max: 100, step: 5, offset: 1, low: '10.5', high: '20.5', expected: [11, 11, 16] },
      { min: -9, max: 16, step: 5, low: '-6.5', high: '7.5', expected: [-4, -4, 6] },
      { min: 0, max: 100, step: 1, low: '-30', high: '120', expected: [0, 25, 100] },
      { min: 0, max: 100, step: 5, high: '20.5', expected: [0, 5, 20] },
      { min: 0, max: 100, step: 5, low: '90.5', expected: [95, 95, 100] },
      { min: 0, max: 100, step: 5, low: '20', high: '20', expected: [20, 20, 20] },
      { min: 0, max: 100, step: 5, low: '10.2', high: '14.8' },
    ].map((interval) => ({ kind: 'INT' as const, ...interval }))
    intervals.push(
      { kind: 'FLOAT', min: 0, max: 100, step: 5, low: '100', high: '120', expected: [100, 100, 100] },
      { kind: 'FLOAT', min: 0, max: 100, step: 5, low: '-30', high: '0', expected: [0, 0, 0] },
      { kind: 'FLOAT', min: 0, max: 100, step: 5, low: '20', high: '20', expected: [20, 20, 20] },
      { kind: 'FLOAT', min: 0, max: 100, step: 5, low: '10.5', high: '20.5', expected: [11.75, 13, 19.25] },
      { kind: 'FLOAT', min: 0, max: 100, step: 5, low: '-10', high: '20.5', expected: [2.5625, 5.125, 17.9375] },
      { kind: 'FLOAT', min: 0, max: 100, step: 5, high: '20.5', expected: [2.5625, 5.125, 17.9375] },
      { kind: 'FLOAT', min: 0, max: 100, step: 5, low: '90.5', expected: [91.6875, 92.875, 98.8125] },
      { kind: 'FLOAT', min: 0, max: 9007199254741000, step: 1, low: '9007199254740993', high: '9007199254740994', expected: [9007199254740994, 9007199254740994, 9007199254740994] },
      { kind: 'FLOAT', min: 0, max: 9007199254741000, step: 1, low: '9007199254740994', high: '9007199254740995', expected: [9007199254740994, 9007199254740994, 9007199254740994] },
      { kind: 'FLOAT', min: -9007199254741000, max: 0, step: 1, low: '-9007199254740995', high: '-9007199254740993', expected: [-9007199254740994, -9007199254740994, -9007199254740994] },
      { kind: 'FLOAT', min: 0, max: 9007199254741000, step: 1, low: '9007199254740993', high: '9007199254740993' },
      { kind: 'FLOAT', step: 1, low: '0', high: '2 ** 2000', expected: [Number.MAX_VALUE / 8, Number.MAX_VALUE / 4, Number.MAX_VALUE * 0.875] },
      { kind: 'FLOAT', step: 1, low: '-(2 ** 2000)', high: '0', expected: [-Number.MAX_VALUE * 0.875, -Number.MAX_VALUE * 0.75, -Number.MAX_VALUE / 8] },
    )
    for (const kind of ['INT', 'FLOAT'] as const) intervals.push(
      { kind, step: 1, min: 0 },
      { kind, step: 1, max: 100 },
      { kind, step: 1, low: '10.5', high: '20.5', expected: kind === 'INT' ? [11, 13, 20] : [11.75, 13, 19.25] },
    )
    for (const [index, { kind, low, high, expected, ...widget }] of intervals.entries()) {
      const type = `test.random_interval.${index}`
      addSchema(type, [
        { kind: 'input', id: 'value', type: { kind: 'concrete', types: [kind] }, default: widget.min ?? 0, widget: { type: 'NUMBER', ...widget } },
        { kind: 'input', id: 'marker', type: { kind: 'concrete', types: ['INT'] }, default: 41 },
        { kind: 'button', id: 'random', label: 'Random', steps: [
          { step: 'set', field: 'marker', value: { value: 19 } },
          { step: 'randomize', field: 'value', ...(low === undefined ? {} : { low: { formula: low } }), ...(high === undefined ? {} : { high: { formula: high } }) },
        ] },
      ])
      for (const [drawIndex, draw] of (kind === 'INT' ? [0, 0.25, 0.999999] : [0.125, 0.25, 0.875]).entries()) {
        const doc = documentOf({ n1: { type, values: { value: widget.min ?? 0, marker: 41 } } })
        const session = sessionOf(doc)
        let draws = 0
        const outcome = await runPress(session, at('random'), hostOf({ random: () => { draws++; return draw } }))
        if (expected === undefined) {
          expect(outcome.kind).toBe('failed')
          expect(session.doc).toEqual(doc)
          expect(session.canUndo).toBe(false)
          expect(draws).toBe(0)
        } else {
          expect(outcome.kind, `${index} ${draw}`).toBe('done')
          expect(session.doc.graphs['g0']!.nodes['n1']!.values).toEqual({ value: expected[drawIndex], marker: 19 })
          const after = session.doc
          const drawn = draws
          expect(session.undo()).toBe(true)
          expect(session.doc).toEqual(doc)
          expect(session.canUndo).toBe(false)
          expect(session.redo()).toBe(true)
          expect(session.doc).toEqual(after)
          expect(draws).toBe(drawn)
        }
      }
    }
  })

  it('Randomize picks a whole seed in the field limits, then fixes it', async () => {
    // Draws of 0.25, 0 and 0 make exactly a quarter of the 2**51 + 1 allowed values.
    const draws = [0.25, 0, 0]
    const { values, node } = await press('dev.buttons.seed', 'new_fixed_random', { seed: 5 }, hostOf({ random: () => draws.shift()! }))
    expect(values['seed']).toBe(-(2 ** 50) + 2 ** 49)
    expect(node.controllers).toEqual({ seed: 'fixed' })
  })

  const members = (keys: readonly string[], strengths: readonly number[]) => ({
    values: Object.fromEntries(keys.flatMap((key, index) => [[`loras.${key}.name`, key.toUpperCase()], [`loras.${key}.strength`, strengths[index]!]])),
    extra: { dynamic: { loras: { members: keys, seq: 3 } } },
  })

  it('AddMember adds at the end with a fresh key and its values', async () => {
    const start = members(['lora_1', 'lora_3'], [0.5, 1.5])
    const { node } = await press('dev.buttons.member_steps', 'add', start.values, hostOf(), start.extra)
    expect(node.dynamic?.['loras']?.members).toEqual(['lora_1', 'lora_3', 'lora_4'])
    // len(loras) * 0.5 reads the two members there were before the add.
    expect(node.values).toMatchObject({ 'loras.lora_4.name': 'added', 'loras.lora_4.strength': 1, 'loras.lora_1.strength': 0.5 })
  })

  it('RemoveMember removes the first, the last or the formula position, with what it stored', async () => {
    const start = members(['lora_1', 'lora_2', 'lora_3'], [0.25, 0.5, 0.75])
    const kept = async (button: string) => {
      const { node } = await press('dev.buttons.member_steps', button, start.values, hostOf(), start.extra)
      expect(Object.keys(node.values).filter((key) => key.endsWith('.strength')).sort()).toEqual(
        node.dynamic!['loras']!.members!.map((key) => `loras.${key}.strength`).sort())
      return node.dynamic!['loras']!.members
    }
    expect(await kept('remove_first')).toEqual(['lora_2', 'lora_3'])
    expect(await kept('remove_last')).toEqual(['lora_1', 'lora_2'])
    expect(await kept('remove_second')).toEqual(['lora_1', 'lora_3'])
    const one = members(['lora_2'], [1])
    const outcome = (await press('dev.buttons.member_steps', 'remove_last', one.values, hostOf(), one.extra)).outcome
    expect(outcome.message).toBe('Nothing was changed. The group already has its fewest members.')
  })

  it('ClearMembers stops at the least count and keeps a wired member', async () => {
    const start = members(['lora_1', 'lora_2', 'lora_3'], [1, 1, 1])
    const doc = documentOf({ n1: { type: 'dev.buttons.member_steps', values: start.values, ...start.extra }, src: { type: 'dev.image.gradient' } },
      link('l1', ['src', 'image'], ['n1', 'loras.lora_2.clip']))
    const session = sessionOf(doc)
    const outcome = await runPress(session, at('clear'), hostOf())
    expect(session.doc.graphs['g0']!.nodes['n1']!.dynamic!['loras']!.members).toEqual(['lora_2'])
    expect(outcome.skipped).toEqual([{ id: 'loras.lora_2', why: 'wired' }])

    // A wire leaving a member field's output is a widget tap on the field, and keeps its member too.
    const tapped = documentOf({
      n1: { type: 'dev.buttons.member_steps', values: start.values, ...start.extra },
      n2: { type: 'dev.buttons.member_steps', values: start.values, ...start.extra },
    }, { t1: { id: asLinkId('t1'), from: { node: asNodeId('n1'), tap: asPortId('loras.lora_3.strength') }, to: { node: asNodeId('n2'), port: asPortId('loras.lora_1.strength') } } })
    const tapSession = sessionOf(tapped)
    const tapOutcome = await runPress(tapSession, at('clear'), hostOf())
    expect(tapSession.doc.graphs['g0']!.nodes['n1']!.dynamic!['loras']!.members).toEqual(['lora_3'])
    expect(tapOutcome.skipped).toEqual([{ id: 'loras.lora_3', why: 'wired' }])

    // A boundary input's additional binding is a wire too, not just its primary target.
    const boundary = documentOf({ n1: { type: 'dev.buttons.member_steps', values: start.values, ...start.extra } })
    const boundSession = sessionOf({ ...boundary, graphs: { g0: { ...boundary.graphs['g0']!, boundary: {
      body: [{ kind: 'input', id: 'clip', binds: { kind: 'port', node: asNodeId('n1'), port: asPortId('loras.lora_1.clip') },
        alsoBinds: [{ kind: 'port', node: asNodeId('n1'), port: asPortId('loras.lora_3.clip') }] }],
    } } } })
    const boundOutcome = await runPress(boundSession, at('clear'), hostOf())
    expect(boundSession.doc.graphs['g0']!.nodes['n1']!.dynamic!['loras']!.members).toEqual(['lora_1', 'lora_3'])
    expect(boundOutcome.skipped).toEqual([{ id: 'loras.lora_3', why: 'wired' }, { id: 'loras.lora_1', why: 'wired' }])

    const local = documentOf({ n1: { type: 'dev.buttons.member_steps', values: start.values, ...start.extra }, src: { type: 'dev.image.gradient' } })
    const occurrenceDoc = { ...local, root: asGraphDefId('root'), graphs: { ...local.graphs, root: {
      id: asGraphDefId('root'), name: 'root', nodes: { a: { id: asNodeId('a'), type: '#g0', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
    } }, occurrenceTopologies: { a: { owner: { instancePath: [], node: asNodeId('a') }, bodyGraph: asGraphDefId('g0'), nextOrdinal: 1,
      links: { local: { id: asLinkId('local'), from: { kind: 'body' as const, endpoint: { node: asNodeId('src'), port: asPortId('image') } },
        to: { kind: 'body' as const, endpoint: { node: asNodeId('n1'), port: asPortId('loras.lora_3.clip') } } } },
    } } }
    for (const button of ['remove_last', 'clear']) {
      const localSession = sessionOf(occurrenceDoc)
      const localOutcome = await runPress(localSession, at(button), hostOf())
      expect(localOutcome.skipped).toEqual([{ id: 'loras.lora_3', why: 'wired' }])
      expect(localSession.doc.graphs['g0']!.nodes['n1']!.dynamic!['loras']!.members)
        .toEqual(button === 'clear' ? ['lora_3'] : ['lora_1', 'lora_2', 'lora_3'])
      expect(localSession.doc.occurrenceTopologies).toEqual(occurrenceDoc.occurrenceTopologies)
    }
    const continued = sessionOf(occurrenceDoc)
    const continuedOutcome = await runSteps(continued, [
      { graphId: 'g0', nodeId: 'n1', prefix: '', steps: decodeSteps([{ step: 'removeMember', group: 'loras', which: 'last' }] as never) },
      { graphId: 'g0', nodeId: 'n1', prefix: 'loras.lora_1.', steps: decodeSteps([{ step: 'set', field: 'strength', value: { value: 0.5 } }] as never) },
    ], hostOf())
    expect(continuedOutcome).toMatchObject({ kind: 'done', skipped: [{ id: 'loras.lora_3', why: 'wired' }] })
    expect(valuesOf(continued)['loras.lora_1.strength']).toBe(0.5)
    expect(continued.doc.occurrenceTopologies).toEqual(occurrenceDoc.occurrenceTopologies)
  })

  it('SetEach works out every member before it writes any', async () => {
    const start = members(['lora_1', 'lora_2', 'lora_3'], [0.25, 1.5, -1])
    expect((await press('dev.buttons.member_steps', 'copy_first', start.values, hostOf(), start.extra)).values).toMatchObject({
      'loras.lora_1.strength': 0.25, 'loras.lora_2.strength': 0.25, 'loras.lora_3.strength': 0.25,
    })
    expect((await press('dev.buttons.member_steps', 'halve_each', start.values, hostOf(), start.extra)).values).toMatchObject({
      'loras.lora_1.strength': 0.125, 'loras.lora_2.strength': 0.75, 'loras.lora_3.strength': -0.5,
    })
    // Written one member at a time, the sum would grow as it went: 0.75, then 1.25, then 2.5.
    addSchema('test.sum_each', [
      ...(wire['dev.buttons.member_steps'] as { body: unknown[] }).body.slice(0, 1),
      { kind: 'button', id: 'sum', label: 'Sum', steps: [{ step: 'setEach', group: 'loras', field: 'strength', value: { formula: 'sum(loras.strength)' } }] },
    ])
    expect((await press('test.sum_each', 'sum', start.values, hostOf(), start.extra)).values).toMatchObject({
      'loras.lora_1.strength': 0.75, 'loras.lora_2.strength': 0.75, 'loras.lora_3.strength': 0.75,
    })
    addSchema('test.minimum_each', [
      { kind: 'group', id: 'items', grows: 'button', minMembers: 2, maxMembers: 4,
        keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: [
          { kind: 'input', id: 'source', type: { kind: 'concrete', types: ['INT'] }, default: 13 },
          { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 41 },
        ] },
      { kind: 'button', id: 'copy', label: 'Copy', steps: [{ step: 'setEach', group: 'items', field: 'value', value: { formula: 'items.source[0] + index()' } }] },
    ])
    for (const members of [[], ['m0']]) {
      const before = documentOf({ n1: { type: 'test.minimum_each', values: members.length === 0 ? {} : { 'items.m0.source': 31, 'items.m0.value': 43 },
        ...(members.length === 0 ? {} : { dynamic: { items: { members, seq: 1 } } }) } })
      const session = sessionOf(before)
      expect((await runPress(session, at('copy'), hostOf())).kind).toBe('done')
      const first = members.length === 0 ? 13 : 31
      expect(valuesOf(session)).toMatchObject({ 'items.m0.value': first, 'items.m1.value': first + 1 })
      const after = session.doc
      expect(session.undo()).toBe(true)
      expect(valuesOf(session)).toEqual(before.graphs['g0']!.nodes['n1']!.values)
      expect(session.doc.graphs['g0']!.nodes['n1']!.dynamic?.['items']?.members ?? []).toEqual(members)
      expect(session.canUndo).toBe(false)
      expect(session.redo()).toBe(true)
      expect(session.doc).toEqual(after)
    }
  })

  it.each([1, 2])('AddNode shares the node and definition wires at depth %s', async (depth) => {
    addSchema('test.add_target', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 3 },
      { kind: 'input', id: 'other', type: { kind: 'concrete', types: ['INT'] }, default: 4 },
      { kind: 'button', id: 'add', label: 'Add', steps: [{ step: 'addNode', nodeType: 'test.add_processor', to: 'value', values: {} }] },
    ])
    addSchema('test.add_processor', [
      { kind: 'input', id: 'input', type: { kind: 'concrete', types: ['INT'] }, default: 9 },
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
    ])
    for (const driver of ['none', 'inside', 'tap', 'reroute', 'net', 'local', 'outside', 'outsideReroute'] as const) {
      const target = { node: asNodeId('inner'), port: asPortId('value') }
      const from = driver === 'tap' ? { node: asNodeId('source'), tap: asPortId('input') }
        : driver === 'reroute' || driver === 'outsideReroute' ? { reroute: 'junction' as never } : { node: asNodeId('source'), port: asPortId('out') }
      const links = driver === 'none' || driver === 'outside' || driver === 'local' || driver === 'net' ? {} : {
        shared: { id: asLinkId('shared'), from, to: target },
        ...(driver === 'reroute' ? { upstream: { id: asLinkId('upstream'), from: { node: asNodeId('source'), port: asPortId('out') }, to: from } } : {}),
      }
      const initialBody = documentOf({ inner: { type: 'test.add_target' }, source: { type: 'test.add_processor' } }, links).graphs['g0']!
      const body = { ...initialBody, ...(driver === 'reroute' || driver === 'outsideReroute' ? { reroutes: { junction: { id: 'junction' as never } } } : {}),
        ...(driver === 'net' ? { nets: { shared: { id: 'shared' as never, name: 'Shared source', source: { node: asNodeId('source'), port: asPortId('out') }, sinks: [target] } } } : {}) }
      const root = documentOf({ left: { type: depth === 1 ? '#g1' : '#g2' }, right: { type: depth === 1 ? '#g1' : '#g2' }, source: { type: 'test.add_processor' } },
        driver === 'outside' || driver === 'outsideReroute' ? link('parent', ['source', 'out'], ['left', 'shown']) : {})
      const middle = documentOf({ deep: { type: '#g1' } }).graphs['g0']!
      const doc: WorkflowDocument = { ...root,
        ...(driver === 'local' ? { occurrenceTopologies: { [depth === 1 ? 'left' : 'left.deep']: {
          owner: { instancePath: depth === 1 ? [] : [asNodeId('left')], node: asNodeId(depth === 1 ? 'left' : 'deep') },
          bodyGraph: asGraphDefId('g1'), nextOrdinal: 1,
          links: { local: { id: asLinkId('local'), from: { kind: 'body' as const, endpoint: from }, to: { kind: 'body' as const, endpoint: target } } },
        } } } : {}), graphs: { ...root.graphs,
        g1: { ...body, id: asGraphDefId('g1'), name: 'Shared body', boundary: {
          body: [{ kind: 'input', id: asPortId('shown'), promoted: true, binds: { kind: 'port', node: asNodeId('inner'), port: asPortId('value'), ...(driver === 'outsideReroute' ? { viaReroute: 'junction' as never } : {}) } }],
        } },
        ...(depth === 1 ? {} : { g2: { ...middle, id: asGraphDefId('g2'), boundary: {
          body: [{ kind: 'input', id: asPortId('shown'), promoted: true, binds: { kind: 'port', node: asNodeId('deep'), port: asPortId('shown') } }],
        } } }),
      } }
      const path = (side: string) => (depth === 1 ? [side] : [side, 'deep']).map(asNodeId)
      const host = hostOf({ schemaResolverFor: (current) => documentResolver(current, resolve) })
      const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
      const topology = (current: WorkflowDocument, side: string) => {
        const hops = path(side)
        const found = effectiveOccurrenceTopology(current, resolve, { instancePath: hops.slice(0, -1), node: hops.at(-1)! })
        return [...found.links, ...found.projectedParentLinks]
      }
      const siblingPrompt = (current: WorkflowDocument) => {
        const result = compile({ document: current, revision: 1, resolve, scope: { kind: 'partial', targets: [{ instancePath: path('right'), node: asNodeId('inner') }] }, connection: asConnectionId('test'), schemaHash: 'test' })
        expect(result.ok, JSON.stringify(result)).toBe(true)
        return result.ok ? result.artifact.prompt : undefined
      }
      const siblingBefore = topology(doc, 'right')
      const promptBefore = siblingPrompt(doc)
      const outcome = await runPress(session, { graphId: 'g1', nodeId: 'inner', instancePath: path('left'), button: 'add' }, host)
      expect(outcome.kind, JSON.stringify(outcome)).toBe('done')
      if (driver === 'outside' || driver === 'outsideReroute' || driver === 'local') {
        expect(outcome.message).toBe('Nothing added. value is wired from outside this subgraph.')
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
        const mixed = await runSteps(session, [{ graphId: 'g1', nodeId: 'inner', instancePath: path('left'), prefix: '', steps: decodeSteps([
          { step: 'addNode', nodeType: 'test.add_processor', to: 'value', values: {} },
          { step: 'addNode', nodeType: 'test.add_processor', to: 'other', values: {} },
        ]) }], host)
        expect(mixed).toMatchObject({ kind: 'done', message: 'Also added in the other use of "Shared body".\nSkipped value: it is wired from outside this subgraph.' })
        expect(Object.keys(session.doc.graphs['g1']!.nodes)).toHaveLength(3)
        expect(session.undo()).toBe(true)
        expect(session.canUndo).toBe(false)
        continue
      }
      expect(outcome.message).toBe('Also added in the other use of "Shared body".')
      const fresh = Object.values(session.doc.graphs['g1']!.nodes).find((node) => !Object.hasOwn(body.nodes, node.id))!
      expect(fresh.type).toBe('test.add_processor')
      expect(Object.keys(session.doc.graphs['g1']!.nodes)).toHaveLength(3)
      expect(session.doc.occurrenceTopologies).toEqual(doc.occurrenceTopologies)
      const endpoints = topology(session.doc, 'left').map((item) => [item.from.endpoint, item.to.endpoint])
      expect(endpoints).toContainEqual([{ node: fresh.id, port: 'out' }, { node: 'inner', port: 'value' }])
      if (driver !== 'none') expect(endpoints).toContainEqual([from, { node: fresh.id, port: 'input' }])
      expect(topology(session.doc, 'right').map((item) => [item.from.endpoint, item.to.endpoint])).toEqual(endpoints)
      const promptAfter = siblingPrompt(session.doc)
      expect(promptAfter).not.toEqual(promptBefore)
      expect(Object.values(promptAfter!).filter((node) => node.class_type === 'test.add_processor')).toHaveLength(
        Object.values(promptBefore!).filter((node) => node.class_type === 'test.add_processor').length + 1)
      const after = session.doc
      expect(session.undo()).toBe(true)
      expect(session.doc.graphs['g1']).toEqual({ ...doc.graphs['g1'], nextOrdinal: after.graphs['g1']!.nextOrdinal })
      expect(topology(session.doc, 'left')).toEqual(topology(doc, 'left'))
      expect(topology(session.doc, 'right')).toEqual(siblingBefore)
      expect(siblingPrompt(session.doc)).toEqual(promptBefore)
      expect(session.canUndo).toBe(false)
      expect(session.redo()).toBe(true)
      expect(session.doc).toEqual(after)
      if (driver === 'none') {
        const commands = coreCommandRegistry([], resolve) as Map<string, CommandDefinition>
        const connect = commands.get('link.connect')!
        commands.set(connect.id, { ...connect, validateDispatch: () => [diag('error', 'command', 'test.refusal', 'The wire was refused.')] })
        const refusedHost = { ...host, commands }
        const refused = createLocalSession(doc, commands, { schemaResolverFor: host.schemaResolverFor! })
        expect(await runPress(refused, { graphId: 'g1', nodeId: 'inner', instancePath: path('left'), button: 'add' }, refusedHost))
          .toMatchObject({ kind: 'failed', message: 'Nothing was changed. The wire was refused.', notes: [] })
        expect(refused.doc).toEqual(doc)
        expect(refused.canUndo).toBe(false)
        for (const uses of [1, 3]) {
          const { right, ...single } = doc.graphs['g0']!.nodes
          const nodes = uses === 1 ? single : { ...doc.graphs['g0']!.nodes, third: { ...right!, id: asNodeId('third') } }
          const varied = createLocalSession({ ...doc, graphs: { ...doc.graphs, g0: { ...doc.graphs['g0']!, nodes } } }, host.commands, { schemaResolverFor: host.schemaResolverFor! })
          const result = await runPress(varied, { graphId: 'g1', nodeId: 'inner', instancePath: path('left'), button: 'add' }, host)
          expect(result.kind).toBe('done')
          expect(result.notes).toEqual(uses === 1 ? [] : ['Also added in the other 2 uses of "Shared body".'])
        }
      }
      if (driver === 'reroute') {
        const waiting = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
        const changedHost = { ...host, pick: async () => {
          expect(waiting.dispatch({ command: 'batch', params: { invocations: [
            { command: 'link.disconnect', params: { graphId: 'g1', linkId: 'upstream' } },
            { command: 'boundary.setBinding', params: { graphId: 'g1', side: 'inputs', itemId: 'shown', node: 'inner', port: 'value', viaReroute: 'junction' } },
            { command: 'link.connect', params: { graphId: 'g0', from: { node: 'source', port: 'out' }, to: { node: 'left', port: 'shown' } } },
          ] } }).ok).toBe(true)
          return 'go'
        } }
        const outcome = await runSteps(waiting, [{ graphId: 'g1', nodeId: 'inner', instancePath: path('left'), prefix: '', steps: decodeSteps([
          { step: 'addNode', nodeType: 'test.add_processor', to: 'value', values: {} },
          { step: 'pick', name: 'chosen', options: { value: ['go'] } },
        ]) }], changedHost)
        expect(outcome).toMatchObject({ kind: 'done', message: 'Nothing added. value is wired from outside this subgraph.', notes: [] })
        expect(Object.keys(waiting.doc.graphs['g1']!.nodes)).toHaveLength(2)
        expect(waiting.doc.occurrenceTopologies).toBeUndefined()
        expect(waiting.undo()).toBe(true)
        expect(waiting.doc.graphs['g1']!.links).toEqual(body.links)
        expect(waiting.canUndo).toBe(false)
      }
    }
  })

  it('Disconnect removes the wire and AddNode connects a new node beside this one', async () => {
    const doc = documentOf({ n1: { type: 'dev.buttons.field_steps' }, src: { type: 'dev.image.gradient' } }, link('l1', ['src', 'image'], ['n1', 'image']))
    const cut = sessionOf(doc)
    await runPress(cut, at('disconnect'), hostOf())
    expect(cut.doc.graphs['g0']!.links).toEqual({})

    const added = sessionOf(documentOf({ n1: { type: 'dev.buttons.field_steps' } }))
    await runPress(added, at('add_source'), hostOf())
    const graph = added.doc.graphs['g0']!
    const fresh = Object.values(graph.nodes).find((node) => node.id !== 'n1')!
    expect(fresh).toMatchObject({ type: 'dev.image.gradient', values: { width: 64 } })
    expect(added.doc.view.graphs['g0']!.nodes[fresh.id]!.position).toEqual({ x: 180, y: 40 })
    expect(Object.values(graph.links).map((item) => [item.from, item.to])).toEqual([[{ node: fresh.id, port: 'image' }, { node: 'n1', port: 'image' }]])
  })
})

describe('what a press may write', () => {
  it.each(['readOnly', 'disabled'] as const)('allows action writes to a %s field but still skips its wired sibling', async (access) => {
    addSchema('test.blocked-action', [
      ...['first', 'second'].map((id) => ({
        kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, required: true,
        default: 12, [access]: true, widget: { type: 'NUMBER', min: 0, max: 100 },
      })),
      { kind: 'button', id: 'set', label: 'Set', steps: [
        { step: 'set', field: 'first', value: { value: 24 } },
        { step: 'set', field: 'second', value: { value: 36 } },
      ] },
    ])
    addSchema('test.blocked-source', [{ kind: 'output', id: 'value', type: { kind: 'concrete', types: ['INT'] } }])
    const session = sessionOf(documentOf({
      n1: { type: 'test.blocked-action', values: { first: 12, second: 12 } },
      src: { type: 'test.blocked-source' },
    }, link('l1', ['src', 'value'], ['n1', 'second'])))
    expect(buttonAvailability(session.doc, at('set'), hostOf())).toEqual({ enabled: true })
    const outcome = await runPress(session, at('set'), hostOf())
    expect(outcome).toMatchObject({ kind: 'done', skipped: [{ id: 'second', why: 'wired' }] })
    expect(valuesOf(session)).toEqual({ first: 24, second: 12 })
    expect(session.doc.graphs.g0!.links.l1).toMatchObject({ to: { node: 'n1', port: 'second' } })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({ first: 12, second: 12 })
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session)).toEqual({ first: 24, second: 12 })
  })

  it('reads effective asset filenames and kinds in scope and after staged picker changes as one undo step', async () => {
    const asset = (name: string, mediaType = 'image/png') => ({ digest: `blake3:${'a'.repeat(64)}`, name, size: 123, mediaType, virtualPath: `input/${name}` })
    const rows = [
      { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: ['image/*'] } },
      { kind: 'input', id: 'result', type: { kind: 'concrete', types: ['STRING'] }, default: 'old' },
      { kind: 'input', id: 'after', type: { kind: 'concrete', types: ['STRING'] }, default: 'before' },
      { kind: 'button', id: 'fact', label: 'Read filename', steps: [
        { step: 'set', field: 'result', value: { formula: 'filename(image) + ":" + kind(image)' } },
        { step: 'disconnect', input: 'image' },
        { step: 'openPicker', field: 'image' },
        { step: 'set', field: 'after', value: { formula: 'filename(image) + ":" + kind(image)' } },
      ] },
    ]
    addSchema('test.asset_fact', rows)
    addSchema('test.asset_fact_member', [{ kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 4,
      keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: rows }])
    addSchema('test.asset_fact_output', [{ kind: 'output', id: 'out', type: { kind: 'concrete', types: ['ASSET'] } }])
    for (const prefix of ['', 'items.m0.']) for (const driver of ['saved', 'tap', 'output']) {
      const wired = driver !== 'saved'
      const doc = documentOf({
        n1: { type: prefix === '' ? 'test.asset_fact' : 'test.asset_fact_member',
          values: { [prefix + 'image']: asset('saved.png'), [prefix + 'result']: 'old', [prefix + 'after']: 'before' },
          ...(prefix === '' ? {} : { dynamic: { items: { members: ['m0'], seq: 1 } } }) },
        src: { type: driver === 'output' ? 'test.asset_fact_output' : 'test.asset_fact', values: { image: asset('incoming.png') } },
      }, wired ? { feed: { id: asLinkId('feed'), from: driver === 'output' ? { node: asNodeId('src'), port: asPortId('out') }
        : { node: asNodeId('src'), tap: asPortId('image') },
        to: { node: asNodeId('n1'), port: asPortId(prefix + 'image') } } } : {})
      const session = sessionOf(doc)
      const host = hostOf({ openPicker: async () => asset('picked.webm', 'video/webm') })
      const target = at(prefix + 'fact')
      if (driver === 'output') {
        expect(buttonAvailability(doc, target, host)).toEqual({ enabled: false, reason: 'Needs image, which is not known until a run.' })
        expect((await runPress(session, target, host)).kind).toBe('failed')
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
        const part = (formula: string) => [{ graphId: 'g0', nodeId: 'n1', prefix, steps: decodeSteps([
          { step: 'set', field: 'result', value: { formula } },
        ]) }]
        expect((await runSteps(session, part('filename(image) if known(filename(image)) else "unknown"'), host)).kind).toBe('done')
        expect(valuesOf(session)[prefix + 'result']).toBe('unknown')
        expect((await runSteps(session, part('"lazy" if True else filename(image)'), host)).kind).toBe('done')
        expect(valuesOf(session)[prefix + 'result']).toBe('lazy')
        continue
      }
      expect(buttonAvailability(doc, target, host)).toEqual({ enabled: true })
      expect((await runPress(session, target, host)).kind).toBe('done')
      expect(valuesOf(session)).toEqual({ [prefix + 'image']: asset('picked.webm', 'video/webm'),
        [prefix + 'result']: wired ? 'incoming.png:image' : 'saved.png:image', [prefix + 'after']: 'picked.webm:video' })
      const after = session.doc
      expect(session.undo()).toBe(true)
      expect(session.doc).toEqual(doc)
      expect(session.canUndo).toBe(false)
      expect(session.redo()).toBe(true)
      expect(session.doc).toEqual(after)
    }
    for (const [mediaType, expected] of [['image/gif', 'image'], ['video/webm', 'video'], ['audio/flac', 'audio'],
      ['model/gltf+json', '3d'], ['text/plain', 'text'], ['application/pdf', 'file'], ['image', 'file'], ['', 'unknown']]) {
      const session = sessionOf(documentOf({ n1: { type: 'test.asset_fact', values: { image: asset('folder\\nested/file.ext', mediaType) } } }))
      const outcome = await runSteps(session, [{ graphId: 'g0', nodeId: 'n1', prefix: '', steps: decodeSteps([
        { step: 'set', field: 'result', value: { formula: 'filename(image)' } },
        { step: 'set', field: 'after', value: { formula: 'kind(image) if known(kind(image)) else "unknown"' } },
      ]) }], hostOf())
      expect(outcome.kind, mediaType).toBe('done')
      expect(valuesOf(session)).toMatchObject({ result: 'file.ext', after: expected })
    }
  })

  it('keeps decoded asset facts unknown with a stored reference and rolls back earlier writes', async () => {
    addSchema('test.decoded_asset_fact', [
      { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['ASSET'] } },
      { kind: 'input', id: 'marker', type: { kind: 'concrete', types: ['INT'] }, default: 41 },
      { kind: 'button', id: 'read', label: 'Read width', steps: [
        { step: 'set', field: 'marker', value: { value: 23 } },
        { step: 'set', field: 'marker', value: { formula: 'width(image)' } },
      ] },
    ])
    const doc = documentOf({ n1: { type: 'test.decoded_asset_fact', values: {
      image: { digest: `blake3:${'a'.repeat(64)}`, name: '640x480.png', size: 123, mediaType: 'image/png', virtualPath: 'input/640x480.png' }, marker: 41,
    } } })
    const session = sessionOf(doc)
    expect(await runPress(session, at('read'), hostOf())).toMatchObject({ kind: 'failed', message: 'Nothing was changed. A value this button needs is not known yet.' })
    expect(session.doc).toEqual(doc)
    expect(session.canUndo).toBe(false)
  })

  it('reads connected types without execution values and refreshes facts after Disconnect', async () => {
    const int = (id: string) => ({ kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, default: 7 })
    const rows = [
      int('source'),
      { kind: 'input', id: 'result', type: { kind: 'concrete', types: ['STRING'] }, default: 'old' },
      { kind: 'input', id: 'after', type: { kind: 'concrete', types: ['STRING'] }, default: 'before' },
      { kind: 'button', id: 'fact', label: 'Read type', steps: [
        { step: 'set', field: 'result', value: { formula: 'linked_type(source) if linked(source) else "unwired"' } },
        { step: 'disconnect', input: 'source' },
        { step: 'set', field: 'after', value: { formula: '"disconnected" if linked_type(source) == None else "still linked"' } },
      ] },
    ]
    addSchema('test.type_fact', rows)
    addSchema('test.type_fact_member', [{ kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 4,
      keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: rows }])
    addSchema('test.type_fact_source', [int('value'), { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } }])
    addSchema('test.type_fact_generic', [
      { kind: 'input', id: 'value', type: { kind: 'variable', templateId: 'T' } },
      { kind: 'output', id: 'out', type: { kind: 'variable', templateId: 'T' } },
    ])
    for (const prefix of ['', 'items.m0.']) for (const driver of ['none', 'output', 'tap', 'net', 'reroute', 'generic', 'bypass']) {
      const connected = driver !== 'none'
      const from = driver === 'tap' ? { node: asNodeId('src'), tap: asPortId('value') }
        : driver === 'reroute' ? { reroute: 'junction' as never } : { node: asNodeId('src'), port: asPortId('out') }
      const to = { node: asNodeId('n1'), port: asPortId(prefix + 'source') }
      const initial = documentOf({
        n1: { type: prefix === '' ? 'test.type_fact' : 'test.type_fact_member', values: { [prefix + 'result']: 'old', [prefix + 'after']: 'before' },
          ...(prefix === '' ? {} : { dynamic: { items: { members: ['m0'], seq: 1 } } }) },
        src: { type: driver === 'generic' ? 'test.type_fact_generic' : 'test.type_fact_source', ...(driver === 'bypass' ? { mode: 'bypassed' as const } : {}) },
        upstream: { type: 'test.type_fact_source' },
      }, {
        ...(connected && driver !== 'net' ? { feed: { id: asLinkId('feed'), from, to } } : {}),
        ...(driver === 'reroute' ? { bridge: { id: asLinkId('bridge'), from: { node: asNodeId('src'), port: asPortId('out') }, to: from } } : {}),
        ...(driver === 'generic' || driver === 'bypass' ? link('bridge', ['upstream', 'out'], ['src', 'value']) : {}),
      })
      const doc: WorkflowDocument = { ...initial, graphs: { g0: { ...initial.graphs['g0']!,
        ...(driver === 'net' ? { nets: { feed: { id: 'feed' as never, name: 'Typed source', source: { node: asNodeId('src'), port: asPortId('out') }, sinks: [to] } } } : {}),
        ...(driver === 'reroute' ? { reroutes: { junction: { id: 'junction' as never } } } : {}),
      } } }
      const session = sessionOf(doc)
      const host = hostOf()
      const target = at(prefix + 'fact')
      expect(buttonAvailability(doc, target, host), driver + prefix).toEqual({ enabled: true })
      const outcome = await runPress(session, target, host)
      expect(outcome.kind, driver + prefix + ': ' + outcome.message).toBe('done')
      expect(valuesOf(session)).toEqual({ [prefix + 'result']: connected ? 'INT' : 'unwired', [prefix + 'after']: 'disconnected' })
      expect(Object.values(session.doc.graphs['g0']!.links).some((link) => isPortEndpoint(link.to) && link.to.node === 'n1')).toBe(false)
      const after = session.doc
      expect(session.undo()).toBe(true)
      expect(session.doc).toEqual(doc)
      expect(session.canUndo).toBe(false)
      expect(session.redo()).toBe(true)
      expect(session.doc).toEqual(after)
    }
  })

  it('fails on an off-step whole number or an option the field does not have, and stores a decimal off its step', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.field_steps', values: { width: 512, mode: 'fast', scale: 0.5 } } }))
    expect((await runPress(session, at('off_step'), hostOf())).message).toBe('Nothing was changed. width moves in steps of 64; the button gave 100.')
    expect((await runPress(session, at('bad_option'), hostOf())).message).toBe('Nothing was changed. slow is not one of the options of mode.')
    expect((await runPress(session, at('quarter'), hostOf())).kind).toBe('done')
    expect(valuesOf(session)).toMatchObject({ width: 512, mode: 'fast', scale: 0.3 })
  })

  it('skips and reports a wired target and sets the others', async () => {
    const doc = documentOf({ n1: { type: 'dev.buttons.field_steps', values: { width: 512, height: 768 } }, src: { type: 'test.int' } },
      link('l1', ['src', 'value'], ['n1', 'height']))
    addSchema('test.int', [{ kind: 'output', id: 'value', type: { kind: 'concrete', types: ['INT'] } }])
    const session = sessionOf(doc)
    const outcome = await runPress(session, at('double'), hostOf())
    expect(outcome).toMatchObject({ kind: 'done', message: 'Set 1 field. height has a wire and was left as it is.' })
    expect(valuesOf(session)).toMatchObject({ width: 1024, height: 768 })
  })

  it('checks SetEach member targets and lazy dependencies before making a Call', async () => {
    const input = (id: string) => ({ kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, default: 7 })
    addSchema('test.each_availability', [
      input('upstream'), input('marker'),
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
      { kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 4,
        keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: [input('source'), input('value')] },
      { kind: 'button', id: 'all', label: 'Fill', steps: [{ step: 'setEach', group: 'items', field: 'value', value: { value: 23 } }] },
      ...['upstream', 'source', '31 if index() == 0 else source', '31 if True else source', 'source if known(source) else 37', 'sum(items.source)', 'amount + (31 if True else source)'].map((formula, index) => ({
        kind: 'button', id: `read_${index}`, label: 'Read', steps: [
          { step: 'set', field: 'marker', value: { value: 17 } },
          { step: 'pick', name: 'amount', options: { value: [5] } },
          { step: 'call', function: 'probe.wait', args: [], writes: ['marker'] },
          { step: 'setEach', group: 'items', field: 'value', value: { formula } },
        ],
      })),
    ])
    const values = { marker: 7, upstream: 13, 'items.m0.source': 19, 'items.m1.source': 29, 'items.m0.value': 41, 'items.m1.value': 43 }
    const base = documentOf({ n1: { type: 'test.each_availability', values, dynamic: { items: { members: ['m0', 'm1'], seq: 2 } } }, src: { type: 'test.each_availability' } })
    let calls = 0
    const host = hostOf({ pick: async () => 5, call: async () => { calls++; return { kind: 'answer', fields: { marker: 47n }, notes: [] } } })
    const wired = (ports: string[]) => ({ ...base, graphs: { ...base.graphs, g0: { ...base.graphs['g0']!, links: Object.assign({}, ...ports.map((port, i) => link(`l${i}`, ['src', 'out'], ['n1', port]))) } } })
    const all = wired(['items.m0.value', 'items.m1.value'])
    expect(buttonAvailability(all, at('all'), host)).toEqual({ enabled: false, reason: 'Every field this would set has a wire.' })
    const partial = sessionOf(wired(['items.m0.value']))
    expect(buttonAvailability(partial.doc, at('all'), host)).toEqual({ enabled: true })
    expect((await runPress(partial, at('all'), host)).kind).toBe('done')
    expect(valuesOf(partial)).toMatchObject({ 'items.m0.value': 41, 'items.m1.value': 23 })
    for (const [button, port, needed] of [['read_0', 'upstream', 'upstream'], ['read_1', 'items.m1.source', 'source'], ['read_2', 'items.m1.source', 'source'], ['read_5', 'items.m1.source', 'items.source']]) {
      const session = sessionOf(wired([port!]))
      expect(buttonAvailability(session.doc, at(button!), host)).toEqual({ enabled: false, reason: `Needs ${needed}, which is not known until a run.` })
      expect((await runPress(session, at(button!), host)).kind).toBe('failed')
      expect(session.doc).toEqual(wired([port!]))
      expect(session.canUndo).toBe(false)
    }
    expect(calls).toBe(0)
    for (const [button, first, second] of [['read_3', 31, 31], ['read_4', 19, 37], ['read_6', 36, 36]] as const) {
      const session = sessionOf(wired(['items.m1.source']))
      expect(buttonAvailability(session.doc, at(button), host)).toEqual({ enabled: true })
      expect((await runPress(session, at(button), host)).kind).toBe('done')
      expect(valuesOf(session)).toMatchObject({ marker: 47, 'items.m0.value': first, 'items.m1.value': second })
    }
    expect(calls).toBe(3)
  })

  it('is turned off before a press when every target is wired, when it needs a wired value, or when the pack says so', () => {
    addSchema('test.int', [{ kind: 'output', id: 'value', type: { kind: 'concrete', types: ['INT'] } }])
    addSchema('test.text', [{ kind: 'output', id: 'value', type: { kind: 'concrete', types: ['STRING'] } }])
    const host = hostOf()
    const wired = documentOf({ n1: { type: 'dev.buttons.field_steps' }, src: { type: 'test.int' } },
      { ...link('l1', ['src', 'value'], ['n1', 'width']), ...link('l2', ['src', 'value'], ['n1', 'height']) })
    expect(buttonAvailability(wired, at('swap'), host)).toEqual({ enabled: false, reason: 'Every field this would set has a wire.' })
    expect(buttonAvailability(wired, at('needs_image'), host)).toEqual({ enabled: true })

    const text = documentOf({ n1: { type: 'dev.buttons.translate' }, src: { type: 'test.text' } }, link('l1', ['src', 'value'], ['n1', 'text']))
    expect(buttonAvailability(text, at('translate'), host)).toEqual({ enabled: false, reason: 'Needs text, which is not known until a run.' })

    const off = documentOf({ n1: { type: 'dev.buttons.translate', values: { manual_translate: false } } })
    expect(buttonAvailability(off, at('translate'), host)).toEqual({
      enabled: false, reason: 'Manual translate is off. The translation happens when you press Run.',
    })
    const mask = documentOf({ n1: { type: 'dev.buttons.ask_steps' } })
    expect(buttonAvailability(mask, at('mask'), host)).toEqual({ enabled: false, reason: 'This editor is not available yet.' })
  })

  it('reads known incoming values rather than dormant fields, with one undo and deterministic redo', async () => {
    addSchema('test.known_incoming', [
      { kind: 'input', id: 'upstream', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
      { kind: 'input', id: 'marker', type: { kind: 'concrete', types: ['INT'] }, default: 41 },
      { kind: 'output', id: 'known', type: { kind: 'concrete', types: ['INT'] }, knownValue: { input: 'upstream' } },
      { kind: 'output', id: 'unknown', type: { kind: 'concrete', types: ['INT'] } },
      { kind: 'button', id: 'read', label: 'Read incoming', steps: [
        { step: 'set', field: 'marker', value: { formula: 'upstream + 1' } },
        { step: 'call', function: 'probe.read', args: ['upstream'], writes: ['marker'] },
      ] },
    ])
    const args: unknown[] = []
    const host = hostOf({ call: async (request) => { args.push(request.args); return { kind: 'answer', fields: {}, notes: [] } } })
    for (const kind of ['tap', 'known', 'unknown'] as const) {
      const doc = documentOf({ n1: { type: 'test.known_incoming', values: { upstream: 97, marker: 41 } }, src: { type: 'test.known_incoming', values: { upstream: 13 } } }, {
        l1: { id: asLinkId('l1'), from: kind === 'tap' ? { node: asNodeId('src'), tap: asPortId('upstream') } : { node: asNodeId('src'), port: asPortId(kind) }, to: { node: asNodeId('n1'), port: asPortId('upstream') } },
      })
      const session = sessionOf(doc)
      expect(buttonAvailability(doc, at('read'), host), kind).toEqual(kind === 'unknown'
        ? { enabled: false, reason: 'Needs upstream, which is not known until a run.' } : { enabled: true })
      expect((await runPress(session, at('read'), host)).kind).toBe(kind === 'unknown' ? 'failed' : 'done')
      if (kind === 'unknown') {
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
      } else {
        expect(valuesOf(session)).toEqual({ upstream: 97, marker: 14 })
        expect(args.at(-1)).toEqual([13n])
        const calls = args.length
        expect(session.undo()).toBe(true)
        expect(valuesOf(session)).toEqual({ upstream: 97, marker: 41 })
        expect(session.canUndo).toBe(false)
        expect(session.redo()).toBe(true)
        expect(valuesOf(session).marker).toBe(14)
        expect(args).toHaveLength(calls)
      }
    }
    expect(args).toHaveLength(2)
  })

  it('checks reads against preceding staged values and disconnections without making preflight calls', async () => {
    const set = (field: string, value: unknown) => ({ step: 'set', field, value })
    const cases = [
      { id: 'disconnect', steps: [{ step: 'disconnect', input: 'upstream' }, set('marker', { formula: 'upstream + 1' })], values: { upstream: 97, marker: 98, result: 3 } },
      { id: 'lazy', steps: [set('marker', { value: 0 }), set('result', { formula: 'upstream if marker else 23' })], values: { upstream: 97, marker: 0, result: 23 } },
      { id: 'formula', steps: [set('marker', { formula: 'marker - 41' }), set('result', { formula: 'upstream if marker else 23' })], values: { upstream: 97, marker: 0, result: 23 } },
      { id: 'disconnected_target', steps: [{ step: 'disconnect', input: 'upstream' }, set('upstream', { value: 17 })], values: { upstream: 17, marker: 41, result: 3 } },
      { id: 'needed', steps: [set('marker', { value: 1 }), set('result', { formula: 'upstream if marker else 23' })] },
      { id: 'call_before_needed', steps: [{ step: 'call', function: 'probe', args: [], writes: ['result'] }, set('marker', { value: 1 }), set('result', { formula: 'upstream if marker else 23' })] },
    ]
    addSchema('test.staged_availability', [
      ...['upstream', 'marker', 'result'].map((id) => ({ kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, default: 7 })),
      { kind: 'output', id: 'unknown', type: { kind: 'concrete', types: ['INT'] } },
      ...cases.map(({ id, steps }) => ({ kind: 'button', id, label: id, steps })),
    ])
    let calls = 0
    const host = hostOf({ call: async () => { calls++; return { kind: 'answer', fields: {}, notes: [] } } })
    const doc = documentOf({ n1: { type: 'test.staged_availability', values: { upstream: 97, marker: 41, result: 3 } }, src: { type: 'test.staged_availability' } }, link('l1', ['src', 'unknown'], ['n1', 'upstream']))
    for (const item of cases) {
      const session = sessionOf(doc)
      expect(buttonAvailability(doc, at(item.id), host), item.id).toEqual(item.values === undefined
        ? { enabled: false, reason: 'Needs upstream, which is not known until a run.' } : { enabled: true })
      expect(calls).toBe(0)
      expect((await runPress(session, at(item.id), host)).kind, item.id).toBe(item.values === undefined ? 'failed' : 'done')
      if (item.values === undefined) {
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
      } else {
        expect(valuesOf(session), item.id).toEqual(item.values)
        expect(session.undo()).toBe(true)
        expect(session.doc).toEqual(doc)
        expect(session.canUndo).toBe(false)
        expect(session.redo()).toBe(true)
        expect(valuesOf(session)).toEqual(item.values)
      }
    }
    expect(calls).toBe(0)
  })

  it('checks independent required inputs even after uncertain Call results', async () => {
    const set = (formula: string) => ({ step: 'set', field: 'result', value: { formula } })
    const cases = [
      { id: 'later', steps: [set('marker + 1'), set('upstream + 1')], enabled: false },
      { id: 'left', steps: [set('marker + upstream')], enabled: false },
      { id: 'right', steps: [set('upstream + marker')], enabled: false },
      { id: 'argument', steps: [set('min(marker, upstream)')], enabled: false },
      { id: 'comparison', steps: [set('1 if marker < upstream else 0')], enabled: false },
      { id: 'list', steps: [set('sum([marker, upstream])')], enabled: false },
      { id: 'index', steps: [set('[marker][upstream]')], enabled: false },
      { id: 'members', steps: [set('sum([marker if x else upstream for x in [1, 0]])')], enabled: false },
      { id: 'lazy', steps: [set('upstream if marker else 23')], enabled: true },
      { id: 'known', steps: [set('upstream if known(marker) else 23')], enabled: true },
    ]
    addSchema('test.uncertain_reads', [
      ...['upstream', 'marker', 'result'].map((id) => ({ kind: 'input', id, type: { kind: 'concrete', types: ['INT'] }, default: 7 })),
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
      ...cases.map(({ id, steps }) => ({ kind: 'button', id, label: id, steps: [
        { step: 'call', function: 'probe', args: [], writes: ['marker'] }, ...steps,
      ] })),
    ])
    const doc = documentOf({ n1: { type: 'test.uncertain_reads', values: { upstream: 97, marker: 41, result: 3 } }, src: { type: 'test.uncertain_reads' } }, link('l1', ['src', 'out'], ['n1', 'upstream']))
    for (const item of cases) {
      let calls = 0
      const host = hostOf({ call: async () => { calls++; return { kind: 'answer', fields: { marker: 0n }, notes: [] } } })
      const session = sessionOf(doc)
      expect(buttonAvailability(doc, at(item.id), host), item.id).toEqual(item.enabled
        ? { enabled: true } : { enabled: false, reason: 'Needs upstream, which is not known until a run.' })
      expect(calls).toBe(0)
      const outcome = await runPress(session, at(item.id), host)
      expect(calls, item.id).toBe(item.enabled ? 1 : 0)
      if (item.id === 'lazy') {
        expect(outcome.kind).toBe('done')
        expect(valuesOf(session)).toEqual({ upstream: 97, marker: 0, result: 23 })
        expect(session.undo()).toBe(true)
        expect(session.doc).toEqual(doc)
      } else {
        expect(outcome.kind).toBe('failed')
        expect(session.doc).toEqual(doc)
      }
      expect(session.canUndo).toBe(false)
    }
  })

  it('checks nested Lookup arguments before making a Call or changing topology', async () => {
    addSchema('test.nested_lookup', [
      { kind: 'input', id: 'upstream', type: { kind: 'concrete', types: ['INT'] }, default: 13 },
      { kind: 'input', id: 'marker', type: { kind: 'concrete', types: ['INT'] }, default: 41 },
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
      { kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 4,
        keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
        ] },
      ...['addMember', 'addNode'].flatMap((step) => ['upstream', { formula: 'upstream' }, { formula: '37 if True else upstream' }, 'amount'].map((arg, index) => ({
        kind: 'button', id: `${step}_${index}`, label: 'Add', steps: [
          { step: 'pick', name: 'amount', options: { value: [19] } },
          { step: 'call', function: 'probe.wait', args: [], writes: ['marker'] },
          { step, ...(step === 'addMember' ? { group: 'items' } : { nodeType: 'test.nested_lookup', to: 'upstream' }),
            values: { [step === 'addMember' ? 'value' : 'marker']: { lookup: 'probe.value', args: [arg] } } },
        ],
      }))),
    ])
    let calls = 0, lookups = 0
    const host = hostOf({ pick: async () => 19, call: async () => { calls++; return { kind: 'answer', fields: { marker: 29n }, notes: [] } },
      lookup: async ({ args }) => { lookups++; return { state: 'ready', value: args[0] } } })
    for (const step of ['addMember', 'addNode']) {
      const before = documentOf({ n1: { type: 'test.nested_lookup', values: { marker: 41 } }, src: { type: 'test.nested_lookup' } },
        link('l1', ['src', 'out'], ['n1', 'upstream']))
      for (const index of [0, 1]) {
        const session = sessionOf(before)
        expect(buttonAvailability(before, at(`${step}_${index}`), host)).toEqual({ enabled: false, reason: 'Needs upstream, which is not known until a run.' })
        expect((await runPress(session, at(`${step}_${index}`), host)).kind).toBe('failed')
        expect(session.doc).toEqual(before)
        expect(session.canUndo).toBe(false)
      }
      expect(calls).toBe(0)
      expect(lookups).toBe(0)
    }
    for (const step of ['addMember', 'addNode']) for (const [index, value] of [[2, 37], [3, 19]]) {
      const session = sessionOf(documentOf({ n1: { type: 'test.nested_lookup' }, src: { type: 'test.nested_lookup' } },
        link('l1', ['src', 'out'], ['n1', 'upstream'])))
      expect(buttonAvailability(session.doc, at(`${step}_${index}`), host)).toEqual({ enabled: true })
      expect((await runPress(session, at(`${step}_${index}`), host)).kind).toBe('done')
      if (step === 'addMember') expect(valuesOf(session)['items.m0.value']).toBe(value)
      else expect(Object.values(session.doc.graphs['g0']!.nodes).find((node) => node.id !== 'n1' && node.id !== 'src')?.values['marker']).toBe(value)
    }
    expect(calls).toBe(4)
    expect(lookups).toBe(4)
  })
})

describe('while a press waits', () => {
  const probe = (values: Record<string, Json> = {}) =>
    sessionOf(documentOf({ n1: { type: 'dev.buttons.call_probe', values: { first: 'old', second: 1, ...values } } }))

  it('keeps a field the user changed meanwhile, even back to its old value, and sets the rest', async () => {
    const session = probe()
    const answer = later<CallAnswer>()
    const pressing = runPress(session, at('call'), hostOf({ call: () => answer.promise }))
    await Promise.resolve()
    const edit = (value: string) => session.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'first', value } })
    edit('mine')
    edit('old')
    answer.settle({ kind: 'answer', fields: { first: 'one', second: 2n }, notes: [] })
    const outcome = await pressing
    expect(valuesOf(session)).toMatchObject({ first: 'old', second: 2 })
    expect(outcome.skipped).toEqual([{ id: 'first', why: 'edited' }])
    expect(outcome.message).toBe('Set 1 field. first was changed while the button waited and keeps that value.')
  })

  it('rolls back all staged writes when a saved member is removed during Pick', async () => {
    addSchema('test.removed-saved-member', [
      { kind: 'input', id: 'marker', type: { kind: 'concrete', types: ['STRING'] }, default: 'before' },
      { kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 4,
        keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
        ] },
      { kind: 'button', id: 'apply', label: 'Apply', steps: [
        { step: 'set', field: 'marker', value: { value: 'after' } },
        { step: 'setEach', group: 'items', field: 'value', value: { formula: 'value * 2' } },
        { step: 'pick', name: 'answer', options: { value: ['continue'] } },
      ] },
    ])
    const session = sessionOf(documentOf({ n1: {
      type: 'test.removed-saved-member',
      values: { marker: 'before', 'items.m0.value': 7, 'items.m1.value': 13 },
      dynamic: { items: { members: ['m0', 'm1'], seq: 2 } },
    } }))
    const entered = later<void>()
    const answer = later<string>()
    const pressing = runPress(session, at('apply'), hostOf({ pick: () => { entered.settle(); return answer.promise } }))
    await entered.promise
    expect(session.dispatch({ command: 'dynamic.removeMember', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'items', member: 'm0',
    } }).ok).toBe(true)
    const beforeReply = structuredClone(session.doc)
    answer.settle('continue')
    expect(await pressing).toMatchObject({ kind: 'failed', message: 'Nothing was changed. A member this button needs was removed while it waited.' })
    expect(session.doc).toEqual(beforeReply)
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toEqual({ marker: 'before', 'items.m0.value': 7, 'items.m1.value': 13 })
    expect(session.canUndo).toBe(false)
  })

  it('rolls back when a formula source disappears during Call, but permits ordinary edits', async () => {
    const reads = [
      { formula: 'items.value[0] + 11', option: false, result: 40 },
      { formula: 'len(items) + 11', option: false, result: 12 },
      { formula: '11 if linked(mode.value) else 12', option: true, result: 12 },
      { formula: '11 if linked_type(mode.value) == None else 12', option: true, result: 11 },
    ]
    addSchema('test.removed-read-member', [
      { kind: 'input', id: 'result', type: { kind: 'concrete', types: ['INT'] }, default: 3 },
      { kind: 'input', id: 'answer', type: { kind: 'concrete', types: ['INT'] }, default: 5 },
      { kind: 'group', id: 'items', grows: 'button', minMembers: 0, maxMembers: 4,
        keys: { numbered: { prefix: 'm', start: 0, pad: 0 } }, member: [
          { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
        ] },
      { kind: 'choice', id: 'mode', required: true, default: 'a', options: [
        { key: 'a', rows: [{ kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 23 }] },
        { key: 'b', rows: [] },
      ] },
      ...reads.map(({ formula }, index) => ({ kind: 'button', id: `apply_${index}`, label: 'Apply', steps: [
        { step: 'set', field: 'result', value: { formula } },
        { step: 'call', function: 'probe.wait', args: [], writes: ['answer'] },
      ] })),
    ])
    for (const [index, { option, result }] of reads.entries()) for (const remove of [true, false]) {
      const session = sessionOf(documentOf({ n1: {
        type: 'test.removed-read-member', values: { result: 3, answer: 5, 'items.m0.value': 29, 'mode.value': 23 },
        dynamic: { items: { members: ['m0'], seq: 1 }, mode: { selected: 'a' } },
      } }))
      const entered = later<void>()
      const answer = later<CallAnswer>()
      const pressing = runPress(session, at(`apply_${index}`), hostOf({ call: () => { entered.settle(); return answer.promise } }))
      await entered.promise
      expect(valuesOf(session)).toMatchObject({ result: 3, answer: 5 })
      expect(session.dispatch(remove
        ? option
          ? { command: 'dynamic.selectOption', params: { graphId: 'g0', nodeId: 'n1', construct: 'mode', option: 'b' } }
          : { command: 'dynamic.removeMember', params: { graphId: 'g0', nodeId: 'n1', construct: 'items', member: 'm0' } }
        : { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'items.m0.value', value: 83 } }).ok).toBe(true)
      const beforeReply = structuredClone(session.doc)
      answer.settle({ kind: 'answer', fields: { answer: 71n }, notes: [] })
      expect((await pressing).kind).toBe(remove ? 'failed' : 'done')
      if (remove) expect(session.doc).toEqual(beforeReply)
      else {
        expect(valuesOf(session)).toEqual({ result, answer: 71, 'items.m0.value': 83, 'mode.value': 23 })
        expect(session.undo()).toBe(true)
        expect(session.doc).toEqual(beforeReply)
      }
      expect(session.undo()).toBe(true)
      expect(valuesOf(session)).toEqual({ result: 3, answer: 5, 'items.m0.value': 29, 'mode.value': 23 })
      expect(session.canUndo).toBe(false)
    }
  })

  describe('changes to what the press writes into', () => {
    const text = { kind: 'concrete', types: ['STRING'] }
    const pickThen = (step: unknown) => [{ step: 'pick', name: 'chosen', options: { value: ['p', 'q'] } }, step]
    addSchema('test.waits', [
      { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['dev.image'] }, required: false },
      {
        kind: 'group', id: 'items', keys: { numbered: { prefix: 'item_', start: 1, pad: 0 } }, grows: 'button', minMembers: 0, maxMembers: 3,
        member: [{ kind: 'input', id: 'label', type: text, required: true, default: 'x' }],
      },
      {
        kind: 'choice', id: 'mode', required: true, default: 'a',
        options: [{ key: 'a', rows: [{ kind: 'input', id: 'x', type: text, required: true, default: '' }] }, { key: 'b', rows: [] }],
      },
      { kind: 'button', id: 'add', label: 'Add', steps: pickThen({ step: 'addMember', group: 'items', values: { label: { formula: 'chosen' } } }) },
      { kind: 'button', id: 'feed', label: 'Feed', steps: pickThen({ step: 'addNode', nodeType: 'dev.image.gradient', to: 'image', values: {} }) },
      { kind: 'button', id: 'set_x', label: 'Set x', steps: pickThen({ step: 'set', field: 'mode.x', value: { formula: 'chosen' } }) },
    ])
    const waiting = (session: DocumentSession, button: string) => {
      const list = later<string | undefined>()
      return { pressing: runPress(session, at(button), hostOf({ pick: () => list.promise })), answer: list.settle }
    }

    it('fails a second press whose new member another press already added', async () => {
      const session = sessionOf(documentOf({ n1: { type: 'test.waits' } }))
      const first = waiting(session, 'add')
      const second = waiting(session, 'add')
      await Promise.resolve()
      first.answer('p')
      expect((await first.pressing).kind).toBe('done')
      second.answer('q')
      expect((await second.pressing).message).toBe('Nothing was changed. The group changed while the button waited.')
      expect(session.doc.graphs['g0']!.nodes['n1']!.dynamic?.['items']?.members).toEqual(['item_1'])
      expect(valuesOf(session)).toMatchObject({ 'items.item_1.label': 'p' })
    })

    it('keeps a wire the user made meanwhile instead of putting a new node in front of it', async () => {
      const session = sessionOf(documentOf({ n1: { type: 'test.waits' }, src: { type: 'dev.image.gradient' } }))
      const press = waiting(session, 'feed')
      await Promise.resolve()
      session.dispatch({ command: 'link.connect', params: { graphId: 'g0', from: { node: 'src', port: 'image' }, to: { node: 'n1', port: 'image' } } })
      press.answer('p')
      expect((await press.pressing).skipped).toEqual([{ id: 'image', why: 'wired' }])
      const links = Object.values(session.doc.graphs['g0']!.links)
      expect(links.map((item) => [item.from, item.to])).toEqual([[{ node: 'src', port: 'image' }, { node: 'n1', port: 'image' }]])
      expect(Object.keys(session.doc.graphs['g0']!.nodes).sort()).toEqual(['n1', 'src'])
    })

    it('fails when the option holding its field is no longer chosen', async () => {
      const session = sessionOf(documentOf({ n1: { type: 'test.waits' } }))
      const press = waiting(session, 'set_x')
      await Promise.resolve()
      session.dispatch({ command: 'dynamic.selectOption', params: { graphId: 'g0', nodeId: 'n1', construct: 'mode', option: 'b' } })
      press.answer('p')
      expect((await press.pressing).message).toBe('Nothing was changed. A field this button sets is no longer on the node.')
      expect(valuesOf(session)['mode.x']).toBeUndefined()
    })
  })

  it('writes nowhere when the node is deleted', async () => {
    const session = probe()
    const answer = later<CallAnswer>()
    const pressing = runPress(session, at('call'), hostOf({ call: () => answer.promise }))
    await Promise.resolve()
    session.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['n1'] } })
    answer.settle({ kind: 'answer', fields: { second: 2n }, notes: [] })
    expect((await pressing).message).toBe('Nothing was changed. The node was removed while the button waited.')
    expect(session.doc.graphs['g0']!.nodes['n1']).toBeUndefined()
  })

  it('drops everything on Cancel and lets the next press run', async () => {
    const session = probe()
    const controller = new AbortController()
    const answer = later<CallAnswer>()
    const pressing = runPress(session, at('call'), hostOf({ call: () => answer.promise }), { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    answer.settle({ kind: 'answer', fields: { first: 'late' }, notes: [] })
    expect(await pressing).toEqual({ kind: 'cancelled', skipped: [], notes: [] })
    expect(valuesOf(session)).toMatchObject({ first: 'old', second: 1 })
    expect(session.canUndo).toBe(false)
    const next = await runPress(session, at('call'), hostOf({ call: async () => ({ kind: 'answer', fields: { second: 3n }, notes: [] }) }))
    expect(next.kind).toBe('done')
    expect(valuesOf(session)).toMatchObject({ first: 'staged', second: 3 })
  })
})

describe('call answers', () => {
  const pressWith = async (answer: CallAnswer, values: Record<string, Json> = {}) => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.call_probe', values: { first: 'old', second: 1, ...values } } }))
    const progress: unknown[] = []
    const outcome = await runPress(session, at('call'), hostOf({
      call: async (_request, report) => {
        report(0.5, 'Waiting')
        return answer
      },
    }), { onProgress: (item) => progress.push(item) })
    return { session, outcome, progress }
  }

  it('commits a partial answer with the earlier Set and shows its note', async () => {
    const { session, outcome, progress } = await pressWith({ kind: 'answer', fields: { first: 'only' }, notes: ['The second field was left out.'] })
    expect(valuesOf(session)).toMatchObject({ first: 'only', second: 1 })
    expect(outcome).toMatchObject({ kind: 'done', message: 'The second field was left out.' })
    expect(progress).toContainEqual({ text: 'Waiting', fraction: 0.5 })
  })

  it('refuses the whole press for a key it may not set, a wrong type or a failed function', async () => {
    const extra = await pressWith({ kind: 'answer', fields: { first: 'one', elsewhere: 3n }, notes: [] })
    expect(extra.outcome.message).toBe('Nothing was changed. The pack answered something this button may not set.')
    expect(valuesOf(extra.session)).toMatchObject({ first: 'old' })
    const wrong = await pressWith({ kind: 'answer', fields: { second: 'two' }, notes: [] })
    expect(wrong.outcome.message).toBe('Nothing was changed. second takes a whole number; the button gave two.')
    const raised = await pressWith({ kind: 'failed', message: 'No sheet named video in this file.' })
    expect(raised.outcome.message).toBe('Nothing was changed. No sheet named video in this file.')
    expect(raised.session.canUndo).toBe(false)
  })

  it('checks a described answer before it stores it', async () => {
    const press = async (exposed: string) => {
      const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.app_workflow' } }))
      const outcome = await runPress(session, at('source.load_inputs'), hostOf({
        call: async () => ({ kind: 'answer', fields: { exposed, overrides: '{"cfg": 6}' }, notes: [] }),
      }))
      return { outcome, values: valuesOf(session) }
    }
    const good = JSON.stringify({ entries: [{ id: 'steps', label: 'Steps', kind: 'number', default: 20 }] })
    expect((await press(good)).values).toMatchObject({ 'source.exposed': good, overrides: '{"cfg": 6}' })
    const bad = await press(JSON.stringify({ entries: [{ id: 'steps', label: 'Steps', kind: 'slider' }] }))
    expect(bad.outcome.kind).toBe('failed')
    expect(bad.values).toEqual({})
  })
})

describe('lists, forms and lookups', () => {
  it.each([{ answer: 2n, accepted: true }, { answer: 2, accepted: false }])('keeps lookup numeric kind for an integer target: $answer', async ({ answer, accepted }) => {
    addSchema('test.typed_lookup', [
      { kind: 'input', id: 'first', type: { kind: 'concrete', types: ['STRING'] }, required: true, default: '' },
      { kind: 'input', id: 'second', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 1 },
      { kind: 'button', id: 'read', label: 'Read', steps: [
        { step: 'set', field: 'first', value: { value: 'staged' } },
        { step: 'set', field: 'second', value: { lookup: 'test.mod.count', args: [] } },
      ] },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.typed_lookup', values: { first: 'old', second: 1 } } }))
    const outcome = await runPress(session, at('read'), hostOf({ lookup: async () => ({ state: 'ready', value: answer }) }))
    expect(outcome.kind).toBe(accepted ? 'done' : 'failed')
    expect(valuesOf(session)).toEqual(accepted ? { first: 'staged', second: 2 } : { first: 'old', second: 1 })
    expect(session.canUndo).toBe(accepted)
  })

  it('Pick offers a stale list and passes its choice to later steps, which store a looked-up value', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.lora_preset' } }))
    const asked: unknown[] = []
    const host = hostOf({
      lookup: async (request) => {
        asked.push([request.function.split('.').at(-1), request.args, request.use, request.asker])
        return request.use === 'options'
          ? { state: 'stale', value: ['SD-NONE', 'SD-INS'] }
          : { state: 'ready', value: '1,1,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0' }
      },
      pick: async (request) => (expect(request.state).toBe('stale'), request.options[1]!.value),
    })
    expect((await runPress(session, at('pick_preset'), host)).kind).toBe('done')
    expect(valuesOf(session)).toMatchObject({ preset: 'SD-INS', block_vector: '1,1,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0' })
    expect(asked).toEqual([['preset_names', [], 'options', 'press'], ['preset_vector', ['SD-INS'], 'value', 'press']])
  })

  it('fails without storing when the lookup service cannot give a value, and does not ask it again', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.lora_preset' } }))
    let asks = 0
    const outcome = await runPress(session, at('apply_preset'), hostOf({ lookup: async () => (asks++, { state: 'failed', reason: 'wrong-shape' }) }))
    // The service itself asks again once for a missing or stale value.
    expect(asks).toBe(1)
    expect(outcome.message).toBe('Nothing was changed. The pack could not provide this value.')
    expect(valuesOf(session)).toEqual({})
  })

  it('an empty or failed list offers nothing to pick, and closing it changes nothing', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.lora_preset' } }))
    const shown: unknown[] = []
    const outcome = await runPress(session, at('pick_preset'), hostOf({
      lookup: async () => ({ state: 'failed', reason: 'failed' }),
      pick: async (request) => (shown.push([request.state, request.options.length]), undefined),
    }))
    expect(shown).toEqual([['failed', 0]])
    expect(outcome.kind).toBe('cancelled')
    expect(session.canUndo).toBe(false)
  })

  it('Ask gives its rows to the formula after it, as whole and decimal numbers', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.ask_steps' } }))
    const outcome = await runPress(session, at('fill'), hostOf({ ask: async () => ({ start: 0.5, end: 2, count: 4 }) }))
    expect(outcome.kind).toBe('done')
    expect(valuesOf(session)['values']).toBe('0.50, 1.00, 1.50, 2.00')
    const cancelled = sessionOf(documentOf({ n1: { type: 'dev.buttons.ask_steps' } }))
    expect((await runPress(cancelled, at('fill'), hostOf())).kind).toBe('cancelled')
    expect(cancelled.canUndo).toBe(false)
  })
})

describe('steps outside the workflow', () => {
  it('run after the commit, read the committed values, and report a failure without undoing', async () => {
    addSchema('test.outside', [
      { kind: 'input', id: 'site', type: { kind: 'concrete', types: ['STRING'] }, required: true, default: 'a.example' },
      {
        kind: 'button', id: 'go', label: 'Go',
        steps: [
          { step: 'set', field: 'site', value: { value: 'b.example' } },
          { step: 'copy', value: { formula: 'site' } },
          { step: 'openLink', url: { formula: '"https://" + site' } },
          { step: 'download', value: { formula: 'site' }, filename: 'site.txt' },
          { step: 'queue', toHere: true },
        ],
      },
    ])
    const session = sessionOf(documentOf({ n1: { type: 'test.outside' } }))
    const host = hostOf()
    expect((await runPress(session, at('go'), host)).kind).toBe('done')
    expect(host.log).toEqual(['copy b.example', 'open https://b.example shown first', 'download site.txt b.example', 'queue n1'])

    const denied = sessionOf(documentOf({ n1: { type: 'test.outside' } }))
    const outcome = await runPress(denied, at('go'), hostOf({ copy: async () => { throw new Error('the browser refused the clipboard') } }))
    expect(outcome).toMatchObject({ kind: 'done', warning: true, message: 'The changes were made. Copying failed: the browser refused the clipboard' })
    expect(valuesOf(denied)['site']).toBe('b.example')
  })

  it('delivers a called file to the user and copies from the menu', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.call_probe' } }))
    const host = hostOf({ call: async (request) => ({ kind: 'file', bytes: new TextEncoder().encode(`${request.download}\n`), notes: [] }) })
    expect((await runPress(session, at('download'), host)).kind).toBe('done')
    expect(host.log).toEqual(['download probe.txt 10 bytes'])
    // Closing Desktop's Save As is reported, not a failure, and keeps the changes made.
    const closed = await runPress(sessionOf(documentOf({ n1: { type: 'dev.buttons.call_probe' } })), at('download'), { ...host, download: async () => 'closed' })
    expect(closed).toMatchObject({ kind: 'done', message: 'The Save As dialog was closed, so probe.txt was not saved.' })
    expect(closed).not.toHaveProperty('warning')
    const menu = sessionOf(documentOf({ n1: { type: 'dev.buttons.field_steps', values: { width: 640 } } }))
    const copied = hostOf()
    await runPress(menu, at('menu_copy', 'n1', true), copied)
    expect(copied.log).toEqual(['copy 640x768'])
  })
})

describe('steps inside a subgraph occurrence', () => {
  it('sets a promoted Unpack count without changing another occurrence or its definition', async () => {
    const root = documentOf({
      left: { type: '#g1', values: { count: 3 } },
      right: { type: '#g1', values: { count: 1 } },
    })
    const inner = documentOf({ inner: { type: 'dinkster.utilities.unpack', values: { count: 4 } } }).graphs.g0!
    const doc: WorkflowDocument = { ...root, graphs: { ...root.graphs, g1: {
      ...inner, id: asGraphDefId('g1'), boundary: { body: [{
        kind: 'input', id: asPortId('count'), promoted: true,
        binds: { kind: 'port', node: asNodeId('inner'), port: asPortId('count') },
      }] },
    } } }
    const host = hostOf({
      schemaResolverFor: (current) => documentResolver(current, resolve),
      ask: async () => ({ new_count: 2 }),
    })
    const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    expect(await runPress(session, { graphId: 'g1', nodeId: 'inner', instancePath: ['left'], button: 'set_count' }, host))
      .toMatchObject({ kind: 'done' })
    expect(valuesOf(session, 'left')).toEqual({ count: 2 })
    expect(valuesOf(session, 'right')).toEqual({ count: 1 })
    expect(session.doc.graphs.g1).toEqual(doc.graphs.g1)
    const result = compile({ document: session.doc, revision: 1, resolve,
      scope: { kind: 'partial', targets: ['left', 'right'].map((id) => ({ instancePath: [asNodeId(id)], node: asNodeId('inner') })) },
      connection: asConnectionId('test'), schemaHash: 'test', graphFeatures: ['regions'] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    expect(result.artifact.dinksterGraph?.nodes['left.inner']).toMatchObject({ outputMembers: { items: ['0', '1'] } })
    expect(result.artifact.dinksterGraph?.nodes['right.inner']).toMatchObject({ outputMembers: { items: ['0'] } })
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(doc)
    expect(session.canUndo).toBe(false)
  })

  it('reports only shared values left changed at commit, after restored writes and skipped targets', async () => {
    addSchema('test.shared_source', [{ kind: 'output', id: 'value', type: { kind: 'concrete', types: ['INT'] } }])
    addSchema('test.shared_restored', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 3 },
      { kind: 'input', id: 'other', type: { kind: 'concrete', types: ['INT'] }, default: 11 },
      { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['dev.image'] } },
    ])
    const host = hostOf({ schemaResolverFor: (current) => documentResolver(current, resolve) })
    for (const changed of [false, true]) for (const add of [false, true]) for (const wired of [false, true]) {
      const root = documentOf({ left: { type: '#g1' }, right: { type: '#g1' } })
      const inner = documentOf({ inner: { type: 'test.shared_restored', values: { value: 3, other: 11 } }, source: { type: 'test.shared_source' } },
        wired ? link('feed', ['source', 'value'], ['inner', 'other']) : {}).graphs['g0']!
      const doc: WorkflowDocument = { ...root, graphs: { ...root.graphs, g1: { ...inner, id: asGraphDefId('g1'), name: 'shared' } } }
      const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
      const outcome = await runSteps(session, [{ graphId: 'g1', nodeId: 'inner', instancePath: ['left'], prefix: '', steps: decodeSteps([
        { step: 'set', field: 'value', value: { value: 4 } },
        { step: 'set', field: 'value', value: { value: 3 } },
        ...(changed ? [{ step: 'set', field: 'other', value: { value: 17 } }] : []),
        ...(add ? [{ step: 'addNode', nodeType: 'dev.image.gradient', to: 'image', values: {} }] : []),
      ]) }], host)
      expect(outcome, outcome.message).toMatchObject({ kind: 'done', notes: [
        ...(add ? ['Also added in the other use of "shared".'] : []),
        ...(changed && !wired ? ['Also changed in the other use of "shared".'] : []),
      ] })
      expect(session.doc.graphs.g1!.nodes.inner!.values).toEqual({ value: 3, other: changed && !wired ? 17 : 11 })
      const after = session.doc
      expect(session.undo()).toBe(true)
      expect(session.doc.graphs.g1!.nodes).toEqual(inner.nodes)
      expect(session.doc.graphs.g1!.links).toEqual(inner.links)
      expect(session.doc.graphs.g0).toEqual(root.graphs.g0)
      expect(session.canUndo).toBe(false)
      expect(session.redo()).toBe(true)
      expect(session.doc).toEqual(after)
    }
  })

  it('reports shared field changes while keeping promoted writes instance-local in one undo step', async () => {
    addSchema('test.shared_value', [
      { kind: 'input', id: 'owned', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
      { kind: 'input', id: 'shared', type: { kind: 'concrete', types: ['INT'] }, default: 3 },
      { kind: 'button', id: 'increase', label: 'Increase', steps: [
        { step: 'set', field: 'owned', value: { formula: 'owned + 1' } },
        { step: 'set', field: 'shared', value: { formula: 'shared + 1' } },
      ] },
    ])
    const host = hostOf({ schemaResolverFor: (current) => documentResolver(current, resolve) })
    for (const uses of [1, 2, 3]) for (const promoted of [false, true]) {
      const root = documentOf({ left: { type: '#g1', values: { shown: 41, ...(promoted ? { ownShared: 3 } : {}) } },
        ...(uses > 1 ? { right: { type: '#g1', values: { shown: 73 } } } : {}),
        ...(uses > 2 ? { third: { type: '#g1', values: { shown: 97 } } } : {}),
      })
      const inner = documentOf({ inner: { type: 'test.shared_value', values: { shared: 3 } } }).graphs['g0']!
      const doc: WorkflowDocument = { ...root, graphs: { ...root.graphs, g1: { ...inner, id: asGraphDefId('g1'), name: 'shared', boundary: {
        body: [{ kind: 'input', id: asPortId('shown'), binds: { kind: 'port', node: asNodeId('inner'), port: asPortId('owned') }, promoted: true },
          ...(promoted ? [{ kind: 'input' as const, id: asPortId('ownShared'), binds: { kind: 'port' as const, node: asNodeId('inner'), port: asPortId('shared') }, promoted: true }] : [])],
      } } } }
      const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
      const outcome = await runPress(session, { graphId: 'g1', nodeId: 'inner', instancePath: ['left'], button: 'increase' }, host)
      expect(outcome).toMatchObject({ kind: 'done', notes: !promoted && uses > 1
        ? [`Also changed in the other ${uses === 2 ? 'use' : '2 uses'} of "shared".`] : [] })
      expect(valuesOf(session, 'left')).toEqual({ shown: 42, ...(promoted ? { ownShared: 4 } : {}) })
      expect(session.doc.graphs['g1']!.nodes['inner']!.values).toEqual({ shared: promoted ? 3 : 4 })
      for (const id of ['right', 'third']) if (root.graphs['g0']!.nodes[id]) {
        expect(session.doc.graphs['g0']!.nodes[id]).toEqual(root.graphs['g0']!.nodes[id])
      }
      const after = session.doc
      expect(session.undo()).toBe(true)
      expect(session.doc).toEqual(doc)
      expect(session.canUndo).toBe(false)
      expect(session.redo()).toBe(true)
      expect(session.doc).toEqual(after)
    }
  })

  it('materializes and edits whole promoted groups outside, keeping definition members and sibling instances', async () => {
    addSchema('test.owned_group', [
      { kind: 'group', id: 'items', grows: 'button', minMembers: 1, maxMembers: 5,
        keys: { numbered: { prefix: 'item_', start: 1, pad: 0 } }, member: [
          { kind: 'input', id: 'label', type: { kind: 'concrete', types: ['STRING'] }, default: 'old' },
        ] },
      { kind: 'button', id: 'fill', label: 'Fill', steps: [{ step: 'setEach', group: 'items', field: 'label', value: { value: 'changed' } }] },
      { kind: 'button', id: 'add', label: 'Add', steps: [{ step: 'addMember', group: 'items', values: { label: { value: 'new' } } }] },
      { kind: 'button', id: 'remove', label: 'Remove', steps: [{ step: 'removeMember', group: 'items', which: 'last' }] },
    ])
    const root = documentOf({ left: { type: '#g1' }, right: { type: '#g1' } })
    const inner = documentOf({ inner: { type: 'test.owned_group' } }).graphs['g0']!
    const doc: WorkflowDocument = { ...root, graphs: { ...root.graphs, g1: { ...inner, id: asGraphDefId('g1'), boundary: {
      body: [{ kind: 'input', id: asPortId('shown'), binds: { kind: 'construct', node: asNodeId('inner'), port: asPortId('items') }, promoted: true }],
    } } } }
    const host = hostOf({ schemaResolverFor: (current) => documentResolver(current, resolve) })
    const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    const target = { graphId: 'g1', nodeId: 'inner', instancePath: ['left'] }
    expect(await runPress(session, { ...target, button: 'fill' }, host)).toMatchObject({ kind: 'done' })
    expect(session.doc.graphs['g1']).toEqual(doc.graphs['g1'])
    expect(valuesOf(session, 'left')).toEqual({ 'shown.item_1.label': 'changed' })
    expect(valuesOf(session, 'right')).toEqual({})
    expect(session.doc.graphs['g0']!.nodes['left']!.dynamic?.['shown']).toEqual({ members: ['item_1'], seq: 1 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session, 'left')).toEqual({})
    expect(session.doc.graphs['g0']!.nodes['left']!.dynamic?.['shown']?.members ?? []).toEqual([])
    expect(session.doc.graphs['g1']).toEqual(doc.graphs['g1'])
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(await runPress(session, { ...target, button: 'add' }, host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session, 'left')).toEqual({ 'shown.item_1.label': 'changed', 'shown.item_2.label': 'new' })
    expect(await runPress(session, { ...target, button: 'remove' }, host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session, 'left')).toEqual({ 'shown.item_1.label': 'changed' })
    expect(session.doc.graphs['g1']).toEqual(doc.graphs['g1'])
    expect(valuesOf(session, 'right')).toEqual({})

    const withDefinitionMember: WorkflowDocument = { ...doc, graphs: { ...doc.graphs,
      g1: { ...doc.graphs['g1']!, nodes: { inner: { ...inner.nodes['inner']!,
        dynamic: { items: { members: ['item_1'], seq: 1 } }, values: { 'items.item_1.label': 'definition' },
      } } },
    } }
    const offset = createLocalSession(withDefinitionMember, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    expect(await runPress(offset, { ...target, button: 'add' }, host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(offset, 'left')).toEqual({ 'shown.item_1.label': 'new' })
    expect(valuesOf(offset, 'right')).toEqual({})
    expect(offset.doc.graphs['g1']).toEqual(withDefinitionMember.graphs['g1'])
  })

  it('materializes nested minimum members through an outer construct before writing', async () => {
    addSchema('test.nested_owned_group', [
      { kind: 'group', id: 'items', grows: 'button', minMembers: 1, maxMembers: 5,
        keys: { numbered: { prefix: 'item_', start: 1, pad: 0 } }, member: [
          { kind: 'group', id: 'children', grows: 'button', minMembers: 1, maxMembers: 5,
            keys: { numbered: { prefix: 'child_', start: 1, pad: 0 } }, member: [
              { kind: 'input', id: 'label', type: { kind: 'concrete', types: ['STRING'] }, default: 'old' },
            ] },
        ] },
    ])
    const root = documentOf({ left: { type: '#g1' }, right: { type: '#g1' } })
    const inner = documentOf({ inner: { type: 'test.nested_owned_group' } }).graphs['g0']!
    const doc: WorkflowDocument = { ...root, graphs: { ...root.graphs, g1: { ...inner, id: asGraphDefId('g1'), boundary: {
      body: [{ kind: 'input', id: asPortId('shown'), binds: { kind: 'construct', node: asNodeId('inner'), port: asPortId('items') }, promoted: true }],
    } } } }
    const host = hostOf({ schemaResolverFor: (current) => documentResolver(current, resolve) })
    const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    expect(await runSteps(session, [{ graphId: 'g1', nodeId: 'inner', instancePath: ['left'],
      prefix: 'items.item_1.children.child_1.', steps: decodeSteps([{ step: 'set', field: 'label', value: { value: 'changed' } }]),
    }], host)).toMatchObject({ kind: 'done' })
    expect(valuesOf(session, 'left')).toEqual({ 'shown.item_1.children.child_1.label': 'changed' })
    expect(valuesOf(session, 'right')).toEqual({})
    expect(session.doc.graphs['g1']).toEqual(doc.graphs['g1'])
    expect(session.undo()).toBe(true)
    expect(valuesOf(session, 'left')).toEqual({})
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session, 'left')).toEqual({ 'shown.item_1.children.child_1.label': 'changed' })
  })

  it.each([false, true])('disconnects only the original projected delivery, replacement during wait: %s', async (replace) => {
    addSchema('test.owned_disconnect', [
      { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 },
      { kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } },
      { kind: 'button', id: 'set', label: 'Set', steps: [
        { step: 'disconnect', input: 'value' },
        ...(replace ? [{ step: 'call', function: 'test.wait', args: [], writes: ['value'] }] : []),
        { step: 'set', field: 'value', value: { value: 99 } },
      ] },
    ])
    const root = documentOf({ left: { type: '#g1', values: { shown: 41 } }, right: { type: '#g1', values: { shown: 73 } }, source: { type: 'test.owned_disconnect' } }, {
      ...link('left-wire', ['source', 'out'], ['left', 'shown']), ...link('right-wire', ['source', 'out'], ['right', 'shown']),
    })
    const inner = documentOf({ inner: { type: 'test.owned_disconnect', values: { value: 3 } } }).graphs['g0']!
    const doc: WorkflowDocument = { ...root, graphs: { ...root.graphs, g1: { ...inner, id: asGraphDefId('g1'), boundary: {
      body: [{ kind: 'input', id: asPortId('shown'), binds: { kind: 'port', node: asNodeId('inner'), port: asPortId('value') }, promoted: true }],
    } } } }
    const answer = later<CallAnswer>()
    const host = hostOf({ schemaResolverFor: (current) => documentResolver(current, resolve), call: () => answer.promise })
    const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    const pending = runPress(session, { graphId: 'g1', nodeId: 'inner', instancePath: ['left'], button: 'set' }, host)
    if (replace) {
      expect(session.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: 'left-wire' } }).ok).toBe(true)
      expect(session.dispatch({ command: 'link.connect', params: { graphId: 'g0', from: { node: 'source', port: 'out' }, to: { node: 'left', port: 'shown' } } }).ok).toBe(true)
      const live = session.doc
      answer.settle({ kind: 'answer', fields: {}, notes: [] })
      const result = await pending
      expect(result.kind, JSON.stringify(result)).toBe('done')
      expect(result.skipped).toEqual([{ id: 'value', why: 'wired' }])
      expect(session.doc).toEqual(live)
      return
    }
    expect(await pending).toMatchObject({ kind: 'done', skipped: [] })
    expect(valuesOf(session, 'left')).toEqual({ shown: 99 })
    expect(valuesOf(session, 'right')).toEqual({ shown: 73 })
    expect(session.doc.graphs['g1']).toEqual(doc.graphs['g1'])
    expect(session.doc.graphs['g0']!.links['right-wire']).toEqual(doc.graphs['g0']!.links['right-wire'])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(doc)
    expect(session.canUndo).toBe(false)
    expect(session.redo()).toBe(true)
    expect(valuesOf(session, 'left')).toEqual({ shown: 99 })
  })
})

describe('steps that are not a button\'s', () => {
  const whole = { kind: 'concrete', types: ['INT'] }
  addSchema('test.fix', [
    { kind: 'input', id: 'a', type: whole, required: true, default: 0 },
    { kind: 'input', id: 'b', type: whole, required: true, default: 0 },
  ])
  const part = (nodeId: string, steps: readonly unknown[]): StepPart => ({ graphId: 'g0', nodeId, prefix: '', steps: decodeSteps(steps as never) })
  const set = (field: string, value: unknown) => ({ step: 'set', field, value })
  const twoNodes = () => sessionOf(documentOf({ n1: { type: 'test.fix', values: { a: 1, b: 0 } }, n2: { type: 'test.fix', values: { a: 1, b: 0 } } }))
  const edit = (session: DocumentSession, inputId: string, value: number) =>
    session.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId, value } })

  it('runs every part as one undo step, a later part reading what an earlier one set', async () => {
    const session = twoNodes()
    const outcome = await runSteps(session, [
      part('n1', [set('a', { value: 5 })]),
      part('n1', [set('b', { formula: 'a + 1' })]),
      part('n2', [set('a', { value: 7 })]),
    ], hostOf())
    expect(outcome).toEqual({ kind: 'done', skipped: [], notes: [] })
    expect(valuesOf(session)).toMatchObject({ a: 5, b: 6 })
    expect(valuesOf(session, 'n2')).toMatchObject({ a: 7 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toMatchObject({ a: 1, b: 0 })
    expect(valuesOf(session, 'n2')).toMatchObject({ a: 1 })
    expect(session.canUndo).toBe(false)
  })

  it('stores nothing when one part fails or two set one field to different values', async () => {
    const failing = twoNodes()
    const outcome = await runSteps(failing, [part('n1', [set('a', { value: 5 })]), part('n2', [set('a', { value: 'five' })])], hostOf())
    expect(outcome.kind).toBe('failed')
    expect(valuesOf(failing)).toMatchObject({ a: 1 })
    expect(failing.canUndo).toBe(false)

    const clashing = twoNodes()
    const clash = await runSteps(clashing, [part('n1', [set('a', { value: 5 })]), part('n1', [set('a', { value: 6 })])], hostOf(), { conflictMessage: 'These fixes disagree.' })
    expect(clash).toMatchObject({ kind: 'failed', message: 'These fixes disagree.' })
    expect(clashing.canUndo).toBe(false)
    // One part may set a field twice, and two parts may agree.
    const agreeing = twoNodes()
    const agree = await runSteps(agreeing, [part('n1', [set('a', { value: 4 }), set('a', { value: 5 })]), part('n1', [set('a', { value: 5 })])], hostOf())
    expect(agree.kind).toBe('done')
    expect(valuesOf(agreeing)).toMatchObject({ a: 5 })
    expect(CONFLICT_MESSAGE).toBe('Two of these set the same field to different values.')
  })

  it('refuses, before anything runs, steps that ask the user or wait when told to', async () => {
    const session = twoNodes()
    const host = hostOf({ pick: async () => (host.log.push('pick'), 'p'), lookup: async () => (host.log.push('lookup'), { state: 'ready', value: 3n }) })
    const pick = [set('a', { value: 5 }), { step: 'pick', name: 'chosen', options: { value: ['p'] } }]
    expect(await runSteps(session, [part('n1', pick)], host, { insideOnly: true })).toMatchObject({ kind: 'failed', message: `Nothing was changed. ${INSIDE_ONLY_MESSAGE}` })
    expect(await runSteps(session, [part('n1', [{ step: 'copy', value: { value: 'x' } }])], host, { insideOnly: true })).toMatchObject({ kind: 'failed' })
    const looked = [set('a', { value: 5 }), set('b', { lookup: 'pack.count', args: [] })]
    expect(await runSteps(session, [part('n1', looked)], host, { noWait: true })).toMatchObject({ kind: 'failed', message: `Nothing was changed. ${NO_WAIT_MESSAGE}` })
    expect(host.log).toEqual([])
    expect(valuesOf(session)).toMatchObject({ a: 1, b: 0 })
    expect(session.canUndo).toBe(false)
  })

  it('stores nothing when what the fix was worked out from changed, or, when strict, a field it sets did', async () => {
    const stale = 'Could not apply this fix. The workflow changed.'
    const waiting = () => {
      const answer = later<LookupResult>()
      return { answer, host: hostOf({ lookup: () => answer.promise }) }
    }
    const fix = [part('n1', [set('a', { lookup: 'pack.count', args: [] })])]

    const started = twoNodes()
    edit(started, 'b', 9)
    expect(await runSteps(started, fix, hostOf(), { unchanged: (doc) => doc.graphs['g0']!.nodes['n1']!.values['b'] === 0, staleMessage: stale }))
      .toMatchObject({ kind: 'failed', message: stale })

    const meanwhile = twoNodes()
    const first = waiting()
    const running = runSteps(meanwhile, fix, first.host, { unchanged: (doc) => doc.graphs['g0']!.nodes['n1']!.values['b'] === 0, staleMessage: stale })
    await Promise.resolve()
    edit(meanwhile, 'b', 9)
    first.answer.settle({ state: 'ready', value: 3n })
    expect(await running).toMatchObject({ kind: 'failed', message: stale })
    expect(valuesOf(meanwhile)).toMatchObject({ a: 1, b: 9 })

    // Without strict the user's value is kept and reported; with strict the run fails.
    const strict = twoNodes()
    const second = waiting()
    const strictRun = runSteps(strict, fix, second.host, { strict: true, staleMessage: stale })
    await Promise.resolve()
    edit(strict, 'a', 2)
    second.answer.settle({ state: 'ready', value: 3n })
    expect(await strictRun).toMatchObject({ kind: 'failed', message: stale })
    expect(valuesOf(strict)).toMatchObject({ a: 2 })
  })

  it('stores the user\'s own edit and the fix it led to as one undo step', async () => {
    const session = twoNodes()
    const lead = [{ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'a', value: 3 } }]
    const outcome = await runSteps(session, [part('n1', [set('b', { formula: 'a * 2' })])], hostOf(), { lead, noWait: true })
    expect(outcome.kind).toBe('done')
    expect(valuesOf(session)).toMatchObject({ a: 3, b: 6 })
    expect(session.undo()).toBe(true)
    expect(valuesOf(session)).toMatchObject({ a: 1, b: 0 })
    expect(session.canUndo).toBe(false)
  })
})
