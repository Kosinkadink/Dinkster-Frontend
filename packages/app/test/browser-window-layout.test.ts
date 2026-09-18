import { afterEach, describe, expect, it, vi } from 'vitest'
import { coordinateBrowserWindows } from '../src/browser-window-layout.js'
import type { DesktopWindowLayout } from '../src/desktop-bridge.js'

class Bus {
  readonly channels = new Set<MemoryChannel>()
  connect(): MemoryChannel {
    const channel = new MemoryChannel(this)
    this.channels.add(channel)
    return channel
  }
}

class MemoryChannel {
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
  private crashed = false
  constructor(private readonly bus: Bus) {}
  postMessage(data: unknown): void {
    if (this.crashed) return
    for (const peer of this.bus.channels) {
      if (peer === this) continue
      for (const listener of peer.listeners) listener({ data: structuredClone(data) } as MessageEvent<unknown>)
    }
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener)
  }
  close(): void { this.bus.channels.delete(this) }
  crash(): void {
    this.crashed = true
    this.bus.channels.delete(this)
  }
}

afterEach(() => vi.useRealTimers())

describe('browser window coordination', () => {
  it('publishes tear-out assignment and removes it when the child closes', () => {
    const bus = new Bus()
    let primaryLayout: DesktopWindowLayout | undefined
    const primary = coordinateBrowserWindows(
      { id: 'primary', kind: 'primary' },
      (layout) => { primaryLayout = layout },
      bus.connect(),
    )
    const child = coordinateBrowserWindows(
      { id: 'workflow-one', kind: 'workflow', workflowId: 'one' },
      () => {},
      bus.connect(),
    )

    expect(primaryLayout?.windows).toEqual([
      { id: 'primary', kind: 'primary' },
      { id: 'workflow-one', kind: 'workflow', workflowId: 'one' },
    ])
    child.close()
    expect(primaryLayout?.windows).toEqual([{ id: 'primary', kind: 'primary' }])
    primary.close()
  })

  it('ignores malformed window announcements', () => {
    const bus = new Bus()
    let count = 0
    const primary = coordinateBrowserWindows(
      { id: 'primary', kind: 'primary' },
      (layout) => { count = layout.windows.length },
      bus.connect(),
    )
    bus.connect().postMessage({ kind: 'join', context: { id: 'bad', kind: 'panel', panelId: 'queue', returnPlacement: 'modal' } })
    expect(count).toBe(1)
    primary.close()
  })

  it('removes a child whose channel disappears without a leave message', async () => {
    vi.useFakeTimers()
    const bus = new Bus()
    let primaryLayout: DesktopWindowLayout | undefined
    const primary = coordinateBrowserWindows(
      { id: 'primary', kind: 'primary' },
      (layout) => { primaryLayout = layout },
      bus.connect(),
    )
    const childChannel = bus.connect()
    const child = coordinateBrowserWindows(
      { id: 'workflow-one', kind: 'workflow', workflowId: 'one' },
      () => {},
      childChannel,
    )
    expect(primaryLayout?.windows).toHaveLength(2)
    childChannel.crash()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(primaryLayout?.windows).toEqual([{ id: 'primary', kind: 'primary' }])
    child.close()
    primary.close()
  })
})
