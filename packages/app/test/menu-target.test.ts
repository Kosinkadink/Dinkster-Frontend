import { describe, expect, it } from 'vitest'
import type { Hit } from '@dinkster/canvas'
import { coreCommandRegistry, createLocalSession, createMenuRegistry, type MenuContext, type MenuItem, type NodeSchema, type ResolvedMenuGroup, type WidgetSpec, type WorkflowDocument } from '@dinkster/core'
import { toolboxMenuRequest } from '../src/CanvasHost.js'
import { canvasMenuContext, memberRemovalInvocation, menuFlat, menuTargetOf, resolveNodeMenuGroups, selectionLifecycleMenuGroups, widgetRepresentationAddress, widgetRepresentationMenuGroup } from '../src/menu-target.js'

const item = (id: string): MenuItem => ({
  id,
  label: id,
  action: { kind: 'host', action: 'noop' },
})

const group = (name: string, ...ids: string[]): ResolvedMenuGroup => ({
  group: name,
  items: ids.map(item),
})

describe('direct member removal', () => {
  const schema: NodeSchema = {
    type: 'Stack', displayName: 'Stack', category: 'test', source: 'v3', isOutputNode: false,
    body: [{ kind: 'group', id: 'items', keys: { kind: 'numbered', prefix: 'm', start: 0, pad: 0 },
      grows: 'button', minMembers: 1, member: [
        { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {} } },
      ] }],
  }
  const document = (): WorkflowDocument => ({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'lin1', root: 'g0', view: { graphs: {} },
    graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 }, sub: {
      id: 'sub', name: 'sub', nextOrdinal: 100, reroutes: {},
      nodes: {
        n1: { id: 'n1', type: 'Stack', values: { 'items.m0.value': 7, 'items.m1.value': 19, 'items.m10.value': 31 },
          dynamic: { items: { members: ['m0', 'm1', 'm10'], seq: 11 } } },
        n2: { id: 'n2', type: 'Stack', values: {}, dynamic: { items: { members: ['m0', 'm1', 'm10'], seq: 11 } } },
      },
      links: {
        incoming: { id: 'incoming', from: { node: 'n2', tap: 'items.m0.value' }, to: { node: 'n1', port: 'items.m1.value' } },
        outgoing: { id: 'outgoing', from: { node: 'n1', tap: 'items.m1.value' }, to: { node: 'n2', port: 'items.m0.value' } },
        kept: { id: 'kept', from: { node: 'n1', tap: 'items.m10.value' }, to: { node: 'n2', port: 'items.m10.value' } },
      },
      nets: {
        sourced: { id: 'sourced', source: { node: 'n1', port: 'items.m1.out' }, sinks: [{ node: 'n2', port: 'items.m1.net' }] },
        shared: { id: 'shared', source: { node: 'n2', port: 'items.m1.out' }, sinks: [{ node: 'n1', port: 'items.m1.net' }, { node: 'n1', port: 'items.m10.net' }] },
      },
      boundary: {
        inputs: [{ id: 'input', binds: { kind: 'port', node: 'n1', port: 'items.m1.value' }, alsoBinds: [
          { kind: 'port', node: 'n1', port: 'items.m1.extra' }, { kind: 'port', node: 'n1', port: 'items.m10.value' },
        ] }],
        outputs: [{ id: 'output', binds: { kind: 'widgetTap', node: 'n1', tap: 'items.m1.value' } }],
      },
    } },
  } as unknown as WorkflowDocument)

  it.each(['button', 'filled', 'link'] as const)('removes a %s-grown member and its wires in one undo step, preserving a similarly named sibling', (grows) => {
    const before = document()
    const session = createLocalSession(before, coreCommandRegistry())
    const grown = { ...schema, body: schema.body.map((row) => row.kind === 'group' ? { ...row, grows } : row) }
    const invocation = memberRemovalInvocation(session.doc, grown, 'sub', 'n1', 'items', 'm1')!
    expect(session.dispatch(invocation).ok).toBe(true)
    const after = session.doc
    const graph = after.graphs.sub!
    expect(graph.nodes.n1!.dynamic!.items).toEqual({ members: ['m0', 'm10'], seq: 11 })
    expect(graph.nodes.n1!.values).toEqual({ 'items.m0.value': 7, 'items.m10.value': 31 })
    expect(Object.keys(graph.links)).toEqual(['kept'])
    expect(Object.keys(graph.nets)).toEqual(['shared'])
    expect(graph.nets.shared!.sinks).toEqual([{ node: 'n1', port: 'items.m10.net' }])
    expect(graph.boundary).toEqual({ inputs: [{ id: 'input', binds: { kind: 'port', node: 'n1', port: 'items.m10.value' } }], outputs: [] })
    session.undo()
    expect(session.doc).toEqual(before)
    expect(session.canUndo).toBe(false)
    session.redo()
    expect(session.doc).toEqual(after)
  })

  it('offers no removal for the least count or a member the document does not store', () => {
    const before = document()
    expect(memberRemovalInvocation(before, schema, 'sub', 'n1', 'items', 'm2')).toBeUndefined()
    const node = before.graphs.sub!.nodes.n1!
    const least = { ...before, graphs: { ...before.graphs, sub: { ...before.graphs.sub!, nodes: {
      ...before.graphs.sub!.nodes, n1: { ...node, dynamic: { items: { members: ['m1'], seq: 11 } } },
    } } } }
    expect(memberRemovalInvocation(least, schema, 'sub', 'n1', 'items', 'm1')).toBeUndefined()
  })
})

