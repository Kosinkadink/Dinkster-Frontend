/**
 * Workflow library orchestration: saveWorkflow create/patch with the
 * one-retry conflict discipline, openFromLibrary linking (record + backend
 * home), and the advisory sourceDocument stamp on queue - uploaded once
 * per document revision, degrading to an unstamped submission on any
 * failure (a stampless queue is always valid).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_MEDIA_TYPE, asNodeId, asPortId, asPromptId, boundaryOf, compile, diag, documentResolver, emptyBoard, exposedKey, type DinksterNodesPayload, type JsonObject, type NodeSchema } from '@dinkster/core'
import { buildDinksterRegistry, type LibraryRecord } from '@dinkster/client'
import {
  AppState,
  LIBRARY_SCOPE,
  WORKFLOW_LABEL,
  WORKFLOW_MEDIA_TYPE,
  type Backend,
  type Tab,
} from '../src/app-state.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { buildParamRows } from '../src/app-view-rows.js'
import { activeProjectId } from '../src/projects.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes.json'), 'utf8'),
) as DinksterNodesPayload

const DIGEST = 'blake3:' + 'a'.repeat(64)
const DIGEST2 = 'blake3:' + 'b'.repeat(64)

/**
 * Saves are chained through a microtask, so a just-issued saveWorkflow()
 * has not captured its snapshot yet. Interleaving tests wait for the
 * upload call - the point where ownership (revision, backend, payload)
 * is pinned - before mutating anything.
 */
async function uploadStarted(upload: { mock: { calls: unknown[][] } }): Promise<void> {
  for (let i = 0; i < 50 && upload.mock.calls.length === 0; i++) await Promise.resolve()
  if (upload.mock.calls.length === 0) throw new Error('uploadAsset was never called')
}

const record = (over: Partial<LibraryRecord> = {}): LibraryRecord => ({
  id: 'r1',
  scope: LIBRARY_SCOPE,
  name: 'Saved Flow',
  digest: DIGEST,
  mediaType: WORKFLOW_MEDIA_TYPE,
  labels: [WORKFLOW_LABEL],
  created: 1,
  modified: 2,
  revision: 1,
  ...over,
})

/** Two chained std.math.add_ints; no output node, so queue scope is partial. */
const CHAIN_DOC = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage-library-test',
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
}

let app: AppState

beforeEach(() => {
  app = createWorkflowApp(null)
})

