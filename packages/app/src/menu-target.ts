/**
 * Framework-free context-menu helpers: the anchor shape the host constructs
 * at open time, the flat item list keyboard navigation walks, and the
 * canvas-hit -> menu-target mapping that MenuRegistry items are resolved
 * against. Kept out of ContextMenu.tsx so unit tests (node environment, no
 * Solid transform) can pin them directly - same split as combo-search.ts.
 */

import type { Hit, OccurrenceMutationPlanner, Scene } from '@dinkster/canvas'
import { boundaryItems, coreCommandRegistry, createTransactionBuilder, effectiveOccurrenceTopology, executeCommand, isPortEndpoint, outputsOf, supportsExpressionMirror, supportsGlslMirror, supportsOutputRepresentation, widgetRepresentationsOf, type CommandInvocation, type Json, type MenuContext, type MenuItem, type MenuRegistry, type MenuTarget, type NodeSchema, type ResolvedMenuGroup, type SchemaResolver, type WidgetSpec, type WorkflowDocument } from '@dinkster/core'

/** Where and on what the menu opened; anchored in canvas-pane CSS px. */
export interface MenuAnchor {
  readonly x: number
  readonly y: number
  readonly worldX: number
  readonly worldY: number
  readonly groups: readonly ResolvedMenuGroup[]
}

/** Flat item list (for keyboard nav); sep marks the first item of a later group. */
export function menuFlat(groups: readonly ResolvedMenuGroup[]): { item: MenuItem; sep: boolean }[] {
  const out: { item: MenuItem; sep: boolean }[] = []
  groups.forEach((g, gi) => {
    g.items.forEach((item, ii) => out.push({ item, sep: gi > 0 && ii === 0 }))
  })
  return out
}

/** Resolve a canvas menu, including app-owned availability overrides. */
export function resolveNodeMenuGroups(
  registry: MenuRegistry,
  ctx: MenuContext,
  queueUpToAvailable: boolean,
  createSubgraphAvailable = true,
  queueUpToReason?: string,
): readonly ResolvedMenuGroup[] {
  return registry.resolve(ctx).map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.id === 'core.node.queueSelection' && !queueUpToAvailable
        ? { ...item, disabled: true, ...(queueUpToReason === undefined ? {} : { disabledReason: queueUpToReason }) }
        : (item.id === 'core.canvas.createSubgraph' || item.id.startsWith('core.canvas.create') && item.id.endsWith('Region')) && !createSubgraphAvailable
          ? { ...item, disabled: true }
          : item),
  }))
}

/** Lifecycle actions belong only to selection-level construct menus. */
export function selectionLifecycleMenuGroups(
  target: MenuTarget,
  group: ResolvedMenuGroup,
): readonly ResolvedMenuGroup[] {
  switch (target.kind) {
    case 'node':
    case 'group':
    case 'reroute':
      return [group]
    default:
      return []
  }
}

/** Offer enclosing definitions only along the navigation's exact occurrence path. */
export function ancestorPromotionMenuGroup(
  groups: readonly ResolvedMenuGroup[],
  doc: WorkflowDocument,
  graphStack: readonly string[],
  instancePath: readonly string[] | undefined,
  disabled: boolean,
  target?: MenuTarget,
): ResolvedMenuGroup | undefined {
  if (instancePath === undefined || instancePath.length !== graphStack.length - 1 || graphStack.length < 3) return undefined
  const candidates = groups.flatMap((group) => group.items).filter((item) =>
    item.id === 'core.widget.subgraphNode.show' || item.id === 'core.widget.subgraphNode.remove' ||
    item.id.startsWith('core.boundary.showWhole.') || item.id.startsWith('core.boundary.hideWhole.'))
  const graphId = graphStack.at(-1)!
  if (target?.kind === 'widget' && target.synthetic !== true && target.address !== undefined &&
      !candidates.some((item) => item.id.startsWith('core.widget.subgraphNode.')) &&
      boundaryItems(doc.graphs[graphId]?.boundary, 'inputs').some((item) => item.promoted === true &&
        [item.binds, ...(item.alsoBinds ?? [])].some((binding) => binding.kind === 'port' && binding.node === target.nodeId && binding.port === target.address!.port))) {
    candidates.push({ id: 'core.widget.subgraphNode.show', label: 'Show on subgraph node', action: {
      kind: 'command', invocation: { command: 'boundary.showOnSubgraphNode', params: { graphId, node: target.nodeId, port: target.address.port } },
    } })
  }
  const items = candidates.flatMap((item) => {
    const action = item.action
    if (action?.kind !== 'command') return []
    const params = action.invocation.params
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return []
    const { graphId, node, port } = params as { readonly [key: string]: Json }
    if (typeof graphId !== 'string' || typeof node !== 'string' || typeof port !== 'string') return []
    return [{ id: `ancestor.${item.id}`, label: item.label.replace(/^Remove (.+) from subgraph node$/, 'Show $1 on ancestor')
      .replace('Remove from subgraph node', 'Show on ancestor').replace('on subgraph node', 'on ancestor'),
    disabled: disabled || item.disabled === true,
    children: graphStack.slice(1, -1).map((ancestor, index) => ({
      id: `ancestor.${item.id}.${index}`, label: doc.graphs[ancestor]?.name || ancestor,
      action: { kind: 'host' as const, action: 'showOnAncestor', params: {
        graphId, node, port,
        ancestors: graphStack.slice(index + 1, -1).map((parent, offset) => ({
          graphId: parent, node: instancePath[index + 1 + offset]!,
        })).reverse(),
      } },
    })).reverse() }]
  })
  return items.length === 0 ? undefined : { group: '86-ancestor-promotion', items }
}

