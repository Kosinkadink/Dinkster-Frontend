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
  loadDocument,
  type CompileArtifact,
  type Diagnostic,
  type DinksterNodesPayload,
  type ExecutionRef,
  type NormalizedEvent,
  type Prompt,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  buildDinksterRegistry,
  DinksterConnection,
  ExecutionStore,
  IMAGE_DOCUMENT_MEDIA_TYPE,
  parseAssetsMissingRejection,
  promptToDinksterGraph,
  reconcileDinksterExecutions,
  targetsForArtifact,
  type FetchLike,
  type WebSocketLike,
} from '../src/index.js'
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

it('includes output profile detector revision in registry identity', () => {
  const payload = (revision: string): DinksterNodesPayload => ({
    schemaVersion: 1,
    nodes: { 'dinkster.load_model_profile': { schemaVersion: 1, interface: [
      { role: 'input', id: 'checkpoint', required: true, type: { kind: 'concrete', types: ['ASSET'] } },
      { role: 'input', id: 'entries', required: true, type: { kind: 'concrete', types: ['STRING'] } },
      { role: 'outputDescriptors', input: 'entries', choices: ['model', 'clip', 'vae'].map((id) => ({ id, type: { kind: 'concrete', types: [id.toUpperCase()] } })), minEntries: 1, maxEntries: 3, fixedIds: true, probe: { input: 'checkpoint', kind: 'model', revision } },
    ] } },
  })
  const first = buildDinksterRegistry(C0, payload('1'))
  const second = buildDinksterRegistry(C0, payload('2'))
  expect(first.resolve('dinkster.load_model_profile')).toBeDefined()
  expect(second.resolve('dinkster.load_model_profile')).toBeDefined()
  expect(first.hash).not.toBe(second.hash)
})

describe('schema registry identity', () => {
  it('excludes the wire 42 help availability marker from execution identity', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Documented: { schemaVersion: 1, interface: [] } },
    } as unknown as DinksterNodesPayload
    const withDocs = structuredClone(base) as any
    withDocs.nodes.Documented.hasDocs = true
    expect(buildDinksterRegistry(C0, withDocs).resolve('Documented')?.hasDocs).toBe(true)
    expect(buildDinksterRegistry(C0, withDocs).hash).toBe(buildDinksterRegistry(C0, base).hash)
  })

  it('normalizes false storage acceptance but retains true in registry cache identity', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Storage: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'value', required: true,
          type: { kind: 'concrete', types: ['IMAGE'] },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const explicitlyFalse = structuredClone(base) as any
    explicitlyFalse.nodes.Storage.interface[0].acceptsStorage = false
    const accepted = structuredClone(base) as any
    accepted.nodes.Storage.interface[0].acceptsStorage = true
    expect(buildDinksterRegistry(C0, base).hash).toBe(buildDinksterRegistry(C0, explicitlyFalse).hash)
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, accepted).hash)
    expect(buildDinksterRegistry(C0, accepted).resolve('Storage')?.items[0]).toMatchObject({ acceptsStorage: true })
    expect(buildDinksterRegistry(C0, accepted).resolve('Storage')?.signature).toBe('backend-signature')
  })

  it('normalizes false stream acceptance and hashes stream and chunk policies', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Stream: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'image', required: true,
          type: { kind: 'concrete', types: ['IMAGE'] },
        }, {
          role: 'output', id: 'image',
          type: { kind: 'concrete', types: ['IMAGE'] },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const explicitlyFalse = structuredClone(base) as any
    explicitlyFalse.nodes.Stream.interface[0].acceptsStream = false
    const accepted = structuredClone(base) as any
    accepted.nodes.Stream.interface[0].acceptsStream = true
    const chunked = structuredClone(accepted) as any
    chunked.nodes.Stream.chunkSafe = { inputs: ['image'], outputs: ['image'] }
    const scoped = structuredClone(chunked) as any
    scoped.nodes.Stream.interface.splice(1, 0, {
      role: 'dynamicCombo', id: 'operation', required: true,
      options: [{ key: 'map', inputs: [] }],
    })
    const unscoped = structuredClone(scoped)
    scoped.nodes.Stream.chunkSafe.applies = { operation: ['map'] }

    const normalized = buildDinksterRegistry(C0, explicitlyFalse)
    expect(normalized.resolve('Stream')).toEqual(buildDinksterRegistry(C0, base).resolve('Stream'))
    expect(normalized.hash).toBe(buildDinksterRegistry(C0, base).hash)
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, accepted).hash)
    expect(buildDinksterRegistry(C0, accepted).hash).not.toBe(buildDinksterRegistry(C0, chunked).hash)
    expect(buildDinksterRegistry(C0, unscoped).hash).not.toBe(buildDinksterRegistry(C0, scoped).hash)
    expect(buildDinksterRegistry(C0, scoped).resolve('Stream')?.signature).toBe('backend-signature')
  })

  it.each([{}, { role: 'input' }])('preserves literal default fields named acceptsStorage: %j', (fields) => {
    const payload = (value: unknown): DinksterNodesPayload => ({
      schemaVersion: 1,
      nodes: { Options: {
        schemaVersion: 1, signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'options', required: false,
          type: { kind: 'concrete', types: ['custom.options'] }, default: value,
        }],
      } },
    })
    const omitted = buildDinksterRegistry(C0, payload(fields))
    const present = buildDinksterRegistry(C0, payload({ ...fields, acceptsStorage: false }))
    expect(present.hash).not.toBe(omitted.hash)
  })

  it('includes wire 40 media policies in registry cache identity', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Media: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'image', required: true,
          type: { kind: 'concrete', types: ['IMAGE'] },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const changed = structuredClone(base) as any
    changed.nodes.Media.interface[0].alphaPolicy = 'require'
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, changed).hash)
    expect(buildDinksterRegistry(C0, changed).resolve('Media')?.signature).toBe('backend-signature')
  })

  it('does not include remote COMBO policy fields in the frontend registry hash', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Policy: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'choice', required: true,
          type: { kind: 'concrete', types: ['COMBO'] },
          widget: { type: 'COMBO', remote: { route: '/api/choices/models', refreshButton: true } },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const withPolicy = structuredClone(base) as any
    Object.assign(withPolicy.nodes.Policy.interface[0].widget.remote, {
      controlAfterRefresh: 'last', timeoutMs: 2000, maxRetries: 1, refreshMs: 5000,
    })
    expect(buildDinksterRegistry(C0, base).hash).toBe(buildDinksterRegistry(C0, withPolicy).hash)
  })

  it('excludes MULTI_COMBO presentation while retaining behavior', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Multi: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'choices', required: true,
          type: { kind: 'list', element: { kind: 'concrete', types: ['COMBO'] } },
          widget: { type: 'MULTI_COMBO', options: ['a'] },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const changed = structuredClone(base) as any
    changed.nodes.Multi.interface[0].widget = {
      type: 'MULTI_COMBO', options: ['a'], placeholder: 'Pick', chip: false,
      remote: {
        route: '/api/choices/providers', refreshButton: true,
        controlAfterRefresh: 'last', timeoutMs: 2000, maxRetries: 1, refreshMs: 5000,
      },
    }
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, changed).hash)
    delete changed.nodes.Multi.interface[0].widget.remote
    expect(buildDinksterRegistry(C0, base).hash).toBe(buildDinksterRegistry(C0, changed).hash)
    changed.nodes.Multi.interface[0].widget.options = ['b']
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, changed).hash)
  })

  it('excludes wire 23 choice labels, info, and folders from registry identity', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Sampler: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'sampler', required: true,
          type: { kind: 'concrete', types: ['COMBO'] },
          widget: { type: 'COMBO', options: [{
            value: 'dinkster.euler', label: 'euler', info: 'Euler sampler', folder: 'Basic',
          }] },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const changed = structuredClone(base) as any
    changed.nodes.Sampler.interface[0].widget.options[0] = {
      value: 'dinkster.euler', label: 'Euler', info: 'First-order sampler', folder: 'Solvers/ODE',
    }
    expect(buildDinksterRegistry(C0, base).hash).toBe(buildDinksterRegistry(C0, changed).hash)
    changed.nodes.Sampler.interface[0].widget.options[0].value = 'dinkster.lcm'
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, changed).hash)
  })

  it('excludes wire 23 MULTI_COMBO presentation while retaining option values', () => {
    const base = {
      schemaVersion: 1,
      nodes: { Models: {
        schemaVersion: 1,
        signature: 'backend-signature',
        interface: [{
          role: 'input', id: 'models', required: true,
          type: { kind: 'list', element: { kind: 'concrete', types: ['COMBO'] } },
          widget: { type: 'MULTI_COMBO', options: [{
            value: 'dinkster.first', label: 'First', info: 'First model', folder: 'Models',
          }] },
        }],
      } },
    } as unknown as DinksterNodesPayload
    const changed = structuredClone(base) as any
    changed.nodes.Models.interface[0].widget.options[0] = {
      value: 'dinkster.first', label: 'Primary', info: 'Preferred model', folder: 'Featured',
    }
    expect(buildDinksterRegistry(C0, base).hash).toBe(buildDinksterRegistry(C0, changed).hash)
    changed.nodes.Models.interface[0].widget.options[0].value = 'dinkster.second'
    expect(buildDinksterRegistry(C0, base).hash).not.toBe(buildDinksterRegistry(C0, changed).hash)
  })
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

  it('decodes a missing mountChangesAllowed as false (older backends degrade to read-only)', async () => {
    const fetch = (payload: unknown): DinksterConnection =>
      new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(200, payload) })
    await expect(fetch({ mounts: [] }).fetchMountSettings()).resolves.toMatchObject({ mountChangesAllowed: false })
    await expect(fetch({ mounts: [], mountChangesAllowed: undefined }).fetchMountSettings()).resolves.toMatchObject({ mountChangesAllowed: false })
  })

  it('rejects present non-boolean mountChangesAllowed', async () => {
    const fetch = (payload: unknown): DinksterConnection =>
      new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(200, payload) })
    for (const bad of ['true', 'false', 1, 0, null]) {
      await expect(fetch({ mounts: [], mountChangesAllowed: bad }).fetchMountSettings()).rejects.toThrow('malformed mountChangesAllowed')
    }
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

  it('drops rows with an unknown mode or malformed shape, keeps the rest', async () => {
    const mounts = await connectionWith([
      { id: 'good', mode: 'read', state: 'ready' },
      { id: 'invented', mode: 'readonly', state: 'ready' }, // the frontend's old guess is NOT server vocabulary
      { id: 'noMode', state: 'ready' },
      { id: 'badKind', mode: 'read', state: 'ready', kind: 42 },
      { id: 'badCount', mode: 'read', state: 'ready', entryCount: -1 },
      'not-an-object',
    ]).listMounts()
    expect(mounts.map((m) => m.id)).toEqual(['good'])
  })

  it('adds and removes a local directory grant with exact server vocabulary', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    const replies = [
      jsonResponse(201, { id: 'shared-models', mode: 'read', state: 'pending' }),
      jsonResponse(200, { removed: 'shared-models' }),
    ]
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) })
      return replies.shift()!
    } })
    await expect(connection.addMount('shared-models', 'D:\\Models', 'read')).resolves.toMatchObject({ id: 'shared-models', state: 'pending' })
    await connection.removeMount('shared-models')
    expect(requests[0]).toMatchObject({
      url: 'http://native/api/mounts',
      init: { method: 'POST', body: JSON.stringify({ id: 'shared-models', path: 'D:\\Models', mode: 'read' }) },
    })
    expect(requests[1]).toMatchObject({ url: 'http://native/api/mounts/shared-models', init: { method: 'DELETE' } })
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

  it('keeps concurrent project folder reads and writes independent', async () => {
    const orders = new Map([['film-a', ['plates', 'renders']], ['film-b', ['renders', 'plates']]])
    const connection = (project: string) => new DinksterConnection({ id: C0, project, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url, init) => {
        const parsed = new URL(String(url))
        const owner = parsed.searchParams.get('project') ?? parsed.pathname.split('/').at(-1)!
        if (init?.method === 'PUT') orders.set(owner, JSON.parse(String(init.body)).mounts)
        return jsonResponse(200, { mounts: orders.get(owner)!.map((id) => ({ id, mode: 'readwrite', state: 'ready' })), outputMount: null, activeOutputMount: null, restartRequired: false, pendingRemovals: [] })
      },
    })
    const a = connection('film-a'), b = connection('film-b')
    const [left, right] = await Promise.all([a.fetchMountSettings(), b.fetchMountSettings()])
    expect(left.mounts.map((row) => row.id)).toEqual(['plates', 'renders'])
    expect(right.mounts.map((row) => row.id)).toEqual(['renders', 'plates'])
    await a.updateProjectFolders(['plates'], null)
    expect((await b.fetchMountSettings()).mounts.map((row) => row.id)).toEqual(['renders', 'plates'])
    expect(await a.fetchMountSettings()).toMatchObject({ restartRequired: false, pendingRemovals: [] })
  })
})

