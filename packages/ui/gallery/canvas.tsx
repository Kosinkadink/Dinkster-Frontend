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
import { earlierWidgetRows } from '../../canvas/gallery/earlier-widget-rows.js'
import {
  ProductButton,
  ProductDialog,
  ProductField,
  ProductLink,
  ProductPanel,
  ProductSelect,
  ProductSection,
  ProductTextInput,
  type ProductNavigationGroup,
} from '../src/index.js'
import { NodeLookGallery } from './node-look.js'
import { ColorEditingGallery } from './color-editing.js'
import { RowEditingGallery } from './row-editing.js'
import { RowListsGallery } from './row-lists.js'

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
        'title-suffix',
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
        'row-lists',
        'color-editing',
        'collection-rows',
        'editor-rows',
        'widget-driven',
        'widget-offered',
        'widget-companions',
        'widget-taps',
        'widget-states',
        'text-boxes',
      ],
    ],
    ['Wires', ['types', 'structure']],
    ['Subgraphs', ['boundary', 'boundary-names']],
    ['Flow nodes', ['switch-primitive', 'small-flow-nodes', 'type-conflict']],
    ['Zoom', ['zoom', 'zoom-content', 'zoom-overview', 'minimap']],
  ]

const pageOrder = pageGroups.flatMap(([, pages]) => pages)

const pageLabel = (id: CanvasGalleryPage) =>
  canvasGalleryPages.find(([page]) => page === id)![1]

/** A page's own link; the gallery reads it back when the page opens. */
export const canvasPageHref = (id: CanvasGalleryPage) => `?page=${id}#canvas`

/** The Canvas pages under their headings, for the gallery's side list. */
export const canvasNavigationGroups: readonly ProductNavigationGroup[] =
  pageGroups.map(([label, pages]) => ({
    label,
    items: pages.map((id) => ({
      label: pageLabel(id),
      href: canvasPageHref(id),
    })),
  }))

const parsePage = (search: string) => {
  const id = new URLSearchParams(search).get('page')
  return pageOrder.find((page) => page === id)
}

// The selected page is kept in the address, so a page can be linked.
const [canvasPage, setCanvasPageSignal] = createSignal<CanvasGalleryPage>(
  parsePage(window.location.search) ?? 'anatomy',
)
export { canvasPage }

const writePageToAddress = (id: CanvasGalleryPage) => {
  const url = new URL(window.location.href)
  url.searchParams.set('page', id)
  window.history.replaceState(window.history.state, '', url)
}

/** Opens a page from its link (`?page=<id>#canvas`); unknown ids are ignored. */
export function selectCanvasPage(href: string) {
  const id = parsePage(href.slice(0, href.indexOf('#') >>> 0))
  if (id === undefined) return
  setCanvasPageSignal(id)
  writePageToAddress(id)
}

