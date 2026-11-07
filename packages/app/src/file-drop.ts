import { defaultValuesOf, type AssetRef, type CommandInvocation, type Json, type JsonObject, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
import { readLatentMetadata, type LatentMetadata } from './latent-metadata.js'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_LATENT_FILE_BYTES = 1024 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_PNG_CHUNKS = 512
const MAX_PNG_CHUNK_BYTES = 16 * 1024 * 1024
const MAX_WORKFLOW_BYTES = 1024 * 1024
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

export type FileDropClassification =
  | { readonly kind: 'workflow'; readonly document: unknown }
  | { readonly kind: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; readonly embeddedWorkflow?: unknown; readonly embeddedPrompt?: JsonObject }
  | { readonly kind: 'latent'; readonly metadata: LatentMetadata }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }

const rejected = (code: string, message: string): FileDropClassification => ({ kind: 'rejected', code, message })

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value)

const decodeJson = (bytes: Uint8Array): unknown => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(text) as unknown
}

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) !== 0 ? 0xedb88320 : 0)
  CRC32_TABLE[index] = value >>> 0
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Synchronous one-shot gate for mutually exclusive embedded-PNG actions. */
export function singleUseFileDropChoice(clear: () => void): { readonly run: (action: () => void) => boolean } {
  let consumed = false
  return {
    run: (action) => {
      if (consumed) return false
      consumed = true
      clear()
      action()
      return true
    },
  }
}

/** One lock gate shared by the CanvasHost drop entry and its focused tests. */
export function startCanvasFileDrop(locked: boolean, start: () => void): boolean {
  if (locked) return false
  start()
  return true
}

/** Cancel a pending drop as soon as its graph is deleted or navigated away from. */
export function watchFileDropGraphOwner(p: {
  readonly graphId: string
  readonly document: { readonly subscribe: (listener: (document: WorkflowDocument) => void) => () => void }
  readonly graphStack: { readonly subscribe: (listener: (stack: readonly string[]) => void) => () => void }
  readonly cancel: () => void
  readonly onRetired: () => void
}): () => void {
  let live = true
  const cancel = (retired: boolean): void => {
    if (!live) return
    live = false
    if (retired) p.onRetired()
    p.cancel()
  }
  const stopDocument = p.document.subscribe((document) => {
    if (document.graphs[p.graphId] === undefined) cancel(true)
  })
  const stopStack = p.graphStack.subscribe((stack) => {
    if (stack.at(-1) !== p.graphId) cancel(false)
  })
  return () => {
    live = false
    stopDocument()
    stopStack()
  }
}

