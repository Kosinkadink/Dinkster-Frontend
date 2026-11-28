import { BOARD_MAX_NAME, boardMediaKindOf, emptyBoard, t, type BoardCardSource, type BoardMediaItem, type CollectionEntry, type CollectionSource, type ExecutionRef } from '@dinkster/core'
import { BlueprintIcon, ProductBoard, ProductBoardResultBar, ProductErrorBanner } from '@dinkster/ui'
import { Images, Workflow } from 'lucide-solid'
import { createEffect, createMemo, createSignal, onCleanup, Show, type Accessor } from 'solid-js'
import { LIBRARY_SCOPE, type AppState, type Backend } from './app-state.js'
import type { BoardEntry } from './board-workspace.js'
import { CanvasCornerControls, type CanvasCornerMenu } from './CanvasChrome.js'
import { useSignal } from './solid-adapter.js'
import { ASSET_DRAG_TYPE, readAssetDrag } from './asset-browser/drag.js'
import { inspectBoardMedia } from './board-media.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton, ProductFileInput } from './ProductControls.js'
import { failureMessage } from './request-failure.js'
import { RequestFailure } from '@dinkster/client'
import { ProductActionFooter } from './ProductForm.js'
import { UploadDestination } from './UploadDestination.js'
import { activeProjectId } from './projects.js'
import { readUploadDestination, saveUploadDestination, type UploadDestinationChoice } from './upload-destination.js'
import { CollectionPanel } from './CollectionPanel.js'
import { boardBlueprintsSource, boardContinuationSources, workflowsSource } from './collections.js'
import { BoardCard, boardCardStatusLabel } from './BoardCard.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { executionProgress } from './ExecutionActivityCard.js'

type Continuation = NonNullable<Parameters<AppState['boards']['placeCard']>[4]>

