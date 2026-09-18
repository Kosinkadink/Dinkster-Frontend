# Execution log

The Execution log is the per-run structured feed of what a workflow execution
reported while it ran. It is a bottom-zone registered panel, separate from the
app Activity panel: Activity records frontend and connection events, while the
Execution log shows one selected run's backend log records and errors.

Each row keeps a UTC timestamp, a level, the originating node when the record
carries one, and the message. Rows come from two sources and only two. Log
rows are the backend's `node_event`/`log` wire records: explicit
`report_log(level, message)` calls plus captured node stdout, stderr, and
Python logging, at level `info` or `warning` only. Captured rows keep their
origin (`stdout`, `stderr`, `logging`, or `capture`) beside the message. Error
rows are a projection of the run's error report - the same
`ExecutionState.errors` diagnostics that drive node error badges - so an
execution error appears exactly once in the system and the log never carries a
separate error channel. Diagnostics carry no own timestamp; they are ordered
at the run's end time.

Log rows missed while the page was not listening are backfilled from the
server's run journal when the server keeps one (a library root is
configured). After a reconnect, reconciliation replays each open run's
journal alongside its job record; after a page reload, the first live event
of a still-running run arriving with a wire sequence past 1 triggers the
same replay. Backfilled rows merge with live rows by each record's per-job
sequence number, so a row is never shown twice. The journal drops info-level
rows once a run finishes, so a backfilled finished run shows its warnings
only; servers without a journal simply show rows from the live stream.

The store retains the latest 2000 log records per run in memory. When a run
exceeds that, the oldest records are discarded and the panel shows a
truncation notice with the exact discarded count. Individual messages are
capped at 4096 characters by the client (the backend caps them earlier at
2000).

The Run selector defaults to Current, which follows the run the active
workflow tab shows; picking a specific run pins the view to it, and a pinned
run that disappears from history falls back to Current. The Node selector
narrows the feed to one node's rows, and the three level toggles (info,
warning, error) hide or show each level independently. A row's node name is a
button that focuses and centers that node on the canvas; names resolve through
run provenance to the document node title, then the schema display name, then
the raw runtime id.

The list starts at the newest row and follows appended rows while the reader
is at the tail. Scrolling upward pauses tail following and reveals a "Jump to
latest" control that resumes it. The scroll region is keyboard focusable and
its text can be selected and copied. An empty run and the no-selection state
each show a deterministic empty message.

Execution log controls, statuses, levels, accessibility names, empty and
truncation messages, and the tail-resume action follow the active locale while
the panel remains mounted. The selected run, node and level filters, tail
position, prompt and node identifiers, timestamps, origins, backend messages,
diagnostics, and canvas focus targets remain unchanged.

## Bottom node badges

Nodes surface the current run's records as tabs on their bottom edge,
left-aligned and flowing right: error, then warning, then info. The error tab
is the run error report's single visual - the same `ExecutionState.errors`
diagnostics the Execution log projects - and shows a count when more than one
diagnostic anchors to the node. The warning tab counts the node's warning log
records; a compact info dot marks that the node produced any informational
records. Warning and info badges derive from the run's log records, so they
clear when the next run starts, and they follow the view: inside a subgraph
they sit on the inner node that logged, and on the collapsed instance node
when viewed from the parent graph.

Clicking a badge opens a popover. The error popover lists the anchored
diagnostics (exception, hints, traceback, inputs) and offers Dismiss, which
hides that node's error badge until the next run without touching the error
report, and Open in Execution log. The warning and info popovers list the
node's records with timestamps and also link into the Execution log; opening
it selects the Current run and pre-filters the Node selector to that node.
A collapsed subgraph instance aggregates several runtime occurrences, so
opening from its badge filters to all of them at once ("Focused node (N
occurrences)"); picking any node manually returns to the ordinary filter.
Document problem badges (compile and validation diagnostics) are unaffected
and stay in the node header lane.
