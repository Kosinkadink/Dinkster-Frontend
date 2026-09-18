# Activity

The Activity panel is a host-owned record of frontend events. Each entry keeps
four separate facts: an exact UTC timestamp, severity, source, and message.
Backend labels remain attached to events after a disconnect, while app-level
diagnostics use their diagnostic origin as the source. Severity is written as
text and reinforced by a bordered badge and row marker, never communicated by
color alone.

The log retains the latest 500 entries in memory. It starts at the newest
entry and follows appended entries while the reader remains at the tail.
Scrolling upward pauses tail following; returning to the tail resumes it.
The scroll region is keyboard focusable, touch-scrollable, and its text can be
selected and copied.

Clear remains a host-header action. The first activation arms a four-second
confirmation shown inside the panel; the second clears the same in-memory log.
An expired confirmation or an empty log leaves entries unchanged. Clearing
shows the deterministic empty state without changing backend, execution, or
diagnostic state.

The panel's accessible labels, clear confirmation, and empty state use the
application locale catalog. A mounted panel relabels in place without changing
focus, reader position, tail-follow preference, entries, or clear state.
Timestamp, severity, source, and message remain raw event facts; timestamps
keep their deterministic UTC presentation regardless of locale.
