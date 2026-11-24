/**
 * Core menu contributions. Registered through the exact public
 * MenuRegistry API - the same one extensions use - so the core UI never has
 * a privileged path.
 *
 * Group keys establish the standard menu bands; extensions slot between
 * them: '10-nav' (navigation), '20-mode', '30-layout', '90-edit'
 * (destructive, always last).
 */

import type { NodeMode, PreviewMode } from '../format/document.js'
import { isExposed } from '../format/exposed.js'
import { isPreviewExposed } from '../format/exposed-previews.js'
import { netViewPositions } from '../format/net-views.js'
import { asNodeId, asPortId, samePortRef, type PortRef } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { constructsAround } from '../schema/derive-boundary.js'
import { boundaryFieldState } from '../commands/boundary-commands.js'
import { t } from '../i18n/index.js'
import type { MenuContribution, MenuContext, MenuItem } from './contract.js'

/** Menu-target port -> command PortRef params: the node and flattened port id. */
const portParams = (p: { node: string; port: string }): { node: string; port: string } => ({
  node: p.node,
  port: p.port,
})

const NODE_MODES: readonly { mode: NodeMode; label: string; icon: string; command?: string }[] = [
  { mode: 'active', label: 'Active', icon: 'circle-play' },
  { mode: 'muted', label: 'Muted', icon: 'volume-x', command: 'node.mute' },
  { mode: 'bypassed', label: 'Bypassed', icon: 'ban', command: 'node.bypass' },
]

/** Shared node/group identity palette; null clears back to theme defaults. */
const COLOR_PRESETS: readonly { readonly label: string; readonly color: string | null }[] = [
  { label: 'Default', color: null },
  { label: 'Blue', color: '#355c7d' },
  { label: 'Green', color: '#3f6e4e' },
  { label: 'Red', color: '#7d3b3b' },
  { label: 'Yellow', color: '#7d6f3b' },
  { label: 'Purple', color: '#5e4b7d' },
]

/** Selected nodes when the target rides the selection, else just the target. */
function targetNodeIds(ctx: MenuContext, nodeId: string): readonly string[] {
  return ctx.selection.nodes.includes(nodeId) ? ctx.selection.nodes : [nodeId]
}

const nodeMode: MenuContribution = {
  id: 'core.node.mode',
  targets: ['node'],
  group: '20-mode',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId).filter((id) => def.nodes[id])
    if (nodeIds.length === 0) return []
    const children = NODE_MODES.map(({ mode, label, icon, command }): MenuItem => {
      const checked = nodeIds.every((id) => (def.nodes[id]!.mode ?? 'active') === mode)
      return {
        id: `core.node.mode.${mode}`,
        label,
        icon,
        ...(command !== undefined && ctx.shortcuts?.[command] !== undefined ? { shortcut: ctx.shortcuts[command] } : {}),
        checked,
        action: {
          kind: 'command',
          invocation: { command: 'node.setMode', params: { graphId: ctx.graphId, nodeIds: [...nodeIds], mode } },
        },
      }
    })
    return [{ id: 'core.node.mode', label: 'Mode', icon: 'sliders-horizontal', children }]
  },
}

const NODE_PREVIEW_MODES: readonly { mode: PreviewMode | null; label: string }[] = [
  { mode: null, label: 'Inherit' },
  { mode: 'off', label: 'Off' },
  { mode: 'cheap', label: 'Cheap' },
  { mode: 'quality', label: 'Quality' },
  { mode: 'auto', label: 'Auto' },
]

const nodePreviews: MenuContribution = {
  id: 'core.node.previews',
  targets: ['node'],
  group: '20-mode',
  order: 1,
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    // Schema capability gates the whole submenu: only node types declaring
    // emitsPreviews (or containing one, for subgraphs) get the override,
    // and a mixed selection acts on the capable nodes only. Without a
    // capability source every node keeps the menu.
    const capable = ctx.previewCapable
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId)
      .filter((id) => def.nodes[id])
      .filter((id) => capable === undefined || capable(def.nodes[id]!.type))
    if (nodeIds.length === 0) return []
    const children = NODE_PREVIEW_MODES.map(({ mode, label }): MenuItem => ({
      id: `core.node.previews.${mode ?? 'inherit'}`,
      label,
      checked: nodeIds.every((id) => (def.nodes[id]!.previews ?? null) === mode),
      action: {
        kind: 'command',
        invocation: { command: 'node.setPreviews', params: { graphId: ctx.graphId, nodeIds: [...nodeIds], previews: mode } },
      },
    }))
    return [{ id: 'core.node.previews', label: 'Live previews', icon: 'eye', children }]
  },
}

