import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { registerCatalog, type WidgetRegistry } from '@dinkster/core'
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
  hitTestBadge,
  linkControlOffset,
  sceneVisualBounds,
  type BadgeHit,
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
  canvasGalleryPages,
  galleryWidgetInputs,
  createCanvasGalleryFixture,
  type CanvasGalleryFixture,
  type CanvasGalleryPage,
} from '../../canvas/gallery/fixtures.js'
import {
  ProductButton,
  ProductDialog,
  ProductField,
  ProductPanel,
  ProductSelect,
  ProductSection,
  ProductTextInput,
} from '../src/index.js'
import { NodeLookGallery } from './node-look.js'
import { RowEditingGallery } from './row-editing.js'

type Theme = 'dark' | 'light'

const pageGroups: readonly (readonly [string, readonly CanvasGalleryPage[]])[] =
  [
    [
      'Nodes',
      [
        'anatomy',
        'idle-outline',
        'titles',
        'titles-content',
        'node-look',
        'previews',
        'badges',
      ],
    ],
    [
      'Tabs and states',
      ['tabs', 'tabs-content', 'states', 'run-editable', 'run-frozen'],
    ],
    [
      'Rows',
      [
        'widgets',
        'core-rows',
        'row-editing',
        'collection-rows',
        'widget-driven',
        'widget-offered',
        'widget-companions',
        'widget-states',
      ],
    ],
    ['Wires', ['types', 'structure']],
    ['Subgraphs', ['boundary', 'boundary-names']],
    ['Zoom', ['zoom', 'zoom-content', 'zoom-overview', 'minimap']],
  ]

/** One plain sentence per page on what to look at. */
const pageNotes: Record<CanvasGalleryPage, string> = {
  anatomy:
    'The parts of a node: title bar, pins, value rows, a section open and closed, and a node whose type is missing.',
  'idle-outline':
    'The outline of a node at rest, hovered and selected; hovering adds dots at the ends of the rows.',
  titles:
    'A title that does not fit ends in an ellipsis instead of squeezing its letters, drawn at 75 percent zoom.',
  'titles-content': 'The same titles at 50 percent zoom.',
  'node-look':
    'The same nodes in the original look and in the flat-title look the owner chose.',
  previews:
    'Previews inside nodes: image, video, audio and model, and the loading, unavailable, failed, cached and estimated states.',
  badges: 'Every badge on a node, and the toolbar above a selected node.',
  tabs: 'Tabs above a node say what it is and tabs below say what happened, drawn at 75 percent zoom in both proposed sizes; the larger tabs also start 16 px in from the side instead of 12 px.',
  'tabs-content': 'The same tabs at 50 percent zoom.',
  states:
    'Every state a node can show: hover, selection, run states, problems, mode, color, a new title and a bad value.',
  'run-editable':
    'While a workflow is being edited, only running and failed nodes are marked.',
  'run-frozen':
    'A finished run marks every node with its state, in a tab under the node.',
  widgets: 'One row of every widget kind, with its default value.',
  'core-rows':
    'Number, text, toggle, choice, color and file rows with set, empty and long values.',
  'row-editing':
    'Number, single-line text and seed rows become their own field when clicked, with their limits beside the node.',
  'collection-rows':
    'Multi-choice, list, colors and curve rows; After makes them raised rows that open an editor.',
  'widget-driven':
    'A row whose value comes from a wire is dimmed and its stored value is struck through.',
  'widget-offered':
    'Rows a node offers but does not have yet are dimmed until they are added.',
  'widget-companions':
    'A value passed down a wire shows in italics: grey when known, teal when unproven, green when estimated.',
  'widget-states':
    'One widget kind in its default, hovered, offered, invalid and empty states; choose the kind above.',
  types: 'The color of each data type on its pins and wires.',
  structure:
    'What is drawn between nodes: groups, reroutes, notes, value sources, selectors and net tags.',
  boundary: 'The input and output panels at the edges of an open subgraph.',
  'boundary-names':
    "The names on a subgraph's panels and on its collapsed node; After shows ids as written.",
  zoom: 'Three nodes at 75 percent, the smallest zoom that still draws controls.',
  'zoom-content':
    'The same nodes at 50 percent, where text stays and controls are hidden.',
  'zoom-overview':
    'The same nodes just below 50 percent, where the canvas draws its overview.',
  minimap:
    'The minimap: nodes colored by state, a bypassed node, groups, and the frame of the visible area.',
}

