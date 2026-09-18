# Autogrow member lifecycle

Autogrow canvas rows have two different kinds of identity:

- Persisted members are document state. Links and values may address them.
- The trailing ghost is an editor affordance. It is never document state and
  never appears in a compiled prompt.

The lifecycle is:

```text
ghost mN --connect--> persisted mN + one trailing ghost mN+1
persisted mN --disconnect/rewire/delete--> removed if unused; next ghost remains >= mN+1
```

Disconnect, destination rewire, boundary unbind/rewire, selected noodle or net
sink deletion, and source-node deletion automatically compact every surviving
freed destination. The semantic edit and deduplicated `dynamic.compact`
commands share one batch, so one undo restores the exact old member identity
and its old link or binding together. Compaction still retains a member when
any link, net, binding, value, or nested state references it. **Remove Unused
Dynamic Inputs** remains in the node context menu for bulk and legacy cleanup,
but normal editing does not require it.

Member allocation uses a monotonic `seq` high-water mark. Save/export/open and
supported LiteGraph import preserve or reconstruct that mark, so a compacted
member id is never offered again. Links and named-net endpoints that still
address a removed member are invalid when the owning dynamic scope is present;
they cannot recreate a retired socket.

The same cleanup rules apply to root and nested graph definitions, direct and
forwarded families, and whole and grouped templates. A grouped ghost promotes
one member atomically, not one member per visible leaf. Every scope has at most
one trailing nonpersisted ghost while below capacity. Nested-only templates
continue to use their growth row.

## Drilled occurrence sockets

A drilled occurrence can have suffix members and a trailing ghost owned by
that occurrence rather than by the shared graph definition. The scene retains
the complete reversible route from each displayed row to its occurrence owner,
source family, and suffix member. When an occurrence mutation planner is
available, these rows have ordinary sockets: link gestures become
occurrence-level connect, disconnect, destination-rewire, or source-rewire
intentions. The planner resolves the trusted command invocation, and the app
keeps that invocation unchanged. Disconnect and destination-rewire gestures
append compaction of the freed destination's persisted owner in the same
batch, so one undo restores both its occurrence link and member state.

The capability is fail-closed. Without a planner, occurrence-owned suffix and
ghost rows paint without sockets and do not participate in pin hit testing.
Planner refusals surface as named Problems diagnostics instead of silently
dropping a gesture. Definition-owned rows in the same drilled graph retain the
ordinary definition editing path, and instance pins on the parent canvas retain
the existing parent-graph path. Production installs the core trusted-plan
planner (`coreOccurrencePlanner` in `packages/app/src/CanvasHost.tsx`), so
drilled occurrence rows are socketed in the shipped app; the fail-closed state
applies only when no planner is installed.

## Automated coverage

The production-path matrix in
`packages/canvas/test/dynamic-scene.test.ts` covers direct/forwarded and
whole/grouped families through connect, canonical save/open, drill view,
automatic one-batch disconnect compaction, undo/redo, compile, stale-link
rejection, and canvas pin ownership. `packages/core/test/import-litegraph.test.ts` covers the
supported import high-water path. `packages/app/test/subgraph-lifecycle.test.ts`
covers AppState export/open and drill projection for a grouped forwarded
member.

`packages/e2e/tests/autogrow-lifecycle.spec.ts` is the browser proof. It uses
the production CanvasHost to connect the trailing grouped/forwarded ghost and
disconnect the persisted socket, then checks automatic compaction, export/open,
drilling, one-step undo/redo, and non-recycled identity. The context-menu bulk
cleanup action remains separately covered by the menu tests.
`packages/e2e/tests/audit-t6a-compaction.spec.ts` covers the same full cycle
for a drilled occurrence-local link, including sibling and definition
isolation and exactly one trailing ghost after compaction and reload.

## Coordinator E2E procedure

1. Start from a clean frontend server using the repository E2E instructions.
2. Run only `packages/e2e/tests/autogrow-lifecycle.spec.ts` first.
3. Confirm the connected ghost creates exactly member `m0`, `seq: 1`, one
   link, and one grouped trailing ghost member `m1`.
4. Confirm export/open and drill-in preserve owner id `m0` and the link.
5. Drag the connected input into empty canvas. Confirm the link disappears,
   `m0` disappears, and `m1` remains the only trailing ghost.
6. Undo once. Confirm both the `m0` member and its link return together. Redo
   once and confirm both disappear together while the next ghost stays `m1`.
7. Run the complete E2E suite only after the focused proof is green.
