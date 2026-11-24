import { For, Show, createEffect, onCleanup } from 'solid-js'
import {
  defaultValuesOf,
  elabInputsOf,
  elaborateInterface,
  loadDocument,
  type InputSpec,
  type Json,
  type LookedState,
  type LookedWidgetField,
  type LookupAnswerState,
  type NodeSchema,
  type WidgetRegistry,
  type WidgetSpec,
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
  type TextMeasurer,
  type WidgetMeasure,
} from '@dinkster/canvas'
import {
  createWidgetRegistry,
  numberFieldFacts,
  registerCoreWidgets,
  widgetRegistrationDoors,
} from '@dinkster/widgets'
import { CanvasSidePart, ProductLink, ProductSection } from '../src/index.js'

const NODE_WIDTH = 300
const MARGIN = 16

const concrete = (name: string) => ({ kind: 'concrete', name }) as const
const lookup = (name: string, ...args: string[]) => ({ lookup: `dinkster_nodes_dev.lookups.${name}`, args })
const field = (id: string, widget: WidgetSpec, extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: concrete(widget.widgetType),
  optional: false,
  widget,
  ...extra,
})

/** The development pack's LoRA picker: everything below its category comes from lookups that read it. */
const picker: NodeSchema = {
  type: 'LoRA by category',
  displayName: 'LoRA by category',
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body: [
    { kind: 'input', id: 'model', type: concrete('MODEL'), optional: false },
    { kind: 'output', id: 'MODEL', type: concrete('MODEL') },
    field('category', { widgetType: 'COMBO', options: { options: ['sd', 'sdxl'] }, default: 'sd' }),
    field('lora', { widgetType: 'COMBO', options: {}, looked: { options: lookup('loras_in', 'category') }, default: 'detail.safetensors' }),
    field('strength', { widgetType: 'FLOAT', options: { min: 0, step: 0.05 }, looked: { max: lookup('strength_max', 'category') }, default: 1 }),
    field('frames', { widgetType: 'INT', options: { min: 1, max: 121, step: 4 }, looked: { offset: lookup('frame_start', 'category') }, default: 17 }),
    { kind: 'note', id: 'count', text: lookup('lora_count', 'category'), unknown: 'LoRA count not known.' },
  ],
}
const source: NodeSchema = {
  type: 'Category source',
  displayName: 'Category source',
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body: [{ kind: 'output', id: 'category', type: concrete('COMBO') }],
}

type Held = Readonly<Record<string, LookupAnswerState>>
const key = (name: string, ...args: Json[]): string => JSON.stringify([`dinkster_nodes_dev.lookups.${name}`, args])
const LORAS = ['detail.safetensors', { value: 'film-grain.safetensors', label: 'Film grain', folder: 'styles' }]
const readyFor = (category: string): Held => ({
  [key('loras_in', category)]: { state: 'ready', answer: LORAS },
  [key('strength_max', category)]: { state: 'ready', answer: 2 },
  [key('frame_start', category)]: { state: 'ready', answer: 1 },
  [key('lora_count', category)]: { state: 'ready', answer: `12 LoRAs in ${category}.` },
})
const each = (answer: LookupAnswerState, category = 'sd'): Held =>
  Object.fromEntries(['loras_in', 'strength_max', 'frame_start', 'lora_count'].map((name) => [key(name, category), answer]))

interface Example {
  readonly id: string
  readonly title: string
  readonly caption: string
  readonly values?: Readonly<Record<string, Json>>
  /** Category comes from a wire: its value is not known. */
  readonly wired?: true
  /** Answers the editor holds, by call; 'off' where lookups are not called. */
  readonly held: Held | 'off'
}

const noteExamples: readonly Example[] = [
  { id: 'ready', title: 'Ready', caption: 'The answer replaces the note\'s unknown text. No state line.', held: readyFor('sd') },
  { id: 'loading', title: 'Loading, no answer', caption: 'The declared unknown text, dimmed, and Loading... under it. Nothing is stored.', held: {} },
  {
    id: 'stale',
    title: 'Stale, same arguments',
    caption: 'A refresh failed: the earlier answer for sd stays, with Could not refresh and Try again under it.',
    held: { ...readyFor('sd'), [key('lora_count', 'sd')]: { state: 'stale', answer: '12 LoRAs in sd.', reason: 'failed' } },
  },
  {
    id: 'unavailable',
    title: 'Unavailable, no answer',
    caption: 'No answer for these arguments: the unknown text, never an answer from another category. The error itself goes to the doctor.',
    held: { [key('lora_count', 'sd')]: { state: 'unavailable', reason: 'timeout' } },
  },
  {
    id: 'waiting',
    title: 'Waiting for a wired input',
    caption: 'category comes from a wire, so its value is not known: nothing is called, and there is no Try again.',
    wired: true,
    held: {},
  },
  {
    id: 'changed',
    title: 'Argument changed during a call',
    caption: 'category changed from sd to sdxl while sd was loading. The late sd answer is kept for sd only and never shown for sdxl.',
    values: { category: 'sdxl' },
    held: readyFor('sd'),
  },
  {
    id: 'paused',
    title: 'Paused by the editing budget',
    caption: 'More than 8 calls under way or 60 a minute: the note keeps what it shows and says Paused. A run is not affected.',
    held: { [key('lora_count', 'sd')]: { state: 'paused', answer: '12 LoRAs in sd.' } },
  },
  {
    id: 'offline',
    title: 'Backend not connected',
    caption: 'The call could not reach the backend: Offline, with Try again.',
    held: { [key('lora_count', 'sd')]: { state: 'unavailable', reason: 'offline' } },
  },
  {
    id: 'file',
    title: 'File not checked yet',
    caption: 'A lookup that reads a local file waits until the host has checked it. No Try again.',
    held: { [key('lora_count', 'sd')]: { state: 'unavailable', reason: 'file-unchecked' } },
  },
  { id: 'off', title: 'Search or registry preview', caption: 'Lookups are off in previews: no calls, and the note says so.', held: 'off' },
  {
    id: 'wrong-shape',
    title: 'Wrong shape',
    caption: 'The lookup answered a number where the note needs text: unavailable, with Try again. Nothing is repaired.',
    held: { [key('lora_count', 'sd')]: { state: 'ready', answer: 12 } },
  },
]

