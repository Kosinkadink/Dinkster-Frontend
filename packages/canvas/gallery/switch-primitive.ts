import {
  asNodeId,
  defaultValuesOf,
  documentResolver,
  loadDocument,
  occurrenceDynamicView,
  type InputSpec,
  type Json,
  type NodeProgress,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  buildScene,
  dropTargetKey,
  pinPosition,
  type CompanionMap,
  type DesignTokens,
  type OverlayState,
  type RowMarkMap,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

/**
 * One card of the Switch and Primitive page: a scene of its own, so a card
 * can show an entered subgraph with its Inputs panel beside ordinary nodes.
 */
export interface SwitchPrimitiveCard {
  readonly caption: string
  readonly scene: Scene
  readonly states?: Readonly<Record<string, NodeProgress>>
  readonly companions?: CompanionMap
  readonly rowMarks?: RowMarkMap
  readonly inactive?: ReadonlySet<string>
  readonly overlay?: OverlayState
}

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const field = (
  id: string,
  displayName: string,
  widgetType: string,
  value: Json,
  options: Record<string, Json> = {},
): InputSpec => ({
  kind: 'input',
  id,
  displayName,
  type: concrete(widgetType),
  optional: false,
  widget: { widgetType, options, default: value },
})
const pin = (id: string, type: string, displayName = id): InputSpec => ({
  kind: 'input',
  id,
  displayName,
  type: concrete(type),
  optional: false,
})
const out = (id: string, type: string, displayName = id): OutputSpec => ({
  kind: 'output',
  id,
  displayName,
  type: concrete(type),
})
const schema = (
  type: string,
  displayName: string,
  body: NodeSchema['body'],
): NodeSchema => ({
  type,
  displayName,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body,
})

/**
 * The Switch: Pick first, with the ordinary dropdown and its mode control,
 * then one typed pin per branch in authored order, then Value. A branch's
 * id is its member id and its name is the member's label, so renaming or
 * moving a branch never changes what a pick stores. Pick takes a wired
 * whole number (a position from 0), a text or choice naming a branch, or,
 * for two branches, a yes or no.
 */
const switchSchema = (
  type: string,
  valueType: string,
  names: readonly string[],
  mode: 'fixed' | 'randomize' = 'fixed',
) =>
  schema(type, 'Switch', [
    {
      kind: 'input',
      id: 'pick',
      displayName: 'Pick',
      type: { kind: 'union', names: ['INT', 'BOOLEAN', 'STRING', 'COMBO'] },
      optional: false,
      widget: {
        widgetType: 'COMBO',
        options: { options: [...names] },
        default: names[0]!,
        controller: 'after_generate',
        controllerInitial: mode,
      },
    },
    {
      kind: 'group',
      id: 'branch',
      value: { kind: 'input', id: 'branch', type: concrete(valueType), optional: true },
      keys: { kind: 'numbered', prefix: 'branch', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 1,
      maxMembers: 8,
    },
    out('value', valueType, 'Value'),
  ])
const branches = (names: readonly string[]) => ({
  branch: {
    members: names.map((_, i) => `branch${i}`),
    memberLabels: Object.fromEntries(names.map((name, i) => [`branch${i}`, name])),
    seq: names.length,
  },
})
const branchPort = (index: number) => `branch.branch${index}`
/** A member's pin is addressed by its flattened id. */
const endpoint = (node: string, port: string) => ({ node, port })

/**
 * The Primitive: one value field drawn with the widget and label of the
 * field it was made from, then a Limits section whose minimum, maximum, step
 * and default are ordinary fields of its own. An empty limit is derived from
 * the fields the Primitive feeds.
 */
const numberPrimitive = (
  type: string,
  label: string,
  kind: 'INT' | 'FLOAT',
  value: number,
  limits: Record<string, Json>,
  open = false,
  title = 'Primitive',
) =>
  schema(type, title, [
    field('value', label, kind, value, limits),
    {
      kind: 'section',
      id: 'limits',
      displayName: 'Limits',
      collapsedByDefault: !open,
      rows: (['minimum', 'maximum', 'step', 'default'] as const).map((id) => ({
        ...field(id, id[0]!.toUpperCase() + id.slice(1), kind, null, {}),
        optional: true,
      })),
    },
    out(kind, kind),
  ])
const plainPrimitive = (
  type: string,
  label: string,
  widgetType: string,
  outputType: string,
  value: Json,
  options: Record<string, Json> = {},
  title = 'Primitive',
) =>
  schema(type, title, [
    field('value', label, widgetType, value, options),
    {
      kind: 'section',
      id: 'limits',
      displayName: 'Limits',
      collapsedByDefault: true,
      rows: [{ ...field('default', 'Default', widgetType, value, options), optional: true }],
    },
    out(outputType, outputType),
  ])

const imageNode = (type: string) => schema(type, type, [out('IMAGE', 'IMAGE')])
const stepsNode = (type: string, title: string, min: number, max: number) =>
  schema(type, title, [
    pin('model', 'MODEL'),
    field('steps', 'Steps', 'INT', 6, { min, max }),
    out('LATENT', 'LATENT'),
  ])
const samplerNode = (type: string, title: string, options: readonly string[]) =>
  schema(type, title, [
    field('sampler', 'Sampler', 'COMBO', options[0]!, {
      options: [...options],
    }),
    out('LATENT', 'LATENT'),
  ])

type Endpoint = Record<string, Json>
export interface NodeEntry {
  readonly type: NodeSchema
  readonly x: number
  readonly y: number
  readonly values?: Record<string, Json>
  readonly dynamic?: Record<string, Json>
  readonly title?: string
  readonly width?: number
  /** A subgraph node: an instance of the named graph. */
  readonly instanceOf?: string
}
export interface Graph {
  readonly name?: string
  readonly nodes: Record<string, NodeEntry>
  /** [from node, from port, to node, to port], or explicit endpoints. */
  readonly links?: readonly (
    | readonly [string, string, string, string]
    | { readonly from: Endpoint; readonly to: Endpoint }
  )[]
  readonly boundary?: Json
  /** Where the boundary panels sit when the graph is entered. */
  readonly panels?: { readonly inputs: number; readonly outputs: number }
  /** Extra graph fields, such as today's value sources and selectors. */
  readonly extra?: Record<string, Json>
  readonly extraView?: Record<string, Json>
}

const NODE_WIDTH = 200
const COLUMN = 230

/**
 * Builds a document of the given graphs and paints one of them the way the
 * app does: the top level with the occurrence view, a subgraph entered
 * through one of its nodes, or a subgraph opened with no node.
 */
export function sceneOf(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  graphs: Record<string, Graph>,
  show: { readonly graph: string; readonly through?: string },
): Scene {
  const schemas = new Map<string, NodeSchema>()
  for (const graph of Object.values(graphs))
    for (const node of Object.values(graph.nodes))
      if (!node.instanceOf) schemas.set(node.type.type, node.type)
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-switch-primitive',
    root: 'root',
    graphs: Object.fromEntries(
      Object.entries(graphs).map(([id, graph]) => [
        id,
        {
          id,
          name: graph.name ?? id,
          nextOrdinal: 100,
          nodes: Object.fromEntries(
            Object.entries(graph.nodes).map(([nodeId, node]) => [
              nodeId,
              {
                id: nodeId,
                type: node.instanceOf ? `#${node.instanceOf}` : node.type.type,
                values: node.instanceOf
                  ? { ...node.values }
                  : { ...defaultValuesOf(node.type), ...node.values },
                ...(node.dynamic ? { dynamic: node.dynamic } : {}),
                ...(node.title ? { title: node.title } : {}),
              },
            ]),
          ),
          links: Object.fromEntries(
            (graph.links ?? []).map((link, i) => [
              `l${i}`,
              Array.isArray(link)
                ? {
                    id: `l${i}`,
                    from: { node: link[0], port: link[1] },
                    to: endpoint(link[2], link[3]),
                  }
                : {
                    id: `l${i}`,
                    ...(link as { from: Endpoint; to: Endpoint }),
                  },
            ]),
          ),
          nets: {},
          reroutes: {},
          ...(graph.boundary ? { boundary: graph.boundary } : {}),
          ...graph.extra,
        },
      ]),
    ),
    view: {
      graphs: Object.fromEntries(
        Object.entries(graphs).map(([id, graph]) => [
          id,
          {
            nodes: Object.fromEntries(
              Object.entries(graph.nodes).map(([nodeId, node]) => [
                nodeId,
                {
                  position: { x: node.x, y: node.y },
                  size: { width: node.width ?? NODE_WIDTH, height: 0 },
                },
              ]),
            ),
            ...(graph.panels
              ? {
                  boundary: {
                    inputs: { position: { x: graph.panels.inputs, y: 0 } },
                    outputs: { position: { x: graph.panels.outputs, y: 0 } },
                  },
                }
              : {}),
            ...graph.extraView,
          },
        ]),
      ),
    },
  } as unknown as Json)
  const doc = loaded.document
  if (!doc)
    throw new Error(
      `Invalid Switch and Primitive gallery document: ${JSON.stringify(loaded)}`,
    )
  const resolve = documentResolver(doc, (type) => schemas.get(type))
  const base = {
    document: doc,
    resolve,
    tokens,
    measure,
    widgetMeasure,
    seedControllerEnabled: true,
  }
  if (show.graph === 'root')
    return buildScene({
      ...base,
      graphId: 'root',
      occurrenceView: occurrenceDynamicView(doc, resolve, [], 'root'),
    })
  if (show.through)
    return buildScene({
      ...base,
      graphId: show.graph,
      occurrence: {
        owner: { instancePath: [], node: asNodeId(show.through) },
        plannerAvailable: false,
      },
      occurrenceView: occurrenceDynamicView(doc, resolve, [show.through]),
    })
  return buildScene({ ...base, graphId: show.graph })
}

