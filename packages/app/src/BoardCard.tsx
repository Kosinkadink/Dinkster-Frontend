import { documentResolver, exposedKey, jsonSameValue, t, type BoardCardItem, type Json, type WorkflowDocument } from '@dinkster/core'
import { ProductBoardCard } from '@dinkster/ui'
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup } from 'solid-js'
import type { AppState, Backend } from './app-state.js'
import { ExposedParameterInput } from './AppView.js'
import { buildParamRows, comboOptions, fetchRemoteComboOptions, type ParamRow } from './app-view-rows.js'
import { applyCardInputs, type BoardEntry } from './board-workspace.js'
import { ProductNotice } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { useSignal } from './solid-adapter.js'
import { widgetCommitError } from './widget-commit.js'

type LiveRow = Extract<ParamRow, { kind: 'live' }>

function BoardCardInput(props: {
  readonly row: LiveRow
  readonly backend: Backend
  readonly app: AppState
  readonly commit: (row: LiveRow, value: Json) => boolean
}) {
  const labelId = `board-input-${createUniqueId()}`
  const [error, setError] = createSignal<string>()
  const [remote, setRemote] = createSignal<readonly { value: Json; label: string }[]>()
  let abort: AbortController | undefined
  let live = true
  onCleanup(() => { live = false; abort?.abort() })
  const commit = async (value: Json, stillWanted: () => boolean = () => true): Promise<boolean> => {
    if (!live || !stillWanted()) return false
    const spec = props.row.spec!
    const problem = widgetCommitError(props.app.widgetRegistry.kind(spec.widgetType), value, spec)
    setError(problem)
    return problem === undefined && props.commit(props.row, value)
  }
  const loadOptions = () => {
    const spec = props.row.spec?.remote
    if (!spec) return
    abort?.abort()
    const request = new AbortController()
    abort = request
    const client = props.backend.scopedClient
    const authority = client.remoteChoiceAuthority()
    void fetchRemoteComboOptions(spec.route, (route, options) => client.remoteChoices(route, options), request.signal, spec)
      .then((options) => {
        if (live && !request.signal.aborted && client.remoteChoiceAuthority() === authority) { setRemote(options); setError(undefined) }
      }).catch((reason) => {
        if (live && !request.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
  }
  const options = () => remote() ?? comboOptions(props.row.spec!)
  const selected = () => options().findIndex((option) => jsonSameValue(option.value, props.row.value))
  return <>
    <div class="dinkster-board-card-input">
      <span id={labelId}>{props.row.label}</span>
      <ExposedParameterInput row={props.row} labelId={labelId} draftScopeId={labelId} onCommit={commit}
        onError={setError} onDraftActive={() => undefined}
        combo={<ProductSelect ariaLabelledBy={labelId} selectedId={selected() < 0 ? 'stored' : String(selected())}
            options={[
              ...(selected() < 0 ? [{ id: 'stored', label: String(props.row.value ?? ''), value: props.row.value ?? null, disabled: true }] : []),
              ...options().map((option, index) => ({ id: String(index), ...option })),
            ]} onFocus={loadOptions} onPointerDown={loadOptions}
            onSelectAsync={(option, current) => commit(option.value, current)} />} />
    </div>
    <Show when={error()}>{(message) => <ProductNotice tone="error">{message()}</ProductNotice>}</Show>
  </>
}

export function BoardCard(props: {
  readonly app: AppState
  readonly entry: BoardEntry
  readonly card: BoardCardItem
  readonly onOpen: () => void
  readonly onChooseInputs: () => void
  readonly onRemove: () => void
}) {
  const backends = useSignal(props.app.backends)
  const tick = useSignal(props.app.backendsTick)
  const backend = () => backends().find((backend) => backend.baseUrl === props.entry.baseUrl && backend.protocol === 'dinkster')
  const registry = createMemo(() => { tick(); return backend()?.registry.get() })
  const identity = createMemo(() => JSON.stringify([props.entry.id, props.card.id, props.card.kind, props.card.source]))
  const [source, setSource] = createSignal<WorkflowDocument>()
  const [error, setError] = createSignal<string>()
  createEffect(on([identity, registry, backend], ([, schemas]) => {
    setSource(undefined)
    setError(undefined)
    if (!schemas) return
    let live = true
    onCleanup(() => { live = false })
    void props.app.boards.loadCardSource(props.entry.id, props.card.id, schemas.resolve, () => live)
      .then((document) => { if (live) setSource(document) })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
  }))
  const projection = createMemo(() => {
    const document = source()
    const schemas = registry()
    if (!document || !schemas) return { rows: [] as readonly ParamRow[] }
    try {
      const snapshot = applyCardInputs(document, props.card.values, schemas.resolve)
      return { rows: buildParamRows(snapshot, documentResolver(snapshot, schemas.resolve)) }
    } catch (reason) {
      return { rows: [] as readonly ParamRow[], error: reason instanceof Error ? reason.message : String(reason) }
    }
  })
  const rows = createMemo(() => new Map(projection().rows.map((row) => [exposedKey(row.entry), row])))
  const editable = (row: LiveRow) => !row.linked && !row.derived && row.spec !== undefined &&
    ['INT', 'FLOAT', 'STRING', 'LIST', 'BOOLEAN', 'COLOR', 'COMBO'].includes(row.spec.widgetType)
  const commit = (row: LiveRow, value: Json): boolean => {
    const latest = rows().get(exposedKey(row.entry))
    if (!latest || latest.kind !== 'live' || !editable(latest) || !backend() ||
      !props.app.boards.entries.get().includes(props.entry)) return false
    if (jsonSameValue(latest.value, value)) return true
    const result = props.entry.session.dispatch({ command: 'board.card.input', params: {
      id: props.card.id, input: latest.entry, value,
    } })
    if (!result.ok) setError(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return result.ok
  }
  return <ProductBoardCard name={props.card.name} kind={props.card.kind} lastRun="Not run" disabled
    error={error() ?? projection().error} onRun={() => undefined} onStop={() => undefined}
    onOpen={props.onOpen} onChooseInputs={props.onChooseInputs} onRemove={props.onRemove}>
    <For each={[...rows().keys()]}>{(key) => {
      const row = () => rows().get(key)!
      return <Show when={row().kind === 'live'} fallback={<p class="dinkster-board-card-error" role="status">{(row() as Extract<ParamRow, { kind: 'stale' }>).reason}</p>}>
        <Show when={editable(row() as LiveRow)} fallback={<div class="dinkster-board-card-input">
          <span>{(row() as LiveRow).label}</span><span title={t((row() as LiveRow).linked ? 'appView.readOnly.linked' : (row() as LiveRow).derived ? 'appView.readOnly.derived' : 'appView.readOnly.unsupported')}>
            {typeof (row() as LiveRow).value === 'string' ? (row() as LiveRow).value as string : JSON.stringify((row() as LiveRow).value) ?? t('appView.value.unset')}
          </span>
        </div>}>
          <BoardCardInput app={props.app} backend={backend()!} row={row() as LiveRow} commit={commit} />
        </Show>
      </Show>
    }}</For>
  </ProductBoardCard>
}
