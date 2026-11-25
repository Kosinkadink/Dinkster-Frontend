import { asNodeId, companionSourcesOf, inputsOf, occurrencesForView } from '@dinkster/core'
import type { DinksterValuesClient, ValueQuery } from '@dinkster/client'
import type { AppState, Tab } from './app-state.js'
import { previewRuntimeMapping } from './app-view-rows.js'
import { liveExactnessFor } from './companion-display.js'

export interface VideoEditSource {
  readonly values: Pick<DinksterValuesClient, 'peek' | 'rendition'>
  readonly query: ValueQuery
}

/**
 * Resolve the input, never the edited node's output or an arbitrary adjacent
 * video. `strictRow` is the row the widget writes as its `strict_duration`
 * part; without one the editor offers no strict duration.
 */
export function videoEditContext(
  app: AppState, tab: Tab, graphId: string, nodeId: string, instancePath?: readonly string[], strictRow?: string,
): { readonly source?: VideoEditSource; readonly strictDuration?: boolean; readonly strictDisabledReason?: string; readonly sourceReason?: string } {
  const graph = tab.store.doc.graphs[graphId]
  const node = graph?.nodes[nodeId]
  const resolve = app.registryForTab(tab)?.resolve
  const schema = node && resolve?.(node.type)
  if (!graph || !node || !schema) return { sourceReason: 'Video node schema is unavailable.' }
  const inputs = inputsOf(schema)
  const sources = companionSourcesOf(graph, undefined, undefined, resolve)
  const strict = strictRow === undefined ? undefined
    : inputs.find((input) => input.id === strictRow && input.type.kind === 'concrete' && input.type.name === 'BOOLEAN')
  const strictState = strict === undefined ? {} : {
    strictDuration: (node.values[strict.id] ?? strict.widget?.default ?? false) === true,
    ...(sources.get(nodeId)?.has(strict.id) ? { strictDisabledReason: 'Strict duration is driven by a link.' } : {}),
  }
  const videos = inputs.filter((input) => input.type.kind === 'concrete' && input.type.name === 'VIDEO')
  const source = videos.length === 1 ? sources.get(nodeId)?.get(videos[0]!.id) : undefined
  if (source?.kind !== 'producer') return { ...strictState, sourceReason: 'Connect one VIDEO source and run it to enable lazy previews.' }
  const exec = app.executionForTab(tab)
  const backend = exec && app.backendFor(exec.ref.connection)
  if (!exec || exec.status === 'queued' || exec.status === 'running' || backend?.protocol !== 'dinkster') {
    return { ...strictState, sourceReason: 'A completed native execution is required for a lazy VIDEO preview.' }
  }
  const mapping = instancePath === undefined
    ? previewRuntimeMapping(tab.store.doc, exec, graphId)?.own(source.node) ?? []
    : occurrencesForView({
        instancePath: instancePath.map(asNodeId),
        runtimeIds: new Set([...Object.keys(exec.nodes), ...Object.keys(exec.outputs)]),
        toSource: exec.artifact?.provenance.toSource,
      }).own.get(asNodeId(source.node)) ?? []
  if (mapping.length !== 1) return { ...strictState, sourceReason: 'The source execution occurrence is unavailable or ambiguous.' }
  const runtimeId = mapping[0]!
  const current = app.compileTabCached(tab)
  if (!current?.ok || !exec.artifact || current.artifact.connection !== exec.ref.connection ||
      liveExactnessFor(current.artifact, exec.artifact)?.(runtimeId) !== true) {
    return { ...strictState, sourceReason: 'The source changed since execution. Run it again before previewing edits.' }
  }
  const outputId = exec.artifact.provenance.outputAliases?.[runtimeId]?.[source.output] ?? source.output
  return { ...strictState, source: { values: backend.connection.values(), query: { jobId: exec.ref.prompt, nodeId: runtimeId, outputId } } }
}