const NODE_MIRROR_PREVIEW_MODES: readonly { value: boolean | null; label: string }[] = [
  { value: null, label: 'Inherit' },
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
]

const nodeMirrorPreviews: MenuContribution = {
  id: 'core.node.mirrorPreviews',
  targets: ['node'],
  group: '20-mode',
  order: 2,
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    // Capability gates the whole submenu: only node types whose schema
    // declares a mirror this frontend can evaluate get the override, and a
    // mixed selection acts on the capable nodes only. Without a capability
    // source the menu stays hidden - an override on a node that can never
    // estimate would be dead state.
    const capable = ctx.mirrorCapable
    if (capable === undefined) return []
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId)
      .filter((id) => def.nodes[id])
      .filter((id) => capable(def.nodes[id]!.type))
    if (nodeIds.length === 0) return []
    const children = NODE_MIRROR_PREVIEW_MODES.map(({ value, label }): MenuItem => ({
      id: `core.node.mirrorPreviews.${value === null ? 'inherit' : value ? 'on' : 'off'}`,
      label,
      checked: nodeIds.every((id) => (def.nodes[id]!.mirrorPreviews ?? null) === value),
      action: {
        kind: 'command',
        invocation: { command: 'node.setMirrorPreviews', params: { graphId: ctx.graphId, nodeIds: [...nodeIds], mirrorPreviews: value } },
      },
    }))
    return [{ id: 'core.node.mirrorPreviews', label: 'Mirror estimates', icon: 'eye', children }]
  },
}

const nodeColor: MenuContribution = {
  id: 'core.node.color',
  targets: ['node'],
  group: '30-layout',
  order: 1,
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId).filter((id) => def.nodes[id])
    if (nodeIds.length === 0) return []
    const viewNodes = ctx.doc.view.graphs[ctx.graphId]?.nodes ?? {}
    const children = COLOR_PRESETS.map(({ label, color }): MenuItem => {
      const invocations = nodeIds.map((nodeId) => ({
        command: 'view.setNodeColor',
        params: { graphId: ctx.graphId, nodeId, color },
      }))
      return {
        id: `core.node.color.${label.toLowerCase()}`,
        label,
        checked: nodeIds.every((id) => (viewNodes[id]?.color ?? null) === color),
        action: {
          kind: 'command',
          invocation: invocations.length === 1
            ? invocations[0]!
            : { command: 'batch', params: { invocations } },
        },
      }
    })
    return [{ id: 'core.node.color', label: 'Color', icon: 'palette', children }]
  },
}

const nodeMinimize: MenuContribution = {
  id: 'core.node.minimize',
  targets: ['node'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId).filter((id) => def.nodes[id])
    if (nodeIds.length === 0) return []
    const viewNodes = ctx.doc.view.graphs[ctx.graphId]?.nodes ?? {}
    const collapsed = nodeIds.every((nodeId) => viewNodes[nodeId]?.collapsed === true)
    return [{
      id: 'core.node.minimize',
      label: collapsed ? 'Restore' : 'Minimize',
      icon: 'minimize-2',
      ...(ctx.shortcuts?.['node.minimize'] === undefined
        ? {}
        : { shortcut: ctx.shortcuts['node.minimize'] }),
      action: {
        kind: 'command',
        invocation: {
          command: 'view.setNodeCollapsed',
          params: { graphId: ctx.graphId, nodeIds: [...nodeIds], collapsed: !collapsed },
        },
      },
    }]
  },
}

const nodeOpenSubgraph: MenuContribution = {
  id: 'core.node.openSubgraph',
  targets: ['node'],
  group: '10-nav',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const node = ctx.doc.graphs[ctx.graphId]?.nodes[ctx.target.nodeId]
    if (!node) return []
    const defId = subgraphDefIdOf(node.type)
    if (!defId || !ctx.doc.graphs[defId]) return []
    return [
      {
        id: 'core.node.openSubgraph',
        label: 'Open subgraph',
        icon: 'folder-open',
        action: { kind: 'host', action: 'openSubgraph', params: { nodeId: ctx.target.nodeId } },
      },
    ]
  },
}

const nodeHelp: MenuContribution = {
  id: 'core.node.help',
  targets: ['node'],
  group: '10-nav',
  order: 2,
  resolve(ctx) {
    if (ctx.target.kind !== 'node' || ctx.nodeHasDocs !== true) return []
    return [{
      id: 'core.node.help',
      label: t('nodeHelp.action.help'),
      icon: 'circle-help',
      ...(ctx.shortcuts?.['node.help'] === undefined ? {} : { shortcut: ctx.shortcuts['node.help'] }),
      action: { kind: 'host', action: 'openNodeHelp', params: { nodeId: ctx.target.nodeId } },
    }]
  },
}

