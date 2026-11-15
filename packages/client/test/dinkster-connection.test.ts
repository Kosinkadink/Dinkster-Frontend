/**
 * DinksterConnection unit tests: native schema registry from the real
 * /api/nodes fixture, V1-prompt -> native graph conversion, submit
 * accept/reject mapping, job hydration/replay, WS framing, and native
 * reconciliation.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  asConnectionId,
  asDynamicMemberId,
  asNodeId,
  asPortId,
  asPromptId,
  compile,
  importLitegraph,
  resolveImportedNodePacks,
  loadDocument,
  type CompileArtifact,
  type Diagnostic,
  type DinksterNodesPayload,
  type ExecutionRef,
  type NormalizedEvent,
  type Prompt,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry, DinksterConnection, ExecutionStore, IMAGE_DOCUMENT_MEDIA_TYPE, hydrateDinksterCompletedExecution, PackInstallError, promptToDinksterGraph, reconcileDinksterExecutions, targetsForArtifact, type FetchLike, type WebSocketLike } from '../src/index.js'
import { uuidv4 } from '../src/dinkster-connection.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const nodesPayload = readJson('fixtures/dinkster-nodes.json') as DinksterNodesPayload
const docsPageFixture = JSON.parse(readFileSync(new URL('./fixtures/docs-page.json', import.meta.url), 'utf8')) as unknown
const currentNodesPayload = (
  dinkster?: Record<string, unknown>,
): DinksterNodesPayload => ({
  ...nodesPayload,
  schemaVersion: 1,
  ...(dinkster === undefined ? {} : { dinkster: { ...dinkster, schemaWire: 1 } }),
  nodes: Object.fromEntries(
    Object.entries(nodesPayload.nodes as Record<string, Record<string, unknown>>)
      .map(([type, schema]) => [type, { ...schema, schemaVersion: 1 }]),
  ),
})
const liveNodesPayload = currentNodesPayload()
const C0 = asConnectionId('c0')
const registry = buildDinksterRegistry(C0, nodesPayload)
const liveRegistry = buildDinksterRegistry(C0, liveNodesPayload)
const ref = (jobId: string): ExecutionRef => ({ connection: C0, prompt: asPromptId(jobId) })

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

it('decodes and revalidates static registry import metadata without backend credentials or installed schemas', async () => {
  const row = { pack: 'dinkster-text', version: '0.0.1',
    rule: { from: 'StringLength', cases: [{ to: 'dinkster.text.string_length',
      inputs: { string: { kind: 'copy', input: 'string' } }, outputs: { length: 'length' } }] },
    schema: { schemaVersion: 1, nodeType: 'dinkster.text.string_length', interface: [
      { role: 'input', id: 'string', type: { kind: 'concrete', types: ['STRING'] } },
      { role: 'output', id: 'length', type: { kind: 'concrete', types: ['INT'] } },
    ] } }
  const indexRow = (version = '0.0.1') => ({ from: 'StringLength', candidates: [{ ...row, version, target: row.schema.nodeType }] })
  let payload: unknown = { schemaVersion: 1, items: [indexRow()] }
  let status = 200
  let etag = '"first"'
  const calls: { url: string; etag: string | null }[] = []
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'importer', token: 'backend-only',
    registryStaticUrl: () => 'https://mirror.example/static',
    fetchFn: async (url, init) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      expect(init?.credentials).toBe('omit')
      if (url.endsWith('/schemas.json')) return jsonResponse(200, { packName: row.pack,
        version: url.includes('/0.0.2/') ? '0.0.2' : '0.0.1', schemas: [{ nodeType: row.schema.nodeType,
          schemaWireVersion: 1, schema: row.schema }] })
      calls.push({ url, etag: new Headers(init?.headers).get('If-None-Match') })
      return new Response(status === 304 ? null : JSON.stringify(payload), { status, headers: { ETag: etag } })
    }, webSocketFactory: () => ({}) as WebSocketLike })
  const first = await connection.fetchComfyTranslations()
  const imported = importLitegraph({ nodes: [{ id: 1, type: 'StringLength', widgets_values: ['asymmetric value'] }], links: [] },
    () => undefined, undefined, first)
  expect(imported.document!.graphs.g0!.nodes.n1).toMatchObject({ type: 'dinkster.text.string_length', values: { string: 'asymmetric value' } })
  expect(resolveImportedNodePacks(imported.document!, () => undefined)).toEqual([
    expect.objectContaining({ status: 'installable', pack: 'dinkster-text', version: '0.0.1' }),
  ])
  status = 304
  expect(await connection.fetchComfyTranslations()).toEqual(first)
  status = 200
  etag = '"second"'
  payload = { schemaVersion: 1, items: [indexRow('0.0.2')] }
  expect((await connection.fetchComfyTranslations())[0]!.version).toBe('0.0.2')
  payload = { schemaVersion: 1, items: [indexRow(), indexRow()] }
  await expect(connection.fetchComfyTranslations()).rejects.toThrow('Ambiguous')
  status = 304
  expect((await connection.fetchComfyTranslations())[0]!.version).toBe('0.0.2')
  expect(calls.map((call) => call.etag)).toEqual([null, '"first"', '"first"', '"second"', '"second"'])
  expect(calls.every((call) => call.url === 'https://mirror.example/static/replacements/index.json')).toBe(true)
  payload = { schemaVersion: 1, items: [{ from: 'DiscoveredAlias', candidates: [
    { ...row, target: row.schema.nodeType }, { ...row, target: row.schema.nodeType },
  ] }] }
  status = 200
  const ambiguous = importLitegraph({ nodes: [{ id: 1, type: 'DiscoveredAlias', widgets_values: ['raw ambiguous'] }], links: [] },
    () => undefined, undefined, await connection.fetchComfyTranslations())
  expect(ambiguous.document!.graphs.g0!.nodes.n1!.type).toBe('DiscoveredAlias')
  expect(ambiguous.document!.graphs.g0!.nodes.n1!.ext!['importer.rawWidgetValues']).toEqual(['raw ambiguous'])
  expect(ambiguous.diagnostics.some((entry) => entry.code === 'import.translation.ambiguous')).toBe(true)
  payload = { schemaVersion: 1, items: [{ from: 'DiscoveredAlias', candidates: [{ ...row, target: row.schema.nodeType }] }] }
  const alias = importLitegraph({ nodes: [{ id: 1, type: 'DiscoveredAlias', widgets_values: ['alias value'] }], links: [] },
    () => undefined, undefined, await connection.fetchComfyTranslations())
  expect(alias.document!.graphs.g0!.nodes.n1).toMatchObject({ type: row.schema.nodeType, values: { string: 'alias value' } })
})

it('retains the newer import catalog when an older refresh completes last', async () => {
  const snapshot = (version: string) => ({ schemaVersion: 1, items: [{ from: 'StringLength', candidates: [{
    pack: 'dinkster-text', version, target: 'dinkster.text.string_length',
    rule: { from: 'StringLength', cases: [{ to: 'dinkster.text.string_length', inputs: {}, outputs: {} }] },
  }] }] })
  let releaseOlder!: (response: Response) => void
  const etags: (string | null)[] = []
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'importer',
    registryStaticUrl: () => 'https://mirror.example/static',
    fetchFn: async (url, init) => {
      if (url.endsWith('/schemas.json')) return jsonResponse(200, { packName: 'dinkster-text',
        version: url.includes('/0.0.2/') ? '0.0.2' : '0.0.1', schemas: [{ nodeType: 'dinkster.text.string_length', schemaWireVersion: 1,
          schema: { schemaVersion: 1, interface: [] } }] })
      etags.push(new Headers(init?.headers).get('If-None-Match'))
      if (etags.length === 1) return new Promise<Response>((resolve) => { releaseOlder = resolve })
      if (etags.length === 2) return new Response(JSON.stringify(snapshot('0.0.2')), { headers: { ETag: '"newer"' } })
      return new Response(null, { status: 304 })
    }, webSocketFactory: () => ({}) as WebSocketLike })
  const older = connection.fetchComfyTranslations()
  const newer = await connection.fetchComfyTranslations()
  expect(newer[0]!.version).toBe('0.0.2')
  releaseOlder(new Response(JSON.stringify(snapshot('0.0.1')), { headers: { ETag: '"older"' } }))
  expect((await older)[0]!.version).toBe('0.0.1')
  expect((await connection.fetchComfyTranslations())[0]!.version).toBe('0.0.2')
  expect(etags).toEqual([null, null, '"newer"'])
})

function preparedReview(result: unknown) {
  return { preparation: 'preparation-1', state: 'ready', progress: { sequence: 2, stage: 'retaining-review', completed: 1, total: 1 }, result }
}

it.each([
  { format: 'dinkster.plan/1', base: null },
  { format: 'desktop.project-software/1', retained: { engine: 'sealed', constraints: ['cpu'] } },
])('plans exact pack selections with an opaque host plan and applies only confirmation', async (hostPlan) => {
  const plan = { confirmation: 'opaque-review-token', plan: hostPlan,
    review: 'Install sampling 2.1 and image 3.2', expiresInSeconds: 900 }
  const activation = { generation: 3, epoch: 7, added: ['sampling', 'image'], removed: [],
    reloaded: ['models'], unchanged: ['base'], failed: {}, diagnostics: [], rolledBack: false }
  const calls: { url: string; body: unknown }[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init!.body as string) })
    return jsonResponse(200, url.endsWith('/prepare') ? preparedReview(plan) : { generation: 3, activation })
  }
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'installer', fetchFn,
    webSocketFactory: () => ({}) as WebSocketLike })
  const reviewed = await connection.planPackInstall([
    { pack: 'sampling', version: '2.1' }, { pack: 'image', version: '3.2' },
  ])
  expect(reviewed).toEqual(plan)
  expect(calls).toEqual([{ url: '/selected/api/packs/install/prepare', body: { packs: [
    { pack: 'sampling', version: '2.1' }, { pack: 'image', version: '3.2' },
  ] } }])
  if (reviewed.commands !== undefined) throw new Error('Expected a gateway confirmation')
  expect(await connection.applyPackInstall(reviewed.confirmation)).toEqual({ generation: 3,
    activation: { epoch: 7, added: ['sampling', 'image'], removed: [], reloaded: ['models'], unchanged: ['base'] } })
  expect(calls[1]).toEqual({ url: '/selected/api/packs/install/apply', body: { confirmation: 'opaque-review-token' } })
})

it('retains terminal-only installation commands without granting HTTP confirmation', async () => {
  const plan = { plan: { format: 'dinkster.project-pack-plan/1' }, review: 'Install on the backend host',
    commands: ['dinkster-env --root /project packs-plan image@3.2 --output /tmp/review',
      'dinkster-env --root /project packs-apply --input /tmp/review --approval sha256:example'], expiresInSeconds: 900 }
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'installer',
    fetchFn: async () => jsonResponse(200, preparedReview(plan)), webSocketFactory: () => ({}) as WebSocketLike })
  expect(await connection.planPackInstall([{ pack: 'image', version: '3.2' }])).toEqual(plan)
})

it.each([404, 409, 422])('preserves structured installation failures without retries: HTTP %s', async (status) => {
  let requests = 0
  const body = { error: 'activation-failed', detail: 'Old live surface retained', generation: 4,
    activation: { failed: { image: 'worker failed' } } }
  const fetchFn: FetchLike = async () => { requests++; return jsonResponse(status, body) }
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'installer', fetchFn,
    webSocketFactory: () => ({}) as WebSocketLike })
  for (const request of [() => connection.planPackInstall([{ pack: 'image', version: '1' }]),
    () => connection.applyPackInstall('token')]) {
    await expect(request()).rejects.toMatchObject({ status, body, message: body.detail })
  }
  expect(requests).toBe(2)
  await expect(connection.applyPackInstall('token')).rejects.toBeInstanceOf(PackInstallError)
})

it('rejects malformed installation success and activation rollback instead of reporting installed', async () => {
  let response: unknown
  const fetchFn: FetchLike = async (url) => jsonResponse(200, url.endsWith('/prepare') ? preparedReview(response) : response)
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'installer', fetchFn,
    webSocketFactory: () => ({}) as WebSocketLike })
  const plan = { confirmation: 'token', plan: { format: 'dinkster.plan/1' }, review: 'Review', expiresInSeconds: 900 }
  const terminal = { ...plan, confirmation: undefined, commands: ['run command'] }
  for (const invalid of [null, [], { ...plan, confirmation: '' }, { ...plan, plan: [] },
    { ...terminal, commands: [] }, { ...terminal, commands: [''] }, { ...terminal, commands: [4] },
    { ...terminal, confirmation: 'mixed-authority' }, { ...terminal, commands: 'run command' },
    { ...plan, plan: null }, { ...plan, review: 4 }, { ...plan, expiresInSeconds: 0 }]) {
    response = invalid
    await expect(connection.planPackInstall([{ pack: 'image', version: '1' }])).rejects.toThrow('Malformed')
  }
  const activation = { generation: 2, epoch: 3, added: ['image'], removed: [], reloaded: [], unchanged: [],
    failed: {}, rolledBack: false }
  for (const invalid of [null, { ...activation, epoch: -1 }, { ...activation, generation: 3 },
    { ...activation, added: [4] }, { ...activation, failed: { image: 'failure' } },
    { ...activation, failed: [] }, { ...activation, rolledBack: true }]) {
    response = { generation: 2, activation: invalid }
    await expect(connection.applyPackInstall('token')).rejects.toThrow('Malformed')
  }
})

it('bounds install planning and forwards cancellation without retrying apply', async () => {
  vi.useFakeTimers()
  try {
    const signals: AbortSignal[] = []
    const fetchFn: FetchLike = async (_url, init) => {
      const signal = init!.signal as AbortSignal
      signals.push(signal)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    }
    const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'installer', fetchFn,
      webSocketFactory: () => ({}) as WebSocketLike })
    const planning = expect(connection.planPackInstall([{ pack: 'image', version: '1' }])).rejects.toThrow('could not be acknowledged within 30 seconds')
    await vi.advanceTimersByTimeAsync(30_000)
    await planning
    expect(signals[0]!.aborted).toBe(true)
    const controller = new AbortController()
    const applying = expect(connection.applyPackInstall('token', controller.signal)).rejects.toThrow('cancelled')
    controller.abort()
    await applying
    expect(signals[1]!.aborted).toBe(true)
    expect(signals).toHaveLength(2)
  } finally { vi.useRealTimers() }
})

it('cancels a late preparation acknowledgement after the caller stops waiting', async () => {
  let acknowledge!: (response: Response) => void
  const calls: string[] = []
  const fetchFn: FetchLike = async (url) => {
    calls.push(url)
    if (url.endsWith('/prepare')) return new Promise((resolve) => { acknowledge = resolve })
    return jsonResponse(200, { state: 'cancelled' })
  }
  const connection = new DinksterConnection({ id: C0, baseUrl: '/selected', clientId: 'installer', fetchFn,
    webSocketFactory: () => ({}) as WebSocketLike })
  const controller = new AbortController()
  const stopped = expect(connection.planPackInstall([{ pack: 'image', version: '1' }], controller.signal)).rejects.toThrow('Aborted')
  controller.abort(new Error('Aborted'))
  await stopped
  acknowledge(jsonResponse(202, { preparation: 'late-preparation', state: 'preparing' }))
  await vi.waitFor(() => expect(calls).toEqual([
    '/selected/api/packs/install/prepare', '/selected/api/packs/install/preparation/cancel',
  ]))
})

it('reads live source selections from the editing connection and rejects malformed options', async () => {
  let payload: unknown = { kind: 'model/vae', options: [
    { name: 'vendor/vae.safetensors', shape: 'file' },
    { name: 'taesd', shape: 'pair' }, { name: 'pixel_space', shape: 'literal' },
  ] }
  const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(200, payload))
  const connection = new DinksterConnection({ id: C0, baseUrl: '/native', clientId: 'selection', fetchFn,
    webSocketFactory: () => ({}) as WebSocketLike })
  expect(await connection.listAssetSelections('model/vae')).toEqual((payload as { options: unknown }).options)
  expect(fetchFn.mock.calls[0]?.[0]).toBe('/native/api/assets/selections?kind=model%2Fvae')
  const projectConnection = new DinksterConnection({ id: C0, baseUrl: '/native', clientId: 'project-selection', project: 'connection-project', fetchFn,
    webSocketFactory: () => ({}) as WebSocketLike })
  await projectConnection.listAssetSelections('model/vae')
  expect(new URL(String(fetchFn.mock.calls.at(-1)?.[0]), 'http://native').searchParams.get('project')).toBe('connection-project')
  await projectConnection.listAssetSelections('model/vae', undefined, 'editing-project')
  expect(new URL(String(fetchFn.mock.calls.at(-1)?.[0]), 'http://native').searchParams.get('project')).toBe('editing-project')
  payload = { kind: 'directory/input', options: [{ name: 'train/set', shape: 'directory' }] }
  expect(await connection.listAssetSelections('directory/input')).toEqual([{ name: 'train/set', shape: 'directory' }])
  for (const invalid of [
    { kind: 'model/vae', options: [{ name: 'a', shape: 'directory' }] },
    { kind: 'model/vae', options: [{ name: 'a', shape: 'file', path: '/host/private' }] },
    { kind: 'model/vae', options: [{ name: 'a', shape: 'file' }, { name: 'a', shape: 'pair' }] },
    { kind: 'model/vae', options: [{ name: '', shape: 'literal' }] },
    { kind: 'directory/input', options: [] },
    { kind: 'model/vae', options: [], root: '/host/private' },
  ]) {
    payload = invalid
    await expect(connection.listAssetSelections('model/vae')).rejects.toThrow('Malformed')
  }
  await expect(connection.listAssetSelections('model/*')).rejects.toThrow('Unsupported')
})

async function snapshotFixture(id: string): Promise<{ body: string; digest: string }> {
  const body = JSON.stringify({
    format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
      id, version: '1.0.0', packageDigest: `sha256:${'a'.repeat(64)}`, contributionIds: [],
      selectorResolutions: [], serviceProviders: [], capabilities: [], behaviorConfiguration: [],
      events: [{ name: `${id}.observed`, payload: { value: 'integer' } }],
    }],
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return { body, digest: `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` }
}

describe('mount listing decode', () => {
  const connectionWith = (mounts: unknown, outputMount?: unknown, mountChangesAllowed: unknown = true): DinksterConnection =>
    new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(200, { mounts, mountChangesAllowed, ...(outputMount === undefined ? {} : { outputMount }) }) })

  it.each([200, 503])('answers an older mount read with the newer snapshot after a late HTTP %s response', async (status) => {
    let finish!: (response: Response) => void
    const current = { mounts: [{ id: 'current', mode: 'readwrite', state: 'ready' }], mountChangesAllowed: true, outputMount: 'current' }
    const fetchFn = vi.fn<FetchLike>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue(jsonResponse(200, current))
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn })
    const older = connection.fetchMountSettings()
    await expect(connection.fetchMountSettings()).resolves.toEqual(current)
    finish(jsonResponse(status, { mounts: [{ id: 'removed', mode: 'read', state: 'ready' }], outputMount: 'removed' }))
    await expect(older).resolves.toEqual(current)
    expect(connection.mountError.get()).toBeUndefined()
  })

  it('does not clear a newer mount failure when an older snapshot arrives', async () => {
    let finish!: (response: Response) => void
    const fetchFn = vi.fn<FetchLike>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockResolvedValue(jsonResponse(503, {}))
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn })
    const older = connection.fetchMountSettings()
    await expect(connection.fetchMountSettings()).rejects.toThrow('GET /api/mounts failed: 503')
    finish(jsonResponse(200, { mounts: [], outputMount: 'removed' }))
    await expect(older).rejects.toThrow('GET /api/mounts failed: 503')
    expect(connection.mountError.get()).toBe('GET /api/mounts failed: 503')
  })

  it('times out a stalled mount read, ignores its late completion, and clears health on retry', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (response: Response) => void
      const fetchFn = vi.fn<FetchLike>()
        .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
        .mockResolvedValue(jsonResponse(200, { mounts: [], outputMount: 'renders' }))
      const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn })
      const first = expect(connection.fetchMountSettings()).rejects.toThrow('timed out after 30 seconds')
      await vi.advanceTimersByTimeAsync(30_000)
      await first
      expect(connection.mountError.get()).toContain('timed out')
      finish(jsonResponse(200, { mounts: [], outputMount: 'stale' }))
      await Promise.resolve()
      expect(connection.mountError.get()).toContain('timed out')
      await expect(connection.fetchMountSettings()).resolves.toMatchObject({ outputMount: 'renders' })
      expect(connection.mountError.get()).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('does not commit a schema catalog that arrives after its deadline', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (response: Response) => void
      const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
        fetchFn: () => new Promise((resolve) => { finish = resolve }),
      })
      const first = expect(connection.fetchSchemas()).rejects.toThrow('timed out after 30 seconds')
      await vi.advanceTimersByTimeAsync(30_000)
      await first
      finish(jsonResponse(200, nodesPayload))
      await vi.advanceTimersByTimeAsync(0)
      expect(connection.currentRegistry).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('decodes mountChangesAllowed as an exact boolean', async () => {
    await expect(connectionWith([], undefined, true).fetchMountSettings()).resolves.toMatchObject({ mountChangesAllowed: true })
    await expect(connectionWith([], undefined, false).fetchMountSettings()).resolves.toMatchObject({ mountChangesAllowed: false })
  })

  it('decodes the selected output mount and host path', async () => {
    const settings = await connectionWith([
      { id: 'output', mode: 'readwrite', state: 'ready', path: '/library/output' },
    ], 'output').fetchMountSettings()
    expect(settings).toEqual({
      outputMount: 'output',
      mountChangesAllowed: true,
      mounts: [{ id: 'output', mode: 'readwrite', state: 'ready', path: '/library/output' }],
    })
    for (const unset of [undefined, null]) {
      await expect(connectionWith([
        { id: 'output', mode: 'readwrite', state: 'ready' },
      ], unset).fetchMountSettings()).resolves.toEqual({
        mounts: [{ id: 'output', mode: 'readwrite', state: 'ready' }],
        mountChangesAllowed: true,
      })
    }
    await expect(connectionWith([], 42).fetchMountSettings()).rejects.toThrow('malformed output mount')
  })

  it("decodes the server vocabulary: 'read' and 'readwrite'", async () => {
    // The real server (dinkster_assets MOUNT_MODES) says 'read', never
    // 'readonly'. A decoder that guessed 'readonly' silently hid every
    // read mount (comfy-input, comfy-models) - this pins the actual words.
    const mounts = await connectionWith([
      { id: 'comfy-input', mode: 'read', state: 'ready', kind: 'media/image', entryCount: 3 },
      { id: 'comfy-output', mode: 'readwrite', state: 'ready' },
    ]).listMounts()
    expect(mounts.map((m) => m.id)).toEqual(['comfy-input', 'comfy-output'])
    expect(mounts.map((m) => m.mode)).toEqual(['read', 'readwrite'])
    expect(mounts.map((m) => m.kind)).toEqual(['media/image', undefined])
    expect(mounts.map((m) => m.entryCount)).toEqual([3, undefined])
  })

  it('accepts an unconfigured output without losing configured sources', async () => {
    const mounts = [{ id: 'inputs', mode: 'read', state: 'ready' }]
    const { conn } = submitHarness(() => jsonResponse(200, {
      mounts, outputMount: null, activeOutputMount: null, mountChangesAllowed: true,
    }))
    await expect(conn.fetchMountSettings()).resolves.toEqual({ mounts, mountChangesAllowed: true })
    await expect(conn.listMounts()).resolves.toEqual(mounts)
  })

  it('decodes bounded mount scan progress and rejects malformed counters', async () => {
    const progress = {
      filesDone: 4,
      filesTotal: 10,
      bytesDone: 1024,
      bytesTotal: 4096,
      elapsedSeconds: 2.5,
    }
    const mounts = await connectionWith([
      { id: 'scanning', mode: 'read', state: 'scanning', scanProgress: progress },
      {
        id: 'impossible-files',
        mode: 'read',
        state: 'scanning',
        scanProgress: { ...progress, filesDone: 11 },
      },
      {
        id: 'impossible-bytes',
        mode: 'read',
        state: 'scanning',
        scanProgress: { ...progress, bytesDone: 4097 },
      },
      {
        id: 'fractional-files',
        mode: 'read',
        state: 'scanning',
        scanProgress: { ...progress, filesDone: 1.5 },
      },
    ]).listMounts()
    expect(mounts).toEqual([
      { id: 'scanning', mode: 'read', state: 'scanning', scanProgress: progress },
    ])
  })

  it.each([undefined, 'default', 'film'])('persists the output for project %s without changing another project', async (project) => {
    const requests: { url: string; init?: RequestInit }[] = []
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://native', clientId: 'test', ...(project === undefined ? {} : { project }), webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) })
      return jsonResponse(200, { mounts: [{ id: 'renders', mode: 'readwrite', state: 'ready' }], outputMount: null, activeOutputMount: null, restartRequired: true, pendingRemovals: ['old'] })
    } })
    await connection.selectOutputMount('renders')
    expect(requests).toEqual([
      { url: `http://native/api/mounts${project === 'film' ? '?project=film' : ''}`, init: { signal: expect.any(AbortSignal) } },
      ...(project === 'film' ? [] : [{
        url: 'http://native/api/mounts/output',
        init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'renders' }) },
      }]),
      {
        url: `http://native/api/mounts/projects/${project ?? 'default'}`,
        init: { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mounts: ['renders'], outputMount: 'renders' }) },
      },
    ])
  })

  it('keeps operator configured and active locations distinct across pending changes', async () => {
    const active = { id: 'plates', path: '/live/plates', mode: 'readwrite', state: 'ready' }
    const payload = { mounts: [{ id: 'plates', path: '/configured/new-plates' }], activeMounts: [active], importMount: 'plates' }
    const { conn } = submitHarness(() => jsonResponse(200, payload))
    expect(await conn.fetchMountLocations()).toEqual(payload)
    const unconfigured = submitHarness(() => jsonResponse(200, { ...payload, importMount: null })).conn
    expect(await unconfigured.fetchMountLocations()).toEqual({ ...payload, importMount: null })
    for (const importMount of ['', false, 12, {}]) {
      const invalid = submitHarness(() => jsonResponse(200, { ...payload, importMount })).conn
      await expect(invalid.fetchMountLocations()).rejects.toThrow('malformed import mount')
    }
    const missingActive = submitHarness(() => jsonResponse(200, { mounts: payload.mounts })).conn
    expect(await missingActive.fetchMountLocations()).toEqual({ mounts: payload.mounts })
    const malformed = submitHarness(() => jsonResponse(200, { ...payload, activeMounts: [{ ...active, mode: 'readonly' }] })).conn
    await expect(malformed.fetchMountLocations()).rejects.toThrow('malformed active mount')
    const forbidden = submitHarness(() => jsonResponse(403, {})).conn
    await expect(forbidden.fetchMountLocations()).rejects.toThrow('403')
  })

  it('queries exact asset locations with local scope and the connection project, rejecting failed or malformed responses', async () => {
    const digest = `blake3:${'a'.repeat(64)}`
    const urls: string[] = []
    let response = jsonResponse(200, { locations: [{ storage: 'mount', path: '/imports/final-2.png' }, { storage: 'vault', path: '/vault/aa/file' }] })
    const conn = new DinksterConnection({ id: C0, project: 'p-film', baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url) => {
      urls.push(String(url))
      return response
    } })
    expect(await conn.fetchAssetLocations(digest)).toEqual(['/imports/final-2.png', '/vault/aa/file'])
    const query = new URL(urls[0]!).searchParams
    expect(Object.fromEntries(query)).toEqual({ digest, scope: 'local', project: 'p-film' })
    response = jsonResponse(403, {})
    await expect(conn.fetchAssetLocations(digest)).rejects.toThrow('403')
    response = jsonResponse(200, { mounts: [] })
    await expect(conn.fetchAssetLocations(digest)).rejects.toThrow('malformed response')
  })

})

describe('runtime settings transport', () => {

  it('preserves structured 400 fields and 403 mutation errors', async () => {
    const replies = [
      jsonResponse(400, { error: 'invalid-settings', category: 'worker-comfy-args', message: 'Dinkster owns --port', offendingFlag: '--port', owner: 'Dinkster server' }),
      jsonResponse(400, { error: 'invalid-settings', category: 'jobs', message: 'jobs.maxRunningJobs must be an integer >= 1' }),
      jsonResponse(400, { error: 'invalid-settings', category: 'worker-comfy-args', message: 'bad flag type', offendingFlag: 42, owner: 'Dinkster server' }),
      jsonResponse(400, { error: 'invalid-settings', category: 'worker-comfy-args', message: 'bad owner type', offendingFlag: '--port', owner: { name: 'Dinkster server' } }),
      jsonResponse(403, { error: 'settings-changes-disabled', category: 'logging', granted: ['jobs'] }),
    ]
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => replies.shift()! })
    await expect(connection.updateRuntimeSetting('worker-comfy-args', ['--port', '8188'])).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ error: 'invalid-settings', offendingFlag: '--port', owner: 'Dinkster server' }),
      message: 'Dinkster owns --port',
      offendingFlag: '--port',
      owner: 'Dinkster server',
    })
    const withoutExtendedFields = connection.updateRuntimeSetting('jobs', { maxRunningJobs: 0 })
    await expect(withoutExtendedFields).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ error: 'invalid-settings' }),
      message: 'jobs.maxRunningJobs must be an integer >= 1',
      offendingFlag: undefined,
      owner: undefined,
    })
    await expect(connection.updateRuntimeSetting('worker-comfy-args', ['--port'])).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ error: 'invalid-settings', owner: 'Dinkster server' }),
      offendingFlag: undefined,
      owner: 'Dinkster server',
    })
    await expect(connection.updateRuntimeSetting('worker-comfy-args', ['--port'])).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ error: 'invalid-settings', offendingFlag: '--port' }),
      offendingFlag: '--port',
      owner: undefined,
    })
    await expect(connection.updateRuntimeSetting('logging', { level: 'info', overrides: {} })).rejects.toMatchObject({ status: 403, body: expect.objectContaining({ error: 'settings-changes-disabled' }), message: 'Changes to logging are not granted (granted: jobs)' })
  })

})

describe('pack settings transport', () => {
  const response = {
    packId: 'pack/one',
    displayName: 'Pack One',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', title: 'Enabled', default: true },
        quality: { type: 'integer', title: 'Quality', default: 2, minimum: 1, maximum: 5 },
      },
      required: ['enabled', 'quality'],
    },
    values: { enabled: true, quality: 2 },
  }

  it('rejects malformed schemas and values instead of exposing partial settings', async () => {
    const replies = [
      { ...response, schema: { ...response.schema, future: true } },
      { ...response, values: { enabled: true, quality: 9 } },
      { ...response, values: { enabled: true, quality: 2**53 } },
    ]
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', fetchFn: async () => jsonResponse(200, replies.shift()) })
    await expect(connection.fetchPackSettings('pack')).rejects.toThrow('pack settings response is malformed')
    await expect(connection.fetchPackSettings('pack')).rejects.toThrow('pack settings response is malformed')
    await expect(connection.fetchPackSettings('pack')).rejects.toThrow('pack settings response is malformed')
  })

  it('surfaces read status and backend mutation errors', async () => {
    const replies = [jsonResponse(503, {}), jsonResponse(400, { error: 'quality must be at most 5' })]
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', fetchFn: async () => replies.shift()! })
    await expect(connection.fetchPackSettings('pack')).rejects.toThrow('pack settings request failed: 503')
    await expect(connection.updatePackSettings('pack', { enabled: true, quality: 9 })).rejects.toThrow('quality must be at most 5')
  })
})

describe('principal permissions transport', () => {

  it('throws a status-bearing error for a failed principal fetch', async () => {
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(403, { error: 'forbidden' }) })
    await expect(connection.fetchPrincipals()).rejects.toMatchObject({ status: 403, message: 'principals request failed: 403' })
  })

  it('carries the server error string on a failed permission update', async () => {
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(404, { error: 'unknown-principal' }) })
    await expect(connection.updatePrincipalPermissions('missing', { edit: true })).rejects.toMatchObject({
      status: 404,
      serverError: 'unknown-principal',
      message: 'unknown-principal',
    })
  })
})

describe('local asset catalog and availability', () => {
  const digest = `blake3:${'a'.repeat(64)}`
  const other = `blake3:${'b'.repeat(64)}`
  const asset = { digest, name: 'final.png', size: 17, mediaType: 'image/png', virtualPath: 'mounts/imports/final.png' }
  const observation = { id: 'upload-1', asset, originalName: 'original.png', kind: 'media/image', origin: { kind: 'upload' }, project: 'film', created: 123.5 }
  const entry = { asset, aliases: ['original.png', 'final.png'], observations: [observation] }
  const harness = () => {
    const requests: { url: string; init?: RequestInit }[] = []
    let payload: unknown = { assets: [entry], cursor: 'next/page' }
    let status = 200
    const conn = new DinksterConnection({ id: C0, project: 'film', baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) })
        return jsonResponse(status, payload)
      },
    })
    return { conn, requests, reply: (value: unknown, code = 200) => { payload = value; status = code } }
  }

  it('rejects malformed and cross-project catalog responses instead of treating them as empty', async () => {
    const { conn, reply } = harness()
    for (const payload of [null, {}, { assets: [null] }, { assets: [entry], cursor: 3 },
      { assets: [{ ...entry, aliases: [42] }] },
      { assets: [{ ...entry, asset: { ...asset, size: -1 } }] },
      ...[{ project: 'other' }, { asset: { ...asset, digest: other } }, { created: 'yesterday' }, { origin: { kind: 3 } }]
        .map((change) => ({ assets: [{ ...entry, observations: [{ ...observation, ...change }] }] })),
    ]) {
      reply(payload)
      await expect(conn.listLocalAssets({ scope: 'local' })).rejects.toThrow('malformed')
    }
    reply({}, 403)
    await expect(conn.listLocalAssets({ scope: 'local' })).rejects.toThrow('403')
  })

  it('checks each exact digest once without project, names, acquisition or writes', async () => {
    const { conn, requests, reply } = harness()
    reply({ assets: [{ digest: other, status: 'missing' }, { digest, status: 'available' }] })
    const signal = new AbortController().signal
    expect(await conn.checkAssetAvailability([digest, other, digest], { scope: 'local', signal })).toEqual([
      { digest, status: 'available' }, { digest: other, status: 'missing' },
    ])
    expect([...new URL(requests[0]!.url).searchParams]).toEqual([['scope', 'local'], ['digest', digest], ['digest', other]])
    expect(requests[0]!.init).toEqual({ signal })
    expect(await conn.checkAssetAvailability([], { scope: 'local' })).toEqual([])
    expect(requests).toHaveLength(1)
  })

  it('keeps absent, duplicate, foreign and invalid availability replies distinct from missing bytes', async () => {
    const { conn, reply } = harness()
    for (const payload of [null, {}, { assets: [] }, { assets: [null] },
      { assets: [{ digest: other, status: 'available' }] },
      { assets: [{ digest, status: 'pending' }] },
      { assets: [{ digest, status: 'missing' }, { digest, status: 'available' }] },
    ]) {
      reply(payload)
      await expect(conn.checkAssetAvailability([digest], { scope: 'local' })).rejects.toThrow(/malformed|incomplete/)
    }
    for (const status of [401, 403, 404, 500]) {
      reply({}, status)
      await expect(conn.checkAssetAvailability([digest], { scope: 'local' })).rejects.toThrow(String(status))
    }
  })
})

describe('asset name guesses', () => {
  it('decodes both candidate flavors, empty lists, future tiers, and sequential batches', async () => {
    const calls: string[][] = []
    const names = Array.from({ length: 65 }, (_, i) => `asset-${i}`)
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { names: string[] }
      calls.push(body.names)
      return jsonResponse(200, { matches: body.names.map((query, i) => ({ query, candidates: i ? [] : [
        { digest: 'blake3:a', name: 'local.png', confidence: 'path', held: true, virtualPath: 'images/local.png', mountId: 'm', size: 12, mediaType: 'image/png' },
        { digest: 'blake3:b', name: 'pack.bin', confidence: 'future-tier', held: false, declaredBy: ['pack.one'], kind: 'model' },
      ] })) })
    } })
    const matches = await connection.guessAssets(names)
    expect(calls.map((call) => call.length)).toEqual([64, 1])
    expect(matches.map((match) => match.query)).toEqual(names)
    expect(matches[0]!.candidates).toEqual([
      expect.objectContaining({ confidence: 'path', virtualPath: 'images/local.png', held: true, size: 12 }),
      expect.objectContaining({ confidence: 'other', declaredBy: ['pack.one'], held: false, kind: 'model' }),
    ])
    expect(matches[1]!.candidates).toEqual([])
  })

  it('decodes digest confidence and sends only canonical hints belonging to each batch', async () => {
    const calls: Array<{ names: string[]; digestHints?: Record<string, string> }> = []
    const names = Array.from({ length: 65 }, (_, i) => `asset-${i}`)
    const upper = `blake3:${'A'.repeat(64)}`
    const lower = `blake3:${'b'.repeat(64)}`
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { names: string[]; digestHints?: Record<string, string> }
      calls.push(body)
      return jsonResponse(200, { matches: body.names.map((query) => ({ query, candidates: query === 'asset-0' ? [
        { digest: lower, name: 'renamed.bin', confidence: 'digest', held: true, virtualPath: 'models/renamed.bin' },
      ] : [] })) })
    } })

    const matches = await connection.guessAssets(names, {
      'asset-0': upper,
      'asset-64': lower,
      'asset-1': 'sha256:' + 'c'.repeat(64),
      'asset-2': 'blake3:short',
      unknown: `blake3:${'d'.repeat(64)}`,
    })

    expect(calls).toEqual([
      { names: names.slice(0, 64), digestHints: { 'asset-0': upper.toLowerCase() } },
      { names: names.slice(64), digestHints: { 'asset-64': lower } },
    ])
    expect(matches[0]!.candidates[0]?.confidence).toBe('digest')
  })

})

/** Two chained std.math.add_ints; no output node, so scope must be partial. */
const CHAIN_DOC = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-dinkster-test',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {
        n0: { id: 'n0', type: 'std.math.add_ints', values: { a: 3, b: 4 } },
        n1: { id: 'n1', type: 'std.math.add_ints', values: { b: 10 } },
      },
      links: {
        l2: { id: 'l2', from: { node: 'n0', port: 'sum' }, to: { node: 'n1', port: 'a' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 3,
    },
  },
  view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } }, n1: { position: { x: 200, y: 0 } } } } } },
  meta: { title: 'native chain' },
}

