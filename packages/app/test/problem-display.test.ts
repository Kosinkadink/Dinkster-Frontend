import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asNodeId,
  asPortId,
  diag,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { composeCanvasProblemDiagnostics, deriveNodeProblems, deriveProblemProjection, groupProblemDiagnostics, problemDisplay } from '../src/problem-display.js'

const schema: NodeSchema = {
  type: 'Sampler',
  displayName: 'KSampler',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'model', displayName: 'Model input', type: { kind: 'concrete', name: 'MODEL' }, optional: false },
    { kind: 'output', id: 'image', displayName: 'Generated image', type: { kind: 'concrete', name: 'IMAGE' } },
  ],
}

const document = (title?: string, lineage = 'lineage'): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId(lineage),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'), name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      nodes: {
        'n5-a1b2': { id: asNodeId('n5-a1b2'), type: 'Sampler', values: {}, ...(title === undefined ? {} : { title }) },
        'n6-c3d4': { id: asNodeId('n6-c3d4'), type: 'Sampler', title: 'Other sampler', values: {} },
      },
    },
  },
  view: { graphs: {} },
})

const subgraphDocument = (): WorkflowDocument => {
  const base = document('Root sampler')
  return {
    ...base,
    graphs: {
      ...base.graphs,
      g0: {
        ...base.graphs.g0!,
        nodes: {
          ...base.graphs.g0!.nodes,
          instance: { id: asNodeId('instance'), type: '#inner', values: {} },
          nested: { id: asNodeId('nested'), type: 'Sampler', title: 'Root duplicate', values: {} },
        },
      },
      inner: {
        id: asGraphDefId('inner'), name: 'inner', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        nodes: {
          nested: { id: asNodeId('nested'), type: 'Sampler', title: 'Nested sampler', values: {} },
        },
      },
    },
  }
}

const registry = { resolve: (type: string) => type === 'Sampler' ? schema : undefined }
const diagnostic = (refs?: Parameters<typeof diag>[4]) =>
  diag('error', 'command', 'link.connect', "link.connect: unknown port 'model'", refs)

describe('problemDisplay', () => {
  it('prefers a user title while preserving actor-suffixed raw ids', () => {
    const d = diagnostic({ refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }] })
    expect(problemDisplay(d, document('My sampler'), registry)).toBe(
      `Node "My sampler" (n5-a1b2): link.connect: unknown port 'model'`,
    )
  })

  it('falls back to the schema display name', () => {
    const d = diagnostic({ refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }] })
    expect(problemDisplay(d, document(), registry)).toContain('Node "KSampler" (n5-a1b2)')
  })

  it('resolves input and output display labels while retaining port ids', () => {
    const d = diagnostic({ refs: [
      { graphId: 'g0', nodeId: 'n5-a1b2', portId: 'model', direction: 'input' },
      { graphId: 'g0', nodeId: 'n5-a1b2', portId: 'image', direction: 'output' },
    ] })
    const shown = problemDisplay(d, document(), registry)
    expect(shown).toContain('input "Model input" (model)')
    expect(shown).toContain('output "Generated image" (image)')
  })

  it('returns the verbatim message when refs are absent', () => {
    const d = diagnostic()
    expect(problemDisplay(d, document(), registry)).toBe(d.message)
  })
})

