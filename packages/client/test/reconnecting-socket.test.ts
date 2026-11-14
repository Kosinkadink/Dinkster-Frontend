/**
 * ReconnectingSocket transport lifecycle: superseded-socket identity guards
 * and deliberate-teardown callback detachment. A stale
 * socket that opens or delivers after being replaced must never touch
 * current state or inject events.
 */
import { describe, expect, it } from 'vitest'
import { ReconnectingSocket, type WebSocketLike } from '../src/index.js'

class FakeWS implements WebSocketLike {
  binaryType = ''
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  sent: string[] = []
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
}

function harness() {
  const sockets: FakeWS[] = []
  const scheduled: (() => void)[] = []
  const received: unknown[] = []
  const socket = new ReconnectingSocket({
    url: 'ws://test',
    webSocketFactory: () => {
      const s = new FakeWS()
      sockets.push(s)
      return s
    },
    scheduleFn: (fn) => {
      scheduled.push(fn)
      return scheduled.length
    },
    cancelFn: () => {},
    onData: (data) => received.push(data),
  })
  return { socket, sockets, scheduled, received }
}

describe('CL3 socket identity guards', () => {
  it('suspends delivery and reconnects until resumed, without reviving a disconnected lifetime', () => {
    const { socket, sockets, scheduled, received } = harness()
    socket.connect()
    const first = sockets[0]!
    first.onopen?.({})
    const lateMessage = first.onmessage
    const resume = socket.suspend()
    lateMessage?.({ data: 'while suspended' })
    expect(received).toEqual([])
    expect(scheduled).toEqual([])
    expect(first.closed).toBe(true)
    resume()
    sockets[1]!.onopen?.({})
    sockets[1]!.onmessage?.({ data: 'resumed' })
    expect(received).toEqual(['resumed'])
    const staleResume = socket.suspend()
    socket.disconnect()
    staleResume()
    expect(sockets).toHaveLength(2)
    expect(socket.status.get()).toBe('disconnected')
  })

  it('ignores open and message from a superseded socket', () => {
    const { socket, sockets, scheduled, received } = harness()
    socket.connect()
    const a = sockets[0]!
    a.onclose?.({}) // transport died; a reconnect is scheduled
    scheduled.shift()!() // opens replacement socket B
    const b = sockets[1]!
    a.onopen?.({}) // stale open: must not flip status to connected
    expect(socket.status.get()).toBe('reconnecting')
    a.onmessage?.({ data: 'stale' }) // stale delivery: must not reach onData
    expect(received).toHaveLength(0)
    b.onopen?.({})
    expect(socket.status.get()).toBe('connected')
    b.onmessage?.({ data: 'live' })
    expect(received).toEqual(['live'])
  })

  it('FR-8 a queued reconnect callback surviving cancel never reopens after disconnect', () => {
    // cancelFn is best-effort: a scheduler may have already queued the
    // callback when disconnect() cancels the handle. The stale callback must
    // not open a socket into a deliberately closed transport.
    const { socket, sockets, scheduled } = harness()
    socket.connect()
    sockets[0]!.onclose?.({}) // transport died; reconnect queued
    expect(scheduled).toHaveLength(1)
    socket.disconnect() // cancel is a no-op in this harness: callback survives
    scheduled.shift()!() // the stale callback fires anyway
    expect(sockets).toHaveLength(1) // no zombie socket
    expect(socket.status.get()).toBe('disconnected')
  })

  it('FR-8 a stale reconnect callback never clears a newer cycle reconnect handle', () => {
    const { socket, sockets, scheduled } = harness()
    socket.connect()
    sockets[0]!.onclose?.({}) // queues stale callback #1
    socket.disconnect()
    socket.connect() // new cycle
    const b = sockets[1]!
    b.onclose?.({}) // queues live callback #2
    expect(scheduled).toHaveLength(2)
    scheduled.shift()!() // stale #1: must be inert
    expect(sockets).toHaveLength(2)
    scheduled.shift()!() // live #2: reconnects the current cycle
    expect(sockets).toHaveLength(3)
    sockets[2]!.onopen?.({})
    expect(socket.status.get()).toBe('connected')
  })

})
