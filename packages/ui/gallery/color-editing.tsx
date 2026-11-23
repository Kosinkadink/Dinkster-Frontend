import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from 'solid-js'
import { effectiveWidgetDefault, type WidgetRegistry } from '@dinkster/core'
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
  colorFieldDraft,
  createWidgetRegistry,
  hsvToHex,
  integerColorHex,
  parseColorText,
  pickedColor,
  registerCoreWidgets,
  widgetRegistrationDoors,
  workflowSwatches,
} from '@dinkster/widgets'
import {
  colorEditingGroups,
  colorEditingSchema,
  createColorEditingScene,
  wiredColorCompanions,
  type ColorEditingExample,
} from '../../canvas/gallery/color-editing.js'
import {
  CanvasColorCode,
  CanvasColorArriving,
  CanvasColorKeys,
  CanvasColorPicker,
  CanvasColorSide,
  CanvasColorSquare,
  CanvasRowField,
  CanvasRowFocus,
  CanvasSidePart,
  ProductSection,
  canvasColorLayout,
  canvasSideLayout,
} from '../src/index.js'
import { MARGIN, NODE_WIDTH, SIDE_ROOM } from './row-editing.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

const colorInput = colorEditingSchema.items.find(
  (item) => item.kind === 'input' && item.id === 'color',
)
const help = colorInput?.kind === 'input' ? colorInput.tooltip : undefined

