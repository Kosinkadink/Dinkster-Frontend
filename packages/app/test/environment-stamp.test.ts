import { prepareWorkflowApp } from './fixtures/workflow-app.js'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asPromptId,
  createSignal,
  DINKSTER_SCHEMA_WIRE_VERSION,
  type DinksterNodesPayload,
  type ExecutionRef,
} from '@dinkster/core'
import { buildDinksterRegistry, PackInstallError, type LibraryProject } from '@dinkster/client'
import { historicalSchemas } from './historical-schemas.js'
import { AppState, type Tab } from '../src/app-state.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

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
  app = createWorkflowApp(null)
})

afterEach(() => {
  app.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

const open = async (json: unknown): Promise<Tab> => {
  expect((await app.openDocument(json, 'T'))).toEqual([])
  return app.activeTab()!
}

describe('exportDocument', () => {
  it('stamps a live tab freshly from the Dinkster registry (used-only, both axes)', async () => {
    loadDinksterSchemas()
    const tab = (await open(docJson('lin-stamp', ['std.a'])))
    const out = app.exportDocument(tab.id)!
    expect(out.environment).toEqual({
      dinkster: { version: '0.9.0', schemaWire: 1 },
      frontend: { version: FRONTEND_VERSION },
      packs: { core: { version: '1.2.0' } }, // vhs.video unused -> absent
      nodes: { 'std.a': { pack: 'core', signature: 'sig-a-1' } },
    })
  })

  it('does not mutate the stored document', async () => {
    loadDinksterSchemas()
    const tab = (await open(docJson('lin-nomut', ['std.a'])))
    app.exportDocument(tab.id)
    expect(tab.store.doc.environment).toBeUndefined()
  })

  it('replaces a stale stamp wholesale on export', async () => {
    loadDinksterSchemas()
    const tab = (await open(
      docJson('lin-restamp', ['std.b'], {
        packs: { 'gone.pack': { version: '0.0.1' } },
        nodes: { 'std.b': { pack: 'gone.pack', signature: 'sig-b-OLD' } },
      }),
    ))
    const out = app.exportDocument(tab.id)!
    expect(out.environment?.nodes['std.b']).toEqual({ pack: 'vhs.video', signature: 'sig-b-1' })
    expect(out.environment?.packs['gone.pack']).toBeUndefined()
  })

  it('PRESERVES an existing stamp when the registry has no signatures', async () => {
    loadUnstampedSchemas()
    const stamp = {
      packs: { core: { version: '1.0.0' } },
      nodes: { KSampler: { pack: 'core', signature: 'sig-old' } },
    }
    const tab = (await open(docJson('lin-preserve', ['KSampler'], stamp)))
    const out = app.exportDocument(tab.id)!
    expect(out.environment).toEqual(stamp) // last known record beats no record
  })

  it('frozen execution tabs export their snapshot verbatim - history is never restamped', async () => {
    const backend = app.backends.get()[0]!
    loadUnstampedSchemas()
    const tab = (await open(docJson('lin-frozen', ['KSampler'])))
    const result = app.compileTab(tab)
    if (!result?.ok) throw new Error('fixture compile failed')
    const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('p1') }
    app.store.register(ref, result.artifact, 1)
    expect(await app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    expect(app.exportDocument(frozen.id)).toBe(frozen.store.doc)
  })
})

describe('load-time drift reporting', () => {
  const driftCodes = () => app.problems.get().filter((d) => d.origin === 'environment').map((d) => d.code)

  it('a stamped document opened against a drifted backend lands env.node-drift in Problems', async () => {
    loadDinksterSchemas()
    await open(
      docJson('lin-drift', ['std.a'], {
        packs: { core: { version: '1.0.0' } },
        nodes: { 'std.a': { pack: 'core', signature: 'sig-a-OLD' } },
      }),
    )
    expect(driftCodes()).toEqual(['env.node-drift'])
  })

  it('an identical environment stays silent', async () => {
    loadDinksterSchemas()
    await open(
      docJson('lin-clean', ['std.a'], {
        packs: { core: { version: '1.2.0' } },
        nodes: { 'std.a': { pack: 'core', signature: 'sig-a-1' } },
      }),
    )
    expect(driftCodes()).toEqual([])
  })

  it('the check defers until schemas arrive and never duplicates across backend ticks', async () => {
    await open(
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

})

describe('workflow-open requirements', () => {
  it('opens an all-present workflow silently and reports one structured missing-item plan', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    const plan = vi.spyOn(backend.connection, 'planWorkflowRequirements')
      .mockResolvedValue({ packs: [], assets: [], errors: [] })
    await open(docJson('present-plan', ['std.a']))
    await Promise.resolve()
    expect(app.problems.get().filter((entry) => entry.code.startsWith('workflow.requirements'))).toEqual([])
    const missing = { packs: [{ pack: 'core', version: '1.2.0' }], assets: [], errors: [] }
    plan.mockResolvedValue(missing)
    const tab = (await open(docJson('missing-plan', ['std.a'])))
    await vi.waitFor(() => expect(app.problems.get().filter((entry) => entry.code === 'workflow.requirements')).toEqual([
      expect.objectContaining({ owner: tab.id, severity: 'warning', data: missing }),
    ]))
  })

  it('reviews only workflow-used packs and preserves extras when enabling an installed pack', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'planWorkflowRequirements').mockResolvedValue({ packs: [], assets: [], errors: [] })
    const project = { id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film', created: '2026-11-18T12:00:00Z', revision: 7, deleted: false }
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue(project)
    vi.spyOn(backend.connection, 'projectNeeds').mockResolvedValue({
      packs: [], extra: ['already-enabled'], unknown: [],
      installed: [{ pack: 'vhs.video', version: '3.1.4' }, { pack: 'unused', version: '9.0' }, { pack: 'already-enabled', version: '1.0' }],
    })
    await open(docJson('needs-enabled', ['std.b'], {
      packs: { 'vhs.video': { version: '3.1.4' }, unused: { version: '9.0' } },
      nodes: { 'std.b': { pack: 'vhs.video', signature: 'sig-b-1' } },
    }))
    await app.checkProjectNeeds(backend)
    const review = app.projectNeedsReview.get()!
    expect(review.enable).toEqual(['vhs.video'])
    expect(review.changes).toEqual([])
    let savedExtra: readonly string[] = ['already-enabled']
    vi.spyOn(backend.connection, 'setProjectExtraPacks').mockImplementation(async (id, extra, revision) => {
      if (id !== project.id || revision !== project.revision) throw new Error('stale project')
      savedExtra = extra
      return { ...project, revision: 8 }
    })
    vi.spyOn(app, 'refreshBackendSchemas').mockResolvedValue()
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ ...project, uid: '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457' })
    await expect(app.enableReviewedProjectPacks(review)).rejects.toThrow('changed')
    expect(savedExtra).toEqual(['already-enabled'])
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue(project)
    await app.enableReviewedProjectPacks(review)
    expect(savedExtra).toEqual(['already-enabled', 'vhs.video'])
    expect(app.projectNeedsReview.get()).toBeUndefined()

    savedExtra = ['other-window-choice']
    const { uid: _uid, ...unidentified } = project
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue(unidentified)
    await app.checkProjectNeeds(backend)
    await expect(app.enableReviewedProjectPacks(app.projectNeedsReview.get()!)).rejects.toThrow('changed')
    expect(savedExtra).toEqual(['other-window-choice'])
  })

  it('separates missing and version-conflicting packs from project-only enablement', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film', created: '2026-11-18T12:00:00Z', revision: 7, deleted: false })
    vi.spyOn(backend.connection, 'projectNeeds').mockResolvedValue({
      packs: [{ pack: 'different', version: '2.0' }, { pack: 'absent', version: '3.0' }], extra: [],
      unknown: [{ scope: 'local', id: 'unreadable' }], installed: [{ pack: 'different', version: '1.0' }],
    })
    await app.checkProjectNeeds(backend)
    expect(app.projectNeedsReview.get()).toMatchObject({
      enable: [], changes: [{ pack: 'different', version: '2.0' }, { pack: 'absent', version: '3.0' }], errors: ['local/unreadable'],
    })
    let savedExtra: readonly string[] = ['other-window-choice']
    const review = app.projectNeedsReview.get()!
    vi.spyOn(backend.connection, 'setProjectExtraPacks').mockImplementation(async (_id, extra) => {
      savedExtra = extra
      return { ...review.project, revision: 9 }
    })
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ ...review.project, revision: 8 })
    await expect(app.enableReviewedProjectPacks(review)).rejects.toThrow('changed')
    expect(savedExtra).toEqual(['other-window-choice'])
  })

  it.each([undefined, 'every-project', 'only-project'] as const)('prepares one exact project software review with scope %s without enabling or installing packs', async (scope) => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    const project = { id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film', created: '2026-11-18T12:00:00Z', revision: 7, deleted: false }
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue(project)
    vi.spyOn(backend.connection, 'projectNeeds').mockResolvedValue({
      packs: [{ pack: 'different', version: '2.0' }, { pack: 'absent', version: '3.0' }], extra: ['kept'], unknown: [],
      installed: [{ pack: 'different', version: '1.0' }, { pack: 'kept', version: '4.0' }],
    })
    await app.checkProjectNeeds(backend)
    const review = app.projectNeedsReview.get()!
    const prepared = { plan: { format: 'dinkster.project-pack-plan/1' }, confirmation: 'opaque', review: 'Reviewed software', expiresInSeconds: 900 }
    const originalEnvironment = { id: 'a'.repeat(32), snapshot: '2' }
    let running = originalEnvironment
    vi.spyOn(backend.connection, 'activeEnvironment').mockImplementation(async () => running)
    let selections: readonly { pack: string; version: string }[] = []
    let preparedScope: string | undefined
    let enabled: readonly string[] = ['kept']
    let installed = false
    vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async (packs, _signal, progress, requestedScope) => {
      selections = packs
      preparedScope = requestedScope
      progress?.({ stage: 'retaining-review', sequence: 1, completed: 1, total: 1 })
      return prepared
    })
    vi.spyOn(backend.connection, 'setProjectExtraPacks').mockImplementation(async (_id, extra) => {
      enabled = extra
      return { ...project, revision: 8 }
    })
    vi.spyOn(backend.connection, 'applyPackInstall').mockImplementation(async () => { installed = true; throw new Error('unexpected apply') })
    const progress: string[] = []
    expect(await app.reviewProjectPackInstallation(review, new AbortController().signal, (value) => progress.push(value.stage), scope))
      .toMatchObject({ installation: prepared, affectedProjects: null, ...(scope === undefined ? {} : { scope }) })
    expect(preparedScope).toBe(scope)
    expect(selections).toEqual([{ pack: 'different', version: '2.0' }, { pack: 'absent', version: '3.0' }])
    expect(progress).toEqual(['retaining-review'])
    expect(enabled).toEqual(['kept'])
    expect(installed).toBe(false)
    expect(app.projectNeedsReview.get()).toBe(review)

    for (const changed of [{ ...originalEnvironment, id: 'b'.repeat(32) }, { ...originalEnvironment, snapshot: '3' }]) {
      running = originalEnvironment
      vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async () => { running = changed; return prepared })
      await expect(app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined)).rejects.toThrow('changed')
    }
    running = originalEnvironment
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ ...project, uid: '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457' })
    await expect(app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined, scope)).rejects.toThrow('changed')
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ ...project,
      environment: { id: 'b'.repeat(32), lastSnapshot: '2', lastRunAt: '2026-11-19T15:00:00Z' } })
    await expect(app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined)).rejects.toThrow('changed')

    let revision = 7
    vi.spyOn(backend.connection, 'getProject').mockImplementation(async () => ({ ...project, revision }))
    vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async () => { revision = 8; return prepared })
    await expect(app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined)).rejects.toThrow('changed')

    revision = 7
    const cancelled = new AbortController()
    vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async () => { cancelled.abort(); return prepared })
    await expect(app.reviewProjectPackInstallation(review, cancelled.signal, () => undefined)).rejects.toThrow()
    vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async () => { app.projectNeedsReview.set(undefined); return prepared })
    await expect(app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined)).rejects.toThrow('changed')
  })

  it.each(['shared', 'isolated', 'shared-reconnect', 'isolated-reconnect', 'reconnect-timeout', 'lost-response', 'refused', 'changed-uid', 'closed-document', 'dismissed',
    'wrong-environment', 'wrong-snapshot', 'wrong-version', 'unknown-needs', 'revision-conflict', 'expired', 'stale-before', 'unscoped'] as const)(
    'applies a retained project review once and protects post-activation writes: %s', async (scenario) => {
      app = prepareWorkflowApp(new AppState())
      loadDinksterSchemas()
      const backend = app.backends.get()[0]!
      const status = createSignal<'connected' | 'reconnecting'>('connected')
      vi.spyOn(backend.connection.status, 'get').mockImplementation(status.get)
      vi.spyOn(backend.connection.status, 'subscribe').mockImplementation(status.subscribe)
      vi.spyOn(backend.connection, 'planWorkflowRequirements').mockResolvedValue({ packs: [], assets: [], errors: [] })
      const sourceId = 'a'.repeat(32)
      let activated = false
      let refreshed = false
      let uid = '48bb018e-5b17-4e68-bd81-c6412c4bcd72'
      const environmentId = () => activated && scenario.startsWith('isolated') ? 'b'.repeat(32) : sourceId
      const project = (): LibraryProject => ({ id: 'default', uid, name: 'Film', created: '2026-11-18T12:00:00Z',
        revision: activated ? 11 : 7, deleted: false,
        environment: { id: activated && scenario === 'wrong-environment' ? 'c'.repeat(32) : environmentId(), lastSnapshot: null, lastRunAt: null } })
      vi.spyOn(backend.connection, 'getProject').mockImplementation(async () => project())
      vi.spyOn(backend.connection, 'activeEnvironment').mockImplementation(async () => ({ id: environmentId(),
        snapshot: activated ? scenario === 'wrong-snapshot' ? '5' : '4' : '2' }))
      vi.spyOn(backend.connection, 'projectNeeds').mockImplementation(async () => ({
        packs: [{ pack: 'newpack', version: '2.1' }], extra: activated ? ['kept', 'other-window'] : ['kept'],
        unknown: refreshed || activated && scenario === 'unknown-needs' ? [{ scope: 'local', id: 'unreadable' }] : [],
        installed: [{ pack: 'kept', version: '1.0' }, ...(activated ? [{ pack: 'newpack', version: scenario === 'wrong-version' ? '2.0' : '2.1' }] : [])],
      }))
      vi.spyOn(backend.connection, 'planPackInstall').mockResolvedValue({ plan: { format: 'dinkster.project-pack-plan/1' },
        confirmation: 'opaque', review: 'Reviewed software', expiresInSeconds: 900 })
      const tab = await open(docJson('apply-project', ['std.a']))
      await app.checkProjectNeeds(backend)
      const review = app.projectNeedsReview.get()!
      const prepared = await app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined,
        scenario === 'unscoped' ? undefined : scenario.startsWith('isolated') ? 'only-project' : 'every-project')
      let installations = 0
      vi.spyOn(backend.connection, 'applyPackInstall').mockImplementation(async () => {
        installations++
        if (scenario === 'lost-response') throw new TypeError('connection lost')
        if (scenario === 'refused') throw new PackInstallError(409, { error: 'plan-stale' })
        activated = true
        if (scenario === 'reconnect-timeout') status.set('reconnecting')
        if (scenario.endsWith('-reconnect')) {
          status.set('reconnecting')
          setTimeout(() => status.set('connected'), 20)
        }
        loadDinksterSchemas()
        await app.checkProjectNeeds(backend)
        if (scenario === 'changed-uid') uid = '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457'
        if (scenario === 'closed-document') app.closeTab(tab.id)
        if (scenario === 'dismissed') app.projectNeedsReview.set(undefined)
        return { generation: 4, activation: { epoch: 8, added: ['newpack'], removed: [], reloaded: [], unchanged: [] } }
      })
      let saved: readonly string[] = ['kept']
      vi.spyOn(backend.connection, 'setProjectExtraPacks').mockImplementation(async (id, extra, revision) => {
        if (scenario === 'revision-conflict') throw new Error('revision conflict')
        if (id !== 'default' || revision !== 11) throw new Error('wrong project revision')
        saved = extra
        return { ...project(), revision: 12 }
      })
      vi.spyOn(app, 'refreshBackendSchemas').mockImplementation(async () => {
        refreshed = true
        await app.checkProjectNeeds(backend)
      })
      if (scenario === 'expired') vi.spyOn(performance, 'now').mockReturnValue(prepared.expiresAt + 1)
      if (scenario === 'stale-before') uid = '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457'
      if (scenario === 'shared' || scenario === 'isolated' || scenario.endsWith('-reconnect')) {
        await app.applyReviewedProjectPacks(review, prepared)
        expect(saved).toEqual(['kept', 'newpack', 'other-window'])
        expect(app.projectPackNotification.get()).toBeDefined()
        expect(app.projectNeedsReview.get()?.needs.unknown).toEqual([{ scope: 'local', id: 'unreadable' }])
      } else {
        if (scenario === 'reconnect-timeout') {
          vi.useFakeTimers()
          const failed = expect(app.applyReviewedProjectPacks(review, prepared)).rejects.toThrow('connection did not recover')
          await vi.advanceTimersByTimeAsync(15_000)
          await failed
        } else await expect(app.applyReviewedProjectPacks(review, prepared)).rejects.toThrow()
        expect(saved).toEqual(['kept'])
        expect(app.projectPackNotification.get()).toBeUndefined()
      }
      await expect(app.applyReviewedProjectPacks(review, prepared)).rejects.toThrow()
      expect(installations).toBe(['expired', 'stale-before', 'unscoped'].includes(scenario) ? 0 : 1)
      if (scenario === 'lost-response') {
        await app.checkProjectNeeds(backend)
        const reopened = app.projectNeedsReview.get()!
        await expect(app.enableReviewedProjectPacks(reopened)).rejects.toThrow('Do not install again')
        expect(saved).toEqual(['kept'])
        await expect(app.reviewProjectPackInstallation(reopened, new AbortController().signal, () => undefined, 'every-project'))
          .rejects.toThrow('Do not install again')
        expect(installations).toBe(1)
      }
    })

  it('finds affected workflow and extra-pack projects across pages without treating unknown ownership as safe', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    const environment = { id: 'a'.repeat(32), snapshot: '2' }
    const base = { created: '2026-11-18T12:00:00Z', revision: 7, deleted: false,
      environment: { id: environment.id, lastSnapshot: '1', lastRunAt: '2026-11-18T12:00:00Z' } }
    const project = { ...base, id: 'default', name: 'Film' }
    const workflow = { ...base, id: 'workflow', name: 'Workflow user' }
    const extra = { ...base, id: 'extra', name: 'Extra pack user' }
    const untouched = { ...base, id: 'untouched', name: 'Unaffected' }
    const other = { ...base, id: 'other', name: 'Other environment', environment: { ...base.environment, id: 'b'.repeat(32) } }
    let projects: LibraryProject[] = [project, workflow, extra, untouched, other]
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue(project)
    const selectedNeeds = { packs: [{ pack: 'added', version: '2.0' }], extra: [], unknown: [], installed: [] }
    let unknown = false
    let mutateNeeds = false
    let extraReads = 0
    vi.spyOn(backend.connection, 'projectNeeds').mockImplementation(async (id) => {
      if (id === project.id) return selectedNeeds
      if (id === extra.id && mutateNeeds) return { packs: [], extra: extraReads++ === 0 ? ['added'] : ['unchanged'], installed: [], unknown: [] }
      if (id === other.id) throw new Error('must not inspect a different environment')
      return { packs: id === workflow.id ? [{ pack: 'replaced', version: '1.0' }] : [],
        extra: id === extra.id ? ['added'] : ['unchanged'], installed: [],
        unknown: unknown ? [{ scope: 'local', id: 'unreadable' }] : [] }
    })
    let mutateList = false
    vi.spyOn(backend.connection, 'listProjects').mockImplementation(async (cursor) => {
      if (mutateList) { projects = projects.map((item) => item.id === extra.id ? { ...item, revision: item.revision + 1 } : item) }
      return cursor === undefined ? { items: projects.slice(0, 2), cursor: 'second' }
        : { items: projects.slice(2), cursor: null }
    })
    vi.spyOn(backend.connection, 'activeEnvironment').mockResolvedValue(environment)
    const changes = [
      { pack: 'added', kind: 'added' as const, sourceChanged: true, dependenciesChanged: false },
      { pack: 'replaced', kind: 'changed' as const, sourceChanged: false, dependenciesChanged: true },
    ]
    let impact: typeof changes | null | undefined = changes
    vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async () => ({
      plan: { format: 'dinkster.project-pack-plan/1', ...(impact === undefined ? {} : { packChanges: impact }) },
      confirmation: 'opaque', review: 'Reviewed software', expiresInSeconds: 900,
    }))
    await app.checkProjectNeeds(backend)
    const review = app.projectNeedsReview.get()!
    const prepare = () => app.reviewProjectPackInstallation(review, new AbortController().signal, () => undefined)
    expect((await prepare()).affectedProjects?.map(({ id }) => id)).toEqual(['extra', 'workflow'])
    unknown = true
    expect((await prepare()).affectedProjects).toBeNull()
    unknown = false
    projects = [...projects, { ...base, id: 'legacy', name: 'Unbound', environment: null }]
    expect((await prepare()).affectedProjects).toBeNull()
    projects = projects.filter(({ id }) => id !== 'legacy')
    for (const missing of [undefined, null]) {
      impact = missing
      expect((await prepare()).affectedProjects).toBeNull()
    }
    impact = []
    expect((await prepare()).affectedProjects).toEqual([])
    impact = changes
    mutateNeeds = true
    await expect(prepare()).rejects.toThrow('changed')
    mutateNeeds = false
    mutateList = true
    await expect(prepare()).rejects.toThrow('changed')
    mutateList = false
    let clock = 1000
    let scanTime = 449_999
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.spyOn(backend.connection, 'listProjects').mockImplementation(async () => {
      clock += scanTime
      return { items: projects, cursor: null }
    })
    const almostExpired = await prepare()
    expect(almostExpired.expiresAt - performance.now()).toBe(2)
    clock = 1000
    scanTime = 450_000
    await expect(prepare()).rejects.toThrow(/expired/)
  })

  it('refuses ambiguous or unknown project needs before preparing software', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film', created: '2026-11-18T12:00:00Z', revision: 7, deleted: false })
    let prepared = false
    vi.spyOn(backend.connection, 'planPackInstall').mockImplementation(async () => { prepared = true; throw new Error('unexpected preparation') })
    for (const needs of [
      { packs: [{ pack: 'absent', version: null }], unknown: [] },
      { packs: [{ pack: 'conflict', version: '1.0' }, { pack: 'conflict', version: '2.0' }], unknown: [] },
      { packs: [{ pack: 'absent', version: '3.0' }], unknown: [{ scope: 'local', id: 'unreadable' }] },
    ]) {
      vi.spyOn(backend.connection, 'projectNeeds').mockResolvedValue({ ...needs, extra: [], installed: [] })
      await app.checkProjectNeeds(backend)
      await expect(app.reviewProjectPackInstallation(app.projectNeedsReview.get()!, new AbortController().signal, () => undefined)).rejects.toThrow('recorded version')
    }
    vi.spyOn(backend.connection, 'projectNeeds').mockResolvedValue({
      packs: [{ pack: 'absent', version: '3.0' }], extra: [], installed: [], unknown: [],
    })
    await app.openDocument(docJson('unknown-document-needs', ['unidentified.node']), 'Unknown workflow')
    await app.checkProjectNeeds(backend)
    expect(app.projectNeedsReview.get()!.errors).toEqual(['unidentified.node'])
    await expect(app.reviewProjectPackInstallation(app.projectNeedsReview.get()!, new AbortController().signal, () => undefined)).rejects.toThrow('recorded version')
    expect(prepared).toBe(false)
    app.registerSchemas([{ ...backend.registry.get()!.resolve('std.a')!, type: 'unidentified.node' }])
    await vi.waitFor(() => expect(app.projectNeedsReview.get()).toMatchObject({ errors: [] }))
  })

  it('discards needs for a workflow replaced during the read', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'planWorkflowRequirements').mockResolvedValue({ packs: [], assets: [], errors: [] })
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue({ id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film', created: '2026-11-18T12:00:00Z', revision: 7, deleted: false })
    let finish!: (needs: { packs: []; extra: string[]; installed: []; unknown: [] }) => void
    vi.spyOn(backend.connection, 'projectNeeds').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await open(docJson('stale-needs', ['std.a']))
    const checking = app.checkProjectNeeds(backend)
    await Promise.resolve()
    const resolveOld = finish
    await open(docJson('stale-needs', ['std.b']))
    resolveOld({ packs: [], extra: ['missing'], installed: [], unknown: [] })
    await checking
    expect(app.projectNeedsReview.get()).toBeUndefined()
  })

  it('discards a plan for a replaced tab even when the replacement has the same lineage', async () => {
    app = prepareWorkflowApp(new AppState())
    loadDinksterSchemas()
    const backend = app.backends.get()[0]!
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    let finish!: (plan: { packs: { pack: string; version: string }[]; assets: []; errors: [] }) => void
    vi.spyOn(backend.connection, 'planWorkflowRequirements')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue({ packs: [], assets: [], errors: [] })
    await open(docJson('replaced-plan', ['std.a']))
    await open(docJson('replaced-plan', ['std.b']))
    finish({ packs: [{ pack: 'retired', version: '0.1.0' }], assets: [], errors: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(app.problems.get().filter((entry) => entry.code === 'workflow.requirements')).toEqual([])
  })
})
