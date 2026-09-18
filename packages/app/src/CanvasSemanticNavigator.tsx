import { For, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js'
import type { NodeProgress } from '@dinkster/core'
import {
  boundarySceneId,
  defaultTokens,
  nodesInGroup,
  presentedType,
  typeIdDisplayLabel,
  type NodeBadge,
  type NodeOutputText,
  type OutputTextMap,
  type PinLayout,
  type PortProblemMap,
  type Scene,
  type SceneLinkEnd,
  type SceneNode,
} from '@dinkster/canvas'

export const CANVAS_SEMANTIC_WINDOW_SIZE = 5

export type CanvasSemanticTarget =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'port'; readonly nodeId: string; readonly id: string; readonly direction: 'in' | 'out'; readonly widgetTap?: true }
  | { readonly kind: 'boundary'; readonly id: string }
  | { readonly kind: 'link'; readonly id: string }
  | { readonly kind: 'reroute'; readonly id: string }
  | { readonly kind: 'valueSource'; readonly id: string }
  | { readonly kind: 'selector'; readonly id: string }
  | { readonly kind: 'net'; readonly id: string }
  | { readonly kind: 'group'; readonly id: string }

export interface CanvasSemanticItem {
  readonly key: string
  readonly category: CanvasSemanticTarget['kind']
  readonly label: string
  readonly target: CanvasSemanticTarget
}

export interface CanvasSemanticSource {
  readonly scene: Scene
  readonly states: Readonly<Record<string, NodeProgress>>
  readonly badges: Readonly<Record<string, readonly NodeBadge[]>>
  readonly portProblems: PortProblemMap
  readonly outputTexts: OutputTextMap
}

const pinConnectionKey = (
  nodeId: string,
  direction: 'in' | 'out',
  port: string,
  members: readonly unknown[] | undefined,
  kind: 'port' | 'widgetTap' | 'boundary' = 'port',
): string => JSON.stringify([kind, nodeId, direction, port, members ?? []])

const pinConnectionKeyOf = (nodeId: string, pin: PinLayout, boundary = false): string =>
  pinConnectionKey(
    nodeId,
    pin.direction,
    pin.address.port,
    pin.address.members,
    boundary ? 'boundary' : pin.widgetTap === true ? 'widgetTap' : 'port',
  )

const pinName = (node: Pick<SceneNode, 'layout'>, pin: PinLayout): string => {
  for (const row of node.layout.rows) {
    if (row.kind === 'ports') {
      const slot = pin.direction === 'in' ? row.input : row.output
      if (slot?.portId === pin.portId) return slot.label
    } else if (row.kind === 'widget' && row.inputId === pin.address.port) {
      if (pin.direction === 'in' || pin.widgetTap === true) return row.label
    }
  }
  return pin.label ?? pin.address.port
}

const badgeStatus = (badge: NodeBadge): string | undefined => {
  switch (badge.id) {
    case 'core.error': return 'runtime error'
    case 'core.problem.error': return 'document error'
    case 'core.problem.blocking-warning': return 'blocking warning'
    case 'core.problem.warning': return 'warning'
    case 'core.mode.muted': return 'muted'
    case 'core.mode.bypassed': return 'bypassed'
    case 'core.deprecated': return 'deprecated'
    default: return undefined
  }
}

const nodeStatus = (
  node: SceneNode,
  state: NodeProgress | undefined,
  badges: readonly NodeBadge[],
): string => {
  const status = new Set<string>()
  if (node.unrecognized === true || node.missingSchema === true) status.add('unrecognized')
  if (node.node.mode === 'muted') status.add('muted')
  if (node.node.mode === 'bypassed') status.add('bypassed')
  if (state !== undefined) {
    if (state.state === 'running' && state.value !== undefined) {
      const ratio = state.max !== undefined && state.max > 0 ? state.value / state.max : state.value
      status.add(`running ${Math.round(Math.max(0, Math.min(1, ratio)) * 100)} percent`)
    } else status.add(state.state)
  }
  for (const badge of badges) {
    const label = badgeStatus(badge)
    if (label !== undefined) status.add(label)
  }
  return [...status].join(', ')
}

