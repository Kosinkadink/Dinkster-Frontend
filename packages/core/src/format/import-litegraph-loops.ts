import { diag, type Diagnostic } from '../diagnostics.js'
import { STRUCTURAL_IMPORT_HELPERS } from '../extensions/import-helpers.js'
import {
  inputsOf,
  outputsOf,
  type NodeSchema,
  type TypeExpr,
} from '../schema/model.js'
import { typesCompatible } from '../schema/type-compatibility.js'
import type { Json, JsonObject } from './document.js'

type Mutable = { [key: string]: any }

interface RawNode {
  readonly id: number
  readonly type: string
  readonly inputs?: readonly { readonly name?: string }[]
  readonly outputs?: readonly { readonly name?: string }[]
  readonly widgets_values?: readonly Json[] | Readonly<Record<string, Json>>
}

interface RawLink {
  readonly id: number
  readonly from: number
  readonly fromSlot: number
  readonly to: number
  readonly toSlot: number
}

interface LoopPair {
  readonly start: number
  readonly end: number
  readonly body: ReadonlySet<number>
}

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const walk = (
  starts: Iterable<number>,
  edges: ReadonlyMap<number, ReadonlySet<number>>,
  stops: ReadonlySet<number> = new Set(),
  returnStops = false,
): Set<number> => {
  const found = new Set<number>()
  const reachedStops = new Set<number>()
  const pending = [...starts]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (found.has(id)) continue
    found.add(id)
    if (stops.has(id)) reachedStops.add(id)
    else pending.push(...(edges.get(id) ?? []))
  }
  return returnStops ? reachedStops : found
}

const loopError = (
  diagnostics: Diagnostic[],
  code: string,
  message: string,
): void => {
  diagnostics.push(diag('error', 'import', `import.loop.${code}`, message))
}

function pairLoops(
  nodes: readonly RawNode[],
  links: readonly RawLink[],
  diagnostics: Diagnostic[],
): readonly LoopPair[] {
  const ids = new Set(nodes.map((node) => node.id))
  const children = new Map<number, Set<number>>(
    [...ids].map((id) => [id, new Set()]),
  )
  const parents = new Map<number, Set<number>>(
    [...ids].map((id) => [id, new Set()]),
  )
  for (const link of links) {
    if (!ids.has(link.from) || !ids.has(link.to)) continue
    children.get(link.from)!.add(link.to)
    parents.get(link.to)!.add(link.from)
  }
  const starts = new Set(
    nodes.filter((node) => node.type === 'StartLoop').map((node) => node.id),
  )
  const ends = new Set(
    nodes.filter((node) => node.type === 'EndLoop').map((node) => node.id),
  )
  if (starts.size === 0 && ends.size === 0) return []
  const terminal = new Set(
    [...ids].filter((id) => children.get(id)!.size === 0),
  )
  const startDag = new Map<number, Set<number>>()
  const startDescendants = new Map<number, Set<number>>()
  for (const start of starts) {
    const direct = walk(children.get(start)!, children, starts, true)
    startDag.set(start, direct)
  }
  for (const start of starts)
    startDescendants.set(start, walk(startDag.get(start)!, startDag))
  const endDag = new Map<number, Set<number>>()
  for (const end of ends)
    endDag.set(end, walk(parents.get(end)!, parents, ends, true))

  const remainingStarts = new Set(starts)
  const remainingEnds = new Set(ends)
  const paired: { start: number; end: number }[] = []
  while (remainingEnds.size > 0) {
    const end = [...remainingEnds]
      .sort((a, b) => a - b)
      .find(
        (candidate) =>
          ![...(endDag.get(candidate) ?? [])].some((id) =>
            remainingEnds.has(id),
          ),
      )
    if (end === undefined) break
    const candidates = walk(parents.get(end)!, parents, remainingStarts, true)
    if (candidates.size === 0) {
      loopError(
        diagnostics,
        'unmatchedEnd',
        `End Loop ${end} has no available Start Loop`,
      )
      return []
    }
    const closest = [...candidates].filter((candidate) =>
      [...candidates].every(
        (other) =>
          other === candidate || startDescendants.get(other)?.has(candidate),
      ),
    )
    if (closest.length !== 1) {
      loopError(
        diagnostics,
        'ambiguousNesting',
        `End Loop ${end} can close multiple unrelated Start Loops: ${[...candidates].sort((a, b) => a - b).join(', ')}`,
      )
      return []
    }
    const start = closest[0]!
    remainingStarts.delete(start)
    remainingEnds.delete(end)
    const stops = new Set([...remainingEnds, ...terminal, end])
    const escapes = walk(children.get(start)!, children, stops, true)
    escapes.delete(end)
    if (escapes.size > 0) {
      loopError(
        diagnostics,
        'bodyEscape',
        `Start Loop ${start} reaches ${[...escapes].sort((a, b) => a - b).join(', ')} without passing through End Loop ${end}`,
      )
      return []
    }
    paired.push({ start, end })
  }
  if (remainingStarts.size > 0) {
    loopError(
      diagnostics,
      'unmatchedStart',
      `Start Loops without End Loops: ${[...remainingStarts].sort((a, b) => a - b).join(', ')}`,
    )
    return []
  }
  return paired.map(({ start, end }) => {
    const body = walk(children.get(start)!, children, new Set([end]))
    body.delete(end)
    const accumulate = links.find(
      (link) =>
        link.to === end &&
        nodes.find((node) => node.id === end)?.inputs?.[link.toSlot]?.name ===
          'accumulate',
    )
    if (
      accumulate !== undefined &&
      (accumulate.from === start || body.has(accumulate.from))
    ) {
      loopError(
        diagnostics,
        'accumulateFromBody',
        `End Loop ${end} accumulate is driven by loop node ${accumulate.from} under Start Loop ${start}`,
      )
    }
    return { start, end, body }
  })
}

