# App shell

The shell is everything around the center region: topbar, tab strip, icon
sidebar, the left dock, the tabbed right zone, the bottom panel, the status bar,
and the settings dialog. This document pins the layout contract so panels
do not accrete ad hoc. The center region itself hosts EDITORS resolved
through the editor registry - a separate vocabulary pinned in
docs/editors.md (today's only editor kind is the graph canvas).

## Layout

```diagram
+--------------------------------------------------------------+
| topbar (menu, centered search, layout / left / bottom / right)|
+----+---------------+------------------------------+----------+
|    |               | tab strip (workflow tabs)    |          |
|icon| dock panel    +------------------------------+ rail     |
|side| (exclusive:   | canvas + workflow controls   | (local   |
|bar |  library /    | (views, lenses, queue)       | jobs,    |
|    |  backends)    +------------------------------+ problems)|
|    |               | bottom panel (exclusive:     |          |
|    |               |  Activity)                   |          |
+----+---------------+------------------------------+----------+
| status bar (optional: connection, schemas, Backends, review) |
+--------------------------------------------------------------+
```

The tab strip belongs to the center workspace column. It starts after both
the icon sidebar and an open left dock, so those left-side regions own their
full height and tabs never cover them.

The **Dinkster** wordmark is the application menu. It uses the same grouped,
keyboard-navigable menu idiom as canvas context menus: click or Enter opens,
arrow keys move, Enter invokes, and Escape or an outside press closes. The
menu reflects existing document commands rather than introducing persistence
paths of its own. Its groups expose Open workflow library, Import workflow
from file, Save workflow, and Export workflow, then Undo, Redo, Select all,
Zoom in, Zoom out, Fit view to selection,
Customize layout, and Open settings. Every row shows its current keybinding at the right; user
overrides replace defaults and unbound commands show no hint. Undo and Redo
follow the active document's history availability. An availability change
closes the open menu so its per-open keyboard and ARIA snapshot cannot become
stale. Canvas-only commands are disabled while no canvas bridge is mounted.
Fit view to selection currently
uses the renderer's whole-scene fit fallback when selection-specific fitting
is unavailable, so an empty selection does not disable it. All rows dispatch
the same command-registry actions as keyboard shortcuts. Import/export are not
shown because no such commands exist yet. Save therefore no longer occupies
the tab toolbar.
Queue is a graph-local center-region control, not a tab-strip action. Its
top-right disclosure shows only executions owned by the active workflow's
lineage and reads their status directly from the execution store; App View
retains its form-header Queue action instead of inheriting graph chrome. See
`docs/workflow-queue.md`. App view and Data lens have no duplicate tab-strip
buttons. Both remain discoverable in the center-stage top-left Views/Lenses
cluster. Views switches Graph/App through the existing editor-kind command
path, while the registry-driven Lenses menu includes Data. Alt+V and D remain
available. The menus reuse the same tab editor-kind and per-tab lens state
rather than maintaining parallel mode state. An outside Canvas press dismisses
either menu without consuming that press, so the same gesture can pan, select,
link, or activate a widget. A visible modal surface continues to own input
until it closes.

The Views/Lenses switcher labels, headings, delegated tooltip labels, and the
three graph-wide named-net display actions use the application locale catalog.
An open menu relabels in place without changing focus, active view or lens,
viewport, graph state, or backend requests. Lens names and descriptions remain
registry-owned data and are displayed verbatim. Opening either menu suppresses
its trigger tooltip so the tooltip cannot cover the menu heading.

Three toggleable regions surround the canvas: the **left dock** and the
**bottom panel** each host ONE exclusive panel; the **right zone** is a
tabbed panel host with a single open/closed switch. The top-right controls
`left-panel-toggle`, `bottom-panel-toggle`, and `rail-toggle` explicitly
toggle the three regions in that visual order after Customize Layout and
expose their current state through `aria-pressed`. Their custom panel icons
outline the whole shell and fill only the active region in white; active state
does not use a blue button background. Opening a closed exclusive region selects its first
registered panel (Library on the left, Activity on the bottom). Existing
panel-specific sidebar and status-bar toggles continue to select or close
their named panel through the same `ShellLayout` signals.
All three are pointer- and keyboard-resizable and all layout state persists per-browser (see
"Layout persistence"). The status bar is a separate thin strip - it is NOT
the bottom panel and never toggles with it.

At 520 px and below, the activity rail compacts to icons and each open side
surface becomes a full-width sheet below the workflow tabs and beside the
activity rail. The canvas is hidden while a dock or rail sheet is open, so
panel content never obscures workflow tabs or the status bar. If the dock and
independent right zone are both open, the sheets split the available height
and retain their own scrolling. The bottom panel is temporarily hidden while
a side sheet is present; its persisted selection is unchanged. Side resize
separators are hidden in this mode because their persisted wide-layout sizes
do not determine sheet width.

## Customize Layout

The `layout.customize` command opens **Customize Layout** through the native
ModalHost. It is discoverable from the compact Customize layout icon button at
the front of the topbar's right-side layout group, in universal search's Commands provider, and in
the application menu's View group. Every entry point dispatches the same
`layout.customize` registry command. The dialog intentionally offers only
regions the current shell can really control: Activity bar, Primary dock,
Bottom panel, Right rail, and Status bar. It does not advertise secondary
sidebars, floating windows, placement, or panel alignment.

The controls are native labeled checkboxes grouped under a Visibility
fieldset, so Tab and Space use browser keyboard behavior and checked state is
announced by assistive technology. The ModalHost supplies Escape, backdrop
dismissal, initial focus, and focus restoration to the invoking menu button.
Reset visibility restores the shell defaults (including each dock zone's
default open state) without changing user-resized region dimensions or the
right zone's tab membership and order.

Visibility uses existing shell state rather than a second layout model. The
Primary dock and Bottom panel checkboxes apply the same close/open-first-panel
operations as the topbar controls; hiding either closes its current panel,
while panel-owned document/application data remains authoritative and the
choice persists. The Right rail checkbox writes the right dock zone's open
state, leaving its tab membership and active tab untouched. Hiding the Activity bar
does not close an open dock. The Status bar and Activity bar stay mounted with
the HTML `hidden` state, and the status bar's contents are therefore not
recreated when it is shown again.

## Document tabs

Workflow documents use the dedicated `WorkflowTabs` shell primitive, not the
presentation-only `ProductTabs` content primitive. The strip exposes a named
`tablist`, one `tab` per document, and a labelled workflow-editor `tabpanel`.
Exactly the active workflow is in the tab order. Left/Right wraps and activates,
Home/End moves to the first/last workflow, and Delete requests close. Closing
from the keyboard or a focused close action restores focus to the resulting
active tab, including after dirty-close confirmation.

The navigation and tablist names, close/new controls, document-state
qualifiers, context actions, and live-preview choices follow the active locale
while mounted. An open context menu and preview submenu update in place without
changing the active workflow, tab identity, focus, scroll position, preview
override, or caller-owned workflow title.

Tabs can be reordered by pressing a tab and dragging horizontally. Movement
under 4 px remains an ordinary activation click. Once the threshold is
crossed, the tab immediately lifts with reduced opacity and an inset highlight. A blue
insertion marker remains visible before its current drop position for the
whole drag, while the strip reflows live as the pointer crosses neighboring
tab centers. A semi-transparent miniature of the dragged tab (its title)
follows the cursor at a small fixed offset for the whole drag, so the held
tab is visible rather than implied; it ignores pointer events and disappears
on release or cancellation. Pointer release commits the new persisted order and pointer
cancel restores the original order. Reordering does not change the active tab
and does not alter click activation, middle-click close, close buttons, dirty
or collaboration indicators, frozen styling, or keyboard focus behavior.
The initiating pointer owns the gesture until it releases or cancels; other
primary pointers are consumed rather than replacing that session. If pointer
capture is lost, the preview rolls back immediately but the owner remains
tracked through its eventual release so the browser's ensuing click cannot
activate the dragged tab. Tabs use `touch-action: pan-y`: vertical native
touch scrolling remains available while horizontal movement belongs to tab
reordering instead of being canceled by a native horizontal pan.

**Move to new window** in a workflow tab's right-click context menu moves the
live workflow into a separate window. The menu targets the right-clicked tab,
opens from the keyboard via the context-menu key or Shift+F10 on the focused
tab, and only a real tab opens it - right-clicks on the new-workflow button or
empty strip space keep the native event. The entry is offered only where
popping out is available (the primary window); there is no always-visible
pop-out button. Releasing a
started tab drag more than 24 px outside the editor split region performs the
same tear-out; releases inside the region target split panes and strips
instead (see Editor splits below).
The primary window stops rendering an assigned workflow, while the child keeps
its identity and offers **Move back to main window**. Both views dispatch to
the same SharedWorker-owned document revision and observe shared edit, undo,
redo, and execution state. The Electron host persists and restores native
assignments; browser-only launchers coordinate ordinary pop-out windows over a
same-origin channel.

The strip has no vertical scroll axis. If enough tabs exceed the available
width, horizontal overflow remains `auto`: wheel/trackpad/touch scrolling can
reach every tab, and a scrollbar appears only while horizontal overflow
exists, using the app-wide thin dark scrollbar styling.

## Editor splits

The center region renders the split tree from `editor-layout.ts`: leaves are
editor groups, each with its own `WorkflowTabs` strip and a labelled editor
`tabpanel`; interior nodes are binary row/column splits with draggable ratio
dividers. `editor-split-rects.ts` computes a pixel rect for every pane and
divider inside the region, applied as region-relative percentages so a
region resize reflows the panes in the same layout pass; ratio drags and
structural changes restyle the existing pane elements instead of remounting
them - a live canvas keeps its viewport through a split or a divider drag.
Each pane's stage is a
CSS inline-size container and reports its true laid-out width, preserving the
App View container-width breakpoint per pane: a narrow pane renders the
mobile presentation while a wide sibling stays desktop.

Splits are created from a tab's context menu (**Split right**, **Split
down**) or by dragging a tab: dropping on the outer band of a pane splits
that pane on the matching side, dropping in a pane's center moves the tab
into that group, and dropping on another group's strip inserts it at the
pointer position. A tinted preview rectangle shows the claimed half or pane
for the whole hover, and the cursor-following tab ghost signals refusal
(depth limit, sole-tab self-split, non-primary window) instead of silently
dropping. **Unsplit** merges a group into its reading-order neighbor. Every
gesture is one atomic layout commit: split create, split dissolve, tab move,
and ratio drag each persist exactly once on release.

