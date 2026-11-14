import {
  IMAGE_DOCUMENT_MEDIA_TYPE,
  type DinksterConnection,
  type ImageDocumentDependency,
  type LibraryRecord,
  type RenderedImageDocument,
  type RetainedAssets,
} from '@dinkster/client'
import {
  MAX_IMAGE_DOCUMENT_BYTES,
  canonicalJson,
  connectSharedImageDocumentSession,
  createLocalImageDocumentSession,
  diag,
  loadImageDocument,
  serializeImageDocument,
  type CollabConnection,
  type CollabSessionDescriptor,
  type ImageDocument,
  type ImageDocumentCommandInvocation,
  type ImageDocumentDispatchOutcome,
  type ImageDocumentSession,
  type ImageRasterResource,
  type PreparedImageDocumentDispatch,
  type SharedImageDocumentSession,
  type SharedImageDocumentSessionOptions,
} from '@dinkster/core'
import {
  ImageDocumentLocalStore,
  imageDocumentDigest,
  type ImageDocumentDraft,
  type ImageLibraryLink,
  type StagedImageResource,
} from './image-document-local.js'
import { activeProjectId } from './projects.js'
import { RetainedAssetReader, retainWorkflowAssets, retireAssetOwner } from './workflow-asset-retention.js'

export const IMAGE_DOCUMENT_LIBRARY_LABEL = 'image-document'

export interface RetainedImageDocumentSession<S extends ImageDocumentSession = ImageDocumentSession> {
  readonly session: S
  dispatch(invocation: ImageDocumentCommandInvocation): Promise<ImageDocumentDispatchOutcome>
  undo(): Promise<ImageDocumentDispatchOutcome>
  redo(): Promise<ImageDocumentDispatchOutcome>
  readPreviewResource<T>(holder: object, resource: ImageRasterResource, consume: (staged: StagedImageResource) => Promise<T>): Promise<T>
  previewCurrent(): boolean
  close(): Promise<void>
}

export function createRetainedLocalImageDocumentSession(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  document: ImageDocument,
  isCurrent: () => boolean,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): Promise<RetainedImageDocumentSession> {
  return createRetainedImageDocumentSession(connection, store,
    (options) => Promise.resolve(createLocalImageDocumentSession(document, options)), isCurrent, storage)
}

export async function createRetainedSharedImageDocumentSession(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  transport: CollabConnection,
  descriptor: CollabSessionDescriptor,
  options: Pick<SharedImageDocumentSessionOptions, 'actorId' | 'onConflict' | 'onError'>,
  isCurrent: () => boolean,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): Promise<RetainedImageDocumentSession<SharedImageDocumentSession>> {
  let disconnected = false
  const stop = transport.onEvent((event) => {
    if (event.kind === 'disconnected' || event.kind === 'session-closed') disconnected = true
  })
  try {
    const retained = await createRetainedImageDocumentSession(connection, store,
      (admission) => connectSharedImageDocumentSession(transport, descriptor, { ...options, ...admission }),
      () => !disconnected && isCurrent(), storage, descriptor.scope)
    return { ...retained, close: async () => { stop(); await retained.close() } }
  } catch (cause) {
    stop()
    transport.close()
    throw cause
  }
}

