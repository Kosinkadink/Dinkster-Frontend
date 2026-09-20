/**
 * Built-in collection sources: packs (active backend's packs table joined
 * with node counts, icon thumbnails by descriptor presence) and history
 * (newest-first executions with status badges). Both are LIVE sources -
 * the corpus is re-derived per page request - and both rank their WHOLE
 * corpus for a query, never a loaded page. initialsOf is the shared
 * no-thumbnail fallback.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  asConnectionId,
  asPromptId,
  DINKSTER_SCHEMA_WIRE_VERSION,
  executionKey,
  setLocale,
  type DinksterNodesPayload,
  type ExecutionRef,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { formatByteSize, formatCollectionDate, historySource, initialsOf, packsSource, readCollectionViewMode, safeLocalStorage, templateAssetLines, writeCollectionViewMode } from '../src/collections.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const nodesPayload: DinksterNodesPayload = {
  schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION,
  dinkster: { version: '0.9.0', schemaWire: DINKSTER_SCHEMA_WIRE_VERSION },
  packs: {
    core: { displayName: 'Dinkster Core', version: '1.2.0' },
    'vhs.video': {
      displayName: 'Video Helper Suite',
      abbr: 'VHS',
      icon: { digest: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png' },
      version: '3.1.4',
      artifactDigest: 'sha256:' + 'b'.repeat(64),
      source: 'registry',
      publisher: 'kosinkadink',
      assets: [{ id: 'vae', name: 'Video VAE', digest: 'blake3:abc', kind: 'model/vae', size: 1572864 }],
    },
    'dev.local': { displayName: 'Scratch Pack', source: 'local:/home/u/pack' },
  },
  nodes: {
    'std.a': { displayName: 'A', pack: 'core', signature: 's1', interface: [] },
    'std.b': { displayName: 'B', pack: 'core', signature: 's2', interface: [] },
    'vhs.load': { displayName: 'Load Video', pack: 'vhs.video', signature: 's3', interface: [] },
  },
}

let app: AppState

beforeEach(() => {
  app = new AppState()
})

const loadDinksterSchemas = (): void => {
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
}

const runRef = (prompt: string): ExecutionRef => ({
  connection: app.connection.id,
  prompt: asPromptId(prompt),
})

describe('initialsOf', () => {
  it('derives initials from the first two words, uppercased', () => {
    expect(initialsOf('Video Helper Suite')).toBe('VH')
    expect(initialsOf('rgthree-comfy')).toBe('RC')
    expect(initialsOf('core')).toBe('CO')
    expect(initialsOf('vhs.video')).toBe('VV')
    expect(initialsOf('')).toBe('?')
  })
})

describe('formatByteSize', () => {
  it('formats binary byte sizes for compact asset presentation', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1536)).toBe('1.5 KiB')
    expect(formatByteSize(1572864)).toBe('1.5 MiB')
    expect(formatByteSize(2147483648)).toBe('2 GiB')
  })
})

describe('formatCollectionDate', () => {
  it('preserves the full English year from Date.toLocaleString', () => {
    const previousTimeZone = process.env['TZ']
    process.env['TZ'] = 'America/Los_Angeles'
    setLocale('en-US')
    try {
      expect(formatCollectionDate(1767323045000)).toBe('1/1/2026, 7:04:05 PM')
      expect(formatCollectionDate(0)).toBe('12/31/1969, 4:00:00 PM')
    } finally {
      if (previousTimeZone === undefined) delete process.env['TZ']
      else process.env['TZ'] = previousTimeZone
    }
  })
})

describe('persisted collection view mode', () => {
  const storageWith = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value })
  it('reads a stored grid/list preference', () => {
    expect(readCollectionViewMode(storageWith('grid'), 'k', 'list')).toBe('grid')
    expect(readCollectionViewMode(storageWith('list'), 'k', 'grid')).toBe('list')
  })
  it("decodes the legacy asset-browser 'tile' value as 'grid'", () =>
    expect(readCollectionViewMode(storageWith('tile'), 'k', 'list')).toBe('grid'))
  it('falls back after corrupt, absent, or inaccessible preferences', () => {
    expect(readCollectionViewMode(storageWith('broken'), 'k', 'grid')).toBe('grid')
    expect(readCollectionViewMode(storageWith(null), 'k', 'list')).toBe('list')
    expect(readCollectionViewMode({ getItem: () => { throw new Error('blocked') } }, 'k', 'list')).toBe('list')
    expect(readCollectionViewMode(undefined, 'k', 'grid')).toBe('grid')
  })
  it('writes the preference and swallows storage failures', () => {
    const writes: [string, string][] = []
    writeCollectionViewMode({ setItem: (key, value) => writes.push([key, value]) }, 'k', 'grid')
    expect(writes).toEqual([['k', 'grid']])
    expect(() => writeCollectionViewMode({ setItem: () => { throw new Error('blocked') } }, 'k', 'list')).not.toThrow()
  })
  it('treats a storage GLOBAL whose getter throws as absent (blocked/opaque contexts)', () => {
    // SecurityError comes from the localStorage property access itself,
    // before any getItem call - the read helpers never get a chance.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage is disabled') },
    })
    try {
      expect(safeLocalStorage()).toBeUndefined()
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
    expect(safeLocalStorage()).toBeUndefined() // absent global is also absent
  })
})

describe('packsSource', () => {
  it('maps the packs table with node counts, badges, and details', async () => {
    loadDinksterSchemas()
    const page = await packsSource(app).page({ query: '', limit: 10 })
    // Unfiltered browse is title-sorted.
    expect(page.items.map((e) => e.id)).toEqual(['core', 'dev.local', 'vhs.video'])
    expect(page.total).toBe(3)

    const core = page.items[0]!
    expect(core.title).toBe('Dinkster Core')
    expect(core.subtitle).toBe('core')
    expect(core.badges).toEqual(['v1.2.0', '2 nodes'])
    expect(core.thumbUrl).toBeUndefined()

    const vhs = page.items[2]!
    expect(vhs.badges).toEqual(['VHS', 'v3.1.4', 'registry', '1 node', '1 asset'])
    expect(vhs.thumbUrl).toContain('/api/packs/vhs.video/icon')
    expect(vhs.details).toContainEqual({ label: 'backend', text: app.backends.get()[0]!.label })
    expect(vhs.details).toContainEqual({ label: 'publisher', text: 'kosinkadink' })
    expect(vhs.details).toContainEqual({ label: 'digest', text: 'sha256:' + 'b'.repeat(64) })
    expect(vhs.details).toContainEqual({ label: 'asset: Video VAE', text: 'model/vae - 1.5 MiB' })

    const dev = page.items[1]!
    expect(dev.badges).toEqual(['local', '0 nodes'])
  })

  it('ranks the whole corpus for a query, not a loaded page', async () => {
    loadDinksterSchemas()
    // Page size 1: 'video' must still find vhs.video even though an
    // unfiltered first page would only have contained 'core'.
    const page = await packsSource(app).page({ query: 'video', limit: 1 })
    expect(page.items.map((e) => e.id)).toEqual(['vhs.video'])
  })

  it('is empty without a packs table (V1 backend or not connected)', async () => {
    const page = await packsSource(app).page({ query: '', limit: 10 })
    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
  })

  it('reads a LIVE corpus: packs appear after the registry loads', async () => {
    const source = packsSource(app)
    expect((await source.page({ query: '', limit: 10 })).items).toEqual([])
    loadDinksterSchemas()
    expect((await source.page({ query: '', limit: 10 })).items).toHaveLength(3)
  })
})

describe('templateAssetLines', () => {
  it('joins pack-local asset ids and preserves a dangling id as raw text', () => {
    loadDinksterSchemas()
    expect(templateAssetLines({
      pack: 'vhs.video', id: 'starter', name: 'Starter', digest: 'sha256:x', assets: ['vae', 'missing-id'],
    }, app.backends.get()[0])).toEqual(['Video VAE - model/vae - 1.5 MiB', 'missing-id'])
  })
})

describe('historySource', () => {
  it('lists executions newest-first with status badges and key ids', async () => {
    const first = runRef('p-early')
    const second = runRef('p-late')
    app.store.apply({ kind: 'started', execution: first, timestamp: 1000 })
    app.store.apply({ kind: 'started', execution: second, timestamp: 2000 })
    app.store.apply({
      kind: 'nodeStates',
      execution: second,
      timestamp: 2500,
      nodes: { sampler: { state: 'running', executionArm: 'native', worker: 'render-box' } },
    })
    app.store.apply({ kind: 'completed', execution: first, timestamp: 3000 })

    const page = await historySource(app).page({ query: '', limit: 10 })
    expect(page.items.map((e) => e.id)).toEqual([executionKey(second), executionKey(first)])
    expect(page.items[0]!.badges).toContain('running')
    expect(page.items[1]!.badges).toContain('completed')
    expect(page.items[1]!.subtitle).toContain('p-early')
    expect(page.items[1]!.badges).toContain('External execution')
    expect(page.items[1]!.badges).toContain('Snapshot unavailable')
    expect(page.items[1]!.badges).not.toContain('Local snapshot')
    expect(page.items[1]!.details).toContainEqual({ label: 'backend', text: app.connection.id })
    expect(page.items[0]!.details).toContainEqual({ label: 'node sampler', text: 'running - Native - render-box' })
  })

  it('surfaces error counts as a badge', async () => {
    const ref = runRef('p-err')
    app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
    app.store.apply({
      kind: 'error',
      execution: ref,
      timestamp: 2,
      detail: { exceptionType: 'RuntimeError', exceptionMessage: 'boom', traceback: [] },
    })
    const page = await historySource(app).page({ query: '', limit: 10 })
    expect(page.items[0]!.badges).toContain('1 error')
  })

  it('is empty with no executions', async () => {
    const page = await historySource(app).page({ query: '', limit: 10 })
    expect(page.items).toEqual([])
  })

  it('labels an entry admitted from mid-run chatter unconfirmed instead of queued', async () => {
    const phantom = runRef('p-phantom')
    // First contact is a preview, so the store admits it unconfirmed.
    app.store.apply({
      kind: 'preview',
      execution: phantom,
      timestamp: 1,
      channel: 'comfy/preview-image',
      payload: new ArrayBuffer(16),
    })
    const page = await historySource(app).page({ query: '', limit: 10 })
    const row = page.items.find((item) => item.id === executionKey(phantom))!
    expect(row.badges).toContain('unconfirmed')
    expect(row.badges).not.toContain('queued')
    expect(row.details).toContainEqual({ label: 'status', text: 'unconfirmed' })
    // An observed run start confirms the entry and restores real status.
    app.store.apply({ kind: 'started', execution: phantom, timestamp: 2 })
    const after = await historySource(app).page({ query: '', limit: 10 })
    expect(after.items.find((item) => item.id === executionKey(phantom))!.badges).toContain('running')
  })
})