One group is focused, and the focused group's active tab is the global
active tab; activating a tab in another group moves focus there. Dividers
are keyboard-operable separators (arrow keys nudge the ratio) and expose
their ratio through `aria-valuenow`. F6 / Shift+F6 (`view.focusNextEditorGroup`,
`view.focusPreviousEditorGroup`) cycle focus through groups in reading
order.

The layout persists in the project-scoped `editor.splitLayout` setting
(`EditorSplitStore`, following the dock-layout pattern) and is validated at
the read boundary. Tab lifecycle stays split-blind: on every render the
stored tree is repaired against the live open-tab list - unknown ids drop,
orphan tabs append to the focused group, emptied groups prune, and
single-child splits collapse - so closing, opening, and restoring tabs need
no split-aware code. Pop-out workflow and panel windows always render a
single group; split surfaces are absent there.

## Workflow files and save feedback

**Export workflow** is available from the application menu and universal
search for every live (non-execution-snapshot) tab, independent of backend
connectivity. It downloads pretty-printed `.json` through the same fresh
environment-stamping path used by library saves. The filename is the tab title
with filesystem-reserved characters replaced; an empty result becomes
`workflow.json`. The temporary browser object URL is revoked after the click.

**Import workflow from file** accepts `.json`, parses it through the same
`openDocument` load, migration, validation, environment-drift, and editor
default path as a library open, and activates the imported document tab. That
ingress also recognizes full ComfyUI/LiteGraph workflow JSON and routes it
through the existing schema-aware legacy importer. Invalid JSON and rejected
documents remain on the current tab and report visibly in Problems plus the
status bar. If the imported lineage is already open, the imported copy receives
a fresh lineage so it opens beside the existing session instead of replacing
it or discarding that session's unsaved edits.