async function createRetainedImageDocumentSession<S extends ReturnType<typeof createLocalImageDocumentSession> | SharedImageDocumentSession>(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  createSession: (options: Pick<SharedImageDocumentSessionOptions, 'validateCommit' | 'beforeRemoteDocument'>) => Promise<S>,
  isCurrent: () => boolean,
  storage: Pick<Storage, 'setItem'>,
  remoteScope?: string,
) {
  const assetBaseUrl = connection.assetUrl('')
  const project = activeProjectId()
  let closed = false
  let connectionChanged = false
  const unsubscribe = connection.status.subscribe(() => { connectionChanged = true })
  const assertCurrent = (): void => {
    if (closed || connectionChanged || activeProjectId() !== project || connection.status.get() !== 'connected' ||
      connection.assetUrl('') !== assetBaseUrl || !isCurrent()) {
      throw new Error('ImageDocument destination changed during asset admission')
    }
  }
  let initializing = true
  let admitted: ImageDocument | undefined
  let stopSession = (): void => undefined
  const pending = new Set<Promise<unknown>>()
  const previewReaders = new WeakMap<object, Map<string, Promise<RetainedAssetReader>>>()
  let session: S | undefined
  let owner: RetainedAssets | undefined
  const superseded = new Set<RetainedAssets>()
  const installOwner = (retained: RetainedAssets): void => {
    try { assertCurrent() } catch { return }
    const previous = owner
    owner = retained
    if (previous === undefined || !previous.complete || !retained.complete) return
    superseded.add(previous)
    queueMicrotask(() => {
      try { assertCurrent() } catch { return }
      if (owner !== retained || storage !== globalThis.localStorage) return
      for (const previous of superseded) {
        superseded.delete(previous)
        const task = retireAssetOwner(connection, previous)
        pending.add(task)
        void task.finally(() => pending.delete(task)).catch(() => undefined)
      }
    })
  }
  try {
    assertCurrent()
    session = await createSession({
      validateCommit: (_current, candidate) => {
        if (initializing) return []
        if (admitted === candidate) { admitted = undefined; return [] }
        return [diag('error', 'command', 'image.retention.required', 'ImageDocument change requires asset admission')]
      },
      ...(remoteScope === undefined ? {} : {
        beforeRemoteDocument: (document, revision, _current, digests, snapshots) => {
          const task = (async () => {
            assertCurrent()
            for (const snapshot of snapshots) {
              await hydrateImageDocumentResources(connection, store, snapshot, remoteScope, assertCurrent)
            }
            assertCurrent()
            const retained = await retainWorkflowAssets(connection, document.lineage, revision,
              { complete: true, digests }, storage, undefined, false, [2, 3, 4])
            assertCurrent()
            return () => {
              if (session !== undefined && session.doc !== document) return
              installOwner(retained)
            }
          })()
          pending.add(task)
          void task.finally(() => pending.delete(task)).catch(() => undefined)
          return task
        },
      } satisfies Pick<SharedImageDocumentSessionOptions, 'beforeRemoteDocument'>),
    })
    const admittedSession = session
    stopSession = (): void => { if ('close' in admittedSession) admittedSession.close() }
    initializing = false
    const uploaded = new Set<string>()
    const uploadResources = async (snapshot: ImageDocument): Promise<void> => {
      for (const resource of Object.values(snapshot.resources)) {
        if (resource.inline !== undefined) continue
        const staged = await store.getResource(resource.digest)
        assertCurrent()
        if (staged === undefined || !stagedMatches(resource, staged)) {
          throw new Error(`staged ImageDocument resource does not match its descriptor: ${resource.id}`)
        }
        if (uploaded.has(resource.digest)) continue
        await uploadImageDocumentResource(connection, store, resource, remoteScope ?? 'local', undefined, assertCurrent)
        uploaded.add(resource.digest)
      }
    }
    if (remoteScope === undefined) {
      await uploadResources(session.doc)
      assertCurrent()
      const retained = await retainWorkflowAssets(connection, session.doc.lineage, session.revision,
        { complete: true, digests: [...session.retainedResourceDigests()].sort() }, storage, undefined, false, [2, 3, 4])
      installOwner(retained)
    }
    assertCurrent()
    const commit = (prepared: PreparedImageDocumentDispatch): Promise<ImageDocumentDispatchOutcome> => {
      const revision = admittedSession.revision + 1
      const task = (async (): Promise<ImageDocumentDispatchOutcome> => {
        assertCurrent()
        if (!prepared.ok) return prepared
        await uploadResources(prepared.document)
        const retained = await retainWorkflowAssets(connection, prepared.document.lineage, revision,
          { complete: true, digests: prepared.resourceDigests }, storage, undefined, false, [2, 3, 4])
        assertCurrent()
        admitted = prepared.document
        try {
          const outcome = prepared.commit()
          if (outcome.ok && admittedSession.doc === outcome.document && admittedSession.revision === outcome.revision) installOwner(retained)
          return outcome
        } finally { admitted = undefined }
      })()
      pending.add(task)
      void task.finally(() => pending.delete(task)).catch(() => undefined)
      return task
    }
    return {
      session,
      previewCurrent: (): boolean => { try { assertCurrent(); return true } catch { return false } },
      dispatch: (invocation: ImageDocumentCommandInvocation) => commit(admittedSession.prepareDispatch(invocation)),
      undo: () => commit(admittedSession.prepareUndo()),
      redo: () => commit(admittedSession.prepareRedo()),
      readPreviewResource: <T>(holder: object, resource: ImageRasterResource, consume: (staged: StagedImageResource) => Promise<T>): Promise<T> => {
        const task = (async (): Promise<T> => {
          assertCurrent()
          let readers = previewReaders.get(holder)
          if (readers === undefined) { readers = new Map(); previewReaders.set(holder, readers) }
          const key = JSON.stringify(resource)
          let admission = readers.get(key)
          if (admission === undefined) {
            admission = (async () => {
              const digests = resource.inline === undefined ? [resource.digest] : []
              const read = await store.beginResourceRead(connection.id, assetBaseUrl, remoteScope ?? 'local', digests)
              assertCurrent()
              const matches = (actual: RetainedAssets | undefined): actual is RetainedAssets => actual !== undefined &&
                actual.scope === read.owner.scope && actual.ownerKind === read.owner.ownerKind &&
                actual.ownerId === read.owner.ownerId && actual.revision === 1 && actual.complete === true &&
                actual.digests.length === digests.length && actual.digests.every((digest, index) => digest === digests[index])
              let acknowledged: RetainedAssets | undefined
              try {
                acknowledged = await connection.retainAssets(read.owner, { revision: 0, complete: true, digests })
                if (!matches(acknowledged)) throw new Error('Image preview retention acknowledgment differs')
              } catch (cause) {
                try { acknowledged = await connection.fetchRetainedAssets(read.owner) } catch { /* Intent stays unresolved. */ }
                if (!matches(acknowledged)) throw cause
              }
              assertCurrent()
              return new RetainedAssetReader(connection, acknowledged, () => {
                try { assertCurrent(); return true } catch { return false }
              })
            })()
            readers.set(key, admission)
          }
          const reader = await admission
          return reader.read(async () => {
            const staged = await store.getResource(resource.digest)
            assertCurrent()
            if (staged === undefined || !stagedMatches(resource, staged)) {
              throw new Error(`staged ImageDocument resource does not match its descriptor: ${resource.id}`)
            }
            return consume(staged)
          })
        })()
        pending.add(task)
        void task.finally(() => pending.delete(task)).catch(() => undefined)
        return task
      },
      close: async (): Promise<void> => {
        closed = true
        unsubscribe()
        stopSession()
        await Promise.allSettled([...pending])
      },
    }
  } catch (cause) {
    closed = true
    unsubscribe()
    stopSession()
    throw cause
  }
}

