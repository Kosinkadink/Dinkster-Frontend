import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import type { Json, JsonObject } from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { asConnectionId } from '../src/ids.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import type {
  InputSpec,
  InterfaceItem,
  NodeSchema,
  TypeExpr,
} from '../src/schema/model.js'
import { historicalSchemas } from './fixtures/historical-schemas.js'

const nativeListSchemas = new Map<string, NodeSchema>([
  [
    'CreateList',
    parseDinksterSchema('CreateList', {
      schemaVersion: 1,
      interface: [
        {
          role: 'inputFamily',
          id: 'inputs',
          required: true,
          minMembers: 1,
          maxMembers: 10,
          memberPrefix: 'input',
          template: [
            {
              role: 'input',
              id: 'input',
              required: true,
              type: { kind: 'wildcard' },
            },
          ],
        },
        {
          role: 'output',
          id: 'list',
          type: { kind: 'list', element: { kind: 'wildcard' } },
        },
      ],
    }).schema!,
  ],
  [
    'GetItemFromList',
    parseDinksterSchema('GetItemFromList', {
      schemaVersion: 1,
      interface: [
        {
          role: 'input',
          id: 'list',
          required: true,
          type: { kind: 'wildcard' },
        },
        {
          role: 'input',
          id: 'index',
          required: true,
          default: 0,
          acceptsList: true,
          type: { kind: 'concrete', types: ['INT'] },
        },
        {
          role: 'output',
          id: 'item',
          displayName: '*',
          type: { kind: 'wildcard' },
        },
      ],
    }).schema!,
  ],
])
const coreSchemas = new Map([...historicalSchemas, ...nativeListSchemas])

const helperSchemas = new Map<string, NodeSchema>([
  [
    'std.list.range',
    {
      type: 'std.list.range',
      displayName: 'Integer Range',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'start',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
          widget: { widgetType: 'INT', options: {}, default: 0 },
        },
        {
          kind: 'input',
          id: 'stop',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'step',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
          widget: { widgetType: 'INT', options: {}, default: 1 },
        },
        {
          kind: 'output',
          id: 'list',
          type: {
            kind: 'list',
            element: { kind: 'concrete', name: 'INT' },
          },
        },
      ],
    },
  ],
  [
    'std.math.add_ints',
    {
      type: 'std.math.add_ints',
      displayName: 'Add Ints',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'a',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'b',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
        },
        {
          kind: 'output',
          id: 'sum',
          type: { kind: 'concrete', name: 'INT' },
        },
      ],
    },
  ],
  [
    'std.list.length',
    {
      type: 'std.list.length',
      displayName: 'List Length',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'list',
          type: { kind: 'wildcard' },
          optional: false,
        },
        {
          kind: 'output',
          id: 'length',
          type: { kind: 'concrete', name: 'INT' },
        },
      ],
    },
  ],
  [
    'dinkster.value.compare',
    {
      type: 'dinkster.value.compare',
      displayName: 'Compare',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'a',
          type: { kind: 'concrete', name: 'core.value' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'b',
          type: { kind: 'concrete', name: 'core.value' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'operation',
          type: { kind: 'concrete', name: 'STRING' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'epsilon',
          type: { kind: 'concrete', name: 'FLOAT' },
          optional: false,
        },
        {
          kind: 'output',
          id: 'result',
          type: { kind: 'concrete', name: 'BOOLEAN' },
        },
      ],
    },
  ],
  [
    'Issue408LazySwitch',
    {
      type: 'Issue408LazySwitch',
      displayName: 'Select Value',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'condition',
          type: { kind: 'concrete', name: 'BOOLEAN' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'on_false',
          type: { kind: 'variable', templateId: 'T' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'on_true',
          type: { kind: 'variable', templateId: 'T' },
          optional: false,
        },
        {
          kind: 'output',
          id: 'value',
          type: { kind: 'variable', templateId: 'T' },
        },
      ],
      selector: {
        input: 'condition',
        branches: { false: 'on_false', true: 'on_true' },
      },
    },
  ],
])
const listOutputs = new Set([
  'Issue408EmptyList',
  'Issue408IntegerList',
  'Issue408Pair',
  'Issue408RecordCarried',
])
const valueOutputs = new Set([
  'Issue408ListBackedScalar',
  'Issue408Pair',
  'Issue408RecordCarried',
])

