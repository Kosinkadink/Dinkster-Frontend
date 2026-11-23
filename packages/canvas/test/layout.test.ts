/**
 * Row-model layout tests. These pin the architecture's committed layout
 * rules: paired input/output lines, widgets own full rows, overflow outputs
 * get dedicated rows, auto-size is a pure function of the row stack.
 */
import { describe, expect, it } from 'vitest'
import type { ButtonSpec, InputSpec, NodeData, NodeSchema, NoteSpec, OutputSpec } from '@dinkster/core'
import { asNodeId, elaborateInterface, EMPTY_CONNECTIVITY } from '@dinkster/core'
import { layoutNode, projectNodeLayoutHeight, withCompactPreviewRegion, withPreviewRegion, withTextOutputRegion, type TextMeasurer, type WidgetMeasure } from '../src/layout.js'
import { canvasPaintTokens, defaultTokens } from '../src/tokens.js'

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = (spec) =>
  spec.options['multiline'] === true
    ? { viewId: 'core.text', rows: 2 }
    : { viewId: spec.widgetType === 'STRING' ? 'core.line' : 'core.number', rows: 1 }

const input = (id: string, over: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'IMAGE' },
  optional: false,
  ...over,
})
const widget = (id: string, over: Partial<InputSpec> = {}): InputSpec =>
  input(id, { type: { kind: 'concrete', name: 'INT' }, widget: { widgetType: 'INT', options: {} }, ...over })
const output = (id: string, over: Partial<OutputSpec> = {}): OutputSpec => ({
  kind: 'output', id, type: { kind: 'concrete', name: 'IMAGE' }, ...over,
})

const schemaOf = (items: NodeSchema['body'], displayName = 'Test'): NodeSchema => ({
  type: 'Test',
  displayName,
  category: 'test',
  source: 'v3',
  body: items,
  isOutputNode: false,
})
const nodeData: NodeData = { id: asNodeId('n0'), type: 'Test', values: {} }

const doLayout = (items: NodeSchema['body'], displayName?: string) =>
  layoutNode(schemaOf(items, displayName), nodeData, defaultTokens, measure, widgetMeasure)