afterEach(() => {
  app.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A native backend with live schemas, plus the CHAIN_DOC tab targeted at it. */
async function nativeSetup(): Promise<{ backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab }> {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect((await app.openDocument(CHAIN_DOC, 'Chain'))).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('Board card sources', () => {
  it('delivers only a card run\'s recorded saved files, including partial saves, without replaying removed results', async () => {
    const { backend } = await nativeSetup()
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(CHAIN_DOC))
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockImplementation(async (digests) =>
      digests.map((digest) => ({ digest, status: 'available' })))
    let count = 0
    vi.spyOn(backend.connection, 'submit').mockImplementation(async () => ({ ok: true,
      execution: { connection: backend.id, prompt: asPromptId(`saved-${++count}`) }, jobRef: `native-${count}` }))
    const board = app.boards.open(emptyBoard(), 'Results', backend.baseUrl)
    const card = await app.boards.placeCard(board.id, { project: activeProjectId(), baseUrl: backend.baseUrl,
      kind: 'workflow', source: { kind: 'library', recordId: 'r1' }, name: 'Rain' }, { x: 17, y: 29 })
    const point = { x: 410, y: 29 }
    for (const status of ['completed', 'error', 'cancelled'] as const) {
      const ref = (await app.queueBoardCard(board, card))!
      const execution = app.store.get(ref)!
      const held = app.boardResultPlaces(board, execution)
      const cardRect = board.session.doc.items[card]!.rect
      expect(held[0]).toEqual({ x: cardRect.x + cardRect.width + 24, y: cardRect.y, width: 280, height: 175 })
      board.session.dispatch({ command: 'board.item.move', params: {
        moves: [{ id: card, x: cardRect.x - 400, y: cardRect.y + 300 }],
      } })
      expect(app.boardResultPlaces(board, execution)).toEqual(held)
      app.store.hydrateOutputs(ref, { n0: { images: [{ digest: DIGEST, name: 'preview-only.png' }] } })
      expect(await app.placeBoardCardResults(board, ref, point)).toEqual([])
      app.store.apply(status === 'error'
        ? { kind: 'error', execution: ref, timestamp: count,
          detail: { exceptionType: 'Error', exceptionMessage: 'Failed after saving', traceback: [] } }
        : { kind: status, execution: ref, timestamp: count })
      expect(await app.placeBoardCardResults(board, ref, point)).toEqual([])
      app.store.hydrateArtifacts(ref, [
        { nodeId: 'save-video', digest: DIGEST, name: 'rain.mp4', mediaType: 'video/mp4', size: 17, virtualPath: 'outputs/rain.mp4' },
        { nodeId: 'save-sound', digest: DIGEST2, name: 'rain.wav', mediaType: 'audio/wav', size: 29, virtualPath: 'outputs/rain.wav' },
        { nodeId: 'save-text', digest: DIGEST, name: 'notes.txt', mediaType: 'text/plain', size: 3, virtualPath: 'outputs/notes.txt' },
      ])
      const other = app.boards.open(emptyBoard(), 'Other', backend.baseUrl)
      await expect(app.placeBoardCardResults(other, ref, point)).rejects.toThrow('does not belong')
      const ids = await app.placeBoardCardResults(board, ref, point)
      expect(ids.map((id) => board.session.doc.items[id]!.kind)).toEqual(['video', 'sound'])
      expect(board.session.doc.items[ids[0]!]!.rect).toEqual(held[0])
      expect(board.session.doc.items[ids[0]!]).toMatchObject({ asset: { digest: DIGEST,
        origin: { job: `native-${count}`, node: 'save-video' } } })
      expect(board.session.doc.runs?.[`native-${count}`]).toEqual({ card, items: ids })
      expect(app.store.get(ref)!.status).toBe(status)
      board.session.dispatch({ command: 'board.item.remove', params: { ids } })
      expect(await app.placeBoardCardResults(board, ref, point)).toEqual([])
      expect(board.session.doc.order).toEqual([card])
    }
    const empty = (await app.queueBoardCard(board, card))!
    app.store.apply({ kind: 'completed', execution: empty, timestamp: 4 })
    app.store.hydrateArtifacts(empty, [])
    expect(await app.placeBoardCardResults(board, empty, point)).toEqual([])
    expect(board.session.doc.runs?.['native-4']).toEqual({ card, items: [] })
    const snapshot = board.session.doc
    app.boards.close(board.id)
    const reopened = app.boards.open(snapshot, 'Reopened', backend.baseUrl)
    await expect(app.placeBoardCardResults(board, empty, point)).rejects.toThrow('does not belong')
    expect(await app.placeBoardCardResults(reopened, empty, point)).toEqual([])
    expect(reopened.session.doc.order).toEqual([card])
  })

  it('keeps exposed after-run choices private, resets them with values, and ignores in-flight mode edits', async () => {
    const { backend, tab } = await nativeSetup()
    const registry = backend.registry.get()!
    const schema = registry.resolve('test.numeric_union')!
    backend.registry.set({ ...registry, resolve: (type) => type !== schema.type ? registry.resolve(type) : {
      ...schema, body: schema.body.map((row) => row.kind === 'input' ? { ...row,
        widget: { ...row.widget!, controller: 'after_generate', controllerInitial: 'increment' },
      } : row),
    } })
    const input = { graphId: 'g0', nodeId: 'n0', inputId: 'frame_rate' }
    let source = { ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: { n0: { id: 'n0', type: schema.type, values: { frame_rate: 25 }, controllers: { frame_rate: 'increment' } } }, links: {},
    } }, ext: { 'dinkster.exposed': [input] } }
    const original = tab.store.doc
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockImplementation(async () => JSON.stringify(source))
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    let count = 0
    vi.spyOn(backend.connection, 'submit').mockImplementation(async () => ({ ok: true,
      execution: { connection: backend.id, prompt: asPromptId(`mode-${++count}`) } }))
    const board = app.boards.open(emptyBoard(), 'Modes', backend.baseUrl)
    const selection = { project: activeProjectId(), baseUrl: backend.baseUrl, kind: 'workflow' as const,
      source: { kind: 'library' as const, recordId: 'r1' }, name: 'Rate' }
    const a = await app.boards.placeCard(board.id, selection, { x: 0, y: 0 })
    const b = await app.boards.placeCard(board.id, selection, { x: 400, y: 0 })
    const mode = (id: string, mode?: 'fixed' | 'increment' | 'decrement') =>
      board.session.dispatch({ command: 'board.card.controller', params: { id, key: exposedKey(input), ...(mode ? { mode } : {}) } })
    const snapshot = (id: string) => app.boards.loadCard(board.id, id, backend.registry.get()!.resolve)
    mode(a, 'fixed')
    const first = (await app.queueBoardCard(board, a))!
    const second = (await app.queueBoardCard(board, b))!
    app.store.apply({ kind: 'completed', execution: first, timestamp: 1 })
    app.store.apply({ kind: 'completed', execution: second, timestamp: 2 })
    expect((await snapshot(a)).graphs.g0!.nodes.n0!.values.frame_rate).toBe(25)
    expect((await snapshot(b)).graphs.g0!.nodes.n0!.values.frame_rate).toBe(25.01)
    source = { ...source, graphs: { g0: { ...source.graphs.g0, nodes: { n0: { ...source.graphs.g0.nodes.n0,
      values: { frame_rate: 31 }, controllers: { frame_rate: 'decrement' },
    } } } } }
    expect((await snapshot(a)).graphs.g0!.nodes.n0!.controllers!.frame_rate).toBe('fixed')
    expect((await snapshot(b)).graphs.g0!.nodes.n0!.controllers!.frame_rate).toBe('decrement')
    board.session.dispatch({ command: 'board.card.input', params: { id: a, input, value: 40 } })
    board.session.dispatch({ command: 'board.card.input', params: { id: a, input } })
    expect((await snapshot(a)).graphs.g0!.nodes.n0!).toMatchObject({ values: { frame_rate: 31 }, controllers: { frame_rate: 'decrement' } })
    const third = (await app.queueBoardCard(board, a))!
    mode(a, 'fixed'); mode(a, 'decrement')
    app.store.apply({ kind: 'completed', execution: third, timestamp: 3 })
    expect((await snapshot(a)).graphs.g0!.nodes.n0!.values.frame_rate).toBe(31)
    source = { ...source, ext: { 'dinkster.exposed': [] } }
    await snapshot(a)
    expect(board.session.doc.items[a]).toMatchObject({ controllers: {} })
    const persisted = JSON.parse(JSON.stringify(board.session.doc))
    app.boards.close(board.id)
    const reopened = app.boards.open(persisted, 'Modes reopened', backend.baseUrl)
    const fourth = (await app.queueBoardCard(reopened, a))!
    app.store.apply({ kind: 'completed', execution: fourth, timestamp: 4 })
    expect((await app.boards.loadCard(reopened.id, a, backend.registry.get()!.resolve)).graphs.g0!.nodes.n0!.values.frame_rate).toBe(30.99)
    expect(source.graphs.g0.nodes.n0.values.frame_rate).toBe(31)
    expect(tab.store.doc).toBe(original)
  })

  it.each(['workflow', 'blueprint'] as const)('advances private %s seeds and dropdowns only on success, preserves in-flight edits, and persists them without source writes', async (kind) => {
    const { backend, tab } = await nativeSetup()
    const schema: NodeSchema = { type: 'CardControls', displayName: 'Card controls', category: 'test', source: 'v3', isOutputNode: true,
      body: [
        { kind: 'input', id: 'seed', optional: false, type: { kind: 'concrete', name: 'INT' },
          widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 2 }, controller: 'after_generate' } },
        { kind: 'input', id: 'choice', optional: false, type: { kind: 'concrete', name: 'STRING' },
          widget: { widgetType: 'COMBO', options: { options: ['alpha', 'beta', 'gamma'] }, controller: 'after_generate' } },
      ] }
    const registry = backend.registry.get()!
    backend.registry.set({ ...registry, resolve: (type) => type === schema.type ? schema : registry.resolve(type) })
    let source = { ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: { n0: { id: 'n0', type: schema.type, values: { seed: 7, choice: 'beta' }, controllers: { seed: 'increment', choice: 'decrement' } } },
      links: {}, ...(kind === 'blueprint' ? { boundary: boundaryOf([
        { id: 'seed', binds: { kind: 'port' as const, node: asNodeId('n0'), port: asPortId('seed') }, promoted: true },
      ], []) } : {}),
    } } }
    const original = tab.store.doc
    const tabs = app.tabs.get()
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record({ labels: [kind] }))
    vi.spyOn(backend.connection, 'fetchAssetText').mockImplementation(async () => JSON.stringify(source))
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const submitted: JsonObject[] = []
    vi.spyOn(backend.connection, 'submit').mockImplementation(async (artifact) => {
      submitted.push(Object.values(artifact.prompt)[0]!.inputs as JsonObject)
      return { ok: true, execution: { connection: backend.id, prompt: asPromptId(`advance-${submitted.length}`) } }
    })
    const board = app.boards.open(emptyBoard(), 'Private controls', backend.baseUrl)
    const selection = { project: activeProjectId(), baseUrl: backend.baseUrl, kind,
      source: { kind: 'library' as const, recordId: 'r1' }, name: 'Controls' }
    const a = await app.boards.placeCard(board.id, selection, { x: 0, y: 0 })
    const b = await app.boards.placeCard(board.id, selection, { x: 400, y: 0 })
    const first = (await app.queueBoardCard(board, a))!
    const second = (await app.queueBoardCard(board, b))!
    expect(submitted).toEqual([{ seed: 7, choice: 'beta' }, { seed: 7, choice: 'beta' }])
    app.store.apply({ kind: 'completed', execution: first, timestamp: 1 })
    const advanced = structuredClone(board.session.doc)
    app.store.apply({ kind: 'completed', execution: first, timestamp: 2 })
    expect(board.session.doc).toEqual(advanced)
    expect(board.session.undo()).toBe(true)
    expect((await app.boards.loadCard(board.id, a, backend.registry.get()!.resolve)).graphs.g0!.nodes.n0!.values.choice).toBe('beta')
    expect(board.session.redo()).toBe(true)
    app.store.apply({ kind: 'cancelled', execution: second, timestamp: 3 })
    const third = (await app.queueBoardCard(board, a))!
    const fourth = (await app.queueBoardCard(board, b))!
    expect(submitted.slice(2)).toEqual([{ seed: 8, choice: 'alpha' }, { seed: 7, choice: 'beta' }])
    const seedInput = { graphId: kind === 'blueprint' ? 'board-root' : 'g0', nodeId: 'n0', inputId: 'seed' }
    board.session.dispatch({ command: 'board.card.input', params: { id: a, input: seedInput, value: 40 } })
    board.session.dispatch({ command: 'board.card.input', params: { id: a, input: seedInput, value: 8 } })
    app.store.apply({ kind: 'completed', execution: third, timestamp: 4 })
    app.store.apply({ kind: 'error', execution: fourth, timestamp: 5,
      detail: { exceptionType: 'Error', exceptionMessage: 'Failed', traceback: [] } })
    const retried = (await app.queueBoardCard(board, b))!
    expect(submitted[4]).toEqual({ seed: 7, choice: 'beta' })
    app.store.apply({ kind: 'cancelled', execution: retried, timestamp: 6 })
    expect((board.session.doc.items[a] as { values: JsonObject }).values[exposedKey(seedInput)]).toBe(8)
    if (kind === 'workflow') {
      vi.mocked(backend.connection.fetchAssetText).mockResolvedValueOnce(JSON.stringify({ ...source, ext: { 'dinkster.exposed': [
        seedInput, { graphId: 'g0', nodeId: 'n0', inputId: 'choice' },
      ] } }))
      const exposed = await app.boards.loadCard(board.id, a, backend.registry.get()!.resolve)
      expect(buildParamRows(exposed, documentResolver(exposed, backend.registry.get()!.resolve))
        .map((row) => row.kind === 'live' ? row.value : undefined)).toEqual([8, 'gamma'])
      expect(exposed.graphs.g0!.nodes.n0!.controllers).toEqual({ seed: 'increment', choice: 'decrement' })
    }
    const fifth = (await app.queueBoardCard(board, a))!
    expect(submitted[5]).toEqual({ seed: 8, choice: 'gamma' })
    app.store.apply({ kind: 'cancelled', execution: fifth, timestamp: 6 })
    const persisted = JSON.parse(JSON.stringify(board.session.doc))
    app.boards.close(board.id)
    const reopened = app.boards.open(persisted, 'Reopened', backend.baseUrl)
    const sixth = (await app.queueBoardCard(reopened, a))!
    expect(submitted[6]).toEqual({ seed: 8, choice: 'gamma' })
    app.store.apply({ kind: 'cancelled', execution: sixth, timestamp: 7 })
    source = { ...source, graphs: { g0: { ...source.graphs.g0, nodes: { n0: { ...source.graphs.g0.nodes.n0,
      values: { seed: 31, choice: 'beta' }, controllers: { seed: 'fixed', choice: 'fixed' },
    } } } } }
    const seventh = (await app.queueBoardCard(reopened, a))!
    expect(submitted[7]).toEqual({ seed: kind === 'blueprint' ? 8 : 31, choice: 'beta' })
    expect((reopened.session.doc.items[a] as { values: JsonObject }).values[exposedKey({ graphId: 'g0', nodeId: 'n0', inputId: 'choice' })]).toBeUndefined()
    app.store.apply({ kind: 'cancelled', execution: seventh, timestamp: 8 })
    source = { ...source, graphs: { g0: { ...source.graphs.g0, nodes: { n0: { ...source.graphs.g0.nodes.n0,
      controllers: { seed: 'increment', choice: 'decrement' },
    } } } } }
    const eighth = (await app.queueBoardCard(reopened, a))!
    expect(submitted[8]).toEqual({ seed: kind === 'blueprint' ? 8 : 31, choice: 'beta' })
    app.store.apply({ kind: 'cancelled', execution: eighth, timestamp: 9 })
    vi.mocked(backend.connection.fetchAssetText).mockImplementation(async () => JSON.stringify({ ...source,
      ...(kind === 'workflow' ? { ext: { 'dinkster.exposed': [seedInput] } } : {}),
    }))
    reopened.session.dispatch({ command: 'board.card.controller', params: { id: a, key: exposedKey(seedInput), mode: 'fixed' } })
    const ninth = (await app.queueBoardCard(reopened, a))!
    app.store.apply({ kind: 'completed', execution: ninth, timestamp: 10 })
    const held = await app.boards.loadCard(reopened.id, a, backend.registry.get()!.resolve)
    expect(held.graphs[seedInput.graphId]!.nodes.n0!.values.seed).toBe(kind === 'blueprint' ? 8 : 31)
    reopened.session.dispatch({ command: 'board.card.input', params: { id: a, input: seedInput } })
    const tenth = (await app.queueBoardCard(reopened, a))!
    expect(submitted[10]!.seed).toBe(31)
    app.store.apply({ kind: 'completed', execution: tenth, timestamp: 11 })
    expect((await app.boards.loadCard(reopened.id, a, backend.registry.get()!.resolve))
      .graphs[seedInput.graphId]!.nodes.n0!.values.seed).toBe(32)
    expect(app.tabs.get()).toBe(tabs)
    expect(tab.store.doc).toBe(original)
    expect(source.graphs.g0.nodes.n0.values).toEqual({ seed: 31, choice: 'beta' })
  })

  it('advances a card when completion beats its submit reply but never advances a replacement Board', async () => {
    const { backend } = await nativeSetup()
    const registry = backend.registry.get()!
    const schema = registry.resolve('test.numeric_union')!
    backend.registry.set({ ...registry, resolve: (type) => type !== schema.type ? registry.resolve(type) : {
      ...schema, body: schema.body.map((row) => row.kind === 'input' ? { ...row,
        widget: { ...row.widget!, controller: 'after_generate', controllerInitial: 'increment' },
      } : row),
    } })
    const source = { ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: { n0: { id: 'n0', type: schema.type, values: { frame_rate: 25 } } }, links: {},
    } } }
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(source))
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const board = app.boards.open(emptyBoard(), 'Early completion', backend.baseUrl)
    const id = await app.boards.placeCard(board.id, { project: activeProjectId(), baseUrl: backend.baseUrl,
      kind: 'workflow', source: { kind: 'library', recordId: 'r1' }, name: 'Rate' }, { x: 0, y: 0 })
    const first = { connection: backend.id, prompt: asPromptId('already-completed') }
    const submit = vi.spyOn(backend.connection, 'submit').mockImplementation(async () => {
      app.store.apply({ kind: 'completed', execution: first, timestamp: 1 })
      return { ok: true, execution: first }
    })
    await app.queueBoardCard(board, id)
    const key = exposedKey({ graphId: 'g0', nodeId: 'n0', inputId: 'frame_rate' })
    expect((board.session.doc.items[id] as { values: JsonObject }).values[key]).toBe(25.01)
    const second = { connection: backend.id, prompt: asPromptId('closed-owner') }
    submit.mockResolvedValue({ ok: true, execution: second })
    await app.queueBoardCard(board, id)
    const snapshot = board.session.doc
    app.boards.close(board.id)
    const replacement = app.boards.open(snapshot, 'Replacement', backend.baseUrl)
    app.store.apply({ kind: 'completed', execution: second, timestamp: 2 })
    expect(replacement.session.doc).toEqual(snapshot)
  })

  it('runs independent full card snapshots on the Board backend, keeps editing tabs unchanged, and stops a posted run even when its reply arrives late', async () => {
    const { backend, tab } = await nativeSetup()
    const input = { graphId: 'g0', nodeId: 'n0', inputId: 'frame_rate', label: 'Rate' }
    const source = { ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: { n0: { id: 'n0', type: 'test.numeric_union', values: { frame_rate: 25 } } }, links: {},
    } }, ext: { 'dinkster.exposed': [input] } }
    const bytes = JSON.stringify(source)
    const original = tab.store.doc
    const tabs = app.tabs.get()
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(bytes)
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    const board = app.boards.open(emptyBoard(), 'Rates', backend.baseUrl)
    const selection = { project: activeProjectId(), baseUrl: backend.baseUrl, kind: 'workflow' as const,
      source: { kind: 'library' as const, recordId: 'r1' }, name: 'Rates' }
    const a = await app.boards.placeCard(board.id, selection, { x: 0, y: 0 })
    const b = await app.boards.placeCard(board.id, selection, { x: 400, y: 0 })
    for (const [id, value] of [[a, 17], [b, 29]] as const)
      board.session.dispatch({ command: 'board.card.input', params: { id, input, value } })
    const submitted: number[] = []
    let reply: (() => void) | undefined
    const submit = vi.spyOn(backend.connection, 'submit').mockImplementation(async (artifact) => {
      submitted.push(artifact.prompt.n0!.inputs.frame_rate as number)
      const execution = { connection: backend.id, prompt: asPromptId(`card-${submitted.length}`) }
      if (submitted.length === 3) await new Promise<void>((resolve) => { reply = resolve })
      return { ok: true, execution, jobRef: String(execution.prompt) }
    })
    const first = await app.queueBoardCard(board, a)
    const second = await app.queueBoardCard(board, b)
    expect(first?.connection).toBe(backend.id)
    expect(second?.connection).toBe(backend.id)
    expect(submitted).toEqual([17, 29])
    expect(app.executionsForBoardCard(board, a)).toHaveLength(1)
    expect(app.executionsForBoardCard(board, b)).toHaveLength(1)
    expect(app.store.get(first!)?.sourceDocument).toBe(DIGEST2)
    expect(app.store.get(first!)?.artifact?.snapshot.ext?.['dinkster.boardCard']).toMatchObject({ board: board.id, card: a })
    expect(app.tabs.get()).toBe(tabs)
    expect(tab.store.doc).toBe(original)
    expect(JSON.parse(bytes).graphs.g0.nodes.n0.values).toEqual({ frame_rate: 25 })
    app.store.apply({ kind: 'completed', execution: first!, timestamp: 1 })
    const late = app.queueBoardCard(board, a)
    await vi.waitFor(() => expect(reply).toBeDefined())
    expect(await app.queueBoardCard(board, a)).toBeUndefined()
    expect(submitted).toEqual([17, 29, 17])
    await app.stopBoardCard(board, a)
    const cancelled: string[] = []
    vi.spyOn(backend.connection, 'cancel').mockImplementation(async (ref) => { cancelled.push(String(ref.prompt)); return 'cancelled' })
    reply!()
    await late
    await vi.waitFor(() => expect(cancelled).toEqual(['card-3']))
    expect(app.executionsForBoardCard(board, b)[0]?.ref).toEqual(second)
    expect(submit.mock.calls.every(([artifact]) => artifact.connection === backend.id)).toBe(true)
  })

  it('cancels a card before upload completes and refuses a removed card consent retry without posting another run', async () => {
    const { backend } = await nativeSetup()
    const source = { ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0,
      nodes: { n0: { id: 'n0', type: 'test.numeric_union', values: { frame_rate: 25 } } }, links: {},
    } } }
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(source))
    const board = app.boards.open(emptyBoard(), 'Rates', backend.baseUrl)
    const card = await app.boards.placeCard(board.id, { project: activeProjectId(), baseUrl: backend.baseUrl,
      kind: 'workflow', source: { kind: 'library', recordId: 'r1' }, name: 'Rates' }, { x: 0, y: 0 })
    let uploaded: (() => void) | undefined
    const upload = vi.spyOn(backend.connection, 'uploadAsset').mockImplementation(async () => {
      await new Promise<void>((resolve) => { uploaded = resolve }); return DIGEST
    })
    let posted = 0
    const execution = { connection: backend.id, prompt: asPromptId('card-consent') }
    vi.spyOn(backend.connection, 'submit').mockImplementation(async () => {
      posted++
      return { ok: false, assetsMissing: { assets: [{ digest: DIGEST, kind: 'media/image', name: 'Image' }] },
        diagnostics: [], retryWithAssets: async () => { posted++; return { ok: true, execution } } }
    })
    const cancelled = app.queueBoardCard(board, card)
    await vi.waitFor(() => expect(uploaded).toBeDefined())
    await app.stopBoardCard(board, card)
    uploaded!()
    expect(await cancelled).toBeUndefined()
    expect(posted).toBe(0)
    upload.mockResolvedValue(DIGEST)
    const pending = app.queueBoardCard(board, card)
    await vi.waitFor(() => expect(app.assetConsent.get()).toBeDefined())
    const consent = app.assetConsent.get()!
    expect(board.session.dispatch({ command: 'board.item.remove', params: { ids: [card] } }).ok).toBe(true)
    await pending
    await consent.retry?.([DIGEST])
    expect(posted).toBe(1)
    expect(app.store.get(execution)).toBeUndefined()
    expect(app.boardCardSubmissions.get().size).toBe(0)
    expect(board.session.undo()).toBe(true)
    const accepted = app.queueBoardCard(board, card)
    await vi.waitFor(() => expect(app.assetConsent.get()).toBeDefined())
    await app.assetConsent.get()!.retry?.([DIGEST])
    expect(await accepted).toEqual(execution)
    expect(posted).toBe(3)
    expect(app.executionsForBoardCard(board, card)[0]?.ref).toEqual(execution)
    expect(app.boardCardSubmissions.get().size).toBe(0)
  })

  it('places referenced cards undoably and resolves their exposed values independently without changing the saved workflow or open tab', async () => {
    const { backend, tab } = await nativeSetup()
    const { connection, baseUrl } = backend
    const board = app.boards.open(emptyBoard(), 'Cards', baseUrl)
    const exposed = [
      { graphId: 'g0', nodeId: 'n0', inputId: 'b', label: 'Right' },
      { graphId: 'g0', nodeId: 'n0', inputId: 'a', label: 'Left' },
      { graphId: 'g0', nodeId: 'n1', inputId: 'a', label: 'Linked' },
    ]
    const bytes = JSON.stringify({ ...CHAIN_DOC, ext: { 'dinkster.exposed': exposed } })
    vi.spyOn(connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(connection, 'fetchAssetText').mockResolvedValue(bytes)
    const selection = { project: activeProjectId(), baseUrl, kind: 'workflow' as const,
      source: { kind: 'library' as const, recordId: 'r1' }, name: 'Stale title' }
    const first = await app.boards.placeCard(board.id, selection, { x: 500, y: 350 })
    const second = await app.boards.placeCard(board.id, selection, { x: 500, y: 350 })
    expect(board.session.doc.items[first]).toMatchObject({ name: 'Saved Flow', rect: { x: 330, y: 256 } })
    expect(board.session.doc.items[second]).toMatchObject({ rect: { x: 354, y: 280 } })
    expect(board.session.undo()).toBe(true)
    expect(board.session.doc.items[second]).toBeUndefined()
    expect(board.session.redo()).toBe(true)
    for (const [id, value] of [[first, 17], [second, 29]] as const) {
      expect(board.session.dispatch({ command: 'board.card.input', params: { id, input: exposed[0]!, value } }).ok).toBe(true)
      expect(board.session.dispatch({ command: 'board.card.input', params: { id, input: exposed[2]!, value: 999 } }).ok).toBe(true)
      expect(board.session.dispatch({ command: 'board.card.input', params: { id,
        input: { graphId: 'g0', nodeId: 'n1', inputId: 'b' }, value: 777 } }).ok).toBe(true)
    }
    const originalTab = tab.store.doc
    const resolve = backend.registry.get()!.resolve
    const a = await app.boards.loadCard(board.id, first, resolve)
    const b = await app.boards.loadCard(board.id, second, resolve)
    expect(a.graphs.g0!.nodes.n0!.values).toEqual({ a: 3, b: 17 })
    expect(b.graphs.g0!.nodes.n0!.values).toEqual({ a: 3, b: 29 })
    expect(a.graphs.g0!.nodes.n1!.values).toEqual({ b: 10 })
    for (const [document, expected] of [[a, 17], [b, 29]] as const) {
      const result = compile({ document, revision: 1, resolve, connection: backend.id, schemaHash: backend.registry.get()!.hash,
        scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n1') }] } })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
      expect(result.artifact.prompt.n0!.inputs).toEqual({ a: 3, b: expected })
      expect(result.artifact.prompt.n1!.inputs).toEqual({ a: ['n0', 0], b: 10 })
    }
    expect(buildParamRows(a, documentResolver(a, resolve)).map((row) => row.kind === 'live' && row.label)).toEqual(['Right', 'Left', 'Linked'])
    board.session.dispatch({ command: 'board.card.input', params: { id: first, input: exposed[0]! } })
    expect((await app.boards.loadCard(board.id, first, resolve)).graphs.g0!.nodes.n0!.values.b).toBe(4)
    expect((await app.boards.loadCard(board.id, second, resolve)).graphs.g0!.nodes.n0!.values.b).toBe(29)
    expect(tab.store.doc).toBe(originalTab)
    expect(JSON.parse(bytes).graphs.g0.nodes.n0.values).toEqual({ a: 3, b: 4 })
    board.session.dispatch({ command: 'board.card.input', params: { id: first, input: exposed[1]!, value: 51 } })
    const conditional = (type: string): NodeSchema | undefined => {
      const schema = resolve(type)
      return schema && { ...schema, body: schema.body.map((row) => row.kind === 'input' && row.id === 'a'
        ? { ...row, visible: { formula: 'b > 5' } } : row) }
    }
    expect((await app.boards.loadCard(board.id, first, conditional)).graphs.g0!.nodes.n0!.values.a).toBe(3)
    board.session.dispatch({ command: 'board.card.input', params: { id: first, input: exposed[0]!, value: 17 } })
    expect((await app.boards.loadCard(board.id, first, conditional)).graphs.g0!.nodes.n0!.values).toEqual({ a: 51, b: 17 })
    await expect(app.boards.placeCard(board.id, { ...selection, project: 'other-project' }, { x: 0, y: 0 })).rejects.toThrow('project and backend')
    await expect(app.boards.placeCard(board.id, { ...selection, baseUrl: 'http://other' }, { x: 0, y: 0 })).rejects.toThrow('project and backend')
    vi.spyOn(connection, 'getLibraryRecord').mockResolvedValue(record({ labels: ['blueprint'] }))
    await expect(app.boards.placeCard(board.id, selection, { x: 0, y: 0 })).rejects.toThrow('no longer available')
    expect(board.session.doc.order).toEqual([first, second])
  })

  it.each(['cancel', 'reopen', 'backend'] as const)('does not place delayed card bytes after %s', async (action) => {
    const { backend } = await nativeSetup()
    const { connection, baseUrl } = backend
    const board = app.boards.open(emptyBoard(), 'Cards', baseUrl)
    vi.spyOn(connection, 'getLibraryRecord').mockResolvedValue(record())
    let release!: (text: string) => void
    let started!: () => void
    let cancelled = false
    const entered = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(connection, 'fetchAssetText').mockImplementation(() => {
      started()
      return new Promise<string>((resolve) => { release = resolve })
    })
    const placing = app.boards.placeCard(board.id, { project: activeProjectId(), baseUrl, kind: 'workflow',
      source: { kind: 'library', recordId: 'r1' }, name: 'Card' }, { x: 300, y: 200 }, () => !cancelled)
    const refused = expect(placing).rejects.toThrow('Board changed')
    await entered
    let replacement = board
    if (action === 'cancel') cancelled = true
    else if (action === 'reopen') {
      app.boards.close(board.id)
      replacement = app.boards.open(board.session.doc, 'Reopened', baseUrl)
    } else {
      app.removeBackend(backend.id)
      app.addBackend(baseUrl, 'Replacement', false, 'dinkster')
    }
    release(JSON.stringify(CHAIN_DOC))
    await refused
    expect(replacement.session.doc.order).toEqual([])
    expect(replacement.session.canUndo).toBe(false)
    expect(app.boards.entries.get()).toEqual([replacement])
  })

  it('wraps a saved blueprint as one subgraph instance and applies card inputs to that instance only', async () => {
    const { backend } = await nativeSetup()
    const { connection, baseUrl } = backend
    const board = app.boards.open(emptyBoard(), 'Blueprints', baseUrl)
    const blueprint = { ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0, boundary: boundaryOf([
      { id: 'amount', binds: { kind: 'port', node: asNodeId('n0'), port: asPortId('a') }, promoted: true },
    ], [{ id: 'result', binds: { kind: 'port', node: asNodeId('n1'), port: asPortId('sum') } }]) } } }
    const bytes = JSON.stringify(blueprint)
    vi.spyOn(connection, 'getLibraryRecord').mockResolvedValue(record({ labels: ['blueprint'] }))
    vi.spyOn(connection, 'fetchAssetText').mockResolvedValue(bytes)
    const id = await app.boards.placeCard(board.id, { project: activeProjectId(), baseUrl, kind: 'blueprint',
      source: { kind: 'library', recordId: 'r1' }, name: 'Add' }, { x: 500, y: 300 })
    const resolve = backend.registry.get()!.resolve
    const document = await app.boards.loadCard(board.id, id, resolve)
    const rows = buildParamRows(document, documentResolver(document, resolve))
    expect(rows.map((row) => row.entry.inputId)).toEqual(['amount'])
    const input = rows[0]!.entry
    expect(exposedKey(input)).not.toBe(exposedKey({ graphId: 'g0', nodeId: 'n0', inputId: 'a' }))
    board.session.dispatch({ command: 'board.card.input', params: { id, input, value: 41 } })
    const changed = await app.boards.loadCard(board.id, id, resolve)
    expect(Object.values(changed.graphs[changed.root]!.nodes)).toMatchObject([{ type: '#g0', values: { amount: 41 } }])
    expect(changed.graphs.g0!.nodes.n0!.values.a).toBe(3)
    const compiled = compile({ document: changed, revision: 1, resolve, connection: backend.id, schemaHash: backend.registry.get()!.hash,
      scope: { kind: 'partial', targets: [{ instancePath: [asNodeId('n0')], node: asNodeId('n1') }] } })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) throw new Error(compiled.diagnostics.map((diagnostic) => diagnostic.message).join('; '))
    expect(compiled.artifact.prompt['n0.n0']!.inputs).toEqual({ a: 41, b: 4 })
    expect(compiled.artifact.prompt['n0.n1']!.inputs).toEqual({ a: ['n0.n0', 0], b: 10 })
    expect(JSON.parse(bytes)).toEqual(blueprint)
    vi.spyOn(connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(CHAIN_DOC))
    await expect(app.boards.loadCard(board.id, id, resolve)).rejects.toThrow('not a boundary subgraph')
  })
})

