# Node palette

The node palette is the canvas-local browser for nodes, subgraphs,
blueprints, and utilities. Double-clicking empty canvas opens it with its
top edge centered on that point. Dropping a link on empty canvas opens the
same surface with compatible entries, and double-clicking a link can open it
with both endpoint filters; every spawn point uses the same top-centered
anchor, shifted only as needed to keep the whole surface visible.

## Search and browsing

The palette uses `ProductSearch` for the field, kind tabs, one-line results,
type menus, key hints and beside-list preview. The input owns an option-only
listbox through `aria-controls` and `aria-activedescendant`. Up/Down changes
the active result, Enter chooses it, and Escape closes the palette. The active
row stays visible while the result region scrolls. Pointer movement can
highlight another row, but rows scrolling under a stationary pointer do not
replace keyboard selection.

Before typing, Recent lists the last placements and Categories opens a list
with a way back. Named kind tabs, `kind:`, `in:`, and `out:` query tokens,
and Takes and Gives menus narrow the same canonical entry set. Multi-select type
filters match canonical and legacy type names case-insensitively and require
every selected input and output type, just like repeated typed filters. A
no-match state is announced outside the empty listbox. If the live catalog
changes while a no-match query is open, the first new match becomes active.
Catalog refreshes update entries and category counts without closing search.

## Preview and placement

The preview shows the highlighted entry's rendered node, name, description,
category and pack, with deprecation or experimental status. The drawing shows
ports directly instead of repeating an interface list below it. Blueprint
boundary hints are labelled as declared; bodies are not fetched before activation.

A dropped wire appears as a removable type chip; compatible node rows name
the connection target. Removing the chip keeps the query and clears only the
pending connection. Uninstalled nodes come from the shared registry catalog
and open the same validated install prompt as Ctrl+K. They are never offered
for wire-drop or link-splice placement.

List and file forms appear directly beneath their type with plain names.
Pins use the node's circle, list diamond and either-input shape. A list
filter or dropped list wire also finds matching inputs that accept a whole
list; scalar-only inputs remain incompatible with list wires.

Browsing and highlighting never mutate the workflow. Ordinary node,
subgraph, and blueprint choices arm the existing pointer-following placement
ghost, which appears at the current cursor position the moment the choice is
made when the cursor is inside the canvas; a canvas click commits and Escape
cancels. Link-drop, link-splice, and reroute choices retain their existing
immediate atomic placement behavior.

Ordinary insertion selects the new node only after the command is accepted.
While acceptance is pending, the document and selection remain unchanged.
A refusal shows the canvas command notice without adding a node. A later
selection or navigation is not replaced by a delayed insertion result.

The shared search owns chrome, keyboard navigation and ARIA; the canvas host
owns point-anchor containment through `placeFloatingSurface` and canvas
interaction. Entries supply typed schema, blueprint, and action data only.

Host-owned labels, filter text, announcements, empty states, and preview
headings use the active application locale and update while the palette or a
type menu remains open. Node names, descriptions, categories, ports,
types, tooltips and widget kinds remain pack-provided data.

At narrow widths, the shared search hides the preview so browsing and keyboard
placement remain reachable. Hidden preview controls are excluded from the
modal focus loop.

## Verification

Component tests cover listbox ownership, active-descendant keyboard flow,
empty-to-populated catalog changes, category browsing, type filters,
modal focus containment, live locale changes, and edge placement. Browser tests
cover long content, schema preview, case-insensitive type filtering, categories,
type menus, live locale changes, keyboard tail scrolling, no-match
state, no mutation before activation, placement cancellation, and 1600x950,
1366x768, and 360x640 containment.
