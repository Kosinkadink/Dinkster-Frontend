# Problem surfaces

Problems appear in the right-side Problems panel and its indicator. By
default the panel shows every current problem, grouped by user action, with
anchored navigation. Selection only narrows the list to the current canvas
selection. It starts off and is not persisted. The indicator always counts
the complete list, even while Selection only is enabled.

Both read the same composed diagnostics list: solver diagnostics,
owner-scoped live problems, and the active execution's artifact diagnostics
and errors. The separate Focused panel is removed.

## Problems sections

The panel shows only non-empty sections, in this order:

1. **Execution**: runtime failures and validation rejects.
2. **This workflow**: compile, document consistency, and environment problems.
3. **Upgraded on open**: import notices; dismissable, never persisted, and
   cleared when the workflow is saved or its tab closes.
4. **Packs and backend**: schema, extension, command, compatibility and
   unavailable inference problems.
5. **Collaboration**: shared-session problems.

Information notices remain visible. Problems rows have a severity
icon and a single-line producer message naming the thing and its cause. Expanding the
row reveals the diagnostic code and any debug payload or traceback; hovering
the summary reveals its complete producer message without repeating the row text.
Clicking an anchored Problems row also navigates to its owner. Section
disclosure remains independent of row disclosure. Adding or removing other
diagnostics, including in the same section, preserves unchanged rows'
disclosure and text selection so expanded repair actions remain available.
Identical diagnostic snapshots also retain row disclosure when a workflow's
shared-session promotion briefly removes and rechecks its asset diagnostics.

When a queue attempt is refused, a Product error toast repeats the Problems
indicator summary and lists counts by severity. Show Problems opens the
Problems panel directly, including when its tab is in overflow. Dismiss or a
new queue attempt clears the toast; switching documents hides another
document's refusal. Queue eligibility and diagnostic codes are unchanged.

Native backend pack failures are restored from the process-lifetime
`/api/composition` snapshot on schema load, refresh, and reconnect. A later
healthy snapshot clears only that backend's pack failures, leaving unrelated
app and document problems intact.

A resident-value connection between packs in different processes marks the
consumer node Unavailable before Run. Its problem names both packs and offers
admission to the shared inference process or an engine-run owner node on a
reference. Connections within one process and transferable asset references
remain available. Process affinity comes from the current backend catalog,
not the saved workflow. A host-declared `unavailableReason` also marks the node
Unavailable and blocks submission, preserving the exact reason in its problem.
The live canvas derives these availability problems without queueing a job;
region ports, state feedback and exports retain their original producer affinity.

Node badge popovers stay open through background overlay updates while the
same document, graph occurrence, badge and on-screen anchor remain valid.
This applies to expanded and minimized nodes. Moving or removing the badge,
changing its document or graph, or dismissing the popover closes it. A
deprecation warning therefore remains available for an explicit replacement
decision even when previews or diagnostics refresh.

Saving records each used node type's host-attributed pack and the pack's
version in the workflow's `environment.nodes` and `environment.packs` tables.
When a used node is unavailable on the current backend, saving retains its
last recorded attribution and pack version rather than losing that information.
Available types refresh from the live catalog; removed types and packs are not
included in a refreshed stamp. These records do not grant install or download
permission and do not change the workflow's execution identity.

Opening a live workflow on a connected native backend requests a read-only
requirement plan using that backend's declared engine variant. Missing packs
with their saved versions, asset digests and resolver leads appear together
in one expandable workflow notice. An empty plan adds no notice or prompt.
Opening never grants installation or acquisition consent and never changes
the saved document. Unavailable plans are reported as warnings; historical
stamps remain advisory rather than an execution gate. A response for a closed,
replaced or edited tab is discarded.

A pack that declared samplers or schedulers but composed with no native
sampling worker live keeps its nodes, routes and events and reports its
inference surface as unavailable. `/api/diagnostics` carries one
`packInferenceUnavailable` entry per such pack (reason plus the refused
provider ids), and the Problems tab shows each pack and its reason under
Packs and backend, with provider ids in the expanded detail. The notice
is advisory: those ids are refused when a plan references them, and the
advisory disappears once the pack composes with a live worker.

## Missing model downloads

When submission needs a digest-backed model, the acquisition consent dialog
shows its name, source host and full declared source URLs, size when known, and
the backend's planned **Download folder** when provided. Review the repository,
revision and file in a provider URL as well as its host before consenting.
The folder remains visible while acquisition and the captured submission retry
are busy. Choose only the exact assets to acquire;
closing the busy view does not cancel the active retry. Successful acquisition
closes the dialog and continues submission. Failed acquisition returns its
updated plan or reports the refusal in Problems. Older backends and packaged
assets without a destination keep their existing presentation.

