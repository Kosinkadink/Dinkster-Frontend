/**
 * Framework-free context-menu helpers: the anchor shape the host constructs
 * at open time, the flat item list keyboard navigation walks, and the
 * canvas-hit -> menu-target mapping that MenuRegistry items are resolved
 * against. Kept out of ContextMenu.tsx so unit tests (node environment, no
 * Solid transform) can pin them directly - same split as combo-search.ts.
 */

import type { Hit } from '@dinkster/canvas'
import { outputsOf, supportsExpressionMirror, supportsGlslMirror, supportsOutputRepresentation, widgetRepresentationsOf, type MenuContext, type MenuItem, type MenuRegistry, type MenuTarget, type NodeSchema, type ResolvedMenuGroup, type WidgetSpec, type WorkflowDocument } from '@dinkster/core'

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
): readonly ResolvedMenuGroup[] {
  return registry.resolve(ctx).map((group) => ({
    ...group,
    items: group.items.map((item) =>
      (item.id === 'core.node.queueSelection' && !queueUpToAvailable) ||
      ((item.id === 'core.canvas.createSubgraph' || item.id.startsWith('core.canvas.create') && item.id.endsWith('Region')) && !createSubgraphAvailable)
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
    case 'valueSource':
    case 'selector':
      return [group]
    default:
      return []
  }
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
 * state by their elaborated value key, and a forwarded family row belongs to
 * its occurrence-view owner rather than the visible instance node.
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
  readonly shortcuts?: Readonly<Record<string, string>>
}): MenuContext {
  return {
    doc: input.doc,
    features: { namedNets: input.namedNets },
    ...(input.nodeDisplayName !== undefined ? { nodeDisplayName: input.nodeDisplayName } : {}),
    ...(input.nodeHasDocs !== undefined ? { nodeHasDocs: input.nodeHasDocs } : {}),
    ...(input.previewCapable !== undefined ? { previewCapable: input.previewCapable } : {}),
    ...(input.mirrorCapable !== undefined ? { mirrorCapable: input.mirrorCapable } : {}),
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
  const synthetic =
    row.ghost === true ||
    row.materialize !== undefined ||
    (row.familyOwner !== undefined && row.familyOwner.valueKey === undefined)
  const owner =
    !synthetic && row.familyOwner?.valueKey !== undefined
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
    ...owner,
    ...(synthetic ? { synthetic: true as const } : {}),
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
                ...(hit.link.to.members !== undefined ? { members: hit.link.to.members } : {}),
              }
            : hit.link.to.kind === 'reroute'
              ? { reroute: hit.link.to.reroute }
              : hit.link.to.kind === 'selector' && hit.link.to.candidate !== undefined
                ? { selector: hit.link.to.selector, candidate: hit.link.to.candidate }
                : // 'boundary' ends are unreachable: boundary noodles are
                  // excluded from link hit-testing.
                  { reroute: '' },
      }
    case 'reroute':
    // Ghost sockets never reach the context menu (its hitTest does not
    // reveal them), but the junction menu is the right fallback anyway.
    case 'rerouteSocket':
      return { kind: 'reroute', rerouteId: hit.reroute.id }
    case 'valueSource':
    case 'valueSourceOut':
    case 'valueSourceBadge':
      return { kind: 'valueSource', valueSourceId: hit.valueSource.id }
    case 'selector':
    case 'selectorIn':
    case 'selectorOut':
    case 'selectorBadge':
      return { kind: 'selector', selectorId: hit.selector.id }
    case 'pin':
      // Structural identity (address), not the elab view key: menu items
      // build command endpoints from this.
      return {
        kind: 'pin',
        nodeId: hit.node.id,
        portId: hit.pin.address.port,
        ...(hit.pin.address.members !== undefined ? { members: hit.pin.address.members } : {}),
        direction: hit.direction,
      }
    case 'widgetTap':
      return {
        kind: 'widget',
        nodeId: hit.node.id,
        inputId: hit.input,
        // Tap pins carry no owner value key, so forwarded/unpersisted taps
        // can only be flagged, never redirected.
        ...(hit.pin.ghost === true || hit.pin.materialize !== undefined || hit.pin.familyOwner !== undefined
          ? { synthetic: true as const }
          : {}),
      }
    case 'widget':
      return widgetMenuTarget(hit.node.id, hit.row)
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
        ...(hit.stub.members !== undefined ? { members: hit.stub.members } : {}),
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
