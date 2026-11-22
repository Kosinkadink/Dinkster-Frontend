/**
 * Interface elaboration tests. The contract under test:
 * (schema body, stored state, link existence) -> effective ordered interface,
 * deterministic, with every row at its flattened id, members in stored order
 * with their keys as identity, the chosen option's rows only, type choice
 * rows that follow the pin, and input/output symmetry.
 * Elaboration never sees solved types - nothing here constructs any.
 */
import { describe, expect, it } from 'vitest'
import type { GraphDef } from '../src/format/document.js'
import { asNodeId } from '../src/ids.js'
import { buildGraphConnectivity, elabInputsOf, elabOutputsOf, elaborateInterface, EMPTY_CONNECTIVITY, type Connectivity } from '../src/schema/elaborate.js'
import { checkBody, initialDynamicStateOf } from '../src/schema/body.js'
import type { BodyRow, ChoiceSpec, GroupSpec, InputSpec, NodeSchema, OutputSpec, TypeChoiceSpec } from '../src/schema/model.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const schemaOf = (body: BodyRow[]): NodeSchema => ({
  type: 'Test',
  displayName: 'Test',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body,
})

const intInput = (id: string, extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'INT' },
  optional: false,
  widget: { widgetType: 'INT', options: {}, default: 0 },
  ...extra,
})

const socketInput = (id: string, type = 'IMAGE', extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: type },
  optional: false,
  ...extra,
})

const output = (id: string, type = 'IMAGE', extra: Partial<OutputSpec> = {}): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: type },
  ...extra,
})

/** A group of IMAGE pins named image0, image1, ... (or by the given names). */
const imageGroup = (id: string, opts: { min?: number; max?: number; names?: string[] } = {}): GroupSpec => ({
  kind: 'group',
  id,
  value: socketInput('item', 'IMAGE'),
  keys: opts.names ? { kind: 'named', names: opts.names } : { kind: 'numbered', prefix: 'image', start: 0, pad: 0 },
  grows: 'link',
  minMembers: opts.min ?? 1,
  ...(opts.max !== undefined ? { maxMembers: opts.max } : opts.names ? {} : { maxMembers: 4 }),
})

/** A group of records: each member holds an image and an optional mask. */
const recordGroup = (id: string, opts: { min?: number; max?: number } = {}): GroupSpec => ({
  kind: 'group',
  id,
  member: [socketInput('image', 'IMAGE'), socketInput('mask', 'MASK', { optional: true })],
  keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
  grows: 'link',
  minMembers: opts.min ?? 1,
  maxMembers: opts.max ?? 3,
})

const choiceOf = (id: string, options: ChoiceSpec['options'], extra: Partial<ChoiceSpec> = {}): ChoiceSpec => ({
  kind: 'choice',
  id,
  options,
  shared: [],
  required: true,
  ...extra,
})

const openSlot = (id: string, rows: BodyRow[], type = 'MODEL'): TypeChoiceSpec => ({
  kind: 'typeChoice',
  id,
  type: { kind: 'concrete', name: type },
  rows,
  required: false,
})

const connectedInputs = (...ports: string[]): Connectivity => ({
  isInputConnected: (port) => ports.includes(port),
  isOutputConnected: () => false,
})

const ghostOf = (input: { origin: { kind: string; ghost?: boolean } }): boolean =>
  input.origin.kind === 'member' && input.origin.ghost === true

const noState = { values: {} }

// ---------------------------------------------------------------------------
// Static pass-through
// ---------------------------------------------------------------------------

describe('static schemas', () => {
  it('keeps authored choices separate from values and scopes explicit extra input types', () => {
    const schema: NodeSchema = {
      ...schemaOf([{ ...socketInput('choice', 'COMBO'), widget: { widgetType: 'COMBO', options: { options: ['seed'] }, editableOptions: true } }]),
      additionalInputs: { kind: 'variable', templateId: 'T' },
    }
    const names = ['index', 'sparse.009', ...Array.from({ length: 150 }, (_, index) => `extra_${index * 3}`)]
    const values = { choice: 'outside', unlisted: 42 }
    const result = elaborateInterface(schema, {
      values, additionalInputs: names, dynamic: { choice: { options: ['same', 'same', false, 7] } },
    })
    expect(result.diagnostics).toEqual([])
    const inputs = elabInputsOf(result)
    expect(inputs.map((input) => input.apiName)).toEqual(['choice', ...names])
    expect(inputs[0]!.spec.widget!.options['options']).toEqual(['same', 'same', false, 7])
    expect(inputs[1]!.spec).toMatchObject({ optional: true, type: { kind: 'variable', templateId: 'index:T' } })
    expect(inputs[2]!.spec.type).toEqual({ kind: 'variable', templateId: 'sparse.009:T' })
    expect(values.choice).toBe('outside')
    expect(elabInputsOf(elaborateInterface(schema, { values, dynamic: { choice: { options: [] } } }))[0]!.spec.widget!.options['options']).toEqual([])
    const closed = elaborateInterface(schemaOf([socketInput('choice', 'COMBO')]), { values, additionalInputs: ['index'] })
    expect(closed.diagnostics.map((diag) => diag.code)).toContain('elab.additionalInput.closed')
    expect(elabInputsOf(closed).map((input) => input.apiName)).toEqual(['choice'])
    const collision = elaborateInterface({ ...schema, body: [...schema.body, imageGroup('items')] }, {
      values, additionalInputs: ['choice', 'items.inactive', 'items'],
    })
    expect(collision.diagnostics.filter((diag) => diag.code === 'elab.additionalInput.reserved')).toHaveLength(3)
  })

  it('elaborates a static schema unchanged, in declared order', () => {
    const schema = schemaOf([
      output('out0'),
      socketInput('image'),
      { kind: 'section', id: 'adv', displayName: 'Advanced', rows: [intInput('strength')] },
    ])
    const e = elaborateInterface(schema, noState)
    expect(e.diagnostics).toEqual([])
    expect(e.items.map((i) => (i.kind === 'section' ? `section:${i.spec.id}` : i.kind === 'growth' || i.kind === 'editor' ? i.kind : `${i.kind}:${i.address.port}`))).toEqual([
      'output:out0',
      'input:image',
      'section:adv',
      'input:strength',
    ])
    const strength = elabInputsOf(e).find((i) => i.address.port === 'strength')!
    expect(strength.origin).toEqual({ kind: 'static' })
    expect(strength.apiName).toBe('strength')
    expect(strength.spec.section).toBe('adv')
  })

  it('censuses every option of a choice, including a shared row two options use, without changing the active interface', () => {
    const schema = schemaOf([choiceOf('mode', [
      { key: 'a', rows: [{ kind: 'use', id: 'file' }] },
      { key: 'b', rows: [{ kind: 'use', id: 'file' }, socketInput('other', 'AUDIO')] },
    ], { shared: [socketInput('file', 'IMAGE')] })])
    expect(() => checkBody(schema.body)).not.toThrow()
    const node = { values: {}, dynamic: { mode: { selected: 'a' } } }
    const active = elaborateInterface(schema, node)
    expect(active.diagnostics).toEqual([])
    expect(elabInputsOf(active).map((input) => input.spec.id)).toEqual(['mode', 'mode.file'])
    const stored = elaborateInterface(schema, node, EMPTY_CONNECTIVITY, { includeDormant: true })
    expect(stored.diagnostics).toEqual([])
    expect(elabInputsOf(stored).map((input) => input.spec.id)).toEqual(expect.arrayContaining(['mode.file', 'mode.other']))
    expect(elabInputsOf(stored).find((input) => input.spec.id === 'mode.other')!.apiName).toBeUndefined()
    expect(elaborateInterface(schema, node)).toEqual(active)
  })
})

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