An absent or empty `definitions.subgraphs` field is valid in an ordinary or
template workflow. A nonempty field still fails with
`import.subgraphs.unsupported`: current ComfyUI templates can contain real
structural subgraph definitions, and Dinkster does not flatten or guess at them.

The status bar has a polite live region for transient operation feedback. A
successful library save reports `Saved to <backend> library`; a failed save
keeps its `library.saveFailed` Problem and also reports there. Ctrl+S on an
execution snapshot or a tab targeting a ComfyUI-protocol backend is consumed
and explains why it cannot save instead of silently doing nothing. The latter
message names the targeted backend and its current connection state, matching
the backend whose connection/schema indicator the active tab already uses.
Messages clear automatically after four seconds and temporarily reveal the
status bar even when the user's layout setting hides it.

## The left dock

A tabbed dock zone between the icon sidebar and the canvas. Multiple panels
remain available in its tab row while exactly one body per section is
visible (see "Dock zone sections"). In wide
mode, the dock shares the flex row with the canvas, so opening it shrinks the
canvas rather than covering it. In narrow mode it uses the contained sheet
behavior described above.

Panels:

- **Library** (`library-toggle`, Ctrl+O): the collection browser over Packs,
  Templates, Workflows, History, and Runs. Its body names the active backend,
  protocol, and connection state; see [Library](library.md). Activating an entry
  that opens a document closes the dock, matching the previous overlay
  behavior.
- **Backends** (`backends-sidebar-toggle` in the sidebar, or the `Backends`
  status-bar button): connection rows (status, schema count, protocol chip,
  engine state, restart/remove) and the add-backend form. User-added backends
  sync across same-origin tabs through browser storage events. Each tab
  applies external adds/removes through the normal connection lifecycle while
  retaining its own live connection object for backends present in both tabs;
  event application does not write the list back to storage.

`DockZoneHost` owns the tab row, active-panel actions, close button, and scroll
body. A named separator on the right edge resizes the zone from 280-640 px.
Arrow Left/Right changes the size by 16 px, while Home/End selects the
minimum/maximum. Pointer resizing previews continuously and commits once on
release. Test IDs: `dock-panel` (`data-active-panel` names the visible body),
`dock-zone-left`, `dock-zone-close`, and `dock-resize`. The library body exposes
the `library-overlay` test ID even though it is not an overlay.

The status-bar `Backends` button and the sidebar icon toggle the same dock
panel; both reflect pressed state via `aria-pressed`.

The 72 px activity rail stacks each centered label beneath its thin 20 px
glyph in a full-width 72 px action. Labels may wrap to two lines without
widening the rail, and every action
participates in the rail's custom tooltip session so the full descriptor text
remains available. Buttons retain normal document tab order, explicit
accessible names, pressed state for panel toggles, hover feedback, and a
visible keyboard focus ring. Its panel toggles occupy a scrolling
placement-driven stack, while Settings is a separate labeled gear button
pinned below that stack at the rail bottom and dispatches the existing
`settings.open` command.
Toggles whose descriptor's effective
placement is `dock` stay at the top; toggles effectively placed in `bottom`
anchor at the bottom. Runtime registrations and placement moves use the same
registry queries, so their icons join the cluster for the region they open.
Within either cluster there are no visual gaps or button boundaries between
adjacent items. Once one delayed tooltip has appeared, pointer travel between
targets in the same rail session replaces it immediately without a hidden
frame. A visible tooltip may bridge empty rail space for 300 ms so crossing
between clusters remains forgiving, then hides if no target is reached.
Leaving the rail boundary hides immediately, so a later re-entry uses the
configured delay again.

## The bottom panel

