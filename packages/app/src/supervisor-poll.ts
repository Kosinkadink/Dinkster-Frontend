/**
 * Supervisor poll loop, decoupled from AppState for testability (injected
 * probe + scheduler, no timers or fetch of its own).
 *
 * Lifecycle per native backend:
 * - probe /supervisor/status;
 * - 'absent' (server answered, no supervisor - standalone dinkster-serve):
 *   clear and stop for good; the WS connection status is the whole truth.
 * - 'unreachable': nothing answered. While the WS is also down keep a slow
 *   probe going (a supervisor may be about to bind, and it answers from the
 *   first millisecond); once the WS is connected the server is evidently
 *   reachable without one, so stop rather than poll standalone servers
 *   forever.
 * - 'status': render it. Starting and composition poll quickly; stable ready,
 *   failed, and stopped states remain under low-cadence observation so an
 *   engine death after startup is surfaced without relying on its WebSocket.
 *
 * onReady fires on every transition INTO ready (including the first probe
 * already being ready after an earlier engine-not-ready failure) so the app
 * can retry a schema fetch the 503 gate rejected.
 */
import type { SupervisorProbe, SupervisorStatus } from '@dinkster/client'

export interface SupervisorPollOptions {
  readonly probe: () => Promise<SupervisorProbe>
  /** Current WS connection status of the same backend. */
  readonly connected: () => boolean
  readonly get: () => SupervisorStatus | undefined
  readonly set: (status: SupervisorStatus | undefined) => void
  /** Engine just became ready: reload anything the 503 gate blocked. */
  readonly onReady: () => void
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
}

/** Poll cadence by what is being narrated. */
export const POLL_MS = {
  starting: 1_000,
  composing: 1_000, // ready + progress
  failed: 5_000,
  stopped: 5_000,
  ready: 5_000,
  unreachable: 3_000,
} as const

/** Start polling. Returns a cancel function (idempotent). */
export function pollSupervisor(opts: SupervisorPollOptions): () => void {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancelHandle = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let cancelled = false
  let pending: unknown
  const later = (ms: number): void => {
    pending = schedule(() => void step(), ms)
  }
  const step = async (): Promise<void> => {
    if (cancelled) return
    let probe: SupervisorProbe
    try {
      probe = await opts.probe()
    } catch {
      // Probes return 'unreachable' for network failures, so rejection is an
      // unexpected error that must not wedge the loop or escape unhandled.
      if (cancelled) return
      if (opts.connected()) {
        opts.set(undefined)
        return
      }
      later(POLL_MS.unreachable)
      return
    }
    if (cancelled) return
    switch (probe.kind) {
      case 'absent':
        opts.set(undefined)
        return
      case 'unreachable':
        if (opts.connected()) {
          opts.set(undefined)
          return
        }
        later(POLL_MS.unreachable)
        return
      case 'status': {
        const previous = opts.get()
        opts.set(probe.status)
        if (probe.status.state === 'ready') {
          if (previous?.state !== 'ready') opts.onReady()
          later(probe.status.progress === undefined ? POLL_MS.ready : POLL_MS.composing)
          return
        }
        later(POLL_MS[probe.status.state])
        return
      }
    }
  }
  void step()
  return () => {
    cancelled = true
    if (pending !== undefined) cancelHandle(pending)
  }
}
