# Editors (the center region)

The center region of the shell hosts EDITORS: projections over shared
document state. This document pins the editor seam so future surfaces
(video timeline, 3D surfaces,
external-tool bridges) arrive as registry descriptors, never as shell
rewrites or bolted-on views.

## The contract (user-approved architecture pin, 2026-07-25)

- A tab is conceptually **(document, editorKind)**. `Tab.editorKind` names
  the editor that renders it; the built-in kinds are `graph` (the node
  canvas), `app` (the form-style app view), and `image` (image editing,
  including mask tools).
- Editors are projections: they render shared document state and mutate it
  ONLY by dispatching maintained serializable commands - never by reaching
  into renderer or editor internals. This is what keeps undo, document
  history, and future collaboration working identically across editor
  kinds.
- Node workflows remain the execution lingua franca: whatever an editor
  looks like, what it produces lowers to the same document/command model
  that compiles to workflows.
- Editors are NOT panels. Panels (`panels.ts`, docs/shell.md) are shell
  chrome AROUND the center region - docks, rails, the bottom panel.
  Editors own the center. The two vocabularies never conflate.
- Future editor kinds must also honor the collaboration and agent pins in
  docs/collaboration.md ("Editor-readiness pins"): per-surface command
  families as the only mutation path, ephemeral view state in presence,
  media by asset-digest reference, and agent actions through the same
  commands and proposal conventions humans use.

## EditorRegistry

`packages/app/src/editors.ts`, exposed as `app.editors`. A descriptor is:

- `id`: the stable kind id tabs reference (`GRAPH_EDITOR_KIND = 'graph'`,
  `APP_EDITOR_KIND = 'app'`, `IMAGE_EDITOR_KIND = 'image'`).
- `title`: human-readable name.
- `component`: renders the editor. Mounted once per kind and kept alive
  across same-kind tab switches - the component binds to the active tab
  itself (as CanvasHost does), so per-tab view state such as the canvas
  viewport survives switching.

Registration follows the house registry discipline (PanelRegistry,
CommandRegistry, widget registry): `register` returns the unregister
function, duplicate ids refuse loudly, `changed` ticks on every mutation.
Core registers graph, app, image, curve, and GLSL editors through
`app.frontendDoors.editor`. Extension packs use the `editor()` door and provide
a declarative host-UI provider instead of a component.

`editorBinding()` maps schema-owned `editorRole` metadata to an editor kind.
Compatibility matches can use node id, widget type, or value type. A binding
matches only when every declared field matches; priority is descending and id
is the deterministic tie-breaker. Core registers its bindings through the same
door. Opening an extension binding changes the tab's editor kind while keeping
the shared document session and view state.

## Rendering

`App.tsx` resolves the active tab's `editorKind` through the registry and
renders the descriptor's component inside `.canvas-stage`. With no active
tab the graph editor stays mounted (it owns the empty state). A tab whose
kind has no registered editor (an unregistered extension kind) renders a
loud `editor-missing` placeholder - never a blank stage.

The keyed host only remounts when the DESCRIPTOR changes: same-kind tab
switches return the same descriptor object, so switching between two graph
tabs never tears down the canvas.

Each live tab keeps browser-local view position in the open-tab snapshot.
Graph viewports are keyed by graph definition so tab switches and drill
navigation restore the last pan and zoom; App View restores its scroll
position. Concurrent windows merge different positions independently; the
latest update wins when they change the same position. This state never
enters the workflow document, collaboration, `WorkspaceTabRecord`, or
SharedWorker authority. Gestures in progress, Arrange mode, and image-editor
state remain session-only. The image editor's target, local operation history,
pan, and zoom belong to its temporary edit session. The transient `image`
projection is therefore omitted from tab persistence and cannot be restored
after refresh.

Mask edits can still become durable workflow behavior. When a native
`dinkster.load_image` mask has graph consumers, **Apply mask to graph** records the
session's brush recipe in a source-bound `dinkster.mask.paint` node and rewires
only those consumers. **Bake to asset** remains the explicit replacement path
for other eligible image inputs. The graph command validates the source asset,
paint node, and mask topology before making one undoable change.

