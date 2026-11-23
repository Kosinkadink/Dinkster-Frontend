import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from 'solid-js'
import {
  defaultValuesOf,
  loadDocument,
  type InputSpec,
  type Json,
  type NodeSchema,
  type WidgetRegistry,
} from '@dinkster/core'
import {
  CanvasRenderer,
  buildScene,
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
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  CanvasListSideLink,
  CanvasRowFocus,
  CanvasRowList,
  CanvasSidePart,
  ProductSection,
  canvasListLayout,
  canvasSideLayout,
  type CanvasListAction,
  type CanvasListOption,
  type CanvasListStatus,
} from '../src/index.js'

type WidgetRow = Extract<LayoutRow, { kind: 'widget' }>

const NODE_WIDTH = 280
const MARGIN = 16
const SIDE_ROOM = 272

const widget = (
  id: string,
  widgetType: string,
  value: Json,
  options: Record<string, Json> = {},
  tooltip?: string,
): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: widgetType },
  optional: false,
  widget: { widgetType, options, default: value },
  ...(tooltip === undefined ? {} : { tooltip }),
})
const schema = (type: string, items: NodeSchema['items']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items,
})

const PRESETS = ['portrait', 'landscape', 'line-art']
const PRESET_HELP = 'Presets for the chosen category. Refresh never changes the stored value.'

/** A list fed by a declared lookup: its options depend on the category row. */
const presetNode = schema('Presets by category', [
  widget('preset', 'COMBO', 'portrait', { options: PRESETS }, PRESET_HELP),
  widget('strength', 'FLOAT', 1, { min: -10, max: 10, step: 0.01 }, 'How strongly the preset applies.'),
  widget('category', 'COMBO', 'drawing', { options: ['photo', 'drawing'] }, 'Which presets to list.'),
  widget('enabled', 'BOOLEAN', true, {}, 'Turn the preset on or off.'),
])
const SAMPLERS = [
  { value: 'euler', label: 'Euler' },
  { value: 'euler_ancestral', label: 'Euler ancestral' },
  { value: 'dpmpp_2m', label: 'DPM++ 2M' },
]
const samplerNode = schema('Sampler settings', [
  widget('sampler_name', 'COMBO', 'euler', { options: SAMPLERS }, 'The sampling method.'),
  widget('scheduler', 'COMBO', 'normal', { options: ['normal', 'karras'] }, 'How the noise steps are spaced.'),
  widget('steps', 'INT', 20, { min: 1, max: 10000 }, 'Number of denoising steps.'),
])
const sourceNode = schema('Preset source', [
  { kind: 'output', id: 'preset', type: { kind: 'concrete', name: 'COMBO' } },
])
const nodes = { preset: presetNode, sampler: samplerNode }
type NodeKind = keyof typeof nodes

function listScene(
  kind: NodeKind,
  values: Record<string, Json>,
  wired: boolean,
  position: { x: number; y: number },
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): Scene {
  const definition = nodes[kind]
  const id = definition.type
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery',
        name: 'Gallery',
        nextOrdinal: 3,
        nodes: {
          [id]: { id, type: id, values: { ...defaultValuesOf(definition), ...values } },
          ...(wired ? { source: { id: 'source', type: sourceNode.type, values: {} } } : {}),
        },
        links: wired
          ? { wire: { id: 'wire', from: { node: 'source', port: 'preset' }, to: { node: id, port: 'preset' } } }
          : {},
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [id]: { position, size: { width: NODE_WIDTH, height: 0 } },
            ...(wired ? { source: { position: { x: -400, y: position.y }, size: { width: 160, height: 0 } } } : {}),
          },
        },
      },
    },
  })
  if (!loaded.document) throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => (type === id ? definition : type === sourceNode.type ? sourceNode : undefined),
    tokens,
    measure,
    widgetMeasure,
  })
}

interface SideContent {
  readonly problem?: string
  readonly facts?: readonly { readonly key: string; readonly value: string; readonly link?: boolean; readonly focused?: boolean }[]
  readonly help?: string
}

interface ListContent {
  readonly query?: string
  readonly options: readonly CanvasListOption[]
  readonly highlight?: number
  readonly status?: Omit<CanvasListStatus, 'action'> & { readonly action?: string }
  readonly empty?: string
  readonly actions?: readonly (string | { readonly label: string; readonly disabled: true })[]
  readonly focusedAction?: string
  readonly hiddenAfter?: number
  readonly frozen?: boolean
}

