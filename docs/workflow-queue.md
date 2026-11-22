# Workflow-local queue

## Cancelling a run

While this window has a running or queued job, the top bar shows Cancel run,
even when another tab is selected. Running jobs are selected first, preferring
the active workflow, then the newest queued job. Each job in
the queue disclosure and Executions rail also has its own Cancel run button.
App View offers cancellation in its header and beside authored queue buttons.
The command palette's Cancel current run command uses the same selection and
can be assigned a keyboard shortcut.

Cancelling a queued job removes it before it runs. Cancelling a running job
waits for backend cleanup; later queued jobs continue normally. The job then
reads Cancelled, and node progress stops. A completed job is not relabelled
cancelled if it finishes before the request arrives. Backend failures and
already-finished jobs produce a plain status message; the control becomes
available again after a failed request.

## Background tab recovery

Camera and app-scroll positions are saved separately from workflow documents.
Moving the view does not validate, serialize or checksum the workflow. Each
window keeps its own position record; reopening merges the newest position for
each graph without overwriting another window's changes to a different graph.

After document edits, a browser worker prepares validation, serialized document
bytes and recovery checksums. The page commits the recovery envelope and retains
its asset ownership as before. Closing the page still writes a synchronous
recovery snapshot when it cannot wait for background work.

## Selection execution controls

Selecting or right-clicking a node shows the selection and menu before checking
which partial execution actions are available. Those actions remain disabled
while the check is pending. Moving or restyling a node reuses its execution
availability; changing the workflow's execution data checks it again. Queueing
always validates the current workflow independently of the display's cached answer.

## Run controls

The canvas button reads Run. Its compact neighbor opens this workflow's runs:
idle shows a list icon, running shows a cyan ring, and a number counts only
waiting jobs. Completed runs never contribute to this indicator. Waiting jobs
remain visible as a count beside the list icon when no job is running.
The shared `executionActivity` selector in `packages/app/src/execution-activity.ts`
accepts workflow-filtered executions or all executions for the top bar and
returns separate numeric `running` and `waiting` counts. Multiple jobs can
run concurrently, including jobs of the same workflow. Completed and failed
jobs contribute to neither count. Both surfaces derive their state from the
execution store.

Queueing is a control of the workflow currently open in the graph editor,
not a global shell action. Each live graph tab has a compact control on the
center region's top toolbar row, right-aligned beside the view and lens
controls. App View retains its form-header Run button when its document has
no authored queue placement. Authored layouts can instead place multiple
partial-run buttons as described in `docs/app-view.md`. The graph control's primary button
submits that tab through the existing `AppState.queue` path. The adjacent
disclosure shows only jobs whose compile artifact snapshot has the same
workflow lineage as the tab. A frozen execution tab shows only its exact job.

Queueing preserves the accepted workflow snapshot when shared workspace
startup adopts the same editing session during submission. Closing the
workflow or independently reopening its lineage before submission cancels
that unposted request instead of sending it for the replacement document.

Before submitting, queueing confirms retained
ownership of known asset digests and incomplete roots in the captured workflow,
including effective catalog defaults that arrived after startup. An opaque
census requires acknowledgement even when it contains no known digest and the
optional source upload fails. Refusal prevents submission and appears in
Problems. These incomplete declarations do not enable vault cleanup; failure
of the optional source stamp still allows an otherwise admitted unstamped submission.
Repeated queues reuse the acknowledged owner only while the captured document,
backend connection, catalog and known digest set remain unchanged. The durable
journal records the acknowledged revision; connection transitions require fresh
admission. Reuse does not release old generations or certify complete ownership.

The control does not create an optimistic row while a submission is in
flight. A row appears only after the backend accepts the job and the
execution store registers its real execution reference. Queued, running, and
terminal labels, progress, node facts, errors, and partial-run scope are read
directly from `ExecutionStore`; the control has no parallel status state.
When the engine reports an absent root value, the execution card and its
matching canvas node show the one blocked message for that node. Runtime graph
expansion remains attached to its parent: both surfaces show the child count,
and the card reports how many of those children have completed or used cache.
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
Each expanded region also lists its runtime items. Fixed map and fold counts
show waiting placeholders immediately; explicit iteration events advance rows
to running and completed. While rows appear as the backend spawns them. The
Outputs panel groups retained images by the same runtime item identity.

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

The Run button retains `Ctrl+Enter` through the command registry. The
disclosure is a separately named button, opens with click or ArrowDown,
closes on an outside press or Escape, and restores focus to its trigger after
keyboard dismissal. Home, End, and arrow keys move between available Open
snapshot actions. Each activity card uses text labels in addition to status
styling, retains the complete prompt identity, and exposes an explicit Open
snapshot action when local provenance allows the exact frozen view.

The control is ordinary Dinkster chrome: styled buttons, a list or ring icon, and the
shared quiet scrollbar. It adds no native select or browser scrollbar chrome.
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
  blocked and expanded-runtime facts, incomplete provenance, and exact open
  and pin/follow command routing.
- `canvas/test/renderer-paint.test.ts` and
  `e2e/tests/execution-progress.spec.ts` prove normalized step progress paints
  on the running node, reacts alongside the shell aggregate, animates only
  while running, and becomes static under reduced motion. Inspected receipts
  are under `dinkster-evidence/frontend/issue-140/` and `dinkster-evidence/frontend/issue-141/`.
