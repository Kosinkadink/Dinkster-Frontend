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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asPromptId, type DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry, type LibraryRecord } from '@dinkster/client'
import {
  AppState,
  LIBRARY_SCOPE,
  WORKFLOW_LABEL,
  WORKFLOW_MEDIA_TYPE,
  type Backend,
  type Tab,
} from '../src/app-state.js'

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
  app = new AppState()
})

/** A native backend with live schemas, plus the CHAIN_DOC tab targeted at it. */
function nativeSetup(): { backend: Extract<Backend, { protocol: 'dinkster' }>; tab: Tab } {
  const added = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!added || added.protocol !== 'dinkster') throw new Error('addBackend rejected')
  added.registry.set(buildDinksterRegistry(added.id, nodesPayload))
  expect(app.openDocument(CHAIN_DOC, 'Chain')).toEqual([])
  const tab = app.activeTab()!
  app.setTabTarget(tab.id, added.id)
  return { backend: added, tab }
}

describe('saveWorkflow', () => {
  it('uploads the document and creates a labeled record; re-save patches it', async () => {
    const { backend, tab } = nativeSetup()
    const upload = vi
      .spyOn(backend.connection, 'uploadAsset')
      .mockResolvedValueOnce(DIGEST)
      .mockResolvedValueOnce(DIGEST2)
    const create = vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const patch = vi
      .spyOn(backend.connection, 'patchLibraryRecord')
      .mockResolvedValue({ ok: true, record: record({ digest: DIGEST2, revision: 2 }) })

    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(app.isTabDirty(tab.id)).toBe(false)
    expect(app.transientStatus.get()).toBe('Saved to Native library')
    // The uploaded bytes are the tab's own document (stamping is advisory
    // and registry-dependent; the FORMAT is what must round-trip).
    const uploadedBody = upload.mock.calls[0]![0]
    expect(typeof uploadedBody).toBe('string')
    const uploaded = JSON.parse(uploadedBody as string) as Record<string, unknown>
    expect(uploaded['format']).toBe('dinkster-workflow')
    expect(uploaded['lineage']).toBe('lineage-library-test')
    expect(create).toHaveBeenCalledWith({
      scope: LIBRARY_SCOPE,
      name: 'Chain',
      digest: DIGEST,
      mediaType: WORKFLOW_MEDIA_TYPE,
      labels: [WORKFLOW_LABEL],
    })
    expect(patch).not.toHaveBeenCalled()

    const edit = app.dispatchTo(tab, {
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

  it('a stale-revision conflict re-reads and retries exactly once', async () => {
    const { backend, tab } = nativeSetup()
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
    const { backend, tab } = nativeSetup()
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
    const { backend, tab } = nativeSetup()
    vi.spyOn(backend.connection, 'uploadAsset').mockRejectedValue(new Error('boom'))
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'library.saveFailed')).toBe(true)
    expect(app.transientStatus.get()).toBe('Save failed on Native: boom')
  })

  it('keeps a save failure when the tab diagnostic snapshot refreshes', async () => {
    const { backend, tab } = nativeSetup()
    vi.spyOn(backend.connection, 'uploadAsset').mockRejectedValue(new Error('boom'))

    expect(await app.saveWorkflow(tab.id)).toBe(false)
    app.replaceProblems(tab.id, [])

    expect(app.problems.get().some((d) => d.code === 'library.saveFailed')).toBe(true)
  })

  it('v1 backends explain that the targeted backend cannot save', async () => {
    const tab = app.activeTab()! // seed tab on the default v1 backend
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    expect(app.problems.get()).toEqual([])
    expect(app.transientStatus.get()).toContain('Save requires a Dinkster backend')
    expect(app.transientStatus.get()).toContain('uses the ComfyUI protocol')
  })

  it('AP2: an edit made while the save is in flight keeps the tab dirty', async () => {
    const { backend, tab } = nativeSetup()
    let release!: (digest: string) => void
    const upload = vi
      .spyOn(backend.connection, 'uploadAsset')
      .mockReturnValue(new Promise((r) => { release = r }))
    vi.spyOn(backend.connection, 'createLibraryRecord').mockResolvedValue(record())
    const saving = app.saveWorkflow(tab.id)
    await uploadStarted(upload) // the snapshot + revision are now captured
    const edit = app.dispatchTo(tab, {
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
    const { backend, tab } = nativeSetup()
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
    const { backend, tab } = nativeSetup()
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
    expect(app.openDocument(CHAIN_DOC, 'Chain (reopened)')).toEqual([])
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
    const { backend, tab } = nativeSetup()
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
    const { backend, tab } = nativeSetup()
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
    const { backend } = nativeSetup()
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

  it('a missing record or missing bytes is a clean false', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(undefined)
    expect(await app.openFromLibrary('gone', backend.id)).toBe(false)

    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(undefined)
    expect(await app.openFromLibrary('r1', backend.id)).toBe(false)
  })

  it('unparseable bytes land in Problems', async () => {
    const { backend } = nativeSetup()
    vi.spyOn(backend.connection, 'getLibraryRecord').mockResolvedValue(record())
    vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue('{not json')
    expect(await app.openFromLibrary('r1', backend.id)).toBe(false)
    expect(app.problems.get().some((d) => d.code === 'library.openFailed')).toBe(true)
  })
})

describe('sourceDocument stamp on queue', () => {
  it('stamps submissions and uploads once per unchanged document', async () => {
    const { backend, tab } = nativeSetup()
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
    const outcome = app.dispatchTo(tab, {
      command: 'node.move',
      params: { graphId: 'g0', positions: { n0: { x: 50, y: 50 } } },
    })
    expect(outcome.ok).toBe(true)
    await app.queueSelection(tab, ['n1'])
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('AP4: a same-lineage replacement never reuses the old session sourceDocument digest', async () => {
    const { backend, tab } = nativeSetup()
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
    expect(app.openDocument(changed, 'Chain (changed)')).toEqual([])
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
    const { backend, tab } = nativeSetup()
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