/** One labeled color state: the production renderer's node with the open field's own controls over it. */
function ColorEditingExampleCard(props: {
  example: ColorEditingExample
  theme: 'dark' | 'light'
  registry: WidgetRegistry
}) {
  let canvas!: HTMLCanvasElement
  let stage!: HTMLDivElement
  let field: HTMLDivElement | undefined
  const [scene, setScene] = createSignal<Scene>()
  const [fieldInsetY, setFieldInsetY] = createSignal(0)
  const [sideSize, setSideSize] = createSignal({ width: SIDE_ROOM - MARGIN, height: 0 })
  const [panelHeight, setPanelHeight] = createSignal(0)
  const example = () => props.example
  const scale = () => example().scale ?? 1
  const open = () => example().text !== undefined
  const edge = () => example().room === 'above' || example().room === 'constrained'
  const nodeAt = () =>
    scale() < 1
      ? { x: MARGIN * 2, y: MARGIN * 2 }
      : example().room === 'above'
        ? { x: MARGIN, y: 220 }
        : example().room === 'left'
          ? { x: SIDE_ROOM, y: MARGIN }
          : { x: MARGIN, y: MARGIN }
  const width = () =>
    scale() < 1
      ? NODE_WIDTH + MARGIN * 2
      : example().room === 'left'
        ? SIDE_ROOM + NODE_WIDTH + MARGIN
        : MARGIN + NODE_WIDTH + SIDE_ROOM

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
        const built = createColorEditingScene(
          tokens,
          measure,
          widgetMeasure,
          nodeAt(),
          current.stored,
          current.arriving !== undefined,
          undefined,
          current.integer === true,
        )
        const node = built.nodes.find((item) => item.id === colorEditingSchema.type)!
        canvas.style.width = `${width()}px`
        canvas.style.height = `${(node.y + node.layout.height + MARGIN) * scale()}px`
        renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
        renderer.setReducedMotion(true)
        renderer.setGridVisible(false)
        renderer.setScene(built)
        // The row paints the color the field uses, not the code that arrives.
        if (current.arriving !== undefined)
          renderer.setCompanions(
            wiredColorCompanions(
              colorFieldDraft(current.arriving, current.stored, current.stored, false).enter,
            ),
          )
        renderer.setOpenRow(open() ? { nodeId: node.id, valueKey: 'color' } : undefined)
        renderer.setViewport({ x: 0, y: 0, scale: scale() })
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
    const node = current.nodes.find((item) => item.id === colorEditingSchema.type)!
    const row = node.layout.rows.find(
      (row): row is WidgetRow => row.kind === 'widget' && row.valueKey === 'color',
    )
    return row ? { node, row } : undefined
  })

  // The field's draft, read by the product's own color parsing.
  const withOpacity = () => example().opacity === true
  const draft = () =>
    colorFieldDraft(
      example().text ?? '',
      example().stored,
      example().lastValid ?? example().stored,
      withOpacity(),
    )
  const point = () => {
    const color = parseColorText(draft().live)!
    return pickedColor(color, example().hue ?? 0)
  }
  // A whole-number color declares its default as a number.
  const declared = () =>
    effectiveWidgetDefault(target()?.row.spec ?? { widgetType: 'COLOR', options: {} })
  const swatches = () =>
    workflowSwatches(
      typeof declared() === 'number' ? integerColorHex(declared()) : (declared() as string | undefined),
      example().used ?? [],
      withOpacity(),
    )
  const defaultColor = () => swatches()[0]

  const placement = () => {
    const found = target()
    if (!found) return undefined
    const { node, row } = found
    const s = scale()
    const grow = 1
    const rowWidth = (row.width ?? node.layout.width - row.inset * 2) + grow * 2
    const zoom = Math.max(1, s)
    const screen = {
      x: (node.x + row.inset) * s - grow,
      y: (node.y + row.y + fieldInsetY()) * s - grow,
      width: rowWidth * zoom,
      height: (row.height - fieldInsetY() * 2) * zoom + grow * 2,
    }
    const bounds = {
      x: 0,
      y: 0,
      width: canvas.clientWidth,
      height: edge() ? canvas.clientHeight : Infinity,
    }
    if (!open())
      return {
        rowWidth,
        screen,
        panelPlace: 'below' as const,
        ...canvasSideLayout(screen, bounds, sideSize(), s, Infinity, Infinity),
      }
    return {
      rowWidth,
      screen,
      ...canvasColorLayout(screen, bounds, panelHeight(), sideSize(), s),
    }
  }

  createEffect(() => {
    const current = placement()
    if (!current || !field) return
    field.style.left = `${current.screen.x}px`
    field.style.top = `${current.screen.y}px`
    const shown = 'panelMaxHeight' in current && current.panelMaxHeight !== undefined ? current.panelMaxHeight : panelHeight()
    const columnTop = current.panelPlace === 'above' ? -shown : 0
    const bottom = Math.max(
      current.screen.height + (current.panelPlace === 'below' && open() ? shown : 0),
      current.sideTop + columnTop + (current.sideMaxHeight ?? sideSize().height),
    )
    stage.style.height = `${Math.max(canvas.clientHeight, current.screen.y + bottom + MARGIN)}px`
  })

  const side = createMemo(() => {
    const current = example()
    const result = draft()
    return (
      <CanvasColorSide
        {...(current.refused !== undefined
          ? { problem: current.refused }
          : result.invalid
            ? { problem: 'Not a color.' }
            : {})}
        pending={current.pending === true}
        droppedOpacity={result.droppedOpacity}
        enter={{ verb: result.invalid || result.enter === current.stored ? 'keeps' : 'stores', color: result.enter }}
        {...(result.invalid ? { preview: result.live } : {})}
        {...(defaultColor() === undefined ? {} : { defaultColor: defaultColor()! })}
        {...(help === undefined ? {} : { help })}
      >
        <Show when={example().keyboard}>
          {(control) => <CanvasColorKeys control={control()} point={point()} />}
        </Show>
      </CanvasColorSide>
    )
  })

  const focusSide = createMemo(() => {
    const current = example()
    if (current.arriving !== undefined) {
      const used = colorFieldDraft(current.arriving, current.stored, current.stored, false)
      return (
        <CanvasSidePart>
          <CanvasColorArriving arriving={current.arriving} used={used.enter} />
        </CanvasSidePart>
      )
    }
    return (
      <CanvasSidePart
        facts={
          defaultColor() === undefined
            ? []
            : [{ key: 'default', value: <CanvasColorCode color={defaultColor()!} /> }]
        }
        {...(help === undefined ? {} : { help })}
      />
    )
  })

  const picker = (
    <div
      ref={(element) => {
        const observer = new ResizeObserver(() => setPanelHeight(element.offsetHeight))
        observer.observe(element)
        onCleanup(() => observer.disconnect())
      }}
    >
      <CanvasColorPicker
        point={point()}
        opacity={withOpacity()}
        hex={hsvToHex}
        swatches={swatches()}
        {...(swatches().includes(draft().live) ? { chosen: draft().live } : {})}
        {...(example().candidate === undefined ? {} : { candidate: example().candidate! })}
        {...(example().keyboard === undefined ? {} : { focused: example().keyboard! })}
        disabled={example().pending === true}
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
          data-testid={`color-editing-${example().id}`}
        />
        <Show when={!open() && (example().rowFocus === true || example().arriving !== undefined) && placement()}>
          {(current) => (
            <CanvasRowFocus
              ref={(element) => (field = element)}
              look="flat-title"
              neutral={example().arriving !== undefined}
              rowWidth={current().rowWidth}
              place={current().place}
              sideTop={current().sideTop}
              onSideSize={setSideSize}
              side={focusSide()}
            />
          )}
        </Show>
        <Show when={open() && placement()}>
          {(current) => (
            <CanvasRowField
              ref={(element) => (field = element)}
              look="flat-title"
              rowWidth={current().rowWidth}
              label={target()!.row.label}
              labelMark={<CanvasColorSquare color={example().stored} />}
              mark={<CanvasColorSquare color={draft().live} />}
              value={example().text ?? ''}
              onInput={() => undefined}
              inputRef={(element) => {
                element.readOnly = example().pending === true
                element.setAttribute('aria-invalid', String(draft().invalid))
              }}
              inputLabel={target()!.row.label}
              place={current().place}
              sideTop={current().sideTop}
              {...(current().sideMaxHeight !== undefined
                ? { sideMaxHeight: current().sideMaxHeight! }
                : {})}
              onSideSize={setSideSize}
              side={side()}
              panel={picker}
              panelPlace={current().panelPlace}
              {...(current().panelMaxHeight !== undefined
                ? { panelMaxHeight: current().panelMaxHeight! }
                : {})}
            />
          )}
        </Show>
      </div>
      <figcaption class="dinkster-metadata">{example().caption}</figcaption>
    </figure>
  )
}

/** Every labeled state of a color edited in its row, painted by the production renderer with the field's own controls. */
export function ColorEditingGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <For each={colorEditingGroups}>
      {(group) => (
        <ProductSection title={group.title}>
          <div class="dinkster-canvas-examples">
            <For each={group.examples}>
              {(example) => (
                <ColorEditingExampleCard example={example} theme={props.theme} registry={registry} />
              )}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  )
}
