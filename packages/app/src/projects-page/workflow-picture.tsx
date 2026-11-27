/**
 * A saved workflow drawn the way the minimap draws it: boxes, wires and
 * groups, laid out from the node definitions the project last ran with.
 */
import { onCleanup, onMount } from 'solid-js'
import { documentResolver, type SchemaResolver, type WidgetRegistry, type WorkflowDocument } from '@dinkster/core'
import {
  buildScene,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  defaultTokens,
  drawMinimapGraph,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'

export function WorkflowPicture(props: {
  readonly document: WorkflowDocument
  /** Node definitions; a node without one is drawn at its placeholder size. */
  readonly resolve: SchemaResolver
  readonly widgets: WidgetRegistry
}) {
  let canvas!: HTMLCanvasElement
  onMount(() => {
    const paint = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const graphics = canvas.getContext('2d')
      if (width === 0 || height === 0 || !graphics) return
      const theme = document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
      const tokens = { ...defaultTokens, colors: canvasColorsForTheme(theme), ...canvasTypePaintForTheme(theme) }
      const text = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (value, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        text.font = title
          ? `${canvasPaintTokens.type.semiboldWeight} ${tokens.titleFontSize}px ${tokens.fontFamily}`
          : `${tokens.fontSize}px ${tokens.fontFamily}`
        return text.measureText(value).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = props.widgets.kind(spec.widgetType)
        if (!kind) return undefined
        const viewId = kind.defaultView(spec)
        const view = props.widgets.viewsFor(spec.widgetType).find((candidate) => candidate.id === viewId)
        return view ? { viewId, rows: view.measure(spec).rows } : undefined
      }
      const scene = buildScene({
        document: props.document,
        graphId: props.document.root,
        resolve: documentResolver(props.document, props.resolve),
        tokens,
        measure,
        widgetMeasure,
      })
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      graphics.setTransform(ratio, 0, 0, ratio, 0, 0)
      drawMinimapGraph(graphics, {
        width,
        height,
        tokens,
        nodes: scene.nodes.map((node) => ({
          x: node.x,
          y: node.y,
          width: node.layout.width,
          height: node.layout.height,
          bypassed: node.node.mode === 'bypassed',
          ...(node.color !== undefined ? { color: node.color } : {}),
        })),
        groups: scene.groups.map((group) => ({
          x: group.x,
          y: group.y,
          width: group.width,
          height: group.height,
          ...(group.color !== undefined ? { color: group.color } : {}),
        })),
        links: scene.links
          .filter((link) => link.hidden !== true)
          .map((link) => ({
            from: { x: link.x1, y: link.y1 },
            to: { x: link.x2, y: link.y2 },
            ...(link.typeName !== undefined ? { typeName: link.typeName } : {}),
          })),
        reroutes: scene.reroutes.map((point) => ({ x: point.x, y: point.y })),
      })
    }
    // Layout measures text, so it waits for the canvas fonts; without font loading it paints at once.
    const fonts = Promise.resolve()
      .then(() =>
        Promise.all([
          document.fonts.load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`),
          document.fonts.load(`${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`),
        ]),
      )
      .catch(() => undefined)
    const repaint = () => void fonts.then(paint)
    repaint()
    const observer = new ResizeObserver(repaint)
    observer.observe(canvas)
    onCleanup(() => observer.disconnect())
  })
  return <canvas ref={canvas} aria-hidden="true" />
}