/**
 * Context-menu switcher for a schema-authorized representation set. The command
 * writes view state only; the schema/default/value/socket remain untouched.
 */
export function widgetRepresentationMenuGroup(input: {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly spec: WidgetSpec
  readonly selected?: string
  readonly disabled?: boolean
}): ResolvedMenuGroup | undefined {
  const set = widgetRepresentationsOf(input.spec)
  if (set === undefined || !set.userSwitchable || set.representations.length < 2) return undefined
  return {
    group: '45-widget-representation',
    items: [{
      id: 'core.widget.representation',
      label: 'Representation',
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      children: set.representations.map((representation) => ({
        id: `core.widget.representation.${representation.id}`,
        label: representation.displayName || representation.id,
        checked: input.selected === representation.id,
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
        action: {
          kind: 'command' as const,
          invocation: {
            command: 'view.setWidgetRepresentation',
            params: {
              graphId: input.graphId,
              nodeId: input.nodeId,
              inputId: input.inputId,
              representation: representation.id,
            },
          },
        },
      })),
    }],
  }
}

/**
 * Document address for representation view state. Dynamic widgets key view
 * state by their elaborated value key, and a row whose value is stored by a
 * promoted boundary input belongs to that owning instance node rather than
 * the visible node.
 */
export function widgetRepresentationAddress(
  hit: Extract<Hit, { kind: 'widget' }>,
  graphId: string,
): { readonly graphId: string; readonly nodeId: string; readonly inputId: string } {
  return {
    graphId: hit.row.familyOwner?.graphId ?? graphId,
    nodeId: hit.row.familyOwner?.nodeId ?? hit.node.id,
    inputId: hit.row.familyOwner?.valueKey ?? hit.row.valueKey,
  }
}