describe('menuFlat', () => {
  it('flattens groups in order and marks only the first item of later groups as separated', () => {
    const flat = menuFlat([group('10-a', 'a1', 'a2'), group('20-b', 'b1', 'b2'), group('30-c', 'c1')])
    expect(flat.map((e) => e.item.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1'])
    expect(flat.map((e) => e.sep)).toEqual([false, false, true, false, true])
  })

})

describe('selectionLifecycleMenuGroups', () => {
  const lifecycle = group('15-subgraph-lifecycle', 'core.subgraph.extract', 'core.subgraph.flatten')

  it('includes lifecycle actions for selection-level construct targets', () => {
    const targets: MenuContext['target'][] = [
      { kind: 'node', nodeId: 'n1' },
      { kind: 'group', groupId: 'g1' },
      { kind: 'reroute', rerouteId: 'r1' },
    ]
    for (const target of targets) {
      expect(selectionLifecycleMenuGroups(target, lifecycle).flatMap((entry) => entry.items.map((entry) => entry.id)))
        .toEqual(['core.subgraph.extract', 'core.subgraph.flatten'])
    }
  })

  it('does not add lifecycle actions to a widget-target menu', () => {
    const ids = selectionLifecycleMenuGroups(
      { kind: 'widget', nodeId: 'n1', inputId: 'seed' },
      lifecycle,
    ).flatMap((entry) => entry.items.map((entry) => entry.id))
    expect(ids).not.toContain('core.subgraph.extract')
    expect(ids).not.toContain('core.subgraph.flatten')
  })
})

describe('widgetRepresentationMenuGroup', () => {
  const spec: WidgetSpec = {
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
  }

  it('offers schema-declared alternatives and marks the effective selection', () => {
    const group = widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'text', spec, selected: 'multiline',
    })!
    expect(group.group).toBe('45-widget-representation')
    const submenu = group.items[0]!
    expect(submenu.label).toBe('Representation')
    expect(submenu.children?.map((entry) => ({ id: entry.id, checked: entry.checked }))).toEqual([
      { id: 'core.widget.representation.single-line', checked: false },
      { id: 'core.widget.representation.multiline', checked: true },
    ])
    expect(submenu.children?.[0]?.action).toEqual({
      kind: 'command',
      invocation: {
        command: 'view.setWidgetRepresentation',
        params: { graphId: 'g0', nodeId: 'n1', inputId: 'text', representation: 'single-line' },
      },
    })
  })

  it('synthesizes ordinary string alternatives and honors explicit locks', () => {
    const ordinary = widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'text', selected: 'multiline',
      spec: { widgetType: 'STRING', options: { multiline: true } },
    })
    expect(ordinary?.items[0]?.children?.map((entry) => entry.label)).toEqual(['Single line', 'Multiline'])

    expect(widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'text', selected: 'multiline',
      spec: { ...spec, representations: { ...spec.representations!, userSwitchable: false } },
    })).toBeUndefined()
    expect(widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'text', selected: 'multiline',
      spec: {
        ...spec,
        representations: {
          default: 'multiline',
          userSwitchable: true,
          representations: [spec.representations!.representations[1]!],
        },
      },
    })).toBeUndefined()
  })

  it('disables every action for non-editable widget rows', () => {
    const group = widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'text', spec, selected: 'multiline', disabled: true,
    })!
    expect(group.items[0]?.disabled).toBe(true)
    expect(group.items[0]?.children?.every((entry) => entry.disabled === true)).toBe(true)
  })

  it('addresses dynamic rows by value key and forwarded rows by their document owner', () => {
    expect(widgetRepresentationAddress(hit({
      kind: 'widget', node: { id: 'visible' }, row: { valueKey: 'family.member.text' },
    }) as Extract<Hit, { kind: 'widget' }>, 'g0')).toEqual({
      graphId: 'g0', nodeId: 'visible', inputId: 'family.member.text',
    })
    expect(widgetRepresentationAddress(hit({
      kind: 'widget',
      node: { id: 'instance' },
      row: {
        valueKey: 'forwarded.member.text',
        familyOwner: {
          graphId: 'definition', nodeId: 'owner', construct: 'boundary', valueKey: 'boundary.persisted.text',
        },
      },
    }) as Extract<Hit, { kind: 'widget' }>, 'g0')).toEqual({
      graphId: 'definition', nodeId: 'owner', inputId: 'boundary.persisted.text',
    })
  })
})

