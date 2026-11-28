import { For, createEffect, onCleanup } from 'solid-js'
import { loadDocument, type NodeSchema } from '@dinkster/core'
import {
  CanvasRenderer,
  buildScene,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  nodeLookTokens,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'

const schema: NodeSchema = {
  type: 'Exposure controls', displayName: 'Exposure controls', category: 'gallery', source: 'v3', isOutputNode: false,
  body: [
    { kind: 'input', id: 'text', optional: false, type: { kind: 'concrete', name: 'STRING' }, widget: { widgetType: 'STRING', default: 'Quiet studio light', options: {} } },
    { kind: 'input', id: 'number', optional: false, type: { kind: 'concrete', name: 'INT' }, widget: { widgetType: 'INT', default: 37, options: { min: 0, max: 100, step: 1 }, controller: 'after_generate' } },
    { kind: 'input', id: 'choice', optional: false, type: { kind: 'concrete', name: 'COMBO' }, widget: { widgetType: 'COMBO', default: 'A very long selected choice with fine detail', options: { options: ['A very long selected choice with fine detail', 'Short alternative'] }, controller: 'after_generate' } },
  ],
}

export function ExposureRowsGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  const examples = [
    { id: 'ordinary', title: 'Ordinary Graph rows', active: undefined },
    { id: 'unchecked', title: 'Exposure: not exposed', active: false },
    { id: 'checked', title: 'Exposure: exposed', active: true },
  ] as const
  return <div class="dinkster-canvas-examples">
      <For each={examples}>{(example) => {
        let canvas!: HTMLCanvasElement
        createEffect(() => {
          const theme = props.theme
          let disposed = false
          let renderer: CanvasRenderer | undefined
          void document.fonts.ready.then(() => {
            if (disposed) return
            const tokens: DesignTokens = {
              ...defaultTokens, widgetEditing: 'in-row',
              ...canvasTypePaintForTheme(theme), colors: canvasColorsForTheme(theme),
              ...nodeLookTokens('flat-title', theme),
            }
            const context = document.createElement('canvas').getContext('2d')!
            const measure: TextMeasurer = (text, role) => {
              const title = role === 'title' || role === 'renamedTitle'
              context.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
              return context.measureText(text).width
            }
            const widgetMeasure: WidgetMeasure = (spec) => {
              const kind = registry.kind(spec.widgetType)
              const view = registry.viewsFor(spec.widgetType).find((candidate) => candidate.id === kind?.defaultView(spec))
              return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
            }
            const loaded = loadDocument({
              format: 'dinkster-workflow', formatVersion: 1, lineage: 'exposure-gallery', root: 'g0',
              graphs: { g0: { id: 'g0', name: 'Exposure controls', nextOrdinal: 1,
                nodes: { n0: { id: 'n0', type: schema.type, values: { text: 'Quiet studio light', number: 37, choice: 'A very long selected choice with fine detail' }, controllers: { number: 'fixed', choice: 'fixed' } } },
                links: {}, nets: {}, reroutes: {},
              } },
              view: { graphs: { g0: { nodes: { n0: { position: { x: 12, y: 12 }, size: { width: 320, height: 180 } } } } } },
            })
            if (!loaded.document) throw new Error('Invalid Exposure gallery document')
            const scene = buildScene({ document: loaded.document, graphId: 'g0', tokens, measure, widgetMeasure, resolve: () => schema })
            canvas.style.width = '344px'
            canvas.style.height = `${scene.nodes[0]!.layout.height + 24}px`
            renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(registry))
            renderer.setReducedMotion(true)
            renderer.setGridVisible(false)
            renderer.setScene(scene)
            renderer.setViewport({ x: 0, y: 0, scale: 1 })
            if (example.active !== undefined) renderer.setLensCapabilities({ widgetRowAffordance: (_node, row) => ({ active: example.active, label: row.inputId }) })
            renderer.renderNow()
            canvas.dataset.ready = `${example.id}-${theme}`
          })
          onCleanup(() => { disposed = true; renderer?.dispose(); delete canvas.dataset.ready })
        })
        return <figure class="dinkster-canvas-example"><figcaption>{example.title}</figcaption><canvas ref={canvas} role="img" aria-label={example.title} data-testid={`exposure-${example.id}`} /></figure>
      }}</For>
    </div>
}
