import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import type {
  Json,
  JsonObject,
  NodeData,
  WorkflowDocument,
} from '../src/format/document.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { asConnectionId } from '../src/ids.js'
import type {
  InputSpec,
  InterfaceItem,
  NodeSchema,
  TypeExpr,
} from '../src/schema/model.js'
import {
  parseObjectInfo,
  type ObjectInfoEntry,
} from '../src/schema/object-info.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(root, 'test/fixtures/comfyui-generic-loops')
const objectInfo = JSON.parse(
  readFileSync(join(root, 'fixtures/object_info.json'), 'utf8'),
) as Record<string, ObjectInfoEntry>
const coreSchemas = parseObjectInfo(objectInfo).schemas
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
    'dinkster.value.select',
    {
      type: 'dinkster.value.select',
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

const workflowFiles = readdirSync(fixtureRoot)
  .filter((name) => name.endsWith('.json'))
  .sort()

describe('explicit imported list utilities', () => {
  it.each([false, true])(
    'flattens declared list-backed native loop results only (list: %s)',
    (listSource) => {
      const integer: TypeExpr = { kind: 'concrete', name: 'INT' }
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
              type: listSource ? { kind: 'list', element: integer } : integer,
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
      expect(helper !== undefined).toBe(listSource)
      if (listSource)
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
      if (compiled.ok && listSource) {
        expect(
          compiled.artifact.dinksterGraph!.nodes.loop_result_n2,
        ).toMatchObject({
          region: {
            ports: {
              item: {
                kind: 'list',
                element: { kind: 'concrete', types: ['INT'] },
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
      const family = (id: string, type: TypeExpr): InterfaceItem => ({
        kind: 'input',
        id,
        type: { kind: 'wildcard' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [input(id, type)],
          naming: { kind: 'prefix', prefix: id, min: 1 },
        },
      })
      const schemas = new Map([
        ['Scalar', schema('Scalar', [output('value', integer)])],
        ['Sequence', schema('Sequence', [output('value', list)])],
        ['Sink', schema('Sink', [input('value', integer)], true)],
        [
          'std.list.make',
          schema('std.list.make', [
            family('items', integer),
            output('list', list),
          ]),
        ],
        [
          'std.list.concat',
          schema('std.list.concat', [
            family('lists', list),
            output('list', list),
          ]),
        ],
        [
          'std.list.element',
          schema('std.list.element', [
            input('list', list),
            input('index', integer),
            output('item', integer),
          ]),
        ],
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
        nodeType: listSource ? 'std.list.concat' : 'std.list.make',
      })
      expect(nodes['n4']).toMatchObject({
        nodeType: 'std.list.element',
        inputs: { list: { $link: { node: 'n3', output: 'list' } } },
      })
      const selection = nodes['n4'] as { inputs: Record<string, Json> }
      const firstIndex = (selection.inputs['index'] as JsonObject)[
        '$link'
      ] as JsonObject
      expect(nodes[firstIndex['node'] as string]).toMatchObject({
        nodeType: 'std.list.element',
        inputs: { index: 0, list: { $link: { node: 'n5', output: 'value' } } },
      })
      const collection = nodes['n3'] as { inputs: Record<string, Json> }
      const values = Object.values(collection.inputs).filter(
        (value) =>
          typeof value === 'object' && value !== null && '$link' in value,
      )
      expect(values).toHaveLength(2)
      if (!listSource)
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

const regionsOf = (document: WorkflowDocument): NodeData[] =>
  Object.values(document.graphs)
    .flatMap((graph) => Object.values(graph.nodes))
    .filter((node) => node.region !== undefined)

const importCorpusWorkflow = (name: string) => {
  const workflow = JSON.parse(
    readFileSync(join(fixtureRoot, name), 'utf8'),
  ) as JsonObject
  const fixtureSchemas = new Map<string, NodeSchema>()
  for (const node of workflow['nodes'] as readonly JsonObject[]) {
    if (typeof node['type'] === 'string' && !coreSchemas.has(node['type']))
      fixtureSchemas.set(node['type'], fixtureSchema(node))
  }
  const resolve = (type: string): NodeSchema | undefined =>
    type === 'StartLoop'
      ? { ...coreSchemas.get(type)!, mayExpandGraph: true }
      : type === 'Issue408LazySwitch'
        ? helperSchemas.get('dinkster.value.select')
        : (coreSchemas.get(type) ??
          helperSchemas.get(type) ??
          fixtureSchemas.get(type))
  return { workflow, resolve, imported: importLitegraph(workflow, resolve) }
}

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

describe('ComfyUI Generic Loops structural import', () => {
  it('keeps the fixed-SHA acceptance corpus complete', () => {
    expect(workflowFiles).toHaveLength(23)
  })

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

  it('binds a generated singleton to the actual StartLoop iteration output', () => {
    const workflow = topologyWorkflow({
      start: { type: 'StartLoop' },
      selection: { type: 'Body', inputs: { list: 'start' } },
      end: { type: 'EndLoop', inputs: { output_value: 'selection' } },
      output: { type: 'Output', inputs: { value: 'end' } },
    })
    const resolve = topologyResolver(workflow)
    const nodes = workflow['nodes'] as JsonObject[]
    nodes[1] = { ...nodes[1]!, type: 'GetItemFromList', widgets_values: [0] }
    const imported = importLitegraph(workflow, resolve)
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    const document = imported.document!
    const body = document.graphs['comfy-loop-1']!
    const wrapper = Object.values(body.nodes).find(
      (node) => node.type === 'std.list.make',
    )!
    expect(wrapper).toBeDefined()
    const iteration = body.boundary!.inputs.find(
      (input) => input.id === 'iteration_index',
    )!
    expect([iteration.binds, ...(iteration.alsoBinds ?? [])]).toContainEqual({
      kind: 'port',
      node: wrapper.id,
      port: 'items.items',
      members: ['m0'],
    })
  })

  it('keeps scalar wrappers and index selection inside their authored loop', () => {
    const workflow = topologyWorkflow({
      source: { type: 'Source' },
      start: { type: 'StartLoop' },
      body: { type: 'Body', inputs: { value: 'start' } },
      collection: {
        type: 'Body',
        inputs: { 'inputs.input9': 'body', 'inputs.input2': 'source' },
      },
      selection: {
        type: 'Body',
        inputs: { list: 'collection', index: 'source' },
      },
      end: { type: 'EndLoop', inputs: { output_value: 'selection' } },
      output: { type: 'Output', inputs: { value: 'end' } },
    })
    const resolveTopology = topologyResolver(workflow)
    const nodes = workflow['nodes'] as JsonObject[]
    nodes[3] = { ...nodes[3]!, type: 'CreateList' }
    nodes[4] = { ...nodes[4]!, type: 'GetItemFromList' }
    const imported = importLitegraph(workflow, (type) => {
      const schema = resolveTopology(type)
      if (type !== 'Issue408TopologySource1' || !schema) return schema
      return {
        ...schema,
        items: [
          {
            kind: 'output',
            id: 'output_0',
            type: { kind: 'list', element: { kind: 'concrete', name: 'INT' } },
          },
        ],
      }
    })
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    const body = imported.document!.graphs['comfy-loop-2']!
    expect(Object.values(body.nodes).map((node) => node.type)).toEqual(
      expect.arrayContaining([
        'std.list.make',
        'std.list.concat',
        'std.list.element',
      ]),
    )
    const root = imported.document!.graphs[imported.document!.root]!
    expect(
      Object.values(root.nodes).some((node) =>
        node.type.startsWith('std.list.'),
      ),
    ).toBe(false)
  })

  it.each(
    workflowFiles.filter((name) => name !== 'runtime-expanded-descendant.json'),
  )('converts %s into explicit region definitions', (name) => {
    const { resolve, imported } = importCorpusWorkflow(name)
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    expect(imported.document).toBeDefined()
    const document = imported.document!
    const nodes = Object.values(document.graphs).flatMap((graph) =>
      Object.values(graph.nodes),
    )
    expect(
      nodes.some(
        (node) => node.type === 'StartLoop' || node.type === 'EndLoop',
      ),
    ).toBe(false)
    expect(nodes.some((node) => node.region !== undefined)).toBe(true)
    const compiled = compile({
      document,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'fixed-comfyui-b5cc8830',
      graphFeatures: ['regions', 'typedLiteral'],
    })
    expect(
      compiled.ok,
      compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
    ).toBe(true)
  })

  it('refuses a flagged runtime-expanding loop body node', () => {
    const { imported } = importCorpusWorkflow(
      'runtime-expanded-descendant.json',
    )
    expect(imported.document).toBeUndefined()
    expect(imported.diagnostics.map((item) => item.code)).toContain(
      'import.loop.runtimeExpansionUnsupported',
    )
  })

  it('refuses a runtime-expanding node inside a loop body subgraph', () => {
    const { workflow, resolve } = importCorpusWorkflow('cache-enabled.json')
    const nodes = [...(workflow['nodes'] as readonly JsonObject[])]
    const expanding = {
      ...nodes[1]!,
      id: 1,
      type: 'Issue408ExpandIncrement',
      inputs: [{ name: 'value', type: '*', link: 101 }],
      outputs: [{ name: 'output_0', type: '*', links: [102] }],
    } satisfies JsonObject
    nodes[1] = { ...nodes[1]!, type: 'expanding-subgraph' }
    const withDefinition = {
      ...workflow,
      nodes,
      definitions: {
        subgraphs: [
          {
            id: 'expanding-subgraph',
            name: 'expanding-subgraph',
            version: 1,
            nodes: [expanding],
            inputs: [{ id: 'in', name: 'value', type: '*', linkIds: [101] }],
            outputs: [
              { id: 'out', name: 'output_0', type: '*', linkIds: [102] },
            ],
            links: [
              {
                id: 101,
                origin_id: -10,
                origin_slot: 0,
                target_id: 1,
                target_slot: 0,
                type: '*',
              },
              {
                id: 102,
                origin_id: 1,
                origin_slot: 0,
                target_id: -20,
                target_slot: 0,
                type: '*',
              },
            ],
          },
        ],
      },
    } satisfies JsonObject
    const imported = importLitegraph(withDefinition, (type) =>
      type === 'Issue408ExpandIncrement'
        ? fixtureSchema(expanding)
        : resolve(type),
    )
    expect(imported.document).toBeUndefined()
    expect(imported.diagnostics.map((item) => item.code)).toContain(
      'import.loop.runtimeExpansionUnsupported',
    )
  })

  it.each([false, true])(
    'preserves promoted widget values through generated loops (nested: %s)',
    (nested) => {
      const loop = topologyWorkflow(
        nested
          ? {
              outer: { type: 'StartLoop' },
              start: {
                type: 'StartLoop',
                inputs: { initial_iteration_value: 'outer' },
              },
              body: { type: 'Body', inputs: { dependency: 'start' } },
              end: { type: 'EndLoop', inputs: { output_value: 'body' } },
              outerEnd: { type: 'EndLoop', inputs: { output_value: 'end' } },
            }
          : {
              start: { type: 'StartLoop' },
              body: { type: 'Body', inputs: { dependency: 'start' } },
              end: { type: 'EndLoop', inputs: { output_value: 'body' } },
            },
      )
      const body = (loop['nodes'] as { [key: string]: Json }[])[nested ? 2 : 1]!
      ;(body['inputs'] as Json[]).push({
        name: 'x',
        type: 'INT',
        widget: { name: 'x' },
        link: null,
      })
      body['widgets_values'] = { x: 7 }
      const resolver = topologyResolver(loop)
      const imported = importLitegraph(
        {
          version: 0.4,
          nodes: [
            {
              id: 20,
              type: 'loop-body',
              inputs: [],
              outputs: [],
              properties: { proxyWidgets: [[String(body['id']), 'x']] },
              widgets_values: [123],
            },
          ],
          links: [],
          definitions: {
            subgraphs: [
              {
                id: 'loop-body',
                name: 'loop-body',
                version: 1,
                nodes: loop['nodes']!,
                links: loop['links']!,
                inputs: [],
                outputs: [],
              },
            ],
          },
        },
        resolver,
      )
      expect(
        imported.diagnostics.filter((item) => item.severity === 'error'),
      ).toEqual([])
      expect(imported.diagnostics.map((item) => item.code)).not.toContain(
        'import.subgraphs.boundaryUnresolved',
      )
      expect(
        Object.values(imported.document!.graphs.g0!.nodes.n20!.values),
      ).toContain(123)
      const generated = Object.values(imported.document!.graphs).filter(
        (graph) => graph.id.startsWith('comfy-loop-'),
      )
      expect(generated).toHaveLength(nested ? 2 : 1)
      for (const graph of generated) {
        expect(
          graph.boundary!.inputs.some((input) => input.promoted === true),
        ).toBe(true)
      }
    },
  )

  it('retains loop definitions generated inside imported subgraphs', () => {
    const loop = topologyWorkflow({
      count: { type: 'Source' },
      start: { type: 'StartLoop', inputs: { 'mode.num_iterations': 'count' } },
      body: { type: 'Body', inputs: { value: 'start', first: 'start:1' } },
      end: { type: 'EndLoop', inputs: { output_value: 'body' } },
    })
    const definition: JsonObject = {
      id: 'loop-body',
      name: 'loop-body',
      version: 1,
      nodes: loop['nodes'] ?? [],
      links: loop['links'] ?? [],
      inputs: [],
      outputs: [],
    }
    const workflow: JsonObject = {
      version: 0.4,
      last_node_id: 2,
      last_link_id: 0,
      nodes: [
        { id: 1, type: 'loop-body', inputs: [], outputs: [] },
        { id: 2, type: 'loop-body', inputs: [], outputs: [] },
      ],
      links: [],
      groups: [],
      config: {},
      extra: {},
      definitions: {
        subgraphs: [definition],
      },
    }
    const imported = importLitegraph(workflow, topologyResolver(loop))
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    expect(imported.document).toBeDefined()
    expect(imported.document!.graphs['comfy-loop-2']).toBeDefined()
    expect(imported.document!.graphs['loop-body']!.nodes.n2!.type).toBe(
      '#comfy-loop-2',
    )
    expect(
      Object.values(imported.document!.occurrenceTopologies ?? {}).map(
        (topology) => topology.owner,
      ),
    ).toEqual([
      { instancePath: ['n1'], node: 'n2' },
      { instancePath: ['n2'], node: 'n2' },
    ])
  })

  it('consumes flagged nested loop boundaries before scanning the outer body', () => {
    const { imported } = importCorpusWorkflow('nested-carry.json')
    expect(imported.diagnostics.map((item) => item.code)).not.toContain(
      'import.loop.runtimeExpansionUnsupported',
    )
    expect(imported.document).toBeDefined()
    expect(regionsOf(imported.document!)).toHaveLength(2)
  })

  it('lowers the fixed-SHA lazy branch helper to the native selector', () => {
    const { resolve, imported } = importCorpusWorkflow('lazy-branch.json')
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    expect(imported.document).toBeDefined()
    const selector = Object.values(imported.document!.graphs)
      .flatMap((graph) => Object.values(graph.nodes))
      .find((node) => node.type === 'dinkster.value.select')
    expect(selector).toBeDefined()

    const compiled = compile({
      document: imported.document!,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'fixed-comfyui-b5cc8830',
      graphFeatures: ['regions', 'typedLiteral'],
    })
    expect(
      compiled.ok,
      compiled.ok ? undefined : JSON.stringify(compiled.diagnostics),
    ).toBe(true)
    if (!compiled.ok) return
    const region = Object.values(compiled.artifact.dinksterGraph!.nodes).find(
      (node) => 'region' in node,
    )
    expect(region).toBeDefined()
    if (region === undefined || !('region' in region)) return
    expect(region.region.body.nodes).toEqual(
      expect.objectContaining({
        n4: expect.objectContaining({
          nodeType: 'dinkster.value.select',
          inputs: {
            condition: { $link: { node: '$region', output: 'is_first' } },
            on_false: { $link: { node: 'n2', output: 'output_0' } },
            on_true: { $link: { node: 'n3', output: 'output_0' } },
          },
        }),
      }),
    )
  })

  it.each([
    ['cache-disabled.json', ['rerun']],
    ['cache-enabled.json', ['reuse']],
    ['nested-mixed-cache.json', ['rerun', 'reuse']],
    ['nested-cache-enabled.json', ['reuse', 'reuse']],
  ] as const)('preserves cache policy for %s', (name, expected) => {
    const { imported } = importCorpusWorkflow(name)
    expect(imported.document).toBeDefined()
    expect(
      regionsOf(imported.document!)
        .map((node) => node.region!.cachePolicy)
        .sort(),
    ).toEqual([...expected].sort())
  })

  it.each([
    ['accumulate-list-output.json', 'flatten'],
    ['final-list-output.json', 'last'],
    ['cache-disabled.json', undefined],
  ] as const)('preserves the result role for %s', (name, expected) => {
    const { imported } = importCorpusWorkflow(name)
    expect(imported.document).toBeDefined()
    expect(
      regionsOf(imported.document!)[0]!.region!.outputRoles?.['result']?.kind,
    ).toBe(expected)
  })

  it.each([
    ['nested-carry.json', 2],
    ['heterogeneous-carry.json', 1],
    ['list-backed-carry.json', 1],
    ['cache-enabled.json', 0],
  ] as const)('preserves carried state for %s', (name, expected) => {
    const { imported } = importCorpusWorkflow(name)
    expect(imported.document).toBeDefined()
    expect(
      regionsOf(imported.document!).filter((node) =>
        node.region!.statePorts?.includes('carry'),
      ),
    ).toHaveLength(expected)
  })

  it.each([
    ['nested-output-list.json', 2],
    ['nested-list-backed-scalar.json', 0],
  ] as const)(
    'preserves nested output-list cardinality for %s',
    (name, flattened) => {
      const { imported } = importCorpusWorkflow(name)
      expect(imported.document).toBeDefined()
      expect(
        regionsOf(imported.document!).filter(
          (node) => node.region!.outputRoles?.['result']?.kind === 'flatten',
        ),
      ).toHaveLength(flattened)
    },
  )

  it('decodes positional mode, range, accumulate, and cache widgets', () => {
    const { workflow, resolve } = importCorpusWorkflow('for-state.json')
    const positional = structuredClone(workflow)
    for (const node of positional['nodes'] as JsonObject[]) {
      const mutable = node as unknown as Record<string, unknown>
      if (node['type'] === 'StartLoop')
        mutable['widgets_values'] = ['For', 2, 8, 3, true]
      if (node['type'] === 'EndLoop') mutable['widgets_values'] = [true]
    }
    const imported = importLitegraph(positional, resolve)
    expect(imported.document).toBeDefined()
    const region = regionsOf(imported.document!)[0]!
    expect(region.values['iteration_index']).toEqual([2, 5])
    expect(region.region!.cachePolicy).toBe('reuse')
    expect(region.region!.outputRoles?.['result']).toBeUndefined()
  })

  it('lifts linked range controls into an integer range node', () => {
    const workflow = topologyWorkflow({
      count: { type: 'Source' },
      start: { type: 'StartLoop', inputs: { 'mode.num_iterations': 'count' } },
      body: { type: 'Body', inputs: { value: 'start' } },
      end: { type: 'EndLoop', inputs: { output_value: 'body' } },
      output: { type: 'Output', inputs: { value: 'end' } },
    })
    const imported = importLitegraph(workflow, topologyResolver(workflow))
    expect(
      imported.diagnostics.filter((item) => item.severity === 'error'),
    ).toEqual([])
    expect(imported.document).toBeDefined()
    const root = imported.document!.graphs.g0!
    const range = Object.values(root.nodes).find(
      (node) => node.type === 'std.list.range',
    )!
    const region = regionsOf(imported.document!)[0]!
    expect(range.values).toEqual({ start: 0, step: 1 })
    expect(region.values['iteration_index']).toBeUndefined()
    expect(Object.values(root.links)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: { node: 'n1', port: 'output_0' },
          to: { node: range.id, port: 'stop' },
        }),
        expect.objectContaining({
          from: { node: range.id, port: 'list' },
          to: { node: region.id, port: 'iteration_index' },
        }),
      ]),
    )
  })

  it('lowers last and rerun into the native graph wire', () => {
    const { resolve, imported } = importCorpusWorkflow('final-list-output.json')
    expect(imported.document).toBeDefined()
    const compiled = compile({
      document: imported.document!,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'fixed-comfyui-b5cc8830',
      graphFeatures: ['regions', 'typedLiteral'],
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const regions = Object.values(
      compiled.artifact.dinksterGraph!.nodes,
    ).filter((entry) => 'region' in entry)
    expect(regions).toHaveLength(1)
    expect(regions[0]!.region.cachePolicy).toBe('rerun')
    expect(regions[0]!.region.outputs['result']?.mode).toBe('last')
  })

  it.each([
    [
      'simple body',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        end: { type: 'EndLoop', inputs: { output_value: 'body' } },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      undefined,
    ],
    [
      'branched body',
      {
        start: { type: 'StartLoop' },
        left: { type: 'Body', inputs: { value: 'start' } },
        right: { type: 'Termination', inputs: { value: 'start' } },
        end: {
          type: 'EndLoop',
          inputs: { output_value: 'left', termination0: 'right' },
        },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      undefined,
    ],
    [
      'entering dependency',
      {
        source: { type: 'Source' },
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { iteration: 'start', value: 'source' } },
        end: { type: 'EndLoop', inputs: { output_value: 'body' } },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      undefined,
    ],
    [
      'nested loops',
      {
        outer: { type: 'StartLoop' },
        inner: { type: 'StartLoop', inputs: { parent_iteration: 'outer' } },
        innerBody: { type: 'Body', inputs: { value: 'inner' } },
        innerEnd: { type: 'EndLoop', inputs: { output_value: 'innerBody' } },
        outerBody: {
          type: 'Body',
          inputs: { outer: 'outer', inner: 'innerEnd' },
        },
        outerEnd: { type: 'EndLoop', inputs: { output_value: 'outerBody' } },
        output: { type: 'Output', inputs: { value: 'outerEnd' } },
      },
      undefined,
    ],
    [
      'sequential loops',
      {
        first: { type: 'StartLoop' },
        firstBody: { type: 'Body', inputs: { value: 'first' } },
        firstEnd: { type: 'EndLoop', inputs: { output_value: 'firstBody' } },
        second: { type: 'StartLoop', inputs: { parent_iteration: 'firstEnd' } },
        secondBody: { type: 'Body', inputs: { value: 'second' } },
        secondEnd: { type: 'EndLoop', inputs: { output_value: 'secondBody' } },
        output: { type: 'Output', inputs: { value: 'secondEnd' } },
      },
      undefined,
    ],
    [
      'independent loops',
      {
        left: { type: 'StartLoop' },
        leftBody: { type: 'Body', inputs: { value: 'left' } },
        leftEnd: { type: 'EndLoop', inputs: { output_value: 'leftBody' } },
        leftOutput: { type: 'Output', inputs: { value: 'leftEnd' } },
        right: { type: 'StartLoop' },
        rightBody: { type: 'Body', inputs: { value: 'right' } },
        rightEnd: { type: 'EndLoop', inputs: { output_value: 'rightBody' } },
        rightOutput: { type: 'Output', inputs: { value: 'rightEnd' } },
      },
      undefined,
    ],
    [
      'termination target',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        sideEffect: { type: 'Termination', inputs: { value: 'body' } },
        end: {
          type: 'EndLoop',
          inputs: { output_value: 'body', termination0: 'sideEffect' },
        },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      undefined,
    ],
    [
      'end without start',
      {
        source: { type: 'Source' },
        end: { type: 'EndLoop', inputs: { output_value: 'source' } },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.unmatchedEnd',
    ],
    [
      'start without end',
      {
        start: { type: 'StartLoop' },
        output: { type: 'Output', inputs: { value: 'start' } },
      },
      'import.loop.unmatchedStart',
    ],
    [
      'all starts without ends',
      {
        first: { type: 'StartLoop' },
        second: { type: 'StartLoop' },
        output: {
          type: 'Output',
          inputs: { first: 'first', second: 'second' },
        },
      },
      'import.loop.unmatchedStart',
    ],
    [
      'ambiguous unrelated starts',
      {
        left: { type: 'StartLoop' },
        right: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { left: 'left', right: 'right' } },
        end: { type: 'EndLoop', inputs: { output_value: 'body' } },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.ambiguousNesting',
    ],
    [
      'second end',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        endA: { type: 'EndLoop', inputs: { output_value: 'body' } },
        endB: { type: 'EndLoop', inputs: { output_value: 'body' } },
        outputA: { type: 'Output', inputs: { value: 'endA' } },
        outputB: { type: 'Output', inputs: { value: 'endB' } },
      },
      'import.loop.bodyEscape',
    ],
    [
      'body output escape',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        end: { type: 'EndLoop', inputs: { output_value: 'body' } },
        output: { type: 'Output', inputs: { closed: 'end', bypass: 'body' } },
      },
      'import.loop.bodyEscape',
    ],
    [
      'inner body escape',
      {
        outer: { type: 'StartLoop' },
        inner: { type: 'StartLoop', inputs: { parent_iteration: 'outer' } },
        body: { type: 'Body', inputs: { value: 'inner' } },
        innerEnd: { type: 'EndLoop', inputs: { output_value: 'body' } },
        outerEnd: {
          type: 'EndLoop',
          inputs: { closed: 'innerEnd', bypass: 'body' },
        },
        output: { type: 'Output', inputs: { value: 'outerEnd' } },
      },
      'import.loop.bodyEscape',
    ],
    [
      'end after paired start',
      {
        start: { type: 'StartLoop' },
        firstEnd: { type: 'EndLoop', inputs: { output_value: 'start' } },
        secondEnd: { type: 'EndLoop', inputs: { output_value: 'firstEnd' } },
        output: { type: 'Output', inputs: { value: 'secondEnd' } },
      },
      'import.loop.unmatchedEnd',
    ],
    [
      'accumulate from body',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        control: { type: 'Body', inputs: { value: 'body' } },
        end: {
          type: 'EndLoop',
          inputs: { output_value: 'body', accumulate: 'control' },
        },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.accumulateFromBody',
    ],
    [
      'accumulate from start',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        end: {
          type: 'EndLoop',
          inputs: { output_value: 'body', accumulate: 'start:1' },
        },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.accumulateFromBody',
    ],
    [
      'external accumulate control',
      {
        control: { type: 'Source' },
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        end: {
          type: 'EndLoop',
          inputs: { output_value: 'body', accumulate: 'control' },
        },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.accumulateDynamic',
    ],
    [
      'prompt ambiguous boundary',
      {
        left: { type: 'StartLoop' },
        right: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { left: 'left', right: 'right' } },
        end: { type: 'EndLoop', inputs: { output_value: 'body' } },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.ambiguousNesting',
    ],
    [
      'prompt stacked loop error',
      {
        start: { type: 'StartLoop' },
        output: { type: 'Output', inputs: { value: 'start' } },
      },
      'import.loop.unmatchedStart',
    ],
    [
      'prompt recognized escape',
      {
        start: { type: 'StartLoop' },
        body: { type: 'Body', inputs: { value: 'start' } },
        end: { type: 'EndLoop', inputs: { output_value: 'body' } },
        output: { type: 'Output', inputs: { closed: 'end', bypass: 'body' } },
      },
      'import.loop.bodyEscape',
    ],
    [
      'independent output remains atomic',
      {
        source: { type: 'Source' },
        independent: { type: 'Output', inputs: { value: 'source' } },
        start: { type: 'StartLoop' },
      },
      'import.loop.unmatchedStart',
    ],
    [
      'second unmatched end',
      {
        source: { type: 'Source' },
        end: { type: 'EndLoop', inputs: { output_value: 'source' } },
        output: { type: 'Output', inputs: { value: 'end' } },
      },
      'import.loop.unmatchedEnd',
    ],
  ] as const)(
    'matches fixed-SHA validation class: %s',
    (_name, spec, errorCode) => {
      const workflow = topologyWorkflow(spec)
      const imported = importLitegraph(workflow, topologyResolver(workflow))
      const errors = imported.diagnostics.filter(
        (item) => item.severity === 'error',
      )
      if (errorCode === undefined) {
        expect(errors).toEqual([])
        expect(imported.document).toBeDefined()
      } else {
        expect(errors.map((item) => item.code)).toContain(errorCode)
        expect(imported.document).toBeUndefined()
      }
    },
  )
})
