const MAX_HEADER_BYTES = 4 * 1024 * 1024
const MAX_DATA_BYTES = 1024 * 1024 * 1024
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024
const MAX_PROMPT_BYTES = 1024 * 1024
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_VAE_HINT_BYTES = 8 * 1024

const RETAINED_LIMITS: Readonly<Record<string, number>> = {
  workflow: MAX_WORKFLOW_BYTES,
  prompt: MAX_PROMPT_BYTES,
  dinkster_latent_schema: MAX_SCHEMA_BYTES,
  dinkster_vae_hint: MAX_VAE_HINT_BYTES,
}

export interface LatentMetadata {
  readonly workflow?: unknown
  readonly vaeHint?: string
  readonly latentSpace?: string
}

export type LatentMetadataResult =
  | { readonly ok: true; readonly metadata: LatentMetadata }
  | { readonly ok: false; readonly message: string }

class JsonNumberToken {
  constructor(readonly text: string) {}
}

class StrictJsonParser {
  private offset = 0

  constructor(private readonly text: string, private readonly preserveNumberTokens = false) {}

  parse(): unknown {
    const value = this.value()
    this.space()
    if (this.offset !== this.text.length) throw new Error('trailing JSON data')
    return value
  }

  private space(): void {
    while (this.offset < this.text.length && /[\t\n\r ]/.test(this.text[this.offset]!)) this.offset += 1
  }

  private value(): unknown {
    this.space()
    const token = this.text[this.offset]
    if (token === '{') return this.object()
    if (token === '[') return this.array()
    if (token === '"') return this.string()
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.text.startsWith(literal, this.offset)) { this.offset += literal.length; return value }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.offset))
    if (match === null) throw new Error('invalid JSON value')
    this.offset += match[0].length
    return this.preserveNumberTokens ? new JsonNumberToken(match[0]) : Number(match[0])
  }

  private object(): Record<string, unknown> {
    this.offset += 1
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = new Set<string>()
    this.space()
    if (this.text[this.offset] === '}') { this.offset += 1; return result }
    for (;;) {
      this.space()
      if (this.text[this.offset] !== '"') throw new Error('invalid JSON object key')
      const key = this.string()
      if (keys.has(key)) throw new Error('duplicate JSON key')
      keys.add(key)
      this.space()
      if (this.text[this.offset] !== ':') throw new Error('invalid JSON object')
      this.offset += 1
      result[key] = this.value()
      this.space()
      if (this.text[this.offset] === '}') { this.offset += 1; return result }
      if (this.text[this.offset] !== ',') throw new Error('invalid JSON object')
      this.offset += 1
    }
  }

  private array(): unknown[] {
    this.offset += 1
    const result: unknown[] = []
    this.space()
    if (this.text[this.offset] === ']') { this.offset += 1; return result }
    for (;;) {
      result.push(this.value())
      this.space()
      if (this.text[this.offset] === ']') { this.offset += 1; return result }
      if (this.text[this.offset] !== ',') throw new Error('invalid JSON array')
      this.offset += 1
    }
  }

  private string(): string {
    const start = this.offset
    this.offset += 1
    let escaped = false
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset)
      if (code < 0x20) throw new Error('invalid JSON string')
      if (!escaped && code === 0x22) {
        this.offset += 1
        return JSON.parse(this.text.slice(start, this.offset)) as string
      }
      if (!escaped && code === 0x5c) escaped = true
      else escaped = false
      this.offset += 1
    }
    throw new Error('unterminated JSON string')
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const DTYPE_BYTES: Readonly<Record<string, number>> = {
  F16: 2, BF16: 2, F32: 4, F64: 8,
}

interface TensorDescriptor {
  readonly dtype: string
  readonly shape: readonly number[]
  readonly start: number
  readonly end: number
}

