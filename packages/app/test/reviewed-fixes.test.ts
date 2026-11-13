import { describe, expect, it, vi } from 'vitest'
import { coreCommandRegistry, DocumentStore, type MenuItem, type NodeSchema } from '@dinkster/core'
import { type Scene } from '@dinkster/canvas'

vi.mock('lucide-solid', () => ({
  Ban: {}, Check: {}, CirclePlay: {}, Copy: {}, CopyPlus: {}, Eye: {}, FolderOpen: {}, Group: {},
  Palette: {}, SlidersHorizontal: {}, Trash2: {}, Ungroup: {}, VolumeX: {}, X: {},
}))

import { menuStep, rootPanelPosition, submenuPanelPosition } from '../src/ContextMenu.js'
import { buildCategoryTree, paletteEntryMatchesLinkDrop, recentFirst } from '../src/NodePalette.js'
import { linkDropInvocations, linkSpliceInvocations, occurrenceDeleteDecision, rerouteDropInvocations, selectionDeleteInvocation } from '../src/CanvasHost.js'
import { parseNumericCommit } from '../src/WidgetEditor.js'

describe('occurrence delete classification', () => {
  const counts = {
    boundaryCount: 0, nodeCount: 0, rerouteCount: 0,
    valueSourceCount: 0, selectorCount: 0, groupCount: 0,
  }
  const identity = { kind: 'parent', from: 'a', to: 'b' }

  it('deletes a lone effective delivery through the planner seam', () => {
    expect(occurrenceDeleteDecision({ effectiveLinks: [[identity]], ...counts, drilled: true }))
      .toEqual({ kind: 'occurrence', identity })
  })

  it('refuses a boundary pseudo-node selected with an effective delivery', () => {
    expect(occurrenceDeleteDecision({
      effectiveLinks: [[identity]], ...counts, boundaryCount: 1, drilled: true,
    })).toEqual({ kind: 'mixed' })
  })

  it('refuses definition items selected with an effective delivery', () => {
    expect(occurrenceDeleteDecision({
      effectiveLinks: [[identity], undefined], ...counts, drilled: true,
    })).toEqual({ kind: 'mixed' })
    expect(occurrenceDeleteDecision({
      effectiveLinks: [[identity]], ...counts, nodeCount: 1, drilled: true,
    })).toEqual({ kind: 'mixed' })
    expect(occurrenceDeleteDecision({
      effectiveLinks: [[identity]], ...counts, netViewCount: 1, drilled: true,
    })).toEqual({ kind: 'mixed' })
  })

  it('refuses effective deliveries outside a drilled scene', () => {
    expect(occurrenceDeleteDecision({ effectiveLinks: [[identity]], ...counts, drilled: false }))
      .toEqual({ kind: 'mixed' })
  })

  it('refuses more than one distinct effective delivery', () => {
    expect(occurrenceDeleteDecision({
      effectiveLinks: [[identity], [{ ...identity, to: 'c' }]], ...counts, drilled: true,
    })).toEqual({ kind: 'multi' })
    expect(occurrenceDeleteDecision({
      effectiveLinks: [[identity], [{ ...identity }]], ...counts, drilled: true,
    })).toEqual({ kind: 'occurrence', identity })
  })
})