describe('groupProblemDiagnostics', () => {
  it('groups by primary node ref and computes each group maximum severity', () => {
    const first = diag('info', 'command', 'first', 'first', { refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }] })
    const second = diag('error', 'command', 'second', 'second', { refs: [
      { graphId: 'g0', nodeId: 'n5-a1b2', portId: 'model' },
      { graphId: 'g0', nodeId: 'n6-c3d4' },
    ] })
    const groups = groupProblemDiagnostics([first, second], document('My sampler'), registry)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBe('Node "My sampler" (n5-a1b2)')
    expect(groups[0]?.severity).toBe('error')
    expect(groups[0]?.diagnostics).toEqual([first, second])
  })

  it('retains first-appearance node order and puts unanchored diagnostics in General last', () => {
    const generalFirst = diag('warning', 'command', 'general', 'general')
    const other = diag('info', 'command', 'other', 'other', { refs: [{ graphId: 'g0', nodeId: 'n6-c3d4' }] })
    const first = diag('warning', 'command', 'first', 'first', { refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }] })
    const otherAgain = diag('error', 'command', 'other-again', 'other again', { refs: [{ graphId: 'g0', nodeId: 'n6-c3d4' }] })
    const groups = groupProblemDiagnostics([generalFirst, other, first, otherAgain], document('My sampler'), registry)

    expect(groups.map((group) => group.title)).toEqual([
      'Node "Other sampler" (n6-c3d4)',
      'Node "My sampler" (n5-a1b2)',
      'General',
    ])
    expect(groups.map((group) => group.diagnostics.map((entry) => entry.code))).toEqual([
      ['other', 'other-again'],
      ['first'],
      ['general'],
    ])
    expect(groups.map((group) => group.severity)).toEqual(['error', 'warning', 'warning'])
  })

  it('scopes identical node and General keys to document lineage', () => {
    const anchored = diag('error', 'command', 'anchored', 'anchored', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }],
    })
    const general = diag('info', 'command', 'general', 'general')
    const first = groupProblemDiagnostics([anchored, general], document(undefined, 'lineage-a'), registry)
    const second = groupProblemDiagnostics([anchored, general], document(undefined, 'lineage-b'), registry)

    expect(first.map((group) => group.key)).toEqual([
      JSON.stringify(['node', 'lineage-a', 'g0', 'n5-a1b2']),
      JSON.stringify(['general', 'lineage-a']),
    ])
    expect(second.map((group) => group.key)).toEqual([
      JSON.stringify(['node', 'lineage-b', 'g0', 'n5-a1b2']),
      JSON.stringify(['general', 'lineage-b']),
    ])
    expect(second.map((group) => group.key)).not.toEqual(first.map((group) => group.key))
  })

  it('groups anchor-only missing inputs under the friendly node title', () => {
    const missing = diag('warning', 'compile', 'compile.input.missing', "'Sampler' required input 'model' has no value or connection", {
      blocksExecution: true,
      anchor: {
        occurrence: { instancePath: [], node: asNodeId('n5-a1b2') },
        port: { node: asNodeId('n5-a1b2'), port: asPortId('model') },
      },
    })
    const groups = groupProblemDiagnostics([missing], document('My sampler'), registry)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBe('Node "My sampler" (n5-a1b2)')
    expect(groups[0]?.key).toBe(JSON.stringify(['node', 'lineage', 'g0', 'n5-a1b2']))
    expect(groups[0]?.diagnostics).toEqual([missing])
  })

  it('coalesces ref-based and anchor-only diagnostics for the same node', () => {
    const referenced = diag('error', 'validation', 'validation.node', 'invalid', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }],
    })
    const anchored = diag('warning', 'compile', 'compile.input.missing', 'missing', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') } },
    })
    const groups = groupProblemDiagnostics([referenced, anchored], document(), registry)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.diagnostics).toEqual([referenced, anchored])
    expect(groups[0]?.severity).toBe('error')
  })

  it('resolves occurrence paths to the anchored node in its subgraph', () => {
    const anchored = diag('error', 'runtime', 'runtime.validation', 'invalid at runtime', {
      anchor: { occurrence: { instancePath: [asNodeId('instance')], node: asNodeId('nested') } },
    })
    const groups = groupProblemDiagnostics([anchored], subgraphDocument(), registry)

    expect(groups[0]?.title).toBe('Node "Nested sampler" (nested)')
    expect(groups[0]?.key).toBe(JSON.stringify(['node', 'lineage', 'inner', 'nested']))
  })

  it('qualifies port-only anchors with the active graph instead of scanning duplicate node ids', () => {
    const portOnly = diag('warning', 'schema', 'port.warning', 'warning', {
      anchor: { port: { node: asNodeId('nested'), port: asPortId('model') } },
    })
    const groups = groupProblemDiagnostics(
      [portOnly], subgraphDocument(), registry, { graphId: 'inner' },
    )

    expect(groups[0]?.title).toBe('Node "Nested sampler" (nested)')
    expect(groups[0]?.key).toBe(JSON.stringify(['node', 'lineage', 'inner', 'nested']))
  })

  it('keeps a structured ref primary when its occurrence anchor identifies another node', () => {
    const conflicted = diag('error', 'validation', 'validation.node', 'invalid', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }],
      anchor: { occurrence: { instancePath: [asNodeId('instance')], node: asNodeId('nested') } },
    })
    const groups = groupProblemDiagnostics([conflicted], subgraphDocument(), registry)

    expect(groups[0]?.title).toBe('Node "Root sampler" (n5-a1b2)')
    expect(groups[0]?.key).toBe(JSON.stringify(['node', 'lineage', 'g0', 'n5-a1b2']))
  })

  it('falls back to General for a stale occurrence anchor', () => {
    const stale = diag('warning', 'compile', 'compile.input.missing', 'missing', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('gone') } },
    })

    expect(groupProblemDiagnostics([stale], document(), registry).map((group) => group.title)).toEqual(['General'])
  })
})