describe('pairing', () => {
  it('places an appended adjacent widget after its sibling without changing schema or value order', () => {
    const items = [widget('prefix'), widget('quality'), widget('mount', { adjacentTo: 'prefix' }), widget('tail')]
    const before = JSON.stringify(items)
    const layout = doLayout(items)
    expect(layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(['prefix', 'mount', 'quality', 'tail'])
    expect(JSON.stringify(items)).toBe(before)
    expect(layout.pins.filter((pin) => pin.direction === 'in').map((pin) => pin.portId)).toEqual(['prefix', 'mount', 'quality', 'tail'])
    const [prefix, mount, quality] = layout.rows
    expect(mount!.y).toBe(prefix!.y)
    expect(quality!.y).toBe(prefix!.y + prefix!.height)
    for (const projected of [layout, withPreviewRegion(layout, defaultTokens), withCompactPreviewRegion(layout, defaultTokens), withTextOutputRegion(layout, defaultTokens)]) {
      expect(projected.rows[1]!.y).toBe(projected.rows[0]!.y)
      const inputs = projected.pins.filter((pin) => pin.direction === 'in')
      expect(inputs[1]!.y - inputs[0]!.y).toBeGreaterThan(18)
      expect(inputs[1]!.y).toBeLessThan(projected.rows[0]!.y + projected.rows[0]!.height)
    }
  })

  it('keeps a same-id real output separate from the adjacent widget value output', () => {
    const layout = doLayout([widget('prefix'), widget('mount', { adjacentTo: 'prefix' }), output('prefix')])
    const realOutput = layout.pins.find((pin) => pin.portId === 'prefix' && pin.direction === 'out' && !pin.widgetTap)!
    const valueOutput = layout.pins.find((pin) => pin.portId === 'prefix' && pin.widgetTap)!
    expect(realOutput.y).toBeGreaterThan(valueOutput.y)
  })

  it('keeps adjacency inside each chosen option and group member', () => {
    const siblings: NodeSchema['body'] = [{ kind: 'row', rows: [widget('prefix'), widget('mount')] }, widget('quality')]
    const combo: NodeSchema['body'][number] = {
      kind: 'choice', id: 'mode', required: true, shared: [], options: [{ key: 'save', rows: siblings }],
    }
    const family: NodeSchema['body'][number] = {
      kind: 'group', id: 'files', member: [combo],
      keys: { kind: 'numbered', prefix: 'file', start: 0, pad: 0 }, grows: 'link', minMembers: 1, maxMembers: 2,
    }
    for (const [items, node, prefixes] of [
      [[combo], nodeData, ['mode']],
      [
        [family],
        { ...nodeData, values: { 'files.file0.mode.prefix': 'first', 'files.file1.mode.prefix': 'second' }, dynamic: { files: { members: ['file0', 'file1'], seq: 2 } } },
        ['files.file0.mode', 'files.file1.mode'],
      ],
    ] as const) {
      const schema = schemaOf(items)
      const before = JSON.stringify({ schema, node })
      const elaborated = elaborateInterface(schema, node)
      const layout = layoutNode(schema, node, defaultTokens, measure, widgetMeasure)
      const widgets = layout.rows.filter((row) => row.kind === 'widget')
      for (const prefix of prefixes) {
        const rows = widgets.filter((row) => row.inputId?.startsWith(`${prefix}.`))
        expect(rows.map((row) => row.inputId)).toEqual([`${prefix}.prefix`, `${prefix}.mount`, `${prefix}.quality`])
        expect(rows[1]!.y).toBe(rows[0]!.y)
        expect(rows[2]!.y).toBe(rows[0]!.y + rows[0]!.height)
        expect(elaborated.items.filter((item) => item.kind === 'input' && item.spec.id.startsWith(`${prefix}.`)).map((item) => item.kind === 'input' && item.spec.id)).toEqual([`${prefix}.prefix`, `${prefix}.mount`, `${prefix}.quality`])
      }
      expect(JSON.stringify({ schema, node })).toBe(before)
    }
  })

  it('draws notes and buttons as rows, inside a Row on its line, and only under the chosen option', () => {
    const note = (id: string, text: NoteSpec['text'], unknown?: string): NoteSpec =>
      ({ kind: 'note', id, text, ...(unknown !== undefined ? { unknown } : {}) })
    const button = (id: string, label: string): ButtonSpec => ({ kind: 'button', id, label, steps: [] })
    const mode: NodeSchema['body'][number] = {
      kind: 'choice', id: 'mode', required: true, shared: [],
      options: [{ key: 'a', rows: [note('shown', 'under a')] }, { key: 'b', rows: [note('hidden', 'under b'), button('go', 'Go')] }],
    }
    const layout = doLayout([
      note('intro', 'Plain text'),
      { kind: 'row', rows: [widget('w'), note('size', { formula: 'w * 2' }, 'pending'), button('swap', 'Swap')] },
      widget('after'),
      mode,
    ])
    const kinds = layout.rows.map((row) => row.kind === 'note' ? `note:${row.noteId}:${row.text}${row.unknown ? ':unknown' : ''}`
      : row.kind === 'button' ? `button:${row.buttonId}:${row.label}`
        : row.kind === 'widget' ? `widget:${row.inputId}` : row.kind)
    expect(kinds).toEqual(['note:intro:Plain text', 'widget:w', 'note:size:pending:unknown', 'button:swap:Swap', 'widget:after', 'widget:mode', 'note:mode.shown:under a'])
    const [intro, w, size, swap, after] = layout.rows
    expect(w!.y).toBe(intro!.y + intro!.height)
    expect(size!.y).toBe(w!.y)
    expect(swap!.y).toBe(w!.y)
    const span = (row: (typeof layout.rows)[number] | undefined) =>
      row !== undefined && 'width' in row ? [row.inset, row.inset + row.width!] : []
    expect(span(w)[1]).toBeLessThanOrEqual(span(size)[0]!)
    expect(span(size)[1]).toBeLessThanOrEqual(span(swap)[0]!)
    expect(after!.y).toBe(w!.y + w!.height)
    // Neither kind is a pin target.
    expect(layout.pins.filter((pin) => pin.direction === 'in').map((pin) => pin.portId)).toEqual(['w', 'after'])
  })

  it('outputs pair with connection-input rows top-down', () => {
    const l = doLayout([input('a'), input('b'), output('x'), output('y')])
    expect(l.rows).toHaveLength(2)
    expect(l.rows[0]).toMatchObject({ kind: 'ports', input: { portId: 'a' }, output: { portId: 'x' } })
    expect(l.rows[1]).toMatchObject({ kind: 'ports', input: { portId: 'b' }, output: { portId: 'y' } })
  })

  it('overflow outputs get dedicated rows, never widget rows', () => {
    const l = doLayout([input('a'), widget('w'), output('x'), output('y'), output('z')])
    expect(l.rows).toHaveLength(4)
    expect(l.rows[0]).toMatchObject({ kind: 'ports', input: { portId: 'a' }, output: { portId: 'x' } })
    expect(l.rows[1]).toMatchObject({ kind: 'widget', inputId: 'w' })
    expect(l.rows[2]).toMatchObject({ kind: 'ports', output: { portId: 'y' } })
    expect((l.rows[2] as { input?: unknown }).input).toBeUndefined()
    expect(l.rows[3]).toMatchObject({ kind: 'ports', output: { portId: 'z' } })
  })

  it('a widget row never carries an output even when outputs overflow', () => {
    const l = doLayout([widget('w'), output('x')])
    const widgetRow = l.rows.find((r) => r.kind === 'widget')!
    expect((widgetRow as { output?: unknown }).output).toBeUndefined()
    expect(l.rows.filter((r) => r.kind === 'ports' && r.output)).toHaveLength(1)
  })

  it('forceInput widget inputs are pairable socket rows', () => {
    const l = doLayout([widget('seed', { forceInput: true }), output('x')])
    expect(l.rows).toHaveLength(1)
    expect(l.rows[0]).toMatchObject({ kind: 'ports', input: { portId: 'seed' }, output: { portId: 'x' } })
  })

  it.each([
    ['INT', 'INT'],
    ['FLOAT', 'FLOAT'],
    ['BOOLEAN', 'BOOLEAN'],
  ] as const)('renders forceInput %s group members as socket rows', (widgetType, typeName) => {
    const family: NodeSchema['body'][number] = {
      kind: 'group',
      id: 'values',
      value: input('value', {
        type: { kind: 'concrete', name: typeName },
        widget: { widgetType, options: {} },
        forceInput: true,
      }),
      keys: { kind: 'named', names: ['a', 'b'] },
      grows: 'link',
      minMembers: 2,
    }
    // Member a is stored; member b is offered up to the minimum.
    const layout = layoutNode(
      schemaOf([family, output('x'), output('y')]),
      { ...nodeData, dynamic: { values: { members: ['a'] } } },
      defaultTokens,
      measure,
      widgetMeasure,
    )
    // The members sit in the group's box; the node's own outputs, outside
    // it, take rows of their own after it.
    expect(layout.rows).toHaveLength(5)
    expect(layout.rows[0]).toMatchObject({ kind: 'section', sectionId: 'group:values', box: 'group' })
    expect(layout.rows[1]).toMatchObject({
      kind: 'ports',
      input: { portId: 'values.a', familyMember: true, type: { kind: 'concrete', name: typeName } },
    })
    expect(layout.rows[2]).toMatchObject({
      kind: 'ports',
      input: { portId: 'values.b', familyMember: true, ghost: true, materialize: expect.any(Array) },
    })
    expect(layout.rows.slice(3)).toMatchObject([
      { kind: 'ports', output: { portId: 'x' } },
      { kind: 'ports', output: { portId: 'y' } },
    ])
    expect(layout.rows.some((row) => row.kind === 'widget')).toBe(false)
    expect(layout.pins.filter((pin) => pin.direction === 'in')).toHaveLength(2)
    expect(layout.pins.filter((pin) => pin.direction === 'in').every((pin) => pin.widgetBacked === undefined)).toBe(true)
    expect(layout.pins.filter((pin) => pin.direction === 'in').every((pin) => pin.familyMember === true)).toBe(true)
    expect(layout.pins.some((pin) => pin.widgetTap === true)).toBe(false)
  })

  it('keeps force-input widgets of a chosen option as socket rows', () => {
    const mode: NodeSchema['body'][number] = {
      kind: 'choice',
      id: 'mode',
      required: true,
      shared: [],
      options: [{
        key: 'active',
        rows: [input('value', {
          type: { kind: 'concrete', name: 'INT' },
          widget: { widgetType: 'INT', options: {} },
          forceInput: true,
        })],
      }],
    }
    const layout = doLayout([mode])
    expect(layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(['mode'])
    expect(layout.rows.find((row) => row.kind === 'ports'))
      .toMatchObject({ input: { portId: 'mode.value' } })
  })

})

describe('declared order', () => {
  it('interface order is preserved: widgets may precede inputs', () => {
    const l = doLayout([widget('w1'), input('a'), widget('w2')])
    expect(l.rows.map((r) => (r.kind === 'widget' ? r.inputId : (r as { input?: { portId: string } }).input?.portId))).toEqual([
      'w1',
      'a',
      'w2',
    ])
  })
})

describe('wire-17 widget representations', () => {
  const represented = widget('text', {
    type: { kind: 'concrete', name: 'STRING' },
    widget: {
      widgetType: 'STRING',
      options: { multiline: true },
      representations: {
        default: 'multiline',
        userSwitchable: true,
        representations: [
          { id: 'single-line', displayName: 'Single line', widget: { widgetType: 'STRING', options: { multiline: false } } },
          { id: 'multiline', displayName: 'Multiline', widget: { widgetType: 'STRING', options: { multiline: true } } },
        ],
      },
    },
  })

  const rowWith = (selection?: string) => layoutNode(
    schemaOf([represented]),
    { ...nodeData, values: { text: 'unchanged' } },
    defaultTokens,
    measure,
    widgetMeasure,
    selection === undefined ? {} : { widgetRepresentations: { text: selection } },
  ).rows[0]!

  it('uses the schema default, applies a stored choice, and safely falls back from a stale choice', () => {
    expect(rowWith()).toMatchObject({
      kind: 'widget', representationId: 'multiline', viewId: 'core.text', rows: 2,
      spec: { options: { multiline: true } },
    })
    expect(rowWith('single-line')).toMatchObject({
      kind: 'widget', representationId: 'single-line', viewId: 'core.line', rows: 1,
      spec: { options: { multiline: false } },
    })
    expect(rowWith('temporarily-missing')).toMatchObject({
      kind: 'widget', representationId: 'multiline', viewId: 'core.text', rows: 2,
    })
  })

  it('treats an ordinary string multiline hint as its switchable default', () => {
    const ordinary = widget('text', {
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'STRING', options: { multiline: true } },
    })
    const layout = (selection?: string) => layoutNode(
      schemaOf([ordinary]),
      { ...nodeData, values: { text: 'same value' } },
      defaultTokens,
      measure,
      widgetMeasure,
      selection === undefined ? {} : { widgetRepresentations: { text: selection } },
    ).rows[0]
    expect(layout()).toMatchObject({
      kind: 'widget', representationId: 'multiline', viewId: 'core.text', rows: 2,
    })
    expect(layout('single-line')).toMatchObject({
      kind: 'widget', representationId: 'single-line', viewId: 'core.line', rows: 1,
    })
  })

})

describe('document-time selector branch display', () => {
  const selectorSchema = (): NodeSchema => ({
    ...schemaOf([
      widget('switch', { type: { kind: 'concrete', name: 'BOOLEAN' }, widget: { widgetType: 'BOOLEAN', options: {} } }),
      input('on_false'),
      input('on_true'),
      output('result'),
    ]),
    selector: { input: 'switch', branches: { false: 'on_false', true: 'on_true' } },
  })
  const branchState = (values: NodeData['values']) => {
    const rows = layoutNode(
      selectorSchema(),
      { ...nodeData, values },
      defaultTokens,
      measure,
      widgetMeasure,
    ).rows
    return Object.fromEntries(rows.flatMap((row) =>
      row.kind === 'ports' && row.input
        ? [[row.input.portId, row.input.inactive === true ? 'inactive' : 'normal']]
        : [],
    ))
  }

  it('projects the stored boolean onto active and inactive branch rows, with absent state neutral', () => {
    expect(branchState({ switch: false })).toMatchObject({ on_false: 'normal', on_true: 'inactive' })
    expect(branchState({ switch: true })).toMatchObject({ on_false: 'inactive', on_true: 'normal' })
    expect(branchState({})).toMatchObject({ on_false: 'normal', on_true: 'normal' })
  })

  it('projects selector branches by raw port identity for ids containing # and %', () => {
    const schema: NodeSchema = {
      ...schemaOf([input('branch#false'), input('branch%23false'), output('result')]),
      selector: {
        input: 'switch',
        branches: { false: 'branch#false', true: 'branch%23false' },
      },
    }
    const rows = layoutNode(
      schema,
      { ...nodeData, values: { switch: true } },
      defaultTokens,
      measure,
      widgetMeasure,
    ).rows
    expect(rows.find((row) => row.kind === 'ports' && row.input?.address.port === 'branch#false')).toMatchObject({
      input: { inactive: true },
    })
    expect(rows.find((row) => row.kind === 'ports' && row.input?.address.port === 'branch%23false')).not.toMatchObject({
      input: { inactive: true },
    })
  })
})

describe('after-generate controller rows', () => {
  it('marks only controller-enabled widget rows and derives the unstored randomize default', () => {
    const controlled = widget('seed', {
      widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
    })
    const rows = doLayout([controlled, widget('plain')]).rows
    expect(rows[0]).toMatchObject({ kind: 'widget', inputId: 'seed', controllerMode: 'randomize' })
    expect(rows[1]).toMatchObject({ kind: 'widget', inputId: 'plain' })
    expect(rows[1]).not.toHaveProperty('controllerMode')
  })

  it('lays out the stored controller mode on the widget row', () => {
    const controlled = widget('seed', {
      widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
    })
    const layout = layoutNode(
      schemaOf([controlled]),
      { ...nodeData, controllers: { seed: 'increment' } },
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(layout.rows[0]).toMatchObject({ kind: 'widget', controllerMode: 'increment', height: defaultTokens.rowHeight })
  })

  it('seeds the unstored mode from the schema controllerInitial (wire v11); stored state still wins', () => {
    const controlled = widget('seed', {
      widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate', controllerInitial: 'fixed' },
    })
    const unstored = doLayout([controlled]).rows
    expect(unstored[0]).toMatchObject({ kind: 'widget', inputId: 'seed', controllerMode: 'fixed' })
    const stored = layoutNode(
      schemaOf([controlled]),
      { ...nodeData, controllers: { seed: 'increment' } },
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(stored.rows[0]).toMatchObject({ kind: 'widget', controllerMode: 'increment' })
  })

  it('omits the controller chip metadata when the feature is disabled', () => {
    const controlled = widget('seed', {
      widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
    })
    const layout = layoutNode(schemaOf([controlled]), nodeData, defaultTokens, measure, widgetMeasure, { seedControllerEnabled: false })
    expect(layout.rows[0]).not.toHaveProperty('controllerMode')
  })

  it('reuses controller chip metadata for a remote COMBO after-refresh slot', () => {
    const combo = widget('model', {
      type: { kind: 'concrete', name: 'COMBO' },
      widget: {
        widgetType: 'COMBO', options: {}, default: 'a', controller: 'after_refresh',
        remote: { route: '/models', refreshButton: true, controlAfterRefresh: 'first' },
      },
    })
    expect(doLayout([combo]).rows[0]).toMatchObject({
      kind: 'widget', inputId: 'model', controllerMode: 'randomize',
      spec: { widgetType: 'COMBO', controller: 'after_refresh' },
    })
  })
})

describe('sizing', () => {
  it('multiline widgets consume more rows -> taller node', () => {
    const single = doLayout([widget('s', { widget: { widgetType: 'STRING', options: {} } })])
    const multi = doLayout([widget('s', { widget: { widgetType: 'STRING', options: { multiline: true } } })])
    expect(multi.height - single.height).toBe(
      4 + defaultTokens.multilineText.labelHeight - defaultTokens.rowHeight +
      2 * defaultTokens.multilineText.lineHeight + 2 * defaultTokens.multilineText.padding,
    )
  })

  it('FR7 malformed widget row counts normalize to whole positive rows', () => {
    for (const [rows, expected] of [[Number.NaN, 1], [0, 1], [-3, 1], [2.5, 2]] as const) {
      const layout = layoutNode(
        schemaOf([widget('w')]), nodeData, defaultTokens, measure,
        () => ({ viewId: 'test', rows }),
      )
      expect(layout.rows[0]).toMatchObject({ kind: 'widget', height: expected * defaultTokens.rowHeight })
    }
  })

  it('auto width grows with the title but stays clamped', () => {
    const short = doLayout([output('x')], 'A')
    const long = doLayout([output('x')], 'A very long node display name indeed')
    expect(long.width).toBeGreaterThan(short.width)
    const absurd = doLayout([output('x')], 'x'.repeat(500))
    expect(absurd.width).toBe(defaultTokens.nodeMaxAutoWidth)
  })

  it('keeps auto width independent of above-node execution-arm indicators', () => {
    const title = 'A Rather Long Adaptive KSampler'
    const ordinary = schemaOf([], title)
    const armed = { ...ordinary, executionArms: ['native', 'comfyui'] as const }
    const ordinaryLayout = layoutNode(ordinary, nodeData, defaultTokens, measure, widgetMeasure)
    const armedLayout = layoutNode(armed, nodeData, defaultTokens, measure, widgetMeasure)

    expect(ordinaryLayout.width).toBe(6 * title.length + defaultTokens.padX * 2 + 8)
    expect(armedLayout.width).toBe(ordinaryLayout.width)
  })

  it('minimizes to title width with an 80px floor while retaining every endpoint', () => {
    const schema = schemaOf([
      input('required', { type: { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } } }),
      widget('value'),
      { kind: 'section', id: 'advanced', displayName: 'Advanced', collapsedByDefault: true, rows: [input('advanced')] },
      output('result', { type: { kind: 'union', names: ['IMAGE', 'MASK'] } }),
    ], 'A')
    const layout = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      minimized: true,
      size: { width: 400, height: 300 },
    })
    expect(layout).toMatchObject({
      minimized: true,
      width: 80,
      minWidth: 80,
      rows: [],
    })
    expect(layout.pins.map((pin) => `${pin.direction}:${pin.portId}`).sort()).toEqual([
      'in:advanced',
      'in:required',
      'in:value',
      'out:result',
      'out:value',
    ])
    expect(layout.pins.every((pin) => pin.minimized === true && pin.y === defaultTokens.headerHeight / 2)).toBe(true)
    expect(layout.pins.some((pin) => pin.type.kind === 'list')).toBe(true)
    expect(layout.pins.some((pin) => pin.type.kind === 'union')).toBe(true)
    const compact = withCompactPreviewRegion(layout, defaultTokens)
    expect(compact.preview).toMatchObject({
      compact: true,
      y: defaultTokens.headerHeight + defaultTokens.previewGap,
      height: defaultTokens.rowHeight,
    })
    expect(withPreviewRegion(compact, defaultTokens)).toEqual(compact)
    expect(withTextOutputRegion(compact, defaultTokens, 6).textOutput).toMatchObject({
      y: defaultTokens.headerHeight + defaultTokens.previewGap,
      height: defaultTokens.rowHeight,
    })

    const familySchema = schemaOf([{
      kind: 'group',
      id: 'images',
      value: input('image'),
      keys: { kind: 'numbered', prefix: 'image', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 1,
      maxMembers: 3,
    }])
    const familyNode = { ...nodeData, dynamic: { images: { members: ['image0'], seq: 1 } } }
    // The stored member is connected, so the group offers a spare member.
    const familyLayout = layoutNode(
      familySchema,
      familyNode,
      defaultTokens,
      measure,
      widgetMeasure,
      {
        minimized: true,
        elaborated: elaborateInterface(familySchema, familyNode, { ...EMPTY_CONNECTIVITY, isInputConnected: (port) => port === 'images.image0' }),
      },
    )
    expect(familyLayout.pins).toHaveLength(2)
    expect(familyLayout.pins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        familyMember: true,
        address: { port: 'images.image0' },
      }),
      expect.objectContaining({
        familyMember: true,
        ghost: true,
        address: { port: 'images.image1' },
      }),
    ]))
    expect(familyLayout.pins.every((pin) => pin.minimized === true)).toBe(true)

    const zeroPortLayout = layoutNode(
      schemaOf([], 'Zero'),
      nodeData,
      defaultTokens,
      measure,
      widgetMeasure,
      { minimized: true },
    )
    expect(zeroPortLayout).toMatchObject({ minimized: true, rows: [], pins: [], minWidth: 80 })
  })
})