const closedExamples: readonly Example[] = [
  {
    id: 'closed-loading',
    title: 'Closed rows while loading',
    caption: 'Closed, a list and a range show the stored value in every state, with no status strip and nothing pushed onto the next row.',
    held: { [key('lora_count', 'sd')]: { state: 'loading' } },
  },
  {
    id: 'closed-ready',
    title: 'Closed rows, ready',
    caption: 'The same rows with every answer in. The note shows its text; the rows look as they did while loading.',
    held: readyFor('sd'),
  },
  {
    id: 'closed-late-limit',
    title: 'A late limit below the stored number',
    caption: 'strength is stored as 3 and the lookup gives a max of 2. The number stays 3 and nothing is written; the open range line says 0 to 2.',
    values: { strength: 3 },
    held: readyFor('sd'),
  },
]

interface RangeExample {
  readonly id: string
  readonly title: string
  readonly caption: string
  readonly held: Held | 'off'
  readonly row: 'strength' | 'frames'
  readonly wired?: true
}

const rangeExamples: readonly RangeExample[] = [
  { id: 'range-loading', title: 'Loading', caption: 'The range line has the spinner and says loading. Any number is accepted meanwhile.', row: 'strength', held: {} },
  { id: 'range-ready', title: 'Ready', caption: 'The range line shows the numbers, as for any number.', row: 'strength', held: readyFor('sd') },
  {
    id: 'range-stale',
    title: 'Stale',
    caption: 'The last range for these arguments, with a dimmed line saying it could not update.',
    row: 'strength',
    held: { [key('strength_max', 'sd')]: { state: 'stale', answer: 2, reason: 'failed' } },
  },
  {
    id: 'range-unavailable',
    title: 'Unavailable',
    caption: 'The range line says not available. Not yellow: a run goes ahead.',
    row: 'strength',
    held: { [key('strength_max', 'sd')]: { state: 'unavailable', reason: 'failed' } },
  },
  {
    id: 'range-contradiction',
    title: 'Limits that contradict',
    caption: 'The lookup gave a max below min: a wrong shape, never swapped or repaired.',
    row: 'strength',
    held: { [key('strength_max', 'sd')]: { state: 'ready', answer: -1 } },
  },
  { id: 'range-waiting', title: 'Waiting for an input', caption: 'category comes from a wire: not called, and the range line names what it waits for.', row: 'strength', wired: true, held: {} },
  {
    id: 'range-paused',
    title: 'Paused',
    caption: 'Over the editing budget with no answer yet: the range line says paused.',
    row: 'strength',
    held: { [key('strength_max', 'sd')]: { state: 'paused' } },
  },
  {
    id: 'range-offset',
    title: 'Offset not known yet',
    caption: 'frames counts its step of 4 from an offset a lookup gives. Until it comes there is no step grid: the arrows move by 4 from the value and a typed whole number is kept.',
    row: 'frames',
    held: {},
  },
]

const answersOf = (held: Held | 'off') => held === 'off' ? undefined : (name: string, args: readonly Json[]) => held[JSON.stringify([name, args])]

function documentOf(values: Readonly<Record<string, Json>>, wired: boolean) {
  const id = 'picker'
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
          [id]: { id, type: picker.type, values: { ...defaultValuesOf(picker), ...values } },
          ...(wired ? { source: { id: 'source', type: source.type, values: {} } } : {}),
        },
        links: wired ? { wire: { id: 'wire', from: { node: 'source', port: 'category' }, to: { node: id, port: 'category' } } } : {},
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [id]: { position: { x: MARGIN, y: MARGIN }, size: { width: NODE_WIDTH, height: 0 } },
            ...(wired ? { source: { position: { x: -400, y: MARGIN }, size: { width: 160, height: 0 } } } : {}),
          },
        },
      },
    },
  })
  if (!loaded.document) throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return loaded.document
}

