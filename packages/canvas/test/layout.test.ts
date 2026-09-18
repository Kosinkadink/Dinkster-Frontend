/**
 * Row-model layout tests. These pin the architecture's committed layout
 * rules: paired input/output lines, widgets own full rows, overflow outputs
 * get dedicated rows, auto-size is a pure function of the row stack.
 */
import { describe, expect, it } from 'vitest'
import type { InputSpec, NodeData, NodeSchema, OutputSpec } from '@dinkster/core'
import { asDynamicMemberId, asNodeId, elaborateInterface } from '@dinkster/core'
import { layoutNode, projectNodeLayoutHeight, widgetChromeRect, withCompactPreviewRegion, withPreviewRegion, withTextOutputRegion, type TextMeasurer, type WidgetMeasure } from '../src/layout.js'
import { defaultTokens } from '../src/tokens.js'

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

const schemaOf = (items: NodeSchema['items'], displayName = 'Test'): NodeSchema => ({
  type: 'Test',
  displayName,
  category: 'test',
  source: 'v3',
  items,
  isOutputNode: false,
})
const nodeData: NodeData = { id: asNodeId('n0'), type: 'Test', values: {} }

const doLayout = (items: NodeSchema['items'], displayName?: string) =>
  layoutNode(schemaOf(items, displayName), nodeData, defaultTokens, measure, widgetMeasure)

describe('widget chrome geometry', () => {
  it('applies the shared vertical inset and radius to compact and flexible rows', () => {
    expect(widgetChromeRect(109.5, 120, 121, 24)).toEqual({
      x: 109.5, y: 122, width: 121, height: 20, radius: 4,
    })
    expect(widgetChromeRect(109.5, 120, 121, 96)).toEqual({
      x: 109.5, y: 122, width: 121, height: 92, radius: 4,
    })
  })
})

