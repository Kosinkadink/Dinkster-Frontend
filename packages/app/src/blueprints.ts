/**
 * Blueprint body cache: decoded workflow documents for pack-shipped
 * blueprints, fetched from GET /api/packs/{packId}/blueprints/{id}
 * (backend commit ed5fdf6) and validated ONCE through loadDocument.
 *
 * The endpoint contract makes decode-once-cache-forever safe: the digest
 * in the descriptor is immutable content identity (also the ETag) - bytes
 * for a digest never change, so entries key by digest alone and a changed
 * blueprint arrives as a NEW digest. Bodies are <= 1 MiB by backend cap.
 *
 * Pack blueprint bodies are sha256-addressed, not blake3. The two identity
 * domains must never mix.
 *
 * A DEFINITIVE miss (404, non-OK, unparseable JSON, document that fails
 * loadDocument) is negative-cached per digest; a transport failure leaves no
 * record so the next attempt retries naturally.
 */

import {
  defaultValuesOf,
  diag,
  documentResolver,
  loadDocument,
  materializeBlueprint,
  type CommandInvocation,
  type Diagnostic,
  type Json,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import type { FetchLike } from '@dinkster/client'

/** Decoded documents are small; 64 cached bodies is plenty for a session. */
const BODY_CACHE_MAX = 64

type Entry =
  | { readonly state: 'pending'; readonly promise: Promise<WorkflowDocument | undefined> }
  | { readonly state: 'ready'; readonly document: WorkflowDocument }
  | { readonly state: 'failed' }

export class BlueprintBodyCache {
  private readonly fetchFn: FetchLike
  /** digest -> entry; insertion order doubles as eviction age order. */
  private readonly entries = new Map<string, Entry>()

  constructor(opts?: { fetchFn?: FetchLike }) {
    this.fetchFn = opts?.fetchFn ?? ((url, init) => fetch(url, init))
  }

  /**
   * The validated document for a blueprint, fetching on first use.
   * Returns undefined on any failure (definitive failures stay cached;
   * transport failures retry on the next call). Concurrent callers for
   * one digest share a single fetch.
   */
  load(
    baseUrl: string,
    packId: string,
    blueprintId: string,
    digest: string,
  ): Promise<WorkflowDocument | undefined> {
    const existing = this.entries.get(digest)
    if (existing?.state === 'ready') return Promise.resolve(existing.document)
    if (existing?.state === 'failed') return Promise.resolve(undefined)
    if (existing?.state === 'pending') return existing.promise

    const url = `${baseUrl}/api/packs/${encodeURIComponent(packId)}/blueprints/${encodeURIComponent(blueprintId)}`
    const promise = this.fetchFn(url)
      .then(async (res) => {
        if (!res.ok) {
          // The descriptor promised bytes the server won't serve:
          // definitive for THIS digest; a reload/new digest retries.
          this.entries.set(digest, { state: 'failed' })
          return undefined
        }
        let json: unknown
        try {
          json = JSON.parse(await res.text())
        } catch {
          this.entries.set(digest, { state: 'failed' })
          return undefined
        }
        // Backend validates JSON-ness only, never document semantics -
        // format validation is OURS, here, once per digest.
        const loaded = loadDocument(json)
        if (!loaded.document) {
          this.entries.set(digest, { state: 'failed' })
          return undefined
        }
        this.entries.set(digest, { state: 'ready', document: loaded.document })
        this.evict()
        return loaded.document
      })
      .catch(() => {
        // Transport failure: clear the slot so the next attempt retries.
        this.entries.delete(digest)
        return undefined
      })
    this.entries.set(digest, { state: 'pending', promise })
    return promise
  }

  private evict(): void {
    while (this.entries.size > BODY_CACHE_MAX) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }
}

/**
 * Outcome of a delayed blueprint insertion. Everything except 'inserted'
 * commits NOTHING. 'no-body' and 'materialize-failed' are user-visible
 * failures of a live gesture and worth surfacing; the stale-* refusals
 * mean ownership moved during the fetch (the gesture's coordinates and
 * link-drop context no longer apply anywhere) and stay silent.
 */
export type BlueprintInsertOutcome =
  | 'inserted'
  | 'rejected'
  | 'no-body'
  | 'stale-tab'
  | 'stale-graph'
  | 'stale-owner'
  | 'graph-missing'
  | 'materialize-failed'

/**
 * The delayed half of a blueprint insertion, with invocation-time
 * ownership held across the body fetch. The caller captures the owner before
 * the await - the exact Tab object (identity, never id:
 * a same-id replacement must not inherit the gesture) and the graph the
 * gesture happened in (its world position and link-drop context are
 * meaningful only there) - and supplies owner-scoped probes that are
 * evaluated only AFTER the fetch resolves. Ownership is checked before
 * payload: a failed fetch for a dead owner is a dead owner, and no probe
 * below runs against a replacement.
 *
 * On success the import + node.add (+ link-drop connect) commit as ONE
 * batch against the owner document AS OF NOW - ids allocate against the
 * exact revision the batch dispatches into, same turn, per
 * materializeBlueprint's contract.
 */
export const insertBlueprintIntoTab = async (p: {
  /** The body fetch (digest-cached) - the await ownership must survive. */
  readonly loadBody: () => Promise<WorkflowDocument | undefined>
  /** Graph the gesture happened in, captured BEFORE the fetch. */
  readonly graphId: string
  /** Insertion position in that graph's world coordinates (pre-rounded). */
  readonly position: { readonly x: number; readonly y: number }
  /** Whether the EXACT invoking Tab object is still open. */
  readonly tabStillOpen: () => boolean
  /** The invoking tab's current graph id (owner-scoped, not active-tab). */
  readonly currentGraphId: () => string
  /**
   * Whether the graph INCARNATION the gesture happened in is still the one
   * in the document. Graph ids are reusable (an undo of an import frees
   * 'g<n>' for the next import to re-key onto), so id equality alone
   * cannot prove ownership - the caller watches the owner document during
   * the fetch and latches false if the captured graph is ever absent; a
   * later same-id recreation must not inherit the gesture.
   */
  readonly graphStillOwned: () => boolean
  /** Backend, schema registry, and frozen state still match click-time ownership. */
  readonly ownerStillCurrent: () => boolean
  /** The invoking tab's document at commit time. */
  readonly doc: () => WorkflowDocument
  /** Session-owned prediction for the next node id in the captured graph. */
  readonly predictedNodeId: () => string | undefined
  /**
   * The invoking tab's registry resolver at commit time - the OWNER's,
   * never the active tab's (the user may have switched tabs during the
   * fetch). Undefined while schemas are still loading: the insert still
   * commits, it just carries no widget defaults.
   */
  readonly resolveType: () => ((type: string) => NodeSchema | undefined) | undefined
  /** Link-drop connect invocations for the new node (empty when none). */
  readonly connect: (nodeId: string, schema: NodeSchema | undefined) => readonly CommandInvocation[]
  /** Owner-routed dispatch (dispatchTo the invoking tab); true on ok. */
  readonly dispatch: (invocation: CommandInvocation) => boolean
  /** Called with the new node id after an ok commit. */
  readonly onInserted: (nodeId: string) => void
}): Promise<BlueprintInsertOutcome> => {
  const body = await p.loadBody()
  // Ownership BEFORE payload checks (the AP6 discipline).
  if (!p.tabStillOpen()) return 'stale-tab'
  if (!p.graphStillOwned() || p.currentGraphId() !== p.graphId) return 'stale-graph'
  if (!p.ownerStillCurrent()) return 'stale-owner'
  if (!body) return 'no-body'
  const doc = p.doc()
  const def = doc.graphs[p.graphId]
  if (!def) return 'graph-missing'
  const expectedId = p.predictedNodeId()
  if (expectedId === undefined) return 'graph-missing'
  // Materialize against the document AS OF NOW (it may have changed during
  // the fetch); fresh definition ids allocate against this exact revision.
  const m = materializeBlueprint(doc, body)
  if (!m.ok) return 'materialize-failed'
  // Defaults derive from the blueprint's own namespace: boundary item ids
  // survive the re-key, so the derived defaults transfer as-is.
  const resolveType = p.resolveType()
  const resolve = resolveType ? documentResolver(body, resolveType) : () => undefined
  const schema = resolve(`#${body.root}`)
  const values = schema ? (defaultValuesOf(schema) as Record<string, Json>) : {}
  const ok = p.dispatch({
    command: 'batch',
    params: {
      invocations: [
        {
          command: 'subgraph.import',
          params: { graphs: m.graphs, view: m.view } as unknown as Json,
        },
        {
          command: 'node.add',
          params: {
            graphId: p.graphId,
            type: `#${m.rootId}`,
            position: { x: p.position.x, y: p.position.y },
            values,
          },
        },
        ...p.connect(expectedId, schema),
      ],
    } as unknown as Json,
  })
  if (!ok) return 'rejected'
  p.onInserted(expectedId)
  return 'inserted'
}

/**
 * The Problems diagnostic for a delayed insertion outcome, or undefined
 * when nothing should surface: stale-* refusals are silent by design (the
 * user already moved on; the gesture's coordinates apply nowhere), and
 * 'rejected' mirrors the synchronous palette path, where a rejected commit
 * is not a Problems event.
 */
export const blueprintFailureDiagnostic = (
  outcome: BlueprintInsertOutcome,
  blueprintName: string,
  packId: string,
): Diagnostic | undefined => {
  if (outcome === 'no-body') {
    return diag('error', 'import', 'blueprint.loadFailed', `blueprint '${blueprintName}' could not be loaded from pack '${packId}'`)
  }
  if (outcome === 'materialize-failed') {
    return diag('error', 'import', 'blueprint.insertFailed', `blueprint '${blueprintName}' could not be inserted into this document`)
  }
  return undefined
}
