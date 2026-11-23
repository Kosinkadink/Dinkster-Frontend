import type { DinksterConnection, MemoryStatus } from '@dinkster/client'

type MemoryConnection = Pick<DinksterConnection, 'status' | 'fetchMemoryStatus' | 'onMemoryStatus'>
type Timer = ReturnType<typeof setInterval>

/** Owns push/poll selection and detail-fetch lifetime; timers are injectable for unit tests. */
export class MemoryStatusController {
  private pollTimer: Timer | undefined
  private detailTimer: Timer | undefined
  private readonly expanded = new Set<string>()
  private readonly disposers: (() => void)[]
  private lastPushAt = -Infinity
  private pushVersion = 0
  private detailGeneration = 0
  private baseRequestGeneration = 0
  private detailRequestGeneration = 0
  private disposed = false

  constructor(
    private readonly connection: MemoryConnection,
    private readonly accept: (status: MemoryStatus, details: boolean) => void,
    private readonly fail: (error: unknown, details: boolean) => void,
    private readonly every: (fn: () => void, ms: number) => Timer = (fn, ms) => setInterval(fn, ms),
    private readonly stopTimer: (timer: Timer) => void = (timer) => clearInterval(timer),
    private readonly now: () => number = Date.now,
  ) {
    this.disposers = [
      connection.onMemoryStatus((status) => {
        if (this.disposed) return
        this.lastPushAt = this.now()
        this.pushVersion++
        this.baseRequestGeneration++
        this.detailGeneration++
        this.accept(status, false)
      }),
      connection.status.subscribe((state) => { if (state !== 'connected') this.request(false) }),
    ]
    this.request(false)
    this.pollTimer = this.every(() => {
      if (this.connection.status.get() !== 'connected' || this.now() - this.lastPushAt > 6000) this.request(false)
    }, 5000)
  }

  private request(details: boolean): void {
    const requestGeneration = details ? ++this.detailRequestGeneration : ++this.baseRequestGeneration
    const pushVersion = this.pushVersion
    const detailGeneration = this.detailGeneration
    void this.connection.fetchMemoryStatus(details).then((status) => {
      if (this.disposed || requestGeneration !== (details ? this.detailRequestGeneration : this.baseRequestGeneration) ||
        (details ? detailGeneration !== this.detailGeneration : pushVersion !== this.pushVersion)) return
      this.accept(status, details)
    }, (error) => {
      if (!this.disposed && requestGeneration === (details ? this.detailRequestGeneration : this.baseRequestGeneration) &&
        (details ? detailGeneration === this.detailGeneration : pushVersion === this.pushVersion)) this.fail(error, details)
    })
  }

  setExpanded(consumer: string, expanded: boolean): void {
    this.detailGeneration++
    if (expanded) this.expanded.add(consumer)
    else this.expanded.delete(consumer)
    if (this.expanded.size > 0) {
      this.request(true)
      if (this.detailTimer === undefined) this.detailTimer = this.every(() => this.request(true), 10000)
    } else if (this.detailTimer !== undefined) {
      this.stopTimer(this.detailTimer)
      this.detailTimer = undefined
    }
  }

  refreshDetails(): void {
    if (this.expanded.size === 0) return
    this.detailGeneration++
    this.request(true)
  }

  dispose(): void {
    this.disposed = true
    this.detailGeneration++
    if (this.pollTimer !== undefined) this.stopTimer(this.pollTimer)
    if (this.detailTimer !== undefined) this.stopTimer(this.detailTimer)
    this.disposers.forEach((dispose) => dispose())
  }
}
