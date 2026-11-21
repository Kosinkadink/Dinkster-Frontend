import { For, createEffect, onCleanup } from 'solid-js'
import type { WidgetRegistry } from '@dinkster/core'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  nodeLookTokens,
  type DesignTokens,
  type NodeLook,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  createNodeLookFixture,
  nodeLookExamples,
  type NodeLookExample,
} from '../../canvas/gallery/fixtures.js'
import { ProductSection } from '../src/index.js'
import {
  MARGIN,
  NODE_WIDTH,
  RowEditingExample,
  SIDE_ROOM,
} from './row-editing.js'

interface LookCard {
  readonly id: string
  readonly caption: string
  readonly look: NodeLook
  readonly exchangeLight: boolean
}

/** Room above the node for badges and the selection outline. */
const TOP = 28
/** Narrow enough for the three looks of a node to sit in one line. */
const LOOK_NODE_WIDTH = 256

const looks = (theme: 'dark' | 'light'): readonly LookCard[] => [
  { id: 'today', caption: 'Today', look: 'current', exchangeLight: false },
  {
    id: 'lighter-title',
    caption: 'The lighter title bar',
    look: 'shaded-title',
    exchangeLight: false,
  },
  {
    id: 'body-title',
    caption: 'The title bar as the body',
    look: 'flat-title',
    exchangeLight: false,
  },
  ...(theme === 'light'
    ? [
        {
          id: 'lighter-title-exchanged',
          caption: 'The lighter title bar, surfaces exchanged',
          look: 'shaded-title' as const,
          exchangeLight: true,
        },
        {
          id: 'body-title-exchanged',
          caption: 'The title bar as the body, surfaces exchanged',
          look: 'flat-title' as const,
          exchangeLight: true,
        },
      ]
    : []),
]

function lookTokens(
  card: LookCard,
  theme: 'dark' | 'light',
): Partial<DesignTokens> {
  return nodeLookTokens(card.look, theme, card.exchangeLight)
}

function NodeLookCard(props: {
  example: NodeLookExample
  card: LookCard
  theme: 'dark' | 'light'
  registry: WidgetRegistry
}) {
  let canvas!: HTMLCanvasElement
  let figure!: HTMLElement
  const id = () => `${props.example}-${props.card.id}`
  createEffect(() => {
    const theme = props.theme
    const card = props.card
    const example = props.example
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void Promise.all([
      document.fonts.load(
        `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`,
      ),
      document.fonts.load(
        `${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
    ]).then(() => {
      if (disposed) return
      const tokens: DesignTokens = {
        ...defaultTokens,
        ...canvasTypePaintForTheme(theme),
        colors: canvasColorsForTheme(theme),
        ...lookTokens(card, theme),
      }
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
        return view
          ? { viewId: view.id, rows: view.measure(spec).rows }
          : undefined
      }
      const fixture = createNodeLookFixture(
        example,
        tokens,
        measure,
        widgetMeasure,
        { x: MARGIN, y: TOP },
        LOOK_NODE_WIDTH,
      )
      const node = fixture.scene.nodes[0]!
      const width = MARGIN * 2 + LOOK_NODE_WIDTH
      // Room under the node for a collapsed node's attached tab.
      const height = TOP + node.layout.height + MARGIN * 2
      figure.style.width = `${width}px`
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      renderer = new CanvasRenderer(
        canvas,
        tokens,
        createRegistryPainter(props.registry),
      )
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(fixture.scene)
      renderer.setNodeStates(fixture.states)
      renderer.setBadges(fixture.badges)
      renderer.setOverlay(fixture.overlay)
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.renderNow()
      canvas.dataset.ready = `${id()}-${theme}`
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })
  return (
    <figure ref={figure} class="dinkster-canvas-example">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${id()} in ${props.theme} theme`}
        data-testid={`node-look-${id()}`}
      />
      <figcaption class="dinkster-metadata">{props.card.caption}</figcaption>
    </figure>
  )
}

/** The same nodes in today's look and the proposed looks, painted by the production renderer. */
export function NodeLookGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <>
      <For each={nodeLookExamples}>
        {([example, title, description]) => (
          <ProductSection title={title} description={description}>
            <div class="dinkster-canvas-examples">
              <For each={looks(props.theme)}>
                {(card) => (
                  <NodeLookCard
                    example={example}
                    card={card}
                    theme={props.theme}
                    registry={registry}
                  />
                )}
              </For>
            </div>
          </ProductSection>
        )}
      </For>
      <ProductSection
        title="An open number"
        description="Sample image with steps open in its row and its side part beside the node."
      >
        <div class="dinkster-canvas-examples">
          <For each={looks(props.theme)}>
            {(card) => (
              <RowEditingExample
                example={{
                  id: `open-${card.id}`,
                  caption: card.caption,
                  scale: 1,
                  width: MARGIN + NODE_WIDTH + SIDE_ROOM,
                  node: { x: MARGIN, y: MARGIN },
                  open: 'steps',
                }}
                theme={props.theme}
                registry={registry}
                look={lookTokens(card, props.theme)}
                testIdPrefix="node-look"
              />
            )}
          </For>
        </div>
      </ProductSection>
    </>
  )
}
