import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_DOCUMENT_MEDIA_TYPE,
  type DinksterConnection,
  type ImageDocumentDependency,
  type LibraryRecord,
} from '@dinkster/client'
import { asImageResourceId, serializeImageDocument, type ImageDocument } from '@dinkster/core'
import { decodePng } from '../src/image-png.js'
import {
  ImageDocumentLocalStore,
  imageDocumentDigest,
  importSingleRaster,
} from '../src/image-document-local.js'
import {
  hydrateImageDocumentResources,
  openImageDocumentFromLibrary,
  saveImageDocumentToLibrary,
} from '../src/image-document-library.js'
import { exportImageDocumentSnapshot, openGraphImageDocument } from '../src/image-document-graph.js'
import type { AppState } from '../src/app-state.js'
import { imageDocumentPreviewRefusal } from '../src/image-document-renderer.js'

const SOURCE_PIXELS = new Uint8ClampedArray([
  255, 0, 0, 255,
  1, 2, 3, 64,
])

async function imported(
  store: ImageDocumentLocalStore,
  lineage = 'image-persistence-test',
) {
  return importSingleRaster(
    new File([new Uint8Array([1])], 'source.webp', { type: 'image/webp' }),
    store,
    { lineage, normalize: async () => ({ width: 2, height: 1, rgba: SOURCE_PIXELS }) },
  )
}

function manifest(document: ImageDocument): readonly ImageDocumentDependency[] {
  return Object.values(document.resources).filter((resource) => resource.inline === undefined).map((resource) => ({
    resourceId: resource.id,
    digest: resource.digest,
    byteSize: resource.byteSize,
    mediaType: resource.mediaType,
    width: resource.width,
    height: resource.height,
    colorSpace: resource.colorSpace,
    channelDepth: resource.channelDepth,
    alphaMode: resource.alphaMode,
  }))
}

function record(
  digest: string,
  overrides: Partial<LibraryRecord> = {},
): LibraryRecord {
  return {
    id: 'image-record',
    scope: 'local',
    name: 'Source image',
    digest,
    mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
    labels: ['image-document'],
    created: 1,
    modified: 2,
    revision: 1,
    ...overrides,
  }
}

