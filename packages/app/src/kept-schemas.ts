import { buildDinksterRegistry, type SchemaRegistry } from '@dinkster/client'
import type { ConnectionId, DinksterNodesPayload } from '@dinkster/core'

/**
 * The last settled /api/nodes body each backend gave this browser, kept in
 * IndexedDB per backend URL and project. After a reload the editor draws
 * from it until the backend answers; it is a cache, so storage failures
 * only mean nodes wait for the backend as they would without a copy.
 */
const DATABASE = 'dinkster-kept-schemas'
const STORE = 'tables'

const keyOf = (baseUrl: string, project: string | undefined): string => JSON.stringify([baseUrl, project ?? null])

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode)
      const request = use(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function keepSchemas(baseUrl: string, project: string | undefined, payload: DinksterNodesPayload): Promise<void> {
  await withStore('readwrite', (store) => store.put(payload, keyOf(baseUrl, project))).catch(() => undefined)
}

export async function readKeptSchemas(baseUrl: string, project: string | undefined): Promise<DinksterNodesPayload | undefined> {
  const kept = await withStore('readonly', (store) => store.get(keyOf(baseUrl, project))).catch(() => undefined)
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