const pngWorkflow = (bytes: Uint8Array): { readonly ok: true; readonly workflow?: unknown; readonly prompt?: JsonObject } | { readonly ok: false; readonly message: string } => {
  let offset: number = PNG_SIGNATURE.length
  let chunks = 0
  let workflow: unknown | undefined
  let prompt: JsonObject | undefined
  let sawHeader = false
  let sawImageData = false
  while (offset < bytes.length) {
    if (++chunks > MAX_PNG_CHUNKS) return { ok: false, message: 'PNG contains too many chunks' }
    if (offset + 12 > bytes.length) return { ok: false, message: 'PNG has a truncated chunk header' }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4)
    const length = view.getUint32(0)
    if (length > MAX_PNG_CHUNK_BYTES) return { ok: false, message: 'PNG chunk exceeds the safe size limit' }
    const end = offset + 12 + length
    if (end > bytes.length) return { ok: false, message: 'PNG has a truncated chunk' }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + offset + 8 + length, 4).getUint32(0)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return { ok: false, message: 'PNG chunk checksum is invalid' }
    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) return { ok: false, message: 'PNG must begin with a valid IHDR chunk' }
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const width = header.getUint32(0); const height = header.getUint32(4); const depth = data[8]!; const color = data[9]!
      const validDepth = (color === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
        (color === 2 && [8, 16].includes(depth)) || (color === 3 && [1, 2, 4, 8].includes(depth)) ||
        ((color === 4 || color === 6) && [8, 16].includes(depth))
      if (width === 0 || height === 0 || width > 32_768 || height > 32_768 || width * height > 100_000_000 ||
          !validDepth || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) {
        return { ok: false, message: 'PNG IHDR fields are invalid' }
      }
      sawHeader = true
    } else if (type === 'IHDR') return { ok: false, message: 'PNG contains more than one IHDR chunk' }
    if (type === 'IDAT') sawImageData = true
    let workflowBytes: Uint8Array | undefined
    let keyword: string | undefined
    if (type === 'tEXt') {
      const separator = data.indexOf(0)
      keyword = separator < 0 ? undefined : new TextDecoder().decode(data.subarray(0, separator))
      if (keyword === 'workflow' || keyword === 'prompt') {
        workflowBytes = data.subarray(separator + 1)
      }
    } else if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0)
      keyword = keywordEnd < 0 ? undefined : new TextDecoder().decode(data.subarray(0, keywordEnd))
      if (keyword === 'workflow' || keyword === 'prompt') {
        if (keywordEnd + 3 > data.length) return { ok: false, message: 'PNG workflow text is malformed' }
        const compressed = data[keywordEnd + 1]
        const compressionMethod = data[keywordEnd + 2]
        let cursor = keywordEnd + 3
        const languageEnd = data.indexOf(0, cursor)
        if (compressed !== 0 || compressionMethod !== 0 || languageEnd < 0) return { ok: false, message: 'PNG workflow text is compressed or malformed' }
        const language = data.subarray(cursor, languageEnd)
        if (![...language].every((byte) => byte === 0x2d || byte >= 0x30 && byte <= 0x39 || byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a)) {
          return { ok: false, message: 'PNG workflow language tag is malformed' }
        }
        cursor = languageEnd + 1
        const translatedEnd = data.indexOf(0, cursor)
        if (translatedEnd < 0) return { ok: false, message: 'PNG workflow text is malformed' }
        try { new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(cursor, translatedEnd)) }
        catch { return { ok: false, message: 'PNG workflow translated keyword is malformed' } }
        workflowBytes = data.subarray(translatedEnd + 1)
      }
    }
    if (workflowBytes !== undefined) {
      if (workflowBytes.byteLength > MAX_WORKFLOW_BYTES) return { ok: false, message: `PNG ${keyword} text exceeds the safe size limit` }
      if (keyword === 'workflow' ? workflow !== undefined : prompt !== undefined) return { ok: false, message: `PNG contains more than one ${keyword} text entry` }
      try {
        const decoded = decodeJson(workflowBytes)
        if (keyword === 'workflow') workflow = decoded
        else {
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return { ok: false, message: 'PNG prompt must be a JSON object' }
          prompt = decoded as JsonObject
        }
      } catch {
        return { ok: false, message: `PNG ${keyword} text is not valid UTF-8 JSON` }
      }
    }
    offset = end
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length || !sawHeader || !sawImageData) return { ok: false, message: 'PNG has an invalid IEND or no image data' }
      return { ok: true, ...(workflow !== undefined ? { workflow } : {}), ...(prompt !== undefined ? { prompt } : {}) }
    }
  }
  return { ok: false, message: 'PNG is missing its IEND chunk' }
}

interface Classifier {
  readonly classify: (bytes: Uint8Array) => FileDropClassification | undefined
}

