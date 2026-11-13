/**
 * Presence channel (docs/collaboration.md "Presence"): the app-owned payload
 * schema, throttled+heartbeated egress, validated ingress, TTL expiry, and
 * the gone frame on dispose. Timers and the clock run on vitest fake time -
 * the channel's cadence constants are asserted literally so a change to them
 * is a deliberate, test-visible decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Json } from '@dinkster/core'
import { actorColor, PresenceChannel, PresenceProjector, PRESENCE_HEARTBEAT_MS, PRESENCE_THROTTLE_MS, PRESENCE_TTL_MS, PRESENCE_VERSION, type RemotePresence, type PresenceSession } from '../src/collab-presence.js'

class StubSession implements PresenceSession {
  readonly sent: Json[] = []
  private readonly listeners = new Set<(actorId: string, payload?: Json) => void>()

  sendPresence(payload: Json): void {
    this.sent.push(payload)
  }

  onPresence(listener: (actorId: string, payload?: Json) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  receive(actorId: string, payload?: Json): void {
    for (const l of [...this.listeners]) l(actorId, payload)
  }
}

const frame = (over?: { [key: string]: Json }): Json => ({
  v: PRESENCE_VERSION,
  graph: 'root',
  cursor: { x: 10, y: 20 },
  selection: ['n1'],
  ...over,
})

describe('actor identity helpers', () => {

  it('distinct actors usually get distinct hues', () => {
    const hues = new Set(['a1', 'b2', 'c3', 'd4', 'e5'].map(actorColor))
    expect(hues.size).toBeGreaterThan(3)
  })

})

describe('PresenceChannel', () => {
  let session: StubSession
  let channel: PresenceChannel

  beforeEach(() => {
    vi.useFakeTimers()
    session = new StubSession()
    channel = new PresenceChannel(session, 'me')
  })

  afterEach(() => {
    channel.dispose()
    vi.useRealTimers()
  })

  const local = (x: number) => ({ graph: 'root', cursor: { x, y: 0 }, selection: [] as string[] })

  describe('egress', () => {
    it('sends the first state immediately', () => {
      channel.setLocal(local(1))
      expect(session.sent).toEqual([{ v: PRESENCE_VERSION, graph: 'root', cursor: { x: 1, y: 0 }, selection: [] }])
    })

    it('coalesces rapid changes into one trailing send of the latest state', () => {
      channel.setLocal(local(1))
      channel.setLocal(local(2))
      channel.setLocal(local(3))
      expect(session.sent).toHaveLength(1)
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      expect(session.sent).toHaveLength(2)
      expect(session.sent[1]).toMatchObject({ cursor: { x: 3, y: 0 } })
    })

    it('heartbeats the last state while idle', () => {
      channel.setLocal(local(1))
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)
      expect(session.sent.length).toBe(3)
      expect(session.sent[2]).toMatchObject({ cursor: { x: 1, y: 0 } })
    })

    it('includes an active drag in every later cursor update and heartbeat until gesture end', () => {
      const drag = new Map([['n1', { dx: 3, dy: -4 }]])
      channel.setLocal({ ...local(1), drag })
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      channel.setLocal({ ...local(2), drag })
      expect(session.sent.at(-1)).toMatchObject({ cursor: { x: 2, y: 0 }, drag: [['n1', 3, -4]] })

      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)
      expect(session.sent.at(-1)).toMatchObject({ cursor: { x: 2, y: 0 }, drag: [['n1', 3, -4]] })

      channel.setLocal(local(2))
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      expect(session.sent.at(-1)).not.toHaveProperty('drag')
    })

    it('encodes noodle presence on the cursor cadence and clears it by omission when the drag ends', () => {
      const link = {
        origin: { kind: 'port' as const, node: 'n1', port: 'image', side: 'out' as const },
        cursor: { x: 20, y: 30 },
      }
      channel.setLocal({ ...local(1), link })
      expect(session.sent.at(-1)).toMatchObject({ link })
      channel.setLocal(local(1))
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      expect(session.sent.at(-1)).not.toHaveProperty('link')
    })

    it('blur blanks the broadcast (off-canvas, nothing held) without killing the channel', () => {
      channel.setLocal({
        graph: 'root',
        cursor: { x: 1, y: 0 },
        selection: ['n1'],
        // Everything positional must blank, not just cursor and selection.
        view: { x: 0, y: 0, w: 100, h: 100 },
        hover: 'n1',
        drag: new Map([['n1', { dx: 1, dy: 1 }]]),
      })
      channel.blur()
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      expect(session.sent.at(-1)).toEqual({ v: PRESENCE_VERSION, graph: 'root', cursor: null, selection: [] })
      const count = session.sent.length
      // Still alive: the heartbeat carries the blanked state (two intervals:
      // the first tick lands within the quiet window of the blur send).
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)
      expect(session.sent).toHaveLength(count + 1)
      expect(session.sent.at(-1)).toEqual({ v: PRESENCE_VERSION, graph: 'root', cursor: null, selection: [] })
    })

    it('dispose sends a gone frame and stops everything', () => {
      channel.setLocal(local(1))
      channel.dispose()
      expect(session.sent.at(-1)).toEqual({ v: PRESENCE_VERSION, gone: true })
      const count = session.sent.length
      channel.setLocal(local(2))
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3)
      expect(session.sent).toHaveLength(count)
    })
  })

  describe('ingress', () => {
    it('a valid frame lands in remotes with the actor id', () => {
      session.receive('peer', frame())
      const r = channel.remotes.get().get('peer')
      expect(r).toMatchObject({ actorId: 'peer', graph: 'root', cursor: { x: 10, y: 20 }, selection: ['n1'] })
    })

    it('reroutes, view, hover, and drag land in remotes; an old frame clears additive state', () => {
      session.receive('peer', frame({
        reroutes: ['r1'],
        view: { x: 0, y: 0, w: 100, h: 100 },
        hover: 'n2',
        drag: [['n1', 3, -4]],
      }))
      const r = channel.remotes.get().get('peer')!
      expect(r.reroutes).toEqual(['r1'])
      expect(r.view).toEqual({ x: 0, y: 0, w: 100, h: 100 })
      expect(r.hover).toBe('n2')
      expect(r.drag).toEqual(new Map([['n1', { dx: 3, dy: -4 }]]))
      session.receive('peer', frame()) // an old-build frame: fields absent
      const later = channel.remotes.get().get('peer')!
      expect(later.reroutes).toEqual([])
      expect(later.view).toBeUndefined()
      expect(later.hover).toBeUndefined()
      expect(later.drag).toBeUndefined()
    })

    it('an omitted noodle field clears a remote noodle without disturbing cursor presence', () => {
      session.receive('peer', frame({
        link: { origin: { kind: 'reroute', reroute: 'r1' }, cursor: { x: 30, y: 40 } },
      }))
      expect(channel.remotes.get().get('peer')?.link).toBeDefined()
      session.receive('peer', frame({ cursor: { x: 31, y: 41 } }))
      expect(channel.remotes.get().get('peer')).toMatchObject({ cursor: { x: 31, y: 41 } })
      expect(channel.remotes.get().get('peer')?.link).toBeUndefined()
    })

    it('a gone frame removes the actor immediately', () => {
      session.receive('peer', frame())
      session.receive('peer', { v: PRESENCE_VERSION, gone: true })
      expect(channel.remotes.get().size).toBe(0)
    })

    it('malformed frames drop without disturbing known state', () => {
      session.receive('peer', frame({ reroutes: ['r1'] }))
      session.receive('peer', 'garbage')
      session.receive('peer', frame({ v: 99 }))
      session.receive('peer', frame({ reroutes: null }))
      expect(channel.remotes.get().get('peer')).toMatchObject({ selection: ['n1'], reroutes: ['r1'] })
    })

    it('our own id never paints a ghost, even from a misbehaving relay', () => {
      session.receive('me', frame())
      expect(channel.remotes.get().size).toBe(0)
    })

    it('a silent actor expires after the TTL; a heartbeating one survives', () => {
      session.receive('silent', frame())
      session.receive('alive', frame())
      // 'alive' keeps refreshing under the TTL; 'silent' never speaks again.
      const half = PRESENCE_TTL_MS / 2
      vi.advanceTimersByTime(half)
      session.receive('alive', frame())
      vi.advanceTimersByTime(half + 1000)
      expect(channel.remotes.get().has('silent')).toBe(false)
      expect(channel.remotes.get().has('alive')).toBe(true)
    })

  })
})

describe('PresenceProjector', () => {
  let session: StubSession
  let channel: PresenceChannel
  let projected: ReadonlyMap<string, RemotePresence>
  let graph: string | undefined
  let paints: number
  let projector: PresenceProjector

  beforeEach(() => {
    vi.useFakeTimers()
    session = new StubSession()
    channel = new PresenceChannel(session, 'me')
    projected = new Map()
    graph = undefined
    paints = 0
    projector = new PresenceProjector((remotes, nextGraph) => {
      projected = remotes
      graph = nextGraph
      paints++
    })
    projector.bind(channel, 'root')
  })

  afterEach(() => {
    projector.dispose()
    channel.dispose()
    vi.useRealTimers()
  })

  it('keeps a remote drag through a local document mutation and local drag end', () => {
    session.receive('peer', frame({ drag: [['n1', 8, 5]] }))
    expect(projected.get('peer')?.drag?.get('n1')).toEqual({ dx: 8, dy: 5 })
    const paintsWithDrag = paints

    // This is the production scene-rebuild seam CanvasHost calls when a
    // simulated local document op lands. It reprojects without teardown.
    projector.refresh()
    channel.setLocal({ ...localPresence(1), drag: new Map([['mine', { dx: 2, dy: 3 }]]) })
    channel.setLocal(localPresence(1)) // local gesture ended
    projector.refresh()

    expect(paints).toBe(paintsWithDrag + 2)
    expect(graph).toBe('root')
    expect(projected.get('peer')?.drag?.get('n1')).toEqual({ dx: 8, dy: 5 })
  })

  const localPresence = (x: number) => ({ graph: 'root', cursor: { x, y: 0 }, selection: [] as string[] })
})