/** A look an example is drawn in; a page with two or more shows them side by side. */
interface Variant {
  readonly id: string
  readonly caption: string
  readonly tokens: (tokens: DesignTokens, theme: Theme) => DesignTokens
  readonly boundaryNames?: 'current' | 'ids'
}

const current: Variant = { id: 'current', caption: '', tokens: (t) => t }
const tabSizeCaption = (size: DesignTokens['badgeTab']) =>
  `After: ${size.height} px tabs, ${size.fontSize} px text`
const chipsBefore: Variant = {
  id: 'chips',
  caption: 'Before',
  tokens: (t) => ({ ...t, badgeLayout: 'chips' }),
}
const tabsAfter = (
  size: DesignTokens['badgeTab'],
  caption: string,
): Variant => ({
  id: `tabs-${size.height}`,
  caption,
  tokens: (t) => ({ ...t, badgeLayout: 'tabs', badgeTab: size }),
})

function pageVariants(page: CanvasGalleryPage): readonly Variant[] {
  switch (page) {
    case 'idle-outline':
      return [
        {
          id: 'previous',
          caption: 'Before',
          tokens: (t) => ({
            ...t,
            colors: { ...t.colors, nodeIdleOutline: t.colors.nodeOutline },
          }),
        },
        { ...current, id: 'quieter', caption: 'After' },
      ]
    case 'titles':
    case 'titles-content':
      return [
        {
          id: 'squeeze',
          caption: 'Before',
          tokens: (t) => ({ ...t, titleOverflow: 'squeeze' }),
        },
        {
          id: 'ellipsis',
          caption: 'After',
          tokens: (t) => ({ ...t, titleOverflow: 'ellipsis' }),
        },
      ]
    case 'types':
      return [
        {
          id: 'previous',
          caption: 'Before',
          tokens: (t) => ({ ...t, ...previousCanvasTypePaint }),
        },
        { ...current, caption: 'After' },
      ]
    case 'boundary-names':
      return [
        {
          ...current,
          id: 'current',
          caption: 'Before',
          boundaryNames: 'current',
        },
        { ...current, id: 'ids', caption: 'After', boundaryNames: 'ids' },
      ]
    case 'core-rows':
      return [
        {
          id: 'inset',
          caption: 'Before',
          tokens: (t) => ({ ...t, widgetRowLook: 'inset' }),
        },
        { ...current, id: 'inset-raised', caption: 'After' },
      ]
    case 'collection-rows':
      return [
        { ...current, caption: 'Before' },
        {
          id: 'inset-raised-collections',
          caption: 'After',
          tokens: (t) => ({ ...t, widgetRowLook: 'inset-raised-collections' }),
        },
      ]
    case 'tabs':
    case 'tabs-content':
      return [
        chipsBefore,
        tabsAfter(
          defaultTokens.badgeTab,
          tabSizeCaption(defaultTokens.badgeTab),
        ),
        tabsAfter(
          canvasPaintTokens.badge.roomierTab,
          tabSizeCaption(canvasPaintTokens.badge.roomierTab),
        ),
      ]
    case 'run-editable':
    case 'run-frozen':
      return [chipsBefore, tabsAfter(defaultTokens.badgeTab, 'After')]
    default:
      return [current]
  }
}

/** Room around an example for pin dots, outlines and anything drawn past its nodes. */
const PAD = 10

interface Prepared {
  readonly variant: Variant
  readonly tokens: DesignTokens
  readonly fixture: CanvasGalleryFixture
}