/** Ordered, data-only ingress registry. Entries classify bytes and never dispatch plugin code. */
const CLASSIFIERS: readonly Classifier[] = [
  {
    classify: (bytes) => {
      let first = 0
      while (first < bytes.length && [9, 10, 13, 32].includes(bytes[first]!)) first += 1
      if (bytes[first] !== 0x7b && bytes[first] !== 0x5b) return undefined
      if (bytes.byteLength > MAX_JSON_BYTES) return rejected('fileDrop.jsonTooLarge', 'Workflow JSON exceeds the safe size limit')
      try { return { kind: 'workflow', document: decodeJson(bytes) } }
      catch { return rejected('fileDrop.invalidJson', 'Dropped workflow is not valid UTF-8 JSON') }
    },
  },
  {
    classify: (bytes) => {
      if (!startsWith(bytes, PNG_SIGNATURE)) return undefined
      const metadata = pngWorkflow(bytes)
      return metadata.ok
        ? { kind: 'image', mediaType: 'image/png', ...(metadata.workflow !== undefined ? { embeddedWorkflow: metadata.workflow } : {}), ...(metadata.prompt !== undefined ? { embeddedPrompt: metadata.prompt } : {}) }
        : rejected('fileDrop.invalidPngMetadata', metadata.message)
    },
  },
  { classify: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) ? { kind: 'image', mediaType: 'image/jpeg' } : undefined },
  { classify: (bytes) => startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]) ? { kind: 'image', mediaType: 'image/webp' } : undefined },
]

export async function classifyDroppedFile(file: Pick<File, 'name' | 'size' | 'slice' | 'arrayBuffer'>): Promise<FileDropClassification> {
  if (/\.(?:latent|safetensors)$/i.test(file.name)) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_LATENT_FILE_BYTES) {
      return rejected('fileDrop.invalidLatentSize', 'Dropped latent is empty or exceeds the safe size limit')
    }
    const result = await readLatentMetadata(file)
    return result.ok
      ? { kind: 'latent', metadata: result.metadata }
      : rejected('fileDrop.invalidLatent', result.message)
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
    return rejected('fileDrop.invalidSize', 'Dropped file is empty or exceeds the safe size limit')
  }
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) }
  catch { return rejected('fileDrop.readFailed', 'Dropped file could not be read') }
  for (const classifier of CLASSIFIERS) {
    const result = classifier.classify(bytes)
    if (result !== undefined) return result
  }
  return rejected('fileDrop.unsupported', 'Unsupported dropped file type')
}

export type ImageInsertOutcome = 'inserted' | 'upload-failed' | 'invalid-asset' | 'stale-tab' | 'stale-graph' | 'frozen' | 'schema-missing' | 'rejected'
export type LatentInsertOutcome = ImageInsertOutcome

const loaderForMediaType = (
  schemas: Iterable<NodeSchema>,
  mediaType: string,
): { readonly schema: NodeSchema; readonly input: Extract<NodeSchema['items'][number], { kind: 'input' }> } | undefined => {
  const wildcard = `${mediaType.slice(0, mediaType.indexOf('/'))}/*`
  let fallback: { readonly schema: NodeSchema; readonly input: Extract<NodeSchema['items'][number], { kind: 'input' }> } | undefined
  for (const schema of schemas) {
    const matching = schema.items.filter((item): item is Extract<NodeSchema['items'][number], { kind: 'input' }> => {
      if (item.kind !== 'input' || item.hidden === true || item.widget?.widgetType !== 'ASSET') return false
      const accept = item.widget.options['accept']
      return Array.isArray(accept) && accept.every((value) => typeof value === 'string') &&
        (accept.includes(mediaType) || accept.includes(wildcard) || accept.includes('*/*'))
    })
    if (matching.length !== 1) continue
    const candidate = { schema, input: matching[0]! }
    const accept = matching[0]!.widget!.options['accept'] as readonly string[]
    if (accept.includes(mediaType)) return candidate
    fallback ??= candidate
  }
  return fallback
}

