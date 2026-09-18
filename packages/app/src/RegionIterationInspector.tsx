import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { DinksterValuesClient, ExecutionState, ValuePeekResult } from '@dinkster/client'
import type { Occurrence, WorkflowDocument } from '@dinkster/core'
import { useAppMessage } from './locale.js'
import { resolveNodeOccurrence } from './problem-display.js'
import { regionIterationInventory, regionValuePresentation, type RegionIteration, type RegionIterationNode } from './region-iteration.js'

export function RegionIterationInspector(props: {
  readonly execution: ExecutionState
  readonly regionOccurrence: Occurrence
  readonly document: WorkflowDocument
  readonly resolveSchema: (type: string) => { readonly displayName: string } | undefined
  readonly values: DinksterValuesClient | undefined
}) {
  const message = useAppMessage()
  const inventory = createMemo(() => regionIterationInventory(props.execution, props.regionOccurrence))
  const [iterationKey, setIterationKey] = createSignal('')
  const [runtimeId, setRuntimeId] = createSignal('')
  const [outputId, setOutputId] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [result, setResult] = createSignal(undefined as ValuePeekResult | undefined)
  const resultView = createMemo(() => {
    const current = result()
    return current === undefined ? undefined : regionValuePresentation(current)
  })

  const iteration = createMemo(() => {
    const list = inventory()?.iterations ?? []
    return list.find((entry) => entry.key === iterationKey()) ?? list[0]
  })
  const node = createMemo(() => {
    const list = iteration()?.nodes ?? []
    return list.find((entry) => entry.runtimeId === runtimeId())
      ?? list.find((entry) => entry.outputIds.length > 0)
      ?? list[0]
  })
  const selectedOutput = createMemo(() => {
    const list = node()?.outputIds ?? []
    return list.includes(outputId()) ? outputId() : list[0]
  })

  createEffect(() => {
    const selected = iteration()
    if (selected !== undefined && selected.key !== iterationKey()) setIterationKey(selected.key)
  })
  createEffect(() => {
    const selected = node()
    if (selected !== undefined && selected.runtimeId !== runtimeId()) setRuntimeId(selected.runtimeId)
  })
  createEffect(() => {
    const selected = selectedOutput()
    if (selected !== undefined && selected !== outputId()) setOutputId(selected)
  })

  createEffect(() => {
    const currentNode = node()
    const currentOutput = selectedOutput()
    const values = props.values
    setResult(undefined)
    if (currentNode === undefined || currentOutput === undefined || values === undefined) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    void values.peek({
      jobId: props.execution.ref.prompt,
      nodeId: currentNode.runtimeId,
      outputId: currentOutput,
    }, { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return
      setResult(next)
      setLoading(false)
    })
    onCleanup(() => controller.abort())
  })

  const nodeLabel = (entry: RegionIterationNode): string => {
    const resolved = resolveNodeOccurrence(props.document, entry.occurrence)
    const stored = resolved === undefined ? undefined : props.document.graphs[resolved.graphId]?.nodes[resolved.nodeId]
    return stored?.title ?? (stored === undefined ? undefined : props.resolveSchema(stored.type)?.displayName) ?? entry.runtimeId
  }
  const iterationLabel = (entry: RegionIteration): string => entry.path
    .map((segment, index) => index === 0
      ? message('regionInspector.iteration', { index: segment.iteration + 1 })
      : message('regionInspector.nestedIteration', { region: segment.nodeId, index: segment.iteration + 1 }))
    .join(' / ')
  const observedCount = (): number => new Set(inventory()?.iterations.flatMap((entry) => {
    const root = entry.path[0]
    return root === undefined ? [] : [`${root.nodeId}\0${root.iteration}`]
  }) ?? []).size
  const iterationSummary = (current: NonNullable<ReturnType<typeof inventory>>): string => {
    const total = current.finishedIterations ?? current.expectedIterations
    return total === undefined || total === null
      ? message('regionInspector.observedUnknown', { observed: observedCount() })
      : message('regionInspector.observed', { observed: observedCount(), total })
  }
  const status = (): string => {
    const state = node()?.state
    return state === undefined ? '' : message(`regionInspector.state.${state}`)
  }

  return (
    <section class="region-iteration-inspector" data-testid="region-iteration-inspector">
      <h3>{message('regionInspector.title')}</h3>
      <Show when={inventory()} keyed>
        {(current) => (
          <>
            <p class="region-iteration-summary">{iterationSummary(current)}</p>
            <Show when={current.iterations.length > 0} fallback={<p class="empty">{message('regionInspector.empty')}</p>}>
              <label>
                <span>{message('regionInspector.iterationLabel')}</span>
                <select value={iteration()?.key} onChange={(event) => setIterationKey(event.currentTarget.value)}>
                  <For each={current.iterations}>{(entry) => <option value={entry.key}>{iterationLabel(entry)}</option>}</For>
                </select>
              </label>
              <label>
                <span>{message('regionInspector.nodeLabel')}</span>
                <select value={node()?.runtimeId} onChange={(event) => setRuntimeId(event.currentTarget.value)}>
                  <For each={iteration()?.nodes ?? []}>{(entry) => <option value={entry.runtimeId}>{nodeLabel(entry)}</option>}</For>
                </select>
              </label>
              <Show when={(node()?.outputIds.length ?? 0) > 0} fallback={<p class="empty">{message('regionInspector.noOutputs')}</p>}>
                <label>
                  <span>{message('regionInspector.outputLabel')}</span>
                  <select value={selectedOutput()} onChange={(event) => setOutputId(event.currentTarget.value)}>
                    <For each={node()?.outputIds ?? []}>{(entry) => <option value={entry}>{entry}</option>}</For>
                  </select>
                </label>
                <div class="region-iteration-identity">
                  <span class="region-iteration-provenance" data-provenance={node()?.state}>{status()}</span>
                  <Show when={node()?.progress !== undefined}>
                    <div class="region-iteration-progress">
                      <span>{message('regionInspector.progress', { percent: Math.round(node()!.progress! * 100) })}</span>
                      <progress max="1" value={node()!.progress} />
                    </div>
                  </Show>
                  <code>{node()?.runtimeId}</code>
                </div>
                <Show when={props.values !== undefined} fallback={<p class="empty">{message('regionInspector.ownerUnavailable')}</p>}>
                  <Show when={!loading()} fallback={<p role="status">{message('regionInspector.loading')}</p>}>
                    <Show when={resultView()} keyed>
                      {(value) => <Show when={value.available} fallback={
                        <div class="region-iteration-refusal" data-state="refused" role="status">
                          <strong>{value.reason}</strong>
                          <span>{value.error}</span>
                        </div>
                      }>
                        <dl class="region-iteration-value" data-state="available">
                          <dt>{message('regionInspector.type')}</dt><dd>{value.typeId}</dd>
                          <dt>{message('regionInspector.fingerprint')}</dt><dd><code>{value.fingerprint}</code></dd>
                          <Show when={value.value !== undefined}>
                            <dt>{message('regionInspector.value')}</dt><dd>{value.value}</dd>
                          </Show>
                        </dl>
                      </Show>}
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