const typeExpr = (value: unknown): TypeExpr =>
  value === '*' || typeof value !== 'string'
    ? { kind: 'wildcard' }
    : { kind: 'concrete', name: value }

const fixtureSchema = (node: JsonObject): NodeSchema => {
  const items: InterfaceItem[] = []
  for (const input of Array.isArray(node['inputs']) ? node['inputs'] : []) {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      continue
    const value = input as JsonObject
    if (typeof value['name'] !== 'string') continue
    const nodeType = node['type'] as string
    const inputType =
      nodeType === 'Issue408RecordCarried' ||
      (nodeType === 'Issue408AppendIndex' && value['name'] === 'value')
        ? { kind: 'concrete' as const, name: 'core.value' }
        : value['name'] === 'is_first' ||
            value['name'] === 'is_last' ||
            value['name'] === 'last' ||
            value['name'] === 'switch'
          ? { kind: 'concrete' as const, name: 'BOOLEAN' }
          : value['name'] === 'item'
            ? { kind: 'concrete' as const, name: 'core.value' }
            : value['name'] === 'value' ||
                value['name'] === 'dependency' ||
                value['name'] === 'index'
              ? { kind: 'concrete' as const, name: 'INT' }
              : typeExpr(value['type'])
    const widgets = node['widgets_values']
    const hasWidget =
      widgets !== null &&
      typeof widgets === 'object' &&
      !Array.isArray(widgets) &&
      value['name'] in widgets
    items.push({
      kind: 'input',
      id: value['name'],
      type: inputType,
      optional: false,
      ...(hasWidget
        ? {
            widget: {
              widgetType:
                inputType.kind === 'concrete' ? inputType.name : 'JSON',
              options: {},
            },
          }
        : {}),
    })
  }
  for (const output of Array.isArray(node['outputs']) ? node['outputs'] : []) {
    if (output === null || typeof output !== 'object' || Array.isArray(output))
      continue
    const value = output as JsonObject
    if (typeof value['name'] !== 'string') continue
    items.push({
      kind: 'output',
      id: value['name'],
      type: listOutputs.has(node['type'] as string)
        ? {
            kind: 'list',
            element: {
              kind: 'concrete',
              name: valueOutputs.has(node['type'] as string)
                ? 'core.value'
                : 'INT',
            },
          }
        : {
            kind: 'concrete',
            name: valueOutputs.has(node['type'] as string)
              ? 'core.value'
              : 'INT',
          },
      ...(listOutputs.has(node['type'] as string) ? { isList: true } : {}),
    })
  }
  return {
    type: node['type'] as string,
    displayName: node['type'] as string,
    category: 'test',
    source: 'v1',
    isOutputNode: (node['type'] as string).startsWith('Issue408Capture'),
    ...((node['type'] as string) === 'Issue408ExpandIncrement'
      ? { mayExpandGraph: true }
      : {}),
    items,
  }
}

