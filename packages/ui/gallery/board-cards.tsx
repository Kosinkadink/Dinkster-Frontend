import {
  BoardStore,
  asGraphDefId,
  asLineageId,
  asNodeId,
  emptyBoard,
  exposedKey,
  type BoardCardItem,
  type Json,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { createSignal, For, Show, createUniqueId, onCleanup } from 'solid-js'
import {
  ExposedParameterInput,
  ExposedParameterRow,
} from '../../app/src/AppView.js'
import { buildParamRows, comboOptions } from '../../app/src/app-view-rows.js'
import { ProductSelect } from '../../app/src/ProductSelect.js'
import {
  CanvasCornerControls,
  type CanvasCornerMenu,
} from '../../app/src/CanvasChrome.js'
import { ProductBoard, ProductBoardCard, ProductSection } from '../src/index.js'

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
  const schema: NodeSchema = {
    type: 'GalleryCardControls',
    displayName: 'Card controls',
    category: 'gallery',
    source: 'v3',
    isOutputNode: true,
    body: [
      {
        kind: 'input',
        id: 'prompt',
        optional: false,
        type: { kind: 'concrete', name: 'STRING' },
        widget: { widgetType: 'STRING', options: {} },
      },
      {
        kind: 'input',
        id: 'seed',
        optional: false,
        type: { kind: 'concrete', name: 'INT' },
        widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 1 } },
      },
      {
        kind: 'input',
        id: 'palette',
        optional: false,
        type: { kind: 'concrete', name: 'STRING' },
        widget: { widgetType: 'COMBO', options: { options: ['Warm', 'Cool'] } },
      },
      {
        kind: 'input',
        id: 'enabled',
        optional: false,
        type: { kind: 'concrete', name: 'BOOLEAN' },
        widget: { widgetType: 'BOOLEAN', options: {} },
      },
      {
        kind: 'input',
        id: 'motion',
        optional: false,
        type: { kind: 'concrete', name: 'STRING' },
        widget: { widgetType: 'STRING', options: {} },
      },
      {
        kind: 'input',
        id: 'length',
        optional: false,
        type: { kind: 'concrete', name: 'INT' },
        widget: { widgetType: 'INT', options: { min: 1, max: 30, step: 1 } },
      },
    ],
  }
  const labels: Record<string, string> = {
    prompt: 'Prompt',
    seed: 'Seed',
    palette: 'Palette',
    enabled: 'Enabled',
    motion: 'Motion',
    length: 'Length',
  }
  const rows = (card: BoardCardItem) => {
    const entries = Object.keys(card.values).map((key) => {
      const [graphId, nodeId, inputId] = JSON.parse(key) as [
        string,
        string,
        string,
      ]
      return { graphId, nodeId, inputId, label: labels[inputId]! }
    })
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: asLineageId('gallery'),
      root: asGraphDefId('root'),
      graphs: {
        root: {
          id: asGraphDefId('root'),
          name: 'Sample',
          nodes: {
            controls: {
              id: asNodeId('controls'),
              type: schema.type,
              values: Object.fromEntries(
                entries.map((entry) => [
                  entry.inputId,
                  card.values[exposedKey(entry)]!,
                ]),
              ),
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 1,
        },
      },
      view: { graphs: {} },
      ext: { 'dinkster.exposed': entries },
    }
    return buildParamRows(doc, () => schema).filter(
      (row) => row.kind === 'live',
    )
  }
  const samples: readonly BoardCardItem[] = [
    {
      id: 'workflow-1',
      kind: 'workflow',
      name: 'Diner establishing shot',
      source: { kind: 'library', recordId: 'diner' },
      values: {
        '["root","controls","prompt"]': 'A rainy diner at night',
        '["root","controls","seed"]': 19,
        '["root","controls","palette"]': 'Warm',
        '["root","controls","enabled"]': true,
      },
      autoSize: true,
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
        '["root","controls","motion"]': 'Slow push in',
        '["root","controls","length"]': 5,
      },
      autoSize: true,
      rect: { x: 408, y: 24, width: 340, height: 188 },
    },
    {
      id: 'workflow-many',
      kind: 'workflow',
      name: 'Many exposed controls',
      source: { kind: 'library', recordId: 'many' },
      values: {
        '["root","controls","prompt"]': 'A rainy diner at night',
        '["root","controls","seed"]': 19,
        '["root","controls","palette"]': 'Warm',
        '["root","controls","enabled"]': true,
        '["root","controls","motion"]': 'Slow push in',
        '["root","controls","length"]': 5,
      },
      autoSize: true,
      rect: { x: 792, y: 24, width: 340, height: 188 },
    },
    {
      id: 'workflow-empty',
      kind: 'workflow',
      name: 'Fixed color study',
      source: { kind: 'library', recordId: 'fixed-color' },
      values: {},
      autoSize: true,
      rect: { x: 24, y: 550, width: 340, height: 132 },
    },
    {
      id: 'workflow-failed',
      kind: 'workflow',
      name: 'Missing source',
      source: { kind: 'library', recordId: 'missing' },
      values: {},
      autoSize: true,
      rect: { x: 408, y: 550, width: 340, height: 164 },
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
            lastRun={running().has(item().id) ? 'Running' : 'Not run'}
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
            onContentHeight={(height) =>
              store.dispatch({
                command: 'board.card.fit',
                params: { id: item().id, height },
              })
            }
          >
            <For each={Object.keys(item().values)}>
              {(key) => {
                const row = () =>
                  rows(item()).find((row) => exposedKey(row.entry) === key)!
                const labelId = `gallery-card-${createUniqueId()}`
                const commit = async (value: Json, current: () => boolean) =>
                  current() &&
                  store.dispatch({
                    command: 'board.card.input',
                    params: { id: item().id, input: row().entry, value },
                  }).ok
                const input = () => (
                  <ExposedParameterInput
                    row={row()}
                    labelId={labelId}
                    draftScopeId={labelId}
                    onCommit={commit}
                    onError={() => undefined}
                    onDraftActive={() => undefined}
                    combo={
                      <ProductSelect
                        class="app-view-control"
                        ariaLabelledBy={labelId}
                        selectedId={String(row().value)}
                        options={comboOptions(row().spec!).map((option) => ({
                          id: String(option.value),
                          ...option,
                        }))}
                        onSelectAsync={(option, current) =>
                          commit(option.value, current)
                        }
                      />
                    }
                  />
                )
                return (
                  <ExposedParameterRow
                    head={
                      <>
                        <Show when={row().spec?.widgetType === 'BOOLEAN'}>
                          {input()}
                        </Show>
                        <span id={labelId} class="app-view-label">
                          {row().label}
                        </span>
                      </>
                    }
                  >
                    <Show when={row().spec?.widgetType !== 'BOOLEAN'}>
                      {input()}
                    </Show>
                  </ExposedParameterRow>
                )
              }}
            </For>
          </ProductBoardCard>
        )}
      />
    </ProductSection>
  )
}