describe('groups', () => {
  it.each([false, true])('a new node stores the first minimum keys; members past the minimum of an optional-after-minimum group are optional (named=%s)', (named) => {
    const parsed = parseDinksterSchema('Positional', {
      schemaVersion: 2,
      nodeType: 'Positional',
      body: [{
        kind: 'group', id: 'items', minMembers: 2, optionalAfterMinimum: true, grows: 'link',
        ...(named ? { keys: { named: ['z', 'a', 'b', 'c'] } } : { keys: { numbered: { prefix: 'item', start: 0 } }, maxMembers: 12 }),
        value: { kind: 'input', id: 'entry', type: { kind: 'concrete', types: ['IMAGE'] }, required: true },
      }],
    })
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.schema).toBeDefined()
    const first = named ? ['z', 'a'] : ['item0', 'item1']
    expect(initialDynamicStateOf(parsed.schema!).items?.members).toEqual(first)
    const tails = named ? ['c', 'b'] : ['item10', 'item2']
    const e = elaborateInterface(parsed.schema!, { values: {}, dynamic: { items: { members: [...first, ...tails] } } })
    expect(e.diagnostics).toEqual([])
    const stored = elabInputsOf(e).filter((input) => !ghostOf(input))
    expect(stored.map((input) => [input.address.port, input.apiName, input.spec.optional])).toEqual(
      [...first, ...tails].map((key, index) => [`items.${key}`, `items.${key}`, index >= 2]),
    )
  })

  it('a node with no stored members offers members up to the minimum, which never compile', () => {
    const schema = schemaOf([imageGroup('images', { min: 2, max: 4 })])
    const fresh = elabInputsOf(elaborateInterface(schema, noState))
    expect(fresh.map((i) => i.address.port)).toEqual(['images.image0', 'images.image1'])
    expect(fresh.map((i) => i.origin)).toEqual([
      { kind: 'member', construct: 'images', ordinal: 0, key: 'image0', ghost: true },
      { kind: 'member', construct: 'images', ordinal: 1, key: 'image1', ghost: true },
    ])
    expect(fresh.map((i) => [i.spec.optional, i.apiName])).toEqual([[true, undefined], [true, undefined]])

    const dynamic = initialDynamicStateOf(schema)
    expect(dynamic).toEqual({ images: { members: ['image0', 'image1'], seq: 2 } })
    const stored = elabInputsOf(elaborateInterface(schema, { values: {}, dynamic }))
    expect(stored.map((i) => [i.address.port, i.spec.optional, i.apiName])).toEqual([
      ['images.image0', false, 'images.image0'],
      ['images.image1', false, 'images.image1'],
    ])
    // A spare member appears once every member is in use.
    const used = elabInputsOf(elaborateInterface(schema, { values: {}, dynamic }, connectedInputs('images.image0', 'images.image1')))
    expect(used.map((i) => [i.address.port, ghostOf(i), i.apiName])).toEqual([
      ['images.image0', false, 'images.image0'],
      ['images.image1', false, 'images.image1'],
      ['images.image2', true, undefined],
    ])
  })

  it('stored members keep their keys and stored order; a spare continues past the highest key', () => {
    const node = { values: {}, dynamic: { images: { members: ['image5', 'image2'] } } }
    const e = elaborateInterface(schemaOf([imageGroup('images', { min: 1, max: 4 })]), node, connectedInputs('images.image5', 'images.image2'))
    expect(elabInputsOf(e).map((i) => [i.address.port, i.apiName, i.origin.kind === 'member' ? i.origin.ordinal : undefined])).toEqual([
      ['images.image5', 'images.image5', 0],
      ['images.image2', 'images.image2', 1],
      ['images.image6', undefined, 2],
    ])
  })

  it('stops growing at the cap and refuses a group stored above it', () => {
    const capped = elaborateInterface(
      schemaOf([imageGroup('images', { min: 1, max: 2 })]),
      { values: {}, dynamic: { images: { members: ['image0', 'image1'] } } },
      connectedInputs('images.image0', 'images.image1'),
    )
    expect(elabInputsOf(capped)).toHaveLength(2) // no spare at the cap
    expect(capped.diagnostics).toEqual([])

    const over = elaborateInterface(
      schemaOf([imageGroup('images', { min: 1, max: 2 })]),
      { values: {}, dynamic: { images: { members: ['image0', 'image1', 'image2'] } } },
    )
    expect(over.diagnostics.some((d) => d.code === 'elab.autogrow.overMax')).toBe(true)
    expect(elabInputsOf(over)).toEqual([])
  })

  it('named keys are the flattened ids and labels; the spare takes the first unused name', () => {
    const e = elaborateInterface(
      schemaOf([imageGroup('ops', { names: ['first', 'second'], min: 1 })]),
      { values: {}, dynamic: { ops: { members: ['first'] } } },
      connectedInputs('ops.first'),
    )
    expect(elabInputsOf(e).map((i) => [i.spec.displayName, i.apiName])).toEqual([
      ['first', 'ops.first'],
      ['second', undefined], // spare
    ])
  })

  it('members take the section that holds their group', () => {
    const e = elaborateInterface(schemaOf([{ kind: 'section', id: 's', rows: [imageGroup('images', { min: 1 })] }]), noState)
    expect(elabInputsOf(e).length).toBeGreaterThan(0)
    for (const input of elabInputsOf(e)) expect(input.spec.section).toBe('s')
  })
})