const nodeLocalize: MenuContribution = {
  id: 'core.node.localize',
  targets: ['node'],
  group: '10-nav',
  order: 1,
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const node = ctx.doc.graphs[ctx.graphId]?.nodes[ctx.target.nodeId]
    const defId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    if (defId === undefined) return []
    const occurrences = Object.values(ctx.doc.graphs).reduce((count, graph) =>
      count + Object.values(graph.nodes).filter((candidate) => subgraphDefIdOf(candidate.type) === defId).length, 0)
    if (occurrences < 2) return []
    return [{
      id: 'core.node.localize',
      label: 'Make unique',
      icon: 'copy-plus',
      action: {
        kind: 'command',
        invocation: { command: 'occurrence.localize', params: { graphId: ctx.graphId, nodeId: ctx.target.nodeId } },
      },
    }]
  },
}

const nodeResetSize: MenuContribution = {
  id: 'core.node.resetSize',
  targets: ['node'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const viewNode = ctx.doc.view.graphs[ctx.graphId]?.nodes[ctx.target.nodeId]
    if (!viewNode?.size) return []
    return [
      {
        id: 'core.node.resetSize',
        label: 'Reset size',
        action: {
          kind: 'command',
          invocation: {
            command: 'view.setNodeSize',
            params: { graphId: ctx.graphId, nodeId: ctx.target.nodeId, size: null },
          },
        },
      },
    ]
  },
}

const nodeRename: MenuContribution = {
  id: 'core.node.rename',
  targets: ['node'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const node = ctx.doc.graphs[ctx.graphId]?.nodes[ctx.target.nodeId]
    if (!node) return []
    return [{
      id: 'core.node.rename',
      label: 'Rename...',
      action: { kind: 'host', action: 'renameNode', params: { nodeId: ctx.target.nodeId } },
    }]
  },
}

const nodeResetName: MenuContribution = {
  id: 'core.node.resetName',
  targets: ['node'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const node = ctx.doc.graphs[ctx.graphId]?.nodes[ctx.target.nodeId]
    if (!node || node.title === undefined || node.title === (ctx.nodeDisplayName ?? node.type)) return []
    return [{
      id: 'core.node.resetName',
      label: 'Reset name',
      action: {
        kind: 'command',
        invocation: { command: 'node.setTitle', params: { graphId: ctx.graphId, nodeId: ctx.target.nodeId, title: null } },
      },
    }]
  },
}

const nodeCompactDynamic: MenuContribution = {
  id: 'core.node.compactDynamic',
  targets: ['node'],
  group: '80-values',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId).filter((nodeId) => {
      const dynamic = def.nodes[nodeId]?.dynamic
      return Object.values(dynamic ?? {}).some((state) => (state.members?.length ?? 0) > 0)
    })
    if (nodeIds.length === 0) return []
    const invocations = nodeIds.map((nodeId) => ({
      command: 'dynamic.compact',
      params: { graphId: ctx.graphId, nodeId },
    }))
    return [{
      id: 'core.node.compactDynamic',
      label: nodeIds.length > 1 ? `Remove unused dynamic inputs from ${nodeIds.length} nodes` : 'Remove unused dynamic inputs',
      action: {
        kind: 'command',
        invocation: invocations.length === 1
          ? invocations[0]!
          : { command: 'batch', params: { invocations } },
      },
    }]
  },
}

const nodeDelete: MenuContribution = {
  id: 'core.node.delete',
  targets: ['node'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const count = targetNodeIds(ctx, ctx.target.nodeId).length
    return [
      {
        id: 'core.node.delete',
        label: count > 1 ? `Delete ${count} nodes` : 'Delete',
        icon: 'trash-2',
        ...(ctx.shortcuts?.['edit.delete'] !== undefined ? { shortcut: ctx.shortcuts['edit.delete'] } : {}),
        action: { kind: 'host', action: 'deleteSelection' },
      },
    ]
  },
}

const nodeCopy: MenuContribution = {
  id: 'core.node.copy',
  targets: ['node'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    return [{
      id: 'core.node.copy',
      label: targetNodeIds(ctx, ctx.target.nodeId).length > 1 ? 'Copy selected nodes' : 'Copy',
      icon: 'copy',
      action: { kind: 'host', action: 'copySelection' },
    }]
  },
}

