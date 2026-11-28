import {
  BoardStore,
  emptyBoard,
  type BoardItemInput,
  type BoardRect,
} from '@dinkster/core'
import { createMemo, createSignal, onCleanup } from 'solid-js'
import {
  CanvasCornerControls,
  type CanvasCornerMenu,
} from '../../app/src/CanvasChrome.js'
import {
  ProductBoard,
  ProductBoardCard,
  ProductButton,
  ProductSection,
} from '../src/index.js'

/** Fixed saved-file examples, not a simulated engine or placement planner. */
export function BoardResultsGallery() {
  const [example, setExample] = createSignal('first')
  const [finished, setFinished] = createSignal(false)
  const [state, setState] = createSignal('Running')
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
  const examples = [
    'first',
    'later',
    'away',
    'note',
    'blocked',
    'media',
    'failed',
  ] as const
  const labels = [
    'First run',
    'Later run',
    'Earlier results dragged away',
    'Overflow past a note',
    'Blocked next cell',
    'Video and sound',
    'Failed without files',
  ]
  const places = createMemo<readonly BoardRect[]>(() => {
    const count = ['later', 'away'].includes(example())
      ? 4
      : example() === 'media'
        ? 2
        : 1
    return Array.from({ length: count }, (_, index) => ({
      x: 388 + (index % 2) * 304,
      y: (example() === 'later' ? 422 : 24) + Math.floor(index / 2) * 199,
      width: 280,
      height: 175,
    }))
  })
  const store = createMemo(() => {
    const next = new BoardStore(emptyBoard())
    const items: BoardItemInput[] = [
      {
        id: 'workflow',
        kind: 'workflow',
        name: 'Diner establishing shot',
        source: { kind: 'library', recordId: 'diner' },
        values: {},
        rect: { x: 24, y: 24, width: 340, height: 188 },
      },
    ]
    if (example() === 'note' || example() === 'blocked')
      items.push({
        id: 'note',
        kind: 'note',
        text: 'Keep this note where it is.',
        rect:
          example() === 'blocked'
            ? { x: 692, y: 24, width: 200, height: 240 }
            : { x: 388, y: 223, width: 584, height: 100 },
      })
    next.dispatch({ command: 'board.item.add', params: { items } })
    if (example() === 'later' || example() === 'away')
      next.dispatch({
        command: 'board.run.add',
        params: {
          job: 'earlier-run',
          card: 'workflow',
          items: Array.from({ length: 4 }, (_, index) => ({
            id: `earlier-${index}`,
            kind: 'picture' as const,
            rect: {
              x: 388 + (index % 2) * 304,
              y:
                (example() === 'away' ? 480 : 24) + Math.floor(index / 2) * 199,
              width: 280,
              height: 175,
            },
            asset: {
              digest: `blake3:${String(index + 5).repeat(64)}`,
              name: `Earlier diner ${index + 1}`,
              mediaType: 'image/jpeg',
              origin: { job: 'earlier-run', node: 'save' },
            },
          })),
        },
      })
    if (finished() && example() !== 'failed')
      next.dispatch({
        command: 'board.run.add',
        params: {
          job: 'saved-run',
          card: 'workflow',
          items: Array.from(
            {
              length: example() === 'media' || example() === 'blocked' ? 2 : 4,
            },
            (_, index) => ({
              id: `result-${index}`,
              kind:
                example() === 'media'
                  ? index === 0
                    ? ('video' as const)
                    : ('sound' as const)
                  : ('picture' as const),
              rect: {
                x: example() === 'blocked' ? 388 : 388 + (index % 2) * 304,
                y:
                  example() === 'blocked'
                    ? 24 + index * 264
                    : places()[0]!.y +
                      Math.floor(index / 2) *
                        (example() === 'note' ? 323 : 199),
                width: 280,
                height: example() === 'media' && index === 1 ? 70 : 175,
              },
              asset: {
                digest: `blake3:${String(index + 1).repeat(64)}`,
                name:
                  example() === 'media'
                    ? index === 0
                      ? 'Window light'
                      : 'Chimes'
                    : `Diner ${index + 1}`,
                mediaType:
                  example() === 'media'
                    ? index === 0
                      ? 'video/webm'
                      : 'audio/wav'
                    : 'image/jpeg',
                origin: { job: 'saved-run', node: 'save' },
              },
            }),
          ),
        },
      })
    return next
  })
  const pending = () =>
    finished()
      ? []
      : [
          {
            job: 'saved-run',
            card: 'workflow',
            places: places(),
            label: state() === 'Unknown progress' ? 'Running' : state(),
            running: state() === 'Running' || state() === 'Unknown progress',
            ...(state() === 'Unknown progress' ? {} : { progress: 0.41 }),
          },
        ]
  return (
    <ProductSection title="Board saved results">
      <p class="dinkster-metadata">
        Fixed layout examples for reserved places, saved files and recorded
        history. No engine is connected.
      </p>
      <div class="dinkster-board-result-examples">
        {examples.map((value, index) => (
          <ProductButton
            onClick={() => {
              setExample(value)
              setFinished(false)
            }}
          >
            {labels[index]}
          </ProductButton>
        ))}
        <ProductButton onClick={() => setFinished((value) => !value)}>
          {finished() ? 'Show running' : 'Finish run'}
        </ProductButton>
        {['Preparing', 'Queued', 'Running', 'Unknown progress'].map((value) => (
          <ProductButton
            onClick={() => {
              setState(value)
              setFinished(false)
            }}
          >
            {value}
          </ProductButton>
        ))}
      </div>
      <ProductBoard
        store={store()}
        pendingRuns={pending()}
        assetUrl={(asset) =>
          asset.mediaType === 'video/webm'
            ? '/board/window.webm'
            : asset.mediaType === 'audio/wav'
              ? '/board/chimes.wav'
              : '/templates/diner.jpg'
        }
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
        card={(card, remove) => (
          <ProductBoardCard
            name={card().name}
            kind={card().kind}
            lastRun={
              finished()
                ? example() === 'failed'
                  ? 'Failed'
                  : 'Completed'
                : state() === 'Unknown progress'
                  ? 'Running'
                  : state()
            }
            running={!finished()}
            error={
              finished() && example() === 'failed'
                ? 'The run failed before saving a file.'
                : undefined
            }
            onRun={() => setFinished(false)}
            onStop={() => setFinished(true)}
            onRemove={remove}
          >
            <span class="dinkster-metadata">A rainy diner at night</span>
          </ProductBoardCard>
        )}
      />
    </ProductSection>
  )
}