describe('mount entries transport', () => {
  it('encodes folder scope and recursive mode exactly, without an empty cursor', async () => {
    const urls: string[] = []
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url) => {
      urls.push(String(url))
      return jsonResponse(200, { entries: [] })
    } })
    await connection.listMountEntries('mount / one', { q: 'cat photos', path: 'trips/2026', recursive: false, cursor: '', limit: 25 })
    await connection.listMountEntries('m', { recursive: true, cursor: 'next/page' })
    expect(urls).toEqual([
      'http://native/api/mounts/mount%20%2F%20one/entries?q=cat+photos&path=trips%2F2026&recursive=false&limit=25',
      'http://native/api/mounts/m/entries?recursive=true&cursor=next%2Fpage',
    ])
  })

  it('distinguishes omitted folder parameters and parses first-page folders', async () => {
    const urls: string[] = []
    const replies = [
      jsonResponse(200, { entries: [], folders: ['photos', 'models', 42] }),
      jsonResponse(200, { entries: [] }),
    ]
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url) => {
      urls.push(String(url))
      return replies.shift()!
    } })
    expect(await connection.listMountEntries('m', { path: '', recursive: false })).toEqual({ entries: [], folders: ['photos', 'models'] })
    expect(await connection.listMountEntries('m')).toEqual({ entries: [] })
    expect(urls).toEqual([
      '/api/mounts/m/entries?path=&recursive=false',
      '/api/mounts/m/entries?',
    ])
  })

  it('forwards the AbortSignal to the fetch, and omits init without one', async () => {
    // The collection panel aborts superseded pages; a transport that
    // drops the signal keeps dead transfers alive on slow mounts.
    const inits: (RequestInit | undefined)[] = []
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (_url, init) => {
      inits.push(init)
      return jsonResponse(200, { entries: [] })
    } })
    const controller = new AbortController()
    await connection.listMountEntries('m', { q: 'x', signal: controller.signal })
    await connection.listMountEntries('m')
    expect(inits[0]?.signal).toBe(controller.signal)
    expect(inits[1]).toBeUndefined()
  })
})

describe('runtime settings transport', () => {
  it('GETs the per-server discovery response and PUTs category-shaped JSON', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const section = { value: { maxRunningJobs: 3 }, source: 'runtime', mutability: 'live', writable: true, persistence: { available: true, persisted: true } }
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) })
      return calls.length === 1
        ? jsonResponse(200, { categories: { granted: ['jobs'], available: ['jobs'] }, settings: { jobs: section } })
        : jsonResponse(200, section)
    }
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn })
    expect((await connection.fetchRuntimeSettings()).categories.granted).toEqual(['jobs'])
    expect(await connection.updateRuntimeSetting('jobs', { maxRunningJobs: 3 })).toEqual(section)
    expect(calls).toEqual([
      { url: 'http://native/api/settings' },
      { url: 'http://native/api/settings/jobs', init: expect.objectContaining({ method: 'PUT', body: '{"maxRunningJobs":3}' }) },
    ])
  })

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

  it('falls back to status errors for malformed or wrong-status error bodies', async () => {
    const replies = [jsonResponse(403, { error: 'settings-changes-disabled', category: 'jobs' }), jsonResponse(500, { error: 'invalid-settings', category: 'jobs', message: 'not a 400' })]
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => replies.shift()! })
    await expect(connection.updateRuntimeSetting('jobs', {})).rejects.toMatchObject({ status: 403, body: undefined, message: 'runtime settings request failed: 403' })
    await expect(connection.updateRuntimeSetting('jobs', {})).rejects.toMatchObject({ status: 500, body: undefined, message: 'runtime settings request failed: 500' })
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

  it('GETs and PUTs the encoded pack route with a complete values object', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const connection = new DinksterConnection({
      id: C0,
      baseUrl: 'http://native',
      clientId: 'test',
      webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) })
        return jsonResponse(200, calls.length === 1 ? response : { ...response, values: { enabled: false, quality: 4 } })
      },
    })
    await expect(connection.fetchPackSettings('pack/one')).resolves.toEqual(response)
    await expect(connection.updatePackSettings('pack/one', { enabled: false, quality: 4 })).resolves.toMatchObject({ values: { enabled: false, quality: 4 } })
    expect(calls).toEqual([
      { url: 'http://native/api/packs/pack%2Fone/settings' },
      { url: 'http://native/api/packs/pack%2Fone/settings', init: expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false,"quality":4}' }) },
    ])
  })

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
  it.each([true, false, 'true', null])('preserves only boolean local-mode metadata (%s)', async (local) => {
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', fetchFn: async () => jsonResponse(200, [
      { principalId: 'local', kind: 'human', local, categories: {} },
    ]) })
    expect((await connection.fetchPrincipals())[0]?.local).toBe(typeof local === 'boolean' ? local : undefined)
  })

  it('decodes principals and boolean category values', async () => {
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(200, [
      { principalId: 'agent-one', kind: 'agent', categories: { edit: true, execute: false } },
      { principalId: 'person', kind: 'human', categories: { read: true } },
    ]) })

    await expect(connection.fetchPrincipals()).resolves.toEqual([
      { principalId: 'agent-one', kind: 'agent', categories: { edit: true, execute: false } },
      { principalId: 'person', kind: 'human', categories: { read: true } },
    ])
  })

  it('drops malformed principals and non-boolean category values', async () => {
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(200, [
      { principalId: 'valid', kind: 'agent', categories: { edit: true, read: 'yes', queue: false } },
      { principalId: 42, kind: 'agent', categories: {} },
      { principalId: 'missing-kind', categories: {} },
      { principalId: 'array-categories', kind: 'agent', categories: [] },
      null,
    ]) })

    await expect(connection.fetchPrincipals()).resolves.toEqual([
      { principalId: 'valid', kind: 'agent', categories: { edit: true, queue: false } },
    ])
  })

  it('throws a status-bearing error for a failed principal fetch', async () => {
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(403, { error: 'forbidden' }) })
    await expect(connection.fetchPrincipals()).rejects.toMatchObject({ status: 403, message: 'principals request failed: 403' })
  })

  it('PUTs one principal change and returns the updated categories', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) })
      return jsonResponse(200, { edit: false, execute: true, ignored: 'yes' })
    } })

    await expect(connection.updatePrincipalPermissions('agent / one', { execute: true })).resolves.toEqual({ edit: false, execute: true })
    expect(calls).toEqual([{ url: 'http://native/api/principals/agent%20%2F%20one/permissions', init: expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"execute":true}',
    }) }])
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

  it('preserves project-scoped aliases, provenance and canonical refs across catalog pages', async () => {
    const { conn, requests, reply } = harness()
    const signal = new AbortController().signal
    const options = { scope: 'local', q: 'original name', kind: 'media/image', origin: 'upload', since: 0, until: 125, limit: 1, signal }
    const first = await conn.listLocalAssets(options)
    expect(first).toEqual({ assets: [entry], cursor: 'next/page' })
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({
      scope: 'local', project: 'film', q: 'original name', kind: 'media/image', origin: 'upload', since: '0', until: '125', limit: '1',
    })
    expect(requests[0]!.init?.signal).toBe(signal)
    reply({ assets: [{ ...entry, asset: { ...asset, digest: other }, observations: [{ ...observation, asset: { ...asset, digest: other } }] }] })
    expect(await conn.listLocalAssets({ ...options, cursor: first.cursor! })).toEqual({ assets: [{
      ...entry, asset: { ...asset, digest: other }, observations: [{ ...observation, asset: { ...asset, digest: other } }],
    }] })
    expect(new URL(requests[1]!.url).searchParams.get('cursor')).toBe('next/page')
    expect(requests.every((request) => request.init?.method === undefined)).toBe(true)
  })

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

  it('omits empty hint maps and retries an included hinted batch once without hints on 400', async () => {
    const calls: Array<{ names: string[]; digestHints?: Record<string, string> }> = []
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { names: string[]; digestHints?: Record<string, string> }
      calls.push(body)
      if (body.digestHints) return jsonResponse(400, { error: 'unknown request fields' })
      return jsonResponse(200, { matches: body.names.map((query) => ({ query, candidates: [] })) })
    } })

    await expect(connection.guessAssets(['old.bin'], { 'old.bin': `blake3:${'a'.repeat(64)}` })).resolves.toEqual([
      { query: 'old.bin', candidates: [] },
    ])
    await connection.guessAssets(['plain.bin'], { plain: `blake3:${'b'.repeat(64)}` })
    expect(calls).toEqual([
      { names: ['old.bin'], digestHints: { 'old.bin': `blake3:${'a'.repeat(64)}` } },
      { names: ['old.bin'] },
      { names: ['plain.bin'] },
    ])
  })

  it('does not retry an unhinted 400 or a non-400 hinted failure', async () => {
    const statuses = [400, 500]
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(statuses.shift()!, {}) })
    await expect(connection.guessAssets(['plain.bin'])).rejects.toThrow('POST /api/assets/guess failed: 400')
    await expect(connection.guessAssets(['hinted.bin'], { 'hinted.bin': `blake3:${'a'.repeat(64)}` })).rejects.toThrow('POST /api/assets/guess failed: 500')
    expect(statuses).toEqual([])
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

