# Subgraph lifecycle actions

Dinkster exposes create, extract, and one-level flatten actions on the canvas.
They use the same serializable lifecycle commands as undo, redo, and shared
sessions.

## Create an empty subgraph

Use **Create empty subgraph** from the canvas context menu or universal
search. Dinkster creates an empty definition and occurrence as one undoable
operation, then opens the new definition.

## Extract a selection

Use **Extract as Subgraph** in the selection toolbox or a node, group,
reroute, value-source, or selector context menu, find **Extract selection as
subgraph** in universal search, or press **Ctrl+Shift+E**. Element-row menus
such as widgets, pins, sections, nets, and links stay scoped to that element.
Extraction commits immediately without a naming prompt. The definition uses
the shared collision-safe default (`New Subgraph`, then `New Subgraph 2`, and
so on). The created occurrence remains renameable later through the normal
node **Rename** action.

The gesture snapshots selected nodes, reroutes, value sources, selectors,
and groups. A selected group includes every supported item spatially inside
the group at gesture time. Selecting the contents without selecting the
group does not move the group.

After success, the new occurrence is the active selection.

## Flatten one level

Select exactly one subgraph occurrence. Use **Flatten Subgraph One Level**
in the toolbox or a node, group, reroute, value-source, or selector context
menu, find **Flatten selected subgraph one level** in universal search, or
press **Ctrl+Shift+F**. Element-row menus such as widgets, pins, sections,
nets, and links stay scoped to that element. Dinkster removes that occurrence
and splices one copy of its body into the parent as one undoable operation.
Nested occurrences remain nested. After success, the newly spliced body
nodes are selected.

Extract and flatten are unavailable while execution owns the tab. Extract is
unavailable for an empty semantic selection. Flatten is unavailable unless
the selection is exactly one resolvable subgraph occurrence.

## Refusals

Lifecycle operations fail closed. A refusal changes nothing and appears in
Problems with its stable code, human-readable message, and node or port
anchor when supplied. Codes such as `subgraph.flatten.regionUnsupported` are
not translated or renamed. Select the anchored Problems entry to navigate to
the affected node.

Region occurrences intentionally refuse one-level flatten because ordinary
nodes cannot preserve map, fold, or while semantics.

## Remove unused definitions

Use **Manage subgraph definitions** from the application menu or universal
search. The dialog separates definitions reachable from the workflow root
from unreachable definitions left behind by flattening or deleting their last
occurrence. Each row exposes the definition name and exact ID, a text-labelled
reachability state, body-node and occurrence counts, related saved-item count,
and the names and IDs of direct nested definitions. Retained definitions stay
available in a separate disclosure for comparison.

The unreachable and retained lists are keyboard-focusable scroll regions with
selectable, wrapping text. The layout collapses its facts vertically at narrow
widths and keeps the dialog contained at high zoom. Sets larger than two rows
announce that every row is available by scrolling. Empty and unavailable states
are explicit. Planning is local and synchronous, so this surface has no loading
or disconnected state.

Confirmed cleanup removes the complete unreachable set in one undoable and
redoable command. It also removes the definitions' views, bookmarks, exposed
app controls, saved net positions, and mode-panel bindings. A checksum binds
the action to the reviewed dependency set; concurrent changes refuse as
`subgraph.cleanup.stalePlan` instead of deleting a newly used definition.
Definitions are never removed automatically during save.

When a selected node's widget-output tap feeds outside consumers, extraction
creates one typed subgraph output for that exact tap and rewrites the complete
fan-out through it. The binding survives save/load, nesting, flattening,
undo/redo, and boundary editing. The Boundary panel labels these endpoints as
**Widget output**.

Only static widget-backed inputs can supply this endpoint. Missing, ambiguous,
dynamic, or non-widget tap targets fail closed. Value-source, selector, and
reroute output cuts remain unsupported rather than being encoded as fake
ports.

## Browser proof status

`packages/e2e/tests/subgraph-lifecycle.spec.ts` covers create-empty, mixed node
and group extraction, extract and flatten undo/redo, nested drill-in,
post-success selection, region-flatten refusal, dependency-aware cleanup,
cleanup undo/redo, semantic reachability and impact rows, keyboard and text
selection, long-content overflow, wide/narrow/high-zoom containment, reduced
motion, widget-output boundary extraction, and the post-cleanup empty state.
