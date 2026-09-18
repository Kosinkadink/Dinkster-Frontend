import { scopedSharedName } from './projects.js'
import type { WorkerPortLike } from './shared-worker-authority.js'
import type {
  WorkspaceTabMutation,
  WorkspaceTabRecord,
  WorkspaceTabSnapshot,
  WorkspaceWorkerRequest,
  WorkspaceWorkerResponse,
} from './workspace-worker-authority.js'

export type WorkspaceWorkerPortFactory = () => WorkerPortLike
type RequestWithoutId = WorkspaceWorkerRequest extends infer Request
  ? Request extends { readonly id: number }
    ? Omit<Request, 'id'>
    : never
  : never

const browserPortFactory: WorkspaceWorkerPortFactory = () => {
  // Project-scoped name: windows sharing a project converge on one tab
  // authority; windows on different projects get isolated workers.
  const worker = new SharedWorker(new URL('./workspace-worker-entry.ts', import.meta.url), {
    type: 'module',
    name: scopedSharedName('dinkster-workspace-tabs'),
  })
  return worker.port
}

export class SharedWorkerTabConnection {
  private static readonly REQUEST_TIMEOUT_MS = 15_000
  private static readonly HEARTBEAT_MS = 15_000
  private nextId = 1
  private closed = false
  private closing = false
  private disposed = false
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private readonly listeners = new Set<(snapshot: WorkspaceTabSnapshot) => void>()
  private readonly disconnectListeners = new Set<(error: Error) => void>()
  private readonly heartbeat: ReturnType<typeof setInterval>

  private constructor(private readonly port: WorkerPortLike) {
    port.addEventListener('message', (event) => this.receive(event.data))
    port.start?.()
    this.heartbeat = setInterval(() => {
      if (!this.closed) void this.request({ kind: 'heartbeat' }).catch((error: unknown) => {
        this.dispose(error instanceof Error ? error : new Error(String(error)))
      })
    }, SharedWorkerTabConnection.HEARTBEAT_MS)
    ;(this.heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  }

  static async open(
    tabs: readonly WorkspaceTabRecord[],
    factory: WorkspaceWorkerPortFactory = browserPortFactory,
    revision = 0,
    active = '',
    operationWatermarks: Readonly<Record<string, number>> = {},
  ): Promise<{ readonly connection: SharedWorkerTabConnection; readonly snapshot: WorkspaceTabSnapshot }> {
    const connection = new SharedWorkerTabConnection(factory())
    try {
      const snapshot = await connection.request({
        kind: 'open', tabs, revision, active, operationWatermarks,
      }) as WorkspaceTabSnapshot
      return { connection, snapshot }
    } catch (error) {
      connection.dispose(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  mutate(mutation: WorkspaceTabMutation): Promise<WorkspaceTabSnapshot> {
    return this.request({ kind: 'mutate', mutation }) as Promise<WorkspaceTabSnapshot>
  }

  onSnapshot(listener: (snapshot: WorkspaceTabSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closing = true
    this.closed = true
    clearInterval(this.heartbeat)
    void this.request({ kind: 'close' }).finally(() => this.port.close?.())
  }

  private request(request: RequestWithoutId): Promise<unknown> {
    if (this.closed && request.kind !== 'close') return Promise.reject(new Error('workspace tab connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) this.dispose(new Error(`workspace tab request '${request.kind}' timed out`))
      }, SharedWorkerTabConnection.REQUEST_TIMEOUT_MS)
      ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timeout })
      this.port.postMessage({ ...request, id })
    })
  }

  private receive(raw: unknown): void {
    const response = raw as WorkspaceWorkerResponse
    if (response.kind === 'snapshot') {
      for (const listener of [...this.listeners]) listener(response.snapshot)
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timeout)
    if (response.kind === 'error') {
      const error = new Error(response.message)
      pending.reject(error)
      if (response.message === 'workspace connection is not open') this.dispose(error)
    } else pending.resolve(response.value)
  }

  private dispose(error: Error): void {
    if (this.disposed) return
    this.disposed = true
    this.closed = true
    clearInterval(this.heartbeat)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.port.close?.()
    if (!this.closing) for (const listener of [...this.disconnectListeners]) listener(error)
    this.disconnectListeners.clear()
  }
}
