# Node palette

The node palette is the canvas-local browser for nodes, subgraphs,
blueprints, and utilities. Double-clicking empty canvas opens it with its
top edge centered on that point. Dropping a link on empty canvas opens the
same surface with compatible entries, and double-clicking a link can open it
with both endpoint filters; every spawn point uses the same top-centered
anchor, shifted only as needed to keep the whole surface visible.

## Search and browsing

The palette uses the host-owned `SearchInput`, `SearchResultGroup`,
`SearchResultRow`, and `SearchState` vocabulary. The input owns an option-only
listbox through `aria-controls` and `aria-activedescendant`. Up/Down changes
the active result, Enter chooses it, and Escape closes the palette. The active
row stays visible while the result region scrolls. Pointer movement can
highlight another row, but rows scrolling under a stationary pointer do not
replace keyboard selection.

Categories are an expandable navigation browser, not an ARIA tree. Kind
chips, `kind:`, `in:`, and `out:` query tokens, and the searchable Input and
Output type dialogs narrow the same canonical entry set. Multi-select type
filters match canonical and legacy type names case-insensitively, use OR
within one direction, and use AND between input and output directions. A
no-match state is announced outside the empty listbox. If the live catalog
changes while a no-match query is open, the first new match becomes active.

## Preview and placement

The preview shows the highlighted entry's rendered node, description,
canonical input and output types, optionality, widget kind, dynamic-family
kind, and deprecation or experimental status. Blueprint boundary hints are
labelled as declared because the body is not fetched before activation.

Browsing and highlighting never mutate the workflow. Ordinary node,
subgraph, and blueprint choices arm the existing pointer-following placement
ghost, which appears at the current cursor position the moment the choice is
made when the cursor is inside the canvas; a canvas click commits and Escape
cancels. Link-drop, link-splice, and reroute choices retain their existing
immediate atomic placement behavior.

The root and type-filter dialogs reuse `.floating-surface` chrome and
`placeFloatingSurface` containment. The host owns markup, tokens, focus,
ARIA, overflow, and Canvas interaction. Entries supply typed schema,
blueprint, and action data only.

Host-owned labels, filter text, announcements, empty states, and preview
headings use the active application locale and update while the palette or a
type-filter dialog remains open. Node names, descriptions, categories, ports,
types, tooltips, widget kinds, and dynamic-family identifiers remain
pack-provided data.

At narrow widths, categories and results stack vertically and the schema
preview is hidden so browsing and keyboard placement remain reachable. Hidden
preview controls are excluded from the modal Tab loop.

## Verification

Component tests cover listbox ownership, active-descendant keyboard flow,
empty-to-populated catalog changes, category disclosure, type-filter focus,
modal focus containment, live locale changes, and edge placement. Browser tests
cover long content, schema preview, case-insensitive type filtering, categories,
type-filter dialogs, live locale changes, keyboard tail scrolling, no-match
state, no mutation before activation, placement cancellation, and 1600x950,
1366x768, and 360x640 containment.