describe('pins', () => {
  it('every input/output gets a pin centered on its row; widget pins included', () => {
    const l = doLayout([input('a'), widget('w'), output('x')])
    const pinIds = l.pins.map((p) => `${p.direction}:${p.portId}`).sort()
    expect(pinIds).toEqual(['in:a', 'in:w', 'out:w', 'out:x'])
    const row0 = l.rows[0]!
    const pinA = l.pins.find((p) => p.portId === 'a')!
    expect(pinA.y).toBe(row0.y + row0.height / 2)
  })

})

describe('manual size override', () => {
  const items = [input('a'), widget('w'), output('x')]
  const withSize = (width: number, height: number) =>
    layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, { size: { width, height } })

  it('natural layout records its own size as the resize floor', () => {
    const natural = doLayout(items)
    expect(natural.minWidth).toBe(defaultTokens.nodeMinWidth)
    expect(natural.minHeight).toBe(natural.height)
  })

  it('override grows the node; rows keep their positions', () => {
    const natural = doLayout(items)
    const l = withSize(natural.width + 80, natural.height + 60)
    expect(l.width).toBe(natural.width + 80)
    expect(l.height).toBe(natural.height + 60)
    expect(l.rows.map((r) => r.y)).toEqual(natural.rows.map((r) => r.y))
  })

  it('keeps an explicit width authoritative when the schema declares execution arms', () => {
    const schema = { ...schemaOf(items), executionArms: ['native', 'comfyui'] as const }
    const layout = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      size: { width: defaultTokens.nodeMinWidth, height: 1 },
    })

    expect(layout.width).toBe(defaultTokens.nodeMinWidth)
  })

  it('gives one active core.text row all extra height and shifts following rows and pins', () => {
    const items = [
      widget('text', { type: { kind: 'concrete', name: 'STRING' }, widget: { widgetType: 'STRING', options: { multiline: true } } }),
      input('after'),
    ]
    const natural = doLayout(items)
    const grown = layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, {
      size: { width: natural.width, height: natural.height + 61 },
    })
    const multilineHeight = 4 + defaultTokens.multilineText.labelHeight +
      2 * defaultTokens.multilineText.lineHeight + 2 * defaultTokens.multilineText.padding
    expect(natural.rows[0]).toMatchObject({ kind: 'widget', height: multilineHeight })
    expect(grown.rows[0]).toMatchObject({ kind: 'widget', height: multilineHeight + 61 })
    expect(grown.rows[1]!.y - natural.rows[1]!.y).toBe(61)
    expect(grown.pins.find((pin) => pin.portId === 'after')!.y - natural.pins.find((pin) => pin.portId === 'after')!.y).toBe(61)
    expect(grown.minHeight).toBe(natural.height)
  })

  it('shares extra height across active core.text rows in schema order with remainder on the final row', () => {
    const text = (id: string) => widget(id, {
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'STRING', options: { multiline: true } },
    })
    const items = [text('first'), widget('number'), text('second'), input('after')]
    const natural = doLayout(items)
    const grown = layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, {
      size: { width: natural.width, height: natural.height + 61 },
    })
    expect(grown.rows.map((row) => row.height)).toEqual([
      4 + defaultTokens.multilineText.labelHeight + 2 * defaultTokens.multilineText.lineHeight + 2 * defaultTokens.multilineText.padding + 30,
      defaultTokens.rowHeight,
      4 + defaultTokens.multilineText.labelHeight + 2 * defaultTokens.multilineText.lineHeight + 2 * defaultTokens.multilineText.padding + 31,
      defaultTokens.rowHeight,
    ])
    expect(grown.rows[1]!.y - natural.rows[1]!.y).toBe(30)
    expect(grown.rows[2]!.y - natural.rows[2]!.y).toBe(30)
    expect(grown.rows[3]!.y - natural.rows[3]!.y).toBe(61)
  })

  it('does not give manual height surplus to an inactive core.text branch', () => {
    const text = (id: string) => widget(id, {
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'STRING', options: { multiline: true } },
    })
    const items = [
      widget('switch', {
        type: { kind: 'concrete', name: 'BOOLEAN' },
        widget: { widgetType: 'BOOLEAN', options: {} },
      }),
      text('active'),
      text('inactive'),
      input('after'),
    ]
    const schema: NodeSchema = {
      ...schemaOf(items),
      selector: { input: 'switch', branches: { false: 'active', true: 'inactive' } },
    }
    const selected = { ...nodeData, values: { switch: false } }
    const natural = layoutNode(schema, selected, defaultTokens, measure, widgetMeasure)
    const grown = layoutNode(schema, selected, defaultTokens, measure, widgetMeasure, {
      size: { width: natural.width, height: natural.height + 61 },
    })
    const multilineHeight = 4 + defaultTokens.multilineText.labelHeight +
      2 * defaultTokens.multilineText.lineHeight + 2 * defaultTokens.multilineText.padding
    expect(grown.rows[1]).toMatchObject({ kind: 'widget', inputId: 'active', height: multilineHeight + 61 })
    expect(grown.rows[2]).toMatchObject({ kind: 'widget', inputId: 'inactive', height: multilineHeight, inactive: true })
    expect(grown.rows[3]!.y - natural.rows[3]!.y).toBe(61)
    expect(grown.pins.find((pin) => pin.portId === 'after')!.y - natural.pins.find((pin) => pin.portId === 'after')!.y).toBe(61)
  })

  it('leaves core.line and every following row at natural geometry when manually grown', () => {
    const represented = widget('text', {
      type: { kind: 'concrete', name: 'STRING' },
      widget: {
        widgetType: 'STRING', options: { multiline: true },
        representations: {
          default: 'multiline', userSwitchable: true,
          representations: [
            { id: 'line', displayName: 'Single line', widget: { widgetType: 'STRING', options: {} } },
            { id: 'multiline', displayName: 'Multiline', widget: { widgetType: 'STRING', options: { multiline: true } } },
          ],
        },
      },
    })
    const items = [represented, input('after')]
    const natural = layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, {
      widgetRepresentations: { text: 'line' },
    })
    const grown = layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, {
      widgetRepresentations: { text: 'line' },
      size: { width: natural.width, height: natural.height + 61 },
    })
    expect(grown.rows).toEqual(natural.rows)
    expect(grown.pins).toEqual(natural.pins)
    expect(grown.height).toBe(natural.height + 61)
  })

  it('width clamps to nodeMinWidth, height clamps to the natural height', () => {
    const natural = doLayout(items)
    const l = withSize(1, 1)
    expect(l.width).toBe(defaultTokens.nodeMinWidth)
    expect(l.height).toBe(natural.height)
  })

  it('width override may exceed nodeMaxAutoWidth (manual beats auto clamp)', () => {
    const l = withSize(defaultTokens.nodeMaxAutoWidth + 200, 10)
    expect(l.width).toBe(defaultTokens.nodeMaxAutoWidth + 200)
  })
})

