import { For, createEffect, createSignal, onCleanup, type JSX } from 'solid-js'
import {
  AppWindow,
  Box,
  Download,
  PanelTop,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from 'lucide-solid'
import {
  asNodeId,
  defaultValuesOf,
  type Json,
  type NodeSchema,
  type TypeExpr,
  type WidgetRegistry,
} from '@dinkster/core'
import {
  CanvasRenderer,
  canvasColorsForTheme,
  canvasPaintTokens,
  canvasTypePaintForTheme,
  createRegistryPainter,
  defaultTokens,
  layoutNode,
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import {
  ProductSearch,
  ProductSearchNodePreview,
  ProductSection,
  ProductWindowAction,
  type ProductSearchGroup,
  type ProductSearchRow,
} from '../src/index.js'

type Kind = 'nodes' | 'blueprints' | 'commands' | 'settings' | 'workflows' | 'tabs'

interface Item {
  readonly key: string
  readonly kind: Kind
  readonly title: string
  readonly detail?: string
  readonly note?: string
  readonly keys?: readonly string[]
  readonly toggle?: boolean
  readonly description?: string
  readonly schema?: NodeSchema
  readonly notInstalled?: boolean
}

const KINDS: readonly { readonly id: 'all' | Kind; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'blueprints', label: 'Blueprints' },
  { id: 'commands', label: 'Commands' },
  { id: 'settings', label: 'Settings' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'tabs', label: 'Tabs' },
]

const ICONS: Record<Kind, LucideIcon> = {
  nodes: PanelTop,
  blueprints: Box,
  commands: SquareTerminal,
  settings: SlidersHorizontal,
  workflows: Workflow,
  tabs: AppWindow,
}

const NOUNS: Record<Kind, string> = {
  nodes: 'nodes',
  blueprints: 'blueprints',
  commands: 'commands',
  settings: 'settings',
  workflows: 'workflows',
  tabs: 'tabs',
}

const ENTER: Record<Kind, string> = {
  nodes: 'place this node',
  blueprints: 'place this blueprint',
  commands: 'run',
  settings: 'change',
  workflows: 'open',
  tabs: 'open',
}

const type = (name: string): TypeExpr => ({ kind: 'concrete', name })
const node = (
  title: string,
  inputs: readonly [string, string][],
  outputs: readonly [string, string][],
  description: string,
  widgets: readonly [string, number][] = [],
): NodeSchema => ({
  type: title.replace(/\W+/gu, ''),
  displayName: title,
  category: 'dev/image',
  pack: 'dinkster-nodes-dev',
  description,
  source: 'v3',
  isOutputNode: false,
  body: [
    ...inputs.map(([id, name]) => ({ kind: 'input' as const, id, type: type(name), optional: false })),
    ...outputs.map(([id, name]) => ({ kind: 'output' as const, id, type: type(name) })),
    ...widgets.map(([id, value]) => ({
      kind: 'input' as const,
      id,
      type: type('INT'),
      optional: false,
      widget: { widgetType: 'INT', options: { min: 1, max: 8192 }, default: value },
    })),
  ],
})

const nodeItem = (schema: NodeSchema, notInstalled = false): Item => ({
  key: `nodes:${schema.type}`,
  kind: 'nodes',
  title: schema.displayName,
  detail: notInstalled ? 'Not installed' : 'dev / image',
  ...(schema.description === undefined ? {} : { description: schema.description }),
  schema,
  notInstalled,
})

const ITEMS: readonly Item[] = [
  nodeItem(node('Image Stats', [['image', 'IMAGE']], [['stats', 'STRING']], 'Measures the size, range and mean colour of a picture.')),
  nodeItem(node('Image Batch to List', [['batch', 'IMAGE']], [['images', 'IMAGE']], 'Splits a batch of pictures into a list, one picture each.')),
  nodeItem(node('Gradient Image', [], [['image', 'IMAGE']], 'Makes a picture that fades from one colour to another.', [['width', 512], ['height', 512]])),
  nodeItem(node('Image List to Batch', [['images', 'IMAGE']], [['batch', 'IMAGE']], 'Joins a list of pictures into one batch.')),
  nodeItem(node('Blend Images', [['first', 'IMAGE'], ['second', 'IMAGE']], [['image', 'IMAGE']], 'Mixes two pictures together.')),
  nodeItem(node('Invert Image', [['image', 'IMAGE']], [['image', 'IMAGE']], 'Flips every colour of the picture.')),
  nodeItem(node('Save Image (PGM)', [['image', 'IMAGE']], [], 'Writes a picture to the library as a grey PGM file.')),
  nodeItem(node('Upscale Image with Model', [['image', 'IMAGE'], ['model', 'UPSCALE_MODEL']], [['image', 'IMAGE']], 'Makes a picture larger with an upscaling model.'), true),
  {
    key: 'blueprints:image-to-video',
    kind: 'blueprints',
    title: 'Image to video',
    detail: 'Blueprint',
    description: 'Turns one picture into a short clip with a slow camera move.',
    schema: node('Image to video', [['picture', 'IMAGE']], [['video', 'VIDEO']], ''),
  },
  {
    key: 'blueprints:upscale-image-2x',
    kind: 'blueprints',
    title: 'Upscale image 2x',
    detail: 'Blueprint',
    description: 'Doubles the size of a picture in two gentle steps.',
    schema: node('Upscale image 2x', [['image', 'IMAGE']], [['image', 'IMAGE']], ''),
  },
  { key: 'commands:run', kind: 'commands', title: 'Run workflow', keys: ['Ctrl', 'Enter'] },
  { key: 'commands:save', kind: 'commands', title: 'Save workflow', keys: ['Ctrl', 'S'] },
  { key: 'commands:library', kind: 'commands', title: 'Open workflow library', keys: ['Ctrl', 'O'] },
  { key: 'commands:cancel', kind: 'commands', title: 'Cancel current run' },
  { key: 'settings:minimap', kind: 'settings', title: 'Show minimap', detail: 'Canvas', toggle: true },
  { key: 'settings:previews', kind: 'settings', title: 'Live sampling previews', note: 'preview images during sampling', detail: 'Runs', toggle: true },
  { key: 'settings:grid', kind: 'settings', title: 'Show dot grid', detail: 'Canvas', toggle: true },
  { key: 'settings:frame-rate', kind: 'settings', title: 'Show frame rate', detail: 'Advanced', toggle: false },
  { key: 'workflows:diner', kind: 'workflows', title: 'Diner establishing shot', detail: 'Film grain tests' },
  { key: 'workflows:image-to-video', kind: 'workflows', title: 'Image to video', detail: 'Film grain tests' },
  { key: 'workflows:upscale', kind: 'workflows', title: 'Upscale image 2x' },
  { key: 'tabs:untitled', kind: 'tabs', title: 'Untitled' },
  { key: 'tabs:image-to-video', kind: 'tabs', title: 'Image to video', detail: 'Edited' },
]

const RECENT = ['workflows:diner', 'nodes:ImageBatchtoList', 'settings:minimap', 'commands:run']

/** The example node drawn by the canvas renderer, as the product draws its previews. */
function NodeDrawing(props: { schema: NodeSchema; registry: WidgetRegistry; subgraph?: boolean }) {
  let canvas!: HTMLCanvasElement
  createEffect(() => {
    const schema = props.schema
    let renderer: CanvasRenderer | undefined
    let disposed = false
    void document.fonts
      .load(`${canvasPaintTokens.type.semiboldWeight} ${defaultTokens.titleFontSize}px ${defaultTokens.fontFamily}`)
      .then(() => {
        if (disposed) return
        const tokens = { ...defaultTokens, colors: canvasColorsForTheme('dark'), ...canvasTypePaintForTheme('dark') }
        const context = document.createElement('canvas').getContext('2d')!
        const measure: TextMeasurer = (text, style) => {
          context.font = style === 'title' || style === 'renamedTitle'
            ? `${canvasPaintTokens.type.semiboldWeight} ${tokens.titleFontSize}px ${tokens.fontFamily}`
            : `${tokens.fontSize}px ${tokens.fontFamily}`
          return context.measureText(text).width
        }
        const widgetMeasure: WidgetMeasure = (spec) => {
          const kind = props.registry.kind(spec.widgetType)
          const view = props.registry.viewsFor(spec.widgetType).find((candidate) => candidate.id === kind?.defaultView(spec))
          return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
        }
        const data = {
          id: asNodeId('search-preview'),
          type: schema.type,
          values: defaultValuesOf(schema) as Record<string, Json>,
          title: schema.displayName,
        }
        const layout = layoutNode(schema, data, tokens, measure, widgetMeasure)
        const inset = canvasPaintTokens.preview.palette.inset
        canvas.style.width = `${Math.ceil(layout.width + inset * 2)}px`
        canvas.style.height = `${Math.ceil(layout.height + inset * 2)}px`
        renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
        renderer.setReducedMotion(true)
        renderer.setGridVisible(false)
        renderer.setScene({
          graphId: 'search-preview',
          nodes: [{ id: data.id, x: 0, y: 0, node: data, layout, isSubgraph: props.subgraph === true }],
          links: [], reroutes: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [],
        })
        renderer.setViewport({ x: inset, y: inset, scale: 1 })
        renderer.renderNow()
        canvas.dataset['ready'] = schema.type
      })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset['ready']
    })
  })
  return <canvas ref={canvas} role="img" aria-label={`${props.schema.displayName} node`} />
}

