import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { uuidv4 } from '@dinkster/client'
import {
  IMAGE_DOCUMENT_FORMAT_VERSION,
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OPACITY_MAX,
  MAX_IMAGE_CANVAS_DIMENSION,
  MAX_IMAGE_PIXELS,
  asImageLayerId,
  asImageLineageId,
  asImageResourceId,
  canonicalJson,
  loadImageDocument,
  serializeImageDocument,
  type ImageDocument,
  type ImageRasterResource,
} from '@dinkster/core'
import { encodePng, type ImageRaster } from './image-png.js'

const DATABASE_NAME = 'dinkster.image-documents'
const DATABASE_VERSION = 1
const RESOURCES = 'resources'
const DRAFTS = 'drafts'
const BY_PROJECT = 'byProject'

export interface StagedImageResource {
  readonly digest: string
  readonly bytes: Uint8Array
  readonly name: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly width: number
  readonly height: number
  readonly colorSpace: 'srgb'
  readonly channelDepth: 8
  readonly alphaMode: 'straight' | 'premultiplied' | 'opaque'
}

export interface ImageLibraryLink {
  readonly recordId: string
  readonly revision: number
  readonly digest: string
  readonly pendingDigest?: string
  readonly scope: string
  readonly connectionId: string
}

export interface ImageCollaborationLink {
  readonly sessionId: string
  readonly baseUrl: string
}

export interface ImageDocumentDraft {
  readonly document: ImageDocument
  readonly name: string
  readonly updatedAt: number
  readonly library?: ImageLibraryLink
  readonly collaboration?: ImageCollaborationLink
}

interface ResourceRecord extends StagedImageResource {
  readonly key: string
  readonly projectId: string
}

interface DraftRecord {
  readonly key: string
  readonly projectId: string
  readonly lineage: string
  readonly canonical: string
  readonly name: string
  readonly updatedAt: number
  readonly library?: ImageLibraryLink
  readonly collaboration?: ImageCollaborationLink
}

export function imageDocumentDigest(bytes: Uint8Array): `blake3:${string}` {
  return `blake3:${bytesToHex(blake3(bytes))}`
}

function resourceKey(projectId: string, digest: string): string {
  return `${projectId}\u0000${digest}`
}

function draftKey(projectId: string, lineage: string): string {
  return `${projectId}\u0000${lineage}`
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    const transaction = request.transaction!
    const resources = database.objectStoreNames.contains(RESOURCES)
      ? transaction.objectStore(RESOURCES)
      : database.createObjectStore(RESOURCES, { keyPath: 'key' })
    if (!resources.indexNames.contains(BY_PROJECT)) resources.createIndex(BY_PROJECT, 'projectId')
    const drafts = database.objectStoreNames.contains(DRAFTS)
      ? transaction.objectStore(DRAFTS)
      : database.createObjectStore(DRAFTS, { keyPath: 'key' })
    if (!drafts.indexNames.contains(BY_PROJECT)) drafts.createIndex(BY_PROJECT, 'projectId')
  }
  return requestResult(request).then((database) => {
    database.onversionchange = () => database.close()
    return database
  })
}

function sameResource(record: ResourceRecord, resource: ImageRasterResource): boolean {
  return record.digest === resource.digest && record.bytes.byteLength === resource.byteSize &&
    record.mediaType === resource.mediaType && record.width === resource.width &&
    record.height === resource.height && record.colorSpace === resource.colorSpace &&
    record.channelDepth === resource.channelDepth
}

function stagedResource(record: ResourceRecord): StagedImageResource {
  return {
    digest: record.digest,
    bytes: new Uint8Array(record.bytes),
    name: record.name,
    mediaType: record.mediaType,
    width: record.width,
    height: record.height,
    colorSpace: record.colorSpace,
    channelDepth: record.channelDepth,
    alphaMode: record.alphaMode,
  }
}

function validLibraryLink(value: unknown): value is ImageLibraryLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const link = value as Record<string, unknown>
  return typeof link['recordId'] === 'string' && link['recordId'] !== '' &&
    typeof link['revision'] === 'number' && Number.isSafeInteger(link['revision']) && link['revision'] >= 1 &&
    typeof link['digest'] === 'string' && /^blake3:[0-9a-f]{64}$/.test(link['digest']) &&
    (link['pendingDigest'] === undefined ||
      (typeof link['pendingDigest'] === 'string' && /^blake3:[0-9a-f]{64}$/.test(link['pendingDigest']))) &&
    typeof link['scope'] === 'string' && link['scope'] !== '' &&
    typeof link['connectionId'] === 'string' && link['connectionId'] !== ''
}