// ---------------------------------------------------------------------------
// Groups of records (one member = several rows)
// ---------------------------------------------------------------------------

describe('groups of records', () => {
  it('stamps every member row per member, in declared order, sharing member key and ordinal', () => {
    const node = { values: {}, dynamic: { items: { members: ['item0'] } } }
    const e = elaborateInterface(schemaOf([recordGroup('items', { min: 1, max: 3 })]), node, connectedInputs('items.item0.image'))
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => i.address.port)).toEqual([
      'items.item0.image',
      'items.item0.mask',
      'items.item1.image',
      'items.item1.mask',
    ])
    expect(inputs.map((i) => i.origin)).toEqual([
      { kind: 'member', construct: 'items', ordinal: 0, key: 'item0' },
      { kind: 'member', construct: 'items', ordinal: 0, key: 'item0' },
      { kind: 'member', construct: 'items', ordinal: 1, key: 'item1', ghost: true },
      { kind: 'member', construct: 'items', ordinal: 1, key: 'item1', ghost: true },
    ])
    // A row's own optionality holds inside a stored member; a spare member's
    // rows are always optional.
    expect(inputs.map((i) => i.spec.optional)).toEqual([false, true, true, true])
    // A numbered member is labeled by its prefix and position.
    expect(inputs.map((i) => i.spec.displayName)).toEqual([
      'item 1 image',
      'item 1 mask',
      'item 2 image',
      'item 2 mask',
    ])
    expect(inputs.map((i) => i.apiName)).toEqual([
      'items.item0.image',
      'items.item0.mask',
      undefined,
      undefined,
    ])
  })

  it('a link on any row of a member counts as use and offers the spare member', () => {
    const node = { values: {}, dynamic: { items: { members: ['item0'] } } }
    const unused = elabInputsOf(elaborateInterface(schemaOf([recordGroup('items')]), node))
    expect(unused.map((i) => i.address.port)).toEqual(['items.item0.image', 'items.item0.mask'])
    // Only the OPTIONAL mask row of the stored member is wired.
    const used = elabInputsOf(elaborateInterface(schemaOf([recordGroup('items')]), node, connectedInputs('items.item0.mask')))
    expect(used.filter(ghostOf).map((i) => i.address.port)).toEqual(['items.item1.image', 'items.item1.mask'])
  })

  describe('growth items (members of only boxes)', () => {
    const growthsOf = (e: ReturnType<typeof elaborateInterface>) =>
      e.items.filter((i): i is Extract<typeof i, { kind: 'growth' }> => i.kind === 'growth')
    const nested = (opts: { innerMin: number; outerMin?: number; outerMax?: number; withStatic?: boolean }): GroupSpec => ({
      kind: 'group',
      id: 'items',
      member: [
        ...(opts.withStatic ? [socketInput('img')] : []),
        {
          kind: 'group',
          id: 'sub',
          value: socketInput('s'),
          keys: { kind: 'numbered', prefix: 'sub', start: 0, pad: 0 },
          grows: 'link',
          minMembers: opts.innerMin,
          maxMembers: 4,
        },
      ],
      keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: 'link',
      minMembers: opts.outerMin ?? 0,
      maxMembers: opts.outerMax ?? 5,
    })

    it('a spare member that shows nothing is replaced by a growth item with materialize frames', () => {
      // Fresh node, min-0 outer, min-0 inner: the spare member offers no
      // inner members of its own, so a growth item stands in. Its frames
      // persist the offered member.
      const bare = elaborateInterface(schemaOf([nested({ innerMin: 0 })]), noState)
      expect(elabInputsOf(bare)).toHaveLength(0)
      expect(growthsOf(bare)).toEqual([
        {
          kind: 'growth',
          construct: 'items',
          side: 'input',
          label: 'items',
          frames: [{ construct: 'items', members: ['item0'], seq: 1 }],
        },
      ])
    })

    it('no growth item when the spare member shows something', () => {
      // Inner min > 0: the spare member offers its inner minimum, so pins
      // exist and connecting one grows the group.
      const minFill = elaborateInterface(schemaOf([nested({ innerMin: 1 })]), noState)
      expect(growthsOf(minFill)).toHaveLength(0)
      expect(elabInputsOf(minFill).length).toBeGreaterThan(0)

      // A plain row beside the inner group shows the spare member: no growth.
      const mixed = elaborateInterface(schemaOf([nested({ innerMin: 0, withStatic: true })]), noState)
      expect(growthsOf(mixed)).toHaveLength(0)
    })

    it('stored members shift the offer; capacity removes it', () => {
      const node = {
        values: {},
        dynamic: { items: { members: ['item0'], seq: 1 }, 'items.item0.sub': { members: ['sub0'], seq: 1 } },
      }
      const wired = connectedInputs('items.item0.sub.sub0')
      const one = elaborateInterface(schemaOf([nested({ innerMin: 0 })]), node, wired)
      expect(growthsOf(one).filter((g) => g.construct === 'items').map((g) => g.frames)).toEqual([
        [{ construct: 'items', members: ['item1'], seq: 2 }],
      ])
      // At the group's maximum there is no spare member and no growth offer.
      const full = elaborateInterface(schemaOf([nested({ innerMin: 0, outerMax: 1 })]), node, wired)
      expect(growthsOf(full).filter((g) => g.construct === 'items')).toHaveLength(0)
    })

    it('an inner group of a stored member offers growth with its own frame', () => {
      // items > sub > leaf, every level min-0 until the leaf's value.
      const doubly: GroupSpec = {
        kind: 'group',
        id: 'items',
        member: [{
          kind: 'group',
          id: 'sub',
          member: [{
            kind: 'group',
            id: 'leaf',
            value: socketInput('s'),
            keys: { kind: 'numbered', prefix: 'leaf', start: 0, pad: 0 },
            grows: 'link',
            minMembers: 0,
            maxMembers: 3,
          }],
          keys: { kind: 'numbered', prefix: 'sub', start: 0, pad: 0 },
          grows: 'link',
          minMembers: 0,
          maxMembers: 3,
        }],
        keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
        grows: 'link',
        minMembers: 0,
        maxMembers: 3,
      }
      // Fresh: only the OUTER group offers growth (the inner groups do not
      // exist until a member does).
      const fresh = elaborateInterface(schemaOf([doubly]), noState)
      expect(growthsOf(fresh).map((g) => g.construct)).toEqual(['items'])
      // With item0 stored, the group under it offers growth through its own
      // frame; the stored outer member needs none.
      const grown = elaborateInterface(schemaOf([doubly]), {
        values: {},
        dynamic: { items: { members: ['item0'], seq: 1 } },
      })
      expect(growthsOf(grown).find((g) => g.construct === 'items.item0.sub')).toEqual({
        kind: 'growth',
        construct: 'items.item0.sub',
        side: 'input',
        label: 'sub',
        frames: [{ construct: 'items.item0.sub', members: ['sub0'], seq: 1 }],
      })
    })
  })

  it('groups of output records elaborate symmetrically', () => {
    const family: GroupSpec = {
      kind: 'group',
      id: 'results',
      member: [output('image', 'IMAGE'), output('mask', 'MASK')],
      keys: { kind: 'numbered', prefix: 'result', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 1,
      maxMembers: 2,
    }
    const connected: Connectivity = {
      isInputConnected: () => false,
      isOutputConnected: (port) => port === 'results.result0.image',
    }
    const e = elaborateInterface(schemaOf([family]), { values: {}, dynamic: { results: { members: ['result0'] } } }, connected)
    const outs = elabOutputsOf(e)
    expect(outs.map((o) => [o.address.port, o.spec.displayName, o.wireable])).toEqual([
      ['results.result0.image', 'result 1 image', undefined],
      ['results.result0.mask', 'result 1 mask', undefined],
      ['results.result1.image', 'result 2 image', false], // spare member
      ['results.result1.mask', 'result 2 mask', false],
    ])
    expect(outs[1]!.spec.type).toEqual({ kind: 'concrete', name: 'MASK' })
  })
})

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

