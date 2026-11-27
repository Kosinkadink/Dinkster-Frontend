import { BOARD_MAX_NAME, boardMediaKindOf, emptyBoard, t } from '@dinkster/core'
import { ProductBoard, ProductErrorBanner } from '@dinkster/ui'
import { Images } from 'lucide-solid'
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import type { AppState, Backend } from './app-state.js'
import type { BoardEntry } from './board-workspace.js'
import { CanvasCornerControls, type CanvasCornerMenu } from './CanvasChrome.js'
import { useSignal } from './solid-adapter.js'
import { ASSET_DRAG_TYPE, readAssetDrag } from './asset-browser/drag.js'
import { inspectBoardMedia } from './board-media.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton, ProductFileInput } from './ProductControls.js'
import { ProductActionFooter } from './ProductForm.js'
import { UploadDestination } from './UploadDestination.js'
import { activeProjectId } from './projects.js'
import { readUploadDestination, saveUploadDestination, type UploadDestinationChoice } from './upload-destination.js'

function BoardPage(props: { app: AppState; entry: BoardEntry; saveError: string | undefined; clearSaveError: () => void }) {
  const [menu, setMenu] = createSignal<CanvasCornerMenu>()
  const [error, setError] = createSignal<string>()
  const clearError = () => { setError(undefined); props.clearSaveError() }
  const backends = useSignal(props.app.backends)
  let live = true
  let drop = 0
  let input!: HTMLInputElement
  let pickerPoint = { x: 0, y: 0 }
  let importAbort: AbortController | undefined
  const [busy, setBusy] = createSignal(false)
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
      if (current()) { setError(reason instanceof Error ? reason.message : String(reason)); setImporting(undefined) }
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
    <Show when={error() ?? props.saveError}>{(message) => <ProductErrorBanner onDismiss={clearError}>{message()}</ProductErrorBanner>}</Show>
    <div class="board-page-canvas"><ProductBoard
    fill
    store={props.entry.session}
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
            setError(reason instanceof Error ? reason.message : String(reason))
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
        id: pageId(entry.id), title: entry.title, icon: Images, enabled,
        dirty: () => { changed(); return app.boards.isDirty(entry.id) },
        save: async () => {
          const owner = app.boards.entries.get().find((candidate) => candidate.id === entry.id)
          if (!owner) return
          try {
            await app.boards.save(entry.id)
            if (app.boards.entries.get().includes(owner)) setSaveError(undefined)
          } catch (reason) {
            if (app.boards.entries.get().includes(owner))
              setSaveError(reason instanceof Error ? reason.message : String(reason))
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
          const entry = app.boards.open(emptyBoard(), t('board.title'), backend.baseUrl)
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