function chainArtifact(): CompileArtifact {
  const doc = loadDocument(CHAIN_DOC).document as WorkflowDocument
  const result = compile({
    document: doc,
    revision: 1,
    resolve: liveRegistry.resolve,
    scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }] },
    connection: C0,
    schemaHash: liveRegistry.hash,
  })
  if (!result.ok) throw new Error(`fixture compile failed: ${JSON.stringify(result.diagnostics)}`)
  return result.artifact
}

describe('promptToDinksterGraph', () => {
  it('lowers heterogeneous compiler outputs without reconstructing the static catalog order', () => {
    const output = (id: string, type: string) => ({
      role: 'output', id, type: { kind: 'concrete', types: [type] },
    })
    const effective = buildDinksterRegistry(C0, {
      schemaVersion: 1,
      nodes: {
        Source: { schemaVersion: 1, nodeType: 'Source', interface: [output('caption', 'core.str'), output('total', 'INT')] },
        Sink: { schemaVersion: 1, nodeType: 'Sink', interface: [
          { role: 'input', id: 'text', required: true, type: { kind: 'concrete', types: ['core.str'] } },
          { role: 'input', id: 'count', required: true, type: { kind: 'concrete', types: ['INT'] } },
        ] },
      },
    })
    const loaded = loadDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'effective-output-ids', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source: { id: 'source', type: 'Source', values: {} },
          sink: { id: 'sink', type: 'Sink', values: {} },
        },
        links: {
          text: { id: 'text', from: { node: 'source', port: 'caption' }, to: { node: 'sink', port: 'text' } },
          count: { id: 'count', from: { node: 'source', port: 'total' }, to: { node: 'sink', port: 'count' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: {} } } },
    })
    expect(loaded.document).toBeDefined()
    const compiled = compile({
      document: loaded.document!, revision: 1, resolve: effective.resolve,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }] },
      connection: C0, schemaHash: effective.hash,
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (!compiled.ok) throw new Error('unreachable')
    expect(compiled.artifact.prompt.source?.outputIds).toEqual(['caption', 'total'])
    expect(compiled.artifact.prompt.sink?.inputs).toEqual({ text: ['source', 0], count: ['source', 1] })
    for (const declared of [
      [output('placeholder', 'INT')],
      [output('total', 'INT'), output('caption', 'core.str')],
    ]) {
      const catalog = buildDinksterRegistry(C0, {
        schemaVersion: 1,
        nodes: { Source: { schemaVersion: 1, nodeType: 'Source', interface: declared } },
      })
      const native = promptToDinksterGraph(compiled.artifact.prompt, catalog.resolve)
      expect(native.ok).toBe(true)
      if (!native.ok) throw new Error('unreachable')
      expect(native.graph.nodes.sink).toEqual({ nodeType: 'Sink', inputs: {
        text: { $link: { node: 'source', output: 'caption' } },
        count: { $link: { node: 'source', output: 'total' } },
      } })
      expect(native.graph.nodes.source).toEqual({ nodeType: 'Source', inputs: {} })
    }
  })

  it('converts literals as-is and links by producer output ID', () => {
    const prompt: Prompt = {
      n0: { class_type: 'std.math.add_ints', inputs: { a: 3, b: 4 } },
      n1: { class_type: 'std.math.add_ints', inputs: { a: ['n0', 0], b: 10 } },
    }
    const result = promptToDinksterGraph(prompt, registry.resolve)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.graph).toEqual({
      nodes: {
        n0: { nodeType: 'std.math.add_ints', inputs: { a: 3, b: 4 } },
        n1: {
          nodeType: 'std.math.add_ints',
          inputs: { a: { $link: { node: 'n0', output: 'sum' } }, b: 10 },
        },
      },
    })
  })

  it.each([
    { count: undefined, members: [] },
    { count: undefined, members: ['left', 'right'] },
    { count: 2, members: ['0', '1'] },
  ])('lowers output-family members $members with count $count by canonical ID', ({ count, members }) => {
    const dynamicRegistry = buildDinksterRegistry(C0, {
      schemaVersion: 1,
      nodes: {
        Splitter: {
          schemaVersion: 1,
          nodeType: 'Splitter',
          interface: [
            ...(count === undefined ? [] : [{
              role: 'input', id: 'count', required: true, type: { kind: 'concrete', types: ['INT'] },
            }]),
            { role: 'output', id: 'before', type: { kind: 'concrete', types: ['INT'] } },
            {
              role: 'outputFamily', id: 'parts', minMembers: 1, maxMembers: 4,
              type: { kind: 'concrete', types: ['INT'] },
              ...(count === undefined ? {} : { count: { input: 'count', suffix: 'index' } }),
            },
            { role: 'output', id: 'after', type: { kind: 'concrete', types: ['INT'] } },
          ],
        },
      },
    })
    expect(dynamicRegistry.diagnostics).toEqual([])
    const resolve = (type: string) => dynamicRegistry.resolve(type) ?? registry.resolve(type)
    const result = promptToDinksterGraph({
      source: { class_type: 'Splitter', inputs: {}, outputMembers: { parts: ['left', 'right'] } },
      sink: { class_type: 'std.math.add_ints', inputs: { a: ['source', 2], b: 0 } },
    }, resolve)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.graph.nodes.source).toEqual({
      nodeType: 'Splitter', inputs: {}, outputMembers: { parts: ['left', 'right'] },
    })
    expect(result.graph.nodes.sink).toMatchObject({ inputs: { a: { $link: { node: 'source', output: 'parts.right' } } } })

    const loaded = loadDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'manual-output-family', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            source: { id: 'source', type: 'Splitter', values: count === undefined ? {} : { count },
              ...(count === undefined ? { dynamic: { parts: { members } } } : {}),
            },
            sink: { id: 'sink', type: 'std.math.add_ints', values: { b: 0 } },
          },
          links: {
            l0: { id: 'l0', from: { node: 'source', port: 'after' }, to: { node: 'sink', port: 'a' } },
            ...(members.length === 0 ? {} : { l1: {
              id: 'l1', from: { node: 'source', port: count === undefined ? 'parts.parts' : 'parts', members: [members[1]] },
              to: { node: 'sink', port: 'b' },
            } }),
          },
          nets: {}, reroutes: {}, nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: {} } } },
    })
    expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
    const compiled = compile({
      document: loaded.document!, revision: 1, resolve,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }] },
      connection: C0, schemaHash: dynamicRegistry.hash,
    })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (!compiled.ok) throw new Error('unreachable')
    expect(compiled.artifact.prompt.source).toEqual({
      class_type: 'Splitter', inputs: count === undefined ? {} : { count },
      outputIds: ['before', ...members.map((member) => `parts.${member}`), 'after'], outputMembers: { parts: members },
    })
    expect(compiled.artifact.prompt.sink?.inputs.a).toEqual(['source', members.length + 1])
    const native = promptToDinksterGraph(compiled.artifact.prompt, resolve)
    expect(native.ok, JSON.stringify(!native.ok && native.diagnostics)).toBe(true)
    if (!native.ok) throw new Error('unreachable')
    expect(native.graph.nodes.sink).toMatchObject({
      inputs: {
        a: { $link: { node: 'source', output: 'after' } },
        b: members.length === 0 ? 0 : { $link: { node: 'source', output: `parts.${members[1]}` } },
      },
    })
  })

  it('moves recursive DynamicCombo selectors out of native inputs without removing DynamicSlot sockets', () => {
    const dynamicRegistry = buildDinksterRegistry(C0, {
      schemaVersion: 1,
      nodes: {
        Dynamic: {
          schemaVersion: 1,
          nodeType: 'Dynamic',
          interface: [
            {
              role: 'dynamicCombo', id: 'mode', required: true,
              options: [{ key: 'batch', inputs: [{
                role: 'dynamicCombo', id: 'quality', required: true,
                options: [{ key: 'full', inputs: [{
                  role: 'input', id: 'steps', required: false,
                  type: { kind: 'concrete', types: ['INT'] },
                }] }],
              }] }, {
                key: 'plain', inputs: [{
                  role: 'input', id: 'quality', required: false,
                  type: { kind: 'concrete', types: ['STRING'] },
                }],
              }],
            },
            {
              role: 'inputFamily', id: 'items', memberPrefix: 'item',
              template: [{
                role: 'dynamicCombo', id: 'mode', required: true,
                options: [{ key: 'a', inputs: [{
                  role: 'input', id: 'x', required: false,
                  type: { kind: 'concrete', types: ['INT'] },
                }] }],
              }],
            },
            {
              role: 'dynamicSlot', id: 'source', required: false,
              variants: [
                {
                  key: 'text', type: { kind: 'concrete', types: ['STRING'] },
                  inputs: [{
                    role: 'input', id: 'mode', required: false,
                    type: { kind: 'concrete', types: ['STRING'] },
                  }],
                },
                {
                  key: 'advanced', type: { kind: 'concrete', types: ['STRING'] },
                  inputs: [{
                    role: 'dynamicCombo', id: 'mode', required: true,
                    options: [{ key: 'one', inputs: [] }],
                  }],
                },
              ],
              inputs: [],
            },
          ],
        },
      },
    } as unknown as DinksterNodesPayload)
    const prompt: Prompt = {
      n: {
        class_type: 'Dynamic',
        inputs: {
          mode: 'batch',
          'mode.quality': 'full',
          'mode.quality.steps': 2,
          'items.item0.mode': 'a',
          'items.item0.mode.x': 1,
          source: 'text',
          'source.mode': 'ordinary',
        },
        slotVariants: {
          mode: 'batch',
          'mode.quality': 'full',
          'items.item0.mode': 'a',
          source: 'text',
        },
      },
    }
    const result = promptToDinksterGraph(prompt, dynamicRegistry.resolve)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.graph.nodes.n).toEqual({
      nodeType: 'Dynamic',
      inputs: {
        'mode.quality.steps': 2,
        'items.item0.mode.x': 1,
        source: 'text',
        'source.mode': 'ordinary',
      },
      slotVariants: {
        mode: 'batch',
        'mode.quality': 'full',
        'items.item0.mode': 'a',
        source: 'text',
      },
    })

    const reusedPath = promptToDinksterGraph({
      n: {
        class_type: 'Dynamic',
        inputs: { mode: 'plain', 'mode.quality': 'ordinary' },
        slotVariants: { mode: 'plain' },
      },
    }, dynamicRegistry.resolve)
    expect(reusedPath.ok).toBe(true)
    if (!reusedPath.ok) throw new Error('unreachable')
    expect(reusedPath.graph.nodes.n).toEqual({
      nodeType: 'Dynamic',
      inputs: { 'mode.quality': 'ordinary' },
      slotVariants: { mode: 'plain' },
    })
  })

  it('diagnoses links to missing producers and undeclared output indices', () => {
    const prompt: Prompt = {
      n1: { class_type: 'std.math.add_ints', inputs: { a: ['ghost', 0], b: ['n1', 7] } },
    }
    const result = promptToDinksterGraph(prompt, registry.resolve)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics).toHaveLength(2)
    expect(result.diagnostics.every((d) => d.code === 'submit.unresolvedLink')).toBe(true)
  })

  it('preserves an AssetRef from document compile through native graph conversion', () => {
    const asset = {
      digest: 'blake3:' + 'b'.repeat(64),
      name: 'photo.webp',
      size: 1234,
      mediaType: 'image/webp',
      virtualPath: '',
    }
    const assetRegistry = buildDinksterRegistry(C0, {
      schemaVersion: 1,
      nodes: {
        'comfy.LoadImage': {
          schemaVersion: 1,
          nodeType: 'comfy.LoadImage',
          idempotent: false,
          interface: [{
            role: 'input',
            id: 'image',
            required: true,
            type: { kind: 'concrete', types: ['ASSET'] },
            widget: { type: 'ASSET', accept: ['image/webp'] },
          }],
        },
      },
    })
    const raw = structuredClone(CHAIN_DOC) as any
    raw.graphs.g0.nodes = { image: { id: 'image', type: 'comfy.LoadImage', values: { image: asset } } }
    raw.graphs.g0.links = {}
    raw.view.graphs.g0.nodes = { image: { position: { x: 0, y: 0 } } }
    const loaded = loadDocument(raw)
    expect(loaded.document).toBeDefined()
    const doc = loaded.document!
    const compiled = compile({
      document: doc,
      revision: 1,
      resolve: assetRegistry.resolve,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('image') }] },
      connection: C0,
      schemaHash: assetRegistry.hash,
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error('unreachable')
    const native = promptToDinksterGraph(compiled.artifact.prompt, assetRegistry.resolve)
    expect(native.ok).toBe(true)
    if (!native.ok) throw new Error('unreachable')
    const imageNode = native.graph.nodes['image']!
    expect('region' in imageNode ? undefined : imageNode.inputs['image']).toEqual(asset)
  })
})

