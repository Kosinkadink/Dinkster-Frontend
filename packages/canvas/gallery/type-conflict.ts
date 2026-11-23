import type { NodeSchema, TypeExpr } from '@dinkster/core'
import {
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  dropTargetKey,
  pinPosition,
  type BadgeMap,
  type NodeBadge,
  type DesignTokens,
  type OverlayState,
  type PortProblemMap,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'
import { COLUMN, out, schema, sceneOf, type Graph } from './switch-primitive.js'

/** One card of the type conflict page, drawn from a solved scene of its own. */
export interface TypeConflictCard {
  readonly caption: string
  readonly scene: Scene
  readonly badges: BadgeMap
  readonly portProblems: PortProblemMap
  readonly overlay?: OverlayState
}

const T: TypeExpr = { kind: 'variable', templateId: 'T' }

const loadImage = schema('Load Image', 'Load Image', [out('IMAGE', 'IMAGE')])
const text = schema('Text', 'Text', [out('STRING', 'STRING')])
const int = schema('Int', 'Int', [out('INT', 'INT')])
/** An ordinary node with one type variable on two inputs and its output. */
const blend = schema('Blend', 'Blend', [
  { kind: 'input', id: 'image1', displayName: 'image 1', type: T, optional: false },
  { kind: 'input', id: 'image2', displayName: 'image 2', type: T, optional: false },
  { kind: 'output', id: 'result', displayName: 'result', type: T },
])
/** A Switch whose branches and Value share one type variable. */
const switchNode: NodeSchema = {
  ...schema('Switch', 'Switch', [
    {
      kind: 'input',
      id: 'pick',
      displayName: 'Pick',
      type: { kind: 'union', names: ['INT', 'BOOLEAN', 'STRING', 'COMBO'] },
      optional: false,
      widget: {
        widgetType: 'COMBO',
        options: { options: ['branch 1', 'branch 2'] },
        default: 'branch 1',
      },
    },
    {
      kind: 'group',
      id: 'branch',
      value: { kind: 'input', id: 'branch', type: T, optional: true, lazy: true },
      keys: { kind: 'numbered', prefix: 'branch', start: 1, pad: 0 },
      grows: 'button',
      minMembers: 1,
      maxMembers: 8,
    },
    { kind: 'output', id: 'value', displayName: 'Value', type: T },
  ]),
  selector: { input: 'pick', group: 'branch' },
} as NodeSchema

const SOURCE_WIDTH = 150
const sources = (withInt: boolean): Graph['nodes'] => ({
  image: { type: loadImage, x: 0, y: 0, width: SOURCE_WIDTH },
  text: { type: text, x: 0, y: 90, width: SOURCE_WIDTH },
  ...(withInt ? { int: { type: int, x: 0, y: 180, width: SOURCE_WIDTH } } : {}),
})
const blendGraph = (both: boolean): Graph => ({
  nodes: { ...sources(false), blend: { type: blend, x: COLUMN, y: 20 } },
  links: [
    ['image', 'IMAGE', 'blend', 'image1'],
    ...(both ? [['text', 'STRING', 'blend', 'image2'] as const] : []),
  ],
})
const switchGraph = (both: boolean, wiredPick: boolean): Graph => ({
  nodes: {
    ...sources(wiredPick),
    sw: {
      type: switchNode,
      x: COLUMN,
      y: 20,
      dynamic: { branch: { members: ['branch1', 'branch2'] } },
    },
  },
  links: [
    ['image', 'IMAGE', 'sw', 'branch.branch1'],
    ...(both ? [['text', 'STRING', 'sw', 'branch.branch2'] as const] : []),
    ...(wiredPick ? [['int', 'INT', 'sw', 'pick'] as const] : []),
  ],
})

/**
 * The marks the app derives from the solver's problems: a badge and outline
 * on the node and a ring on the input the problem is anchored to.
 */
function problemMarks(scene: Scene): Pick<TypeConflictCard, 'badges' | 'portProblems'> {
  const badges: Record<string, NodeBadge[]> = {}
  const ports: Record<string, Record<string, 'error' | 'warning'>> = {}
  for (const diagnostic of scene.diagnostics) {
    const port = diagnostic.anchor?.port
    if (port === undefined || diagnostic.severity === 'info') continue
    const kind = diagnostic.severity === 'error' ? 'error' : 'warning'
    const badge = kind === 'error' ? PROBLEM_ERROR_BADGE : PROBLEM_WARNING_BADGE
    const list = (badges[port.node] ??= [])
    if (!list.includes(badge)) list.push(badge)
    ;(ports[port.node] ??= {})[port.port] = kind
  }
  return { badges, portProblems: ports }
}

/**
 * A STRING wire held over the second input. Only inputs that take a STRING
 * are offered: none on Blend, and Pick on the Switch, which takes a text
 * naming a branch.
 */
function heldOver(scene: Scene, node: string, port: string, offered: readonly string[]): OverlayState {
  const from = pinPosition(scene.nodes.find((n) => n.id === 'text')!, 'STRING', 'out')!
  const to = pinPosition(scene.nodes.find((n) => n.id === node)!, port, 'in')!
  return {
    ghostLink: { x1: from.x, y1: from.y, x2: to.x, y2: to.y, typeName: 'STRING' },
    dropTargets: new Set(offered.map((id) => dropTargetKey(node, id, 'in'))),
  }
}

export function typeConflictGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly TypeConflictCard[] {
  const card = (caption: string, graph: Graph, overlay?: (scene: Scene) => OverlayState): TypeConflictCard => {
    const scene = sceneOf(tokens, measure, widgetMeasure, { root: graph }, { graph: 'root' })
    return { caption, scene, ...problemMarks(scene), ...(overlay ? { overlay: overlay(scene) } : {}) }
  }
  return [
    card(
      'Blend takes one type on image 1, image 2 and its result. Wiring a STRING to image 2 beside an IMAGE on image 1 is an error: the node and its ring on image 2 turn red, both wires into Blend are drawn red, and Problems reads "These inputs must be the same type: image 1 is IMAGE, image 2 is STRING." Run is refused with the same words, and the engine refuses the same workflow before anything runs.',
      blendGraph(true),
    ),
    card(
      'A Switch whose Pick is wired takes one type on its branches and Value, because the branch it runs is only known while running. Branch 1 IMAGE beside branch 2 STRING is the same error: "These inputs must be the same type: branch 1 is IMAGE, branch 2 is STRING." Such a Switch ran before when it picked branch 1; it is now refused before the run.',
      switchGraph(true, true),
    ),
    card(
      'A Switch whose Pick is stored on the node runs only the branch it names, so branches of different types stay a warning and the workflow runs. The Switch shows a warning in the same words, its wires are drawn red as for every type warning, and Run is not refused.',
      switchGraph(true, false),
    ),
    card(
      'By hand the wire is not accepted: with an IMAGE on image 1, a STRING wire held over image 2 is not offered there, and releasing it makes no wire.',
      blendGraph(false),
      (scene) => heldOver(scene, 'blend', 'image2', []),
    ),
    card(
      'The same on a Switch: with an IMAGE on branch 1, a STRING wire is not offered on branch 2. A mismatch that arrives another way, by opening or pasting a workflow, through the API, or when an upstream type changes, is shown and refused as in the cards above.',
      switchGraph(false, true),
      (scene) => heldOver(scene, 'sw', 'branch.branch2', ['pick']),
    ),
  ]
}
