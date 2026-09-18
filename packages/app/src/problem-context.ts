/**
 * Focus-to-context ownership model for the Context panel (#22).
 *
 * One pure derivation maps the shell's live focus facts (open widget
 * editor, canvas selection, subgraph navigation) to exactly one focused
 * context, and one pure partition decides which Problems entries belong to
 * that context. Both are deterministic: the same snapshot always yields the
 * same context, and a diagnostic belongs to a context by anchor/ref facts
 * alone. The priority order is documented in docs/problem-surfaces.md and
 * must stay in sync with it.
 *
 * Priority (most specific focus wins):
 *   widget > node selection > link selection > group selection
 *   > subgraph view > document
 */

import type { Diagnostic } from '@dinkster/core'

/** A selected canvas group with its member node ids resolved by the caller. */
export interface FocusedGroup {
  readonly id: string
  readonly title: string
  readonly members: readonly string[]
}

/** The live focus facts a shell snapshot supplies to the derivation. */
export interface FocusSnapshot {
  /** Open widget editor: node id plus the node.values key it writes. */
  readonly widget?: { readonly nodeId: string; readonly valueKey: string; readonly label: string } | undefined
  /** Selected node ids in the graph currently shown. */
  readonly nodes: readonly string[]
  /** Selected link ids in the graph currently shown. */
  readonly links: readonly string[]
  /** Selected groups with resolved members. */
  readonly groups: readonly FocusedGroup[]
  /** Graph definition currently shown. */
  readonly graphId: string
  /** The document's root graph definition. */
  readonly rootGraphId: string
  /**
   * Instance node ids from the root to the shown graph ([] at the root).
   * Undefined when navigation signals are out of sync; occurrence-exact
   * matching then abstains (see viewInstancePath).
   */
  readonly instancePath: readonly string[] | undefined
}

export type FocusContext =
  | { readonly kind: 'widget'; readonly nodeId: string; readonly valueKey: string; readonly label: string }
  | { readonly kind: 'node'; readonly nodeIds: readonly string[] }
  | { readonly kind: 'link'; readonly linkIds: readonly string[] }
  | { readonly kind: 'group'; readonly groups: readonly FocusedGroup[] }
  | { readonly kind: 'subgraph'; readonly graphId: string; readonly instancePath: readonly string[] }
  | { readonly kind: 'document' }

/**
 * Derive the single focused context from a snapshot. Pure and total: every
 * snapshot maps to exactly one context, falling through the priority order
 * to the whole document.
 */
export function deriveFocusContext(snapshot: FocusSnapshot): FocusContext {
  if (snapshot.widget !== undefined) {
    return { kind: 'widget', nodeId: snapshot.widget.nodeId, valueKey: snapshot.widget.valueKey, label: snapshot.widget.label }
  }
  if (snapshot.nodes.length > 0) return { kind: 'node', nodeIds: snapshot.nodes }
  if (snapshot.links.length > 0) return { kind: 'link', linkIds: snapshot.links }
  if (snapshot.groups.length > 0) return { kind: 'group', groups: snapshot.groups }
  if (snapshot.graphId !== snapshot.rootGraphId && snapshot.instancePath !== undefined && snapshot.instancePath.length > 0) {
    return { kind: 'subgraph', graphId: snapshot.graphId, instancePath: snapshot.instancePath }
  }
  return { kind: 'document' }
}

const sameInstancePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((hop, index) => hop === b[index])

const pathHasPrefix = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((hop, index) => hop === path[index])

/**
 * Whether a diagnostic points at one of `nodeIds` in the view described by
 * `graphId`/`instancePath`. Anchors take precedence over presentation refs:
 * occurrence anchors must match the view path exactly (when it is known),
 * port anchors are view-relative by convention, and refs match by node id
 * plus an optional graph id check.
 */
function matchesNodes(
  diagnostic: Diagnostic,
  nodeIds: ReadonlySet<string>,
  graphId: string,
  instancePath: readonly string[] | undefined,
): boolean {
  const occurrence = diagnostic.anchor?.occurrence
  if (occurrence !== undefined) {
    return nodeIds.has(occurrence.node)
      && (instancePath === undefined || sameInstancePath(occurrence.instancePath, instancePath))
  }
  const port = diagnostic.anchor?.port
  if (port !== undefined) return nodeIds.has(port.node)
  return (diagnostic.refs ?? []).some(
    (ref) => ref.nodeId !== undefined && nodeIds.has(ref.nodeId) && (ref.graphId === undefined || ref.graphId === graphId),
  )
}

/** Widget ownership: the diagnostic names the node AND that input/value key. */
function matchesWidget(
  diagnostic: Diagnostic,
  nodeId: string,
  valueKey: string,
): boolean {
  const port = diagnostic.anchor?.port
  if (port !== undefined && port.node === nodeId && (port.port as string) === valueKey) return true
  const occurrence = diagnostic.anchor?.occurrence
  const nodeNamed = occurrence?.node === nodeId || port?.node === nodeId
  return (diagnostic.refs ?? []).some((ref) =>
    (ref.nodeId === nodeId || (ref.nodeId === undefined && nodeNamed))
    && (ref.portId === valueKey || ref.valueKey === valueKey),
  )
}

/**
 * The Problems entries belonging to `context`, in the caller's order. The
 * caller passes the same owner-scoped diagnostics list the whole-document
 * panel shows; the document context therefore keeps every entry.
 */
export function contextProblems<T extends Diagnostic>(
  context: FocusContext,
  diagnostics: readonly T[],
  view: { readonly graphId: string; readonly instancePath: readonly string[] | undefined },
): readonly T[] {
  switch (context.kind) {
    case 'document':
      return diagnostics
    case 'widget':
      return diagnostics.filter((d) => matchesWidget(d, context.nodeId, context.valueKey))
    case 'node': {
      const ids = new Set(context.nodeIds)
      return diagnostics.filter((d) => matchesNodes(d, ids, view.graphId, view.instancePath))
    }
    case 'link':
      return diagnostics.filter((d) => d.anchor?.link !== undefined && context.linkIds.includes(d.anchor.link))
    case 'group': {
      const members = new Set(context.groups.flatMap((group) => group.members))
      return diagnostics.filter((d) => matchesNodes(d, members, view.graphId, view.instancePath))
    }
    case 'subgraph':
      return diagnostics.filter((d) => {
        const occurrence = d.anchor?.occurrence
        if (occurrence !== undefined) return pathHasPrefix(occurrence.instancePath, context.instancePath)
        if (d.anchor?.port !== undefined) return true // port anchors are view-relative
        return (d.refs ?? []).some((ref) => ref.graphId === context.graphId)
      })
  }
}

/**
 * Whether a diagnostic names a context the Focused panel can be focused on
 * (an occurrence or port anchor resolving to a node). The whole-document
 * panel offers "Show in Focused" exactly for these entries.
 */
export const hasOwningContext = (diagnostic: Diagnostic): boolean =>
  diagnostic.anchor?.occurrence !== undefined || diagnostic.anchor?.port !== undefined