describe('conditional widget groups', () => {
  const schema = { ...schemaOf([widget('mode', { widget: { widgetType: 'STRING', options: {}, default: 'basic' } }), widget('basic'), widget('advanced')]), widgetGroups: [{ input: 'mode', values: ['basic'], members: ['basic'] }, { input: 'mode', values: ['advanced'], members: ['advanced'] }] }

  it('changes generic rows without deleting stored values', () => {
    const node = { ...nodeData, values: { mode: 'advanced', basic: 4, advanced: 8 } }
    expect(layoutNode(schema, node, defaultTokens, measure, widgetMeasure).rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(['mode', 'advanced'])
    expect(node.values).toEqual({ mode: 'advanced', basic: 4, advanced: 8 })
  })

  it('keeps a connected controlled widget rendered', () => {
    const layout = layoutNode(schema, { ...nodeData, values: { mode: 'basic' } }, defaultTokens, measure, widgetMeasure, { connectedPorts: new Set(['in:advanced']) })
    expect(layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(['mode', 'basic', 'advanced'])
  })
})

describe('pairing', () => {
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

  it('carries source filename bindings on elaborated widget rows', () => {
    const source = widget('source', {
      type: { kind: 'concrete', name: 'dinkster.asset' },
      widget: { widgetType: 'ASSET', options: { accept: ['image/*'] }, kind: 'media/image', allowUpload: true },
      sourceFilename: { kind: 'media/image', category: 'input' },
    })
    const schema = schemaOf([input('choice', {
      dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [source] }] },
    })])
    const layout = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure)
    expect(layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'choice.[a].source'))
      .toMatchObject({ sourceFilename: { kind: 'media/image', category: 'input' } })
  })

  it('insets widget chrome past pin circles while preserving useful minimum width', () => {
    const l = doLayout([widget('w')])
    const row = l.rows[0]!
    expect(row).toMatchObject({ kind: 'widget', inset: defaultTokens.pinRadius + 4 })
    expect(l.width).toBeGreaterThanOrEqual(defaultTokens.nodeMinWidth)
    if (row.kind === 'widget') expect(l.width - row.inset * 2).toBe(121)
  })

  it('forceInput widget inputs are pairable socket rows', () => {
    const l = doLayout([widget('seed', { forceInput: true }), output('x')])
    expect(l.rows).toHaveLength(1)
    expect(l.rows[0]).toMatchObject({ kind: 'ports', input: { portId: 'seed' }, output: { portId: 'x' } })
  })

  it.each([
    ['INT', 'core.int'],
    ['FLOAT', 'core.float'],
    ['BOOLEAN', 'core.boolean'],
  ] as const)('renders forceInput wire-15 %s family members as pairable socket rows', (widgetType, typeName) => {
    const family = input('values', {
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        materialization: 'wire15',
        naming: { kind: 'names', names: ['a', 'b'], min: 1 },
        template: [input('value', {
          type: { kind: 'concrete', name: typeName },
          widget: { widgetType, options: {} },
          forceInput: true,
        })],
      },
    })
    const layout = doLayout([family, output('x'), output('y')])
    expect(layout.rows).toHaveLength(2)
    expect(layout.rows[0]).toMatchObject({
      kind: 'ports',
      input: { portId: 'values.a', familyMember: true, type: { kind: 'concrete', name: typeName } },
      output: { portId: 'x' },
    })
    expect(layout.rows[1]).toMatchObject({
      kind: 'ports',
      input: { portId: 'values.b', familyMember: true, ghost: true, materialize: expect.any(Array) },
      output: { portId: 'y' },
    })
    expect(layout.rows.some((row) => row.kind === 'widget')).toBe(false)
    expect(layout.pins.filter((pin) => pin.direction === 'in')).toHaveLength(2)
    expect(layout.pins.filter((pin) => pin.direction === 'in').every((pin) => pin.widgetBacked === undefined)).toBe(true)
    expect(layout.pins.filter((pin) => pin.direction === 'in').every((pin) => pin.familyMember === true)).toBe(true)
    expect(layout.pins.some((pin) => pin.widgetTap === true)).toBe(false)
  })

  it('marks persisted and trailing Autogrow inputs with family identity', () => {
    const family = input('images', {
      dynamic: {
        kind: 'autogrow',
        naming: { kind: 'prefix', prefix: 'image', min: 1, max: 3 },
        template: [input('image')],
      },
    })
    const layout = layoutNode(
      schemaOf([family]),
      { ...nodeData, dynamic: { images: { members: ['m0'], seq: 1 } } },
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(layout.pins).toHaveLength(2)
    expect(layout.pins[0]).toMatchObject({ familyMember: true, address: { members: ['m0'] } })
    expect(layout.pins[0]!.ghost).toBeUndefined()
    expect(layout.pins[1]).toMatchObject({ familyMember: true, ghost: true, address: { members: ['m1'] } })
  })

  it('derives a numeric literal for a wire-15 scalar union while retaining its socket type', () => {
    const scalar = {
      kind: 'union' as const,
      names: ['core.float', 'core.int', 'core.boolean'],
    }
    const family = input('values', {
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        materialization: 'wire15',
        naming: { kind: 'names', names: ['a', 'b'], min: 1 },
        template: [input('value', { type: scalar })],
      },
    })
    const layout = doLayout([family])
    const rows = layout.rows.filter((row) => row.kind === 'widget')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      familyLiteral: true,
      type: scalar,
      spec: { widgetType: 'FLOAT', options: {} },
    })
    expect(layout.pins[0]).toMatchObject({ direction: 'in', type: scalar })
    expect(layout.pins[0]!.widgetBacked).toBeUndefined()
    expect(layout.pins.some((pin) => pin.direction === 'out')).toBe(false)
  })

  it('uses a decimal editor for a named integer/boolean union', () => {
    const scalar = {
      kind: 'union' as const,
      names: ['core.int', 'core.boolean'],
    }
    const family = input('values', {
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        materialization: 'wire15',
        naming: { kind: 'names', names: ['a'], min: 1 },
        template: [input('value', { type: scalar })],
      },
    })
    const layout = doLayout([family])
    expect(layout.rows[0]).toMatchObject({
      kind: 'widget',
      familyLiteral: true,
      type: scalar,
      spec: { widgetType: 'FLOAT', options: {} },
    })
  })

  it('keeps prefix family widgets as their existing socket rows', () => {
    const family = input('values', {
      type: { kind: 'wildcard' },
      dynamic: {
        kind: 'autogrow',
        materialization: 'wire15',
        naming: { kind: 'prefix', prefix: 'value', min: 1, max: 3 },
        template: [input('value', {
          type: { kind: 'concrete', name: 'core.int' },
          widget: { widgetType: 'INT', options: {} },
          forceInput: true,
        })],
      },
    })
    const layout = doLayout([family])
    expect(layout.rows.filter((row) => row.kind === 'widget')).toEqual([])
    expect(layout.rows.filter((row) => row.kind === 'ports').map((row) => row.input?.portId))
      .toEqual(['values.m0', 'values.m1'])
  })

  it('keeps wire-15 branch force-input widgets as socket rows', () => {
    const mode = input('mode', {
      dynamic: {
        kind: 'dynamicCombo',
        materialization: 'wire15',
        options: [{
          key: 'active',
          inputs: [input('value', {
            type: { kind: 'concrete', name: 'core.int' },
            widget: { widgetType: 'INT', options: {} },
            forceInput: true,
          })],
        }],
      },
    })
    const layout = doLayout([mode])
    expect(layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)).toEqual(['mode'])
    expect(layout.rows.find((row) => row.kind === 'ports'))
      .toMatchObject({ input: { portId: 'mode.value' } })
  })

  it('renders wire-16 lazy absent and true ordinary inputs as identical sockets', () => {
    const absent = doLayout([input('value'), output('x')])
    const lazy = doLayout([input('value', { lazy: true }), output('x')])
    expect(lazy).toEqual(absent)
    expect(lazy.rows).toEqual([
      expect.objectContaining({ kind: 'ports', input: expect.objectContaining({ portId: 'value' }) }),
    ])
  })

  it('renders output preview absent and true with identical layout', () => {
    const absent = doLayout([input('value'), output('result')])
    const preview = doLayout([input('value'), output('result', { preview: true })])
    expect(preview).toEqual(absent)
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
    type: { kind: 'concrete', name: 'core.string' },
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
      type: { kind: 'concrete', name: 'core.string' },
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

  it('retains dynamic API names for schema completion sources', () => {
    const dynamic = schemaOf([widget('text', {
      type: { kind: 'concrete', name: 'core.string' },
      widget: { widgetType: 'STRING', options: {} },
    })])
    const row = layoutNode(
      dynamic,
      nodeData,
      defaultTokens,
      measure,
      widgetMeasure,
      {
        elaborated: {
          items: [{
            kind: 'input',
            address: { port: 'values.value', members: [asDynamicMemberId('m0')] },
            apiName: 'values.value0',
            spec: widget('values.value#m0', {
              type: { kind: 'concrete', name: 'core.string' },
              widget: { widgetType: 'STRING', options: {} },
            }),
            origin: { kind: 'member', construct: 'values', ordinal: 0, wire15Naming: 'prefix' },
          }],
          submissionValues: [],
          diagnostics: [],
        },
      },
    ).rows[0]
    expect(row).toMatchObject({ kind: 'widget', apiName: 'values.value0' })
  })
})

