import { describe, expect, it } from 'vitest'
import { compile, documentResolver } from '../src/compile/compile.js'
import { occurrenceDynamicView } from '../src/compile/occurrence-view.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import type { InputSpec, NodeSchema } from '../src/schema/model.js'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'

const countOutputSchema: NodeSchema = {
  type: 'CountOutput', displayName: 'CountOutput', category: 'test', source: 'v3', isOutputNode: false,
  body: [
    {
      kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: true,
      widget: { widgetType: 'INT', options: {}, default: 0 },
    },
    {
      kind: 'group', id: 'items',
      value: { kind: 'output', id: 'item', type: { kind: 'concrete', name: 'STRING' } },
      keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: { count: 'count' },
      minMembers: 0,
      maxMembers: 8,
    },
  ],
}
const resolve = (type: string) => type === 'CountOutput' ? countOutputSchema : undefined
const graph = (id: string, nodes: Record<string, unknown>, boundary?: unknown) => ({
  id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10, ...(boundary ? { boundary } : {}),
})
const docOf = (graphs: Record<string, unknown>): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'test', root: 'g0', graphs, view: { graphs: {} },
} as unknown as WorkflowDocument)

describe('occurrenceDynamicView', () => {
  it.each([{ options: [] }, { options: [false, 0, 'same', 'same'] }])('projects promoted editable menus through chained instances and fan-out: %j', ({ options }) => {
    const menuSchema: NodeSchema = {
      type: 'Menu', displayName: 'Menu', category: 'test', source: 'v3', isOutputNode: true,
      body: [{ kind: 'input', id: 'choice', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
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
      body: [{ kind: 'group', id: 'items', value: menu, keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
        grows: 'filled', minMembers: 0, maxMembers: 4 }] }
    const doc = docOf({
      g0: graph('g0', { s: { id: 's', type: '#sub', values: { menu: 'outside' }, dynamic: { menu: { options: [] } } } }),
      sub: graph('sub', { n: { id: 'n', type: 'NestedMenu', values: {}, dynamic: {
        items: { members: ['item0', 'item1'] },
        'items.item0': { options: ['first'] },
        'items.item1': { options: ['second'] },
      } } }, { inputs: [{ id: 'menu', binds: { kind: 'port', node: 'n', port: 'items.item1' }, promoted: true }], outputs: [] }),
    })
    const view = occurrenceDynamicView(doc, documentResolver(doc, (type) => type === nested.type ? nested : undefined), ['s'])
    const node = doc.graphs.sub!.nodes.n!
    const dynamic = view.dynamic.get('n') ?? node.dynamic ?? {}
    expect(dynamic['items.item0']!.options).toEqual(['first'])
    expect(dynamic['items.item1']!.options).toEqual(editableOptions ? [] : ['second'])
    const inputs = elabInputsOf(elaborateInterface(nested, { ...node, dynamic })).filter((item) => item.spec.widget !== undefined)
    expect(inputs.filter((item) => item.address.port === 'items.item1').map((item) => item.spec.widget!.options.options)).toEqual([editableOptions ? [] : ['schema']])
    expect(node.dynamic!['items.item1']!.options).toEqual(['second'])
  })

  it('projects a promoted group count and keeps inherited edits occurrence-local', () => {
    const doc = docOf({
      g0: graph('g0', {
        explicit: { id: 'explicit', type: '#sub', values: { amount: 3 } },
        inherited: { id: 'inherited', type: '#sub', values: {} },
      }),
      sub: graph('sub', {
        n: { id: 'n', type: 'CountOutput', values: { count: 2 } },
      }, {
        inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
        outputs: [{ id: 'forwarded', binds: { kind: 'port', node: 'n', port: 'items.item0' } }],
      }),
    })

    const explicit = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['explicit'])
    expect(explicit.values.get('n')).toEqual({ count: 3 })
    expect(explicit.valueOwners.get('n')?.get('count')).toEqual({ graphId: 'g0', nodeId: 'explicit', valueKey: 'amount' })

    const inherited = occurrenceDynamicView(doc, documentResolver(doc, resolve), ['inherited'])
    expect(inherited.values.get('n')).toBeUndefined()
    expect(inherited.valueOwners.get('n')?.get('count')).toEqual({ graphId: 'g0', nodeId: 'inherited', valueKey: 'amount' })
    expect(inherited.dynamic.size).toBe(0)
  })

})
