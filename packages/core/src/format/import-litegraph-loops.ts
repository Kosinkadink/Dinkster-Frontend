import type { LinkEndpoint } from '../ids.js'
import { traceEndpoint } from '../reroute.js'
import { deriveBoundarySchema } from '../schema/derive-boundary.js'
import {
  elaborateInterface,
  elabInputsOf,
  elabOutputsOf,
  elabKeyOf,
} from '../schema/elaborate.js'
import { solveGraphTypes } from '../schema/solve.js'
import {
  cardinalityOf,
  inputsOf,
  outputsOf,
  type NodeSchema,
  type TypeExpr,
} from '../schema/model.js'
import type {
  GraphDef,
  JsonObject,
  NodeData,
  RegionContract,
} from './document.js'

type Mutable = { [key: string]: any }

const endpointNode = (endpoint: Mutable): string | undefined =>
  typeof endpoint?.['node'] === 'string' ? endpoint['node'] : undefined

/** Persist source execution-list boundaries as ordinary, explicitly typed maps. */
export function convertLitegraphListConsumers(
  document: JsonObject,
  resolve: (type: string) => NodeSchema | undefined,
): void {
  const doc = document as Mutable
  const graph = doc['graphs']['g0'] as Mutable
  const generated = new Map<string, NodeSchema>()
  const localResolve = (type: string): NodeSchema | undefined =>
    generated.get(type) ?? resolve(type)
  const controls = new Set([
    'StartLoop',
    'EndLoop',
    'LoopIteration',
    'LoopProgress',
    'LoopResult',
  ])
  const converted = new Map<
    string,
    { original: Mutable; defId: string; elements: ReadonlySet<string> }
  >()
  const incomingTo = (id: string): Mutable[] => [
    ...(Object.values(graph['links']) as Mutable[]).filter(
      (link) => endpointNode(link['to']) === id,
    ),
    ...(Object.values(graph['nets']) as Mutable[]).flatMap((net) =>
      net['sinks']
        .filter((sink: Mutable) => endpointNode(sink) === id)
        .map((sink: Mutable) => ({ from: net['source'], to: sink })),
    ),
  ]
  const sourceTypes = new Map<string, TypeExpr>()
  const resolving = new Set<string>()
  // Project upstream declarations without downstream scalar constraints erasing
  // open list constructors at generic inputs.
  const sourceType = (endpoint: Mutable): TypeExpr | undefined => {
    const traced = traceEndpoint(graph as GraphDef, endpoint as LinkEndpoint)
    if (traced.kind !== 'output') return undefined
    const key = `${traced.ref.node}/${elabKeyOf(traced.ref)}`
    const cached = sourceTypes.get(key)
    if (cached) return cached
    const source = graph['nodes'][traced.ref.node] as Mutable | undefined
    const schema = source && localResolve(source['type'])
    if (!source || !schema || resolving.has(key)) return undefined
    resolving.add(key)
    const projectedInputs = incomingTo(traced.ref.node).flatMap((link) => {
      const type = sourceType(link['from'])
      return type ? [{ type, to: link['to'] }] : []
    })
    const solved = solveGraphTypes(
      {
        ...graph,
        nodes: { [traced.ref.node]: source },
        links: {},
        nets: {},
        reroutes: {},
      } as GraphDef,
      localResolve,
      { projectedInputs },
    )
    const type = solved.portTypeOf(
      traced.ref.node,
      'output',
      elabKeyOf(traced.ref),
    )
    resolving.delete(key)
    if (type) sourceTypes.set(key, type)
    return type
  }
  const flattened = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const [id, node] of Object.entries(graph['nodes']) as [
      string,
      Mutable,
    ][]) {
      if (
        node['type'] === 'EndLoop' &&
        (node['mode'] === undefined || node['mode'] === 'active') &&
        !flattened.has(id) &&
        localResolve('std.list.concat')
      ) {
        const output = incomingTo(id).find(
          (link) => link['to']['port'] === 'output_value',
        )
        if (output && sourceType(output['from'])?.kind === 'list') {
          let defId = `loop-result-${id}`
          for (let suffix = 2; doc['graphs'][defId]; suffix++)
            defId = `loop-result-${id}-${suffix}`
          const body = {
            id: defId,
            name: 'Loop Result',
            nodes: {
              body: {
                id: 'body',
                type: 'std.list.concat',
                values: {},
                dynamic: { lists: { members: ['m0'], seq: 1 } },
              },
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 1,
            boundary: {
              inputs: [
                {
                  id: 'item',
                  binds: {
                    kind: 'port',
                    node: 'body',
                    port: 'lists.lists',
                    members: ['m0'],
                  },
                },
              ],
              outputs: [
                {
                  id: 'list',
                  binds: { kind: 'port', node: 'body', port: 'list' },
                },
              ],
            },
          } as unknown as GraphDef
          const region: RegionContract = {
            kind: 'map',
            elementPorts: ['item'],
            outputRoles: { list: { kind: 'flatten' } },
          }
          const derived = deriveBoundarySchema(body, localResolve, region)
          if (derived.schema) {
            let helperId = `loop_result_${id}`
            for (let suffix = 2; graph['nodes'][helperId]; suffix++)
              helperId = `loop_result_${id}_${suffix}`
            const replacement = { node: helperId, port: 'list' }
            for (const link of Object.values(graph['links']) as Mutable[])
              if (endpointNode(link['from']) === id) link['from'] = replacement
            for (const net of Object.values(graph['nets']) as Mutable[])
              if (endpointNode(net['source']) === id)
                net['source'] = replacement
            let ordinal = Number(graph['nextOrdinal']) || 1
            let linkId = `list_link_${ordinal++}`
            while (graph['links'][linkId]) linkId = `list_link_${ordinal++}`
            graph['links'][linkId] = {
              id: linkId,
              from: { node: id, port: 'outputs' },
              to: { node: helperId, port: 'item' },
            }
            graph['nextOrdinal'] = ordinal
            graph['nodes'][helperId] = {
              id: helperId,
              type: `#${defId}`,
              values: {},
              region,
            }
            doc['graphs'][defId] = body
            doc['view']['graphs'][defId] = {
              nodes: { body: { position: { x: 0, y: 0 } } },
            }
            doc['view']['graphs']['g0']['nodes'][helperId] = {
              position: { x: 0, y: 0 },
            }
            generated.set(derived.schema.type, derived.schema)
            flattened.add(id)
            sourceTypes.clear()
            changed = true
          }
        }
      }
      const previous = converted.get(id)
      const original = previous?.original ?? node
      if (
        (!previous && node['region']) ||
        original['virtual'] ||
        controls.has(original['type']) ||
        original['type'].startsWith('std.list.')
      )
        continue
      const schema = localResolve(original['type'])
      if (!schema || schema.mayExpandGraph) continue
      const elaborated = elaborateInterface(schema, original as NodeData)
      const inputs = elabInputsOf(elaborated).filter(
        (input) =>
          input.apiName !== undefined && input.origin.kind !== 'selector',
      )
      const sourceIsList = (endpoint: Mutable): boolean => {
        return sourceType(endpoint)?.kind === 'list'
      }
      const incoming = incomingTo(id)
      const elementInputs = new Set(
        incoming
          .filter((link) => {
            const key = previous ? link['to']['port'] : elabKeyOf(link['to'])
            const input = inputs.find(
              (input) => elabKeyOf(input.address) === key,
            )
            return (
              input !== undefined &&
              input.spec.acceptsList !== true &&
              cardinalityOf(input.spec.type) === 'scalar' &&
              sourceIsList(link['from'])
            )
          })
          .map((link) =>
            previous ? (link['to']['port'] as string) : elabKeyOf(link['to']),
          ),
      )
      if (elementInputs.size === 0) continue
      if (
        previous &&
        [...elementInputs].every((key) => previous.elements.has(key))
      )
        continue
      for (const key of previous?.elements ?? []) elementInputs.add(key)
      let defId = previous?.defId ?? `list-map-${id}`
      if (!previous)
        for (let suffix = 2; doc['graphs'][defId]; suffix++)
          defId = `list-map-${id}-${suffix}`
      const outputs = elabOutputsOf(elaborated).filter(
        (output) => output.wireable !== false,
      )
      const boundaryKeys = new Set(
        inputs.map((input) => elabKeyOf(input.address)),
      )
      const outputKeys = new Map(
        outputs.map((output) => {
          const key = elabKeyOf(output.address)
          let exposed = key
          while (boundaryKeys.has(exposed)) exposed = `output.${exposed}`
          boundaryKeys.add(exposed)
          return [key, exposed]
        }),
      )
      const body = {
        id: defId,
        name: schema.displayName,
        nodes: { body: { ...original, id: 'body' } },
        links: {},
        nets: {},
        reroutes: {},
        nextOrdinal: 1,
        boundary: {
          inputs: inputs.map((input) => ({
            id: elabKeyOf(input.address),
            binds: { kind: 'port', node: 'body', ...input.address },
            ...(input.spec.widget &&
            !elementInputs.has(elabKeyOf(input.address))
              ? { promoted: true }
              : {}),
          })),
          outputs: outputs.map((output) => ({
            id: outputKeys.get(elabKeyOf(output.address))!,
            binds: { kind: 'port', node: 'body', ...output.address },
          })),
        },
      } as unknown as GraphDef
      const region: RegionContract = {
        kind: 'map',
        elementPorts: [...elementInputs],
        binding: 'broadcast',
        outputRoles: Object.fromEntries(
          outputs.map((output) => [
            outputKeys.get(elabKeyOf(output.address))!,
            { kind: output.spec.type.kind === 'list' ? 'flatten' : 'gather' },
          ]),
        ),
      }
      const derived = deriveBoundarySchema(body, localResolve, region)
      if (!derived.schema) continue
      generated.set(derived.schema.type, derived.schema)
      doc['graphs'][defId] = body
      doc['view']['graphs'][defId] = {
        nodes: { body: { position: { x: 0, y: 0 } } },
      }
      graph['nodes'][id] = {
        id,
        type: `#${defId}`,
        values: Object.fromEntries(
          Object.entries(original['values']).filter(
            ([key]) => !elementInputs.has(key),
          ),
        ),
        region,
        ...(node['mode'] ? { mode: node['mode'] } : {}),
        ...(node['title'] ? { title: node['title'] } : {}),
      }
      if (!previous) {
        for (const link of Object.values(graph['links']) as Mutable[]) {
          for (const side of ['from', 'to'])
            if (endpointNode(link[side]) === id)
              link[side] = {
                node: id,
                port:
                  side === 'from'
                    ? outputKeys.get(elabKeyOf(link[side]))!
                    : elabKeyOf(link[side]),
              }
        }
        for (const net of Object.values(graph['nets']) as Mutable[]) {
          if (endpointNode(net['source']) === id)
            net['source'] = {
              node: id,
              port: outputKeys.get(elabKeyOf(net['source']))!,
            }
          net['sinks'] = net['sinks'].map((sink: Mutable) =>
            endpointNode(sink) === id
              ? {
                  node: id,
                  port: elabKeyOf({
                    port: sink['port'],
                    members: sink['members'],
                  }),
                }
              : sink,
          )
        }
      }
      converted.set(id, { original, defId, elements: elementInputs })
      sourceTypes.clear()
      changed = true
    }
  }
}