describe('in-node preview region', () => {

  it('expands and clears without changing a manually sized multiline row', () => {
    const items = [widget('text', {
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'STRING', options: { multiline: true } },
    })]
    const natural = doLayout(items)
    const base = layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, {
      size: {
        width: natural.width,
        height: natural.height + defaultTokens.previewGap + defaultTokens.previewDefaultHeight +
          defaultTokens.previewCaptionHeight + 90,
      },
    })
    const compact = withCompactPreviewRegion(base, defaultTokens)
    const active = withPreviewRegion(compact, defaultTokens)
    expect(compact.rows[0]!.height).toBe(natural.rows[0]!.height + 90)
    expect(active.rows).toEqual(compact.rows)
    expect(active.height - compact.height).toBe(
      defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight - defaultTokens.rowHeight,
    )
    expect(compact.resizeHeightOffset).toBe(compact.height - active.height)
    expect(active.resizeHeightOffset).toBeUndefined()
    expect(withCompactPreviewRegion(base, defaultTokens)).toEqual(compact)
  })

  it('gives resize surplus to preview only when no active core.text row exists', () => {
    const plain = doLayout([widget('w')])
    const plainRequested = {
      ...plain,
      height: plain.minHeight + defaultTokens.previewGap + defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight + 40,
    }
    expect(withPreviewRegion(plainRequested, defaultTokens).preview?.height).toBe(
      defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight + 40,
    )

    const textItems = [widget('text', {
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'STRING', options: { multiline: true } },
    })]
    const text = doLayout(textItems)
    const textRequested = {
      ...text,
      height: text.minHeight + defaultTokens.previewGap + defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight + 40,
    }
    const grown = withPreviewRegion(textRequested, defaultTokens)
    expect(grown.preview?.height).toBe(defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight)
    expect(grown.rows[0]!.height).toBe(
      4 + defaultTokens.multilineText.labelHeight + 2 * defaultTokens.multilineText.lineHeight +
      2 * defaultTokens.multilineText.padding + 40,
    )
  })
})

