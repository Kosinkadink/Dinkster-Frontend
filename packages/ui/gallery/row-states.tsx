import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  executionNodePresentation,
  linkControlOffset,
  sceneVisualBounds,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import type { WidgetRegistry } from '@dinkster/core'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  createRepresentationScene,
  createTintRepresentationScene,
  representationSchema,
  tintSchema,
  rowStateExamples,
  createSameLineScene,
  sameLineSchema,
  type RowStateExample,
} from '../../canvas/gallery/row-states.js'
import { CanvasRowFocus, CanvasRowList, CanvasSidePart, ProductSection } from '../src/index.js'
import { ButtonAskContent, ButtonBoxView } from '../../app/src/ButtonOverlays.js'
import {
  MARGIN,
  NODE_WIDTH,
  SIDE_ROOM,
  RowEditingExample,
  type RowExample,
} from './row-editing.js'

type Theme = 'dark' | 'light'

/** Room around an example for pins, tabs and outlines drawn past its nodes. */
const PAD = 12

function tokensFor(theme: Theme): DesignTokens {
  return {
    ...defaultTokens,
    widgetEditing: 'in-row',
    ...canvasTypePaintForTheme(theme),
    colors: canvasColorsForTheme(theme),
  }
}

function measurers(tokens: DesignTokens, registry: WidgetRegistry) {
  const context = document.createElement('canvas').getContext('2d')!
  const measure: TextMeasurer = (text, role) => {
    const title = role === 'title' || role === 'renamedTitle'
    context.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
    return context.measureText(text).width
  }
  const widgetMeasure: WidgetMeasure = (spec) => {
    const kind = registry.kind(spec.widgetType)
    const view = registry
      .viewsFor(spec.widgetType)
      .find((candidate) => candidate.id === kind?.defaultView(spec))
    return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
  }
  widgetMeasure.representations = (spec) => registry.kind(spec.widgetType)?.representations?.(spec)
  return { measure, widgetMeasure }
}

