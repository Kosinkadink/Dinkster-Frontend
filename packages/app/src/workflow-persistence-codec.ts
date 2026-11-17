import {
  acceptPersistenceValue,
  cachedPersistenceJson,
  parsePersistenceJson,
  persistenceValuePrepared,
  preparePersistenceValue,
  type PreparedWorkflow,
} from './workflow-persistence-value.js'

export class WorkflowPersistenceCodec {
  private worker: Worker | undefined
  private nextId = 0
  private readonly pending = new Map<number, {
    readonly value: unknown
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
  }>()

  prepare(value: unknown): Promise<unknown> {
    if (persistenceValuePrepared(value)) return Promise.resolve(value)
    return this.request(value)
  }

  async parse(json: string): Promise<unknown> {
    const value = cachedPersistenceJson(json)
    if (value !== undefined && persistenceValuePrepared(value)) return value
    return this.request(undefined, json)
  }

  private request(value: unknown, json?: string): Promise<unknown> {
    if (typeof Worker === 'undefined') {
      const decoded = json === undefined ? value : parsePersistenceJson(json)
      acceptPersistenceValue(decoded, preparePersistenceValue(decoded), json)
      return Promise.resolve(decoded)
    }
    if (this.worker === undefined) {
      this.worker = new Worker(new URL('./workflow-persistence-worker-entry.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }: MessageEvent<{
        readonly id: number
        readonly value: unknown
        readonly prepared: readonly PreparedWorkflow[]
        readonly json?: string
        readonly error?: string
      }>) => {
        const request = this.pending.get(data.id)
        if (!request) return
        this.pending.delete(data.id)
        if (data.error !== undefined) request.reject(new Error(data.error))
        else {
          const result = data.json === undefined ? request.value : data.value
          acceptPersistenceValue(result, data.prepared, data.json)
          request.resolve(result)
        }
      }
      this.worker.onerror = () => this.dispose()
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { value, resolve, reject })
      this.worker!.postMessage({ id, ...(json === undefined ? { value } : { json }) })
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = undefined
    for (const request of this.pending.values()) request.reject(new Error('Workflow persistence worker stopped'))
    this.pending.clear()
  }
}
