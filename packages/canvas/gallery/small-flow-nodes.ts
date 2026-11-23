import {
  type InputSpec,
  type Json,
  type NodeProgress,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  pinPosition,
  type DesignTokens,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'
import {
  joined,
  sceneOf,
  type Graph,
  type NodeEntry,
  type SwitchPrimitiveCard,
} from './switch-primitive.js'

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const T: TypeExpr = { kind: 'variable', templateId: 'T' }
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
const out = (
  id: string,
  type: TypeExpr | string,
  displayName = id,
): OutputSpec => ({
  kind: 'output',
  id,
  displayName,
  type: typeof type === 'string' ? concrete(type) : type,
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
 * Or else as `dinkster.utilities.or_else` declares it: a group of inputs of
 * one type variable that grows from Add input, starts with two and can be
 * reordered, then one output of that type. The first row is First and every
 * later row Next.
 */
const orElse = schema('dinkster.utilities.or_else', 'Or else', [
  {
    kind: 'group',
    id: 'values',
    value: { kind: 'input', id: 'value', type: T, optional: true },
    keys: { kind: 'numbered', prefix: '', start: 1, pad: 0 },
    grows: 'button',
    minMembers: 2,
    reorderable: true,
    addLabel: 'Add input',
    memberLabel: { formula: '"First" if index() == 0 else "Next"' },
    openName: false,
  },
  out('value', T, 'Value'),
])
const members = (...keys: string[]) => ({
  values: { members: keys, seq: Math.max(...keys.map(Number)) },
})
const hasValue = schema('dinkster.utilities.has_value', 'Has value', [
  { kind: 'input', id: 'value', displayName: 'Value', type: T, optional: true },
  out('has_value', 'BOOLEAN', 'Has value'),
])
const onlyIf = schema('dinkster.utilities.only_if', 'Only if', [
  { kind: 'input', id: 'value', displayName: 'Value', type: T, optional: true },
  field('condition', 'Condition', 'BOOLEAN', true, {
    labelOn: 'Yes',
    labelOff: 'No',
  }),
  out('value', T, 'Value'),
])

const loadImage = schema('Load Image', 'Load image', [
  field('image', 'image', 'COMBO', 'photo.png', {
    options: ['photo.png', 'backup.png'],
  }),
  out('IMAGE', 'IMAGE'),
])
const generate = schema('Generate image', 'Generate image', [
  field('steps', 'steps', 'INT', 30, { min: 1, max: 10000 }),
  field('seed', 'seed', 'INT', 123456789, { min: 0, max: 999999999 }),
  out('IMAGE', 'IMAGE'),
])
const inpaint = schema('Inpaint', 'Inpaint', [
  pin('image', 'IMAGE'),
  pin('mask', 'MASK'),
  field('steps', 'steps', 'INT', 20, { min: 1, max: 10000 }),
  out('IMAGE', 'IMAGE'),
])
const loadMask = schema('Optional mask', 'Optional mask', [out('MASK', 'MASK')])
const upscale = schema('Upscale', 'Upscale', [
  pin('image', 'IMAGE'),
  field('scale', 'scale', 'FLOAT', 4, { min: 1, max: 8, step: 0.5 }),
  out('IMAGE', 'IMAGE'),
])
const saveImage = schema('Save Image', 'Save Image', [
  pin('images', 'IMAGE'),
  field('filename_prefix', 'filename_prefix', 'STRING', 'out'),
])
const intValue = schema('Int', 'Int', [
  field('value', 'value', 'INT', 0, { min: -1000, max: 1000 }),
  out('INT', 'INT'),
])
const boolValue = schema('Boolean', 'Boolean', [
  field('value', 'value', 'BOOLEAN', false),
  out('BOOLEAN', 'BOOLEAN'),
])
const textValue = schema('Text', 'Text', [
  field('value', 'value', 'STRING', ''),
  out('STRING', 'STRING'),
])
const emptyList = schema('Empty list', 'Empty list', [
  out('list', { kind: 'list', element: concrete('INT') }, 'list'),
])
const optionalImage = schema('Optional image', 'Optional image', [
  out('IMAGE', 'IMAGE'),
])
const optionalAnswer = schema('Optional answer', 'Optional answer', [
  out('BOOLEAN', 'BOOLEAN'),
])

const done: NodeProgress = { state: 'done' }
const skipped: NodeProgress = { state: 'skipped' }
const failed: NodeProgress = { state: 'error' }

const COLUMN = 240

/**
 * Or else, Has value and Only if as ordinary nodes, one card per state of the
 * small flow nodes design. A value on a wire is not something the canvas
 * paints, so the captions name the values.
 */
export function smallFlowNodesGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly SwitchPrimitiveCard[] {
  const scene = (
    graphs: Record<string, Graph>,
    show: { graph: string; through?: string } = { graph: 'root' },
  ) => sceneOf(tokens, measure, widgetMeasure, graphs, show)
  const node = (
    type: NodeSchema,
    x: number,
    y: number,
    more: Partial<NodeEntry> = {},
  ): NodeEntry => ({ type, x, y, ...more })
  const image = (x: number, y: number, file: string, title?: string) =>
    node(loadImage, x, y, {
      values: { image: file },
      width: 180,
      ...(title ? { title } : {}),
    })

  const cards: SwitchPrimitiveCard[] = []

  // 1. Or else gives the first input that has a value.
  cards.push({
    caption:
      'Or else gives the first input, top to bottom, that has a value. Above, First has photo.png, so photo.png comes out unchanged. Below, First is nothing because Optional image gave nothing, so the next input down, backup.png, comes out. All inputs and the output share one type, here IMAGE, set by the first wire.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          b: image(0, 100, 'backup.png'),
          or: node(orElse, COLUMN, 30, { dynamic: members('1', '2') }),
          c: node(optionalImage, 0, 230, { width: 180 }),
          d: image(0, 300, 'backup.png'),
          or2: node(orElse, COLUMN, 250, { dynamic: members('1', '2') }),
        },
        links: [
          ['a', 'IMAGE', 'or', 'values.1'],
          ['b', 'IMAGE', 'or', 'values.2'],
          ['c', 'IMAGE', 'or2', 'values.1'],
          ['d', 'IMAGE', 'or2', 'values.2'],
        ],
      },
    }),
    states: { a: done, or: done, c: done, d: done, or2: done },
  })

  // 2. Has value answers yes or no.
  cards.push({
    caption:
      'Has value says Yes when its input has a value (above, photo.png) and No when it is nothing (below). It is not skipped for receiving nothing: answering is its job. The input takes any one type; the answer is always a BOOLEAN.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          has: node(hasValue, COLUMN, 10, { width: 170 }),
          c: node(optionalImage, 0, 130, { width: 180 }),
          has2: node(hasValue, COLUMN, 130, { width: 170 }),
        },
        links: [
          ['a', 'IMAGE', 'has', 'value'],
          ['c', 'IMAGE', 'has2', 'value'],
        ],
      },
    }),
    states: { a: done, has: done, c: done, has2: done },
  })

  // 3. Only if passes its input on, or gives nothing.
  cards.push({
    caption:
      'Only if passes Value on unchanged when Condition is Yes (above). When Condition is No (below) it gives nothing, with the reason "Condition is false", and never asks for Value, so the Load image below did not run.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          yes: node(onlyIf, COLUMN, 0, { values: { condition: true } }),
          b: image(0, 130, 'photo.png'),
          no: node(onlyIf, COLUMN, 130, { values: { condition: false } }),
        },
        links: [
          ['a', 'IMAGE', 'yes', 'value'],
          ['b', 'IMAGE', 'no', 'value'],
        ],
      },
    }),
    states: { a: done, yes: done, no: done },
  })

  // 5. Only nothing counts as nothing.
  {
    const sources: [string, NodeSchema, string, Record<string, Json>][] = [
      ['zero', intValue, 'INT', { value: 0 }],
      ['no', boolValue, 'BOOLEAN', { value: false }],
      ['text', textValue, 'STRING', { value: '' }],
      ['list', emptyList, 'list', {}],
      ['nothing', optionalImage, 'IMAGE', {}],
    ]
    const nodes: Record<string, NodeEntry> = {}
    const links: [string, string, string, string][] = []
    const states: Record<string, NodeProgress> = {}
    sources.forEach(([id, type, port, values], i) => {
      nodes[id] = node(type, 0, i * 90, { values, width: 180 })
      nodes[`has_${id}`] = node(hasValue, COLUMN, i * 90, { width: 170 })
      links.push([id, port, `has_${id}`, 'value'])
      states[id] = done
      states[`has_${id}`] = done
    })
    nodes['has_unwired'] = node(hasValue, COLUMN, sources.length * 90, {
      width: 170,
    })
    states['has_unwired'] = done
    cards.push({
      caption:
        'Only nothing counts as nothing. The number 0, the value No, empty text and an empty list are values, so the first four Has value nodes say Yes. Nothing (fifth) says No, and so does an input with no wire (last), which is not a missing-input error on these nodes. Or else and Only if use the same test: an Or else whose First is 0 gives 0.',
      scene: scene({ root: { nodes, links } }),
      states,
    })
  }

  // 6. Before a run, what only the run can answer is not known yet.
  cards.push({
    caption:
      'Before a run, an answer only the run can give is not known yet. Has value does not say No because nothing has run; Or else does not jump ahead to backup.png although it is known, since First may still have a value; Only if waits for its wired Condition. None of the three declares a known value, so nothing is handed a made-up answer. The canvas does not write "Not known yet" yet: the wired Condition still shows its stored Yes struck through.',
    scene: scene({
      root: {
        nodes: {
          gen: node(generate, 0, 0, { width: 180 }),
          has: node(hasValue, COLUMN, 0, { width: 170 }),
          a: image(COLUMN, 90, 'photo.png'),
          only: node(onlyIf, COLUMN * 2 + 10, 30),
          gen2: node(generate, 0, 220, { width: 180 }),
          b: image(0, 370, 'backup.png'),
          or: node(orElse, COLUMN, 260, { dynamic: members('1', '2') }),
        },
        links: [
          ['gen', 'IMAGE', 'has', 'value'],
          ['gen2', 'IMAGE', 'or', 'values.1'],
          ['b', 'IMAGE', 'or', 'values.2'],
          ['a', 'IMAGE', 'only', 'value'],
          ['has', 'has_value', 'only', 'condition'],
        ],
      },
    }),
  })

  // 7. Or else stops at the first input that has a value.
  cards.push({
    caption:
      'Or else stops at the first input that has a value. First has photo.png, so it comes out and Or else stops there. Generate image feeds only Next; nothing asks for it, so it does not run. If something else in the graph needs Generate image, it still runs for that, and the check before a run still covers it.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          gen: node(generate, 0, 100, { width: 180 }),
          or: node(orElse, COLUMN, 30, { dynamic: members('1', '2') }),
        },
        links: [
          ['a', 'IMAGE', 'or', 'values.1'],
          ['gen', 'IMAGE', 'or', 'values.2'],
        ],
      },
    }),
    states: { a: done, or: done },
  })

  // 8. A skipped stage does not stop the save.
  cards.push({
    caption:
      'Optional mask gave nothing. Inpaint needs a mask, so it is skipped and its image is nothing. First is nothing, so Or else gives Next, the original photo.png, and Save Image saves it. Plug a mask in and the inpainted image wins instead.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          mask: node(loadMask, 0, -110, { width: 180 }),
          inpaint: node(inpaint, COLUMN, -100),
          or: node(orElse, COLUMN * 2, 30, { dynamic: members('1', '2') }),
          save: node(saveImage, COLUMN * 3, 30),
        },
        links: [
          ['a', 'IMAGE', 'inpaint', 'image'],
          ['mask', 'MASK', 'inpaint', 'mask'],
          ['inpaint', 'IMAGE', 'or', 'values.1'],
          ['a', 'IMAGE', 'or', 'values.2'],
          ['or', 'value', 'save', 'images'],
        ],
      },
    }),
    states: {
      a: done,
      mask: done,
      inpaint: skipped,
      or: done,
      save: done,
    },
  })

  // 9. Add input adds one more input at the bottom.
  cards.push({
    caption:
      'Add input adds one input at the bottom; the node starts with two and never has fewer. The new third input has no wire, which counts as nothing, not a missing-input error. First is nothing here, so backup.png comes out.',
    scene: scene({
      root: {
        nodes: {
          c: node(optionalImage, 0, 0, { width: 180 }),
          b: image(0, 80, 'backup.png'),
          or: node(orElse, COLUMN, 20, { dynamic: members('1', '2', '3') }),
        },
        links: [
          ['c', 'IMAGE', 'or', 'values.1'],
          ['b', 'IMAGE', 'or', 'values.2'],
        ],
      },
    }),
    states: { c: done, b: done, or: done },
  })

  // 10. The order of the rows decides the winner.
  cards.push({
    caption:
      'The top input that has a value wins, so the order of the rows is part of what Or else does. Above, photo.png is First and comes out; below, the same two wires with backup.png moved to the top give backup.png. Moving a row by hand is not built in the editor yet; these two are stored in each order.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          b: image(0, 100, 'backup.png'),
          or: node(orElse, COLUMN, 30, { dynamic: members('1', '2') }),
          a2: image(0, 230, 'photo.png'),
          b2: image(0, 330, 'backup.png'),
          or2: node(orElse, COLUMN, 260, {
            dynamic: { values: { members: ['2', '1'], seq: 2 } },
          }),
        },
        links: [
          ['a', 'IMAGE', 'or', 'values.1'],
          ['b', 'IMAGE', 'or', 'values.2'],
          ['a2', 'IMAGE', 'or2', 'values.1'],
          ['b2', 'IMAGE', 'or2', 'values.2'],
        ],
      },
    }),
    states: { a: done, or: done, b2: done, or2: done },
  })

  // 11. No input has a value.
  cards.push({
    caption:
      'When no input has a value Or else gives nothing, with the reason "No input has a value". It ran (finished, not skipped), so its result is cached like any other; a skip is never cached. Save Image needs an image and gets nothing, so it is skipped. Here Optional mask gave nothing, so Inpaint was skipped and First is nothing, and Next has no wire.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          mask: node(loadMask, 0, -110, { width: 180 }),
          inpaint: node(inpaint, COLUMN, -100),
          or: node(orElse, COLUMN * 2, 30, { dynamic: members('1', '2') }),
          save: node(saveImage, COLUMN * 3, 30),
        },
        links: [
          ['a', 'IMAGE', 'inpaint', 'image'],
          ['mask', 'MASK', 'inpaint', 'mask'],
          ['inpaint', 'IMAGE', 'or', 'values.1'],
          ['or', 'value', 'save', 'images'],
        ],
      },
    }),
    states: {
      a: done,
      mask: done,
      inpaint: skipped,
      or: done,
      save: skipped,
    },
  })

  // 12. A node that fails still fails the run.
  cards.push({
    caption:
      'A node that fails still fails the run. Load image was asked for its image and failed; Or else does not read the failure as nothing and does not try backup.png. Has value, likewise, never turns a failure into No.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          b: image(0, 100, 'backup.png'),
          or: node(orElse, COLUMN, 30, { dynamic: members('1', '2') }),
        },
        links: [
          ['a', 'IMAGE', 'or', 'values.1'],
          ['b', 'IMAGE', 'or', 'values.2'],
        ],
      },
    }),
    states: { a: failed },
  })

  // 13. A wire of another type is refused.
  {
    const refused = scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          v: node(intValue, 0, 100, { values: { value: 512 }, width: 180 }),
          or: node(orElse, COLUMN + 40, 20, { dynamic: members('1', '2') }),
        },
        links: [['a', 'IMAGE', 'or', 'values.1']],
      },
    })
    const nodeOf = (id: string) => refused.nodes.find((n) => n.id === id)!
    const from = pinPosition(nodeOf('v'), 'INT', 'out')!
    const to = pinPosition(nodeOf('or'), 'values.2', 'in')!
    cards.push({
      caption:
        'First made this an IMAGE node, so an INT dragged to Next finds no pin to land on: nothing is converted and the node keeps its wiring. The engine refuses the same mix before a run. Only if takes only a BOOLEAN on Condition.',
      scene: refused,
      overlay: {
        ghostLink: {
          x1: from.x,
          y1: from.y,
          x2: to.x - 24,
          y2: to.y + 6,
          typeName: 'INT',
        },
        dropTargets: new Set(),
      },
    })
  }

  // 14. Only if switched off; the stage behind it does not run.
  cards.push({
    caption:
      'Only if with Condition No ran and gives nothing, with the reason "Condition is false". Upscale feeds only this Only if, which never asks for it, so Upscale does not run: nothing went wrong, it was not needed.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          up: node(upscale, COLUMN, 0),
          only: node(onlyIf, COLUMN * 2, 0, { values: { condition: false } }),
        },
        links: [
          ['a', 'IMAGE', 'up', 'image'],
          ['up', 'IMAGE', 'only', 'value'],
        ],
      },
    }),
    states: { only: done },
  })

  // 15. Or else after Only if passes the original around a switched-off stage.
  {
    const row = (suffix: string, y: number, condition: boolean) => ({
      [`a${suffix}`]: image(0, y + 40, 'photo.png'),
      [`up${suffix}`]: node(upscale, COLUMN, y),
      [`only${suffix}`]: node(onlyIf, COLUMN * 2, y, {
        values: { condition },
      }),
      [`or${suffix}`]: node(orElse, COLUMN * 3, y + 40, {
        dynamic: members('1', '2'),
      }),
    })
    const links = (suffix: string) =>
      [
        [`a${suffix}`, 'IMAGE', `up${suffix}`, 'image'],
        [`up${suffix}`, 'IMAGE', `only${suffix}`, 'value'],
        [`only${suffix}`, 'value', `or${suffix}`, 'values.1'],
        [`a${suffix}`, 'IMAGE', `or${suffix}`, 'values.2'],
      ] as const
    cards.push({
      caption:
        'Or else after Only if passes the original around a switched-off stage. Above, Condition is No: Only if gives nothing, Upscale does not run, and Or else falls through to the original photo.png. Below, Condition is Yes: the upscaled image arrives first and wins. Only if has no hidden bypass of its own; the original gets through only because Or else is wired to do it.',
      scene: scene({
        root: {
          nodes: { ...row('', 0, false), ...row('2', 200, true) },
          links: [...links(''), ...links('2')],
        },
      }),
      states: {
        a: done,
        only: done,
        or: done,
        a2: done,
        up2: done,
        only2: done,
        or2: done,
      },
    })
  }

  // 16. Switched on with nothing plugged into Value.
  cards.push({
    caption:
      'Value has no wire and may be left empty, so there is no missing-input error. Condition is Yes, which passes on whatever arrives, and what arrives is nothing.',
    scene: scene({
      root: {
        nodes: {
          only: node(onlyIf, 0, 0, { values: { condition: true } }),
        },
      },
    }),
    states: { only: done },
  })

  // 17. Condition itself is nothing.
  cards.push({
    caption:
      'Condition is needed and is nothing, so Only if is skipped like any node that misses a needed input, and its output is nothing. An empty Condition is never turned into a made-up No.',
    scene: scene({
      root: {
        nodes: {
          a: image(0, 0, 'photo.png'),
          has: node(optionalAnswer, 0, 120, { width: 180 }),
          only: node(onlyIf, COLUMN + 30, 40),
        },
        links: [
          ['a', 'IMAGE', 'only', 'value'],
          ['has', 'BOOLEAN', 'only', 'condition'],
        ],
      },
    }),
    states: { has: done, only: skipped },
  })

  // 18. Condition shown on a subgraph node, and an old run.
  {
    const detail: Graph = {
      name: 'Detail pass',
      nodes: {
        up: node(upscale, 210, 30, { width: 170 }),
        only: node(onlyIf, 410, 30, { width: 190 }),
      },
      links: [['up', 'IMAGE', 'only', 'value']],
      boundary: {
        inputs: [
          {
            id: 'image',
            displayName: 'image',
            binds: { kind: 'port', node: 'up', port: 'image' },
          },
          {
            id: 'condition',
            displayName: 'Condition',
            binds: { kind: 'port', node: 'only', port: 'condition' },
            promoted: true,
            wireHidden: true,
          },
        ],
        outputs: [
          {
            id: 'result',
            displayName: 'image',
            binds: { kind: 'port', node: 'only', port: 'value' },
          },
        ],
      },
      panels: { inputs: 0, outputs: 640 },
    }
    const instance = (
      title: string,
      x: number,
      condition: boolean,
    ): NodeEntry => ({
      type: onlyIf,
      instanceOf: 'detail',
      x,
      y: 330,
      title,
      values: { condition },
    })
    const graphs = {
      root: {
        nodes: {
          a: instance('Detail pass A', 0, true),
          b: instance('Detail pass B', 240, false),
          run: node(onlyIf, 480, 330, {
            title: 'Only if, run 31',
            values: { condition: false },
          }),
        },
      },
      detail,
    }
    cards.push({
      caption:
        "Condition is shown on the subgraph node like any field: Detail pass A is Yes and B is No, each its own value. Entered through A, Condition is edited on the Inputs panel, and the Only if inside is an ordinary node showing what A sends. The node on the right is the same Only if in a finished run, which shows that run's No read-only.",
      scene: joined(
        scene(graphs),
        scene(graphs, { graph: 'detail', through: 'a' }),
      ),
      states: { run: done },
    })
  }

  return cards
}
