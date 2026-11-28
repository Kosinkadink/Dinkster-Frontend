import { describe, expect, it } from 'vitest'
import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asPromptId,
  compile,
  solveGraphTypes,
  DinksterNormalizer,
  diag,
  type DiagnosticOrigin,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { outputRowKey } from '@dinkster/canvas'
import { ExecutionStore } from '@dinkster/client'
import { composeCanvasProblemDiagnostics, deriveNodeProblems, deriveProblemProjection, executionProblemDiagnostics, groupProblemDiagnostics, problemDisplay } from '../src/problem-display.js'
import { problemBoxLines } from '../src/problem-box.js'

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
  it('keeps coded run warnings on their occurrence through replay and log eviction without failing the run', () => {
    const doc = subgraphDocument()
    const compiled = compile({ document: { ...doc, graphs: { ...doc.graphs,
      inner: { ...doc.graphs.inner!, boundary: { body: [] } },
    } }, revision: 1, resolve: (type) => type === schema.type ? { ...schema,
      body: schema.body.map((row) => row.kind === 'input' ? { ...row, optional: true } : row),
    } : undefined, scope: { kind: 'partial', targets: [{ instancePath: [asNodeId('instance')], node: asNodeId('nested') }] },
      connection: asConnectionId('local'), schemaHash: 'test', graphFeatures: ['regions'] })
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true)
    if (!compiled.ok) throw new Error('compile failed')
    const store = new ExecutionStore()
    const normalizer = new DinksterNormalizer(asConnectionId('local'), () => 1)
    const execution = { connection: asConnectionId('local'), prompt: asPromptId('run') }
    const warning = { type: 'node_event', jobId: 'run', nodeId: 'instance.nested', event: 'log', seq: 1,
      data: { level: 'warning', code: 'unpack_count_mismatch', message: 'Expected 3 items; received 1' } }
    for (const event of normalizer.normalize(warning)) store.apply(event)
    for (const event of normalizer.normalize(warning)) store.apply(event)
    for (const event of normalizer.normalize({ ...warning, seq: 2,
      data: { ...warning.data, origin: 'stderr', message: 'Captured warning' } })) store.apply(event)
    for (const event of normalizer.normalize({ ...warning, seq: 3,
      data: { level: 'warning', message: 'Uncoded warning' } })) store.apply(event)
    store.apply({ kind: 'completed', execution, timestamp: 2 })
    store.register(execution, compiled.artifact)
    for (let seq = 4; seq < 2005; seq++) store.apply({ kind: 'log', execution, timestamp: 3,
      seq, level: 'info', message: 'Progress' })
    for (const event of normalizer.normalize({ ...warning, seq: 0,
      data: { ...warning.data, message: 'Old replay' } })) store.apply(event)
    const state = store.get(execution)!
    expect(state.status).toBe('completed')
    expect(state.errors).toEqual([])
    expect(state.logs.some((entry) => entry.code === 'unpack_count_mismatch')).toBe(false)
    const diagnostics = executionProblemDiagnostics(state)
    expect(diagnostics).toEqual([expect.objectContaining({ severity: 'warning',
      code: 'runtime.unpack_count_mismatch', message: 'Expected 3 items; received 1',
      anchor: { execution, occurrence: { instancePath: ['instance'], node: 'nested' } },
    })])
    const projection = deriveProblemProjection({ diagnostics, document: doc, graphId: 'inner', instancePath: ['instance'] })
    expect(projection.nodes.nested).toEqual([expect.objectContaining({ kind: 'warning' })])
    expect(deriveProblemProjection({ diagnostics, document: doc, graphId: 'g0', instancePath: [] }).nodes.nested).toBeUndefined()
  })

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

  it('keeps a solver sentence already named for the reader without adding ids or a second title', () => {
    const d = diag('warning', 'schema', 'solve.linkMismatch', 'My sampler: Model input needs MODEL, but Load image sends an image.', {
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'model', direction: 'input' }],
      data: { nodeMessage: 'Model input needs MODEL, but Load image sends an image.' },
    })
    expect(problemDisplay(d, document('My sampler'), registry)).toBe(d.message)
    const ordinary = diag('error', 'validation', 'field.invalid', 'Model is missing.', { refs: d.refs!, data: { nodeMessage: 3 } })
    const projection = deriveProblemProjection({ diagnostics: [d, ordinary], graphId: 'g0', instancePath: [] })
    expect(deriveProblemProjection({ diagnostics: [d], graphId: 'g0', instancePath: [] }).rows)
      .toEqual({ 'n5-a1b2': { model: 'warning' } })
    const lines = problemBoxLines(projection.nodes['n5-a1b2']!, [{ key: 'model', name: 'Model input', field: true }], (row) => row,
      (line) => problemDisplay(line.diagnostic, document('My sampler'), registry))
    expect(lines).toMatchObject([
      { kind: 'error', row: 'model', rowName: 'Model input', message: problemDisplay(ordinary, document('My sampler'), registry), actions: ['edit-field'] },
      { kind: 'warning', row: 'model', message: d.data!['nodeMessage'], actions: ['edit-field'] },
    ])
    expect(lines[1]?.rowName).toBeUndefined()
  })

})