const widgetRecord = (node: RawNode): Readonly<Record<string, Json>> =>
  object(node.widgets_values) ? node.widgets_values : {}

interface StartSettings {
  readonly mode: Json
  readonly start: Json
  readonly stop: Json
  readonly step: Json
  readonly cacheIterations: boolean
}

const startSettings = (node: RawNode): StartSettings => {
  const widgets = widgetRecord(node)
  if (!Array.isArray(node.widgets_values)) {
    const mode = widgets['mode'] ?? 'simple'
    return {
      mode,
      start: mode === 'For' ? (widgets['mode.start_iteration_index'] ?? 0) : 0,
      stop:
        mode === 'For'
          ? (widgets['mode.max_iteration'] ?? 4)
          : (widgets['mode.num_iterations'] ?? 4),
      step: mode === 'For' ? (widgets['mode.step'] ?? 1) : 1,
      cacheIterations: widgets['cache_iterations'] === true,
    }
  }
  const [mode = 'simple', first, second, third, fourth] = node.widgets_values
  if (mode === 'For') {
    return {
      mode,
      start: first ?? 0,
      stop: second ?? 4,
      step: third ?? 1,
      cacheIterations: fourth === true,
    }
  }
  if (mode === 'List')
    return { mode, start: 0, stop: 0, step: 1, cacheIterations: first === true }
  return {
    mode,
    start: 0,
    stop: first ?? 4,
    step: 1,
    cacheIterations: second === true,
  }
}

const rangeValues = (
  node: RawNode,
  diagnostics: Diagnostic[],
):
  | {
      mode: 'range'
      values: Json[]
      start: number
      stop: number
      step: number
    }
  | { mode: 'list' }
  | undefined => {
  const { mode, start, stop, step } = startSettings(node)
  if (mode === 'List') return { mode: 'list' }
  if (mode !== 'simple' && mode !== 'For') {
    loopError(
      diagnostics,
      'modeUnsupported',
      `Start Loop ${node.id} has unsupported mode ${JSON.stringify(mode)}`,
    )
    return undefined
  }
  if (
    ![start, stop, step].every(
      (value) => typeof value === 'number' && Number.isSafeInteger(value),
    )
  ) {
    loopError(
      diagnostics,
      'modeUnsupported',
      `Start Loop ${node.id} has non-integer range widgets`,
    )
    return undefined
  }
  if (step === 0) {
    loopError(
      diagnostics,
      'rangeStep',
      `Start Loop ${node.id} step must not be zero`,
    )
    return undefined
  }
  const values: Json[] = []
  for (
    let value = start as number;
    (step as number) > 0 ? value < (stop as number) : value > (stop as number);
    value += step as number
  ) {
    if (values.length >= 100_000) {
      loopError(
        diagnostics,
        'budget',
        `Start Loop ${node.id} exceeds the 100000 iteration import budget`,
      )
      return undefined
    }
    values.push(value)
  }
  return {
    mode: 'range',
    values,
    start: start as number,
    stop: stop as number,
    step: step as number,
  }
}