## Switching kinds (the app view)

The app view (`AppView.tsx`, docs/app-view.md) is the first non-graph
kind. `AppState.setTabEditorKind(tabId, kind)` swaps the projection: the
Tab object is replaced (fields stay readonly) but keeps its id, its
`DocumentSession`, and its view state - the same document under a
different editor, per the (document, editorKind) pin. Frozen tabs refuse
the switch (their read-only snapshot semantics are canvas-rendered today).

Entry points: the top-bar `App` toggle and the `view.toggleAppView`
command (Alt+V). `editorKind` persists with the tab snapshot
(absent = `graph`, so pre-2.4 snapshots load unchanged; an unknown
persisted kind restores as-is and renders the `editor-missing` fallback
rather than being coerced).

Because registry-bound command shortcuts must work whichever kind owns the
center, they dispatch from a SHELL-level keydown handler in `App.tsx`, not
from inside any editor. CanvasHost keeps only canvas-owned keys
(copy/paste, lens, camera bookmarks); both handlers share the same
`shortcutSuppressed` guard (`settings.ts`) for field/modal/popover
suppression, and the canvas handler ignores keys the shell already
consumed (`defaultPrevented`).

## Camera bookmarks and minimap

Shift+1 through Shift+0 saves the current graph camera in slots 1 through
10. Press the matching digit without Shift to restore it. A quick second
Shift press clears the slot. Bookmarks retain the full graph-definition and
instance path, so a bookmark inside one occurrence of a subgraph returns to
that occurrence; a path orphaned by later edits is ignored.

New bookmarks persist the visible world rectangle, not a canvas top-left
transform. Restoring centers that rectangle and chooses the largest scale
that contains all four saved corners in the current canvas. This preserves
the saved view when the window has a different size or aspect ratio. The
minimap digit is placed at the saved rectangle's world center and therefore
also stays stable across resizes. Legacy documents with raw `viewport`
bookmarks still load and retain their previous restore and marker behavior;
overwriting one saves the new rectangle form.

The minimap always fits the union of every node and group box in the scene.
Nodes always paint and remain at least 2 CSS pixels wide and tall. **Node
Colors** chooses between each node's scene identity color (with the active
theme's node-header color as fallback) and one neutral schematic fill; it
never hides nodes. **Render Bypass State** independently lets bypass fill
take precedence. **Render Error State** controls only error outlines, while
running and completed execution outlines remain visible. **Show Links**,
**Show Frames/Groups**, **Reroutes**, and **Bookmarks** are independent
persisted overlays. Disabling frames/groups suppresses their paint without
removing their boxes from the fitted union. None of these presentation
settings changes the workflow document or its revision.

The minimap stays in the graph-local bottom-right control cluster in root and
drilled views. Its CSS-coordinate pointer mapping is independent of the
device-pixel-ratio-scaled backing store, so click, drag, and pointed wheel zoom
retain the same hit regions on high-density displays. Local and collaboration
viewports and camera bookmark markers paint above graph content without
joining fit bounds.

The cluster stacks the minimap above a single corner bar; nothing ever paints
on the minimap surface itself. The bar's left group holds the minimap
visibility toggle (one stateful button whose label and pressed state track
visibility) and the minimap settings button; its right group holds zoom out,
the current zoom percentage, fit graph, and zoom in. Every control is keyboard
reachable, has a product tooltip and visible focus state, and uses at least a
36-by-36 CSS-pixel hit target. Activating the percentage resets the canvas to
100% without moving the world point under the canvas center. Above 520 CSS
pixels the minimap is 260 by 150 pixels; at 520 pixels and below it is 122
pixels tall. Hiding the minimap collapses the cluster to just the bar. The
settings menu opens as a popover beside the cluster (to its left) when the
canvas stage has room there and above the cluster when it does not (a narrow
window or an open side panel), never covering the minimap or the bar.
The cluster's wrapper is click-through; canvas gestures outside the visible
controls continue to reach the graph.

