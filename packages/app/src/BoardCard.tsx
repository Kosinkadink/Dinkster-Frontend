import { documentResolver, exposedKey, jsonSameValue, semanticDesignTokens, t, type BoardCardItem, type ControllerMode, type Json, type WorkflowDocument } from '@dinkster/core'
import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import { CanvasSeedModeIcon, ProductBoardCard, ProductButton } from '@dinkster/ui'
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Dice5, Lock, Minus, Plus } from 'lucide-solid'
import { LIBRARY_SCOPE, type AppState, type Backend } from './app-state.js'
import { ExposedParameterInput, ExposedParameterRow, isBooleanParameter } from './AppView.js'
import { ControllerModeMenu } from './ControllerModeMenu.js'
import { executionStatusLabel } from './ExecutionActivityCard.js'
import { Icon } from './Icon.js'
import { buildParamRows, comboOptions, fetchRemoteComboOptions, type ParamRow } from './app-view-rows.js'
import { applyCardInputs, type BoardEntry } from './board-workspace.js'
import { ProductNotice } from './ProductForm.js'
import { ProductSelect } from './ProductSelect.js'
import { useSignal } from './solid-adapter.js'
import { widgetCommitError } from './widget-commit.js'
import type { ExecutionState, HistoryRunRecord } from '@dinkster/client'

type LiveRow = Extract<ParamRow, { kind: 'live' }>

export const boardCardStatusLabel = (preparing: boolean, run?: ExecutionState): string =>
  preparing ? 'Preparing' : run ? executionStatusLabel(run.status) : 'Not run'

function BoardCardInput(props: {
  readonly row: LiveRow
  readonly backend: Backend
  readonly app: AppState
  readonly commit: (row: LiveRow, value: Json) => boolean
  readonly onMode: (row: LiveRow, mode: ControllerMode) => boolean
}) {
  const labelId = `board-input-${createUniqueId()}`
  const [error, setError] = createSignal<string>()
  const [modeOpen, setModeOpen] = createSignal(false)
  const mode = () => props.row.node.controllers?.[props.row.valueKey] ?? props.row.spec?.controllerInitial ?? 'randomize'
  let modeButton!: HTMLButtonElement
  let menu!: HTMLDivElement
  const closeMode = (focus = false) => {
    setModeOpen(false)
    if (focus) modeButton.focus()
  }
  createEffect(() => {
    if (!modeOpen()) return
    const place = () => {
      if (!modeOpen() || !menu) return
      const placement = placeFloatingSurface({
        surface: { width: menu.offsetWidth, height: menu.scrollHeight }, anchor: modeButton.getBoundingClientRect(),
        bounds: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, direction: 'block',
        margin: semanticDesignTokens.space[4], gap: semanticDesignTokens.space[4],
      })
      menu.style.left = `${placement.left}px`
      menu.style.top = `${placement.top}px`
      menu.style.maxHeight = `${placement.maxHeight}px`
    }
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !modeButton.contains(event.target as Node)) closeMode()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMode(true) }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[index]?.focus()
      } else if (event.key === 'Tab') closeMode()
    }
    queueMicrotask(() => {
      if (!modeOpen()) return
      place()
      menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    })
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', keydown)
    window.addEventListener('resize', place)
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', place)
    })
  })
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
  const input = () => <ExposedParameterInput row={props.row} labelId={labelId} draftScopeId={labelId} onCommit={commit}
    onError={setError} onDraftActive={() => undefined}
    combo={<ProductSelect class="app-view-control" ariaLabelledBy={labelId} selectedId={selected() < 0 ? 'stored' : String(selected())}
      options={[
        ...(selected() < 0 ? [{ id: 'stored', label: String(props.row.value ?? ''), value: props.row.value ?? null, disabled: true }] : []),
        ...options().map((option, index) => ({ id: String(index), ...option })),
      ]} onFocus={loadOptions} onPointerDown={loadOptions}
      onSelectAsync={(option, current) => commit(option.value, current)} />} />
  return <ExposedParameterRow head={<>
      <Show when={isBooleanParameter(props.row)}>{input()}</Show>
      <span id={labelId} class="app-view-label">{props.row.label}</span>
      <Show when={props.row.spec?.controller === 'after_generate'}>
        <span class="dinkster-board-controller"><ProductButton ref={(element) => { modeButton = element }} fill="quiet"
          aria-label={`After run for ${props.row.label}`} aria-haspopup="menu" aria-expanded={modeOpen()}
          onClick={() => setModeOpen((open) => !open)}>
          <Show when={['INT', 'FLOAT'].includes(props.row.spec!.widgetType)}
            fallback={<Icon icon={{ fixed: Lock, increment: Plus, decrement: Minus, randomize: Dice5 }[mode()]} />}>
            <CanvasSeedModeIcon mode={mode()} />
          </Show>
        </ProductButton></span>
        <Show when={modeOpen()}><Portal><div class="dinkster-root dinkster-board-controller-layer"
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <ControllerModeMenu ref={(element) => { menu = element }} mode={mode()} trigger="after_generate"
            onMode={(next) => { if (props.onMode(props.row, next)) closeMode(true) }} />
        </div></Portal></Show>
      </Show>
    </>}>
    <Show when={!isBooleanParameter(props.row)}>{input()}</Show>
    <Show when={error()}>{(message) => <ProductNotice tone="error">{message()}</ProductNotice>}</Show>
  </ExposedParameterRow>
}

