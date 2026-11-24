import type { InputSpec, Json, NodeSchema, OutputSpec } from '@dinkster/core'
import {
  subgraphBadge,
  toolboxButton,
  toolboxSeparator,
  type BadgeMap,
  type DesignTokens,
  type OverlayState,
  type Scene,
  type TextMeasurer,
  type ToolboxRow,
  type WidgetMeasure,
} from '../src/index.js'
import { joined, numberPrimitive, sceneOf, type Graph, type NodeEntry } from './switch-primitive.js'

const concrete = (name: string) => ({ kind: 'concrete' as const, name })
const field = (id: string, displayName: string, value: Json, options: Record<string, Json>): InputSpec => ({
  kind: 'input',
  id,
  displayName,
  type: concrete('FLOAT'),
  optional: false,
  widget: { widgetType: 'FLOAT', options, default: value },
})
const pin = (id: string): InputSpec => ({ kind: 'input', id, type: concrete('IMAGE'), optional: false })
const out: OutputSpec = { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') }
const schema = (type: string, body: NodeSchema['body']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body,
})

const upscale = schema('Upscale', [pin('image'), field('scale', 'Scale', 2, { min: 1, max: 4, step: 0.5 }), out])
const sharpen = schema('Sharpen', [pin('image'), field('amount', 'Amount', 0.4, { min: 0, max: 1, step: 0.05 }), out])

/**
 * Upscale pass: Scale is shown on the subgraph node without a wire, and
 * Strength is a Primitive inside whose value the subgraph node sends.
 */
const detail: Graph = {
  name: 'Upscale pass',
  nodes: {
    up: { type: upscale, x: 210, y: 20, width: 180 },
    sharp: { type: sharpen, x: 430, y: 20, width: 180 },
    strength: {
      type: numberPrimitive('Primitive strength', 'Strength', 'FLOAT', 0.4, { min: 0, max: 1, step: 0.05 }, false, 'Strength'),
      x: 210,
      y: 170,
      width: 180,
    },
  },
  links: [
    ['up', 'IMAGE', 'sharp', 'image'],
    ['strength', 'FLOAT', 'sharp', 'amount'],
  ],
  boundary: {
    inputs: [
      { id: 'image', displayName: 'image', binds: { kind: 'port', node: 'up', port: 'image' } },
      { id: 'scale', displayName: 'Scale', binds: { kind: 'port', node: 'up', port: 'scale' }, promoted: true, wireHidden: true },
      { id: 'strength', displayName: 'Strength', binds: { kind: 'port', node: 'strength', port: 'value' }, promoted: true, wireHidden: true },
    ],
    outputs: [{ id: 'result', displayName: 'image', binds: { kind: 'port', node: 'sharp', port: 'IMAGE' } }],
  },
  panels: { inputs: 0, outputs: 650 },
}

const instance = (x: number, y: number, title?: string): NodeEntry => ({
  type: upscale,
  instanceOf: 'detail',
  x,
  y,
  ...(title ? { title } : {}),
  values: { scale: 2, strength: 0.4 },
})

export interface SubgraphIconCard {
  readonly caption: string
  readonly scene: Scene
  readonly badges: BadgeMap
  readonly overlay?: OverlayState
}

/** The rows CanvasHost builds for one selected subgraph node in the root graph, without the run buttons. */
export const subgraphToolbox: readonly ToolboxRow[] = [[
  toolboxButton({ id: 'core.delete', icon: 'trash-2', label: 'Delete' }),
  toolboxSeparator(),
  toolboxButton({ id: 'core.mode', icon: 'sliders-horizontal', label: 'Choose mode' }),
  toolboxButton({ id: 'core.openSubgraph', icon: 'folder-open', label: 'Open subgraph' }),
  toolboxButton({ id: 'core.extractSubgraph', icon: 'group', label: 'Extract as subgraph' }),
  toolboxButton({ id: 'core.flattenSubgraph', icon: 'ungroup', label: 'Flatten subgraph one level' }),
  toolboxSeparator(),
  toolboxButton({ id: 'core.color', icon: 'circle', label: 'Choose color' }),
  toolboxSeparator(),
  toolboxButton({ id: 'core.more', icon: 'ellipsis-vertical', label: 'More actions' }),
]]

/** Every place the canvas draws the subgraph icon, each at the 14 px the product draws it. */
export function subgraphIconGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly SubgraphIconCard[] {
  const scene = (graphs: Record<string, Graph>, show: { graph: string; through?: string } = { graph: 'root' }) =>
    sceneOf(tokens, measure, widgetMeasure, graphs, show)
  const one = subgraphBadge(1)
  const two = subgraphBadge(2)
  return [
    {
      caption: 'The mark alone at the right end of the title bar of a subgraph node used once, and the same node with a long name, cut before the mark.',
      scene: scene({
        root: { nodes: { single: instance(0, 20), long: instance(240, 20, 'Upscale and sharpen the whole image twice') } },
        detail,
      }),
      badges: { single: [one], long: [one] },
    },
    {
      caption: 'The mark with a count: two subgraph nodes of one definition.',
      scene: scene({ root: { nodes: { a: instance(0, 20, 'Upscale pass A'), b: instance(240, 20, 'Upscale pass B') } }, detail }),
      badges: { a: [two], b: [two] },
    },
    {
      caption: 'Fields shown on the subgraph node, entered through it: the cyan mark before Scale on the Inputs panel and on the Upscale node inside, and on the Strength Primitive whose value the subgraph node sends.',
      scene: joined(
        scene({ root: { nodes: { entered: instance(0, 260, 'Upscale pass') } }, detail }),
        scene({ root: { nodes: { entered: instance(0, 260, 'Upscale pass') } }, detail }, { graph: 'detail', through: 'entered' }),
      ),
      badges: { entered: [one] },
    },
    {
      caption: 'A selected subgraph node and its toolbox. No toolbox button draws the subgraph icon: Open subgraph, Extract as subgraph and Flatten subgraph one level keep their icons.',
      scene: scene({ root: { nodes: { picked: instance(0, 60, 'Upscale pass') } }, detail }),
      badges: { picked: [one] },
      overlay: { selection: new Set(['picked']) },
    },
  ]
}
