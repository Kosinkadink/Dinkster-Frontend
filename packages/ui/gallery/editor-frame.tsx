import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js'
import { effectiveWidgetDefault, formatWidgetValue, type Json, type WidgetRegistry } from '@dinkster/core'
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
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import { createEditorFrameScene, editorFrameSchema } from '../../canvas/gallery/fixtures.js'
import {
  CanvasRowFocus,
  CanvasSidePart,
  ProductButton,
  ProductEditorFrame,
  ProductField,
  ProductList,
  ProductListRow,
  ProductSection,
  ProductTextInput,
  canvasSideLayout,
  type ProductEditorFramePhase,
} from '../src/index.js'
import { MARGIN, NODE_WIDTH, SIDE_ROOM } from './row-editing.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

const STORED = { x: 0, y: 0, width: 1024, height: 768 }
const CHANGED = { x: 112, y: 84, width: 800, height: 600 }
const ELSEWHERE = { x: 192, y: 144, width: 640, height: 480 }

/** The crop editor's body as an example: tools, the picture and its settings. */
function CropBody(props: {
  crop: typeof STORED
  /** Width as typed, when it differs from the crop. */
  width?: string
  widthError?: string
}) {
  const field = (label: string, value: string, error?: string) => (
    <ProductField label={label} {...(error === undefined ? {} : { error })}>
      {(attributes) => <ProductTextInput {...attributes} inputMode="numeric" value={value} />}
    </ProductField>
  )
  return (
    <>
      <div class="dinkster-editor-frame-toolbar">
        <ProductButton>Reset view</ProductButton>
        <ProductButton>Fit</ProductButton>
      </div>
      <div class="dinkster-editor-frame-columns">
        <div class="dinkster-editor-frame-work">
          <div class="dinkster-frame-example-picture" role="img" aria-label="Image preview">
            <div
              class="dinkster-frame-example-crop"
              data-crop={props.crop === STORED ? 'whole' : 'part'}
            />
          </div>
        </div>
        <div class="dinkster-editor-frame-panel">
          {field('X', String(props.crop.x))}
          {field('Y', String(props.crop.y))}
          {field('Width', props.width ?? String(props.crop.width), props.widthError)}
          {field('Height', String(props.crop.height))}
        </div>
      </div>
    </>
  )
}

/** The asset browser's body as an example: where it is, a filter, the list and the selection. */
function AssetBody() {
  return (
    <>
      <div class="dinkster-editor-frame-toolbar">
        <span class="dinkster-metadata">Library / Images</span>
      </div>
      <div class="dinkster-editor-frame-columns">
        <div class="dinkster-editor-frame-work" data-align="start">
          <ProductField label="Filter assets">
            {(attributes) => <ProductTextInput {...attributes} type="search" value="p" />}
          </ProductField>
          <ProductList label="Images">
            <ProductListRow title="portrait.png" description="1024 x 1024, selected" />
            <ProductListRow title="landscape.png" description="1536 x 1024" />
            <ProductListRow title="product-shot.png" description="1024 x 1024" />
          </ProductList>
        </div>
        <div class="dinkster-editor-frame-panel">
          <span class="dinkster-metadata">Selection</span>
          <span>portrait.png</span>
          <span class="dinkster-metadata">1024 x 1024</span>
        </div>
      </div>
    </>
  )
}

interface FrameExample {
  readonly id: string
  readonly caption: string
  readonly title: string
  readonly phase: ProductEditorFramePhase
  readonly width?: 'narrow'
  readonly applying?: boolean
  readonly error?: string
  readonly retry?: boolean
  readonly body: () => JSX.Element
}

const crop = (
  id: string,
  caption: string,
  phase: ProductEditorFramePhase,
  more: Partial<FrameExample> = {},
): FrameExample => ({
  id,
  caption,
  title: 'Crop - Crop image',
  phase,
  body: () => <CropBody crop={phase === 'unchanged' ? STORED : CHANGED} />,
  ...more,
})

