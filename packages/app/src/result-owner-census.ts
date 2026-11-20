/** Origin-wide locks enumerate live members; channel silence never means no holder. */
export class ResultOwnerCensus {
  private readonly id = globalThis.crypto?.randomUUID?.() ?? ''
  private readonly prefix = 'dinkster-result-holders:v2:'
  private readonly gate = 'dinkster-result-reclamation'
  private readonly locks = globalThis.navigator?.locks
  private readonly channel: BroadcastChannel | undefined
  private readonly ready: Promise<boolean>
  private readonly blocked = new Map<string, string>()
  private release: (() => void) | undefined
  private joining = false
  private closed = false

  constructor(private readonly holders: () => ReadonlySet<string> | undefined) {
    if (!this.id || typeof this.locks?.query !== 'function' || typeof globalThis.BroadcastChannel !== 'function') {
      this.ready = Promise.resolve(false)
      return
    }
    this.joining = true
    try {
      this.channel = new BroadcastChannel(this.prefix)
      ;(this.channel as BroadcastChannel & { unref?: () => void }).unref?.()
      this.channel.addEventListener('message', this.receive)
      this.ready = new Promise((resolve) => {
        // Registration cannot begin a new adopting lifetime inside a release.
        void this.locks!.request(this.gate, { mode: 'shared' }, () => new Promise<void>((joined) => {
          void this.locks!.request(`${this.prefix}${this.id}`, async () => {
            if (this.closed) { resolve(false); joined(); return }
            this.joining = false
            resolve(true)
            joined()
            await new Promise<void>((finish) => { this.release = finish })
          }).catch(() => { resolve(false); joined() })
        })).catch(() => resolve(false))
      })
    } catch {
      this.channel?.close()
      this.ready = Promise.resolve(false)
    }
  }

  mayAdopt(ownerId: string): boolean {
    return !this.closed && !this.joining && ![...this.blocked.values()].includes(ownerId)
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    const request = event.data as { kind?: unknown; nonce?: unknown; owner?: unknown } | null
    if (this.closed || typeof request?.nonce !== 'string') return
    if (request.kind === 'resume') { this.blocked.delete(request.nonce); return }
    if (request.kind !== 'query' || typeof request.owner !== 'string') return
    // The synchronous publication guard stays closed through the release's
    // durable tombstone, not just while this participant answers the query.
    this.blocked.set(request.nonce, request.owner)
    try {
      const owners = this.holders()
      if (owners !== undefined) this.channel?.postMessage({ kind: 'holders', nonce: request.nonce,
        member: this.id, owners: [...owners] })
    } catch { /* An instance that cannot answer prevents reclamation. */ }
  }

  private async members(): Promise<Set<string> | undefined> {
    const snapshot = await this.locks!.query()
    // Earlier members do not fence adoption, even if they answer a query.
    if ([...(snapshot.held ?? []), ...(snapshot.pending ?? [])].some((lock) =>
      lock.name?.startsWith('dinkster-result-holders') && !lock.name.startsWith(this.prefix))) return undefined
    if (snapshot.pending?.some((lock) => lock.name?.startsWith(this.prefix))) return undefined
    return new Set((snapshot.held ?? []).flatMap((lock) =>
      lock.name?.startsWith(this.prefix) ? [lock.name.slice(this.prefix.length)] : []))
  }

  private async collect(owner: string, nonce: string): Promise<ReadonlySet<string> | undefined> {
    if (this.closed || this.channel === undefined) return undefined
    const replies = new Map<string, readonly string[]>()
    let notify = (): void => {}
    const receive = (event: MessageEvent<unknown>): void => {
      const reply = event.data as { kind?: unknown; nonce?: unknown; member?: unknown; owners?: unknown } | null
      if (reply?.kind !== 'holders' || reply.nonce !== nonce || typeof reply.member !== 'string' ||
        !Array.isArray(reply.owners) || !reply.owners.every((id) => typeof id === 'string')) return
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
        this.channel!.postMessage({ kind: 'query', nonce, owner })
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

  /** Every member excludes adoption until the exact release and its journal settle. */
  async reclaim(owner: string, release: () => Promise<void>): Promise<boolean> {
    if (!await this.ready || this.closed || this.channel === undefined) return false
    return this.locks!.request(this.gate, async () => {
      const nonce = crypto.randomUUID()
      this.blocked.set(nonce, owner)
      try {
        const held = await this.collect(owner, nonce)
        if (held === undefined) return false
        if (!held.has(owner)) await release()
        return true
      } finally {
        this.blocked.delete(nonce)
        if (!this.closed) this.channel!.postMessage({ kind: 'resume', nonce })
      }
    }).catch(() => false)
  }

  dispose(): void {
    this.closed = true
    this.release?.()
    this.channel?.removeEventListener('message', this.receive)
    this.channel?.close()
  }
}
