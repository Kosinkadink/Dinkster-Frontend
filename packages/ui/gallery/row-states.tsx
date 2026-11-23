import { For, createEffect, onCleanup } from 'solid-js'
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
  representationSchema,
  rowStateExamples,
  type RowStateExample,
} from '../../canvas/gallery/row-states.js'
import { ProductSection } from '../src/index.js'
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
    canvas.style.width = `${Math.ceil(box.maxX - box.minX + PAD * 2)}px`
    canvas.style.height = `${Math.ceil(box.maxY - box.minY + PAD * 2)}px`
    renderer.setViewport({ x: PAD - box.minX, y: PAD - box.minY, scale: 1 })
    renderer.renderNow()
    canvas.dataset.ready = `${example.id}-${props.theme}`
    onCleanup(() => {
      renderer.dispose()
      delete canvas.dataset.ready
    })
  })
  return (
    <figure class="dinkster-canvas-example">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${props.example.id} in ${props.theme} theme`}
        data-testid={`row-states-${props.example.id}`}
      />
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
  } = {},
): RowExample => ({
  id,
  caption,
  scale: 1,
  width: MARGIN + NODE_WIDTH + SIDE_ROOM,
  node: { x: MARGIN, y: MARGIN },
  ...(options.focus ? { focus: field } : { open: field }),
  representation: options.expanded ? 'expanded' : 'closed',
  build: {
    scene: (tokens, measure, widgetMeasure, position, width) =>
      createRepresentationScene(tokens, measure, widgetMeasure, position, width, options.views ?? {}, [field]),
    schema: representationSchema,
  },
})

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