describe('groupProblemDiagnostics', () => {
  it.each([false, true])('shows one selected-type cause on both surfaces, reversed=%s', (reversed) => {
    const refs = [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'model', direction: 'input' as const }]
    const data = { sourceNode: 'producer', sourcePort: 'latent' }
    const mismatch = diag('warning', 'schema', 'solve.linkMismatch', 'Choose model: Source needs an image, but Load latent sends latent data.', {
      refs, data: { ...data, nodeMessage: 'Source needs an image, but Load latent sends latent data.' },
    })
    const selected = diag('warning', 'schema', 'solve.slot.staleSpecialization', 'Choose model: Source is set to image, but Load latent sends latent data.', {
      refs, data: { ...data, nodeMessage: 'Source is set to image, but Load latent sends latent data.' },
    })
    const diagnostics = reversed ? [selected, mismatch] : [mismatch, selected]
    expect(groupProblemDiagnostics(diagnostics)[0]?.diagnostics).toEqual([selected])
    const projection = deriveProblemProjection({ diagnostics, graphId: 'g0', instancePath: [] })
    expect(projection.nodes['n5-a1b2']).toEqual([{ kind: 'warning', row: 'model', diagnostic: selected }])
    expect(projection.rows).toEqual({ 'n5-a1b2': { model: 'warning' } })
    expect(problemBoxLines(projection.nodes['n5-a1b2']!, [{ key: 'model', name: 'source', field: true }], (row) => row))
      .toMatchObject([{ row: 'model', message: selected.data!['nodeMessage'], actions: ['edit-field'], problem: { diagnostic: selected } }])
    expect(diagnostics).toHaveLength(2)
    for (const other of [
      { ...mismatch, data: { ...mismatch.data, sourceNode: 'other' } },
      { ...mismatch, data: { ...mismatch.data, sourcePort: 'other' } },
      { ...mismatch, refs: [{ ...refs[0]!, portId: 'other' }] },
      { ...mismatch, refs: [{ ...refs[0]!, graphId: 'other' }] },
      { ...mismatch, anchor: { occurrence: { node: asNodeId('n5-a1b2'), instancePath: [asNodeId('other')] } } },
      { ...mismatch, severity: 'error' as const },
    ]) expect(groupProblemDiagnostics([other, selected])[0]?.diagnostics).toEqual([other, selected])
  })

  it('maps every origin to the four ordered user actions, including information notices', () => {
    const expected = {
      runtime: 'execution', validation: 'execution',
      compile: 'workflow', invariant: 'workflow', environment: 'workflow',
      import: 'workflow', schema: 'packs', extension: 'packs', command: 'packs', collab: 'collaboration',
    } satisfies Record<DiagnosticOrigin, string>
    const origins = Object.keys(expected) as DiagnosticOrigin[]
    for (const origin of origins) {
      expect(groupProblemDiagnostics([diag('info', origin, 'test', 'Notice')])[0]?.title).toBe(expected[origin])
    }
    const groups = groupProblemDiagnostics(origins.reverse().map((origin) => diag('info', origin, origin, 'Notice')))
    expect(groups.map((group) => group.title)).toEqual(['execution', 'workflow', 'packs', 'collaboration'])
    expect(groups.every((group) => group.severity === 'info')).toBe(true)
    expect(groupProblemDiagnostics([])).toEqual([])
  })

  it('lists type check problems under this workflow, where their wires are fixed', () => {
    const groups = groupProblemDiagnostics([
      diag('error', 'schema', 'solve.varConflict', 'These inputs must be the same type: a is INT, b is STRING.'),
      diag('warning', 'schema', 'solve.linkMismatch', 'a.b: INT cannot feed STRING'),
      diag('warning', 'schema', 'schema.unresolvedType', 'EmptyImage: not available on backend Local'),
    ])
    expect(groups.map((group) => [group.title, group.diagnostics.map((d) => d.code)])).toEqual([
      ['workflow', ['solve.varConflict', 'solve.linkMismatch']],
      ['packs', ['schema.unresolvedType']],
    ])
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

  it('shows one type conflict before and after Run without merging other nodes or occurrences', () => {
    const variable = { kind: 'variable', templateId: 'T' } as const
    const schemas: Record<string, NodeSchema> = {
      Pair: { ...schema, type: 'Pair', displayName: 'Pair', isOutputNode: true, body: [
        { kind: 'input', id: 'first', type: variable, optional: false },
        { kind: 'input', id: 'second', type: variable, optional: false },
      ] },
      Image: { ...schema, type: 'Image', body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'IMAGE' } }] },
      Latent: { ...schema, type: 'Latent', body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'LATENT' } }] },
    }
    const doc = document()
    const graph = doc.graphs.g0!
    const pairs = ['n5-a1b2', 'n6-c3d4']
    const nodes: typeof graph.nodes = Object.fromEntries([
      ...pairs.map((id) => [id, { id: asNodeId(id), type: 'Pair', values: {} }]),
      ['image', { id: asNodeId('image'), type: 'Image', values: {} }],
      ['latent', { id: asNodeId('latent'), type: 'Latent', values: {} }],
    ])
    const links: typeof graph.links = Object.fromEntries(pairs.flatMap((node) => ['first', 'second'].map((port) => {
      const id = asLinkId(`${node}-${port}`)
      return [id, { id, from: { kind: 'port' as const, node: asNodeId(port === 'first' ? 'image' : 'latent'), port: asPortId('out') },
        to: { kind: 'port' as const, node: asNodeId(node), port: asPortId(port) } }]
    })))
    const workflow: WorkflowDocument = { ...doc, graphs: { g0: { ...graph, nodes, links } } }
    const resolve = (type: string) => schemas[type]
    const editing = solveGraphTypes(workflow.graphs.g0!, resolve).diagnostics
    const result = compile({ document: workflow, revision: 1, resolve,
      scope: { kind: 'partial', targets: pairs.map((node) => ({ instancePath: [], node: asNodeId(node) })) },
      connection: asConnectionId('local'), schemaHash: 'test', graphFeatures: ['regions', 'typedLiteral'] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('Run should be refused')
    expect(result.diagnostics.filter((entry) => entry.code === 'compile.typeVariableConflict')).toHaveLength(2)
    for (const diagnostics of [editing, [...editing, ...result.diagnostics], [...result.diagnostics, ...editing]]) {
      expect(groupProblemDiagnostics(diagnostics, workflow).flatMap((group) => group.diagnostics)).toHaveLength(2)
      const projection = deriveProblemProjection({ diagnostics, document: workflow, graphId: 'g0', instancePath: [] })
      for (const node of pairs) {
        expect(projection.nodes[node]).toHaveLength(1)
        expect(projection.rows[node]).toEqual({ second: 'error' })
        const lines = problemBoxLines(projection.nodes[node]!, [{ key: 'second', name: 'second', field: false }], (row) => row,
          (line) => problemDisplay(line.diagnostic, workflow, { resolve }))
        expect(lines).toMatchObject([{ message: 'The inputs must be the same type, but the input first is an image and the input second is latent data.' }])
        expect(lines[0]?.rowName).toBeUndefined()
        expect(problemDisplay(projection.nodes[node]![0]!.diagnostic, workflow, { resolve })).toContain('Pair:')
      }
    }
    const first = result.diagnostics.find((entry) => entry.code === 'compile.typeVariableConflict')!
    const repeatedInstance = { ...first, anchor: { ...first.anchor, occurrence: { ...first.anchor!.occurrence!, instancePath: [asNodeId('instance')] } } }
    expect(groupProblemDiagnostics([first, repeatedInstance], workflow).flatMap((group) => group.diagnostics)).toHaveLength(2)
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
    expect(groupProblemDiagnostics([fromEditor, fromCompile, otherRule], document()).flatMap((group) => group.diagnostics)).toHaveLength(2)
  })

  it('lists an automatic default passed on to another node once, by the warning that names that node', () => {
    const port = (node: string, input: string) => ({ node: asNodeId(node), port: asPortId(input) })
    const own = (node: string) => diag('warning', 'schema', 'automatic.default', 'Could not work out frame rate. Using the default, 24.', {
      anchor: { port: port(node, 'frame_rate') }, data: { input: 'frame_rate' },
    })
    const passedOn = diag('warning', 'compile', 'automatic.tapDefault', 'Could not work out frame rate. Retime 2 gets the default, 24.', {
      anchor: { occurrence: { instancePath: [], node: asNodeId('n5-a1b2') }, port: port('n5-a1b2', 'frame_rate') },
      refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', valueKey: 'frame_rate', direction: 'input' }],
      data: { input: 'frame_rate' },
    })
    const lines = composeCanvasProblemDiagnostics({ owned: [passedOn], scene: [own('n5-a1b2'), own('other')] })
    expect(lines.map((d) => [d.code, d.anchor?.port?.node])).toEqual([
      ['automatic.tapDefault', 'n5-a1b2'],
      ['automatic.default', 'other'],
    ])
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
    const selection = diag('warning', 'schema', 'record-field-removed', "Record field 'seed' was removed.", {
      anchor: { port: { node: asNodeId('n5-a1b2'), port: asPortId('field') } }, data: { input: 'field' },
    })
    const projection = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [], diagnostics: [viaRef, viaAnchor, onInput, selection],
      portSideOf: (_node, port) => port === 'latent' || port === 'field' ? 'output' : 'input',
    })
    expect(projection.rows).toEqual({
      'n5-a1b2': { [outputRowKey('image')]: 'warning', [outputRowKey('latent')]: 'warning', image: 'error', field: 'warning' },
    })
    expect(problemBoxLines(projection.nodes['n5-a1b2']!, [{ key: 'field', name: 'Field', field: true }], (row) => row))
      .toContainEqual(expect.objectContaining({ row: 'field', actions: ['edit-field'], problem: { kind: 'warning', row: 'field', diagnostic: selection } }))
    const nested = deriveProblemProjection({
      document: document(), graphId: 'g0', instancePath: [], diagnostics: [{ ...selection,
        refs: [{ graphId: 'g0', nodeId: 'n5-a1b2', portId: 'field', valueKey: '$record/field/1', direction: 'input' }],
      }],
    })
    expect(nested.rows).toEqual({ 'n5-a1b2': { '$record/field/1': 'warning' } })
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