describe('targetsForArtifact', () => {

  it('selects output-node runtime ids for full scope', () => {
    const prompt: Prompt = {
      a: { class_type: 'std.math.add_ints', inputs: {} }, // idempotent -> not output
      b: { class_type: 'test.types', inputs: {} }, // non-idempotent -> output
    }
    const artifact = { prompt } as unknown as CompileArtifact
    expect(targetsForArtifact(artifact, registry.resolve)).toEqual(['b'])
  })
})

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

function submitHarness(respond: (url: string, init?: RequestInit) => Response | undefined, project?: string) {
  const requests: { url: string; init?: RequestInit }[] = []
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, ...(init ? { init } : {}) })
    const res = respond(url, init)
    if (!res) throw new Error(`unexpected fetch: ${url}`)
    return res
  }
  const conn = new DinksterConnection({
    id: C0,
    baseUrl: 'http://test',
    clientId: 'cid',
    fetchFn,
    jobIdFactory: () => 'job-fixed',
    ...(project !== undefined ? { project } : {}),
  })
  return { conn, requests }
}

const nodesRoute = (url: string): Response | undefined =>
  url.includes('/api/nodes') ? jsonResponse(200, liveNodesPayload) : undefined

describe('library storage accounting', () => {
  const status = { temporaryBytes: 37, vaultBytes: 513, adoptedBytes: 299, reclaimableBytes: null,
    collectionEnabled: false, blocked: ['owner_completeness_unknown'], policyAvailable: true, limitBytes: 8193 }

  it('preserves unknown sizes and unavailable policy instead of inventing zero or unlimited', async () => {
    let body: unknown = status
    const { conn, requests } = submitHarness(() => jsonResponse(200, body))
    expect(await conn.fetchLibraryStorage()).toEqual(status)
    expect(requests[0]!.url).toBe('http://test/api/library/storage')
    expect(requests[0]!.init!.cache).toBe('no-store')
    body = { ...status, policyAvailable: false, limitBytes: null, vaultBytes: null }
    expect(await conn.fetchLibraryStorage()).toEqual(body)
    for (const invalid of [{ ...status, vaultBytes: -1 }, { ...status, temporaryBytes: undefined },
      { ...status, limitBytes: 0 }, { ...status, policyAvailable: false }, { ...status, blocked: [false] }]) {
      body = invalid
      await expect(conn.fetchLibraryStorage()).rejects.toThrow('malformed')
    }
  })

  it('returns cleanup totals and ownership refusals without replaying a failed clear', async () => {
    let body: unknown = { collectionEnabled: true, blocked: [], reclaimedBytes: 113, reclaimedFiles: 2 }
    let code = 200
    const { conn, requests } = submitHarness(() => jsonResponse(code, body))
    expect(await conn.clearLibraryStorage()).toEqual(body)
    expect(requests[0]!.url).toBe('http://test/api/library/storage/clear')
    expect(requests[0]!.init!.method).toBe('POST')
    expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({})
    code = 409
    body = { collectionEnabled: false, blocked: ['owner_completeness_unknown'], reclaimedBytes: 0, reclaimedFiles: 0 }
    expect(await conn.clearLibraryStorage()).toEqual(body)
    for (const invalid of [{ ...body as object, reclaimedBytes: -1 },
      { ...body as object, reclaimedFiles: 1.5 }, { ...body as object, blocked: [] },
      { ...body as object, collectionEnabled: true }]) {
      body = invalid
      await expect(conn.clearLibraryStorage()).rejects.toThrow('malformed')
    }
    code = 503
    const count = requests.length
    await expect(conn.clearLibraryStorage()).rejects.toThrow('503')
    expect(requests).toHaveLength(count + 1)
  })

  it('requires an exact policy acknowledgment and does not replay failed writes', async () => {
    let body: unknown = { limitBytes: 8193, collectionEnabled: false }
    let code = 200
    const { conn, requests } = submitHarness(() => jsonResponse(code, body))
    await conn.updateLibraryStorageLimit(8193)
    expect(requests[0]!.url).toBe('http://test/api/library/storage/policy')
    expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({ limitBytes: 8193 })
    body = { limitBytes: null, collectionEnabled: false }
    await conn.updateLibraryStorageLimit(null)
    await expect(conn.updateLibraryStorageLimit(8193)).rejects.toThrow('differs')
    body = { limitBytes: 8193, collectionEnabled: true }
    await expect(conn.updateLibraryStorageLimit(8193)).rejects.toThrow('differs')
    code = 403
    await expect(conn.updateLibraryStorageLimit(8193)).rejects.toThrow('403')
    const count = requests.length
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(conn.updateLibraryStorageLimit(invalid)).rejects.toThrow('positive safe integer')
    }
    expect(requests).toHaveLength(count)
  })
})