function ExampleCard(props: {
  page: CanvasGalleryPage
  theme: Theme
  prepared: Prepared
  example: CanvasGalleryFixture['examples'][number]
  index: number
  registry: WidgetRegistry
  onBadge: (hit: BadgeHit | undefined) => void
}) {
  let canvas!: HTMLCanvasElement
  const id = () =>
    `${props.page}-${props.index}${props.prepared.variant.id === 'current' ? '' : `-${props.prepared.variant.id}`}`
  createEffect(() => {
    const { page, theme, example } = props
    const { tokens, fixture, variant } = props.prepared
    const nodes = example.nodes?.map((index) => fixture.scene.nodes[index]!)
    const names = nodes && new Set(nodes.map((node) => node.id))
    const scene =
      nodes && names
        ? {
            ...fixture.scene,
            nodes,
            links: fixture.scene.links.filter(
              (link) =>
                link.from.kind === 'port' &&
                link.to.kind === 'port' &&
                names.has(link.from.node) &&
                names.has(link.to.node),
            ),
          }
        : fixture.scene
    const scale = fixture.scale
    const renderer = new CanvasRenderer(
      canvas,
      tokens,
      createRegistryPainter(props.registry),
    )
    renderer.setReducedMotion(true)
    renderer.setGridVisible(false)
    renderer.setScene(scene)
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
      page === 'previews'
        ? {
            ...fixture.previews,
            Image: { image, width: 320, height: 160 },
            Cached: { image, width: 320, height: 160, state: 'cached' },
            Estimate: { image, width: 320, height: 160, state: 'estimate' },
          }
        : fixture.previews,
    )
    renderer.setViewport({ x: 0, y: 0, scale })
    const measure = canvas.getContext('2d')!
    measure.font = `${tokens.fontSize}px ${tokens.fontFamily}`
    const labels = names ? [] : fixture.labels
    const box =
      page === 'minimap'
        ? { minX: 0, minY: 0, maxX: fixture.width, maxY: fixture.height }
        : sceneVisualBounds(
            // The painted scene: previews and minimized badges widen nodes.
            { ...renderer.getScene(), links: [] },
            fixture.previews,
            fixture.badges,
            (node) => renderer.getNodeBadgeBounds(node),
          )!
    const include = (x: number, y: number) => {
      box.minX = Math.min(box.minX, x)
      box.minY = Math.min(box.minY, y)
      box.maxX = Math.max(box.maxX, x)
      box.maxY = Math.max(box.maxY, y)
    }
    // Points along each link's curve: its control hull reaches far past a
    // reverse link's drawn bend. The minimap draws none of these.
    for (const link of page === 'minimap' ? [] : scene.links) {
      const dx = linkControlOffset(link.x1, link.x2)
      for (let step = 0; step <= 32; step++) {
        const t = step / 32
        const a = (1 - t) ** 3
        const b = 3 * (1 - t) ** 2 * t
        const c = 3 * (1 - t) * t ** 2
        const d = t ** 3
        include(
          a * link.x1 + b * (link.x1 + dx) + c * (link.x2 - dx) + d * link.x2,
          (a + b) * link.y1 + (c + d) * link.y2,
        )
      }
    }
    const toolbox = page === 'minimap' ? undefined : renderer.getToolboxLayout()
    if (toolbox) {
      include(toolbox.x, toolbox.y)
      include(toolbox.x + toolbox.width, toolbox.y + toolbox.height)
    }
    for (const label of labels) {
      include(label.x, label.y - tokens.fontSize)
      include(
        label.x + measure.measureText(label.text).width,
        label.y + tokens.fontSize,
      )
    }
    const pad = page === 'minimap' ? 0 : PAD
    const origin = { x: box.minX - pad, y: box.minY - pad }
    const width = Math.ceil((box.maxX - box.minX + pad * 2) * scale)
    const height = Math.ceil((box.maxY - box.minY + pad * 2) * scale)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    renderer.setViewport({ x: -origin.x * scale, y: -origin.y * scale, scale })
    renderer.renderNow()
    const paintLabels = () => {
      const context = canvas.getContext('2d')!
      context.save()
      context.setTransform(
        window.devicePixelRatio * scale,
        0,
        0,
        window.devicePixelRatio * scale,
        -origin.x * scale * window.devicePixelRatio,
        -origin.y * scale * window.devicePixelRatio,
      )
      context.font = `${tokens.fontSize}px ${tokens.fontFamily}`
      context.fillStyle = tokens.colors.label
      context.textBaseline = 'middle'
      for (const label of labels) context.fillText(label.text, label.x, label.y)
      context.restore()
    }
    paintLabels()
    let removeListeners: (() => void) | undefined
    if (tokens.badgeLayout === 'tabs') {
      const hit = (event: PointerEvent | MouseEvent) => {
        const rect = canvas.getBoundingClientRect()
        return hitTestBadge(
          renderer.getScene(),
          fixture.badges,
          (event.clientX - rect.left) / scale + origin.x,
          (event.clientY - rect.top) / scale + origin.y,
          (node) => renderer.getNodeBadgeLayout(node),
        )
      }
      const hover = (event: PointerEvent) => {
        const target = event.type === 'pointerleave' ? undefined : hit(event)
        canvas.title = target
          ? (target.overflow ?? [target.badge])
              .map((badge) => badge.glyph)
              .join(', ')
          : ''
        renderer.setOverlay({
          ...fixture.overlay,
          ...(target
            ? {
                hoveredBadge: {
                  nodeId: target.node.id,
                  badgeId: target.badge.id,
                },
              }
            : {}),
        })
        renderer.renderNow()
      }
      const activate = (event: MouseEvent) => props.onBadge(hit(event))
      canvas.addEventListener('pointermove', hover)
      canvas.addEventListener('pointerleave', hover)
      canvas.addEventListener('click', activate)
      removeListeners = () => {
        canvas.removeEventListener('pointermove', hover)
        canvas.removeEventListener('pointerleave', hover)
        canvas.removeEventListener('click', activate)
      }
    }
    if (page === 'minimap') {
      renderer.dispose()
      const context = canvas.getContext('2d')!
      context.resetTransform()
      context.scale(window.devicePixelRatio, window.devicePixelRatio)
      drawMinimap(context, {
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
    canvas.dataset.ready = `${page}-${theme}`
    canvas.dataset.variant = variant.id
    onCleanup(() => {
      removeListeners?.()
      canvas.removeAttribute('title')
      renderer.dispose()
      delete canvas.dataset.ready
    })
  })
  // A comparison names its example above the cards, so a card names its look.
  const caption = () => props.prepared.variant.caption || props.example.caption
  return (
    <figure class="dinkster-canvas-example">
      <div class="dinkster-canvas-example-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${[props.example.caption, props.prepared.variant.caption].filter(Boolean).join(', ') || props.page} in ${props.theme} theme`}
          data-testid={`canvas-${id()}`}
        />
      </div>
      <Show when={caption()}>
        <figcaption class="dinkster-metadata">{caption()}</figcaption>
      </Show>
    </figure>
  )
}

export function CanvasGallery() {
  const [theme, setTheme] = createSignal<Theme>('dark')
  const [page, setPage] = createSignal<CanvasGalleryPage>('anatomy')
  const [widgetId, setWidgetId] = createSignal('float')
  const [prepared, setPrepared] = createSignal<readonly Prepared[]>([])
  const [badgeDetails, setBadgeDetails] = createSignal<BadgeHit>()
  registerCatalog('en', english)
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  createEffect(() => {
    const currentTheme = theme()
    const currentPage = page()
    const currentWidget = widgetId()
    document.documentElement.dataset.theme = currentTheme
    setPrepared([])
    if (currentPage === 'row-editing' || currentPage === 'node-look') return
    let disposed = false
    void Promise.all([
      document.fonts.load(
        `${defaultTokens.fontSize}px ${defaultTokens.fontFamily}`,
      ),
      document.fonts.load(
        `${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
      document.fonts.load(
        `italic ${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`,
      ),
    ]).then(() => {
      if (disposed) return
      const base: DesignTokens = {
        ...defaultTokens,
        ...canvasTypePaintForTheme(currentTheme),
        colors: canvasColorsForTheme(currentTheme),
      }
      const measureContext = document.createElement('canvas').getContext('2d')!
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = registry.kind(spec.widgetType)
        const view = registry
          .viewsFor(spec.widgetType)
          .find((view) => view.id === kind?.defaultView(spec))
        return view
          ? { viewId: view.id, rows: view.measure(spec).rows }
          : undefined
      }
      setPrepared(
        pageVariants(currentPage).map((variant) => {
          const tokens = variant.tokens(base, currentTheme)
          const measure: TextMeasurer = (text, role) => {
            const title = role === 'title' || role === 'renamedTitle'
            measureContext.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
            return measureContext.measureText(text).width
          }
          return {
            variant,
            tokens,
            fixture: createCanvasGalleryFixture(
              currentPage,
              tokens,
              measure,
              widgetMeasure,
              galleryWidgetInputs.find((input) => input.id === currentWidget)!,
              variant.boundaryNames,
            ),
          }
        }),
      )
    })
    onCleanup(() => {
      disposed = true
    })
  })
  onCleanup(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  const label = (id: CanvasGalleryPage) =>
    canvasGalleryPages.find(([page]) => page === id)![1]
  const card = (
    example: CanvasGalleryFixture['examples'][number],
    index: number,
    variant: Prepared,
  ) => (
    <ExampleCard
      page={page()}
      theme={theme()}
      prepared={variant}
      example={example}
      index={index}
      registry={registry}
      onBadge={setBadgeDetails}
    />
  )
  return (
    <>
      <div class="dinkster-actions">
        <ProductField label="Page">
          {(attributes) => (
            <ProductSelect
              {...attributes}
              value={page()}
              onChange={(event) =>
                setPage(event.currentTarget.value as CanvasGalleryPage)
              }
            >
              <For each={pageGroups}>
                {([heading, pages]) => (
                  <optgroup label={heading}>
                    <For each={pages}>
                      {(id) => <option value={id}>{label(id)}</option>}
                    </For>
                  </optgroup>
                )}
              </For>
            </ProductSelect>
          )}
        </ProductField>
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
        <div class="dinkster-actions" aria-label="Canvas theme" role="group">
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
      </div>
      <ProductSection title={label(page())} description={pageNotes[page()]}>
        <Show when={page() === 'node-look'}>
          <NodeLookGallery theme={theme()} />
        </Show>
        <Show when={page() === 'row-editing'}>
          <RowEditingGallery theme={theme()} />
        </Show>
        <Show when={prepared()[0]}>
          {(first) => (
            <Show
              when={prepared().length > 1}
              fallback={
                <div class="dinkster-canvas-examples">
                  <For each={first().fixture.examples}>
                    {(example, index) => card(example, index(), first())}
                  </For>
                </div>
              }
            >
              <For each={first().fixture.examples}>
                {(example, index) => (
                  <div class="dinkster-canvas-comparison">
                    <Show when={example.caption}>
                      <h3>{example.caption}</h3>
                    </Show>
                    <div class="dinkster-canvas-examples">
                      <For each={prepared()}>
                        {(variant) => card(example, index(), variant)}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          )}
        </Show>
      </ProductSection>
      <Show when={page() === 'core-rows'}>
        <ProductSection
          title="Canvas text input"
          description="The shared text field at canvas density, not a number-editing proposal. Values remain exact strings; no parsing or editor behavior is added."
        >
          <ProductPanel>
            <ProductField label="Default field">
              {(attributes) => <ProductTextInput {...attributes} value="42" />}
            </ProductField>
            <ProductField label="Canvas seed">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  inputMode="numeric"
                  value="18446744073709551615"
                />
              )}
            </ProductField>
            <ProductField label="Canvas decimal">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  inputMode="decimal"
                  value="-0.125"
                />
              )}
            </ProductField>
            <ProductField label="Unavailable canvas field">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  disabled
                  value="24"
                />
              )}
            </ProductField>
            <ProductField label="Read-only canvas field">
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  readOnly
                  value="9007199254740993"
                />
              )}
            </ProductField>
            <ProductField
              label="Invalid canvas field"
              error="Enter a numeric value."
            >
              {(attributes) => (
                <ProductTextInput
                  {...attributes}
                  density="canvas"
                  value="not a number"
                />
              )}
            </ProductField>
          </ProductPanel>
        </ProductSection>
      </Show>
      <Show when={badgeDetails()}>
        {(details) => (
          <ProductDialog
            title="Node details"
            onDismiss={() => setBadgeDetails(undefined)}
          >
            <For each={details().overflow ?? [details().badge]}>
              {(badge) => <p class="dinkster-description">{badge.glyph}</p>}
            </For>
            <ProductButton onClick={() => setBadgeDetails(undefined)}>
              Close
            </ProductButton>
          </ProductDialog>
        )}
      </Show>
    </>
  )
}
