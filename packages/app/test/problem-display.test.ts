import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asNodeId,
  asPortId,
  diag,
  type DiagnosticOrigin,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { outputRowKey } from '@dinkster/canvas'
import { composeCanvasProblemDiagnostics, deriveNodeProblems, deriveProblemProjection, groupProblemDiagnostics, problemDisplay } from '../src/problem-display.js'

const schema: NodeSchema = {
  type: 'Sampler',
  displayName: 'KSampler',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: [
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

})

describe('groupProblemDiagnostics', () => {
  it('maps every origin to the five ordered user actions, including information notices', () => {
    const expected = {
      runtime: 'execution', validation: 'execution',
      compile: 'workflow', invariant: 'workflow', environment: 'workflow',
      import: 'upgrade', schema: 'packs', extension: 'packs', command: 'packs', collab: 'collaboration',
    } satisfies Record<DiagnosticOrigin, string>
    const origins = Object.keys(expected) as DiagnosticOrigin[]
    for (const origin of origins) {
      expect(groupProblemDiagnostics([diag('info', origin, 'test', 'Notice')])[0]?.title).toBe(expected[origin])
    }
    const groups = groupProblemDiagnostics(origins.reverse().map((origin) => diag('info', origin, origin, 'Notice')))
    expect(groups.map((group) => group.title)).toEqual(['execution', 'workflow', 'upgrade', 'packs', 'collaboration'])
    expect(groups.every((group) => group.severity === 'info')).toBe(true)
    expect(groupProblemDiagnostics([])).toEqual([])
  })

  it('groups command diagnostics in Packs and backend and computes maximum severity', () => {
    const first = diag('info', 'command', 'first', 'first', { refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }] })
    const second = diag('error', 'command', 'second', 'second', { refs: [
      { graphId: 'g0', nodeId: 'n5-a1b2', portId: 'model' },
      { graphId: 'g0', nodeId: 'n6-c3d4' },
    ] })
    const groups = groupProblemDiagnostics([first, second], document('My sampler'))

    expect(groups).toHaveLength(1)
    expect(groups[0]?.title).toBe('packs')
    expect(groups[0]?.severity).toBe('error')
    expect(groups[0]?.diagnostics).toEqual([first, second])
  })

  it('separates execution and workflow diagnostics even for the same node', () => {
    const referenced = diag('error', 'validation', 'validation.node', 'invalid', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }],
    })
    const anchored = diag('warning', 'compile', 'compile.input.missing', 'missing', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') } },
    })
    const groups = groupProblemDiagnostics([referenced, anchored], document())

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.diagnostics)).toEqual([[referenced], [anchored]])
    expect(groups[0]?.severity).toBe('error')
  })

})