const exactInteger = (value: unknown): number | undefined => {
  if (!(value instanceof JsonNumberToken) || !/^-?(?:0|[1-9]\d*)$/.test(value.text)) return undefined
  const parsed = Number(value.text)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const tensorTable = (header: Record<string, unknown>, bodyBytes: number): ReadonlyMap<string, TensorDescriptor> | undefined => {
  if (bodyBytes > MAX_DATA_BYTES) return undefined
  const ranges: Array<readonly [number, number]> = []
  const tensors = new Map<string, TensorDescriptor>()
  for (const [name, raw] of Object.entries(header)) {
    if (name === '__metadata__') continue
    if (!object(raw) || typeof raw['dtype'] !== 'string' || !Array.isArray(raw['shape']) ||
        !Array.isArray(raw['data_offsets']) || raw['data_offsets'].length !== 2 ||
        new Set(Object.keys(raw)).size !== 3 ||
        !Object.hasOwn(raw, 'dtype') || !Object.hasOwn(raw, 'shape') || !Object.hasOwn(raw, 'data_offsets')) return undefined
    const width = DTYPE_BYTES[raw['dtype']]
    const shape = raw['shape'].map(exactInteger)
    const offsets = raw['data_offsets'].map(exactInteger)
    const markerShape = name === 'latent_format_version_0' && shape.length === 1 && shape[0] === 0
    if (width === undefined || shape.length < 1 || shape.length > 8 ||
        (!markerShape && !shape.every((dim) => dim !== undefined && dim > 0)) ||
        !offsets.every((offset) => offset !== undefined && offset >= 0)) return undefined
    let elements = 1
    for (const dim of shape as number[]) {
      elements *= dim
      if (!Number.isSafeInteger(elements) || elements > MAX_DATA_BYTES) return undefined
    }
    const [start, end] = offsets as [number, number]
    if (start > end || end > bodyBytes || end - start !== elements * width) return undefined
    ranges.push([start, end])
    tensors.set(name, { dtype: raw['dtype'], shape: shape as number[], start, end })
    if (tensors.size > 64) return undefined
  }
  if (tensors.size === 0) return undefined
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let end = 0
  for (const range of ranges) {
    if (range[0] !== end) return undefined
    end = range[1]
  }
  return end === bodyBytes ? tensors : undefined
}

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const sameShape = (left: readonly number[], right: unknown): boolean =>
  Array.isArray(right) && right.length === left.length && right.every((dim, index) => dim === left[index])

const validNativeProfile = (raw: string, tensors: ReadonlyMap<string, TensorDescriptor>): boolean => {
  try {
    const schema = new StrictJsonParser(raw).parse()
    if (!object(schema) || !sameKeys(schema, ['format', 'version', 'structure', 'streams']) ||
        schema['format'] !== 'dinkster.latent' || schema['version'] !== 1 || !Array.isArray(schema['streams']) ||
        schema['streams'].length < 1 || schema['streams'].length > 64) return false
    const structure = schema['structure']
    if (structure !== 'single' && structure !== 'multi') return false
    if (structure === 'single' && schema['streams'].length !== 1) return false
    const roles = new Set<string>()
    const names = new Set<string>()
    for (let index = 0; index < schema['streams'].length; index += 1) {
      const stream = schema['streams'][index]
      if (!object(stream)) return false
      const name = structure === 'single' ? 'dinkster_samples' : `dinkster_stream_${String(index).padStart(4, '0')}`
      const keys = structure === 'single' ? ['tensor', 'dtype', 'shape'] : ['order', 'role', 'tensor', 'dtype', 'shape']
      if (!sameKeys(stream, keys) || stream['tensor'] !== name) return false
      if (structure === 'multi') {
        const role = stream['role']
        if (stream['order'] !== index || typeof role !== 'string' || role.length === 0 ||
            new TextEncoder().encode(role).byteLength > 128 || /[\u0000-\u001f\u007f]/.test(role) || roles.has(role)) return false
        roles.add(role)
      }
      const tensor = tensors.get(name)
      if (tensor === undefined || stream['dtype'] !== tensor.dtype || !sameShape(tensor.shape, stream['shape'])) return false
      names.add(name)
    }
    return tensors.size === names.size && [...tensors.keys()].every((name) => names.has(name))
  } catch {
    return false
  }
}

const validProfile = (metadata: Record<string, unknown> | undefined, tensors: ReadonlyMap<string, TensorDescriptor>): boolean => {
  const schema = metadata?.['dinkster_latent_schema']
  if (schema !== undefined) return typeof schema === 'string' && validNativeProfile(schema, tensors)
  const latent = tensors.get('latent_tensor')
  if (latent === undefined) return false
  const marker = tensors.get('latent_format_version_0')
  if (marker === undefined) return tensors.size === 1
  return tensors.size === 2 && marker.dtype === 'F32' && marker.shape.length === 1 && marker.shape[0] === 0 &&
    marker.start === latent.end && marker.end === latent.end
}

const pythonJsonString = (value: string): string => {
  let result = '"'
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (character === '"' || character === '\\') result += `\\${character}`
    else if (character === '\b') result += '\\b'
    else if (character === '\t') result += '\\t'
    else if (character === '\n') result += '\\n'
    else if (character === '\f') result += '\\f'
    else if (character === '\r') result += '\\r'
    else if (code < 0x20 || code > 0x7e) {
      if (code <= 0xffff) result += `\\u${code.toString(16).padStart(4, '0')}`
      else {
        const scalar = code - 0x10000
        result += `\\u${(0xd800 + (scalar >> 10)).toString(16)}\\u${(0xdc00 + (scalar & 0x3ff)).toString(16)}`
      }
    } else result += character
  }
  return `${result}"`
}

const canonicalHint = (hint: Record<string, unknown>): string => `{${Object.keys(hint).sort().map((key) => {
  const value = hint[key]
  return `${pythonJsonString(key)}:${typeof value === 'string' ? pythonJsonString(value) : String(value)}`
}).join(',')}}`

