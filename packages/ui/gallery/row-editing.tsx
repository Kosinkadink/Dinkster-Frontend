import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from 'solid-js'
import {
  effectiveWidgetDefault,
  formatWidgetValue,
  numericStepConstraints,
  type Json,
  type WidgetRegistry,
  type WidgetSpec,
} from '@dinkster/core'
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
  numberFieldFacts,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  createRowEditingScene,
  createRowFocusScene,
  rowEditingSchema,
  rowFocusSchema,
} from '../../canvas/gallery/fixtures.js'
import {
  CanvasRowField,
  CanvasRowFocus,
  CanvasSeedModeIcon,
  CanvasSideLink,
  CanvasSideModes,
  CanvasSidePart,
  ProductSection,
  canvasSidePlace,
} from '../src/index.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

export interface RowExample {
  readonly id: string
  readonly caption: string
  readonly scale: number
  readonly width: number
  readonly node: { readonly x: number; readonly y: number }
  readonly nodeWidth?: number
  readonly open?: string
  /** The row the keyboard is on while nothing is open, on the keyboard node. */
  readonly focus?: string
  readonly drag?: { readonly valueKey: string; readonly value: Json }
}

export const NODE_WIDTH = 280
export const MARGIN = 16
export const SIDE_ROOM = 272
const NARROW_NODE_WIDTH = 180

const besideRight = (
  id: string,
  caption: string,
  open: string,
): RowExample => ({
  id,
  caption,
  scale: 1,
  width: MARGIN + NODE_WIDTH + SIDE_ROOM,
  node: { x: MARGIN, y: MARGIN },
  open,
})
const besideLeft = (id: string, caption: string, open: string): RowExample => ({
  id,
  caption,
  scale: 1,
  width: SIDE_ROOM + NODE_WIDTH + MARGIN,
  node: { x: SIDE_ROOM, y: MARGIN },
  open,
})
const focusedRight = (
  id: string,
  caption: string,
  focus: string,
): RowExample => ({
  id,
  caption,
  scale: 1,
  width: MARGIN + NODE_WIDTH + SIDE_ROOM,
  node: { x: MARGIN, y: MARGIN },
  focus,
})
const zoomedOut = (id: string, caption: string, open: string): RowExample => ({
  id,
  caption,
  scale: 0.5,
  width: NODE_WIDTH + MARGIN * 2,
  node: { x: MARGIN * 2, y: MARGIN * 2 },
  open,
})