## Node display names

Right-click a node and choose **Rename...** to edit its displayed title in the
same anchored text prompt used by group rename. The commit dispatches the
serializable `node.setTitle` command, so undo, persistence, and collaboration
all use the document operation path.

A title override that differs from the schema display name is italic. Hovering
that header shows `Original: <display name>` immediately, without the normal
tooltip delay. If the schema is unavailable, the node type is the original
name. **Reset Name** appears beside the other node layout actions only while a
real override exists. Reset removes the title field entirely; entering the
original name in the rename prompt performs the same clear operation. An
equal-name field from an older document is treated as unrenamed: normal text,
normal tooltip timing, and no reset action.

## Selector nodes

Some native nodes choose one of two input branches from a stored boolean
setting. The canvas leaves the selected branch at normal brightness and dims
the other branch's input row to show that it will not run. If the workflow has
no stored boolean yet, both rows remain neutral rather than guessing a branch.

The backend owns selector lowering. Dinkster submits the complete graph, including
both branches, and the server rewires and removes the inactive branch at queue
time. A connection into the selector's boolean decision input is refused before
submission with an input-anchored Problem because selector decisions must be
stored values, not computed links.

## Graph canvas selection modifiers

Starting a canvas gesture cannot be diverted into the browser's native drag
of text selected elsewhere in the shell. The canvas clears that stray
selection on pointerdown and refuses native dragstart, while preserving an
active input or textarea selection. Text in Problems, outputs, and other
shell panels remains deliberately selectable and copyable.

- Click a node to select it. Ctrl+Click (Cmd+Click on macOS) toggles that
  node without replacing the rest of the selection.
- Shift+Click a node to add the connectivity range between the current
  selection and that node: the current selection, clicked node, and every
  node and reroute dot on a directed connection path between them remain
  selected. The search works in either path direction and crosses reroute
  chains. Dragging the resulting range carries those reroutes with its nodes.
- If the selection is empty or no path connects either endpoint,
  Shift+Click falls back to the same additive node toggle. Ctrl+Shift+Click
  remains an alias for connectivity range selection.
- Dragging directly after a modifier click moves the resulting selection.
- Ctrl+drag (Cmd+drag on macOS) on the canvas starts a marquee; hold Shift
  as well to add its contents. Reroute dots inside the rectangle are included.
  A plain empty-canvas drag pans, while Shift preserves the selection through
  that pan.

## Graph link menu

Every ordinary noodle paints a midpoint handle. A clean left-click on that
handle selects the link and opens the link menu with Add reroute and Insert
node. The handle grows and gains a light outline while the pointer is inside
its generous hit radius. Ctrl, Cmd, Shift, and Alt clicks keep their
selection-only behavior, and moving beyond the canvas drag threshold
suppresses the menu. A double-click anywhere else on an ordinary link opens
the same menu. Boundary binding and named-net delivery noodles remain
selection-only: their synthetic ids cannot be spliced, and inserting a node
between a Set and a Get has no defined semantics. Net noodles paint the net
name at their midpoint instead of a handle; net edits go through the
right-click net menu.

The menu's full-screen focus layer intentionally receives programmatic focus
so Escape works immediately. Its focus outline is suppressed explicitly; the
layer must not draw a viewport-sized browser focus rectangle.

Context menus may contain cascading submenus. Hovering or pressing a submenu
row opens its child panel; ArrowRight enters it and ArrowLeft returns to the
parent. Submenus can contain further submenus. Every tier stays within the
viewport after its scrollable height is applied, flipping to the left of its
parent near the right edge. Open tiers keep their DOM and scroll position while
the active row changes; closing a tier discards that state. The cascade is one
ARIA menu composite with one focus owner; nested tiers are labelled groups
controlled by their parent submenu rows. Escape, outside focus, and invoking a
terminal action dismiss the whole cascade.