const nodeQueueSelection: MenuContribution = {
  id: 'core.node.queueSelection',
  targets: ['node'],
  group: '15-run',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    // Partial targets are occurrence-qualified from the ROOT graph. A
    // drilled-in subgraph selection has no single occurrence (the definition
    // may be instantiated many times), so the item is root-only for now.
    if (ctx.graphId !== ctx.doc.root) return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const nodeIds = targetNodeIds(ctx, ctx.target.nodeId).filter((id) => def.nodes[id])
    if (nodeIds.length === 0) return []
    return [
      {
        id: 'core.node.queueSelection',
        label: 'Execute up to selection',
        action: { kind: 'host', action: 'queueSelection', params: { nodeIds: [...nodeIds] } },
      },
    ]
  },
}

const linkDelete: MenuContribution = {
  id: 'core.link.delete',
  targets: ['link'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.target.kind !== 'link') return []
    const t = ctx.target
    // Net-derived noodles have synthetic ids; deletion removes the SINK.
    // (Nets are port-only, so a net noodle's consumer end is always a port.)
    const invocation =
      t.netId !== undefined && 'node' in t.to
        ? { command: 'net.disconnectInput', params: { graphId: ctx.graphId, to: portParams(t.to) } }
        : { command: 'link.disconnect', params: { graphId: ctx.graphId, linkId: t.linkId } }
    return [{ id: 'core.link.delete', label: 'Delete link', action: { kind: 'command', invocation } }]
  },
}

// ---------------------------------------------------------------------------
// Reroutes: junctions on noodles. Splitting a link is the canvas double-click
// gesture; the menu offers the two removal flavors: dissolve (contract the
// span, keep consumers wired to the surviving source) and plain delete.
// ---------------------------------------------------------------------------

/** Selected reroutes when the target rides the selection, else just the target. */
function targetRerouteIds(ctx: MenuContext, rerouteId: string): readonly string[] {
  return ctx.selection.reroutes.includes(rerouteId) ? ctx.selection.reroutes : [rerouteId]
}

const rerouteDissolve: MenuContribution = {
  id: 'core.reroute.dissolve',
  targets: ['reroute'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.target.kind !== 'reroute') return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const ids = targetRerouteIds(ctx, ctx.target.rerouteId).filter((id) => def.reroutes[id])
    if (ids.length === 0) return []
    return [
      {
        id: 'core.reroute.dissolve',
        label: ids.length > 1 ? `Dissolve ${ids.length} reroutes` : 'Dissolve reroute',
        action: {
          kind: 'command',
          invocation: {
            command: 'reroute.remove',
            params: { graphId: ctx.graphId, rerouteIds: [...ids], reconnect: true },
          },
        },
      },
      {
        id: 'core.reroute.delete',
        label: ids.length > 1 ? `Delete ${ids.length} reroutes` : 'Delete reroute',
        action: {
          kind: 'command',
          invocation: {
            command: 'reroute.remove',
            params: { graphId: ctx.graphId, rerouteIds: [...ids], reconnect: false },
          },
        },
      },
    ]
  },
}

