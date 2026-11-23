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
import { buttonAvailability, runPress, type ActionHost, type CallAnswer, type PressTarget } from '../src/actions/runner.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { createLocalSession, type DocumentSession } from '../src/commands/session.js'
import type { GraphDef, Json, NodeData, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId } from '../src/ids.js'
import { parseDinksterSchema, type DinksterWireSchema } from '../src/schema/dinkster-wire.js'
import type { NodeSchema } from '../src/schema/model.js'

const wire = JSON.parse(readFileSync(new URL('./fixtures/button_schemas.json', import.meta.url), 'utf8')) as Record<string, unknown>
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
    download: async (name, content) => void log.push(`download ${name} ${typeof content === 'string' ? content : `${content.length} bytes`}`),
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

  it('Randomize keeps to its bounds and the field step, and Toggle, Reset and SetMode write what they name', async () => {
    const draws = [0, 0.999999, 0.5]
    const picked: Json[] = []
    for (const draw of draws) picked.push((await press('dev.buttons.field_steps', 'random', { seed: 7 }, hostOf({ random: () => draw }))).values['seed']!)
    expect(picked).toEqual([10, 20, 15])
    expect((await press('dev.buttons.field_steps', 'toggle', { flag: false })).values['flag']).toBe(true)
    expect((await press('dev.buttons.field_steps', 'reset', { width: 1024, title: 'final' })).values).toMatchObject({ width: 512, title: 'draft' })
    expect((await press('dev.buttons.field_steps', 'increment', {})).node.controllers).toEqual({ seed: 'increment' })
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
    expect(outcome.message).toBe('Nothing was changed. loras already has its fewest members.')
  })

  it('ClearMembers stops at the least count and keeps a wired member', async () => {
    const start = members(['lora_1', 'lora_2', 'lora_3'], [1, 1, 1])
    const doc = documentOf({ n1: { type: 'dev.buttons.member_steps', values: start.values, ...start.extra }, src: { type: 'dev.image.gradient' } },
      link('l1', ['src', 'image'], ['n1', 'loras.lora_2.clip']))
    const session = sessionOf(doc)
    const outcome = await runPress(session, at('clear'), hostOf())
    expect(session.doc.graphs['g0']!.nodes['n1']!.dynamic!['loras']!.members).toEqual(['lora_2'])
    expect(outcome.skipped).toEqual([{ id: 'loras.lora_2', why: 'wired' }])
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
  it('Pick passes its choice to later steps, which store a looked-up value', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.lora_preset' } }))
    const asked: unknown[] = []
    const host = hostOf({
      lookup: async (request) => {
        asked.push([request.function.split('.').at(-1), request.args, request.use, request.asker])
        return request.use === 'options'
          ? { state: 'ready', value: ['SD-NONE', 'SD-INS'] }
          : { state: 'ready', value: '1,1,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0' }
      },
      pick: async (request) => request.options[1]!.value,
    })
    expect((await runPress(session, at('pick_preset'), host)).kind).toBe('done')
    expect(valuesOf(session)).toMatchObject({ preset: 'SD-INS', block_vector: '1,1,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0' })
    expect(asked).toEqual([['preset_names', [], 'options', 'press'], ['preset_vector', ['SD-INS'], 'value', 'press']])
  })

  it('asks a failed value lookup once more, then fails without storing', async () => {
    const session = sessionOf(documentOf({ n1: { type: 'dev.buttons.lora_preset' } }))
    let asks = 0
    const outcome = await runPress(session, at('apply_preset'), hostOf({ lookup: async () => (asks++, { state: 'failed', reason: 'wrong-shape' }) }))
    expect(asks).toBe(2)
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
    const menu = sessionOf(documentOf({ n1: { type: 'dev.buttons.field_steps', values: { width: 640 } } }))
    const copied = hostOf()
    await runPress(menu, at('menu_copy', 'n1', true), copied)
    expect(copied.log).toEqual(['copy 640x768'])
  })
})
