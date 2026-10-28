/**
 * Environment stamping orchestration: exportDocument writes a FRESH stamp
 * from the tab's live registry (used packs + used node-type signatures);
 * frozen tabs export their snapshot verbatim; an unstamped/absent registry
 * PRESERVES an existing stamp instead of erasing it; and opening a stamped
 * document surfaces drift diagnostics exactly once, even across repeated
 * backend ticks.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asPromptId,
  DINKSTER_SCHEMA_WIRE_VERSION,
  type DinksterNodesPayload,
  type ExecutionRef,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { historicalSchemas } from './historical-schemas.js'
import { AppState, type Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const FRONTEND_VERSION = (
  JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }
).version

/** A Dinkster /api/nodes payload with the full environment surface (5b58c53). */
const nodesPayload: DinksterNodesPayload = {
  schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
  dinkster: { version: '0.9.0', schemaWire: 1 },
  packs: {
    core: { displayName: 'Dinkster Core', version: '1.2.0' },
    'vhs.video': {
      displayName: 'Video Helper Suite',
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
    },
  },
  nodes: {
    'std.a': { displayName: 'A', pack: 'core', signature: 'sig-a-1', interface: [] },
    'std.b': { displayName: 'B', pack: 'vhs.video', signature: 'sig-b-1', interface: [] },
  },
}

let app: AppState

beforeEach(() => {
  app = new AppState()
})

const loadUnstampedSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set({
    connection: backend.id,
    hash: 'historical-fixture',
    schemas: historicalSchemas,
    diagnostics: [],
    resolve: (type) => historicalSchemas.get(type),
  })
}

/** Put the Dinkster payload on the default backend (fires backendsTick). */
const loadDinksterSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
}

/** Minimal native document json using the payload's node types. */
const docJson = (lineage: string, types: string[], environment?: unknown): unknown => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage,
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: Object.fromEntries(types.map((t, i) => [`n${i}`, { id: `n${i}`, type: t, values: {} }])),
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 99,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
  ...(environment !== undefined ? { environment } : {}),
})

const open = (json: unknown): Tab => {
  expect(app.openDocument(json, 'T')).toEqual([])
  return app.activeTab()!
}

describe('exportDocument', () => {
  it('stamps a live tab freshly from the Dinkster registry (used-only, both axes)', () => {
    loadDinksterSchemas()
    const tab = open(docJson('lin-stamp', ['std.a']))
    const out = app.exportDocument(tab.id)!
    expect(out.environment).toEqual({
      dinkster: { version: '0.9.0', schemaWire: 1 },
      frontend: { version: FRONTEND_VERSION },
      packs: { core: { version: '1.2.0' } }, // vhs.video unused -> absent
      nodes: { 'std.a': { pack: 'core', signature: 'sig-a-1' } },
    })
  })

  it('does not mutate the stored document', () => {
    loadDinksterSchemas()
    const tab = open(docJson('lin-nomut', ['std.a']))
    app.exportDocument(tab.id)
    expect(tab.store.doc.environment).toBeUndefined()
  })

  it('replaces a stale stamp wholesale on export', () => {
    loadDinksterSchemas()
    const tab = open(
      docJson('lin-restamp', ['std.b'], {
        packs: { 'gone.pack': { version: '0.0.1' } },
        nodes: { 'std.b': { pack: 'gone.pack', signature: 'sig-b-OLD' } },
      }),
    )
    const out = app.exportDocument(tab.id)!
    expect(out.environment?.nodes['std.b']).toEqual({ pack: 'vhs.video', signature: 'sig-b-1' })
    expect(out.environment?.packs['gone.pack']).toBeUndefined()
  })

  it('PRESERVES an existing stamp when the registry has no signatures', () => {
    loadUnstampedSchemas()
    const stamp = {
      packs: { core: { version: '1.0.0' } },
      nodes: { KSampler: { pack: 'core', signature: 'sig-old' } },
    }
    const tab = open(docJson('lin-preserve', ['KSampler'], stamp))
    const out = app.exportDocument(tab.id)!
    expect(out.environment).toEqual(stamp) // last known record beats no record
  })

  it('returns the document unchanged when no registry is loaded, and undefined for unknown tabs', () => {
    const tab = open(docJson('lin-noreg', ['std.a']))
    expect(app.exportDocument(tab.id)).toBe(tab.store.doc)
    expect(app.exportDocument('no-such-tab')).toBeUndefined()
  })

  it('frozen execution tabs export their snapshot verbatim - history is never restamped', () => {
    const backend = app.backends.get()[0]!
    loadUnstampedSchemas()
    const tab = open(docJson('lin-frozen', ['KSampler']))
    const result = app.compileTab(tab)
    if (!result?.ok) throw new Error('fixture compile failed')
    const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('p1') }
    app.store.register(ref, result.artifact, 1)
    expect(app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    expect(app.exportDocument(frozen.id)).toBe(frozen.store.doc)
  })
})