A tabbed dock zone under the canvas column. Multiple panels, such as Problems
and Activity, can coexist in its tab row while exactly one body per
section is visible; its two sections sit side by side (see "Dock zone
sections").
It shares the canvas pane's column flex, so opening it shrinks the canvas. The
same `DockZoneHost` chrome supplies the tab row and active-panel actions. A
named separator on the top edge resizes the zone from 120-480 px; Arrow Up/Down
grows or shrinks it, and Home/End selects its minimum/maximum. Test IDs:
`bottom-panel` (`data-active-panel` names the visible body),
`dock-zone-bottom`, `dock-zone-close`, and `bottom-resize`.

Resident panel:

- **Activity** (`logs-toggle`): structured UTC timestamp, severity,
  source, and message rows with deterministic empty and tail-following states.
  Its Clear header action requires a second activation within four seconds.
  Bottom by default (a wide, short surface suits streaming rows); `dock`
  remains an allowed placement. See `docs/activity-log.md`.

Panels with bottom-zone membership get their toggle in the bottom-anchored
cluster of the same icon sidebar as left-zone panels. The toggle's cluster and
routing both derive from durable `DockLayout` membership, so a cross-zone move
survives reload and moves the panel's icon and behavior together.

## The right zone

A tabbed panel host (`queue`, `outputs`, `extensions`, `boundary`,
`surfaces`, `problems`; some conditional via `when()`), toggled as one unit
by the topbar `rail-toggle` and drag-resizable via the grab handle on its
left edge (`rail-resize`, clamped 240-560 px). `DockZoneHost`
(`ShellChrome.tsx`) renders one tab row per section through the shared
`ProductTabs` primitive - so the ARIA tablist, roving tabindex, and keyboard
traversal are the primitive's, not bespoke - with exactly one visible panel
body per section (see "Dock zone sections").
The left and bottom zones use the same host and keyboard/ARIA contract.
Inactive bodies stay mounted (hidden by the tab primitive), so panel state
survives tab switches. Each section owns its panel bodies through dedicated
reactive roots: a body created when a panel enters the zone stays live across
later membership and layout changes until the panel leaves the zone (or the
section unmounts), at which point it is disposed. A panel that floats away
and docks back gets a fresh, fully reactive body rather than a stale one.
Tab membership, order, each section's active tab, the
section split, and open state for all three zones live in `DockLayout`
(`dock-layout.ts`, exposed as `app.dock`) and persist as one value (see
"Layout persistence"). A stored tab
renders only while its panel is registered, allowed in that zone, attached,
not floating or windowed, and allowed by its `when()` condition. Unavailable
panels keep their saved membership and return to the same position; a hidden
active tab uses the first rendered tab without replacing the saved active
choice.

Rendered dock-zone tabs can be dragged with a mouse, pen, or touch pointer.
Movement under 4 px remains tab activation. Crossing the threshold captures
the pointer and shows one fixed overlay: a zone highlight or insertion caret,
plus a shield that prevents the canvas from receiving the gesture. The overlay
also renders a cursor-following ghost: a semi-transparent miniature of the
dragged tab showing its icon (when the panel declares one) and title at a
small fixed offset from the pointer. The ghost switches to a refusal style in
step with the target highlight whenever the current target would refuse the
drop, ignores pointer events, and disappears on release or rollback. Geometry
for every visible zone, tab slot, and hidden-zone edge is captured on press;
pointer movement performs no DOM geometry reads. Scrolling, resizing, Escape,
pointer cancellation, or capture loss rolls the session back.

A tab strip selects an insertion index, a zone body appends, and the outer
24 px screen edges target their corresponding zones. While a zone shows one
section, its far half (the lower half of a side zone, the right half of the
bottom zone) is a split target that opens a second section holding the
dropped tab; the drop preview highlights just that half and labels it
("Dock in lower half" / "Dock in right half"). A zone's only tab gets no
split target. Closed zones expose a
slim ghost bar while dragging and expand to a full drop preview when targeted.
Only tabs with visible boxes participate in insertion mapping. The empty strip
tail and all-tabs overflow button append after tabs hidden by overflow.
Targets outside a panel's `allowedPlacements` remain visible with a
not-allowed cursor and refuse the drop. The canvas floats panels that allow
`floating`. No layout state or settings change before release; a successful
release commits once through `movePanel`.

The host owns one trailing action cluster for the ACTIVE panel - the
descriptor's header action and the zone close button. There are no
always-visible placement buttons: placement moves
(Float when `floating` is allowed, Move to new window when `window` is
allowed) live in each tab's right-click context menu, served by the shared
styled `ContextMenu` rather than the native browser menu. The menu targets
the right-clicked tab (not just the active one), opens from the keyboard
via the context-menu key or Shift+F10 anchored to the focused tab, and
Escape returns focus to that tab. Only a real zone tab opens it:
right-clicks inside panel bodies, on trailing header actions (header
action, close), or on all-tabs overflow menu entries never do. The zone itself is
a named section landmark. The zone separator uses Arrow Left/Right plus
Home/End with the same 16 px step and clamping contract as the dock.

Customize layout, section and divider names, overflow controls, zone close,
and Float/Dock/new-window placement actions follow the active locale while
mounted. Open placement menus update without remounting panel bodies,
changing the active tab or split, moving floating panels, or translating
caller-owned panel titles and indicator text.

When the tab row is narrower than its labels, tabs shrink to a 64 px
ellipsis floor instead of scrolling - the strip never shows a native
scrollbar - and every tab label carries its full title as a product
tooltip. When even the floors do not fit, the action cluster gains an
all-tabs menu (`dock-zone-overflow-button`) listing every tab with the
active one checked. Tabs that cannot fit as a complete floor are fully
hidden rather than clipped; activating a hidden entry selects it and makes
it a whole visible tab. Arrow-key traversal covers the visible tab row,
while the all-tabs button keeps every hidden tab reachable by keyboard and
pointer.

The queue tab is active-workflow scoped. It uses the same lineage-filtered
entries as the center-region queue disclosure and never displays the
backend-wide queue depth as though it belonged to one workflow.

Every move between a zone, floating, and a separate window goes through one
boundary: `movePanel` / `returnPanelToZone` (`panel-location.ts`). It
validates against the descriptor's `allowedPlacements`. `PanelRegistry` owns
descriptors, placement legality, and floating/window overrides; `DockLayout`
owns durable zone membership, tab order, active tab, and open state. A stored
legal zone remains authoritative after reload even when it differs from the
descriptor's default placement. A refused move mutates nothing.

## Dock zone sections

Each dock zone hosts one or two sections, VS Code / Krita style: side zones
stack sections vertically, the bottom zone places them side by side. Every
section is its own tab strip plus one visible panel body, so a zone can show
two panels at once. With one section the tablist keeps the zone label
("Inspector panels"); with two, each tablist appends its half ("... upper /
lower section" on side zones, "... left / right section" on the bottom). The
first rendered section owns the zone-wide close button; every section's tabs
offer the same right-click placement menu (Float / Move to new window) and
the same drag behavior as any dock tab.

A second section opens by dropping a tab on the split target (the far half
of a zone showing one section) and closes when its last tab leaves: the zone
collapses back to one section and the split returns to 50/50. A section
whose panels are all hidden (unregistered, floating, windowed, or
`when()`-gated) does not render but keeps its stored membership, so its
panels return to the same section later. Zone-level consumers (activity-bar
pressed state, indicator aggregation, the active-panel attribute) read the
flat view spanning both sections.

The divider between two sections (`dock-section-divider-<zone>`) is an ARIA
separator whose `aria-valuenow` reports the first section's share (10-90).
It drags with any pointer and resizes from the keyboard: arrow keys move the
split in 5% steps along the zone's axis (Down/Up on side zones, Right/Left
on the bottom), Home and End jump to the 10% / 90% clamps. The split
persists with the rest of the dock layout.

Universal dockability: every zone-hosted panel accepts all three zones
(`dock`, `rail`, `bottom`) plus `floating` and `window`, so any zone tab can
be dragged to any zone and every zone tab's context menu offers Float and
Move to new window. Placement legality still flows from `allowedPlacements`
through the same `movePanel` boundary, and modal-only surfaces stay modal.
A panel whose `when()` gate answers false renders nothing wherever it is
placed - zone tabs, the floating overlay, and a separate panel window
(which shows its panel-unavailable view) - and keeps its placement
override, so the panel returns when the gate flips back.

## Layout persistence

Shell state persists per-browser through the settings machinery - overrides
only, validated at the read boundary (FR11), never backend-synced. Ownership is
split by concern:

- `ShellLayout` (`packages/app/src/shell-layout.ts`, exposed as `app.shell`)
  owns shell geometry and the activity/status bar switches.
- `shell.layout.activityBar.visible` / `shell.layout.statusBar.visible`: the
  two independent bar switches (both default `true`).
- `shell.dock.layout`, owned by `DockLayout`: one versioned, validated,
  project-scoped value holding every dock zone's sections (each section's
  tab membership, order, and active tab), the section split, and open
  state. Writes always use the `v: 2` shape
  (`zones.<zone>.{sections, split, open}`); a stored `v: 1` layout (one
  flat tab list per zone) still decodes as a single section with a 50/50
  split, so layouts saved before sections existed load unchanged.
  Construction never
  writes: until the first mutation the stored value stays empty and the
  shell renders the *effective* state, which appends every registered
  zone-default panel (in registry `order`) to its default zone. Mutations
  rebase on the effective state, so the first persisted value already
  contains the derived membership. Stored tab ids whose panels are not
  (currently) registered keep their place rather than being dropped;
  duplicate ids keep their first position, out-of-range splits clamp to
  10-90%, and zones with more than two stored sections are refused as
  malformed. An
  external reset to `''` returns to the derived defaults without
  persisting; malformed values are ignored.