const frameExamples: readonly FrameExample[] = [
  crop(
    'loading',
    'Editor loading. The frame opens at once; its body shows the shared spinner and Loading preview. Apply is unavailable; Cancel and the X still close it.',
    'loading',
  ),
  crop(
    'unchanged',
    'Editor unchanged. Nothing differs from the stored crop, so there is nothing to apply.',
    'unchanged',
  ),
  crop(
    'changed',
    "Editor changed. The body keeps the editor's own tools and panels; Apply is the one solid button and the only thing that stores.",
    'changed',
  ),
  crop(
    'invalid',
    'Editor invalid. The problem shows under its field; Apply is unavailable until the draft can be applied.',
    'invalid',
    { body: () => <CropBody crop={CHANGED} width="-1" widthError="Width must be positive." /> },
  ),
  crop(
    'applying',
    'Editor applying. Apply keeps its name and shows a spinner; the body, Cancel and the X wait for the result.',
    'changed',
    { applying: true },
  ),
  crop(
    'failed',
    'Editor apply failed. The banner says why; the draft and the tools stay, and Apply can be tried again.',
    'changed',
    { error: 'Could not apply the crop. Your changes are kept.' },
  ),
  crop(
    'unavailable',
    'Editor unavailable. The frame says what could not load and offers Try again. Apply stays unavailable; Cancel still works.',
    'unavailable',
    { retry: true },
  ),
  {
    id: 'asset',
    caption:
      'Asset browser frame. The same frame hosts asset browsing: the selection is a draft until Apply, and Cancel goes back to the list it was opened from.',
    title: 'Image - Browse assets',
    phase: 'changed',
    body: () => <AssetBody />,
  },
  crop(
    'narrow',
    'Narrow workspace editor, 390 px. The header and footer stay; the settings move under the picture and the body scrolls.',
    'changed',
    { width: 'narrow' },
  ),
]

function FrameCard(props: { example: FrameExample }) {
  return (
    <figure class="dinkster-canvas-example">
      <div
        class="dinkster-editor-frame-stage"
        data-width={props.example.width ?? 'wide'}
        data-testid={`editor-frame-${props.example.id}`}
      >
        <ProductEditorFrame
          title={props.example.title}
          phase={props.example.phase}
          applying={props.example.applying === true}
          {...(props.example.error === undefined ? {} : { error: props.example.error, onDismissError: () => undefined })}
          {...(props.example.retry === true ? { onRetry: () => undefined } : {})}
          onApply={() => undefined}
          onCancel={() => undefined}
        >
          {props.example.body()}
        </ProductEditorFrame>
      </div>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  )
}

interface RowExample {
  readonly id: string
  readonly caption: string
  readonly crop: Json
  /** What the side part says first, after the editor closed. */
  readonly notice?: string
}

const rowExamples: readonly RowExample[] = [
  {
    id: 'opener',
    caption:
      'Editor row keyboard stop. Tab reached Crop, a row that opens the full editor: the outline shows where the keyboard is and the side part holds the default and the help. Enter opens the editor.',
    crop: STORED,
  },
  {
    id: 'applied',
    caption:
      'Editor applied. The store was acknowledged, so the frame closed: the row shows the new crop, the keyboard is back on it, and one Undo takes the whole change back.',
    crop: CHANGED,
    notice: 'Applied. Undo takes it back in one step.',
  },
  {
    id: 'conflict',
    caption:
      'Editor target changed. Someone else stored a different crop while the editor was open; the old draft was dropped without writing and the keyboard is back on the row.',
    crop: ELSEWHERE,
    notice: 'The stored crop changed, so the editor closed without applying. Open it again to edit the new crop.',
  },
]