describe('Board Library persistence', () => {
  it('saves and reopens every item kind with membership and media facts, then patches the linked record without losing newer edits', async () => {
    const { backend } = await nativeSetup()
    const { connection, baseUrl } = backend
    const entry = app.boards.open(emptyBoard(), 'References', baseUrl)
    entry.session.dispatch({ command: 'board.item.add', params: { items: [
      { id: 'section', kind: 'section', name: 'Study', rect: { x: 1, y: 2, width: 900, height: 800 } },
      { id: 'picture', kind: 'picture', sectionId: 'section', rect: { x: 20, y: 30, width: 100, height: 200 },
        asset: { digest: DIGEST, mediaType: 'image/png', name: 'Portrait', width: 300, height: 600, origin: { source: 'upload' } } },
      { id: 'video', kind: 'video', rect: { x: 210, y: 37, width: 320, height: 180 },
        asset: { digest: DIGEST2, mediaType: 'video/webm', name: 'Motion', duration: 3.5, width: 1920, height: 1080 } },
      { id: 'sound', kind: 'sound', rect: { x: 90, y: 220, width: 320, height: 80 },
        asset: { digest: DIGEST, mediaType: 'audio/wav', name: 'Voice', duration: 7 } },
      { id: 'note', kind: 'note', text: 'Keep the proportions', sectionId: 'section', rect: { x: 50, y: 320, width: 180, height: 90 } },
    ] } })
    const expected = structuredClone(entry.session.doc)
    let bytes = ''
    let saved = record({ name: entry.title, mediaType: BOARD_MEDIA_TYPE, labels: ['board'] })
    vi.spyOn(connection, 'uploadAsset').mockImplementation(async (value) => { bytes = String(value); return DIGEST })
    vi.spyOn(connection, 'createLibraryRecord').mockImplementation(async (value) => { saved = { ...saved, ...value }; return saved })
    vi.spyOn(connection, 'getLibraryRecord').mockImplementation(async () => saved)
    vi.spyOn(connection, 'fetchAssetText').mockImplementation(async () => bytes)
    vi.spyOn(connection, 'patchLibraryRecord').mockImplementation(async (_id, patch) => {
      if (patch.revision !== saved.revision) return { ok: false, conflict: true }
      saved = { ...saved, ...patch, revision: saved.revision + 1 }
      return { ok: true, record: saved }
    })
    expect(app.boards.isDirty(entry.id)).toBe(true)
    await app.boards.save(entry.id)
    expect(app.boards.isDirty(entry.id)).toBe(false)
    expect(JSON.parse(bytes)).toEqual(expected)
    app.boards.close(entry.id)
    const reopened = await app.boards.openSaved(saved.id, baseUrl)
    expect(reopened.session.doc).toEqual(expected)
    expect(reopened.title).toBe('References')
    expect(app.boards.isDirty(reopened.id)).toBe(false)
    reopened.session.dispatch({ command: 'board.note.edit', params: { id: 'note', text: 'New version' } })
    expect(app.boards.isDirty(reopened.id)).toBe(true)
    expect(reopened.session.undo()).toBe(true)
    expect(app.boards.isDirty(reopened.id)).toBe(false)
    expect(reopened.session.redo()).toBe(true)
    await app.boards.rename(reopened.id, 'Renamed references')
    await Promise.all([app.boards.save(reopened.id), app.boards.save(reopened.id)])
    expect(saved.revision).toBe(3)
    expect(saved.name).toBe('Renamed references')
    expect(app.boards.isDirty(reopened.id)).toBe(false)
    expect((await app.boards.openSaved(saved.id, baseUrl)).session.doc.items['note']).toMatchObject({ text: 'New version' })
    await app.boards.rename(reopened.id, 'Name only')
    expect(app.boards.isDirty(reopened.id)).toBe(true)
    await app.boards.save(reopened.id)
    expect(app.boards.isDirty(reopened.id)).toBe(false)
    app.boards.close(reopened.id)
    expect((await app.boards.openSaved(saved.id, baseUrl)).title).toBe('Name only')
  })

  it('refuses another saved record with the same document identity without redirecting its edits to the open record', async () => {
    const { backend } = await nativeSetup()
    const { connection, baseUrl } = backend
    const entry = app.boards.open(emptyBoard(), 'A', baseUrl)
    entry.session.dispatch({ command: 'board.item.add', params: { items: [
      { id: 'note', kind: 'note', text: 'A contents', rect: { x: 10, y: 20, width: 160, height: 80 } },
    ] } })
    const copy = { ...entry.session.doc, items: {
      ...entry.session.doc.items, note: { ...entry.session.doc.items['note']!, kind: 'note', text: 'B contents' },
    } }
    const records = new Map<string, LibraryRecord>([
      ['copy', record({ id: 'copy', name: 'B', digest: DIGEST2, mediaType: BOARD_MEDIA_TYPE })],
    ])
    const bytes = new Map([[DIGEST2, JSON.stringify(copy)]])
    let upload = 0
    vi.spyOn(connection, 'uploadAsset').mockImplementation(async (text) => {
      const digest = 'blake3:' + String(++upload).repeat(64)
      bytes.set(digest, String(text))
      return digest
    })
    vi.spyOn(connection, 'createLibraryRecord').mockImplementation(async (value) => {
      const saved = record({ ...value, id: 'original' })
      records.set(saved.id, saved)
      return saved
    })
    vi.spyOn(connection, 'getLibraryRecord').mockImplementation(async (id) => records.get(id))
    vi.spyOn(connection, 'fetchAssetText').mockImplementation(async (digest) => bytes.get(digest))
    vi.spyOn(connection, 'patchLibraryRecord').mockImplementation(async (id, patch) => {
      const saved = records.get(id)!
      if (patch.revision !== saved.revision) return { ok: false, conflict: true }
      const updated = { ...saved, ...patch, revision: saved.revision + 1 }
      records.set(id, updated)
      return { ok: true, record: updated }
    })
    await expect(app.boards.openSaved('copy', baseUrl)).rejects.toThrow('document identity')
    await app.boards.save(entry.id)
    await expect(app.boards.openSaved('copy', baseUrl)).rejects.toThrow('document identity')
    entry.session.dispatch({ command: 'board.note.edit', params: { id: 'note', text: 'Edited A' } })
    expect((await app.boards.openSaved('original', baseUrl)).session.doc.items['note']).toMatchObject({ text: 'Edited A' })
    expect(app.boards.isDirty(entry.id)).toBe(true)
    await app.boards.save(entry.id)
    const original = records.get('original')!
    expect(JSON.parse(bytes.get(original.digest)!).items.note.text).toBe('Edited A')
    expect(JSON.parse(bytes.get(records.get('copy')!.digest)!).items.note.text).toBe('B contents')
    records.set('original', { ...original, revision: original.revision + 1, digest: DIGEST2 })
    await expect(app.boards.openSaved('original', baseUrl)).rejects.toThrow('changed since')
    expect(entry.session.doc.items['note']).toMatchObject({ text: 'Edited A' })
    app.boards.close(entry.id)
    const opened = await app.boards.openSaved('copy', baseUrl)
    expect(opened.title).toBe('B')
    expect(opened.session.doc.items['note']).toMatchObject({ text: 'B contents' })
    opened.session.dispatch({ command: 'board.note.edit', params: { id: 'note', text: 'Edited B' } })
    await app.boards.save(opened.id)
    expect(JSON.parse(bytes.get(records.get('copy')!.digest)!).items.note.text).toBe('Edited B')
    expect(records.get('original')).toEqual({ ...original, revision: original.revision + 1, digest: DIGEST2 })
  })

  it('keeps edits made during a save dirty and refuses foreign record changes rather than overwriting them', async () => {
    const { backend } = await nativeSetup()
    const { connection, baseUrl } = backend
    const entry = app.boards.open(emptyBoard(), 'References', baseUrl)
    let release!: (digest: string) => void
    const waiting = new Promise<string>((resolve) => { release = resolve })
    const upload = vi.spyOn(connection, 'uploadAsset').mockReturnValue(waiting)
    vi.spyOn(connection, 'createLibraryRecord').mockImplementation(async (value) => record(value))
    const saving = app.boards.save(entry.id)
    await uploadStarted(upload)
    entry.session.dispatch({ command: 'board.item.add', params: { items: [
      { id: 'note', kind: 'note', text: 'Not in saved snapshot', rect: { x: 20, y: 30, width: 160, height: 80 } },
    ] } })
    release(DIGEST)
    await saving
    expect(app.boards.isDirty(entry.id)).toBe(true)
    expect(entry.session.undo()).toBe(true)
    expect(app.boards.isDirty(entry.id)).toBe(false)
    entry.session.redo()
    vi.spyOn(connection, 'patchLibraryRecord').mockResolvedValue({ ok: false, conflict: true })
    await expect(app.boards.save(entry.id)).rejects.toThrow('changed elsewhere')
    expect(app.boards.isDirty(entry.id)).toBe(true)
    expect(entry.session.doc.items['note']).toMatchObject({ text: 'Not in saved snapshot' })
  })

  it('does not save into a reopened owner or resurrect a Board closed while saved bytes load', async () => {
    const { backend } = await nativeSetup()
    const { connection, baseUrl } = backend
    const entry = app.boards.open(emptyBoard(), 'References', baseUrl)
    let release!: (digest: string) => void
    const upload = vi.spyOn(connection, 'uploadAsset').mockReturnValue(new Promise<string>((resolve) => { release = resolve }))
    const saving = app.boards.save(entry.id)
    const refused = expect(saving).rejects.toThrow('changed while saving')
    await uploadStarted(upload)
    app.boards.close(entry.id)
    const reopened = app.boards.open(entry.session.doc, 'Reopened', baseUrl)
    release(DIGEST)
    await refused
    expect(app.boards.isDirty(reopened.id)).toBe(true)
    let load!: (text: string) => void
    vi.spyOn(connection, 'getLibraryRecord').mockResolvedValue(record({ mediaType: BOARD_MEDIA_TYPE }))
    const fetch = vi.spyOn(connection, 'fetchAssetText').mockReturnValue(new Promise<string>((resolve) => { load = resolve }))
    const opening = app.boards.openSaved('r1', baseUrl)
    const cancelled = expect(opening).rejects.toThrow('closed while opening')
    for (let i = 0; i < 50 && fetch.mock.calls.length === 0; i++) await Promise.resolve()
    expect(fetch.mock.calls.length).toBe(1)
    app.boards.close(reopened.id)
    load(JSON.stringify(entry.session.doc))
    await cancelled
    expect(app.boards.entries.get()).toEqual([])
    const next = app.boards.open(entry.session.doc, 'Next', baseUrl)
    upload.mockResolvedValue(DIGEST)
    let finish!: (saved: LibraryRecord) => void
    let started!: () => void
    const creating = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(connection, 'createLibraryRecord').mockImplementation(() => {
      started()
      return new Promise<LibraryRecord>((resolve) => { finish = resolve })
    })
    const late = app.boards.save(next.id)
    const retired = expect(late).rejects.toThrow('original document is no longer active')
    await creating
    app.boards.close(next.id)
    const replacement = app.boards.open(next.session.doc, 'Replacement', baseUrl)
    finish(record({ mediaType: BOARD_MEDIA_TYPE }))
    await retired
    expect(app.boards.isDirty(replacement.id)).toBe(true)
  })
})