const groups: readonly {
  readonly title: string
  readonly examples: readonly RowExample[]
}[] = [
  {
    title: 'Closed rows',
    examples: [
      {
        id: 'closed',
        caption:
          'Nothing is open. The seed shows its mode as an icon before its value; the slider is tinted up to its value.',
        scale: 1,
        width: MARGIN * 2 + NODE_WIDTH,
        node: { x: MARGIN, y: MARGIN },
      },
      {
        id: 'closed-narrow',
        caption:
          'A narrow node. The seed keeps its mode icon; the label and the value share what is left.',
        scale: 1,
        width: MARGIN * 2 + NARROW_NODE_WIDTH,
        node: { x: MARGIN, y: MARGIN },
        nodeWidth: NARROW_NODE_WIDTH,
      },
    ],
  },
  {
    title: 'A number',
    examples: [
      besideRight(
        'number-right',
        'Clicked steps. The row is the field; its limits sit beside the node.',
        'steps',
      ),
      besideLeft(
        'number-left',
        'No room on the right of the node: the same side part opens on its left.',
        'steps',
      ),
      zoomedOut(
        'number-zoomed',
        'At 50 percent the field keeps its normal size and the side part goes under it.',
        'steps',
      ),
    ],
  },
  {
    title: 'A single-line text',
    examples: [
      besideRight(
        'text-right',
        'Clicked filename_prefix. Text has no limits, so the side part holds its help only.',
        'filename_prefix',
      ),
      besideLeft(
        'text-left',
        'No room on the right of the node: the side part opens on its left.',
        'filename_prefix',
      ),
      zoomedOut(
        'text-zoomed',
        'At 50 percent: the field at normal size, the help under it.',
        'filename_prefix',
      ),
    ],
  },
  {
    title: 'A seed',
    examples: [
      besideRight(
        'seed-right',
        'Clicked seed. Its mode icon stays before the value while the field is open. The side part shows the four modes as one group of icons, the meaning of the current one under them, then new seed.',
        'seed',
      ),
      besideLeft(
        'seed-left',
        'No room on the right of the node: the side part opens on its left.',
        'seed',
      ),
      zoomedOut(
        'seed-zoomed',
        'At 50 percent: the field at normal size, the side part under it.',
        'seed',
      ),
    ],
  },
  {
    title: 'A slider',
    examples: [
      {
        id: 'slider-dragged',
        caption:
          'Pressed on denoise and dragged left: the value is where the pointer is, and a bright line marks the fill while the pointer is down.',
        scale: 1,
        width: MARGIN * 2 + NODE_WIDTH,
        node: { x: MARGIN, y: MARGIN },
        drag: { valueKey: 'denoise', value: 0.45 },
      },
      besideRight(
        'slider-open',
        'Clicked denoise without dragging. The field keeps the fill.',
        'denoise',
      ),
    ],
  },
  {
    title: 'The keyboard on a row',
    examples: [
      focusedRight(
        'focus-toggle',
        'Tab reached enabled, a toggle. The row is drawn as it is closed; the outline shows where the keyboard is, and the side part holds the default and the help.',
        'enabled',
      ),
      focusedRight(
        'focus-choice',
        'Tab reached sampler_name, a row that opens an editor: the same look.',
        'sampler_name',
      ),
      focusedRight(
        'focus-number',
        'steps just stored with Enter, or left with Escape: the keyboard stays on the row in the same look.',
        'steps',
      ),
    ],
  },
  {
    title: 'Dragging a number',
    examples: [
      {
        id: 'number-dragged',
        caption:
          'Pressed on cfg (7.00, step 0.01) and moved 40 pixels right: 10 steps. The value turns the accent color, and nothing opens.',
        scale: 1,
        width: MARGIN * 2 + NODE_WIDTH,
        node: { x: MARGIN, y: MARGIN },
        drag: { valueKey: 'cfg', value: 7.1 },
      },
    ],
  },
]

function fieldText(value: Json | undefined): string {
  return value === undefined || value === null ? '' : String(value)
}

function sliderFill(
  spec: WidgetSpec,
  value: Json | undefined,
): number | undefined {
  const min = spec.options['min']
  const max = spec.options['max']
  if (
    spec.options['display'] !== 'slider' ||
    typeof value !== 'number' ||
    typeof min !== 'number' ||
    typeof max !== 'number' ||
    max <= min
  )
    return undefined
  return (value - min) / (max - min)
}