describe('document-time selector branch display', () => {
  const selectorSchema = (): NodeSchema => ({
    ...schemaOf([
      widget('switch', { type: { kind: 'concrete', name: 'core.boolean' }, widget: { widgetType: 'BOOLEAN', options: {} } }),
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

  it('projects selector branches by raw port identity when elaborated ids are escaped', () => {
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
      type: { kind: 'concrete', name: 'core.combo' },
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

  it('measures renamed titles as italic and equal-name overrides as normal', () => {
    const roles: string[] = []
    const record: TextMeasurer = (_text, role) => { roles.push(role); return 20 }
    const schema = schemaOf([], 'Original')
    const renamed = layoutNode(schema, { ...nodeData, title: 'Custom' }, defaultTokens, record, widgetMeasure)
    expect(renamed.titleRenamed).toBe(true)
    expect(roles).toContain('renamedTitle')

    roles.length = 0
    const same = layoutNode(schema, { ...nodeData, title: 'Original' }, defaultTokens, record, widgetMeasure)
    expect(same.titleRenamed).toBe(false)
    expect(roles).toContain('title')
    expect(roles).not.toContain('renamedTitle')
  })

  it('layout is deterministic (pure function of inputs)', () => {
    const items = [input('a'), widget('w'), output('x')]
    expect(doLayout(items)).toEqual(doLayout(items))
  })

  it('minimizes to title width with an 80px floor while retaining every endpoint', () => {
    const schema = schemaOf([
      input('required', { type: { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } } }),
      widget('value'),
      input('advanced', { advanced: true }),
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

    const family = input('images', {
      dynamic: {
        kind: 'autogrow',
        naming: { kind: 'prefix', prefix: 'image', min: 1, max: 3 },
        template: [input('image')],
      },
    })
    const familyLayout = layoutNode(
      schemaOf([family]),
      { ...nodeData, dynamic: { images: { members: ['m0'], seq: 1 } } },
      defaultTokens,
      measure,
      widgetMeasure,
      { minimized: true },
    )
    expect(familyLayout.pins).toHaveLength(2)
    expect(familyLayout.pins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        familyMember: true,
        address: expect.objectContaining({ members: ['m0'] }),
      }),
      expect.objectContaining({
        familyMember: true,
        ghost: true,
        address: expect.objectContaining({ members: ['m1'] }),
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

  it('marks only non-forced widget input pins as widget-backed and preserves their optionality', () => {
    const l = doLayout([
      input('socket'),
      widget('widget'),
      widget('optionalWidget', { optional: true }),
      widget('forced', { forceInput: true }),
      output('output'),
    ])
    expect(l.pins.find((p) => p.portId === 'widget')).toMatchObject({ direction: 'in', widgetBacked: true })
    expect(l.pins.find((p) => p.portId === 'optionalWidget')).toMatchObject({
      direction: 'in', widgetBacked: true, optional: true,
    })
    expect(l.pins.find((p) => p.portId === 'socket')?.widgetBacked).toBeUndefined()
    expect(l.pins.find((p) => p.portId === 'forced')?.widgetBacked).toBeUndefined()
    expect(l.pins.find((p) => p.portId === 'output')?.widgetBacked).toBeUndefined()
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
      widget('text', { type: { kind: 'concrete', name: 'core.string' }, widget: { widgetType: 'STRING', options: { multiline: true } } }),
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
      type: { kind: 'concrete', name: 'core.string' },
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
      type: { kind: 'concrete', name: 'core.string' },
      widget: { widgetType: 'STRING', options: { multiline: true } },
    })
    const items = [
      widget('switch', {
        type: { kind: 'concrete', name: 'core.boolean' },
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
      type: { kind: 'concrete', name: 'core.string' },
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
  it('reserves a one-line preview affordance before content exists', () => {
    const base = doLayout([widget('w')])
    const layout = withCompactPreviewRegion(base, defaultTokens)
    expect(layout.height).toBe(base.height + defaultTokens.previewGap + defaultTokens.rowHeight)
    expect(layout.preview).toEqual({
      x: defaultTokens.padX,
      y: base.rows[0]!.y + base.rows[0]!.height + defaultTokens.previewGap,
      width: base.width - defaultTokens.padX * 2,
      height: defaultTokens.rowHeight,
      compact: true,
    })
  })

  it('expands and clears without changing a manually sized multiline row', () => {
    const items = [widget('text', {
      type: { kind: 'concrete', name: 'core.string' },
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

  it('keeps the compact surface to one line while resizing a preview-only node', () => {
    const base = doLayout([widget('w')])
    const compact = withCompactPreviewRegion(base, defaultTokens)
    const resized = projectNodeLayoutHeight(compact, compact.height + 40, defaultTokens)
    expect(resized.preview?.height).toBe(defaultTokens.rowHeight)
    expect(resized.preview?.y).toBe(compact.preview!.y + 40)
    const active = withPreviewRegion(resized, defaultTokens)
    expect(active.height).toBe(resized.height - resized.resizeHeightOffset!)
    expect(active.preview?.y).toBe(compact.preview!.y)
    expect(active.preview?.height).toBe(
      defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight + 40,
    )
  })

  it('appends an inner-width region after rows and grows the natural height', () => {
    const base = doLayout([widget('w')])
    const layout = withPreviewRegion(base, defaultTokens)
    expect(layout.height).toBe(
      base.height + defaultTokens.previewGap + defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight,
    )
    // The panel opens at its default height but can be shrunk to the floor.
    expect(layout.minHeight).toBe(
      base.minHeight + defaultTokens.previewGap + defaultTokens.previewMinHeight + defaultTokens.previewCaptionHeight,
    )
    expect(layout.preview).toEqual({
      x: defaultTokens.padX,
      y: base.rows[0]!.y + base.rows[0]!.height + defaultTokens.previewGap,
      width: base.width - defaultTokens.padX * 2,
      height: defaultTokens.previewDefaultHeight + defaultTokens.previewCaptionHeight,
    })
  })

  it('lets a preview-only node shrink the panel to its floor', () => {
    const base = doLayout([widget('w')])
    const floor = base.minHeight + defaultTokens.previewGap +
      defaultTokens.previewMinHeight + defaultTokens.previewCaptionHeight
    // A persisted size below the floor clamps to it instead of the default.
    const layout = withPreviewRegion({ ...base, height: base.minHeight + 1 }, defaultTokens)
    expect(layout.height).toBe(floor)
    expect(layout.minHeight).toBe(floor)
    expect(layout.preview?.height).toBe(
      defaultTokens.previewMinHeight + defaultTokens.previewCaptionHeight,
    )
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
      type: { kind: 'concrete', name: 'core.string' },
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
  it('appends a six-row result region after body rows', () => {
    const base = doLayout([widget('w')])
    const layout = withTextOutputRegion(base, defaultTokens)
    expect(layout.height).toBeGreaterThan(base.height)
    expect(layout.minHeight).toBe(layout.height)
    expect(layout.textOutput).toEqual({
      x: defaultTokens.padX,
      y: base.rows[0]!.y + base.rows[0]!.height + defaultTokens.previewGap,
      width: base.width - defaultTokens.padX * 2,
      height: defaultTokens.rowHeight * 6,
    })
  })

  it('uses one row for a one-line result and caps long results at six rows', () => {
    const base = doLayout([widget('w')])
    expect(withTextOutputRegion(base, defaultTokens, 1).textOutput?.height).toBe(defaultTokens.rowHeight)
    expect(withTextOutputRegion(base, defaultTokens, 20).textOutput?.height).toBe(defaultTokens.rowHeight * 6)
  })

  it('maps compact-capable text resizing to the same expanded size request', () => {
    const compact = withCompactPreviewRegion(doLayout([widget('w')]), defaultTokens)
    const text = withTextOutputRegion(compact, defaultTokens, 1)
    expect(text.height).toBe(compact.height)
    expect(text.resizeHeightOffset).toBe(
      defaultTokens.rowHeight - defaultTokens.previewDefaultHeight - defaultTokens.previewCaptionHeight,
    )
  })
})

describe('sections', () => {
  const section = (id: string, over: Partial<Extract<NodeSchema['items'][number], { kind: 'section' }>> = {}) =>
    ({ kind: 'section', id, ...over }) as const
  const items: NodeSchema['items'] = [
    input('a'),
    section('adv', { displayName: 'Advanced' }),
    widget('w', { section: 'adv' }),
    input('b', { section: 'adv', optional: true }),
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

  it('groups unsectioned advanced inputs under a collapsed Advanced row', () => {
    const schema = schemaOf([widget('prompt'), widget('service', { advanced: true })])
    const collapsed = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure)
    expect(collapsed.rows).toMatchObject([
      { kind: 'widget', inputId: 'prompt' },
      { kind: 'section', sectionId: 'advanced', label: 'Advanced', collapsed: true },
    ])
    expect(collapsed.pins.some((pin) => pin.portId === 'service')).toBe(false)

    const expanded = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { advanced: false },
    })
    expect(expanded.rows).toMatchObject([
      { kind: 'widget', inputId: 'prompt' },
      { kind: 'section', sectionId: 'advanced', collapsed: false },
      { kind: 'widget', inputId: 'service' },
    ])
    expect(expanded.advancedGroup).toEqual({
      y: expanded.rows[1]!.y,
      height: expanded.rows[1]!.height + expanded.rows[2]!.height,
    })
  })

  it('keeps generated Advanced after ordinary inputs and outputs in both states', () => {
    const schema = schemaOf([
      widget('first'),
      input('advancedSocket', { advanced: true }),
      widget('last'),
      widget('advancedWidget', { advanced: true }),
      output('result'),
    ])
    const collapsed = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure)
    const l = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { advanced: false },
      size: { width: defaultTokens.nodeMinWidth, height: 0 },
    })
    const rowIdentity = (row: typeof l.rows[number]): string =>
      row.kind === 'widget'
        ? row.inputId
        : row.kind === 'ports'
          ? row.input?.portId ?? row.output?.portId ?? 'ports'
          : row.kind
    expect(collapsed.rows.map(rowIdentity)).toEqual(['first', 'last', 'result', 'section'])
    expect(l.rows.map(rowIdentity)).toEqual([
      'first', 'last', 'result', 'section', 'advancedSocket', 'advancedWidget',
    ])
    expect(l.rows[4]).toMatchObject({ kind: 'ports', input: { portId: 'advancedSocket' } })
    expect((l.rows[4] as { output?: unknown }).output).toBeUndefined()
    const group = l.advancedGroup!
    expect(group.y).toBe(l.rows[3]!.y)
    expect(group.y).toBe(collapsed.rows[3]!.y)
    expect(group.y + group.height).toBe(l.rows[5]!.y + l.rows[5]!.height)
    expect(l.pins.find((pin) => pin.portId === 'result')!.y).toBeLessThan(group.y)
    expect(l.width).toBe(defaultTokens.nodeMinWidth)
    expect(l.pins.filter((pin) => ['advancedSocket', 'advancedWidget'].includes(pin.portId))).toHaveLength(3)
  })

  it('includes an Advanced dynamic-family growth row in the enclosure', () => {
    const nestedOnly = input('items', {
      section: 'advanced',
      dynamic: {
        kind: 'autogrow',
        template: [input('sub', {
          optional: true,
          dynamic: {
            kind: 'autogrow',
            template: [input('value', { optional: true })],
            naming: { kind: 'prefix', prefix: 'value', min: 0, max: 2 },
          },
        })],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 2 },
      },
    })
    const l = layoutNode(
      schemaOf([section('advanced', { displayName: 'Advanced' }), nestedOnly]),
      nodeData,
      defaultTokens,
      measure,
      widgetMeasure,
    )
    expect(l.rows).toMatchObject([
      { kind: 'section', sectionId: 'advanced', collapsed: false },
      { kind: 'growth', construct: 'items' },
    ])
    expect(l.advancedGroup).toEqual({
      y: l.rows[0]!.y,
      height: l.rows[0]!.height + l.rows[1]!.height,
    })
  })

  it('keeps declared Advanced members continuous without enclosing primary rows or outputs', () => {
    const l = layoutNode(
      schemaOf([
        input('before'),
        section('advanced', { displayName: 'Advanced' }),
        input('tuning', { section: 'advanced' }),
        input('after'),
        input('expert', { section: 'advanced' }),
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
    const group = l.advancedGroup!
    expect(group.y).toBe(l.rows[2]!.y)
    expect(group.y + group.height).toBe(l.rows[4]!.y + l.rows[4]!.height)
    expect(l.pins.find((pin) => pin.portId === 'second')!.y).toBeLessThan(group.y)
  })

  it('keeps connected Advanced sockets as collapsed disclosure proxies', () => {
    const schema = schemaOf([input('socket', { advanced: true }), widget('value', { advanced: true })])
    const l = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      connectedPorts: new Set(['in:socket', 'in:value', 'out:value']),
    })
    expect(l.rows).toMatchObject([{ kind: 'section', collapsed: true }])
    const header = l.rows[0]!
    expect(l.pins).toMatchObject([
      { portId: 'socket', direction: 'in', collapsedSection: 'advanced' },
      { portId: 'value', direction: 'in', collapsedSection: 'advanced' },
      { portId: 'value', direction: 'out', widgetTap: true, collapsedSection: 'advanced' },
    ])
    expect(l.pins.every((pin) => pin.y === header.y + header.height / 2)).toBe(true)
    expect(l.advancedGroup).toBeUndefined()
  })

  it('keeps declared Advanced outputs inside the enclosure and proxies connected outputs when collapsed', () => {
    const schema = schemaOf([
      input('primary'),
      section('advanced', { displayName: 'Advanced' }),
      input('tuning', { section: 'advanced' }),
      output('diagnostic', { section: 'advanced' }),
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
    expect(expanded.advancedGroup).toEqual({
      y: expanded.rows[1]!.y,
      height: expanded.rows[1]!.height + expanded.rows[2]!.height,
    })
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
    expect(collapsed.advancedGroup).toBeUndefined()
  })

  it('keeps Advanced bounds aligned when a primary text row is resized', () => {
    const schema = schemaOf([
      widget('prompt', { widget: { widgetType: 'STRING', options: { multiline: true } } }),
      widget('tuning', { advanced: true }),
    ])
    const base = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { advanced: false },
    })
    const resized = projectNodeLayoutHeight(base, base.height + 48, defaultTokens)
    expect(resized.advancedGroup).toEqual({
      y: base.advancedGroup!.y + 48,
      height: base.advancedGroup!.height,
    })
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
    const defaultItems: NodeSchema['items'] = [
      section('adv', { displayName: 'Advanced', collapsedByDefault: true }),
      widget('w', { section: 'adv' }),
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
    const buggy: NodeSchema['items'] = [widget('w', { section: 'ghost' }), output('x')]
    const l = layoutNode(schemaOf(buggy), nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { ghost: true },
    })
    expect(l.rows.map((r) => r.kind)).toEqual(['widget', 'ports'])
  })

  it('collapsed sections count hidden MODIFIED widget values (derived, never stored)', () => {
    const tunable: NodeSchema['items'] = [
      section('adv', { displayName: 'Advanced' }),
      widget('w', { section: 'adv', widget: { widgetType: 'INT', options: {}, default: 20 } }),
      widget('v', { section: 'adv', widget: { widgetType: 'INT', options: {}, default: 5 } }),
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
    const items: NodeSchema['items'] = [
      section('adv', {}),
      widget('seed', {
        section: 'adv',
        widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
      }),
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
    const outItems: NodeSchema['items'] = [
      input('a'),
      section('outs', {}),
      output('hidden1'),
      output('visible'),
    ]
    // Attach the first output to the section.
    const patched = outItems.map((it) =>
      it.kind === 'output' && it.id === 'hidden1' ? { ...it, section: 'outs' } : it,
    )
    const l = layoutNode(schemaOf(patched), nodeData, defaultTokens, measure, widgetMeasure, {
      sectionOverrides: { outs: true },
    })
    const portRows = l.rows.filter((r) => r.kind === 'ports')
    expect(portRows).toHaveLength(1)
    expect(portRows[0]).toMatchObject({ input: { portId: 'a' }, output: { portId: 'visible' } })
  })
})

describe('v14 core.combo layout', () => {
  const comboWidget = (id: string, over: Partial<InputSpec> = {}): InputSpec =>
    input(id, { type: { kind: 'concrete', name: 'core.combo' }, widget: { widgetType: 'COMBO', options: { options: ['a', 'b'] } }, ...over })
  const comboOutput = (id: string): OutputSpec =>
    ({ kind: 'output', id, type: { kind: 'concrete', name: 'core.combo' } })

  it('preserves core.combo identity on widget pins, taps, and output slots', () => {
    const l = doLayout([comboWidget('forced', { forceInput: true }), comboWidget('backed'), comboOutput('choice')])
    expect(l.pins.filter((p) => ['forced', 'backed', 'choice'].includes(p.portId)).every((pin) => JSON.stringify(pin.type).includes('core.combo'))).toBe(true)
    expect(l.pins.find((p) => p.portId === 'backed' && p.direction === 'out')).toMatchObject({ widgetTap: true, staticWidgetTap: true, type: { name: 'core.combo' } })
    expect(l.rows.find((r) => r.kind === 'ports' && r.output?.portId === 'choice')).toMatchObject({ output: { type: { name: 'core.combo' } } })
  })

  it('does not mark DynamicCombo selector or active branch widget taps as static', () => {
    const leaf = comboWidget('leaf')
    const schema = schemaOf([input('combo', {
      dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [leaf] }] },
    })])
    const elaborated = elaborateInterface(schema, nodeData)
    const layout = layoutNode(schema, nodeData, defaultTokens, measure, widgetMeasure, { elaborated })
    const taps = layout.pins.filter((pin) => pin.widgetTap === true)
    expect(taps.map((pin) => pin.portId)).toEqual(['combo', 'combo.[a].leaf'])
    expect(taps.every((pin) => pin.staticWidgetTap !== true)).toBe(true)
  })
})
