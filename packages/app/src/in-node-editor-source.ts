import { asNodeId, companionSourcesOf, defaultValuesOf, occurrencesForView, type Json } from '@dinkster/core'
import type { DinksterValuesClient, ValueQuery } from '@dinkster/client'
import { isCurveValue } from '@dinkster/widgets'
import { viewInstancePath, type AppState, type Tab } from './app-state.js'
import { liveExactnessFor } from './companion-display.js'

export interface EditorInputAddress {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
}

/** A wired input's literal, or one exact runtime occurrence that can be read. */
export function editorInputSource(app: AppState, tab: Tab, at: EditorInputAddress, signal: AbortSignal):
  | { readonly kind: 'literal'; readonly value: Json }
  | { readonly kind: 'producer'; readonly values: DinksterValuesClient; readonly query: ValueQuery; readonly current: () => boolean }
  | undefined {
  const graph = tab.store.doc.graphs[at.graphId]
  const resolve = app.registryForTab(tab)?.resolve
  if (graph === undefined) return undefined
  const source = companionSourcesOf(graph, undefined, (nodeId, inputId) => {
    const node = graph.nodes[nodeId]
    const schema = node === undefined ? undefined : resolve?.(node.type)
    return schema === undefined ? undefined : (defaultValuesOf(schema) as Readonly<Record<string, Json>>)[inputId]
  }, resolve).get(at.nodeId)?.get(at.inputId)
  if (source?.kind === 'literal') return source
  if (source?.kind !== 'producer') return undefined
  const backend = app.backendForTab(tab)
  const execution = app.executionForTab(tab)
  const compiled = app.compileTabCached(tab)
  const path = viewInstancePath(tab)
  const depth = tab.graphStack.get().lastIndexOf(at.graphId)
  if (backend.protocol !== 'dinkster' || execution?.status !== 'completed' || !execution.artifact || !compiled?.ok || !path || depth < 0
    || execution.ref.connection !== backend.id || compiled.artifact.connection !== backend.id
    || execution.artifact.snapshot.lineage !== tab.store.doc.lineage) return undefined
  const ids = occurrencesForView({ instancePath: path.slice(0, depth),
    runtimeIds: new Set([...Object.keys(execution.nodes), ...Object.keys(execution.outputs)]),
    toSource: execution.artifact.provenance.toSource }).own.get(asNodeId(source.node)) ?? []
  const runtimeId = ids.length === 1 ? ids[0] : undefined
  if (!runtimeId || liveExactnessFor(compiled.artifact, execution.artifact)?.(runtimeId) !== true) return undefined
  const values = backend.connection.values()
  const revision = tab.store.revision
  const current = () => !signal.aborted && tab.store.revision === revision
    && app.backendForTab(tab).connection === backend.connection && backend.connection.values() === values
    && app.executionForTab(tab)?.key === execution.key
    && viewInstancePath(tab)?.length === path.length && viewInstancePath(tab)?.every((id, index) => id === path[index]) === true
  return { kind: 'producer', values, current, query: { jobId: execution.ref.prompt, nodeId: runtimeId,
    outputId: execution.artifact.provenance.outputAliases?.[runtimeId]?.[source.output] ?? source.output } }
}

/** Structured CURVE outputs have a bounded rendition, not an inline scalar summary. */
export async function readEditorCurve(app: AppState, tab: Tab, at: EditorInputAddress, signal: AbortSignal): Promise<Json | undefined> {
  const source = editorInputSource(app, tab, at, signal)
  if (source?.kind === 'literal') return isCurveValue(source.value) ? source.value : undefined
  if (source === undefined) return undefined
  const { values, query, current } = source
  const peek = await values.peek(query, { signal })
  if (!current() || !peek.available || peek.descriptor.typeId !== 'CURVE') return undefined
  const info = peek.renditions.find((entry) => entry.kind === 'curve-points' && entry.mime === 'application/json')
  if (!info) return undefined
  return values.read(query, peek.descriptor, async () => {
    const result = await values.rendition(query, info.kind, { signal, descriptor: peek.descriptor,
      ...(info.version === undefined ? {} : { rendererVersion: info.version }) })
    if (!current() || !result.available || result.mime !== info.mime || result.fingerprint !== peek.descriptor.fingerprint
      || result.bytes.byteLength > 1024 * 1024) return undefined
    const value: unknown = JSON.parse(new TextDecoder().decode(result.bytes))
    return isCurveValue(value) ? value as unknown as Json : undefined
  })
}