Core menu rows use decorative Lucide icons where the action has a natural
match. A shortcut appears as a visible trailing pill only when the current
keybinding registry supplies that command's binding. Because the pill is text
inside the menu item, it is included in the menu item's accessible name without
a separate ARIA-only spelling. User keybinding overrides therefore update the
display rather than leaving a stale default behind.

## Graph canvas identity colors

Right-click a node, open Color, and choose a preset to give it a durable
identity color. Default clears the override. When the clicked node belongs to
the current node selection, the choice applies to every selected node as one
atomic dispatch; otherwise it applies only to the clicked node. The same
Default, Blue, Green, Red, Yellow, and Purple palette is shared with group
context menus. The selection toolbox also exposes Color directly; its circle
uses the shared selection color when every selected node has the same override.

Node color strongly tints the header and subtly tints the theme body. It does
not replace title text, selection halos, badges, or problem and execution
outlines. Muted opacity and the bypass wash remain visually authoritative.
The types lens adds labels and the data lens re-skins body content without
recoloring headers, so identity colors remain visible underneath either lens.
Groups retain their existing translucent fill, title band, and border colors.

## Unrecognized node types

When the active document resolver cannot provide a schema for a node type, the
canvas marks that node with a modest red hue across its body and header plus a
red border three times the standard node-border width. This error treatment
overrides a custom identity color, while selection remains a separate white
outline painted above it. Stored values, inferred pins, links, run-state
badges, and problem badges remain available. Hovering the header immediately
shows `Unknown node type: <node.type>`.

Unresolved nodes are excluded from execution. Opening a document containing
one reports a Problems warning per type naming the backend that lacks it.
Pressing Queue when a requested output depends on an unresolved node refuses
the run: the tab's Problems entries are replaced with one error per
unresolved node (duplicate compile copies collapse) stating the node id, its
type, the backend it does not resolve on, and that a run depending on it
cannot be queued. Unresolved nodes outside the executed scope never block
queueing.

## Graph selection execution toolbox

The floating selection toolbox derives partial-execution actions from directed
connections, not node position. Execute up to uses every first selected node
(no selected ancestor). Execute from onwards uses every last selected node (no
selected descendant) and queues the reachable graph outputs; uncached
dependencies before or beside that region may execute naturally. Execute
between is available for a contiguous directed selection of more than one
node. It targets every selected node whose outputs have no direct collapsed
edge to another selected node. Upstream dependencies outside the selection may
execute as needed, but downstream consumers of those targets are not planned.

The toolbox is an upside-down-T whose bottom edge stays 16 screen pixels above
the outer edge of the painted white selection outline. Its 28px buttons are
arranged in two centered, natural-width rows. The narrow upper cap contains
exactly the three root-graph execution actions in
before-to-after order: up to, between, from onwards. The lower panel keeps its
wider natural width rather than stretching the upper cap to match it.
Disabled actions are dimmed and inert, do not show scope previews, and explain
why in their hover tooltip. Enabled actions show their label in the same
tooltip. Non-root graphs and other views where partial execution does not
apply omit that row entirely, so the panel never contains an empty row.
The 16px clearance and 28px buttons stay constant in screen space from 25%
through 400% camera zoom, including toolboxes centered over multi-node and
mixed ordinary/boundary selections. Multi-item placement accounts for the
padded dashed union outline, including other selected canvas citizens, rather
than measuring from the underlying node bounds.

The bottom row groups Delete, node modification (Mute, Bypass, conditional
Open Subgraph, Extract, and Flatten), Color, and More actions with thin
non-interactive vertical separators.
Padding, gaps, and separators still claim clicks as panel chrome; they never
pass a gesture through to the graph. More actions opens the same menu registry
target and complete selection context as right-clicking the selected node, at
the More button anchor. For a multi-selection, the first real selected node is
the representative target while every selected canvas category remains in the
menu context. Cycles only disable modes whose actual upstream
execution closure intersects a cycle; an unrelated cycle elsewhere does not
affect the selection. The root-node context menu exposes the same up-to action
as "Execute up to Selection" and disables it whenever the toolbox up-to action
is disabled.

