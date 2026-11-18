import { scopedSharedName } from './projects.js'

/** Browser locks enumerate live members; channel silence never means no holder. */
export class ResultOwnerCensus {
  private readonly id = crypto.randomUUID()
  private readonly prefix = `${scopedSharedName('dinkster-result-holders')}:`
  private readonly locks = globalThis.navigator?.locks
  private readonly channel: BroadcastChannel | undefined
  private readonly ready: Promise<boolean>
  private release: (() => void) | undefined
  private closed = false

  constructor(private readonly holders: () => ReadonlySet<string> | undefined) {
    if (typeof this.locks?.query !== 'function' || typeof globalThis.BroadcastChannel !== 'function') {
      this.ready = Promise.resolve(false)
      return
    }
    try {
      this.channel = new BroadcastChannel(this.prefix)
      ;(this.channel as BroadcastChannel & { unref?: () => void }).unref?.()
      this.channel.addEventListener('message', this.receive)
      this.ready = new Promise((resolve) => {
        void this.locks!.request(`${this.prefix}${this.id}`, async () => {
          if (this.closed) { resolve(false); return }
          resolve(true)
          await new Promise<void>((finish) => { this.release = finish })
        }).catch(() => resolve(false))
      })
    } catch {
      this.channel?.close()
      this.ready = Promise.resolve(false)
    }
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    const request = event.data as { kind?: unknown; nonce?: unknown } | null
    if (this.closed || request?.kind !== 'query' || typeof request.nonce !== 'string') return
    try {
      const owners = this.holders()
      if (owners !== undefined) this.channel?.postMessage({ kind: 'holders', nonce: request.nonce,
        member: this.id, owners: [...owners] })
    } catch { /* An instance that cannot answer prevents reclamation. */ }
  }

  private async members(): Promise<Set<string> | undefined> {
    const snapshot = await this.locks!.query()
    if (snapshot.pending?.some((lock) => lock.name?.startsWith(this.prefix))) return undefined
    return new Set((snapshot.held ?? []).flatMap((lock) =>
      lock.name?.startsWith(this.prefix) ? [lock.name.slice(this.prefix.length)] : []))
  }

  async collect(): Promise<ReadonlySet<string> | undefined> {
    if (!await this.ready || this.closed || this.channel === undefined) return undefined
    const nonce = crypto.randomUUID()
    const replies = new Map<string, readonly string[]>()
    let notify = (): void => {}
    const receive = (event: MessageEvent<unknown>): void => {
      const reply = event.data as { kind?: unknown; nonce?: unknown; member?: unknown; owners?: unknown } | null
      if (reply?.kind !== 'holders' || reply.nonce !== nonce || typeof reply.member !== 'string' ||
        !Array.isArray(reply.owners) || !reply.owners.every((owner) => typeof owner === 'string')) return
      replies.set(reply.member, reply.owners)
      notify()
    }
    this.channel.addEventListener('message', receive)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const members = await this.members()
      const own = this.holders()
      if (members === undefined || !members.has(this.id) || own === undefined) return undefined
      replies.set(this.id, [...own])
      const complete = await new Promise<boolean>((resolve) => {
        notify = () => { if ([...members].every((member) => replies.has(member))) resolve(true) }
        timer = setTimeout(() => resolve(false), 1000)
        this.channel!.postMessage({ kind: 'query', nonce })
        notify()
      })
      if (!complete || this.closed) return undefined
      const after = await this.members()
      if (after === undefined || after.size !== members.size || [...after].some((member) => !members.has(member))) return undefined
      return new Set([...members].flatMap((member) => replies.get(member)!))
    } catch { return undefined } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.channel.removeEventListener('message', receive)
    }
  }

  dispose(): void {
    this.closed = true
    this.release?.()
    this.channel?.removeEventListener('message', this.receive)
    this.channel?.close()
  }
}
