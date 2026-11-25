import { BoardStore, emptyBoard, type BoardAsset } from '@dinkster/core'
import { createSignal, onCleanup } from 'solid-js'
import {
  CanvasCornerControls,
  type CanvasCornerMenu,
} from '../../app/src/CanvasChrome.js'
import { ProductBoard, ProductSection } from '../src/index.js'

export function BoardGallery() {
  const [menu, setMenu] = createSignal<CanvasCornerMenu>()
  let corner: HTMLDivElement | undefined
  const dismiss = (event: PointerEvent | KeyboardEvent) => {
    if (
      event instanceof KeyboardEvent
        ? event.key === 'Escape'
        : !corner?.contains(event.target as Node)
    )
      setMenu(undefined)
  }
  window.addEventListener('pointerdown', dismiss)
  window.addEventListener('keydown', dismiss)
  onCleanup(() => {
    window.removeEventListener('pointerdown', dismiss)
    window.removeEventListener('keydown', dismiss)
  })
  const store = new BoardStore(emptyBoard())
  const asset = (name: string, mediaType = 'image/jpeg'): BoardAsset => ({
    digest: `blake3:${'0'.repeat(64)}`,
    mediaType,
    name,
  })
  store.dispatch({
    command: 'board.item.add',
    params: {
      items: [
        {
          id: 'section-1',
          kind: 'section',
          name: 'Round 1: establishing shot',
          rect: { x: 0, y: 0, width: 690, height: 360 },
        },
        {
          id: 'picture-1',
          kind: 'picture',
          asset: asset('Diner at night'),
          rect: { x: 24, y: 48, width: 310, height: 193.75 },
        },
        {
          id: 'picture-2',
          kind: 'picture',
          asset: asset('Mountain light'),
          rect: { x: 350, y: 48, width: 310, height: 193.75 },
        },
        {
          id: 'picture-3',
          kind: 'picture',
          asset: asset('Bookshop reference'),
          rect: { x: 24, y: 394, width: 280, height: 175 },
        },
        {
          id: 'video-1',
          kind: 'video',
          asset: asset('Rain on the window', 'video/webm'),
          rect: { x: 350, y: 394, width: 280, height: 175 },
        },
        {
          id: 'sound-1',
          kind: 'sound',
          asset: asset('Reference chimes', 'audio/wav'),
          rect: { x: 350, y: 594, width: 300, height: 80 },
        },
        {
          id: 'note-1',
          kind: 'note',
          text: 'Reference for the light. Keep the rain on the window; try a wider shot next.',
          rect: { x: 24, y: 584, width: 280, height: 80 },
        },
      ],
    },
  })
  const url = (value: BoardAsset) => {
    if (value.mediaType === 'video/webm') return '/board/window.webm'
    if (value.mediaType === 'audio/wav') return '/board/chimes.wav'
    return `/templates/${value.name === 'Diner at night' ? 'diner' : value.name === 'Mountain light' ? 'valley' : 'bookshop'}.jpg`
  }
  return (
    <ProductSection title="Board">
      <p class="dinkster-metadata">
        A document surface with no grid. Drag items to move them. Select a
        picture to resize it. Add a note or section, then click the board.
        Delete removes the selection; Undo and Redo restore edits.
      </p>
      <ProductBoard
        store={store}
        assetUrl={url}
        viewControls={(view) => (
          <CanvasCornerControls
            ref={(element) => {
              corner = element
            }}
            size="small"
            minimapEnabled={false}
            minimapVisible={false}
            settings={{}}
            zoom={view.zoom}
            menu={menu()}
            onToggleMinimap={() => undefined}
            onToggleSetting={() => undefined}
            onOpenMenu={setMenu}
            onCloseMenu={() => setMenu(undefined)}
            onFit={view.onFit}
            onZoomBy={view.onZoomBy}
            onZoomTo={view.onZoomTo}
          />
        )}
        onAddMedia={() =>
          store.dispatch({
            command: 'board.item.add',
            params: {
              items: [
                {
                  kind: 'picture',
                  asset: asset('Bookshop reference'),
                  rect: { x: 240, y: 140, width: 280, height: 175 },
                },
              ],
            },
          })
        }
      />
    </ProductSection>
  )
}