describe('retained asset ownership', () => {
  const a = `blake3:${'a'.repeat(64)}`
  const b = `blake3:${'b'.repeat(64)}`
  const owner = { scope: 'team/one', ownerKind: 'document' as const, ownerId: 'window/tab generation' }
  const manifest = { ...owner, revision: 8, digests: [a, b], complete: true }

  it('reads sealed terminal authority with exact client, job, attempt and publication identities', async () => {
    const output = { token: 'a'.repeat(32), scope: owner.scope, jobRef: 'job/ref', attemptId: 2,
      nodeId: 'loop[3]', outputId: 'images', publication: 7, digests: [a, b], complete: true }
    const artifact = { ...output, token: 'b'.repeat(32), outputId: undefined,
      artifact: { nodeId: output.nodeId, index: 0, digest: b, name: 'saved.png',
        size: 19, mediaType: 'image/png', virtualPath: 'outputs/saved.png' }, digests: [b] }
    const wire = { scope: owner.scope, jobRef: output.jobRef, attemptId: 2, state: 'completed', complete: true,
      identity: { clientId: 'cid', jobId: 'j1' }, resultOffers: { [output.nodeId]: { images: output } }, artifacts: [artifact] }
    const { conn, requests } = submitHarness(() => jsonResponse(200, wire))
    expect(await conn.fetchTerminalResultAssets(output.jobRef, 'j1', owner.scope)).toEqual({
      scope: owner.scope, jobRef: output.jobRef, attemptId: 2, state: 'completed', complete: true,
      offers: [output, { token: artifact.token, scope: owner.scope, jobRef: output.jobRef, attemptId: 2,
        nodeId: output.nodeId, publication: 7, digests: [b], complete: true, artifact: artifact.artifact }],
    })
    expect(requests[0]!.url).toBe('http://test/api/library/terminal-results/job%2Fref?scope=team%2Fone')
    expect(requests[0]!.init?.cache).toBe('no-store')
    for (const mismatch of [
      { scope: 'foreign' }, { jobRef: 'foreign' }, { attemptId: 3 }, { state: 'running' },
      { identity: { clientId: 'other', jobId: 'j1' } }, { identity: { clientId: 'cid', jobId: 'other' } },
      { resultOffers: { foreign: { images: output } } }, { resultOffers: { [output.nodeId]: { other: output } } },
      { resultOffers: { [output.nodeId]: { images: { ...output, complete: false } } } },
      { artifacts: [{ ...artifact, token: output.token }] }, { artifacts: [{ ...artifact, artifact: { ...artifact.artifact, index: 1 } }] },
      { artifacts: null }, { artifacts: undefined }, { complete: undefined }, { state: 'failed' },
    ]) {
      const { conn: invalid } = submitHarness(() => jsonResponse(200, { ...wire, ...mismatch }))
      await expect(invalid.fetchTerminalResultAssets(output.jobRef, 'j1', owner.scope)).rejects.toThrow('Terminal result assets')
    }
    const { conn: partial } = submitHarness(() => jsonResponse(200, { ...wire, complete: false, state: 'failed', artifacts: null }))
    expect(await partial.fetchTerminalResultAssets(output.jobRef, 'j1', owner.scope)).toMatchObject({ complete: false, offers: [output] })
    const { conn: missing } = submitHarness(() => jsonResponse(404, { available: false }))
    expect(await missing.fetchTerminalResultAssets(output.jobRef, 'j1', owner.scope)).toBeUndefined()
    const { conn: unavailable } = submitHarness(() => jsonResponse(503, {}))
    await expect(unavailable.fetchTerminalResultAssets(output.jobRef, 'j1', owner.scope)).rejects.toThrow('failed: 503')
  })

  it('reads exact immutable output and artifact offers without substituting missing or malformed roots', async () => {
    const token = '0123456789abcdef'.repeat(2)
    const base = { token, scope: owner.scope, jobRef: 'original-job', attemptId: 2, nodeId: 'loop[3]/saved',
      publication: 7, digests: [a, b], complete: true }
    const output = { ...base, outputId: 'images' }
    const artifact = { ...base, artifact: { nodeId: base.nodeId, index: 3, digest: a, name: 'saved.png',
      size: 19, mediaType: 'image/png', virtualPath: 'outputs/saved.png',
      preview: { digest: b, name: 'poster.png', size: 5, mediaType: 'image/png', virtualPath: `previews/${b.slice(7)}/poster.png` } } }
    for (const offer of [output, artifact, { ...output, complete: false }]) {
      const { conn, requests } = submitHarness(() => jsonResponse(200, offer))
      expect(await conn.fetchResultAssetOffer(owner.scope, token)).toEqual(offer)
      expect(requests[0]!.url).toBe(`http://test/api/library/result-offers/${token}?scope=team%2Fone`)
      expect(requests[0]!.init?.cache).toBe('no-store')
    }
    for (const offer of [
      { ...output, scope: 'foreign' }, { ...output, token: 'f'.repeat(32) },
      { ...output, token: `${token}\n` }, { ...output, digests: [`${a}\n`, b] },
      { ...output, digests: [b, a] }, { ...output, digests: undefined },
      { ...output, complete: undefined }, { ...output, attemptId: 0 },
      { ...output, artifact: artifact.artifact }, { ...artifact, digests: [a] },
      { ...artifact, artifact: { ...artifact.artifact, nodeId: 'foreign' } },
    ]) {
      const { conn } = submitHarness(() => jsonResponse(200, offer))
      await expect(conn.fetchResultAssetOffer(owner.scope, token)).rejects.toThrow('Result asset offer')
    }
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.fetchResultAssetOffer(owner.scope, token)).toBeUndefined()
    const { conn: unavailable } = submitHarness(() => jsonResponse(503, {}))
    await expect(unavailable.fetchResultAssetOffer(owner.scope, token)).rejects.toThrow('failed: 503')
  })

  it('acknowledges canonical sets at the exact scoped owner and revision', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, manifest))
    expect(await conn.retainAssets(owner, { revision: 7, digests: [b, a, b], complete: true }))
      .toEqual(manifest)
    expect(requests[0]!.url).toBe('http://test/api/library/retentions/document/window%2Ftab%20generation?scope=team%2Fone')
    expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({
      revision: 7, digests: [a, b], complete: true,
    })
    expect(requests[0]!.init!.method).toBe('PUT')
    expect(await conn.fetchRetainedAssets(owner)).toEqual(manifest)
    expect(requests[1]!.init?.method).toBe('GET')
    expect(requests[1]!.init?.cache).toBe('no-store')
  })

  it('preserves explicit multi-class membership across writes, source claims and exact release', async () => {
    const admitted = { ...owner, holderClasses: [3, 1] as const }
    let response = manifest
    const { conn, requests } = submitHarness(() => jsonResponse(200, { ...response, holderClasses: [8] }))
    const receipt = await conn.retainAssets(admitted, { revision: 7, digests: [a, b], complete: true })
    expect(receipt.holderClasses).toEqual([3, 1])
    expect(Object.isFrozen(receipt.holderClasses)).toBe(true)
    response = { ...manifest, revision: 9, digests: [] }
    await conn.releaseRetainedAssets(receipt, 8)
    expect(requests.map(({ init }) => new Headers(init?.headers).get('X-Dinkster-Retention-Holder')))
      .toEqual(['1,3', '1,3'])
    const sourceToken = 'a'.repeat(32)
    const resultOwner = { ...admitted, ownerKind: 'shown-result' as const, holderClasses: [6, 5] as const }
    const claimed = { ...resultOwner, revision: 1, digests: [a], complete: true, sourceToken }
    const source = submitHarness(() => jsonResponse(200, claimed))
    expect((await source.conn.claimResultAssets(resultOwner, sourceToken)).holderClasses).toEqual([6, 5])
    expect(new Headers(source.requests[0]!.init?.headers).get('X-Dinkster-Retention-Holder')).toBe('5,6')
    // Wire fields cannot supply authority absent from the caller's admitted lifetime.
    const legacy = submitHarness(() => jsonResponse(200, { ...manifest, holderClasses: [1, 3] }))
    expect((await legacy.conn.fetchRetainedAssets(owner))?.holderClasses).toBeUndefined()
    expect((await legacy.conn.retainAssets(owner, { revision: 7, digests: [a, b], complete: true })).holderClasses).toBeUndefined()
    expect(new Headers(legacy.requests[1]!.init?.headers).has('X-Dinkster-Retention-Holder')).toBe(false)
  })

  it('refuses empty, duplicate and invalid holder membership before sending a mutation', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, manifest))
    for (const holderClasses of [[], [1, 1], [0], [9], [1.5]]) {
      const invalid = { ...owner, holderClasses } as Parameters<typeof conn.retainAssets>[0]
      await expect(conn.retainAssets(invalid, { revision: 7, digests: [a, b], complete: true })).rejects.toThrow('holder classes')
      await expect(conn.releaseRetainedAssets(invalid, 8)).rejects.toThrow('holder classes')
      await expect(conn.claimResultAssets({ ...invalid, ownerKind: 'shown-result' }, 'a'.repeat(32))).rejects.toThrow('holder classes')
    }
    expect(requests).toHaveLength(0)
  })

  it('does not accept a different owner, set, completeness or mutation revision', async () => {
    for (const mismatch of [
      { scope: 'other' }, { ownerKind: 'preview' }, { ownerId: 'another generation' },
      { revision: 7 }, { revision: 9 }, { digests: [a] }, { digests: [b, a] },
      { digests: [a, a] }, { complete: false }, { complete: undefined },
    ]) {
      const { conn } = submitHarness(() => jsonResponse(200, { ...manifest, ...mismatch }))
      await expect(conn.retainAssets(owner, { revision: 7, digests: [a, b], complete: true }))
        .rejects.toThrow('acknowledgment')
    }
  })

  it('distinguishes a missing owner from conflicts and unavailable state without retrying writes', async () => {
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.fetchRetainedAssets(owner)).toBeUndefined()
    for (const status of [404, 409, 503]) {
      const { conn, requests } = submitHarness(() => jsonResponse(status, {}))
      await expect(conn.retainAssets(owner, { revision: 0, digests: [], complete: false }))
        .rejects.toThrow(`failed: ${status}`)
      expect(requests).toHaveLength(1)
    }
    const { conn: unavailable } = submitHarness(() => jsonResponse(503, {}))
    await expect(unavailable.fetchRetainedAssets(owner)).rejects.toThrow('failed: 503')
    const { conn: lost, requests } = submitHarness((_url, init) => {
      if (init?.method === 'PUT') throw new TypeError('response lost after commit')
      return jsonResponse(200, manifest)
    })
    await expect(lost.retainAssets(owner, { revision: 7, digests: [a, b], complete: true }))
      .rejects.toThrow('response lost after commit')
    expect(requests).toHaveLength(1)
    expect(await lost.fetchRetainedAssets(owner)).toEqual(manifest)
    expect(requests.map((request) => request.init?.method)).toEqual(['PUT', 'GET'])
  })

  it('rejects missing, foreign, malformed or reused source acknowledgments', async () => {
    const sourceToken = '0123456789abcdef'.repeat(2)
    const resultOwner = { ...owner, ownerKind: 'shown-result' as const }
    const claimed = { ...resultOwner, revision: 1, digests: [a], complete: true, sourceToken }
    for (const mismatch of [
      { sourceToken: undefined }, { sourceToken: 'f'.repeat(32) }, { sourceToken: null },
      { sourceToken: 'bad-token' }, { revision: 2 }, { scope: 'other' },
      { digests: [b, a] }, { complete: undefined },
    ]) {
      const { conn } = submitHarness(() => jsonResponse(200, { ...claimed, ...mismatch }))
      await expect(conn.claimResultAssets(resultOwner, sourceToken)).rejects.toThrow('acknowledgment')
    }
    const { conn, requests } = submitHarness(() => jsonResponse(200, claimed))
    await expect(conn.claimResultAssets(owner, sourceToken)).rejects.toThrow('Invalid result asset claim')
    await expect(conn.claimResultAssets(resultOwner, sourceToken.toUpperCase())).rejects.toThrow('Invalid result asset claim')
    await expect(conn.claimResultAssets(resultOwner, `${sourceToken}\n`)).rejects.toThrow('Invalid result asset claim')
    expect(requests).toHaveLength(0)
  })

  it('uses response metadata when releasing and rereading a source-bound receipt', async () => {
    const resultOwner = { ...owner, ownerKind: 'shown-result' as const }
    const sourceToken = '0123456789abcdef'.repeat(2)
    const claimed = { ...resultOwner, revision: 1, digests: [a], complete: true, sourceToken }
    const released = { ...resultOwner, revision: 2, digests: [], complete: true }
    let response = claimed as typeof claimed | typeof released
    const { conn } = submitHarness(() => jsonResponse(200, response))
    const receipt = await conn.claimResultAssets(resultOwner, sourceToken)
    expect(receipt).toEqual(claimed)
    expect(await conn.fetchRetainedAssets(receipt)).toEqual(claimed)
    response = released
    expect(await conn.releaseRetainedAssets(receipt, receipt.revision)).toEqual(released)
    expect(await conn.fetchRetainedAssets(receipt)).toEqual(released)
    response = { ...claimed, sourceToken: 'f'.repeat(32) }
    expect(await conn.fetchRetainedAssets(receipt)).toEqual(response)
  })

  it('preserves incomplete ownership and requires an empty next-revision release acknowledgment', async () => {
    const incomplete = { ...owner, revision: 1, digests: [b], complete: false }
    const { conn } = submitHarness(() => jsonResponse(200, incomplete))
    expect(await conn.retainAssets(owner, { revision: 0, digests: [b], complete: false })).toEqual(incomplete)
    const released = { ...owner, revision: 2, digests: [], complete: true }
    const { conn: releasing, requests } = submitHarness(() => jsonResponse(200, released))
    expect(await releasing.releaseRetainedAssets(owner, 1)).toEqual(released)
    expect(requests[0]!.url).toContain('?scope=team%2Fone&revision=1')
    expect(requests[0]!.init!.method).toBe('DELETE')
    for (const mismatch of [{ digests: [a] }, { complete: false }, { revision: 1 }, { sourceToken: 'a'.repeat(32) }]) {
      const { conn: invalid } = submitHarness(() => jsonResponse(200, { ...released, ...mismatch }))
      await expect(invalid.releaseRetainedAssets(owner, 1)).rejects.toThrow('acknowledgment')
    }
  })

})

const regionNodesPayload = currentNodesPayload({
  version: 'test', schemaWire: 1, graphFeatures: ['regions'],
})
const regionNodesRoute = (url: string): Response | undefined =>
  url.includes('/api/nodes') ? jsonResponse(200, regionNodesPayload) : undefined
const placementNodesPayload = currentNodesPayload({
  version: 'test', schemaWire: 1, graphFeatures: ['placement'],
})
const placementNodesRoute = (url: string): Response | undefined =>
  url.includes('/api/nodes') ? jsonResponse(200, placementNodesPayload) : undefined

describe('worker catalog', () => {

  it('reports a failed worker request by status', async () => {
    const { conn } = submitHarness((url) =>
      url.endsWith('/api/workers') ? jsonResponse(503, {}) : undefined)
    await expect(conn.fetchWorkers()).rejects.toThrow('GET /api/workers failed: 503')
  })
})

describe('fetchSchemas wire contract', () => {

  it('refuses a backend selecting another wire version', async () => {
    const { conn } = submitHarness((url) => url.includes('/api/nodes')
      ? jsonResponse(200, {
          schemaVersion: 1,
          dinkster: { version: 'incompatible', schemaWire: 2 },
          nodes: {},
        })
      : undefined)
    await expect(conn.fetchSchemas()).rejects.toThrow(
      'schema wire version mismatch: this build decodes 1; the server encodes 2',
    )
    expect(conn.currentRegistry).toBeUndefined()
  })

})

describe('fetchSchemas payload validation (CL5)', () => {
  it('installs the serializer fixture with streaming policies intact', async () => {
    const exports = readJson('fixtures/dinkster-wire41.json') as Record<string, unknown>[]
    const payload = {
      schemaVersion: 1,
      dinkster: { version: 'fixture', schemaWire: 1 },
      nodes: Object.fromEntries(exports.map((schema) => [schema['nodeType'], { ...schema, schemaVersion: 1 }])),
    }
    const { conn } = submitHarness((url) =>
      url.includes('/api/nodes') ? jsonResponse(200, payload) : undefined,
    )
    const installed = await conn.fetchSchemas()
    expect(installed.schemas.size).toBe(4)
    expect(installed.resolve('test.stream_source')?.items[0]).toMatchObject({
      kind: 'output', type: { kind: 'stream', element: { kind: 'concrete', name: 'IMAGE' } },
    })
    expect(installed.resolve('test.stream_sink')?.items[0]).toMatchObject({ acceptsStream: true })
    expect(installed.resolve('test.chunk_map')?.chunkSafe).toEqual({ inputs: ['image'], outputs: ['image'] })
    expect(installed.resolve('test.scoped')?.chunkSafe).toEqual({
      inputs: ['image'], outputs: ['image'], applies: { operation: ['map'] },
    })
  })

  it('rejects a malformed nodes table instead of installing an empty registry', async () => {
    const { conn } = submitHarness((url) =>
      url.includes('/api/nodes') ? jsonResponse(200, { schemaVersion: 1, nodes: 'bad' }) : undefined,
    )
    await expect(conn.fetchSchemas()).rejects.toThrow('malformed or unsupported')
    expect(conn.currentRegistry).toBeUndefined()
  })

  it('a stale schema response cannot overwrite a fresher registry', async () => {
    const resolvers: ((res: Response) => void)[] = []
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn: () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        }),
    })
    const stale = conn.fetchSchemas()
    const fresh = conn.fetchSchemas()
    resolvers[1]!(jsonResponse(200, liveNodesPayload)) // newest request resolves first
    const freshRegistry = await fresh
    resolvers[0]!(jsonResponse(200, { schemaVersion: 1, nodes: {} })) // superseded response lands late
    // The superseded invocation must return the committed registry too: its
    // own decode is stale and would split compile state from submit state.
    expect(await stale).toBe(freshRegistry)
    expect(conn.currentRegistry).toBe(freshRegistry)
  })

  it('a superseded schema fetch failure is answered by the fresher fetch', async () => {
    const resolvers: ((res: Response) => void)[] = []
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'cid',
      fetchFn: () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve)
        }),
    })
    const stale = conn.fetchSchemas()
    const fresh = conn.fetchSchemas()
    resolvers[0]!(jsonResponse(503, {})) // superseded request fails
    resolvers[1]!(jsonResponse(200, liveNodesPayload))
    const freshRegistry = await fresh
    expect(await stale).toBe(freshRegistry)
  })
})

