import { For, createEffect, createSignal, onMount } from 'solid-js'
import { registerCatalog } from '@dinkster/core'
import {
  canvasColorsForTheme,
  canvasTypePaintForTheme,
  defaultTokens,
  drawMinimapGraph,
  drawMinimapOverlay,
  type DesignTokens,
} from '@dinkster/canvas'
import english from '../../app/src/locales/en.json'
import {
  CanvasCornerControls,
  CanvasViewControls,
  MINIMAP_SWITCHES,
  type CanvasCornerMenu,
} from '../../app/src/CanvasChrome.js'
import { GRAPH_EDITOR_KIND } from '../../app/src/editors.js'

/**
 * A real 19-node test graph captured from the editor, with the camera the
 * capture had: what the corner minimap overviews.
 */
const scene = {
  viewport: { x: -50.1, y: 268.4, scale: 0.374 },
  stage: { width: 1074, height: 794 },
  nodes: [
    [0, 40, 246, 443], [0, -140, 344, 111], [420, 0, 157, 111], [420, 220, 144, 215], [420, 560, 235, 87],
    [800, 20, 148, 55], [1120, 120, 148, 111], [800, 560, 203, 113], [1480, -60, 145, 107], [1480, 140, 168, 55],
    [1800, 140, 168, 55], [2120, 140, 148, 55], [2440, 100, 156, 107], [2800, 100, 168, 111], [3140, 60, 219, 235],
    [1480, 360, 156, 107], [1480, 620, 745, 349], [1800, -60, 210, 85], [2120, -60, 222, 85],
  ].map(([x, y, width, height]) => ({ x: x!, y: y!, width: width!, height: height! })),
  groups: [
    { x: 380, y: -70, width: 340, height: 820 },
    { x: 2400, y: 10, width: 1080, height: 330 },
  ],
  links: ([
    [344, -44, 0, 110, 'INT'], [246, 416, 420, 44, 'INT'], [577, 96, 800, 60, 'dev.image'],
    [948, 60, 1120, 160, 'dev.image'], [564, 290, 1120, 186, 'dev.image'], [655, 600, 800, 600, 'IMAGE'],
    [1268, 160, 1480, -20, 'dev.image'], [1268, 160, 1480, 180, 'dev.image'], [1648, 180, 1800, 180, 'list<dev.image>'],
    [1968, 180, 2120, 180, 'dev.image'], [2268, 180, 2440, 140, 'dev.image'], [2596, 140, 2800, 144, 'STRING'],
    [2968, 196, 3140, 208, 'STRING'], [1268, 160, 1480, 400, 'dev.image'], [1268, 160, 1480, 846, 'dev.image'],
    [1625, -20, 1800, -16, 'FLOAT'], [2010, 10, 2120, -16, 'FLOAT'],
  ] as const).map(([x1, y1, x2, y2, typeName]) => ({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, typeName })),
}

const lenses = [
  { id: 'standard', label: 'Standard', description: 'The standard graph editing view.' },
  { id: 'types', label: 'Types', description: 'Emphasize pin and noodle data types.' },
  { id: 'data', label: 'Data', description: 'Show recorded execution states and outputs on node bodies.' },
]

const defaultSwitches: Readonly<Record<string, boolean>> = {
  ...Object.fromEntries(MINIMAP_SWITCHES.map((item) => [item.id, true])),
  bookmarks: false,
}

function minimapTokens(): DesignTokens {
  const theme = document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
  return { ...defaultTokens, colors: canvasColorsForTheme(theme), ...canvasTypePaintForTheme(theme) }
}

function paintMinimap(canvas: HTMLCanvasElement, switches: Readonly<Record<string, boolean>>): void {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) return
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  const context = canvas.getContext('2d')!
  context.resetTransform()
  context.scale(dpr, dpr)
  const tokens = minimapTokens()
  const viewport = { ...scene.viewport, canvasWidth: scene.stage.width, canvasHeight: scene.stage.height }
  const tf = drawMinimapGraph(context, {
    width,
    height,
    tokens,
    nodes: scene.nodes,
    groups: switches['groups'] === false ? [] : scene.groups,
    links: switches['noodles'] === false ? [] : scene.links,
    linkColors: switches['linkColors'] !== false,
    viewport,
  })
  if (tf) drawMinimapOverlay(context, tf, { width, height, tokens, viewport })
}

interface CornerExample {
  readonly id: string
  readonly caption: string
  readonly size: 'small' | 'medium' | 'large'
  readonly visible: boolean
  readonly menu?: CanvasCornerMenu
  readonly switches?: Readonly<Record<string, boolean>>
  readonly tall?: boolean
}