const resolve = (type: string) => (type === picker.type ? picker : type === source.type ? source : undefined)

function NodeExample(props: { example: Example; theme: 'dark' | 'light'; registry: WidgetRegistry }) {
  let canvas!: HTMLCanvasElement
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
      const answers = answersOf(example.held)
      const built = buildScene({
        document: documentOf(example.values ?? {}, example.wired === true),
        graphId: 'gallery',
        resolve,
        tokens,
        measure,
        widgetMeasure,
        ...(answers === undefined ? {} : { lookupAnswers: answers }),
      })
      const node = built.nodes.find((item) => item.node.type === picker.type)!
      canvas.style.width = `${NODE_WIDTH + MARGIN * 2}px`
      canvas.style.height = `${node.layout.height + MARGIN * 2}px`
      renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(props.registry))
      renderer.setReducedMotion(true)
      renderer.setGridVisible(false)
      renderer.setScene(built)
      renderer.setViewport({ x: 0, y: 0, scale: 1 })
      renderer.renderNow()
      canvas.dataset['ready'] = `${example.id}-${theme}`
    })
    onCleanup(() => {
      disposed = true
      renderer?.dispose()
      delete canvas.dataset['ready']
    })
  })
  return (
    <figure class="dinkster-canvas-example" data-testid={`lookup-${props.example.id}`}>
      <canvas ref={canvas} role="img" aria-label={`${props.example.title} in ${props.theme} theme`} />
      <figcaption class="dinkster-metadata">
        <strong>{props.example.title}.</strong> {props.example.caption}
      </figcaption>
    </figure>
  )
}

/** The open row's side part, worked out from the same elaboration the canvas uses. */
function RangeExampleView(props: { example: RangeExample }) {
  const facts = () => {
    const answers = answersOf(props.example.held)
    const wired = props.example.wired === true
    const document = documentOf({}, wired)
    const node = document.graphs['gallery']!.nodes['picker']!
    const elaborated = elaborateInterface(picker, node, {
      isInputConnected: (port) => wired && port === 'category',
      isOutputConnected: () => false,
    }, answers === undefined ? {} : { lookupAnswers: answers })
    const input = elabInputsOf(elaborated).find((item) => item.spec.id === props.example.row)!
    const label = (port: string) => elabInputsOf(elaborated).find((item) => item.spec.id === port)?.spec.displayName ?? port
    const looked = Object.fromEntries(Object.entries(input.looked ?? {}).map(([name, state]) =>
      [name, state.state === 'waiting' ? { ...state, input: label(state.input) } : state])) as Partial<Record<LookedWidgetField, LookedState>>
    return numberFieldFacts(input.spec.widget!, looked)
  }
  return (
    <figure class="dinkster-canvas-example" data-testid={`lookup-${props.example.id}`}>
      <div class="dinkster-canvas-example-side dinkster-canvas-field-side">
        <p class="dinkster-metadata">{props.example.row}</p>
        <CanvasSidePart
          facts={facts().map((fact) => ({
            key: fact.key,
            value: (
              <>
                <Show when={fact.busy === true}>
                  <span class="dinkster-spinner dinkster-canvas-side-spinner" aria-hidden="true" />
                </Show>
                {fact.text}
                <Show when={fact.note}>{(note) => <span class="dinkster-canvas-side-note">{note()}</span>}</Show>
              </>
            ),
          }))}
        />
      </div>
      <figcaption class="dinkster-metadata">
        <strong>{props.example.title}.</strong> {props.example.caption}
      </figcaption>
    </figure>
  )
}

/** Every state of a field or note worked out by a declared lookup, from the production elaboration and renderer. */
export function LookupsGallery(props: { theme: 'dark' | 'light' }) {
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  return (
    <>
      <ProductSection title="Notes">
        <div class="dinkster-canvas-examples">
          <For each={noteExamples}>{(example) => <NodeExample example={example} theme={props.theme} registry={registry} />}</For>
        </div>
      </ProductSection>
      <ProductSection title="Closed rows">
        <div class="dinkster-canvas-examples">
          <For each={closedExamples}>{(example) => <NodeExample example={example} theme={props.theme} registry={registry} />}</For>
        </div>
      </ProductSection>
      <ProductSection title="The range line of an open number">
        <div class="dinkster-canvas-examples">
          <For each={rangeExamples}>{(example) => <RangeExampleView example={example} />}</For>
        </div>
      </ProductSection>
      <ProductSection title="Lists">
        <p class="dinkster-metadata">
          A list from a lookup opens in its row with the same states: loading, ready, ready and empty, refreshing, stale, failed,
          waiting for an input, a changed argument, paused, off in previews, and a stored choice missing from the answer.
          They are drawn on <ProductLink href="?page=row-lists#canvas">Lists in the row</ProductLink>, under States of a list from a lookup.
        </p>
      </ProductSection>
    </>
  )
}