describe('in-node text output region', () => {

  it('uses one row for a one-line result and caps long results at six rows', () => {
    const base = doLayout([widget('w')])
    expect(withTextOutputRegion(base, defaultTokens, 1).textOutput?.height).toBe(defaultTokens.rowHeight)
    expect(withTextOutputRegion(base, defaultTokens, 20).textOutput?.height).toBe(defaultTokens.rowHeight * 6)
  })

})

describe('sections', () => {
  const section = (
    id: string,
    rows: NodeSchema['body'],
    over: Partial<Omit<Extract<NodeSchema['body'][number], { kind: 'section' }>, 'kind' | 'id' | 'rows'>> = {},
  ) => ({ kind: 'section' as const, id, rows, ...over })
  const items: NodeSchema['body'] = [
    input('a'),
    section('adv', [widget('w'), input('b', { optional: true })], { displayName: 'Advanced' }),
    output('x'),
  ]
  const layout = (opts: Parameters<typeof layoutNode>[5] = {}) =>
    layoutNode(schemaOf(items), nodeData, defaultTokens, measure, widgetMeasure, opts)

  it('omits hidden compatibility inputs without mutating their stored values', () => {
    const node = { ...nodeData, values: { provider: 'vision.depth.v2' } }
    const l = layoutNode(
      schemaOf([widget('model'), widget('provider', { hidden: true })]),
      node,
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(l.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(['model'])
    expect(l.pins.some((pin) => pin.portId === 'provider')).toBe(false)
    expect(node.values).toEqual({ provider: 'vision.depth.v2' })
  })

  it('hides a choice subtree without hiding sibling controls or losing literals', () => {
    for (const hidden of [false, true]) {
      const schema = schemaOf([widget('prefix'), {
        kind: 'choice',
        id: 'codec',
        required: true,
        shared: [],
        ...(hidden ? { hidden: true as const } : {}),
        options: [{ key: 'h264', rows: [
          widget('crf'),
          { kind: 'choice', id: 'nested', required: true, shared: [], options: [{ key: 'on', rows: [widget('quality')] }] },
        ] }],
      }])
      const node = { ...nodeData, values: { 'codec.crf': 23, 'codec.nested.quality': 7 } }
      const layout = layoutNode(schema, node, defaultTokens, measure, widgetMeasure)
      expect(layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(hidden
        ? ['prefix'] : ['prefix', 'codec', 'codec.crf', 'codec.nested', 'codec.nested.quality'])
      expect(layout.pins.some((pin) => String(pin.portId).startsWith('codec'))).toBe(!hidden)
      expect(node.values).toEqual({ 'codec.crf': 23, 'codec.nested.quality': 7 })
    }
  })

  it('draws Advanced as a box around its rows, a group and its growth row included', () => {
    const nestedOnly: NodeSchema['body'][number] = {
      kind: 'group',
      id: 'items',
      member: [{
        kind: 'group',
        id: 'sub',
        value: input('value', { optional: true }),
        keys: { kind: 'numbered', prefix: 'value', start: 0, pad: 0 },
        grows: 'link',
        minMembers: 0,
        maxMembers: 2,
      }],
      keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 0,
      maxMembers: 2,
    }
    const l = layoutNode(
      schemaOf([section('advanced', [nestedOnly], { displayName: 'Advanced' })]),
      nodeData,
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(l.rows).toMatchObject([
      { kind: 'section', sectionId: 'advanced', box: 'section', collapsed: false },
      { kind: 'section', sectionId: 'group:items', box: 'group', collapsed: false },
      { kind: 'growth', construct: 'items' },
    ])
    expect(l.boxes).toMatchObject([
      { id: 'advanced', depth: 1, first: 0, last: 2 },
      { id: 'group:items', depth: 2, first: 1, last: 2 },
    ])
    const [outer, inner] = l.boxes!
    const growth = l.rows[2]!
    expect(outer!.y).toBe((l.rows[0] as { top: number }).top)
    expect(inner!.x).toBeGreaterThan(outer!.x)
    expect(inner!.y + inner!.height).toBeGreaterThan(growth.y + growth.height - canvasPaintTokens.widget.verticalInset)
    expect(outer!.y + outer!.height).toBeGreaterThan(inner!.y + inner!.height)
  })

  it('keeps declared Advanced members continuous without enclosing primary rows or outputs', () => {
    const l = layoutNode(
      schemaOf([
        input('before'),
        section('advanced', [input('tuning'), input('expert')], { displayName: 'Advanced' }),
        input('after'),
        output('first'),
        output('second'),
      ]),
      nodeData,
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(l.rows).toMatchObject([
      { kind: 'ports', input: { portId: 'before' }, output: { portId: 'first' } },
      { kind: 'ports', input: { portId: 'after' }, output: { portId: 'second' } },
      { kind: 'section', sectionId: 'advanced' },
      { kind: 'ports', input: { portId: 'tuning' } },
      { kind: 'ports', input: { portId: 'expert' } },
    ])
    const [group] = l.boxes!
    expect(group).toMatchObject({ id: 'advanced', first: 2, last: 4 })
    expect(group!.y + group!.height).toBeGreaterThan(l.rows[4]!.y + l.rows[4]!.height - canvasPaintTokens.widget.verticalInset)
    expect(l.pins.find((pin) => pin.portId === 'second')!.y).toBeLessThan(group!.y)
  })

  it('keeps connected Advanced sockets as collapsed disclosure proxies', () => {
    const schema = schemaOf([section('advanced', [input('socket'), widget('value')], { displayName: 'Advanced', collapsedByDefault: true })])
    const l = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      connectedPorts: new Set(['in:socket', 'in:value', 'out:value']),
    })
    expect(l.rows).toMatchObject([{ kind: 'section', collapsed: true }])
    const center = (l.rows[0] as { top: number }).top + (defaultTokens.rowHeight - canvasPaintTokens.widget.verticalInset * 2) / 2
    expect(l.pins).toMatchObject([
      { portId: 'socket', direction: 'in', collapsedSection: 'advanced' },
      { portId: 'value', direction: 'in', collapsedSection: 'advanced' },
      { portId: 'value', direction: 'out', widgetTap: true, collapsedSection: 'advanced' },
    ])
    // Two pins at one end overlap in a cluster around the closed row's
    // middle, 7 apart; one pin sits on the middle.
    expect(l.pins.map((pin) => pin.y)).toEqual([center - 3.5, center + 3.5, center])
    expect(l.boxes).toMatchObject([{ id: 'advanced', closed: true, first: 0, last: 0 }])
  })

  it('keeps declared Advanced outputs inside the enclosure and proxies connected outputs when collapsed', () => {
    const schema = schemaOf([
      input('primary'),
      section('advanced', [input('tuning'), output('diagnostic')], { displayName: 'Advanced' }),
      output('result'),
    ])
    const expanded = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure)
    expect(expanded.rows).toMatchObject([
      { kind: 'ports', input: { portId: 'primary' }, output: { portId: 'result' } },
      { kind: 'section', sectionId: 'advanced', collapsed: false },
      {
        kind: 'ports',
        input: { portId: 'tuning' },
        output: { portId: 'diagnostic' },
      },
    ])
    expect(expanded.boxes).toMatchObject([{ id: 'advanced', first: 1, last: 2 }])
    expect(expanded.pins.filter((pin) => ['tuning', 'diagnostic'].includes(pin.portId))).toHaveLength(2)

    const collapsed = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { advanced: true },
      connectedPorts: new Set(['in:tuning', 'out:diagnostic']),
    })
    expect(collapsed.rows).toMatchObject([
      { kind: 'ports', input: { portId: 'primary' }, output: { portId: 'result' } },
      { kind: 'section', sectionId: 'advanced', collapsed: true },
    ])
    expect(collapsed.pins.map((pin) => pin.portId)).toEqual(['primary', 'result', 'tuning', 'diagnostic'])
    expect(collapsed.pins.slice(2)).toMatchObject([
      { direction: 'in', collapsedSection: 'advanced' },
      { direction: 'out', collapsedSection: 'advanced' },
    ])
    expect(collapsed.boxes).toMatchObject([{ id: 'advanced', closed: true }])
  })

  it('keeps Advanced bounds aligned when a primary text row is resized', () => {
    const schema = schemaOf([
      widget('prompt', { widget: { widgetType: 'STRING', options: { multiline: true } } }),
      section('advanced', [widget('tuning')], { displayName: 'Advanced' }),
    ])
    const base = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { advanced: false },
    })
    const resized = projectNodeLayoutHeight(base, base.height + 48, defaultTokens)
    expect(resized.boxes![0]!.y).toBe(base.boxes![0]!.y + 48)
    expect(resized.boxes![0]!.height).toBe(base.boxes![0]!.height)
  })

  it('emits a section header row at its declared position', () => {
    const l = layout()
    expect(l.rows.map((r) => r.kind)).toEqual(['ports', 'section', 'widget', 'ports'])
    expect(l.rows[1]).toMatchObject({ kind: 'section', sectionId: 'adv', label: 'Advanced', collapsed: false })
  })

  it('expanded sections show member rows and pins', () => {
    const l = layout()
    const pinIds = l.pins.map((p) => `${p.direction}:${p.portId}`).sort()
    expect(pinIds).toEqual(['in:a', 'in:b', 'in:w', 'out:w', 'out:x'])
  })

  it('collapsing hides member rows and unconnected member pins', () => {
    const l = layout({ sectionOverrides: { adv: true } })
    // Output x pairs into input a's socket row (top-down pairing), so hiding
    // b's row leaves just the paired row and the section header.
    expect(l.rows.map((r) => r.kind)).toEqual(['ports', 'section'])
    expect(l.rows[1]).toMatchObject({ kind: 'section', collapsed: true })
    const pinIds = l.pins.map((p) => `${p.direction}:${p.portId}`).sort()
    expect(pinIds).toEqual(['in:a', 'out:x'])
  })

  it('connected members of a collapsed section keep pins anchored on the header row', () => {
    const l = layout({ sectionOverrides: { adv: true }, connectedPorts: new Set(['in:b']) })
    const pinB = l.pins.find((p) => p.portId === 'b')!
    const header = l.rows.find((r) => r.kind === 'section')!
    expect(pinB.y).toBe(header.y + header.height / 2)
    expect(pinB.optional).toBe(true)
    // The unconnected member stays hidden.
    expect(l.pins.find((p) => p.portId === 'w')).toBeUndefined()
  })

  it('collapse reduces the natural height and the resize floor', () => {
    const open = layout()
    const closed = layout({ sectionOverrides: { adv: true } })
    expect(closed.height).toBeLessThan(open.height)
    expect(closed.minHeight).toBe(closed.height)
  })

  it('collapsedByDefault applies without an override and an override can expand it', () => {
    const defaultItems: NodeSchema['body'] = [
      section('adv', [widget('w')], { displayName: 'Advanced', collapsedByDefault: true }),
      output('x'),
    ]
    const closed = layoutNode(schemaOf(defaultItems), nodeData, defaultTokens, measure, widgetMeasure)
    expect(closed.rows.map((r) => r.kind)).toEqual(['section', 'ports'])
    const open = layoutNode(schemaOf(defaultItems), nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { adv: false },
    })
    expect(open.rows.map((r) => r.kind)).toEqual(['section', 'widget', 'ports'])
  })

  it('members of an UNDECLARED section render normally (schema bug, not a hole)', () => {
    const buggy: NodeSchema['body'] = [widget('w', { section: 'ghost' }), output('x')]
    const l = layoutNode(schemaOf(buggy), nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { ghost: true },
    })
    expect(l.rows.map((r) => r.kind)).toEqual(['widget', 'ports'])
  })

  it('collapsed sections count hidden MODIFIED widget values (derived, never stored)', () => {
    const tunable: NodeSchema['body'] = [
      section('adv', [
        widget('w', { widget: { widgetType: 'INT', options: {}, default: 20 } }),
        widget('v', { widget: { widgetType: 'INT', options: {}, default: 5 } }),
      ], { displayName: 'Advanced' }),
      output('x'),
    ]
    const withValues = (values: NodeData['values'], collapsed = true) =>
      layoutNode(
        schemaOf(tunable),
        { ...nodeData, values },
        defaultTokens,
        measure,
        widgetMeasure,
        collapsed ? { sectionOverrides: { adv: true } } : {},
      ).rows.find((r) => r.kind === 'section')!

    // Both widgets off-default: count 2. One: count 1.
    expect(withValues({ w: 99, v: 1 })).toMatchObject({ hiddenModified: 2 })
    expect(withValues({ w: 99 })).toMatchObject({ hiddenModified: 1 })
    // At defaults (explicit or absent keys): no indicator field at all.
    expect(withValues({ w: 20 })).not.toHaveProperty('hiddenModified')
    expect(withValues({})).not.toHaveProperty('hiddenModified')
    // Expanded: the widgets are visible, nothing is "hidden modified".
    expect(withValues({ w: 99, v: 1 }, false)).not.toHaveProperty('hiddenModified')
  })

  it('controller widgets never trip the hidden-modified indicator', () => {
    const items: NodeSchema['body'] = [
      section('adv', [
        widget('seed', {
          widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
        }),
      ]),
      output('x'),
    ]
    const row = layoutNode(
      schemaOf(items),
      { ...nodeData, values: { seed: 123456 } },
      defaultTokens,
      measure,
      widgetMeasure,
      { sectionOverrides: { adv: true } },
    ).rows.find((r) => r.kind === 'section')!
    expect(row).not.toHaveProperty('hiddenModified')
  })

  it('hidden outputs are excluded from row pairing', () => {
    const outItems: NodeSchema['body'] = [
      input('a'),
      section('outs', [output('hidden1')]),
      output('visible'),
    ]
    const l = layoutNode(schemaOf(outItems), nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { outs: true },
    })
    const portRows = l.rows.filter((r) => r.kind === 'ports')
    expect(portRows).toHaveLength(1)
    expect(portRows[0]).toMatchObject({ input: { portId: 'a' }, output: { portId: 'visible' } })
  })
})

