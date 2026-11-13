import { describe, expect, it } from 'vitest'
import { compile, documentNodeResolver, documentResolver } from '../src/compile/compile.js'
import { occurrenceDynamicView } from '../src/compile/occurrence-view.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import type { InputSpec, NodeSchema } from '../src/schema/model.js'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'

const combo: InputSpec = {
  kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
  dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [] }, { key: 'b', inputs: [] }] },
}
const schema: NodeSchema = { type: 'Combo', displayName: 'Combo', category: 'test', source: 'v3', isOutputNode: false, items: [combo] }
const familySchema: NodeSchema = {
  type: 'Family', displayName: 'Family', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'items', type: { kind: 'concrete', name: 'STRING' }, optional: true,
    dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: true }], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 } } }],
}
const nestedFamilySchema: NodeSchema = {
  type: 'NestedFamily', displayName: 'NestedFamily', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'items', type: { kind: 'concrete', name: 'STRING' }, optional: true,
    dynamic: { kind: 'autogrow', template: [
      { kind: 'input', id: 'sub', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: true }], naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 8 } } },
    ], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 } } }],
}
const countOutputSchema: NodeSchema = {
  type: 'CountOutput', displayName: 'CountOutput', category: 'test', source: 'v3', isOutputNode: false,
  items: [
    {
      kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: true,
      widget: { widgetType: 'INT', options: {}, default: 0 },
    },
    {
      kind: 'output', id: 'items', type: { kind: 'concrete', name: 'STRING' },
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'item', type: { kind: 'concrete', name: 'STRING' }, optional: true }],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ],
}
const resolve = (type: string) =>
  type === 'Combo'
    ? schema
    : type === 'Family'
      ? familySchema
      : type === 'NestedFamily'
        ? nestedFamilySchema
        : type === 'CountOutput' ? countOutputSchema : undefined
const graph = (id: string, nodes: Record<string, unknown>, boundary?: unknown) => ({
  id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10, ...(boundary ? { boundary } : {}),
})
const node = (id: string, type: string, selected?: string) => ({
  id, type, values: {}, ...(selected === undefined ? {} : { dynamic: { choice: { selected } } }),
})
const boundary = (target: string, port = 'mode') => ({ inputs: [{ id: 'choice', binds: { kind: 'port', node: target, port } }], outputs: [] })
const docOf = (selected?: string): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'test', root: 'g0',
  graphs: {
    g0: graph('g0', { s: node('s', '#sub', selected) }),
    sub: graph('sub', { n: node('n', 'Combo'), other: node('other', 'Combo') }, boundary('n')),
  },
  view: { graphs: {} },
} as unknown as WorkflowDocument)