/** One canvas example, drawn by the production renderer with its run states as a finished run shows them. */
function SceneCard(props: {
  example: RowStateExample
  theme: Theme
  tokens: DesignTokens
  registry: WidgetRegistry
}) {
  let canvas!: HTMLCanvasElement
  const [focusBox, setFocusBox] = createSignal<{ x: number; y: number; width: number; height: number }>()
  createEffect(() => {
    const { example, tokens } = props
    const renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
    renderer.setReducedMotion(true)
    renderer.setGridVisible(false)
    renderer.setScene(example.scene)
    const presentation = executionNodePresentation(example.states ?? {}, true, tokens)
    renderer.setNodeStates(presentation.states)
    renderer.setBadges(presentation.badges)
    renderer.setOverlay(example.overlay ?? {})
    renderer.setRowMarks(example.rowMarks ?? {})
    renderer.setCompanions(example.companions ?? {})
    renderer.setButtonPaint(example.buttons ?? {})
    const box = sceneVisualBounds({ ...renderer.getScene(), links: [] }, {}, (node) => renderer.getNodeBadgeBounds(node))!
    for (const link of example.scene.links) {
      const dx = linkControlOffset(link.x1, link.x2)
      for (const [x, y] of [[link.x1 + dx, link.y1], [link.x2 - dx, link.y2]] as const) {
        box.minX = Math.min(box.minX, x)
        box.maxX = Math.max(box.maxX, x)
        box.minY = Math.min(box.minY, y)
        box.maxY = Math.max(box.maxY, y)
      }
    }
    canvas.style.width = `${Math.ceil(box.maxX - box.minX + PAD * 2) + (example.ask || example.focus?.help !== undefined ? SIDE_ROOM : 0)}px`
    canvas.style.height = `${Math.ceil(box.maxY - box.minY + PAD * 2) + (example.ask ? 160 : example.pick ? 180 : example.result ? 80 : 0)}px`
    renderer.setViewport({ x: PAD - box.minX, y: PAD - box.minY, scale: 1 })
    renderer.renderNow()
    const node = example.scene.nodes[0]
    const button = example.focus?.button ?? example.result?.button ?? example.pick?.button ?? example.ask?.button
    const row = node?.layout.rows.find((item) => item.kind === 'button' && item.buttonId === button)
    setFocusBox(node === undefined || row?.kind !== 'button' ? undefined : {
      x: node.x + row.inset + PAD - box.minX,
      y: node.y + row.y + tokens.rowGeometry.fieldInsetY + PAD - box.minY,
      width: row.width ?? node.layout.width - row.inset * 2,
      height: row.height - tokens.rowGeometry.fieldInsetY * 2,
    })
    canvas.dataset.ready = `${example.id}-${props.theme}`
    onCleanup(() => {
      renderer.dispose()
      delete canvas.dataset.ready
    })
  })
  const picture = <canvas
    ref={canvas}
    role="img"
    aria-label={`${props.example.id} in ${props.theme} theme`}
    data-testid={`row-states-${props.example.id}`}
  />
  return (
    <figure class="dinkster-canvas-example">
      <Show when={props.example.focus !== undefined || props.example.result !== undefined || props.example.pick !== undefined || props.example.ask !== undefined} fallback={picture}>
      <div class="dinkster-canvas-example-stage" data-fixed-surfaces={props.example.result !== undefined}>
        {picture}
        <Show when={props.example.focus !== undefined && focusBox()}>{(box) => (
          <CanvasRowFocus
            ref={(element) => createEffect(() => {
              element.style.left = `${box().x}px`
              element.style.top = `${box().y}px`
            })}
            rowWidth={box().width}
            look={props.tokens.nodeLook}
            place="right"
            sideTop={0}
            {...(props.example.focus?.help === undefined ? {} : { side: <CanvasSidePart help={props.example.focus.help} /> })}
          />
        )}</Show>
        <Show when={props.example.result && focusBox()}>{(box) => (
          <ButtonBoxView box={props.example.result!} under={box()} testId={props.example.id} />
        )}</Show>
        <Show when={props.example.ask && focusBox()}>{(box) => (
          <CanvasRowFocus
            ref={(element) => createEffect(() => {
              element.style.left = `${box().x}px`
              element.style.top = `${box().y}px`
            })}
            rowWidth={box().width}
            look={props.tokens.nodeLook}
            place="right"
            sideTop={0}
            side={<ButtonAskContent request={props.example.ask!.request} widgetKind={(type) => props.registry.kind(type)} editRow={() => undefined} onAnswer={() => undefined} />}
          />
        )}</Show>
        <Show when={props.example.pick && focusBox()}>{(box) => (
          <CanvasRowList
            ref={(element) => createEffect(() => {
              element.style.left = `${box().x}px`
              element.style.top = `${box().y}px`
            })}
            rowWidth={box().width}
            look={props.tokens.nodeLook}
            label="Prepare"
            inputLabel="Filter presets"
            query=""
            onQuery={() => undefined}
            place="right"
            options={props.example.pick!.state === 'ready' ? [
              { key: 'portrait', label: 'Portrait' },
              { key: 'landscape', label: 'Landscape' },
              { key: 'line-art', label: 'Line art' },
            ] : []}
            onPick={() => undefined}
            {...(props.example.pick!.state === 'ready' ? { highlight: 0 } : {})}
            listMaxHeight={156}
            {...(props.example.pick!.state === 'empty' ? { empty: 'No options available' } : {})}
            {...(props.example.pick!.state === 'failed' ? { status: { tone: 'error' as const, text: 'Could not load options', action: { id: 'retry', label: 'Try again', onClick: () => undefined } } } : {})}
          />
        )}</Show>
      </div>
      </Show>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  )
}

const representationExample = (
  id: string,
  caption: string,
  field: string,
  options: {
    readonly views?: Record<string, string>
    readonly focus?: true
    readonly expanded?: true
    readonly listRoom?: number
  } = {},
): RowExample => ({
  id,
  caption,
  scale: 1,
  width: MARGIN + NODE_WIDTH + SIDE_ROOM,
  node: { x: MARGIN, y: MARGIN },
  ...(options.focus ? { focus: field } : { open: field }),
  representation: options.expanded ? 'expanded' : 'closed',
  ...(options.listRoom === undefined ? {} : { listRoom: options.listRoom }),
  build: {
    scene: (tokens, measure, widgetMeasure, position, width) =>
      createRepresentationScene(tokens, measure, widgetMeasure, position, width, options.views ?? {}, [field]),
    schema: representationSchema,
  },
})

const sameLineExamples: readonly RowExample[] = [
  { id: 'middle-field', field: 'y', caption: 'Middle field open. Only y is outlined; its side part is a separate bordered box below the node, never a bridge across z.' },
  { id: 'last-field', field: 'z', caption: 'Last field open. Its side part joins the exposed right edge when there is room; x and y stay untouched.' },
  { id: 'first-field', field: 'x', caption: 'First field open. Its side part joins the exposed left edge when there is room; y and z stay untouched.' },
].map((example) => ({
  id: example.id, caption: example.caption, scale: 1,
  width: MARGIN + 600 + SIDE_ROOM, nodeWidth: 600,
  node: { x: example.field === 'x' ? SIDE_ROOM : MARGIN, y: MARGIN },
  open: example.field,
  build: { scene: createSameLineScene, schema: sameLineSchema },
}))