const matches = (item: Item, query: string): boolean => {
  const text = `${item.title} ${item.note ?? ''}`.toLocaleLowerCase()
  return query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => text.includes(word))
}

/** Example data behind one Ctrl+K search: what the app's providers give it. */
function CtrlKExample(props: {
  query?: string
  current?: string
  loadingWorkflows?: boolean
  registry: WidgetRegistry
  testId: string
}) {
  const [query, setQuery] = createSignal(props.query ?? '')
  const [kind, setKind] = createSignal<'all' | Kind>('all')
  const [current, setCurrent] = createSignal(props.current)
  const [opened, setOpened] = createSignal<ReadonlySet<Kind>>(new Set())
  const [switches, setSwitches] = createSignal<ReadonlyMap<string, boolean>>(
    new Map(ITEMS.filter((item) => item.toggle !== undefined).map((item) => [item.key, item.toggle!])),
  )
  const [chosen, setChosen] = createSignal('Nothing chosen yet')
  const byKey = new Map(ITEMS.map((item) => [item.key, item]))
  const row = (item: Item): ProductSearchRow => ({
    key: item.key,
    title: item.title,
    icon: ICONS[item.kind],
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.notInstalled ? { detailIcon: Download } : {}),
    ...(item.keys === undefined ? {} : { keys: item.keys }),
    ...(item.toggle === undefined
      ? {}
      : {
          toggle: {
            checked: switches().get(item.key) ?? false,
            label: item.title,
            onChange: (next: boolean) => setSwitches(new Map(switches()).set(item.key, next)),
          },
        }),
  })
  const found = (of: Kind) => ITEMS.filter((item) => item.kind === of && matches(item, query()))
  const groups = (): readonly ProductSearchGroup[] => {
    const typed = query().trim() !== ''
    if (!typed && kind() === 'all') {
      return [
        { key: 'recent', label: 'Recent', rows: RECENT.map((key) => row(byKey.get(key)!)) },
        { key: 'open-tabs', label: 'Open tabs', rows: found('tabs').map(row) },
      ]
    }
    const kinds = kind() === 'all' ? (KINDS.slice(1).map((entry) => entry.id) as Kind[]) : [kind() as Kind]
    return kinds.flatMap((of): ProductSearchGroup[] => {
      if (of === 'workflows' && props.loadingWorkflows)
        return [{ key: of, label: 'Workflows', rows: [], note: 'Searching workflows' }]
      const items = found(of)
      if (items.length === 0) return []
      const label = KINDS.find((entry) => entry.id === of)!.label
      const short = kind() === 'all' && !opened().has(of) && items.length > 3
      return [{
        key: of,
        label,
        count: items.length,
        rows: [
          ...(short ? items.slice(0, 3) : items).map(row),
          ...(short ? [{ key: `more:${of}`, kind: 'more' as const, title: `${items.length - 3} more ${NOUNS[of]}` }] : []),
        ],
      }]
    })
  }
  const kinds = () =>
    KINDS.filter((entry) => query().trim() === '' || entry.id === 'all' || found(entry.id as Kind).length > 0).map((entry) => ({
      id: entry.id,
      label: entry.label,
      ...(query().trim() === '' || entry.id === 'all' ? {} : { count: found(entry.id as Kind).length }),
    }))
  const currentKey = () => {
    const keys = groups().flatMap((group) => group.rows.map((item) => item.key))
    const key = current()
    return key !== undefined && keys.includes(key) ? key : keys[0]
  }
  const currentItem = () => byKey.get(currentKey() ?? '')
  const activate = (key: string) => {
    if (key.startsWith('more:')) {
      const of = key.slice(5) as Kind
      setOpened(new Set([...opened(), of]))
      setCurrent(found(of)[3]?.key)
      return
    }
    const item = byKey.get(key)
    if (item === undefined) return
    if (item.toggle !== undefined) {
      setSwitches(new Map(switches()).set(key, !(switches().get(key) ?? false)))
      return
    }
    setChosen(`Chose ${item.title}`)
  }
  const preview = (): JSX.Element | undefined => {
    const item = currentItem()
    if (item?.schema === undefined) return undefined
    return (
      <ProductSearchNodePreview
        drawing={<NodeDrawing schema={item.schema} registry={props.registry} subgraph={item.kind === 'blueprints'} />}
        title={item.title}
        {...(item.description === undefined ? {} : { description: item.description })}
        place={item.kind === 'blueprints' ? 'Blueprint - dinkster-nodes-dev' : 'dev / image - dinkster-nodes-dev'}
        {...(item.notInstalled ? { flags: ['Not installed'] } : {})}
      />
    )
  }
  const enterLabel = () => {
    const key = currentKey()
    if (key?.startsWith('more:')) return 'show all'
    const item = currentItem()
    return item === undefined ? 'open' : item.notInstalled ? 'install' : ENTER[item.kind]
  }
  return (
    <div class="dinkster-search-stage">
      <div class="dinkster-window-toolbar-search">
        <ProductWindowAction label="Search Dinkster" icon={Search} shortcut="Ctrl+K" aria-expanded="true" />
      </div>
      <ProductSearch
        label="Search Dinkster"
        placeholder="Search Dinkster"
        query={query()}
        onQuery={(text) => {
          setQuery(text)
          setOpened(new Set<Kind>())
        }}
        kinds={kinds()}
        kind={kind()}
        onKind={(id) => setKind(id as 'all' | Kind)}
        groups={groups()}
        {...(currentKey() === undefined ? {} : { current: currentKey()! })}
        onCurrent={setCurrent}
        onActivate={activate}
        onClose={() => setQuery('')}
        empty={{ title: 'No matches', detail: `Nothing is called "${query()}".` }}
        hints={[
          { keys: ['Up', 'Down'], label: 'move' },
          { keys: ['Enter'], label: enterLabel() },
          { keys: ['Tab'], label: 'next kind' },
          { keys: ['Esc'], label: 'close' },
        ]}
        preview={preview()}
        previewPlace="floating"
        testId={props.testId}
      />
      <p class="dinkster-metadata" data-testid={`${props.testId}-chosen`}>{chosen()}</p>
    </div>
  )
}