describe('F0 atomic schema/snapshot pairing', () => {

  it('refetches both surfaces after a digest mismatch and never commits the mixed pair', async () => {
    const stale = await snapshotFixture('pack.stale')
    const fresh = await snapshotFixture('pack.fresh')
    let nodeFetches = 0
    const conn = new DinksterConnection({
      id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url) => {
        if (url.includes('/api/nodes')) {
          nodeFetches += 1
          return jsonResponse(200, { ...liveNodesPayload, extensionSnapshotDigest: nodeFetches === 1 ? stale.digest : fresh.digest })
        }
        return new Response(fresh.body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
    const paired = await conn.fetchSchemas()
    expect(nodeFetches).toBe(2)
    expect(paired.extensionSnapshotPair?.digest).toBe(fresh.digest)
    expect(paired.extensionSnapshotPair?.snapshot.extensions[0]?.id).toBe('pack.fresh')
    expect(conn.currentRegistry).toBe(paired)
  })

  it.each([true, false])('revokes custom-event authority on invalidation with a current pair: %s', async (hasCurrentPair) => {
    const fixture = await snapshotFixture('pack.old')
    let includePair = true
    const conn = new DinksterConnection({
      id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url) => url.includes('/api/nodes')
        ? jsonResponse(200, { ...liveNodesPayload, ...(includePair ? { extensionSnapshotDigest: fixture.digest } : {}) })
        : new Response(fixture.body, { status: 200 }),
    })
    const received: NormalizedEvent[] = []
    conn.onEvent((event) => { if (event.kind === 'extensionEvent') received.push(event) })
    const event = {
      type: 'node_event', jobId: 'job', runId: 'run', seq: 0, event: 'pack.old.observed',
      pack: 'pack.old', schemaVersion: 1, extensionSnapshotDigest: fixture.digest, data: { value: 1 },
    }
    await conn.fetchSchemas()
    conn.ingest(event)
    expect(received).toHaveLength(1)
    if (!hasCurrentPair) {
      includePair = false
      await conn.fetchSchemas()
      expect(conn.currentRegistry?.extensionSnapshotPair).toBeUndefined()
    }
    conn.invalidateExtensionSnapshotPair()
    conn.ingest(event)
    expect(received).toHaveLength(1)
    includePair = true
    await conn.fetchSchemas()
    conn.ingest(event)
    expect(received).toHaveLength(2)
  })

  it('prevents an old-lifetime in-flight fetch from restoring the invalidated pair', async () => {
    const fixture = await snapshotFixture('pack.old')
    let nodeRequests = 0
    let resolveOldNodes!: () => void
    const conn = new DinksterConnection({
      id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url) => {
        if (url.includes('/api/nodes')) {
          nodeRequests += 1
          if (nodeRequests === 2) await new Promise<void>((resolve) => { resolveOldNodes = resolve })
          return jsonResponse(200, { ...liveNodesPayload, extensionSnapshotDigest: fixture.digest })
        }
        return new Response(fixture.body, { status: 200 })
      },
    })
    await conn.fetchSchemas()
    const oldLifetimeFetch = conn.fetchSchemas()
    await vi.waitFor(() => expect(nodeRequests).toBe(2))
    conn.invalidateExtensionSnapshotPair()
    resolveOldNodes()
    await expect(oldLifetimeFetch).rejects.toThrow('schema fetch invalidated by server reconnect')
    expect(conn.currentRegistry?.extensionSnapshotPair).toBeUndefined()
    const received: NormalizedEvent[] = []
    conn.onEvent((event) => { if (event.kind === 'extensionEvent') received.push(event) })
    conn.ingest({
      type: 'node_event', jobId: 'job', seq: 0, event: 'pack.old.observed', pack: 'pack.old',
      schemaVersion: 1, extensionSnapshotDigest: fixture.digest, data: { value: 1 },
    })
    expect(received).toHaveLength(0)
  })

  it('pairs the snapshot without crypto.subtle (insecure LAN/tailnet origins)', async () => {
    // crypto.subtle is undefined outside secure contexts (plain HTTP on a
    // non-localhost host). The digest check must fall back to the
    // dependency-free SHA-256 instead of throwing "reading 'digest'".
    const fixture = await snapshotFixture('pack.insecure')
    const realCrypto = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    try {
      const conn = new DinksterConnection({
        id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
        fetchFn: async (url) => url.includes('/api/nodes')
          ? jsonResponse(200, { ...liveNodesPayload, extensionSnapshotDigest: fixture.digest })
          : new Response(fixture.body, { status: 200 }),
      })
      const paired = await conn.fetchSchemas()
      expect(paired.extensionSnapshotPair?.digest).toBe(fixture.digest)
      expect(paired.extensionSnapshotPair?.snapshot.extensions[0]?.id).toBe('pack.insecure')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('cancel ownership (CL7)', () => {
  it.each(['running', 'cancelled', 'completed', 'failed'] as const)('returns the actual %s outcome instead of inventing cancellation', async (state) => {
    const { conn } = submitHarness(() => jsonResponse(200, { jobId: 'j1', state, nodes: {} }))
    const events: NormalizedEvent[] = []
    conn.onEvent((event) => events.push(event))
    await expect(conn.cancel(ref('j1'))).resolves.toBe(state)
    expect(events.map((event) => event.kind)).toEqual(
      state === 'running' ? [] : [state === 'failed' ? 'error' : state],
    )
  })

  it('surfaces a failed cancel response instead of resolving', async () => {
    const { conn } = submitHarness(() => jsonResponse(500, {}))
    await expect(conn.cancel(ref('j1'))).rejects.toMatchObject({
      diagnostic: {
        code: 'execution.cancel.http-500',
        data: { status: 500, code: 'http-500', operation: 'cancel' },
      },
    })
  })

  it.each([
    ['cancel', (conn: DinksterConnection) => conn.cancel(ref('j1'))],
    ['inspect', (conn: DinksterConnection) => conn.fetchJob('j1')],
    ['outputs', (conn: DinksterConnection) => conn.fetchJobOutputs('j1')],
  ] as const)('preserves %s authorization denials in thrown diagnostics', async (operation, request) => {
    const { conn } = submitHarness(() => jsonResponse(403, {
      error: 'capability-required',
      message: `missing permission for ${operation}`,
      capability: operation === 'cancel' ? 'jobs:cancel' : 'jobs:read',
      scope: 'shared',
    }))

    await expect(request(conn)).rejects.toMatchObject({
      diagnostic: {
        code: `execution.${operation}.capability-required`,
        message: `missing permission for ${operation}`,
        data: {
          status: 403,
          code: 'capability-required',
          operation,
          scope: 'shared',
        },
      },
    })
  })
})

describe('read absence semantics (CL8)', () => {

  it('throws on 503 instead of reporting absence', async () => {
    const { conn } = submitHarness(() => jsonResponse(503, {}))
    await expect(conn.fetchAssetText('blake3:abc')).rejects.toThrow('failed: 503')
    await expect(conn.getLibraryRecord('id1', 'local')).rejects.toThrow('failed: 503')
    await expect(conn.getHistoryRun('r1', 'local')).rejects.toThrow('failed: 503')
    await expect(conn.fetchTemplateBody('pack', 'tpl')).rejects.toThrow('failed: 503')
  })

  it('treats a malformed successful record body as a protocol error, not absence', async () => {
    const { conn } = submitHarness(() => jsonResponse(200, { nope: true }))
    await expect(conn.getLibraryRecord('id1', 'local')).rejects.toThrow('malformed response')
    await expect(conn.getHistoryRun('r1', 'local')).rejects.toThrow('malformed response')
  })
})

describe('fetchDiagnostics', () => {
  const problem = {
    carrier: 'pack.old_node',
    from: 'pack.old_node',
    caseIndex: 0,
    ref: 'image',
    refKind: 'input' as const,
    target: 'pack.new_node',
    message: 'input image is unavailable',
  }
  const compatSkip = {
    packId: 'comfy',
    nodeId: 'CreateList',
    reason: "V3 Autogrow input 'inputs' has unsupported nested dynamic marker COMFY_MATCHTYPE_V3",
  }

  it('decodes replacement problems and compat skips from one diagnostics snapshot', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, {
      replacementProblems: [problem],
      compatSkips: [compatSkip],
    }))
    expect(await conn.fetchDiagnostics()).toEqual({
      replacementProblems: [problem],
      compatSkips: [compatSkip],
      packInferenceUnavailable: [],
    })
    expect(requests[0]?.url).toBe('http://test/api/diagnostics')
  })

  it('returns an empty diagnostics snapshot for a non-ok response', async () => {
    const { conn } = submitHarness(() => jsonResponse(404, { error: 'not found' }))
    expect(await conn.fetchDiagnostics()).toEqual({ replacementProblems: [], compatSkips: [], packInferenceUnavailable: [] })
  })

  it('decodes packInferenceUnavailable rows, taking the pack id from each row', async () => {
    const { conn } = submitHarness(() => jsonResponse(200, {
      packInferenceUnavailable: [
        {
          packId: 'pack.degraded',
          reason: 'No live native sampling worker (dinkster.ksampler) is registered.',
          entry: 'sampler',
          worker: 'dinkster.ksampler',
          providers: [{ registry: 'sampler', id: 'euler', available: false, extra: 'ignored' }],
        },
      ],
    }))
    expect(await conn.fetchDiagnostics()).toEqual({
      replacementProblems: [],
      compatSkips: [],
      packInferenceUnavailable: [{
        pack: 'pack.degraded',
        reason: 'No live native sampling worker (dinkster.ksampler) is registered.',
        entry: 'sampler',
        worker: 'dinkster.ksampler',
        providers: [{ registry: 'sampler', id: 'euler' }],
      }],
    })
  })

})

describe('fetchCompositionFailures', () => {
  it('returns every failed pack from the process-lifetime snapshot', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, {
      epoch: 8,
      packs: {
        ready: { state: 'announced', epoch: 3 },
        waiting: { state: 'pending' },
        removed: { state: 'removed', epoch: 7 },
        compat: { state: 'failed', error: 'worker exited', future: true },
        generation: { state: 'failed', error: 'schema-only nodes have no provider' },
      },
      future: true,
    }))

    await expect(conn.fetchCompositionFailures()).resolves.toEqual([
      { pack: 'compat', error: 'worker exited' },
      { pack: 'generation', error: 'schema-only nodes have no provider' },
    ])
    expect(requests[0]?.url).toBe('http://test/api/composition')
  })

  it('returns an authoritative empty list after failures heal', async () => {
    const { conn } = submitHarness(() => jsonResponse(200, {
      epoch: 9,
      packs: { compat: { state: 'announced', epoch: 9 } },
    }))
    await expect(conn.fetchCompositionFailures()).resolves.toEqual([])
  })

  it('keeps unavailable and older-backend responses non-authoritative', async () => {
    const absent = submitHarness(() => jsonResponse(404, {})).conn
    const unreachable = submitHarness(() => undefined).conn
    await expect(absent.fetchCompositionFailures()).resolves.toBeUndefined()
    await expect(unreachable.fetchCompositionFailures()).resolves.toBeUndefined()
  })
})

