import { buildDinksterRegistry, type SchemaRegistry } from '@dinkster/client'
import type { ConnectionId, DinksterNodesPayload } from '@dinkster/core'

/**
 * The last settled /api/nodes body each backend gave this browser, kept in
 * IndexedDB per backend URL and project. After a reload the editor draws
 * from it until the backend answers; it is a cache, so storage failures
 * only mean nodes wait for the backend as they would without a copy.
 */
const DATABASE = 'dinkster-kept-schemas'
const TABLES = 'tables'
/** Last use per record, kept apart so trimming never reads the large tables. */
const USED = 'used'
/** Projects kept per backend; the least recently used beyond this are dropped. */
export const KEPT_PROJECTS_PER_BACKEND = 20

let lastUse = 0
/** Strictly increasing, so records written in the same millisecond still have an order. */
const useStamp = (): number => (lastUse = Math.max(Date.now(), lastUse + 1))

const keyOf = (baseUrl: string, project: string | undefined): string => JSON.stringify([baseUrl, project ?? null])

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(TABLES)
      request.result.createObjectStore(USED)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(mode: IDBTransactionMode, use: (tables: IDBObjectStore, used: IDBObjectStore) => () => T): Promise<T> {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction([TABLES, USED], mode)
      const result = use(transaction.objectStore(TABLES), transaction.objectStore(USED))
      transaction.oncomplete = () => resolve(result())
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function keepSchemas(baseUrl: string, project: string | undefined, payload: DinksterNodesPayload): Promise<void> {
  await transact('readwrite', (tables, used) => {
    const key = keyOf(baseUrl, project)
    tables.put(payload, key)
    used.put(useStamp(), key)
    const backendUse: [string, number][] = []
    const cursor = used.openCursor()
    cursor.onsuccess = () => {
      const entry = cursor.result
      if (entry !== null) {
        const [entryBaseUrl] = JSON.parse(String(entry.key)) as [string, string | null]
        if (entryBaseUrl === baseUrl) backendUse.push([String(entry.key), Number(entry.value)])
        entry.continue()
        return
      }
      backendUse.sort((a, b) => b[1] - a[1])
      for (const [stale] of backendUse.slice(KEPT_PROJECTS_PER_BACKEND)) {
        tables.delete(stale)
        used.delete(stale)
      }
    }
    return () => undefined
  }).catch(() => undefined)
}

export async function readKeptSchemas(baseUrl: string, project: string | undefined): Promise<DinksterNodesPayload | undefined> {
  const kept = await transact('readwrite', (tables, used) => {
    const key = keyOf(baseUrl, project)
    const request = tables.get(key)
    request.onsuccess = () => { if (request.result !== undefined) used.put(useStamp(), key) }
    return () => request.result as unknown
  }).catch(() => undefined)
  return typeof kept === 'object' && kept !== null ? kept as DinksterNodesPayload : undefined
}

/**
 * A registry to draw nodes from before the backend answers. It has no epoch,
 * so it can never satisfy the epoch gate, and no extension snapshot, whose
 * modules only the live backend serves. A copy encoded in another schema
 * wire version than this build decodes is not used.
 */
export function keptRegistry(connection: ConnectionId, kept: DinksterNodesPayload): SchemaRegistry | undefined {
  const { epoch: _epoch, extensionSnapshotDigest: _digest, ...payload } = kept
  const registry = buildDinksterRegistry(connection, payload)
  return registry.diagnostics.some((entry) => entry.code === 'schema.dinkster.wireVersion') ? undefined : registry
}