export function SearchGallery() {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  const examples: readonly { title: string; text: string; props: Omit<Parameters<typeof CtrlKExample>[0], 'registry'> }[] = [
    { title: 'Before you type', text: 'It opens under the field it belongs to, with what was used last and the open tabs. Tab steps through the kinds.', props: { testId: 'search-before' } },
    { title: 'After typing', text: 'The best few of each kind, one line each, the match marked, where the thing lives at the right. On a node, its preview floats to the right of the list.', props: { query: 'image', current: 'nodes:ImageBatchtoList', testId: 'search-typed' } },
    { title: 'On a blueprint', text: 'Blueprints are a kind of their own and show the same preview.', props: { query: 'image', current: 'blueprints:image-to-video', testId: 'search-blueprint' } },
    { title: 'On a setting', text: 'Any other kind of row has no panel. A setting that is a switch can be flipped in its row.', props: { query: 'image', current: 'settings:previews', testId: 'search-setting' } },
    { title: 'Waiting for workflows', text: "Workflows come from the engine's library; the other kinds show at once.", props: { query: 'image', loadingWorkflows: true, current: 'commands:none', testId: 'search-loading' } },
    { title: 'Nothing found', text: 'The list says so in its own place.', props: { query: 'zebra', testId: 'search-empty' } },
  ]
  return (
    <For each={examples}>
      {(example) => (
        <ProductSection title={example.title}>
          <p class="dinkster-description">{example.text}</p>
          <CtrlKExample {...example.props} registry={registry} />
        </ProductSection>
      )}
    </For>
  )
}
