export const POINTER_TRACE_CAPACITY = 512

export type PointerTraceReason =
  | 'pointerdown'
  | 'pointerup'
  | 'synthetic-buttons0'
  | 'pointerdown-repress'
  | 'wheel-buttons0'
  | 'mouseup-fallback'
  | 'pointercancel-release'
  | 'pointercancel-strict-commit'
  | 'pointercancel-cancel'
  | 'lostpointercapture-commit'
  | 'lostpointercapture-cancel'
  | 'escape'
  | 'blur'
  | 'scene-replaced'
  | 'selection-owner-changed'
  | 'dispose'
  | 'contextmenu'
  | 'touch-nav-takeover'

export interface PointerTraceEventEntry {
  readonly seq: number
  readonly t: number
  readonly type: string
  readonly pointerId: number
  readonly pointerType: string
  readonly buttons: number
  readonly button: number
  readonly clientX: number
  readonly clientY: number
  readonly viaWindow: boolean
}

export interface PointerTraceGestureEntry {
  readonly seq: number
  readonly t: number
  readonly gestureKind: string
  readonly event: 'start' | 'commit' | 'cancel'
  readonly reason: PointerTraceReason
}

export type PointerTraceEntry = PointerTraceEventEntry | PointerTraceGestureEntry

/** Opt-in diagnostic recorder. The disabled hot path is one boolean check. */
export class PointerTrace {
  private enabled = false
  private seq = 0
  private readonly entries: PointerTraceEntry[] = []

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }

  clear(): void {
    this.entries.length = 0
    this.seq = 0
  }

  dump(): readonly PointerTraceEntry[] {
    return [...this.entries]
  }

  recordPointer(event: PointerEvent, viaWindow: boolean): void {
    if (!this.enabled) return
    this.push({
      seq: ++this.seq,
      t: performance.now(),
      type: event.type,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      buttons: event.buttons,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      viaWindow,
    })
  }

  recordGesture(
    gestureKind: string,
    event: 'start' | 'commit' | 'cancel',
    reason: PointerTraceReason,
  ): void {
    if (!this.enabled) return
    this.push({ seq: ++this.seq, t: performance.now(), gestureKind, event, reason })
  }

  private push(entry: PointerTraceEntry): void {
    if (this.entries.length === POINTER_TRACE_CAPACITY) this.entries.shift()
    this.entries.push(entry)
  }
}
