import type { DesktopWindowContext, DesktopWindowLayout } from './desktop-bridge.js'
import { scopedSharedName } from './projects.js'

interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  close?(): void
}

type WindowMessage =
  | { readonly kind: 'join'; readonly context: DesktopWindowContext }
  | { readonly kind: 'leave'; readonly id: string }
  | { readonly kind: 'query' }

const HEARTBEAT_MS = 1_000
const WINDOW_EXPIRY_MS = HEARTBEAT_MS * 3

function decodeContext(value: unknown): DesktopWindowContext | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (row['id'] === 'primary' && row['kind'] === 'primary') return { id: 'primary', kind: 'primary' }
  if (typeof row['id'] !== 'string' || row['id'].length === 0) return undefined
  if (row['kind'] === 'workflow' && typeof row['workflowId'] === 'string' && row['workflowId'].length > 0) {
    return { id: row['id'], kind: 'workflow', workflowId: row['workflowId'] }
  }
  if (row['kind'] === 'panel' && typeof row['panelId'] === 'string' && row['panelId'].length > 0 &&
    (row['returnPlacement'] === 'dock' || row['returnPlacement'] === 'rail' || row['returnPlacement'] === 'bottom')) {
    return {
      id: row['id'], kind: 'panel', panelId: row['panelId'], returnPlacement: row['returnPlacement'],
    }
  }
  return undefined
}

function decodeMessage(value: unknown): WindowMessage | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (row['kind'] === 'query') return { kind: 'query' }
  if (row['kind'] === 'leave' && typeof row['id'] === 'string') return { kind: 'leave', id: row['id'] }
  if (row['kind'] === 'join') {
    const context = decodeContext(row['context'])
    if (context) return { kind: 'join', context }
  }
  return undefined
}

export interface BrowserWindowCoordinator {
  close(): void
}

export function coordinateBrowserWindows(
  context: DesktopWindowContext,
  publish: (layout: DesktopWindowLayout) => void,
  channel: ChannelLike = new BroadcastChannel(scopedSharedName('dinkster-workspace-windows')),
): BrowserWindowCoordinator {
  const windows = new Map<string, DesktopWindowContext>([[context.id, context]])
  const lastSeen = new Map<string, number>([[context.id, Date.now()]])
  const emit = (): void => publish({ windows: [...windows.values()] })
  const announce = (): void => channel.postMessage({ kind: 'join', context } satisfies WindowMessage)
  const receive = (event: MessageEvent<unknown>): void => {
    const message = decodeMessage(event.data)
    if (!message) return
    if (message.kind === 'query') {
      announce()
      return
    }
    if (message.kind === 'leave') {
      lastSeen.delete(message.id)
      if (windows.delete(message.id)) emit()
      return
    }
    lastSeen.set(message.context.id, Date.now())
    const previous = windows.get(message.context.id)
    windows.set(message.context.id, message.context)
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(message.context)) emit()
  }
  channel.addEventListener('message', receive)
  ;(channel as ChannelLike & { unref?: () => void }).unref?.()
  announce()
  channel.postMessage({ kind: 'query' } satisfies WindowMessage)
  emit()
  const heartbeat = setInterval(() => {
    announce()
    const expiredBefore = Date.now() - WINDOW_EXPIRY_MS
    let changed = false
    for (const [id, seen] of lastSeen) {
      if (id === context.id || seen >= expiredBefore) continue
      lastSeen.delete(id)
      changed = windows.delete(id) || changed
    }
    if (changed) emit()
  }, HEARTBEAT_MS)
  ;(heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    channel.postMessage({ kind: 'leave', id: context.id } satisfies WindowMessage)
    channel.removeEventListener('message', receive)
    globalThis.removeEventListener?.('pagehide', close)
    clearInterval(heartbeat)
    channel.close?.()
  }
  globalThis.addEventListener?.('pagehide', close, { once: true })
  return {
    close,
  }
}