describe('choices', () => {
  const modes = choiceOf('mode', [
    { key: 'simple', rows: [{ kind: 'use', id: 'strength' }] },
    { key: 'advanced', rows: [{ kind: 'use', id: 'strength' }, socketInput('mask', 'MASK')] },
  ], { shared: [intInput('strength')] })

  it('emits a COMBO selector whose value is the stored key, then the chosen option rows', () => {
    const e = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'simple' } } })
    const inputs = elabInputsOf(e)
    const selector = inputs[0]!
    expect(selector.origin).toEqual({ kind: 'selector', construct: 'mode', selected: 'simple' })
    expect(selector.spec.widget).toMatchObject({ widgetType: 'COMBO', options: { options: ['simple', 'advanced'] } })
    expect(selector.derivedValue).toBe('simple')
    // The key travels with the node's choices, never as a prompt input.
    expect(selector.apiName).toBeUndefined()
    expect(e.choices).toEqual({ mode: 'simple' })
    expect(inputs.slice(1).map((i) => [i.address.port, i.apiName])).toEqual([['mode.strength', 'mode.strength']])
  })

  it('switching options swaps the rows; a shared row keeps one flattened id', () => {
    const simple = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'simple' } } })
    const advanced = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'advanced' } } })
    const keysOf = (e: ReturnType<typeof elaborateInterface>) => elabInputsOf(e).slice(1).map((i) => i.address.port)
    expect(keysOf(simple)).toEqual(['mode.strength'])
    expect(keysOf(advanced)).toEqual(['mode.strength', 'mode.mask'])
    for (const i of elabInputsOf(advanced).slice(1)) {
      expect(i.origin).toEqual({ kind: 'branch', construct: 'mode', option: 'advanced' })
    }
  })

  it('option rows keep the short id as displayName', () => {
    // spec.id becomes the flattened id ('mode.strength'); without an
    // authored displayName the human label must stay the row id.
    const e = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'simple' } } })
    for (const i of elabInputsOf(e).slice(1)) {
      expect(i.spec.displayName).toBe('strength')
    }
  })

  it('an unknown stored option is refused, never replaced', () => {
    const e = elaborateInterface(schemaOf([modes]), { values: {}, dynamic: { mode: { selected: 'gone' } } })
    expect(e.diagnostics.map((d) => d.code)).toEqual(['prompt.bad_dynamic_choice'])
    expect(elabInputsOf(e)).toEqual([])
  })

  it('shows the declared start option for a required choice with nothing stored; a run refuses it', () => {
    const combo = choiceOf('resize_type', [
      { key: 'scale dimensions', rows: [intInput('width')] },
      { key: 'scale by multiplier', rows: [intInput('multiplier')] },
    ], { default: 'scale by multiplier' })
    const node = { values: {}, dynamic: {} }
    const e = elaborateInterface(schemaOf([combo]), node)
    expect(e.diagnostics).toEqual([])
    expect(elabInputsOf(e).map((input) => input.address.port)).toEqual(['resize_type', 'resize_type.multiplier'])
    expect(elabInputsOf(e)[0]).toMatchObject({
      origin: { kind: 'selector', construct: 'resize_type' },
      derivedValue: 'scale by multiplier',
      spec: {
        widget: {
          widgetType: 'COMBO',
          options: { options: ['scale dimensions', 'scale by multiplier'] },
          default: 'scale by multiplier',
        },
      },
    })
    expect(e.unstoredChoices).toEqual({ resize_type: 'scale by multiplier' })
    expect(e.submissionValues).toEqual([])
    expect(node.dynamic).toEqual({})

    const run = elaborateInterface(schemaOf([combo]), node, EMPTY_CONNECTIVITY, { promoteGhosts: false })
    expect(run.diagnostics).toEqual([expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining("required choice 'resize_type' has no stored option"),
    })])

    const explicit = elaborateInterface(schemaOf([combo]), {
      values: {},
      dynamic: { resize_type: { selected: 'scale dimensions' } },
    })
    expect(explicit.diagnostics).toEqual([])
    expect(elabInputsOf(explicit).map((input) => input.address.port)).toEqual(['resize_type', 'resize_type.width'])
    expect(elabInputsOf(explicit)[0]?.derivedValue).toBe('scale dimensions')
    expect(explicit.unstoredChoices).toBeUndefined()
  })

  it('starts on the first option without a declared default', () => {
    const combo = choiceOf('mode', [
      { key: 'first', rows: [intInput('value')] },
      { key: 'second', rows: [] },
    ])
    const fresh = elaborateInterface(schemaOf([combo]), noState)
    expect(elabInputsOf(fresh).map((input) => input.address.port)).toEqual(['mode', 'mode.value'])
    expect(fresh.unstoredChoices).toEqual({ mode: 'first' })
    expect(initialDynamicStateOf(schemaOf([combo]))).toEqual({ mode: { selected: 'first' } })
  })

  it('a new node stores nested start options but not those of options it does not start on', () => {
    const inner = choiceOf('inner', [{ key: 'inner first', rows: [] }, { key: 'inner second', rows: [] }])
    const inactive = choiceOf('inactive', [{ key: 'inactive first', rows: [] }])
    const outer = choiceOf('outer', [{ key: 'outer first', rows: [inner] }, { key: 'outer second', rows: [inactive] }])
    const optional = choiceOf('extra', [{ key: 'on', rows: [] }], { required: false })
    expect(initialDynamicStateOf(schemaOf([outer, optional]))).toEqual({
      outer: { selected: 'outer first' },
      'outer.inner': { selected: 'inner first' },
    })
  })
})