describe('explicit imported list utilities', () => {
  it.each([0, -1])(
    'imports heterogeneous native collections using index %s',
    (index) => {
      const sink = parseDinksterSchema('Sink', {
        schemaVersion: 1,
        outputNode: true,
        interface: [
          {
            role: 'input',
            id: 'value',
            required: true,
            type: { kind: 'concrete', types: [index === 0 ? 'INT' : 'STRING'] },
          },
        ],
      }).schema!
      const resolve = (type: string) =>
        type === 'Sink' ? sink : coreSchemas.get(type)
      const workflow: JsonObject = {
        nodes: [
          {
            id: 1,
            type: 'PrimitiveInt',
            outputs: [{ name: 'INT' }],
            widgets_values: [7],
          },
          {
            id: 2,
            type: 'PrimitiveString',
            outputs: [{ name: 'STRING' }],
            widgets_values: ['label'],
          },
          {
            id: 3,
            type: 'CreateList',
            inputs: [{ name: 'inputs.input0' }, { name: 'inputs.input1' }],
            outputs: [{ name: 'list' }],
          },
          {
            id: 4,
            type: 'GetItemFromList',
            inputs: [{ name: 'list' }],
            outputs: [{ name: '*' }],
            widgets_values: [index],
          },
          { id: 5, type: 'Sink', inputs: [{ name: 'value' }] },
        ],
        links: [
          [1, 1, 0, 3, 0, 'INT'],
          [2, 2, 0, 3, 1, 'STRING'],
          [3, 3, 0, 4, 0, '*'],
          [4, 4, 0, 5, 0, '*'],
        ],
      }
      const imported = importLitegraph(workflow, resolve)
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      expect(imported.document!.graphs.g0!.nodes.n3!.type).toBe('CreateList')
      expect(imported.document!.graphs.g0!.nodes.n4!.type).toBe(
        'GetItemFromList',
      )
      const compiled = compile({
        document: imported.document!,
        revision: 1,
        resolve,
        scope: { kind: 'full' },
        connection: asConnectionId('tuple-import'),
        schemaHash: 'tuple',
        graphFeatures: ['regions', 'typedLiteral'],
      })
      expect(
        compiled.ok,
        compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
      ).toBe(true)
      if (compiled.ok) {
        expect(compiled.artifact.dinksterGraph!.nodes.n3).toMatchObject({
          nodeType: 'CreateList',
        })
        expect(compiled.artifact.dinksterGraph!.nodes.n4).toMatchObject({
          nodeType: 'GetItemFromList',
          inputs: { list: { $link: { node: 'n3', output: 'list' } }, index },
        })
      }
    },
  )

  it.each([
    [false, 0, false],
    [true, 0, false],
    [true, 2, false],
    [true, 4, false],
    [true, 0, true],
  ] as const)(
    'flattens active declared list-backed native loop results only (list: %s, mode: %s, heterogeneous: %s)',
    (listSource, mode, heterogeneous) => {
      const integer: TypeExpr = { kind: 'concrete', name: 'INT' }
      const element: TypeExpr = heterogeneous ? { kind: 'wildcard' } : integer
      const variable: TypeExpr = { kind: 'variable', templateId: 'T' }
      const list: TypeExpr = { kind: 'list', element: variable }
      const schema = (type: string, items: InterfaceItem[]): NodeSchema => ({
        type,
        displayName: type,
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items,
      })
      const schemas = new Map<string, NodeSchema>([
        [
          'Source',
          schema('Source', [
            {
              kind: 'output',
              id: 'value',
              type: listSource ? { kind: 'list', element } : integer,
            },
          ]),
        ],
        [
          'StartLoop',
          {
            ...schema('StartLoop', [
              { kind: 'output', id: 'iteration_index', type: integer },
            ]),
            mayExpandGraph: true,
          },
        ],
        [
          'EndLoop',
          schema('EndLoop', [
            {
              kind: 'input',
              id: 'output_value',
              type: variable,
              optional: false,
            },
            { kind: 'output', id: 'outputs', type: list },
          ]),
        ],
        [
          'std.list.concat',
          schema('std.list.concat', [
            {
              kind: 'input',
              id: 'lists',
              type: { kind: 'wildcard' },
              optional: false,
              dynamic: {
                kind: 'autogrow',
                template: [
                  { kind: 'input', id: 'lists', type: list, optional: false },
                ],
                naming: { kind: 'prefix', prefix: 'lists', min: 1 },
              },
            },
            { kind: 'output', id: 'list', type: list },
          ]),
        ],
      ])
      const imported = importLitegraph(
        {
          nodes: [
            { id: 1, type: 'Source', outputs: [{ name: 'value', links: [1] }] },
            {
              id: 2,
              type: 'EndLoop',
              mode,
              inputs: [{ name: 'output_value', link: 1 }],
              outputs: [{ name: 'outputs' }],
            },
          ],
          links: [[1, 1, 0, 2, 0, '*']],
        },
        (type) => schemas.get(type),
      )
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      const document = imported.document!
      const helper = document.graphs.g0!.nodes.loop_result_n2
      const adapted = listSource && mode === 0
      expect(helper !== undefined).toBe(adapted)
      if (adapted)
        expect(helper!.region).toMatchObject({
          kind: 'map',
          outputRoles: { list: { kind: 'flatten' } },
        })
      const compiled = compile({
        document,
        revision: 1,
        resolve: (type) => schemas.get(type),
        scope: { kind: 'full' },
        connection: asConnectionId('test'),
        schemaHash: 'native-list-loop',
        graphFeatures: ['regions', 'typedLiteral'],
      })
      expect(
        compiled.ok,
        compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
      ).toBe(true)
      if (compiled.ok && adapted) {
        expect(
          compiled.artifact.dinksterGraph!.nodes.loop_result_n2,
        ).toMatchObject({
          region: {
            ports: {
              item: {
                kind: 'list',
                element: heterogeneous
                  ? { kind: 'wildcard' }
                  : { kind: 'concrete', types: ['INT'] },
              },
            },
            outputs: { list: { mode: 'flatten' } },
          },
        })
      }
    },
  )

  it('maps an output-only scalar consumer', () => {
    const integer: TypeExpr = { kind: 'concrete', name: 'INT' }
    const schemas = new Map<string, NodeSchema>([
      [
        'ListSource',
        {
          type: 'ListSource',
          displayName: 'Source',
          source: 'v3',
          category: 'test',
          isOutputNode: false,
          items: [
            {
              kind: 'output',
              id: 'values',
              type: { kind: 'list', element: integer },
            },
          ],
        },
      ],
      [
        'SaveValue',
        {
          type: 'SaveValue',
          displayName: 'Save',
          source: 'v3',
          category: 'test',
          isOutputNode: true,
          items: [
            { kind: 'input', id: 'value', type: integer, optional: false },
          ],
        },
      ],
    ])
    const imported = importLitegraph(
      {
        nodes: [
          {
            id: 1,
            type: 'ListSource',
            outputs: [{ name: 'values', links: [1] }],
          },
          {
            id: 2,
            type: 'SaveValue',
            inputs: [{ name: 'value', link: 1 }],
            outputs: [],
          },
        ],
        links: [[1, 1, 0, 2, 0, 'INT']],
      },
      (type) => schemas.get(type),
    )
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    const document = imported.document!
    expect(document.graphs.g0!.nodes.n2!.region).toMatchObject({
      kind: 'map',
      elementPorts: ['value'],
    })
    expect(document.graphs['list-map-n2']!.nodes.body!.type).toBe('SaveValue')
    const compiled = compile({
      document,
      revision: 1,
      resolve: (type) => schemas.get(type),
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'output-only-list',
      graphFeatures: ['regions', 'typedLiteral'],
    })
    expect(
      compiled.ok,
      compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
    ).toBe(true)
  })

  it.each([false, true])(
    'maps every list-backed scalar input independent of serialized order (consumer first: %s)',
    (consumerFirst) => {
      const integer: TypeExpr = { kind: 'concrete', name: 'INT' }
      const source: NodeSchema = {
        type: 'ListSource',
        displayName: 'List Source',
        source: 'v3',
        category: 'test',
        isOutputNode: false,
        items: [
          {
            kind: 'output',
            id: 'values',
            type: { kind: 'list', element: integer },
          },
        ],
      }
      const schemas = new Map([['ListSource', source], ...helperSchemas])
      const add = schemas.get('std.math.add_ints')!
      schemas.set(add.type, {
        ...add,
        items: add.items.map((item) =>
          item.kind === 'input'
            ? { ...item, widget: { widgetType: 'INT', options: {} } }
            : item,
        ),
      })
      const unary = {
        id: 3,
        type: add.type,
        inputs: [{ name: 'a', link: 2 }, { name: 'b' }],
        outputs: [{ name: 'sum', links: [3] }],
        widgets_values: { b: 7 },
      }
      const binary = {
        id: 4,
        type: add.type,
        inputs: [
          { name: 'a', link: 1 },
          { name: 'b', link: 3 },
        ],
        outputs: [{ name: 'sum' }],
      }
      const imported = importLitegraph(
        {
          nodes: [
            {
              id: 1,
              type: 'ListSource',
              outputs: [{ name: 'values', links: [1] }],
            },
            {
              id: 2,
              type: 'ListSource',
              outputs: [{ name: 'values', links: [2] }],
            },
            ...(consumerFirst ? [binary, unary] : [unary, binary]),
          ],
          links: [
            [1, 1, 0, 4, 0, 'INT'],
            [2, 2, 0, 3, 0, 'INT'],
            [3, 3, 0, 4, 1, 'INT'],
          ],
        },
        (type) => schemas.get(type),
      )
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      const document = imported.document!
      expect(document.graphs.g0!.nodes.n4!.region).toMatchObject({
        elementPorts: ['a', 'b'],
      })
      expect(
        document.graphs['list-map-n4']!.boundary!.inputs.every(
          (input) => !input.promoted,
        ),
      ).toBe(true)
      expect(
        document.graphs['list-map-n3']!.boundary!.inputs.find(
          (input) => input.id === 'b',
        )?.promoted,
      ).toBe(true)
      const compiled = compile({
        document,
        revision: 1,
        resolve: (type) => schemas.get(type),
        scope: { kind: 'full' },
        connection: asConnectionId('test'),
        schemaHash: 'list-fixed-point',
        graphFeatures: ['regions', 'typedLiteral'],
      })
      expect(
        compiled.ok,
        compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
      ).toBe(true)
    },
  )

  it.each(['direct', 'reroute', 'net'])(
    'persists an explicit map for a declared list-to-scalar boundary through %s',
    (route) => {
      const integer: TypeExpr = { kind: 'concrete', name: 'INT' }
      const source: NodeSchema = {
        type: 'ListSource',
        displayName: 'List Source',
        source: 'v3',
        category: 'test',
        isOutputNode: false,
        items: [
          {
            kind: 'output',
            id: 'values',
            type: { kind: 'list', element: integer },
          },
        ],
      }
      const schemas = new Map([['ListSource', source], ...helperSchemas])
      const add = schemas.get('std.math.add_ints')!
      schemas.set(add.type, {
        ...add,
        items: add.items.map((item) =>
          item.kind === 'input' && item.id === 'b'
            ? { ...item, widget: { widgetType: 'INT', options: {} } }
            : item,
        ),
      })
      const input = route === 'direct' ? 1 : 4
      const imported = importLitegraph(
        {
          nodes: [
            {
              id: 1,
              type: 'ListSource',
              outputs: [{ name: 'values', links: [1] }],
            },
            {
              id: 2,
              type: 'std.math.add_ints',
              inputs: [{ name: 'a', link: input }, { name: 'b' }],
              outputs: [{ name: 'sum' }],
              widgets_values: { b: 5 },
            },
            ...(route === 'reroute'
              ? [
                  {
                    id: 3,
                    type: 'Reroute',
                    inputs: [{ name: '', link: 1 }],
                    outputs: [{ name: '' }],
                  },
                ]
              : []),
            ...(route === 'net'
              ? [
                  {
                    id: 3,
                    type: 'SetNode',
                    inputs: [{ name: 'value', link: 1 }],
                    outputs: [{ name: '*', links: [] }],
                    widgets_values: ['numbers'],
                  },
                  {
                    id: 4,
                    type: 'GetNode',
                    outputs: [{ name: '*', links: [4] }],
                    widgets_values: ['numbers'],
                  },
                ]
              : []),
          ],
          links:
            route === 'direct'
              ? [[1, 1, 0, 2, 0, 'INT']]
              : [
                  [1, 1, 0, 3, 0, 'INT'],
                  [4, route === 'net' ? 4 : 3, 0, 2, 0, 'INT'],
                ],
        },
        (type) => schemas.get(type),
      )
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      const document = imported.document!
      expect(document.graphs.g0!.nodes.n2!.region).toMatchObject({
        kind: 'map',
        elementPorts: ['a'],
        binding: 'broadcast',
      })
      expect(document.graphs['list-map-n2']!.nodes.body!.values).toEqual({
        b: 5,
      })
      const compiled = compile({
        document,
        revision: 1,
        resolve: (type) => schemas.get(type),
        scope: { kind: 'full' },
        connection: asConnectionId('test'),
        schemaHash: 'list-boundary',
        graphFeatures: ['regions', 'typedLiteral'],
      })
      expect(
        compiled.ok,
        compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
      ).toBe(true)
      if (compiled.ok)
        expect(compiled.artifact.dinksterGraph!.nodes.n2).toMatchObject({
          region: { elementPorts: ['a'] },
        })
    },
  )

  it.each([
    [false, 'direct'],
    [true, 'direct'],
    [false, 'reroute'],
    [true, 'reroute'],
    [false, 'net'],
    [true, 'net'],
  ] as const)(
    'preserves authored order and selects the first linked index (list source: %s, route: %s)',
    (listSource, route) => {
      const integer: TypeExpr = { kind: 'concrete', name: 'INT' }
      const list: TypeExpr = { kind: 'list', element: integer }
      const schema = (
        type: string,
        items: InterfaceItem[],
        output = false,
      ): NodeSchema => ({
        type,
        items,
        source: 'v3',
        displayName: type,
        category: 'test',
        isOutputNode: output,
      })
      const input = (id: string, type: TypeExpr): InputSpec => ({
        kind: 'input',
        id,
        type,
        optional: false,
      })
      const output = (id: string, type: TypeExpr): InterfaceItem => ({
        kind: 'output',
        id,
        type,
      })
      const schemas = new Map([
        ...nativeListSchemas,
        ['Scalar', schema('Scalar', [output('value', integer)])],
        ['Sequence', schema('Sequence', [output('value', list)])],
        ['Sink', schema('Sink', [input('value', integer)], true)],
      ])
      const workflow: JsonObject = {
        nodes: [
          { id: 1, type: 'Scalar', outputs: [{ name: 'value', type: 'INT' }] },
          {
            id: 2,
            type: listSource ? 'Sequence' : 'Scalar',
            outputs: [{ name: 'value', type: 'INT' }],
          },
          {
            id: 3,
            type: 'CreateList',
            inputs: [{ name: 'inputs.input9' }, { name: 'inputs.input2' }],
            outputs: [{ name: 'list' }],
          },
          {
            id: 4,
            type: 'GetItemFromList',
            inputs: [{ name: 'list' }, { name: 'index' }],
            outputs: [{ name: '*' }],
            widgets_values: [9],
          },
          {
            id: 5,
            type: 'Sequence',
            outputs: [{ name: 'value', type: 'INT' }],
          },
          { id: 6, type: 'Sink', inputs: [{ name: 'value' }] },
        ],
        links: [
          [1, 2, 0, 3, 1, 'INT'],
          [2, 1, 0, 3, 0, 'INT'],
          [3, 3, 0, 4, 0, '*'],
          [4, 5, 0, 4, 1, 'INT'],
          [5, 4, 0, 6, 0, 'INT'],
        ],
      }
      if (route !== 'direct') {
        const nodes = workflow['nodes'] as JsonObject[]
        const links = workflow['links'] as Json[][]
        for (const [source, destination, slot, junction] of [
          [2, 3, 1, 7],
          [5, 4, 1, 9],
        ] as const) {
          const link = links.find((item) => item[1] === source)!
          if (route === 'reroute') {
            nodes.push({
              id: junction,
              type: 'Reroute',
              inputs: [{ name: 'input' }],
              outputs: [{ name: 'output' }],
            })
            link[3] = junction
            link[4] = 0
            links.push([
              links.length + 1,
              junction,
              0,
              destination,
              slot,
              'INT',
            ])
          } else {
            nodes.push(
              {
                id: junction,
                type: 'SetNode',
                inputs: [{ name: '*', link: link[0]! }],
                outputs: [{ name: 'INT', links: [] }],
                widgets_values: [`shared${source}`],
              },
              {
                id: junction + 1,
                type: 'GetNode',
                outputs: [{ name: 'INT', links: [links.length + 1] }],
                widgets_values: [`shared${source}`],
              },
            )
            link[3] = junction
            link[4] = 0
            links.push([
              links.length + 1,
              junction + 1,
              0,
              destination,
              slot,
              'INT',
            ])
          }
        }
      }
      const resolve = (type: string) => schemas.get(type)
      const imported = importLitegraph(workflow, resolve)
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      expect(imported.document).toBeDefined()
      const compiled = compile({
        document: imported.document!,
        revision: 1,
        resolve,
        scope: { kind: 'full' },
        connection: asConnectionId('test'),
        schemaHash: 'test',
        graphFeatures: ['regions'],
      })
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
      const nodes = compiled.artifact.dinksterGraph!.nodes
      expect(nodes['n3']).toMatchObject({
        nodeType: 'CreateList',
      })
      expect(nodes['n4']).toMatchObject({
        nodeType: 'GetItemFromList',
        inputs: {
          list: { $link: { node: 'n3', output: 'list' } },
          index: { $link: { node: 'n5', output: 'value' } },
        },
      })
      expect(
        Object.values(nodes).some(
          (node) => 'nodeType' in node && node.nodeType.startsWith('std.list.'),
        ),
      ).toBe(false)
      const collection = nodes['n3'] as { inputs: Record<string, Json> }
      const values = Object.values(collection.inputs).filter(
        (value) =>
          typeof value === 'object' && value !== null && '$link' in value,
      )
      expect(values).toHaveLength(2)
      expect(values).toEqual([
        { $link: { node: 'n1', output: 'value' } },
        { $link: { node: 'n2', output: 'value' } },
      ])
    },
  )
  it.each([2, 4])(
    'preserves authored disabled mode %s on list nodes and helpers',
    (mode) => {
      const workflow: JsonObject = {
        nodes: [
          {
            id: 1,
            type: 'PrimitiveInt',
            outputs: [{ name: 'INT' }],
            widgets_values: [7],
          },
          {
            id: 2,
            type: 'CreateList',
            mode,
            inputs: [{ name: 'inputs.input0' }],
            outputs: [{ name: 'list' }],
          },
          {
            id: 3,
            type: 'GetItemFromList',
            mode,
            inputs: [{ name: 'list' }],
            outputs: [{ name: '*' }],
            widgets_values: [0],
          },
        ],
        links: [
          [1, 1, 0, 2, 0, 'INT'],
          [2, 1, 0, 3, 0, 'INT'],
        ],
      }
      const imported = importLitegraph(
        workflow,
        (type) => coreSchemas.get(type) ?? helperSchemas.get(type),
      )
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      const nodes = imported.document!.graphs[imported.document!.root]!.nodes
      for (const node of Object.values(nodes).filter(
        (node) => node.id !== 'n1',
      ))
        expect(node.mode).toBe(mode === 2 ? 'muted' : 'bypassed')
    },
  )
})