/** Upload and atomically insert a catalog loader for the image MIME type. */
export async function insertDroppedImage(p: {
  readonly file: File
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly graphId: string
  readonly position: { readonly x: number; readonly y: number }
  readonly tabStillOpen: () => boolean
  readonly graphStillOwned: () => boolean
  readonly currentGraphId: () => string
  readonly frozen: () => boolean
  readonly document: () => WorkflowDocument
  readonly schemas: () => Iterable<NodeSchema> | undefined
  readonly predictedNodeId: () => string | undefined
  readonly upload: (body: File) => Promise<AssetRef>
  readonly dispatch: (invocation: CommandInvocation) => boolean
  readonly onInserted: (nodeId: string) => void
}): Promise<ImageInsertOutcome> {
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId || p.document().graphs[p.graphId] === undefined) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  let asset: AssetRef
  try { asset = await p.upload(p.file) }
  catch { return 'upload-failed' }
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId || p.document().graphs[p.graphId] === undefined) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  if (!/^blake3:[0-9a-f]{64}$/.test(asset.digest) || asset.name === '' ||
    !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.mediaType !== p.mediaType ||
    typeof asset.virtualPath !== 'string') return 'invalid-asset'
  const schemas = p.schemas()
  const loader = schemas === undefined ? undefined : loaderForMediaType(schemas, p.mediaType)
  if (loader === undefined) return 'schema-missing'
  const { schema, input: assetInput } = loader
  const nodeId = p.predictedNodeId()
  if (nodeId === undefined) return 'stale-graph'
  const values = { ...(defaultValuesOf(schema) as Record<string, Json>), [assetInput.id]: asset as unknown as Json }
  const invocation: CommandInvocation = {
    command: 'batch',
    params: { invocations: [{ command: 'node.add', params: { graphId: p.graphId, type: schema.type, position: p.position, values } }] } as unknown as Json,
  }
  if (!p.dispatch(invocation)) return 'rejected'
  p.onInserted(nodeId)
  return 'inserted'
}

const validLatentAsset = (asset: AssetRef): boolean =>
  /^blake3:[0-9a-f]{64}$/.test(asset.digest) && asset.name !== '' &&
  Number.isSafeInteger(asset.size) && asset.size >= 0 &&
  asset.mediaType === 'application/x-comfy-latent' && typeof asset.virtualPath === 'string'

/** Upload and atomically insert a catalog loader for the latent MIME type. */
export async function insertDroppedLatent(p: {
  readonly file: File
  readonly graphId: string
  readonly position: { readonly x: number; readonly y: number }
  readonly tabStillOpen: () => boolean
  readonly graphStillOwned: () => boolean
  readonly currentGraphId: () => string
  readonly frozen: () => boolean
  readonly document: () => WorkflowDocument
  readonly schemas: () => Iterable<NodeSchema> | undefined
  readonly predictedNodeId: () => string | undefined
  readonly upload: (file: File) => Promise<AssetRef>
  readonly dispatch: (invocation: CommandInvocation) => boolean
  readonly onInserted: (nodeId: string) => void
}): Promise<LatentInsertOutcome> {
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId || p.document().graphs[p.graphId] === undefined) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  let asset: AssetRef
  try { asset = await p.upload(p.file) }
  catch { return 'upload-failed' }
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId || p.document().graphs[p.graphId] === undefined) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  if (!validLatentAsset(asset)) return 'invalid-asset'
  const schemas = p.schemas()
  const loader = schemas === undefined ? undefined : loaderForMediaType(schemas, asset.mediaType)
  if (loader === undefined) return 'schema-missing'
  const { schema, input: assetInput } = loader
  const nodeId = p.predictedNodeId()
  if (nodeId === undefined) return 'stale-graph'
  const values = { ...(defaultValuesOf(schema) as Record<string, Json>), [assetInput.id]: asset as unknown as Json }
  const invocation: CommandInvocation = {
    command: 'batch',
    params: { invocations: [{ command: 'node.add', params: { graphId: p.graphId, type: schema.type, position: p.position, values } }] } as unknown as Json,
  }
  if (!p.dispatch(invocation)) return 'rejected'
  p.onInserted(nodeId)
  return 'inserted'
}
