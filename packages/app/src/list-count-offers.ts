import {
  asNodeId, buildGraphConnectivity, elabInputsOf, elaborateInterface, effectiveWidgetDefault,
  listCountAnswerKey, occurrenceDynamicView, occurrenceKey, solveOccurrenceTypes, subgraphDefIdOf, valueKeyOf,
  type FormulaContext, type OccurrenceListCountEstimate, type SchemaResolver, type WorkflowDocument,
  type CommandInvocation, type Json,
} from '@dinkster/core'

export interface ListCountOffer {
  readonly nodeId: string
  readonly inputId: string
  readonly count: number
  readonly sources: readonly string[]
  readonly limit?: number
}

/** Held metadata can offer a count, but never changes a document by itself. */
export function listCountOffers(
  document: WorkflowDocument, resolve: SchemaResolver, graphId: string, instancePath: readonly string[],
  estimateOf: OccurrenceListCountEstimate | undefined,
): readonly ListCountOffer[] {
  if (estimateOf === undefined) return []
  const graph = document.graphs[graphId]
  if (graph === undefined) return []
  const path = instancePath.map(asNodeId)
  const solved = solveOccurrenceTypes(document, resolve, graphId, path, estimateOf)
  const occurrence = occurrenceDynamicView(document, resolve, path, path.length === 0 ? graphId : document.root)
  const connectivity = buildGraphConnectivity(graph)
  const offers: ListCountOffer[] = []
  for (const stored of Object.values(graph.nodes)) {
    const schema = resolve(stored.type)
    if (schema === undefined) continue
    const values = occurrence.values.get(stored.id)
    const dynamic = occurrence.dynamic.get(stored.id)
    const controllers = occurrence.controllers.get(stored.id)
    const node = { ...stored, ...(values === undefined ? {} : { values }),
      ...(dynamic === undefined ? {} : { dynamic }), ...(controllers === undefined ? {} : { controllers }) }
    const contexts = new Map<string, FormulaContext>()
    const base = connectivity(node.id)
    const inputs = occurrence.inputPorts.get(node.id) ?? []
    const elaborated = elaborateInterface(schema, node, {
      ...base, isInputConnected: port => inputs.includes(port), inputPorts: () => inputs,
    }, { formulaContexts: contexts })
    for (const field of elabInputsOf(elaborated)) {
      if (field.spec.listCountOf === undefined) continue
      const prefix = field.address.port.slice(0, field.address.port.lastIndexOf('.') + 1)
      const source = contexts.get(prefix)?.paths.get(field.spec.listCountOf)
      const fact = source === undefined ? undefined : solved?.listCountFactOf(node.id, 'input', source)
      if (fact?.kind !== 'estimate') continue
      const count = node.values[valueKeyOf(field)] ?? (field.spec.widget && effectiveWidgetDefault(field.spec.widget))
      const answer = document.view.graphs[graphId]?.nodes[node.id]?.listCountAnswers?.[listCountAnswerKey(instancePath, valueKeyOf(field))]
      if (typeof count === 'number' && fact.count <= count || answer === fact.count) continue
      const max = field.spec.widget?.options['max']
      offers.push({ nodeId: node.id, inputId: valueKeyOf(field), count: fact.count, sources: fact.sources,
        ...(typeof max === 'number' && fact.count > max ? { limit: max } : {}),
      })
    }
  }
  return offers
}

/** The count and its answered offer travel together through undo and shared replay. */
export function useListCountEstimate(graphId: string, instancePath: readonly string[], offer: ListCountOffer): CommandInvocation {
  return { command: 'batch', params: { invocations: [
    { command: instancePath.length === 0 ? 'node.setValue' : 'occurrence.setListCount', params: {
      graphId, nodeId: offer.nodeId, inputId: offer.inputId, value: offer.count,
      ...(instancePath.length === 0 ? {} : { instancePath }),
    } },
    { command: 'view.answerListCountEstimate', params: {
      graphId, nodeId: offer.nodeId, inputId: offer.inputId, instancePath, count: offer.count,
    } },
  ] } }
}

/** Explicit value edits answer offers on their concrete count fields, including promoted fields. */
export function answerListCountValueEdits(
  document: WorkflowDocument, resolve: SchemaResolver, estimates: () => OccurrenceListCountEstimate | undefined,
  invocation: CommandInvocation,
): CommandInvocation {
  const writes: { graphId: string; nodeId: string; inputId: string; path?: readonly string[] }[] = []
  const collect = (command: CommandInvocation): void => {
    if (command === null || typeof command !== 'object') return
    const params = command.params as Record<string, Json> | undefined
    if (command.command === 'batch' && Array.isArray(params?.invocations)) {
      for (const child of params.invocations) collect(child as unknown as CommandInvocation)
    } else if ((command.command === 'node.setValue' || command.command === 'occurrence.setListCount') &&
        typeof params?.graphId === 'string' && typeof params.nodeId === 'string' && typeof params.inputId === 'string' &&
        typeof params.value === 'number') {
      writes.push({ graphId: params.graphId, nodeId: params.nodeId, inputId: params.inputId,
        ...(command.command === 'occurrence.setListCount' && Array.isArray(params.instancePath)
          ? { path: params.instancePath as string[] } : {}) })
    } else if (command.command === 'node.setValues' && typeof params?.graphId === 'string' &&
        typeof params.nodeId === 'string' && params.values !== null && typeof params.values === 'object' && !Array.isArray(params.values)) {
      for (const [inputId, value] of Object.entries(params.values)) {
        if (typeof value === 'number') writes.push({ graphId: params.graphId, nodeId: params.nodeId, inputId })
      }
    }
  }
  collect(invocation)
  if (writes.length === 0) return invocation
  const estimateOf = estimates()
  if (estimateOf === undefined) return invocation
  const answers: CommandInvocation[] = []
  const visit = (graphId: string, path: readonly string[], ancestors: readonly string[]): void => {
    const graph = document.graphs[graphId]
    if (graph === undefined || ancestors.includes(graphId)) return
    const view = occurrenceDynamicView(document, resolve, path)
    for (const offer of listCountOffers(document, resolve, graphId, path, estimateOf)) {
      const owner = view.valueOwners.get(offer.nodeId)?.get(offer.inputId)
      const overridden = path.length > 0 && document.occurrenceListCounts?.[occurrenceKey({ instancePath: path.map(asNodeId), node: asNodeId(offer.nodeId) })]?.counts[offer.inputId] !== undefined
      const matches = writes.some(write => write.path !== undefined
        ? write.graphId === graphId && write.nodeId === offer.nodeId && write.inputId === offer.inputId && JSON.stringify(write.path) === JSON.stringify(path)
        : !overridden && write.graphId === (owner?.graphId ?? graphId) && write.nodeId === (owner?.nodeId ?? offer.nodeId) &&
          write.inputId === (owner?.valueKey ?? offer.inputId))
      if (matches) answers.push({ command: 'view.answerListCountEstimate', params: {
        graphId, nodeId: offer.nodeId, inputId: offer.inputId, instancePath: [...path], count: offer.count,
      } })
    }
    for (const node of Object.values(graph.nodes)) {
      const child = subgraphDefIdOf(node.type)
      if (child !== undefined) visit(child, [...path, node.id], [...ancestors, graphId])
    }
  }
  visit(document.root, [], [])
  return answers.length === 0 ? invocation : { command: 'batch', params: { invocations: [invocation, ...answers] } as unknown as Json }
}