type TopologyNode = {
  readonly type:
    | 'StartLoop'
    | 'EndLoop'
    | 'Body'
    | 'Source'
    | 'Output'
    | 'Termination'
  readonly inputs?: Readonly<Record<string, string>>
}

const topologyWorkflow = (
  spec: Readonly<Record<string, TopologyNode>>,
): JsonObject => {
  const entries = Object.entries(spec)
  const ids = new Map(entries.map(([name], index) => [name, index + 1]))
  const links: Json[] = []
  const rawNodes = entries.map(([name, node], index) => {
    const id = index + 1
    const inputNames =
      node.type === 'StartLoop'
        ? [
            ...new Set([
              'mode',
              'mode.num_iterations',
              'cache_iterations',
              ...Object.keys(node.inputs ?? {}),
            ]),
          ]
        : node.type === 'EndLoop'
          ? [
              ...Object.keys(node.inputs ?? {}).filter(
                (input) => input !== 'accumulate',
              ),
              'accumulate',
            ]
          : Object.keys(node.inputs ?? {})
    const inputs = inputNames.map((inputName, slot) => {
      const sourceName = node.inputs?.[inputName]
      if (!sourceName) return { name: inputName, type: '*', link: null }
      const [source, sourceSlotText] = sourceName.split(':')
      const sourceId = ids.get(source!)!
      const linkId = links.length + 1
      links.push([linkId, sourceId, Number(sourceSlotText ?? 0), id, slot, '*'])
      return { name: inputName, type: '*', link: linkId }
    })
    return {
      id,
      type:
        node.type === 'Body'
          ? `Issue408TopologyBody${id}`
          : node.type === 'Source'
            ? `Issue408TopologySource${id}`
            : node.type === 'Output'
              ? `Issue408CaptureTopology${id}`
              : node.type === 'Termination'
                ? `Issue408CapturePassthrough${id}`
                : node.type,
      pos: [id * 100, 0],
      inputs,
      outputs:
        node.type === 'Output'
          ? []
          : Array.from(
              { length: node.type === 'StartLoop' ? 5 : 1 },
              (_, slot) => ({
                name: `output_${slot}`,
                type: '*',
                links: [],
              }),
            ),
      widgets_values:
        node.type === 'StartLoop'
          ? {
              mode: 'simple',
              'mode.num_iterations': 2,
              cache_iterations: false,
            }
          : node.type === 'EndLoop'
            ? { accumulate: false }
            : {},
    }
  })
  for (const link of links as unknown as readonly [
    number,
    number,
    number,
    number,
    number,
    string,
  ][]) {
    const source = rawNodes[link[1] - 1]!
    ;(source.outputs[link[2]]!.links as number[]).push(link[0])
  }
  return {
    version: 0.4,
    last_node_id: entries.length,
    last_link_id: links.length,
    nodes: rawNodes,
    links,
    groups: [],
    config: {},
    extra: {},
  }
}