const endpointNode = (endpoint: Mutable): string | undefined =>
  typeof endpoint?.['node'] === 'string' ? endpoint['node'] : undefined

const endpointKey = (endpoint: Mutable): string => JSON.stringify(endpoint)

const rawPortName = (
  node: RawNode,
  side: 'inputs' | 'outputs',
  slot: number,
): string | undefined => node[side]?.[slot]?.name

const outputIsList = (
  node: RawNode,
  slot: number,
  resolve: (type: string) => NodeSchema | undefined,
): boolean => {
  const schema = resolve(node.type)
  if (!schema) return false
  const name = rawPortName(node, 'outputs', slot)
  const outputs = outputsOf(schema)
  const output =
    name === undefined
      ? outputs[slot]
      : (outputs.find((item) => item.id === name) ?? outputs[slot])
  return output?.isList === true
}

const endpointType = (
  graph: Mutable,
  endpoint: Mutable,
  side: 'input' | 'output',
  resolve: (type: string) => NodeSchema | undefined,
): TypeExpr | undefined => {
  const node = graph['nodes'][endpointNode(endpoint) ?? ''] as
    | Mutable
    | undefined
  const schema = node && resolve(node['type'])
  if (!schema || typeof endpoint['port'] !== 'string') return undefined
  const ports = side === 'input' ? inputsOf(schema) : outputsOf(schema)
  return ports.find((port) => port.id === endpoint['port'])?.type
}

