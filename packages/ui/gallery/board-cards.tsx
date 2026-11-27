import { BoardStore, emptyBoard, type BoardCardItem } from '@dinkster/core'
import { createSignal, For, onCleanup } from 'solid-js'
import {
  CanvasCornerControls,
  type CanvasCornerMenu,
} from '../../app/src/CanvasChrome.js'
import {
  ProductBoard,
  ProductBoardCard,
  ProductSection,
  ProductTextInput,
} from '../src/index.js'

/** Sample sources and run states exercise the shared chrome, without an engine. */
export function BoardCardsGallery() {
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
  const samples: readonly BoardCardItem[] = [
    {
      id: 'workflow-1',
      kind: 'workflow',
      name: 'Diner establishing shot',
      source: { kind: 'library', recordId: 'diner' },
      values: {
        '["root","prompt","value"]': 'A rainy diner at night',
        '["root","pictures","value"]': 4,
      },
      rect: { x: 24, y: 24, width: 340, height: 188 },
    },
    {
      id: 'blueprint-1',
      kind: 'blueprint',
      name: 'Image to video',
      source: {
        kind: 'pack',
        packId: 'video',
        blueprintId: 'image-to-video',
        digest: `sha256:${'a'.repeat(64)}`,
      },
      values: {
        '["root","motion","value"]': 'Slow push in',
        '["root","length","value"]': '5 s',
      },
      rect: { x: 408, y: 24, width: 340, height: 188 },
    },
    {
      id: 'workflow-empty',
      kind: 'workflow',
      name: 'Fixed color study',
      source: { kind: 'library', recordId: 'fixed-color' },
      values: {},
      rect: { x: 24, y: 270, width: 340, height: 132 },
    },
    {
      id: 'workflow-failed',
      kind: 'workflow',
      name: 'Missing source',
      source: { kind: 'library', recordId: 'missing' },
      values: {},
      rect: { x: 408, y: 270, width: 340, height: 164 },
    },
  ]
  store.dispatch({ command: 'board.item.add', params: { items: samples } })
  const [running, setRunning] = createSignal<ReadonlySet<string>>(new Set())
  const [activity, setActivity] = createSignal(
    'Sample sources; Run and Stop change gallery state only.',
  )
  const add = (
    kind: 'workflow' | 'blueprint',
    point: { x: number; y: number },
  ) => {
    const sample = samples.find((item) => item.kind === kind)!
    const { id: _id, ...source } = sample
    let x = point.x - sample.rect.width / 2
    let y = point.y - sample.rect.height / 2
    while (
      Object.values(store.doc.items).some(
        (item) => item.rect.x === x && item.rect.y === y,
      )
    ) {
      x += 24
      y += 24
    }
    const result = store.dispatch({
      command: 'board.item.add',
      params: { items: [{ ...source, rect: { ...sample.rect, x, y } }] },
    })
    return result.ok ? result.created[0] : undefined
  }
  return (
    <ProductSection title="Board cards">
      <p class="dinkster-metadata">
        Shared card presentation with sample values. The Add menu places a
        sample card; project Library selection and execution are not connected
        in this gallery.
      </p>
      <p class="dinkster-metadata" role="status">
        {activity()}
      </p>
      <ProductBoard
        store={store}
        assetUrl={() => ''}
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
        onAddMedia={() => setActivity('Media import requested')}
        onAddCard={{
          workflow: (point) => add('workflow', point),
          blueprint: (point) => add('blueprint', point),
        }}
        card={(item, remove) => (
          <ProductBoardCard
            name={item().name}
            kind={item().kind}
            lastRun={running().has(item().id) ? 'Running' : 'Not run yet'}
            running={running().has(item().id)}
            disabled={item().id === 'workflow-failed'}
            error={
              item().id === 'workflow-failed'
                ? 'The saved workflow is no longer available.'
                : undefined
            }
            onRun={() =>
              setRunning((current) => new Set([...current, item().id]))
            }
            onStop={() =>
              setRunning(
                (current) =>
                  new Set([...current].filter((id) => id !== item().id)),
              )
            }
            onOpen={
              item().source.kind === 'library'
                ? () => setActivity(`Open workflow: ${item().name}`)
                : undefined
            }
            onChooseInputs={
              item().source.kind === 'library'
                ? () => setActivity(`Choose inputs: ${item().name}`)
                : undefined
            }
            onRemove={remove}
          >
            <For each={Object.keys(item().values)}>
              {(key) => {
                const labels: Record<string, string> = {
                  prompt: 'Prompt',
                  pictures: 'Pictures',
                  motion: 'Motion',
                  length: 'Length',
                }
                const [graphId, nodeId, inputId] = JSON.parse(key) as [
                  string,
                  string,
                  string,
                ]
                const label = labels[nodeId]!
                return (
                  <label class="dinkster-board-card-input">
                    {label}
                    <ProductTextInput
                      aria-label={label}
                      value={String(item().values[key])}
                      onChange={(event) =>
                        store.dispatch({
                          command: 'board.card.input',
                          params: {
                            id: item().id,
                            input: { graphId, nodeId, inputId },
                            value:
                              nodeId === 'pictures'
                                ? Number(event.currentTarget.value)
                                : event.currentTarget.value,
                          },
                        })
                      }
                    />
                  </label>
                )
              }}
            </For>
          </ProductBoardCard>
        )}
      />
    </ProductSection>
  )
}