/** A curve owns its histogram visibility, independently of its value's owner. */
export function curveHistogramMenuGroup(input: {
  readonly document: WorkflowDocument
  readonly scene: Scene
  readonly hit: Pick<Extract<Hit, { kind: 'widget' }>, 'node' | 'row' | 'bnode'>
  readonly resolve: SchemaResolver
  readonly planner?: OccurrenceMutationPlanner
  readonly disabled: boolean
}): ResolvedMenuGroup | undefined {
  const { document, scene, hit } = input
  const histogram = hit.row.histogram
  if (hit.bnode !== undefined || histogram === undefined) return undefined
  const graphId = scene.graphId
  const nodeId = hit.node.id
  const valueKey = hit.row.valueKey
  const shown = histogram.connected ||
    (document.view.graphs[graphId]?.nodes[nodeId]?.histogramVisibility?.[valueKey] ?? hit.row.spec.options['histogramVisible']) !== false
  const invocations: CommandInvocation[] = []
  let disabledReason: string | undefined
  if (shown && histogram.connected) {
    if (scene.occurrence !== undefined) {
      const effective = effectiveOccurrenceTopology(document, input.resolve, scene.occurrence.owner)
      const links = [...effective.links, ...effective.projectedParentLinks].filter((link) =>
        link.to.graphId === graphId && isPortEndpoint(link.to.endpoint) && link.to.endpoint.node === nodeId && link.to.endpoint.port === histogram.portId)
      // Each trusted plan fingerprints the document after earlier removals.
      // Nothing is published until the complete batch is dispatched.
      const tx = createTransactionBuilder(document)
      const registry = coreCommandRegistry([], input.resolve)
      disabledReason = effective.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message
      if (links.length === 0) disabledReason ??= 'The histogram connection cannot be resolved.'
      for (const link of links) {
        if (disabledReason !== undefined) break
        const planned = input.planner?.planOccurrenceLinkMutation(tx.current, input.resolve, {
          kind: 'disconnect', ...scene.occurrence, link: link.identity,
        })
        if (planned === undefined || !planned.ok) {
          disabledReason = planned === undefined ? 'Occurrence-local link editing is unavailable.' : planned.diagnostics[0]?.message ?? 'The histogram connection cannot be resolved.'
          break
        }
        const diagnostics = executeCommand(registry.get(planned.invocation.command)!, tx.current, planned.invocation.params, tx, { kind: 'initial' })
        disabledReason = diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message
        invocations.push(planned.invocation)
      }
    } else {
      const graph = document.graphs[graphId]!
      const targetsHistogram = (end: { readonly node: string; readonly port: string }) => end.node === nodeId && end.port === histogram.portId
      for (const link of Object.values(graph.links)) {
        if (isPortEndpoint(link.to) && targetsHistogram(link.to)) invocations.push({ command: 'link.disconnect', params: { graphId, linkId: link.id } })
      }
      if (Object.values(graph.nets).some((net) => net.sinks.some(targetsHistogram))) {
        invocations.push({ command: 'net.disconnectInput', params: { graphId, to: { node: nodeId, port: histogram.portId } } })
      }
      for (const item of boundaryItems(graph.boundary, 'inputs')) {
        if ([item.binds, ...(item.alsoBinds ?? [])].some((binding) => binding.kind === 'port' && targetsHistogram(binding))) {
          invocations.push({ command: 'boundary.unbind', params: { graphId, side: 'inputs', itemId: item.id, node: nodeId, port: histogram.portId } })
        }
      }
      if (invocations.length === 0) disabledReason = 'The histogram connection cannot be resolved.'
    }
  }
  invocations.push({ command: 'view.setHistogramVisible', params: { graphId, nodeId, valueKey, visible: !shown } })
  return {
    group: '45-curve-histogram',
    items: [{
      id: 'core.widget.histogramVisibility', label: shown ? 'Hide histogram input' : 'Show histogram input',
      disabled: input.disabled || disabledReason !== undefined,
      ...(disabledReason === undefined ? {} : { disabledReason }),
      action: { kind: 'command', invocation: invocations.length === 1 ? invocations[0]! : { command: 'batch', params: { invocations: invocations as unknown as Json } } },
    }],
  }
}

/**
 * Live-preview capability callback for menu gating, or undefined when the
 * schema resolver is unavailable. Current backends declare `emitsPreviews`
 * on capable node types and skip preview work for the rest.
 */
export function previewCapabilityOf(
  resolve: ((nodeType: string) => { readonly emitsPreviews?: boolean } | undefined) | undefined,
): ((nodeType: string) => boolean) | undefined {
  if (resolve === undefined) return undefined
  return (nodeType) => resolve(nodeType)?.emitsPreviews === true
}

/**
 * Mirror-estimate capability callback for menu gating: whether a node
 * type's schema declares a mirror this frontend can evaluate locally. No
 * wire gating: mirror declarations carry their own support checks, and a
 * catalog without them simply yields no capable nodes.
 */
export function mirrorCapabilityOf(
  resolve: ((nodeType: string) => NodeSchema | undefined) | undefined,
): ((nodeType: string) => boolean) | undefined {
  if (resolve === undefined) return undefined
  return (nodeType) => {
    const schema = resolve(nodeType)
    return schema !== undefined && (
      supportsExpressionMirror(schema) ||
      supportsGlslMirror(schema) ||
      outputsOf(schema).some((output) => supportsOutputRepresentation(output.represents))
    )
  }
}

/** Build the one menu context consumed by both canvas right-click and More. */
export function canvasMenuContext(input: {
  readonly doc: WorkflowDocument
  readonly namedNets: boolean
  readonly graphId: string
  readonly target: MenuTarget
  readonly selection: MenuContext['selection']
  readonly worldX: number
  readonly worldY: number
  /** Schema display name of the target node; lets items detect real renames. */
  readonly nodeDisplayName?: string
  /** Full help availability for the target node. */
  readonly nodeHasDocs?: boolean
  /** Live-preview capability by node type; omitted = unknown (menu everywhere). */
  readonly previewCapable?: (nodeType: string) => boolean
  /** Mirror-estimate capability by node type; omitted = unknown (menu hidden). */
  readonly mirrorCapable?: (nodeType: string) => boolean
  /** Node schemas by type, for items that read a node's rows. */
  readonly resolve?: (nodeType: string) => NodeSchema | undefined
  readonly shortcuts?: Readonly<Record<string, string>>
}): MenuContext {
  return {
    doc: input.doc,
    features: { namedNets: input.namedNets },
    ...(input.nodeDisplayName !== undefined ? { nodeDisplayName: input.nodeDisplayName } : {}),
    ...(input.nodeHasDocs !== undefined ? { nodeHasDocs: input.nodeHasDocs } : {}),
    ...(input.previewCapable !== undefined ? { previewCapable: input.previewCapable } : {}),
    ...(input.mirrorCapable !== undefined ? { mirrorCapable: input.mirrorCapable } : {}),
    ...(input.resolve !== undefined ? { resolve: input.resolve } : {}),
    ...(input.shortcuts !== undefined ? { shortcuts: input.shortcuts } : {}),
    graphId: input.graphId,
    target: input.target,
    selection: input.selection,
    worldX: input.worldX,
    worldY: input.worldY,
  }
}