- `shell.layout.left.width` / `shell.layout.right.width` /
  `shell.layout.bottom.height`: region sizes, clamped by
  `REGION_SIZE_BOUNDS` (the single source of truth for setting definitions
  AND drags).
- `dinkster.floatingPanels`: panel ids currently hosted as floating overlays.

Electron stores native primary, workflow, and panel window bounds separately
in `window-layout.json`. The versioned layout rejects malformed and duplicate
assignments, restores maximized state, and relocates off-screen windows when a
display is unavailable.

Every left/bottom panel show or hide and every placement move uses the
`panel-location.ts` boundary and therefore inherits DockLayout persistence.
The ShellLayout binding remains two-way for bars and dimensions: a settings
write the shell did not make updates the live layout instead of waiting for a
reload, with a last-seen-value guard so shell writes never echo back and an
unrelated settings change never clobbers an in-flight drag preview. Sizes
update live during a drag through `previewSize` and persist once at drag end
through `commitSize`; the shared gesture
(`beginRegionResize`) covers all three regions, is owned by the pointer
that started it (foreign pointers ignored; pointercancel disposes without
committing), returns an AP8-idempotent disposer, and is sign-aware (left
grows rightward; rail and bottom grow toward the canvas). Canvas viewport
and lens choice stay per-view session state, deliberately not persisted
here. Keyboard separators use the same preview/commit path and clamp each
discrete key action before committing it.