const linkAddReroute: MenuContribution = {
  id: 'core.link.addReroute',
  targets: ['link'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'link') return []
    // Net noodles are synthetic (no real link to split); reroute a net by
    // materializing the link first (net.disconnectInput + link.connect).
    if (ctx.target.netId !== undefined) return []
    if (!ctx.doc.graphs[ctx.graphId]?.links[ctx.target.linkId]) return []
    return [
      {
        id: 'core.link.addReroute',
        label: 'Add reroute',
        action: {
          kind: 'command',
          invocation: {
            command: 'reroute.insert',
            params: {
              graphId: ctx.graphId,
              linkId: ctx.target.linkId,
              position: { x: Math.round(ctx.worldX), y: Math.round(ctx.worldY) },
            },
          },
        },
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Named nets: promote an output (Set), connect an input (Get), and manage a
// net from its noodles or its collapsed endpoint tags. All document behavior
// is commands; only name entry (create/rename) is a host action because it
// needs a text popover.
// ---------------------------------------------------------------------------

const pinPromoteToNet: MenuContribution = {
  id: 'core.pin.promoteToNet',
  targets: ['pin'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.features?.namedNets === false) return []
    if (ctx.target.kind !== 'pin' || ctx.target.direction !== 'out') return []
    const t = ctx.target
    if (!ctx.doc.graphs[ctx.graphId]?.nodes[t.nodeId]) return []
    return [
      {
        id: 'core.pin.promoteToNet',
        label: 'Promote to named net...',
        action: { kind: 'host', action: 'promoteToNet', params: { source: portParams({ node: t.nodeId, port: t.portId }) } },
      },
    ]
  },
}

const pinConnectToNet: MenuContribution = {
  id: 'core.pin.connectToNet',
  targets: ['pin'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.features?.namedNets === false) return []
    if (ctx.target.kind !== 'pin' || ctx.target.direction !== 'in') return []
    const t = ctx.target
    const def = ctx.doc.graphs[ctx.graphId]
    if (!def) return []
    const to = portParams({ node: t.nodeId, port: t.portId })
    const toRef: PortRef = {
      node: asNodeId(t.nodeId),
      port: asPortId(t.portId),
    }
    return Object.values(def.nets)
      .filter((net) => net.source.node !== t.nodeId) // self-loop: not offered
      .map((net): MenuItem => {
        const connected = net.sinks.some((s) => samePortRef(s, toRef))
        return {
          id: `core.pin.connectToNet.${net.id}`,
          label: `Connect to net '${net.name}'`,
          checked: connected,
          action: {
            kind: 'command',
            invocation: connected
              ? { command: 'net.disconnectInput', params: { graphId: ctx.graphId, to } }
              : { command: 'net.connectInput', params: { graphId: ctx.graphId, netId: net.id, to } },
          },
        }
      })
  },
}

/** Shared net management items (noodle right-click and endpoint tags). */
function netManageItems(ctx: MenuContext, netId: string): MenuItem[] {
  if (ctx.features?.namedNets === false) return []
  const net = ctx.doc.graphs[ctx.graphId]?.nets[netId]
  if (!net) return []
  const view = ctx.doc.view.graphs[ctx.graphId]
  const collapsed = view?.collapsedNets?.includes(netId) ?? false
  const guide = collapsed && (view?.guideNets?.includes(netId) ?? false)
  const mode = !collapsed ? 'noodle' : guide ? 'guide' : 'tags'
  const modeItem = (target: 'noodle' | 'tags' | 'guide', label: string): MenuItem => ({
    id: `core.net.display.${target}`,
    label,
    checked: mode === target,
    action: {
      kind: 'command',
      invocation: {
        command: 'view.setNetDisplay',
        params: { graphId: ctx.graphId, netId, mode: target },
      },
    },
  })
  return [
    {
      id: 'core.net.display',
      label: `Display for '${net.name}'`,
      children: [
        modeItem('noodle', 'Noodles'),
        modeItem('tags', 'Tags only'),
        modeItem('guide', 'Tags + guide'),
      ],
    },
    {
      id: 'core.net.rename',
      label: `Rename net '${net.name}'...`,
      action: { kind: 'host', action: 'renameNet', params: { netId } },
    },
  ]
}

const linkNetManage: MenuContribution = {
  id: 'core.link.netManage',
  targets: ['link'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'link' || ctx.target.netId === undefined) return []
    return netManageItems(ctx, ctx.target.netId)
  },
}

const netStubManage: MenuContribution = {
  id: 'core.net.stubManage',
  targets: ['net'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'net') return []
    return netManageItems(ctx, ctx.target.netId)
  },
}

const netStubResetPosition: MenuContribution = {
  id: 'core.net.stubResetPosition',
  targets: ['net'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.features?.namedNets === false) return []
    if (ctx.target.kind !== 'net') return []
    const t = ctx.target
    const to: PortRef = {
      node: asNodeId(t.nodeId),
      port: asPortId(t.portId),
    }
    const authored = netViewPositions(ctx.doc, ctx.graphId).some((view) =>
      view.netId === t.netId &&
      (t.role === 'source' ? view.role === 'source' : view.role === 'sink' && samePortRef(view.to, to)))
    if (!authored) return []
    return [
      {
        id: 'core.net.stubResetPosition',
        label: 'Reset tag position',
        action: {
          kind: 'command',
          invocation: {
            command: 'net.resetView',
            params: {
              graphId: ctx.graphId,
              netId: t.netId,
              role: t.role,
              ...(t.role === 'sink'
                ? { to: portParams({ node: t.nodeId, port: t.portId }) }
                : {}),
            },
          },
        },
      },
    ]
  },
}

const netStubDisconnect: MenuContribution = {
  id: 'core.net.stubDisconnect',
  targets: ['net'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.features?.namedNets === false) return []
    if (ctx.target.kind !== 'net' || ctx.target.role !== 'sink') return []
    const t = ctx.target
    return [
      {
        id: 'core.net.stubDisconnect',
        label: 'Disconnect this input',
        action: {
          kind: 'command',
          invocation: { command: 'net.disconnectInput', params: { graphId: ctx.graphId, to: portParams({ node: t.nodeId, port: t.portId }) } },
        },
      },
    ]
  },
}