For a filename-based model with no single known source, Review source opens
source selection in the same dialog. Choose a suggested source or enter a
Hugging Face HTTPS resolve URL or Civitai model/download URL for the required
filename, then review again. Civitai model URLs can specify modelVersionId;
ambiguous versions return individual file choices that require another review.
Review resolves the immutable revision, hash, exact size and destination without
downloading. Editing the source clears the previous reviewed consent; Download
requires a fresh review. Credential changes also clear reviewed consent while
preserving the entered source. Source editing is disabled during review and
active transfers. Download never runs the graph; Run once retries only the
captured submission after its models are verified.

The displayed folder belongs to the serving backend, which can be another
machine. It is not a browser download directory and is not saved into the
workflow.

## Focus-to-context ownership

Selection only derives its context from live shell facts with the pure
`deriveFocusContext` function in `packages/app/src/problem-context.ts`.
Reading focus never mutates the document. A context description appears above
the filtered list. Nothing selected shows an empty state rather than falling
back to the current subgraph or document.

Priority order, most specific wins:

1. **Widget** - a widget editor is open on canvas. The context is that
   node + value key.
2. **Node selection** - one or more nodes are selected.
3. **Link selection** - one or more links are selected (and no nodes).
4. **Group selection** - one or more groups are selected (and no nodes or
   links). Members resolve geometrically through the canvas bridge.

A canvas selection containing several entity kinds resolves to the most
specific non-empty tier (nodes beat links beat groups). The shared derivation
also represents document and subgraph contexts, but Selection only treats
those as no selection.

## Problem partition

`contextProblems` (same module, also pure) decides which entries belong to a
context by anchor and ref facts alone:

- **Widget**: the diagnostic names that node AND that input/value key (a
  port anchor on the key, or a ref carrying the port id or value key).
- **Node selection**: occurrence anchors matching a selected node - with the
  view's exact instance path when it is known - plus port anchors and
  graph-scoped refs naming a selected node.
- **Link selection**: link anchors matching a selected link id.
- **Group selection**: node matching over the union of member nodes.
- **Subgraph view**: occurrence anchors at or below the view's instance
  path, view-relative port anchors, and refs naming the viewed graph.
- **Document**: everything.

## Navigation

Problems rows with an owning context (an occurrence, port or link anchor)
offer **Show on canvas**. It restores the owning graph view, selects the node
or link, and centers the camera. Link-only anchors resolve in the current
graph, including the current subgraph instance. This changes only view state,
never the document.

## Localization boundary

The Problems headings, section names, context-kind labels, empty states, counts,
navigation actions, entity and endpoint wrappers,
chrome, and diagnostic-code accessible label follow the active locale while
the panels remain mounted. Locale changes preserve disclosure, selection,
focus targets, context and row identity, active document and graph navigation,
and never refresh schemas, diagnostics, execution, or values. Workflow, graph,
tab, widget, node, group, and endpoint names and ids remain raw source data, as
do diagnostic severities, codes, messages, hints, suggestions,
tracebacks, compatibility pack/node ids, and refusal reasons.

## Indicator

`PanelDescriptor.indicator` is a generic hook: any panel may supply a live
`{ count, severity, label }` and every host chrome renders it - the dock tab
strip badge follows the panel wherever it is placed. Badges render nothing
at count 0, so the indicator clears itself when the last problem resolves.
The visible number is presentation-only; the accessible name is the
indicator's label (for example "3 problems, worst severity error").

Aggregation keeps the attention discoverable in every zone state:

- **Tab visible, inactive**: the badge sits on the tab itself.
- **Tab clipped into the all-tabs menu** (narrow zone): the clipped tabs'
  indicators aggregate (counts sum, worst severity wins) onto the all-tabs
  trigger, and each menu entry shows its own badge.
- **Rail collapsed**: the right-rail toggle aggregates ALL rail panels'
  indicators, whatever their tab state.

## Tests

- `packages/app/test/problem-context.test.ts` - derivation priority and
  partition rules, per context kind.
- `packages/app/test/shell-chrome.dom.test.tsx` - descriptor indicators on
  dock tabs, active or not, clearing at zero.
- `packages/app/test/panels.test.ts` - indicator aggregation.
- `packages/app/test/ProblemsPanel.dom.test.tsx` - selection filtering,
  empty selection, canvas navigation, and mounted locale continuity.
- `packages/e2e/tests/problems-focus.spec.ts` - mounted locale changes,
  preserved raw diagnostic and compatibility data, stable disclosure and
  selection, no schema refetch, and inspected English/German-overlay panels.
- `packages/e2e/tests/problem-surfaces.spec.ts` - the full loop in a real
  browser: mounted Focused-panel locale continuity without requests, focused
  filtering, inactive-tab indicator, rail-collapsed indicator, and
  whole-document navigation.
