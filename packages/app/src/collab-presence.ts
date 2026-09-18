/**
 * Ephemeral presence for shared sessions (docs/collaboration.md): what each
 * participant is pointing at and has selected, broadcast over the collab
 * WS presence frames the backend relays to OTHER subscribers and never
 * stores.
 *
 * The payload is opaque Json to both the backend and the core session, so
 * its schema is owned by @dinkster/client and versioned independently of the
 * op envelope: a frame whose shape this build does not understand is noise,
 * dropped without error - presence is noise-tolerant fan-out end to end.
 *
 * Ownership: one PresenceChannel per shared-tab membership, created and
 * disposed with it (CollabTabState). CanvasHost feeds the local side
 * (pointer, selection, current graph) and projects the remote side into
 * the renderer; the channel owns throttling, heartbeat, validation, and
 * expiry so neither the host nor the renderer grows timer state.
 */
import {
  decodePresence,
  encodePresence,
  PRESENCE_VERSION,
  type LocalPresence,
  type PresenceIdentity,
  type PresenceLinkDrag,
  type PresenceRect,
  type SettingsProposal,
} from '@dinkster/client'
import { createSignal, jsonSameValue, type Json, type Signal } from '@dinkster/core'

export {
  decodePresence,
  encodePresence,
  PRESENCE_VERSION,
  type LocalPresence,
  type PresenceIdentity,
  type PresenceLinkDrag,
  type PresenceRect,
  type SettingsProposal,
} from '@dinkster/client'

/** Trailing-edge send throttle: pointer motion coalesces to ~15 frames/s. */
export const PRESENCE_THROTTLE_MS = 66
/** Idle re-send keeping the actor alive in everyone's TTL window. */
export const PRESENCE_HEARTBEAT_MS = 2000
/** An actor silent this long is gone (crashed tab, dropped WS - no frame says so). */
export const PRESENCE_TTL_MS = 6000
/** Expiry sweep cadence. */
export const PRESENCE_SWEEP_MS = 1000
/** A remote participant's last validated state. */
export interface RemotePresence {
  readonly activity?: import('@dinkster/client').AgentActivity
  readonly actorId: string
  readonly graph: string
  readonly cursor?: { readonly x: number; readonly y: number }
  readonly selection: readonly string[]
  readonly reroutes: readonly string[]
  readonly view?: PresenceRect
  readonly hover?: string
  readonly drag?: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>
  readonly link?: PresenceLinkDrag
  readonly identity?: PresenceIdentity
  readonly proposals?: readonly SettingsProposal[]
  /** Channel clock time of the last frame; expiry compares against it. */
  readonly lastSeen: number
}

/** The slice of SharedDocumentSession the channel needs (test seam). */
export interface PresenceSession {
  sendPresence(payload: Json): void
  onPresence(listener: (actorId: string, payload?: Json) => void): () => void
}

/**
 * Deterministic per-actor color: same actor renders the same hue in every
 * participant's canvas with no coordination. FNV-1a over the id -> hue.
 */
export function actorColor(actorId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < actorId.length; i++) {
    h ^= actorId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `hsl(${(h >>> 0) % 360} 70% 55%)`
}

/** Short cursor-label tag for an actor id (UUIDs are unreadable in full). */
export const actorLabel = (actorId: string): string => actorId.slice(0, 6)

const sameRect = (a: PresenceRect | undefined, b: PresenceRect | undefined): boolean =>
  a?.x === b?.x && a?.y === b?.y && a?.w === b?.w && a?.h === b?.h

const sameDrag = (
  a: ReadonlyMap<string, { readonly dx: number; readonly dy: number }> | undefined,
  b: ReadonlyMap<string, { readonly dx: number; readonly dy: number }> | undefined,
): boolean => {
  if (a === b) return true
  if (a === undefined || b === undefined || a.size !== b.size) return false
  for (const [id, o] of a) {
    const p = b.get(id)
    if (p === undefined || p.dx !== o.dx || p.dy !== o.dy) return false
  }
  return true
}

