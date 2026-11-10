import { DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterSchema, sha256Hex, type NodeSchema } from '@dinkster/core'

export interface CatalogPack {
  readonly name: string
  readonly publisher: 'dinkster'
  readonly version: string
  readonly displayName: string
  readonly platforms: readonly string[]
  readonly url: string
  readonly digest: string
}

export interface CatalogNode {
  readonly pack: CatalogPack
  readonly schema: NodeSchema
}

type CacheStorage = Pick<Storage, 'getItem' | 'setItem'>
interface CachedBody { readonly body: string; readonly etag?: string }
const CACHE_PREFIX = 'dinkster.node-catalog.v1:'
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_PACKS = 1024
const MAX_NODES_PER_PACK = 16384
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}

function decodeIndex(body: string): readonly CatalogPack[] {
  const index = object(JSON.parse(body))
  if (index['schemaVersion'] !== 1 || !Array.isArray(index['items']) || index['items'].length > MAX_PACKS) throw new Error('Unsupported schema index')
  const names = new Set<string>()
  return index['items'].map((value: unknown) => {
    const item = object(value)
    if (typeof item['name'] !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item['name'])
      || item['publisher'] !== 'dinkster' || typeof item['version'] !== 'string' || item['version'] === ''
      || typeof item['displayName'] !== 'string' || !Array.isArray(item['platforms'])
      || !item['platforms'].every((platform: unknown) => typeof platform === 'string')
      || typeof item['digest'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item['digest'])
      || item['url'] !== `packs/${item['name']}/${item['version']}/schemas.json`
      || !/^[0-9][a-zA-Z0-9.!+_-]*$/.test(item['version'])
      || names.has(item['name'])) throw new Error('Invalid schema index entry')
    names.add(item['name'])
    return {
      name: item['name'], publisher: 'dinkster' as const, version: item['version'],
      displayName: item['displayName'], platforms: item['platforms'] as string[],
      url: item['url'] as string, digest: item['digest'],
    }
  })
}

function decodeSchemas(body: string, pack: CatalogPack): readonly CatalogNode[] {
  if (`sha256:${sha256Hex(body)}` !== pack.digest) throw new Error('Schema digest mismatch')
  const envelope = object(JSON.parse(body))
  if (envelope['packName'] !== pack.name || envelope['version'] !== pack.version || !Array.isArray(envelope['schemas']) || envelope['schemas'].length > MAX_NODES_PER_PACK) {
    throw new Error('Schema envelope mismatch')
  }
  const types = new Set<string>()
  return envelope['schemas'].map((value: unknown) => {
    const row = object(value)
    if (typeof row['nodeType'] !== 'string' || types.has(row['nodeType'])
      || row['schemaWireVersion'] !== DINKSTER_SCHEMA_WIRE_VERSION
      || typeof row['schemaVersion'] !== 'number' || typeof row['schemaSignature'] !== 'string') {
      throw new Error('Unsupported registry schema entry')
    }
    const wire = object(row['schema'])
    const { schema } = parseDinksterSchema(row['nodeType'], { ...wire, pack: pack.name, signature: row['schemaSignature'] })
    if (schema === undefined) throw new Error('Invalid node schema')
    types.add(schema.type)
    return { pack, schema }
  })
}

/** Preview-only schemas; callers must never add these to an execution registry. */
export class RemoteNodeCatalog {
  readonly baseUrl: string
  private readonly storage: CacheStorage | undefined
  private pending: Promise<readonly CatalogNode[]> | undefined

  constructor(baseUrl: string, storage?: CacheStorage, private readonly fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '')
    if (storage !== undefined) this.storage = storage
    else { try { this.storage = globalThis.localStorage } catch { this.storage = undefined } }
  }

  private read(url: string): CachedBody | undefined {
    try {
      const stored = this.storage?.getItem(CACHE_PREFIX + url) ?? 'null'
      if (stored.length > MAX_BODY_BYTES * 2) return undefined
      const value = object(JSON.parse(stored))
      if (typeof value['body'] !== 'string' || (value['etag'] !== undefined && typeof value['etag'] !== 'string')) return undefined
      if (new TextEncoder().encode(value['body']).length > MAX_BODY_BYTES) return undefined
      return { body: value['body'], ...(typeof value['etag'] === 'string' ? { etag: value['etag'] } : {}) }
    } catch { return undefined }
  }

  private async load<T>(url: string, decode: (body: string) => T): Promise<T> {
    const cached = this.read(url)
    const response = await this.fetchFn(url, {
      ...(cached?.etag === undefined ? {} : { headers: { 'If-None-Match': cached.etag } }),
      signal: AbortSignal.timeout(5000),
      credentials: 'omit',
    })
    if (response.status === 304 && cached !== undefined) return decode(cached.body)
    if (!response.ok) throw new Error(`Schema catalog request failed: ${response.status}`)
    if (Number(response.headers.get('Content-Length')) > MAX_BODY_BYTES) {
      await response.body?.cancel()
      throw new Error('Schema catalog response is too large')
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Schema catalog response has no body')
    let body = ''
    let bytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_BODY_BYTES) throw new Error('Schema catalog response is too large')
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
    } finally { await reader.cancel(); reader.releaseLock() }
    const decoded = decode(body)
    const etag = response.headers.get('ETag')
    try { this.storage?.setItem(CACHE_PREFIX + url, JSON.stringify({ body, ...(etag === null ? {} : { etag }) })) } catch { /* Storage may be full or unavailable. */ }
    return decoded
  }

  cached(): readonly CatalogNode[] {
    if (this.baseUrl === '') return []
    try {
      const index = this.read(`${this.baseUrl}/schemas/index.json`)
      if (index === undefined) return []
      return decodeIndex(index.body).flatMap((pack) => {
        try {
          const cached = this.read(`${this.baseUrl}/${pack.url}`)
          return cached === undefined ? [] : decodeSchemas(cached.body, pack)
        } catch { return [] }
      })
    } catch { return [] }
  }

  refresh(): Promise<readonly CatalogNode[]> {
    if (this.pending !== undefined) return this.pending
    this.pending = this.refreshAll().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async refreshAll(): Promise<readonly CatalogNode[]> {
    if (this.baseUrl === '') return []
    let packs: readonly CatalogPack[]
    try { packs = await this.load(`${this.baseUrl}/schemas/index.json`, decodeIndex) }
    catch { return this.cached() }
    const nodes: (readonly CatalogNode[])[] = new Array(packs.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, packs.length) }, async () => {
      while (next < packs.length) {
        const index = next++
        const pack = packs[index]!
        const url = `${this.baseUrl}/${pack.url}`
        try { nodes[index] = await this.load(url, (body) => decodeSchemas(body, pack)) }
        catch {
          try {
            const cached = this.read(url)
            nodes[index] = cached === undefined ? [] : decodeSchemas(cached.body, pack)
          } catch { nodes[index] = [] }
        }
      }
    }))
    return nodes.flat()
  }
}