describe('deriveNodeProblems', () => {
  it('makes a problem that stops a run an error and lists errors before warnings', () => {
    const refs = [{ graphId: 'g0', nodeId: 'n5-a1b2', direction: 'input' as const }]
    const models = deriveNodeProblems({
      document: document(),
      graphId: 'g0',
      instancePath: [],
      diagnostics: [
        diag('warning', 'schema', 'widget.COMBO.unknown', 'advisory', { refs }),
        diag('error', 'compile', 'compile.bad', 'bad', { refs }),
        diag('warning', 'compile', 'compile.input.missing', 'missing', { refs, blocksExecution: true }),
      ],
    })
    expect(models['n5-a1b2']?.map((line) => [line.kind, line.diagnostic.code])).toEqual([
      ['error', 'compile.bad'],
      ['error', 'compile.input.missing'],
      ['warning', 'widget.COMBO.unknown'],
    ])
  })

  it('gives two causes on one row two lines and counts a cause reported twice once', () => {
    const tooSmall = diag('warning', 'schema', 'widget.INT.belowMin', 'too small', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'width', valueKey: 'width', direction: 'input' }],
    })
    const required = diag('warning', 'compile', 'compile.input.missing', 'required', {
      blocksExecution: true,
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') }, port: { node: asNodeId('n5-a1b2'), port: asPortId('width') } },
    })
    const other = diag('warning', 'schema', 'widget.INT.aboveMax', 'too large', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'steps', valueKey: 'steps', direction: 'input' }],
    })
    const projection = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [],
      diagnostics: composeCanvasProblemDiagnostics({ owned: [required], scene: [tooSmall, other, { ...tooSmall }] }),
    })
    expect(projection.nodes['n5-a1b2']?.map((line) => [line.row, line.kind, line.diagnostic.code])).toEqual([
      ['width', 'error', 'compile.input.missing'],
      ['width', 'warning', 'widget.INT.belowMin'],
      ['steps', 'warning', 'widget.INT.aboveMax'],
    ])
    expect(projection.rows).toEqual({ 'n5-a1b2': { width: 'error', steps: 'warning' } })
  })

  it('counts a failed node rule once when the editor and compile both report it', () => {
    const fromEditor = diag('error', 'compile', 'node.rule.failed', 'Width must be positive.', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'width', valueKey: 'width', direction: 'input' }],
      data: { rule: 0, hasFix: false, fields: ['width'] },
    })
    const fromCompile = diag('error', 'compile', 'node.rule.failed', '[n5-a1b2] Width must be positive.', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') }, port: { node: asNodeId('n5-a1b2'), port: asPortId('width') } },
      data: { rule: 0, hasFix: false, fields: ['width'] },
    })
    const otherRule = diag('error', 'compile', 'node.rule.failed', 'Width must be positive.', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2' }],
      data: { rule: 1, hasFix: false, fields: ['width', 'height'] },
    })
    const lines = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [],
      diagnostics: composeCanvasProblemDiagnostics({ owned: [fromCompile], scene: [fromEditor, otherRule] }),
    }).nodes['n5-a1b2']
    expect(lines?.map((line) => [line.row, line.diagnostic.data?.['rule']])).toEqual([['width', 0], [undefined, 1]])
  })

  it('puts a problem on an output on the output row, apart from an input with the same id', () => {
    const viaRef = diag('warning', 'compile', 'out.ref', 'unused output', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'image', direction: 'output' }],
    })
    const viaAnchor = diag('warning', 'compile', 'out.anchor', 'stale output', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') }, port: { node: asNodeId('n5-a1b2'), port: asPortId('latent') } },
    })
    const onInput = diag('error', 'compile', 'in.anchor', 'missing image', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') }, port: { node: asNodeId('n5-a1b2'), port: asPortId('image') } },
    })
    const projection = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [], diagnostics: [viaRef, viaAnchor, onInput],
      portSideOf: (_node, port) => port === 'latent' ? 'output' : 'input',
    })
    expect(projection.rows).toEqual({
      'n5-a1b2': { [outputRowKey('image')]: 'warning', [outputRowKey('latent')]: 'warning', image: 'error' },
    })
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
    expect(models['inner']![0]!.diagnostic).toEqual(anchored)
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
    })['nested']?.[0]?.diagnostic).toEqual(anchored)
    expect(deriveNodeProblems({
      document: doc, graphId: 'g0', instancePath: [], diagnostics: [anchored],
    })).toEqual({})
    expect(deriveNodeProblems({
      document: doc, graphId: 'inner', instancePath: ['other-instance'], diagnostics: [anchored],
    })).toEqual({})
  })

  it('projects a port anchor to its exact input row and rejects wrong-graph occurrences', () => {
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
    }).rows).toEqual({ nested: { model: 'error' } })
    expect(deriveProblemProjection({
      document: doc, graphId: 'g0', instancePath: [], diagnostics: [exact],
    }).rows).toEqual({})
    expect(deriveProblemProjection({
      document: doc, graphId: 'inner', instancePath: ['other-instance'], diagnostics: [exact],
    }).rows).toEqual({})
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
    const groups = groupProblemDiagnostics(diagnostics, document())
    const projection = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [], diagnostics,
    })

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.diagnostics)).toEqual([[runtime], [warning]])
    expect(groups[0]?.severity).toBe('error')
    expect(projection.nodes['n5-a1b2']?.map((line) => line.diagnostic)).toEqual([warning, runtime])
    expect(projection.rows['n5-a1b2']?.['model']).toBe('error')
  })

})
