# Value controllers

Seed-bearing widgets can choose what happens to their value after a successful run. The small icon-only chip at the right side of the widget capsule shows the current mode without covering the value. Hover it for a summary; hold Alt while hovering for advancement details. Click it to open the non-draggable mode dropdown.

## Modes

- Fixed (lock): keep the current value.
- Increment (plus): add the schema's step.
- Decrement (minus): subtract the schema's step.
- Randomize (die): choose an integer within the schema bounds. This is the default when no mode is stored.

Choosing a mode is one undoable `node.setController` edit. After a successful execution, all eligible values from that submitted prompt advance together in one undo step. Failed or interrupted runs do not advance. Linked values, fixed values, and nodes outside the submitted execution are unchanged.

## Advancement ownership

The advancement is planned at queue time, from the exact document snapshot the run compiled from - not from whatever the document looks like when the run finishes. Consequences you can rely on:

- Editing a seed value after queueing (even while the submit request is still in flight) keeps your edit; only untouched controls advance when the run completes.
- Closing the workflow, or replacing it by reopening a document with the same lineage, means the completed run advances nothing - it never writes into a different document than the one it was queued from.
- A run advances at most once, no matter how event delivery is timed (including completions that arrive before the submit response).
- A run the app provisionally marked lost during a reconnect still advances normally if the server later reports it running and completed.
- Toggling the seed controller feature off suppresses advancement for runs already in flight.

Controllers in active DynamicCombo branches, DynamicSlot dependents, and autogrow members follow their elaborated value keys. A promoted subgraph widget advances its own occurrence, while an unset occurrence inherits the definition's current value and mode. When one boundary input fans out, its primary `binds` target supplies that fallback before any `alsoBinds` target, regardless of graph node storage order. Nested promotion follows the outermost owner, and a link that reaches the terminal input suppresses advancement through every boundary it crossed. An unpromoted controller remains definition-owned and advances once even when that definition has multiple running instances.

Completion verifies each controller against the current compiled occurrence view. If a schema refresh removes a controller while a run is in flight, that retired item stays unchanged while other valid controllers can still advance.

Inspected before-and-after screenshots of two promoted occurrences are under `dinkster-evidence/frontend/issue-308/`.

## Remote combo refresh

A remote COMBO whose schema declares `control_after_refresh` uses the same controller chip and `node.setController` history path. Its modes operate on the freshly returned option order: increment and decrement wrap, randomize samples every option uniformly, and fixed leaves the value alone. If a refresh removes the stored value, increment starts at the first fresh option and decrement starts at the last.

Only an explicit fresh response advances values. Opening an editor from cache and failed refreshes do nothing. The refresh captures raw stored values and effective controller modes before the request; edits or mode changes made while the old options are stale win over the completion. Every eligible widget sharing the refreshed route advances in one atomic undo step, and each refresh completion applies at most once.