/** One plain sentence per page on what to look at. */
const pageNotes: Record<CanvasGalleryPage, string> = {
  anatomy:
    'The parts of a node: title bar with its minimize arrow, pins, value rows, a section open and closed, a subgraph node with its mark, and a node whose type is missing.',
  'idle-outline':
    'The outline of a node at rest, hovered and selected; hovering adds dots at the ends of the rows.',
  titles:
    'A title that does not fit ends in an ellipsis instead of squeezing its letters, drawn at 75 percent zoom.',
  'titles-content': 'The same titles at 50 percent zoom.',
  'title-suffix':
    'A node\'s declared title suffix, worked out from its values ("20 steps, euler"), one space after the title in the row names\' dim regular type: beside a pack title, beside a renamed title, cut first on a narrow node ("20 steps with the euler sampler"), and on a minimized node.',
  'node-look':
    'The same nodes in the original look and in the flat-title look the owner chose.',
  previews:
    'Every node that can show a preview has a "Preview" caption row: before a picture, with one (open, and folded with the caption under the pointer), loading, failed, cached and estimated, and a text result open and folded. A minimized node keeps the caption folded while it has a picture or a text result; its caption opens the picture at its open height.',
  badges: 'Every badge on a node, and the toolbar above a selected node.',
  tabs: 'Tabs above a node say what it is and tabs below say what happened, 3 px off the node and flush with its edges, drawn at 75 percent zoom; only the subgraph mark stays in the title bar. Icons: Queued clock, Running play, Finished check, Cached database, Skipped ban, Failed and Error circle-x, Unavailable unplug, Warning triangle-alert, Blocked lock, children list-tree, Log scroll-text, iteration repeat, Muted volume-x, Bypassed forward, Deprecated archive, subgraph boxes.',
  'tabs-content': 'The same tabs at 50 percent zoom.',
  states:
    'Every state a node can show: hover, selection, run states, problems, mode, color, a new title, minimized, the minimize arrow under the pointer and a bad value.',
  'run-editable':
    'While a workflow is being edited, only running and failed nodes are marked.',
  'run-frozen':
    'A finished run marks every node with its state, in a tab under the node.',
  widgets:
    'One row of every widget kind, with its default value; After raises the rows that open an editor and puts a color in an inset field.',
  'core-rows':
    'Number, text, toggle, choice, color and file rows with set, empty and long values.',
  'row-editing':
    'Number, single-line text and seed rows become their own field when clicked, with their limits beside the node.',
  'row-lists':
    'A choice, and a list a pack fills from a lookup, open one filtered list in their own row: the value becomes the filter, a check marks the stored option and the grey highlight the candidate. Opening, filtering, refreshing or Tab never changes the stored value; only Enter or a click picks. Model and media fields are asset fields and keep their own editor; a list of plain names is what a pack\'s own dropdown shows.',
  'color-editing':
    'A color row becomes its own field when clicked, with a picker under it and what Enter stores beside it. Nothing is stored until the field is left. The saved color is a line in the side part beside the field, read here as the tooltip asked for, while the draft differs from it; nothing marks it by the name.',
  'collection-rows':
    'Multi-choice, list, colors and curve rows; After raises the rows that open an editor and draws the curve in its row.',
  'editor-rows':
    'Every row that opens an editor, chosen and empty; After raises each with an icon for its kind and says what an empty one asks for.',
  'widget-driven':
    'A row whose value comes from a wire is dimmed and its stored value is struck through.',
  'widget-offered':
    'Rows a node offers but does not have yet are dimmed until they are added.',
  'widget-companions':
    'A value passed down a wire shows in italics: grey when known, teal when unproven, green when estimated.',
  'widget-taps':
    'A field feeds another node through a pin at the right end of its row: at rest, pointed at, with a wire dragged toward it and wired, beside each kind of row, and where it does not work today.',
  'widget-states':
    'One widget kind in its default, hovered, offered, invalid and empty states; choose the kind above.',
  'text-boxes':
    'Each text box keeps its own height, set by dragging the short bar on its bottom edge; text that does not fit shows the quiet scrollbar. The middle node shows the bar under the pointer; the right one was made taller by its own edge, which sizes only its last box.',
  types:
    'The color of each data type on its pins and wires, and the pin of an input that accepts a list before and after its type is matched.',
  structure:
    'What is drawn between nodes: groups, reroutes, notes, value sources, selectors and net tags.',
  boundary:
    "The panels at the edges of a subgraph entered through its node. The Inputs panel carries that node's fields, which it sends down their wires; strength, the edge dropdown and the grain value source are shown on the node without a wire and carry the subgraph icon, as does the grain pill.",
  'boundary-names':
    "The names on a subgraph's panels and on its collapsed node; After shows ids as written.",
  zoom: 'Three nodes at 75 percent, the smallest zoom that still draws controls.',
  'zoom-content':
    'The same nodes at 50 percent, where text stays and controls are hidden.',
  'zoom-overview':
    'The same nodes just below 50 percent, where the canvas draws its overview.',
  minimap:
    'The minimap: nodes colored by state, a bypassed node, groups, and the frame of the visible area.',
  'switch-primitive':
    'Switch and Primitive as ordinary nodes, in every state of the design: a Switch picks one of its named branches for each subgraph node, and a Primitive holds a value with its limits as its own fields. They replace the value source pill and the selector box shown in the second card.',
  'small-flow-nodes':
    'Or else, Has value and Only if as ordinary nodes, one card per state of the design: they let a graph deal with nothing on purpose. A value on a wire is not painted by the canvas, so each caption names the values. A skipped node shows the Skipped state the canvas draws today, and a node that was not run shows no state, as today.',
  'type-conflict':
    'Inputs that must share one type but are fed two different types: an error on the node, its wires and in Problems, and a refusal before the run. By hand such a wire is not accepted.',
}