const netDelete: MenuContribution = {
  id: 'core.net.delete',
  targets: ['link', 'net'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.features?.namedNets === false) return []
    const netId =
      ctx.target.kind === 'net' ? ctx.target.netId : ctx.target.kind === 'link' ? ctx.target.netId : undefined
    if (netId === undefined) return []
    const net = ctx.doc.graphs[ctx.graphId]?.nets[netId]
    if (!net) return []
    return [
      {
        id: 'core.net.delete',
        label: `Delete net '${net.name}'`,
        action: {
          kind: 'command',
          invocation: { command: 'net.remove', params: { graphId: ctx.graphId, netId } },
        },
      },
    ]
  },
}

const canvasAddNode: MenuContribution = {
  id: 'core.canvas.addNode',
  targets: ['canvas'],
  group: '10-nav',
  resolve(ctx) {
    if (ctx.target.kind !== 'canvas') return []
    return [
      {
        id: 'core.canvas.addNode',
        label: 'Add node...',
        action: { kind: 'host', action: 'openPalette' },
      },
    ]
  },
}

const canvasCreateSubgraph: MenuContribution = {
  id: 'core.canvas.createSubgraph',
  targets: ['canvas'],
  group: '10-nav',
  order: 1,
  resolve(ctx) {
    if (ctx.target.kind !== 'canvas') return []
    return [{
      id: 'core.canvas.createSubgraph',
      label: 'Create empty subgraph',
      action: { kind: 'host', action: 'createSubgraph' },
    }]
  },
}

// ---------------------------------------------------------------------------
// Groups: view-only rectangles. Creation at the cursor is a plain command;
// creation AROUND a selection is a host action (the bounding box needs node
// layout sizes, which live in the canvas, not the document). Rename needs a
// text popover, so it is a host action too.
// ---------------------------------------------------------------------------

const canvasAddGroup: MenuContribution = {
  id: 'core.canvas.addGroup',
  targets: ['canvas'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'canvas') return []
    return [
      {
        id: 'core.canvas.addGroup',
        label: 'Add group',
        action: {
          kind: 'command',
          invocation: {
            command: 'view.createGroup',
            params: {
              graphId: ctx.graphId,
              title: 'Group',
              bounds: { x: Math.round(ctx.worldX), y: Math.round(ctx.worldY), width: 320, height: 220 },
            },
          },
        },
      },
    ]
  },
}

const canvasPaste: MenuContribution = {
  id: 'core.canvas.paste',
  targets: ['canvas'],
  group: '90-edit',
  resolve() {
    return [{ id: 'core.canvas.paste', label: 'Paste', action: { kind: 'host', action: 'pasteSelection' } }]
  },
}

const nodeGroupSelection: MenuContribution = {
  id: 'core.node.groupSelection',
  targets: ['node'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'node') return []
    const count = targetNodeIds(ctx, ctx.target.nodeId).length
    return [
      {
        id: 'core.node.groupSelection',
        label: count > 1 ? `Group ${count} nodes` : 'Group node',
        action: { kind: 'host', action: 'groupSelection' },
      },
    ]
  },
}

const groupRename: MenuContribution = {
  id: 'core.group.rename',
  targets: ['group'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'group') return []
    const group = ctx.doc.view.graphs[ctx.graphId]?.groups?.[ctx.target.groupId]
    if (!group) return []
    return [
      {
        id: 'core.group.rename',
        label: 'Rename group...',
        action: { kind: 'host', action: 'renameGroup', params: { groupId: ctx.target.groupId } },
      },
    ]
  },
}

const groupColor: MenuContribution = {
  id: 'core.group.color',
  targets: ['group'],
  group: '30-layout',
  order: 1,
  resolve(ctx) {
    if (ctx.target.kind !== 'group') return []
    const t = ctx.target
    const group = ctx.doc.view.graphs[ctx.graphId]?.groups?.[t.groupId]
    if (!group) return []
    return [{
      id: 'core.group.color',
      label: 'Color',
      children: COLOR_PRESETS.map(({ label, color }): MenuItem => ({
        id: `core.group.color.${label.toLowerCase()}`,
        label,
        checked: (group.color ?? null) === color,
        action: {
          kind: 'command',
          invocation: { command: 'view.setGroupColor', params: { graphId: ctx.graphId, groupId: t.groupId, color } },
        },
      })),
    }]
  },
}

const groupDelete: MenuContribution = {
  id: 'core.group.delete',
  targets: ['group'],
  group: '90-edit',
  resolve(ctx) {
    if (ctx.target.kind !== 'group') return []
    const group = ctx.doc.view.graphs[ctx.graphId]?.groups?.[ctx.target.groupId]
    if (!group) return []
    return [
      {
        id: 'core.group.delete',
        label: 'Delete group',
        action: {
          kind: 'command',
          invocation: {
            command: 'view.removeGroup',
            params: { graphId: ctx.graphId, groupId: ctx.target.groupId },
          },
        },
      },
    ]
  },
}