## The panel registry

Shell panels are not hardcoded JSX branches: `App.tsx` renders the sidebar
toggles, the dock/bottom bodies, and the right-zone tabs from `PanelRegistry`
(`packages/app/src/panels.ts`, exposed as `app.panels`). Each panel is a
descriptor: stable id, title, a component factory, an ordered placement, and
the set of placements it may legally occupy.

Placement vocabulary (`PanelPlacement`): `dock`, `rail`, `bottom`, `modal`,
`floating`, `window`. The shell actuates `dock` (a tab in the left zone),
`rail` (a tab in the right zone), `bottom` (a tab in the bottom zone), and
`modal` (the root modal host, below), `floating` (a movable, resizable overlay),
and `window` (a browser or Electron child window). A floating panel's header
keeps Dock as its one visible chrome button; right-clicking the header (or
pressing the context-menu key or Shift+F10 on the focused Dock button) opens
the shared styled context menu with Dock and, when the descriptor allows
`window`, Move to new window - Escape returns focus to the Dock button.
Native panel windows render
only their assigned body and re-dock to the prior dock, right-zone, or bottom
host - a right-zone return restores the panel's saved tab spot. Moving a
panel between placements goes through the `panel-location.ts` move boundary
(see "The right zone"), which validates against the descriptor's allowed
set - never a JSX edit.

Registered panels: `library`, `assets`, `backends`, `memory` (dock), `logs` (bottom),
`settings` (modal), and `queue`, `outputs`, `extensions`, `boundary`,
`surfaces`, `problems` (rail; some are conditional via a `when()` guard).
Panel ids are stable open strings; the registry, not a closed union, is the
source of truth for what exists.

## SurfaceContext: what a host tells its body

Every host - dock, bottom, rail, modal - renders a panel body through one
contract: `component(surface)` where `SurfaceContext` carries the current
`placement` and a `requestClose()` with the host's semantics (dock/bottom
close their region, the modal host closes the dialog, the right zone closes
the zone). `requestClose` is idempotent - it closes, never toggles - so a
retained or repeated call can never reopen a surface. Bodies receive
nothing else, so the same content renders in any hosted placement without
knowing where it lives. Dock, bottom, modal, and zone hosts own their chrome
(headers, tab rows, close buttons, backdrops, resize affordances). Existing
feature bodies retain their product semantics, but the host's descriptor
title is the only visible panel heading or tab label.

## The modal host

The `modal` placement is actuated by one root host in `App.tsx`: at most
one modal panel is open at a time, tracked by `app.modalPanel` (the panel
id, `''` = closed). Modal open state is session-only and deliberately never
persisted - modals are decision flows, and reloading into a blocking dialog
would be hostile (`e2e/modal-host.spec.ts` pins this). Stale state is
cleared, not just hidden: an `AppState` subscription on registry changes
closes the modal when its panel unregisters or moves off `modal`, so a
later re-register can never resurrect the dialog
(`app/test/modal-state.test.ts`).

The host is a native `<dialog>` opened with `showModal()`, which supplies
the modal focus contract: initial focus moves inside the dialog, the
background becomes inert (focus cannot reach it), Escape requests close,
and closing restores focus to the opener. The host owns the `::backdrop`
(a press on it closes; the dialog receives the event with coordinates
outside its box), the chrome (`modal-surface` with `data-modal` naming the
panel), and the title header with close button (`modal-close`).
`aria-modal="true"` is set explicitly - redundant on a modal `<dialog>`,
but `CanvasHost` gates canvas shortcuts on `[aria-modal="true"]`. A body
that must swallow keys calls `preventDefault` on the keydown, which
suppresses the dialog's native Escape close request - the settings
keybinding capture does exactly that, so Escape cancels the capture
instead of closing the dialog.

Resident panel: **Settings** (`settings`), opened from the topbar settings
button or the `settings.open` command (Ctrl+,). `SettingsDialog` is a
placement-agnostic body; everything around it is host chrome. With an empty
search query, the left rail browses one active category. Category IDs are
presented as readable labels without changing their registry identity.
Typing searches setting names, ids, and descriptions across every category,
plus command names and ids from the keybinding editor. Results use the shared
search scorer, are grouped under ranked category headers, and remain directly
editable. Search mode adds an All results entry and per-category match counts
to the rail; selecting a category header or a counted rail entry narrows the
current results, while editing the query returns to All results. The visible
result summary announces updates, an authoritative empty result remains
visible, and Clear or Escape resets a nonempty query without closing Settings.