function RowCard(props: { example: RowExample; theme: 'dark' | 'light'; registry: WidgetRegistry }) {
  let canvas!: HTMLCanvasElement
  let field: HTMLDivElement | undefined
  let stage!: HTMLDivElement
  const [scene, setScene] = createSignal<Scene>()
  const [insetY, setInsetY] = createSignal(0)
  const [sideSize, setSideSize] = createSignal({ width: SIDE_ROOM - MARGIN, height: 0 })
  createEffect(() => {
    const theme = props.theme
    const example = props.example
    let disposed = false
    let renderer: CanvasRenderer | undefined
    void document.fonts.load(`${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`).then(() => {
      if (disposed) return
      const tokens: DesignTokens = {
        ...defaultTokens,
        widgetEditing: 'in-row',
        ...canvasTypePaintForTheme(theme),
        colors: canvasColorsForTheme(theme),
      }
      setInsetY(tokens.rowGeometry.fieldInsetY)
      const measureContext = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return measureContext.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = props.registry.kind(spec.widgetType)
        const view = props.registry.viewsFor(spec.widgetType).find((view) => view.id === kind?.defaultView(spec))
        return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
      }
      const built = createEditorFrameScene(tokens, measure, widgetMeasure, { x: MARGIN, y: MARGIN }, example.crop)
      const node = built.nodes[0]!
      canvas.style.width = `${MARGIN + NODE_WIDTH + SIDE_ROOM}px`
      canvas.style.height = `${node.y + node.layout.height + MARGIN}px`
      renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(built)
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
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
  const focus = createMemo(() => {
    const current = scene()
    if (!current) return undefined
    const node = current.nodes[0]!
    const row = node.layout.rows.find((row): row is WidgetRow => row.kind === 'widget' && row.valueKey === 'crop')
    if (!row) return undefined
    // The keyboard's outline is the open field's: the row's field grown one pixel on every side.
    const width = (row.width ?? node.layout.width - row.inset * 2) + 2
    const screen = {
      x: node.x + row.inset - 1,
      y: node.y + row.y + insetY() - 1,
      width,
      height: row.height - insetY() * 2 + 2,
    }
    const layout = canvasSideLayout(
      screen,
      { x: 0, y: 0, width: canvas.clientWidth, height: Infinity },
      sideSize(),
      1,
      node.y + node.layout.height - screen.y + MARGIN / 2,
      screen.y - node.y + MARGIN / 2,
    )
    return { row, screen, width, ...layout }
  })
  const side = createMemo(() => {
    const target = focus()
    if (!target) return undefined
    const declared = effectiveWidgetDefault(target.row.spec)
    const item = editorFrameSchema.items.find((item) => item.kind === 'input' && item.id === 'crop')
    const help = item?.kind === 'input' ? item.tooltip : undefined
    return (
      <CanvasSidePart
        {...(props.example.notice === undefined ? {} : { notice: props.example.notice })}
        facts={declared === undefined ? [] : [{ key: 'default', value: formatWidgetValue(declared, target.row.spec) }]}
        {...(help === undefined ? {} : { help })}
      />
    )
  })
  createEffect(() => {
    const current = focus()
    if (!current || !field) return
    field.style.left = `${current.screen.x}px`
    field.style.top = `${current.screen.y}px`
    const sideBottom = Math.max(current.screen.height, current.sideTop + (current.sideMaxHeight ?? sideSize().height))
    stage.style.height = `${Math.max(canvas.clientHeight, current.screen.y + sideBottom + MARGIN)}px`
  })
  return (
    <figure class="dinkster-canvas-example">
      <div ref={stage} class="dinkster-canvas-example-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${props.example.id} in ${props.theme} theme`}
          data-testid={`editor-frame-row-${props.example.id}`}
        />
        <Show when={focus()}>
          {(current) => (
            <CanvasRowFocus
              ref={(element) => (field = element)}
              look="flat-title"
              rowWidth={current().width}
              place={current().place}
              sideTop={current().sideTop}
              {...(current().sideMaxHeight === undefined ? {} : { sideMaxHeight: current().sideMaxHeight! })}
              onSideSize={setSideSize}
              {...(side() === undefined ? {} : { side: side()! })}
            />
          )}
        </Show>
      </div>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  )
}

/** Every labeled state of the full editor frame, drawn with the product's own frame, controls and renderer. */
export function EditorFrameGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <>
      <ProductSection title="From the row">
        <div class="dinkster-canvas-examples">
          <For each={rowExamples}>
            {(example) => <RowCard example={example} theme={props.theme} registry={registry} />}
          </For>
        </div>
      </ProductSection>
      <ProductSection title="In the frame">
        <div class="dinkster-canvas-examples">
          <For each={frameExamples}>{(example) => <FrameCard example={example} />}</For>
        </div>
      </ProductSection>
    </>
  )
}