describe('submit', () => {

  it('refuses placement locally when capability is absent or a hinted node is not top-level', async () => {
    const unsupported = submitHarness(nodesRoute)
    await unsupported.conn.fetchSchemas()
    const unsupportedResult = await unsupported.conn.submit(chainArtifact(), { placement: { n0: 'local' } })
    expect(unsupportedResult.ok).toBe(false)
    if (unsupportedResult.ok) throw new Error('unreachable')
    expect(unsupportedResult.diagnostics[0]?.code).toBe('submit.placementUnsupported')
    expect(unsupported.requests.some((request) => request.init?.method === 'POST')).toBe(false)

    const invalid = submitHarness(placementNodesRoute)
    await invalid.conn.fetchSchemas()
    const invalidResult = await invalid.conn.submit({
      ...chainArtifact(),
      schemaHash: buildDinksterRegistry(C0, placementNodesPayload).hash,
    }, { placement: { 'nested/body': 'render-box' } })
    expect(invalidResult.ok).toBe(false)
    if (invalidResult.ok) throw new Error('unreachable')
    expect(invalidResult.diagnostics[0]?.code).toBe('submit.placementInvalid')
    expect(invalid.requests.some((request) => request.init?.method === 'POST')).toBe(false)

    for (const special of ['constructor', 'toString', '__proto__']) {
      const placement = Object.fromEntries([[special, 'render-box']])
      const result = await invalid.conn.submit({
        ...chainArtifact(),
        schemaHash: buildDinksterRegistry(C0, placementNodesPayload).hash,
      }, { placement })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.diagnostics[0]?.code).toBe('submit.placementInvalid')
    }
    expect(invalid.requests.some((request) => request.init?.method === 'POST')).toBe(false)
  })

  it('keeps placement unchanged when a missing-assets submission is retried', async () => {
    let posts = 0
    const { conn, requests } = submitHarness((url, init) =>
      placementNodesRoute(url) ??
      (url.endsWith('/api/jobs') && init?.method === 'POST'
        ? ++posts === 1
          ? jsonResponse(409, {
              error: 'assets-missing',
              assets: [{ digest: `blake3:${'a'.repeat(64)}`, name: 'model', status: 'missing', sources: ['https://assets.test/model'], fetchable: true }],
            })
          : jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' })
        : undefined))
    await conn.fetchSchemas()
    const placement = { n1: 'render-box' }
    const first = await conn.submit({
      ...chainArtifact(),
      schemaHash: buildDinksterRegistry(C0, placementNodesPayload).hash,
    }, { placement })
    expect(first.ok).toBe(false)
    if (first.ok || !('retryWithAssets' in first)) throw new Error('expected an assets-missing retry')

    placement.n1 = 'changed-after-submit'
    expect((await first.retryWithAssets([`blake3:${'a'.repeat(64)}`])).ok).toBe(true)
    const bodies = requests
      .filter((request) => request.init?.method === 'POST')
      .map((request) => JSON.parse(request.init!.body as string) as Record<string, unknown>)
    expect(bodies.map((body) => body['placement'])).toEqual([
      { n1: 'render-box' },
      { n1: 'render-box' },
    ])
  })

  it('POSTs the converted graph with explicit targets and client-owned job id', async () => {
    const { conn, requests } = submitHarness(
      (url, init) =>
        nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' })
          : undefined),
    )
    await conn.fetchSchemas()
    const result = await conn.submit(chainArtifact())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.execution).toEqual(ref('job-fixed'))
    const post = requests.find((r) => r.init?.method === 'POST')!
    const body = JSON.parse(post.init!.body as string) as Record<string, unknown>
    expect(body['clientId']).toBe('cid')
    expect(body['jobId']).toBe('job-fixed')
    expect(body['targets']).toEqual(['n1'])
    expect(body['graph']).toEqual({
      nodes: {
        n0: { nodeType: 'std.math.add_ints', inputs: { a: 3, b: 4 } },
        n1: {
          nodeType: 'std.math.add_ints',
          inputs: { a: { $link: { node: 'n0', output: 'sum' } }, b: 10 },
        },
      },
    })
  })

  it('rejects an artifact compiled for another connection', async () => {
    const { conn } = submitHarness(nodesRoute)
    await conn.fetchSchemas()
    const foreign = { ...chainArtifact(), connection: asConnectionId('other') }
    const result = await conn.submit(foreign)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics[0]!.code).toBe('submit.wrongConnection')
  })

  it('rejects before schemas are fetched and on schema-hash drift', async () => {
    const { conn } = submitHarness(nodesRoute)
    const unfetched = await conn.submit(chainArtifact())
    expect(unfetched.ok).toBe(false)
    if (unfetched.ok) throw new Error('unreachable')
    expect(unfetched.diagnostics[0]!.code).toBe('submit.staleSchemas')

    await conn.fetchSchemas()
    const stale = { ...chainArtifact(), schemaHash: 'someone-else' }
    const drifted = await conn.submit(stale)
    expect(drifted.ok).toBe(false)
    if (drifted.ok) throw new Error('unreachable')
    expect(drifted.diagnostics[0]!.code).toBe('submit.staleSchemas')
  })

  it('rejects full-scope submission when the graph has no output nodes', async () => {
    const { conn } = submitHarness(nodesRoute)
    await conn.fetchSchemas()
    const artifact = chainArtifact()
    const full = {
      ...artifact,
      scope: { kind: 'full' } as const,
    }
    delete (full as { partialTargets?: unknown }).partialTargets
    const result = await conn.submit(full)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics[0]!.code).toBe('submit.noTargets')
  })

  it('maps structured rejection diagnostics with provenance anchoring', async () => {
    const { conn } = submitHarness(
      (url, init) =>
        nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(400, {
              diagnostics: [
                { severity: 'error', code: 'missing-input', nodeId: 'n1', inputId: 'items.item0.image', message: "input 'a' is not connected" },
              ],
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const artifact = chainArtifact()
    const result = await conn.submit({
      ...artifact,
      provenance: {
        ...artifact.provenance,
        inputSources: {
          ...artifact.provenance.inputSources,
          n1: {
            ...artifact.provenance.inputSources?.['n1'],
            'items.item0.image': {
              node: asNodeId('n1'),
              port: asPortId('items.image'),
              members: [asDynamicMemberId('m0')],
            },
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics).toHaveLength(1)
    const d = result.diagnostics[0]!
    expect(d.code).toBe('validation.missing-input')
    expect(d.message).toBe("input 'a' is not connected")
    expect(d.anchor?.occurrence).toEqual({ instancePath: [], node: 'n1' })
    expect(d.anchor?.port).toEqual({ node: 'n1', port: 'items.image', members: ['m0'] })
    expect(d.data).toEqual({ runtimeId: 'n1', inputId: 'items.item0.image' })
  })

  it('falls back from a body refusal to its owning region and input', async () => {
    const { conn } = submitHarness(
      (url, init) =>
        regionNodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(400, {
              diagnostics: [
                {
                  severity: 'error',
                  code: 'region-binding-length-mismatch',
                  nodeId: 'r/body',
                  inputId: 'item',
                  message: 'region inputs have different lengths',
                },
              ],
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const artifact = chainArtifact()
    const result = await conn.submit({
      ...artifact,
      schemaHash: buildDinksterRegistry(C0, regionNodesPayload).hash,
      dinksterGraph: {
        nodes: {
          r: {
            region: {
              kind: 'map',
              ports: { item: { kind: 'concrete', types: ['INT'] } },
              elementPorts: ['item'],
              inputs: { item: [1] },
              body: { nodes: { body: { nodeType: 'Body', inputs: {} } } },
              outputs: {},
            },
          },
        },
      } as never,
      dinksterTargets: ['r'],
      provenance: {
        ...artifact.provenance,
        toSource: { ...artifact.provenance.toSource, r: 'region-occurrence' },
        inputSources: {
          ...artifact.provenance.inputSources,
          r: { item: { node: asNodeId('region-occurrence'), port: asPortId('items') } },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics[0]).toMatchObject({
      code: 'validation.region-binding-length-mismatch',
      anchor: { occurrence: { instancePath: [], node: 'region-occurrence' } },
      data: { runtimeId: 'r/body', inputId: 'item' },
    })
    expect(result.diagnostics[0]!.anchor?.port).toEqual({
      node: 'region-occurrence',
      port: 'items',
    })
  })

  it('anchors a nested body refusal to its exact occurrence and abstains for ordinary paths', async () => {
    const { conn } = submitHarness(
      (url, init) =>
        regionNodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(400, {
              diagnostics: [
                {
                  severity: 'error',
                  code: 'inner-refusal',
                  nodeId: 'outer/inner/body',
                  inputId: 'value',
                  message: 'inner failed',
                },
                { severity: 'error', code: 'foreign-refusal', nodeId: 'ordinary/foreign', message: 'foreign failed' },
                { severity: 'error', code: 'malformed-refusal', nodeId: 'outer//body', message: 'malformed path' },
                { severity: 'error', code: 'unknown-refusal', nodeId: 'outer/unknown', message: 'unknown path' },
              ],
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const artifact = chainArtifact()
    const result = await conn.submit({
      ...artifact,
      schemaHash: buildDinksterRegistry(C0, regionNodesPayload).hash,
      dinksterGraph: {
        nodes: {
          outer: {
            region: {
              kind: 'map',
              ports: { item: { kind: 'concrete', types: ['INT'] } },
              elementPorts: ['item'],
              inputs: { item: [1] },
              body: {
                nodes: {
                  inner: {
                    region: {
                      kind: 'map',
                      ports: { item: { kind: 'concrete', types: ['INT'] } },
                      elementPorts: ['item'],
                      inputs: { item: [1] },
                      body: { nodes: { body: { nodeType: 'Body', inputs: {} } } },
                      outputs: {},
                    },
                  },
                },
              },
              outputs: {},
            },
          },
          ordinary: { nodeType: 'Ordinary', inputs: {} },
        },
      } as never,
      dinksterTargets: ['outer'],
      provenance: {
        ...artifact.provenance,
        toSource: {
          ...artifact.provenance.toSource,
          outer: 'outer-occurrence',
          'outer.inner': 'outer-occurrence.inner-occurrence',
          'outer.inner.body': 'outer-occurrence.inner-occurrence.body-occurrence',
          'ordinary.foreign': 'unrelated-occurrence',
          'outer..body': 'malformed-occurrence',
          'outer.unknown': 'unknown-occurrence',
        },
        inputSources: {
          ...artifact.provenance.inputSources,
          'outer.inner.body': {
            value: { node: asNodeId('body-occurrence'), port: asPortId('value') },
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics[0]).toMatchObject({
      code: 'validation.inner-refusal',
      message: 'inner failed',
      anchor: {
        occurrence: {
          instancePath: ['outer-occurrence', 'inner-occurrence'],
          node: 'body-occurrence',
        },
        port: { node: 'body-occurrence', port: 'value' },
      },
      data: { runtimeId: 'outer/inner/body', inputId: 'value' },
    })
    expect(result.diagnostics[1]).toMatchObject({ code: 'validation.foreign-refusal' })
    expect(result.diagnostics[1]!.anchor).toBeUndefined()
    expect(result.diagnostics[2]).toMatchObject({ code: 'validation.malformed-refusal' })
    expect(result.diagnostics[2]!.anchor).toBeUndefined()
    expect(result.diagnostics[3]).toMatchObject({ code: 'validation.unknown-refusal' })
    expect(result.diagnostics[3]!.anchor).toBeUndefined()
  })

  it('anchors unavailable vision capability details to the responsible node', async () => {
    const { conn } = submitHarness(
      (url, init) =>
        nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(400, {
              error: 'capability-unavailable',
              diagnostics: [{
                severity: 'error',
                code: 'capability-unavailable',
                message: 'Preprocess Realistic Line Art cannot run because a compatible vision-processing implementation is unavailable on this server. Install or reconnect the standard vision components, then retry.',
                nodeId: 'n1',
                nodeType: 'dinkster.preprocess.lineart_realistic',
                title: 'Preprocess Realistic Line Art',
                capability: 'a compatible vision-processing implementation',
                remedy: 'Install or reconnect the standard vision components, then retry.',
              }],
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const result = await conn.submit(chainArtifact())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics[0]).toMatchObject({
      code: 'validation.capability-unavailable',
      message: expect.stringContaining('Preprocess Realistic Line Art'),
      anchor: { occurrence: { instancePath: [], node: 'n1' } },
      data: {
        runtimeId: 'n1',
        nodeType: 'dinkster.preprocess.lineart_realistic',
        title: 'Preprocess Realistic Line Art',
        capability: 'a compatible vision-processing implementation',
        remedy: 'Install or reconnect the standard vision components, then retry.',
      },
    })
  })

  it('prefers an actionable message over a legacy rejection code', async () => {
    const { conn } = submitHarness(
      (url, init) =>
        nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(400, {
              error: 'vision-provider-unavailable',
              message: 'Preprocess Realistic Line Art needs a compatible vision component.',
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const result = await conn.submit(chainArtifact())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics[0]).toMatchObject({
      code: 'execution.submit.vision-provider-unavailable',
      message: 'Preprocess Realistic Line Art needs a compatible vision component.',
      data: {
        status: 400,
        code: 'vision-provider-unavailable',
        operation: 'submit',
      },
    })
  })

  it('preserves submission authorization status, code, message, capability, and scope', async () => {
    const { conn } = submitHarness(
      (url, init) => nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(403, {
              error: 'capability-required',
              message: 'scope shared requires jobs:submit',
              capability: 'jobs:submit',
              scope: 'shared',
            })
          : undefined),
    )
    await conn.fetchSchemas()

    const result = await conn.submit(chainArtifact())
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{
        code: 'execution.submit.capability-required',
        message: 'scope shared requires jobs:submit',
        data: {
          status: 403,
          code: 'capability-required',
          operation: 'submit',
          capability: 'jobs:submit',
          scope: 'shared',
        },
      }],
    })
  })

  it('decodes assets-missing preflight rejections into a legible typed diagnostic', async () => {
    const { conn } = submitHarness(
      (url, init) => nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(409, {
              error: 'assets-missing',
              assets: [
                { digest: `blake3:${'a'.repeat(64)}`, name: 'portrait.png', status: 'missing', sources: ['https://one', 'https://two'], fetchable: true, kind: 'image/reference', size: 2048, unknownFutureField: true },
                { digest: `blake3:${'b'.repeat(64)}`, name: 'broken.vae', status: 'failed', sources: [], fetchable: true, detail: 'checksum mismatch', packagedFrom: ['models.base'] },
              ],
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const result = await conn.submit(chainArtifact())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    const diagnostic = result.diagnostics[0]!
    expect(diagnostic.code).toBe('submit.assetsMissing')
    expect(diagnostic.message).toContain('portrait.png (aaaaaaaaaaaa, missing, image/reference)')
    expect(diagnostic.message).toContain('2 known download sources')
    expect(diagnostic.message).toContain('broken.vae (bbbbbbbbbbbb, failed)')
    expect(diagnostic.message).toContain('ships with pack models.base')
    expect(diagnostic.message).not.toContain('not yet implemented')
    expect((diagnostic.data?.['assets'] as unknown[])).toHaveLength(2)
    expect((diagnostic.data?.['assets'] as { kind?: string; size?: number; packagedFrom?: string[] }[])[0]).toMatchObject({ kind: 'image/reference', size: 2048 })
    expect((diagnostic.data?.['assets'] as { packagedFrom?: string[] }[])[1]?.packagedFrom).toEqual(['models.base'])
  })

  it('reports name-only asset refusals with their original node and input, without acquisition consent', async () => {
    const { conn } = submitHarness(
      (url, init) => nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(409, {
              error: 'assets-missing',
              assets: [{ name: 'wan_2.1_vae.safetensors', kind: 'model/vae', status: 'missing',
                verification: 'unverified', sources: [], fetchable: false, nodeId: 'n0', inputId: 'a' }],
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const result = await conn.submit(chainArtifact())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error', code: 'validation.asset.nameUnavailable',
      anchor: { occurrence: { instancePath: [], node: 'n0' } },
      data: { runtimeId: 'n0', inputId: 'a' },
    })
    expect(result.diagnostics[0]!.message).toContain('wan_2.1_vae.safetensors')
    expect(result.diagnostics[0]!.message).toContain('model/vae')
    expect(result.diagnostics[0]!.message).toContain('mounted folder')
    expect(result).not.toHaveProperty('retryWithAssets')
  })

})

// ---------------------------------------------------------------------------
// Job hydration + replay
// ---------------------------------------------------------------------------

describe('job hydration and replay', () => {
  const videoArtifact = {
    nodeId: 'save-video',
    digest: `blake3:${'d'.repeat(64)}`,
    name: 'render.webm',
    size: 4043,
    mediaType: 'video/webm',
    virtualPath: 'output/render.webm',
  }
  const completedJob = {
    clientId: 'cid',
    jobId: 'j1',
    state: 'completed',
    nodeStates: { n0: 'completed', n1: 'completed' },
    executed: ['n0', 'n1'],
    cached: [],
    skipped: [],
    outputs: { n1: { sum: { typeId: 'INT', fingerprint: 'abc', meta: {} } } },
  }

  function replayHarness(routes: Record<string, unknown>) {
    const fetchFn: FetchLike = async (url) => {
      for (const [suffix, payload] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return jsonResponse(200, payload)
      }
      if (url.includes('/api/jobs/')) return jsonResponse(404, { error: 'no such job' })
      throw new Error(`unexpected fetch: ${url}`)
    }
    const conn = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    const seedRunning = (jobId: string): void => {
      store.apply({ kind: 'started', execution: ref(jobId), timestamp: 0 })
    }
    return { conn, store, seedRunning }
  }

  it('fetches one job record keyed by clientId + jobId', async () => {
    const sourceDocument = `blake3:${'e'.repeat(64)}`
    const { conn } = replayHarness({
      '/api/jobs/cid/j1': { ...completedJob, artifacts: [videoArtifact], sourceDocument },
    })
    const job = await conn.fetchJob('j1')
    expect(job?.state).toBe('completed')
    expect(job?.artifacts).toEqual([videoArtifact])
    expect(job?.sourceDocument).toBe(sourceDocument)
    expect(await conn.fetchJob('missing')).toBeUndefined()
  })

  it('retains saved-file previews and descriptor-only sizes without a per-job file cap', async () => {
    const preview = {
      digest: `blake3:${'a'.repeat(64)}`, name: 'preview.webp', size: 238,
      mediaType: 'image/webp', virtualPath: `previews/${'a'.repeat(64)}/preview.webp`,
    }
    const artifacts = Array.from({ length: 4097 }, (_, index) => ({
      ...videoArtifact, nodeId: index < 4096 ? 'save-image' : 'another-save',
      name: `render-${index}.exr`, size: 1024 * 1024 * 1024 + index + 1,
      mediaType: 'image/x-exr', virtualPath: `mounts/output/render-${index}.exr`,
      ...(index === 4096 ? { preview } : {}),
    }))
    const { conn } = replayHarness({ '/api/jobs/cid/j1': { ...completedJob, artifacts } })
    const job = await conn.fetchJob('j1')
    expect(job?.artifacts).toEqual(artifacts)
  })

  it('replays a completed job into node states and a terminal transition', async () => {
    const { conn, store, seedRunning } = replayHarness({})
    seedRunning('j1')
    conn.replayJob('j1', completedJob)
    const state = store.get(ref('j1'))!
    expect(state.status).toBe('completed')
    expect(state.nodes['n0']).toEqual({ state: 'done' })
    // The target's result descriptor hydrates into a per-output summary.
    expect(state.nodes['n1']).toEqual({
      state: 'done',
      outputs: { sum: { typeId: 'INT' } },
    })
  })

  it('fetches and replays a failed job with the culprit node and error hints', async () => {
    const failedJob = {
      clientId: 'cid',
      jobId: 'j2',
      state: 'failed',
      nodeStates: { n0: 'completed' },
      error: {
        kind: 'execution',
        nodeId: 'n1',
        message: 'boom',
        traceback: 'tb1\ntb2',
        hints: [{
          code: 'dtype-mismatch',
          message: 'Input dtype Float does not match required dtype Half.',
        }],
      },
    }
    const { conn, store, seedRunning } = replayHarness({ '/api/jobs/cid/j2': failedJob })
    seedRunning('j2')
    const fetched = await conn.fetchJob('j2')
    expect(fetched).toBeDefined()
    conn.replayJob('j2', fetched!)
    const state = store.get(ref('j2'))!
    expect(state.status).toBe('error')
    expect(state.nodes['n1']).toEqual({ state: 'error' })
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]!.message).toBe('boom')
    expect(state.errors[0]!.runtime?.hints).toEqual([{
      code: 'dtype-mismatch',
      message: 'Input dtype Float does not match required dtype Half.',
    }])
  })
})

// ---------------------------------------------------------------------------
// Native reconciliation
// ---------------------------------------------------------------------------

describe('reconcileDinksterExecutions', () => {
  function harness(routes: Record<string, unknown>) {
    const requested: string[] = []
    const fetchFn: FetchLike = async (url) => {
      requested.push(url)
      for (const [suffix, payload] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return jsonResponse(200, payload)
      }
      if (url.includes('/api/jobs/')) return jsonResponse(404, { error: 'no such job' })
      throw new Error(`unexpected fetch: ${url}`)
    }
    const conn = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    const seedRunning = (jobId: string): void => {
      store.apply({ kind: 'started', execution: ref(jobId), timestamp: 0 })
    }
    return { conn, store, requested, seedRunning }
  }

  it.each(['accepted', 'refused', 'failed'] as const)(
    'admits a fetched reconnect record before replaying outputs or completion: %s', async (scenario) => {
      const outputs = { n1: { sum: { typeId: 'INT', value: 29 } } }
      const { conn, store, seedRunning } = harness({ '/api/jobs/cid/j1': {
        state: 'completed', nodeStates: { n1: 'completed' }, outputs, artifacts: [],
      } })
      seedRunning('j1')
      let acknowledge!: () => void
      let requested!: () => void
      const request = new Promise<void>((resolve) => { requested = resolve })
      const pass = reconcileDinksterExecutions(conn, store, () => async () => {
        requested()
        await new Promise<void>((resolve, reject) => {
          acknowledge = () => scenario === 'failed' ? reject(new Error('retention unavailable')) : resolve()
        })
        return scenario === 'accepted'
      })
      await request
      expect(store.get(ref('j1'))).toMatchObject({ status: 'running', nodes: {}, outputs: {}, artifactsHydrated: false })
      acknowledge()
      await pass
      expect(store.get(ref('j1'))).toMatchObject(scenario === 'accepted'
        ? { status: 'completed', nodes: { n1: { state: 'done', outputs: { sum: { value: 29 } } } }, outputs, artifactsHydrated: true }
        : { status: 'running', nodes: {}, outputs: {}, artifactsHydrated: false })
      if (scenario !== 'accepted') {
        await reconcileDinksterExecutions(conn, store, () => async () => true)
        expect(store.get(ref('j1'))).toMatchObject({ status: 'completed', outputs, artifactsHydrated: true })
      }
    },
  )

  it('hydrates persisted image outputs after run_finished observed an unfinished job', async () => {
    const job: Record<string, unknown> = { state: 'running' }
    const { conn, store, seedRunning } = harness({ '/api/jobs/cid/j1': job })
    seedRunning('j1')
    conn.ingest({ type: 'run_finished', jobId: 'j1' })
    expect(store.get(ref('j1'))!.status).toBe('running')
    expect(await conn.fetchJobOutputs('j1')).toEqual({})

    const outputs = { save: { images: {
      typeId: 'IMAGE', fingerprint: 'saved-image', meta: { shape: [2, 48, 64, 3] },
    } } }
    Object.assign(job, { state: 'completed', outputs, artifacts: [] })
    conn.ingest({ type: 'job_state', jobId: 'j1', state: 'completed' })
    expect(store.get(ref('j1'))!.status).toBe('completed')
    await hydrateDinksterCompletedExecution(conn, store, ref('j1'))
    expect(store.get(ref('j1'))!.outputs).toEqual(outputs)
    expect(store.get(ref('j1'))!.artifactsHydrated).toBe(true)
  })

  it('completes a run whose terminal event was missed, hydrating output descriptors', async () => {
    const outputs = { n1: { sum: { typeId: 'INT', fingerprint: 'abc', meta: {}, length: 4 } } }
    const artifacts = [{
      nodeId: 'n1',
      digest: `blake3:${'e'.repeat(64)}`,
      name: 'result.mp4',
      size: 1234,
      mediaType: 'video/mp4',
      virtualPath: 'output/result.mp4',
    }]
    const { conn, store, seedRunning } = harness({
      '/api/jobs/cid/j1': {
        state: 'completed',
        nodeStates: { n0: 'completed', n1: 'completed' },
        outputs,
        artifacts,
        submittedBy: { principalId: 'queue-agent', kind: 'agent' },
      },
    })
    seedRunning('j1')
    await reconcileDinksterExecutions(conn, store)
    const state = store.get(ref('j1'))!
    expect(state.status).toBe('completed')
    expect(state.outputs['n1']).toEqual(outputs.n1)
    expect(state.artifacts).toEqual(artifacts)
    expect(state.artifactsHydrated).toBe(true)
    expect(state.submittedBy).toEqual({ principalId: 'queue-agent', kind: 'agent' })
  })

  it('hydrates a completed run when reconnect lands after run_finished but before job_state', async () => {
    const artifacts = [{
      nodeId: 'save',
      digest: `blake3:${'7'.repeat(64)}`,
      name: 'result.webm',
      size: 4043,
      mediaType: 'video/webm',
      virtualPath: 'output/result.webm',
    }]
    const { conn, store, seedRunning } = harness({
      '/api/jobs/cid/gap': { state: 'completed', artifacts },
    })
    seedRunning('gap')
    conn.ingest({ type: 'run_finished', jobId: 'gap' })
    expect(store.get(ref('gap'))).toMatchObject({ status: 'running', artifactsHydrated: false })

    await reconcileDinksterExecutions(conn, store)

    expect(store.get(ref('gap'))).toMatchObject({
      status: 'completed',
      artifacts,
      artifactsHydrated: true,
    })
  })

  it('replays a missed skip cascade as normal skipped states', async () => {
    const { conn, store, seedRunning } = harness({
      '/api/jobs/cid/j2': {
        state: 'completed',
        nodeStates: { m: 'completed', a: 'skipped', b: 'skipped' },
      },
    })
    seedRunning('j2')
    await reconcileDinksterExecutions(conn, store)
    const state = store.get(ref('j2'))!
    expect(state.status).toBe('completed')
    expect(state.nodes['a']).toEqual({ state: 'skipped' })
    expect(state.nodes['b']).toEqual({ state: 'skipped' })
    expect(state.errors).toEqual([])
  })

  it('FR-6 hydrates a still-running job snapshot: nodes finished during the gap are not lost', async () => {
    // node_finished is incremental and never re-announced; only the fetched
    // record can fill the gap for a run that is STILL live after reconnect.
    const { conn, store, seedRunning } = harness({
      '/api/jobs/cid/j6': { state: 'running', nodeStates: { n0: 'completed', n1: 'running' } },
    })
    seedRunning('j6')
    await reconcileDinksterExecutions(conn, store)
    const state = store.get(ref('j6'))!
    expect(state.status).toBe('running')
    expect(state.nodes['n0']).toEqual({ state: 'done' })
    expect(state.nodes['n1']).toEqual({ state: 'running' })
  })

  it('FR-6 a delayed running snapshot never regresses a node that finished live during the fetch', async () => {
    // The race: reconcile fetches the job (capturing n0 as running), a live
    // terminal node state for n0 arrives while the fetch is pending, then the
    // stale fetch resolves. The snapshot must not overwrite the newer live
    // terminal state - while still gap-filling nodes the store never saw.
    let gate: (() => void) | undefined
    const fetchFn: FetchLike = async () => {
      await new Promise<void>((resolve) => { gate = resolve })
      return jsonResponse(200, {
        clientId: 'cid',
        jobId: 'j8',
        state: 'running',
        nodeStates: { n0: 'running', n1: 'completed' },
      })
    }
    const conn = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    store.apply({ kind: 'started', execution: ref('j8'), timestamp: 0 })
    const pass = reconcileDinksterExecutions(conn, store)
    while (gate === undefined) await Promise.resolve()
    // Live wire races past the pending fetch: n0 finishes.
    store.apply({ kind: 'nodeStates', execution: ref('j8'), timestamp: 1, nodes: { n0: { state: 'done' } } })
    gate()
    await pass
    const state = store.get(ref('j8'))!
    expect(state.status).toBe('running')
    expect(state.nodes['n0']).toEqual({ state: 'done' }) // newer live terminal survives
    expect(state.nodes['n1']).toEqual({ state: 'done' }) // gap-filled from the snapshot
  })

  it('CL2 a reconnect during an in-flight native pass supersedes its loss verdict', async () => {
    let gate: (() => void) | undefined
    let fetches = 0
    const fetchFn: FetchLike = async () => {
      fetches += 1
      if (fetches === 1) {
        // Block the first pass's job read until the second reconnect lands.
        await new Promise<void>((resolve) => { gate = resolve })
        return jsonResponse(404, { error: 'no such job' }) // obsolete answer
      }
      return jsonResponse(200, { clientId: 'cid', jobId: 'j9', state: 'running' })
    }
    const conn = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    store.apply({ kind: 'started', execution: ref('j9'), timestamp: 0 })
    const first = reconcileDinksterExecutions(conn, store)
    while (gate === undefined) await Promise.resolve()
    const second = reconcileDinksterExecutions(conn, store) // bumps the generation
    gate()
    await Promise.all([first, second])
    // The stale 404 must not mark a live job lost; the rerun saw it running.
    expect(store.get(ref('j9'))!.status).toBe('running')
    expect(fetches).toBe(2)
  })

  it('marks an execution lost when the server disowns its job', async () => {
    const { conn, store, seedRunning } = harness({})
    seedRunning('j4')
    await reconcileDinksterExecutions(conn, store)
    const state = store.get(ref('j4'))!
    expect(state.status).toBe('interrupted')
    expect(state.errors[0]!.code).toBe('execution.lost')
  })

})

// ---------------------------------------------------------------------------
// Execution log backfill from the run journal
// ---------------------------------------------------------------------------

describe('execution log backfill', () => {
  const logWire = (
    jobId: string,
    runId: string,
    seq: number,
    level: 'info' | 'warning',
    message: string,
  ): Readonly<Record<string, unknown>> & { type: string } => ({
    type: 'node_event',
    event: 'log',
    jobId,
    runId,
    nodeId: 'n1',
    seq,
    clientId: 'cid',
    data: { level, message, ts: 1000 + seq },
  })
  const journalRecord = (seq: number, name: string, payload: unknown): Record<string, unknown> =>
    ({ seq, name, payload, durable: true, timestamp: 50 + seq })
  const journalUrl = (runId: string, after: number): string =>
    `http://test/api/runs/${runId}/journal?scope=local&after=${after}&limit=1000`

  function harness(routes: Record<string, unknown>) {
    const requested: string[] = []
    const fetchFn: FetchLike = async (url) => {
      requested.push(url)
      const payload = routes[url]
      if (payload !== undefined) return jsonResponse(200, payload)
      if (url.includes('/journal')) return jsonResponse(404, { error: 'no journal for run' })
      throw new Error(`unexpected fetch: ${url}`)
    }
    const conn = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    return { conn, store, requested }
  }

  it('replays only journal log records into the store', async () => {
    const { conn, store } = harness({
      [journalUrl('r1', 0)]: {
        records: [
          journalRecord(1, 'run_started', { type: 'run_started', jobId: 'j1', runId: 'r1', seq: 1 }),
          journalRecord(2, 'log', logWire('j1', 'r1', 2, 'info', 'loading model')),
          journalRecord(3, 'progress', { type: 'node_event', event: 'progress', jobId: 'j1', nodeId: 'n1', seq: 3, data: { step: 1, total: 4 } }),
          journalRecord(4, 'log', logWire('j1', 'r1', 4, 'warning', 'fallback vae')),
        ],
        latestSeq: 4,
        coalescedBelow: 0,
      },
    })
    await conn.backfillRunLog('r1', 'local')
    const logs = store.get(ref('j1'))!.logs
    expect(logs.map((l) => [l.seq, l.level, l.message])).toEqual([
      [2, 'info', 'loading model'],
      [4, 'warning', 'fallback vae'],
    ])
    // Replayed lifecycle/progress records are NOT re-applied here: only the
    // journal's log records flow, job state reconciles through replayJob.
    expect(store.get(ref('j1'))!.status).toBe('queued')
  })

  it('resolves quietly when the server has no journal (404)', async () => {
    const { conn, store, requested } = harness({})
    await conn.backfillRunLog('r-none', 'local')
    expect(requested).toEqual([journalUrl('r-none', 0)])
    expect(store.get(ref('j1'))).toBeUndefined()
  })

  it('pages with an advancing cursor and resumes from it on later calls', async () => {
    const { conn, store, requested } = harness({
      [journalUrl('r2', 0)]: {
        records: [1, 2, 3].map((s) => journalRecord(s, 'log', logWire('j2', 'r2', s, 'info', `m${s}`))),
        latestSeq: 5,
        coalescedBelow: 0,
      },
      [journalUrl('r2', 3)]: {
        records: [4, 5].map((s) => journalRecord(s, 'log', logWire('j2', 'r2', s, 'info', `m${s}`))),
        latestSeq: 5,
        coalescedBelow: 0,
      },
      [journalUrl('r2', 5)]: { records: [], latestSeq: 5, coalescedBelow: 0 },
    })
    await conn.backfillRunLog('r2', 'local')
    expect(requested).toEqual([journalUrl('r2', 0), journalUrl('r2', 3)])
    expect(store.get(ref('j2'))!.logs.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5])
    await conn.backfillRunLog('r2', 'local')
    expect(requested).toEqual([journalUrl('r2', 0), journalUrl('r2', 3), journalUrl('r2', 5)])
    expect(store.get(ref('j2'))!.logs.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('backfills when a job is first seen live mid-run (wire seq past 1)', async () => {
    const { conn, store } = harness({
      'http://test/api/jobs/cid/j9': { state: 'running', jobId: 'j9', jobRef: 'r9', runId: 'r9', scope: 'local' },
      [journalUrl('r9', 0)]: {
        records: [
          journalRecord(2, 'log', logWire('j9', 'r9', 2, 'info', 'before reload')),
        ],
        latestSeq: 7,
        coalescedBelow: 0,
      },
      [journalUrl('r9', 2)]: { records: [], latestSeq: 7, coalescedBelow: 0 },
    })
    conn.ingest(logWire('j9', 'r9', 7, 'info', 'after reload'))
    await vi.waitFor(() => {
      expect(store.get(ref('j9'))!.logs.map((l) => [l.seq, l.message])).toEqual([
        [2, 'before reload'],
        [7, 'after reload'],
      ])
    })
  })

  it('reconciliation replays the journal for jobs that carry a run identity', async () => {
    const { conn, store } = harness({
      'http://test/api/jobs/cid/j12': {
        state: 'running',
        jobId: 'j12',
        jobRef: 'r12',
        runId: 'r12',
        scope: 'local',
        nodeStates: { n1: 'running' },
      },
      [journalUrl('r12', 0)]: {
        records: [journalRecord(1, 'log', logWire('j12', 'r12', 1, 'warning', 'missed in gap'))],
        latestSeq: 1,
        coalescedBelow: 0,
      },
    })
    store.apply({ kind: 'started', execution: ref('j12'), timestamp: 0 })
    await reconcileDinksterExecutions(conn, store)
    // The reconcile-launched backfill is fire-and-forget; joining a fresh
    // backfill call settles after it (coalesced onto the in-flight pass, or
    // a quiet no-op pass once it finished).
    await conn.backfillRunLog('r12', 'local')
    expect(store.get(ref('j12'))!.logs.map((l) => [l.seq, l.message])).toEqual([
      [1, 'missed in gap'],
    ])
  })

  it('reconciliation completes even when the journal endpoint hangs', async () => {
    const artifacts = [{
      nodeId: 'n1',
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'result.png',
      size: 99,
      mediaType: 'image/png',
      virtualPath: 'output/result.png',
    }]
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('/journal')) return new Promise<never>(() => {}) // never settles
      if (url.endsWith('/api/jobs/cid/j13'))
        return jsonResponse(200, {
          state: 'running',
          jobId: 'j13',
          jobRef: 'r13',
          runId: 'r13',
          scope: 'local',
          nodeStates: { n1: 'running' },
        })
      if (url.endsWith('/api/jobs/cid/j14'))
        return jsonResponse(200, { state: 'completed', nodeStates: { n1: 'completed' }, artifacts })
      throw new Error(`unexpected fetch: ${url}`)
    }
    const conn = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'cid', fetchFn })
    const store = new ExecutionStore()
    conn.onEvent((e) => store.apply(e))
    // j13 (hung journal) is reconciled before j14: the hang must not stall
    // later jobs or artifact hydration.
    store.apply({ kind: 'started', execution: ref('j13'), timestamp: 0 })
    store.apply({ kind: 'started', execution: ref('j14'), timestamp: 1 })
    await reconcileDinksterExecutions(conn, store)
    expect(store.get(ref('j14'))).toMatchObject({
      status: 'completed',
      artifacts,
      artifactsHydrated: true,
    })
  })
})

// ---------------------------------------------------------------------------
// WebSocket framing
// ---------------------------------------------------------------------------

describe('websocket', () => {
  class FakeWs implements WebSocketLike {
    binaryType = 'blob'
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: unknown) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    url = ''
    sent: string[] = []
    send(data: string): void {
      this.sent.push(data)
    }
    close(): void {
      this.onclose?.({})
    }
  }

  function connected() {
    let ws: FakeWs | undefined
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'cid',
      webSocketFactory: (url) => {
        ws = new FakeWs()
        ws.url = url
        return ws
      },
    })
    const events: NormalizedEvent[] = []
    conn.onEvent((e) => events.push(e))
    conn.connect()
    return { conn, ws: ws!, events }
  }

  it('delivers an unseen node event to the application subscriber unchanged', () => {
    const { conn, events } = connected()
    conn.ingest({
      type: 'node_event', jobId: 'job-new-event', nodeId: 'node-1',
      event: 'pack.future.telemetry', data: { nested: { answer: 42 }, values: [1, 2, 3] },
    })
    expect(events).toEqual([{
      kind: 'node.event',
      execution: { connection: C0, prompt: 'job-new-event' },
      timestamp: expect.any(Number),
      name: 'pack.future.telemetry',
      payload: { nested: { answer: 42 }, values: [1, 2, 3] },
      runtimeNodeId: 'node-1',
    }])
  })

  it('authenticates agent HTTP and event WebSocket traffic with the delegation', async () => {
    let ws: FakeWs | undefined
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer delegated-agent')
      expect(new Headers(init?.headers).get('X-Dinkster-Actor-Kind')).toBe('agent')
      if (url.includes('/api/events?clientId=')) return jsonResponse(400, { error: 'websocket-upgrade-required' })
      if (url.endsWith('/api/auth/ws-ticket')) return jsonResponse(200, { ticket: 'single use' })
      if (url.endsWith('/api/nodes')) return jsonResponse(200, liveNodesPayload)
      throw new Error(`unexpected fetch: ${url}`)
    })
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'agent-id',
      token: 'delegated-agent',
      actorKind: 'agent',
      fetchFn,
      webSocketFactory: (url) => {
        ws = new FakeWs()
        ws.url = url
        return ws
      },
    })

    conn.connect()
    await vi.waitFor(() => expect(ws).toBeDefined())
    expect(ws!.url).toBe('ws://test/api/events?clientId=agent-id&ticket=single%20use')
    await conn.fetchSchemas()
    expect(fetchFn).toHaveBeenCalledTimes(3)
    conn.disconnect()
  })

  it('keeps credentialed event preflight requests on the configured HTTP server', async () => {
    let ws: FakeWs | undefined
    const requested: string[] = []
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      wsUrl: 'wss://events.example/api/events?clientId=agent-id',
      clientId: 'agent-id',
      token: 'delegation',
      actorKind: 'agent',
      fetchFn: async (url) => {
        requested.push(url)
        return url.endsWith('/api/auth/ws-ticket')
          ? jsonResponse(200, { ticket: 'single-use' })
          : jsonResponse(400, { error: 'websocket-upgrade-required' })
      },
      webSocketFactory: (url) => {
        ws = new FakeWs()
        ws.url = url
        return ws
      },
    })

    conn.connect()
    await vi.waitFor(() => expect(ws).toBeDefined())
    expect(requested).toEqual([
      'http://test/api/events?clientId=agent-id',
      'http://test/api/auth/ws-ticket',
    ])
    expect(ws!.url).toBe('wss://events.example/api/events?clientId=agent-id&ticket=single-use')
    conn.disconnect()
  })

  it('stops before opening or retrying when the events preflight denies a session delegation', async () => {
    const scheduled: (() => void)[] = []
    const problems: Diagnostic[] = []
    const webSocketFactory = vi.fn(() => new FakeWs())
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'agent-id',
      token: 'session-delegation',
      actorKind: 'agent',
      fetchFn: async () => jsonResponse(403, {
        error: 'delegation-session-required',
        message: 'this delegation is limited to session s1',
      }),
      webSocketFactory,
      scheduleFn: (callback) => { scheduled.push(callback); return callback },
      cancelFn: () => {},
    })
    conn.onProblem((problem) => problems.push(problem))

    conn.connect()
    await vi.waitFor(() => expect(conn.status.get()).toBe('disconnected'))
    expect(webSocketFactory).not.toHaveBeenCalled()
    expect(scheduled).toEqual([])
    expect(problems).toEqual([expect.objectContaining({
      code: 'execution.events.delegation-session-required',
      message: 'this delegation is limited to session s1',
      data: {
        status: 403,
        code: 'delegation-session-required',
        operation: 'events',
      },
    })])
  })

  it('makes authorization loss on reconnect terminal and observable', async () => {
    const scheduled: (() => void)[] = []
    const sockets: FakeWs[] = []
    const problems: Diagnostic[] = []
    let preflights = 0
    const conn = new DinksterConnection({
      id: C0,
      baseUrl: 'http://test',
      clientId: 'agent-id',
      token: 'delegation',
      actorKind: 'agent',
      fetchFn: async (url) => {
        if (url.includes('/api/events?clientId=')) {
          preflights += 1
          return preflights === 1
            ? jsonResponse(400, { error: 'websocket-upgrade-required' })
            : jsonResponse(401, { error: 'authentication-required', message: 'delegation expired' })
        }
        return jsonResponse(200, { ticket: 'single-use' })
      },
      webSocketFactory: (url) => {
        const ws = new FakeWs()
        ws.url = url
        sockets.push(ws)
        return ws
      },
      scheduleFn: (callback) => { scheduled.push(callback); return callback },
      cancelFn: () => {},
    })
    conn.onProblem((problem) => problems.push(problem))
    conn.connect()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.onopen?.({})
    sockets[0]!.onclose?.({})
    expect(scheduled).toHaveLength(1)

    scheduled.shift()!()
    await vi.waitFor(() => expect(conn.status.get()).toBe('disconnected'))
    expect(sockets).toHaveLength(1)
    expect(scheduled).toEqual([])
    expect(problems).toEqual([expect.objectContaining({
      code: 'execution.events.authentication-required',
      message: 'delegation expired',
      data: { status: 401, code: 'authentication-required', operation: 'events' },
    })])
  })

  it('routes text frames through the native normalizer', () => {
    const { ws, events } = connected()
    ws.onopen?.({})
    ws.onmessage?.({
      data: JSON.stringify({ type: 'job_state', jobId: 'j1', runId: 'r1', state: 'running' }),
    })
    ws.onmessage?.({ data: JSON.stringify({ type: 'run_started', runId: 'r1' }) })
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('started')
    expect(events[0]).toMatchObject({ execution: ref('j1') })
  })

  it('routes schema_changed control frames to listeners', () => {
    const { ws, events } = connected()
    ws.onopen?.({})
    ws.onmessage?.({ data: JSON.stringify({ type: 'schema_changed', epoch: 4 }) })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'schemaChanged', connection: C0, epoch: 4 })
  })

  it('invalidates folder snapshots on mount pings without emitting asset or execution data', () => {
    const { conn, ws, events } = connected()
    let changes = 0
    const unsubscribe = conn.onMountsChanged(() => { changes++ })
    ws.onopen?.({})
    ws.onmessage?.({ data: JSON.stringify({ type: 'mounts_changed' }) })
    expect(changes).toBe(1)
    expect(events).toEqual([])
    unsubscribe()
    ws.onmessage?.({ data: JSON.stringify({ type: 'mounts_changed' }) })
    expect(changes).toBe(1)
    conn.disconnect()
  })

  it('decodes self-describing binary frames into attributed previews', () => {
    const { ws, events } = connected()
    ws.onopen?.({})
    const header = new TextEncoder().encode(
      JSON.stringify({
        type: 'node_event',
        event: 'preview',
        jobId: 'j1',
        nodeId: 'p',
        data: { mime: 'image/jpeg' },
      }),
    )
    const blob = new Uint8Array([1, 2, 3])
    const frame = new Uint8Array(4 + header.length + blob.length)
    new DataView(frame.buffer).setUint32(0, header.length, false)
    frame.set(header, 4)
    frame.set(blob, 4 + header.length)
    ws.onmessage?.({ data: frame.buffer })
    expect(events).toHaveLength(1)
    const preview = events[0]!
    if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`)
    expect(preview.runtimeNodeId).toBe('p')
    expect(preview.channel).toBe('image/jpeg')
    expect(new Uint8Array(preview.payload as ArrayBuffer)).toEqual(blob)
  })

  it('ignores malformed text frames without crashing', () => {
    const { ws, events } = connected()
    ws.onopen?.({})
    ws.onmessage?.({ data: '{not json' })
    ws.onmessage?.({ data: JSON.stringify({ noType: true }) })
    expect(events).toEqual([])
  })

})

describe('workflow library wire', () => {
  const DIGEST = 'blake3:' + 'a'.repeat(64)
  const MEDIA_ASSET = {
    digest: DIGEST,
    name: 'server-name.png',
    size: 4,
    mediaType: 'image/png',
    virtualPath: '',
  }
  const record = {
    id: 'r1',
    scope: 'local',
    name: 'My Flow',
    digest: DIGEST,
    mediaType: 'application/x-dinkster-workflow+json',
    labels: ['workflow'],
    created: 1.5,
    modified: 2.5,
    revision: 1,
  }
  const imageDependency = {
    resourceId: 'r0',
    digest: 'blake3:' + 'b'.repeat(64),
    byteSize: 70,
    mediaType: 'image/png',
    width: 2,
    height: 1,
    colorSpace: 'srgb',
    channelDepth: 8,
    alphaMode: 'straight',
  }

  it('uploadAsset throws on failure (e.g. a server without --library-root)', async () => {
    const { conn } = submitHarness(() => jsonResponse(404, { error: 'unknown' }))
    await expect(conn.uploadAsset('x')).rejects.toThrow('404')
  })

  it('reads immutable ImageDocument dependency manifests and rejects mismatches', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, {
      digest: DIGEST,
      dependencies: [imageDependency],
    }))
    await expect(conn.fetchImageDocumentDependencies(DIGEST)).resolves.toEqual([imageDependency])
    expect(requests[0]!.url).toContain(`/api/assets/${encodeURIComponent(DIGEST)}/dependencies`)

    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    await expect(missing.fetchImageDocumentDependencies(DIGEST)).resolves.toBeUndefined()
    const { conn: mismatch } = submitHarness(() => jsonResponse(200, {
      digest: 'blake3:' + 'f'.repeat(64), dependencies: [imageDependency],
    }))
    await expect(mismatch.fetchImageDocumentDependencies(DIGEST)).rejects.toThrow('malformed')
  })

  it('renders an adopted ImageDocument and validates exact provenance', async () => {
    const outputDigest = 'blake3:' + 'f'.repeat(64)
    const provenance = {
      documentDigest: DIGEST,
      selector: 'layer:l1',
      profile: 'dinkster-image-document-v2-cpu-reference',
      rendererContract: '2;pillow=12.1.1;jpeg=9.0;webp=1.6.0',
      encoding: 'image/png;dinkster-canonical=1',
      source: {
        digest: DIGEST,
        mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
        dependencies: [imageDependency],
      },
      output: {
        digest: outputDigest,
        byteSize: 123,
        mediaType: 'image/png',
        width: 8,
        height: 4,
        encoding: 'image/png;dinkster-canonical=1',
      },
    }
    const asset = {
      digest: outputDigest,
      name: 'image-document-render.png',
      size: 123,
      mediaType: 'image/png',
      virtualPath: '',
    }
    const { conn, requests } = submitHarness(() => jsonResponse(201, {
      cacheKey: 'blake3:' + 'e'.repeat(64), cached: false, asset, provenance,
    }))
    await expect(conn.renderImageDocument(DIGEST, {
      scope: 'local', selector: 'layer:l1',
    })).resolves.toEqual({
      cacheKey: 'blake3:' + 'e'.repeat(64), cached: false, asset, provenance,
    })
    const request = requests[0]!
    expect(new URL(request.url).pathname).toBe(`/api/assets/${encodeURIComponent(DIGEST)}/render`)
    expect(new URL(request.url).searchParams.get('scope')).toBe('local')
    expect(JSON.parse(request.init?.body as string)).toEqual({
      selector: 'layer:l1', profile: 'dinkster-image-document-v2-cpu-reference',
    })

    const { conn: malformed } = submitHarness(() => jsonResponse(200, {
      cacheKey: 'blake3:' + 'e'.repeat(64), cached: true,
      asset: { ...asset, size: 124 }, provenance,
    }))
    await expect(malformed.renderImageDocument(DIGEST, {
      scope: 'local', selector: 'layer:l1',
    })).rejects.toThrow('malformed')
    const { conn: wrongSelector } = submitHarness(() => jsonResponse(200, {
      cacheKey: 'blake3:' + 'e'.repeat(64), cached: true,
      asset, provenance: { ...provenance, selector: 'composite' },
    }))
    await expect(wrongSelector.renderImageDocument(DIGEST, {
      scope: 'local', selector: 'layer:l1',
    })).rejects.toThrow('malformed')
    const { conn: oldProfile } = submitHarness(() => jsonResponse(200, {
      cacheKey: 'blake3:' + 'e'.repeat(64), cached: true,
      asset, provenance: { ...provenance, profile: 'dinkster-image-document-v1-cpu-reference' },
    }))
    await expect(oldProfile.renderImageDocument(DIGEST, {
      scope: 'local', selector: 'layer:l1',
    })).rejects.toThrow('malformed')
  })

  it.each(['named', 'media'] as const)('%s upload preserves the project destination and collision-safe server reference', async (route) => {
    const body = new File(['different bytes'], 'proof.png', { type: 'image/png' })
    const asset = { ...MEDIA_ASSET, name: 'proof (2).png', size: 19, virtualPath: 'mounts/imports/plates/scene A/proof (2).png' }
    const { conn, requests } = submitHarness(() => jsonResponse(201, {
      digest: DIGEST, asset: { ...asset, hostPath: '/private/not-an-asset-field' }, kind: 'media/image',
    }), 'project-b')
    const controller = new AbortController()
    const options = { scope: 'team', name: body.name, mount: 'imports', folder: 'plates/scene A', signal: controller.signal }
    const result = route === 'named'
      ? await conn.uploadNamedAsset(body, options)
      : await conn.uploadMediaAsset(body, { ...options, kind: 'media/image' })
    expect(result).toEqual(asset)
    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.pathname).toBe(route === 'named' ? '/api/assets' : '/api/assets/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: 'team', project: 'project-b', name: 'proof.png', mount: 'imports', folder: 'plates/scene A',
      ...(route === 'media' ? { kind: 'media/image' } : {}),
    })
    expect(request.init?.body).toBe(body)
    expect(request.init?.signal).toBe(controller.signal)
  })

  it.each([
    { digest: 'blake3:' + 'b'.repeat(64), asset: MEDIA_ASSET },
    { digest: DIGEST, asset: { ...MEDIA_ASSET, virtualPath: undefined } },
    { digest: DIGEST },
  ])('named upload rejects a malformed or inconsistent server reference', async (payload) => {
    const { conn } = submitHarness(() => jsonResponse(201, payload))
    await expect(conn.uploadNamedAsset(new File(['x'], 'x'), { scope: 'local', name: 'x' })).rejects.toThrow('malformed response')
  })

  it('named upload surfaces a rejected destination without retrying into the vault', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(403, { error: 'read-only mount' }))
    await expect(conn.uploadNamedAsset(new File(['x'], 'x'), { scope: 'local', name: 'x', mount: 'readonly' })).rejects.toThrow('403')
    expect(requests).toHaveLength(1)
  })

  it('uploadMediaAsset sends a video File directly without reading or copying it in JavaScript', async () => {
    const body = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'clip.webm', { type: 'video/webm' })
    const read = vi.spyOn(body, 'arrayBuffer')
    const asset = { ...MEDIA_ASSET, name: 'clip.webm', mediaType: 'video/webm' }
    const { conn, requests } = submitHarness(() => jsonResponse(201, {
      asset,
      kind: 'media/video',
    }))
    await expect(conn.uploadMediaAsset(body, {
      scope: 'local', kind: 'media/video', name: 'clip.webm',
    })).resolves.toEqual(asset)
    expect(requests[0]?.init?.body).toBe(body)
    expect(new Headers(requests[0]?.init?.headers).get('Content-Type')).toBe('video/webm')
    expect(read).not.toHaveBeenCalled()
  })

  it('fetchAssetText returns bytes as text, undefined on a miss', async () => {
    const { conn, requests } = submitHarness((url) =>
      url.includes('/api/assets/') ? new Response('{"a":1}', { status: 200 }) : undefined,
    )
    expect(await conn.fetchAssetText(DIGEST)).toBe('{"a":1}')
    expect(requests[0]?.url).toBe(`http://test/api/assets/${encodeURIComponent(DIGEST)}`)
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.fetchAssetText(DIGEST)).toBeUndefined()
  })

  it('fetchAssetBytes returns binary bytes without text decoding', async () => {
    const { conn } = submitHarness(() => new Response(new Uint8Array([0, 255, 17])))
    expect(new Uint8Array((await conn.fetchAssetBytes(DIGEST))!)).toEqual(new Uint8Array([0, 255, 17]))
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.fetchAssetBytes(DIGEST)).toBeUndefined()
  })

  it('cancels an asset byte read while the response body is pending', async () => {
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const { conn } = submitHarness((_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
      },
      pull() { started() },
    })))
    const abort = new AbortController()
    const bytes = conn.fetchAssetBytes(DIGEST, abort.signal)
    const rejected = expect(bytes).rejects.toThrow('Preview closed')
    await reading
    abort.abort(new Error('Preview closed'))
    await rejected
  })

  it('reads local bindings without digest identity or browser caching and propagates cancellation', async () => {
    const { conn, requests } = submitHarness(() => new Response(new Uint8Array([251, 0, 17])))
    const abort = new AbortController()
    expect(new Uint8Array((await conn.fetchLocalAssetBytes('binding/?scope=public', abort.signal))!)).toEqual(new Uint8Array([251, 0, 17]))
    expect(requests[0]).toEqual({
      url: 'http://test/api/assets/local/binding%2F%3Fscope%3Dpublic',
      init: { cache: 'no-store', signal: abort.signal },
    })
    const { conn: revoked } = submitHarness(() => jsonResponse(404, {}))
    expect(await revoked.fetchLocalAssetBytes('revoked')).toBeUndefined()
    const { conn: denied } = submitHarness(() => jsonResponse(403, {}))
    await expect(denied.fetchLocalAssetBytes('denied')).rejects.toThrow('403')
    const { conn: cancelled } = submitHarness((_url, init) => { init?.signal?.throwIfAborted(); return new Response() })
    abort.abort()
    await expect(cancelled.fetchLocalAssetBytes('cancelled', abort.signal)).rejects.toThrow()
  })

  it('listLibrary throws on a rejected cursor (restart from page one)', async () => {
    const { conn } = submitHarness(() => jsonResponse(400, { error: 'cursor-query-mismatch' }))
    await expect(conn.listLibrary({ scope: 'local', cursor: 'stale' })).rejects.toThrow('400')
  })

  it('fetchTemplateBody mirrors the immutable blueprint path and validates native documents', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, CHAIN_DOC))
    const body = await conn.fetchTemplateBody('demo/pack', 'starter one')
    expect(body?.graphs.g0?.nodes.n0?.type).toBe('std.math.add_ints')
    expect(requests[0]!.url).toBe('http://test/api/packs/demo%2Fpack/templates/starter%20one')
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.fetchTemplateBody('p', 't')).toBeUndefined()
  })

  it('CL1 fetchTemplateBody treats a 200 body that fails to load as a protocol error, not absence', async () => {
    const { conn } = submitHarness(() => jsonResponse(200, {}))
    await expect(conn.fetchTemplateBody('p', 't')).rejects.toThrow('malformed response')
  })

  it('listDocs decodes the frozen grouped-locale fixture and sends every paging filter', async () => {
    const { conn, requests } = submitHarness((url) => url.includes('/api/docs?')
      ? jsonResponse(200, docsPageFixture)
      : undefined)
    const page = await conn.listDocs({
      q: 'loops', kind: 'guide', pack: 'dinkster-nodes-foundation', id: 'loops-and-subgraphs', limit: 2, cursor: 'next',
    })
    expect(page.docs).toHaveLength(2)
    expect(page.cursor).toBe('<opaque-filter-bound-cursor>')
    expect(page.docs[0]).toMatchObject({
      kind: 'guide', id: 'loops-and-subgraphs', order: 20, tags: ['loops', 'subgraphs'], guideKind: 'tour',
      locales: { en: { title: 'Loops and subgraphs' }, zh: { title: 'Loops and subgraphs (zh)' } },
    })
    expect(page.docs[1]).toMatchObject({
      kind: 'node', id: 'std.math.add_ints', defaultLocale: 'en',
      locales: { en: { schemaVersion: 1, assets: { 'assets/addition.mp4': { mediaType: 'video/mp4' } } } },
    })
    const url = new URL(requests[0]!.url)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'loops', kind: 'guide', pack: 'dinkster-nodes-foundation', id: 'loops-and-subgraphs', limit: '2', cursor: 'next',
    })
  })

  it('bounds the docs page cache and retries failed bodies', async () => {
    const { conn, requests } = submitHarness((url) => new Response(url, {
      status: 200,
      headers: { 'Content-Type': 'text/markdown' },
    }))
    for (let index = 0; index < 65; index += 1) {
      await conn.fetchDocsPage('pack', `sha256:${String(index).padStart(64, '0')}`)
    }
    expect(requests).toHaveLength(65)
    await conn.fetchDocsPage('pack', `sha256:${'0'.repeat(64)}`)
    expect(requests).toHaveLength(66)

    let attempts = 0
    const { conn: retrying } = submitHarness(() => {
      attempts += 1
      return attempts === 1
        ? new Response(null, { status: 500 })
        : new Response('# recovered', { status: 200, headers: { 'Content-Type': 'text/markdown' } })
    })
    await expect(retrying.fetchDocsPage('pack', `sha256:${'f'.repeat(64)}`)).rejects.toThrow('failed: 500')
    await expect(retrying.fetchDocsPage('pack', `sha256:${'f'.repeat(64)}`)).resolves.toBe('# recovered')
    expect(attempts).toBe(2)
  })

  it('rejects malformed locale catalog transport and retries transient failures', async () => {
    const { conn: wrongType } = submitHarness(() => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }))
    await expect(wrongType.fetchPackLocaleCatalog('pack', 'sha256:text')).rejects.toThrow(
      'expected application/json',
    )
    const { conn: invalidUtf8 } = submitHarness(() => new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await expect(invalidUtf8.fetchPackLocaleCatalog('pack', 'sha256:utf8')).rejects.toThrow(
      'malformed response',
    )

    let attempts = 0
    const { conn: retrying } = submitHarness(() => {
      attempts += 1
      return attempts === 1
        ? new Response(null, { status: 503 })
        : jsonResponse(200, { searchTerms: { 'demo.node': ['retry'] } })
    })
    await expect(retrying.fetchPackLocaleCatalog('pack', 'sha256:retry')).rejects.toThrow('failed: 503')
    await expect(retrying.fetchPackLocaleCatalog('pack', 'sha256:retry')).resolves.toEqual({
      searchTerms: { 'demo.node': ['retry'] },
    })
    expect(attempts).toBe(2)
  })

  it('getLibraryRecord returns the record, undefined on the no-hint 404', async () => {
    const { conn, requests } = submitHarness((url) =>
      url.includes('/api/library/r1') ? jsonResponse(200, record) : undefined,
    )
    expect(await conn.getLibraryRecord('r1', 'local')).toEqual(record)
    expect(requests[0]?.url).toBe('http://test/api/library/r1?scope=local')
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.getLibraryRecord('r1', 'local')).toBeUndefined()
  })

  it('patchLibraryRecord returns the record on 200 and conflict on 409', async () => {
    const bumped = { ...record, revision: 2 }
    const { conn, requests } = submitHarness((url, init) =>
      url.endsWith('/api/library/r1') && init?.method === 'PATCH'
        ? jsonResponse(200, bumped)
        : undefined,
    )
    const res = await conn.patchLibraryRecord('r1', { scope: 'local', revision: 1, digest: DIGEST })
    expect(res).toEqual({ ok: true, record: bumped })
    const body = JSON.parse(requests[0]!.init!.body as string) as Record<string, unknown>
    expect(body['revision']).toBe(1)

    const { conn: conflicted } = submitHarness(() => jsonResponse(409, { error: 'revision-stale' }))
    expect(await conflicted.patchLibraryRecord('r1', { scope: 'local', revision: 1 })).toEqual({
      ok: false,
      conflict: true,
    })
  })

})