// ---------------------------------------------------------------------------
// Type choices
// ---------------------------------------------------------------------------

describe('type choices', () => {
  const slot = openSlot('model', [intInput('lora_strength'), socketInput('clip', 'CLIP')])

  it('a required type choice with nothing stored shows its pin; a run refuses it', () => {
    const required: TypeChoiceSpec = {
      kind: 'typeChoice',
      id: 'source',
      variants: [
        { key: 'text', type: { kind: 'concrete', name: 'STRING' }, rows: [] },
        { key: 'integer', type: { kind: 'concrete', name: 'INT' }, rows: [] },
      ],
      rows: [],
      required: true,
    }
    const cleared = elaborateInterface(schemaOf([required]), { values: { source: 7 }, dynamic: { source: {} } })
    expect(cleared.diagnostics).toEqual([])
    expect(elabInputsOf(cleared)).toHaveLength(1)
    expect(elabInputsOf(cleared)[0]).toMatchObject({
      address: { port: 'source' }, spec: { optional: false, type: { kind: 'union', names: ['STRING', 'INT'] } },
      origin: { kind: 'slot', construct: 'source', variants: [
        { key: 'text', type: { kind: 'concrete', name: 'STRING' } },
        { key: 'integer', type: { kind: 'concrete', name: 'INT' } },
      ] },
    })
    expect(elabInputsOf(cleared)[0]!.apiName).toBeUndefined()
    const run = elaborateInterface(schemaOf([required]), { values: { source: 7 }, dynamic: { source: {} } }, EMPTY_CONNECTIVITY, { promoteGhosts: false })
    expect(run.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', code: 'prompt.missing_dynamic_choice' }))

    const reselected = elaborateInterface(schemaOf([required]), { values: { source: 7 }, dynamic: { source: { selected: 'integer' } } })
    expect(reselected.diagnostics).toEqual([])
    expect(elabInputsOf(reselected)[0]).toMatchObject({ apiName: 'source', spec: { type: { kind: 'concrete', name: 'INT' } } })
    expect(reselected.choices).toEqual({ source: 'integer' })
    const optional = elaborateInterface(schemaOf([{ ...required, required: false }]), noState, EMPTY_CONNECTIVITY, { promoteGhosts: false })
    expect(elabInputsOf(optional)).toEqual([])
    expect(optional.diagnostics).toEqual([])
  })

  const specialized = (variantRows: BodyRow[] = [intInput('weight')]): TypeChoiceSpec => ({
    kind: 'typeChoice',
    id: 'model',
    rows: [intInput('shared')],
    variants: [{ key: 'lora', type: { kind: 'concrete', name: 'LORA' }, rows: variantRows }],
    required: false,
  })

  it('censuses the rows of variants that are not chosen without submitting them', () => {
    const source: TypeChoiceSpec = {
      kind: 'typeChoice',
      id: 'source',
      rows: [intInput('shared')],
      variants: [
        { key: 'text', type: { kind: 'concrete', name: 'STRING' }, rows: [intInput('amount')] },
        { key: 'integer', type: { kind: 'concrete', name: 'INT' }, rows: [socketInput('amount', 'ASSET')] },
      ],
      required: true,
    }
    expect(() => checkBody([source])).not.toThrow()
    const node = { values: { source: 'hello' }, dynamic: { source: { selected: 'text' } } }
    const active = elaborateInterface(schemaOf([source]), node)
    expect(elabInputsOf(active).map((input) => input.apiName)).toEqual(['source', 'source.shared', 'source.amount'])
    const census = elaborateInterface(schemaOf([source]), node, EMPTY_CONNECTIVITY, { includeDormant: true })
    expect(census.diagnostics).toEqual([])
    expect(elabInputsOf(census).map((input) => input.spec.type)).toContainEqual({ kind: 'concrete', name: 'ASSET' })
    expect(elaborateInterface(schemaOf([source]), node, EMPTY_CONNECTIVITY, { includeDormant: true, budget: { maxItems: 2 } })
      .diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['elab.budget.items'])
  })

  it('disconnected open slot: only the pin itself, typed and optional', () => {
    const e = elaborateInterface(schemaOf([slot]), noState)
    const inputs = elabInputsOf(e)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.origin).toEqual({ kind: 'slot', construct: 'model' })
    expect(inputs[0]!.spec.type).toEqual({ kind: 'concrete', name: 'MODEL' })
    expect(inputs[0]!.spec.optional).toBe(true)
    expect(inputs[0]!.apiName).toBe('model')
    expect(inputs[0]!.origin).not.toHaveProperty('variants')
  })

  it('connected open slot: its rows appear at slot-scoped ids; disconnect hides, never deletes', () => {
    const e = elaborateInterface(schemaOf([slot]), noState, connectedInputs('model'))
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [i.address.port, i.apiName])).toEqual([
      ['model', 'model'],
      ['model.lora_strength', 'model.lora_strength'],
      ['model.clip', 'model.clip'],
    ])
    expect(inputs[1]!.origin).toEqual({ kind: 'dependent', construct: 'model' })
    // Hiding is pure derivation: the same node state with no connection just
    // elaborates fewer ports - values in the document are untouched.
    const hidden = elaborateInterface(schemaOf([slot]), noState)
    expect(elabInputsOf(hidden)).toHaveLength(1)
  })

  it('the chosen variant adds its rows at <slot>.<row>', () => {
    const e = elaborateInterface(schemaOf([specialized()]), { values: {}, dynamic: { model: { selected: 'lora' } } }, connectedInputs('model'))
    expect(elabInputsOf(e).map((i) => [i.address.port, i.apiName])).toEqual([
      ['model', 'model'], ['model.shared', 'model.shared'], ['model.weight', 'model.weight'],
    ])
    expect(elabInputsOf(e)[2]!.origin).toEqual({ kind: 'dependent', construct: 'model', variant: 'lora' })
    expect(e.choices).toEqual({ model: 'lora' })
  })

  it('surfaces the per-variant widget spec', () => {
    const e = elaborateInterface(schemaOf([specialized([intInput('weight', { widget: { widgetType: 'FLOAT', options: { min: 0 }, default: 0.5 } })])]), { values: {}, dynamic: { model: { selected: 'lora' } } }, connectedInputs('model'))
    expect(elabInputsOf(e)[2]!.spec.widget).toEqual({ widgetType: 'FLOAT', options: { min: 0 }, default: 0.5 })
  })

  it('refuses an unknown stored variant', () => {
    const e = elaborateInterface(schemaOf([specialized()]), { values: {}, dynamic: { model: { selected: 'gone' } } }, connectedInputs('model'))
    expect(e.diagnostics.map((d) => d.code)).toEqual(['prompt.bad_dynamic_choice'])
    expect(elabInputsOf(e)).toEqual([])
  })

  it('reads a member type choice from state at its flattened id', () => {
    const family: GroupSpec = {
      kind: 'group',
      id: 'items',
      member: [specialized()],
      keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 0,
      maxMembers: 2,
    }
    const state = { values: {}, dynamic: { items: { members: ['item0'] }, 'items.item0.model': { selected: 'lora' } } }
    const e = elaborateInterface(schemaOf([family]), state, connectedInputs('items.item0.model'))
    expect(elabInputsOf(e).map((i) => i.address.port)).toEqual(['items.item0.model', 'items.item0.model.shared', 'items.item0.model.weight', 'items.item1.model'])
    expect(e.choices).toEqual({ 'items.item0.model': 'lora' })
  })
})