/** Widget-row menu identity shared by context menus and lens affordances. */
export function widgetMenuTarget(
  nodeId: string,
  row: Extract<Hit, { kind: 'widget' }>['row'],
): MenuTarget {
  const synthetic = row.ghost === true || row.materialize !== undefined
  const owner =
    !synthetic && row.familyOwner !== undefined
      ? {
          owner: {
            graphId: row.familyOwner.graphId,
            nodeId: row.familyOwner.nodeId,
            inputId: row.familyOwner.valueKey,
          },
        }
      : {}
  return {
    kind: 'widget',
    nodeId,
    inputId: row.inputId,
    address: { port: row.address.port },
    ...owner,
    ...(synthetic ? { synthetic: true as const } : {}),
    ...(row.selector !== undefined || row.dynamicSlot !== undefined ? { construct: true as const } : {}),
  }
}

/** Canvas hit -> plain menu target. */
export function menuTargetOf(hit: Hit): MenuTarget {
  switch (hit.kind) {
    case 'empty':
      return { kind: 'canvas' }
    case 'link':
      return {
        kind: 'link',
        linkId: hit.link.id,
        ...(hit.link.netId !== undefined ? { netId: hit.link.netId } : {}),
        to:
          hit.link.to.kind === 'port'
            ? {
                node: hit.link.to.node,
                port: hit.link.to.port,
              }
            : hit.link.to.kind === 'reroute'
              ? { reroute: hit.link.to.reroute }
              : // 'boundary' ends are unreachable: boundary noodles are
                // excluded from link hit-testing.
                { reroute: '' },
      }
    case 'reroute':
    // Ghost sockets never reach the context menu (its hitTest does not
    // reveal them), but the junction menu is the right fallback anyway.
    case 'rerouteSocket':
      return { kind: 'reroute', rerouteId: hit.reroute.id }
    case 'pin':
      // Structural identity (address), not the elab view key: menu items
      // build command endpoints from this.
      return {
        kind: 'pin',
        nodeId: hit.node.id,
        portId: hit.pin.address.port,
        direction: hit.direction,
      }
    case 'widgetTap':
      return {
        kind: 'widget',
        nodeId: hit.node.id,
        inputId: hit.input,
        // Tap pins carry no owner value key, so unpersisted taps can only
        // be flagged, never redirected.
        ...(hit.pin.ghost === true || hit.pin.materialize !== undefined
          ? { synthetic: true as const }
          : {}),
      }
    case 'widget':
      // A field on a subgraph's Inputs panel belongs to the panel, which has
      // no menu of its own. An editor row stores nothing of its own: it opens
      // the node's menu.
      if (hit.bnode !== undefined) return { kind: 'canvas' }
      return hit.row.editor === true ? { kind: 'node', nodeId: hit.node.id } : widgetMenuTarget(hit.node.id, hit.row)
    case 'growth':
      return { kind: 'growth', nodeId: hit.node.id, construct: hit.row.construct }
    case 'section':
      return {
        kind: 'section',
        nodeId: hit.node.id,
        sectionId: hit.row.sectionId,
        collapsed: hit.row.collapsed,
      }
    case 'netStub':
      return {
        kind: 'net',
        netId: hit.stub.netId,
        role: hit.stub.role,
        nodeId: hit.stub.nodeId,
        portId: hit.stub.portId,
      }
    case 'group-header':
    case 'group-resize':
      return { kind: 'group', groupId: hit.group.id }
    case 'boundary-pin':
    case 'boundary-header':
    case 'boundary-body':
      // Boundary pseudo-nodes are derived view affordances, not document
      // nodes; there is no boundary menu contract yet.
      return { kind: 'canvas' }
    default:
      return { kind: 'node', nodeId: hit.node.id }
  }
}