function BoardResultActions(props: {
  app: AppState; entry: BoardEntry; item: Accessor<BoardMediaItem>
  select: (id: string) => void; remove: () => void; actionsRef: (open: () => void) => void
  choose: (kind: 'workflow' | 'blueprint', point: { x: number; y: number },
    continuation: { value: Continuation; source: CollectionSource; current: () => boolean }) => Promise<string | undefined>
  onError: (message: string) => void
}) {
  const backends = useSignal(props.app.backends)
  const tick = useSignal(props.app.backendsTick)
  const executions = useSignal(props.app.store.executions)
  const board = useSignal(props.entry.session.document)
  const backend = () => backends().find((backend) => backend.baseUrl === props.entry.baseUrl && backend.protocol === 'dinkster')
  const [loaded, setLoaded] = createSignal<{
    continuation: Continuation; sources: Awaited<ReturnType<typeof boardContinuationSources>>
    current: () => boolean
  }>()
  const [openRef, setOpenRef] = createSignal<ExecutionRef>()
  let live = true
  let placing = false
  onCleanup(() => { live = false })
  createEffect(() => {
    const owner = backend()
    const item = props.item()
    tick()
    const registry = owner?.registry.get()
    const snapshot = board()
    const project = activeProjectId()
    let wanted = true
    onCleanup(() => { wanted = false })
    setLoaded(undefined)
    if (owner?.protocol !== 'dinkster' || !registry) return
    const current = () => live && wanted && props.entry.session.doc === snapshot &&
      props.entry.session.doc.items[item.id] === item && activeProjectId() === project &&
      props.app.backends.get().includes(owner) && owner.registry.get() === registry
    void (async () => {
      const asset = await props.app.boards.resolveMediaAsset(props.entry.id, item.id, current)
      if (!asset || !current()) return
      const sources = await boardContinuationSources(props.app, props.entry, project, asset, current)
      if (!current()) return
      setLoaded({ continuation: { itemId: item.id, asset, resolve: registry.resolve }, sources, current })
      if (sources.errors.length) props.onError(sources.errors.join('; '))
    })().catch((reason) => { if (current()) props.onError(String(reason instanceof Error ? reason.message : reason)) })
  })
  createEffect(() => {
    const owner = backend()
    const item = props.item()
    const job = item.asset.origin?.['job']
    const run = job === undefined ? undefined : board().runs?.[job]
    executions(); tick()
    setOpenRef(undefined)
    if (owner?.protocol !== 'dinkster' || !job || !run) return
    const existing = [...props.app.store.executions.get().values()].find((state) =>
      state.ref.connection === owner.id && state.jobRef === job && state.artifact)
    if (existing) { setOpenRef(existing.ref); return }
    let wanted = true
    onCleanup(() => { wanted = false })
    const current = () => live && wanted && props.app.backends.get().includes(owner) &&
      props.entry.session.doc.items[item.id] === item
    void owner.connection.getHistoryRun(job, LIBRARY_SCOPE).then(async (record) => {
      if (!record || !current()) return
      const ref = await props.app.restoreBoardCardRun(props.entry, run.card, record, current)
      if (current()) setOpenRef(ref)
    }).catch(() => { /* An unavailable producing workflow has no action. */ })
  })
  const place = async (selected: CollectionEntry | 'workflow' | 'blueprint') => {
    const request = loaded()
    const owner = backend()
    if (!request || !request.current() || placing || owner?.protocol !== 'dinkster') return
    placing = true
    try {
      const point = props.item().rect
      const id = typeof selected === 'string'
        ? await props.choose(selected, point, { value: request.continuation, current: request.current,
          source: selected === 'workflow' ? request.sources.workflows : request.sources.blueprints })
        : await props.app.boards.placeCard(props.entry.id, {
          project: activeProjectId(), baseUrl: owner.baseUrl, kind: selected.kind as 'workflow' | 'blueprint',
          source: selected.ref as BoardCardSource, name: selected.title,
        }, point, request.current, request.continuation)
      if (live && id && props.entry.session.doc.items[id]) props.select(id)
    } catch (reason) {
      if (live) props.onError(reason instanceof Error ? reason.message : String(reason))
    } finally { placing = false }
  }
  return <ProductBoardResultBar onRemove={props.remove} actionsRef={props.actionsRef}
    onOpenWorkflow={openRef() ? () => void props.app.openExecutionView(openRef()!) : undefined}
    continuation={loaded() ? {
      kind: props.item().kind,
      recent: loaded()!.sources.recent.map((entry) => ({ label: entry.title,
        icon: entry.kind === 'blueprint' ? BlueprintIcon : Workflow, onSelect: () => void place(entry) })),
      onChooseWorkflow: () => void place('workflow'),
      onChooseBlueprint: () => void place('blueprint'),
    } : undefined} />
}

