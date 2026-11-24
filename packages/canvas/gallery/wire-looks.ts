import type { NodeSchema, OutputSpec } from '@dinkster/core'
import {
  dropTargetKey,
  pinPosition,
  type DesignTokens,
  type OverlayState,
  type PresenceActor,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'
import { COLUMN, joined, out, schema, sceneOf, type Graph } from './switch-primitive.js'
import { widgetTapGallery } from './widget-taps.js'

/** One card of the wire looks page, drawn from a scene of its own. */
export interface WireLookCard {
  readonly caption: string
  readonly scene: Scene
  readonly overlay?: OverlayState
  readonly presence?: readonly PresenceActor[]
  readonly inactive?: ReadonlySet<string>
}

const input = (id: string, type: string, optional = false) => ({
  kind: 'input' as const,
  id,
  displayName: id,
  type: { kind: 'concrete' as const, name: type },
  optional,
})
const loadImage = schema('Load Image', 'Load Image', [out('IMAGE', 'IMAGE')])
/** A detector that may find no face, so its wire may carry nothing. */
const findFace = schema('Find Face', 'Find Face', [
  { ...out('IMAGE', 'IMAGE'), optional: true } satisfies OutputSpec,
])
const blur = schema('Blur', 'Blur', [input('image', 'IMAGE'), out('IMAGE', 'IMAGE')])
/** Takes a face when there is one. */
const retouch = schema('Retouch', 'Retouch', [input('face', 'IMAGE', true), out('IMAGE', 'IMAGE')])
const sampler = schema('Sampler', 'Sampler', [input('latent', 'LATENT'), out('LATENT', 'LATENT')])

const SOURCE_WIDTH = 160
const pair = (
  source: NodeSchema,
  sourcePort: string,
  sink: NodeSchema,
  sinkPort: string,
  y: number,
  wired = true,
  id = '',
  gap = 0,
  drop = 0,
): Graph => ({
  nodes: {
    [`from${id}`]: { type: source, x: 0, y, width: SOURCE_WIDTH },
    [`to${id}`]: { type: sink, x: COLUMN + gap, y: y + drop, width: SOURCE_WIDTH },
  },
  links: wired ? [[`from${id}`, sourcePort, `to${id}`, sinkPort]] : [],
})
const merged = (...graphs: Graph[]): Graph => ({
  nodes: Object.assign({}, ...graphs.map((graph) => graph.nodes)),
  links: graphs.flatMap((graph) => graph.links ?? []),
  ...Object.assign({}, ...graphs.map((graph) => ({ ...(graph.extra ? { extra: graph.extra } : {}), ...(graph.extraView ? { extraView: graph.extraView } : {}) }))),
})

/** A wire held from Load Image's output over Blur's image pin. */
function held(scene: Scene): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const from = pinPosition(scene.nodes.find((node) => node.id === 'from')!, 'IMAGE', 'out')!
  const to = pinPosition(scene.nodes.find((node) => node.id === 'to')!, 'image', 'in')!
  return { from, to }
}