const nodeOutputStatus = (output: NodeOutputText | undefined): string | undefined => {
  if (output === undefined) return undefined
  const text = output.text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (output.error === true) {
    if (text[0]?.toLowerCase() === 'preview error') text.shift()
    return `preview error: ${text.join(', ')}`
  }
  if (output.estimate === true) {
    if (text[0]?.toLowerCase() === 'estimated locally') text.shift()
    return `live result estimated locally: ${text.join(', ')}`
  }
  return `${output.stale === true ? 'stale ' : ''}recorded result: ${text.join(', ')}`
}

const endpointName = (
  end: SceneLinkEnd,
  direction: 'in' | 'out',
  nodes: ReadonlyMap<string, SceneNode>,
  reroutes: ReadonlyMap<string, string>,
  valueSources: ReadonlyMap<string, string>,
  selectors: ReadonlyMap<string, string>,
  pinNames: ReadonlyMap<string, string>,
): string => {
  if (end.kind === 'port') {
    const node = nodes.get(end.node)
    const port = pinNames.get(pinConnectionKey(end.node, direction, end.port, end.members)) ?? end.port
    return `${node?.layout.title ?? end.node}.${port}`
  }
  if (end.kind === 'widgetTap') {
    const input = pinNames.get(pinConnectionKey(end.node, 'out', end.input, undefined, 'widgetTap')) ?? end.input
    return `${nodes.get(end.node)?.layout.title ?? end.node}.${input}`
  }
  if (end.kind === 'reroute') return reroutes.get(end.reroute) ?? `reroute ${end.reroute}`
  if (end.kind === 'valueSource') return valueSources.get(end.valueSource) ?? `value source ${end.valueSource}`
  if (end.kind === 'selector') {
    const title = selectors.get(end.selector) ?? `selector ${end.selector}`
    return end.candidate === undefined ? title : `${title}.${end.candidate}`
  }
  const id = boundarySceneId(end.side)
  const port = pinNames.get(pinConnectionKey(id, direction, end.item, undefined, 'boundary')) ?? end.item
  return `${end.side} boundary.${port}`
}

const endpointConnectionKey = (end: SceneLinkEnd, direction: 'in' | 'out'): string | undefined => {
  if (end.kind === 'port') return pinConnectionKey(end.node, direction, end.port, end.members)
  if (end.kind === 'widgetTap') return pinConnectionKey(end.node, 'out', end.input, undefined, 'widgetTap')
  if (end.kind === 'boundary') return pinConnectionKey(boundarySceneId(end.side), direction, end.item, undefined, 'boundary')
  return undefined
}

