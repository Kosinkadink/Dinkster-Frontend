import { For, createEffect, createSignal, onCleanup } from 'solid-js'
import type { WidgetRegistry } from '@dinkster/core'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  problemBoxPlacement,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  problemBoxGallery,
  type ProblemBoxGalleryCard,
} from '../../canvas/gallery/problem-box.js'
import { ProblemBox } from '../src/index.js'

/** Room under the nodes for their tabs, and under the lowest box, in px. */
const TAB_ROOM = 24

interface PlacedBox {
  readonly box: ProblemBoxGalleryCard['boxes'][number]
  readonly x: number
  readonly y: number
  readonly width: number
}

function ProblemBoxCard(props: {
  card: (tokens: DesignTokens) => ProblemBoxGalleryCard
  id: string
  theme: 'dark' | 'light'
  registry: WidgetRegistry
}) {
  let canvas!: HTMLCanvasElement
  let frame!: HTMLDivElement
  const [boxes, setBoxes] = createSignal<readonly PlacedBox[]>([])
  const [caption, setCaption] = createSignal('')
  const [highlighted, setHighlighted] = createSignal<Record<string, string | undefined>>({})
  let renderer: CanvasRenderer | undefined
  createEffect(() => {
    const theme = props.theme
    let disposed = false
    void Promise.all([
      document.fonts.load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`),
      document.fonts.load(
        `${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
    ]).then(() => {
      if (disposed) return
      const tokens: DesignTokens = {
        ...defaultTokens,
        ...canvasTypePaintForTheme(theme),
        colors: canvasColorsForTheme(theme),
      }
      const card = props.card(tokens)
      const nodesBottom = Math.max(...card.scene.nodes.map((node) => node.y + node.layout.height))
      const height = nodesBottom + TAB_ROOM
      canvas.style.width = `${card.width}px`
      canvas.style.height = `${height}px`
      frame.style.width = `${card.width}px`
      frame.style.height = `${height}px`
      renderer?.dispose()
      renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(card.scene)
      renderer.setNodeStates(card.states ?? {})
      renderer.setBadges(card.badges)
      renderer.setRowMarks(card.rowMarks)
      renderer.setProblemRowHighlight(card.highlight)
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.renderNow()
      const viewport = renderer.getViewport()
      setCaption(card.caption)
      setHighlighted(Object.fromEntries(card.boxes.map((box) => [box.nodeId, box.highlighted])))
      setBoxes(card.boxes.flatMap((box) => {
        const node = card.scene.nodes.find((candidate) => candidate.id === box.nodeId)
        if (node === undefined) return []
        const at = problemBoxPlacement(node, renderer!.getNodeBadgeLayout(node), viewport)
        return [{ box, x: at.x, y: at.y, width: at.width }]
      }))
      // The boxes wrap to their nodes' widths, so the frame grows to hold them once drawn.
      requestAnimationFrame(() => {
        if (disposed) return
        const below = Math.max(0, ...[...frame.querySelectorAll<HTMLElement>('.problem-box')]
          .map((element) => element.offsetTop + element.offsetHeight))
        frame.style.height = `${Math.max(height, below + TAB_ROOM)}px`
        canvas.dataset.ready = `${props.id}-${theme}`
      })
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      renderer = undefined
      delete canvas.dataset.ready
    })
  })
  // Pointing at a line lights its row, as in the editor; a minimized node has no rows to light.
  const point = (nodeId: string, key: string | undefined, row: string | undefined): void => {
    setHighlighted((current) => ({ ...current, [nodeId]: key }))
    const node = renderer?.getScene().nodes.find((candidate) => candidate.id === nodeId)
    renderer?.setProblemRowHighlight(row === undefined || node?.layout.minimized === true ? undefined : { nodeId, row })
  }
  return (
    <figure class="dinkster-canvas-example">
      <div ref={frame} class="dinkster-problem-box-frame">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${props.id} in ${props.theme} theme`}
          data-testid={`problem-box-${props.id}`}
        />
        <For each={boxes()}>
          {(placed) => (
            <ProblemBox
              nodeId={placed.box.nodeId}
              label={`Problems of ${placed.box.nodeTitle}`}
              lines={placed.box.lines.map((line) => ({
                ...line,
                actions: line.actions.map((label) => ({ id: label, label })),
              }))}
              {...(highlighted()[placed.box.nodeId] === undefined ? {} : { highlighted: highlighted()[placed.box.nodeId]! })}
              x={placed.x}
              y={placed.y}
              width={placed.width}
              onPointLine={(line) => point(placed.box.nodeId, line?.key, line?.row)}
            />
          )}
        </For>
      </div>
      <figcaption class="dinkster-metadata">{caption()}</figcaption>
    </figure>
  )
}

/** The node's problem box: its states, painted by the production renderer and the product box. */
export function ProblemBoxGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  const measureContext = document.createElement('canvas').getContext('2d')!
  const cardsFor = (tokens: DesignTokens) => {
    const measure: TextMeasurer = (text, role) => {
      const title = role === 'title' || role === 'renamedTitle'
      measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
      return measureContext.measureText(text).width
    }
    const widgetMeasure: WidgetMeasure = (spec) => {
      const kind = registry.kind(spec.widgetType)
      const view = registry.viewsFor(spec.widgetType).find((candidate) => candidate.id === kind?.defaultView(spec))
      return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
    }
    return problemBoxGallery(tokens, measure, widgetMeasure)
  }
  const ids = cardsFor(defaultTokens).map((card) => card.id)
  return (
    <div class="dinkster-canvas-examples">
        <For each={ids}>
          {(id) => (
            <ProblemBoxCard
              id={id}
              theme={props.theme}
              registry={registry}
              card={(tokens) => cardsFor(tokens).find((card) => card.id === id)!}
            />
          )}
        </For>
    </div>
  )
}
