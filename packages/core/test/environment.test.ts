/**
 * Environment stamping + drift diagnostics. The contract under test:
 * - the stamp is a RECORD, never identity: it never blocks loading, never
 *   joins the execution-semantic hash, and absence is fully valid
 * - sanitization is warn-and-drop: valid parts survive, malformed parts
 *   are named in ONE warning, and an empty husk is dropped entirely
 * - stamping is used-only on both axes (instantiated node types across
 *   ALL graph defs; packs attributing them) and returns undefined when no
 *   used type carries a signature (V1 backend) so callers preserve any
 *   existing stamp instead of overwriting it with an empty lie
 * - drift is advisory and precise: signature mismatch names the node type;
 *   a pack pin change with identical interfaces is info, not alarm
 */
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/diagnostics.js'
import type { EnvironmentStamp, GraphDef, WorkflowDocument } from '../src/format/document.js'
import { environmentDrift, stampEnvironment, type EnvironmentSource } from '../src/format/environment.js'
import { loadDocument } from '../src/format/migrate.js'
import { semanticHashOf } from '../src/compile/hash.js'
import { asGraphDefId, asLineageId, asNodeId } from '../src/ids.js'
import type { NodeSchema, PackInfo } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const schemaOf = (type: string, extra?: Partial<NodeSchema>): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [],
  ...extra,
})

const graph = (id: string, nodeTypes: Record<string, string>): GraphDef => ({
  id: asGraphDefId(id),
  name: id,
  nodes: Object.fromEntries(
    Object.entries(nodeTypes).map(([nid, type]) => [nid, { id: asNodeId(nid), type, values: {} }]),
  ),
  links: {},
  nets: {},
  reroutes: {},
  nextOrdinal: 100,
})

const doc = (graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('lin1'),
  root: asGraphDefId(root),
  graphs,
  view: { graphs: {} },
})

const schemas: Record<string, NodeSchema> = {
  'core.add': schemaOf('core.add', { pack: 'core', signature: 'sig-add-1' }),
  'vhs.load': schemaOf('vhs.load', { pack: 'vhs.video', signature: 'sig-load-1' }),
  'vhs.save': schemaOf('vhs.save', { pack: 'vhs.video', signature: 'sig-save-1' }),
  unattributed: schemaOf('unattributed', { signature: 'sig-orphan-1' }),
  'v1.legacy': schemaOf('v1.legacy'), // no signature: V1/incomparable
}

const packs = new Map<string, PackInfo>([
  ['core', { displayName: 'Dinkster Core', version: '1.2.0' }],
  [
    'vhs.video',
    {
      displayName: 'Video Helper Suite',
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
    },
  ],
])

const source: EnvironmentSource = {
  resolve: (type) => schemas[type],
  packs,
  server: { version: '0.9.0', schemaWire: 1 },
  frontendVersion: '0.1.0',
}

const warnings = (diags: readonly Diagnostic[]) => diags.filter((d) => d.severity === 'warning')
const errors = (diags: readonly Diagnostic[]) => diags.filter((d) => d.severity === 'error')
const codes = (diags: readonly Diagnostic[]) => diags.map((d) => d.code)

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------