Settings and keybindings share one host-owned field row. It aligns declarative
controls and actions, associates descriptions with their controls, exposes
setting and command IDs as secondary metadata, and presents keybinding
conflicts and invalid numeric drafts as named inline alerts. Invalid numeric
drafts remain local until corrected, so the settings registry never receives a
non-finite or out-of-range value. Escape restores the committed numeric value
and clears its draft validation. The row and navigation chrome use semantic
design tokens. On narrow viewports the category rail scrolls horizontally and
the field rows stack their copy above controls so every action and the result
scroll tail remain inside the dialog.

The initial category is the first category actually derived by the settings
registry (for example `canvas.grid`), never an invented empty parent. Each
setting whose current value differs from its registered default shows a Reset
button; Reset writes that default through `SettingsRegistry.reset`, removes
the persisted override, and disappears immediately. Default-valued settings
do not show a redundant reset action.

Keybinding capture waits through modifier-only keydowns and commits only when
a non-modifier key completes the chord. A completed duplicate chord marks both
commands as conflicting. Reset restores the command's registered default and
clears the conflict when the duplicate no longer exists; Escape cancels an
in-progress capture without closing the settings dialog.

The framework-free `settings-search.ts` builds and queries the same index used
by the dialog. Each entry carries its id, name, category, keywords, and a
serializable open-settings action so the planned `core.settings` universal
search provider can consume the index without extracting search logic from the
component later.

The Problems panel is owner-scoped: every entry in `app.problems` carries an
owner - a tab id for workflow diagnostics (compile, upgrade, drift,
unresolved types, command rejections) or `GLOBAL_PROBLEMS_OWNER` for
app-level feedback (backend connections, schema fetches, library/history
operations without a tab). The panel renders `visibleProblems(problems,
visibleOwners)`: the visible canvases' entries plus all globals. Today the
visible set is the single active tab; a multiple-visible-canvases layout
widens the set, not the model. Background tabs keep their entries hidden,
queueing replaces only the queued tab's entries, and closing a tab drops
its entries. Proof: `app/test/problems-ownership.test.ts`.

The active native backend's compatibility translation skips appear below the
workflow diagnostics in a separate **Compat skips** advisory group. Each row
names `packId: nodeId` and displays the server's refusal reason verbatim.
These nodes are absent from the catalog, not broken nodes in the open
document, so the rows never navigate to the canvas and never create graph
badges. An empty skip list omits the group entirely. The list refreshes with
the existing schema and diagnostics load rather than polling independently.

Visible diagnostics group by their primary structured-ref node, or by their
occurrence/port anchor when refs do not identify a node. Occurrence paths are
walked through subgraph instances, so compile missing-input warnings and
provenance-anchored validation/runtime errors use the affected node's current
title or schema display name while retaining its raw id. Ref-based and
anchor-based diagnostics for one node share one lineage-scoped disclosure
group. Stale or identity-free anchors collect in the final General group.

Each problem summary is only a native disclosure: it expands or collapses the
complete message, runtime hints, suggestions, and traceback without changing
canvas focus or navigation. Anchored entries expose a separate **Show on
canvas** button inside the expanded details. That explicit action switches to
the owning tab, revalidates the anchor against the current document, restores
the exact subgraph instance path, selects the node, and animates the camera
until the node is centered. Unanchored entries have no canvas action. Manual
pan or zoom cancels the animation. An anchor whose node or drill-in path was
deleted is ignored without an error. Pins carrying
solver diagnostics keep their warning ring; hovering one shows every
diagnostic severity and message. Proven-mismatch noodles and their midpoint
grab dots expose the same messages retained on the scene link; healthy noodles
remain tooltip-free. Canvas diagnostic tooltips close when the scene or camera
moves so they never remain detached from their painted anchor. The invalidation is
scoped to canvas-anchored tooltips: DOM chrome tooltips share the same
controller and survive scene rebuilds and camera moves
(`TooltipController.hideMatching`, proof `app/test/tooltips.test.ts`
"hideMatching" cases and `e2e/tests/tooltips.spec.ts`).

The Problems panel is a native text and shortcut scope. Its messages and
expanded detail text can be selected and copied with normal browser behavior;
shell and canvas shortcuts do not consume keys whose event target is inside
the panel. The same shortcuts remain active over the canvas. Long messages,
hints, suggestions, and tracebacks wrap within the rail, while traceback
details retain a bounded scroll area.

Native runtime failures may include processed diagnostic hints. The Problems
detail and the node error-badge popover show each hint below the backend's raw
message and before the raw traceback. A hint keeps its diagnostic code in a
muted prefix, shows its explanation, and places an optional suggested fix on
its own secondary line. Hints are additive guidance: they never replace or
rewrite the backend message or traceback. Missing or malformed hints leave the
existing error presentation unchanged.

## What is a modal, what is a dock

Dock and bottom panels are browse/manage surfaces the user works *beside*:
they must not block the canvas. Modals are reserved for flows that demand a
decision before work continues (settings, node search, asset consent,
import resolution). New shell surfaces should pick a docked placement unless
they genuinely need to block. Settings goes through the modal host; node
search stays a canvas ephemeral, and the asset-consent/import-resolution
dialogs stay request-driven flow dialogs (they appear when a pending
request exists, not when a panel is toggled), so they are not registry
panels. Those request dialogs use the same native product modal chrome,
focus restoration, labelled close action, scrolling body, notices, and
wrapping action footer as registry modals. Asset consent blocks incidental
Escape, backdrop, and close-chrome dismissal while acquisition is busy but
retains its explicit Dismiss action; dismissing never aborts the owned retry.

