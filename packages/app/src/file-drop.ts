import { defaultValuesOf, type AssetRef, type CommandInvocation, type Json, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
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
  | { readonly kind: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; readonly embeddedWorkflow?: unknown }
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

const pngWorkflow = (bytes: Uint8Array): { readonly ok: true; readonly workflow?: unknown } | { readonly ok: false; readonly message: string } => {
  let offset: number = PNG_SIGNATURE.length
  let chunks = 0
  let workflow: unknown | undefined
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
    if (type === 'tEXt') {
      const separator = data.indexOf(0)
      if (separator >= 0 && new TextDecoder().decode(data.subarray(0, separator)) === 'workflow') {
        workflowBytes = data.subarray(separator + 1)
      }
    } else if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0)
      if (keywordEnd >= 0 && new TextDecoder().decode(data.subarray(0, keywordEnd)) === 'workflow') {
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
      if (workflowBytes.byteLength > MAX_WORKFLOW_BYTES) return { ok: false, message: 'PNG workflow text exceeds the safe size limit' }
      if (workflow !== undefined) return { ok: false, message: 'PNG contains more than one workflow text entry' }
      try {
        workflow = decodeJson(workflowBytes)
      } catch {
        return { ok: false, message: 'PNG workflow text is not valid UTF-8 JSON' }
      }
    }
    offset = end
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length || !sawHeader || !sawImageData) return { ok: false, message: 'PNG has an invalid IEND or no image data' }
      return { ok: true, ...(workflow !== undefined ? { workflow } : {}) }
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
        ? { kind: 'image', mediaType: 'image/png', ...(metadata.workflow !== undefined ? { embeddedWorkflow: metadata.workflow } : {}) }
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

const imageName = (mediaType: string): string => `dropped-image.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)}`

/** Upload and atomically insert the registry-owned Load Image node into the captured graph owner. */
export async function insertDroppedImage(p: {
  readonly file: Pick<File, 'size'> & Blob
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  /** Overrides the default dropped-image asset name (e.g. for pasted images). */
  readonly assetName?: string
  readonly graphId: string
  readonly position: { readonly x: number; readonly y: number }
  readonly tabStillOpen: () => boolean
  readonly graphStillOwned: () => boolean
  readonly currentGraphId: () => string
  readonly frozen: () => boolean
  readonly document: () => WorkflowDocument
  readonly resolve: () => ((type: string) => NodeSchema | undefined) | undefined
  readonly predictedNodeId: () => string | undefined
  readonly upload: (body: Blob) => Promise<string>
  readonly dispatch: (invocation: CommandInvocation) => boolean
  readonly onInserted: (nodeId: string) => void
}): Promise<ImageInsertOutcome> {
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId || p.document().graphs[p.graphId] === undefined) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  let digest: string
  try { digest = await p.upload(p.file) }
  catch { return 'upload-failed' }
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId || p.document().graphs[p.graphId] === undefined) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  if (!/^blake3:[0-9a-f]{64}$/.test(digest)) return 'invalid-asset'
  const schema = p.resolve()?.('dinkster.load_image')
  const assetInputs = schema?.type === 'dinkster.load_image'
    ? schema.items.filter((item) => item.kind === 'input' && item.hidden !== true && item.widget?.widgetType === 'ASSET')
    : []
  const assetInput = assetInputs.length === 1 ? assetInputs[0] : undefined
  if (!schema || !assetInput) return 'schema-missing'
  const nodeId = p.predictedNodeId()
  if (nodeId === undefined) return 'stale-graph'
  const asset = { digest, name: p.assetName ?? imageName(p.mediaType), size: p.file.size, mediaType: p.mediaType, virtualPath: '' }
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

/** Upload and atomically insert the registry-owned native Load Latent node. */
export async function insertDroppedLatent(p: {
  readonly file: File
  readonly graphId: string
  readonly position: { readonly x: number; readonly y: number }
  readonly tabStillOpen: () => boolean
  readonly graphStillOwned: () => boolean
  readonly currentGraphId: () => string
  readonly frozen: () => boolean
  readonly document: () => WorkflowDocument
  readonly resolve: () => ((type: string) => NodeSchema | undefined) | undefined
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
  const schema = p.resolve()?.('dinkster.load_latent')
  const assetInputs = schema?.type === 'dinkster.load_latent'
    ? schema.items.filter((item) => item.kind === 'input' && item.hidden !== true && item.widget?.widgetType === 'ASSET' &&
      item.widget.kind === 'data/latent' &&
      item.type.kind === 'asset' && item.type.element.kind === 'concrete' && item.type.element.name === 'comfy.LATENT')
    : []
  const assetInput = assetInputs.length === 1 ? assetInputs[0] : undefined
  if (!schema || !assetInput) return 'schema-missing'
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
