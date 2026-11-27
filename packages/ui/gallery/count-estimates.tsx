import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import {
  asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, coreCommandRegistry,
  createLocalSession, documentResolver, parseDinksterSchema, type NodeSchema, type WorkflowDocument,
} from '@dinkster/core'
import {
  CanvasRenderer, buildScene, canvasColorsForTheme, canvasTypePaintForTheme, createRegistryPainter,
  defaultTokens, problemBadge, PROBLEM_WARNING_BADGE, type WidgetMeasure,
} from '@dinkster/canvas'
import { createWidgetRegistry, registerCoreWidgets, widgetRegistrationDoors } from '@dinkster/widgets'
import flowSchemas from '../../core/test/fixtures/flow_schemas.json'
import { listCountOffers, useListCountEstimate } from '../../app/src/list-count-offers.js'
import { CountEstimateBox, ProblemBox } from '../src/index.js'

const parsed = parseDinksterSchema('dinkster.utilities.unpack', flowSchemas['dinkster.utilities.unpack'] as never).schema!
const unpack = { ...parsed, body: parsed.body.map(row => row.kind === 'input' && row.id === 'count'
  ? { ...row, listCountOf: 'list' } : row) }
const source: NodeSchema = { ...parsed, type: 'gallery.list', displayName: 'List', body: [
  { kind: 'output', id: 'list', type: { kind: 'list', element: { kind: 'concrete', name: 'INT' } } },
] }
const sink = parseDinksterSchema('dinkster.utilities.has_value', flowSchemas['dinkster.utilities.has_value'] as never).schema!
const resolve = (type: string) => type === unpack.type ? unpack : type === source.type ? source : type === sink.type ? sink : undefined
const states = ['ready', 'limit', 'reading', 'unavailable', 'problem', 'drop'] as const
type State = typeof states[number]

