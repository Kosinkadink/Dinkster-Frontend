/**
 * Delayed clipboard paste with ownership discipline.
 *
 * navigator.clipboard.readText() is an await: between the paste gesture
 * and the text arriving, the user may close the invoking tab, navigate to
 * a different graph, or start an execution that freezes the tab. The
 * helper captures the gesture's owners BEFORE the read and refuses to
 * commit when any of them changed - stale work must never mutate whoever
 * owns the canvas when the read completes.
 *
 * Ownership probes are supplied by the caller so this stays testable
 * without a DOM: tabStillOpen must check the EXACT invoking Tab object
 * (identity, not id - closed-and-reopened ids are different owners), and
 * currentGraphId/frozen/doc/dispatch must all be scoped to that same tab,
 * never to the active tab.
 */

import {
  isDinksterClipboardEnvelope,
  planClipboardPaste,
  type CommandInvocation,
  type DinksterClipboardEnvelope,
  type ExternalIncomingStub,
  type WorkflowDocument,
} from '@dinkster/core'

export type ClipboardPasteOutcome =
  /** The plan committed; onPasted ran with the fresh ids. */
  | 'pasted'
  /** Nothing readable on the clipboard (denied read with no fallback). */
  | 'no-text'
  /** Text present but not a Dinkster clipboard envelope (silent by design). */
  | 'unrecognized'
  /** Envelope was empty or the anchor/graph could not host a plan. */
  | 'no-plan'
  /** The invoking tab closed during the clipboard read. */
  | 'stale-tab'
  /** The invoking tab navigated to a different graph during the read. */
  | 'stale-graph'
  /** The invoking tab became read-only (execution view) during the read. */
  | 'frozen'
  /** The command dispatch refused the plan. */
  | 'rejected'

export const pasteClipboardIntoTab = async (p: {
  /** The clipboard read (system clipboard with in-memory fallback). */
  readonly readText: () => Promise<string | undefined>
  /** Graph the gesture happened in, captured BEFORE the read. */
  readonly graphId: string
  /** Paste anchor in that graph's world coordinates. */
  readonly anchor: { readonly x: number; readonly y: number } | undefined
  /** Recreate valid v2 links feeding the copied targets. Ordinary paste is false. */
  readonly connectInputs?: boolean
  /** Allocation scope stamped by a shared session; absent for local sessions. */
  readonly actor?: string
  /** App-owned proof that the copied source node still has the same incarnation. */
  readonly acceptExternal?: (envelope: DinksterClipboardEnvelope, stub: ExternalIncomingStub) => boolean
  /** Whether the EXACT invoking Tab object is still open. */
  readonly tabStillOpen: () => boolean
  /** Whether the invoking tab is read-only at commit time. */
  readonly frozen: () => boolean
  /** The invoking tab's current graph id (owner-scoped, not active-tab). */
  readonly currentGraphId: () => string
  /**
   * Whether the graph INCARNATION the gesture happened in is still the one
   * in the document. Graph ids are reusable (an undo of an import frees
   * 'g<n>' for the next import to re-key onto), so id equality alone
   * cannot prove ownership - the caller watches the owner document during
   * the read and latches false if the captured graph is ever absent; a
   * later same-id recreation must not inherit the gesture (the AP7
   * blueprint contract, applied to the clipboard).
   */
  readonly graphStillOwned: () => boolean
  /** The invoking tab's document at commit time. */
  readonly doc: () => WorkflowDocument
  /** Owner-routed dispatch (dispatchTo the invoking tab); true on ok. */
  readonly dispatch: (invocation: CommandInvocation) => boolean
  /** Called with the fresh ids after an ok commit. */
  readonly onPasted: (nodeIds: readonly string[], rerouteIds: readonly string[]) => void
}): Promise<ClipboardPasteOutcome> => {
  const text = await p.readText()
  // Ownership BEFORE payload checks (the AP6 discipline).
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId) return 'stale-graph'
  if (p.frozen()) return 'frozen'
  if (text === undefined) return 'no-text'
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'unrecognized'
  }
  if (!isDinksterClipboardEnvelope(parsed)) return 'unrecognized'
  // Plan against the owner document AS OF NOW: ids allocate against the
  // exact revision the invocation dispatches into, same turn.
  const plan = planClipboardPaste(
    p.doc(), p.graphId, parsed, p.anchor, p.actor, p.connectInputs === true,
    p.acceptExternal === undefined ? undefined : (stub) => p.acceptExternal!(parsed as DinksterClipboardEnvelope, stub),
  )
  if (!plan) return 'no-plan'
  if (!p.dispatch(plan.invocation)) return 'rejected'
  p.onPasted(plan.nodeIds, plan.rerouteIds)
  return 'pasted'
}