/** Two scenes of one card together: what is outside, then what is inside. */
export const joined = (a: Scene, b: Scene): Scene => ({
  ...b,
  nodes: [...a.nodes, ...b.nodes],
  links: [...a.links, ...b.links],
  boundaryNodes: [...a.boundaryNodes, ...b.boundaryNodes],
})

const done: NodeProgress = { state: 'done' }
const failed: NodeProgress = { state: 'error' }

export function switchPrimitiveGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly SwitchPrimitiveCard[] {
  const scene = (
    graphs: Record<string, Graph>,
    show: { graph: string; through?: string } = { graph: 'root' },
  ) => sceneOf(tokens, measure, widgetMeasure, graphs, show)

  const quickDetailed = switchSchema('Switch', 'IMAGE', ['Quick', 'Detailed'])
  const quick = imageNode('Quick path')
  const detailed = imageNode('Detailed path')
  const save = schema('Save Image', 'Save Image', [
    pin('images', 'IMAGE', 'images'),
    field('filename_prefix', 'filename_prefix', 'STRING', 'Dinkster'),
  ])
  const amount = numberPrimitive('Primitive amount', 'Amount', 'FLOAT', 0.4, {
    min: 0,
    max: 1,
    step: 0.05,
  })
  const blend = schema('Blend', 'Blend', [
    pin('image', 'IMAGE', 'image'),
    field('amount', 'Amount', 'FLOAT', 0.5, { min: 0, max: 1, step: 0.05 }),
    out('IMAGE', 'IMAGE'),
  ])
  const intSource = (type: string) => schema(type, type, [out('INT', 'INT')])
  const floatSource = (type: string) =>
    schema(type, type, [out('FLOAT', 'FLOAT')])

  // Pictures feeding a Switch's branches, and what reads the Switch.
  const pickGraph = (
    sw: NodeSchema,
    pick: Json,
    names: readonly string[],
    wired: readonly number[] = [0, 1],
  ): Graph => ({
    nodes: {
      ...Object.fromEntries(
        wired.map((i) => [
          `in${i}`,
          {
            type: imageNode(`${names[i]} path`),
            x: 0,
            y: 60 + i * 80,
            width: 170,
          },
        ]),
      ),
      sw: {
        type: sw,
        x: COLUMN,
        y: 0,
        values: { pick },
        dynamic: branches(names),
      },
      save: { type: save, x: COLUMN * 2, y: 0 },
    },
    links: [
      ...wired.map((i) => [`in${i}`, 'IMAGE', 'sw', branchPort(i)] as const),
      ['sw', 'value', 'save', 'images'],
    ],
  })

  // The subgraph "Soften": a Switch whose Pick is the subgraph node's Mode,
  // and an Amount primitive shown on the subgraph node without an inside wire.
  const soften: Graph = {
    name: 'Soften',
    nodes: {
      quick: { type: quick, x: 210, y: 30, width: 140 },
      detailed: { type: detailed, x: 210, y: 110, width: 140 },
      mode: {
        type: quickDetailed,
        x: 380,
        y: 30,
        width: 190,
        dynamic: branches(['Quick', 'Detailed']),
      },
      amount: {
        type: amount,
        x: 380,
        y: 190,
        width: 190,
        values: { value: 0.4 },
      },
      blend: { type: blend, x: 600, y: 30, width: 160 },
    },
    links: [
      ['quick', 'IMAGE', 'mode', branchPort(0)],
      ['detailed', 'IMAGE', 'mode', branchPort(1)],
      ['mode', 'value', 'blend', 'image'],
      ['amount', 'FLOAT', 'blend', 'amount'],
    ],
    boundary: {
      inputs: [
        {
          id: 'mode',
          displayName: 'Mode',
          binds: { kind: 'port', node: 'mode', port: 'pick' },
          promoted: true,
          wireHidden: true,
        },
        {
          id: 'amount',
          displayName: 'Amount',
          binds: { kind: 'port', node: 'amount', port: 'value' },
          promoted: true,
          wireHidden: true,
        },
      ],
      outputs: [
        { id: 'image', binds: { kind: 'port', node: 'blend', port: 'IMAGE' } },
      ],
    },
    panels: { inputs: 0, outputs: 790 },
  }
  const softenNode = (
    title: string,
    x: number,
    y: number,
    values: Record<string, Json>,
  ): NodeEntry => ({
    type: quickDetailed,
    instanceOf: 'soften',
    x,
    y,
    title,
    values,
  })

  const cards: SwitchPrimitiveCard[] = []

  // 1. The hardest state: two subgraph nodes, two picks, two values.
  {
    const graphs = {
      root: {
        nodes: {
          a: softenNode('Soften A', 230, 330, { mode: 'Quick', amount: 0.25 }),
          b: softenNode('Soften B', 470, 330, {
            mode: 'Detailed',
            amount: 0.75,
          }),
        },
      },
      soften,
    }
    cards.push({
      caption:
        'Two subgraph nodes of Soften keep their own pick and value: A is Quick at 0.25 and B is Detailed at 0.75. Entered through B, the Inputs panel is "Inputs of Soften B" and edits only B. Inside, the Switch and the Primitive show what B sends, dimmed with the cyan subgraph icon, and the Quick path, which B does not pick, is dimmed.',
      scene: joined(
        scene(graphs),
        scene(graphs, { graph: 'soften', through: 'b' }),
      ),
      inactive: new Set(['quick']),
    })
  }

  // 2. What the Switch and the Primitive replace.
  cards.push({
    caption:
      'Today, for comparison: a value source pill and a separate selector box, each with its own look and its own hit area. The selector resolves once for the whole subgraph definition. Both go; the Switch and the Primitive below are ordinary nodes.',
    scene: scene({
      root: {
        nodes: {
          quick: { type: quick, x: 0, y: 20, width: 150 },
          detailed: { type: detailed, x: 0, y: 100, width: 150 },
          blend: { type: blend, x: 470, y: 20, width: 170 },
        },
        links: [
          {
            from: { node: 'quick', port: 'IMAGE' },
            to: { selector: 's', candidate: 'quick' },
          },
          {
            from: { node: 'detailed', port: 'IMAGE' },
            to: { selector: 's', candidate: 'detailed' },
          },
          { from: { selector: 's' }, to: { node: 'blend', port: 'image' } },
          {
            from: { valueSource: 'grain' },
            to: { node: 'blend', port: 'amount' },
          },
        ],
        extra: {
          valueSources: {
            grain: {
              id: 'grain',
              value: 0.4,
              title: 'Grain',
              spec: {
                widgetType: 'FLOAT',
                options: { min: 0, max: 1, step: 0.05 },
              },
            },
          },
          selectors: {
            s: {
              id: 's',
              title: 'Selector',
              candidates: [
                { id: 'quick', title: 'Quick' },
                { id: 'detailed', title: 'Detailed' },
              ],
              policy: { kind: 'fixed', candidate: 'quick' },
            },
          },
        },
        extraView: {
          selectors: { s: { position: { x: 220, y: 20 } } },
          valueSources: { grain: { position: { x: 250, y: 190 } } },
        },
      },
    }),
  })

  // 3. A pick known before the run.
  cards.push({
    caption:
      'The pick is known before the run. Pick is the Switch\'s own dropdown and stores the branch\'s id; "Quick" is its name. The Detailed path is dimmed: it is left out of the submitted graph, so a missing model used only there does not block the run.',
    scene: scene({
      root: pickGraph(quickDetailed, 'Quick', ['Quick', 'Detailed']),
    }),
    inactive: new Set(['in1']),
  })

  // 4. A pick that arrives during the run.
  {
    const graph = pickGraph(quickDetailed, 'Quick', ['Quick', 'Detailed'])
    cards.push({
      caption:
        'The pick arrives on a wire during the run: a whole number picks a position, counting from 0. Every branch stays in the submitted graph and only the picked one runs. For exactly two branches a yes or no is accepted (no is 0). A wired text picks by name, below.',
      scene: scene({
        root: {
          ...graph,
          nodes: {
            index: {
              type: intSource('Choose index'),
              x: 0,
              y: -40,
              width: 170,
            },
            ...graph.nodes,
          },
          links: [...graph.links!, ['index', 'INT', 'sw', 'pick']],
        },
      }),
    })
  }

  // 5. The picked branch has nothing plugged in.
  cards.push({
    caption:
      'The picked branch has nothing plugged in. The Switch passes nothing on, the same for a typed and a wired pick, and Save Image does not run; Detailed is shown as "Nothing plugged in". No warning is added before the run, and it is not a missing-branch error.',
    scene: scene({
      root: pickGraph(quickDetailed, 'Detailed', ['Quick', 'Detailed'], [0]),
    }),
    inactive: new Set(['in0', 'save']),
  })

  // 6. A stored branch was removed.
  cards.push({
    caption:
      "The branch the pick stored was removed. The first branch is used, and Pick shows it dimmed until a branch is chosen again; choosing Detailed clears it. Removing or renaming a branch never reinterprets another branch's id.",
    scene: scene({
      root: pickGraph(quickDetailed, 'Final', ['Quick', 'Detailed']),
    }),
    companions: { sw: { pick: { value: 'Quick', state: 'stale' } } },
    inactive: new Set(['in1']),
  })

  // 7. A wired position outside the branch list.
  {
    const graph = pickGraph(quickDetailed, 'Quick', ['Quick', 'Detailed'])
    cards.push({
      caption:
        'A wired position outside the branch list fails the run at the Switch with a problem on Pick: "Switch received position 3. There are 2 branches; use 0 or 1." There is no clamp and no fallback to the first branch.',
      scene: scene({
        root: {
          ...graph,
          nodes: {
            position: { type: intSource('Position'), x: 0, y: -40, width: 170 },
            ...graph.nodes,
          },
          links: [...graph.links!, ['position', 'INT', 'sw', 'pick']],
        },
      }),
      states: { sw: failed },
      rowMarks: { sw: new Set(['pick']) },
    })
  }

  // 8. A wired text picks a branch by its name.
  {
    const graph = pickGraph(quickDetailed, 'Quick', ['Quick', 'Detailed'])
    const customCombo = schema('Custom Combo', 'Custom Combo', [
      field('choice', 'Choice', 'COMBO', 'Detailed', {
        options: ['Quick', 'Detailed'],
      }),
      out('STRING', 'STRING'),
      out('INDEX', 'INT'),
    ])
    cards.push({
      caption:
        'A wired text picks the branch whose name is exactly that text; case matters and nothing is trimmed. A branch\'s id is accepted too, tried after the names. Here Custom Combo\'s text output sends "Detailed". It runs, so the pick is not known before the run and every branch stays in the submitted graph; a Text primitive holding "Detailed" is known before the run and drops the Quick path, as for a typed pick.',
      scene: scene({
        root: {
          ...graph,
          nodes: {
            combo: { type: customCombo, x: 0, y: -90, width: 170 },
            ...graph.nodes,
          },
          links: [...graph.links!, ['combo', 'STRING', 'sw', 'pick']],
        },
      }),
    })
  }

  // 9. A Choice primitive on Pick.
  {
    const graph = pickGraph(quickDetailed, 'Quick', ['Quick', 'Detailed'])
    const choice = plainPrimitive(
      'Primitive pick choice',
      'Pick',
      'COMBO',
      'COMBO',
      'Detailed',
      { options: ['Quick', 'Detailed'] },
      'Choice',
    )
    cards.push({
      caption:
        "A Choice primitive wired to Pick reads Pick's options: it shows the branch names and stores the branch's id, so it keeps picking the same branch when that branch is renamed. Its value is known before the run, so the Quick path is dropped. Text that arrives from elsewhere carrying an old name stops matching after a rename; the Choice primitive is the way that survives one.",
      scene: scene({
        root: {
          ...graph,
          nodes: {
            choice: { type: choice, x: 0, y: -90, width: 170 },
            ...graph.nodes,
          },
          links: [...graph.links!, ['choice', 'COMBO', 'sw', 'pick']],
        },
      }),
      inactive: new Set(['in0']),
    })
  }

  // 10. A wired text that names no branch.
  {
    const graph = pickGraph(quickDetailed, 'Quick', ['Quick', 'Detailed'])
    cards.push({
      caption:
        'A wired text that names no branch fails the run at the Switch with a problem on Pick: "Switch received "Fast". The branches are Quick and Detailed." There is no fallback to the first branch. A Text primitive holding "Fast" shows the same problem on Pick before the run.',
      scene: scene({
        root: {
          ...graph,
          nodes: {
            tag: {
              type: schema('Style tag', 'Style tag', [out('STRING', 'STRING')]),
              x: 0,
              y: -40,
              width: 170,
            },
            ...graph.nodes,
          },
          links: [...graph.links!, ['tag', 'STRING', 'sw', 'pick']],
        },
      }),
      states: { sw: failed },
      rowMarks: { sw: new Set(['pick']) },
    })
  }

  // 11. Rename and random.
  {
    const randomPick = switchSchema(
      'Switch random',
      'IMAGE',
      ['Quick', 'Final'],
      'randomize',
    )
    const { save: _save, ...nodes } = pickGraph(randomPick, 'Quick', [
      'Quick',
      'Final',
    ]).nodes
    const graph: Graph = {
      nodes,
      links: [0, 1].map(
        (i) => [`in${i}`, 'IMAGE', 'sw', branchPort(i)] as const,
      ),
    }
    const frozen = switchSchema('Switch frozen', 'IMAGE', ['Quick', 'Final'])
    cards.push({
      caption:
        "Renaming Detailed to Final keeps its id, so every pick of it now reads Final. Random is a mode of Pick, like a seed's: each run chooses among the current branches for each subgraph node and records the choice. The second Switch is the same node in a finished run, which shows the recorded Final read-only.",
      scene: scene({
        root: {
          ...graph,
          nodes: {
            ...graph.nodes,
            run: {
              type: frozen,
              x: COLUMN * 2,
              y: 0,
              title: 'Switch, run 31',
              values: { pick: 'Final' },
              dynamic: branches(['Quick', 'Final']),
            },
          },
        },
      }),
      states: { run: done },
    })
  }

  // The subgraph "Finish pass": one Mode on the subgraph node drives the
  // Picks of two Switches, which must have the same branches.
  const finishPass = (finishNames: readonly string[]): Graph => ({
    name: 'Finish pass',
    nodes: {
      resize: {
        type: switchSchema('Switch resize', 'IMAGE', ['Quick', 'Detailed']),
        x: 230,
        y: 30,
        title: 'Resize',
        dynamic: branches(['Quick', 'Detailed']),
      },
      finish: {
        type: switchSchema(
          `Switch finish ${finishNames.join(' ')}`,
          'IMAGE',
          finishNames,
        ),
        x: 470,
        y: 30,
        title: 'Finish',
        dynamic: branches(finishNames),
      },
    },
    boundary: {
      inputs: [
        {
          id: 'mode',
          displayName: 'Mode',
          binds: { kind: 'port', node: 'resize', port: 'pick' },
          alsoBinds: [{ kind: 'port', node: 'finish', port: 'pick' }],
          promoted: true,
          wireHidden: true,
        },
      ],
      outputs: [],
    },
    panels: { inputs: 0, outputs: 720 },
  })
  const finishRoot: Graph = {
    nodes: {
      pass: {
        type: quickDetailed,
        instanceOf: 'pass',
        x: 0,
        y: 220,
        title: 'Finish pass',
        values: { mode: 'Detailed' },
      },
    },
  }

  // 12. One promoted choice drives two Switches.
  {
    const graphs = {
      root: finishRoot,
      pass: finishPass(['Quick', 'Detailed']),
    }
    cards.push({
      caption:
        'One choice drives two Switches. The subgraph node\'s Mode is one boundary row bound to the Picks of Resize and Finish, which share branch ids and names; a row\'s "Show when" may read the same Mode. Outside, Mode is one ordinary dropdown; inside, both Picks show the arriving Detailed.',
      scene: joined(
        scene(graphs),
        scene(graphs, { graph: 'pass', through: 'pass' }),
      ),
    })
  }

  // 13. The shared Switches' branches no longer agree.
  {
    const graphs = { root: finishRoot, pass: finishPass(['Quick', 'Final']) }
    cards.push({
      caption:
        'A branch was renamed on Finish only, so the two Switches no longer agree and Mode has a problem with the fix "Copy branches from Mode". The fix gives Finish the same ids and names in one undo step, keeps wires whose names match, shows which wires it would remove first, and can be cancelled.',
      scene: joined(
        scene(graphs),
        scene(graphs, { graph: 'pass', through: 'pass' }),
      ),
      rowMarks: { finish: new Set(['pick']) },
    })
  }

  const stepsA = (min: number, max: number) =>
    stepsNode(`Steps A ${min} ${max}`, 'Steps A', min, max)
  const stepsB = (min: number, max: number) =>
    stepsNode(`Steps B ${min} ${max}`, 'Steps B', min, max)
  const stepsPrimitive = (open = false) =>
    numberPrimitive(`Primitive steps ${open}`, 'Steps', 'INT', 6, {}, open)
  const fanOut = (
    a: readonly [number, number],
    b: readonly [number, number],
    value: number,
    open = false,
  ): Graph => ({
    nodes: {
      p: { type: stepsPrimitive(open), x: 0, y: 0, values: { value } },
      a: { type: stepsA(...a), x: COLUMN + 20, y: 0 },
      b: { type: stepsB(...b), x: COLUMN + 20, y: 120 },
    },
    links: [
      ['p', 'INT', 'a', 'steps'],
      ['p', 'INT', 'b', 'steps'],
    ],
  })

  // 14. A Primitive feeding two fields that overlap.
  cards.push({
    caption:
      'A Primitive feeds two fields that allow 0 to 8 and 4 to 12, so it allows 4 to 8. The range is worked out from the fields it feeds on every change, and the empty limits in its open Limits section show the derived values in quiet text; nothing is copied onto the Primitive. Each field shows the arriving 6, dimmed.',
    scene: scene({ root: fanOut([0, 8], [4, 12], 6, true) }),
    companions: {
      p: {
        minimum: { value: 4, state: 'expected' },
        maximum: { value: 8, state: 'expected' },
        step: { value: 1, state: 'expected' },
      },
      a: { steps: { value: 6 } },
      b: { steps: { value: 6 } },
    },
  })

  // 15. The fields it feeds share no value.
  cards.push({
    caption:
      'The two fields share no value: Steps A allows 0 to 3 and Steps B 8 to 12. The value and both wires stay, and a problem names both fields. Nothing is reset or removed; whether those nodes can queue is decided by their own fields as today.',
    scene: scene({ root: fanOut([0, 3], [8, 12], 6) }),
    rowMarks: {
      p: new Set(['value']),
      a: new Set(['steps']),
      b: new Set(['steps']),
    },
    companions: { a: { steps: { value: 6 } }, b: { steps: { value: 6 } } },
  })

  // 16. Explicit and pinned limits.
  cards.push({
    caption:
      'Limits sit below the value in the ordinary node body. A limit the author types is used as given, here minimum 4, maximum 8, step 1 and default 6. "Pin the range" stores the current derived range the same way in one undo step, and "Use connected fields" empties them again. A subgraph node may narrow them, never widen them.',
    scene: scene({
      root: {
        nodes: {
          p: {
            type: stepsPrimitive(true),
            x: 0,
            y: 0,
            values: { value: 6, minimum: 4, maximum: 8, step: 1, default: 6 },
          },
          b: { type: stepsB(4, 12), x: COLUMN + 20, y: 0 },
        },
        links: [['p', 'INT', 'b', 'steps']],
      },
    }),
    companions: { b: { steps: { value: 6 } } },
  })

  // 17. The typed primitives beside the general one.
  cards.push({
    caption:
      'Int, Float, Text, Boolean and Choice are the Primitive with its type fixed: one node, six entries in the add-node search, which also finds them as "integer", "number", "decimal", "string", "bool", "toggle", "dropdown" and "combo". A typed primitive has its value field from the start and needs no wire to become something; the general Primitive takes its type, label and widget from the first field it is wired to. Text shown as a multiline box is the same Text node. Text and Boolean have only a Default limit, and Choice offers the options the fields it feeds share. Dragging off a field makes the typed primitive for that field\'s type when there is one.',
    scene: scene({
      root: {
        nodes: {
          int: {
            type: numberPrimitive(
              'Primitive int',
              'Value',
              'INT',
              20,
              { min: 0, max: 10000 },
              false,
              'Int',
            ),
            x: 0,
            y: 0,
          },
          float: {
            type: numberPrimitive(
              'Primitive float',
              'Value',
              'FLOAT',
              0.4,
              { min: 0, max: 1, step: 0.05 },
              false,
              'Float',
            ),
            x: COLUMN,
            y: 0,
          },
          toggle: {
            type: plainPrimitive(
              'Primitive toggle',
              'Value',
              'BOOLEAN',
              'BOOLEAN',
              true,
              {},
              'Boolean',
            ),
            x: COLUMN * 2,
            y: 0,
          },
          text: {
            type: plainPrimitive(
              'Primitive text',
              'Value',
              'STRING',
              'STRING',
              'a quiet lake',
              {},
              'Text',
            ),
            x: 0,
            y: 150,
          },
          multiline: {
            type: plainPrimitive(
              'Primitive multiline text',
              'Value',
              'STRING',
              'STRING',
              'a quiet lake at dawn,\nmist over the water',
              { multiline: true },
              'Text',
            ),
            x: COLUMN,
            y: 150,
          },
          choice: {
            type: plainPrimitive(
              'Primitive choice',
              'Sampler',
              'COMBO',
              'COMBO',
              'euler',
              { options: ['euler', 'dpmpp_2m'] },
              'Choice',
            ),
            x: COLUMN * 2,
            y: 150,
          },
          sampler: {
            type: samplerNode('Sampler', 'Sampler', ['euler', 'dpmpp_2m']),
            x: COLUMN * 3,
            y: 150,
          },
        },
        links: [['choice', 'COMBO', 'sampler', 'sampler']],
      },
    }),
    companions: { sampler: { sampler: { value: 'euler' } } },
  })

  // 18. The definition opened with no subgraph node.
  {
    const graphs = {
      root: { nodes: { fresh: softenNode('Soften', 230, 330, {}) } },
      soften,
    }
    cards.push({
      caption:
        "Soften opened with no subgraph node, as from the library. The Inputs panel shows the defaults, and editing Amount there edits the inner Primitive's value, which a new subgraph node such as the one below starts with. Subgraph nodes that already hold their own Amount keep it.",
      scene: joined(scene(graphs), scene(graphs, { graph: 'soften' })),
    })
  }

  // 19. Amount wired from outside, entered through that subgraph node.
  {
    const graphs = {
      root: {
        nodes: {
          runtime: {
            type: floatSource('Runtime number'),
            x: 0,
            y: 330,
            width: 170,
          },
          b: softenNode('Soften B', 230, 330, {
            mode: 'Detailed',
            amount: 0.75,
          }),
        },
        links: [['runtime', 'FLOAT', 'b', 'amount'] as const],
      },
      soften,
    }
    cards.push({
      caption:
        "Amount on Soften B is wired from a node that runs. Entered through B, the Inputs panel row and the inner Primitive are read-only, and B's stored 0.75 is struck through: the value is not known until the run brings it, and no stored default stands in for it. The same holds two levels deep, and a finished run shows the values it used, whatever was edited since.",
      scene: joined(
        scene(graphs),
        scene(graphs, { graph: 'soften', through: 'b' }),
      ),
    })
  }

  // 20. One number drives two Picks in a plain graph.
  {
    const index = numberPrimitive('Primitive index', 'Value', 'INT', 1, {
      min: 0,
      max: 1,
    })
    const switchAt = (title: string, y: number): NodeEntry => ({
      type: quickDetailed,
      x: COLUMN + 20,
      y,
      title,
      values: { pick: 'Detailed' },
      dynamic: branches(['Quick', 'Detailed']),
    })
    cards.push({
      caption:
        'In a plain graph one whole-number Primitive drives the Picks of two Switches through ordinary wires: 1 picks Detailed on both. Its known value is written into each Pick before the unpicked branches are dropped, and the Primitive itself does not run. A custom dropdown gives text and does not drive a Switch.',
      scene: scene({
        root: {
          nodes: {
            p: { type: index, x: 0, y: 0, values: { value: 1 } },
            a: switchAt('Switch A', 0),
            b: switchAt('Switch B', 140),
          },
          links: [
            ['p', 'INT', 'a', 'pick'],
            ['p', 'INT', 'b', 'pick'],
          ],
        },
      }),
      companions: {
        a: { pick: { value: 'Detailed', state: 'expected' } },
        b: { pick: { value: 'Detailed', state: 'expected' } },
      },
    })
  }

  // 21. A refused link and a refused name.
  {
    const refused = scene({
      root: {
        nodes: {
          p: {
            type: numberPrimitive('Primitive refused', 'Value', 'INT', 3, {}),
            x: 0,
            y: 0,
          },
          sw: {
            type: quickDetailed,
            x: COLUMN + 60,
            y: 0,
            values: { pick: 'Quick' },
            dynamic: branches(['Quick', 'Detailed']),
          },
        },
      },
    })
    const nodeOf = (id: string) => refused.nodes.find((node) => node.id === id)!
    const from = pinPosition(nodeOf('p'), 'INT', 'out')!
    const to = pinPosition(nodeOf('sw'), 'branch.branch1', 'in')!
    cards.push({
      caption:
        'Refused edits leave the last valid state. A whole number dragged to an IMAGE branch finds no pin to land on, because all branches share one type; only Pick takes it. Renaming Quick to "Detailed" is refused with "Detailed already exists" on the name, and the name stays Quick; Escape cancels the rename.',
      scene: refused,
      overlay: {
        ghostLink: {
          x1: from.x,
          y1: from.y,
          x2: to.x - 24,
          y2: to.y + 6,
          typeName: 'INT',
        },
        dropTargets: new Set([dropTargetKey('sw', 'pick', 'in')]),
      },
    })
  }

  // 22. Plugging in corrects the value in the same undo step.
  {
    const p = stepsPrimitive()
    const stage = (
      row: number,
      value: number,
      both: boolean,
    ): Record<string, NodeEntry> => ({
      [`p${row}`]: { type: p, x: 0, y: row * 250, values: { value } },
      [`a${row}`]: { type: stepsA(0, 8), x: COLUMN + 20, y: row * 250 },
      ...(both
        ? {
            [`b${row}`]: {
              type: stepsB(4, 12),
              x: COLUMN + 20,
              y: row * 250 + 120,
            },
          }
        : {}),
    })
    cards.push({
      caption:
        'Plugging in corrects the value in the same undo step. Top: the Primitive holds 2 and feeds a field allowing 0 to 8. Middle: plugging in Steps B (4 to 12) narrows the range to 4 to 8 and moves the value to 4 in that one edit. Bottom: Undo restores 2 and removes the new wire together. A conflict with no allowed value never moves the value.',
      scene: scene({
        root: {
          nodes: {
            ...stage(0, 2, false),
            ...stage(1, 4, true),
            ...stage(2, 2, false),
          },
          links: [
            ['p0', 'INT', 'a0', 'steps'],
            ['p1', 'INT', 'a1', 'steps'],
            ['p1', 'INT', 'b1', 'steps'],
            ['p2', 'INT', 'a2', 'steps'],
          ],
        },
      }),
      companions: {
        a0: { steps: { value: 2 } },
        a1: { steps: { value: 4 } },
        b1: { steps: { value: 4 } },
        a2: { steps: { value: 2 } },
      },
    })
  }

  // 23. Pinned range, disconnected and conflicting dropdowns.
  {
    const conflict = plainPrimitive(
      'Primitive conflict',
      'Sampler',
      'COMBO',
      'COMBO',
      'euler',
      {
        options: [],
      },
    )
    cards.push({
      caption:
        'A pinned range stays 4 to 8 when the fields it feeds change, and a field that cannot take it gets a problem on its wire. A dropdown Primitive with nothing to read options from is a text field that keeps its value. Two fed dropdowns with no option in common keep the value and every wire, with a problem.',
      scene: scene({
        root: {
          nodes: {
            pinned: {
              type: stepsPrimitive(true),
              x: 0,
              y: 0,
              values: { value: 6, minimum: 4, maximum: 8 },
            },
            b: { type: stepsB(5, 12), x: COLUMN + 20, y: 0 },
            disconnected: {
              type: plainPrimitive(
                'Primitive disconnected',
                'Sampler',
                'STRING',
                'COMBO',
                'euler',
              ),
              x: 0,
              y: 250,
            },
            conflict: { type: conflict, x: COLUMN + 20, y: 250 },
            s1: {
              type: samplerNode('Sampler A', 'Sampler A', ['euler', 'heun']),
              x: COLUMN * 2 + 40,
              y: 200,
            },
            s2: {
              type: samplerNode('Sampler B', 'Sampler B', ['dpmpp_2m', 'lcm']),
              x: COLUMN * 2 + 40,
              y: 300,
            },
          },
          links: [
            ['pinned', 'INT', 'b', 'steps'],
            ['conflict', 'COMBO', 's1', 'sampler'],
            ['conflict', 'COMBO', 's2', 'sampler'],
          ],
        },
      }),
      rowMarks: { b: new Set(['steps']), conflict: new Set(['value']) },
      companions: {
        b: { steps: { value: 6 } },
        s1: { sampler: { value: 'euler' } },
        s2: { sampler: { value: 'euler' } },
      },
    })
  }

  // 24. A wired Primitive passes its producer on.
  cards.push({
    caption:
      'A Primitive whose value arrives on a wire is read-only, with its stored 0.4 struck through, and passes the wire on: the submitted graph links Runtime number straight to Blend, and the Primitive itself does not run. Its stored value is not written into Blend; it is used again once the wire is removed.',
    scene: scene({
      root: {
        nodes: {
          runtime: {
            type: floatSource('Runtime number'),
            x: 0,
            y: 0,
            width: 170,
          },
          p: { type: amount, x: 200, y: 0, values: { value: 0.4 } },
          blend: { type: blend, x: 430, y: 0, width: 170 },
        },
        links: [
          ['runtime', 'FLOAT', 'p', 'value'],
          ['p', 'FLOAT', 'blend', 'amount'],
        ],
      },
    }),
  })

  return cards
}
