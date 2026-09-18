/**
 * App-view row resolution (app-view-rows.ts): exposed entries against live
 * graphs + schemas, with the graph's REAL connectivity.
 *
 * What must hold:
 * - `linked` covers link-driven inputs AND named-net sinks: both are
 *   connection-driven, so a form edit would write a dormant value
 * - elaboration receives connectivity (not EMPTY_CONNECTIVITY), matching
 *   what the canvas scene passes - the app view must resolve the same
 *   elaborated interface as the graph editor
 * - unresolvable entries are STALE rows with reasons, never dropped
 * - values resolve stored -> widget default, and rows keep declared order
 */

import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
  type GraphDef,
  type InputSpec,
  type Json,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
  type WidgetRegistry,
  type WidgetView,
  type WorkflowDocument,
} from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { appViewQueueScope, appViewQueueTargetOptions, appViewWidgetPresentation, buildParamRows, buildPreviewRows, fetchRemoteComboOptions, moveExposedInvocation, previewRuntimeMapping, remoteComboOptions, remoteComboRefreshCanAdvance, type ParamRow } from '../src/app-view-rows.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }

const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  widget: { widgetType: 'INT', options: {}, default: 5 },
  ...extra,
})
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })

const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  Sink: schemaOf('Sink', [input('seed'), input('steps'), input('provider', { hidden: true })]),
  Preview: schemaOf('Preview', [input('image', {
    type: { kind: 'concrete', name: 'core.ASSET' },
    widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null },
  })]),
  Slot: schemaOf('Slot', [
    {
      kind: 'input',
      id: 'slot',
      type: IMAGE,
      optional: true,
      dynamic: { kind: 'dynamicSlot', slotType: IMAGE, inputs: [input('gain')] },
    },
    output('out'),
  ]),
}
const resolve = (type: string): NodeSchema | undefined => schemas[type]

function doc(g: {
  values?: Record<string, Json>
  links?: GraphDef['links']
  nets?: GraphDef['nets']
  exposed?: Json
  exposedPreviews?: Json
}): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('rows'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'g',
        nodes: {
          src: { id: asNodeId('src'), type: 'Src', values: {} },
          sink: { id: asNodeId('sink'), type: 'Sink', values: g.values ?? {} },
          preview: { id: asNodeId('preview'), type: 'Preview', values: g.values ?? {} },
          dyn: { id: asNodeId('dyn'), type: 'Slot', values: {} },
        },
        links: g.links ?? {},
        nets: g.nets ?? {},
        reroutes: {},
        nextOrdinal: 10,
      },
    },
    view: { graphs: {} },
    ...(g.exposed !== undefined || g.exposedPreviews !== undefined
      ? { ext: {
          ...(g.exposed !== undefined ? { 'dinkster.exposed': g.exposed } : {}),
          ...(g.exposedPreviews !== undefined ? { 'dinkster.exposedPreviews': g.exposedPreviews } : {}),
        } }
      : {}),
  } as WorkflowDocument
}

const entry = (nodeId: string, inputId: string): Json => ({ graphId: 'g0', nodeId, inputId })
const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const live = (row: ParamRow): Extract<ParamRow, { kind: 'live' }> => {
  expect(row.kind).toBe('live')
  return row as Extract<ParamRow, { kind: 'live' }>
}