## Coverage

`packages/e2e/tests/shell-dock.spec.ts` pins exclusivity, toggle/close
behavior from all entry points, canvas-shrinks-not-covered geometry for the
dock AND the bottom panel, region independence, drag-resize bounds for all
three regions, narrow sheet containment, reload persistence,
status-bar/bottom-panel separation, the Ctrl+O shortcut, and the tab
context menu: no Float or pop-out chrome buttons, right-click and Shift+F10
menu opening, Float/Move-to-new-window entries, floating the panel, the
floating header's context menu (Dock and Move-to-new-window entries, no
pop-out button), and Escape focus restoration.
`packages/app/test/shell-chrome.dom.test.tsx`
pins the menu's per-tab targeting, placement legality, the tab-only
trigger (panel bodies, trailing header actions, and all-tabs overflow
entries never open it), the keyboard anchor, and the floating header
menu's gating, keyboard path, and Dock-button focus restoration.
`packages/app/test/panel-drag.test.ts` pins panel-drag geometry snapshots,
thresholds, hidden-tab and overflow-button targeting, legality,
previews, pointer ownership, and rollback.
`packages/e2e/tests/panel-drag-docking.spec.ts` pins dragging from all three
zone tab strips, cross-zone reload persistence, hidden-tab tail and
overflow-button append, hidden-zone reveal, floating, atomic persistence,
geometry-read discipline, canvas isolation, refusal, and interruption rollback.
`packages/app/test/WorkflowTabs.dom.test.tsx` pins workflow-tab ARIA,
keyboard navigation, close routing, state labels, new-workflow routing, and
the tab context menu (Share and Move to new window, the tab-only trigger,
the keyboard anchor, and no pop-out chrome button).
`packages/app/test/shared-worker-connection.test.ts` and
`workspace-multiwindow.test.ts` pin canonical cross-window edits, undo,
reconnect, malformed mutation rejection, and execution visibility.
`packages/e2e/tests/shell-tabs.spec.ts` pins workflow-tab activation,
reorder, focus, close, overflow, shell geometry, and the context-menu
move to a new window (pointer and keyboard paths, the tab-only trigger,
and no pop-out chrome button). `packages/e2e/tests/modal-host.spec.ts` pins the modal
host: close via button/backdrop/Escape, the Ctrl+, command, overlay (not
shrink) geometry, the focus contract (initial focus inside, inert
background, restoration to the opener), Escape-during-capture staying in
the body, and session-only open state across reload;
`app/test/modal-state.test.ts` pins the stale-modal guard.
`app/test/shell-layout.test.ts` pins persistence
round-trips, FR11 fallback on tampered sizes, exclusive-toggle semantics,
clamping, and the shared resize gesture (single commit at drag end,
AP8-idempotent disposer).

## Universal search

The always-visible centered topbar control reads "Search Dinkster (Ctrl+K)".
It and the rebindable `search.open` command open one modal search overlay,
including when no document tab exists. Results are grouped by provider and
support Arrow Up/Down, Enter, Escape, and a five-result group cap with Show
more. Prefixes route directly to commands (`>`), nodes (`@`), settings (`#`),
and open tabs (`~`). Node activation and ordinary Add node palette picks share
one placement interaction: the selected node follows the pointer without
editing the graph, the pointer marks the center of its title bar at every zoom,
and the next canvas click inserts it. Escape, leaving the canvas, changing tabs
or graphs, freezing the tab, or invalidating the selected schema cancels or
hides the preview as appropriate. Dropping or splicing a noodle remains an
immediate atomic insertion at the noodle's release point, and Reroute remains
immediate.

The Add node palette's Input and Output type filters are independent product
disclosures. Each trigger reports either `Any type` or its selected count.
Enter or Space opens the anchored filter, search matches type labels by
case-insensitive substring, Arrow Down enters the result rows, and Enter or
Space toggles the focused row immediately. Escape closes the filter and returns
focus to its trigger; clicking another palette control closes the filter while
preserving that control's click. Opening, closing, searching, and keyboard
navigation never edit the document.

## Boot indicator (pre-render discovery window)

Before the shell mounts, `main.tsx` awaits `discoverBackend()` to pick the
same-origin protocol. On a slow or dead origin that await holds for up to
the probe timeout (2500ms), leaving `#root` blank. The boot indicator
fills that window with a minimal centered pulse and the product name so the
launch is never a blank screen.

Timing contract (`packages/app/src/boot-indicator.ts`):

- The indicator appears only after **150ms**. A fast boot that discovers
  and renders before then never flashes it.
- After **3000ms** an additional line names what it is waiting on
  ("Waiting for backend discovery...").
- `hide()` cancels both timers and removes the element. It is called the
  moment `discoverBackend()` resolves, before Solid's `render()`.

The indicator is plain DOM/CSS (no framework, no new dependencies) and
never blocks or delays startup - it is appended to `#root` and removed
before `render()` replaces the root's content. The discovery/probe logic
itself is unchanged; this is presentation only.

Coverage: `app/test/boot-indicator.test.ts` pins the show-after-delay,
no-flash-on-fast-boot, message-after-3000ms, hide-cancels-both-timers,
idempotent-hide, and custom-delay contracts via an injected scheduler
(matching `supervisor-poll.ts`'s test pattern). The DOM mount/unmount is
presentation-only and E2E-covered, not unit-tested.
