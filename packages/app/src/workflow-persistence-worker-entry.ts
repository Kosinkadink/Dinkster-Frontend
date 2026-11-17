import { preparePersistenceValue } from './workflow-persistence-value.js'

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ readonly id: number; readonly value?: unknown; readonly json?: string }>) => void) | null
  postMessage(value: unknown): void
}

worker.onmessage = ({ data }) => {
  try {
    const value: unknown = data.json === undefined ? data.value : JSON.parse(data.json)
    const prepared = preparePersistenceValue(value)
    worker.postMessage({ id: data.id, value, prepared, ...(data.json === undefined ? {} : { json: data.json }) })
  } catch (error) {
    worker.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