export interface ListExample {
  readonly id: string
  readonly title: string
  readonly caption: string
  readonly node: NodeKind
  readonly values?: Record<string, Json>
  readonly wired?: boolean
  /** The row whose list is open. */
  readonly open?: string
  /** The row the keyboard is on while nothing is open. */
  readonly focus?: string
  readonly scale?: number
  readonly place?: 'left' | 'narrow'
  /** The canvas ends here, so the list and side part keep within it. */
  /** `height` 'fit' ends the canvas just under the node. */
  readonly canvas?: { readonly height: number | 'fit'; readonly nodeY: number }
  readonly list?: ListContent
  readonly side?: SideContent
}

const option = (label: string, extra: Partial<CanvasListOption> = {}): CanvasListOption => ({ key: label, label, ...extra })
const presets = (saved: string | null = 'portrait') =>
  PRESETS.map((label) => option(label, label === saved ? { saved: true } : {}))
const defaultLink = { key: 'default', value: 'portrait', link: true }
const presetSide: SideContent = { facts: [defaultLink], help: PRESET_HELP }
const missingSide: SideContent = {
  problem: 'Not in the current list. Kept until you choose another.',
  facts: [{ key: 'saved', value: 'portrait-old' }, defaultLink],
  help: PRESET_HELP,
}
const refresh = ['Refresh']
const refreshing = [{ label: 'Refresh', disabled: true }] as const

