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
  ProductSection,
  ProductSelect,
  ProductTextInput,
  ProductToast,
  canvasSideLayout,
  type ProductEditorFramePhase,
} from '../src/index.js'
import { MARGIN, NODE_WIDTH, SIDE_ROOM } from './row-editing.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

const STORED_TARGET = { mount: 'output', prefix: 'portraits/session' }
const APPLIED_TARGET = { mount: 'archive', prefix: 'portraits/final' }
const ELSEWHERE_TARGET = { mount: 'output', prefix: 'renders/batch' }

/** The curve editor's body as an example: its settings beside the graph, as the product lays them out. */
function CurveBody(props: { changed: boolean }) {
  const points = () => (props.changed ? [[0, 600], [500, 140], [1000, 42]] : [[0, 600], [1000, 0]])
  return (
    <div class="dinkster-frame-example-curve">
      <div class="dinkster-frame-example-curve-settings">
        <ProductField label="Interpolation">
          {(attributes) => (
            <ProductSelect {...attributes}>
              <option selected={!props.changed}>Linear</option>
              <option selected={props.changed}>Monotone cubic</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductButton disabled={!props.changed}>Delete point</ProductButton>
        <p class="dinkster-metadata">Double-click the graph to add a point. Drag points to adjust them.</p>
        <p class="dinkster-metadata">Position and value range from 0 to 1.</p>
      </div>
      <svg class="dinkster-frame-example-curve-graph" viewBox="-20 -20 1040 640" role="img" aria-label="Curve graph">
        <path class="dinkster-frame-example-curve-grid" d="M0 0H1000V600H0ZM0 150H1000M0 300H1000M0 450H1000M250 0V600M500 0V600M750 0V600" />
        <path
          class="dinkster-frame-example-curve-line"
          d={props.changed ? 'M0 600C180 420 330 230 500 140S820 70 1000 42' : 'M0 600L1000 0'}
        />
        <For each={points()}>
          {([x, y], index) => (
            <circle
              cx={x}
              cy={y}
              r="14"
              data-selected={props.changed && index() === 1 ? 'true' : undefined}
            />
          )}
        </For>
      </svg>
    </div>
  )
}

/** The 3D viewer's body as an example: the viewport and its camera and placement settings. */
function ViewerBody() {
  return (
    <>
      <div class="dinkster-editor-frame-toolbar">
        <ProductButton>Record viewport</ProductButton>
      </div>
      <div class="dinkster-editor-frame-columns">
        <div class="dinkster-editor-frame-work">
          <div class="dinkster-frame-example-picture" role="img" aria-label="3D viewport" />
        </div>
        <div class="dinkster-editor-frame-panel">
          {([['Field of view', '40'], ['Model position X', '0'], ['Model scale X', '1']] as const).map(([label, value]) => (
            <ProductField label={label}>
              {(attributes) => <ProductTextInput {...attributes} inputMode="numeric" value={value} />}
            </ProductField>
          ))}
        </div>
      </div>
    </>
  )
}

/** The save target editor's body as an example: a few controls, not a picture. */
function SaveTargetBody(props: { prefix: string; error?: string }) {
  return (
    <>
      <div class="dinkster-editor-frame-toolbar">
        <ProductButton>Clear destination</ProductButton>
      </div>
      <div class="dinkster-frame-example-form">
        <ProductField label="Writable mount">
          {(attributes) => (
            <ProductSelect {...attributes}>
              <option>output</option>
              <option selected>archive</option>
            </ProductSelect>
          )}
        </ProductField>
        <ProductField
          label="Relative filename prefix"
          description="Subfolders and filename stem only. The writer adds numbering and .png."
          {...(props.error === undefined ? {} : { error: props.error })}
        >
          {(attributes) => <ProductTextInput {...attributes} value={props.prefix} />}
        </ProductField>
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
  readonly unavailable?: string
  /** An editor that can never store: its footer has one Close button. */
  readonly viewOnly?: boolean
  readonly status?: string
  /** A few controls: one centered column at the top of the body. */
  readonly form?: boolean
  readonly body: () => JSX.Element
}

const curve = (
  id: string,
  caption: string,
  phase: ProductEditorFramePhase,
  more: Partial<FrameExample> = {},
): FrameExample => ({
  id,
  caption,
  title: 'Curve - Tone curve',
  phase,
  body: () => <CurveBody changed={phase !== 'unchanged' && phase !== 'loading'} />,
  ...more,
})

const viewer = (id: string, caption: string, phase: ProductEditorFramePhase, more: Partial<FrameExample> = {}): FrameExample => ({
  id,
  caption,
  title: 'Viewport - Load 3D',
  phase,
  body: () => <ViewerBody />,
  ...more,
})

const saveTarget = (id: string, caption: string, phase: ProductEditorFramePhase, more: Partial<FrameExample> = {}): FrameExample => ({
  id,
  caption,
  title: 'Destination - Save Image',
  phase,
  form: true,
  body: () => <SaveTargetBody prefix="portraits/final" />,
  ...more,
})

const frameExamples: readonly FrameExample[] = [
  curve(
    'changed',
    "Curve editor, changed. A large editor gets the whole body for its own settings and graph; Apply is the one solid button and the only thing that stores.",
    'changed',
  ),
  curve('unchanged', 'Curve editor, unchanged. Nothing differs from the stored curve, so Apply is unavailable.', 'unchanged'),
  curve(
    'applying',
    'Curve editor, applying. Apply keeps its name and shows a spinner; the body, Cancel and the X wait for the result.',
    'changed',
    { applying: true },
  ),
  curve(
    'failed',
    'Curve editor, apply failed. The banner says why; the draft and the tools stay, and Apply can be tried again.',
    'changed',
    { error: 'Could not apply the curve. Your changes are kept.' },
  ),
  viewer(
    'loading',
    "3D viewer, loading. The frame opens at once; its body shows the shared spinner while the model loads. Apply is unavailable; Cancel and the X still close it.",
    'loading',
  ),
  viewer(
    'viewer-untouched',
    '3D viewer, not touched yet. Applying stores new captures and an undo step, so Apply waits for the first pointer action or key in the viewport, or the first use of a setting, after it opened.',
    'unchanged',
    { status: 'Nothing changed yet' },
  ),
  viewer(
    'unavailable',
    'Editor unavailable. The frame says what could not load. Apply stays unavailable; Cancel still works. An editor that can load again also offers Try again.',
    'unavailable',
    { unavailable: 'The selected model file is unavailable.' },
  ),
  saveTarget(
    'form',
    'Save target, changed. A small editor that is a few controls keeps them at their usual width in one centered column at the top, while the frame still fills the canvas area.',
    'changed',
  ),
  saveTarget(
    'invalid',
    'Save target, invalid. The problem shows under its field; Apply is unavailable until the draft can be applied.',
    'invalid',
    {
      body: () => (
        <SaveTargetBody
          prefix="../escape"
          error="Enter a relative prefix with no empty, dot or parent segments and no backslashes."
        />
      ),
    },
  ),
  {
    id: 'view-only',
    caption:
      'Editor that can never store. Image comparison only shows run results, so one Close button stands where Cancel and Apply would be.',
    title: 'Compare - Image Compare',
    phase: 'unchanged',
    viewOnly: true,
    status: 'Nothing to apply here',
    body: () => (
      <div class="dinkster-editor-frame-columns">
        <div class="dinkster-editor-frame-work">
          <div class="dinkster-frame-example-picture" role="img" aria-label="Comparison preview" />
        </div>
        <div class="dinkster-editor-frame-panel">
          {(['Divider', 'Image A', 'Image B'] as const).map((label) => (
            <ProductField label={label}>
              {(attributes) => (
                <ProductTextInput {...attributes} value={label === 'Divider' ? '50%' : 'Frame 1 of 1'} />
              )}
            </ProductField>
          ))}
        </div>
      </div>
    ),
  },
  curve(
    'narrow',
    'Curve editor in a narrow workspace, 390 px. The header and footer stay; the settings move above the graph and the body scrolls.',
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
          {...(props.example.unavailable === undefined ? {} : { unavailableLabel: props.example.unavailable })}
          {...(props.example.status === undefined ? {} : { status: props.example.status })}
          {...(props.example.viewOnly === true ? {} : { onApply: () => undefined })}
          form={props.example.form === true}
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
  readonly target: Json
  /** What the side part says first, after the editor closed. */
  readonly notice?: string
}

const rowExamples: readonly RowExample[] = [
  {
    id: 'opener',
    caption:
      'Editor row keyboard stop. Tab reached Destination, a row that opens the full editor: the outline shows where the keyboard is and the side part holds the help. Enter opens the editor.',
    target: STORED_TARGET,
  },
  {
    id: 'applied',
    caption:
      'Editor applied. The store was acknowledged, so the frame closed: the row shows the new destination, the keyboard is back on it, and one Undo takes the whole change back.',
    target: APPLIED_TARGET,
    notice: 'Applied. Undo takes it back in one step.',
  },
  {
    id: 'conflict',
    caption:
      'Editor target changed. Someone else stored a different destination while the editor was open; the old draft was dropped without writing and the keyboard is back on the row.',
    target: ELSEWHERE_TARGET,
    notice: 'The stored value changed, so the editor closed without applying. Open it again to edit the new value.',
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
      const built = createEditorFrameScene(tokens, measure, widgetMeasure, { x: MARGIN, y: MARGIN }, example.target)
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
    const row = node.layout.rows.find((row): row is WidgetRow => row.kind === 'widget' && row.valueKey === 'destination')
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
    const item = editorFrameSchema.items.find((item) => item.kind === 'input' && item.id === 'destination')
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
      <ProductSection title="In the frame">
        <div class="dinkster-canvas-examples">
          <For each={frameExamples}>{(example) => <FrameCard example={example} />}</For>
          <figure class="dinkster-canvas-example">
            <div class="dinkster-editor-frame-stage" data-closed="true" data-testid="editor-frame-removed">
              <ProductToast
                notification={{ message: 'The field this editor was editing was removed. Nothing was stored.', tone: 'info' }}
                onDismiss={() => undefined}
              />
            </div>
            <figcaption class="dinkster-metadata">
              Editor target removed. The node was removed while its editor was open, by Undo or by someone else, so the frame closed without writing. With no row left to hold the notice, the app's notice says so.
            </figcaption>
          </figure>
        </div>
      </ProductSection>
      <ProductSection title="From the row">
        <div class="dinkster-canvas-examples">
          <For each={rowExamples}>
            {(example) => <RowCard example={example} theme={props.theme} registry={registry} />}
          </For>
        </div>
      </ProductSection>
    </>
  )
}