function connectionFor(document: ImageDocument, resourceBytes: Uint8Array) {
  const canonical = serializeImageDocument(document)
  const digest = imageDocumentDigest(new TextEncoder().encode(canonical))
  const outputDigest = imageDocumentDigest(resourceBytes)
  const dependencies = manifest(document)
  const library = record(digest)
  const methods = {
    uploadMediaAsset: vi.fn(async () => ({
      digest: resourceBytes.length > 0 ? Object.values(document.resources)[0]!.digest : '',
      name: 'r0.png',
      size: resourceBytes.byteLength,
      mediaType: 'image/png',
      virtualPath: 'input/r0.png',
    })),
    adoptImageDocument: vi.fn(async () => ({
      digest,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      byteSize: new TextEncoder().encode(canonical).byteLength,
      dependencies,
    })),
    createLibraryRecord: vi.fn(async () => library),
    patchLibraryRecord: vi.fn(),
    getLibraryRecord: vi.fn(async (): Promise<LibraryRecord | undefined> => library),
    fetchAssetText: vi.fn(async () => canonical),
    fetchAssetBytes: vi.fn(async () => Uint8Array.from(resourceBytes).buffer),
    fetchImageDocumentDependencies: vi.fn(async () => dependencies),
    renderImageDocument: vi.fn(async (_digest: string, options: { selector?: string }) => ({
      cacheKey: `blake3:${'e'.repeat(64)}`,
      cached: false,
      asset: {
        digest: outputDigest,
        name: 'render.png',
        size: resourceBytes.byteLength,
        mediaType: 'image/png' as const,
        virtualPath: '',
      },
      provenance: {
        documentDigest: digest,
        selector: options.selector ?? 'composite',
        profile: 'dinkster-image-document-v2-cpu-reference' as const,
        rendererContract: 'test-renderer',
        encoding: 'image/png;dinkster-canonical=1' as const,
        source: { digest, mediaType: IMAGE_DOCUMENT_MEDIA_TYPE, dependencies },
        output: {
          digest: outputDigest,
          byteSize: resourceBytes.byteLength,
          mediaType: 'image/png' as const,
          width: document.canvas.width,
          height: document.canvas.height,
          encoding: 'image/png;dinkster-canonical=1' as const,
        },
      },
    })),
    assetUrl: vi.fn((assetDigest: string) => `http://assets.test/${assetDigest}`),
  }
  return { connection: methods as unknown as DinksterConnection, methods, digest, library, dependencies }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

function transaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

describe('ImageDocument local persistence', () => {
  it('keeps immutable resource bytes and drafts isolated by project', async () => {
    const factory = new FakeIDBFactory()
    const first = new ImageDocumentLocalStore('project-a', factory)
    const second = new ImageDocumentLocalStore('project-b', factory)
    const draft = await imported(first)
    const resource = Object.values(draft.document.resources)[0]!
    const staged = await first.getResource(resource.digest)
    expect(staged).toBeDefined()
    staged!.bytes[0] = 0
    expect((await first.getResource(resource.digest))!.bytes[0]).not.toBe(0)
    await expect(second.getResource(resource.digest)).resolves.toBeUndefined()
    await expect(second.recoverDraft(draft.document.lineage)).resolves.toBeUndefined()
    expect((await first.recoverDraft(draft.document.lineage))?.document).toEqual(draft.document)

    await expect(first.stageResource(
      { ...resource, width: resource.width + 1 },
      (await first.getResource(resource.digest))!.bytes,
      'conflict.png',
    )).rejects.toThrow('conflicts with immutable bytes')
    await first.close()
    await second.close()
  })

  it('normalizes a single raster into a canonical PNG-backed draft', async () => {
    const store = new ImageDocumentLocalStore('project-import', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    expect(resource.mediaType).toBe('image/png')
    expect(draft.document.canvas).toMatchObject({ width: 2, height: 1, colorSpace: 'srgb' })
    const staged = (await store.getResource(resource.digest))!
    expect(imageDocumentDigest(staged.bytes)).toBe(resource.digest)
    expect([...((await decodePng(staged.bytes)).rgba)]).toEqual([...SOURCE_PIXELS])
    expect((await store.recoverDrafts()).drafts).toHaveLength(1)
    await store.close()
  })

  it('recovers canonical v1 drafts and opens their library records without rewriting library identity', async () => {
    const factory = new FakeIDBFactory()
    const store = new ImageDocumentLocalStore('project-migrate', factory)
    try {
      const draft = await imported(store)
      const v1 = { ...draft.document, formatVersion: 1 }
      const database = await request(factory.open('dinkster.image-documents', 1))
      const edit = database.transaction('drafts', 'readwrite')
      const done = transaction(edit)
      const drafts = edit.objectStore('drafts')
      const stored = await request(drafts.get(`project-migrate\u0000${v1.lineage}`)) as Record<string, unknown>
      drafts.put({ ...stored, canonical: serializeImageDocument(v1) })
      await done
      database.close()
      expect((await store.recoverDraft(v1.lineage))?.document).toEqual(draft.document)
      const bytes = (await store.getResource(v1.resources.r0!.digest))!.bytes
      const remote = connectionFor(v1, bytes)
      const opened = await openImageDocumentFromLibrary(remote.connection, store, remote.library.id, 'local', 'backend-a')
      expect(opened?.document).toEqual(draft.document)
      expect(opened?.library?.digest).toBe(remote.digest)
      expect(remote.methods.adoptImageDocument).not.toHaveBeenCalled()
      expect(remote.methods.patchLibraryRecord).not.toHaveBeenCalled()
    } finally {
      await store.close()
    }
  })

  it('hydrates digest-checked inline resources without fetching an external asset or approximating v2 pixels', async () => {
    const source = new ImageDocumentLocalStore('inline-source', new FakeIDBFactory())
    const target = new ImageDocumentLocalStore('inline-target', new FakeIDBFactory())
    try {
      const draft = await imported(source)
      const resource = draft.document.resources.r0!
      const bytes = (await source.getResource(resource.digest))!.bytes
      const remote = connectionFor(draft.document, bytes)
      const document: ImageDocument = { ...draft.document,
        canvas: { ...draft.document.canvas, compositing: 'linear-premultiplied-alpha' },
        resources: { r0: { ...resource, inline: btoa(String.fromCharCode(...bytes)) } },
      }
      await hydrateImageDocumentResources(remote.connection, target, document)
      expect((await target.getResource(resource.digest))?.bytes).toEqual(bytes)
      expect(remote.methods.fetchAssetBytes).not.toHaveBeenCalled()
      expect(imageDocumentPreviewRefusal(document)).toContain('authoritative CPU render')
      expect(imageDocumentPreviewRefusal(draft.document)).toBeUndefined()
      expect((await target.saveDraft(document, 'Inline')).document).toEqual(document)
      expect((await target.recoverDraft(document.lineage))?.document).toEqual(document)
      const inlineRemote = connectionFor(document, bytes)
      expect(inlineRemote.dependencies).toEqual([])
      await saveImageDocumentToLibrary(inlineRemote.connection, target, document, {
        scope: 'local', connectionId: 'backend-a', name: 'Inline',
      })
      expect(inlineRemote.methods.uploadMediaAsset).not.toHaveBeenCalled()
      const opened = await openImageDocumentFromLibrary(inlineRemote.connection, target, inlineRemote.library.id, 'local', 'backend-a')
      expect(opened?.document).toEqual(document)
      expect(inlineRemote.methods.fetchAssetBytes).not.toHaveBeenCalled()
      const opaque = { ...resource, alphaMode: 'opaque' as const }
      await expect(target.stageResource(opaque, bytes, 'same-bytes.png')).resolves.toMatchObject({ digest: resource.digest })
      await hydrateImageDocumentResources(remote.connection, target, { ...draft.document, resources: { r0: opaque } })
      expect(imageDocumentPreviewRefusal({ ...draft.document, resources: { r0: opaque } })).toContain('alpha interpretation')
      expect(remote.methods.fetchAssetBytes).not.toHaveBeenCalled()
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('requires every external descriptor in adoption even when only the inline raster is referenced', async () => {
    const store = new ImageDocumentLocalStore('mixed-manifest', new FakeIDBFactory())
    try {
      const draft = await imported(store)
      const resource = draft.document.resources.r0!
      const bytes = (await store.getResource(resource.digest))!.bytes
      const document: ImageDocument = {
        ...draft.document,
        allocation: { nextOrdinal: 4 },
        resources: {
          r3: { ...resource, id: asImageResourceId('r3') },
          r0: { ...resource, inline: btoa(String.fromCharCode(...bytes)) },
          r2: { ...resource, id: asImageResourceId('r2'), alphaMode: 'premultiplied' },
        },
      }
      const remote = connectionFor(document, bytes)
      const dependency = {
        resourceId: 'r2', digest: resource.digest, byteSize: bytes.byteLength,
        mediaType: 'image/png' as const, width: 2, height: 1,
        colorSpace: 'srgb' as const, channelDepth: 8 as const, alphaMode: 'premultiplied' as const,
      }
      const dependencies = [dependency, { ...dependency, resourceId: 'r3', alphaMode: 'straight' as const }]
      const adoption = {
        digest: remote.digest, mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
        byteSize: new TextEncoder().encode(serializeImageDocument(document)).byteLength,
        dependencies,
      }
      remote.methods.adoptImageDocument.mockResolvedValue(adoption)
      for (const invalid of [[], [...dependencies, { ...dependency, resourceId: 'r0' }]]) {
        remote.methods.adoptImageDocument.mockResolvedValueOnce({ ...adoption, dependencies: invalid })
        await expect(saveImageDocumentToLibrary(remote.connection, store, document, {
          scope: 'local', connectionId: 'backend-a', name: 'Mixed',
        })).rejects.toThrow('dependency manifest')
      }
      expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()
      remote.methods.uploadMediaAsset.mockClear()
      const saved = await saveImageDocumentToLibrary(remote.connection, store, document, {
        scope: 'local', connectionId: 'backend-a', name: 'Mixed',
      })
      expect(saved.document).toEqual(document)
      expect(remote.methods.uploadMediaAsset).toHaveBeenCalledTimes(1)
      expect(remote.methods.adoptImageDocument).toHaveBeenLastCalledWith(
        new TextEncoder().encode(serializeImageDocument(document)),
        { scope: 'local', expectedDigest: remote.digest },
      )
    } finally {
      await store.close()
    }
  })

  it('validates every descriptor sharing raster bytes while preserving distinct alpha interpretations', async () => {
    const source = new ImageDocumentLocalStore('duplicate-source', new FakeIDBFactory())
    const target = new ImageDocumentLocalStore('duplicate-target', new FakeIDBFactory())
    try {
      const draft = await imported(source)
      const resource = draft.document.resources.r0!
      const bytes = (await source.getResource(resource.digest))!.bytes
      const document: ImageDocument = { ...draft.document, allocation: { nextOrdinal: 3 }, resources: {
        r0: resource, r2: { ...resource, id: asImageResourceId('r2'), alphaMode: 'premultiplied' },
      } }
      const remote = connectionFor(document, bytes)
      await hydrateImageDocumentResources(remote.connection, target, document)
      expect(remote.methods.fetchAssetBytes).toHaveBeenCalledTimes(1)
      const corrupt: ImageDocument = { ...document, resources: {
        ...document.resources, r2: { ...document.resources.r2!, width: resource.width + 1 },
      } }
      await expect(hydrateImageDocumentResources(remote.connection, target, corrupt))
        .rejects.toThrow('does not match its descriptor: r2')
      expect(remote.methods.fetchAssetBytes).toHaveBeenCalledTimes(1)
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('does not treat document retrieval as access to an unreferenced external raster', async () => {
    const source = new ImageDocumentLocalStore('unreferenced-source', new FakeIDBFactory())
    const target = new ImageDocumentLocalStore('unreferenced-target', new FakeIDBFactory())
    try {
      const draft = await imported(source)
      const bytes = (await source.getResource(draft.document.resources.r0!.digest))!.bytes
      const document: ImageDocument = { ...draft.document, rootLayerIds: [], layers: {}, masks: {} }
      const remote = connectionFor(document, bytes)
      remote.methods.fetchAssetBytes.mockRejectedValueOnce(new Error('asset access denied'))
      await expect(openImageDocumentFromLibrary(
        remote.connection, target, remote.library.id, 'local', 'backend-a',
      )).rejects.toThrow('asset access denied')
      expect(remote.methods.fetchAssetText).toHaveBeenCalled()
      expect(remote.methods.fetchAssetBytes).toHaveBeenCalledWith(document.resources.r0!.digest)
      expect(await target.recoverDraft(document.lineage)).toBeUndefined()
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('persists shared-session membership with the recoverable draft', async () => {
    const store = new ImageDocumentLocalStore('project-collab', new FakeIDBFactory())
    const draft = await imported(store)
    const linked = await store.setCollaboration(draft.document.lineage, {
      sessionId: 'session-image-1',
      baseUrl: 'http://127.0.0.1:8765',
    })
    expect(linked.collaboration).toEqual({
      sessionId: 'session-image-1',
      baseUrl: 'http://127.0.0.1:8765',
    })
    const saved = await store.saveDraft(linked.document, 'Edited while shared')
    expect(saved.collaboration).toEqual(linked.collaboration)
    expect((await store.recoverDraft(draft.document.lineage))?.collaboration).toEqual(linked.collaboration)
    await store.setCollaboration(draft.document.lineage, undefined)
    expect((await store.recoverDraft(draft.document.lineage))?.collaboration).toBeUndefined()
    await store.close()
  })

  it('allocates an import lineage when randomUUID is unavailable on a LAN origin', async () => {
    const store = new ImageDocumentLocalStore('project-lan', new FakeIDBFactory())
    let next = 0
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = next++
        return bytes
      },
    })
    try {
      const draft = await importSingleRaster(
        new File([new Uint8Array([1])], 'lan.png', { type: 'image/png' }),
        store,
        { normalize: async () => ({ width: 2, height: 1, rgba: SOURCE_PIXELS }) },
      )
      expect(draft.document.lineage).toMatch(/^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    } finally {
      vi.unstubAllGlobals()
      await store.close()
    }
  })

  it('reports corrupt drafts without blocking recovery of valid drafts', async () => {
    const factory = new FakeIDBFactory()
    const store = new ImageDocumentLocalStore('project-recovery', factory)
    const invalidJson = await imported(store, 'image-invalid-json')
    const nonCanonical = await imported(store, 'image-noncanonical')
    const invalidOwnership = await imported(store, 'image-invalid-ownership')
    const valid = await imported(store, 'image-valid')
    const database = await request(factory.open('dinkster.image-documents', 1))
    const edit = database.transaction('drafts', 'readwrite')
    const done = transaction(edit)
    const records = edit.objectStore('drafts')
    const invalidJsonKey = `project-recovery\u0000${invalidJson.document.lineage}`
    const invalidJsonRecord = await request(records.get(invalidJsonKey)) as Record<string, unknown>
    records.put({ ...invalidJsonRecord, canonical: '{not json' })
    const nonCanonicalKey = `project-recovery\u0000${nonCanonical.document.lineage}`
    const nonCanonicalRecord = await request(records.get(nonCanonicalKey)) as Record<string, unknown>
    records.put({
      ...nonCanonicalRecord,
      canonical: JSON.stringify(JSON.parse(nonCanonicalRecord['canonical'] as string), null, 2),
    })
    const invalidOwnershipKey = `project-recovery\u0000${invalidOwnership.document.lineage}`
    const invalidOwnershipRecord = await request(records.get(invalidOwnershipKey)) as Record<string, unknown>
    records.put({ ...invalidOwnershipRecord, library: { recordId: 'orphaned' } })
    await done
    database.close()

    await expect(store.recoverDraft(invalidJson.document.lineage)).resolves.toBeUndefined()
    const recovery = await store.recoverDrafts()
    expect(recovery.drafts.map((draft) => draft.document.lineage)).toEqual([valid.document.lineage])
    expect(recovery.rejectedLineages).toHaveLength(3)
    expect(recovery.rejectedLineages).toEqual(expect.arrayContaining([
      invalidJson.document.lineage,
      nonCanonical.document.lineage,
      invalidOwnership.document.lineage,
    ]))
    await store.close()
  })
})

describe('ImageDocument library persistence', () => {
  it('adopts resources and the typed document before creating a library record', async () => {
    const store = new ImageDocumentLocalStore('project-save', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const staged = (await store.getResource(resource.digest))!
    const remote = connectionFor(draft.document, staged.bytes)
    const saved = await saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local',
      connectionId: 'backend-a',
      name: 'Saved image',
    })
    expect(saved.digest).toBe(remote.digest)
    expect(remote.methods.uploadMediaAsset).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ scope: 'local', expectedDigest: resource.digest }),
    )
    expect(remote.methods.adoptImageDocument).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ scope: 'local', expectedDigest: remote.digest }),
    )
    expect(remote.methods.createLibraryRecord).toHaveBeenCalledWith(expect.objectContaining({
      digest: remote.digest,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      labels: ['image-document'],
    }))
    expect((await store.recoverDraft(draft.document.lineage))?.library).toEqual({
      recordId: remote.library.id,
      revision: remote.library.revision,
      digest: remote.digest,
      scope: 'local',
      connectionId: 'backend-a',
    })
    await store.close()
  })

  it('retries one optimistic update against the current library revision', async () => {
    const store = new ImageDocumentLocalStore('project-retry', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const remote = connectionFor(draft.document, (await store.getResource(resource.digest))!.bytes)
    remote.methods.patchLibraryRecord
      .mockResolvedValueOnce({ ok: false, conflict: true })
      .mockResolvedValueOnce({ ok: true, record: record(remote.digest, { revision: 5 }) })
    const previousDigest = `blake3:${'0'.repeat(64)}`
    remote.methods.getLibraryRecord.mockResolvedValueOnce(record(previousDigest, { revision: 4 }))
    const saved = await saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local',
      connectionId: 'backend-a',
      name: 'Updated image',
      link: {
        recordId: 'image-record', revision: 1, digest: previousDigest,
        scope: 'local', connectionId: 'backend-a',
      },
    })
    expect(saved.record.revision).toBe(5)
    expect(remote.methods.patchLibraryRecord).toHaveBeenNthCalledWith(
      2,
      'image-record',
      expect.objectContaining({ revision: 4 }),
    )
    expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()
    await store.close()
  })

  it('does not retry a library update over a newer document head', async () => {
    const store = new ImageDocumentLocalStore('project-conflict', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const remote = connectionFor(draft.document, (await store.getResource(resource.digest))!.bytes)
    remote.methods.patchLibraryRecord.mockResolvedValueOnce({ ok: false, conflict: true })
    remote.methods.getLibraryRecord.mockResolvedValueOnce(record(`blake3:${'0'.repeat(64)}`, {
      revision: 4,
    }))
    await expect(saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local',
      connectionId: 'backend-a',
      name: 'Conflicting image',
      link: {
        recordId: 'image-record', revision: 1, digest: remote.digest,
        scope: 'local', connectionId: 'backend-a',
      },
    })).rejects.toThrow('changed concurrently')
    expect(remote.methods.patchLibraryRecord).toHaveBeenCalledTimes(1)
    expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()
    await store.close()
  })

  it('reconciles an uncertain update after local edits without duplicating the record', async () => {
    const store = new ImageDocumentLocalStore('project-lost-ack', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await store.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    const previousDigest = `blake3:${'0'.repeat(64)}`
    const initialLink = {
      recordId: 'image-record', revision: 1, digest: previousDigest,
      scope: 'local', connectionId: 'backend-a',
    }
    await store.saveDraft(draft.document, draft.name, initialLink)
    remote.methods.patchLibraryRecord.mockRejectedValueOnce(new Error('response lost'))
    remote.methods.getLibraryRecord.mockRejectedValueOnce(new Error('offline'))
    await expect(saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local',
      connectionId: 'backend-a',
      name: 'Uncertain image',
    })).rejects.toThrow('response lost')
    expect((await store.recoverDraft(draft.document.lineage))?.library).toEqual({
      ...initialLink,
      pendingDigest: remote.digest,
    })

    const layerId = draft.document.rootLayerIds[0]!
    const edited: ImageDocument = {
      ...draft.document,
      layers: {
        ...draft.document.layers,
        [layerId]: { ...draft.document.layers[layerId]!, name: 'Edited after uncertain save' },
      },
    }
    await store.saveDraft(edited, 'Edited after uncertain save')
    const editedCanonical = serializeImageDocument(edited)
    const editedDigest = imageDocumentDigest(new TextEncoder().encode(editedCanonical))
    remote.methods.getLibraryRecord.mockResolvedValueOnce(record(remote.digest, { revision: 2 }))
    remote.methods.adoptImageDocument.mockResolvedValueOnce({
      digest: editedDigest,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      byteSize: new TextEncoder().encode(editedCanonical).byteLength,
      dependencies: manifest(edited),
    })
    remote.methods.patchLibraryRecord.mockResolvedValueOnce({
      ok: true,
      record: record(editedDigest, { revision: 3 }),
    })
    const saved = await saveImageDocumentToLibrary(remote.connection, store, edited, {
      scope: 'local', connectionId: 'backend-a', name: 'Edited after uncertain save',
    })
    expect(saved.record.revision).toBe(3)
    expect(saved.draft.library).toEqual({
      recordId: 'image-record', revision: 3, digest: editedDigest,
      scope: 'local', connectionId: 'backend-a',
    })
    expect(remote.methods.patchLibraryRecord).toHaveBeenCalledTimes(2)
    expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()
    await store.close()
  })

  it('stops a linked save when a local edit lands before pending publication', async () => {
    const store = new ImageDocumentLocalStore('project-linked-race', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const remote = connectionFor(draft.document, (await store.getResource(resource.digest))!.bytes)
    const baseDigest = `blake3:${'0'.repeat(64)}`
    await store.saveDraft(draft.document, draft.name, {
      recordId: 'image-record', revision: 1, digest: baseDigest,
      pendingDigest: `blake3:${'1'.repeat(64)}`,
      scope: 'local', connectionId: 'backend-a',
    })
    let releaseRead!: (value: LibraryRecord) => void
    const readGate = new Promise<LibraryRecord>((resolve) => { releaseRead = resolve })
    remote.methods.getLibraryRecord.mockImplementationOnce(async () => readGate)
    const saving = saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: draft.name,
    })
    await vi.waitFor(() => expect(remote.methods.getLibraryRecord).toHaveBeenCalledTimes(1))
    const layerId = draft.document.rootLayerIds[0]!
    const edited: ImageDocument = {
      ...draft.document,
      layers: {
        ...draft.document.layers,
        [layerId]: { ...draft.document.layers[layerId]!, name: 'Edit before pending write' },
      },
    }
    await store.saveDraft(edited, 'Edit before pending write')
    releaseRead(record(baseDigest))
    await expect(saving).rejects.toThrow('draft changed concurrently')
    const preserved = await store.recoverDraft(draft.document.lineage)
    expect(preserved?.document).toEqual(edited)
    expect(preserved?.library?.pendingDigest).toBe(remote.digest)
    expect(remote.methods.uploadMediaAsset).not.toHaveBeenCalled()
    await store.close()
  })

  it('does not replace a local edit that lands while a save is in flight', async () => {
    const store = new ImageDocumentLocalStore('project-save-race', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await store.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    let releaseUpload!: () => void
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
    remote.methods.uploadMediaAsset.mockImplementationOnce(async () => {
      await uploadGate
      return {
        digest: resource.digest,
        name: 'r0.png',
        size: bytes.byteLength,
        mediaType: 'image/png',
        virtualPath: 'input/r0.png',
      }
    })
    const saving = saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: 'Saving image',
    })
    await vi.waitFor(() => expect(remote.methods.uploadMediaAsset).toHaveBeenCalledTimes(1))
    const layerId = draft.document.rootLayerIds[0]!
    const localDocument: ImageDocument = {
      ...draft.document,
      layers: {
        ...draft.document.layers,
        [layerId]: { ...draft.document.layers[layerId]!, name: 'New local edit' },
      },
    }
    await store.saveDraft(localDocument, 'New local edit')
    releaseUpload()
    const saved = await saving
    expect(saved.draft.document).toEqual(localDocument)
    expect(saved.draft.name).toBe('New local edit')
    expect(saved.draft.library).toEqual({
      recordId: remote.library.id,
      revision: remote.library.revision,
      digest: remote.digest,
      scope: 'local',
      connectionId: 'backend-a',
    })
    expect(await store.recoverDraft(draft.document.lineage)).toEqual(saved.draft)
    await store.close()
  })

  it('refuses to fork or overwrite a linked record after ownership is lost', async () => {
    const store = new ImageDocumentLocalStore('project-owner', new FakeIDBFactory())
    const draft = await imported(store)
    const resource = Object.values(draft.document.resources)[0]!
    const remote = connectionFor(draft.document, (await store.getResource(resource.digest))!.bytes)
    const link = {
      recordId: 'image-record', revision: 1, digest: remote.digest,
      scope: 'local', connectionId: 'backend-a',
    }
    remote.methods.patchLibraryRecord.mockResolvedValue({ ok: false, conflict: true })
    remote.methods.getLibraryRecord.mockResolvedValueOnce(undefined)
    await expect(saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: 'Deleted image', link,
    })).rejects.toThrow('no longer exists')
    expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()

    remote.methods.getLibraryRecord.mockResolvedValueOnce(record(remote.digest, {
      mediaType: 'application/vnd.dinkster.workflow+json',
    }))
    await expect(saveImageDocumentToLibrary(remote.connection, store, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: 'Replaced image', link,
    })).rejects.toThrow('ownership changed')
    expect(remote.methods.patchLibraryRecord).toHaveBeenCalledTimes(1)
    await store.close()
  })

  it('opens only canonical documents with matching manifests and stages missing resources', async () => {
    const factory = new FakeIDBFactory()
    const source = new ImageDocumentLocalStore('project-source', factory)
    const target = new ImageDocumentLocalStore('project-open', factory)
    const draft = await imported(source)
    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await source.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    const opened = await openImageDocumentFromLibrary(
      remote.connection,
      target,
      remote.library.id,
      'local',
      'backend-a',
    )
    expect(opened?.document).toEqual(draft.document)
    expect(opened?.library).toEqual({
      recordId: remote.library.id,
      revision: remote.library.revision,
      digest: remote.digest,
      scope: 'local',
      connectionId: 'backend-a',
    })
    expect(remote.methods.fetchAssetBytes).toHaveBeenCalledWith(resource.digest)
    expect((await target.getResource(resource.digest))?.bytes).toEqual(bytes)
    const reopened = await openImageDocumentFromLibrary(
      remote.connection,
      target,
      remote.library.id,
      'local',
      'backend-a',
    )
    expect(reopened?.document).toEqual(draft.document)
    expect(reopened?.library).toEqual(opened?.library)
    await source.close()
    await target.close()
  })

  it('does not overwrite an existing local draft when opening the same lineage', async () => {
    const factory = new FakeIDBFactory()
    const source = new ImageDocumentLocalStore('project-source', factory)
    const target = new ImageDocumentLocalStore('project-open-conflict', factory)
    const draft = await imported(source)
    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await source.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    const layerId = draft.document.rootLayerIds[0]!
    const localDocument: ImageDocument = {
      ...draft.document,
      layers: {
        ...draft.document.layers,
        [layerId]: { ...draft.document.layers[layerId]!, name: 'Unsaved local edit' },
      },
    }
    const localDraft = await target.saveDraft(localDocument, 'Unsaved local edit')
    await expect(openImageDocumentFromLibrary(
      remote.connection,
      target,
      remote.library.id,
      'local',
      'backend-a',
    )).rejects.toThrow('unsaved changes')
    expect(await target.recoverDraft(draft.document.lineage)).toEqual(localDraft)
    await source.close()
    await target.close()
  })

  it('repairs an invalid local draft row when opening a valid saved document', async () => {
    const factory = new FakeIDBFactory()
    const source = new ImageDocumentLocalStore('project-source', factory)
    const target = new ImageDocumentLocalStore('project-open-repair', factory)
    const draft = await imported(source)
    await target.saveDraft(draft.document, draft.name)
    const database = await request(factory.open('dinkster.image-documents', 1))
    const edit = database.transaction('drafts', 'readwrite')
    const done = transaction(edit)
    const drafts = edit.objectStore('drafts')
    const key = `project-open-repair\u0000${draft.document.lineage}`
    const stored = await request(drafts.get(key)) as Record<string, unknown>
    drafts.put({ ...stored, canonical: '{invalid', updatedAt: 'invalid' })
    await done
    database.close()
    await expect(target.recoverDraft(draft.document.lineage)).resolves.toBeUndefined()

    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await source.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    const opened = await openImageDocumentFromLibrary(
      remote.connection, target, remote.library.id, 'local', 'backend-a',
    )
    expect(opened?.document).toEqual(draft.document)
    expect(await target.recoverDraft(draft.document.lineage)).toEqual(opened)
    await source.close()
    await target.close()
  })

  it('rejects missing resources and mismatched dependency manifests', async () => {
    const factory = new FakeIDBFactory()
    const source = new ImageDocumentLocalStore('project-source', factory)
    const unstaged = new ImageDocumentLocalStore('project-empty', factory)
    const draft = await imported(source)
    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await source.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    await expect(saveImageDocumentToLibrary(remote.connection, unstaged, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: 'Missing',
    })).rejects.toThrow('not staged')

    remote.methods.adoptImageDocument.mockResolvedValueOnce({
      digest: `blake3:${'0'.repeat(64)}`,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      byteSize: new TextEncoder().encode(serializeImageDocument(draft.document)).byteLength,
      dependencies: manifest(draft.document),
    })
    await expect(saveImageDocumentToLibrary(remote.connection, source, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: 'Wrong digest',
    })).rejects.toThrow('dependency manifest')

    remote.methods.adoptImageDocument.mockResolvedValueOnce({
      digest: remote.digest,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      byteSize: new TextEncoder().encode(serializeImageDocument(draft.document)).byteLength,
      dependencies: [],
    })
    await expect(saveImageDocumentToLibrary(remote.connection, source, draft.document, {
      scope: 'local', connectionId: 'backend-a', name: 'Mismatch',
    })).rejects.toThrow('dependency manifest')

    const target = new ImageDocumentLocalStore('project-target', factory)
    remote.methods.fetchImageDocumentDependencies.mockResolvedValueOnce([])
    await expect(openImageDocumentFromLibrary(
      remote.connection,
      target,
      remote.library.id,
      'local',
      'backend-a',
    )).rejects.toThrow('dependency manifest')
    await source.close()
    await unstaged.close()
    await target.close()
  })
})