describe('v14 COMBO layout', () => {
  const comboWidget = (id: string, over: Partial<InputSpec> = {}): InputSpec =>
    input(id, { type: { kind: 'concrete', name: 'COMBO' }, widget: { widgetType: 'COMBO', options: { options: ['a', 'b'] } }, ...over })
  const comboOutput = (id: string): OutputSpec =>
    ({ kind: 'output', id, type: { kind: 'concrete', name: 'COMBO' } })

  it('preserves COMBO identity on widget pins, taps, and output slots', () => {
    const l = doLayout([comboWidget('forced', { forceInput: true }), comboWidget('backed'), comboOutput('choice')])
    expect(l.pins.filter((p) => ['forced', 'backed', 'choice'].includes(p.portId)).every((pin) => JSON.stringify(pin.type).includes('COMBO'))).toBe(true)
    expect(l.pins.find((p) => p.portId === 'backed' && p.direction === 'out')).toMatchObject({ widgetTap: true, staticWidgetTap: true, type: { name: 'COMBO' } })
    expect(l.rows.find((r) => r.kind === 'ports' && r.output?.portId === 'choice')).toMatchObject({ output: { type: { name: 'COMBO' } } })
  })

  it("does not mark a choice's dropdown or chosen-option widget taps as static", () => {
    const leaf = comboWidget('leaf')
    const schema = schemaOf([{ kind: 'choice', id: 'combo', required: true, shared: [], options: [{ key: 'a', rows: [leaf] }] }])
    const elaborated = elaborateInterface(schema, nodeData)
    const layout = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, { elaborated })
    const taps = layout.pins.filter((pin) => pin.widgetTap === true)
    expect(taps.map((pin) => pin.portId)).toEqual(['combo', 'combo.leaf'])
    expect(taps.every((pin) => pin.staticWidgetTap !== true)).toBe(true)
  })
})