/** Convert maintained ComfyUI StartLoop/EndLoop topology into explicit regions. */
export function convertLitegraphLoops(
  document: JsonObject,
  rawNodesValue: readonly unknown[],
  rawLinksValue: readonly unknown[],
  resolve: (type: string) => NodeSchema | undefined,
  diagnostics: Diagnostic[],
): void {
  const rawNodes = rawNodesValue.filter(
    (value): value is RawNode =>
      object(value) &&
      typeof value['id'] === 'number' &&
      Number.isSafeInteger(value['id']) &&
      typeof value['type'] === 'string',
  )
  const rawLinks = rawLinksValue
    .filter(
      (value): value is readonly unknown[] =>
        Array.isArray(value) && value.length >= 5,
    )
    .map(
      (value): RawLink => ({
        id: value[0] as number,
        from: value[1] as number,
        fromSlot: value[2] as number,
        to: value[3] as number,
        toSlot: value[4] as number,
      }),
    )
  const pairs = pairLoops(rawNodes, rawLinks, diagnostics)
  if (
    pairs.length === 0 ||
    diagnostics.some((item) => item.severity === 'error')
  )
    return
  const byId = new Map(rawNodes.map((node) => [node.id, node]))
  const doc = document as Mutable
  const graph = doc['graphs']['g0'] as Mutable
  const view = doc['view']['graphs']['g0'] as Mutable
  if (
    Object.keys(graph['nets'] ?? {}).length > 0 ||
    Object.keys(graph['reroutes'] ?? {}).length > 0
  ) {
    loopError(
      diagnostics,
      'topologySugarUnsupported',
      'Generic Loop conversion does not cross named nets or reroutes',
    )
    return
  }
  doc['occurrenceTopologies'] ??= {}
  const convertedOutputIsList = new Map<string, boolean>()

  for (const pair of pairs) {
    const startRaw = byId.get(pair.start)!
    const endRaw = byId.get(pair.end)!
    const startId = `n${pair.start}`
    const endId = `n${pair.end}`
    const startNode = graph['nodes'][startId] as Mutable | undefined
    const endNode = graph['nodes'][endId] as Mutable | undefined
    if (!startNode || !endNode) {
      loopError(
        diagnostics,
        'boundaryMissing',
        `loop pair ${pair.start}/${pair.end} was not materialized`,
      )
      return
    }
    const iteration = rangeValues(startRaw, diagnostics)
    if (!iteration) return
    const linkedRangeInputs = new Map(
      rawLinks
        .filter(
          (link) =>
            link.to === pair.start &&
            (rawPortName(startRaw, 'inputs', link.toSlot)?.startsWith('mode.') ??
              false),
        )
        .map((link) => [rawPortName(startRaw, 'inputs', link.toSlot)!, link]),
    )
    const bodyNodeIds = new Set(
      [...pair.body]
        .map((id) => `n${id}`)
        .filter((id) => graph['nodes'][id] !== undefined),
    )
    const expandingBodyNode = [...bodyNodeIds]
      .map((id) => graph['nodes'][id] as Mutable)
      .find((node) => resolve(node['type'])?.mayExpandGraph === true)
    if (expandingBodyNode) {
      loopError(
        diagnostics,
        'runtimeExpansionUnsupported',
        `Loop ${pair.start}/${pair.end} contains runtime-expanding node ${expandingBodyNode['id']} (${expandingBodyNode['type']})`,
      )
      return
    }
    const allLinks = Object.values(graph['links']) as Mutable[]
    const internal = allLinks.filter(
      (link) =>
        bodyNodeIds.has(endpointNode(link['from']) ?? '') &&
        bodyNodeIds.has(endpointNode(link['to']) ?? ''),
    )
    const incoming = allLinks.filter(
      (link) =>
        !bodyNodeIds.has(endpointNode(link['from']) ?? '') &&
        bodyNodeIds.has(endpointNode(link['to']) ?? '') &&
        endpointNode(link['from']) !== startId,
    )
    const startLinks = allLinks.filter(
      (link) =>
        endpointNode(link['from']) === startId &&
        bodyNodeIds.has(endpointNode(link['to']) ?? ''),
    )
    const endOutputs = allLinks.filter(
      (link) => endpointNode(link['from']) === endId,
    )
    const escapes = allLinks.filter(
      (link) =>
        bodyNodeIds.has(endpointNode(link['from']) ?? '') &&
        endpointNode(link['to']) !== endId &&
        !bodyNodeIds.has(endpointNode(link['to']) ?? ''),
    )
    if (escapes.length > 0) {
      loopError(
        diagnostics,
        'bodyEscape',
        `Start Loop ${pair.start} body has ${escapes.length} output route(s) outside End Loop ${pair.end}`,
      )
      return
    }
    const accumulateLink = rawLinks.find(
      (link) =>
        link.to === pair.end &&
        rawPortName(endRaw, 'inputs', link.toSlot) === 'accumulate',
    )
    if (accumulateLink !== undefined) {
      loopError(
        diagnostics,
        'accumulateDynamic',
        `End Loop ${pair.end} has a linked accumulate control; Dinkster output roles are static`,
      )
      return
    }

    const defBase = `comfy-loop-${pair.start}`
    let defId = defBase
    for (let suffix = 2; doc['graphs'][defId] !== undefined; suffix++)
      defId = `${defBase}-${suffix}`
    const body: Mutable = {
      id: defId,
      name: `ComfyUI Loop ${pair.start}`,
      nodes: Object.fromEntries(
        [...bodyNodeIds].map((id) => [id, graph['nodes'][id]]),
      ),
      links: Object.fromEntries(internal.map((link) => [link['id'], link])),
      nets: {},
      reroutes: {},
      boundary: { inputs: [], outputs: [] },
      nextOrdinal: Math.max(1, Number(graph['nextOrdinal']) || 1),
    }
    const bodyView: Mutable = {
      nodes: Object.fromEntries(
        [...bodyNodeIds].flatMap((id) =>
          view['nodes']?.[id] ? [[id, view['nodes'][id]]] : [],
        ),
      ),
    }
    let ordinal = body['nextOrdinal'] as number
    const nextNodeId = (label: string): string => `loop_${label}_${ordinal++}`
    const nextLinkId = (): string => `loop_link_${ordinal++}`
    const inputBindings = new Map<string, Mutable[]>()
    const inputSources = new Map<string, Mutable>()
    const addInput = (id: string, binding: Mutable, source?: Mutable): void => {
      const bindings = inputBindings.get(id) ?? []
      bindings.push(binding)
      inputBindings.set(id, bindings)
      if (source !== undefined) inputSources.set(id, source)
    }
    const addBodyLink = (from: Mutable, to: Mutable): void => {
      const id = nextLinkId()
      body['links'][id] = { id, from, to }
    }
    const outputRoles: Mutable = {}
    const outputPorts: string[] = []
    const addOutput = (
      id: string,
      source: Mutable,
      role?: 'gather' | 'flatten' | 'last',
    ): void => {
      body['boundary']['outputs'].push({
        id,
        displayName: id,
        binds: { kind: 'port', ...source },
      })
      outputPorts.push(id)
      if (role && role !== 'gather') outputRoles[id] = { kind: role }
    }

    for (const link of incoming) {
      const key = endpointKey(link['from'])
      let id = [...inputSources].find(
        ([, source]) => endpointKey(source) === key,
      )?.[0]
      if (!id) id = `external_${inputSources.size}`
      addInput(id, { kind: 'port', ...link['to'] }, link['from'])
    }

    const values: Mutable = {}
    const elementPorts = new Set<string>()
    const statePorts = new Set<string>()
    const occurrenceLinks: Mutable = {}
    let occurrenceOrdinal = 0
    const addIndexLink = (to: Mutable): void => {
      const id = `index_${occurrenceOrdinal++}`
      occurrenceLinks[id] = {
        id,
        from: { kind: 'body', endpoint: { node: '$region', port: 'index' } },
        to: { kind: 'body', endpoint: to },
      }
    }
    const linkedRange = iteration.mode === 'range' && linkedRangeInputs.size > 0
    const staticFlags =
      iteration.mode === 'range' && !linkedRange
        ? {
            is_first: iteration.values.map((_, index) => index === 0),
            is_last: iteration.values.map(
              (_, index) => index === iteration.values.length - 1,
            ),
          }
        : undefined
    let sequenceSource: Mutable | undefined
    if (iteration.mode === 'range' && !linkedRange) {
      values['iteration_index'] = iteration.values
      elementPorts.add('iteration_index')
    }

    if (iteration.mode === 'range' && linkedRange) {
      const rangeId = nextNodeId('range')
      const rangeValues: Mutable = {
        start: iteration.start,
        stop: iteration.stop,
        step: iteration.step,
      }
      graph['nodes'][rangeId] = {
        id: rangeId,
        type: 'std.list.range',
        values: rangeValues,
      }
      view['nodes'][rangeId] = {
        position: { x: Number(startRaw.id) * 20 - 180, y: -180 },
      }
      const rangeNames =
        startSettings(startRaw).mode === 'For'
          ? {
              'mode.start_iteration_index': 'start',
              'mode.max_iteration': 'stop',
              'mode.step': 'step',
            }
          : { 'mode.num_iterations': 'stop' }
      for (const [sourceName, targetName] of Object.entries(rangeNames)) {
        const raw = linkedRangeInputs.get(sourceName)
        const link = raw && graph['links'][`l${raw.id}`]
        if (!link) continue
        delete rangeValues[targetName]
        const id = `loop_outer_${ordinal++}`
        graph['links'][id] = {
          id,
          from: link['from'],
          to: { node: rangeId, port: targetName },
        }
      }
      sequenceSource = { node: rangeId, port: 'list' }
      inputSources.set('iteration_index', sequenceSource)
      elementPorts.add('iteration_index')
    }

    let listSource: Mutable | undefined
    if (iteration.mode === 'list') {
      const listRawLink = rawLinks.find(
        (link) =>
          link.to === pair.start &&
          rawPortName(startRaw, 'inputs', link.toSlot) === 'mode.list',
      )
      const listLink = listRawLink && graph['links'][`l${listRawLink.id}`]
      if (!listLink) {
        loopError(
          diagnostics,
          'modeUnsupported',
          `List Start Loop ${pair.start} requires a connected list input`,
        )
        return
      }
      listSource = listLink['from'] as Mutable
      sequenceSource = listSource
      inputSources.set('list_item', listSource)
      elementPorts.add('list_item')
    }

    const startPort = (link: Mutable): string | undefined => {
      const rawId =
        typeof link['id'] === 'string' && /^l\d+$/.test(link['id'])
          ? Number(link['id'].slice(1))
          : undefined
      const raw =
        rawId === undefined
          ? undefined
          : rawLinks.find((candidate) => candidate.id === rawId)
      return raw === undefined
        ? link['from']?.['port']
        : [
            'iteration_index',
            'is_first',
            'is_last',
            'list_item',
            'current_iteration_value',
          ][raw.fromSlot]
    }
    for (const link of startLinks) {
      const port = startPort(link)
      if (port === 'iteration_index') {
        if (iteration.mode === 'range')
          addInput('iteration_index', { kind: 'port', ...link['to'] })
        else addIndexLink(link['to'])
      } else if (port === 'list_item') {
        if (iteration.mode === 'list')
          addInput('list_item', { kind: 'port', ...link['to'] })
        else {
          values['list_item'] = (iteration as { values: Json[] }).values.map(
            () => null,
          )
          elementPorts.add('list_item')
          addInput('list_item', { kind: 'port', ...link['to'] })
        }
      } else if (port === 'current_iteration_value') {
        addInput('carry', { kind: 'port', ...link['to'] })
        statePorts.add('carry')
      } else if (port === 'is_first' || port === 'is_last') {
        if (staticFlags) {
          values[port] = staticFlags[port]
          elementPorts.add(port)
          addInput(port, { kind: 'port', ...link['to'] })
        } else {
          const compareId = nextNodeId(port)
          body['nodes'][compareId] = {
            id: compareId,
            type: STRUCTURAL_IMPORT_HELPERS.compare,
            values: {
              b: 0,
              operation: 'eq',
              epsilon: 0,
            },
          }
          bodyView['nodes'][compareId] = {
            position: { x: 0, y: port === 'is_first' ? -120 : 120 },
          }
          addIndexLink({ node: compareId, port: 'a' })
          if (port === 'is_last') {
            const countId = nextNodeId('count_minus_one')
            body['nodes'][countId] = {
              id: countId,
              type: 'std.math.add_ints',
              values: { b: -1 },
            }
            bodyView['nodes'][countId] = { position: { x: -180, y: 120 } }
            addInput('loop_count', { kind: 'port', node: countId, port: 'a' })
            addBodyLink(
              { node: countId, port: 'sum' },
              { node: compareId, port: 'b' },
            )
          }
          addBodyLink({ node: compareId, port: 'result' }, link['to'])
        }
      }
    }
    if (iteration.mode === 'range' && !inputBindings.has('iteration_index')) {
      const anchorId = nextNodeId('iteration_anchor')
      body['nodes'][anchorId] = {
        id: anchorId,
        type: 'std.math.add_ints',
        values: { b: 0 },
      }
      bodyView['nodes'][anchorId] = { position: { x: -180, y: 0 } }
      addInput('iteration_index', { kind: 'port', node: anchorId, port: 'a' })
    }
    if (iteration.mode === 'list' && !inputBindings.has('list_item')) {
      const anchorId = nextNodeId('list_item_anchor')
      body['nodes'][anchorId] = {
        id: anchorId,
        type: STRUCTURAL_IMPORT_HELPERS.compare,
        values: { operation: 'eq', epsilon: 0 },
      }
      bodyView['nodes'][anchorId] = { position: { x: -180, y: 0 } }
      addInput('list_item', { kind: 'port', node: anchorId, port: 'a' })
      addInput('list_item', { kind: 'port', node: anchorId, port: 'b' })
    }

    const initialCarryRaw = rawLinks.find(
      (link) =>
        link.to === pair.start &&
        rawPortName(startRaw, 'inputs', link.toSlot) ===
          'initial_iteration_value',
    )
    const initialCarry =
      initialCarryRaw && graph['links'][`l${initialCarryRaw.id}`]
    if (statePorts.has('carry')) {
      if (initialCarry) inputSources.set('carry', initialCarry['from'])
      else values['carry'] = null
    }

    const endInput = (
      name: string,
    ): { raw: RawLink; link: Mutable } | undefined => {
      const raw = rawLinks.find(
        (candidate) =>
          candidate.to === pair.end &&
          rawPortName(endRaw, 'inputs', candidate.toSlot) === name,
      )
      const link = raw && graph['links'][`l${raw.id}`]
      return raw && link ? { raw, link } : undefined
    }
    const nextCarry = endInput('next_iteration_value')
    if (nextCarry) {
      if (!bodyNodeIds.has(endpointNode(nextCarry.link['from']) ?? '')) {
        loopError(
          diagnostics,
          'carryTypeIncompatible',
          `End Loop ${pair.end} carry source is not a body node`,
        )
        return
      }
      const carries = startLinks.filter(
        (link) => startPort(link) === 'current_iteration_value',
      )
      const carrySources = [
        initialCarry?.['from'],
        nextCarry.link['from'],
      ].filter((source): source is Mutable => source !== undefined)
      const carryTargets = carries.map((link) => link['to'] as Mutable)
      const incompatible = carrySources.some((source) => {
        const sourceType = endpointType(graph, source, 'output', resolve)
        return (
          sourceType !== undefined &&
          carryTargets.some((target) => {
            const targetType = endpointType(graph, target, 'input', resolve)
            return (
              targetType !== undefined &&
              targetType.kind !== 'wildcard' &&
              !(
                targetType.kind === 'concrete' &&
                targetType.name === 'core.value'
              ) &&
              !typesCompatible(sourceType, targetType)
            )
          })
        )
      })
      if (incompatible) {
        loopError(
          diagnostics,
          'carryTypeIncompatible',
          `Loop ${pair.start}/${pair.end} carry endpoints do not share a compatible type`,
        )
        return
      }
      if (carries.length > 0) statePorts.add('carry')
      if (statePorts.has('carry') && !inputBindings.has('carry')) {
        const consumers = startLinks.filter(
          (link) => startPort(link) === 'current_iteration_value',
        )
        for (const consumer of consumers)
          addInput('carry', { kind: 'port', ...consumer['to'] })
      }
      if (statePorts.has('carry')) {
        if (!initialCarry) values['carry'] = null
        addOutput('next_carry', nextCarry.link['from'])
        outputRoles['next_carry'] = { kind: 'state', statePort: 'carry' }
      } else {
        addOutput('next_value', nextCarry.link['from'], 'gather')
      }
    }

    const resultInput = endInput('output_value')
    if (resultInput) {
      const sourceNode = endpointNode(resultInput.link['from'])
      if (!sourceNode || !bodyNodeIds.has(sourceNode)) {
        loopError(
          diagnostics,
          'outputCardinalityUnknown',
          `End Loop ${pair.end} output source is not a body node`,
        )
        return
      }
      const accumulate = Array.isArray(endRaw.widgets_values)
        ? endRaw.widgets_values[0] === true
        : widgetRecord(endRaw)['accumulate'] === true
      const producerRawId = Number(sourceNode.slice(1))
      const producerRaw = byId.get(producerRawId)
      const sourceRawLink = resultInput.raw
      const sourceIsList =
        convertedOutputIsList.get(sourceNode) ??
        (producerRaw !== undefined &&
          outputIsList(producerRaw, sourceRawLink.fromSlot, resolve))
      const role = !accumulate ? 'last' : sourceIsList ? 'flatten' : 'gather'
      addOutput('result', resultInput.link['from'], role)
      convertedOutputIsList.set(startId, accumulate && sourceIsList)
    }

    for (const raw of rawLinks.filter(
      (link) =>
        link.to === pair.end &&
        (rawPortName(endRaw, 'inputs', link.toSlot)?.startsWith(
          'termination',
        ) ??
          false),
    )) {
      const link = graph['links'][`l${raw.id}`] as Mutable | undefined
      const sourceNode = link && endpointNode(link['from'])
      if (!link || !sourceNode || !bodyNodeIds.has(sourceNode)) {
        loopError(
          diagnostics,
          'terminationTargetUnsupported',
          `End Loop ${pair.end} termination ${raw.id} is not produced by its body`,
        )
        return
      }
      addOutput(`termination_${raw.id}`, link['from'], 'gather')
    }

    if (sequenceSource && inputBindings.has('loop_count')) {
      const lengthId = nextNodeId('list_length')
      graph['nodes'][lengthId] = {
        id: lengthId,
        type: 'std.list.length',
        values: {},
      }
      view['nodes'][lengthId] = {
        position: { x: Number(startRaw.id) * 20 - 180, y: -180 },
      }
      const sourceLinkId = `loop_outer_${ordinal++}`
      graph['links'][sourceLinkId] = {
        id: sourceLinkId,
        from: sequenceSource,
        to: { node: lengthId, port: 'list' },
      }
      inputSources.set('loop_count', { node: lengthId, port: 'length' })
    }

    for (const [id, bindings] of inputBindings) {
      for (const binding of bindings) {
        const target = body['nodes'][binding['node']] as Mutable | undefined
        if (target?.['region']?.['statePorts']?.includes(binding['port'])) {
          target['values'][binding['port']] ??= null
        }
      }
      body['boundary']['inputs'].push({
        id,
        displayName: id,
        binds: bindings[0],
        ...(bindings.length > 1 ? { alsoBinds: bindings.slice(1) } : {}),
      })
    }
    for (const node of Object.values(body['nodes']) as Mutable[]) {
      for (const statePort of node['region']?.['statePorts'] ?? []) {
        node['values'][statePort] ??= null
      }
    }
    if (outputPorts.length === 0) {
      loopError(
        diagnostics,
        'terminationTargetUnsupported',
        `Loop ${pair.start}/${pair.end} has no executable output, carry, or termination target`,
      )
      return
    }
    body['nextOrdinal'] = ordinal

    const removed = new Set([startId, endId, ...bodyNodeIds])
    graph['links'] = Object.fromEntries(
      (Object.values(graph['links']) as Mutable[])
        .filter(
          (link) =>
            !removed.has(endpointNode(link['from']) ?? '') &&
            !removed.has(endpointNode(link['to']) ?? ''),
        )
        .map((link) => [link['id'], link]),
    )
    for (const id of bodyNodeIds) {
      delete graph['nodes'][id]
      delete view['nodes']?.[id]
    }
    delete graph['nodes'][endId]
    delete view['nodes']?.[endId]

    const cacheIterations = startSettings(startRaw).cacheIterations
    graph['nodes'][startId] = {
      id: startId,
      type: `#${defId}`,
      values,
      region: {
        kind: 'fold',
        elementPorts: [...elementPorts],
        ...(statePorts.size > 0 ? { statePorts: [...statePorts] } : {}),
        ...(Object.keys(outputRoles).length > 0 ? { outputRoles } : {}),
        binding: 'zip',
        cachePolicy: cacheIterations ? 'reuse' : 'rerun',
      },
      ext: { 'importer.comfyLoop': { start: pair.start, end: pair.end } },
    }
    for (const [id, source] of inputSources) {
      const linkId = `loop_outer_${ordinal++}`
      graph['links'][linkId] = {
        id: linkId,
        from: source,
        to: { node: startId, port: id },
      }
    }
    for (const link of endOutputs) {
      if (!resultInput) {
        loopError(
          diagnostics,
          'outputCardinalityUnknown',
          `End Loop ${pair.end} has consumers but no output_value`,
        )
        return
      }
      graph['links'][link['id']] = {
        ...link,
        from: { node: startId, port: 'result' },
      }
    }
    graph['nextOrdinal'] = Math.max(Number(graph['nextOrdinal']) || 1, ordinal)
    doc['graphs'][defId] = body
    doc['view']['graphs'][defId] = bodyView

    for (const topology of Object.values(
      doc['occurrenceTopologies'],
    ) as Mutable[]) {
      const path = [
        ...topology['owner']['instancePath'],
        topology['owner']['node'],
      ]
      if (bodyNodeIds.has(path[0])) {
        topology['owner'] = {
          instancePath: [startId, ...topology['owner']['instancePath']],
          node: topology['owner']['node'],
        }
      }
    }
    if (Object.keys(occurrenceLinks).length > 0) {
      const owner = { instancePath: [], node: startId }
      doc['occurrenceTopologies'][startId] = {
        owner,
        bodyGraph: defId,
        links: occurrenceLinks,
        nextOrdinal: occurrenceOrdinal,
      }
    }
  }
}