describe('saveWorkflow', () => {
  it.each(['available', 'denied', 'edited', 'timed out'] as const)('saves an early snapshot with optional location lookup %s', async (outcome) => {
    const { backend } = (await nativeSetup())
    const source: NodeSchema = { type: 'test.asset-location', displayName: 'Asset location', category: 'test', source: 'v3', isOutputNode: false,
      body: [
        { kind: 'input', id: 'a', type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } }, optional: false },
        { kind: 'input', id: 'b', type: { kind: 'concrete', name: 'INT' }, optional: false },
        { kind: 'output', id: 'sum', type: { kind: 'concrete', name: 'INT' }, isList: false },
      ] }
    const catalog = backend.registry.get()!
    const schemas = new Map([...catalog.schemas, [source.type, source]])
    backend.registry.set({ ...catalog, schemas, resolve: (type) => schemas.get(type) })
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue([{ digest: DIGEST, status: 'available' }])
    let resolve!: (paths: readonly string[]) => void
    let reject!: (error: Error) => void
    const pending = new Promise<readonly string[]>((res, rej) => { resolve = res; reject = rej })
    const locations = vi.spyOn(backend.connection, 'fetchAssetLocations').mockReturnValue(pending)
    const upload = vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record({ digest: DIGEST2 }))
    const asset = { digest: DIGEST, name: 'early.png', size: 19, mediaType: 'image/png', virtualPath: 'input/early.png' }
    await app.openDocument({ ...CHAIN_DOC, graphs: { g0: { ...CHAIN_DOC.graphs.g0, nodes: {
      ...CHAIN_DOC.graphs.g0.nodes, n0: { ...CHAIN_DOC.graphs.g0.nodes.n0, type: source.type, values: { a: asset, b: 4 } },
    } } } }, 'Early save')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    const saving = app.saveWorkflow(tab.id)
    await vi.waitFor(() => expect(locations).toHaveBeenCalled())
    expect(upload).not.toHaveBeenCalled()
    if (outcome === 'edited') {
      expect((await app.dispatchTo(tab, { command: 'node.setValues', params: { graphId: 'g0', nodeId: 'n0', values: { a: { ...asset, digest: DIGEST2 } } } })).ok).toBe(true)
    }
    if (outcome === 'denied') reject(new Error('operator access denied'))
    else if (outcome === 'available') resolve(['/machine/original/early.png'])
    else if (outcome === 'timed out') deadline.abort()
    // An edit cancels the old observation even if its transport never settles.
    expect(await saving).toBe(true)
    const saved = JSON.parse(upload.mock.calls[0]![0] as string)
    expect(saved.graphs.g0.nodes.n0.values.a).toEqual(asset)
    if (outcome === 'available') {
      expect(saved.meta.ext['dinkster.assetLocations']).toEqual({ version: 1, observations: [{
        graph: 'g0', node: 'n0', input: 'a', index: 0, digest: DIGEST,
        machine: 'Native', paths: ['/machine/original/early.png'],
      }] })
      expect(tab.store.revision).toBe(0)
    } else expect(saved.meta?.ext?.['dinkster.assetLocations']).toBeUndefined()
    if (outcome === 'edited') {
      expect(app.isTabDirty(tab.id)).toBe(true)
      resolve(['/stale/path'])
    }
    if (outcome === 'timed out') {
      resolve(['/late/path'])
      await Promise.resolve()
      expect(JSON.stringify(app.exportDocument(tab.id))).not.toContain('/late/path')
    }
    app.dispose()
    timeout.mockRestore()
  })

  it('uploads the document and creates a labeled record; re-save patches it', async () => {
    const { backend, tab } = (await nativeSetup())
    const upload = vi
      .spyOn(backend.connection, 'uploadAsset')
      .mockResolvedValueOnce(DIGEST)
      .mockResolvedValueOnce(DIGEST2)
    const create = vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const patch = vi
      .spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: true, record: record({ digest: DIGEST2, revision: 2 }) })

    app.reportProblems(tab.id, [
      diag('info', 'import', 'import.notice', 'Sampler: saved seed format is upgraded'),
      diag('warning', 'schema', 'schema.notice', 'Sampler: backend schema is unavailable'),
    ])

    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(app.problems.get().some((entry) => entry.code === 'import.notice')).toBe(false)
    expect(app.problems.get().some((entry) => entry.code === 'schema.notice')).toBe(true)
    expect(app.isTabDirty(tab.id)).toBe(false)
    expect(app.transientStatus.get()).toBe('Saved to Native library')
    // The uploaded bytes are the tab's own document (stamping is advisory
    // and registry-dependent; the FORMAT is what must round-trip).
    const uploadedBody = upload.mock.calls[0]![0]
    expect(typeof uploadedBody).toBe('string')
    const uploaded = JSON.parse(uploadedBody as string) as Record<string, unknown>
    expect(uploaded['format']).toBe('dinkster-workflow')
    expect(uploaded['lineage']).toBe('lineage-library-test')
    expect(uploadedBody).not.toContain('import.notice')
    expect(create).toHaveBeenCalledWith({
      scope: LIBRARY_SCOPE,
      name: 'Chain',
      digest: DIGEST,
      mediaType: WORKFLOW_MEDIA_TYPE,
      labels: [WORKFLOW_LABEL],
    })
    expect(patch).not.toHaveBeenCalled()

    const edit = await app.dispatchTo(tab, {
      command: 'node.move',
      params: { graphId: 'g0', positions: { n0: { x: 25, y: 25 } } },
    })
    expect(edit.ok).toBe(true)
    expect(app.isTabDirty(tab.id)).toBe(true)

    // Second save: the linked tab PATCHES with the revision from create.
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(app.isTabDirty(tab.id)).toBe(false)
    expect(patch).toHaveBeenCalledWith('r1', {
      scope: LIBRARY_SCOPE,
      revision: 1,
      digest: DIGEST2,
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('keeps a rename during Save dirty and writes it only on the next Save', async () => {
    const { backend, tab } = await nativeSetup()
    let release!: (digest: string) => void
    const upload = vi.spyOn(backend.connection, 'uploadAsset')
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockResolvedValue(DIGEST2)
    const create = vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const patch = vi.spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: true, record: record({ name: 'New name', revision: 2 }) })
    const saving = app.saveWorkflow(tab.id)
    await uploadStarted(upload)
    app.renameTab(tab.id, '  New name  ')
    expect(app.activeTab()?.title).toBe('New name')
    expect(app.activeTab()?.store).toBe(tab.store)
    expect(patch).not.toHaveBeenCalled()
    release(DIGEST)
    expect(await saving).toBe(true)
    expect(app.isTabDirty(tab.id)).toBe(true)
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('r1', {
      scope: LIBRARY_SCOPE, revision: 1, digest: DIGEST2, name: 'New name',
    })
    expect(app.isTabDirty(tab.id)).toBe(false)
  })

  it('a stale-revision conflict re-reads and retries exactly once', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const patch = vi
      .spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValueOnce({ ok: false, conflict: true })
      .mockResolvedValueOnce({ ok: true, record: record({ revision: 6, digest: DIGEST2 }) })
    const get = vi
      .spyOn(backend.connection, 'getLibraryRecord')
      .mockResolvedValue(record({ revision: 5, name: 'Renamed Elsewhere' }))

    expect(await app.saveWorkflow(tab.id)).toBe(true) // create + link
    expect(await app.saveWorkflow(tab.id)).toBe(true) // conflict -> re-read -> retry
    expect(get).toHaveBeenCalledWith('r1', LIBRARY_SCOPE)
    // The retry presents the FRESH revision and repoints only the digest -
    // the rename made elsewhere survives.
    expect(patch).toHaveBeenNthCalledWith(2, 'r1', {
      scope: LIBRARY_SCOPE,
      revision: 5,
      digest: DIGEST2,
    })
  })

  it('a deleted record falls back to creating a new one', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const create = vi
      .spyOn(backend.connection, 'createLibraryRecord')
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(record({ id: 'r2' }))
    vi.spyOn(backend.connection, 'patchLibraryRecord').mockResolvedValue({ ok: false, conflict: true })
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(undefined)

    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('failures land in Problems and return false', async () => {
    const { backend, tab } = (await nativeSetup())
    app.reportProblems(tab.id, [diag('info', 'import', 'import.notice', 'Sampler: saved seed format is upgraded')])
    vi.spyOn(backend.connection, 'uploadAsset').mockRejectedValue(new Error('boom'))
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    expect(app.problems.get().some((entry) => entry.code === 'import.notice')).toBe(true)
    expect(app.problems.get().some((d) => d.code === 'library.saveFailed')).toBe(true)
    expect(app.transientStatus.get()).toBe('Save failed on Native: boom')
  })

  it('AP2: an edit made while the save is in flight keeps the tab dirty', async () => {
    const { backend, tab } = (await nativeSetup())
    let release!: (digest: string) => void
    const upload = vi
      .spyOn(backend.connection, 'uploadAsset')
      .mockReturnValue(new Promise((r) => { release = r }))
    vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const saving = app.saveWorkflow(tab.id)
    await uploadStarted(upload) // the snapshot + revision are now captured
    const edit = await app.dispatchTo(tab, {
      command: 'node.move',
      params: { graphId: 'g0', positions: { n0: { x: 50, y: 50 } } },
    })
    expect(edit.ok).toBe(true)
    release(DIGEST)
    expect(await saving).toBe(true)
    // The record holds the pre-edit snapshot; the newer edit is unsaved.
    expect(app.isTabDirty(tab.id)).toBe(true)
    expect(app.transientStatus.get()).toContain('newer changes remain unsaved')
  })

  it('AP2: concurrent saves serialize - one record, then a patch, never duplicates', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const create = vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const patch = vi
      .spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: true, record: record({ revision: 2 }) })
    const [first, second] = await Promise.all([app.saveWorkflow(tab.id), app.saveWorkflow(tab.id)])
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    // The second save ran AFTER the first and patched the record it linked.
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('r1', { scope: LIBRARY_SCOPE, revision: 1, digest: DIGEST })
  })

  it('AP2: a same-lineage replacement tab inherits neither the link nor the clean flag', async () => {
    const { backend, tab } = (await nativeSetup())
    let release!: (digest: string) => void
    const upload = vi
      .spyOn(backend.connection, 'uploadAsset')
      .mockReturnValue(new Promise((r) => { release = r }))
    const create = vi
      .spyOn(backend.connection, 'createLibraryRecord')
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(record({ id: 'r2' }))
    const patch = vi.spyOn(backend.connection, 'patchLibraryRecord')
    const saving = app.saveWorkflow(tab.id)
    await uploadStarted(upload) // ownership captured against the ORIGINAL tab
    // Replace the tab mid-save: same lineage, same tab id, NEW session.
    expect((await app.openDocument(CHAIN_DOC, 'Chain (reopened)'))).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)
    expect(replacement.store).not.toBe(tab.store)
    release(DIGEST)
    expect(await saving).toBe(true) // the record WAS written...
    expect(app.isTabDirty(replacement.id)).toBe(true) // ...but the replacement stays dirty
    // ...and unlinked: its own save must CREATE, not patch the old record.
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    app.setTabTarget(replacement.id, backend.id)
    expect(await app.saveWorkflow(replacement.id)).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
    expect(patch).not.toHaveBeenCalled()
  })

  it('AP2: an old save cannot steal or delete the link openFromLibrary installs mid-flight', async () => {
    const { backend, tab } = (await nativeSetup())
    // Link the tab first so the blocked save enters the patch path.
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValueOnce(DIGEST)
    vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    expect(await app.saveWorkflow(tab.id)).toBe(true)

    // Old save blocks in upload; its ownership (including the r1 link) is
    // captured once uploadAsset is entered.
    let release!: (digest: string) => void
    const upload = vi
      .spyOn(backend.connection, 'uploadAsset')
      .mockReturnValue(new Promise((r) => { release = r }))
    const patch = vi
      .spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: false, conflict: true })
    // The refetch says r1 is gone: the old save falls back to CREATE.
    vi.spyOn(backend.connection, 'getLibraryRecord')
      .mockImplementation(async (id: string) =>
        id === 'rNew' ? record({ id: 'rNew', revision: 7, digest: DIGEST2 }) : undefined)
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(CHAIN_DOC))
    const saving = app.saveWorkflow(tab.id)
    await uploadStarted(upload)

    // openFromLibrary replaces the same-lineage tab and links it to rNew.
    expect(await app.openFromLibrary('rNew', backend.id)).toBe(true)
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)

    release(DIGEST)
    expect(await saving).toBe(true)
    // The old save never patched rNew (its captured link was r1, which the
    // conflict + missing-record path abandoned)...
    expect(patch).not.toHaveBeenCalledWith('rNew', expect.anything())
    // ...and the replacement's rNew link survived: its next save patches it.
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    patch.mockResolvedValue({ ok: true, record: record({ id: 'rNew', revision: 8 }) })
    expect(await app.saveWorkflow(replacement.id)).toBe(true)
    expect(patch).toHaveBeenLastCalledWith('rNew', { scope: LIBRARY_SCOPE, revision: 7, digest: DIGEST2 })
  })

  it('AP2: a link made on one backend is never patched through another', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const patchA = vi.spyOn(backend.connection, 'patchLibraryRecord')
    expect(await app.saveWorkflow(tab.id)).toBe(true) // linked on backend A

    const other = app.addBackend('http://native2:8000', 'Native2', false, 'dinkster')
    if (!other || other.protocol !== 'dinkster') throw new Error('addBackend rejected')
    other.registry.set(buildDinksterRegistry(other.id, nodesPayload))
    app.setTabTarget(tab.id, other.id)
    vi.spyOn(other.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    const createB = vi
      .spyOn(other.connection, 'createLibraryRecord')
      .mockResolvedValue(record({ id: 'rB' }))
    const patchB = vi
      .spyOn(other.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: true, record: record({ id: 'rB', revision: 2 }) })

    // Retargeted save: fresh record on B, no patch of A's record id anywhere.
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(createB).toHaveBeenCalledTimes(1)
    expect(patchB).not.toHaveBeenCalled()
    expect(patchA).not.toHaveBeenCalled()
    // The link now lives on B: the next save patches rB there.
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(patchB).toHaveBeenCalledWith('rB', { scope: LIBRARY_SCOPE, revision: 1, digest: DIGEST2 })
  })
})

