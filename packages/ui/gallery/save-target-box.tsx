import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { t, type Json, type WidgetRegistry } from '@dinkster/core'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  type DesignTokens,
  type LayoutRow,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  saveTargetDraft,
  saveTargetText,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  createSaveTargetScene,
  galleryDefault,
  galleryMounts,
  saveTargetGroups,
  saveTargetSchema,
  optionalSaveTargetSchema,
  wiredTargetCompanions,
  type SaveTargetExample,
} from '../../canvas/gallery/save-target-box.js'
import {
  CanvasRowField,
  CanvasEditorSpace,
  CanvasTargetBox,
  CanvasTargetSide,
  ProductSection,
  canvasTargetLayout,
  type CanvasTargetMount,
  type CanvasTargetMounts,
} from '../src/index.js'
import { MARGIN, NODE_WIDTH, SIDE_ROOM } from './row-editing.js'
import { InNodeEditorExampleCard } from './in-node-editors.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

/** The words a backend without mounts gives, as the product shows them. */
const NO_BACKEND = 'mountWidget.error'

const targetText = (value: Json, projectMount: string): string =>
  saveTargetText(value, projectMount) ?? t('saveTargetWidget.default')

/** One labeled save target state: the production renderer's node with the open row's own controls over it. */
function SaveTargetExampleCard(props: {
  example: SaveTargetExample
  theme: 'dark' | 'light'
  registry: WidgetRegistry
}) {
  let canvas!: HTMLCanvasElement
  let stage!: HTMLDivElement
  let field: HTMLDivElement | undefined
  const [scene, setScene] = createSignal<Scene>()
  const [fieldInsetY, setFieldInsetY] = createSignal(0)
  const [sideSize, setSideSize] = createSignal({ width: SIDE_ROOM - MARGIN, height: 0 })
  const [boxHeight, setBoxHeight] = createSignal(0)
  const example = () => props.example
  const schema = () => (example().optional === true ? optionalSaveTargetSchema : saveTargetSchema)
  const nodeAt = { x: MARGIN, y: MARGIN }

  createEffect(() => {
    const theme = props.theme
    const current = example()
    const controlsHeight = boxHeight()
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void document.fonts
      .load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`)
      .then(() => {
        if (disposed) return
        const tokens: DesignTokens = {
          ...defaultTokens,
          widgetEditing: 'in-row',
          widgetRowLook: 'raised-editors',
          ...canvasTypePaintForTheme(theme),
          colors: canvasColorsForTheme(theme),
        }
        setFieldInsetY(tokens.rowGeometry.fieldInsetY)
        const measureContext = document.createElement('canvas').getContext('2d')!
        const measure: TextMeasurer = (text, role) => {
          const title = role === 'title' || role === 'renamedTitle'
          measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
          return measureContext.measureText(text).width
        }
        const widgetMeasure: WidgetMeasure = (spec) => {
          const kind = props.registry.kind(spec.widgetType)
          const view = props.registry
            .viewsFor(spec.widgetType)
            .find((view) => view.id === kind?.defaultView(spec))
          return view ? { viewId: view.id, rows: view.measure(spec).rows,
            ...(current.foldout && current.open && controlsHeight > 0 ? { editorControls: controlsHeight } : {}) } : undefined
        }
        const shown = current.foldout && current.open && !draft().prefixInvalid
          ? { prefix: current.open.prefix, ...(current.open.mount === null ? {} : { mount: current.open.mount }) }
          : current.stored
        const built = createSaveTargetScene(tokens, measure, widgetMeasure, nodeAt, shown, {
          ...(current.optional === true ? { optional: true } : {}),
          ...(current.arriving === undefined ? {} : { wired: true }),
          ...(current.foldout ? { unfolded: current.open !== undefined } : {}),
          ...(current.wiredParts === undefined ? {} : { wiredParts: current.wiredParts }),
        })
        const node = built.nodes.find((item) => item.id === schema().type)!
        canvas.style.width = `${current.foldout ? node.layout.width + MARGIN * 2 : MARGIN + NODE_WIDTH + SIDE_ROOM}px`
        canvas.style.height = `${node.y + node.layout.height + MARGIN}px`
        renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
        renderer.setReducedMotion(true)
        renderer.setGridVisible(false)
        renderer.setScene(built)
        if (current.arriving !== undefined) renderer.setCompanions(wiredTargetCompanions(node.id, current.arriving))
        if ((current.mounts ?? 'ready') === 'ready')
          renderer.setWidgetFacts({ SAVE_TARGET: { ready: [...galleryMounts], ...(current.noDefault === true ? {} : { projectMount: galleryMounts[0] }) } })
        renderer.setOpenRow(current.open === undefined || current.foldout ? undefined : { nodeId: node.id, valueKey: 'target' })
        renderer.setViewport({ x: 0, y: 0, scale: 1 })
        renderer.renderNow()
        setScene(built)
        canvas.dataset.ready = `${current.id}-${theme}`
      })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })

  const target = createMemo(() => {
    const current = scene()
    if (!current) return undefined
    const node = current.nodes.find((item) => item.id === schema().type)!
    const row = node.layout.rows.find(
      (row): row is WidgetRow => row.kind === 'widget' && row.valueKey === 'target',
    )
    return row ? { node, row } : undefined
  })

  const mounts = (): CanvasTargetMounts => example().mounts ?? 'ready'
  const ready = (): readonly string[] => (mounts() === 'ready' ? galleryMounts : [])
  const open = () => example().open
  // The project's default output mount, known once the mounts are read; a project may have none.
  const noDefault = (): boolean => mounts() === 'ready' && example().noDefault === true
  const projectMount = (): string | undefined => (mounts() === 'ready' && !noDefault() ? galleryMounts[0] : undefined)
  const projectText = (): string => projectMount() ?? t(noDefault() ? 'saveTargetWidget.noOutputMount' : 'saveTargetWidget.projectDefault')
  const options = (): readonly CanvasTargetMount[] => {
    const picked = open()?.mount ?? ''
    const entries: CanvasTargetMount[] = [
      {
        id: '',
        label: t('saveTargetWidget.projectDefaultIs', { mount: projectText() }),
        closedLabel: t('saveTargetWidget.projectDefault'),
      },
      ...ready().map((id) => ({ id, label: id })),
    ]
    if (picked !== '' && !ready().includes(picked))
      entries.unshift({ id: picked, label: t('saveTargetWidget.notHere', { id: picked }), closedLabel: picked, unavailable: true })
    return entries
  }
  // The box read by the product's own rules.
  const draft = () =>
    saveTargetDraft({
      stored: example().stored,
      mount: open()?.mount ?? null,
      prefix: open()?.prefix ?? '',
      ready: mounts() === 'ready' ? ready() : undefined,
      projectMount: projectText(),
    })
  const tooltip = () => {
    const input = schema().body.find((item) => item.kind === 'input' && item.id === 'target')
    return input?.kind === 'input' ? input.tooltip : undefined
  }

  const placement = () => {
    const found = target()
    if (!found) return undefined
    const { node, row } = found
    const grow = 1
    const rowWidth = (row.width ?? node.layout.width - row.inset * 2) + grow * 2
    const screen = {
      x: node.x + row.inset - grow,
      y: node.y + row.y + fieldInsetY() - grow,
      width: rowWidth,
      height: row.height - fieldInsetY() * 2 + grow * 2,
    }
    const bounds = { x: 0, y: 0, width: canvas.clientWidth, height: Infinity }
    return { rowWidth, screen, ...canvasTargetLayout(screen, bounds, boxHeight(), sideSize(), 1) }
  }

  createEffect(() => {
    const current = placement()
    if (!current || !field) return
    field.style.left = `${current.screen.x}px`
    field.style.top = `${current.screen.y}px`
    // The mount list reaches past the box; the stage grows to show it whole.
    const list = field.querySelector<HTMLElement>('.dinkster-canvas-target-list')
    const listBottom = list ? list.getBoundingClientRect().bottom - field.getBoundingClientRect().top : 0
    const bottom = Math.max(
      current.screen.height + boxHeight(),
      current.sideTop + sideSize().height,
      listBottom,
    )
    stage.style.height = `${Math.max(canvas.clientHeight, current.screen.y + bottom + MARGIN)}px`
  })

  const runStops = (): string | undefined => {
    if (!noDefault()) return undefined
    if (draft().mountGone) return t('saveTargetWidget.notHereNoDefault', { id: open()?.mount ?? '' })
    return open()?.mount === null ? t('saveTargetWidget.noDefaultMount') : undefined
  }
  const mountTone = (): 'warning' | 'error' | undefined =>
    runStops() !== undefined ? 'error' : draft().mountGone ? 'warning' : undefined

  const side = createMemo(() => {
    const result = draft()
    const gone = result.mountGone ? open()?.mount ?? undefined : undefined
    const stops = runStops()
    const problem = stops !== undefined ? undefined : mounts() === 'none'
      ? t('saveTargetWidget.noMounts')
      : gone !== undefined ? t('saveTargetWidget.notHereSaving', { id: gone, mount: projectText() }) : undefined
    return (
      <CanvasTargetSide
        {...(problem === undefined ? {} : { problem })}
        enter={result.store === undefined
          ? { verb: t('saveTargetWidget.enterKeeps'), target: targetText(example().stored, projectText()) }
          : { verb: t('saveTargetWidget.enterStores'), target: targetText(result.store, projectText()) }}
        {...(gone === undefined || noDefault() ? {} : { action: { label: t('saveTargetWidget.useProjectDefault'), onClick: () => undefined } })}
        defaultLabel="default"
        defaultText={targetText(galleryDefault, projectText())}
        onDefault={() => undefined}
        {...(mounts() === 'failed' ? { error: t(NO_BACKEND) } : stops !== undefined ? { error: stops } : {})}
        {...(tooltip() === undefined ? {} : { tooltip: tooltip()! })}
        naming={t('saveTargetWidget.naming', { suffix: '.png' })}
      />
    )
  })

  const listOn = () => {
    const on = example().listOn
    return on === undefined ? undefined : options().findIndex((entry) => entry.id === on)
  }
  const box = (
    <div
      ref={(element) => {
        const observer = new ResizeObserver(() => setBoxHeight(element.scrollHeight))
        observer.observe(element)
        onCleanup(() => observer.disconnect())
      }}
    >
      <CanvasTargetBox
        inNode={example().foldout === true}
        frozen={example().arriving !== undefined}
        mountWired={example().wiredParts?.includes('mount') === true}
        prefixWired={example().wiredParts?.includes('name') === true}
        words={{
          mount: example().foldout ? 'Mount' : t('saveTargetWidget.mount'),
          prefix: example().foldout ? 'Name' : t('saveTargetWidget.prefix'),
          loading: t('saveTargetWidget.loading'),
          none: t('saveTargetWidget.none'),
          failed: t('saveTargetWidget.couldNotLoad'),
        }}
        mounts={mounts()}
        options={options()}
        mount={open()?.mount ?? ''}
        {...(mountTone() === undefined ? {} : { tone: mountTone()! })}
        listOpen={listOn() !== undefined}
        {...(listOn() === undefined ? {} : { highlight: listOn()! })}
        prefix={open()?.prefix ?? ''}
        {...(draft().prefixInvalid ? { prefixProblem: t('saveTargetWidget.invalid') } : {})}
        {...(example().resting ? {} : { focused: listOn() !== undefined ? 'mount' as const : 'prefix' as const })}
      />
    </div>
  )

  return (
    <figure class="dinkster-canvas-example">
      <div ref={stage} class="dinkster-canvas-example-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${example().id} in ${props.theme} theme`}
          data-testid={`save-target-box-${example().id}`}
        />
        <Show when={example().foldout && target()}>
          {(found) => {
            const space = () => found().node.layout.rows.find((row): row is Extract<LayoutRow, { kind: 'editorSpace' }> => row.kind === 'editorSpace' && row.valueKey === 'target')
            return <Show when={space()}>{(row) =>
              <CanvasEditorSpace {...(example().arriving === undefined ? {} : { state: 'dimmed' })} ref={(element) => {
                createEffect(() => {
                  element.style.left = `${found().node.x + row().inset}px`
                  element.style.top = `${found().node.y + row().y}px`
                  element.style.width = `${row().width ?? found().node.layout.width - row().inset * 2}px`
                  element.style.height = `${row().height - fieldInsetY()}px`
                })
              }}>{box}</CanvasEditorSpace>
            }</Show>
          }}
        </Show>
        <Show when={!example().foldout && open() !== undefined && placement()}>
          {(current) => (
            <CanvasRowField
              ref={(element) => (field = element)}
              look="flat-title"
              rowWidth={current().rowWidth}
              label={target()!.row.label}
              value={draft().rowText}
              placeholder={t('saveTargetWidget.default')}
              onInput={() => undefined}
              inputRef={(element) => {
                element.readOnly = true
                element.tabIndex = -1
              }}
              inputLabel={target()!.row.label}
              place={current().place}
              sideTop={current().sideTop}
              {...(current().sideMaxHeight !== undefined ? { sideMaxHeight: current().sideMaxHeight! } : {})}
              onSideSize={setSideSize}
              side={side()}
              panel={box}
              panelPlace={current().panelPlace}
            />
          )}
        </Show>
      </div>
      <figcaption class="dinkster-metadata">{example().caption}</figcaption>
    </figure>
  )
}

/** Every state of a save target opened in its row, painted by the production renderer with the row's own controls. */
export function SaveTargetBoxGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <For each={saveTargetGroups}>
      {(group) => (
        <ProductSection title={group.title}>
          <div class="dinkster-canvas-examples">
            <For each={group.examples}>
              {(example) => <>
                <SaveTargetExampleCard example={example} theme={props.theme} registry={registry} />
                <Show when={example.foldout}>
                  <InNodeEditorExampleCard theme={props.theme} registry={registry} example={{
                    id: `curve-beside-${example.id}`, type: 'Curve editor', card: 34,
                    caption: 'Curve uses the same frame, header, opener and editor space.',
                    values: { curve: { interpolation: 'linear', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] } },
                    view: { editors: { curve: { unfolded: example.open !== undefined } } },
                    ...(example.arriving === undefined ? {} : {
                      wired: { curve: 'CURVE' }, carried: { curve: { interpolation: 'linear', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] } },
                    }),
                  }} />
                </Show>
              </>}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  )
}