describe('native schema registry', () => {
  it('parses the real /api/nodes fixture with a stable hash', () => {
    const again = buildDinksterRegistry(C0, nodesPayload)
    expect(registry.schemas.size).toBeGreaterThan(0)
    expect(registry.hash).toBe(again.hash)
    expect(registry.resolve('std.math.add_ints')).toBeDefined()
    expect(registry.resolve('NotANode')).toBeUndefined()
  })

  it('carries the server-identity header when present, omits it when absent', () => {
    expect(registry.server).toBeUndefined() // fixture predates the header
    const withHeader = buildDinksterRegistry(C0, {
      ...nodesPayload,
      dinkster: { version: '0.9.0', schemaWire: 1 },
    })
    expect(withHeader.server).toEqual({ version: '0.9.0', schemaWire: 1 })
  })

  it('carries graphFeatures when present, omits it when absent (older backend)', () => {
    expect(registry.graphFeatures).toBeUndefined() // fixture predates the field
    const withFeatures = buildDinksterRegistry(C0, {
      ...nodesPayload,
      dinkster: { version: '0.9.0', schemaWire: 1, graphFeatures: ['typedLiteral'] },
    })
    expect(withFeatures.graphFeatures).toEqual(['typedLiteral'])
  })

  it('carries mergeableTypes when present (incl. empty), omits it when absent (older backend)', () => {
    expect(registry.mergeableTypes).toBeUndefined() // fixture predates the field
    const withProviders = buildDinksterRegistry(C0, {
      ...nodesPayload,
      dinkster: { version: '0.9.0', schemaWire: 1, mergeableTypes: ['comfy.IMAGE'] },
    })
    expect(withProviders.mergeableTypes).toEqual(['comfy.IMAGE'])
    const settledEmpty = buildDinksterRegistry(C0, {
      ...nodesPayload,
      dinkster: { version: '0.9.0', schemaWire: 1, mergeableTypes: [] },
    })
    expect(settledEmpty.mergeableTypes).toEqual([])
  })

  it('decodes epoch + composing when present, omits both when absent or malformed', () => {
    expect(registry.epoch).toBeUndefined() // fixture predates epochs
    expect(registry.composing).toBeUndefined()
    const composing = buildDinksterRegistry(C0, { ...nodesPayload, epoch: 2, composing: true })
    expect(composing.epoch).toBe(2)
    expect(composing.composing).toBe(true)
    // Non-positive/non-integer epochs and composing:false never propagate.
    const bad = buildDinksterRegistry(C0, { ...nodesPayload, epoch: 0.5, composing: false })
    expect(bad.epoch).toBeUndefined()
    expect(bad.composing).toBeUndefined()
  })

  it('resolves legacy names through schema aliases; canonical ids stay primary', () => {
    const comfy = buildDinksterRegistry(C0, readJson('fixtures/dinkster-nodes-comfy.json') as DinksterNodesPayload)
    expect(comfy.resolve('comfy.EmptyImage')?.type).toBe('comfy.EmptyImage')
    expect(comfy.resolve('EmptyImage')?.type).toBe('comfy.EmptyImage')
    expect(comfy.resolve('PreviewImage')?.type).toBe('comfy.PreviewImage')
    expect(comfy.resolve('NotANode')).toBeUndefined()
  })

  it('an alias colliding with a canonical id is ignored; an ambiguous alias resolves to neither', () => {
    const payload = readJson('fixtures/dinkster-nodes-comfy.json') as DinksterNodesPayload
    const nodes = payload.nodes as Record<string, Record<string, unknown>>
    const doctored = {
      ...payload,
      nodes: {
        ...nodes,
        // A real node whose id another schema also claims as an alias.
        'EmptyImage': { ...nodes['comfy.PreviewImage'], nodeType: 'EmptyImage', aliases: [] },
        // Two schemas both claiming 'Legacy'.
        'comfy.A': { ...nodes['comfy.EmptyImage'], nodeType: 'comfy.A', aliases: ['Legacy'] },
        'comfy.B': { ...nodes['comfy.EmptyImage'], nodeType: 'comfy.B', aliases: ['Legacy'] },
      },
    } as DinksterNodesPayload
    const reg = buildDinksterRegistry(C0, doctored)
    // Canonical 'EmptyImage' wins over comfy.EmptyImage's alias claim.
    expect(reg.resolve('EmptyImage')?.type).toBe('EmptyImage')
    // Ambiguity stays loud: no winner, one warning diagnostic.
    expect(reg.resolve('Legacy')).toBeUndefined()
    expect(reg.diagnostics.some((d) => d.code === 'schema.dinkster.aliasCollision')).toBe(true)
  })
})

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

  it.each([null, 'sum', { 0: 'sum' }, [''], [' '], ['sum', 2], ['sum', 'sum'], Array(1)].map((outputIds) => ({ outputIds })))(
    'rejects malformed compiler outputIds $outputIds even when the catalog could resolve the link', ({ outputIds }) => {
      const prompt = {
        source: { class_type: 'std.math.add_ints', inputs: {}, outputIds },
        sink: { class_type: 'std.math.add_ints', inputs: { a: ['source', 0] } },
      } as unknown as Prompt
      const result = promptToDinksterGraph(prompt, registry.resolve)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.diagnostics[0]?.code).toBe('submit.invalidOutputIds')
    },
  )

  it.each([0, 1, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects output index %s against empty compiler IDs without falling back', (index) => {
      const result = promptToDinksterGraph({
        source: { class_type: 'std.math.add_ints', inputs: {}, outputIds: [] },
        sink: { class_type: 'std.math.add_ints', inputs: { a: ['source', index] } },
      }, registry.resolve)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.diagnostics[0]?.code).toBe('submit.unresolvedLink')
      expect(result.diagnostics[0]?.message).toBe(`sink.a: std.math.add_ints has no output #${index}`)
    },
  )

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

  it('passes a $typed marker through verbatim (compile owns emission; the wire relays it)', () => {
    // The typed-literal form (Dinkster ea6eca7) is staged by compile as a Json
    // literal; the graph wire converter must never sniff or rewrite it -
    // only link tuples convert.
    const prompt: Prompt = {
      n0: { class_type: 'std.math.add_ints', inputs: { a: { $typed: { type: 'INT', value: 7 } }, b: 4 } },
    }
    const result = promptToDinksterGraph(prompt, registry.resolve)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.graph.nodes['n0']).toEqual({
      nodeType: 'std.math.add_ints',
      inputs: { a: { $typed: { type: 'INT', value: 7 } }, b: 4 },
    })
  })

  it('passes per-node stored dynamic choices through verbatim, omitted when absent', () => {
    const prompt: Prompt = {
      n0: { class_type: 'std.math.add_ints', inputs: { a: 3, b: 4 } },
      n1: {
        class_type: 'std.math.add_ints',
        inputs: { a: ['n0', 0], b: 10 },
        slotVariants: { a: 'text', 'a.mode': 'advanced' },
      },
    }
    const result = promptToDinksterGraph(prompt, registry.resolve)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.graph.nodes['n0']).not.toHaveProperty('slotVariants')
    expect((result.graph.nodes['n1'] as { slotVariants?: unknown }).slotVariants)
      .toEqual({ a: 'text', 'a.mode': 'advanced' })
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
  it('passes explicit partial targets through untouched', () => {
    const artifact = chainArtifact()
    expect(artifact.partialTargets).toBeDefined()
    expect(targetsForArtifact(artifact, registry.resolve)).toBe(artifact.partialTargets)
  })

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
  it('strictly decodes the complete worker response while allowing additive fields and statuses', async () => {
    const { conn, requests } = submitHarness((url) => url.endsWith('/api/workers')
      ? jsonResponse(200, { workers: [
          {
            name: 'local', status: 'connected', routedNodeTypes: ['std.math.add_ints'],
            deviceQualifiers: [], future: true,
          },
          {
            name: 'render-box', status: 'draining', routedNodeTypes: ['image.upscale'],
            deviceQualifiers: ['@render-box'],
          },
        ], future: true })
      : undefined)

    await expect(conn.fetchWorkers()).resolves.toEqual([
      { name: 'local', status: 'connected', routedNodeTypes: ['std.math.add_ints'], deviceQualifiers: [] },
      { name: 'render-box', status: 'draining', routedNodeTypes: ['image.upscale'], deviceQualifiers: ['@render-box'] },
    ])
    expect(requests[0]?.url).toBe('http://test/api/workers')
  })

  it.each([
    { workers: 'not-an-array' },
    { workers: [{ name: 'local', status: 'connected', routedNodeTypes: [], deviceQualifiers: [1] }] },
    { workers: [
      { name: 'same', status: 'connected', routedNodeTypes: [], deviceQualifiers: [] },
      { name: 'same', status: 'configured', routedNodeTypes: [], deviceQualifiers: [] },
    ] },
  ])('rejects a malformed or ambiguous worker response', async (body) => {
    const { conn } = submitHarness((url) =>
      url.endsWith('/api/workers') ? jsonResponse(200, body) : undefined)
    await expect(conn.fetchWorkers()).rejects.toThrow('GET /api/workers: malformed response')
  })

  it('reports a failed worker request by status', async () => {
    const { conn } = submitHarness((url) =>
      url.endsWith('/api/workers') ? jsonResponse(503, {}) : undefined)
    await expect(conn.fetchWorkers()).rejects.toThrow('GET /api/workers failed: 503')
  })
})