export function buildCanvasSemanticItems(source: CanvasSemanticSource): readonly CanvasSemanticItem[] {
  const { scene } = source
  const items: CanvasSemanticItem[] = []
  const nodes = new Map(scene.nodes.map((node) => [node.id, node]))
  const reroutes = new Map(scene.reroutes.map((reroute) => [reroute.id, `reroute ${reroute.id}`]))
  const valueSources = new Map(scene.valueSources.map((valueSource) => [valueSource.id, valueSource.title]))
  const selectors = new Map(scene.selectors.map((selector) => [selector.id, selector.title]))
  const pinNames = new Map<string, string>()
  const connections = new Map<string, number>()
  const groupsForNode = new Map<string, string[]>()

  for (const node of scene.nodes) {
    for (const pin of node.layout.pins) {
      pinNames.set(pinConnectionKeyOf(node.id, pin), pinName(node, pin))
    }
  }
  for (const boundary of scene.boundaryNodes) {
    const id = boundarySceneId(boundary.side)
    for (const pin of boundary.layout.pins) {
      pinNames.set(pinConnectionKeyOf(id, pin, true), pinName(boundary, pin))
    }
  }
  const countConnection = (key: string): void => {
    connections.set(key, (connections.get(key) ?? 0) + 1)
  }
  for (const link of scene.links) {
    const from = endpointConnectionKey(link.from, 'out')
    const to = endpointConnectionKey(link.to, 'in')
    if (from !== undefined) countConnection(from)
    if (to !== undefined) countConnection(to)
  }
  for (const stub of scene.netStubs) {
    countConnection(pinConnectionKey(
      stub.nodeId,
      stub.role === 'source' ? 'out' : 'in',
      stub.portId,
      stub.members,
    ))
  }
  for (const group of scene.groups) {
    for (const nodeId of nodesInGroup(scene, group)) {
      const memberships = groupsForNode.get(nodeId) ?? []
      memberships.push(group.title)
      groupsForNode.set(nodeId, memberships)
    }
  }

  for (const node of scene.nodes) {
    const inputs = node.layout.pins.filter((pin) => pin.direction === 'in').length
    const outputs = node.layout.pins.length - inputs
    const status = nodeStatus(node, source.states[node.id], source.badges[node.id] ?? [])
    const outputStatus = nodeOutputStatus(source.outputTexts[node.id])
    const memberships = groupsForNode.get(node.id)
    const hiddenConnectedInputs = node.layout.minimized
      ? node.layout.pins.filter((pin) =>
          pin.direction === 'in' && (connections.get(pinConnectionKeyOf(node.id, pin)) ?? 0) > 0).length
      : 0
    const hiddenConnectedOutputs = node.layout.minimized
      ? node.layout.pins.filter((pin) =>
          pin.direction === 'out' && (connections.get(pinConnectionKeyOf(node.id, pin)) ?? 0) > 0).length
      : 0
    const details = [
      `${inputs} input${inputs === 1 ? '' : 's'}`,
      `${outputs} output${outputs === 1 ? '' : 's'}`,
      ...(node.layout.minimized
        ? [
            'minimized',
            `${hiddenConnectedInputs} hidden connected input${hiddenConnectedInputs === 1 ? '' : 's'}`,
            `${hiddenConnectedOutputs} hidden connected output${hiddenConnectedOutputs === 1 ? '' : 's'}`,
          ]
        : []),
      ...(memberships === undefined ? [] : [`in ${memberships.join(', ')}`]),
      ...(status === '' ? [] : [status]),
      ...(outputStatus === undefined ? [] : [outputStatus]),
    ]
    items.push({
      key: `node:${node.id}`,
      category: 'node',
      label: `Node: ${node.layout.title}, ${details.join(', ')}`,
      target: { kind: 'node', id: node.id },
    })
    if (node.layout.minimized) continue
    for (const pin of node.layout.pins) {
      const name = pinName(node, pin)
      const count = connections.get(pinConnectionKeyOf(node.id, pin)) ?? 0
      const problem = pin.direction === 'in' ? source.portProblems[node.id]?.[pin.portId] : undefined
      const traits = [
        presentedType(defaultTokens, pin.type).label,
        ...(pin.matchVariable !== undefined ? [`match ${pin.matchVariable}`] : []),
        ...(pin.inferred === true ? ['inferred'] : []),
        ...(pin.optional === true ? ['optional'] : []),
        ...(pin.maybeAbsent === true ? ['may be absent'] : []),
        ...(pin.warn === true ? ['solver warning'] : []),
        ...(problem === undefined ? [] : [problem]),
        count === 0 ? 'not connected' : `${count} connection${count === 1 ? '' : 's'}`,
      ]
      items.push({
        key: `port:${node.id}:${pin.direction}:${pin.portId}${pin.widgetTap === true ? ':tap' : ''}`,
        category: 'port',
        label: `${pin.direction === 'in' ? 'Input' : 'Output'}: ${name} of ${node.layout.title}, ${traits.join(', ')}`,
        target: {
          kind: 'port', nodeId: node.id, id: pin.portId, direction: pin.direction,
          ...(pin.widgetTap === true ? { widgetTap: true as const } : {}),
        },
      })
    }
  }

  for (const boundary of scene.boundaryNodes) {
    const id = boundarySceneId(boundary.side)
    const portCount = boundary.layout.pins.length
    items.push({
      key: `boundary:${boundary.side}`,
      category: 'boundary',
      label: `${boundary.side === 'inputs' ? 'Inputs' : 'Outputs'} boundary, ${portCount} port${portCount === 1 ? '' : 's'}`,
      target: { kind: 'boundary', id },
    })
    for (const pin of boundary.layout.pins) {
      const name = pinNames.get(pinConnectionKeyOf(id, pin, true)) ?? pin.address.port
      const count = connections.get(pinConnectionKeyOf(id, pin, true)) ?? 0
      items.push({
        key: `boundary-port:${boundary.side}:${pin.portId}`,
        category: 'port',
        label: `${pin.direction === 'in' ? 'Input' : 'Output'}: ${name} of ${boundary.side} boundary, ${presentedType(defaultTokens, pin.type).label}, ${count === 0 ? 'not connected' : `${count} connection${count === 1 ? '' : 's'}`}`,
        target: { kind: 'port', nodeId: id, id: pin.portId, direction: pin.direction },
      })
    }
  }

  for (const link of scene.links) {
    // A hidden (collapsed-net) delivery is represented by its net tags; it
    // still counts as a pin connection above but is not a navigable link.
    if (link.hidden === true) continue
    const from = endpointName(link.from, 'out', nodes, reroutes, valueSources, selectors, pinNames)
    const to = endpointName(link.to, 'in', nodes, reroutes, valueSources, selectors, pinNames)
    const traits = [
      ...(link.typeName === undefined ? [] : [typeIdDisplayLabel(link.typeName)]),
      ...(link.maybeAbsent === true ? ['may be absent'] : []),
      ...(link.mismatch === true ? ['type mismatch'] : []),
    ]
    items.push({
      key: `link:${link.id}`,
      category: 'link',
      label: `Link: ${from} to ${to}${traits.length === 0 ? '' : `, ${traits.join(', ')}`}`,
      target: { kind: 'link', id: link.id },
    })
  }
  for (const reroute of scene.reroutes) items.push({
    key: `reroute:${reroute.id}`,
    category: 'reroute',
    label: `Reroute: ${reroute.id}${reroute.typeName === undefined ? '' : `, ${typeIdDisplayLabel(reroute.typeName)}`}`,
    target: { kind: 'reroute', id: reroute.id },
  })
  for (const valueSource of scene.valueSources) items.push({
    key: `value-source:${valueSource.id}`,
    category: 'valueSource',
    label: `Value source: ${valueSource.title}, ${valueSource.specState}${valueSource.conflict ? ', conflict' : ''}`,
    target: { kind: 'valueSource', id: valueSource.id },
  })
  for (const selector of scene.selectors) items.push({
    key: `selector:${selector.id}`,
    category: 'selector',
    label: `Selector: ${selector.title}, ${selector.random ? 'random' : 'fixed'}, ${selector.candidates.length} candidates`,
    target: { kind: 'selector', id: selector.id },
  })
  for (const stub of scene.netStubs) items.push({
    key: `net:${stub.id}`,
    category: 'net',
    label: `Named net ${stub.role}: ${stub.name}${stub.typeName === undefined ? '' : `, ${typeIdDisplayLabel(stub.typeName)}`}`,
    target: { kind: 'net', id: stub.id },
  })
  for (const group of scene.groups) {
    const count = nodesInGroup(scene, group).length
    items.push({
      key: `group:${group.id}`,
      category: 'group',
      label: `Group: ${group.title}, ${count} node${count === 1 ? '' : 's'}`,
      target: { kind: 'group', id: group.id },
    })
  }
  return items
}

