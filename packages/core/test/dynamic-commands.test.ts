/**
 * Dynamic-state commands and materialization frames.
 *
 * The contract under test: elaboration offers a group's unstored members up
 * to its minimum and one spare as view affordances; `dynamic.materialize`
 * persists them append-only and idempotently; `dynamic.selectOption`
 * writes a choice at its flattened id; `batch` makes
 * "materialize + the action that caused it" one atomic transaction and one
 * undo step; `materializeFramesOf` derives the frames param from an
 * elaborated target, including offered siblings and nested groups.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId } from '../src/ids.js'
import {
  elabInputsOf,
  elaborateInterface,
  materializeFramesOf,
  type ElaboratedInput,
} from '../src/schema/elaborate.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import type { BodyRow, GroupSpec, InputSpec, NodeSchema } from '../src/schema/model.js'
import { boundaryItems, boundaryOf } from '../src/format/document.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id: asNodeId(id),
  type: 'Batch',
  values: {},
  ...extra,
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

const port = (n: string, p: string) => ({ node: asNodeId(n), port: asPortId(p) })

const schemaOf = (items: BodyRow[]): NodeSchema => ({
  type: 'Batch',
  displayName: 'Batch',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: items,
})

const socketInput = (id: string, type = 'IMAGE', extra: Partial<InputSpec> = {}): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: type },
  optional: false,
  ...extra,
})

const group = (
  id: string,
  opts: { min?: number; max?: number; member?: BodyRow[]; prefix?: string } = {},
): GroupSpec => ({
  kind: 'group',
  id,
  ...(opts.member !== undefined ? { member: opts.member } : { value: socketInput('item', 'IMAGE') }),
  keys: { kind: 'numbered', prefix: opts.prefix ?? 'image', start: 0, pad: 0 },
  grows: 'link',
  minMembers: opts.min ?? 0,
  maxMembers: opts.max ?? 4,
})

const dynOf = (store: DocumentStore, nodeId: string, graphId = 'g0') =>
  store.doc.graphs[graphId]!.nodes[nodeId]!.dynamic

describe('dynamic.setOptions', () => {
  it('preserves ordered scalar choices independently of selection and index through undo and redo', () => {
    const initial = doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', {
      values: { choice: 'outside', index: { $typed: { type: 'INT', value: 7 } } },
      additionalInputs: ['index', 'sparse.172'],
      dynamic: { choice: { options: ['before'] }, unrelated: { selected: 'keep' } },
    }) } }) })
    const store = makeStore(initial)
    const choices = ['duplicate', 'duplicate', '', 0, false, ...Array.from({ length: 152 }, (_, i) => `entry${i * 3}`)]
    expect(store.dispatch({ command: 'dynamic.setOptions', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'choice', options: choices,
    } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ choice: { options: choices }, unrelated: { selected: 'keep' } })
    expect(store.doc.graphs.g0!.nodes.n1!.values).toEqual(initial.graphs.g0!.nodes.n1!.values)
    expect(store.doc.graphs.g0!.nodes.n1!.additionalInputs).toEqual(['index', 'sparse.172'])
    for (const editableOptions of [true, false]) {
      const schema = schemaOf([socketInput('choice', 'COMBO', {
        widget: { widgetType: 'COMBO', ...(editableOptions ? { editableOptions: true } : {}), options: { options: ['schema'] } },
      })])
      const effective = elabInputsOf(elaborateInterface(schema, store.doc.graphs.g0!.nodes.n1!))
      expect(effective[0]!.spec.widget!.options.options).toEqual(editableOptions ? choices : ['schema'])
    }
    store.undo()
    expect(store.doc).toEqual(initial)
    store.redo()
    expect(dynOf(store, 'n1')!.choice!.options).toEqual(choices)
    expect(store.dispatch({ command: 'dynamic.setOptions', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'choice', options: [],
    } }).ok).toBe(true)
    expect(dynOf(store, 'n1')!.choice!.options).toEqual([])
    expect(store.doc.graphs.g0!.nodes.n1!.values.choice).toBe('outside')
  })

  it('batches nested menu materialization as one undo step', () => {
    const initial = doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) })
    const store = makeStore(initial)
    const edit = { command: 'dynamic.setOptions', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'items.m0.choice', options: ['a', 'a'],
    } }
    expect(store.dispatch({ command: 'batch', params: { invocations: [
      { command: 'dynamic.materialize', params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'items', members: ['m0'], seq: 1 }] } },
      edit,
    ] } }).ok).toBe(true)
    expect(dynOf(store, 'n1')!['items.m0.choice']!.options).toEqual(['a', 'a'])
    expect(dynOf(store, 'n1')!.items!.members).toEqual(['m0'])
    store.undo()
    expect(dynOf(store, 'n1')!.items!.members).toBeUndefined()
    expect(dynOf(store, 'n1')!['items.m0.choice']).toBeUndefined()
    for (const options of [[null], [{}], [['a']]]) {
      expect(store.dispatch({ command: 'dynamic.setOptions', params: { graphId: 'g0', nodeId: 'n1', construct: 'choice', options } }).ok).toBe(false)
    }
    expect(dynOf(store, 'n1')!.choice).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dynamic.materialize
// ---------------------------------------------------------------------------

describe('dynamic.materialize', () => {

  it('names an added member by its position, as it was offered, and renumbers after a removal', () => {
    const schema = schemaOf([group('images')])
    // Keys that differ from positions: image1 and image4 stand first and second.
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: {
      n1: node('n1', { dynamic: { images: { members: ['image1', 'image4'], seq: 5 } } }),
    } }) }))
    // Every stored member is wired, so the group offers a spare.
    const labels = (state = store.doc.graphs.g0!.nodes.n1!) => {
      const stored = new Set((state.dynamic?.['images']?.members ?? []).map((key) => `images.${key}`))
      const wired = { isInputConnected: (port: string) => stored.has(port), isOutputConnected: () => false }
      return elabInputsOf(elaborateInterface(schema, state, wired)).map((input) =>
        [input.address.port, input.spec.displayName, input.origin.kind === 'member' && input.origin.ghost === true])
    }
    expect(labels()).toEqual([
      ['images.image1', 'image 1', false],
      ['images.image4', 'image 2', false],
      ['images.image5', 'image 3', true],
    ])
    const offered = elabInputsOf(elaborateInterface(schema, store.doc.graphs.g0!.nodes.n1!, {
      isInputConnected: () => true, isOutputConnected: () => false,
    })).find((input) => input.address.port === 'images.image5')!
    expect(store.dispatch({ command: 'dynamic.materialize', params: {
      graphId: 'g0', nodeId: 'n1', frames: offered.materialize as never,
    } }).ok).toBe(true)
    // The added member keeps the name it was offered under; the next offer reads 4.
    expect(labels()).toEqual([
      ['images.image1', 'image 1', false],
      ['images.image4', 'image 2', false],
      ['images.image5', 'image 3', false],
      ['images.image6', 'image 4', true],
    ])
    // Removing the first member renumbers the rest; their keys stay.
    const current = store.doc.graphs.g0!.nodes.n1!
    expect(labels({ ...current, dynamic: { images: { members: ['image4', 'image5'], seq: 6 } } })).toEqual([
      ['images.image4', 'image 1', false],
      ['images.image5', 'image 2', false],
      ['images.image6', 'image 3', true],
    ])
  })

  it('appends after existing members, never reorders, and advances seq to the frame counter', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: ['m5'], seq: 6 } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m6', 'm7'], seq: 8 }] },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m5', 'm6', 'm7'], seq: 8 } })
  })

  it('is idempotent: re-materializing persisted members records no transaction', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: ['m0'], seq: 1 } } }) },
        }),
      }),
    )
    const before = store.revision
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members: ['m0'] }] },
    })
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('preserves sibling group state and existing nested group state', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: {
            n1: node('n1', {
              dynamic: {
                other: { selected: 'b' },
                items: { members: ['m0'], seq: 1 },
                'items.m0.sub': { members: ['m2'], seq: 3 },
              },
            }),
          },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        frames: [
          { construct: 'items', members: ['m0'], seq: 1 },
          { construct: 'items.m0.sub', members: ['m3'], seq: 4 },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      other: { selected: 'b' },
      items: { members: ['m0'], seq: 1 },
      'items.m0.sub': { members: ['m2', 'm3'], seq: 4 },
    })
  })

})

// ---------------------------------------------------------------------------
// dynamic.selectOption
// ---------------------------------------------------------------------------

describe('CO3 dynamic member ids never rewind across undo', () => {
  const materialize = (store: DocumentStore, members: string[]) =>
    store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'n1', frames: [{ construct: 'images', members, seq: members.length }] },
    })

  it('redo after a clamped undo reapplies the members without erroring', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    expect(materialize(store, ['m0']).ok).toBe(true)
    store.undo()
    expect(store.redo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m0'], seq: 1 } })
  })

  it('cursor-only skeletons left by undo are hash-neutral (seq is bookkeeping, not semantics)', () => {
    // Like nextOrdinal and surfaceSeq, the dynamic seq cursor only affects
    // FUTURE member ids - never what executes now. Materialize-then-undo
    // must restore the semantic hash even though the skeleton stays behind.
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const before = semanticHashOf(store.doc)
    expect(materialize(store, ['m0']).ok).toBe(true)
    expect(semanticHashOf(store.doc)).not.toBe(before) // members ARE semantic
    store.undo()
    expect(dynOf(store, 'n1')).toEqual({ images: { seq: 1 } }) // skeleton remains...
    expect(semanticHashOf(store.doc)).toBe(before) // ...but hashes as if absent
  })

})

describe('dynamic.selectOption', () => {
  it('sets selected at top level, preserving other construct state', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { images: { members: ['m0'], seq: 1 } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: { graphId: 'g0', nodeId: 'n1', construct: 'mode', option: 'advanced' },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      images: { members: ['m0'], seq: 1 },
      mode: { selected: 'advanced' },
    })
  })

  it('is idempotent: re-selecting the current option records no transaction', () => {
    const store = makeStore(
      doc({
        g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { mode: { selected: 'a' } } }) } }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: { graphId: 'g0', nodeId: 'n1', construct: 'mode', option: 'a' },
    })
    expect(out.ok).toBe(true)
    expect(store.canUndo).toBe(false)
  })

  it('switches a combo nested under a member at its flattened id', () => {
    const store = makeStore(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { n1: node('n1', { dynamic: { items: { members: ['m0'], seq: 1 } } }) },
        }),
      }),
    )
    const out = store.dispatch({
      command: 'dynamic.selectOption',
      params: {
        graphId: 'g0',
        nodeId: 'n1',
        construct: 'items.m0.mode',
        option: 'blur',
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      items: { members: ['m0'], seq: 1 },
      'items.m0.mode': { selected: 'blur' },
    })
  })

})

describe('dynamic.specializeSlot', () => {
  it('sets selected specialization', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    expect(store.dispatch({ command: 'dynamic.specializeSlot', params: { graphId: 'g0', nodeId: 'n1', construct: 'model', variant: 'lora' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ model: { selected: 'lora' } })
  })

  it('clears selected specialization with null', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { model: { selected: 'lora' } } }) } }) }))
    expect(store.dispatch({ command: 'dynamic.specializeSlot', params: { graphId: 'g0', nodeId: 'n1', construct: 'model', variant: null } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ model: {} })
  })

  it('is idempotent when re-setting the current specialization', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { model: { selected: 'lora' } } }) } }) }))
    const before = store.revision
    expect(store.dispatch({ command: 'dynamic.specializeSlot', params: { graphId: 'g0', nodeId: 'n1', construct: 'model', variant: 'lora' } }).ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('writes the specialization of a type choice under a member at its flattened id', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: { items: { members: ['m0'], seq: 1 } } }) } }) }))
    const out = store.dispatch({ command: 'dynamic.specializeSlot', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'items.m0.model', variant: 'lora',
    } })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ items: { members: ['m0'], seq: 1 }, 'items.m0.model': { selected: 'lora' } })
  })
})

describe('dynamic.labelMember', () => {
  it('authors presentation labels without changing execution identity and supports undo', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: { values: { members: ['m7', 'm2'], seq: 8 } } }),
      } }),
    }))
    const before = semanticHashOf(store.doc)
    const result = store.dispatch({ command: 'dynamic.labelMember', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'values', member: 'm7', label: 'Background',
    } })
    expect(result.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      values: { members: ['m7', 'm2'], seq: 8, memberLabels: { m7: 'Background' } },
    })
    expect(semanticHashOf(store.doc)).toBe(before)
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['m7', 'm2'], seq: 8 } })
  })

  it('rejects duplicate effective labels without recording a transaction', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: {
          values: { members: ['m7', 'm2'], memberLabels: { m7: 'Background', m2: 'Subject' } },
        } }),
      } }),
    }))
    const revision = store.revision
    const result = store.dispatch({ command: 'dynamic.labelMember', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'values', member: 'm2', label: 'Background',
    } })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('dynamic.duplicateMemberLabel')
    expect(store.revision).toBe(revision)
  })

  it('updates multiple labels atomically so labels can be swapped', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: {
          values: { members: ['m0', 'm1'], memberLabels: { m0: 'Left', m1: 'Right' } },
        } }),
      } }),
    }))
    expect(store.dispatch({ command: 'dynamic.labelMembers', params: {
      graphId: 'g0', nodeId: 'n1', construct: 'values', labels: { m0: 'Right', m1: 'Left' },
    } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toMatchObject({
      values: { memberLabels: { m0: 'Right', m1: 'Left' } },
    })
  })

  it('writes labels of a group nested under a member at its flattened id', () => {
    const store = makeStore(doc({
      g0: graph({ id: 'g0', nodes: {
        n1: node('n1', { dynamic: {
          groups: { members: ['outer'] },
          'groups.outer.values': { members: ['m0'] },
        } }),
      } }),
    }))
    expect(store.dispatch({ command: 'dynamic.labelMember', params: {
      graphId: 'g0', nodeId: 'n1',
      construct: 'groups.outer.values', member: 'm0', label: 'Primary',
    } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      groups: { members: ['outer'] },
      'groups.outer.values': { members: ['m0'], memberLabels: { m0: 'Primary' } },
    })
  })
})

// ---------------------------------------------------------------------------
// dynamic.compact
// ---------------------------------------------------------------------------

describe('dynamic.compact', () => {
  const state = { images: { members: ['m0', 'm1', 'm2'], seq: 3 } }

  it('removes unreferenced rows while preserving linked member identity and order', () => {
    const g = graph({
      id: 'g0',
      nodes: { src: node('src'), n1: node('n1', { dynamic: state }) },
      links: {
        l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'images.m1') },
      },
    })
    const store = makeStore(doc({ g0: g }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1'], seq: 3 } })
    const revision = store.revision
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })

  it("retains a member whose only wire leaves a field's output", () => {
    const store = makeStore(doc({ g0: graph({
      id: 'g0',
      nodes: { n1: node('n1', { dynamic: state }), sink: node('sink') },
      links: { l1: { id: asLinkId('l1'), from: { node: asNodeId('n1'), tap: asPortId('images.m2') }, to: port('sink', 'in') } },
    }) }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m2'], seq: 3 } })
  })

  it('retains a member whose only state is a chosen key or an authored menu at a flattened id', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: {
      items: { members: ['m0', 'm1', 'm2'], seq: 3 },
      'items.m1.choice': { options: ['a', 'b'] },
      'items.m2.mode': { selected: 'x' },
    } }) } }) }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')!.items).toEqual({ members: ['m1', 'm2'], seq: 3 })
  })

  it('retains labels only for members retained by semantic references', () => {
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src'), n1: node('n1', { dynamic: {
          images: {
            members: ['m0', 'm1'], seq: 2,
            memberLabels: { m0: 'Removed', m1: 'Retained' },
          },
        } }) },
        links: {
          l1: { id: asLinkId('l1'), from: port('src', 'out'),
            to: port('n1', 'images.m1') },
        },
      }),
    }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      images: { members: ['m1'], seq: 2, memberLabels: { m1: 'Retained' } },
    })
  })

  it('offers the first unused name as the spare member of a named group after compaction', () => {
    const parsed = parseDinksterSchema('Math Expression', {
      schemaVersion: 2,
      nodeType: 'Math Expression',
      body: [{
        kind: 'group', id: 'values', keys: { named: ['a', 'b', 'c'] }, grows: 'link', minMembers: 1,
        value: {
          kind: 'input', id: 'value',
          type: { kind: 'concrete', types: ['core.number'] }, required: false,
        },
      }],
    })
    expect(parsed.diagnostics).toEqual([])
    const schema = parsed.schema!
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src'),
          n1: node('n1', {
            dynamic: { values: { members: ['a', 'b'] } },
            values: { 'values.b': 2 },
          }),
        },
        links: {
          l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'values.b') },
        },
      }),
    }))

    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['b'], seq: 0 } })
    const inputs = elabInputsOf(elaborateInterface(schema, {
      values: store.doc.graphs.g0!.nodes.n1!.values,
      dynamic: store.doc.graphs.g0!.nodes.n1!.dynamic!,
    })).map((input) => ({
      port: input.address.port,
      ghost: input.origin.kind === 'member' && input.origin.ghost === true,
    }))
    expect(inputs).toEqual([
      { port: 'values.b', ghost: false },
      { port: 'values.a', ghost: true },
    ])

    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['a', 'b'], seq: 0 } })
    expect(store.redo()).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ values: { members: ['b'], seq: 0 } })
    expect(store.doc.graphs.g0!.nodes.n1!.values['values.b']).toBe(2)
    expect(store.doc.graphs.g0!.links.l1!.to).toEqual(port('n1', 'values.b'))
  })

  it('keeps members referenced by stored values', () => {
    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: state, values: { 'images.m2': 4 } }) } }) }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m2'], seq: 3 } })
  })

  it('keeps members referenced by nets', () => {
    const g = graph({
      id: 'g0',
      nodes: { n1: node('n1', { dynamic: state }), dst: node('dst') },
      nets: { net1: { id: asNetId('net1'), name: 'n', source: port('n1', 'images.m0'), sinks: [port('dst', 'in')] } },
    })
    const store = makeStore(doc({ g0: g }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m0'], seq: 3 } })
  })

  it('keeps members referenced by the flattened ids of links and nets', () => {
    const g = graph({
      id: 'g0',
      nodes: { src: node('src'), n1: node('n1', { dynamic: state }), dst: node('dst') },
      links: {
        l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'images.m1') },
      },
      nets: {
        net1: { id: asNetId('net1'), name: 'n', source: port('n1', 'images.m2'), sinks: [port('dst', 'in')] },
      },
    })
    const store = makeStore(doc({ g0: g }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1', 'm2'], seq: 3 } })
  })

  it('keeps every group a nested flattened id lies within', () => {
    const dynamic = {
      outer: { members: ['root', 'unused'], seq: 2 },
      'outer.root.inner': { members: ['child', 'unused'], seq: 2 },
    }
    const g = graph({
      id: 'g0',
      nodes: { src: node('src'), n1: node('n1', { dynamic }) },
      links: {
        l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('n1', 'outer.root.inner.child') },
      },
    })
    const store = makeStore(doc({ g0: g }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      outer: { members: ['root'], seq: 2 },
      'outer.root.inner': { members: ['child'], seq: 2 },
    })
  })

  it('keeps members referenced by flat/nested values and flattened choices', () => {
    const dynamic = {
      outer: { members: ['root', 'unused'], seq: 2 },
      'outer.root.inner': { members: ['child', 'unused'], seq: 2 },
      'outer.root.inner.child.mode': { selected: 'on' },
    }
    const store = makeStore(doc({
      g0: graph({
        id: 'g0',
        nodes: {
          n1: node('n1', {
            dynamic,
            values: { 'outer.root.inner.child': 1 },
          }),
        },
      }),
    }))
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      outer: { members: ['root'], seq: 2 },
      'outer.root.inner': { members: ['child'], seq: 2 },
      'outer.root.inner.child.mode': { selected: 'on' },
    })
  })

  it('keeps members referenced by boundary bindings', () => {
    const g = graph({
      id: 'g0',
      nodes: { n1: node('n1', { dynamic: state }) },
      boundary: boundaryOf([{ id: 'in', binds: { kind: 'port', ...port('n1', 'images.m1') } }], []),
    })
    const store = makeStore(doc({ g0: g }))
    store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } })
    expect(dynOf(store, 'n1')).toEqual({ images: { members: ['m1'], seq: 3 } })
  })

})

describe('dynamic.moveMember', () => {
  const ordered = (extra: Partial<GroupSpec> = {}) => schemaOf([{ ...group('items', { max: 8, prefix: 'item' }), reorderable: true, ...extra } as GroupSpec])
  const storeWith = (schema: NodeSchema, dynamic: Record<string, unknown>, values: Record<string, unknown> = {}) =>
    new DocumentStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic, values }) } }) }), coreCommandRegistry(),
      200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => () => schema }))
  const move = (store: DocumentStore, member: string, index: number, construct = 'items') =>
    store.dispatch({ command: 'dynamic.moveMember', params: { graphId: 'g0', nodeId: 'n1', construct, member, index } })
  const codes = (out: ReturnType<DocumentStore['dispatch']>) => out.diagnostics.map((diagnostic) => diagnostic.code)

  it('moves a member to a position and keeps every key, value, label and seq', () => {
    const dynamic = { items: { members: ['item0', 'item1', 'item2', 'item3'], seq: 6, memberLabels: { item3: 'Last' } } }
    const store = storeWith(ordered(), dynamic, { 'items.item3': 4 })
    expect(move(store, 'item3', 1).ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({ items: { members: ['item0', 'item3', 'item1', 'item2'], seq: 6, memberLabels: { item3: 'Last' } } })
    expect(move(store, 'item0', 3).ok).toBe(true)
    expect(dynOf(store, 'n1')!['items']!.members).toEqual(['item3', 'item1', 'item2', 'item0'])
    expect(store.doc.graphs['g0']!.nodes['n1']!.values).toEqual({ 'items.item3': 4 })
    // The shown number follows position; the key does not change.
    const inputs = elabInputsOf(elaborateInterface(ordered(), store.doc.graphs['g0']!.nodes['n1']!))
      .filter((input) => input.origin.kind === 'member' && input.origin.ghost !== true)
    expect(inputs.map((input) => [input.spec.id, input.spec.displayName])).toEqual([
      ['items.item3', 'Last'], ['items.item1', 'item 2'], ['items.item2', 'item 3'], ['items.item0', 'item 4'],
    ])
    // Each move is one undo step.
    store.undo()
    expect(dynOf(store, 'n1')!['items']!.members).toEqual(['item0', 'item3', 'item1', 'item2'])
  })

  it('records nothing when the member stays where it is', () => {
    const store = storeWith(ordered(), { items: { members: ['item0', 'item1'], seq: 2 } })
    const revision = store.revision
    expect(move(store, 'item1', 1).ok).toBe(true)
    expect(store.revision).toBe(revision)
  })

  it('refuses a group that is not reorderable, a count group, a missing member and a position outside the list', () => {
    const stored = { items: { members: ['item0', 'item1'], seq: 2 } }
    expect(codes(move(storeWith(schemaOf([group('items', { prefix: 'item' })]), stored), 'item1', 0))).toEqual(['dynamic.notReorderable'])
    expect(codes(move(storeWith(ordered({ grows: { count: '2' } }), stored), 'item1', 0))).toEqual(['dynamic.notReorderable'])
    expect(codes(move(storeWith(ordered(), stored), 'item1', 0, 'missing'))).toEqual(['dynamic.notReorderable'])
    expect(codes(move(storeWith(ordered(), stored), 'item7', 0))).toEqual(['dynamic.memberMissing'])
    expect(codes(move(storeWith(ordered(), stored), 'item1', 2))).toEqual(['params.invalid'])
    expect(codes(move(storeWith(ordered(), stored), 'item1', -1))).toEqual(['params.invalid'])
    // Without the node's schema the command cannot tell, so it refuses.
    const blind = new DocumentStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic: stored }) } }) }), coreCommandRegistry())
    expect(codes(move(blind, 'item1', 0))).toEqual(['dynamic.notReorderable'])
  })

  it('moves a member of a group nested in a member, by the nested group\'s flattened id', () => {
    const schema = schemaOf([{ ...group('outer', { prefix: 'o', member: [{ ...group('inner', { prefix: 'i' }), reorderable: true } as GroupSpec] }) }])
    const store = storeWith(schema, { outer: { members: ['o0'], seq: 1 }, 'outer.o0.inner': { members: ['i0', 'i1'], seq: 2 } })
    expect(move(store, 'i1', 0, 'outer.o0.inner').ok).toBe(true)
    expect(dynOf(store, 'n1')!['outer.o0.inner']!.members).toEqual(['i1', 'i0'])
  })
})

describe('stored state that follows the schema', () => {
  // Each member holds a required choice that starts on 'a' and a group of its own.
  const schema = (minMembers: number): NodeSchema => schemaOf([{
    kind: 'group', id: 'items', keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 }, grows: 'link', minMembers,
    member: [
      socketInput('img'),
      { kind: 'choice', id: 'mode', required: true, shared: [], options: [{ key: 'a', rows: [] }, { key: 'b', rows: [] }] },
      { kind: 'group', id: 'sub', keys: { kind: 'numbered', prefix: 's', start: 0, pad: 0 }, grows: 'link', minMembers: 0,
        value: socketInput('v') },
    ],
  } as GroupSpec])
  const storeFor = (minMembers: number, dynamic: Record<string, unknown>) =>
    new DocumentStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1', { dynamic }) } }) }), coreCommandRegistry(),
      200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => () => schema(minMembers) }))
  const compact = (store: DocumentStore) =>
    expect(store.dispatch({ command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'n1' } }).ok).toBe(true)

  it('compaction counts a choice off its start key as use, drops what a removed member stored, and keeps the minimum', () => {
    const store = storeFor(1, {
      items: { members: ['item0', 'item1', 'item2', 'item3'], seq: 4 },
      'items.item0.mode': { selected: 'a' },
      'items.item1.mode': { selected: 'b' },
      'items.item2.mode': { selected: 'a' },
      'items.item2.sub': { members: ['s0'], seq: 1 },
    })
    compact(store)
    expect(dynOf(store, 'n1')).toEqual({ items: { members: ['item1'], seq: 4 }, 'items.item1.mode': { selected: 'b' } })

    // Nothing is in use: the first member stays, so the group keeps its minimum.
    const idle = storeFor(1, {
      items: { members: ['item2', 'item3'], seq: 4 },
      'items.item2.mode': { selected: 'a' },
      'items.item3.mode': { selected: 'a' },
    })
    compact(idle)
    expect(dynOf(idle, 'n1')).toEqual({ items: { members: ['item2'], seq: 4 }, 'items.item2.mode': { selected: 'a' } })
  })

  it('stores the minimum members of a group that grows by hand, after the ones it has', () => {
    const fresh = storeFor(2, {})
    expect(fresh.dispatch({ command: 'dynamic.storeStartState', params: {} }).ok).toBe(true)
    expect(dynOf(fresh, 'n1')).toEqual({
      items: { members: ['item0', 'item1'], seq: 2 },
      'items.item0.mode': { selected: 'a' },
      'items.item1.mode': { selected: 'a' },
    })
    const short = storeFor(2, { items: { members: ['item5'], seq: 6 }, 'items.item5.mode': { selected: 'b' } })
    expect(short.dispatch({ command: 'dynamic.storeStartState', params: {} }).ok).toBe(true)
    expect(dynOf(short, 'n1')).toEqual({
      items: { members: ['item5', 'item6'], seq: 7 },
      'items.item5.mode': { selected: 'b' },
      'items.item6.mode': { selected: 'a' },
    })
  })
})

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

describe('batch', () => {
  const twoNodes = () =>
    doc({ g0: graph({ id: 'g0', nodes: { src: node('src'), dst: node('dst') } }) })

  it('materialize + link.connect commits as ONE transaction and ONE undo step', () => {
    const store = makeStore(twoNodes())
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'dynamic.materialize',
            params: { graphId: 'g0', nodeId: 'dst', frames: [{ construct: 'images', members: ['image0'], seq: 1 }] },
          },
          {
            command: 'link.connect',
            params: {
              graphId: 'g0',
              from: port('src', 'out0'),
              to: { node: 'dst', port: 'images.image0' },
            },
          },
        ],
      },
    })
    expect(out.ok).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({ images: { members: ['image0'], seq: 1 } })
    const links = Object.values(store.doc.graphs['g0']!.links)
    expect(links).toHaveLength(1)
    expect(links[0]!.to).toEqual({ node: 'dst', port: 'images.image0' })

    // One undo removes BOTH the member and the link. The seq high-water
    // mark stays behind (CO3): member keys are never reused across undo.
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({ images: { seq: 1 } })
    expect(Object.values(store.doc.graphs['g0']!.links)).toHaveLength(0)
    expect(store.canUndo).toBe(false)

    // Redo restores both.
    expect(store.redo()).toBe(true)
    expect(dynOf(store, 'dst')).toEqual({ images: { members: ['image0'], seq: 1 } })
    expect(Object.values(store.doc.graphs['g0']!.links)).toHaveLength(1)
  })

  it('a failing sub-command aborts the whole batch: no orphaned materialization', () => {
    const store = makeStore(twoNodes())
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'dynamic.materialize',
            params: { graphId: 'g0', nodeId: 'dst', frames: [{ construct: 'images', members: ['m0'] }] },
          },
          {
            // Self-loop: link.connect rejects, so the materialization above
            // must not survive.
            command: 'link.connect',
            params: { graphId: 'g0', from: port('dst', 'out0'), to: port('dst', 'images.item') },
          },
        ],
      },
    })
    expect(out.ok).toBe(false)
    expect(dynOf(store, 'dst')).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// materializeFramesOf
// ---------------------------------------------------------------------------

describe('materializeFramesOf', () => {
  const ghostsOf = (inputs: readonly ElaboratedInput[]): readonly ElaboratedInput[] => {
    const ghosts = inputs.filter((i) => i.origin.kind === 'member' && i.origin.ghost === true)
    expect(ghosts.length).toBeGreaterThan(0)
    return ghosts
  }
  const linked = (...ports: string[]) => ({
    isInputConnected: (port: string) => ports.includes(port),
    isOutputConnected: () => false,
  })

  it('spare member on a fresh min-0 group: one frame with just its key', () => {
    const e = elaborateInterface(schemaOf([group('images', { min: 0 })]), { values: {} })
    const frames = materializeFramesOf(e.items, ghostsOf(elabInputsOf(e))[0]!)
    expect(frames).toEqual([{ construct: 'images', members: ['image0'], seq: 1 }])
  })

  it('an offered member persists with every offered member before it', () => {
    const e = elaborateInterface(schemaOf([group('images', { min: 2 })]), { values: {} })
    const ghosts = ghostsOf(elabInputsOf(e))
    expect(ghosts.map((i) => i.address.port)).toEqual(['images.image0', 'images.image1'])
    expect(materializeFramesOf(e.items, ghosts[1]!)).toEqual([{ construct: 'images', members: ['image0', 'image1'], seq: 2 }])
    expect(materializeFramesOf(e.items, ghosts[0]!)).toEqual([{ construct: 'images', members: ['image0'], seq: 1 }])
  })

  it('a stored member needs no frame', () => {
    const e = elaborateInterface(schemaOf([group('images', { min: 0 })]), {
      values: {},
      dynamic: { images: { members: ['image0'], seq: 1 } },
    })
    const stored = elabInputsOf(e).find((i) => i.address.port === 'images.image0')!
    expect(materializeFramesOf(e.items, stored)).toBeUndefined()
  })

  it('the spare member after a stored prefix continues from seq', () => {
    const e = elaborateInterface(schemaOf([group('images', { min: 0 })]), {
      values: {},
      dynamic: { images: { members: ['image0'], seq: 1 } },
    }, linked('images.image0'))
    const frames = materializeFramesOf(e.items, ghostsOf(elabInputsOf(e))[0]!)
    expect(frames).toEqual([{ construct: 'images', members: ['image1'], seq: 2 }])
  })

  it('a nested spare member under a stored outer member: only the inner frame', () => {
    const nested = group('items', { min: 0, prefix: 'item', member: [group('sub', { min: 0, prefix: 'sub' })] })
    const e = elaborateInterface(schemaOf([nested]), {
      values: {},
      dynamic: { items: { members: ['item0'], seq: 1 } },
    })
    const innerGhost = elabInputsOf(e).find(
      (i) =>
        i.origin.kind === 'member' &&
        i.origin.ghost === true &&
        i.ancestry?.length === 2 &&
        i.ancestry[0]!.member === 'item0',
    )
    expect(innerGhost?.address.port).toBe('items.item0.sub.sub0')
    const frames = materializeFramesOf(e.items, innerGhost!)
    expect(frames).toEqual([{ construct: 'items.item0.sub', members: ['sub0'], seq: 1 }])
  })

  it('keeps nested group materialization in flattened document paths', () => {
    const parsed = parseDinksterSchema('nested-groups', {
      schemaVersion: 2,
      nodeType: 'nested-groups',
      body: [{
        kind: 'group', id: 'outer', keys: { numbered: { prefix: 'row', start: 0 } }, grows: 'link', minMembers: 1, maxMembers: 3,
        member: [{
          kind: 'group', id: 'inner', keys: { numbered: { prefix: 'sub', start: 0 } }, grows: 'link', minMembers: 1, maxMembers: 2,
          value: {
            kind: 'input', id: 'value',
            type: { kind: 'concrete', types: ['INT'] }, required: false,
          },
        }],
      }],
    })
    expect(parsed.diagnostics).toEqual([])
    const schema = parsed.schema!
    const elaborated = elaborateInterface(schema, { values: {}, dynamic: {} })
    const target = elabInputsOf(elaborated).find(
      (input) => input.address.port === 'outer.row0.inner.sub0',
    )
    expect(target).toBeDefined()
    const frames = materializeFramesOf(elaborated.items, target!)
    expect(frames).toEqual([
      { construct: 'outer', members: ['row0'], seq: 1 },
      { construct: 'outer.row0.inner', members: ['sub0'], seq: 1 },
    ])

    const store = makeStore(doc({ g0: graph({ id: 'g0', nodes: { n1: node('n1') } }) }))
    const outcome = store.dispatch({
      command: 'dynamic.materialize',
      params: {
        graphId: 'g0', nodeId: 'n1',
        frames: frames!.map((frame) => ({ construct: frame.construct, members: [...frame.members], seq: frame.seq! })),
      },
    })
    expect(outcome.ok).toBe(true)
    expect(dynOf(store, 'n1')).toEqual({
      outer: { members: ['row0'], seq: 1 },
      'outer.row0.inner': { members: ['sub0'], seq: 1 },
    })

    const dynamic = dynOf(store, 'n1')
    const reloaded = elaborateInterface(schema, {
      values: {},
      ...(dynamic !== undefined ? { dynamic } : {}),
    })
    expect(reloaded.diagnostics).toEqual([])
    expect(elabInputsOf(reloaded).map((input) => [input.address.port, input.apiName])).toContainEqual([
      'outer.row0.inner.sub0',
      'outer.row0.inner.sub0',
    ])
  })
})

describe('a count that shrinks', () => {
  it('removes the wires, nets and forwards on the outputs of the members past it, in the same undo step', () => {
    const field = (id: string): InputSpec => ({
      ...socketInput(id, 'INT'), widget: { widgetType: 'INT', options: {}, default: 1 },
    })
    const schema = schemaOf([field('count'), {
      kind: 'group', id: 'items', keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: { count: 'count' }, minMembers: 0, maxMembers: 4,
      member: [field('amount'), { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } }],
    } as GroupSpec])
    const link = (id: string, from: object, to: string) => [id, { id: asLinkId(id), from, to: port('n2', to) }]
    const initial = doc({ g0: graph({
      id: 'g0',
      nodes: { n1: node('n1', { values: { count: 3 } }), n2: node('n2', { type: 'Sink' }) },
      links: Object.fromEntries([
        link('kept', { node: asNodeId('n1'), tap: asPortId('items.item0.amount') }, 'a'),
        link('tap', { node: asNodeId('n1'), tap: asPortId('items.item2.amount') }, 'b'),
        link('out', port('n1', 'items.item2.image'), 'c'),
      ]),
      nets: { net: { id: asNetId('net'), name: 'second', source: port('n1', 'items.item1.image'), sinks: [port('n2', 'd')] } },
      boundary: boundaryOf([], [
        { id: 'first', binds: { kind: 'widgetTap', node: asNodeId('n1'), tap: asPortId('items.item0.amount') } },
        { id: 'third', binds: { kind: 'port', node: asNodeId('n1'), port: asPortId('items.item2.image') } },
      ]),
    }) })
    const store = new DocumentStore(initial, coreCommandRegistry(), 200, undefined,
      () => ({ kind: 'initial', schemaResolverFor: () => (type) => type === 'Batch' ? schema : undefined }))
    expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'count', value: 1 } }).ok).toBe(true)
    expect(Object.keys(store.doc.graphs['g0']!.links)).toEqual(['kept'])
    expect(store.doc.graphs['g0']!.nets).toEqual({})
    expect(boundaryItems(store.doc.graphs['g0']!.boundary, 'outputs').map((item) => item.id)).toEqual(['first'])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(initial)
    // A count that grows removes nothing.
    expect(store.dispatch({ command: 'node.setValues', params: { graphId: 'g0', nodeId: 'n1', values: { count: 4 } } }).ok).toBe(true)
    expect(Object.keys(store.doc.graphs['g0']!.links).sort()).toEqual(['kept', 'out', 'tap'])
  })
})