describe('deriveNodeProblems', () => {
  it('groups errors, blocking warnings, and advisory warnings separately by node', () => {
    const refs = [{ graphId: 'g0', nodeId: 'n5-a1b2', direction: 'input' as const }]
    const models = deriveNodeProblems({
      document: document(),
      graphId: 'g0',
      instancePath: [],
      diagnostics: [
        diag('error', 'compile', 'compile.bad', 'bad', { refs }),
        diag('warning', 'compile', 'compile.input.missing', 'missing', { refs, blocksExecution: true }),
        diag('warning', 'schema', 'widget.COMBO.unknown', 'advisory', { refs }),
      ],
    })
    expect(models['n5-a1b2']?.map((model) => [model.kind, model.diagnostics.map((d) => d.code)])).toEqual([
      ['error', ['compile.bad']],
      ['blocking-warning', ['compile.input.missing']],
      ['warning', ['widget.COMBO.unknown']],
    ])
  })

  it('uses exact occurrence paths, filters other graphs and info, and deduplicates ref plus anchor', () => {
    const anchored = diag('warning', 'compile', 'compile.input.missing', 'missing', {
      blocksExecution: true,
      refs: [{ graphId: 'g0', nodeId: 'inner' }],
      anchor: { occurrence: { instancePath: [asNodeId('sub')], node: asNodeId('inner') } },
    })
    const models = deriveNodeProblems({
      document: document(),
      graphId: 'g0',
      instancePath: ['sub'],
      diagnostics: [
        anchored,
        diag('warning', 'schema', 'other.graph', 'elsewhere', { refs: [{ graphId: 'g1', nodeId: 'inner' }] }),
        diag('info', 'schema', 'advisory.info', 'quiet', { refs: [{ graphId: 'g0', nodeId: 'inner' }] }),
      ],
    })
    expect(models['inner']).toHaveLength(1)
    expect(models['inner']![0]!.diagnostics).toEqual([anchored])
    const { refs: _refs, ...anchorOnly } = anchored
    expect(deriveNodeProblems({ graphId: 'g0', instancePath: [], diagnostics: [anchorOnly] })).toEqual({})
  })

  it('keeps graph-less refs display-only because node ids are graph-local', () => {
    const graphless = diag('warning', 'schema', 'widget.INT.aboveMax', 'too large', {
      refs: [{ nodeId: 'n5-a1b2', portId: 'model', direction: 'input' }],
    })
    expect(deriveNodeProblems({ graphId: 'g0', instancePath: [], diagnostics: [graphless] })).toEqual({})
    expect(problemDisplay(graphless, document(), registry)).toContain('Node "KSampler" (n5-a1b2)')
  })

  it('projects an occurrence-only badge only into its exact subgraph instance', () => {
    const anchored = diag('warning', 'compile', 'compile.input.missing', 'missing', {
      blocksExecution: true,
      anchor: { occurrence: { instancePath: [asNodeId('instance')], node: asNodeId('nested') } },
    })
    const doc = subgraphDocument()

    expect(deriveNodeProblems({
      document: doc, graphId: 'inner', instancePath: ['instance'], diagnostics: [anchored],
    })['nested']?.[0]?.diagnostics).toEqual([anchored])
    expect(deriveNodeProblems({
      document: doc, graphId: 'g0', instancePath: [], diagnostics: [anchored],
    })).toEqual({})
    expect(deriveNodeProblems({
      document: doc, graphId: 'inner', instancePath: ['other-instance'], diagnostics: [anchored],
    })).toEqual({})
  })

  it('projects a port anchor to its exact input pin id and rejects wrong-graph occurrences', () => {
    const exact = diag('warning', 'compile', 'compile.input.missing', 'missing', {
      blocksExecution: true,
      anchor: {
        occurrence: { instancePath: [asNodeId('instance')], node: asNodeId('nested') },
        port: { node: asNodeId('nested'), port: asPortId('model') },
      },
    })
    const doc = subgraphDocument()

    expect(deriveProblemProjection({
      document: doc, graphId: 'inner', instancePath: ['instance'], diagnostics: [exact],
    }).ports).toEqual({ nested: { model: 'blocking-warning' } })
    expect(deriveProblemProjection({
      document: doc, graphId: 'g0', instancePath: [], diagnostics: [exact],
    }).ports).toEqual({})
    expect(deriveProblemProjection({
      document: doc, graphId: 'inner', instancePath: ['other-instance'], diagnostics: [exact],
    }).ports).toEqual({})
  })

  it('keeps a compile warning and runtime validation error on the same node in grouping and projection', () => {
    const warning = diag('warning', 'compile', 'compile.input.missing', 'missing model', {
      blocksExecution: true,
      anchor: {
        occurrence: { instancePath: [], node: asNodeId('n5-a1b2') },
        port: { node: asNodeId('n5-a1b2'), port: asPortId('model') },
      },
    })
    const runtime = diag('error', 'validation', 'validation.bad-input', 'bad model', {
      anchor: {
        occurrence: { instancePath: [], node: asNodeId('n5-a1b2') },
        port: { node: asNodeId('n5-a1b2'), port: asPortId('model') },
      },
    })
    const diagnostics = composeCanvasProblemDiagnostics({ owned: [warning], scene: [], execution: [runtime] })
    const groups = groupProblemDiagnostics(diagnostics, document(), registry)
    const projection = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [], diagnostics,
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.diagnostics).toEqual(diagnostics)
    expect(groups[0]?.severity).toBe('error')
    expect(projection.nodes['n5-a1b2']?.map((model) => model.kind)).toEqual(['error', 'blocking-warning'])
    expect(projection.ports['n5-a1b2']?.['model']).toBe('error')
  })

  it('keeps a compile warning and runtime validation error on different nodes in grouping and projection', () => {
    const warning = diag('warning', 'compile', 'compile.input.missing', 'missing model', {
      blocksExecution: true,
      anchor: {
        occurrence: { instancePath: [], node: asNodeId('n5-a1b2') },
        port: { node: asNodeId('n5-a1b2'), port: asPortId('model') },
      },
    })
    const runtime = diag('error', 'validation', 'validation.bad-input', 'bad model', {
      anchor: {
        occurrence: { instancePath: [], node: asNodeId('n6-c3d4') },
        port: { node: asNodeId('n6-c3d4'), port: asPortId('model') },
      },
    })
    const diagnostics = composeCanvasProblemDiagnostics({ owned: [warning], scene: [], execution: [runtime] })
    const groups = groupProblemDiagnostics(diagnostics, document(), registry)
    const projection = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [], diagnostics,
    })

    expect(groups.map((group) => group.diagnostics)).toEqual([[warning], [runtime]])
    expect(projection.nodes['n5-a1b2']?.[0]?.diagnostics).toEqual([warning])
    expect(projection.nodes['n6-c3d4']?.[0]?.diagnostics).toEqual([runtime])
    expect(projection.ports).toEqual({
      'n5-a1b2': { model: 'blocking-warning' },
      'n6-c3d4': { model: 'error' },
    })
  })
})