/** A look an example is drawn in; a page with two or more shows them side by side. */
interface Variant {
  readonly id: string
  readonly caption: string
  readonly tokens: (tokens: DesignTokens, theme: Theme) => DesignTokens
  readonly boundaryNames?: 'current' | 'ids'
  /** Widget views the look draws with, when not the product's own. */
  readonly registry?: (registry: WidgetRegistry) => WidgetRegistry
}

const current: Variant = { id: 'current', caption: '', tokens: (t) => t }
const rowsBefore: Variant = {
  id: 'inset-raised',
  caption: 'Before',
  tokens: (t) => ({ ...t, widgetRowLook: 'inset-raised' }),
  registry: earlierWidgetRows,
}
const rowsAfter: Variant = {
  ...current,
  id: 'raised-editors',
  caption: 'After',
}

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
    case 'widgets':
    case 'core-rows':
    case 'collection-rows':
    case 'editor-rows':
    case 'widget-driven':
    case 'widget-offered':
    case 'widget-companions':
    case 'widget-states':
      return [rowsBefore, rowsAfter]
    default:
      return [current]
  }
}

/** Room around an example for pin dots, outlines and anything drawn past its nodes. */
const PAD = 10

interface Prepared {
  readonly variant: Variant
  readonly registry: WidgetRegistry
  readonly tokens: DesignTokens
  readonly fixture: CanvasGalleryFixture
}