describe('buildParamRows', () => {
  it('omits a hidden compatibility input while preserving its stored exposure', () => {
    const document = doc({
      values: { provider: 'vision.depth.v2' },
      exposed: [entry('sink', 'provider'), entry('sink', 'steps')],
    })
    expect(buildParamRows(document, resolve).map((row) => row.entry.inputId)).toEqual(['steps'])
    expect(document.ext?.['dinkster.exposed']).toEqual([entry('sink', 'provider'), entry('sink', 'steps')])
    expect(document.graphs.g0!.nodes.sink!.values.provider).toBe('vision.depth.v2')
  })

  it('resolves live rows in declared order: stored value, widget default fallback', () => {
    const rows = buildParamRows(
      doc({ values: { seed: 42 }, exposed: [entry('sink', 'steps'), entry('sink', 'seed')] }),
      resolve,
    )
    expect(rows.map((r) => r.entry.inputId)).toEqual(['steps', 'seed'])
    expect(live(rows[0]!).value).toBe(5) // widget default
    expect(live(rows[1]!).value).toBe(42) // stored
    expect(rows.map((r) => live(r).linked)).toEqual([false, false])
  })

  it('marks a link-driven input linked (read-only in the form)', () => {
    const rows = buildParamRows(
      doc({
        links: { l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('sink', 'seed') } } satisfies GraphDef['links'],
        exposed: [entry('sink', 'seed'), entry('sink', 'steps')],
      }),
      resolve,
    )
    expect(live(rows[0]!).linked).toBe(true)
    expect(live(rows[1]!).linked).toBe(false)
  })

  it('marks a named-net SINK linked: the net drives the input exactly like a link', () => {
    const rows = buildParamRows(
      doc({
        nets: {
          net1: { id: asNetId('net1'), name: 'imgs', source: port('src', 'out'), sinks: [port('sink', 'seed')] },
        } satisfies GraphDef['nets'],
        exposed: [entry('sink', 'seed'), entry('sink', 'steps')],
      }),
      resolve,
    )
    expect(live(rows[0]!).linked).toBe(true)
    expect(live(rows[1]!).linked).toBe(false)
  })

  it('renders unresolvable entries as stale rows with reasons, never dropping them', () => {
    const rows = buildParamRows(
      doc({
        exposed: [
          { graphId: 'gX', nodeId: 'sink', inputId: 'seed' },
          { graphId: 'g0', nodeId: 'ghost', inputId: 'seed' },
          { graphId: 'g0', nodeId: 'sink', inputId: 'nope' },
          entry('sink', 'seed'),
        ],
      }),
      resolve,
    )
    expect(rows.map((r) => r.kind)).toEqual(['stale', 'stale', 'stale', 'live'])
    expect(rows.slice(0, 3).map((r) => (r as Extract<ParamRow, { kind: 'stale' }>).reason)).toEqual([
      'graph no longer exists',
      'node no longer exists',
      "input 'nope' no longer exists",
    ])
  })

  it('resolves DynamicSlot dependents through real connectivity: absent while the slot is disconnected, live once linked', () => {
    // Dependents exist only while the slot is CONNECTED (elaborate.ts): the
    // app view must feed elaboration the graph's real connectivity or the
    // exposed 'slot.gain' would diverge from what the canvas renders.
    const exposed = [{ graphId: 'g0', nodeId: 'dyn', inputId: 'slot.gain' }]
    const disconnected = buildParamRows(doc({ exposed }), resolve)
    expect(disconnected[0]!.kind).toBe('stale')
    expect((disconnected[0] as Extract<ParamRow, { kind: 'stale' }>).reason).toBe("input 'slot.gain' no longer exists")

    const connected = buildParamRows(
      doc({
        links: { l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('dyn', 'slot') } } satisfies GraphDef['links'],
        exposed,
      }),
      resolve,
    )
    const row = live(connected[0]!)
    expect(row.valueKey).toBe('slot.gain')
    expect(row.linked).toBe(false) // the SLOT is linked; the dependent itself is not
    expect(row.value).toBe(5) // widget default
  })

  it('renders every row stale when no schema resolver is available (registry not ready)', () => {
    const rows = buildParamRows(doc({ exposed: [entry('sink', 'seed')] }), undefined)
    expect(rows[0]!.kind).toBe('stale')
  })

  it('resolves the same default WidgetView as canvas and preserves a no-view fallback', () => {
    const row = live(buildParamRows(doc({ exposed: [entry('sink', 'seed')] }), resolve)[0]!)
    const customView = {
      id: 'test.literal', kind: 'INT', isCompatible: () => true,
      measure: () => ({ rows: 2 }), drawCompact: () => undefined,
    } satisfies WidgetView
    const registry = {
      kind: () => ({
        type: 'INT', valueSchema: { version: 1, validate: (value: unknown): value is Json => typeof value === 'number' },
        defaultValue: () => 0, validate: () => [], defaultView: () => customView.id,
      }),
      viewsFor: () => [customView],
    } as unknown as WidgetRegistry

    expect(appViewWidgetPresentation(row, registry)).toEqual({ view: customView, rows: 2 })
    expect(appViewWidgetPresentation(row, { ...registry, viewsFor: () => [] })).toBeUndefined()
  })
})