describe('persistent history wire', () => {
  const DIGEST = 'blake3:' + 'b'.repeat(64)
  const run = {
    runId: 'run-1',
    scope: 'local',
    clientId: 'cid',
    jobId: 'job-1',
    state: 'completed',
    priority: 0,
    submittedAt: 1.0,
    finishedAt: 3.0,
    executed: 2,
    cached: 1,
    skipped: 0,
    startedAt: 1.5,
    sourceDocument: DIGEST,
  }

  it('decodes interrupted restart-sweep records and still drops unknown states', async () => {
    const interrupted = {
      ...run,
      runId: 'run-interrupted',
      state: 'interrupted',
      executed: 0,
      cached: 0,
      error: {
        kind: 'interrupted',
        phase: 'running',
        message: 'the server exited while this job was running; it was not re-run - resubmit it to run it',
        fingerprint: 'fp-1',
        extensionSnapshotDigest: 'blake3:' + 'c'.repeat(64),
      },
    }
    const { conn } = submitHarness((url) =>
      url.includes('/api/history?')
        ? jsonResponse(200, { records: [
            interrupted,
            { ...run, runId: 'unknown-state', state: 'paused' },
          ] })
        : undefined,
    )
    const records = (await conn.listHistory({ scope: 'local' })).records
    expect(records).toEqual([interrupted])
    expect(records[0]?.error?.['phase']).toBe('running')
  })

  it('listHistory throws on a rejected cursor (restart from page one)', async () => {
    const { conn } = submitHarness(() => jsonResponse(400, { error: 'cursor-query-mismatch' }))
    await expect(conn.listHistory({ scope: 'local', cursor: 'stale' })).rejects.toThrow('400')
  })

  it('getHistoryRun returns the record, undefined on the no-hint 404', async () => {
    const { conn, requests } = submitHarness((url) =>
      url.includes('/api/history/run-1') ? jsonResponse(200, run) : undefined,
    )
    expect(await conn.getHistoryRun('run-1', 'local')).toEqual(run)
    expect(requests[0]?.url).toBe('http://test/api/history/run-1?scope=local')
    const { conn: missing } = submitHarness(() => jsonResponse(404, {}))
    expect(await missing.getHistoryRun('run-1', 'local')).toBeUndefined()
  })

  it('deleteHistoryRun: true on 204, false on 404, throws otherwise', async () => {
    const { conn, requests } = submitHarness((url, init) =>
      url.includes('/api/history/run-1') && init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : undefined,
    )
    expect(await conn.deleteHistoryRun('run-1', 'local')).toBe(true)
    expect(requests[0]?.url).toBe('http://test/api/history/run-1?scope=local')
    const { conn: gone } = submitHarness(() => jsonResponse(404, {}))
    expect(await gone.deleteHistoryRun('run-1', 'local')).toBe(false)
    const { conn: broken } = submitHarness(() => jsonResponse(500, {}))
    await expect(broken.deleteHistoryRun('run-1', 'local')).rejects.toThrow('500')
  })

  it('clearHistory DELETEs with the exact-filter vocabulary and returns the count', async () => {
    const { conn, requests } = submitHarness((url, init) =>
      url.includes('/api/history?') && init?.method === 'DELETE'
        ? jsonResponse(200, { deleted: 7 })
        : undefined,
    )
    expect(await conn.clearHistory({ scope: 'local', state: 'failed', before: 9.5 })).toBe(7)
    const url = new URL(requests[0]!.url)
    expect(url.searchParams.get('scope')).toBe('local')
    expect(url.searchParams.get('state')).toBe('failed')
    expect(url.searchParams.get('before')).toBe('9.5')
    expect(url.searchParams.has('clientId')).toBe(false)
  })
})

