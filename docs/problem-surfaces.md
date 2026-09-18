# Problem surfaces

Problems reach the user through three cooperating surfaces (#22). None
replaces another: the whole-document list is always complete, the focused
view is always narrow, and the indicator is always visible.

| Surface | Where | Shows |
| --- | --- | --- |
| Problems tab | right rail (`problems` panel) | Every current problem, grouped per node, with Show on canvas and Show in Focused navigation. |
| Focused tab | right rail (`context` panel) | The focused entity's details and ONLY the problems belonging to that context. |
| Problem indicator | Problems tab label, right-rail toggle | Count plus worst severity whenever document problems exist; absent at zero. |

All three read the same composed diagnostics list (solver diagnostics,
owner-scoped live problems, and the active execution's artifact diagnostics
and errors), so their counts can never disagree.

Native backend pack failures are restored from the process-lifetime
`/api/composition` snapshot on schema load, refresh, and reconnect. A later
healthy snapshot clears only that backend's pack failures, leaving unrelated
app and document problems intact.

## Focus-to-context ownership

The Focused tab derives WHAT is focused from live shell facts with one pure
function, `deriveFocusContext` in `packages/app/src/problem-context.ts`. The
derivation is deterministic - the same snapshot always yields the same
context - and reading focus never mutates the document.

Priority order, most specific wins:

1. **Widget** - a widget editor is open on canvas. The context is that
   node + value key.
2. **Node selection** - one or more nodes are selected.
3. **Link selection** - one or more links are selected (and no nodes).
4. **Group selection** - one or more groups are selected (and no nodes or
   links). Members resolve geometrically through the canvas bridge.
5. **Subgraph view** - the canvas shows a drilled-in subgraph with a known
   instance path.
6. **Document** - nothing above applies; the whole document is the context.

A canvas selection containing several entity kinds resolves to the most
specific non-empty tier (nodes beat links beat groups), matching how canvas
gestures treat mixed selections. When subgraph navigation signals are
mid-transition (the instance path is momentarily out of sync with the graph
stack), the derivation falls back to the document rather than guessing.

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

Problems rows with an owning context (an occurrence or port anchor) offer
two actions:

- **Show on canvas** - the existing anchored navigation: restores the owning
  graph view, selects the node, and centers the camera.
- **Show in Focused** - does the same focus, then activates the Focused tab,
  which now shows the owner and its problems.

Both actions change only view state (selection, navigation, camera, active
panel), never the document.

## Localization boundary

The Problems and Focused headings, context-kind labels, empty states, counts,
navigation actions, entity and endpoint wrappers, compatibility advisory
chrome, and diagnostic-code accessible label follow the active locale while
the panels remain mounted. Locale changes preserve disclosure, selection,
focus targets, context and row identity, active document and graph navigation,
and never refresh schemas, diagnostics, execution, or values. Workflow, graph,
tab, widget, node, group, and endpoint names and ids remain raw source data, as
do diagnostic group titles, severities, codes, messages, hints, suggestions,
tracebacks, compatibility pack/node ids, and refusal reasons. The generated
General group remains outside this static-chrome boundary.

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
- `packages/app/test/ContextPanel.dom.test.tsx` - the rendered Focused tab
  follows every context kind, localizes every entity and endpoint wrapper,
  preserves raw facts and mounted identity, filters problems, and reports
  empty contexts honestly.
- `packages/app/test/shell-chrome.dom.test.tsx` - descriptor indicators on
  dock tabs, active or not, clearing at zero.
- `packages/app/test/panels.test.ts` - indicator aggregation.
- `packages/app/test/ProblemsPanel.dom.test.tsx` - the Show in Focused
  affordance and mounted static-chrome locale continuity.
- `packages/e2e/tests/problems-focus.spec.ts` - mounted locale changes,
  preserved raw diagnostic and compatibility data, stable disclosure and
  selection, no schema refetch, and inspected English/German-overlay panels.
- `packages/e2e/tests/problem-surfaces.spec.ts` - the full loop in a real
  browser: mounted Focused-panel locale continuity without requests, focused
  filtering, inactive-tab indicator, rail-collapsed indicator, and
  whole-document navigation.
