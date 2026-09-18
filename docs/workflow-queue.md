# Workflow-local queue

Queueing is a control of the workflow currently open in the graph editor,
not a global shell action. Each live graph tab has a compact control on the
center region's top toolbar row, right-aligned beside the view and lens
controls. App View retains its form-header Queue button when its document has
no authored queue placement. Authored layouts can instead place multiple
partial-run buttons as described in `docs/app-view.md`. The graph control's primary button
submits that tab through the existing `AppState.queue` path. The adjacent
disclosure shows only jobs whose compile artifact snapshot has the same
workflow lineage as the tab. A frozen execution tab shows only its exact job.

The control does not create an optimistic row while a submission is in
flight. A row appears only after the backend accepts the job and the
execution store registers its real execution reference. Queued, running, and
terminal labels, progress, node facts, errors, and partial-run scope are read
directly from `ExecutionStore`; the control has no parallel status state.
Rehydrated jobs show the authenticated principal that queued the run, with a
compact `agent` badge for agent principals. The local human principal and jobs
from older backends without attribution retain the existing presentation.
Jobs submitted by another client without a local compile artifact are not
guessed into a workflow and are explicitly labeled snapshot unavailable.

While a run is active, a determinate workflow bar appears directly below the
Queue controls and in its execution card. Its denominator is the scheduled
compile-artifact scope. Done and cached nodes contribute one unit each, and
every running node with determinate progress contributes its clamped fraction,
so parallel execution remains additive. Skipped and failed nodes do not claim
completed work. Native region bodies are weighted by their reported expansion
counts, including nested occurrences; an expansion received after node events
repairs the aggregate without changing store reconciliation. An unbounded
region has no determinate aggregate until its finished iteration count is known.

The canvas consumes the same execution projection. A running node with a
normalized `NodeProgress.value` paints a determinate bar inside its node; the
renderer performs no DOM reads or per-node DOM updates. Backends that do not
emit step progress still receive the running-state treatment without a false
step estimate.

An executing node uses a pulsing glow and a flowing dashed border accent. The
renderer requests continuous frames only while at least one node is running.
With `prefers-reduced-motion: reduce`, the accent becomes a static glow and no
execution animation frames are scheduled. Terminal and idle states return to
ordinary dirty-only painting.

Switching tabs replaces the complete control owner and its entry list in one
render boundary. A job from another lineage is therefore absent from the
summary, disclosure, and right-rail Executions section. Jobs remain grouped
by backend inside the rail when multiple backends are configured, but the
groups contain only the active workflow's jobs. Backend-wide queue depth is
not presented as workflow-local state.

The Queue button retains `Ctrl+Enter` through the command registry. The
disclosure is a separately named button, opens with click or ArrowDown,
closes on an outside press or Escape, and restores focus to its trigger after
keyboard dismissal. Home, End, and arrow keys move between available Open
snapshot actions. Each activity card uses text labels in addition to status
styling, retains the complete prompt identity, and exposes an explicit Open
snapshot action when local provenance allows the exact frozen view.

The control is ordinary Dinkster chrome: styled buttons, a custom caret, and a
themed overflow track. It adds no native select or browser scrollbar chrome.
It shares one wrapping flex row with the view and lens controls, so the
controls cannot overlap each other at any width, and it stays clear of the
bottom-right minimap.

## Proof

- `app/test/overlay.test.ts` proves the workflow-lineage selector returns
  only the requested tab's executions, newest first.
- `app/test/WorkflowQueueControl.dom.test.tsx` proves tab-owner replacement
  has no entry bleed, submission does not fabricate an optimistic row,
  backend status and aggregate progress changes render truthfully, and the
  disclosure's keyboard, focus, and ARIA contract.
- `app/test/ExecutionActivityCard.dom.test.tsx` proves complete identities,
  text status, cached/skipped/region/out-of-order progress, error facts,
  incomplete provenance, and exact open and pin/follow command routing.
- `canvas/test/renderer-paint.test.ts` and
  `e2e/tests/execution-progress.spec.ts` prove normalized step progress paints
  on the running node, reacts alongside the shell aggregate, animates only
  while running, and becomes static under reduced motion. Inspected receipts
  are under `docs/evidence/issue-140/` and `docs/evidence/issue-141/`.