export function RowEditingExample(props: {
  example: RowExample
  theme: 'dark' | 'light'
  registry: WidgetRegistry
  /** Token overrides, such as a node look's. */
  look?: Partial<DesignTokens>
  testIdPrefix?: string
}) {
  let canvas!: HTMLCanvasElement
  let field: HTMLDivElement | undefined
  const [scene, setScene] = createSignal<Scene>()
  const [fieldInsetY, setFieldInsetY] = createSignal(0)
  const [proposal, setProposal] = createSignal(false)
  let stage!: HTMLDivElement
  const [sideWidth, setSideWidth] = createSignal(SIDE_ROOM - MARGIN)
  const [sideHeight, setSideHeight] = createSignal(0)
  createEffect(() => {
    const theme = props.theme
    const example = props.example
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
          ...props.look,
        }
        // Today's open field covers the whole row; in a proposed look the
        // closed field is already as tall as the open one and stays put.
        setProposal(tokens.nodeLook !== 'original')
        setFieldInsetY(proposal() ? tokens.rowGeometry.fieldInsetY : 0)
        const measureContext = document
          .createElement('canvas')
          .getContext('2d')!
        const measure: TextMeasurer = (text, role) => {
          measureContext.font = `${role === 'title' || role === 'renamedTitle' ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${role === 'title' || role === 'renamedTitle' ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
          return measureContext.measureText(text).width
        }
        const widgetMeasure: WidgetMeasure = (spec) => {
          const kind = props.registry.kind(spec.widgetType)
          const view = props.registry
            .viewsFor(spec.widgetType)
            .find((view) => view.id === kind?.defaultView(spec))
          return view
            ? { viewId: view.id, rows: view.measure(spec).rows }
            : undefined
        }
        const built = (
          example.focus === undefined
            ? createRowEditingScene
            : createRowFocusScene
        )(
          tokens,
          measure,
          widgetMeasure,
          example.node,
          example.nodeWidth ?? NODE_WIDTH,
        )
        const node = built.nodes[0]!
        const height =
          (example.node.y + node.layout.height + MARGIN) * example.scale
        canvas.style.width = `${example.width}px`
        canvas.style.height = `${height}px`
        renderer = new CanvasRenderer(
          canvas,
          tokens,
          createRegistryPainter(props.registry),
        )
        renderer.setReducedMotion(true)
        renderer.setGridVisible(false)
        renderer.setScene(built)
        // In a proposed look the canvas leaves the open row unpainted.
        renderer.setOpenRow(
          example.open !== undefined && proposal()
            ? { nodeId: node.id, valueKey: example.open }
            : undefined,
        )
        renderer.setRowDrag(
          example.drag ? { nodeId: node.id, ...example.drag } : undefined,
        )
        renderer.setViewport({ x: 0, y: 0, scale: example.scale })
        renderer.renderNow()
        setScene(built)
        canvas.dataset.ready = `${example.id}-${theme}`
      })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })
  const openRow = createMemo(() => {
    const current = scene()
    const key = props.example.open ?? props.example.focus
    if (!current || key === undefined) return undefined
    const node = current.nodes[0]!
    const row = node.layout.rows.find(
      (row): row is WidgetRow => row.kind === 'widget' && row.valueKey === key,
    )
    if (!row) return undefined
    const schema =
      props.example.focus === undefined ? rowEditingSchema : rowFocusSchema
    const item = schema.items.find(
      (item) => item.kind === 'input' && item.id === row.inputId,
    )
    const help = item?.kind === 'input' ? item.tooltip : undefined
    const numeric =
      row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
    const facts = numeric ? numberFieldFacts(row.spec) : []
    return { node, row, help, numeric, facts }
  })
  // The side part is built once per open row, so measuring and placing it
  // never replaces its content.
  const side = createMemo(() => {
    const target = openRow()
    if (!target) return undefined
    const { row, help, facts } = target
    if (props.example.focus !== undefined) {
      const declared = effectiveWidgetDefault(row.spec)
      if (declared === undefined && help === undefined) return undefined
      return (
        <CanvasSidePart
          facts={
            declared === undefined
              ? []
              : [
                  {
                    key: 'default',
                    value: formatWidgetValue(declared, row.spec),
                  },
                ]
          }
          {...(help !== undefined ? { help: help! } : {})}
        />
      )
    }
    if (facts.length === 0 && help === undefined) return undefined
    return (
      <CanvasSidePart
        {...(row.controllerMode !== undefined
          ? {
              children: (
                <CanvasSideModes
                  current={row.controllerMode!}
                  step={String(numericStepConstraints(row.spec).step)}
                  onMode={() => undefined}
                  onNewSeed={() => undefined}
                />
              ),
            }
          : {})}
        facts={facts.map((fact) => ({
          key: fact.key,
          value:
            fact.key === 'default' ? (
              <CanvasSideLink onClick={() => undefined}>
                {fact.text}
              </CanvasSideLink>
            ) : (
              fact.text
            ),
        }))}
        {...(help !== undefined ? { help: help! } : {})}
      />
    )
  })
  const open = () => {
    const target = openRow()
    if (!target) return undefined
    const { node, row, help, numeric, facts } = target
    const scale = props.example.scale
    // In a proposed look the open field is the row's field grown by one
    // pixel on every side, so its outline sits half in the gap between rows.
    const grow = proposal() ? 1 : 0
    const width = (row.width ?? node.layout.width - row.inset * 2) + grow * 2
    const screen = {
      x: (node.x + row.inset) * scale - grow,
      y: (node.y + row.y + fieldInsetY()) * scale - grow,
      width: width * scale,
      height: (row.height - fieldInsetY() * 2) * scale + grow * 2,
    }
    const bounds = {
      x: 0,
      y: 0,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    }
    const place = canvasSidePlace(screen, bounds, sideWidth(), scale)
    const value = node.node.values[row.valueKey]
    const nodeBottom = (node.y + node.layout.height) * scale
    return {
      row,
      numeric,
      screen,
      place,
      width,
      value,
      help,
      facts,
      sideTop: nodeBottom - screen.y + MARGIN / 2,
    }
  }
  createEffect(() => {
    const current = open()
    if (!current || !field) return
    field.style.left = `${current.screen.x}px`
    field.style.top = `${current.screen.y}px`
    const fieldHeight =
      (current.row.height - fieldInsetY() * 2) *
        Math.max(1, props.example.scale) +
      (proposal() ? 2 : 0)
    const sideBottom =
      current.place === 'below-node'
        ? current.sideTop + sideHeight()
        : current.place === 'below-field'
          ? fieldHeight + sideHeight()
          : Math.max(fieldHeight, sideHeight())
    stage.style.height = `${Math.max(canvas.clientHeight, current.screen.y + sideBottom + MARGIN)}px`
  })
  return (
    <figure class="dinkster-canvas-example">
      <div ref={stage} class="dinkster-canvas-example-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${props.example.id} in ${props.theme} theme`}
          data-testid={`${props.testIdPrefix ?? 'row-editing'}-${props.example.id}`}
        />
        <Show when={props.example.focus !== undefined && open()}>
          {(current) => (
            <CanvasRowFocus
              ref={(element) => (field = element)}
              {...(proposal() ? { look: 'flat-title' as const } : {})}
              rowWidth={current().width}
              place={current().place}
              sideTop={current().sideTop}
              onSideSize={(size) => {
                setSideWidth(size.width)
                setSideHeight(size.height)
              }}
              {...(side() !== undefined ? { side: side()! } : {})}
            />
          )}
        </Show>
        <Show when={props.example.focus === undefined && open()}>
          {(current) => (
            <CanvasRowField
              ref={(element) => (field = element)}
              {...(proposal() ? { look: 'flat-title' as const } : {})}
              rowWidth={current().width}
              label={current().row.label}
              value={fieldText(current().value)}
              onInput={() => undefined}
              inputLabel={current().row.label}
              {...(current().numeric ? { onStep: () => undefined } : {})}
              {...(sliderFill(current().row.spec, current().value) !== undefined
                ? { fill: sliderFill(current().row.spec, current().value)! }
                : {})}
              {...(current().row.controllerMode !== undefined
                ? {
                    mark: (
                      <CanvasSeedModeIcon
                        mode={current().row.controllerMode!}
                      />
                    ),
                  }
                : {})}
              place={current().place}
              sideTop={current().sideTop}
              onSideSize={(size) => {
                setSideWidth(size.width)
                setSideHeight(size.height)
              }}
              {...(side() !== undefined ? { side: side()! } : {})}
            />
          )}
        </Show>
      </div>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  )
}

/** Number, single-line text and seed rows edited in their own row, painted by the production renderer. */
export function RowEditingGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <For each={groups}>
      {(group) => (
        <ProductSection title={group.title}>
          <div class="dinkster-canvas-examples">
            <For each={group.examples}>
              {(example) => (
                <RowEditingExample
                  example={example}
                  theme={props.theme}
                  registry={registry}
                />
              )}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  )
}