Open Subgraph, Extract, and Flatten use folder-open, group, and ungroup icons
from the same canvas icon painter as the other toolbox controls. Subgraph
header badges use the boxes icon. When a definition is referenced by two or
more occurrences, the badge adds the document-derived linked count; a single
occurrence keeps the compact icon-only badge.

Right-click a linked subgraph occurrence and choose **Make Unique** to clone
its definition and repoint only that occurrence. The command clones the
definition graph and its view state in one undoable transaction. Nested
subgraph references are intentionally retained, so nested definitions remain
shared. The menu omits Make Unique when the definition has only one occurrence.

Map, Fold, and While occurrence headers expose concise tooltips derived from
their stored region contracts. The text names element ports, state ports,
binding, continuation output, and iteration limit when those fields apply.
This presentation does not change the region's preserved double outline.

## Create an empty subgraph

Right-click empty canvas space and choose **Create Empty Subgraph** to create a
fresh, empty definition and its occurrence at the clicked position. Dinkster
immediately drills into the new definition. The same action is available from
Search Dinkster as **Create empty subgraph**; that path places the occurrence at
the current viewport center.

Default names progress from `New Subgraph` to `New Subgraph 2`, and so on,
across all definitions in the document. Creation is one undo step: undo removes
both the occurrence and definition and returns navigation to the nearest valid
parent graph. The new definition starts with empty Inputs and Outputs panels,
no boundary-panel positions, and no ordinary nodes.

### Extraction core status

The document command layer now supports atomic node extraction through
`subgraph.extract`. It moves selected ordinary nodes into one fresh definition,
moves interior plain links and named nets, converts crossing links and nets to
deterministically named Inputs and Outputs, rewrites an enclosing definition's
current boundary, and inserts one occurrence in the parent. The command is one
undo step and is safe to re-execute after unrelated collaboration edits; a
changed selection or incident topology drops as a stale plan instead of
absorbing the edit.

This is the L3 command foundation, not yet an end-user canvas gesture. The L7
UI will add selection actions, preview, naming, and post-success navigation.
Until L4, extraction refuses value sources, selectors, reroutes, groups,
promoted or whole-family enclosing forwarding, and direct specialized-slot
roots rather than omitting them. Every planned invocation must carry explicit
specialized-slot-root coverage, including an empty array. Selected node view
state and collapsed state on a moved or split net refuse with
`subgraph.extract.viewUnsupported`; view positions and group geometry remain
for L4. Callers should not expose this command as the finished extraction
experience yet.

## What lands later (ledgered in promises.md)

- Multiple visible editors at once (split view / EditorGroups) is a
  separate seam on top of this registry; visible-problems scoping across
  only visible editors rides that slice.
- The current ASSET widget picker already uses the shared native product
  dialog and collection surface. Full asset transformation editors still
  need to open from anywhere (widget picker, browser, menus, palette); a
  widget is an entry point, never the transformation editor's container.

## Coverage

`app/test/editors.test.ts`: registry register/duplicate/unregister/changed
semantics, descriptor identity stability (keyed hosts never remount), tabs
defaulting to `graph`, `setTabEditorKind` swaps retaining session/state,
frozen-tab refusal, and `editorKind` persistence round trips (legacy and
unknown kinds included). `e2e/app-view.spec.ts` proves the projection
end to end; the entire canvas E2E suite exercises the registry-rendered
center region.

The stable center stage exposes a top-left Views control beside the lens
control. It remains mounted across editor replacement, names the active
projection as Graph or App, and dispatches through
`AppState.setTabEditorKind`, the same state path as the shell's Alt+V and
icon-only App-view toggle. The built-in graph descriptor's displayed title is
Graph; its stable kind id remains `graph`.