describe('buildPreviewRows', () => {
  const rendererFor = ((channel: string) => channel === 'image/png'
    ? { id: 'test.image', mediaKind: 'image', canRender: () => true }
    : undefined) as WidgetRegistry['previewRendererFor']

  it('preserves declared order, labels, and selected-asset preview metadata', () => {
    const asset = {
      digest: `blake3:${'1'.repeat(64)}`,
      name: 'preview.png',
      size: 10,
      mediaType: 'image/png',
      virtualPath: 'preview.png',
    }
    const rows = buildPreviewRows(doc({
      values: { image: [asset, { ...asset, digest: `blake3:${'2'.repeat(64)}` }] },
      exposedPreviews: [
        { graphId: 'g0', nodeId: 'preview', label: 'Result' },
        { graphId: 'g0', nodeId: 'sink' },
      ],
    }), resolve, rendererFor)

    expect(rows.map((row) => row.entry.nodeId)).toEqual(['preview', 'sink'])
    expect(rows[0]).toMatchObject({
      kind: 'candidate',
      label: 'Result',
      context: 'Preview',
      selectedAsset: {
        digest: asset.digest,
        name: 'preview.png',
        count: 2,
        mediaType: 'image/png',
        mediaKind: 'image',
      },
    })
  })

  it('retains entries for missing graphs and nodes as stale rows', () => {
    const rows = buildPreviewRows(doc({
      exposedPreviews: [
        { graphId: 'missing', nodeId: 'preview' },
        { graphId: 'g0', nodeId: 'missing' },
      ],
    }), resolve, rendererFor)

    expect(rows.map((row) => row.kind)).toEqual(['stale', 'stale'])
    expect(rows.map((row) => row.kind === 'stale' ? row.reason : '')).toEqual([
      'graph no longer exists',
      'node no longer exists',
    ])
  })
})

describe('previewRuntimeMapping', () => {
  it('aggregates nested occurrences of a shared definition without changing occurrence order', () => {
    const sharedDoc = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'shared-preview', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 4,
          nodes: {
            sharedA: { id: 'sharedA', type: '#shared', values: {} },
            sharedB: { id: 'sharedB', type: '#shared', values: {} },
            outer: { id: 'outer', type: '#outer', values: {} },
          },
        },
        outer: {
          id: 'outer', name: 'outer', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { inner: { id: 'inner', type: '#shared', values: {} } },
        },
        shared: {
          id: 'shared', name: 'shared', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
          nodes: {
            target: { id: 'target', type: 'Preview', values: {} },
            nested: { id: 'nested', type: '#leaf', values: {} },
          },
        },
        leaf: {
          id: 'leaf', name: 'leaf', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { deep: { id: 'deep', type: 'Preview', values: {} } },
        },
      },
      view: { graphs: {} },
    } as unknown as WorkflowDocument
    const runtimeIds = [
      'outer.inner.nested.deep',
      'sharedB.nested.deep',
      'sharedA.nested.deep',
      'outer.inner.nested',
      'sharedB.nested',
      'sharedA.nested',
      'outer.inner.target',
      'sharedB.target',
      'sharedA.target[2]',
      'sharedA.target',
      'unrelated.target',
    ]
    const execution = {
      nodes: Object.fromEntries(runtimeIds.map((runtimeId) => [runtimeId, { state: 'done' }])),
      outputs: { 'sharedA.target': {} },
      previews: {}, activities: [], artifacts: [],
    } as unknown as ExecutionState

    const mapping = previewRuntimeMapping(sharedDoc, execution, 'shared')!
    expect(mapping.own('target')).toEqual([
      'sharedA.target', 'sharedA.target[2]', 'sharedB.target', 'outer.inner.target',
    ])
    expect(mapping.own('nested')).toEqual([
      'sharedA.nested', 'sharedB.nested', 'outer.inner.nested',
    ])
    expect(mapping.all('nested')).toEqual([
      'sharedA.nested', 'sharedA.nested.deep',
      'sharedB.nested', 'sharedB.nested.deep',
      'outer.inner.nested', 'outer.inner.nested.deep',
    ])
  })
})