const sameLink = (a: PresenceLinkDrag | undefined, b: PresenceLinkDrag | undefined): boolean =>
  a === b || (
    a !== undefined && b !== undefined &&
    a.cursor.x === b.cursor.x && a.cursor.y === b.cursor.y &&
    a.origin.kind === b.origin.kind &&
    (a.origin.kind === 'port' && b.origin.kind === 'port'
      ? a.origin.node === b.origin.node && a.origin.port === b.origin.port && a.origin.side === b.origin.side
      : a.origin.kind === 'widgetTap' && b.origin.kind === 'widgetTap'
        ? a.origin.node === b.origin.node && a.origin.input === b.origin.input
      : a.origin.kind === 'reroute' && b.origin.kind === 'reroute' &&
        a.origin.reroute === b.origin.reroute && a.origin.side === b.origin.side)
  )

const sameIdentity = (a: PresenceIdentity | undefined, b: PresenceIdentity | undefined): boolean =>
  a?.kind === b?.kind && a?.displayName === b?.displayName && a?.owner === b?.owner && a?.harness === b?.harness

const sameProposals = (a: readonly SettingsProposal[] | undefined, b: readonly SettingsProposal[] | undefined): boolean => {
  if (a === b) return true
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false
  const byId = new Map((b ?? []).map((proposal) => [proposal.id, proposal]))
  return (a ?? []).every((proposal) => {
    const other = byId.get(proposal.id)
    return other !== undefined && proposal.settingId === other.settingId && proposal.note === other.note &&
      jsonSameValue(proposal.value, other.value)
  })
}

const sameLocal = (a: LocalPresence | undefined, b: LocalPresence): boolean =>
  a !== undefined && a.graph === b.graph &&
  a.cursor?.x === b.cursor?.x && a.cursor?.y === b.cursor?.y &&
  a.selection.length === b.selection.length && a.selection.every((id, i) => id === b.selection[i]) &&
  (a.reroutes?.length ?? 0) === (b.reroutes?.length ?? 0) &&
  (a.reroutes ?? []).every((id, i) => id === b.reroutes?.[i]) &&
  sameRect(a.view, b.view) && a.hover === b.hover && sameDrag(a.drag, b.drag) && sameLink(a.link, b.link) &&
  sameIdentity(a.identity, b.identity) && sameProposals(a.proposals, b.proposals)

/**
 * One membership's presence pipe: throttled+heartbeated egress of the local
 * state, validated ingress into a TTL-expired per-actor map. All timer and
 * clock access lives here (injectable for tests).
 */
export class PresenceChannel {
  /** Remote actors, keyed by actorId. Map identity changes on every update. */
  readonly remotes: Signal<ReadonlyMap<string, RemotePresence>> =
    createSignal<ReadonlyMap<string, RemotePresence>>(new Map())

  private readonly session: PresenceSession
  private readonly selfId: string
  private readonly now: () => number
  private readonly unsubscribe: () => void
  private readonly heartbeatTimer: ReturnType<typeof setInterval>
  private readonly sweepTimer: ReturnType<typeof setInterval>

  private local: LocalPresence | undefined
  private lastSentAt = -Infinity
  private trailing: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(session: PresenceSession, selfId: string, options?: { readonly now?: () => number }) {
    this.session = session
    this.selfId = selfId
    this.now = options?.now ?? Date.now
    this.unsubscribe = session.onPresence((actorId, payload) => this.ingest(actorId, payload))
    this.heartbeatTimer = setInterval(() => {
      // A recent state send already keeps peers alive: only heartbeat when a
      // full quiet interval has passed, so the heartbeat can never stack a
      // duplicate frame inside the throttle window of a state change.
      if (this.local !== undefined && this.now() - this.lastSentAt >= PRESENCE_HEARTBEAT_MS) this.send()
    }, PRESENCE_HEARTBEAT_MS)
    this.sweepTimer = setInterval(() => this.sweep(), PRESENCE_SWEEP_MS)
  }

  /**
   * Update what this client broadcasts. Unchanged state is a no-op (the
   * heartbeat keeps peers alive); changes send now if the throttle window
   * has passed, else coalesce into one trailing-edge send.
   */
  setLocal(state: LocalPresence): void {
    if (this.disposed || sameLocal(this.local, state)) return
    this.local = state
    const wait = this.lastSentAt + PRESENCE_THROTTLE_MS - this.now()
    if (wait <= 0) this.send()
    else if (this.trailing === undefined) {
      this.trailing = setTimeout(() => {
        this.trailing = undefined
        if (!this.disposed && this.local !== undefined) this.send()
      }, wait)
    }
  }