const sectionToggle: MenuContribution = {
  id: 'core.section.toggle',
  targets: ['section'],
  group: '30-layout',
  resolve(ctx) {
    if (ctx.target.kind !== 'section') return []
    const t = ctx.target
    return [
      {
        id: 'core.section.toggle',
        label: t.collapsed ? 'Expand section' : 'Collapse section',
        action: {
          kind: 'command',
          invocation: {
            command: 'view.setSectionCollapsed',
            params: { graphId: ctx.graphId, nodeId: t.nodeId, sectionId: t.sectionId, collapsed: !t.collapsed },
          },
        },
      },
    ]
  },
}

/**
 * Expose/unexpose a widget as an app-view public control (platform-plan
 * 2.4). Target inputId is the elaborated id the widget row carries - the
 * same identity format/exposed.ts stores, so the toggle round-trips.
 */
const widgetExpose: MenuContribution = {
  id: 'core.widget.expose',
  targets: ['widget'],
  // After '80-values' (Reset to Default): resetting is the everyday values
  // action; promoting to the app view is the rarer curation action.
  group: '85-expose',
  resolve(ctx) {
    if (ctx.target.kind !== 'widget') return []
    const t = ctx.target
    // Ghost/materialize affordances have no document value to record yet.
    if (t.synthetic === true) return []
    // Exposure records the value's document HOME: for forwarded-family rows
    // that is the owning node's elaborated input, not the presentation row.
    const home = t.owner ?? { graphId: ctx.graphId, nodeId: t.nodeId, inputId: t.inputId }
    if (!ctx.doc.graphs[home.graphId]?.nodes[home.nodeId]) return []
    const exposed = isExposed(ctx.doc, home.graphId, home.nodeId, home.inputId)
    return [
      {
        id: 'core.widget.expose.toggle',
        label: exposed ? 'Remove from app view' : 'Expose in app view',
        checked: exposed,
        action: {
          kind: 'command',
          invocation: {
            command: exposed ? 'params.unexpose' : 'params.expose',
            params: { graphId: home.graphId, nodeId: home.nodeId, inputId: home.inputId },
          },
        },
      },
    ]
  },
}

/**
 * Inside a subgraph, put a field on the subgraph node without a wire, or take
 * it off again. A boundary wire has no menu of its own (boundary noodles are
 * not hit-tested), so "Hide wire" lives here too.
 */
const widgetSubgraphNode: MenuContribution = {
  id: 'core.widget.subgraphNode',
  targets: ['widget'],
  group: '85-expose',
  resolve(ctx) {
    if (ctx.target.kind !== 'widget') return []
    const t = ctx.target
    // Synthetic and forwarded rows have no field of this node to bind, and a
    // choice's or type choice's own row is refused by the command.
    if (t.synthetic === true || t.construct === true || t.owner !== undefined || t.address === undefined || ctx.graphId === ctx.doc.root) return []
    const def = ctx.doc.graphs[ctx.graphId]
    if (def?.nodes[t.nodeId] === undefined) return []
    const target = portParams({ node: t.nodeId, port: t.address.port })
    // A row of a construct shown whole is that construct's.
    const wholly = [...(def.boundary?.inputs ?? []), ...(def.boundary?.outputs ?? [])]
      .flatMap((item) => [item.binds, ...(item.alsoBinds ?? [])])
      .some((binding) => binding.kind === 'construct' && binding.node === target.node && target.port.startsWith(`${binding.port}.`))
    if (wholly) return []
    const state = boundaryFieldState(def, { node: asNodeId(target.node), port: asPortId(target.port) })
    if (state.item === undefined) {
      return state.driven ? [] : [{
        id: 'core.widget.subgraphNode.show',
        label: 'Show on subgraph node',
        action: { kind: 'command', invocation: { command: 'boundary.showOnSubgraphNode', params: { graphId: ctx.graphId, ...target } } },
      }]
    }
    if (state.field !== true) return []
    const item = state.item
    return [
      {
        id: 'core.widget.subgraphNode.remove',
        label: 'Remove from subgraph node',
        action: { kind: 'command', invocation: { command: 'boundary.unbind', params: { graphId: ctx.graphId, side: 'inputs', itemId: item.id, ...target } } },
      },
      ...(item.wireHidden === true ? [] : [{
        id: 'core.widget.subgraphNode.hideWire',
        label: 'Hide wire',
        action: { kind: 'command' as const, invocation: { command: 'boundary.setWireHidden', params: { graphId: ctx.graphId, itemId: item.id, hidden: true } } },
      }]),
    ]
  },
}