describe('fetchSchemas wire contract', () => {
  it('requests the nodes catalog without version negotiation', async () => {
    const { conn, requests } = submitHarness(nodesRoute)
    await conn.fetchSchemas()
    const nodes = requests.find((r) => r.url.includes('/api/nodes'))!
    expect(new URL(nodes.url, 'http://x').search).toBe('')
  })

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

  it('accepts the current header-shaped payload (wire version in dinkster.schemaWire)', async () => {
    const payload = { schemaVersion: 1, dinkster: { version: '0.1.0', schemaWire: 1 }, nodes: {} }
    const { conn } = submitHarness((url) =>
      url.includes('/api/nodes') ? jsonResponse(200, payload) : undefined,
    )
    const registry = await conn.fetchSchemas()
    expect(registry.schemas.size).toBe(0)
    expect(registry.server).toEqual({ version: '0.1.0', schemaWire: 1 })
    expect(registry.diagnostics).toEqual([])
    expect(conn.currentRegistry).toBe(registry)
  })

  it('rejects a malformed nodes table instead of installing an empty registry', async () => {
    const { conn } = submitHarness((url) =>
      url.includes('/api/nodes') ? jsonResponse(200, { schemaVersion: 1, nodes: 'bad' }) : undefined,
    )
    await expect(conn.fetchSchemas()).rejects.toThrow('malformed or unsupported')
    expect(conn.currentRegistry).toBeUndefined()
  })

  it('rejects an unsupported wire version in a 200 payload', async () => {
    const { conn } = submitHarness((url) =>
      url.includes('/api/nodes') ? jsonResponse(200, { schemaVersion: 99, nodes: {} }) : undefined,
    )
    await expect(conn.fetchSchemas()).rejects.toThrow(
      'schema wire version mismatch: this build decodes 1; the server encodes 99',
    )
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
  it('holds independent paired snapshots for two connections', async () => {
    const a = await snapshotFixture('pack.alpha')
    const b = await snapshotFixture('pack.beta')
    const connection = async (id: string, fixture: { body: string; digest: string }) => {
      const conn = new DinksterConnection({
        id: asConnectionId(id), baseUrl: `http://${id}`, clientId: id,
        webSocketFactory: () => ({}) as WebSocketLike,
        fetchFn: async (url) => url.includes('/api/nodes')
          ? jsonResponse(200, { ...liveNodesPayload, extensionSnapshotDigest: fixture.digest })
          : new Response(fixture.body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      })
      return conn.fetchSchemas()
    }
    const [registryA, registryB] = await Promise.all([connection('a', a), connection('b', b)])
    expect(registryA.extensionSnapshotPair?.digest).toBe(a.digest)
    expect(registryB.extensionSnapshotPair?.digest).toBe(b.digest)
    expect(registryA.extensionSnapshotPair?.snapshot.extensions[0]?.id).toBe('pack.alpha')
    expect(registryB.extensionSnapshotPair?.snapshot.extensions[0]?.id).toBe('pack.beta')
  })

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

  it('invalidates the current connection snapshot pair as one atomic field', async () => {
    const fixture = await snapshotFixture('pack.old')
    const conn = new DinksterConnection({
      id: C0, baseUrl: 'http://native', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url) => url.includes('/api/nodes')
        ? jsonResponse(200, { ...liveNodesPayload, extensionSnapshotDigest: fixture.digest })
        : new Response(fixture.body, { status: 200 }),
    })
    const paired = await conn.fetchSchemas()
    expect(paired.extensionSnapshotPair).toBeDefined()
    conn.invalidateExtensionSnapshotPair()
    expect(conn.currentRegistry?.extensionSnapshotPair).toBeUndefined()
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
  it('rejects cancelling an execution owned by another connection without a request', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, {}))
    await expect(
      conn.cancel({ connection: asConnectionId('other'), prompt: asPromptId('j1') }),
    ).rejects.toThrow('cannot cancel execution')
    expect(requests).toHaveLength(0)
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
  it('treats 404 as absence for reads', async () => {
    const { conn } = submitHarness(() => jsonResponse(404, {}))
    await expect(conn.fetchAssetText('blake3:abc')).resolves.toBeUndefined()
    await expect(conn.getLibraryRecord('id1', 'local')).resolves.toBeUndefined()
    await expect(conn.getHistoryRun('r1', 'local')).resolves.toBeUndefined()
    await expect(conn.fetchTemplateBody('pack', 'tpl')).resolves.toBeUndefined()
  })

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

  it('filters malformed replacement problems and compat skips independently', async () => {
    const missing = { ...problem } as Partial<typeof problem>
    delete missing.message
    const { conn } = submitHarness(() =>
      jsonResponse(200, {
        replacementProblems: [missing, { ...problem, refKind: 'bogus' }, 'bad', problem],
        compatSkips: [
          { ...compatSkip, packId: 7 },
          { ...compatSkip, nodeId: undefined },
          { ...compatSkip, reason: null },
          'bad',
          compatSkip,
        ],
      }),
    )
    expect(await conn.fetchDiagnostics()).toEqual({
      replacementProblems: [problem],
      compatSkips: [compatSkip],
      packInferenceUnavailable: [],
    })
  })

  it('returns an empty diagnostics snapshot for a non-ok response', async () => {
    const { conn } = submitHarness(() => jsonResponse(404, { error: 'not found' }))
    expect(await conn.fetchDiagnostics()).toEqual({ replacementProblems: [], compatSkips: [], packInferenceUnavailable: [] })
  })

  it('returns an empty diagnostics snapshot when fetch throws', async () => {
    const { conn } = submitHarness(() => undefined)
    expect(await conn.fetchDiagnostics()).toEqual({ replacementProblems: [], compatSkips: [], packInferenceUnavailable: [] })
  })

  it('tolerates absent and malformed diagnostics keys independently', async () => {
    const absent = submitHarness(() => jsonResponse(200, {})).conn
    expect(await absent.fetchDiagnostics()).toEqual({ replacementProblems: [], compatSkips: [], packInferenceUnavailable: [] })

    const malformedSkips = submitHarness(() => jsonResponse(200, {
      replacementProblems: [problem],
      compatSkips: { nope: true },
    })).conn
    expect(await malformedSkips.fetchDiagnostics()).toEqual({
      replacementProblems: [problem],
      compatSkips: [],
      packInferenceUnavailable: [],
    })

    const malformedProblems = submitHarness(() => jsonResponse(200, {
      replacementProblems: 'bad',
      compatSkips: [compatSkip],
    })).conn
    expect(await malformedProblems.fetchDiagnostics()).toEqual({
      replacementProblems: [],
      compatSkips: [compatSkip],
      packInferenceUnavailable: [],
    })
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

  it('keeps rows without optional fields and drops malformed ones independently', async () => {
    const { conn } = submitHarness(() => jsonResponse(200, {
      packInferenceUnavailable: [
        { packId: 'pack.bare', reason: 'no worker', providers: [] },
        { reason: 'no packId', providers: [] },
        { packId: '', reason: 'empty packId', providers: [] },
        { packId: 'pack.no-reason', providers: [] },
        { packId: 'pack.bad-entry', reason: 'x', entry: 7, providers: [] },
        { packId: 'pack.bad-worker', reason: 'x', worker: {}, providers: [] },
        { packId: 'pack.no-providers', reason: 'x' },
        { packId: 'pack.bad-provider-row', reason: 'x', providers: ['nope'] },
        { packId: 'pack.bad-provider-fields', reason: 'x', providers: [{ registry: 's', id: 3 }] },
        'not-an-object',
      ],
    }))
    expect(await conn.fetchDiagnostics()).toEqual({
      replacementProblems: [],
      compatSkips: [],
      packInferenceUnavailable: [{ pack: 'pack.bare', reason: 'no worker', providers: [] }],
    })
  })

  it('tolerates a packInferenceUnavailable field that is not a list of rows', async () => {
    const conn = submitHarness(() => jsonResponse(200, {
      replacementProblems: [problem],
      packInferenceUnavailable: 'bad',
    })).conn
    expect(await conn.fetchDiagnostics()).toEqual({
      replacementProblems: [problem],
      compatSkips: [],
      packInferenceUnavailable: [],
    })
    // A map keyed by pack is not the wire the backend emits; it decodes as absent.
    const mapped = submitHarness(() => jsonResponse(200, {
      packInferenceUnavailable: { 'pack.degraded': { reason: 'x', providers: [] } },
    })).conn
    expect(await mapped.fetchDiagnostics()).toEqual({
      replacementProblems: [],
      compatSkips: [],
      packInferenceUnavailable: [],
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

  it.each([
    { packs: [] },
    { packs: { bad: { state: 'failed' } } },
    { packs: { bad: { state: 'unknown' } } },
  ])('does not treat a malformed snapshot as healed', async (body) => {
    const { conn } = submitHarness(() => jsonResponse(200, body))
    await expect(conn.fetchCompositionFailures()).resolves.toBeUndefined()
  })

  it('keeps unavailable and older-backend responses non-authoritative', async () => {
    const absent = submitHarness(() => jsonResponse(404, {})).conn
    const unreachable = submitHarness(() => undefined).conn
    await expect(absent.fetchCompositionFailures()).resolves.toBeUndefined()
    await expect(unreachable.fetchCompositionFailures()).resolves.toBeUndefined()
  })
})

describe('submit', () => {
  it('POSTs transient placement for exact top-level nodes', async () => {
    const { conn, requests } = submitHarness((url, init) =>
      placementNodesRoute(url) ??
      (url.endsWith('/api/jobs') && init?.method === 'POST'
        ? jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' })
        : undefined))
    await conn.fetchSchemas()
    const artifact = {
      ...chainArtifact(),
      schemaHash: buildDinksterRegistry(C0, placementNodesPayload).hash,
    }

    const result = await conn.submit(artifact, { placement: { n0: 'local', n1: 'render-box' } })

    expect(result.ok).toBe(true)
    const body = JSON.parse(requests.find((request) => request.init?.method === 'POST')!.init!.body as string)
    expect(body['placement']).toEqual({ n0: 'local', n1: 'render-box' })
  })

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

  it('POSTs the compiler-owned native region graph without changing the jobs route', async () => {
    const regionGraph = {
      nodes: {
        r: {
          region: {
            kind: 'map' as const,
            ports: { item: { kind: 'concrete', types: ['INT'] } },
            elementPorts: ['item'],
            inputs: { item: [1, 2] },
            body: {
              nodes: {
                add: {
                  nodeType: 'std.math.add_ints',
                  inputs: { a: { $link: { node: '$region', output: 'item' } }, b: 1 },
                },
              },
            },
            outputs: { sums: { source: { node: 'add', output: 'sum' } } },
          },
        },
      },
    }
    const artifact: CompileArtifact = {
      ...chainArtifact(),
      schemaHash: buildDinksterRegistry(C0, regionNodesPayload).hash,
      dinksterGraph: regionGraph,
      dinksterTargets: ['r'],
    }
    const { conn, requests } = submitHarness(
      (url, init) => url.includes('/api/nodes')
        ? jsonResponse(200, regionNodesPayload)
        : url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' })
          : undefined,
    )
    await conn.fetchSchemas()
    const submitted = await conn.submit(artifact)
    expect(submitted.ok, submitted.ok ? undefined : JSON.stringify(submitted.diagnostics)).toBe(true)
    const post = requests.find((request) => request.init?.method === 'POST')!
    expect(JSON.parse(post.init!.body as string)).toMatchObject({
      targets: ['r'],
      graph: regionGraph,
    })
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

  it('surfaces the server-assigned jobRef from the 202 body', async () => {
    const { conn } = submitHarness(
      (url, init) =>
        nodesRoute(url) ??
        (url.endsWith('/api/jobs') && init?.method === 'POST'
          ? jsonResponse(202, {
              clientId: 'cid',
              jobId: 'job-fixed',
              state: 'queued',
              jobRef: '0198c2f1a4b85e2d9f3a7c6b1d4e8f02',
              runId: '0198c2f1a4b85e2d9f3a7c6b1d4e8f02',
            })
          : undefined),
    )
    await conn.fetchSchemas()
    const result = await conn.submit(chainArtifact())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.jobRef).toBe('0198c2f1a4b85e2d9f3a7c6b1d4e8f02')
  })

  it('accepts a pre-jobRef 202 (missing, non-string, or unparseable body) with jobRef undefined', async () => {
    const bodies = [
      jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' }),
      jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', jobRef: 42 }),
      new Response('not json', { status: 202 }),
    ]
    for (const accepted of bodies) {
      const { conn } = submitHarness(
        (url, init) =>
          nodesRoute(url) ??
          (url.endsWith('/api/jobs') && init?.method === 'POST' ? accepted : undefined),
      )
      await conn.fetchSchemas()
      const result = await conn.submit(chainArtifact())
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.jobRef).toBeUndefined()
    }
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

  it('keeps the legacy assets-missing shape valid when enriched fields are absent', () => {
    expect(parseAssetsMissingRejection({
      error: 'assets-missing',
      assets: [{ digest: 'custom:abc', name: 'legacy', status: 'missing', sources: [], fetchable: false, extra: 1 }],
      extra: true,
    })?.assets[0]).toEqual({ digest: 'custom:abc', name: 'legacy', status: 'missing', sources: [], fetchable: false })
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

  it('decodes optional submitter attribution and ignores missing or malformed values', async () => {
    const { conn } = replayHarness({
      '/api/jobs/cid/agent': {
        ...completedJob,
        jobId: 'agent',
        submittedBy: { principalId: 'build-agent', kind: 'agent' },
      },
      '/api/jobs/cid/plain': { ...completedJob, jobId: 'plain' },
      '/api/jobs/cid/bad-kind': {
        ...completedJob,
        jobId: 'bad-kind',
        submittedBy: { principalId: 'build-agent', kind: 'robot' },
      },
      '/api/jobs/cid/bad-id': {
        ...completedJob,
        jobId: 'bad-id',
        submittedBy: { principalId: 42, kind: 'agent' },
      },
      '/api/jobs/cid/bad-shape': {
        ...completedJob,
        jobId: 'bad-shape',
        submittedBy: ['build-agent', 'agent'],
      },
    })

    expect((await conn.fetchJob('agent'))?.submittedBy).toEqual({
      principalId: 'build-agent',
      kind: 'agent',
    })
    expect((await conn.fetchJob('plain'))?.submittedBy).toBeUndefined()
    expect((await conn.fetchJob('bad-kind'))?.submittedBy).toBeUndefined()
    expect((await conn.fetchJob('bad-id'))?.submittedBy).toBeUndefined()
    expect((await conn.fetchJob('bad-shape'))?.submittedBy).toBeUndefined()
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

  it('keeps saved files when their optional preview metadata is malformed', async () => {
    const valid = {
      digest: `blake3:${'a'.repeat(64)}`, name: 'preview.webp', size: 238,
      mediaType: 'image/webp', virtualPath: `previews/${'a'.repeat(64)}/preview.webp`,
    }
    for (const preview of [
      null, {}, { digest: 'bad' }, { ...videoArtifact, preview: {} },
      { ...valid, size: 0 }, { ...valid, size: 16 * 1024 * 1024 + 1 },
      { ...valid, name: '../preview.webp' }, { ...valid, virtualPath: 'output/preview.webp' },
    ]) {
      const { conn } = replayHarness({
        '/api/jobs/cid/j1': { ...completedJob, artifacts: [{ ...videoArtifact, preview }] },
      })
      expect((await conn.fetchJob('j1'))?.artifacts).toEqual([videoArtifact])
    }
  })

  it('ignores the entire optional artifact field when its required shape or bounds are invalid', async () => {
    const invalid = [
      [{ ...videoArtifact, unexpected: true }],
      [{ ...videoArtifact, digest: 'blake3:short' }],
      [{ ...videoArtifact, size: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...videoArtifact, size: -1 }],
      [{ ...videoArtifact, mediaType: 'not a MIME type' }],
    ]
    for (const artifacts of invalid) {
      const { conn } = replayHarness({ '/api/jobs/cid/j1': { ...completedJob, artifacts } })
      const job = await conn.fetchJob('j1')
      expect(job?.state).toBe('completed')
      expect(job?.artifacts).toBeUndefined()
      expect(job?.outputs).toEqual(completedJob.outputs)
    }
  })

  it('CL1 rejects a malformed job state instead of reconciling it', async () => {
    const { conn } = replayHarness({ '/api/jobs/cid/j1': { ...completedJob, state: 'exploded' } })
    await expect(conn.fetchJob('j1')).rejects.toThrow('malformed response')
  })

  it('CL1 rejects a non-string job state even when it coerces to a known state', async () => {
    // String(['completed']) === 'completed' - a coercing validator would
    // accept this record, but every strict terminal comparison downstream
    // would fail, leaving the execution running forever.
    const { conn } = replayHarness({ '/api/jobs/cid/j1': { ...completedJob, state: ['completed'] } })
    await expect(conn.fetchJob('j1')).rejects.toThrow('malformed response')
  })

  it('CL1 rejects a job record whose identity does not match the request', async () => {
    const wrongJob = replayHarness({ '/api/jobs/cid/j1': { ...completedJob, jobId: 'other' } })
    await expect(wrongJob.conn.fetchJob('j1')).rejects.toThrow('identity mismatch')
    const wrongClient = replayHarness({ '/api/jobs/cid/j1': { ...completedJob, clientId: 'not-cid' } })
    await expect(wrongClient.conn.fetchJob('j1')).rejects.toThrow('clientId mismatch')
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

  it('notifies live completion hydration without retriggering it for fetched replays', () => {
    const { conn } = replayHarness({})
    const completed = vi.fn()
    conn.onLiveCompletion(completed)
    conn.ingest({ type: 'run_finished', jobId: 'live' })
    expect(completed).not.toHaveBeenCalled()
    conn.ingest({ type: 'job_state', jobId: 'live', state: 'completed' })
    expect(completed).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledWith(ref('live'))
    conn.replayJob('replayed', { state: 'completed' })
    expect(completed).toHaveBeenCalledOnce()
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
    const { conn, store } = harness({
      '/api/jobs/cid/gap': { state: 'completed', artifacts },
    })
    conn.ingest({ type: 'run_finished', jobId: 'gap' })
    expect(store.get(ref('gap'))).toMatchObject({ status: 'completed', artifactsHydrated: false })

    await reconcileDinksterExecutions(conn, store)

    expect(store.get(ref('gap'))).toMatchObject({
      status: 'completed',
      artifacts,
      artifactsHydrated: true,
    })
  })

  it('treats an authoritative empty artifact field as hydrated and does not refetch it', async () => {
    const { conn, store, requested } = harness({
      '/api/jobs/cid/empty': { state: 'completed', artifacts: [] },
    })
    conn.ingest({ type: 'run_finished', jobId: 'empty' })

    await reconcileDinksterExecutions(conn, store)
    await reconcileDinksterExecutions(conn, store)

    expect(store.get(ref('empty'))).toMatchObject({
      status: 'completed',
      artifacts: [],
      artifactsHydrated: true,
    })
    expect(requested.filter((url) => url.endsWith('/api/jobs/cid/empty'))).toHaveLength(1)
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

  it('leaves an execution alone when its job is still running', async () => {
    const { conn, store, seedRunning } = harness({
      '/api/jobs/cid/j3': { state: 'running', nodeStates: { n0: 'running' } },
    })
    seedRunning('j3')
    await reconcileDinksterExecutions(conn, store)
    expect(store.get(ref('j3'))!.status).toBe('running')
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

  it('FR-6 rejects hydration when any per-node output record is malformed', async () => {
    const { conn, store, seedRunning } = harness({
      '/api/jobs/cid/j7': {
        state: 'completed',
        outputs: { good: { out: { typeId: 't', fingerprint: 'f' } }, bad: null },
      },
    })
    seedRunning('j7')
    await reconcileDinksterExecutions(conn, store)
    const state = store.get(ref('j7'))!
    expect(state.status).toBe('completed') // the terminal replay still lands
    expect(state.outputs).toEqual({}) // all-or-nothing: nothing manufactured
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

  it('never touches authoritative terminal executions - or the network for them', async () => {
    const { conn, store, requested, seedRunning } = harness({})
    seedRunning('j5')
    store.apply({ kind: 'completed', execution: ref('j5'), timestamp: 5 })
    store.hydrateArtifacts(ref('j5'), [])
    await reconcileDinksterExecutions(conn, store)
    expect(store.get(ref('j5'))!.status).toBe('completed')
    expect(requested).toEqual([])
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

  it('coalesces concurrent backfills of one run', async () => {
    const { conn, requested } = harness({
      [journalUrl('r3', 0)]: { records: [], latestSeq: 0, coalescedBelow: 0 },
    })
    await Promise.all([conn.backfillRunLog('r3', 'local'), conn.backfillRunLog('r3', 'local')])
    expect(requested).toEqual([journalUrl('r3', 0)])
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

  it('does not backfill when a job is first seen from its first event', async () => {
    const { conn, requested } = harness({})
    conn.ingest({ type: 'job_state', jobId: 'j10', state: 'queued', seq: 1 })
    conn.ingest(logWire('j10', 'r10', 2, 'info', 'first log'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requested).toEqual([])
  })

  it('stays quiet when the backfill trigger hits a journal-less or older server', async () => {
    const { conn, store, requested } = harness({
      // Job record without jobRef/runId: a server that predates the journal.
      'http://test/api/jobs/cid/j11': { state: 'running', jobId: 'j11' },
    })
    conn.ingest(logWire('j11', 'r11', 5, 'info', 'live row'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requested).toEqual(['http://test/api/jobs/cid/j11'])
    expect(store.get(ref('j11'))!.logs.map((l) => l.seq)).toEqual([5])
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

  it('derives the native events url and stays silent on open (no handshake)', () => {
    const { conn, ws } = connected()
    expect(ws.url).toBe('ws://test/api/events?clientId=cid')
    expect(ws.binaryType).toBe('arraybuffer')
    ws.onopen?.({})
    expect(conn.status.get()).toBe('connected')
    expect(ws.sent).toEqual([])
  })

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

  it('CL6 reports an undecodable binary frame as a protocol error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ws, events } = connected()
      ws.onopen?.({})
      ws.onmessage?.({ data: new Uint8Array([1, 2]).buffer }) // too short for a header
      expect(events).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed binary WebSocket frame'))
    } finally {
      warn.mockRestore()
    }
  })

  it('R2-6 reports a malformed KNOWN event as a protocol error instead of a silent drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ws, events } = connected()
      ws.onopen?.({})
      // A job_state outside the state vocabulary would strand the run as
      // running if it vanished silently.
      ws.onmessage?.({ data: JSON.stringify({ type: 'job_state', jobId: 'j1', state: 'explodinated' }) })
      expect(events).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("job_state with unknown state 'explodinated'"))
      warn.mockClear()
      // Unknown kinds and uncorrelated runId-only stragglers stay silent.
      ws.onmessage?.({ data: JSON.stringify({ type: 'totally_new_kind', jobId: 'j1' }) })
      ws.onmessage?.({ data: JSON.stringify({ type: 'node_started', nodeId: 'x', runId: 'never-seen' }) })
      expect(events).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
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

  it('uploadAsset POSTs opaque bytes and returns the digest', async () => {
    const { conn, requests } = submitHarness((url, init) =>
      url.endsWith('/api/assets') && init?.method === 'POST'
        ? jsonResponse(201, { digest: DIGEST })
        : undefined,
    )
    expect(await conn.uploadAsset('{"doc":true}')).toBe(DIGEST)
    expect(requests[0]?.url).toBe('http://test/api/assets')
    expect(requests[0]?.init?.body).toBe('{"doc":true}')
  })

  it('uploadAsset passes binary bodies through unchanged', async () => {
    const body = new Uint8Array([0, 255, 17])
    const { conn, requests } = submitHarness(() => jsonResponse(200, { digest: DIGEST }))
    expect(await conn.uploadAsset(body)).toBe(DIGEST)
    expect(requests[0]?.init?.body).toBe(body)
    expect(new Headers(requests[0]?.init?.headers).get('Content-Type')).toBe('application/octet-stream')
  })

  it.each([
    ['Blob', () => new Blob([new Uint8Array([0, 255, 17, 33])], { type: 'image/png' })],
    ['File', () => new File([new Uint8Array([0, 255, 17, 33])], 'proof.png', { type: 'image/png' })],
  ])('uploadAsset passes the exact %s object and its bytes to fetch', async (_kind, makeBody) => {
    const body = makeBody()
    const { conn, requests } = submitHarness(() => jsonResponse(201, { digest: DIGEST }))
    expect(await conn.uploadAsset(body)).toBe(DIGEST)
    expect(requests[0]?.init?.body).toBe(body)
    expect(new Uint8Array(await (requests[0]?.init?.body as Blob).arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 17, 33]),
    )
  })

  it('uploadAsset throws on failure (e.g. a server without --library-root)', async () => {
    const { conn } = submitHarness(() => jsonResponse(404, { error: 'unknown' }))
    await expect(conn.uploadAsset('x')).rejects.toThrow('404')
  })

  it('uploadAsset forwards the abort signal to fetch (upload UIs need a cancel path)', async () => {
    const { conn, requests } = submitHarness(() => jsonResponse(200, { digest: DIGEST }))
    const controller = new AbortController()
    expect(await conn.uploadAsset('x', controller.signal)).toBe(DIGEST)
    expect(requests[0]?.init?.signal).toBe(controller.signal)
    // Without a signal the request carries none (nothing implicit).
    expect(await conn.uploadAsset('x')).toBe(DIGEST)
    expect(requests[1]?.init && 'signal' in requests[1].init).toBe(false)
  })

  it('adopts canonical ImageDocument bytes and validates the typed response', async () => {
    const body = '{"format":"dinkster-image"}'
    const controller = new AbortController()
    const { conn, requests } = submitHarness(() => jsonResponse(201, {
      digest: DIGEST,
      mediaType: 'application/vnd.dinkster.image-document+json',
      byteSize: body.length,
      dependencies: [{ ...imageDependency, ignored: true }],
    }))
    await expect(conn.adoptImageDocument(body, {
      scope: 'local', expectedDigest: DIGEST, signal: controller.signal,
    })).resolves.toEqual({
      digest: DIGEST,
      mediaType: 'application/vnd.dinkster.image-document+json',
      byteSize: body.length,
      dependencies: [imageDependency],
    })
    const request = requests[0]!
    expect(new URL(request.url).searchParams.get('scope')).toBe('local')
    expect(request.init?.body).toBe(body)
    expect(request.init?.signal).toBe(controller.signal)
    const headers = new Headers(request.init?.headers)
    expect(headers.get('Content-Type')).toBe('application/vnd.dinkster.image-document+json')
    expect(headers.get('X-Dinkster-Digest')).toBe(DIGEST)

    const { conn: malformed } = submitHarness(() => jsonResponse(200, {
      digest: DIGEST,
      mediaType: 'application/vnd.dinkster.image-document+json',
      byteSize: body.length,
      dependencies: [{ ...imageDependency, width: 0 }],
    }))
    await expect(malformed.adoptImageDocument(body, { scope: 'local' })).rejects.toThrow('malformed')
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

  it('uploadMediaAsset posts exact bytes and adopts the canonical server AssetRef', async () => {
    const body = new File([new Uint8Array([137, 80, 78, 71])], '../unsafe/path/proof.png', { type: 'image/png' })
    const { conn, requests } = submitHarness(() => jsonResponse(201, {
      asset: MEDIA_ASSET,
      kind: 'media/image',
    }))
    expect(await conn.uploadMediaAsset(body, {
      scope: 'local', kind: 'media/image', name: 'proof.png', expectedDigest: DIGEST,
    })).toEqual(MEDIA_ASSET)
    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.pathname).toBe('/api/assets/media')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'local', kind: 'media/image', name: 'proof.png' })
    expect(request.init?.body).toBe(body)
    const headers = new Headers(request.init?.headers)
    expect(headers.get('Content-Type')).toBe('image/png')
    expect(headers.get('X-Dinkster-Digest')).toBe(DIGEST)
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

  it('named upload leaves the default destination to the server without changing anonymous vault uploads', async () => {
    const body = new File(['weights'], 'model.safetensors')
    const asset = { ...MEDIA_ASSET, name: body.name, mediaType: 'application/octet-stream', virtualPath: 'mounts/imports/model.safetensors' }
    const { conn, requests } = submitHarness(() => jsonResponse(201, { digest: DIGEST, asset }))
    await expect(conn.uploadNamedAsset(body, { scope: 'local', name: body.name })).resolves.toEqual(asset)
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({ scope: 'local', name: 'model.safetensors' })
    expect(new Headers(requests[0]?.init?.headers).get('Content-Type')).toBe('application/octet-stream')
    expect(await conn.uploadAsset(body)).toBe(DIGEST)
    expect(requests[1]?.url).toBe('http://test/api/assets')
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

  it('uploadMediaAsset rejects malformed canonical responses', async () => {
    const body = new File(['x'], 'x.png', { type: 'image/png' })
    const { conn } = submitHarness(() => jsonResponse(201, {
      asset: { ...MEDIA_ASSET, size: -1 }, kind: 'media/image',
    }))
    await expect(conn.uploadMediaAsset(body, {
      scope: 'local', kind: 'media/image', name: 'x.png',
    })).rejects.toThrow('malformed response')
  })

  it('uploadLatentAsset uses the classified latent route without reading or copying the File', async () => {
    const body = new File([new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0])], 'private.safetensors', { type: 'application/octet-stream' })
    const read = vi.spyOn(body, 'arrayBuffer')
    const asset = { ...MEDIA_ASSET, name: 'server.latent', mediaType: 'application/x-comfy-latent' }
    const controller = new AbortController()
    const { conn, requests } = submitHarness(() => jsonResponse(201, { asset, kind: 'data/latent' }))
    await expect(conn.uploadLatentAsset(body, {
      scope: 'local', name: 'dropped-latent.latent', signal: controller.signal,
    })).resolves.toEqual(asset)
    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.pathname).toBe('/api/assets/latent')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'local', name: 'dropped-latent.latent' })
    expect(request.init?.body).toBe(body)
    expect(request.init?.signal).toBe(controller.signal)
    expect(new Headers(request.init?.headers).get('Content-Type')).toBe('application/x-comfy-latent')
    expect(read).not.toHaveBeenCalled()
  })

  it('uploadLatentAsset rejects the wrong classified kind or incomplete AssetRef', async () => {
    const body = new File(['x'], 'x.latent')
    const wrongKind = submitHarness(() => jsonResponse(201, { asset: MEDIA_ASSET, kind: 'media/image' })).conn
    await expect(wrongKind.uploadLatentAsset(body, { scope: 'local', name: 'x.latent' })).rejects.toThrow('malformed response')
    const malformed = submitHarness(() => jsonResponse(201, {
      asset: { ...MEDIA_ASSET, digest: 'not-a-digest' }, kind: 'data/latent',
    })).conn
    await expect(malformed.uploadLatentAsset(body, { scope: 'local', name: 'x.latent' })).rejects.toThrow('malformed response')
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

  it('listLibrary sends the query-first request and skips malformed records', async () => {
    const { conn, requests } = submitHarness((url) =>
      url.includes('/api/library?')
        ? jsonResponse(200, { records: [record, { id: 'broken' }, 'junk'], cursor: 'c1' })
        : undefined,
    )
    const page = await conn.listLibrary({
      scope: 'local',
      query: 'flow',
      label: 'workflow',
      limit: 24,
      cursor: 'c0',
    })
    expect(page.records).toEqual([record])
    expect(page.cursor).toBe('c1')
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe('/api/library')
    expect(url.searchParams.get('scope')).toBe('local')
    expect(url.searchParams.get('q')).toBe('flow')
    expect(url.searchParams.get('label')).toBe('workflow')
    expect(url.searchParams.get('limit')).toBe('24')
    expect(url.searchParams.get('cursor')).toBe('c0')
  })

  it('listLibrary omits empty query and absent cursor; exhausted pages have no cursor', async () => {
    const { conn, requests } = submitHarness((url) =>
      url.includes('/api/library?') ? jsonResponse(200, { records: [] }) : undefined,
    )
    const page = await conn.listLibrary({ scope: 'local', query: '' })
    expect(page).toEqual({ records: [] })
    const url = new URL(requests[0]!.url)
    expect(url.searchParams.has('q')).toBe(false)
    expect(url.searchParams.has('cursor')).toBe(false)
  })

  it('listLibrary throws on a rejected cursor (restart from page one)', async () => {
    const { conn } = submitHarness(() => jsonResponse(400, { error: 'cursor-query-mismatch' }))
    await expect(conn.listLibrary({ scope: 'local', cursor: 'stale' })).rejects.toThrow('400')
  })

  it('listTemplates decodes absent optionals, tolerates extras, and sends paging filters', async () => {
    const descriptor = { pack: 'demo.pack', id: 'starter', name: 'Starter', digest: 'sha256:abc', extra: true }
    const { conn, requests } = submitHarness((url) => url.includes('/api/templates?')
      ? jsonResponse(200, { templates: [descriptor, { id: 'bad' }], cursor: 'next', extra: 1 })
      : undefined)
    const page = await conn.listTemplates({ q: 'start', tag: 'image', pack: 'demo.pack', limit: 2, cursor: 'old' })
    expect(page).toEqual({ templates: [{ pack: 'demo.pack', id: 'starter', name: 'Starter', digest: 'sha256:abc' }], cursor: 'next' })
    const url = new URL(requests[0]!.url)
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'start', tag: 'image', pack: 'demo.pack', limit: '2', cursor: 'old' })
  })

  it('listTemplates preserves optional arrays and surfaces cursor mismatch', async () => {
    const full = { pack: 'p', id: 't', name: 'T', description: 'D', tags: ['x'], assets: ['model'], digest: 'sha256:x' }
    const { conn } = submitHarness(() => jsonResponse(200, { templates: [full] }))
    expect((await conn.listTemplates()).templates[0]).toEqual(full)
    const { conn: mismatch } = submitHarness(() => jsonResponse(400, { error: 'cursor does not match this query' }))
    await expect(mismatch.listTemplates({ cursor: 'wrong' })).rejects.toThrow('400')
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

  it('listDocs skips malformed descriptors and preserves a non-exhausted cursor', async () => {
    const malformed = { ...(docsPageFixture as { docs: unknown[] }).docs[0] as Record<string, unknown>, defaultLocale: 'missing' }
    const { conn } = submitHarness(() => jsonResponse(200, { docs: [malformed], cursor: 'more' }))
    await expect(conn.listDocs()).resolves.toEqual({ docs: [], cursor: 'more' })
  })

  it('listDocs skips guides carrying the node-only schema version', async () => {
    const guide = structuredClone((docsPageFixture as { docs: Record<string, unknown>[] }).docs[0]!)
    const locales = guide['locales'] as Record<string, Record<string, unknown>>
    locales['en']!['schemaVersion'] = 1
    const { conn } = submitHarness(() => jsonResponse(200, { docs: [guide] }))
    await expect(conn.listDocs()).resolves.toEqual({ docs: [] })
  })

  it('fetchDocsPage and docsAssetUrl use encoded immutable digest routes', async () => {
    const { conn, requests } = submitHarness(() => new Response('# Add Integers', {
      status: 200,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    }))
    await expect(conn.fetchDocsPage('demo/pack', 'sha256:abc')).resolves.toBe('# Add Integers')
    await expect(conn.fetchDocsPage('demo/pack', 'sha256:abc')).resolves.toBe('# Add Integers')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://test/api/packs/demo%2Fpack/docs/pages/sha256%3Aabc')
    await expect(conn.fetchDocsPage('other-pack', 'sha256:abc')).resolves.toBe('# Add Integers')
    expect(requests).toHaveLength(2)
    expect(conn.docsAssetUrl('demo/pack', 'sha256:def')).toBe('http://test/api/packs/demo%2Fpack/docs/assets/sha256%3Adef')

    const { conn: missing } = submitHarness(() => new Response(null, { status: 404 }))
    await expect(missing.fetchDocsPage('pack', 'sha256:none')).resolves.toBeUndefined()
    const { conn: wrongType } = submitHarness(() => jsonResponse(200, {}))
    await expect(wrongType.fetchDocsPage('pack', 'sha256:json')).rejects.toThrow('expected text/markdown')
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

  it('fetches and coalesces immutable pack locale catalogs on encoded routes', async () => {
    const catalog = { nodes: { 'demo.node': { displayName: 'Knoten' } } }
    const { conn, requests } = submitHarness(() => jsonResponse(200, catalog))
    const [first, second] = await Promise.all([
      conn.fetchPackLocaleCatalog('demo/pack', 'sha256:abc'),
      conn.fetchPackLocaleCatalog('demo/pack', 'sha256:abc'),
    ])
    expect(first).toEqual(catalog)
    expect(second).toBe(first)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://test/api/packs/demo%2Fpack/locales/sha256%3Aabc')

    const { conn: missing } = submitHarness(() => new Response(null, { status: 404 }))
    await expect(missing.fetchPackLocaleCatalog('pack', 'sha256:none')).resolves.toBeUndefined()
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

  it('createLibraryRecord POSTs the record shape and returns the created record', async () => {
    const { conn, requests } = submitHarness((url, init) =>
      url.endsWith('/api/library') && init?.method === 'POST'
        ? jsonResponse(201, record)
        : undefined,
    )
    const created = await conn.createLibraryRecord({
      scope: 'local',
      name: 'My Flow',
      digest: DIGEST,
      mediaType: 'application/x-dinkster-workflow+json',
      labels: ['workflow'],
    })
    expect(created).toEqual(record)
    const body = JSON.parse(requests[0]!.init!.body as string) as Record<string, unknown>
    expect(body['scope']).toBe('local')
    expect(body['digest']).toBe(DIGEST)
    expect(body['labels']).toEqual(['workflow'])
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

  it('submit stamps sourceDocument when provided, omits it otherwise', async () => {
    const jobsRoute = (url: string, init?: RequestInit): Response | undefined =>
      nodesRoute(url) ??
      (url.endsWith('/api/jobs') && init?.method === 'POST'
        ? jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' })
        : undefined)

    const stamped = submitHarness(jobsRoute)
    await stamped.conn.fetchSchemas()
    expect((await stamped.conn.submit(chainArtifact(), { sourceDocument: DIGEST })).ok).toBe(true)
    const post = stamped.requests.find((r) => r.init?.method === 'POST')!
    expect((JSON.parse(post.init!.body as string) as Record<string, unknown>)['sourceDocument']).toBe(DIGEST)

    const plain = submitHarness(jobsRoute)
    await plain.conn.fetchSchemas()
    expect((await plain.conn.submit(chainArtifact())).ok).toBe(true)
    const plainPost = plain.requests.find((r) => r.init?.method === 'POST')!
    expect('sourceDocument' in (JSON.parse(plainPost.init!.body as string) as Record<string, unknown>)).toBe(false)
  })

  it('submit carries the previews policy when provided, omits it otherwise', async () => {
    const jobsRoute = (url: string, init?: RequestInit): Response | undefined =>
      nodesRoute(url) ??
      (url.endsWith('/api/jobs') && init?.method === 'POST'
        ? jsonResponse(202, { clientId: 'cid', jobId: 'job-fixed', state: 'queued' })
        : undefined)

    const chosen = submitHarness(jobsRoute)
    await chosen.conn.fetchSchemas()
    expect((await chosen.conn.submit(chainArtifact(), { previews: { mode: 'quality' } })).ok).toBe(true)
    const post = chosen.requests.find((r) => r.init?.method === 'POST')!
    expect((JSON.parse(post.init!.body as string) as Record<string, unknown>)['previews']).toEqual({ mode: 'quality' })

    const plain = submitHarness(jobsRoute)
    await plain.conn.fetchSchemas()
    expect((await plain.conn.submit(chainArtifact())).ok).toBe(true)
    const plainPost = plain.requests.find((r) => r.init?.method === 'POST')!
    expect('previews' in (JSON.parse(plainPost.init!.body as string) as Record<string, unknown>)).toBe(false)

    const withNodes = submitHarness(jobsRoute)
    await withNodes.conn.fetchSchemas()
    expect((await withNodes.conn.submit(chainArtifact(), {
      previews: { mode: 'cheap', nodes: { n1: 'off', 's1.inner': 'quality' } },
    })).ok).toBe(true)
    const nodesPost = withNodes.requests.find((r) => r.init?.method === 'POST')!
    expect((JSON.parse(nodesPost.init!.body as string) as Record<string, unknown>)['previews'])
      .toEqual({ mode: 'cheap', nodes: { n1: 'off', 's1.inner': 'quality' } })
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

  it('listHistory sends exact filters + paging and skips malformed records', async () => {
    const { conn, requests } = submitHarness((url, init) =>
      url.includes('/api/history?') && init?.method !== 'DELETE'
        ? jsonResponse(200, { records: [run, { runId: 'broken' }, 'junk'], cursor: 'c1' })
        : undefined,
    )
    const page = await conn.listHistory({
      scope: 'local',
      state: 'completed',
      sourceDocument: DIGEST,
      clientId: 'cid',
      limit: 24,
      cursor: 'c0',
    })
    expect(page.records).toEqual([run])
    expect(page.cursor).toBe('c1')
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe('/api/history')
    expect(url.searchParams.get('scope')).toBe('local')
    expect(url.searchParams.get('state')).toBe('completed')
    expect(url.searchParams.get('sourceDocument')).toBe(DIGEST)
    expect(url.searchParams.get('clientId')).toBe('cid')
    expect(url.searchParams.get('limit')).toBe('24')
    expect(url.searchParams.get('cursor')).toBe('c0')
  })

  it('listHistory omits absent filters/cursor; exhausted pages have no cursor', async () => {
    const { conn, requests } = submitHarness((url) =>
      url.includes('/api/history?') ? jsonResponse(200, { records: [] }) : undefined,
    )
    const page = await conn.listHistory({ scope: 'local' })
    expect(page).toEqual({ records: [] })
    const url = new URL(requests[0]!.url)
    expect([...url.searchParams.keys()]).toEqual(['scope'])
  })

  it('decodes optional history attribution and ignores malformed values', async () => {
    const { conn } = submitHarness((url) =>
      url.includes('/api/history?')
        ? jsonResponse(200, { records: [
            { ...run, runId: 'agent', principalId: 'queue-agent', principalKind: 'agent' },
            { ...run, runId: 'bad', principalId: 42, principalKind: 'robot' },
            { ...run, runId: 'plain' },
          ] })
        : undefined,
    )

    const records = (await conn.listHistory({ scope: 'local' })).records
    expect(records[0]).toMatchObject({
      runId: 'agent',
      principalId: 'queue-agent',
      principalKind: 'agent',
    })
    expect(records[1]?.principalId).toBeUndefined()
    expect(records[1]?.principalKind).toBeUndefined()
    expect(records[2]?.principalId).toBeUndefined()
    expect(records[2]?.principalKind).toBeUndefined()
  })

  it('decodes execution attribution on node receipts and rejects malformed values', async () => {
    const receipt = {
      nodeId: 'sampler',
      disposition: 'executed',
      executionArm: 'native',
      provider: 'vision.depth.v3',
      pack: 'dinkster-vision-depth-anything-v3',
      worker: 'render-box',
    }
    const { conn } = submitHarness((url) =>
      url.includes('/api/history?')
        ? jsonResponse(200, { records: [
            { ...run, runId: 'located', nodeReceipts: [receipt] },
            { ...run, runId: 'empty-worker', nodeReceipts: [{ ...receipt, worker: '' }] },
            { ...run, runId: 'wrong-worker', nodeReceipts: [{ ...receipt, worker: 42 }] },
            { ...run, runId: 'empty-provider', nodeReceipts: [{ ...receipt, provider: '' }] },
            { ...run, runId: 'wrong-pack', nodeReceipts: [{ ...receipt, pack: 42 }] },
          ] })
        : undefined,
    )

    expect((await conn.listHistory({ scope: 'local' })).records).toEqual([
      { ...run, runId: 'located', nodeReceipts: [receipt] },
    ])
  })

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

  it('produces a v4 UUID in a secure context (crypto.randomUUID present)', () => {
    expect(uuidv4()).toMatch(V4)
  })

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
  it('uses governor trim filters for model unload and omits them for unload-all', async () => {
    const requests: { url: string; body: unknown }[] = []
    const connection = new DinksterConnection({ id: C0, baseUrl: 'http://test', clientId: 'test',
      webSocketFactory: () => ({}) as WebSocketLike,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return jsonResponse(200, { requestedBytes: 900, freedBytes: 650 })
      },
    })
    expect(await connection.unloadMemory('vram:cuda:1', 'models', 'model-2')).toEqual({ requestedBytes: 900, freedBytes: 650 })
    await connection.unloadMemory('vram:cuda:1')
    await connection.resetMemoryPeak('vram:cuda:1')
    expect(requests).toEqual([
      { url: 'http://test/cache/trim', body: { device: 'vram:cuda:1', consumers: ['models'], items: ['model-2'] } },
      { url: 'http://test/cache/trim', body: { device: 'vram:cuda:1' } },
      { url: 'http://test/memory/reset-peak', body: { device: 'vram:cuda:1' } },
    ])
  })

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

  it('rejects a malformed HTTP memory payload', async () => {
    const connection = new DinksterConnection({ id: C0, baseUrl: '', clientId: 'test', webSocketFactory: () => ({}) as WebSocketLike, fetchFn: async () => jsonResponse(200, { queue: {} }) })
    await expect(connection.fetchMemoryStatus()).rejects.toThrow('malformed response')
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