function BoardPage(props: { app: AppState; entry: BoardEntry; saveError: string | undefined; clearSaveError: () => void }) {
  const [menu, setMenu] = createSignal<CanvasCornerMenu>()
  const [error, setError] = createSignal<string>()
  const resultErrors = useSignal(props.app.boardResultErrors)
  const clearError = () => {
    setError(undefined)
    props.clearSaveError()
    const errors = new Map(props.app.boardResultErrors.get())
    errors.delete(props.entry)
    props.app.boardResultErrors.set(errors)
  }
  const backends = useSignal(props.app.backends)
  const boardBackend = () => backends().find((backend) => backend.baseUrl === props.entry.baseUrl && backend.protocol === 'dinkster')
  const executions = useSignal(props.app.store.executions)
  const submissions = useSignal(props.app.boardCardSubmissions)
  const changed = useSignal(props.app.boards.changed)
  const pendingRuns = createMemo(() => {
    executions(); changed(); backends()
    return Object.values(props.entry.session.doc.items).flatMap((card) => {
      if (card.kind !== 'workflow' && card.kind !== 'blueprint') return []
      const active = props.app.executionsForBoardCard(props.entry, card.id)
        .filter((run) => run.status === 'queued' || run.status === 'running')
      const preparing = submissions().get(props.app.boardCardKey(props.entry, card.id))
      if (active.length) return active.map((run) => {
        const progress = executionProgress(run)?.value
        return { job: run.jobRef ?? run.key, card: card.id, places: props.app.boardResultPlaces(props.entry, run),
          label: boardCardStatusLabel(!!preparing, run), running: !preparing && run.status === 'running',
          ...(progress === undefined ? {} : { progress }) }
      })
      return preparing?.places ? [{ job: props.app.boardCardKey(props.entry, card.id), card: card.id,
        places: preparing.places, label: boardCardStatusLabel(true), running: false }] : []
    })
  })
  let live = true
  let drop = 0
  let input!: HTMLInputElement
  let pickerPoint = { x: 0, y: 0 }
  let importAbort: AbortController | undefined
  const [busy, setBusy] = createSignal(false)
  const [picking, setPicking] = createSignal<{
    entry: BoardEntry; backend: Extract<Backend, { protocol: 'dinkster' }>; project: string
    kind: 'workflow' | 'blueprint'
    point: { x: number; y: number }; source: CollectionSource; finish: (id?: string) => void
    continuation?: Continuation
    stillWanted?: () => boolean
  }>()
  const [placing, setPlacing] = createSignal(false)
  const cancelPicker = () => {
    const request = picking()
    setPicking(undefined)
    setPlacing(false)
    request?.finish()
  }
  const chooseCard = (kind: 'workflow' | 'blueprint', point: { x: number; y: number },
    continuation?: { value: Continuation; source: CollectionSource; current: () => boolean },
  ): Promise<string | undefined> => {
    cancelPicker()
    const backend = boardBackend()
    if (!backend || backend.protocol !== 'dinkster') return Promise.resolve(undefined)
    const project = activeProjectId()
    const owner = () => props.app.backends.get().includes(backend) ? backend : undefined
    return new Promise((finish) => setPicking({
      entry: props.entry, backend, project, kind, point: { ...point }, finish,
      source: continuation?.source ?? (kind === 'workflow' ? workflowsSource(props.app, owner, project) : boardBlueprintsSource(owner, project)),
      ...(continuation === undefined ? {} : { continuation: continuation.value, stillWanted: continuation.current }),
    }))
  }
  const pickCard = async (selected: CollectionEntry) => {
    const request = picking()
    if (!request || placing() || selected.owner !== request.backend.id) return
    const owned = () => live && picking() === request && props.entry === request.entry &&
      props.app.activeTabId.get() === `page:board:${request.entry.id}` && activeProjectId() === request.project &&
      props.app.backends.get().includes(request.backend)
    const current = () => owned() && (request.stillWanted?.() ?? true)
    setPlacing(true)
    try {
      const id = await props.app.boards.placeCard(request.entry.id, {
        project: request.project, baseUrl: request.backend.baseUrl, kind: request.kind,
        source: request.kind === 'workflow' ? { kind: 'library', recordId: selected.id } : selected.ref as BoardCardSource,
        name: selected.title,
      }, request.point, current, request.continuation)
      if (!owned()) return
      clearError()
      setPicking(undefined)
      request.finish(id)
    } catch (reason) {
      if (owned()) {
        setError(reason instanceof Error ? reason.message : String(reason))
        cancelPicker()
      }
    } finally {
      if (picking() === request) setPlacing(false)
    }
  }
  const activeTabId = useSignal(props.app.activeTabId)
  createEffect(() => {
    const request = picking()
    if (request && (request.entry !== props.entry || activeTabId() !== `page:board:${request.entry.id}` ||
      !backends().includes(request.backend))) cancelPicker()
  })
  const openWorkflow = async (recordId: string, exposure: boolean) => {
    const backend = boardBackend()
    if (!backend) return
    if (await props.app.openFromLibrary(recordId, backend.id) && exposure) {
      const tab = props.app.activeTab()
      if (tab) props.app.setLens(tab.id, 'exposure')
    }
  }
  const [destination, setDestination] = createSignal<UploadDestinationChoice>({ remember: false })
  const [importing, setImporting] = createSignal<{
    files: readonly File[]; point: { x: number; y: number }; entry: BoardEntry; backend: Backend; project: string
  }>()
  const cancelImport = () => {
    importAbort?.abort()
    importAbort = undefined
    setImporting(undefined)
    setBusy(false)
  }
  createEffect(() => {
    const entry = props.entry
    const request = importing()
    if (request && (request.entry !== entry || !backends().some((backend) =>
      backend.id === request.backend.id && backend.connection === request.backend.connection))) cancelImport()
  })
  const stageImport = (files: readonly File[], point: { x: number; y: number }) => {
    if (!files.length) return
    ++drop
    cancelImport()
    const backend = props.app.backends.get().find((candidate) => candidate.baseUrl === props.entry.baseUrl)
    if (!backend) { setError('This Board\'s backend is unavailable'); return }
    const unsupported = files.find((file) => !boardMediaKindOf(file.type))
    if (unsupported) { setError(`Unsupported Board media: ${unsupported.name}`); return }
    const project = activeProjectId()
    setDestination(readUploadDestination(String(backend.id), project))
    setImporting({ files: [...files], point: { ...point }, entry: props.entry, backend, project })
  }
  const confirmImport = async () => {
    const request = importing()
    if (!request || busy()) return
    const abort = new AbortController()
    importAbort = abort
    const choice = { ...destination() }
    const current = () => live && !abort.signal.aborted && props.entry === request.entry &&
      activeProjectId() === request.project && props.app.backends.get().some((backend) =>
        backend.id === request.backend.id && backend.connection === request.backend.connection)
    setBusy(true)
    try {
      const files = []
      for (const file of request.files) {
        abort.signal.throwIfAborted()
        files.push(await inspectBoardMedia(file, abort.signal))
        if (!current()) return
      }
      await props.app.boards.importMedia(request.entry.id, files, request.point, {
        ...(choice.mount ? { mount: choice.mount } : {}), ...(choice.folder ? { folder: choice.folder } : {}),
      }, abort.signal)
      if (!current()) return
      try { saveUploadDestination(String(request.backend.id), request.project, choice) } catch { /* Storage failure does not undo an import. */ }
      clearError()
      setImporting(undefined)
    } catch (reason) {
      if (current()) { setError(reason instanceof RequestFailure ? failureMessage(reason, 'Files could not be imported.') : reason instanceof Error ? reason.message : String(reason)); setImporting(undefined) }
    } finally {
      if (importAbort === abort) { importAbort = undefined; setBusy(false) }
    }
  }
  let corner: HTMLDivElement | undefined
  const dismiss = (event: PointerEvent | KeyboardEvent) => {
    if (event instanceof KeyboardEvent ? event.key === 'Escape' : !corner?.contains(event.target as Node))
      setMenu(undefined)
  }
  window.addEventListener('pointerdown', dismiss)
  window.addEventListener('keydown', dismiss)
  onCleanup(() => {
    live = false
    cancelPicker()
    cancelImport()
    window.removeEventListener('pointerdown', dismiss)
    window.removeEventListener('keydown', dismiss)
  })
  return <div class="board-page">
    <ProductFileInput ref={input} multiple accept="image/*,video/*,audio/*" data-testid="board-media-files"
      onChange={(event) => {
        stageImport([...event.currentTarget.files ?? []], pickerPoint)
        event.currentTarget.value = ''
      }} />
    <Show when={error() ?? resultErrors().get(props.entry) ?? props.saveError}>{(message) => <ProductErrorBanner onDismiss={clearError}>{message()}</ProductErrorBanner>}</Show>
    <div class="board-page-canvas"><ProductBoard
    fill
    store={props.entry.session}
    pendingRuns={pendingRuns()}
    result={(item, select, remove, actionsRef) => <BoardResultActions app={props.app} entry={props.entry}
      item={item} select={select} remove={remove} actionsRef={actionsRef} choose={chooseCard} onError={setError} />}
    onAddCard={boardBackend() ? {
      workflow: (point) => chooseCard('workflow', point), blueprint: (point) => chooseCard('blueprint', point),
    } : {}}
    card={(card, remove, inputPosition) => <BoardCard app={props.app} entry={props.entry} card={card()}
      onInputPosition={inputPosition}
      onOpen={card().source.kind === 'library' ? () => { const source = card().source; if (source.kind === 'library') void openWorkflow(source.recordId, false) } : undefined}
      onChooseInputs={card().source.kind === 'library' ? () => { const source = card().source; if (source.kind === 'library') void openWorkflow(source.recordId, true) } : undefined}
      onRemove={remove} />}
    onAddMedia={(point) => { pickerPoint = point; input.click() }}
    onDropMedia={(event, point) => {
      if (event.dataTransfer?.files.length) { stageImport([...event.dataTransfer.files], point); return }
      const text = event.dataTransfer?.getData(ASSET_DRAG_TYPE)
      if (!text) return
      const entry = props.entry
      const request = ++drop
      void (async () => {
        try {
          const { project, baseUrl, asset } = readAssetDrag(text)
          await props.app.boards.placeMedia(entry.id, { project, baseUrl, assets: [{
            digest: asset.digest, mediaType: asset.mediaType, name: asset.name.slice(0, BOARD_MAX_NAME),
          }] }, point)
          if (live && props.entry === entry && request === drop) clearError()
        } catch (reason) {
          if (live && props.entry === entry && request === drop)
            setError(reason instanceof RequestFailure ? failureMessage(reason, 'The file could not be placed.') : reason instanceof Error ? reason.message : String(reason))
        }
      })()
    }}
    assetUrl={(asset) => `${props.entry.baseUrl}/api/assets/${encodeURIComponent(asset.digest)}`}
    viewControls={(view) => <CanvasCornerControls
      ref={(element) => { corner = element }}
      size="small" minimapEnabled={false} minimapVisible={false} settings={{}}
      zoom={view.zoom} menu={menu()}
      onToggleMinimap={() => undefined} onToggleSetting={() => undefined}
      onOpenMenu={setMenu} onCloseMenu={() => setMenu(undefined)}
      onFit={view.onFit} onZoomBy={view.onZoomBy} onZoomTo={view.onZoomTo}
    />}
  /></div>
    <Show when={picking()} keyed>{(request) => <ModalSurface title={t(request.kind === 'workflow' ? 'board.chooseWorkflow' : 'board.chooseBlueprint')}
      modalId="board-card-picker" testId="board-card-picker" onRequestClose={cancelPicker}>
      <CollectionPanel sources={[request.source]} variant="select" defaultMode="list" searchPriority="primary"
        renderState={(state) => state.kind === 'empty' ? <ProductEmptyState
          title={t(request.kind === 'workflow' ? 'board.noWorkflows' : 'board.noBlueprints')} /> : undefined}
        pick={{ pickable: (entry) => entry.owner === request.backend.id,
          onPick: (entry) => void pickCard(entry) }} onEscape={cancelPicker} />
    </ModalSurface>}</Show>
    <Show when={importing()} keyed>{(request) => <ModalSurface
      title={t('board.import.title')} modalId="canvas-import" testId="board-import-dialog"
      onRequestClose={cancelImport} closeLabel={t('canvasImport.cancel')}>
      <div class="canvas-import-choice">
        <p>{t('canvasImport.description', { name: request.files.map((file) => file.name).join(', ') })}</p>
        <UploadDestination connection={request.backend.connection} machine={request.backend.label}
          value={destination()} disabled={busy()} onChange={setDestination} />
        <ProductActionFooter>
          <ProductButton type="button" variant="primary" data-testid="board-import-confirm" loading={busy()}
            onClick={() => void confirmImport()}>{t(busy() ? 'board.import.busy' : 'board.import.confirm')}</ProductButton>
          <ProductButton type="button" onClick={cancelImport}>{t('canvasImport.cancel')}</ProductButton>
        </ProductActionFooter>
      </div>
    </ModalSurface>}</Show>
  </div>
}

