import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { loadDocument, type Json, type NodeSchema, type WidgetRegistry } from '@dinkster/core'
import {
  CanvasRenderer,
  buildScene,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import { assetRowThumbnails, createPreviewLoader } from '../../app/src/node-previews.js'
import { formatSize } from '../../app/src/asset-browser/helpers.js'
import pictureUrl from '../../e2e/fixtures/media-overlay/with_metadata.png?url'
import videoUrl from '../../e2e/fixtures/media-overlay/visible-2s.webm?url'
import { CanvasEditorSpace, CanvasFileCopy, ProductSection } from '../src/index.js'

const asset = (name: string, mediaType = 'image/png', fill = 'a'): Json => ({
  digest: `blake3:${fill.repeat(64)}`, name, mediaType, size: 100, virtualPath: `input/${name}`,
})
const picture = asset('a.png')
const video = asset('clip.webm', 'video/webm', 'b')
const sound = asset('sound.wav', 'audio/wav', 'c')
const files = [picture, video, asset('c.png', 'image/png', 'd'), asset('d.png', 'image/png', 'e'), asset('e.png', 'image/png', 'f')]
const mixed = ['image/*', 'video/*', 'audio/*']

interface FileExample {
  readonly title: string
  readonly value: Json
  readonly accept: readonly string[]
  readonly width?: number
  readonly mode?: 'pending' | 'expected' | 'estimate' | 'stale' | 'unknown'
  readonly copy?: 'copying' | 'waiting' | 'checking'
}

const examples: readonly FileExample[] = [
  { title: 'One picture', value: picture, accept: ['image/*'] },
  { title: 'One video', value: video, accept: ['video/*'] },
  { title: 'Several names fit', value: [picture, video], accept: mixed },
  { title: 'More files than room', value: files, accept: mixed, width: 300 },
  { title: 'Picture, sound and video', value: [picture, sound, video], accept: mixed },
  { title: 'Pictures still loading', value: [picture, video], accept: mixed, mode: 'pending' },
  { title: 'Only the count fits', value: files, accept: mixed, width: 150 },
  { title: 'The first name is cut', value: [asset('a-very-long-checkpoint-name.png'), video], accept: mixed, width: 300 },
  { title: 'Files brought by a wire', value: [video, picture], accept: mixed, mode: 'expected' },
  { title: 'Estimated incoming files', value: [picture, video], accept: mixed, mode: 'estimate' },
  { title: 'Earlier incoming files', value: [video, picture], accept: mixed, mode: 'stale' },
  { title: 'Incoming value not known', value: picture, accept: ['image/*'], mode: 'unknown' },
  { title: 'Sound has no picture', value: sound, accept: ['audio/*'] },
  { title: 'No picture chosen', value: null, accept: ['image/*'] },
  { title: 'No video chosen', value: null, accept: ['video/*'] },
  { title: 'No sound chosen', value: null, accept: ['audio/*'] },
  { title: 'No 3D file chosen', value: null, accept: ['model/gltf-binary'] },
  { title: 'No mixed file chosen', value: null, accept: mixed },
  { title: 'Copying a video', value: asset('diner_take3.mp4', 'video/mp4'), accept: ['video/*'], width: 340, copy: 'copying' },
  { title: 'Copying in a narrow node', value: asset('diner_take3.mp4', 'video/mp4'), accept: ['video/*'], width: 184, copy: 'copying' },
  { title: 'Waiting to publish a video', value: asset('diner_take3.mp4', 'video/mp4'), accept: ['video/*'], width: 340, copy: 'waiting' },
  { title: 'Checking a video', value: asset('diner_take3.mp4', 'video/mp4'), accept: ['video/*'], width: 340, copy: 'checking' },
]

function FilePreviewCard(props: { example: FileExample; theme: 'dark' | 'light'; registry: WidgetRegistry }) {
  let canvas!: HTMLCanvasElement
  const [stopped, setStopped] = createSignal(false)
  const [copyRow, setCopyRow] = createSignal<{ x: number; y: number; width: number }>()
  createEffect(() => {
    const { example, theme, registry } = props
    const copying = example.copy !== undefined && !stopped()
    const shown = stopped() ? null : example.value
    const width = example.width ?? 460
    const tokens: DesignTokens = {
      ...defaultTokens,
      ...canvasTypePaintForTheme(theme),
      colors: canvasColorsForTheme(theme),
    }
    const schema: NodeSchema = {
      type: 'Closed files', displayName: 'Closed files', category: 'gallery', source: 'v3', isOutputNode: false,
      body: [{
        kind: 'input', id: 'files', displayName: 'files', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: [...example.accept] }, default: null },
      }],
    }
    const wired = example.mode !== undefined && example.mode !== 'pending'
    const source: NodeSchema = {
      ...schema, type: 'File source', displayName: 'File source',
      body: [{ kind: 'output', id: 'files', type: { kind: 'concrete', name: 'ASSET' } }],
    }
    const loaded = loadDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'canvas-gallery', root: 'gallery',
      graphs: { gallery: {
        id: 'gallery', name: 'Gallery', nextOrdinal: 3,
        nodes: { files: { id: 'files', type: schema.type, values: { files: wired ? sound : shown } },
          ...(wired ? { source: { id: 'source', type: source.type, values: {} } } : {}) },
        links: wired ? { wire: { id: 'wire', from: { node: 'source', port: 'files' }, to: { node: 'files', port: 'files' } } } : {},
        nets: {}, reroutes: {},
      } },
      view: { graphs: { gallery: { nodes: {
        files: { position: { x: 16, y: 16 }, size: { width, height: 0 } },
        ...(wired ? { source: { position: { x: -400, y: 16 } } } : {}),
      } } } },
    })
    if (!loaded.document) throw new Error('Invalid closed-file gallery document')
    const context = document.createElement('canvas').getContext('2d')!
    const measure: TextMeasurer = (text, role) => {
      const title = role === 'title' || role === 'renamedTitle'
      context.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
      return context.measureText(text).width
    }
    const widgetMeasure: WidgetMeasure = (spec) => {
      const kind = registry.kind(spec.widgetType)
      const view = registry.viewsFor(spec.widgetType).find((view) => view.id === kind?.defaultView(spec))
      return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
    }
    const scene = buildScene({ document: loaded.document, graphId: 'gallery', tokens, measure, widgetMeasure,
      ...(copying ? { fieldStatus: { files: { files:
        tokens.rowHeight * (example.copy === 'copying' ? 2 : 1) + canvasPaintTokens.node.editorSpace.pad * 2 } } } : {}),
      resolve: (type) => type === schema.type ? schema : source })
    const node = scene.nodes.find((item) => item.id === 'files')!
    const status = node.layout.rows.find((row) => row.kind === 'fieldStatus' && row.valueKey === 'files')
    const pad = canvasPaintTokens.node.editorSpace.pad
    setCopyRow(status?.kind === 'fieldStatus' ? {
      x: node.x + status.inset - pad,
      y: node.y + status.y,
      width: width - status.inset * 2 + pad * 2,
    } : undefined)
    canvas.style.width = `${width + 32}px`
    canvas.style.height = `${node.layout.height + 32}px`
    const renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(registry))
    renderer.setReducedMotion(true)
    renderer.setGridVisible(false)
    renderer.setScene({ ...scene, nodes: [node], links: [] })
    renderer.setViewport({ x: 0, y: 0, scale: 1 })
    if (example.mode === 'expected' || example.mode === 'estimate' || example.mode === 'stale')
      renderer.setCompanions({ files: { files: { value: example.value, state: example.mode } } })
    else if (example.mode === 'unknown')
      renderer.setCompanions({ files: { files: { value: null, state: 'unknown' } } })
    const loader = createPreviewLoader({
      assetUrlForExecution: (_ref, digest) => digest,
      assetUrlForInput: (digest) => digest === `blake3:${'b'.repeat(64)}` ? videoUrl : pictureUrl,
      onDecoded: () => draw(),
    })
    const draw = () => {
      const thumbnails = example.mode === 'pending' ? [null, null] : example.mode === 'unknown' ? undefined
        : assetRowThumbnails(shown, loader, registry, width)
      renderer.setEditorSummaries(example.mode === 'unknown' ? {} : { files: { files:
        { ...(thumbnails === undefined ? {} : { thumbnails }), ...(wired ? { value: example.value } : {}) } } })
      renderer.renderNow()
      if (example.mode === 'pending' || !thumbnails?.includes(null)) canvas.dataset.ready = `file-preview-${theme}`
    }
    draw()
    onCleanup(() => { loader.dispose?.(); renderer.dispose(); delete canvas.dataset.ready })
  })
  return <figure class="dinkster-canvas-example"><figcaption>{props.example.title}</figcaption>
    <Show when={props.example.copy !== undefined} fallback={<canvas ref={canvas} />}>
    <div class="dinkster-canvas-example-stage">
      <canvas ref={canvas} />
      <Show when={copyRow()}>{(row) => <CanvasEditorSpace ref={(element) => {
        element.style.left = `${row().x}px`
        element.style.top = `${row().y}px`
        element.style.width = `${row().width}px`
      }}>
        <CanvasFileCopy state={props.example.copy === 'checking'
          ? { phase: 'checking', label: 'Checking the file' }
          : props.example.copy === 'waiting'
          ? { phase: 'waiting', label: 'Waiting for another file', stopLabel: 'Stop', onStop: () => setStopped(true) }
          : { phase: 'copying', label: 'Copying to', mount: 'input', amount: `${formatSize(210 * 1048576)} of ${formatSize(512 * 1048576)}`,
              description: `Copying to input, ${formatSize(210 * 1048576)} of ${formatSize(512 * 1048576)}`, value: 210 / 512,
              stopLabel: 'Stop', onStop: () => setStopped(true) }} />
      </CanvasEditorSpace>}</Show>
    </div>
    </Show>
  </figure>
}

export function RowFilePreviewsGallery(props: { theme: 'dark' | 'light'; registry: WidgetRegistry }) {
  return <ProductSection title="Thumbnails beside file names" description="Each visible picture or video name has its own preview. Files hidden in the count have no picture. A pending preview reserves its square; sound has no square. The icon at the row's start follows the field's accepted kinds, even before a file is chosen.">
    <div class="dinkster-canvas-examples"><For each={examples}>{(example) => <FilePreviewCard example={example} theme={props.theme} registry={props.registry} />}</For></div>
  </ProductSection>
}