describe('load-time drift reporting', () => {
  const driftCodes = () => app.problems.get().filter((d) => d.origin === 'environment').map((d) => d.code)

  it('a stamped document opened against a drifted backend lands env.node-drift in Problems', () => {
    loadDinksterSchemas()
    open(
      docJson('lin-drift', ['std.a'], {
        packs: { core: { version: '1.0.0' } },
        nodes: { 'std.a': { pack: 'core', signature: 'sig-a-OLD' } },
      }),
    )
    expect(driftCodes()).toEqual(['env.node-drift'])
  })

  it('an identical environment stays silent', () => {
    loadDinksterSchemas()
    open(
      docJson('lin-clean', ['std.a'], {
        packs: { core: { version: '1.2.0' } },
        nodes: { 'std.a': { pack: 'core', signature: 'sig-a-1' } },
      }),
    )
    expect(driftCodes()).toEqual([])
  })

  it('the check defers until schemas arrive and never duplicates across backend ticks', () => {
    open(
      docJson('lin-defer', ['std.a'], {
        packs: {},
        nodes: { 'std.a': { pack: 'core', signature: 'sig-a-OLD' } },
      }),
    )
    expect(driftCodes()).toEqual([]) // no registry yet
    loadDinksterSchemas()
    expect(driftCodes()).toEqual(['env.node-drift'])
    loadDinksterSchemas() // second tick: the once-per-tab pass must not rerun
    expect(driftCodes()).toEqual(['env.node-drift'])
  })

  it('an unstamped document reports nothing (absence is fully valid)', () => {
    loadDinksterSchemas()
    open(docJson('lin-none', ['std.a']))
    expect(driftCodes()).toEqual([])
  })
})

describe('workflow-open requirements', () => {
  it('opens an all-present workflow silently and reports one structured missing-item plan', async () => {
    app = new AppState({ defaultProtocol: 'dinkster' })
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    const plan = vi.spyOn(backend.connection, 'planWorkflowRequirements')
      .mockResolvedValue({ packs: [], assets: [], errors: [] })
    open(docJson('present-plan', ['std.a']))
    await Promise.resolve()
    expect(app.problems.get().filter((entry) => entry.code.startsWith('workflow.requirements'))).toEqual([])
    const missing = { packs: [{ pack: 'core', version: '1.2.0' }], assets: [], errors: [] }
    plan.mockResolvedValue(missing)
    const tab = open(docJson('missing-plan', ['std.a']))
    await vi.waitFor(() => expect(app.problems.get().filter((entry) => entry.code === 'workflow.requirements')).toEqual([
      expect.objectContaining({ owner: tab.id, severity: 'warning', data: missing }),
    ]))
  })

  it('discards a plan for a replaced tab even when the replacement has the same lineage', async () => {
    app = new AppState({ defaultProtocol: 'dinkster' })
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    let finish!: (plan: { packs: { pack: string; version: string }[]; assets: []; errors: [] }) => void
    vi.spyOn(backend.connection, 'planWorkflowRequirements')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue({ packs: [], assets: [], errors: [] })
    open(docJson('replaced-plan', ['std.a']))
    open(docJson('replaced-plan', ['std.b']))
    finish({ packs: [{ pack: 'retired', version: '0.1.0' }], assets: [], errors: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(app.problems.get().filter((entry) => entry.code === 'workflow.requirements')).toEqual([])
  })
})