function CountEstimateCard(props: { state: State; theme: 'dark' | 'light' }) {
  let canvas!: HTMLCanvasElement
  let frame!: HTMLDivElement
  const document: WorkflowDocument = { format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('gallery'),
    root: asGraphDefId('root'), graphs: { root: { id: asGraphDefId('root'), name: 'Root', nextOrdinal: 1, nets: {}, reroutes: {},
      nodes: { list: { id: asNodeId('list'), type: source.type, values: {} },
        unpack: { id: asNodeId('unpack'), type: unpack.type, values: { count: 3 } },
        ...(props.state === 'drop' ? { sink: { id: asNodeId('sink'), type: sink.type, values: {} } } : {}) },
      links: { l: { id: asLinkId('l'), from: { node: asNodeId('list'), port: asPortId('list') },
        to: { node: asNodeId('unpack'), port: asPortId('list') } },
        ...(props.state === 'drop' ? { excess: { id: asLinkId('excess'), from: { node: asNodeId('unpack'), port: asPortId('items.2') },
          to: { node: asNodeId('sink'), port: asPortId('value') } } } : {}) } } },
    view: { graphs: { root: { nodes: { list: { position: { x: 16, y: 16 }, size: { width: 160, height: 0 } },
      unpack: { position: { x: 240, y: 16 }, size: { width: 280, height: 0 } },
      sink: { position: { x: 600, y: 120 }, size: { width: 160, height: 0 } } } } } } }
  const session = createLocalSession(document, coreCommandRegistry([], resolve), { schemaResolverFor: doc => documentResolver(doc, resolve) })
  const [revision, setRevision] = createSignal(0)
  const [placement, setPlacement] = createSignal({ x: 240, y: 0, width: 280 })
  const [problemHeight, setProblemHeight] = createSignal(0)
  const [used, setUsed] = createSignal(false)
  const count = () => props.state === 'limit' ? 900 : props.state === 'drop' ? 1 : 85
  const estimates = () => ({ kind: 'estimate' as const, count: count(), sources: ['last-run'] as const })
  const offer = () => { revision(); return listCountOffers(session.doc, documentResolver(session.doc, resolve), 'root', [], estimates)[0] }
  const isProblem = () => props.state === 'problem' || props.state === 'drop'
  const hasOffer = () => props.state === 'reading' || props.state === 'unavailable' || offer() !== undefined
  const registry = createWidgetRegistry()
  registerCoreWidgets(widgetRegistrationDoors(registry))
  createEffect(() => {
    revision()
    const tokens = { ...defaultTokens, ...canvasTypePaintForTheme(props.theme), colors: canvasColorsForTheme(props.theme) }
    const context = canvas.getContext('2d')!
    context.font = `${tokens.fontSize}px ${tokens.fontFamily}`
    const widgetMeasure: WidgetMeasure = spec => {
      const kind = registry.kind(spec.widgetType)
      const view = registry.viewsFor(spec.widgetType).find(view => view.id === kind?.defaultView(spec))
      return view ? { viewId: view.id, rows: view.measure(spec).rows } : undefined
    }
    const scene = buildScene({ document: session.doc, graphId: 'root', resolve: documentResolver(session.doc, resolve),
      tokens, measure: text => context.measureText(text).width, widgetMeasure, listCountEstimateOf: estimates })
    const node = scene.nodes.find(node => node.id === 'unpack')!
    const y = node.y + node.layout.height + 24
    setPlacement({ x: node.x, y, width: node.layout.width })
    const height = y + (hasOffer() || isProblem() ? 170 : 20)
    canvas.style.width = props.state === 'drop' ? '800px' : '560px'
    canvas.style.height = `${height}px`
    frame.style.height = `${height}px`
    const renderer = new CanvasRenderer(canvas, tokens, createRegistryPainter(registry))
    renderer.setReducedMotion(true)
    renderer.setGridVisible(false)
    renderer.setViewport({ x: 0, y: 0, scale: 1 })
    renderer.setScene(scene)
    if (isProblem()) renderer.setBadges({ unpack: [problemBadge(PROBLEM_WARNING_BADGE, 1)] })
    renderer.renderNow()
    onCleanup(() => renderer.dispose())
  })
  const message = () => props.state === 'reading' ? 'Reading count...' : props.state === 'unavailable' ? 'Count unavailable'
    : props.state === 'limit' ? 'Estimated count: 900. This node allows 512 outputs.' : 'Estimated count: 85, from the last run.'
  return <figure class="dinkster-canvas-example" data-testid={`count-estimate-${props.state}`}>
    <div ref={frame} class="dinkster-canvas-example-stage" data-fixed-surfaces="true">
      <canvas ref={canvas} role="img" aria-label={`Unpack estimate ${props.state}`} />
      <Show when={isProblem()}><ProblemBox nodeId="unpack" label="Problems of Unpack"
        x={placement().x} y={placement().y} minWidth={placement().width} maxWidth={placement().width}
        lines={[{ key: 'count', kind: 'warning', message: props.state === 'drop'
          ? 'Unpack expected 3 items; this run returned 1.' : 'Unpack expected 3 items; this run returned 85.', actions: [] }]}
        ref={element => {
          const observer = new ResizeObserver(() => setProblemHeight(element.getBoundingClientRect().height))
          observer.observe(element)
          onCleanup(() => observer.disconnect())
        }} /></Show>
      <Show when={hasOffer()}><CountEstimateBox x={placement().x}
        y={placement().y + (isProblem() ? problemHeight() + 8 : 0)} width={placement().width}
        message={message()} {...(props.state === 'reading' ? {} : { action: props.state === 'unavailable' ? 'Try again' : `Use ${count()}` })}
        disabled={props.state === 'limit'} onAction={() => {
          if (props.state === 'unavailable') return
          const current = offer()
          if (!current || current.limit !== undefined) return
          if (session.dispatch(useListCountEstimate('root', [], current)).ok) {
            setUsed(true)
            setRevision(value => value + 1)
          }
        }} /></Show>
    </div>
    <figcaption class="dinkster-metadata">{used() ? 'After Use 85: 85 outputs, no estimate box.'
      : props.state === 'reading' || props.state === 'unavailable'
        ? `${props.state}: visual fixture; no asset provider connected.`
        : props.state === 'drop' ? 'Estimate drop: wired Item 2 stays dimmed and gives nothing.'
        : props.state === 'limit' ? 'Above declared limit: Use is disabled.'
        : props.state === 'problem' ? 'Problem first, neutral offer 8px below.'
        : '3 stored, 85 estimated. Press Use 85 to add outputs.'}</figcaption>
  </figure>
}

export function CountEstimatesGallery(props: { theme: 'dark' | 'light' }) {
  return <div class="dinkster-canvas-examples"><For each={states}>{state => <CountEstimateCard state={state} theme={props.theme} />}</For></div>
}