function ExampleCard(props: {
  page: CanvasGalleryPage
  theme: Theme
  prepared: Prepared
  example: CanvasGalleryFixture['examples'][number]
  index: number
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
    const scene = example.scene
      ? example.scene
      : nodes && names
        ? {
            ...fixture.scene,
            nodes,
            links: fixture.scene.links.filter(
              (link) =>
                (link.from.kind === 'port' || link.from.kind === 'widgetTap') &&
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
      createRegistryPainter(props.prepared.registry),
    )
    renderer.setReducedMotion(true)
    renderer.setGridVisible(false)
    renderer.setScene(scene)
    renderer.setNodeStates(example.states ?? fixture.states)
    renderer.setBadges(example.badges ?? fixture.badges)
    renderer.setPortProblems(example.portProblems ?? {})
    renderer.setOverlay(example.overlay ?? fixture.overlay)
    renderer.setRowMarks(example.rowMarks ?? fixture.rowMarks)
    renderer.setCompanions(example.companions ?? fixture.companions)
    renderer.setInactiveNodes(example.inactive)
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
            Folded: { image, width: 320, height: 160 },
            Cached: { image, width: 320, height: 160, state: 'cached' },
            Estimate: { image, width: 320, height: 160, state: 'estimate' },
            'Minimized image': { image, width: 320, height: 160 },
            'Minimized opened': { image, width: 320, height: 160 },
          }
        : fixture.previews,
    )
    renderer.setNodeOutputTexts(fixture.outputTexts)
    renderer.setViewport({ x: 0, y: 0, scale })
    const measure = canvas.getContext('2d')!
    measure.font = `${tokens.fontSize}px ${tokens.fontFamily}`
    const labels = names ? [] : fixture.labels
    const box =
      page === 'minimap'
        ? { minX: 0, minY: 0, maxX: fixture.width, maxY: fixture.height }
        : sceneVisualBounds(
            // The painted scene: preview regions grow nodes.
            { ...renderer.getScene(), links: [] },
            fixture.previews,
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
    if (Object.keys(fixture.badges).length > 0) {
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

// Every face the canvas paints with, loaded as the editor does before its
// first paint.
const canvasFontsLoaded = () => {
  const { fontSize, titleFontSize, fontFamily } = defaultTokens
  const semibold = canvasPaintTokens.type.semiboldWeight
  return Promise.all([
    document.fonts.load(`${fontSize}px ${fontFamily}`),
    document.fonts.load(`${semibold} ${titleFontSize}px ${fontFamily}`),
    document.fonts.load(`italic ${semibold} ${titleFontSize}px ${fontFamily}`),
  ])
}

export function CanvasGallery() {
  // Only the dark theme is designed; `?theme=light` keeps the light theme
  // reachable for checks without a control on the page.
  const theme = (): Theme =>
    new URLSearchParams(window.location.search).get('theme') === 'light'
      ? 'light'
      : 'dark'
  const page = canvasPage
  writePageToAddress(page())
  const step = (by: number) => pageOrder[pageOrder.indexOf(page()) + by]
  // A page opened by its own link paints before any other page has loaded
  // the canvas faces, so every canvas here waits for all of them.
  const [fontsReady, setFontsReady] = createSignal(false)
  void canvasFontsLoaded().then(() => setFontsReady(true))
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
    if (currentPage === 'row-editing' || currentPage === 'row-lists' || currentPage === 'color-editing' || currentPage === 'node-look') return
    let disposed = false
    void canvasFontsLoaded().then(() => {
      if (disposed) return
      const colors = canvasColorsForTheme(currentTheme)
      const base: DesignTokens = {
        ...defaultTokens,
        stateColors: {
          ...defaultTokens.stateColors,
          pending: colors.pendingOutline,
          skipped: colors.skippedOutline,
        },
        ...canvasTypePaintForTheme(currentTheme),
        colors,
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
            registry: variant.registry?.(registry) ?? registry,
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
    const url = new URL(window.location.href)
    url.searchParams.delete('page')
    window.history.replaceState(window.history.state, '', url)
  })
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
      onBadge={setBadgeDetails}
    />
  )
  return (
    <>
      <Show when={page() === 'widget-states'}>
        <div class="dinkster-actions">
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
        </div>
      </Show>
      <ProductSection title={pageLabel(page())} description={pageNotes[page()]}>
        <Show when={fontsReady() && page() === 'node-look'}>
          <NodeLookGallery theme={theme()} />
        </Show>
        <Show when={fontsReady() && page() === 'row-editing'}>
          <RowEditingGallery theme={theme()} />
        </Show>
        <Show when={fontsReady() && page() === 'row-lists'}>
          <RowListsGallery theme={theme()} />
        </Show>
        <Show when={fontsReady() && page() === 'color-editing'}>
          <ColorEditingGallery theme={theme()} />
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
      <nav class="dinkster-canvas-steps" aria-label="Canvas pages">
        <For each={[-1, 1] as const}>
          {(by) => (
            <Show when={step(by)} fallback={<span />}>
              {(target) => (
                <ProductLink
                  href={canvasPageHref(target())}
                  rel={by < 0 ? 'prev' : 'next'}
                  data-step={by < 0 ? 'previous' : 'next'}
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.altKey ||
                      event.shiftKey
                    )
                      return
                    event.preventDefault()
                    selectCanvasPage(canvasPageHref(target()))
                    window.scrollTo(0, 0)
                  }}
                >
                  <span class="dinkster-metadata">
                    {by < 0 ? 'Previous page' : 'Next page'}
                  </span>
                  <span>{pageLabel(target())}</span>
                </ProductLink>
              )}
            </Show>
          )}
        </For>
      </nav>
    </>
  )
}
