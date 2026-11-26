import { emptyBoard, t } from '@dinkster/core'
import { ProductBoard } from '@dinkster/ui'
import { Images } from 'lucide-solid'
import { createSignal, onCleanup, Show } from 'solid-js'
import type { AppState } from './app-state.js'
import type { BoardEntry } from './board-workspace.js'
import { CanvasCornerControls, type CanvasCornerMenu } from './CanvasChrome.js'
import { useSignal } from './solid-adapter.js'

function BoardPage(props: { entry: BoardEntry }) {
  const [menu, setMenu] = createSignal<CanvasCornerMenu>()
  let corner: HTMLDivElement | undefined
  const dismiss = (event: PointerEvent | KeyboardEvent) => {
    if (event instanceof KeyboardEvent ? event.key === 'Escape' : !corner?.contains(event.target as Node))
      setMenu(undefined)
  }
  window.addEventListener('pointerdown', dismiss)
  window.addEventListener('keydown', dismiss)
  onCleanup(() => {
    window.removeEventListener('pointerdown', dismiss)
    window.removeEventListener('keydown', dismiss)
  })
  return <ProductBoard
    fill
    store={props.entry.session}
    assetUrl={(asset) => `${props.entry.baseUrl}/api/assets/${encodeURIComponent(asset.digest)}`}
    viewControls={(view) => <CanvasCornerControls
      ref={(element) => { corner = element }}
      size="small" minimapEnabled={false} minimapVisible={false} settings={{}}
      zoom={view.zoom} menu={menu()}
      onToggleMinimap={() => undefined} onToggleSetting={() => undefined}
      onOpenMenu={setMenu} onCloseMenu={() => setMenu(undefined)}
      onFit={view.onFit} onZoomBy={view.onZoomBy} onZoomTo={view.onZoomTo}
    />}
  />
}

/** Register each Board identity once, over the same page host as other documents. */
export function installBoardPages(app: AppState): () => void {
  const registrations = new Map<string, () => void>()
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
      registrations.set(entry.id, app.pages.register({
        id: pageId(entry.id), title: entry.title, icon: Images, enabled,
        dirty: () => true,
        snapshot: () => app.boards.entries.get().find((candidate) => candidate.id === entry.id)?.session.doc,
        component: () => {
          const entries = useSignal(app.boards.entries)
          return <Show when={entries().find((candidate) => candidate.id === entry.id)}>
            {(current) => <BoardPage entry={current()} />}
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
    unregisterCommand?.()
    for (const unregister of registrations.values()) unregister()
    registrations.clear()
  }
}
