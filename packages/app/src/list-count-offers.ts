import {
  asNodeId, buildGraphConnectivity, elabInputsOf, elaborateInterface, effectiveWidgetDefault,
  listCountAnswerKey, occurrenceDynamicView, solveOccurrenceTypes, valueKeyOf,
  type FormulaContext, type OccurrenceListCountEstimate, type SchemaResolver, type WorkflowDocument,
  type CommandInvocation,
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