// ---------------------------------------------------------------------------
// Nesting
// ---------------------------------------------------------------------------

describe('nested boxes', () => {
  it('a group inside a choice option keys state and members by flattened path', () => {
    const schema = schemaOf([
      choiceOf('mode', [
        { key: 'multi', rows: [imageGroup('images', { min: 1, max: 3 })] },
        { key: 'single', rows: [socketInput('image')] },
      ]),
    ])
    const node = {
      values: {},
      dynamic: {
        'mode': { selected: 'multi' },
        'mode.images': { members: ['image0', 'image1'] },
      },
    }
    const e = elaborateInterface(schema, node)
    expect(e.diagnostics).toEqual([])
    expect(elabInputsOf(e).map((i) => [i.address.port, i.apiName])).toEqual([
      ['mode', undefined],
      ['mode.images.image0', 'mode.images.image0'],
      ['mode.images.image1', 'mode.images.image1'],
    ])
    expect(e.outputMembers).toEqual({ 'mode.images': ['image0', 'image1'] })
  })

  it('a choice inside an open slot only elaborates while the slot is connected', () => {
    const schema = schemaOf([
      openSlot('model', [choiceOf('mode', [{ key: 'a', rows: [intInput('x')] }])]),
    ])
    expect(elabInputsOf(elaborateInterface(schema, noState))).toHaveLength(1)
    const e = elaborateInterface(schema, { values: {}, dynamic: { 'model.mode': { selected: 'a' } } }, connectedInputs('model'))
    expect(elabInputsOf(e).map((i) => i.address.port)).toEqual(['model', 'model.mode', 'model.mode.x'])
  })

  it('runaway nesting is cut off with ONE budget error, not a stack overflow', () => {
    let inner: BodyRow = intInput('leaf')
    for (let i = 0; i < 40; i++) inner = choiceOf(`c${i}`, [{ key: 'k', rows: [inner] }])
    const e = elaborateInterface(schemaOf([inner]), noState)
    expect(e.diagnostics.filter((d) => d.code === 'elab.budget.depth')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Groups in groups
// ---------------------------------------------------------------------------

/**
 * Outer group 'items': each member holds an image plus an INNER group 'sub'
 * of latents ("each item takes an image and any number of latents").
 */
const nestedFamily = (opts: { outerMin?: number; innerMin?: number } = {}): GroupSpec => ({
  kind: 'group',
  id: 'items',
  member: [
    socketInput('image', 'IMAGE'),
    {
      kind: 'group',
      id: 'sub',
      value: socketInput('item', 'LATENT'),
      keys: { kind: 'numbered', prefix: 'g', start: 0, pad: 0 },
      grows: 'link',
      minMembers: opts.innerMin ?? 0,
      maxMembers: 3,
    },
  ],
  keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
  grows: 'link',
  minMembers: opts.outerMin ?? 1,
  maxMembers: 3,
})

/** Two stored outer members with independent inner groups. */
const nestedState = {
  values: {},
  dynamic: {
    items: { members: ['item0', 'item1'] },
    'items.item0.sub': { members: ['g10', 'g11'] },
    'items.item1.sub': { members: ['g5'] },
  },
}

describe('groups in groups', () => {
  it('nested members are addressed by their full flattened path', () => {
    const e = elaborateInterface(schemaOf([nestedFamily()]), nestedState)
    expect(e.diagnostics).toEqual([])
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [i.address.port, i.apiName])).toEqual([
      ['items.item0.image', 'items.item0.image'],
      ['items.item0.sub.g10', 'items.item0.sub.g10'],
      ['items.item0.sub.g11', 'items.item0.sub.g11'],
      ['items.item1.image', 'items.item1.image'],
      ['items.item1.sub.g5', 'items.item1.sub.g5'],
    ])
    for (const i of inputs) expect(i.spec.id).toBe(i.address.port)
    expect(e.outputMembers).toEqual({
      items: ['item0', 'item1'],
      'items.item0.sub': ['g10', 'g11'],
      'items.item1.sub': ['g5'],
    })
  })

  it('reordering outer members moves ordinals, never nested identity or state', () => {
    const reordered = { ...nestedState, dynamic: { ...nestedState.dynamic, items: { members: ['item1', 'item0'] } } }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([nestedFamily()]), reordered))
    expect(inputs.map((i) => i.address.port)).toEqual([
      'items.item1.image',
      'items.item1.sub.g5',
      'items.item0.image',
      'items.item0.sub.g10',
      'items.item0.sub.g11',
    ])
    expect(inputs[0]!.origin).toEqual({ kind: 'member', construct: 'items', ordinal: 0, key: 'item1' })
  })

  it('nothing under an offered member compiles', () => {
    const e = elaborateInterface(schemaOf([nestedFamily({ innerMin: 1 })]), noState)
    const inputs = elabInputsOf(e)
    for (const i of inputs) {
      if ((i.ancestry ?? []).some((a) => a.ghost)) {
        expect(i.apiName, i.address.port).toBeUndefined()
        expect(i.spec.optional, i.address.port).toBe(true)
      }
    }
    // The offered outer member shows its image and its inner minimum.
    expect(inputs.filter((i) => i.ancestry?.[0]?.ghost).map((i) => i.address.port)).toEqual([
      'items.item0.image',
      'items.item0.sub.g0',
    ])
  })

  it('a choice inside a member keeps selector and option roles; state and values are member-scoped', () => {
    const family: GroupSpec = {
      kind: 'group',
      id: 'items',
      member: [choiceOf('mode', [{ key: 'a', rows: [intInput('x')] }, { key: 'b', rows: [] }])],
      keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 1,
      maxMembers: 3,
    }
    const node = {
      values: {},
      dynamic: {
        items: { members: ['item0', 'item1'] },
        'items.item1.mode': { selected: 'b' },
      },
    }
    const e = elaborateInterface(schemaOf([family]), node)
    const inputs = elabInputsOf(e)
    expect(inputs.map((i) => [i.address.port, i.origin.kind, i.derivedValue])).toEqual([
      ['items.item0.mode', 'selector', 'a'], // start option: nothing stored
      ['items.item0.mode.x', 'branch', undefined],
      ['items.item1.mode', 'selector', 'b'], // item1's own key
    ])
    expect(e.unstoredChoices).toEqual({ 'items.item0.mode': 'a' })
    const branch = inputs.find((i) => i.address.port === 'items.item0.mode.x')!
    expect(branch.ancestry).toEqual([{ construct: 'items', member: 'item0', ordinal: 0 }])
  })

  it('a spare member never reuses a removed key: it continues from seq', () => {
    const node = { values: {}, dynamic: { images: { members: ['image0'], seq: 2 } } }
    const inputs = elabInputsOf(elaborateInterface(schemaOf([imageGroup('images', { min: 1, max: 4 })]), node, connectedInputs('images.image0')))
    expect(inputs.map((i) => i.address.port)).toEqual(['images.image0', 'images.image2'])
  })
})

// ---------------------------------------------------------------------------
// Groups of outputs
// ---------------------------------------------------------------------------

describe('groups of outputs', () => {
  it('a group of output values elaborates through the same rules', () => {
    const family: GroupSpec = {
      kind: 'group',
      id: 'results',
      value: output('item', 'IMAGE'),
      keys: { kind: 'numbered', prefix: 'result', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 1,
      maxMembers: 3,
    }
    const node = { values: {}, dynamic: { results: { members: ['result0', 'result1'] } } }
    const e = elaborateInterface(schemaOf([family]), node)
    const outs = elabOutputsOf(e)
    expect(outs.map((o) => [o.address.port, o.spec.displayName])).toEqual([
      ['results.result0', 'result 1'],
      ['results.result1', 'result 2'],
    ])
    expect(outs[0]!.spec.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(e.outputMembers).toEqual({ results: ['result0', 'result1'] })
  })
})

// ---------------------------------------------------------------------------
// Connectivity facts
// ---------------------------------------------------------------------------

describe('formulas', () => {
  const int = { kind: 'concrete', types: ['INT'] }
  const outputsUnder = (body: unknown[], values: Record<string, unknown> = {}, dynamic: Record<string, unknown> = {}) => {
    const { schema, diagnostics } = parseDinksterSchema('Formulas', { body } as never)
    expect(diagnostics).toEqual([])
    const elaborated = elaborateInterface(schema!, { values, dynamic } as never, EMPTY_CONNECTIVITY, { promoteGhosts: false })
    expect(elaborated.diagnostics).toEqual([])
    return elabOutputsOf(elaborated).map((output) => output.spec.id)
  }
  const counted = (count: string) => ({
    kind: 'group', id: 'a', grows: { count }, keys: { numbered: { prefix: '', start: 1, pad: 0 } }, maxMembers: 5,
    value: { kind: 'output', id: 'v', type: int },
  })

  it('reads a led choice the same whether it is declared before or after the formula', () => {
    const led = { kind: 'choice', id: 'b', leader: '"x"', options: [
      { key: 'x', rows: [{ kind: 'input', id: 'n', type: int, pin: false, default: 3 }] },
      { key: 'y', rows: [] },
    ] }
    for (const count of ['b.n', '3 if b == "x" else 1']) {
      expect(outputsUnder([counted(count), led], { 'b.n': 3 })).toEqual(['a.1', 'a.2', 'a.3'])
      expect(outputsUnder([led, counted(count)], { 'b.n': 3 })).toEqual(['a.1', 'a.2', 'a.3'])
    }
  })

  it('reads the size of a group under an option that is not chosen as unknown', () => {
    // Unknown counts fall back to the minimum (1), not to the 2 members stored under the unchosen option.
    const c = { kind: 'choice', id: 'c', options: [
      { key: 'a', rows: [{ kind: 'group', id: 'g', keys: { numbered: { prefix: '', start: 1, pad: 0 } },
        member: [{ kind: 'input', id: 's', type: int, required: false }] }] },
      { key: 'b', rows: [] },
    ] }
    const size = { ...counted('len(c.g)'), id: 'o', minMembers: 1 }
    const sum = { ...counted('sum(c.g.s)'), id: 'p', minMembers: 1 }
    expect(outputsUnder([c, size, sum], { 'c.g.1.s': 2, 'c.g.2.s': 3 }, { c: { selected: 'b' }, 'c.g': { members: ['1', '2'] } }))
      .toEqual(['o.1', 'p.1'])
    expect(outputsUnder([c, size, sum], { 'c.g.1.s': 2, 'c.g.2.s': 3 }, { c: { selected: 'a' }, 'c.g': { members: ['1', '2'] } }))
      .toEqual(['o.1', 'o.2', 'p.1', 'p.2', 'p.3', 'p.4', 'p.5'])
  })

  it('refuses at load a formula or argument that reads across a counted group, and allows reads within a member', () => {
    const n = { kind: 'input', id: 'n', type: int, pin: false, default: 2 }
    const g = { kind: 'group', id: 'g', grows: { count: 'n' }, keys: { numbered: { prefix: '', start: 1, pad: 0 } }, maxMembers: 4,
      member: [{ kind: 'input', id: 's', type: int, pin: false, default: 1 }] }
    const refusal = (body: unknown[], extra: Record<string, unknown> = {}) => {
      const { schema, diagnostics } = parseDinksterSchema('Counted', { body, ...extra } as never)
      return schema === undefined ? diagnostics.map((diagnostic) => diagnostic.message).join() : undefined
    }
    const note = (text: string) => ({ kind: 'note', id: 'x', text: { formula: text } })
    expect(refusal([n, g, note('len(g)')])).toContain("reads 'g': reading the size or the members of group 'g', whose count is a formula, is not built yet")
    expect(refusal([n, { kind: 'choice', id: 'c', options: [{ key: 'a', rows: [g] }] }, note('sum(c.g.s)')]))
      .toContain("reads 'c.g.s': reading the size or the members of group 'c.g'")
    expect(refusal([n, g, { kind: 'choice', id: 'c', leader: '"a" if len(g) > 1 else "b"', options: [{ key: 'a', rows: [] }, { key: 'b', rows: [] }] }]))
      .toContain('is not built yet')
    expect(refusal([n, { ...g, grows: { count: 'len(g)' } }])).toContain('is not built yet')
    expect(refusal([n, g, note('total')], { derived: { total: 'sum(g.s)' } })).toContain("reads 'g.s'")
    expect(refusal([n, g, { kind: 'note', id: 'x', text: { lookup: 'pack.mod.fn', args: ['g'] } }]))
      .toContain("pack.mod.fn: argument 'g' reads the members of a group whose count is a formula, which is not built yet")
    expect(refusal([n, g], { titleSuffix: { formula: 'str(len(g))' } })).toContain('is not built yet')
    // A member reads its own sibling, and a group that grows by hand is read as before.
    expect(refusal([n, { ...g, memberLabel: { formula: 'str(s)' } }])).toBeUndefined()
    expect(refusal([n, { ...g, grows: 'button' }, note('len(g)')])).toBeUndefined()
  })

  it('censuses what a member past a shrunk count stored, up to the limit the keys allow', () => {
    const body = [
      { kind: 'input', id: 'n', type: int, pin: false, default: 2 },
      { kind: 'group', id: 'g', grows: { count: 'n' }, keys: { numbered: { prefix: '', start: 1, pad: 0 } }, maxMembers: 4,
        member: [{ kind: 'choice', id: 'c', options: [{ key: 'x', rows: [] }, { key: 'y', rows: [] }] }] },
    ]
    const { schema } = parseDinksterSchema('Shrunk', { body } as never)
    const census = (dynamic: Record<string, unknown>) => elaborateInterface(schema!, { values: { n: 2 }, dynamic } as never,
      EMPTY_CONNECTIVITY, { includeDormant: true }).diagnostics.map((diagnostic) => diagnostic.message)
    const start = { 'g.1.c': { selected: 'x' }, 'g.2.c': { selected: 'x' } }
    expect(census({ ...start, 'g.4.c': { selected: 'y' } })).toEqual([])
    expect(census({ ...start, 'g.5.c': { selected: 'y' } })).toEqual(["Shrunk: unknown stored dynamic state 'g.5.c'"])
    expect(census({ ...start, 'g.z.c': { selected: 'y' } })).toEqual(["Shrunk: unknown stored dynamic state 'g.z.c'"])
    const active = elaborateInterface(schema!, { values: { n: 2 }, dynamic: { ...start, 'g.4.c': { selected: 'y' } } } as never)
    expect(elabInputsOf(active).map((input) => input.spec.id)).toEqual(['n', 'g.1.c', 'g.2.c'])
  })
})

describe('buildGraphConnectivity', () => {

  it('indexes links and nets once by flattened id, ignoring reroute endpoints', () => {
    const def = {
      id: 'g0',
      nodes: {},
      links: {
        l0: { id: 'l0', from: { node: 'a', port: 'out0' }, to: { node: 'b', port: 'images.m1' } },
        l1: { id: 'l1', from: { node: 'a', port: 'out0' }, to: { reroute: 'r0' } },
        l2: { id: 'l2', from: { reroute: 'r0' }, to: { node: 'b', port: 'model' } },
      },
      nets: {
        n0: { id: 'n0', name: 'vae', source: { node: 'c', port: 'out0' }, sinks: [{ node: 'b', port: 'vae' }] },
      },
      reroutes: { r0: { id: 'r0' } },
      nextOrdinal: 3,
    } as unknown as GraphDef
    const facts = buildGraphConnectivity(def)
    const b = facts(asNodeId('b'))
    expect(b.isInputConnected('images.m1')).toBe(true)
    expect(b.isInputConnected('images.m0')).toBe(false) // one member, not the whole group
    expect(b.isInputConnected('model')).toBe(true) // reroute-driven links still land on the input
    expect(b.isInputConnected('vae')).toBe(true) // net sinks count
    expect(facts(asNodeId('a')).isOutputConnected('out0')).toBe(true)
  })

})