describe('App View queue targets', () => {
  it('expands one definition target across repeated nested occurrences and reports stale targets', () => {
    const sharedDoc = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'shared-queue', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 4,
          nodes: {
            sharedA: { id: 'sharedA', type: '#shared', values: {} },
            sharedB: { id: 'sharedB', type: '#shared', values: {} },
            direct: { id: 'direct', type: 'Output', title: 'Direct result', values: {} },
          },
        },
        shared: {
          id: 'shared', name: 'Shared stage', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { target: { id: 'target', type: 'Output', title: 'Shared result', values: {} } },
        },
        orphan: {
          id: 'orphan', name: 'Unreachable stage', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { target: { id: 'target', type: 'Output', title: 'Orphan result', values: {} } },
        },
      },
      view: { graphs: {} },
    } as unknown as WorkflowDocument

    expect(appViewQueueTargetOptions(sharedDoc)).toEqual([
      { graphId: 'root', nodeId: 'direct', label: 'Direct result', context: 'Root' },
      { graphId: 'shared', nodeId: 'target', label: 'Shared result', context: 'Shared stage' },
    ])
    expect(appViewQueueScope(sharedDoc, [
      { graphId: 'shared', nodeId: 'target' },
      { graphId: 'missing', nodeId: 'gone' },
    ])).toEqual({
      scope: {
        kind: 'partial',
        targets: [
          { instancePath: ['sharedA'], node: 'target' },
          { instancePath: ['sharedB'], node: 'target' },
        ],
      },
      missing: [{ graphId: 'missing', nodeId: 'gone' }],
    })
  })
})

describe('remoteComboOptions', () => {
  it('fetches and normalizes a successful remote payload with WidgetEditor semantics', async () => {
    const calls: unknown[] = []
    const options = await fetchRemoteComboOptions('/options', async (...args) => {
      calls.push(args)
      return ['alpha', 'beta', '3']
    })
    expect(calls).toEqual([['/options', { refresh: false }]])
    expect(options).toEqual([
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' },
      { value: '3', label: '3' },
    ])
  })

  it('passes schema remote policy to the scoped client demand', async () => {
    const calls: unknown[] = []
    await fetchRemoteComboOptions(
      '/api/choices/models',
      async (...args) => { calls.push(args); return ['alpha'] },
      undefined,
      { timeoutMs: 1200, maxRetries: 1, refreshMs: 5000 },
    )
    expect(calls).toEqual([['/api/choices/models', {
      refresh: false, timeoutMs: 1200, maxRetries: 1, refreshMs: 5000,
    }]])
  })

  it('propagates fetch rejection', async () => {
    await expect(fetchRemoteComboOptions('/options', async () => { throw new Error('offline') })).rejects.toThrow('offline')
  })

  it('keeps an out-of-vocabulary stored value out of fetched options so the view renders its placeholder', () => {
    expect(remoteComboOptions(['alpha', 'beta']).findIndex((option) => option.value === 'old')).toBe(-1)
  })

  it('fires the advancement hook only for an explicit refresh from ready or stale options', () => {
    expect(remoteComboRefreshCanAdvance(false, 'ready')).toBe(false) // cache-backed editor open
    expect(remoteComboRefreshCanAdvance(true, 'loading')).toBe(false)
    expect(remoteComboRefreshCanAdvance(true, 'unavailable')).toBe(false)
    expect(remoteComboRefreshCanAdvance(true, undefined)).toBe(false)
    expect(remoteComboRefreshCanAdvance(true, 'ready')).toBe(true)
    expect(remoteComboRefreshCanAdvance(true, 'stale')).toBe(true)
  })
})

describe('app-view drag reorder', () => {
  it('dispatches params.move for the dragged entry and exact drop index', () => {
    expect(moveExposedInvocation({ graphId: 'g0', nodeId: 'sink', inputId: 'steps' }, 2)).toEqual({
      command: 'params.move',
      params: { graphId: 'g0', nodeId: 'sink', inputId: 'steps', index: 2 },
    })
  })
})