describe('occurrenceDynamicView', () => {
  it.each([{ options: [] }, { options: [false, 0, 'same', 'same'] }])('projects promoted editable menus through chained instances and fan-out: %j', ({ options }) => {
    const menuSchema: NodeSchema = {
      type: 'Menu', displayName: 'Menu', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
        widget: { widgetType: 'COMBO', editableOptions: true, options: { options: ['schema'] } } }],
    }
    const bodyNode = (id: string) => ({ id, type: 'Menu', values: {}, dynamic: {
      choice: { options: ['definition'] }, untouched: { selected: 'keep' },
    } })
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'menus', root: 'g0',
      graphs: {
        g0: graph('g0', { s: { id: 's', type: '#outer', values: {}, dynamic: { outerMenu: { options } } } }),
        outer: graph('outer', { i: { id: 'i', type: '#inner', values: {}, dynamic: { innerMenu: { options: ['middle'] } } } }, {
          inputs: [{ id: 'outerMenu', binds: { kind: 'port', node: 'i', port: 'innerMenu' }, promoted: true }], outputs: [],
        }),
        inner: graph('inner', { a: bodyNode('a'), b: bodyNode('b') }, {
          inputs: [{ id: 'innerMenu', binds: { kind: 'port', node: 'a', port: 'choice' },
            alsoBinds: [{ kind: 'port', node: 'b', port: 'choice' }], promoted: true }], outputs: [],
        }),
      }, view: { graphs: {} },
    } as unknown as WorkflowDocument
    const before = JSON.stringify(doc)
    const resolveMenu = (type: string) => type === 'Menu' ? menuSchema : undefined
    const view = occurrenceDynamicView(doc, documentResolver(doc, resolveMenu), ['s', 'i'])
    for (const id of ['a', 'b']) {
      const node = doc.graphs.inner!.nodes[id]!
      const dynamic = view.dynamic.get(id) ?? node.dynamic
      expect(dynamic).toEqual({ choice: { options }, untouched: { selected: 'keep' } })
      const input = elaborateInterface(menuSchema, { ...node, dynamic: dynamic ?? {} }).items.find((item) => item.kind === 'input')!
      expect(input.spec.widget!.options.options).toEqual(options)
      expect(view.valueOwners.get(id)?.get('choice')).toEqual({ graphId: 'g0', nodeId: 's', valueKey: 'outerMenu' })
    }
    const result = compile({ document: doc, revision: 0, resolve: resolveMenu, scope: { kind: 'full' }, connection: asConnectionId('menus'), schemaHash: 'menus' })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('menu compilation failed')
    for (const id of ['s.i.a', 's.i.b']) expect(result.artifact.prompt[id]!.inputs).toEqual(options.length === 0 ? {} : { choice: false })
    expect(JSON.stringify(doc)).toBe(before)
  })

  it.each([false, true])('keeps promoted nested menus at their member scope and respects schema authority: %s', (editableOptions) => {
    const menu: InputSpec = { kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
      widget: { widgetType: 'COMBO', ...(editableOptions ? { editableOptions: true } : {}), options: { options: ['schema'] } } }
    const nested: NodeSchema = { type: 'NestedMenu', displayName: 'NestedMenu', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'items', type: menu.type, optional: false,
        dynamic: { kind: 'autogrow', template: [menu], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 } } }] }
    const doc = { ...docOf(), graphs: {
      g0: graph('g0', { s: { id: 's', type: '#sub', values: { menu: 'outside' }, dynamic: { menu: { options: [] } } } }),
      sub: graph('sub', { n: { id: 'n', type: 'NestedMenu', values: {}, dynamic: { items: {
        members: ['m0', 'm1'], memberState: {
          m0: { 'items.choice': { options: ['first'] } },
          m1: { 'items.choice': { options: ['second'] } },
        },
      } } } }, { inputs: [{ id: 'menu', binds: { kind: 'port', node: 'n', port: 'items.choice', members: ['m1'] }, promoted: true }], outputs: [] }),
    } } as unknown as WorkflowDocument
    const view = occurrenceDynamicView(doc, documentResolver(doc, (type) => type === nested.type ? nested : undefined), ['s'])
    const node = doc.graphs.sub!.nodes.n!
    const dynamic = view.dynamic.get('n') ?? node.dynamic ?? {}
    expect(dynamic.items!.memberState!.m0!['items.choice']!.options).toEqual(['first'])
    expect(dynamic.items!.memberState!.m1!['items.choice']!.options).toEqual(editableOptions ? [] : ['second'])
    const inputs = elabInputsOf(elaborateInterface(nested, { ...node, dynamic })).filter((item) => item.spec.widget !== undefined)
    expect(inputs.filter((item) => item.address.members?.[0] === 'm1').map((item) => item.spec.widget!.options.options)).toEqual([editableOptions ? [] : ['schema']])
    expect(node.dynamic!.items!.memberState!.m1!['items.choice']!.options).toEqual(['second'])
  })

  it('overlays a valid occurrence choice and records its instance owner', () => {
    const view = occurrenceDynamicView(docOf('b'), resolve, ['s'])
    expect(view.dynamic.get('n')?.mode?.selected).toBe('b')
    expect(view.selectorOwners.get('n')?.get('mode')).toEqual({ graphId: 'g0', nodeId: 's', boundaryId: 'choice' })
  })

  it('propagates the outermost choice and owner through chained forwarding', () => {
    const doc = docOf('b') as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', { s: node('s', '#outer', 'b') })
    ;(doc.graphs as unknown as Record<string, unknown>).outer = graph('outer', { i: node('i', '#sub') }, boundary('i', 'choice'))
    const view = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s', 'i'])
    expect(view.dynamic.get('n')?.mode?.selected).toBe('b')
    expect(view.selectorOwners.get('n')?.get('mode')).toEqual({ graphId: 'g0', nodeId: 's', boundaryId: 'choice' })
  })

  it('resolves a selector forwarded through a nested region occurrence', () => {
    const comboIo: NodeSchema = {
      ...schema,
      type: 'ComboIO',
      items: [
        ...schema.items,
        { kind: 'input', id: 'stateIn', type: combo.type, optional: false },
        { kind: 'output', id: 'stateOut', type: combo.type },
      ],
    }
    const resolveIo = (type: string) => type === 'ComboIO' ? comboIo : resolve(type)
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', { s: node('s', '#outer', 'b') })
    ;(doc.graphs as unknown as Record<string, unknown>).outer = graph('outer', {
      i: {
        id: 'i', type: '#body', values: {},
        region: { kind: 'fold', statePorts: ['state'], outputRoles: { result: { kind: 'state', statePort: 'state' } } },
      },
    }, boundary('i', 'choice'))
    ;(doc.graphs as unknown as Record<string, unknown>).body = graph('body', { n: node('n', 'ComboIO') }, {
      inputs: [
        { id: 'choice', binds: { kind: 'port', node: 'n', port: 'mode' } },
        { id: 'state', binds: { kind: 'port', node: 'n', port: 'stateIn' } },
      ],
      outputs: [{ id: 'result', binds: { kind: 'port', node: 'n', port: 'stateOut' } }],
    })

    const docResolve = documentResolver(doc, resolveIo)
    const occurrenceSchema = documentNodeResolver(doc, docResolve)('outer', doc.graphs.outer!.nodes.i!)
    expect(occurrenceSchema?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'choice', dynamic: expect.anything() })]))
    const view = occurrenceDynamicView(doc, docResolve, ['s'])
    expect(view.dynamic.get('i')?.choice?.selected).toBe('b')
    expect(view.selectorOwners.get('i')?.get('choice')).toEqual({ graphId: 'g0', nodeId: 's', boundaryId: 'choice' })
  })

  it('keeps sibling occurrence suffixes independent', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      a: { id: 'a', type: '#sub', values: {}, dynamic: { forwarded: { members: ['a0'] } } },
      b: { id: 'b', type: '#sub', values: {}, dynamic: { forwarded: { members: ['b0', 'b1'] } } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', { n: { id: 'n', type: 'Family', values: {} } },
      { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })
    expect(occurrenceDynamicView(doc, documentResolver(doc, resolve), ['a']).dynamic.get('n')?.items?.members).toEqual(['\u0000a0'])
    expect(occurrenceDynamicView(doc, documentResolver(doc, resolve), ['b']).dynamic.get('n')?.items?.members).toEqual(['\u0000b0', '\u0000b1'])
  })

  it('projects promoted output counts and keeps inherited edits occurrence-local', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      explicit: { id: 'explicit', type: '#sub', values: { amount: 3 } },
      inherited: { id: 'inherited', type: '#sub', values: {} },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', {
      n: { id: 'n', type: 'CountOutput', values: { count: 2 } },
    }, {
      inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
      outputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }],
    })

    const explicit = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['explicit'])
    expect(explicit.values.get('n')).toEqual({ count: 3 })
    expect(explicit.valueOwners.get('n')?.get('count')).toEqual({ graphId: 'g0', nodeId: 'explicit', valueKey: 'amount' })

    const inherited = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['inherited'])
    expect(inherited.values.get('n')).toBeUndefined()
    expect(inherited.valueOwners.get('n')?.get('count')).toEqual({ graphId: 'g0', nodeId: 'inherited', valueKey: 'amount' })
    expect(inherited.dynamic.size).toBe(0)
    expect(inherited.familyOwners.size).toBe(0)
  })

  it('matches the real compiler member order for a definition prefix and instance suffix', () => {
    const doc = docOf() as unknown as { graphs: Record<string, ReturnType<typeof graph>> } & WorkflowDocument
    ;(doc.graphs as unknown as Record<string, unknown>).g0 = graph('g0', {
      s: { id: 's', type: '#sub', values: { 'forwarded.value#s0': 'suffix 0', 'forwarded.value#s1': 'suffix 1' }, dynamic: { forwarded: { members: ['s0', 's1'] } } },
    })
    ;(doc.graphs as unknown as Record<string, unknown>).sub = graph('sub', {
      n: { id: 'n', type: 'Family', values: { 'items.value#d0': 'prefix' }, dynamic: { items: { members: ['d0'] } } },
    }, { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] })

    const members = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['s']).dynamic.get('n')?.items?.members
    const result = compile({ document: doc, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'test' })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(members).toEqual(['d0', '\u0000s0', '\u0000s1'])
    expect(Object.keys(result.artifact.prompt['s.n']!.inputs)).toEqual(members!.map((_, ordinal) => `items.item${ordinal}`))
  })

})
