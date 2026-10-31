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
  loadImageDocument,
  serializeImageDocument,
  type ImageDocument,
  type ImageRasterResource,
} from '@dinkster/core'
import {
  ImageDocumentLocalStore,
  imageDocumentDigest,
  type ImageDocumentDraft,
  type ImageLibraryLink,
  type StagedImageResource,
} from './image-document-local.js'

export const IMAGE_DOCUMENT_LIBRARY_LABEL = 'image-document'

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
): Promise<void> {
  const staged = await store.getResource(resource.digest)
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
): Promise<void> {
  const loaded = loadImageDocument(document)
  if (loaded.document === undefined) throw new Error('cannot hydrate an invalid ImageDocument')
  const resources = Object.values(loaded.document.resources)
  const missing = new Set<string>()
  for (const resource of resources) {
    const local = await store.getResource(resource.digest)
    if (local !== undefined && !stagedMatches(resource, local)) {
      throw new Error(`local ImageDocument resource does not match its descriptor: ${resource.id}`)
    }
    if (local === undefined && resource.inline === undefined) missing.add(resource.digest)
  }
  await withImageResourceRead(connection, store, scope, [...missing].sort(), async () => {
    for (const resource of resources) {
      const local = await store.getResource(resource.digest)
      if (local !== undefined) {
        if (!stagedMatches(resource, local)) {
          throw new Error(`local ImageDocument resource does not match its descriptor: ${resource.id}`)
        }
      } else {
        const fetched = resource.inline === undefined
          ? await connection.fetchAssetBytes(resource.digest)
          : Uint8Array.from(atob(resource.inline), (character) => character.charCodeAt(0))
        if (fetched === undefined) {
          throw new Error(`ImageDocument resource is not held by the server: ${resource.id}`)
        }
        await store.stageResource(
          resource,
          new Uint8Array(fetched),
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
): Promise<LibraryRecord> {
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
    const fresh = await connection.getLibraryRecord(link.recordId, options.scope)
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
): Promise<VerifiedImageDocumentRender> {
  const response = await connection.renderImageDocument(digest, {
    scope,
    selector,
    ...(signal !== undefined ? { signal } : {}),
  })
  return withImageResourceRead(connection, store, scope, [response.asset.digest], async () => {
    const fetched = await connection.fetchAssetBytes(response.asset.digest)
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
): Promise<AdoptedImageDocumentForRender> {
  const dependencies = expectedDependencies(document)
  const canonical = serializeImageDocument(document)
  const bytes = new TextEncoder().encode(canonical)
  const digest = imageDocumentDigest(bytes)
  const uploaded = new Set<string>()
  for (const resource of Object.values(document.resources)) {
    if (resource.inline !== undefined || uploaded.has(resource.digest)) continue
    await uploadImageDocumentResource(connection, store, resource, scope, signal)
    uploaded.add(resource.digest)
  }
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
): Promise<AdoptedImageDocumentForRender> {
  const loaded = loadImageDocument(document)
  if (loaded.document === undefined) throw new Error('cannot render an invalid ImageDocument')
  return adoptOwnedImageDocument(connection, store, loaded.document, scope, signal)
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
  },
): Promise<SavedImageDocument> {
  const loaded = loadImageDocument(document)
  if (loaded.document === undefined) throw new Error('cannot save an invalid ImageDocument')
  const owned = loaded.document
  const existingDraft = await store.recoverDraft(owned.lineage)
  let expectedDraftUpdatedAt = existingDraft?.updatedAt ?? null
  let link = existingDraft?.library ?? options.link
  if (link?.connectionId === options.connectionId && link.scope === options.scope) {
    link = await reconcilePendingLink(connection, link)
  }
  const canonical = serializeImageDocument(owned)
  const bytes = new TextEncoder().encode(canonical)
  const digest = imageDocumentDigest(bytes)
  if (link?.connectionId === options.connectionId && link.scope === options.scope) {
    const pendingDraft = await store.linkDraft(owned, options.name, {
      ...link,
      pendingDigest: digest,
    }, expectedDraftUpdatedAt)
    if (serializeImageDocument(pendingDraft.document) !== canonical || pendingDraft.name !== options.name) {
      throw new Error('ImageDocument draft changed concurrently')
    }
    expectedDraftUpdatedAt = pendingDraft.updatedAt
  }
  await adoptOwnedImageDocument(connection, store, owned, options.scope, options.signal)
  const record = await publishLibraryRecord(connection, {
    scope: options.scope,
    connectionId: options.connectionId,
    name: options.name,
    digest,
    ...(options.labels !== undefined ? { labels: options.labels } : {}),
    ...(options.folder !== undefined ? { folder: options.folder } : {}),
    ...(link !== undefined ? { link } : {}),
  })
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
  }, expectedDraftUpdatedAt)
  return { document: owned, digest, record, draft }
}

export async function openImageDocumentFromLibrary(
  connection: DinksterConnection,
  store: ImageDocumentLocalStore,
  recordId: string,
  scope: string,
  connectionId: string,
): Promise<ImageDocumentDraft | undefined> {
  const record = await connection.getLibraryRecord(recordId, scope)
  if (record === undefined) return undefined
  if (record.scope !== scope || mediaTypeBase(record.mediaType) !== IMAGE_DOCUMENT_MEDIA_TYPE) {
    throw new Error('library record is not an ImageDocument')
  }
  const text = await connection.fetchAssetText(record.digest)
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
  const expected = expectedDependencies(loaded.document)
  if (dependencies === undefined || !manifestMatches(dependencies, expected)) {
    throw new Error('ImageDocument dependency manifest does not match its document')
  }
  const existingDraft = await store.recoverDraft(loaded.document.lineage)
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
  await hydrateImageDocumentResources(connection, store, loaded.document, scope)
  return store.saveDraft(loaded.document, record.name, {
    recordId: record.id,
    revision: record.revision,
    digest: record.digest,
    scope,
    connectionId,
  }, existingDraft?.updatedAt ?? null)
}