const displayHint = (raw: string): Pick<LatentMetadata, 'vaeHint' | 'latentSpace'> => {
  try {
    const hint = new StrictJsonParser(raw).parse()
    if (!object(hint)) return {}
    const allowed = new Set(['version', 'sourceDigest', 'sourceName', 'sourceLogicalId', 'latentSpace'])
    if (Object.keys(hint).some((key) => !allowed.has(key)) || hint['version'] !== 1 ||
        typeof hint['sourceDigest'] !== 'string' || !/^blake3:[0-9a-f]{64}$/.test(hint['sourceDigest']) ||
        raw !== canonicalHint(hint)) return {}
    const sourceName = typeof hint['sourceName'] === 'string' ? hint['sourceName'] : undefined
    const sourceLogicalId = typeof hint['sourceLogicalId'] === 'string' ? hint['sourceLogicalId'] : undefined
    const latentSpace = typeof hint['latentSpace'] === 'string' ? hint['latentSpace'] : undefined
    const encoder = new TextEncoder()
    const invalidDisplay = (value: string | undefined): boolean => value !== undefined &&
      (value.length === 0 || encoder.encode(value).byteLength > 1024 || /[\u0000-\u001f\u007f\\/]/.test(value) ||
        /\b[a-z][a-z0-9+.-]*:/i.test(value) || /(?:^|[.])\.(?:[.]|$)/.test(value))
    if (invalidDisplay(sourceName) || invalidDisplay(sourceLogicalId) ||
        (latentSpace !== undefined && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(latentSpace)) ||
        (hint['sourceName'] !== undefined && sourceName === undefined) ||
        (hint['sourceLogicalId'] !== undefined && sourceLogicalId === undefined) ||
        (hint['latentSpace'] !== undefined && latentSpace === undefined)) return {}
    return {
      ...(sourceName !== undefined ? { vaeHint: sourceName } : {}),
      ...(latentSpace !== undefined ? { latentSpace } : {}),
    }
  } catch {
    return {}
  }
}

/** Read only the bounded safetensors header; tensor bodies never enter JavaScript state. */
export async function readLatentMetadata(file: Pick<File, 'size' | 'slice'>): Promise<LatentMetadataResult> {
  if (!Number.isSafeInteger(file.size) || file.size < 9) return { ok: false, message: 'Latent file is truncated' }
  try {
    const prefix = await file.slice(0, 8).arrayBuffer()
    if (prefix.byteLength !== 8) return { ok: false, message: 'Latent file is truncated' }
    const headerLength = new DataView(prefix).getBigUint64(0, true)
    if (headerLength === 0n || headerLength % 8n !== 0n || headerLength > BigInt(MAX_HEADER_BYTES)) {
      return { ok: false, message: 'Latent header violates the safe size limit or alignment' }
    }
    if (headerLength > BigInt(file.size - 8)) return { ok: false, message: 'Latent header extends beyond the file' }
    const headerEnd = 8 + Number(headerLength)
    const headerBytes = new Uint8Array(await file.slice(8, headerEnd).arrayBuffer())
    if (headerBytes.byteLength !== Number(headerLength)) return { ok: false, message: 'Latent header is truncated' }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)
    if (decoded[0] !== '{' || decoded.replace(/ +$/, '').at(-1) !== '}') {
      return { ok: false, message: 'Latent header padding is malformed' }
    }
    const parsed = new StrictJsonParser(decoded, true).parse()
    if (!object(parsed)) return { ok: false, message: 'Latent tensor table is malformed' }
    const tensors = tensorTable(parsed, file.size - headerEnd)
    if (tensors === undefined) return { ok: false, message: 'Latent tensor table is malformed' }
    const rawMetadata = parsed['__metadata__']
    if (rawMetadata !== undefined && !object(rawMetadata)) return { ok: false, message: 'Latent metadata is malformed' }
    const retained: Record<string, string> = {}
    if (rawMetadata !== undefined) {
      for (const [key, value] of Object.entries(rawMetadata)) {
        if (typeof value !== 'string') return { ok: false, message: 'Latent metadata is malformed' }
        const limit = RETAINED_LIMITS[key]
        if (limit !== undefined) {
          if (new TextEncoder().encode(value).byteLength > limit) return { ok: false, message: `Latent ${key} metadata exceeds the safe size limit` }
          retained[key] = value
        }
      }
    }
    if (!validProfile(rawMetadata, tensors)) return { ok: false, message: 'Latent tensor profile is unsupported or malformed' }
    let workflow: unknown | undefined
    if (retained['workflow'] !== undefined) {
      try { workflow = new StrictJsonParser(retained['workflow']).parse() }
      catch { workflow = undefined }
    }
    const hint = retained['dinkster_vae_hint'] === undefined ? {} : displayHint(retained['dinkster_vae_hint'])
    return { ok: true, metadata: { ...(workflow !== undefined ? { workflow } : {}), ...hint } }
  } catch {
    return { ok: false, message: 'Latent header is not valid strict UTF-8 JSON' }
  }
}