const nodePreviewExpose: MenuContribution = {
  id: 'core.node.preview.expose',
  targets: ['node'],
  group: '85-expose',
  resolve(ctx) {
    if (ctx.target.kind !== 'node' || ctx.target.previewSurface !== true) return []
    if (ctx.doc.graphs[ctx.graphId]?.nodes[ctx.target.nodeId] === undefined) return []
    const exposed = isPreviewExposed(ctx.doc, ctx.graphId, ctx.target.nodeId)
    return [{
      id: 'core.node.preview.expose.toggle',
      label: exposed ? 'Remove from app view' : 'Promote to app view',
      checked: exposed,
      action: {
        kind: 'command',
        invocation: {
          command: exposed ? 'previews.unexpose' : 'previews.expose',
          params: { graphId: ctx.graphId, nodeId: ctx.target.nodeId },
        },
      },
    }]
  },
}

/**
 * Inside a subgraph: show a whole group, choice, type choice or described row
 * on the subgraph node, from any row in it or a group's add row. Each
 * enclosing construct is offered once, outermost first, unless a row in it is
 * already shown; one already shown whole is offered for removal instead.
 */
const showConstructOnSubgraphNode: MenuContribution = {
  id: 'core.boundary.showWhole',
  targets: ['widget', 'pin', 'growth'],
  group: '85-expose',
  resolve(ctx) {
    const target = ctx.target
    if (target.kind !== 'widget' && target.kind !== 'pin' && target.kind !== 'growth') return []
    if (target.kind === 'widget' && target.synthetic === true) return []
    const def = ctx.doc.graphs[ctx.graphId]
    const node = def?.nodes[target.nodeId]
    if (!def || !node || ctx.graphId === ctx.doc.root) return []
    const schema = ctx.resolve?.(node.type)
    if (schema === undefined) return []
    const port = target.kind === 'widget' ? target.inputId : target.kind === 'pin' ? target.portId : target.construct
    const shown = (['inputs', 'outputs'] as const).flatMap((side) => (def.boundary?.[side] ?? [])
      .flatMap((item) => [item.binds, ...(item.alsoBinds ?? [])].map((binding) => ({ item: item.id, side, binding }))))
      .filter(({ binding }) => (binding.kind === 'port' || binding.kind === 'construct') && binding.node === node.id)
      .map(({ item, side, binding }) => ({ item, side, port: (binding as { port: string }).port, whole: binding.kind === 'construct' }))
    return constructsAround(schema, port).flatMap((construct) => {
      const whole = shown.find((other) => other.whole && other.port === construct.path)
      if (whole !== undefined) {
        return [{
          id: `core.boundary.hideWhole.${construct.path}`,
          label: `Remove ${construct.label} from subgraph node`,
          action: {
            kind: 'command' as const,
            invocation: {
              command: 'boundary.unbind',
              params: { graphId: ctx.graphId, side: whole.side, itemId: whole.item, node: node.id, port: construct.path },
            },
          },
        }]
      }
      if (shown.some((other) => other.port.startsWith(`${construct.path}.`) ||
        (other.whole && construct.path.startsWith(`${other.port}.`)))) return []
      return [{
        id: `core.boundary.showWhole.${construct.path}`,
        label: `Show ${construct.label} on subgraph node`,
        action: {
          kind: 'command' as const,
          invocation: {
            command: 'boundary.showOnSubgraphNode',
            params: { graphId: ctx.graphId, node: node.id, port: construct.path },
          },
        },
      }]
    })
  },
}

export function coreMenuContributions(): readonly MenuContribution[] {
  return [
    showConstructOnSubgraphNode,
    nodeMode,
    nodePreviews,
    nodeMirrorPreviews,
    nodeColor,
    nodeMinimize,
    nodeOpenSubgraph,
    nodeHelp,
    nodeLocalize,
    nodeQueueSelection,
    nodeRename,
    nodeResetName,
    nodeResetSize,
    nodeCompactDynamic,
    nodeCopy,
    nodeDelete,
    linkDelete,
    linkAddReroute,
    rerouteDissolve,
    pinPromoteToNet,
    pinConnectToNet,
    linkNetManage,
    netStubManage,
    netStubResetPosition,
    netStubDisconnect,
    netDelete,
    canvasAddNode,
    canvasAddGroup,
    canvasPaste,
    nodeGroupSelection,
    groupRename,
    groupColor,
    groupDelete,
    sectionToggle,
    widgetExpose,
    widgetSubgraphNode,
    nodePreviewExpose,
    canvasCreateSubgraph,
  ]
}