const optionId = (owner: string, key: string): string =>
  `canvas-semantic-${encodeURIComponent(owner)}-${encodeURIComponent(key)}`

export function CanvasSemanticNavigator(props: {
  readonly owner: string
  readonly items: readonly CanvasSemanticItem[]
  readonly selectionVersion: number
  readonly isSelected: (target: CanvasSemanticTarget) => boolean
  readonly onActivate: (item: CanvasSemanticItem) => void
  readonly onExit: () => void
  readonly onFocusChange: (focused: boolean) => void
  readonly onActiveChange?: (item: CanvasSemanticItem | undefined) => void
}) {
  let listbox!: HTMLDivElement
  const [cursor, setCursor] = createSignal(0)
  const [focused, setFocused] = createSignal(false)
  onCleanup(() => queueMicrotask(() => {
    props.onFocusChange(false)
    props.onActiveChange?.(undefined)
  }))
  let previousItems: readonly CanvasSemanticItem[] = []
  createEffect(() => {
    const next = props.items
    const previousKey = previousItems[untrack(cursor)]?.key
    const preserved = previousKey === undefined ? -1 : next.findIndex((item) => item.key === previousKey)
    setCursor(preserved >= 0 ? preserved : Math.min(untrack(cursor), Math.max(0, next.length - 1)))
    previousItems = next
  })
  const windowEntries = createMemo(() => {
    const items = props.items
    const half = Math.floor(CANVAS_SEMANTIC_WINDOW_SIZE / 2)
    const start = Math.min(
      Math.max(0, cursor() - half),
      Math.max(0, items.length - CANVAS_SEMANTIC_WINDOW_SIZE),
    )
    return items.slice(start, start + CANVAS_SEMANTIC_WINDOW_SIZE).map((item, offset) => ({ item, index: start + offset }))
  })
  const move = (next: number): void => {
    setCursor(Math.max(0, Math.min(next, props.items.length - 1)))
  }
  const moveCategory = (direction: -1 | 1): void => {
    const items = props.items
    if (items.length === 0) return
    const current = cursor()
    const category = items[current]?.category
    if (direction > 0) {
      const next = items.findIndex((item, index) => index > current && item.category !== category)
      if (next >= 0) move(next)
      return
    }
    let index = current - 1
    while (index >= 0 && items[index]?.category === category) index -= 1
    if (index < 0) return
    const previousCategory = items[index]!.category
    while (index > 0 && items[index - 1]?.category === previousCategory) index -= 1
    move(index)
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      props.onExit()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (props.items.length === 0) return
    switch (event.key) {
      case 'ArrowDown': move(cursor() + 1); break
      case 'ArrowUp': move(cursor() - 1); break
      case 'Home': move(0); break
      case 'End': move(props.items.length - 1); break
      case 'PageDown': move(cursor() + CANVAS_SEMANTIC_WINDOW_SIZE); break
      case 'PageUp': move(cursor() - CANVAS_SEMANTIC_WINDOW_SIZE); break
      case 'ArrowRight': moveCategory(1); break
      case 'ArrowLeft': moveCategory(-1); break
      case 'Enter':
      case ' ':
        props.onActivate(props.items[cursor()]!)
        break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  const active = () => props.items[cursor()]
  createEffect(() => props.onActiveChange?.(focused() ? active() : undefined))
  const helpId = () => `canvas-semantic-help-${encodeURIComponent(props.owner)}`
  const selected = (target: CanvasSemanticTarget): boolean => {
    void props.selectionVersion
    return props.isSelected(target)
  }
  createEffect(() => {
    const item = active()
    if (item === undefined) return
    queueMicrotask(() => {
      if (document.activeElement === listbox) document.getElementById(optionId(props.owner, item.key))?.scrollIntoView({ block: 'nearest' })
    })
  })
  return (
    <div class="canvas-semantic-nav">
      <span id={helpId()} class="canvas-semantic-help">
        Use arrow keys to browse. Enter selects and centers the item. Escape returns to the canvas.
      </span>
      <div
        ref={listbox}
        role="listbox"
        aria-label="Canvas scene navigator"
        aria-describedby={helpId()}
        aria-multiselectable="true"
        aria-activedescendant={active() === undefined ? undefined : optionId(props.owner, active()!.key)}
        tabIndex={0}
        data-testid="canvas-semantic-navigator"
        onFocus={() => { setFocused(true); props.onFocusChange(true) }}
        onBlur={() => { setFocused(false); props.onFocusChange(false) }}
        onKeyDown={onKeyDown}
      >
        <For each={windowEntries()}>{(entry) => (
          <div
            id={optionId(props.owner, entry.item.key)}
            role="option"
            aria-posinset={entry.index + 1}
            aria-setsize={props.items.length}
            aria-selected={selected(entry.item.target)}
            data-kind={entry.item.category}
            data-active={entry.index === cursor() ? 'true' : undefined}
            onClick={() => move(entry.index)}
          >
            {entry.item.label}
          </div>
        )}</For>
      </div>
    </div>
  )
}