const topologyResolver = (workflow: JsonObject) => {
  const schemas = new Map<string, NodeSchema>()
  for (const node of workflow['nodes'] as readonly JsonObject[]) {
    if (typeof node['type'] === 'string' && !coreSchemas.has(node['type']))
      schemas.set(node['type'], fixtureSchema(node))
  }
  return (type: string): NodeSchema | undefined =>
    coreSchemas.get(type) ?? helperSchemas.get(type) ?? schemas.get(type)
}

describe('native expanding loop import', () => {
  it('preserves registered native expanding loops instead of synthesizing region state', () => {
    const workflow = topologyWorkflow({
      start: { type: 'StartLoop' },
      body: { type: 'Body', inputs: { value: 'start' } },
      end: { type: 'EndLoop', inputs: { output_value: 'body' } },
      output: { type: 'Output', inputs: { value: 'end' } },
    })
    const legacyResolve = topologyResolver(workflow)
    const resolve = (type: string): NodeSchema | undefined => {
      const schema = legacyResolve(type)
      return type === 'StartLoop' && schema
        ? { ...schema, source: 'v3', mayExpandGraph: true }
        : schema
    }
    const imported = importLitegraph(workflow, resolve)
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    expect(Object.keys(imported.document!.graphs)).toEqual(['g0'])
    const graph = imported.document!.graphs.g0!
    expect(graph.nodes.n1!.type).toBe('StartLoop')
    expect(graph.nodes.n3!.type).toBe('EndLoop')
    expect(graph.nodes.n1!.values).not.toHaveProperty('carry')
    const compiled = compile({
      document: imported.document!,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'native-controls',
      graphFeatures: ['regions', 'typedLiteral'],
    })
    expect(
      compiled.ok,
      compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
    ).toBe(true)
    if (compiled.ok) {
      expect(compiled.artifact.dinksterGraph!.nodes['n1']).toMatchObject({
        nodeType: 'StartLoop',
      })
      expect(compiled.artifact.dinksterGraph!.nodes['n3']).toMatchObject({
        nodeType: 'EndLoop',
      })
    }
  })
})
