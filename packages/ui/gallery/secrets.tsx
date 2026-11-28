import { Show, createSignal, onMount, onCleanup } from 'solid-js'
import { loadDocument, registerCatalog, type NodeSchema } from '@dinkster/core'
import { CanvasRenderer, buildScene, createRegistryPainter, defaultTokens, canvasColorsForTheme, canvasTypePaintForTheme, canvasPaintTokens, type TextMeasurer } from '@dinkster/canvas'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import english from '../../app/src/locales/en.json'
import { ProductButton, ProductCheckbox, ProductSecretDialog, ProductSection, ProductToast } from '../src/index.js'

function SecretRows() {
  let canvas!: HTMLCanvasElement
  let renderer: CanvasRenderer | undefined
  let disposed = false
  onMount(() => {
    registerCatalog('en', english)
    void document.fonts.ready.then(async () => {
      await document.fonts.load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`)
      if (disposed) return
      const registry = createWidgetRegistry()
      registerCoreWidgets(widgetRegistrationDoors(registry))
      const tokens = { ...defaultTokens, widgetRowLook: 'raised-editors' as const,
        ...canvasTypePaintForTheme('dark'), colors: canvasColorsForTheme('dark') }
      const context = canvas.getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        context.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return context.measureText(text).width
      }
      const schema: NodeSchema = { type: 'Caption image', displayName: 'Caption image', source: 'v3', category: 'gallery', isOutputNode: false,
        body: [
          { kind: 'input', id: 'caption', displayName: 'Caption service', type: { kind: 'concrete', name: 'STRING' }, secret: true, socketless: true, optional: false,
            widget: { widgetType: 'SECRET', options: {}, default: 'caption-service' } },
          { kind: 'input', id: 'vision', displayName: 'Vision service', type: { kind: 'concrete', name: 'STRING' }, secret: true, socketless: true, optional: false,
            widget: { widgetType: 'SECRET', options: {}, default: 'vision-service' } },
          { kind: 'input', id: 'translation', displayName: 'Translation', type: { kind: 'concrete', name: 'STRING' }, secret: true, socketless: true, optional: true,
            widget: { widgetType: 'SECRET', options: {}, default: 'translation-service' } },
        ] }
      const loaded = loadDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'secret-gallery', root: 'gallery',
        graphs: { gallery: { id: 'gallery', name: 'Gallery', nextOrdinal: 2,
          nodes: { caption: { id: 'caption', type: schema.type, values: {} } }, links: {}, nets: {}, reroutes: {} } },
        view: { graphs: { gallery: { nodes: { caption: { position: { x: 16, y: 16 }, size: { width: 450, height: 0 } } } } } } })
      if (!loaded.document) throw new Error('Invalid secret gallery document')
      const scene = buildScene({ document: loaded.document, graphId: 'gallery', resolve: () => schema, tokens, measure,
        widgetMeasure: (spec) => {
          const kind = registry.kind(spec.widgetType)
          const view = registry.viewsFor(spec.widgetType).find((entry) => entry.id === kind?.defaultView(spec))
          return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
        } })
      canvas.style.width = `${scene.nodes[0]!.layout.width + 32}px`
      canvas.style.height = `${scene.nodes[0]!.layout.height + 32}px`
      renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(registry))
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(scene)
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.setWidgetFacts({ SECRET: { 'caption-service': true, 'vision-service': false, 'translation-service': false } })
      renderer.renderNow()
      canvas.dataset.ready = 'true'
    })
  })
  onCleanup(() => { disposed = true; renderer?.dispose() })
  return <ProductSection title="Secret rows">
    <p class="dinkster-description">A set credential, a required missing credential, and an optional missing credential. These rows hold names only.</p>
    <div class="dinkster-canvas-examples">
      <figure class="dinkster-canvas-example">
        <canvas ref={canvas} role="img" aria-label="Secret rows" />
      </figure>
    </div>
  </ProductSection>
}

export function SecretsGallery() {
  const [open, setOpen] = createSignal(false)
  const [admin, setAdmin] = createSignal(false)
  const [reject, setReject] = createSignal(false)
  const [personal, setPersonal] = createSignal(false)
  const [fallback, setFallback] = createSignal(false)
  const [rejectRemoval, setRejectRemoval] = createSignal(false)
  const [notification, setNotification] = createSignal<{ message: string }>()
  return (<>
    <SecretRows />
    <ProductSection title="Set a secret">
      <p class="dinkster-description">The host form never reads an existing credential. This gallery uses a simulated save and stores no value.</p>
      <ProductCheckbox label="Administrator" checked={admin()} onChange={(event) => setAdmin(event.currentTarget.checked)} />
      <ProductCheckbox label="Reject the next secret save" checked={reject()} onChange={(event) => setReject(event.currentTarget.checked)} />
      <ProductCheckbox label="Personal value set" checked={personal()} onChange={(event) => setPersonal(event.currentTarget.checked)} />
      <ProductCheckbox label="Deployment fallback available" checked={fallback()} onChange={(event) => setFallback(event.currentTarget.checked)} />
      <ProductCheckbox label="Reject the next removal" checked={rejectRemoval()} onChange={(event) => setRejectRemoval(event.currentTarget.checked)} />
      <ProductButton onClick={() => setOpen(true)}>Set caption-service</ProductButton>
      <Show when={open()}>
        <ProductSecretDialog name="caption-service" names={['caption-service', 'caption-service-work', 'image-host']} contextKey="gallery-account-on-this-host" canManageDeployment={admin()}
          onRead={async (name) => ({ set: name !== 'caption-service' || personal() || fallback(),
            source: name !== 'caption-service' || personal() ? 'account' : fallback() ? 'deployment' : null,
            fallback: name === 'caption-service' && personal() && fallback() })}
          onUse={async () => {}}
          onRemove={async () => {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 600))
            if (rejectRemoval()) {
              setRejectRemoval(false)
              throw new Error('Synthetic private refusal')
            }
            setPersonal(false)
          }}
          onSave={async () => {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 600))
            if (reject()) {
              setReject(false)
              return 'Secret access is not permitted.'
            }
          }}
          onCancel={() => setOpen(false)}
          onSaved={() => {
            setOpen(false)
            setNotification({ message: 'Secret set' })
          }} />
      </Show>
      <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
    </ProductSection>
  </>)
}