function expectedDependencies(document: ImageDocument): readonly ImageDocumentDependency[] {
  return Object.values(document.resources)
    .filter((resource) => resource.inline === undefined)
    .map((resource) => ({
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
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId))
}

function sameDependency(
  left: ImageDocumentDependency,
  right: ImageDocumentDependency,
): boolean {
  return left.resourceId === right.resourceId && left.digest === right.digest &&
    left.byteSize === right.byteSize && left.mediaType === right.mediaType &&
    left.width === right.width && left.height === right.height &&
    left.colorSpace === right.colorSpace && left.channelDepth === right.channelDepth &&
    left.alphaMode === right.alphaMode
}

function manifestMatches(
  actual: readonly ImageDocumentDependency[],
  expected: readonly ImageDocumentDependency[],
): boolean {
  if (actual.length !== expected.length) return false
  const sorted = [...actual].sort((left, right) => left.resourceId.localeCompare(right.resourceId))
  return sorted.every((dependency, index) => sameDependency(dependency, expected[index]!))
}

function stagedMatches(resource: ImageRasterResource, staged: StagedImageResource): boolean {
  return staged.digest === resource.digest && staged.bytes.byteLength === resource.byteSize &&
    staged.mediaType === resource.mediaType && staged.width === resource.width &&
    staged.height === resource.height && staged.colorSpace === resource.colorSpace &&
    staged.channelDepth === resource.channelDepth &&
    imageDocumentDigest(staged.bytes) === resource.digest
}

function mediaTypeBase(mediaType: string): string {
  return mediaType.split(';', 1)[0]!.trim().toLowerCase()
}

function resourceFile(resource: ImageRasterResource, staged: StagedImageResource): File {
  const extension = resource.mediaType === 'image/jpeg' ? 'jpg' : resource.mediaType.slice('image/'.length)
  const name = `image-${resource.digest.slice('blake3:'.length, 'blake3:'.length + 16)}.${extension}`
  return new File([Uint8Array.from(staged.bytes)], name, {
    type: resource.mediaType,
  })
}

export async function uploadImageDocumentResource(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  resource: ImageRasterResource,
  scope: string,
  signal?: AbortSignal,
  assertCurrent: () => void = () => undefined,
): Promise<void> {
  assertCurrent()
  const staged = await store.getResource(resource.digest)
  assertCurrent()
  if (staged === undefined) throw new Error(`ImageDocument resource is not staged: ${resource.id}`)
  if (!stagedMatches(resource, staged)) {
    throw new Error(`staged ImageDocument resource does not match its descriptor: ${resource.id}`)
  }
  const file = resourceFile(resource, staged)
  const adopted = await connection.uploadMediaAsset(file, {
    scope,
    kind: 'media/image',
    name: file.name,
    expectedDigest: resource.digest,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (adopted.digest !== resource.digest || adopted.size !== resource.byteSize ||
    mediaTypeBase(adopted.mediaType) !== resource.mediaType) {
    throw new Error(`server returned a mismatched ImageDocument resource: ${resource.id}`)
  }
  await retainStagedImageResource(connection, store, scope, resource.digest)
  assertCurrent()
}

async function retainStagedImageResource(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  scope: string,
  digest: string,
): Promise<void> {
  const retention = await store.beginStagedResourceRetention(connection.id, connection.assetUrl(''), scope, digest)
  const matches = (actual: RetainedAssets | undefined): boolean => actual !== undefined &&
    actual.scope === scope && actual.ownerKind === retention.owner.ownerKind &&
    actual.ownerId === retention.owner.ownerId && actual.revision === 1 && actual.complete === true &&
    actual.digests.length === 1 && actual.digests[0] === digest
  try {
    const acknowledged = await connection.retainAssets(retention.owner, { revision: 0, complete: true, digests: [digest] })
    if (!matches(acknowledged)) throw new Error('Staged image retention acknowledgment differs')
  } catch (cause) {
    let observed: RetainedAssets | undefined
    try { observed = await connection.fetchRetainedAssets(retention.owner) } catch { /* Durable intent stays unresolved. */ }
    if (!matches(observed)) throw cause
  }
  await store.confirmStagedResourceRetention(retention)
}

async function withImageResourceRead<T>(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  scope: string,
  digests: readonly string[],
  consume: () => Promise<T>,
): Promise<T> {
  if (digests.length > 4096) throw new Error('Image resource read exceeds the retained identity limit')
  const read = digests.length === 0 ? undefined : await store.beginResourceRead(
    connection.id, connection.assetUrl(''), scope, digests,
  )
  const matches = (actual: RetainedAssets | undefined, revision: number, expected: readonly string[]): boolean =>
    actual !== undefined && read !== undefined && actual.scope === read.owner.scope &&
    actual.ownerKind === read.owner.ownerKind && actual.ownerId === read.owner.ownerId &&
    actual.revision === revision && actual.complete === true &&
    actual.digests.length === expected.length && actual.digests.every((digest, index) => digest === expected[index])
  if (read !== undefined) {
    try {
      const acknowledged = await connection.retainAssets(read.owner, { revision: 0, complete: true, digests })
      if (!matches(acknowledged, 1, digests)) throw new Error('Image resource retention acknowledgment differs')
    } catch (error) {
      // A lost write response is not permission to replay or read unheld bytes.
      let current: RetainedAssets | undefined
      try { current = await connection.fetchRetainedAssets(read.owner) } catch { /* Durable intent remains unresolved. */ }
      if (!matches(current, 1, digests)) throw error
    }
  }
  try {
    return await consume()
  } finally {
    if (read !== undefined) {
      try {
        const released = await connection.releaseRetainedAssets(read.owner, 1)
        if (!matches(released, 2, [])) throw new Error('Image resource release acknowledgment differs')
      } catch (error) {
        let current: RetainedAssets | undefined
        try { current = await connection.fetchRetainedAssets(read.owner) } catch { /* Durable intent remains unresolved. */ }
        if (!matches(current, 2, [])) throw error
      }
      await store.finishResourceRead(read)
    }
  }
}

export async function hydrateImageDocumentResources(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  document: ImageDocument,
  scope: string,
  assertCurrent: () => void = () => undefined,
): Promise<void> {
  const loaded = loadImageDocument(document)
  if (loaded.document === undefined) throw new Error('cannot hydrate an invalid ImageDocument')
  const resources = Object.values(loaded.document.resources)
  const missing = new Set<string>()
  for (const resource of resources) {
    const local = await store.getResource(resource.digest)
    assertCurrent()
    if (local !== undefined && !stagedMatches(resource, local)) {
      throw new Error(`local ImageDocument resource does not match its descriptor: ${resource.id}`)
    }
    if (local === undefined && resource.inline === undefined) missing.add(resource.digest)
  }
  await withImageResourceRead(connection, store, scope, [...missing].sort(), async () => {
    assertCurrent()
    const retained = new Set<string>()
    for (const resource of resources) {
      const local = await store.getResource(resource.digest)
      assertCurrent()
      if (local !== undefined) {
        if (!stagedMatches(resource, local)) {
          throw new Error(`local ImageDocument resource does not match its descriptor: ${resource.id}`)
        }
        if (resource.inline === undefined && !retained.has(resource.digest)) {
          await retainStagedImageResource(connection, store, scope, resource.digest)
          retained.add(resource.digest)
          assertCurrent()
        }
      } else {
        const fetched = resource.inline === undefined
          ? await connection.fetchAssetBytes(resource.digest)
          : Uint8Array.from(atob(resource.inline), (character) => character.charCodeAt(0))
        assertCurrent()
        if (fetched === undefined) {
          throw new Error(`ImageDocument resource is not held by the server: ${resource.id}`)
        }
        const bytes = new Uint8Array(fetched)
        if (bytes.byteLength !== resource.byteSize || imageDocumentDigest(bytes) !== resource.digest) {
          throw new Error('staged resource bytes do not match their descriptor')
        }
        if (resource.inline === undefined) {
          await retainStagedImageResource(connection, store, scope, resource.digest)
          retained.add(resource.digest)
          assertCurrent()
        }
        await store.stageResource(
          resource,
          bytes,
          `${resource.id}.${resource.mediaType.slice('image/'.length)}`,
        )
      }
    }
  })
}

function linkedRecord(record: LibraryRecord, link: ImageLibraryLink, scope: string): LibraryRecord {
  if (record.id !== link.recordId || record.scope !== scope ||
    mediaTypeBase(record.mediaType) !== IMAGE_DOCUMENT_MEDIA_TYPE) {
    throw new Error('linked image library record ownership changed')
  }
  return record
}

async function reconcilePendingLink(
  connection: DinksterConnection,
  link: ImageLibraryLink,
): Promise<ImageLibraryLink> {
  if (link.pendingDigest === undefined) return link
  const fresh = await connection.getLibraryRecord(link.recordId, link.scope)
  if (fresh === undefined) throw new Error('linked image library record no longer exists')
  linkedRecord(fresh, link, link.scope)
  if (fresh.digest !== link.digest && fresh.digest !== link.pendingDigest) {
    throw new Error('linked image library record changed concurrently - save again')
  }
  return {
    recordId: link.recordId,
    revision: fresh.revision,
    digest: fresh.digest,
    scope: link.scope,
    connectionId: link.connectionId,
  }
}

async function publishLibraryRecord(
  connection: DinksterConnection,
  options: {
    readonly scope: string
    readonly name: string
    readonly digest: string
    readonly connectionId: string
    readonly labels?: readonly string[]
    readonly folder?: string
    readonly link?: ImageLibraryLink
  },
  assertCurrent: () => void = () => undefined,
): Promise<LibraryRecord> {
  assertCurrent()
  const link = options.link
  if (link?.connectionId === options.connectionId && link.scope === options.scope) {
    const patch = {
      scope: options.scope,
      revision: link.revision,
      name: options.name,
      digest: options.digest,
      mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
      ...(options.folder !== undefined ? { folder: options.folder } : {}),
    }
    let first
    try {
      first = await connection.patchLibraryRecord(link.recordId, patch)
    } catch (error) {
      assertCurrent()
      try {
        const fresh = await connection.getLibraryRecord(link.recordId, options.scope)
        if (fresh !== undefined && linkedRecord(fresh, link, options.scope).digest === options.digest) {
          return fresh
        }
      } catch {
        // Preserve the original write error when reconciliation is unavailable.
      }
      throw error
    }
    if (first.ok) return linkedRecord(first.record, link, options.scope)
    assertCurrent()
    const fresh = await connection.getLibraryRecord(link.recordId, options.scope)
    assertCurrent()
    if (fresh === undefined) throw new Error('linked image library record no longer exists')
    linkedRecord(fresh, link, options.scope)
    if (fresh.digest === options.digest) return fresh
    if (fresh.digest !== link.digest) {
      throw new Error('linked image library record changed concurrently - save again')
    }
    const retry = await connection.patchLibraryRecord(link.recordId, {
      ...patch,
      revision: fresh.revision,
    })
    if (!retry.ok) throw new Error('image library record changed concurrently - save again')
    return linkedRecord(retry.record, link, options.scope)
  }
  return connection.createLibraryRecord({
    scope: options.scope,
    name: options.name,
    digest: options.digest,
    mediaType: IMAGE_DOCUMENT_MEDIA_TYPE,
    labels: options.labels ?? [IMAGE_DOCUMENT_LIBRARY_LABEL],
    ...(options.folder !== undefined ? { folder: options.folder } : {}),
  })
}

export interface SavedImageDocument {
  readonly document: ImageDocument
  readonly digest: `blake3:${string}`
  readonly record: LibraryRecord
  readonly draft: ImageDocumentDraft
}

export interface AdoptedImageDocumentForRender {
  readonly document: ImageDocument
  readonly digest: `blake3:${string}`
}

export interface VerifiedImageDocumentRender {
  readonly response: RenderedImageDocument
  readonly image: Blob
  readonly sourceCanonical: string
}

export async function adoptExactImageDocumentBytes(
  connection: DinksterConnection,
  document: ImageDocument,
  bytes: Uint8Array,
  scope: string,
  signal?: AbortSignal,
): Promise<AdoptedImageDocumentForRender> {
  const digest = imageDocumentDigest(bytes)
  const adopted = await connection.adoptImageDocument(bytes, {
    scope,
    expectedDigest: digest,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (adopted.digest !== digest || adopted.mediaType !== IMAGE_DOCUMENT_MEDIA_TYPE ||
    adopted.byteSize !== bytes.byteLength ||
    !manifestMatches(adopted.dependencies, expectedDependencies(document))) {
    throw new Error('server returned a mismatched ImageDocument dependency manifest')
  }
  return { document, digest }
}

export async function renderAdoptedImageDocument(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  digest: string,
  sourceCanonical: string,
  scope: string,
  selector = 'composite',
  signal?: AbortSignal,
  assertCurrent: () => void = () => undefined,
): Promise<VerifiedImageDocumentRender> {
  assertCurrent()
  const response = await connection.renderImageDocument(digest, {
    scope,
    selector,
    ...(signal !== undefined ? { signal } : {}),
  })
  assertCurrent()
  return withImageResourceRead(connection, store, scope, [response.asset.digest], async () => {
    assertCurrent()
    const fetched = await connection.fetchAssetBytes(response.asset.digest)
    assertCurrent()
    if (fetched === undefined) throw new Error('Rendered ImageDocument PNG is not held by the server')
    const bytes = new Uint8Array(fetched)
    if (bytes.byteLength !== response.asset.size || imageDocumentDigest(bytes) !== response.asset.digest) {
      throw new Error('Rendered ImageDocument PNG does not match its asset identity')
    }
    return {
      response,
      image: new Blob([bytes], { type: 'image/png' }),
      sourceCanonical,
    }
  })
}

async function adoptOwnedImageDocument(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  document: ImageDocument,
  scope: string,
  signal?: AbortSignal,
  assertCurrent: () => void = () => undefined,
): Promise<AdoptedImageDocumentForRender> {
  assertCurrent()
  const dependencies = expectedDependencies(document)
  const canonical = serializeImageDocument(document)
  const bytes = new TextEncoder().encode(canonical)
  const digest = imageDocumentDigest(bytes)
  const uploaded = new Set<string>()
  for (const resource of Object.values(document.resources)) {
    if (resource.inline !== undefined || uploaded.has(resource.digest)) continue
    await uploadImageDocumentResource(connection, store, resource, scope, signal, assertCurrent)
    assertCurrent()
    uploaded.add(resource.digest)
  }
  assertCurrent()
  const adopted = await connection.adoptImageDocument(bytes, {
    scope,
    expectedDigest: digest,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (adopted.digest !== digest || adopted.mediaType !== IMAGE_DOCUMENT_MEDIA_TYPE ||
    adopted.byteSize !== bytes.byteLength || !manifestMatches(adopted.dependencies, dependencies)) {
    throw new Error('server returned a mismatched ImageDocument dependency manifest')
  }
  return { document, digest }
}

export async function adoptImageDocumentForRender(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  document: ImageDocument,
  scope: string,
  signal?: AbortSignal,
  assertCurrent: () => void = () => undefined,
): Promise<AdoptedImageDocumentForRender> {
  const loaded = loadImageDocument(document)
  if (loaded.document === undefined) throw new Error('cannot render an invalid ImageDocument')
  return adoptOwnedImageDocument(connection, store, loaded.document, scope, signal, assertCurrent)
}

export async function saveImageDocumentToLibrary(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  document: ImageDocument,
  options: {
    readonly scope: string
    readonly connectionId: string
    readonly name: string
    readonly labels?: readonly string[]
    readonly folder?: string
    readonly link?: ImageLibraryLink
    readonly signal?: AbortSignal
    readonly assertCurrent?: () => void
  },
): Promise<SavedImageDocument> {
  const assertCurrent = options.assertCurrent ?? (() => undefined)
  assertCurrent()
  const loaded = loadImageDocument(document)
  if (loaded.document === undefined) throw new Error('cannot save an invalid ImageDocument')
  const owned = loaded.document
  const existingDraft = await store.recoverDraft(owned.lineage)
  assertCurrent()
  let expectedDraftUpdatedAt = existingDraft?.updatedAt ?? null
  let link = existingDraft?.library ?? options.link
  if (link?.connectionId === options.connectionId && link.scope === options.scope) {
    link = await reconcilePendingLink(connection, link)
    assertCurrent()
  }
  const canonical = serializeImageDocument(owned)
  const bytes = new TextEncoder().encode(canonical)
  const digest = imageDocumentDigest(bytes)
  if (link?.connectionId === options.connectionId && link.scope === options.scope) {
    const pendingDraft = await store.linkDraft(owned, options.name, {
      ...link,
      pendingDigest: digest,
    }, expectedDraftUpdatedAt, assertCurrent)
    assertCurrent()
    if (serializeImageDocument(pendingDraft.document) !== canonical || pendingDraft.name !== options.name) {
      throw new Error('ImageDocument draft changed concurrently')
    }
    expectedDraftUpdatedAt = pendingDraft.updatedAt
  }
  await adoptOwnedImageDocument(connection, store, owned, options.scope, options.signal, assertCurrent)
  assertCurrent()
  const record = await publishLibraryRecord(connection, {
    scope: options.scope,
    connectionId: options.connectionId,
    name: options.name,
    digest,
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
    ...(options.folder !== undefined ? { folder: options.folder } : {}),
    ...(link !== undefined ? { link } : {}),
  }, assertCurrent)
  assertCurrent()
  if (record.scope !== options.scope || record.digest !== digest ||
    mediaTypeBase(record.mediaType) !== IMAGE_DOCUMENT_MEDIA_TYPE) {
    throw new Error('server returned a mismatched ImageDocument library record')
  }
  const draft = await store.linkDraft(owned, options.name, {
    recordId: record.id,
    revision: record.revision,
    digest,
    scope: options.scope,
    connectionId: options.connectionId,
  }, expectedDraftUpdatedAt, assertCurrent)
  return { document: owned, digest, record, draft }
}

export async function openImageDocumentFromLibrary(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  recordId: string,
  scope: string,
  connectionId: string,
  assertCurrent: () => void = () => undefined,
): Promise<ImageDocumentDraft | undefined> {
  assertCurrent()
  const record = await connection.getLibraryRecord(recordId, scope)
  assertCurrent()
  if (record === undefined) return undefined
  if (record.scope !== scope || mediaTypeBase(record.mediaType) !== IMAGE_DOCUMENT_MEDIA_TYPE) {
    throw new Error('library record is not an ImageDocument')
  }
  const text = await withImageResourceRead(connection, store, scope, [record.digest], () => {
    assertCurrent()
    return connection.fetchAssetText(record.digest)
  })
  assertCurrent()
  if (text === undefined) throw new Error('ImageDocument bytes are not held by the server')
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > MAX_IMAGE_DOCUMENT_BYTES) {
    throw new Error('library ImageDocument exceeds the maximum document size')
  }
  if (imageDocumentDigest(bytes) !== record.digest) {
    throw new Error('ImageDocument bytes do not match the library record digest')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error('library ImageDocument is not valid JSON', { cause: error })
  }
  const loaded = loadImageDocument(parsed)
  if (loaded.document === undefined || canonicalJson(parsed) !== text) {
    throw new Error('library ImageDocument is invalid or non-canonical')
  }
  const dependencies = await connection.fetchImageDocumentDependencies(record.digest)
  assertCurrent()
  const expected = expectedDependencies(loaded.document)
  if (dependencies === undefined || !manifestMatches(dependencies, expected)) {
    throw new Error('ImageDocument dependency manifest does not match its document')
  }
  const existingDraft = await store.recoverDraft(loaded.document.lineage)
  assertCurrent()
  if (existingDraft !== undefined) {
    if (serializeImageDocument(existingDraft.document) !== serializeImageDocument(loaded.document)) {
      throw new Error('local ImageDocument draft has unsaved changes')
    }
    if (existingDraft.library !== undefined &&
      (existingDraft.library.recordId !== record.id || existingDraft.library.scope !== scope ||
        existingDraft.library.connectionId !== connectionId)) {
      throw new Error('local ImageDocument draft belongs to another library record')
    }
  }
  await hydrateImageDocumentResources(connection, store, loaded.document, scope, assertCurrent)
  assertCurrent()
  return store.saveDraft(loaded.document, record.name, {
    recordId: record.id,
    revision: record.revision,
    digest: record.digest,
    scope,
    connectionId,
  }, existingDraft?.updatedAt ?? null)
}