export function wireLooksGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly WireLookCard[] {
  const scene = (graph: Graph) => sceneOf(tokens, measure, widgetMeasure, { root: graph }, { graph: 'root' })

  // A wire that gives nothing: the Widget output pins page's row that stays
  // for its wire under an option not chosen, drawn as that page draws it.
  const taps = widgetTapGallery(tokens, measure, widgetMeasure)
  const keptExample = taps.examples.find((example) => example.caption.startsWith('A row that stays for its wire, under an option not chosen'))!
  const keptNodes = keptExample.nodes.map((index) => taps.scene.nodes[index]!)
  const keptIds = new Set(keptNodes.map((node) => node.id))
  const kept: Scene = {
    ...taps.scene,
    nodes: keptNodes,
    links: taps.scene.links.filter((link) =>
      'node' in link.from && 'node' in link.to && keptIds.has(link.from.node) && keptIds.has(link.to.node)),
  }

  // A muted and a bypassed source, each with a wire out, under the wire
  // that gives nothing.
  const keptBottom = Math.max(...keptNodes.map((node) => node.y + node.layout.height))
  const keptLeft = Math.min(...keptNodes.map((node) => node.x))
  const modePair = (mode: 'muted' | 'bypassed', y: number): Graph => {
    const graph = pair(loadImage, 'IMAGE', blur, 'image', y, true, mode, 120)
    return { ...graph, nodes: { ...graph.nodes, [`from${mode}`]: { ...graph.nodes[`from${mode}`]!, mode, title: mode === 'muted' ? 'Muted source' : 'Bypassed source' } } }
  }
  const moded = scene(merged(modePair('muted', keptBottom + 50), modePair('bypassed', keptBottom + 160)))
  const dx = keptLeft
  const besideKept = joined(kept, {
    ...moded,
    nodes: moded.nodes.map((node) => ({ ...node, x: node.x + dx })),
    links: moded.links.map((link) => ({ ...link, x1: link.x1 + dx, x2: link.x2 + dx })),
  })

  const apart = (wired = false) => pair(loadImage, 'IMAGE', blur, 'image', 0, wired, '', 160, 70)
  const dragged = scene(apart())
  const drag = held(dragged)
  const peer = scene(apart())
  const peerDrag = held(peer)
  const peerCursor = { x: peerDrag.to.x - 70, y: peerDrag.to.y - 10 }

  const unchanged = scene(merged(
    pair(loadImage, 'IMAGE', sampler, 'latent', 0, true, 'Mismatch'),
    pair(loadImage, 'IMAGE', blur, 'image', 110, true, 'Selected'),
    pair(loadImage, 'IMAGE', blur, 'image', 220, true, 'Outside'),
  ))
  const selectedLink = unchanged.links.find((link) => 'node' in link.to && link.to.node === 'toSelected')!

  const outlines = scene(pair(loadImage, 'IMAGE', blur, 'image', 0, false, '', 160))
  const outlineGroup = { id: 'sources', title: 'Sources', x: -20, y: 170, width: 600, height: 110 }

  return [
    {
      caption:
        'An ordinary wire is solid. A wire that may carry nothing is dashed in its type\'s color, and its source pin has a dark dot: Find Face may find no face.',
      scene: scene(merged(
        pair(loadImage, 'IMAGE', blur, 'image', 0, true, 'Ordinary', 120),
        pair(findFace, 'IMAGE', retouch, 'face', 110, true, 'Maybe', 120),
      )),
    },
    {
      caption:
        'A wire that gives nothing, from a row kept for its wire under an option not chosen, has the same dashes and stays faded (top). A wire out of a muted node is faded like the node, in its type\'s color, and gains no dashes. A wire out of a bypassed node is drawn as it would be from an active node.',
      scene: besideKept,
    },
    {
      caption:
        'A wire being dragged is solid in its type\'s color, held over the pin that takes it.',
      scene: dragged,
      overlay: {
        ghostLink: { x1: drag.from.x, y1: drag.from.y, x2: drag.to.x, y2: drag.to.y, typeName: 'IMAGE' },
        dropTargets: new Set([dropTargetKey('to', 'image', 'in')]),
      },
    },
    {
      caption: 'Another person\'s drag is solid in their color, faded as before.',
      scene: peer,
      presence: [{
        id: 'peer',
        label: 'Sam',
        color: tokens.colors.selection,
        selection: new Set(),
        cursor: peerCursor,
        link: {
          origin: { kind: 'port', node: 'from', port: 'IMAGE', side: 'out' },
          cursor: peerCursor,
        },
      }],
    },
    {
      caption: 'A named net shown as its tags with a guide line: the guide is solid, at the same width and casing.',
      scene: scene({
        ...pair(loadImage, 'IMAGE', blur, 'image', 0, false, '', 200, 90),
        extra: {
          nets: {
            net: { id: 'net', name: 'Reference image', source: { node: 'from', port: 'IMAGE' }, sinks: [{ node: 'to', port: 'image' }] },
          },
        },
        extraView: { collapsedNets: ['net'], guideNets: ['net'] },
      }),
    },
    {
      caption:
        'Unchanged: a wire whose types do not fit is red, a selected wire has its outline, and a wire outside the highlight is faded. A hidden wire is not drawn.',
      scene: unchanged,
      overlay: { linkSelection: new Set([selectedLink.id]) },
      inactive: new Set(['fromOutside', 'toOutside']),
    },
    {
      caption:
        'Outlines that are not wires stay dashed: a group being resized, the selection marquee, and another person dragging a node.',
      scene: { ...outlines, groups: [outlineGroup] },
      overlay: {
        groupResizeGhost: { groupId: 'sources', x: -20, y: 170, width: 420, height: 100 },
        marquee: { x1: -12, y1: -12, x2: SOURCE_WIDTH + 12, y2: 66 },
      },
      presence: [{
        id: 'peer',
        label: 'Sam',
        color: tokens.colors.selection,
        selection: new Set(),
        drag: new Map([['to', { dx: -40, dy: 80 }]]),
      }],
    },
  ]
}