export function BoardCard(props: {
  readonly app: AppState
  readonly entry: BoardEntry
  readonly card: BoardCardItem
  readonly onOpen?: (() => void) | undefined
  readonly onChooseInputs?: (() => void) | undefined
  readonly onRemove: () => void
}) {
  const backends = useSignal(props.app.backends)
  const tick = useSignal(props.app.backendsTick)
  const backend = () => backends().find((backend) => backend.baseUrl === props.entry.baseUrl && backend.protocol === 'dinkster')
  const registry = createMemo(() => { tick(); return backend()?.registry.get() })
  const identity = createMemo(() => JSON.stringify([props.entry.id, props.card.id, props.card.kind, props.card.source]))
  const [source, setSource] = createSignal<WorkflowDocument>()
  const [error, setError] = createSignal<string>()
  const executions = useSignal(props.app.store.executions)
  const submissions = useSignal(props.app.boardCardSubmissions)
  const runs = createMemo(() => { executions(); return props.app.executionsForBoardCard(props.entry, props.card.id) })
  const latest = () => runs()[0]
  const board = useSignal(props.entry.session.document)
  const recordedJobs = createMemo(() => JSON.stringify(Object.entries(board().runs ?? {})
    .filter(([, run]) => run.card === props.card.id).map(([job]) => job).sort()))
  const [recorded, setRecorded] = createSignal<HistoryRunRecord>()
  createEffect(on([recordedJobs, backend, tick], ([jobs, owner]) => {
    setRecorded(undefined)
    const ids = JSON.parse(jobs) as string[]
    if (!ids.length || owner?.protocol !== 'dinkster') return
    let current = true
    const unsubscribe = owner.connection.status.subscribe(() => {
      current = false
      setRecorded(undefined)
    })
    onCleanup(() => { current = false; unsubscribe() })
    void Promise.all(ids.map((id) => owner.connection.getHistoryRun(id, LIBRARY_SCOPE)))
      .then((records) => {
        if (!current || !props.app.backends.get().includes(owner) || !props.app.boards.entries.get().includes(props.entry)) return
        // A missing record may be newer than every readable one; never substitute an older status.
        if (records.some((record, index) => record === undefined || record.scope !== LIBRARY_SCOPE ||
          (record.jobRef ?? record.runId) !== ids[index])) return
        setRecorded((records as HistoryRunRecord[]).sort((a, b) =>
          b.submittedAt - a.submittedAt || b.finishedAt - a.finishedAt || b.runId.localeCompare(a.runId))[0])
      }).catch(() => { /* Unreadable history leaves the reserved status empty. */ })
  }))
  const pending = () => submissions().has(props.app.boardCardKey(props.entry, props.card.id))
  const running = () => pending() || runs().some((run) => run.status === 'queued' || run.status === 'running')
  const status = () => {
    if (pending() || latest()?.status === 'queued' || latest()?.status === 'running')
      return boardCardStatusLabel(pending(), latest())
    if (recordedJobs() === '[]') return boardCardStatusLabel(false, latest())
    const run = recorded()
    return run === undefined ? '' : executionStatusLabel(run.state === 'failed' ? 'error' : run.state)
  }
  const openable = () => {
    const run = latest()
    return run?.artifact && recorded() && run.jobRef === (recorded()!.jobRef ?? recorded()!.runId) ? run : undefined
  }
  let live = true
  onCleanup(() => { live = false })
  const run = async () => {
    setError(undefined)
    try { await props.app.queueBoardCard(props.entry, props.card.id) }
    catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  createEffect(on([identity, registry, backend, tick], ([, schemas]) => {
    setSource(undefined)
    setError(undefined)
    if (!schemas) return
    let live = true
    onCleanup(() => { live = false })
    void props.app.boards.loadCardSource(props.entry.id, props.card.id, schemas.resolve, () => live)
      .then((document) => {
        if (!live) return
        props.app.boards.resolveCardInputs(props.entry.id, props.card.id, document, schemas.resolve)
        setSource(document)
      })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)) })
  }))
  const projection = createMemo(() => {
    const document = source()
    const schemas = registry()
    if (!document || !schemas) return { rows: [] as readonly ParamRow[] }
    try {
      const snapshot = applyCardInputs(document, props.card.values, schemas.resolve, props.card.controllers)
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
  const chooseMode = (row: LiveRow, mode: ControllerMode): boolean => {
    const latest = rows().get(exposedKey(row.entry))
    if (!latest || latest.kind !== 'live' || !editable(latest) || latest.spec?.controller !== 'after_generate' ||
      !backend() || !props.app.boards.entries.get().includes(props.entry)) return false
    if ((latest.node.controllers?.[latest.valueKey] ?? latest.spec.controllerInitial ?? 'randomize') === mode) return true
    const result = props.entry.session.dispatch({ command: 'board.card.controller', params: {
      id: props.card.id, key: exposedKey(latest.entry), mode,
    } })
    if (!result.ok) setError(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    return result.ok
  }
  return <ProductBoardCard name={props.card.name} kind={props.card.kind}
    lastRun={status()}
    running={running()} disabled={!source() || !registry() || !!projection().error}
    error={error() ?? projection().error ?? latest()?.errors[0]?.message}
    onRun={() => void run()} onStop={() => void props.app.stopBoardCard(props.entry, props.card.id)}
    onOpenLastRun={openable() ? () => void props.app.openExecutionView(openable()!.ref) : undefined}
    onContentHeight={(height) => {
      if (source() && !projection().error && props.card.autoSize === true)
        props.entry.session.dispatch({ command: 'board.card.fit', params: { id: props.card.id, height } })
    }}
    onOpen={props.onOpen} onChooseInputs={props.onChooseInputs} onRemove={props.onRemove}>
    <For each={[...rows().keys()]}>{(key) => {
      const row = () => rows().get(key)!
      return <Show when={row().kind === 'live'} fallback={<p class="dinkster-board-card-error" role="status">{(row() as Extract<ParamRow, { kind: 'stale' }>).reason}</p>}>
        <Show when={editable(row() as LiveRow)} fallback={<ExposedParameterRow head={<span class="app-view-label">{(row() as LiveRow).label}</span>}>
          <p class="app-view-readonly" title={t((row() as LiveRow).linked ? 'appView.readOnly.linked' : (row() as LiveRow).derived ? 'appView.readOnly.derived' : 'appView.readOnly.unsupported')}>
            {typeof (row() as LiveRow).value === 'string' ? (row() as LiveRow).value as string : JSON.stringify((row() as LiveRow).value) ?? t('appView.value.unset')}
          </p>
        </ExposedParameterRow>}>
          <BoardCardInput app={props.app} backend={backend()!} row={row() as LiveRow} commit={commit} onMode={chooseMode} />
        </Show>
      </Show>
    }}</For>
  </ProductBoardCard>
}