const groups: readonly { readonly title: string; readonly examples: readonly ListExample[] }[] = [
  {
    title: 'Opening and choosing',
    examples: [
      {
        id: 'closed',
        title: 'Closed',
        caption: 'A choice at rest. A click or Tab opens the filter in the same row.',
        node: 'preset',
      },
      {
        id: 'ready',
        title: 'Open and selected',
        caption: 'The filter starts empty. The saved option has the check and is highlighted. Picking stores once; opening does not.',
        node: 'preset',
        open: 'preset',
        list: { options: presets(), highlight: 0, actions: refresh },
        side: presetSide,
      },
      {
        id: 'filter',
        title: 'Filter with matches',
        caption: 'Case-insensitive substring matching over label, value, information and folder, in source order. Typing never asks the pack for options.',
        node: 'preset',
        open: 'preset',
        list: {
          query: 'land',
          options: [option('landscape', { detail: 'drawing / landscapes' }), option('landmark-style', { detail: 'drawing / styles' })],
          highlight: 0,
          actions: refresh,
        },
        side: presetSide,
      },
      {
        id: 'nomatch',
        title: 'No filter matches',
        caption: 'No matching options, with Clear filter. The loaded options, the saved value and Refresh stay; this is not a list that came back empty.',
        node: 'preset',
        open: 'preset',
        list: { query: 'zzzz', options: [], empty: 'No matching options', actions: ['Clear filter', 'Refresh'] },
        side: presetSide,
      },
      {
        id: 'stored',
        title: 'Choice stored, keyboard stays',
        caption: 'The list closes after a pick. The keyboard stays on the row: Tab goes on from it, Enter opens it again.',
        node: 'preset',
        values: { preset: 'landscape' },
        focus: 'preset',
      },
    ],
  },
  {
    title: 'States of a list from a lookup',
    examples: [
      {
        id: 'empty',
        title: 'Loaded and empty',
        caption: 'The lookup answered with no options. Refresh stays, and the stored value stays, marked as not in the list.',
        node: 'preset',
        values: { preset: 'portrait-old' },
        open: 'preset',
        list: { options: [], empty: 'No options available', actions: refresh },
        side: missingSide,
      },
      {
        id: 'loading',
        title: 'First load',
        caption: 'Loading options. The stored value stays; nothing can be chosen until these arguments have an answer. Refresh waits for it.',
        node: 'preset',
        open: 'preset',
        list: { options: [], status: { tone: 'busy', text: 'Loading options' }, actions: refreshing },
        side: presetSide,
      },
      {
        id: 'refresh',
        title: 'Refresh in progress',
        caption: 'The earlier answer for these same arguments stays selectable while it refreshes, and filtering still works. The message sits under the list beside Refresh, so the options do not move.',
        node: 'preset',
        open: 'preset',
        list: { options: presets(), highlight: 0, status: { tone: 'busy', text: 'Refreshing options' }, actions: refreshing },
        side: presetSide,
      },
      {
        id: 'stale',
        title: 'Failed refresh, missing saved value',
        caption: 'Could not refresh, under the list with Try again where Refresh stood: the earlier options stay selectable for these arguments. The saved value is missing from them and is never added as an option.',
        node: 'preset',
        values: { preset: 'portrait-old' },
        open: 'preset',
        list: {
          options: presets(null),
          highlight: 0,
          status: { tone: 'warning', text: 'Could not refresh', action: 'Try again' },
        },
        side: missingSide,
      },
      {
        id: 'failed',
        title: 'Failed without an answer',
        caption: 'The pack could not provide this list; the error itself goes to the doctor. Try again stands where Refresh stood, and no options come from other arguments.',
        node: 'preset',
        open: 'preset',
        list: {
          options: [],
          status: { tone: 'error', text: 'Could not load options', action: 'Try again' },
        },
        side: presetSide,
      },
      {
        id: 'waiting',
        title: 'Waiting for an input',
        caption: 'The category is not known yet, so the lookup is not called and there is nothing to try again.',
        node: 'preset',
        values: { category: '' },
        open: 'preset',
        list: { options: [], status: { tone: 'notice', text: 'Waiting for category' } },
        side: presetSide,
      },
      {
        id: 'changed',
        title: 'Changed category, late answer',
        caption: 'Category changed from photo to drawing while photo was loading. The late photo answer is kept for photo and not shown here.',
        node: 'preset',
        open: 'preset',
        list: { options: [], status: { tone: 'busy', text: 'Loading options' }, actions: refreshing },
        side: presetSide,
      },
      {
        id: 'paused',
        title: 'Rate limited',
        caption: 'Paused, under the list beside Refresh: the list keeps what it shows and the filter. Refresh can be tried by hand; nothing retries on a timer.',
        node: 'preset',
        open: 'preset',
        list: { options: presets(), highlight: 0, status: { tone: 'notice', text: 'Rate limited' }, actions: refresh },
        side: presetSide,
      },
      {
        id: 'off',
        title: 'Lookup off in preview',
        caption: 'In node search and the registry, lookups are off and say so: no calls and no timers.',
        node: 'preset',
        open: 'preset',
        list: { options: [], status: { tone: 'notice', text: 'Not loaded in preview' } },
        side: presetSide,
      },
    ],
  },
  {
    title: 'Folders and long names',
    examples: [
      {
        id: 'folder',
        title: 'Folders',
        caption: 'Inside the drawing folder. Enter on a folder opens it without storing; Back, or Backspace in an empty filter, returns to its parent. A filter searches every leaf.',
        node: 'preset',
        open: 'preset',
        list: {
          options: [
            option('Back to parent folder', { kind: 'back' }),
            option('portraits', { kind: 'folder' }),
            option('landscapes', { kind: 'folder' }),
            option('base-style'),
          ],
          highlight: 1,
          actions: refresh,
        },
        side: presetSide,
      },
      {
        id: 'long',
        title: 'Long names',
        caption: 'Names stay on one line with an ellipsis; the highlighted name is written out in full beside the list. Two presets share a label and keep their own values, told apart by their detail lines.',
        node: 'preset',
        values: { preset: 'watercolor-wash-with-soft-edges-and-paper-grain' },
        open: 'preset',
        list: {
          options: [
            option('watercolor-wash-with-soft-edges-and-paper-grain', { saved: true, detail: 'drawing / painterly' }),
            option('portrait', { key: 'portrait-soft', detail: 'drawing / soft light' }),
            option('portrait', { key: 'portrait-hard', detail: 'drawing / hard light' }),
            option('line-art'),
            option('flat-color'),
          ],
          highlight: 0,
          actions: refresh,
        },
        side: {
          facts: [
            { key: 'highlighted', value: 'watercolor-wash-with-soft-edges-and-paper-grain' },
            defaultLink,
          ],
          help: PRESET_HELP,
        },
      },
    ],
  },
  {
    title: 'On the canvas',
    examples: [
      {
        id: 'up',
        title: 'Bottom edge, list above',
        caption: 'The canvas ends just under the node, so the list opens upward. The field stays where it is and the side part still touches it.',
        node: 'preset',
        open: 'preset',
        canvas: { height: 'fit', nodeY: 150 },
        list: { options: presets(), highlight: 0, actions: refresh },
        side: presetSide,
      },
      {
        id: 'narrow',
        title: 'No side room',
        caption: 'No room on either side of the node: the side part goes under the node with its own grey border, below the list.',
        node: 'preset',
        open: 'preset',
        place: 'narrow',
        list: { options: presets(), highlight: 0, actions: refresh },
        side: presetSide,
      },
      {
        id: 'zoom',
        title: '50 percent canvas zoom',
        caption: 'The node is small; the filter and the list keep their normal size, with the side part under the list. The canvas does not pan.',
        node: 'preset',
        open: 'preset',
        scale: 0.5,
        list: { options: presets(), highlight: 0, actions: refresh },
        side: presetSide,
      },
      {
        id: 'left',
        title: 'Side part on the left',
        caption: 'No room on the right: the same side part sits on the left. The list stays under its field.',
        node: 'preset',
        open: 'preset',
        place: 'left',
        list: { options: presets(), highlight: 0, actions: refresh },
        side: presetSide,
      },
      {
        id: 'short',
        title: 'Very short canvas',
        caption: 'The field stays visible. The list takes the height there is and scrolls inside; Refresh stays reachable and the canvas does not move.',
        node: 'preset',
        open: 'preset',
        canvas: { height: 160, nodeY: 18 },
        list: {
          options: [...presets(), option('portrait-v2'), option('watercolor')],
          highlight: 0,
          actions: refresh,
        },
        side: presetSide,
      },
    ],
  },
  {
    title: 'Storing',
    examples: [
      {
        id: 'pending',
        title: 'Store pending',
        caption: 'landscape was picked and is being stored. The list and row navigation wait until it is acknowledged.',
        node: 'preset',
        open: 'preset',
        list: {
          options: presets(),
          highlight: 1,
          status: { tone: 'busy', text: 'Storing landscape' },
          actions: refresh,
          frozen: true,
        },
        side: presetSide,
      },
      {
        id: 'refused',
        title: 'Store refused',
        caption: 'The list and the filter stay open. The first line of the side part says why; nothing else opens.',
        node: 'preset',
        open: 'preset',
        list: { query: 'land', options: [option('landscape', { detail: 'drawing / landscapes' })], highlight: 0, actions: refresh },
        side: { problem: 'landscape is no longer available. Your saved value is unchanged.', facts: [defaultLink], help: PRESET_HELP },
      },
      {
        id: 'locked',
        title: 'Wired, read-only, disabled',
        caption: 'preset takes its value from a wire, so it does not open and Tab skips it: the keyboard lands on strength. How wired, read-only and disabled rows look is set by the row looks change (comfy-vibe-station issue 1235), not by the list.',
        node: 'preset',
        wired: true,
        focus: 'strength',
      },
    ],
  },
  {
    title: 'A declared choice',
    examples: [
      {
        id: 'choice',
        title: 'Static choice',
        caption: 'A declared static choice uses the same filter and list, without a lookup status or Refresh. An option can show one name and store another: the list shows Euler, the workflow stores euler.',
        node: 'sampler',
        open: 'sampler_name',
        list: {
          options: SAMPLERS.map((item, index) => option(item.label, { key: item.value, ...(index === 0 ? { saved: true } : {}) })),
          highlight: 0,
        },
        side: { facts: [{ key: 'default', value: 'Euler', link: true }], help: 'The sampling method.' },
      },
      {
        id: 'author',
        title: 'Editable options',
        caption: 'Edit options opens the existing editor for the option list. The filter gains no JSON, and the existing capability stays.',
        node: 'sampler',
        open: 'sampler_name',
        list: {
          options: SAMPLERS.map((item, index) => option(item.label, { key: item.value, ...(index === 0 ? { saved: true } : {}) })),
          highlight: 0,
          actions: ['Edit options'],
          focusedAction: 'Edit options',
        },
        side: { facts: [{ key: 'default', value: 'Euler', link: true }], help: 'The sampling method.' },
      },
    ],
  },
]

