/**
 * Presence channel (docs/collaboration.md "Presence"): the app-owned payload
 * schema, throttled+heartbeated egress, validated ingress, TTL expiry, and
 * the gone frame on dispose. Timers and the clock run on vitest fake time -
 * the channel's cadence constants are asserted literally so a change to them
 * is a deliberate, test-visible decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Json } from '@dinkster/core'
import {
  actorColor,
  actorLabel,
  decodePresence,
  encodePresence,
  PresenceChannel,
  PresenceProjector,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_THROTTLE_MS,
  PRESENCE_TTL_MS,
  PRESENCE_VERSION,
  type RemotePresence,
  type PresenceSession,
} from '../src/collab-presence.js'

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

describe('decodePresence', () => {
  it('accepts a full frame', () => {
    expect(decodePresence(frame())).toEqual({ graph: 'root', cursor: { x: 10, y: 20 }, selection: ['n1'], reroutes: [] })
  })

  it('accepts old frames without noodle presence and new port, widget tap, or reroute noodle frames', () => {
    expect(decodePresence(frame())).not.toHaveProperty('link')
    expect(decodePresence(frame({
      link: { origin: { kind: 'port', node: 'n1', port: 'image', side: 'out' }, cursor: { x: 80, y: 90 } },
    }))).toMatchObject({
      link: { origin: { kind: 'port', node: 'n1', port: 'image', side: 'out' }, cursor: { x: 80, y: 90 } },
    })
    expect(decodePresence(frame({
      link: { origin: { kind: 'widgetTap', node: 'n1', input: 'amount' }, cursor: { x: 70, y: 75 } },
    }))).toMatchObject({
      link: { origin: { kind: 'widgetTap', node: 'n1', input: 'amount' }, cursor: { x: 70, y: 75 } },
    })
    expect(decodePresence(frame({
      link: { origin: { kind: 'reroute', reroute: 'r1', side: 'in' }, cursor: { x: 30, y: 40 } },
    }))).toMatchObject({
      link: { origin: { kind: 'reroute', reroute: 'r1', side: 'in' }, cursor: { x: 30, y: 40 } },
    })
    // Early additive-link frames omitted reroute direction; default output
    // orientation keeps them paintable without invalidating the frame.
    expect(decodePresence(frame({
      link: { origin: { kind: 'reroute', reroute: 'r1' }, cursor: { x: 30, y: 40 } },
    }))).not.toBeNull()
  })

  it('accepts a null cursor as off-canvas', () => {
    expect(decodePresence(frame({ cursor: null }))).toEqual({ graph: 'root', selection: ['n1'], reroutes: [] })
  })

  it('resolves a gone frame to the departure marker', () => {
    expect(decodePresence({ v: PRESENCE_VERSION, gone: true })).toBe('gone')
  })

  it('accepts the additive v1 fields: reroutes, view, hover, and drag (tuple form)', () => {
    const decoded = decodePresence(frame({
      reroutes: ['r1', 'r2'],
      view: { x: -5, y: 10, w: 800, h: 600 },
      hover: 'n2',
      drag: [['n1', 3, -4], ['n3', 3, -4]],
    }))
    expect(decoded).toMatchObject({ reroutes: ['r1', 'r2'], view: { x: -5, y: 10, w: 800, h: 600 }, hover: 'n2' })
    expect((decoded as Exclude<typeof decoded, string | null>).drag).toEqual(
      new Map([['n1', { dx: 3, dy: -4 }], ['n3', { dx: 3, dy: -4 }]]),
    )
  })

  it('ignores unknown fields (newer builds may add more)', () => {
    expect(decodePresence(frame({ futureField: { anything: true } }))).toMatchObject({ graph: 'root' })
  })

  it('accepts identity and tolerates its absence', () => {
    expect(decodePresence(frame())).not.toHaveProperty('identity')
    expect(decodePresence(frame({
      identity: { kind: 'agent', displayName: 'headless-demo', owner: 'Ada', harness: 'cli' },
    }))).toMatchObject({
      identity: { kind: 'agent', displayName: 'headless-demo', owner: 'Ada', harness: 'cli' },
    })
  })

  it('drops an invalid identity block without dropping the frame', () => {
    expect(decodePresence(frame({ identity: { kind: 'robot', displayName: 'future' } }))).toMatchObject({ graph: 'root' })
    expect(decodePresence(frame({ identity: 'agent' }))).toMatchObject({ graph: 'root' })
  })

  it('drops invalid and oversized identity strings as noise', () => {
    expect(decodePresence(frame({
      identity: { kind: 'agent', displayName: 'x'.repeat(65), owner: 7, harness: 'cli' },
    }))).toMatchObject({ identity: { kind: 'agent', harness: 'cli' } })
  })

  it('encodes identity and applies the string cap', () => {
    expect(encodePresence({
      graph: 'root',
      cursor: undefined,
      selection: [],
      identity: { kind: 'human', displayName: 'Ada', owner: 'x'.repeat(65) },
    })).toMatchObject({ identity: { kind: 'human', displayName: 'Ada' } })
  })

  it.each<[string, Json | undefined]>([
    ['not an object', 'hello'],
    ['undefined payload', undefined],
    ['an array', [1, 2]],
    ['wrong version', frame({ v: 99 })],
    ['missing graph', { v: PRESENCE_VERSION, cursor: null, selection: [] }],
    ['empty graph', frame({ graph: '' })],
    ['non-finite cursor', frame({ cursor: { x: 1 } })],
    ['selection not an array', frame({ selection: 'n1' })],
    ['non-string selection entry', frame({ selection: ['n1', 7] })],
    ['oversized selection', frame({ selection: Array.from({ length: 3000 }, (_, i) => `n${i}`) })],
    ['reroutes not an array', frame({ reroutes: 'r1' })],
    ['null reroutes', frame({ reroutes: null })],
    ['non-string reroute entry', frame({ reroutes: ['r1', 7] })],
    ['oversized reroutes', frame({ reroutes: Array.from({ length: 3000 }, (_, i) => `r${i}`) })],
    ['non-object view', frame({ view: 'big' })],
    ['non-finite view', frame({ view: { x: 0, y: 0, w: 100, h: 'tall' } })],
    ['zero-width view', frame({ view: { x: 0, y: 0, w: 0, h: 100 } })],
    ['negative-height view', frame({ view: { x: 0, y: 0, w: 100, h: -1 } })],
    ['non-string hover', frame({ hover: 7 })],
    ['empty hover', frame({ hover: '' })],
    ['drag not an array', frame({ drag: { n1: { dx: 1, dy: 2 } } })],
    ['drag entry not a tuple', frame({ drag: ['n1'] })],
    ['drag tuple wrong length', frame({ drag: [['n1', 1]] })],
    ['drag tuple non-string id', frame({ drag: [[7, 1, 2]] })],
    ['drag tuple non-finite offset', frame({ drag: [['n1', 1, 'far']] })],
    ['oversized drag', frame({ drag: Array.from({ length: 600 }, (_, i) => [`n${i}`, 1, 2]) })],
    ['noodle missing origin', frame({ link: { cursor: { x: 1, y: 2 } } })],
    ['noodle with invalid side', frame({ link: { origin: { kind: 'port', node: 'n1', port: 'p1', side: 'left' }, cursor: { x: 1, y: 2 } } })],
    ['widget tap noodle with non-string node', frame({ link: { origin: { kind: 'widgetTap', node: 7, input: 'amount' }, cursor: { x: 1, y: 2 } } })],
    ['widget tap noodle with non-string input', frame({ link: { origin: { kind: 'widgetTap', node: 'n1', input: 7 }, cursor: { x: 1, y: 2 } } })],
    ['reroute noodle with invalid side', frame({ link: { origin: { kind: 'reroute', reroute: 'r1', side: 'left' }, cursor: { x: 1, y: 2 } } })],
    ['noodle with non-finite cursor', frame({ link: { origin: { kind: 'reroute', reroute: 'r1' }, cursor: { x: 1, y: 'far' } } })],
  ])('drops %s', (_what, payload) => {
    expect(decodePresence(payload)).toBeNull()
  })
})

describe('actor identity helpers', () => {
  it('colors are deterministic and valid hsl', () => {
    expect(actorColor('alice')).toBe(actorColor('alice'))
    expect(actorColor('alice')).toMatch(/^hsl\(\d+ 70% 55%\)$/)
  })

  it('distinct actors usually get distinct hues', () => {
    const hues = new Set(['a1', 'b2', 'c3', 'd4', 'e5'].map(actorColor))
    expect(hues.size).toBeGreaterThan(3)
  })

  it('labels are a short prefix of the id', () => {
    expect(actorLabel('123e4567-e89b-12d3-a456-426614174000')).toBe('123e45')
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

    it('an unchanged state does not send (the heartbeat owns keep-alive)', () => {
      channel.setLocal(local(1))
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS * 3)
      channel.setLocal(local(1))
      expect(session.sent).toHaveLength(1)
    })

    it('heartbeats the last state while idle', () => {
      channel.setLocal(local(1))
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)
      expect(session.sent.length).toBe(3)
      expect(session.sent[2]).toMatchObject({ cursor: { x: 1, y: 0 } })
    })

    it('never heartbeats before any local state exists', () => {
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3)
      expect(session.sent).toEqual([])
    })

    it('a heartbeat tick right after a state send is skipped (throttle respected)', () => {
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS - 10)
      channel.setLocal(local(1)) // sends 10ms before the heartbeat tick
      vi.advanceTimersByTime(10) // tick: a full quiet interval has NOT passed
      expect(session.sent).toHaveLength(1)
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS) // next tick: it has
      expect(session.sent).toHaveLength(2)
    })

    it('encodes reroute selection, view, hover, and generic drag tuples', () => {
      channel.setLocal({
        graph: 'root',
        cursor: { x: 1, y: 2 },
        selection: [],
        reroutes: ['r1'],
        view: { x: -5, y: 10, w: 800, h: 600 },
        hover: 'n2',
        drag: new Map([['n1', { dx: 3, dy: -4 }]]),
      })
      expect(session.sent).toEqual([{
        v: PRESENCE_VERSION,
        graph: 'root',
        cursor: { x: 1, y: 2 },
        selection: [],
        reroutes: ['r1'],
        view: { x: -5, y: 10, w: 800, h: 600 },
        hover: 'n2',
        drag: [['n1', 3, -4]],
      }])
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

    it('round-trips a widget tap noodle origin through the presence payload', () => {
      const link = {
        origin: { kind: 'widgetTap' as const, node: 'n1', input: 'amount' },
        cursor: { x: 20, y: 30 },
      }
      channel.setLocal({ ...local(1), link })
      const sent = session.sent.at(-1)
      expect(sent).toMatchObject({ link })
      expect(decodePresence(sent)).toMatchObject({ link })
    })

    it('an empty drag map encodes as no drag field at all', () => {
      channel.setLocal({ ...local(1), drag: new Map() })
      expect(session.sent[0]).not.toHaveProperty('drag')
    })

    it('equal view/hover/drag values do not resend; a changed drag offset does', () => {
      const base = {
        graph: 'root',
        cursor: { x: 1, y: 0 },
        selection: [] as string[],
        view: { x: 0, y: 0, w: 100, h: 100 },
        hover: 'n1',
        drag: new Map([['n1', { dx: 1, dy: 1 }]]),
      }
      channel.setLocal(base)
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      // Fresh but value-equal objects: the comparison is structural.
      channel.setLocal({ ...base, view: { ...base.view }, drag: new Map([['n1', { dx: 1, dy: 1 }]]) })
      expect(session.sent).toHaveLength(1)
      channel.setLocal({ ...base, drag: new Map([['n1', { dx: 2, dy: 1 }]]) })
      expect(session.sent).toHaveLength(2)
      expect(session.sent[1]).toMatchObject({ drag: [['n1', 2, 1]] })
    })

    it('compares proposals by id and JSON content before publishing', () => {
      const proposals = [{ id: 'p1', settingId: 'canvas.grid.visible', value: { enabled: true, mode: 'quiet' }, note: 'Try this' }]
      channel.setLocal({ ...local(1), proposals })
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      channel.setLocal({ ...local(1), proposals: [{ ...proposals[0]!, value: { mode: 'quiet', enabled: true } }] })
      expect(session.sent).toHaveLength(1)

      channel.setLocal({ ...local(1), proposals: [{ ...proposals[0]!, value: { enabled: false } }] })
      expect(session.sent).toHaveLength(2)
      expect(session.sent[1]).toMatchObject({ proposals: [{ id: 'p1', value: { enabled: false } }] })
    })

    it('reroute selection participates in snapshot equality and clears by omission', () => {
      channel.setLocal({ ...local(1), reroutes: ['r1'] })
      vi.advanceTimersByTime(PRESENCE_THROTTLE_MS)
      channel.setLocal({ ...local(1), reroutes: ['r1'] })
      expect(session.sent).toHaveLength(1)
      channel.setLocal(local(1))
      expect(session.sent).toHaveLength(2)
      expect(session.sent[1]).not.toHaveProperty('reroutes')
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

    it('blur before any local state is a no-op', () => {
      channel.blur()
      vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
      expect(session.sent).toEqual([])
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

    it('a newer frame replaces the actor state', () => {
      session.receive('peer', frame())
      session.receive('peer', frame({ cursor: null, selection: ['n2'] }))
      const r = channel.remotes.get().get('peer')!
      expect(r.cursor).toBeUndefined()
      expect(r.selection).toEqual(['n2'])
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

    it('dispose forgets all remotes and detaches ingress', () => {
      session.receive('peer', frame())
      channel.dispose()
      expect(channel.remotes.get().size).toBe(0)
      session.receive('peer', frame())
      expect(channel.remotes.get().size).toBe(0)
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

  it('clears the remote drag only when that remote actor publishes gesture end', () => {
    session.receive('peer', frame({ drag: [['n1', 8, 5]] }))
    expect(projected.get('peer')?.drag).toBeDefined()

    session.receive('peer', frame())
    expect(projected.get('peer')?.drag).toBeUndefined()
  })

  const localPresence = (x: number) => ({ graph: 'root', cursor: { x, y: 0 }, selection: [] as string[] })
})