describe('openFromLibrary', () => {

  it('opens the exact bytes, links the tab, and targets the workflow home', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(
      record({ name: 'Opened Flow', revision: 3 }),
    )
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(
      JSON.stringify({ ...CHAIN_DOC, lineage: 'lineage-opened' }),
    )
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    const patch = vi
      .spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: true, record: record({ revision: 4 }) })
    const create = vi.spyOn(backend.connection, 'createLibraryRecord')

    expect(await app.openFromLibrary('r1', backend.id)).toBe(true)
    const tab = app.activeTab()!
    expect(tab.title).toBe('Opened Flow')
    expect(app.backendForTab(tab).id).toBe(backend.id)

    // The opened tab is LINKED: a save patches with the record's revision.
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(patch).toHaveBeenCalledWith('r1', {
      scope: LIBRARY_SCOPE,
      revision: 3,
      digest: DIGEST2,
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('unparseable bytes land in Problems', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue('{not json')
    expect(await app.openFromLibrary('r1', backend.id)).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'library.openFailed')).toBe(true)
  })
})

describe('sourceDocument stamp on queue', () => {
  it('rejects hostile or non-object original prompts without replacing the live tab', async () => {
    const { tab } = (await nativeSetup())
    const accessor = vi.fn(() => { throw new Error('accessor ran') })
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: accessor })
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('prototype trap') } })
    for (const prompt of [hostile, getter, null, [], 17]) {
      const diagnostics = (await app.openDocument(CHAIN_DOC, 'Untrusted prompt', undefined, false, prompt as JsonObject))
      expect(diagnostics.some((item) => item.severity === 'error')).toBe(true)
      expect(app.activeTab()).toBe(tab)
    }
    expect(accessor).not.toHaveBeenCalled()
  })

  it('submits retained import provenance unchanged after native edits and export/reopen', async () => {
    const { backend } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: true, execution: { connection: backend.id, prompt: asPromptId('original-test') },
    })
    const source = {
      version: 0.4, nodes: [{ id: 1, type: 'std.math.add_ints', pos: [0, 0],
        widgets_values: [3, 4], inputs: [], outputs: [{ name: 'sum', type: 'INT', links: [] }] }], links: [],
    }
    const originalPrompt = { 'old-7': { class_type: 'Original', inputs: { seed: 17 } } }
    for (const prompt of [undefined, originalPrompt, {}]) {
      const opened = await app.importWorkflowFile({ name: 'original.json', text: async () => JSON.stringify(source) }, () => true, prompt)
      expect(opened, app.transientStatus.get()).toBe(true)
      const imported = app.activeTab()!
      app.setTabTarget(imported.id, backend.id)
      expect((await app.dispatchTo(imported, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'a', value: 99 } })).ok).toBe(true)
      const saved = JSON.parse(JSON.stringify(app.exportDocument(imported.id)))
      expect((await app.openDocument(saved, 'Reopened'))).toEqual([])
      const reopened = app.activeTab()!
      app.setTabTarget(reopened.id, backend.id)
      await app.queueSelection(reopened, ['n1'])
      expect(submit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        sourceDocument: DIGEST,
        exportSnapshot: { ...(prompt === undefined ? {} : { prompt }), extraPnginfo: { workflow: source } },
      }))
      if (prompt === undefined) expect(submit.mock.calls.at(-1)![1]!.exportSnapshot).not.toHaveProperty('prompt')
      expect(reopened.store.doc.graphs.g0!.nodes.n1!.values.a).toBe(99)
    }
    expect(submit).toHaveBeenCalledTimes(3)
    expect((await app.openDocument(CHAIN_DOC, 'No import provenance'))).toEqual([])
    const plain = app.activeTab()!
    app.setTabTarget(plain.id, backend.id)
    await app.queueSelection(plain, ['n1'])
    expect(submit.mock.calls.at(-1)![1]).not.toHaveProperty('exportSnapshot')
  })

  it('stamps submissions and uploads once per unchanged document', async () => {
    const { backend, tab } = (await nativeSetup())
    const upload = vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: true,
      execution: { connection: backend.id, prompt: asPromptId('j1') },
    })

    await app.queueSelection(tab, ['n1'])
    await app.queueSelection(tab, ['n1'])
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[0]![1]).toMatchObject({ sourceDocument: DIGEST })
    expect(submit.mock.calls[1]![1]).toMatchObject({ sourceDocument: DIGEST })
    expect(upload).toHaveBeenCalledTimes(1) // same revision + schemas = cached

    // A document edit invalidates the cache: the next queue re-uploads.
    const outcome = await app.dispatchTo(tab, {
      command: 'node.move',
      params: { graphId: 'g0', positions: { n0: { x: 50, y: 50 } } },
    })
    expect(outcome.ok).toBe(true)
    await app.queueSelection(tab, ['n1'])
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it.each(['known', 'opaque', 'edited'] as const)('submits the uploaded source snapshot with typed or opaque file values: %s', async (scenario) => {
    const { backend } = await nativeSetup()
    const registry = backend.registry.get()!
    const source: NodeSchema = { type: 'SourceAsset', displayName: 'Source asset', category: 'test',
      source: 'v3', isOutputNode: false, body: [{ kind: 'input', id: 'file', optional: false,
        type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } }] }
    backend.registry.set({ ...registry, schemas: new Map([...registry.schemas, [source.type, source]]),
      resolve: (type) => type === source.type ? source : registry.resolve(type) })
    const asset = { digest: DIGEST2, name: 'source.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '' }
    await app.openDocument({ ...CHAIN_DOC, ...(scenario === 'opaque' ? { ext: { future: { resource: asset } } } : {}),
      graphs: { g0: { ...CHAIN_DOC.graphs.g0, nodes: { ...CHAIN_DOC.graphs.g0.nodes,
        n2: { id: 'n2', type: source.type, values: { file: asset } },
      }, nextOrdinal: 4 } } }, 'Source inventory')
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    let finish!: (digest: string) => void
    const upload = vi.spyOn(backend.connection, 'uploadAsset').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({ ok: true,
      execution: { connection: backend.id, prompt: asPromptId('source-inventory') } })
    const pending = app.queueSelection(tab, ['n1'])
    await uploadStarted(upload)
    if (scenario === 'edited') {
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n2', inputId: 'file', value: { ...asset, digest: `blake3:${'c'.repeat(64)}` },
      } })).ok).toBe(true)
    }
    finish(DIGEST)
    await pending
    expect(submit.mock.calls[0]?.[1]?.sourceDocument).toBe(DIGEST)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a retained source stamp on another backend with the same schemas', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: true, execution: { connection: backend.id, prompt: asPromptId('first-stamp') },
    })
    await app.queueSelection(tab, ['n1'])
    const other = app.addBackend('http://other-native:8000', 'Other native', false, 'dinkster')!
    const registry = buildDinksterRegistry(other.id, nodesPayload)
    expect(registry.hash).toBe(backend.registry.get()!.hash)
    other.registry.set(registry)
    const upload = vi.spyOn(other.connection, 'uploadAsset').mockResolvedValue(DIGEST2)
    const submit = vi.spyOn(other.connection, 'submit').mockResolvedValue({
      ok: true, execution: { connection: other.id, prompt: asPromptId('second-stamp') },
    })
    app.setTabTarget(tab.id, other.id)
    await app.queueSelection(tab, ['n1'])
    expect(upload).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceDocument: DIGEST2 }))
  })

  it('AP4: a same-lineage replacement never reuses the old session sourceDocument digest', async () => {
    const { backend, tab } = (await nativeSetup())
    const upload = vi.spyOn(backend.connection, 'uploadAsset').mockResolvedValue(DIGEST)
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: true,
      execution: { connection: backend.id, prompt: asPromptId('j1') },
    })
    await app.queueSelection(tab, ['n1'])
    expect(upload).toHaveBeenCalledTimes(1) // digest cached for THIS session

    // Replace with a same-lineage document whose CONTENT differs; the fresh
    // session restarts at the same revision the cache entry was made at,
    // exactly the collision an id-keyed cache would answer stale.
    const changed = JSON.parse(JSON.stringify(CHAIN_DOC)) as {
      graphs: { g0: { nodes: { n0: { values: { a: number } } } } }
    }
    changed.graphs.g0.nodes.n0.values.a = 999
    expect((await app.openDocument(changed, 'Chain (changed)'))).toEqual([])
    const replacement = app.activeTab()!
    expect(replacement.id).toBe(tab.id)
    expect(replacement.store.revision).toBe(tab.store.revision) // the collision precondition
    app.setTabTarget(replacement.id, backend.id)

    upload.mockResolvedValue(DIGEST2)
    await app.queueSelection(replacement, ['n1'])
    // The changed document was re-uploaded and its OWN digest stamped.
    expect(upload).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceDocument: DIGEST2 }),
    )
  })

  it('a failed upload degrades to an unstamped submission, never a blocked queue', async () => {
    const { backend, tab } = (await nativeSetup())
    vi.spyOn(backend.connection, 'uploadAsset').mockRejectedValue(new Error('no library'))
    const submit = vi.spyOn(backend.connection, 'submit').mockResolvedValue({
      ok: true,
      execution: { connection: backend.id, prompt: asPromptId('j1') },
    })

    await app.queueSelection(tab, ['n1'])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![1]).not.toHaveProperty('sourceDocument')
    expect(app.problems.get().some((d) => d.code.startsWith('library.'))).toBe(false)
  })
})
