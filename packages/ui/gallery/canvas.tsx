import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { registerCatalog } from '@dinkster/core'
import english from '../../app/src/locales/en.json'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasTypePaintForTheme,
  canvasPaintTokens,
  createRegistryPainter,
  defaultTokens,
  previousCanvasTypePaint,
  drawMinimap,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  canvasGalleryPages,
  galleryWidgetInputs,
  createCanvasGalleryFixture,
  type CanvasGalleryPage,
} from '../../canvas/gallery/fixtures.js'
import {
  ProductButton,
  ProductField,
  ProductSelect,
  ProductSection,
} from '../src/index.js'

export function CanvasGallery() {
  const [theme, setTheme] = createSignal<'dark' | 'light'>('dark')
  const [page, setPage] = createSignal<CanvasGalleryPage>('anatomy')
  const [widgetId, setWidgetId] = createSignal('float')
  const [outline, setOutline] = createSignal('quieter')
  const [typeLook, setTypeLook] = createSignal('current')
  let canvas!: HTMLCanvasElement
  registerCatalog('en', english)
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  createEffect(() => {
    const currentTheme = theme()
    const currentPage = page()
    const currentWidget = widgetId()
    const currentOutline = outline()
    const currentTypeLook = typeLook()
    document.documentElement.dataset.theme = currentTheme
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void document.fonts.ready.then(() => {
      if (disposed) return
      const colors = canvasColorsForTheme(currentTheme)
      const tokens = {
        ...defaultTokens,
        ...(currentPage === 'types' && currentTypeLook === 'previous'
          ? previousCanvasTypePaint
          : canvasTypePaintForTheme(currentTheme)),
        colors: {
          ...colors,
          ...(currentPage === 'idle-outline' && currentOutline === 'previous'
            ? { nodeIdleOutline: colors.nodeOutline }
            : {}),
        },
      }
      const measureContext = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        measureContext.font = `${role === 'title' || role === 'renamedTitle' ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${role === 'title' || role === 'renamedTitle' ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return measureContext.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = registry.kind(spec.widgetType)
        const view = registry
          .viewsFor(spec.widgetType)
          .find((view) => view.id === kind?.defaultView(spec))
        return view
          ? { viewId: view.id, rows: view.measure(spec).rows }
          : undefined
      }
      const fixture = createCanvasGalleryFixture(
        currentPage,
        tokens,
        measure,
        widgetMeasure,
        galleryWidgetInputs.find((input) => input.id === currentWidget)!,
      )
      canvas.style.width = `${fixture.width}px`
      canvas.style.height = `${fixture.height}px`
      renderer = new CanvasRenderer(
        canvas,
        tokens,
        createRegistryPainter(registry),
      )
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(fixture.scene)
      renderer.setNodeStates(fixture.states)
      renderer.setBadges(fixture.badges)
      renderer.setOverlay(fixture.overlay)
      renderer.setRowMarks(fixture.rowMarks)
      renderer.setCompanions(fixture.companions)
      renderer.setToolbox(fixture.toolbox)
      const image = document.createElement('canvas')
      image.width = 320
      image.height = 160
      const imageContext = image.getContext('2d')!
      imageContext.fillStyle = tokens.colors.nodeHeader
      imageContext.fillRect(0, 0, 320, 160)
      imageContext.fillStyle = tokens.colors.selection
      imageContext.beginPath()
      imageContext.arc(210, 65, 42, 0, Math.PI * 2)
      imageContext.fill()
      renderer.setNodePreviews(
        currentPage === 'previews'
          ? {
              ...fixture.previews,
              Image: { image, width: 320, height: 160 },
              Cached: { image, width: 320, height: 160, state: 'cached' },
              Estimate: { image, width: 320, height: 160, state: 'estimate' },
            }
          : fixture.previews,
      )
      renderer.setViewport({ x: 0, y: 0, scale: fixture.scale })
      renderer.renderNow()
      const labelContext = canvas.getContext('2d')!
      labelContext.save()
      labelContext.setTransform(
        window.devicePixelRatio * fixture.scale,
        0,
        0,
        window.devicePixelRatio * fixture.scale,
        0,
        0,
      )
      labelContext.font = `${tokens.fontSize}px ${tokens.fontFamily}`
      labelContext.fillStyle = tokens.colors.label
      labelContext.textBaseline = 'middle'
      for (const label of fixture.labels)
        labelContext.fillText(label.text, label.x, label.y)
      labelContext.restore()
      if (currentPage === 'minimap') {
        renderer.dispose()
        renderer = undefined
        const ctx = canvas.getContext('2d')!
        ctx.resetTransform()
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
        drawMinimap(ctx, {
          width: fixture.width,
          height: fixture.height,
          tokens,
          nodes: fixture.scene.nodes.map((node) => ({
            x: node.x,
            y: node.y,
            width: node.layout.width,
            height: node.layout.height,
            ...(fixture.states[node.id]
              ? { state: fixture.states[node.id]!.state }
              : {}),
            bypassed: node.node.mode === 'bypassed',
            ...(node.color ? { color: node.color } : {}),
          })),
          groups: fixture.scene.groups,
          links: fixture.scene.links.map((link) => ({
            from: { x: link.x1, y: link.y1 },
            to: { x: link.x2, y: link.y2 },
          })),
          reroutes: fixture.scene.reroutes,
          viewport: {
            x: 0,
            y: 0,
            scale: 1,
            canvasWidth: 600,
            canvasHeight: 350,
          },
        })
      }
      canvas.dataset.ready = `${currentPage}-${currentTheme}`
      canvas.dataset.widget = currentWidget
      canvas.dataset.outline = currentOutline
      canvas.dataset.typeLook = currentTypeLook
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset.ready
    })
  })
  onCleanup(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  return (
    <>
      <div class="dinkster-actions" aria-label="Canvas theme">
        <ProductButton
          aria-pressed={theme() === 'dark'}
          onClick={() => setTheme('dark')}
        >
          Dark theme
        </ProductButton>
        <ProductButton
          aria-pressed={theme() === 'light'}
          onClick={() => setTheme('light')}
        >
          Light theme
        </ProductButton>
      </div>
      <nav class="dinkster-actions" aria-label="Canvas pages">
        <For each={canvasGalleryPages}>
          {([id, label]) => (
            <ProductButton
              aria-pressed={page() === id}
              onClick={() => setPage(id)}
            >
              {label}
            </ProductButton>
          )}
        </For>
      </nav>
      <Show when={page() === 'idle-outline'}>
        <ProductField label="Outline look">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={outline()}
              onChange={(event) => setOutline(event.currentTarget.value)}
            >
              <option value="previous">Previous outline</option>
              <option value="quieter">Quieter outline (current)</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          The app uses the quieter idle outline from the shared subtle border.
          Compare it with the previous outline. Hover and selection paint stay
          unchanged.
        </p>
      </Show>
      <Show when={page() === 'types'}>
        <ProductField label="Type colors">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={typeLook()}
              onChange={(event) => setTypeLook(event.currentTarget.value)}
            >
              <option value="current">Contrast-adjusted colors (current)</option>
              <option value="previous">Previous colors</option>
            </ProductSelect>
          )}
        </ProductField>
        <p class="dinkster-description">
          Current type colors keep each type's hue and reach at least 3:1 contrast
          against the node body. Previous colors overrides only this comparison;
          app colors and other gallery pages keep the current palette.
        </p>
      </Show>
      <Show when={page() === 'widget-states'}>
        <ProductField label="Widget kind">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={widgetId()}
              onChange={(event) => setWidgetId(event.currentTarget.value)}
            >
              <For each={galleryWidgetInputs}>
                {(input) => <option value={input.id}>{input.id}</option>}
              </For>
            </ProductSelect>
          )}
        </ProductField>
      </Show>
      <ProductSection
        title={canvasGalleryPages.find(([id]) => id === page())![1]}
      >
        <p class="dinkster-description">
          Fixed examples painted by the production CanvasRenderer and registered
          widget views, without a backend.
        </p>
        <div class="dinkster-table-scroll">
          <canvas
            ref={canvas}
            role="img"
            aria-label={`${page()} in ${theme()} theme`}
          />
        </div>
      </ProductSection>
    </>
  )
}
