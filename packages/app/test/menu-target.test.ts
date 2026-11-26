import { describe, expect, it } from 'vitest'
import { buildScene, defaultTokens, type Hit } from '@dinkster/canvas'
import { asNodeId, boundaryItems, coreCommandRegistry, createMenuRegistry, DocumentStore, effectiveOccurrenceTopology, isPortEndpoint, loadDocument, planOccurrenceLinkMutation, resolveWidgetRepresentation, type MenuContext, type MenuItem, type NodeSchema, type ResolvedMenuGroup, type WidgetSpec, type WorkflowDocument } from '@dinkster/core'
import { intKind } from '@dinkster/widgets'
import { toolboxMenuRequest } from '../src/CanvasHost.js'
import { canvasMenuContext, curveHistogramMenuGroup, menuFlat, menuTargetOf, resolveNodeMenuGroups, selectionLifecycleMenuGroups, widgetRepresentationAddress, widgetRepresentationMenuGroup } from '../src/menu-target.js'

const item = (id: string): MenuItem => ({
  id,
  label: id,
  action: { kind: 'host', action: 'noop' },
})

const group = (name: string, ...ids: string[]): ResolvedMenuGroup => ({
  group: name,
  items: ids.map(item),
})

describe('curve histogram menu', () => {
  const curve: NodeSchema = {
    type: 'Curves', displayName: 'Curves', category: 'test', source: 'v3', isOutputNode: false,
    body: [{ kind: 'group', id: 'curves', member: [
      { kind: 'input', id: 'curve', type: { kind: 'concrete', name: 'CURVE' }, optional: true, widget: { widgetType: 'CURVE', options: { histogram: 'bins' } } },
      { kind: 'input', id: 'bins', type: { kind: 'concrete', name: 'HISTOGRAM' }, optional: true },
    ], keys: { kind: 'numbered', prefix: '', start: 1, pad: 0 }, grows: 'button', minMembers: 2 }],
  }
  const source: NodeSchema = {
    type: 'Source', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
    body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'HISTOGRAM' } }],
  }
  const resolve = (type: string) => type === curve.type ? curve : type === source.type ? source : undefined
  const port = (member: number) => ({ node: 'curves', port: `curves.${member}.bins` })
  const fixture = (delivery: 'link' | 'net' | 'boundary') => loadDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'histogram-menu', root: 'g0',
    graphs: { g0: {
      id: 'g0', name: 'Curves', nextOrdinal: 10,
      nodes: { curves: { id: 'curves', type: curve.type, values: {}, dynamic: { curves: { members: ['1', '2'] } } }, source: { id: 'source', type: 'Source', values: {} } },
      links: delivery === 'link' ? { wire: { id: 'wire', from: { node: 'source', port: 'out' }, to: port(1) } } : {},
      nets: delivery === 'net' ? { net: { id: 'net', name: 'Histogram', source: { node: 'source', port: 'out' }, sinks: [port(1), port(2)] } } : {},
      reroutes: {},
      ...(delivery === 'boundary' ? { boundary: { body: [{ kind: 'input', id: 'feed', binds: { kind: 'port', ...port(1) }, alsoBinds: [{ kind: 'port', ...port(2) }] }] } } : {}),
    } }, view: { graphs: {} },
  }).document!
  const menu = (document: WorkflowDocument, member = 1, disabled = false, occurrence?: Parameters<typeof buildScene>[0]['occurrence']) => {
    const scene = buildScene({ document, graphId: 'g0', resolve, tokens: defaultTokens, measure: (text) => text.length * 7,
      widgetMeasure: () => ({ viewId: 'core.curve', rows: 2 }), ...(occurrence === undefined ? {} : { occurrence }) })
    const node = scene.nodes.find((node) => node.id === 'curves')!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.valueKey === `curves.${member}.curve`)!
    if (row.kind !== 'widget') throw new Error('curve widget missing')
    return curveHistogramMenuGroup({ document, scene, hit: { node, row }, resolve, disabled,
      planner: { planOccurrenceLinkMutation } })!.items[0]!
  }
  for (const delivery of ['link', 'net', 'boundary'] as const) {
    it(`hides a group member and disconnects its ${delivery} in one undo, preserving its neighbour`, () => {
      const store = new DocumentStore(fixture(delivery), coreCommandRegistry())
      const before = store.doc
      const action = menu(before)
      expect(action.label).toBe('Hide histogram input')
      expect(action.disabled, action.disabledReason).toBe(false)
      if (action.action?.kind !== 'command') throw new Error('command missing')
      expect(store.dispatch(action.action.invocation).ok).toBe(true)
      expect(store.doc.view.graphs.g0!.nodes.curves!.histogramVisibility).toEqual({ 'curves.1.curve': false })
      expect(menu(store.doc).label).toBe('Show histogram input')
      expect(menu(store.doc, 2).label).toBe('Hide histogram input')
      if (delivery === 'link') expect(store.doc.graphs.g0!.links).toEqual({})
      if (delivery === 'net') expect(store.doc.graphs.g0!.nets.net!.sinks).toEqual([port(2)])
      if (delivery === 'boundary') expect(boundaryItems(store.doc.graphs.g0!.boundary, 'inputs')[0]!.binds).toEqual({ kind: 'port', ...port(2) })
      const saved = loadDocument(JSON.parse(JSON.stringify(store.doc)))
      expect(menu(saved.document!).label).toBe('Show histogram input')
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(before)
      expect(store.redo()).toBe(true)
      expect(menu(store.doc).label).toBe('Show histogram input')
      expect(menu(store.doc, 1, true).disabled).toBe(true)
    })
  }
  it('disconnects only the drilled occurrence and undoes visibility and topology together', () => {
    const body = fixture('link')
    const document = loadDocument({ ...body, root: 'outer', graphs: { ...body.graphs, outer: {
      id: 'outer', name: 'Outer', nextOrdinal: 1, links: {}, nets: {}, reroutes: {},
      nodes: { first: { id: 'first', type: '#g0', values: {} }, second: { id: 'second', type: '#g0', values: {} } },
    } } }).document!
    const occurrence = { owner: { instancePath: [], node: asNodeId('first') }, plannerAvailable: true }
    const store = new DocumentStore(document, coreCommandRegistry())
    const action = menu(store.doc, 1, false, occurrence)
    expect(action.disabled).toBe(false)
    if (action.action?.kind !== 'command') throw new Error('command missing')
    const outcome = store.dispatch(action.action.invocation)
    expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
    expect(menu(store.doc, 1, false, occurrence).label).toBe('Show histogram input')
    const other = effectiveOccurrenceTopology(store.doc, resolve, { instancePath: [], node: asNodeId('second') })
    expect(other.links.some((link) => isPortEndpoint(link.to.endpoint) && link.to.endpoint.port === 'curves.1.bins')).toBe(true)
    expect(store.doc.graphs.g0!.links.wire).toEqual(document.graphs.g0!.links.wire)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(document)
  })
  for (const delivery of ['net', 'boundary', 'parent-boundary', 'parent-boundary-fanout'] as const) {
    it(`hides a drilled ${delivery} histogram without changing its definition or sibling delivery`, () => {
      const body = fixture(delivery === 'net' ? 'net' : 'boundary')
      const document = loadDocument({ ...body, root: 'outer', graphs: { ...body.graphs,
        g0: { ...body.graphs.g0!, ...(delivery === 'parent-boundary' ? {
          boundary: { body: [{ kind: 'input', id: 'feed', binds: { kind: 'port', ...port(1) } }] },
        } : {}) },
        outer: {
          id: 'outer', name: 'Outer', nextOrdinal: 1, nets: {}, reroutes: {},
          nodes: { first: { id: 'first', type: '#g0', values: {} }, second: { id: 'second', type: '#g0', values: {} }, source: { id: 'source', type: 'Source', values: {} } },
          links: delivery.startsWith('parent-') ? {
            firstWire: { id: 'firstWire', from: { node: 'source', port: 'out' }, to: { node: 'first', port: 'feed' } },
            secondWire: { id: 'secondWire', from: { node: 'source', port: 'out' }, to: { node: 'second', port: 'feed' } },
          } : {},
        },
      }, view: { graphs: { g0: { nodes: { curves: { editors: { 'curves.1.curve': { unfolded: true }, 'curves.2.curve': { unfolded: true } } } } } } } }).document!
      const occurrence = { owner: { instancePath: [], node: asNodeId('first') }, plannerAvailable: true }
      const store = new DocumentStore(document, coreCommandRegistry())
      const scene = () => buildScene({ document: store.doc, graphId: 'g0', resolve, tokens: defaultTokens, measure: (text) => text.length * 7,
        widgetMeasure: () => ({ viewId: 'core.curve', rows: 2 }), occurrence })
      const before = scene().nodes.find((node) => node.id === 'curves')!
      const siblingBefore = effectiveOccurrenceTopology(document, resolve, { instancePath: [], node: asNodeId('second') })
      const action = menu(store.doc, 1, false, occurrence)
      expect(action.disabled).toBe(false)
      if (action.action?.kind !== 'command') throw new Error('command missing')
      const outcome = store.dispatch(action.action.invocation)
      expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
      const after = scene().nodes.find((node) => node.id === 'curves')!
      expect(after.layout.pins.some((pin) => pin.portId === 'curves.1.bins')).toBe(false)
      expect(after.layout.height).toBe(before.layout.height - defaultTokens.rowHeight)
      expect(menu(store.doc, 1, false, occurrence).label).toBe('Show histogram input')
      expect(menu(store.doc, 1, false, occurrence).disabled).toBe(false)
      const effective = effectiveOccurrenceTopology(store.doc, resolve, occurrence.owner)
      expect([...effective.links, ...effective.projectedParentLinks].some((link) => isPortEndpoint(link.to.endpoint) && link.to.endpoint.port === 'curves.1.bins')).toBe(false)
      expect(effectiveOccurrenceTopology(store.doc, resolve, { instancePath: [], node: asNodeId('second') })).toEqual(siblingBefore)
      expect(store.doc.graphs).toEqual(document.graphs)
      if (delivery === 'net' || delivery === 'parent-boundary-fanout') {
        expect([...effective.links, ...effective.projectedParentLinks].some((link) => isPortEndpoint(link.to.endpoint) && link.to.endpoint.port === 'curves.2.bins')).toBe(true)
      }
      const saved = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(menu(saved, 1, false, occurrence).label).toBe('Show histogram input')
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(document)
      expect(store.redo()).toBe(true)
      expect(menu(store.doc, 1, false, occurrence).label).toBe('Show histogram input')
    })
  }
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
    expect(submenu.label).toBe('Display')
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

  it('offers Color and Number for a whole number shown as a color', () => {
    const tint: WidgetSpec = { widgetType: 'INT', options: { min: 0, max: 0xffffff, display: 'color' } }
    const color = widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'tint', selected: 'color',
      spec: resolveWidgetRepresentation(tint, undefined, intKind.representations?.(tint)).spec,
    })!
    expect(color.items[0]?.children?.map((entry) => [entry.label, entry.checked])).toEqual([['Color', true], ['Number', false]])
    expect(widgetRepresentationMenuGroup({
      graphId: 'g0', nodeId: 'n1', inputId: 'count',
      spec: { widgetType: 'INT', options: { min: 0, max: 10 } },
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
