import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { effectiveWidgetDefault, t, type Json, type WidgetRegistry } from '@dinkster/core'
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
  isSaveTarget,
  registerCoreWidgets,
  saveTargetDraft,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  createSaveTargetScene,
  galleryMounts,
  saveTargetGroups,
  saveTargetSchema,
  optionalSaveTargetSchema,
  wiredTargetCompanions,
  type SaveTargetExample,
} from '../../canvas/gallery/save-target-box.js'
import {
  CanvasRowField,
  CanvasTargetBox,
  CanvasTargetSide,
  ProductSection,
  canvasTargetLayout,
  type CanvasTargetMount,
  type CanvasTargetMounts,
} from '../src/index.js'
import { MARGIN, NODE_WIDTH, SIDE_ROOM } from './row-editing.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

/** The words a backend without mounts gives, as the product shows them. */
const NO_BACKEND = 'mountWidget.error'

const targetText = (value: Json): string =>
  isSaveTarget(value) ? `${value.mount}/${value.prefix}` : t('saveTargetWidget.default')

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
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void document.fonts
      .load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`)
      .then(() => {
        if (disposed) return
        const tokens: DesignTokens = {
          ...defaultTokens,
          widgetEditing: 'in-row',
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
          return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
        }
        const built = createSaveTargetScene(tokens, measure, widgetMeasure, nodeAt, current.stored, {
          ...(current.optional === true ? { optional: true } : {}),
          ...(current.arriving === undefined ? {} : { wired: true }),
        })
        const node = built.nodes.find((item) => item.id === schema().type)!
        canvas.style.width = `${MARGIN + NODE_WIDTH + SIDE_ROOM}px`
        canvas.style.height = `${node.y + node.layout.height + MARGIN}px`
        renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
        renderer.setReducedMotion(true)
        renderer.setGridVisible(false)
        renderer.setScene(built)
        if (current.arriving !== undefined) renderer.setCompanions(wiredTargetCompanions(node.id, current.arriving))
        renderer.setOpenRow(current.open === undefined ? undefined : { nodeId: node.id, valueKey: 'target' })
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

  const mounts = (): CanvasTargetMounts => {
    switch (example().mounts ?? 'ready') {
      case 'loading':
        return { kind: 'loading' }
      case 'none':
        return { kind: 'none' }
      case 'failed':
        return { kind: 'failed', message: t(NO_BACKEND) }
      case 'ready':
        return { kind: 'ready' }
    }
  }
  const ready = (): readonly string[] => (mounts().kind === 'ready' ? galleryMounts : [])
  const open = () => example().open
  const options = (): readonly CanvasTargetMount[] => {
    const picked = open()?.mount ?? ''
    const entries: CanvasTargetMount[] = ready().map((id) => ({ id, label: id }))
    if (picked !== '' && !ready().includes(picked))
      entries.unshift({ id: picked, label: t('mountWidget.unavailable', { id: picked }), unavailable: true })
    return entries
  }
  // The box read by the product's own rules.
  const draft = () =>
    saveTargetDraft({
      stored: example().stored,
      mount: open()?.mount ?? '',
      prefix: open()?.prefix ?? '',
      cleared: example().cleared === true,
      ready: mounts().kind === 'ready' ? ready() : undefined,
    })
  const declared = () => effectiveWidgetDefault(target()?.row.spec ?? { widgetType: 'SAVE_TARGET', options: {} })

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

  const side = createMemo(() => {
    const result = draft()
    const problem = mounts().kind === 'none'
      ? t('saveTargetWidget.noMounts')
      : result.mountGone ? t('saveTargetWidget.mountGone') : undefined
    return (
      <CanvasTargetSide
        {...(problem === undefined ? {} : { problem })}
        enter={result.store === undefined
          ? { verb: t('saveTargetWidget.enterKeeps'), target: targetText(example().stored) }
          : { verb: t('saveTargetWidget.enterStores'), target: targetText(result.store) }}
        defaultLabel="default"
        defaultText={targetText((declared() ?? null) as Json)}
        help={t('saveTargetWidget.naming', { suffix: '.png' })}
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
        const observer = new ResizeObserver(() => setBoxHeight(element.offsetHeight))
        observer.observe(element)
        onCleanup(() => observer.disconnect())
      }}
    >
      <CanvasTargetBox
        words={{
          mount: t('saveTargetWidget.mount'),
          prefix: t('saveTargetWidget.prefix'),
          loading: t('saveTargetWidget.loading'),
          none: t('saveTargetWidget.none'),
          failed: t('saveTargetWidget.noMount'),
          clear: t('saveTargetWidget.clear'),
        }}
        mounts={mounts()}
        options={options()}
        mount={open()?.mount ?? ''}
        listOpen={listOn() !== undefined}
        {...(listOn() === undefined ? {} : { highlight: listOn()! })}
        prefix={open()?.prefix ?? ''}
        {...(draft().prefixInvalid ? { prefixProblem: t('saveTargetWidget.invalid') } : {})}
        {...(example().optional === true ? { onClear: () => undefined } : {})}
        focused={listOn() !== undefined ? 'mount' : 'prefix'}
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
        <Show when={open() !== undefined && placement()}>
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
              {(example) => <SaveTargetExampleCard example={example} theme={props.theme} registry={registry} />}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  )
}