// menuTargetOf only reads the discriminant plus the identity fields asserted
// below, so fixtures carry exactly those (cast through unknown - full scene
// objects would drag in layout state irrelevant to the mapping).
const hit = (h: unknown): Hit => h as Hit

describe('menuTargetOf', () => {

  it('carries the OWNER triple for forwarded-family widget rows (valueKey IS the owner elaborated id)', () => {
    expect(
      menuTargetOf(hit({
        kind: 'widget',
        node: { id: 'inst' },
        row: {
          inputId: 'lora.m1.strength',
          address: { port: 'lora.m1.strength' },
          familyOwner: { graphId: 'sub', nodeId: 'owner', construct: 'b0', valueKey: 'b0.m1.strength' },
        },
      })),
    ).toEqual({
      kind: 'widget',
      nodeId: 'inst',
      inputId: 'lora.m1.strength',
      address: { port: 'lora.m1.strength' },
      owner: { graphId: 'sub', nodeId: 'owner', inputId: 'b0.m1.strength' },
    })
  })

  it('flags unpersisted widget rows and taps synthetic (ghost, materialize)', () => {
    const flagged = (row: object) =>
      (menuTargetOf(hit({ kind: 'widget', node: { id: 'n1' }, row: { address: { port: 'x' }, ...row } })) as { synthetic?: true }).synthetic
    expect(flagged({ inputId: 'x', ghost: true })).toBe(true)
    expect(flagged({ inputId: 'x', materialize: [{ construct: 'c', member: 'm' }] })).toBe(true)
    expect(flagged({ inputId: 'x' })).toBeUndefined()
    const construct = (row: object) =>
      (menuTargetOf(hit({ kind: 'widget', node: { id: 'n1' }, row: { address: { port: 'x' }, inputId: 'x', ...row } })) as { construct?: true }).construct
    expect(construct({ selector: { construct: 'mode' } })).toBe(true)
    expect(construct({ dynamicSlot: { construct: 'value', variants: [] } })).toBe(true)
    expect(construct({})).toBeUndefined()
    const tapFlagged = (pin: unknown) =>
      (menuTargetOf(hit({ kind: 'widgetTap', node: { id: 'n1' }, input: 'x', pin })) as { synthetic?: true }).synthetic
    expect(tapFlagged({ ghost: true })).toBe(true)
    expect(tapFlagged({})).toBeUndefined()
  })

})

describe('toolbox more menu parity', () => {
  const resolve = (selection: MenuContext['selection'], target: MenuContext['target']) => {
    const registry = createMenuRegistry()
    registry.register({
      id: 'test.node-selection',
      targets: ['node'],
      group: '10-node',
      resolve: (ctx) => [
        item(`target:${ctx.target.kind === 'node' ? ctx.target.nodeId : ''}`),
        item(`nodes:${ctx.selection.nodes.join(',')}`),
        item(`links:${ctx.selection.links.join(',')}`),
        item(`reroutes:${ctx.selection.reroutes.join(',')}`),
        item('core.node.queueSelection'),
      ],
    })
    const ctx = canvasMenuContext({
      doc: {} as WorkflowDocument,
      namedNets: true,
      graphId: 'g0',
      target,
      selection,
      worldX: 10,
      worldY: 20,
    })
    return resolveNodeMenuGroups(registry, ctx, false).flatMap((group) =>
      group.items.map((entry) => ({ id: entry.id, disabled: entry.disabled === true })),
    )
  }

  it('more action resolves the same menu items as right-click for a single selection', () => {
    const rightClickTarget = menuTargetOf(hit({ kind: 'body', node: { id: 'n1' } }))
    const request = toolboxMenuRequest({
      button: { id: 'core.more', label: 'More actions' }, x: 100, y: 40, size: 28,
    }, ['n1'])!
    expect(request).toMatchObject({ worldX: 114, worldY: 54 })
    const selection = { nodes: ['n1'], links: ['l1'], reroutes: ['r1'] }
    expect(resolve(selection, request.target)).toEqual(resolve(selection, rightClickTarget))
    expect(resolve(selection, request.target)).toContainEqual({ id: 'core.node.queueSelection', disabled: true })
  })

  it('more action resolves the same menu items as right-click for a multi-selection', () => {
    const rightClickTarget = menuTargetOf(hit({ kind: 'body', node: { id: 'n1' } }))
    const request = toolboxMenuRequest({
      button: { id: 'core.more', label: 'More actions' }, x: 100, y: 40, size: 28,
    }, ['n1', 'n2'])!
    const selection = { nodes: ['n1', 'n2'], links: ['l1'], reroutes: ['r1'] }
    expect(resolve(selection, request.target)).toEqual(resolve(selection, rightClickTarget))
  })
})