  /**
   * Blank what peers see without tearing down the channel: off-canvas
   * cursor, empty hands. For rebinding contexts - the canvas switched to
   * another tab or unmounted while the membership lives on - where this
   * client is demonstrably no longer looking at the graph. The heartbeat
   * keeps the blanked state fresh; a later setLocal resumes normally.
   */
  blur(): void {
    if (this.disposed || this.local === undefined) return
    // Everything positional blanks: cursor, selection, viewport, hover, and
    // any in-progress drag - the actor is demonstrably not here anymore.
    this.setLocal({
      graph: this.local.graph,
      cursor: undefined,
      selection: [],
      ...(this.local.identity !== undefined ? { identity: this.local.identity } : {}),
      ...(this.local.proposals !== undefined ? { proposals: this.local.proposals } : {}),
    })
  }

  /**
   * Stop broadcasting and forget everyone. Sends a best-effort `gone` frame
   * so peers drop this actor immediately instead of waiting out the TTL
   * (the connection drops it silently if the WS is already down).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    clearInterval(this.heartbeatTimer)
    clearInterval(this.sweepTimer)
    if (this.trailing !== undefined) clearTimeout(this.trailing)
    this.session.sendPresence({ v: PRESENCE_VERSION, gone: true })
    this.remotes.set(new Map())
  }

  private send(): void {
    if (this.local === undefined) return
    // Any send transmits the CURRENT local state, so a pending trailing
    // send would only duplicate it - cancel instead of double-sending.
    if (this.trailing !== undefined) {
      clearTimeout(this.trailing)
      this.trailing = undefined
    }
    this.lastSentAt = this.now()
    this.session.sendPresence(encodePresence(this.local))
  }

  private ingest(actorId: string, payload: Json | undefined): void {
    // The backend relays to OTHER subscribers only; filtering our own id
    // anyway keeps a misbehaving relay from painting a ghost of ourselves.
    if (this.disposed || actorId === this.selfId) return
    const decoded = decodePresence(payload)
    if (decoded === null) return
    this.remotes.update((m) => {
      const next = new Map(m)
      if (decoded === 'gone') next.delete(actorId)
      else next.set(actorId, { actorId, lastSeen: this.now(), ...decoded })
      return next
    })
  }

  private sweep(): void {
    const cutoff = this.now() - PRESENCE_TTL_MS
    const current = this.remotes.get()
    let stale = false
    for (const r of current.values()) if (r.lastSeen < cutoff) { stale = true; break }
    if (!stale) return
    this.remotes.update((m) => {
      const next = new Map(m)
      for (const [id, r] of next) if (r.lastSeen < cutoff) next.delete(id)
      return next
    })
  }
}

/**
 * Keep one remote-presence projection bound across unrelated host updates.
 * Local document commits and local gesture completion do not change either
 * the membership channel or graph, so rebinding them must be a no-op: a
 * transient empty projection would erase another actor's live gesture.
 */
export class PresenceProjector {
  private channel: PresenceChannel | undefined
  private graph: string | undefined
  private unsubscribe: (() => void) | undefined

  constructor(
    private readonly project: (
      remotes: ReadonlyMap<string, RemotePresence>,
      graph: string | undefined,
    ) => void,
  ) {}

  bind(channel: PresenceChannel | undefined, graph: string | undefined): void {
    if (this.channel === channel && this.graph === graph) return
    this.unsubscribe?.()
    this.channel = channel
    this.graph = graph
    if (channel === undefined || graph === undefined) {
      this.unsubscribe = undefined
      this.project(new Map(), undefined)
      return
    }
    this.project(channel.remotes.get(), graph)
    this.unsubscribe = channel.remotes.subscribe((remotes) => this.project(remotes, graph))
  }

  /** Re-project after the renderer's scene changes, without rebinding. */
  refresh(): void {
    if (this.channel === undefined || this.graph === undefined) return
    this.project(this.channel.remotes.get(), this.graph)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.channel = undefined
    this.graph = undefined
    this.project(new Map(), undefined)
  }
}