/** Every example on the page, in page order. */
export const rowListExamples: readonly ListExample[] = groups.flatMap((group) => group.examples)

function actionsOf(list: ListContent): CanvasListAction[] {
  return (list.actions ?? []).map((item) =>
    typeof item === 'string'
      ? { id: item, label: item, onClick: () => undefined }
      : { id: item.label, label: item.label, disabled: true, onClick: () => undefined },
  )
}

function sidePart(side: SideContent) {
  return (
    <CanvasSidePart
      {...(side.problem === undefined ? {} : { problem: side.problem })}
      facts={(side.facts ?? []).map((fact) => ({
        key: fact.key,
        value: fact.link === true
          ? <CanvasListSideLink focused={fact.focused === true} onClick={() => undefined}>{fact.value}</CanvasListSideLink>
          : fact.value,
      }))}
      {...(side.help === undefined ? {} : { help: side.help })}
    />
  )
}

export function RowListExample(props: { example: ListExample; theme: 'dark' | 'light'; registry: WidgetRegistry }) {
  let canvas!: HTMLCanvasElement
  let stage!: HTMLDivElement
  let field: HTMLDivElement | undefined
  const [scene, setScene] = createSignal<Scene>()
  const [insetY, setInsetY] = createSignal(0)
  const [flat, setFlat] = createSignal(false)
  const [sideSize, setSideSize] = createSignal({ width: SIDE_ROOM - MARGIN, height: 0 })
  const [listSize, setListSize] = createSignal(0)
  const example = () => props.example
  const scale = () => example().scale ?? 1
  const nodeX = () => (example().place === 'left' ? SIDE_ROOM : example().scale === 0.5 ? MARGIN * 2 : MARGIN)
  const width = () =>
    example().place === 'narrow'
      ? NODE_WIDTH + MARGIN * 2
      : example().scale === 0.5
        ? NODE_WIDTH + MARGIN * 2
        : example().place === 'left'
          ? SIDE_ROOM + NODE_WIDTH + MARGIN
          : MARGIN + NODE_WIDTH + SIDE_ROOM
  createEffect(() => {
    const theme = props.theme
    const current = example()
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
      setFlat(tokens.nodeLook !== 'original')
      setInsetY(tokens.nodeLook !== 'original' ? tokens.rowGeometry.fieldInsetY : 0)
      const context = document.createElement('canvas').getContext('2d')!
      const measure: TextMeasurer = (text, role) => {
        const title = role === 'title' || role === 'renamedTitle'
        context.font = `${title ? `${canvasPaintTokens.type.semiboldWeight} ` : ''}${title ? tokens.titleFontSize : tokens.fontSize}px ${tokens.fontFamily}`
        return context.measureText(text).width
      }
      const widgetMeasure: WidgetMeasure = (spec) => {
        const kind = props.registry.kind(spec.widgetType)
        const view = props.registry.viewsFor(spec.widgetType).find((view) => view.id === kind?.defaultView(spec))
        return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
      }
      const zoomedOut = current.scale === 0.5
      const position = {
        x: current.place === 'left' ? SIDE_ROOM : zoomedOut ? MARGIN * 2 : MARGIN,
        y: current.canvas?.nodeY ?? (zoomedOut ? MARGIN * 2 : MARGIN),
      }
      const built = listScene(current.node, current.values ?? {}, current.wired === true, position, tokens, measure, widgetMeasure)
      const node = built.nodes.find((item) => item.node.type === nodes[current.node].type)!
      const fitted = (position.y + node.layout.height + MARGIN / 2) * scale()
      const height = current.canvas === undefined ? fitted + MARGIN / 2 : current.canvas.height === 'fit' ? fitted : current.canvas.height
      canvas.style.width = `${width()}px`
      canvas.style.height = `${height}px`
      renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(built)
      renderer.setOpenRow(current.open !== undefined && tokens.nodeLook !== 'original' ? { nodeId: node.id, valueKey: current.open } : undefined)
      renderer.setViewport({ x: 0, y: 0, scale: scale() })
      renderer.renderNow()
      setScene(built)
      canvas.dataset['ready'] = `${current.id}-${theme}`
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset['ready']
    })
  })
  const target = createMemo(() => {
    const current = scene()
    const key = example().open ?? example().focus
    if (!current || key === undefined) return undefined
    const node = current.nodes.find((item) => item.node.type === nodes[example().node].type)!
    const row = node.layout.rows.find((row): row is WidgetRow => row.kind === 'widget' && row.valueKey === key)
    return row === undefined ? undefined : { node, row }
  })
  const placement = () => {
    const found = target()
    if (!found) return undefined
    const { node, row } = found
    const s = scale()
    const grow = flat() ? 1 : 0
    const rowWidth = (row.width ?? node.layout.width - row.inset * 2) + grow * 2
    const zoom = Math.max(1, s)
    const screen = {
      x: (node.x + row.inset) * s - grow,
      y: (node.y + row.y + insetY()) * s - grow,
      width: rowWidth * zoom,
      height: (row.height - insetY() * 2) * zoom + grow * 2,
    }
    const bounds = {
      x: 0,
      y: 0,
      width: canvas.clientWidth,
      height: example().canvas === undefined ? Infinity : canvas.clientHeight,
    }
    const nodeBelow = ((node.y + node.layout.height) * s - screen.y) / zoom + MARGIN / 2
    const nodeAbove = (screen.y - node.y * s) / zoom + MARGIN / 2
    const layout = example().list === undefined
      ? { ...canvasSideLayout(screen, bounds, sideSize(), s, nodeBelow, nodeAbove), listPlace: 'below' as const }
      : canvasListLayout(screen, bounds, listSize(), sideSize(), s, nodeBelow, nodeAbove)
    return { row, rowWidth, screen, ...layout }
  }
  createEffect(() => {
    const current = placement()
    if (!current || !field) return
    field.style.left = `${current.screen.x}px`
    field.style.top = `${current.screen.y}px`
    if (example().canvas !== undefined) return
    const fieldHeight = current.screen.height
    const listBottom = current.listPlace === 'below' ? fieldHeight + (current.listMaxHeight ?? listSize()) : fieldHeight
    // The side part's top is measured from the top of the row and list together.
    const columnTop = current.listPlace === 'above' ? -(current.listMaxHeight ?? listSize()) : 0
    const sideBottom = columnTop + current.sideTop + (current.sideMaxHeight ?? sideSize().height)
    stage.style.height = `${Math.max(canvas.clientHeight, current.screen.y + Math.max(listBottom, sideBottom) + MARGIN)}px`
  })
  const list = () => example().list
  return (
    <figure class="dinkster-canvas-example" data-testid={`row-list-${example().id}`}>
      <div ref={stage} class="dinkster-canvas-example-stage">
        <canvas ref={canvas} role="img" aria-label={`${example().title} in ${props.theme} theme`} />
        <Show when={example().focus !== undefined && placement()}>
          {(current) => (
            <CanvasRowFocus
              ref={(element) => (field = element)}
              {...(flat() ? { look: 'flat-title' as const } : {})}
              rowWidth={current().rowWidth}
              place={current().place}
              sideTop={current().sideTop}
              {...(current().sideMaxHeight !== undefined ? { sideMaxHeight: current().sideMaxHeight! } : {})}
              onSideSize={setSideSize}
              side={sidePart(
                example().id === 'locked'
                  ? { facts: [{ key: 'default', value: '1.00' }], help: 'How strongly the preset applies.' }
                  : { facts: [{ key: 'default', value: 'portrait' }], help: PRESET_HELP },
              )}
            />
          )}
        </Show>
        <Show when={list() !== undefined && placement()}>
          {(current) => (
            <CanvasRowList
              ref={(element) => (field = element)}
              {...(flat() ? { look: 'flat-title' as const } : {})}
              rowWidth={current().rowWidth}
              label={current().row.label}
              query={list()!.query ?? ''}
              onQuery={() => undefined}
              inputLabel={current().row.label}
              options={list()!.options}
              {...(list()!.highlight === undefined ? {} : { highlight: list()!.highlight! })}
              {...(list()!.status === undefined
                ? {}
                : {
                    status: {
                      tone: list()!.status!.tone,
                      text: list()!.status!.text,
                      ...(list()!.status!.action === undefined
                        ? {}
                        : { action: { id: list()!.status!.action!, label: list()!.status!.action!, onClick: () => undefined } }),
                    },
                  })}
              {...(list()!.empty === undefined ? {} : { empty: list()!.empty! })}
              actions={actionsOf(list()!)}
              {...(list()!.focusedAction === undefined ? {} : { focusedAction: list()!.focusedAction! })}
              {...(list()!.frozen === true ? { frozen: true } : {})}
              zoomed={scale() > 1}
              place={current().place}
              sideTop={current().sideTop}
              {...(current().sideMaxHeight !== undefined ? { sideMaxHeight: current().sideMaxHeight! } : {})}
              listPlace={current().listPlace}
              {...(current().listMaxHeight !== undefined ? { listMaxHeight: current().listMaxHeight! } : {})}
              onListSize={setListSize}
              onSideSize={setSideSize}
              {...(example().side === undefined ? {} : { side: sidePart(example().side!) })}
            />
          )}
        </Show>
      </div>
      <figcaption class="dinkster-metadata">
        <strong>{example().title}.</strong> {example().caption}
      </figcaption>
    </figure>
  )
}

/** Choice rows opened as one filtered list in their own row, painted by the production renderer. */
export function RowListsGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <For each={groups}>
      {(group) => (
        <ProductSection title={group.title}>
          <div class="dinkster-canvas-examples">
            <For each={group.examples}>
              {(example) => <RowListExample example={example} theme={props.theme} registry={registry} />}
            </For>
          </div>
        </ProductSection>
      )}
    </For>
  )
}