describe('reviewed fixes', () => {
  const deletionScene = (links: Scene['links']): Scene => ({
    graphId: 'g0', nodes: [], links, reroutes: [], valueSources: [], selectors: [],
    netStubs: [], groups: [], boundaryNodes: [], diagnostics: [],
  })
  const deletionDef = (overrides: Record<string, unknown> = {}) => ({
    id: 'g0', name: 'g0', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
    ...overrides,
  }) as any

  it.each([
    {
      name: 'ordinary link',
      links: [{
        id: 'l1', from: { kind: 'port', node: 'source', port: 'out' },
        to: { kind: 'port', node: 'target', port: 'images.image', members: ['m0'] },
        x1: 0, y1: 0, x2: 1, y2: 1,
      }],
      expectedDelete: { linkIds: ['l1'], netSinks: [] },
    },
    {
      name: 'named-net sink',
      links: [{
        id: 'net1:target', netId: 'net1',
        from: { kind: 'port', node: 'source', port: 'out' },
        to: { kind: 'port', node: 'target', port: 'images.image', members: ['m0'] },
        x1: 0, y1: 0, x2: 1, y2: 1,
      }],
      expectedDelete: {
        linkIds: [],
        netSinks: [{ node: 'target', port: 'images.image', members: ['m0'] }],
      },
    },
  ] as const)('selected $name deletion compacts its destination in the same batch', ({ links, expectedDelete }) => {
    expect(selectionDeleteInvocation({
      graphId: 'g0', def: deletionDef(), scene: deletionScene(links as any),
      nodeIds: [], selectedLinks: [links[0].id],
    })).toEqual({
      command: 'batch',
      params: { invocations: [
        {
          command: 'graph.deleteItems',
          params: {
            graphId: 'g0', nodeIds: [], ...expectedDelete,
            rerouteIds: [], valueSourceIds: [], selectorIds: [],
          },
        },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'target' } },
      ] },
    })
  })

  it('selected boundary deletion unbinds and compacts in the same batch', () => {
    const links = [{
      id: 'boundary:inputs:images', boundary: true,
      from: { kind: 'boundary', side: 'inputs', item: 'images' },
      to: { kind: 'port', node: 'target', port: 'images.image', members: ['m0'] },
      x1: 0, y1: 0, x2: 1, y2: 1,
    }]
    expect(selectionDeleteInvocation({
      graphId: 'g0', def: deletionDef(), scene: deletionScene(links as any),
      nodeIds: [], selectedLinks: [links[0]!.id],
    })).toEqual({
      command: 'batch',
      params: { invocations: [
        {
          command: 'boundary.unbind',
          params: {
            graphId: 'g0', side: 'inputs', itemId: 'images',
            node: 'target', port: 'images.image', members: ['m0'],
          },
        },
        { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'target' } },
      ] },
    })
  })

  it('selected widget-output boundary deletion unbinds the exact tap', () => {
    const links = [{
      id: 'boundary:outputs:amount', boundary: true,
      from: { kind: 'widgetTap', node: 'source', input: 'amount' },
      to: { kind: 'boundary', side: 'outputs', item: 'amount' },
      x1: 0, y1: 0, x2: 1, y2: 1,
    }]
    expect(selectionDeleteInvocation({
      graphId: 'g0', def: deletionDef(), scene: deletionScene(links as any),
      nodeIds: [], selectedLinks: [links[0]!.id],
    })).toEqual({
      command: 'boundary.unbind',
      params: {
        graphId: 'g0', side: 'outputs', itemId: 'amount', node: 'source', tap: 'amount',
      },
    })
  })

  it('executes selected-link deletion and compaction as one undoable store transaction', () => {
    const graph = deletionDef({
      nodes: {
        source: { id: 'source', type: 'Source', values: {} },
        target: {
          id: 'target', type: 'Target', values: {},
          dynamic: { images: { members: ['m0'], seq: 1 } },
        },
      },
      links: {
        l1: {
          id: 'l1', from: { node: 'source', port: 'out' },
          to: { node: 'target', port: 'images.image', members: ['m0'] },
        },
      },
    })
    const store = new DocumentStore({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'delete-compaction', root: 'g0',
      graphs: { g0: graph }, view: { graphs: {} },
    } as any, coreCommandRegistry())
    const invocation = selectionDeleteInvocation({
      graphId: 'g0', def: graph,
      scene: deletionScene([{
        id: 'l1', from: { kind: 'port', node: 'source', port: 'out' },
        to: { kind: 'port', node: 'target', port: 'images.image', members: ['m0'] },
        x1: 0, y1: 0, x2: 1, y2: 1,
      }] as any),
      nodeIds: [], selectedLinks: ['l1'],
    })!
    expect(store.dispatch(invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.links).toEqual({})
    expect(store.doc.graphs.g0!.nodes.target!.dynamic).toEqual({ images: { seq: 1 } })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.g0!.links.l1!.to).toEqual({
      node: 'target', port: 'images.image', members: ['m0'],
    })
    expect(store.doc.graphs.g0!.nodes.target!.dynamic).toEqual({
      images: { members: ['m0'], seq: 1 },
    })
  })

  it.each(['source-node', 'sink-node', 'sink-noodle'] as const)(
    'normalizes overlapping %s and net-view deletion into one successful undo step',
    (kind) => {
      const graph = deletionDef({
        nextOrdinal: 2,
        nodes: {
          source: { id: 'source', type: 'Source', values: {} },
          target: { id: 'target', type: 'Target', values: {} },
        },
        nets: {
          net1: {
            id: 'net1', name: 'shared', source: { node: 'source', port: 'out' },
            sinks: [{ node: 'target', port: 'in' }],
          },
        },
      })
      const netLink = {
        id: 'net1:0', netId: 'net1',
        from: { kind: 'port', node: 'source', port: 'out' },
        to: { kind: 'port', node: 'target', port: 'in' },
        x1: 0, y1: 0, x2: 1, y2: 1,
      } as const
      const view = kind === 'source-node'
        ? {
            id: 'source-view', netId: 'net1', name: 'shared', role: 'source' as const,
            nodeId: 'source', portId: 'out', pinX: 0, pinY: 0, x: 1, y: 1, width: 50, height: 18,
          }
        : {
            id: 'sink-view', netId: 'net1', name: 'shared', role: 'sink' as const,
            nodeId: 'target', portId: 'in', pinX: 0, pinY: 0, x: 1, y: 1, width: 50, height: 18,
          }
      const store = new DocumentStore({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'delete-net-view', root: 'g0',
        graphs: { g0: graph }, view: { graphs: {} },
      } as any, coreCommandRegistry())
      const invocation = selectionDeleteInvocation({
        graphId: 'g0', def: graph, scene: deletionScene([netLink] as any),
        nodeIds: kind === 'source-node' ? ['source'] : kind === 'sink-node' ? ['target'] : [],
        selectedLinks: kind === 'sink-noodle' ? ['net1:0'] : [],
        selectedNetViews: [view],
      })!
      const outcome = store.dispatch(invocation)
      expect(outcome.diagnostics).toEqual([])
      expect(outcome.ok).toBe(true)
      if (kind === 'source-node') expect(store.doc.graphs.g0!.nets).toEqual({})
      else expect(store.doc.graphs.g0!.nets.net1!.sinks).toEqual([])
      expect(store.undo()).toBe(true)
      expect(store.doc.graphs.g0!.nets.net1!.sinks).toEqual([{ node: 'target', port: 'in' }])
    },
  )

  it('source deletion uses authoritative widget-tap links and collapsed nets', () => {
    const invocation = selectionDeleteInvocation({
      graphId: 'g0',
      def: deletionDef({
        links: {
          tap: {
            id: 'tap', from: { node: 'source', tap: 'value' },
            to: { node: 'tap-target', port: 'images.image', members: ['m0'] },
          },
        },
        nets: {
          net1: {
            id: 'net1', name: 'net', source: { node: 'source', port: 'out' },
            sinks: [{ node: 'net-target', port: 'images.image', members: ['m0'] }],
          },
        },
      }),
      scene: deletionScene([]), nodeIds: ['source'], selectedLinks: [],
    }) as any
    expect(invocation.params.invocations.slice(1)).toEqual([
      { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'tap-target' } },
      { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'net-target' } },
    ])
  })

  it('mixed source and boundary selection suppresses stale unbind and compacts surviving fan-out', () => {
    const boundaryLink = {
      id: 'boundary:inputs:value', boundary: true,
      from: { kind: 'boundary', side: 'inputs', item: 'value' },
      to: { kind: 'port', node: 'source', port: 'in' },
      x1: 0, y1: 0, x2: 1, y2: 1,
    }
    const invocation = selectionDeleteInvocation({
      graphId: 'g0',
      def: deletionDef({
        boundary: {
          inputs: [{
            id: 'value', binds: { kind: 'port', node: 'source', port: 'in' },
            alsoBinds: [{ kind: 'port', node: 'target', port: 'images.image', members: ['m0'] }],
          }],
          outputs: [],
        },
      }),
      scene: deletionScene([boundaryLink] as any),
      nodeIds: ['source'], selectedLinks: [boundaryLink.id],
    }) as any
    expect(invocation.params.invocations).toEqual([
      {
        command: 'graph.deleteItems',
        params: {
          graphId: 'g0', nodeIds: ['source'], linkIds: [], netSinks: [],
          rerouteIds: [], valueSourceIds: [], selectorIds: [],
        },
      },
      { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: 'target' } },
    ])
  })

  it('FR14 keyboard navigation skips disabled menu items', () => {
    const item = (id: string, disabled = false): MenuItem => ({
      id,
      label: id,
      action: { kind: 'host', action: 'noop' },
      ...(disabled ? { disabled: true } : {}),
    })
    const flat = [item('a'), item('b', true), item('c')].map((entry) => ({ item: entry, sep: false }))
    expect(menuStep(flat, 0, 1)).toBe(2)
    expect(menuStep(flat, 2, -1)).toBe(0)
    expect(menuStep(flat, 2, 1)).toBe(2)
  })

  it('cascading menus flip left near the viewport edge and remain contained', () => {
    expect(submenuPanelPosition(
      { width: 180, height: 240 },
      { left: 780, top: 550, right: 800 },
      { width: 820, height: 600 },
    )).toEqual({ x: 596, y: 352 })
    expect(submenuPanelPosition(
      { width: 180, height: 240 },
      { left: 20, top: 10, right: 40 },
      { width: 820, height: 600 },
    )).toEqual({ x: 44, y: 10 })
  })

  it('positions oversized root and submenu content by its viewport-capped height', () => {
    expect(rootPanelPosition(
      { width: 180, height: 900 },
      { x: 450, y: 110 },
      { width: 500, height: 120 },
    )).toEqual({ x: 312, y: 8 })
    expect(submenuPanelPosition(
      { width: 180, height: 900 },
      { left: 450, top: 95, right: 470 },
      { width: 500, height: 120 },
    )).toEqual({ x: 266, y: 8 })
  })

  it('FR15 numeric commits reject empty, whitespace, invalid, and non-finite values', () => {
    for (const raw of ['', '   ', 'abc', '1e999', 'Infinity']) {
      expect(parseNumericCommit(raw, 'FLOAT')).toEqual({ ok: false, error: 'Enter a finite number.' })
    }
  })

  it('FR15 numeric commits require exact integers and preserve valid floats', () => {
    expect(parseNumericCommit('2.5', 'INT')).toEqual({
      ok: false,
      error: 'Enter an exact integer from -9223372036854775808 to 18446744073709551615.',
    })
    expect(parseNumericCommit(' 2.5 ', 'FLOAT')).toEqual({ ok: true, value: 2.5 })
  })

  it('FR16 empty-query recency ordering includes entries beyond the search limit', () => {
    const entries = Array.from({ length: 250 }, (_, index) => ({ type: `type-${index}` }))
    const result = recentFirst(entries, (entry) => entry.type, ['type-225'], 200)
    expect(result[0]?.type).toBe('type-225')
    expect(result).toHaveLength(200)
  })

  it('builds slash categories as a counted, sorted folder tree with an uncategorized fallback', () => {
    expect(buildCategoryTree(['image/load', 'image/save', 'audio/load', ''])).toEqual({
      folders: [
        { name: 'audio', path: 'audio', count: 1, children: [{ name: 'load', path: 'audio/load', count: 1, children: [] }] },
        { name: 'image', path: 'image', count: 2, children: [
          { name: 'load', path: 'image/load', count: 1, children: [] },
          { name: 'save', path: 'image/save', count: 1, children: [] },
        ] },
      ],
      uncategorized: 1,
    })
  })

  it('composes a node splice as disconnect plus both compatible connections', () => {
    const schema: NodeSchema = {
      type: 'test.convert', displayName: 'Convert', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'in', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'IMAGE' } },
      ],
    }
    expect(linkSpliceInvocations('g0', 'n9', schema, {
      linkId: 'l2', position: { x: 10, y: 20 },
      fromType: { kind: 'concrete', name: 'IMAGE' }, toType: { kind: 'concrete', name: 'IMAGE' },
      fixedFrom: { node: 'n1', port: 'out' }, fixedInto: { node: 'n2', port: 'in' },
    })).toEqual([
      { command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l2' } },
      { command: 'link.connect', params: { graphId: 'g0', from: { node: 'n1', port: 'out' }, to: { node: 'n9', port: 'in' } } },
      { command: 'link.connect', params: { graphId: 'g0', from: { node: 'n9', port: 'out' }, to: { node: 'n2', port: 'in' } } },
    ])
  })

  it('refuses a splice when either dangling side has unresolved type metadata', () => {
    const schema: NodeSchema = {
      type: 'test.convert', displayName: 'Convert', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'in', type: { kind: 'concrete', name: 'comfy.IMAGE' }, optional: false },
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'comfy.IMAGE' } },
      ],
    }
    expect(linkSpliceInvocations('g0', 'n9', schema, {
      linkId: 'l2', position: { x: 10, y: 20 },
      fromType: { kind: 'wildcard' }, toType: { kind: 'concrete', name: 'comfy.IMAGE' },
      fixedFrom: { node: 'n1', port: 'out' }, fixedInto: { node: 'n2', port: 'in' },
    })).toEqual([])
    expect(linkSpliceInvocations('g0', 'n9', schema, {
      linkId: 'l2', position: { x: 10, y: 20 },
      fromType: { kind: 'concrete', name: 'comfy.IMAGE' }, toType: { kind: 'variable', templateId: 'unknown' },
      fixedFrom: { node: 'n1', port: 'out' }, fixedInto: { node: 'n2', port: 'in' },
    })).toEqual([])
  })

  it('composes dropped-link reroute insertion and connection in one batch payload', () => {
    expect(rerouteDropInvocations('g0', 'r4', { x: 3, y: 4 }, {
      seeking: 'in', anchorType: { kind: 'concrete', name: 'IMAGE' }, anchorX: 0, anchorY: 0,
      fixedFrom: { node: 'n1', port: 'out' },
    })).toEqual([
      { command: 'reroute.add', params: { graphId: 'g0', position: { x: 3, y: 4 } } },
      { command: 'link.connect', params: { graphId: 'g0', from: { node: 'n1', port: 'out' }, to: { reroute: 'r4' } } },
    ])
  })

  it('targets a constrained autogrow member and output in both noodle directions', () => {
    const matchType = {
      kind: 'variable' as const,
      templateId: 'MatchType',
      allowedTypes: ['comfy.IMAGE', 'comfy.MASK', 'comfy.LATENT'].map((name) => ({ kind: 'concrete' as const, name })),
    }
    const batch: NodeSchema = {
      type: 'test.batch', displayName: 'Batch', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        {
          kind: 'input', id: 'values', type: matchType, optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [{ kind: 'input', id: 'value', type: matchType, optional: false }],
            naming: { kind: 'prefix', prefix: 'value', min: 1, max: 50 },
          },
        },
        { kind: 'output', id: 'value', type: matchType },
      ],
    }
    expect(linkDropInvocations({
      seeking: 'in', anchorType: { kind: 'concrete', name: 'comfy.MASK' }, anchorX: 0, anchorY: 0,
      fixedFrom: { node: 'source', port: 'mask' },
    }, 'g0', 'batch', batch)).toEqual([
      { command: 'dynamic.materialize', params: { graphId: 'g0', nodeId: 'batch', frames: [{ construct: 'values', members: ['m0'] }] } },
      { command: 'link.connect', params: { graphId: 'g0', from: { node: 'source', port: 'mask' }, to: { node: 'batch', port: 'values.value', members: ['m0'] } } },
    ])
    expect(linkDropInvocations({
      seeking: 'out', anchorType: { kind: 'concrete', name: 'comfy.LATENT' }, anchorX: 0, anchorY: 0,
      fixedInto: { node: 'sink', port: 'latent' },
    }, 'g0', 'batch', batch)).toEqual([
      { command: 'link.connect', params: { graphId: 'g0', from: { node: 'batch', port: 'value' }, to: { node: 'sink', port: 'latent' } } },
    ])
    expect(linkDropInvocations({
      seeking: 'in', anchorType: { kind: 'concrete', name: 'AUDIO' }, anchorX: 0, anchorY: 0,
      fixedFrom: { node: 'source', port: 'audio' },
    }, 'g0', 'batch', batch)).toEqual([])
  })

  it('excludes a schema whose only compatible port is outside the fresh dynamic branch', () => {
    const schema: NodeSchema = {
      type: 'test.branches', displayName: 'Branches', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
        dynamic: {
          kind: 'dynamicCombo',
          options: [
            { key: 'mask', inputs: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'comfy.MASK' }, optional: false }] },
            { key: 'image', inputs: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'comfy.IMAGE' }, optional: false }] },
          ],
        },
      }],
    }
    const entry = {
      type: schema.type, name: schema.displayName, category: schema.category,
      kind: 'node' as const, schema, fields: [],
    }
    expect(paletteEntryMatchesLinkDrop(entry, {
      seeking: 'in', anchorType: { kind: 'concrete', name: 'comfy.IMAGE' }, anchorX: 0, anchorY: 0,
      fixedFrom: { node: 'source', port: 'image' },
    })).toBe(false)
    expect(paletteEntryMatchesLinkDrop(entry, {
      seeking: 'in', anchorType: { kind: 'concrete', name: 'comfy.MASK' }, anchorX: 0, anchorY: 0,
      fixedFrom: { node: 'source', port: 'mask' },
    })).toBe(true)
  })
})