function validCollaborationLink(value: unknown): value is ImageCollaborationLink {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const link = value as Record<string, unknown>
  return typeof link['sessionId'] === 'string' && link['sessionId'] !== '' &&
    typeof link['baseUrl'] === 'string'
}

function parseDraft(record: DraftRecord): ImageDocumentDraft | undefined {
  try {
    if (typeof record.name !== 'string' || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
      return undefined
    }
    if (record.library !== undefined && !validLibraryLink(record.library)) return undefined
    if (record.collaboration !== undefined && !validCollaborationLink(record.collaboration)) return undefined
    const parsed: unknown = JSON.parse(record.canonical)
    const loaded = loadImageDocument(parsed)
    if (loaded.document === undefined || loaded.document.lineage !== record.lineage ||
      canonicalJson(parsed) !== record.canonical) return undefined
    return {
      document: loaded.document,
      name: record.name,
      updatedAt: record.updatedAt,
      ...(record.library !== undefined ? { library: record.library } : {}),
      ...(record.collaboration !== undefined ? { collaboration: record.collaboration } : {}),
    }
  } catch {
    return undefined
  }
}

export class ImageDocumentLocalStore {
  private readonly database: Promise<IDBDatabase>

  constructor(
    readonly projectId: string,
    factory: IDBFactory = globalThis.indexedDB,
  ) {
    if (projectId.length === 0 || projectId.includes('\u0000')) throw new Error('invalid project id')
    if (factory === undefined) throw new Error('IndexedDB is unavailable')
    this.database = openDatabase(factory)
  }

  async close(): Promise<void> {
    const database = await this.database
    database.close()
  }