/** Register each Board identity once, over the same page host as other documents. */
export function installBoardPages(app: AppState): () => void {
  const registrations = new Map<string, () => void>()
  const [changed, setChanged] = createSignal(0)
  const unsubscribeChanged = app.boards.changed.subscribe((value) => setChanged(value))
  let open = new Set<string>()
  const pageId = (id: string) => `board:${id}`
  const enabled = () => app.settings.get<boolean>('features.board.enabled')
  const syncEntries = () => {
    const entries = app.boards.entries.get()
    for (const [id, unregister] of registrations) {
      if (entries.some((entry) => entry.id === id)) continue
      registrations.delete(id)
      unregister()
    }
    for (const entry of entries) {
      if (registrations.has(entry.id)) continue
      const [saveError, setSaveError] = createSignal<string>()
      registrations.set(entry.id, app.pages.register({
        id: pageId(entry.id),
        get title() { changed(); return app.boards.entries.get().find((candidate) => candidate.id === entry.id)?.title ?? t('board.title') },
        icon: Images, enabled,
        dirty: () => { changed(); return app.boards.isDirty(entry.id) },
        save: async () => {
          const owner = app.boards.entries.get().find((candidate) => candidate.id === entry.id)
          if (!owner) return
          try {
            await app.boards.save(entry.id)
            if (app.boards.entries.get().includes(owner)) setSaveError(undefined)
          } catch (reason) {
            if (app.boards.entries.get().includes(owner))
              setSaveError(reason instanceof RequestFailure ? failureMessage(reason, 'The board could not be saved.') : reason instanceof Error ? reason.message : String(reason))
          }
        },
        snapshot: () => app.boards.entries.get().find((candidate) => candidate.id === entry.id)?.session.doc,
        component: () => {
          const entries = useSignal(app.boards.entries)
          return <Show when={entries().find((candidate) => candidate.id === entry.id)}>
            {(current) => <BoardPage app={app} entry={current()} saveError={saveError()} clearSaveError={() => setSaveError(undefined)} />}
          </Show>
        },
      }))
    }
  }
  const unsubscribeEntries = app.boards.entries.subscribe(syncEntries)
  const unsubscribeTabs = app.pages.changed.subscribe((tabs) => {
    const next = new Set(tabs.map((tab) => tab.id))
    const closed = [...open].filter((id) => !next.has(`page:${pageId(id)}`))
    open = new Set([...registrations.keys()].filter((id) => next.has(`page:${pageId(id)}`)))
    for (const id of closed) app.boards.close(id)
  })
  let unregisterCommand: (() => void) | undefined
  const syncSetting = () => {
    if (enabled()) {
      if (unregisterCommand) return
      unregisterCommand = app.frontendDoors.command('board.new', {
        get label() { return t('command.board.new') },
        enabled: () => app.collabBackend() !== undefined,
        run: () => {
          const backend = app.collabBackend()
          if (!enabled() || !backend) return
          const entry = app.boards.open(emptyBoard(), undefined, backend.baseUrl)
          app.pages.open(pageId(entry.id))
        },
      })
    } else {
      unregisterCommand?.()
      unregisterCommand = undefined
    }
  }
  const unsubscribeSettings = app.settings.changed.subscribe(syncSetting)
  syncEntries()
  syncSetting()
  return () => {
    unsubscribeSettings()
    unsubscribeTabs()
    unsubscribeEntries()
    unsubscribeChanged()
    unregisterCommand?.()
    for (const unregister of registrations.values()) unregister()
    registrations.clear()
  }
}