const corners: readonly CornerExample[] = [
  { id: 'small', size: 'small', visible: true, caption: 'Small, the default size. The bar is as wide as its buttons and right-justified under the minimap.' },
  { id: 'medium', size: 'medium', visible: true, caption: 'Medium: the bar keeps its width.' },
  { id: 'large', size: 'large', visible: true, caption: 'Large: the bar keeps its width.' },
  { id: 'hidden', size: 'large', visible: false, caption: 'Minimap hidden: the same bar, its switch off.' },
  { id: 'settings', size: 'large', visible: true, menu: 'minimap', tall: true, caption: 'The minimap settings, opened by the arrow beside the minimap switch, straight above the bar and over the dimmed minimap. Link Colors is on by default.' },
  { id: 'quiet', size: 'large', visible: true, menu: 'minimap', tall: true, switches: { ...defaultSwitches, linkColors: false }, caption: 'Link Colors off: wires in one grey and no title lines.' },
  { id: 'zoom', size: 'large', visible: true, menu: 'zoom', caption: 'The zoom menu, opened by the percentage, above the bar: type a percentage, Zoom in, Zoom out, Reset to 100%.' },
]

function CornerExampleCard(props: { readonly example: CornerExample }) {
  const [switches, setSwitches] = createSignal(props.example.switches ?? defaultSwitches)
  const [visible, setVisible] = createSignal(props.example.visible)
  const [menu, setMenu] = createSignal(props.example.menu)
  const [zoom, setZoom] = createSignal(scene.viewport.scale)
  let minimap: HTMLCanvasElement | undefined
  onMount(() => {
    createEffect(() => {
      const current = switches()
      if (visible() && minimap) paintMinimap(minimap, current)
    })
  })
  return (
    <figure class="dinkster-canvas-example" data-testid={`canvas-chrome-corner-${props.example.id}`}>
      <div class="dinkster-canvas-example-stage dinkster-canvas-chrome-stage" data-shape={props.example.tall ? 'tall' : undefined}>
        <CanvasCornerControls
          size={props.example.size}
          minimapVisible={visible()}
          settings={switches()}
          zoom={zoom()}
          menu={menu()}
          shortcuts={{ zoomIn: 'Alt+=', zoomOut: 'Alt+-' }}
          minimapRef={(element) => { minimap = element }}
          onToggleMinimap={() => setVisible((value) => !value)}
          onToggleSetting={(id) => setSwitches((value) => ({ ...value, [id]: !value[id] }))}
          onOpenMenu={setMenu}
          onCloseMenu={() => setMenu(undefined)}
          onFit={() => setZoom(scene.viewport.scale)}
          onZoomBy={(factor) => setZoom((value) => Math.min(4, Math.max(0.05, value * factor)))}
          onZoomTo={(scale) => setZoom(Math.min(4, Math.max(0.05, scale)))}
        />
      </div>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  )
}

interface ViewExample {
  readonly id: string
  readonly caption: string
  readonly lens: string
  readonly menu?: 'view' | 'lens'
}

const views: readonly ViewExample[] = [
  { id: 'standard', lens: 'standard', caption: 'Standard lens: the view button shows the workflow icon; the lens button shows only the layers icon.' },
  { id: 'types', lens: 'types', caption: 'Another lens on: the lens button names it in the accent color.' },
  { id: 'view-menu', lens: 'standard', menu: 'view', caption: 'The view menu: Graph and App, then the named connections.' },
  { id: 'lens-menu', lens: 'types', menu: 'lens', caption: 'The lens menu.' },
]

function ViewExampleCard(props: { readonly example: ViewExample }) {
  const [lens, setLens] = createSignal(props.example.lens)
  const [menu, setMenu] = createSignal(props.example.menu)
  const [view, setView] = createSignal(GRAPH_EDITOR_KIND)
  const active = () => lenses.find((item) => item.id === lens()) ?? lenses[0]!
  return (
    <figure class="dinkster-canvas-example" data-testid={`canvas-chrome-view-${props.example.id}`}>
      <div class="dinkster-canvas-example-stage dinkster-canvas-chrome-stage" data-shape={props.example.menu === undefined ? 'bar' : 'top'}>
        <div class="dinkster-canvas-chrome-toolbar">
          <CanvasViewControls
            drilled={false}
            disabled={false}
            activeView={view()}
            appViewEnabled
            activeLens={active()}
            lenses={lenses}
            viewMenuOpen={menu() === 'view'}
            lensMenuOpen={menu() === 'lens'}
            onToggleViewMenu={() => setMenu((value) => value === 'view' ? undefined : 'view')}
            onToggleLensMenu={() => setMenu((value) => value === 'lens' ? undefined : 'lens')}
            onSelectView={(kind) => { setView(kind); setMenu(undefined) }}
            onSelectLens={(id) => { setLens(id); setMenu(undefined) }}
            onSetAllNetsDisplay={() => undefined}
          />
        </div>
      </div>
      <figcaption class="dinkster-metadata">{props.example.caption}</figcaption>
    </figure>
  )
}

/** The app's canvas corner and top-left view bar, drawn over a piece of canvas. */
export function CanvasChromeGallery() {
  registerCatalog('en', english)
  let root: HTMLDivElement | undefined
  onMount(() => requestAnimationFrame(() => { if (root) root.dataset['ready'] = 'true' }))
  return (
    <div ref={root} class="dinkster-canvas-examples" data-testid="canvas-chrome-gallery">
      <For each={corners}>{(example) => <CornerExampleCard example={example} />}</For>
      <For each={views}>{(example) => <ViewExampleCard example={example} />}</For>
    </div>
  )
}