  async stageResource(
    resource: ImageRasterResource,
    bytes: Uint8Array,
    name: string,
  ): Promise<StagedImageResource> {
    if (bytes.byteLength !== resource.byteSize || imageDocumentDigest(bytes) !== resource.digest) {
      throw new Error('staged resource bytes do not match their descriptor')
    }
    const copy = Uint8Array.from(bytes)
    const database = await this.database
    const transaction = database.transaction(RESOURCES, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(RESOURCES)
    const key = resourceKey(this.projectId, resource.digest)
    const existing = await requestResult(store.get(key) as IDBRequest<ResourceRecord | undefined>)
    if (existing !== undefined) {
      if (!sameResource(existing, resource)) {
        transaction.abort()
        await done.catch(() => undefined)
        throw new Error('staged resource descriptor conflicts with immutable bytes')
      }
      await done
      return stagedResource(existing)
    }
    const record: ResourceRecord = {
      key,
      projectId: this.projectId,
      digest: resource.digest,
      bytes: copy,
      name,
      mediaType: resource.mediaType,
      width: resource.width,
      height: resource.height,
      colorSpace: resource.colorSpace,
      channelDepth: resource.channelDepth,
      alphaMode: resource.alphaMode,
    }
    store.add(record)
    await done
    return stagedResource(record)
  }

  async getResource(digest: string): Promise<StagedImageResource | undefined> {
    const database = await this.database
    const transaction = database.transaction(RESOURCES, 'readonly')
    const done = transactionDone(transaction)
    const record = await requestResult(
      transaction.objectStore(RESOURCES).get(resourceKey(this.projectId, digest)) as
        IDBRequest<ResourceRecord | undefined>,
    )
    await done
    return record === undefined ? undefined : stagedResource(record)
  }

  async saveDraft(
    document: ImageDocument,
    name: string,
    library?: ImageLibraryLink,
    expectedUpdatedAt?: number | null,
  ): Promise<ImageDocumentDraft> {
    const loaded = loadImageDocument(document)
    if (loaded.document === undefined) throw new Error('cannot persist an invalid ImageDocument draft')
    const canonical = serializeImageDocument(loaded.document)
    const key = draftKey(this.projectId, loaded.document.lineage)
    const database = await this.database
    const transaction = database.transaction(DRAFTS, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(DRAFTS)
    const existing = await requestResult(store.get(key) as IDBRequest<DraftRecord | undefined>)
    if (expectedUpdatedAt !== undefined) {
      const matches = expectedUpdatedAt === null
        ? existing === undefined || parseDraft(existing) === undefined
        : existing?.updatedAt === expectedUpdatedAt
      if (!matches) {
        transaction.abort()
        await done.catch(() => undefined)
        throw new Error('ImageDocument draft changed concurrently')
      }
    }
    const previousUpdatedAt = Number.isSafeInteger(existing?.updatedAt) &&
      existing!.updatedAt < Number.MAX_SAFE_INTEGER ? existing!.updatedAt : -1
    const updatedAt = Math.max(Date.now(), previousUpdatedAt + 1)
    const nextLibrary = library ??
      (existing?.library !== undefined && validLibraryLink(existing.library) ? existing.library : undefined)
    const collaboration = existing?.collaboration !== undefined && validCollaborationLink(existing.collaboration)
      ? existing.collaboration
      : undefined
    const record: DraftRecord = {
      key,
      projectId: this.projectId,
      lineage: loaded.document.lineage,
      canonical,
      name,
      updatedAt,
      ...(nextLibrary !== undefined ? { library: nextLibrary } : {}),
      ...(collaboration !== undefined ? { collaboration } : {}),
    }
    store.put(record)
    await done
    return {
      document: loaded.document,
      name,
      updatedAt,
      ...(nextLibrary !== undefined ? { library: nextLibrary } : {}),
      ...(collaboration !== undefined ? { collaboration } : {}),
    }
  }

  async linkDraft(
    document: ImageDocument,
    name: string,
    library: ImageLibraryLink,
    expectedUpdatedAt: number | null,
  ): Promise<ImageDocumentDraft> {
    const loaded = loadImageDocument(document)
    if (loaded.document === undefined || !validLibraryLink(library)) {
      throw new Error('cannot link an invalid ImageDocument draft')
    }
    const key = draftKey(this.projectId, loaded.document.lineage)
    const database = await this.database
    const transaction = database.transaction(DRAFTS, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(DRAFTS)
    const existing = await requestResult(store.get(key) as IDBRequest<DraftRecord | undefined>)
    const existingDraft = existing === undefined ? undefined : parseDraft(existing)
    const preserveCurrent = existingDraft !== undefined && existing?.updatedAt !== expectedUpdatedAt
    const current = preserveCurrent ? existingDraft : { document: loaded.document, name }
    const previousUpdatedAt = Number.isSafeInteger(existing?.updatedAt) &&
      existing!.updatedAt < Number.MAX_SAFE_INTEGER ? existing!.updatedAt : -1
    const updatedAt = Math.max(Date.now(), previousUpdatedAt + 1)
    const record: DraftRecord = {
      key,
      projectId: this.projectId,
      lineage: loaded.document.lineage,
      canonical: serializeImageDocument(current.document),
      name: current.name,
      updatedAt,
      library,
      ...(existingDraft?.collaboration !== undefined
        ? { collaboration: existingDraft.collaboration }
        : {}),
    }
    store.put(record)
    await done
    return {
      document: current.document,
      name: current.name,
      updatedAt,
      library,
      ...(existingDraft?.collaboration !== undefined
        ? { collaboration: existingDraft.collaboration }
        : {}),
    }
  }

  async setCollaboration(
    lineage: string,
    collaboration: ImageCollaborationLink | undefined,
  ): Promise<ImageDocumentDraft> {
    if (collaboration !== undefined && !validCollaborationLink(collaboration)) {
      throw new Error('invalid ImageDocument collaboration membership')
    }
    const database = await this.database
    const transaction = database.transaction(DRAFTS, 'readwrite')
    const done = transactionDone(transaction)
    const records = transaction.objectStore(DRAFTS)
    const key = draftKey(this.projectId, lineage)
    const existing = await requestResult(records.get(key) as IDBRequest<DraftRecord | undefined>)
    const current = existing === undefined ? undefined : parseDraft(existing)
    if (current === undefined) {
      transaction.abort()
      await done.catch(() => undefined)
      throw new Error('ImageDocument draft does not exist')
    }
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1)
    const record: DraftRecord = {
      key,
      projectId: this.projectId,
      lineage,
      canonical: serializeImageDocument(current.document),
      name: current.name,
      updatedAt,
      ...(current.library !== undefined ? { library: current.library } : {}),
      ...(collaboration !== undefined ? { collaboration } : {}),
    }
    records.put(record)
    await done
    const { collaboration: _oldCollaboration, ...withoutCollaboration } = current
    return {
      ...withoutCollaboration,
      updatedAt,
      ...(collaboration !== undefined ? { collaboration } : {}),
    }
  }

  async recoverDraft(lineage: string): Promise<ImageDocumentDraft | undefined> {
    const database = await this.database
    const transaction = database.transaction(DRAFTS, 'readonly')
    const done = transactionDone(transaction)
    const record = await requestResult(
      transaction.objectStore(DRAFTS).get(draftKey(this.projectId, lineage)) as
        IDBRequest<DraftRecord | undefined>,
    )
    await done
    return record === undefined ? undefined : parseDraft(record)
  }

  async recoverDrafts(): Promise<{
    readonly drafts: readonly ImageDocumentDraft[]
    readonly rejectedLineages: readonly string[]
  }> {
    const database = await this.database
    const transaction = database.transaction(DRAFTS, 'readonly')
    const done = transactionDone(transaction)
    const records = await requestResult(
      transaction.objectStore(DRAFTS).index(BY_PROJECT).getAll(this.projectId) as
        IDBRequest<DraftRecord[]>,
    )
    await done
    const drafts: ImageDocumentDraft[] = []
    const rejectedLineages: string[] = []
    for (const record of records) {
      const draft = parseDraft(record)
      if (draft === undefined) rejectedLineages.push(record.lineage)
      else drafts.push(draft)
    }
    drafts.sort((left, right) => left.updatedAt - right.updatedAt ||
      left.document.lineage.localeCompare(right.document.lineage))
    return { drafts, rejectedLineages }
  }

  async deleteDraft(lineage: string): Promise<void> {
    const database = await this.database
    const transaction = database.transaction(DRAFTS, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(DRAFTS).delete(draftKey(this.projectId, lineage))
    await done
  }
}

async function browserRaster(file: File): Promise<ImageRaster> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('this browser cannot decode raster images')
  }
  const bitmap = await globalThis.createImageBitmap(file, {
    colorSpaceConversion: 'default',
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
  })
  try {
    const { width, height } = bitmap
    if (width < 1 || height < 1 || width > MAX_IMAGE_CANVAS_DIMENSION ||
      height > MAX_IMAGE_CANVAS_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
      throw new Error('raster dimensions exceed ImageDocument limits')
    }
    let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (typeof globalThis.OffscreenCanvas === 'function') {
      context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    } else {
      const canvas = Object.assign(document.createElement('canvas'), { width, height })
      context = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (context === null) throw new Error('2D canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    const pixels = context.getImageData(0, 0, width, height)
    return { width, height, rgba: Uint8ClampedArray.from(pixels.data) }
  } finally {
    bitmap.close()
  }
}

export interface PreparedImageRaster {
  readonly name: string
  readonly bytes: Uint8Array
  readonly resource: Omit<ImageRasterResource, 'id'>
}

export async function prepareImageRaster(
  file: File,
  normalize: (file: File) => Promise<ImageRaster> = browserRaster,
): Promise<PreparedImageRaster> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) {
    throw new Error('ImageDocument imports require PNG, JPEG, or WebP')
  }
  const raster = await normalize(file)
  if (raster.width < 1 || raster.height < 1 || raster.width > MAX_IMAGE_CANVAS_DIMENSION ||
    raster.height > MAX_IMAGE_CANVAS_DIMENSION || raster.width * raster.height > MAX_IMAGE_PIXELS ||
    raster.rgba.length !== raster.width * raster.height * 4) {
    throw new Error('normalized raster is outside ImageDocument limits')
  }
  const bytes = await encodePng(raster.width, raster.height, raster.rgba)
  const name = file.name.replace(/\.[^.]+$/, '') || 'Imported image'
  return {
    name,
    bytes,
    resource: {
      kind: 'raster',
      digest: imageDocumentDigest(bytes),
      byteSize: bytes.byteLength,
      mediaType: 'image/png',
      width: raster.width,
      height: raster.height,
      colorSpace: 'srgb',
      channelDepth: 8,
      alphaMode: 'straight',
    },
  }
}

export async function importSingleRaster(
  file: File,
  store: ImageDocumentLocalStore,
  options?: {
    readonly lineage?: string
    readonly normalize?: (file: File) => Promise<ImageRaster>
  },
): Promise<ImageDocumentDraft> {
  const prepared = await prepareImageRaster(file, options?.normalize)
  const resourceId = asImageResourceId('r0')
  const layerId = asImageLayerId('l1')
  const lineage = asImageLineageId(options?.lineage ?? `image-${uuidv4()}`)
  const resource: ImageRasterResource = {
    ...prepared.resource,
    id: resourceId,
  }
  const name = prepared.name
  const document: ImageDocument = {
    format: 'dinkster-image',
    formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION,
    lineage,
    canvas: {
      width: resource.width,
      height: resource.height,
      colorSpace: 'srgb',
      channelDepth: 8,
      compositing: 'premultiplied-alpha',
    },
    allocation: { nextOrdinal: 2 },
    rootLayerIds: [layerId],
    layers: {
      [layerId]: {
        id: layerId,
        kind: 'raster',
        name,
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: { a: IMAGE_FIXED_POINT_SCALE, b: 0, c: 0, d: IMAGE_FIXED_POINT_SCALE, tx: 0, ty: 0 },
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        resourceId,
        sourceRect: { x: 0, y: 0, width: resource.width, height: resource.height },
      },
    },
    masks: {},
    resources: { [resourceId]: resource },
  }
  await store.stageResource(resource, prepared.bytes, `${name}.png`)
  return store.saveDraft(document, name, undefined, null)
}