describe('graph image document opening', () => {
  it('refuses exports when the destination tab, graph or backend changes during adoption', async () => {
    const local = new ImageDocumentLocalStore('export', new FakeIDBFactory())
    try {
      const draft = await imported(local)
      const bytes = (await local.getResource(draft.document.resources.r0!.digest))!.bytes
      for (const change of ['tab', 'graph', 'backend']) {
        const remote = connectionFor(draft.document, bytes)
        let moved = false
        const tab = {
          graphStack: { get: () => moved && change === 'graph' ? ['g1'] : [] },
          store: { doc: { root: 'g0', graphs: { g0: { id: 'g0', nodes: {}, links: {} } } } },
        }
        const backend = { protocol: 'dinkster', connection: remote.connection }
        const dispatchTo = vi.fn()
        const app = {
          activeTab: () => moved && change === 'tab' ? undefined : tab,
          backendForTab: () => moved && change === 'backend' ? { ...backend } : backend,
          registryForTab: () => ({ resolve: () => ({}) }),
          dispatchTo,
        } as unknown as AppState
        const adopt = remote.methods.adoptImageDocument.getMockImplementation()!
        remote.methods.adoptImageDocument.mockImplementation(async () => {
          moved = true
          return adopt()
        })
        await expect(exportImageDocumentSnapshot(app, local, draft.document, draft.name)).rejects.toThrow('changed during export')
        expect(dispatchTo).not.toHaveBeenCalled()
        expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()
      }
    } finally {
      await local.close()
    }
  })

  it('negotiates the native rendition with exact runtime identity and protects recovered edits', async () => {
    const factory = new FakeIDBFactory()
    const source = new ImageDocumentLocalStore('graph-source', factory)
    const target = new ImageDocumentLocalStore('graph-target', factory)
    const draft = await imported(source)
    const resource = Object.values(draft.document.resources)[0]!
    const bytes = (await source.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, bytes)
    const canonical = serializeImageDocument(draft.document)
    const peek = vi.fn(async () => ({ available: true as const,
      descriptor: { typeId: 'dinkster.layers', fingerprint: 'source-fingerprint' },
      renditions: [{ kind: 'image', mime: 'image/png' }, { kind: 'document', mime: IMAGE_DOCUMENT_MEDIA_TYPE }],
    }))
    const rendition = vi.fn(async () => ({ available: true as const, fingerprint: 'source-fingerprint',
      typeId: 'dinkster.layers', mime: IMAGE_DOCUMENT_MEDIA_TYPE, kind: 'document', reportedKind: 'document',
      bytes: new TextEncoder().encode(canonical).buffer,
    }))
    const connection = { ...remote.methods, values: () => ({ peek, rendition }) } as unknown as DinksterConnection
    const query = { jobId: 'remote-job', nodeId: 'group[2]/producer', outputId: 'layers', element: [1] }
    try {
      const opened = await openGraphImageDocument(connection, target, query)
      expect(peek).toHaveBeenCalledWith(query)
      expect(rendition).toHaveBeenCalledWith(query, 'document')
      expect(serializeImageDocument(opened.draft.document)).toBe(canonical)
      expect(opened.render.sourceCanonical).toBe(canonical)
      expect(opened.render.response.provenance.documentDigest).toBe(remote.digest)
      expect(remote.methods.adoptImageDocument).toHaveBeenCalledWith(
        new TextEncoder().encode(canonical),
        { scope: 'local', expectedDigest: remote.digest },
      )
      expect(remote.methods.renderImageDocument).toHaveBeenCalledWith(remote.digest, {
        scope: 'local', selector: 'composite',
      })
      expect((await target.getResource(resource.digest))!.bytes).toEqual(bytes)
      expect(remote.methods.createLibraryRecord).not.toHaveBeenCalled()
      const edited = { ...opened.draft.document, canvas: { ...opened.draft.document.canvas, width: 5 } }
      await target.saveDraft(edited, 'Local edits', undefined, opened.draft.updatedAt)
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('unsaved local edits')
      expect((await target.recoverDraft(draft.document.lineage))!.document.canvas.width).toBe(5)
    } finally {
      await source.close()
      await target.close()
    }
  })

  it('refuses unavailable, preview-only, stale-fingerprint and corrupt resources without writing drafts', async () => {
    const factory = new FakeIDBFactory()
    const source = new ImageDocumentLocalStore('source', factory)
    const target = new ImageDocumentLocalStore('target', factory)
    const draft = await imported(source)
    const resource = Object.values(draft.document.resources)[0]!
    const resourceBytes = (await source.getResource(resource.digest))!.bytes
    const remote = connectionFor(draft.document, resourceBytes)
    const peek = vi.fn()
    const rendition = vi.fn()
    const connection = { ...remote.methods, values: () => ({ peek, rendition }) } as unknown as DinksterConnection
    const query = { jobId: 'job', nodeId: 'node', outputId: 'layers' }
    const descriptor = { typeId: 'dinkster.layers', fingerprint: 'one' }
    try {
      peek.mockResolvedValue({ available: false, error: 'evicted' })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('evicted')
      peek.mockResolvedValue({ available: true, descriptor, renditions: [{ kind: 'preview', mime: 'image/png' }] })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('native ImageDocument rendition')
      peek.mockResolvedValue({ available: true, descriptor, renditions: [{ kind: 'document', mime: IMAGE_DOCUMENT_MEDIA_TYPE }] })
      const result = { available: true, mime: IMAGE_DOCUMENT_MEDIA_TYPE, typeId: 'dinkster.layers',
        kind: 'document', reportedKind: 'document',
        bytes: new TextEncoder().encode(serializeImageDocument(draft.document)).buffer }
      rendition.mockResolvedValue({ ...result, fingerprint: 'two' })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('does not match')
      rendition.mockResolvedValue({ ...result, fingerprint: 'one', typeId: undefined })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('does not match')
      rendition.mockResolvedValue({ ...result, fingerprint: 'one', reportedKind: undefined })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('does not match')
      rendition.mockResolvedValue({ ...result, fingerprint: 'one', mime: `${IMAGE_DOCUMENT_MEDIA_TYPE}; charset=utf-8` })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('does not match')
      rendition.mockResolvedValue({ ...result, fingerprint: 'one',
        bytes: new TextEncoder().encode(JSON.stringify(draft.document, null, 2)).buffer })
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('not canonical')
      rendition.mockResolvedValue({ ...result, fingerprint: 'one' })
      remote.methods.adoptImageDocument.mockRejectedValueOnce(new Error('dependency grant refused'))
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('dependency grant refused')
      remote.methods.renderImageDocument.mockRejectedValueOnce(new Error('reference render refused'))
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('reference render refused')
      remote.methods.fetchAssetBytes
        .mockResolvedValueOnce(Uint8Array.from(resourceBytes).buffer)
        .mockResolvedValue(new Uint8Array([0]).buffer)
      await expect(openGraphImageDocument(connection, target, query)).rejects.toThrow('do not match')
      expect((await target.recoverDrafts()).drafts).toEqual([])
    } finally {
      await source.close()
      await target.close()
    }
  })
})
