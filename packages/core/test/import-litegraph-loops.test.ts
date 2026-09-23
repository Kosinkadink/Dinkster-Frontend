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
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
          widget: { widgetType: 'INT', options: {}, default: 0 },
        },
        {
          kind: 'input',
          id: 'stop',
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'step',
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
          widget: { widgetType: 'INT', options: {}, default: 1 },
        },
        {
          kind: 'output',
          id: 'list',
          type: {
            kind: 'list',
            element: { kind: 'concrete', name: 'core.int' },
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
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'b',
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
        },
        {
          kind: 'output',
          id: 'sum',
          type: { kind: 'concrete', name: 'core.int' },
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
          type: { kind: 'concrete', name: 'core.int' },
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
          type: { kind: 'concrete', name: 'core.string' },
          optional: false,
        },
        {
          kind: 'input',
          id: 'epsilon',
          type: { kind: 'concrete', name: 'core.float' },
          optional: false,
        },
        {
          kind: 'output',
          id: 'result',
          type: { kind: 'concrete', name: 'core.boolean' },
        },
      ],
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
          ? { kind: 'concrete' as const, name: 'core.boolean' }
          : value['name'] === 'item'
            ? { kind: 'concrete' as const, name: 'core.value' }
            : value['name'] === 'value' ||
                value['name'] === 'dependency' ||
                value['name'] === 'index'
              ? { kind: 'concrete' as const, name: 'core.int' }
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
                : 'core.int',
            },
          }
        : {
            kind: 'concrete',
            name: valueOutputs.has(node['type'] as string)
              ? 'core.value'
              : 'core.int',
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
      : coreSchemas.get(type) ?? helperSchemas.get(type) ?? fixtureSchemas.get(type)
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
              (_, slot) => ({ name: `output_${slot}`, type: '*', links: [] }),
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

  it.each(
    workflowFiles.filter((name) => name !== 'runtime-expanded-descendant.json'),
  )(
    'converts %s into explicit region definitions',
    (name) => {
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
    },
  )

  it('refuses a flagged runtime-expanding loop body node', () => {
    const { imported } = importCorpusWorkflow('runtime-expanded-descendant.json')
    expect(imported.document).toBeUndefined()
    expect(imported.diagnostics.map((item) => item.code)).toContain(
      'import.loop.runtimeExpansionUnsupported',
    )
  })

  it('consumes flagged nested loop boundaries before scanning the outer body', () => {
    const { imported } = importCorpusWorkflow('nested-carry.json')
    expect(imported.diagnostics.map((item) => item.code)).not.toContain(
      'import.loop.runtimeExpansionUnsupported',
    )
    expect(imported.document).toBeDefined()
    expect(regionsOf(imported.document!)).toHaveLength(2)
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
    ['nested-carry.json', 1],
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
    expect(imported.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(imported.document).toBeDefined()
    const root = imported.document!.graphs.g0!
    const range = Object.values(root.nodes).find((node) => node.type === 'std.list.range')!
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