describe('uuidv4 (default jobId factory)', () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('produces a v4 UUID WITHOUT crypto.randomUUID (plain-HTTP LAN/tailnet origins)', () => {
    // Insecure browsing contexts expose getRandomValues but not randomUUID;
    // the default jobId factory must not fail every submit there.
    const real = globalThis.crypto
    const insecure = { getRandomValues: real.getRandomValues.bind(real) }
    vi.stubGlobal('crypto', insecure)
    try {
      const a = uuidv4()
      const b = uuidv4()
      expect(a).toMatch(V4)
      expect(b).toMatch(V4)
      expect(a).not.toBe(b)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('memory telemetry transport', () => {

  it('uses the detail query only on request and emits pushed memory_status outside normalized execution events', async () => {
    const urls: string[] = []
    let socket!: WebSocketLike
    const connection = new DinksterConnection({
      id: C0, baseUrl: 'http://test', clientId: 'client',
      fetchFn: async (url) => { urls.push(String(url)); return jsonResponse(200, { devices: {}, queue: { queued: 0, running: [], maxRunningJobs: 1, paused: false }, memoryGovernor: null, leases: null }) },
      webSocketFactory: () => (socket = { binaryType: '', onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => {} }),
    })
    await connection.fetchMemoryStatus()
    await connection.fetchMemoryStatus(true)
    expect(urls).toEqual(['http://test/memory/status', 'http://test/memory/status?details=1'])
    const memory = vi.fn(); const events = vi.fn()
    connection.onMemoryStatus(memory); connection.onEvent(events)
    connection.connect(); socket.onopen?.({})
    socket.onmessage?.({ data: JSON.stringify({ type: 'memory_status', devices: {}, queue: { queued: 0, running: [], maxRunningJobs: 1, paused: false }, memoryGovernor: null, leases: null }) })
    expect(memory).toHaveBeenCalledOnce()
    expect(events).not.toHaveBeenCalled()
    socket.onmessage?.({ data: JSON.stringify({ type: 'memory_status' }) })
    expect(memory).toHaveBeenCalledOnce()
  })

})

it('reads workflow plans without sending a hardware guess or acquisition consent', async () => {
  const workflow = loadDocument(readJson('fixtures/workflows/minimal.json')).document
  expect(workflow).toBeDefined()
  const plan = {
    packs: [{ pack: 'tools-a', version: '1.2.3' }],
    assets: [{ digest: `blake3:${'a'.repeat(64)}`, name: 'first.bin', sources: ['https://models.example.test/first'], packagedFrom: ['starter'] }],
    errors: [],
  }
  let payload: unknown = plan
  const { conn, requests } = submitHarness(() => jsonResponse(200, payload))
  await expect(conn.planWorkflowRequirements(workflow!)).resolves.toEqual(plan)
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ workflows: [workflow] })
  payload = { ...plan, packs: [{ pack: 'tools-a', version: 123 }] }
  await expect(conn.planWorkflowRequirements(workflow!)).rejects.toThrow('invalid workflow requirement plan')
  payload = { ...plan, assets: [{ ...plan.assets[0], sources: 'not-a-list' }] }
  await expect(conn.planWorkflowRequirements(workflow!)).rejects.toThrow('invalid workflow requirement plan')
})