describe('stampEnvironment', () => {
  it('stamps used node types with pack + signature and used packs with full provenance', () => {
    const d = doc({ g0: graph('g0', { n0: 'core.add', n1: 'vhs.load' }) })
    const stamp = stampEnvironment(d, source)!
    expect(stamp.nodes).toEqual({
      'core.add': { pack: 'core', signature: 'sig-add-1' },
      'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' },
    })
    expect(stamp.packs).toEqual({
      core: { version: '1.2.0' },
      'vhs.video': {
        version: '3.1.4',
        artifactDigest: 'sha256:' + 'a'.repeat(64),
        source: 'registry',
        publisher: 'kosinkadink',
      },
    })
    expect(stamp.dinkster).toEqual({ version: '0.9.0', schemaWire: 1 })
    expect(stamp.frontend).toEqual({ version: '0.1.0' })
  })

  it('collects used types across ALL graph defs, not just the root', () => {
    const d = doc({
      g0: graph('g0', { n0: 'core.add', sub: '#g1' }),
      g1: graph('g1', { n1: 'vhs.save' }),
    })
    const stamp = stampEnvironment(d, source)!
    expect(Object.keys(stamp.nodes).sort()).toEqual(['core.add', 'vhs.save'])
  })

  it('preserves used missing-pack provenance while refreshing live packs and dropping removed types', () => {
    const saved: WorkflowDocument = {
      ...doc({ g0: graph('g0', { n0: 'core.add', n1: 'missing.load' }) }),
      environment: {
        nodes: {
          'core.add': { pack: 'core', signature: 'old-core' },
          'missing.load': { pack: 'missing', signature: 'saved-missing' },
          'removed.load': { pack: 'removed', signature: 'saved-removed' },
        },
        packs: { core: { version: '0.1.0' }, missing: { version: '4.2.1', source: 'registry' }, removed: { version: '9.0.0' } },
      },
    }
    const before = JSON.stringify(saved)
    const stamp = stampEnvironment(saved, source)!
    expect(stamp.nodes).toEqual({
      'core.add': { pack: 'core', signature: 'sig-add-1' },
      'missing.load': { pack: 'missing', signature: 'saved-missing' },
    })
    expect(stamp.packs).toEqual({ core: { version: '1.2.0' }, missing: { version: '4.2.1', source: 'registry' } })
    expect(JSON.stringify(saved)).toBe(before)
    const unavailable = stampEnvironment(saved, { resolve: () => undefined })!
    expect(unavailable.packs).toEqual({ core: { version: '0.1.0' }, missing: { version: '4.2.1', source: 'registry' } })
    expect(Object.keys(unavailable.nodes)).toEqual(['core.add', 'missing.load'])
  })

  it('does not mutate the input document and never changes the semantic hash', () => {
    const d = doc({ g0: graph('g0', { n0: 'core.add' }) })
    const before = semanticHashOf(d)
    const stamp = stampEnvironment(d, source)!
    expect(d.environment).toBeUndefined()
    const stamped: WorkflowDocument = { ...d, environment: stamp }
    expect(semanticHashOf(stamped)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// loadDocument integration: never load-bearing
// ---------------------------------------------------------------------------

describe('loadDocument with environment stamps', () => {
  const baseJson = () =>
    JSON.parse(
      JSON.stringify({
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lin1',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: { n0: { id: 'n0', type: 'core.add', values: {} } },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 1,
          },
        },
        view: { graphs: {} },
      }),
    ) as Record<string, unknown>

  it('a valid stamp survives loading', () => {
    const json = baseJson()
    json['environment'] = {
      dinkster: { version: '0.9.0', schemaWire: 1 },
      packs: { core: { version: '1.2.0' } },
      nodes: { 'core.add': { pack: 'core', signature: 'sig-add-1' } },
    }
    const result = loadDocument(json)
    expect(errors(result.diagnostics)).toEqual([])
    expect(result.document?.environment?.nodes['core.add']?.signature).toBe('sig-add-1')
  })

  it('a malformed stamp warns and drops but NEVER blocks loading', () => {
    const json = baseJson()
    json['environment'] = 'garbage'
    const result = loadDocument(json)
    expect(errors(result.diagnostics)).toEqual([])
    expect(result.document).toBeDefined()
    expect(result.document?.environment).toBeUndefined()
    expect(codes(warnings(result.diagnostics))).toContain('env.stamp-malformed')
  })

  it('partially malformed stamps load with the valid parts kept', () => {
    const json = baseJson()
    json['environment'] = {
      nodes: { 'core.add': { signature: 'sig-add-1' }, broken: 17 },
    }
    const result = loadDocument(json)
    expect(errors(result.diagnostics)).toEqual([])
    expect(result.document?.environment?.nodes).toEqual({ 'core.add': { signature: 'sig-add-1' } })
    expect(codes(warnings(result.diagnostics))).toContain('env.stamp-malformed')
  })

})

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe('environmentDrift', () => {
  const stampOf = (
    nodes: EnvironmentStamp['nodes'],
    stampPacks: EnvironmentStamp['packs'] = {},
  ): EnvironmentStamp => ({ packs: stampPacks, nodes })

  it('identical environment: silent', () => {
    const stamp = stampOf(
      { 'core.add': { pack: 'core', signature: 'sig-add-1' } },
      { core: { version: '1.2.0' } },
    )
    expect(environmentDrift(stamp, source)).toEqual([])
  })

  it('signature mismatch names the node type precisely (env.node-drift, warning)', () => {
    const stamp = stampOf({
      'core.add': { pack: 'core', signature: 'sig-add-OLD' },
      'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' },
    })
    const out = environmentDrift(stamp, source)
    expect(codes(out)).toEqual(['env.node-drift'])
    expect(out[0]!.severity).toBe('warning')
    expect(out[0]!.message).toContain("'core.add'")
    expect(out[0]!.message).toContain("'core'")
  })

  it('a stamped type missing from the live backend surfaces env.node-missing', () => {
    const stamp = stampOf({ Gone: { pack: 'vhs.video', signature: 'x' } })
    const out = environmentDrift(stamp, source)
    expect(codes(out)).toEqual(['env.node-missing'])
    expect(out[0]!.severity).toBe('warning')
    expect(out[0]!.message).toContain("'Gone'")
  })

  it('pack pin changed but every used interface identical: info-level env.pack-updated, not alarm', () => {
    const stamp = stampOf(
      { 'vhs.load': { pack: 'vhs.video', signature: 'sig-load-1' } },
      { 'vhs.video': { version: '2.0.0', artifactDigest: 'sha256:' + 'b'.repeat(64) } },
    )
    const out = environmentDrift(stamp, source)
    expect(codes(out)).toEqual(['env.pack-updated'])
    expect(out[0]!.severity).toBe('info')
    expect(out[0]!.message).toContain('2.0.0')
    expect(out[0]!.message).toContain('3.1.4')
  })

  it('node findings suppress the pack-updated info for the same pack (no double reporting)', () => {
    const stamp = stampOf(
      { 'vhs.load': { pack: 'vhs.video', signature: 'sig-load-OLD' } },
      { 'vhs.video': { version: '2.0.0' } },
    )
    expect(codes(environmentDrift(stamp, source))).toEqual(['env.node-drift'])
  })

})