const representationExamples: readonly RowExample[] = [
  representationExample(
    'representation-closed',
    'Switchable field, control closed. The Representation control is the last line of the open field\'s side part and shows the current look by its declared name.',
    'mix',
  ),
  representationExample(
    'representation-open',
    'Representation list open. Choosing changes the row\'s look, never 0.65; Escape closes the list without a change. A draft is stored or refused by the field\'s own rules before the look switches.',
    'mix',
    { expanded: true, listRoom: 120 },
  ),
  representationExample(
    'representation-open-above',
    'At the bottom edge, the same list opens above the Representation line because there is no room below.',
    'mix',
    { expanded: true },
  ),
  representationExample(
    'representation-slider',
    'Slider selected, the keyboard on the row. Same value and pins; the choice is kept per instance as view state. The control is also at the end of the keyboard outline\'s side part.',
    'mix',
    { views: { mix: 'slider' }, focus: true },
  ),
  representationExample(
    'representation-range-unknown',
    'Slider selected, range unknown. The row draws Number until the range is known and says so; the choice stays Slider and comes back with the range.',
    'pending',
  ),
  representationExample(
    'representation-locked',
    'Locked, or only one look. No Representation control and no dead button: a declared set with userSwitchable false wins.',
    'locked',
  ),
  representationExample(
    'representation-readonly',
    'A read-only field keeps its ordinary contrast and lock. The keyboard outline offers Representation because changing the look writes no value.',
    'readonlyMix',
    { focus: true },
  ),
  {
    id: 'representation-color',
    caption: 'A whole-number field declared with the color display offers Color and Number. Above, the same field switched to Number: the ordinary whole-number row with its steppers, and the control shows Number. Below, the declared Color look, drawn as a color square and its code; the in-row color editor also takes its steppers away. Both store 5211846; Reset goes back to Color.',
    scale: 1,
    width: MARGIN + NODE_WIDTH + SIDE_ROOM,
    node: { x: MARGIN, y: MARGIN },
    open: 'tint',
    representation: 'closed',
    build: { scene: createTintRepresentationScene, schema: tintSchema },
  },
  representationExample(
    'representation-text',
    'A text box has no open field side part: the keyboard outline\'s side part carries the control, so Multiline can be switched back to Single line. A read-only or disabled field keeps this control, because it writes no value; a frozen run view shows none.',
    'caption',
    { views: { caption: 'multiline' }, focus: true },
  ),
]

/** Row states the editor knows today, and the Representation control, painted by the production renderer and side part. */
export function RowStatesGallery(props: { theme: Theme }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  const tokens = () => tokensFor(props.theme)
  const examples = () => {
    const { measure, widgetMeasure } = measurers(tokens(), registry)
    return rowStateExamples(tokens(), measure, widgetMeasure)
  }
  const cards = (list: readonly RowStateExample[]) => (
    <div class="dinkster-canvas-examples">
      <For each={list}>
        {(example) => <SceneCard example={example} theme={props.theme} tokens={tokens()} registry={registry} />}
      </For>
    </div>
  )
  return (
    <>
      <ProductSection title="Gives nothing, and a skipped node">{cards(examples().nothing)}</ProductSection>
      <ProductSection title="Promoted fields inside and outside">{cards(examples().promoted)}</ProductSection>
      <ProductSection title="Opening a field on a shared line">
        <div class="dinkster-canvas-examples">
          <For each={sameLineExamples}>{(example) => <RowEditingExample example={example} theme={props.theme} registry={registry} look={tokens()} testIdPrefix="row-states" />}</For>
        </div>
      </ProductSection>
      <ProductSection title="Button keyboard focus">{cards(examples().buttons.filter((example) => example.focus !== undefined))}</ProductSection>
      <ProductSection title="Button results, Pick lists and Ask forms">{cards(examples().buttons.filter((example) => example.focus === undefined))}</ProductSection>
      <ProductSection title="Representation control at the end of the side part">
        <div class="dinkster-canvas-examples">
          <For each={representationExamples}>
            {(example) => (
              <RowEditingExample
                example={example}
                theme={props.theme}
                registry={registry}
                testIdPrefix="row-states"
              />
            )}
          </For>
        </div>
      </ProductSection>
    </>
  )
}
