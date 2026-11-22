# Canvas rendering

Canvas surfaces and text project the shared dark/light palette from
`branding/tokens/dinkster-colors.json` through the semantic tokens. The dark
theme uses cyan-tinted greys for its background, node body, header, inset
fields and outlines; wire/type colors and status hues are unchanged.
Node value fields use the dedicated `bg.field` palette entry (`#0B1111` in
dark, the unchanged light canvas color in light), leaving other inset
surfaces on `bg.canvas`. Queued and skipped outlines use `border.pending`
and `border.skipped`, preserving light values `#5C5C5C` and `#7D8792`.
Data heatmaps keep their data colors. Muted text on a dark panel has 4.64:1
contrast. Canvas layers receive the current background and grid colors in
their draw context. Grid patterns repaint when the theme changes; light grid
dots use the light `border.default` (`#D3D9DE`), not the dark constructor
palette.

The canvas keeps the graph scene separate from the camera. On browsers with
transferable offscreen bitmaps, graph paint is retained in device-pixel tiles.
A camera-only move reuses visible tiles when the scale and backing density
match. The logical camera retains fractional movement, while painting rounds
translation to physical pixels. This keeps retained text sharp without
resampling and limits visual translation steps to one physical pixel. Newly
exposed tiles are painted from the scene. A rebuild bins node and link bounds
once into missing tiles, including paint padding and bleed; each tile keeps
the same graph order, clipping and raster origin. Tiles outside the visible
working set are closed rather than retained indefinitely.

Tiles are copied at their original pixel size, never stretched. Zoom changes
repaint at the new scale, preserving sharp text and geometry. Node selection,
drag, resize, presentation and committed edits retire tiles touching the old
and new node bounds and connected links, retaining distant images. Tile
invalidation includes badge extents, paint padding, bleed and selection-union
outlines. Mutable preview sources repaint their supplied nodes even when the
image object is unchanged. Structural edits, compound gestures, theme and
style changes conservatively retire the complete graph. Disposing the
renderer closes its remaining images. Running-node frames retain direct graph painting and never
reuse graph images. Without transferable offscreen bitmaps, settled scenes
repaint the complete scene on fresh canonical offscreen surfaces, without
retained images or candidate bins. Shared raster origins and transparent
composition keep those settled redraws equivalent to retained imagery.
Browsers without OffscreenCanvas also retain direct graph painting.

Tile assignment unions live node-body and pin padding with external badge
extents, including hover expansion and resize projection, before applying
drag offsets once.

Background and foreground pack contributions, the grid, toolbox and remote
presence remain viewport layers outside the retained graph images. Widgets
still use their registered compact painters; the active editor remains a DOM
overlay rather than part of the graph bitmap.

The browser frame-equivalence check compares a retained-history renderer with
a fresh renderer at each identical state, plus an independent uncached renderer
that repaints the complete scene without retained images or candidate bins.
It compares complete raw RGBA frames without a tolerance, including fractional-DPR pans, exposed edges,
zoom detail changes, selection, cross-tile and reversed drag, release, edit,
mutable preview pixels, theme, style and resize. Dense overlapping reroutes
exercise overview batching changes away from the edited node. Separate
counting checks require camera-only reuse, bounded image copies and reuse of
distant images during node edits for the fixed 66-, 300- and 1200-node fixtures. Comparison canvases explicitly disable
frequent-readback optimization so retained and fresh references request the
same readback policy throughout repeated pixel inspection.
This affects comparison setup only, not production rendering. Frame-time tools
and measured results are documented in [Performance baselines](perf.md);
timings are reports, not CI assertions.

## Node look

Nodes use the flat-title look. A row is 26px: a 24px field and a 2px gap.
Fields sit 7px inside the node's 1px border, and pin rows are also 26px, with
their 16px line of text centered. The space under the title rule and above the
bottom edge depends on the row at that end: 5px next to a boxed row (a field,
section header, growth row or stored value) and 1px next to a pin row, so 6px
stays clear between the rule or border and the first or last thing seen. At
the bottom the 1px border, drawn inside the node's box, comes on top of that
space. A preview or text output after the rows ends the node as a boxed row
does. In the
dark theme the body and the 26px title bar share the darker surface
(`bg.surface`), a 1px `border.divider` rule closes the title bar, and fields
use `bg.field`. Raised opener rows take the lighter surface. The light theme takes
the same sizes and keeps its original colors.

At 100 percent zoom, with a node at whole-number coordinates, every edge falls
on whole pixels. The idle outline is 1px wide and drawn inside the node's box.
The title rule and every field's box fill whole pixel rows. Stepper glyphs are
1px lines centered on pixel rows and columns, 9px inside the field's ends.
A pin on a node's or boundary panel's side is 11px across and centered on the
1px border line: 5px outside it and 5px inside, and half a pixel below its
row's center so it covers whole pixel rows. Wires and hit targets keep the
box's edge and the row's center, which the pin covers. The `crispEdges` token
holds this behavior. `nodeLookTokens('original', theme)` restores the earlier
look for the gallery's side-by-side page.

## Badges

The title bar starts with the minimize arrow: the section rows' disclosure
triangle, centered in an 18px square target 5px in from the node's left edge,
in the label color, and under the pointer in the title color over a rounded
raised-surface square (`canvasPaintTokens.node.minimizeArrow`). The name
starts where that target ends, and a node's automatic width reserves the
space. See [node minimization](node-minimization.md) for what it does.

The title bar holds the node's name and suffix and, for a subgraph node, one
mark at its right end: a 16px square with the boxes icon, followed by the
linked count when two or more occurrences share the definition. The name is
cut with an ellipsis before the mark. Every other badge is a tab outside the
node. Tabs above say what the node is and how it is set: Deprecated, Muted,
Bypassed, and a pack's badge, which goes above unless it asks for below. Tabs
below say what happened and what is wrong: the run state, Error, Unavailable,
Warning, Blocked, child counts, Log, media conversion warnings and a region's
iteration. Top tabs start at the node's right edge, the first one furthest
right; bottom tabs start at its left edge. Both lanes sit 3px outside the
node's painted outline, flush with its left and right edges.

A tab is 16px high with 11px words and 3px rounded corners. Its fill is 16
percent of its color over the canvas background, its 1px line 65 percent, and
its icon and words 70 percent of its color over the title color, so the words
stay readable in either theme; under the pointer the fill rises to 30 percent
and the line takes the words' color. A tab is as wide as its padding, 10px
icon, 4px gap and measured words, the words capped at 120px. When a lane is
full, tabs narrow to their icons and the last becomes a "+N" tab listing the
rest; hovering a narrowed tab shows it whole. Paint, pointer targets and the
scene's bounds share one layout (`layoutNodeBadges`). The tab tokens are in
`canvasPaintTokens.badge`, with the gap from the node as one number (`offset`)
and the distance from its corners as another (`inset`, 0).

Every tab the product adds has an icon, from the Lucide set the canvas
paints, and no two meanings share one: Queued `clock`, Running `play`,
Finished `check`, Cached `database`, Skipped `ban`, Failed and Error
`circle-x`, Unavailable `unplug`, Warning and media warnings `triangle-alert`,
Blocked `lock`, child counts `list-tree`, Log `scroll-text`, iteration
`repeat`, Muted `volume-x`, Bypassed `forward`, Deprecated `archive`, and the
subgraph mark `boxes`. A pack's badge has an icon when the pack names one.

## Numeric edits and comparison diagnostics

Static numeric widget edits reuse scene geometry when the effective interface
is unchanged. Dynamic interfaces, subgraphs, conditional rows, sections and
layout changes retain the full scene-build path. Each increment still commits
its own document command and history entry. Document edits do not enumerate
cleanup file lists or wait for cleanup acknowledgments.

Canvas-only compilation for resident availability and preview recipe comparison
waits until after a painted frame and a 100 ms editing pause. New edits replace
the pending comparison rather than queueing old revisions. Unproven previews
remain stale until the current comparison is ready; old compile diagnostics
are not presented as current. View-only changes reuse a proven comparison.
Queue actions still validate the current workflow independently.

## Frame-rate readout

Settings > Diagnostics > Show frame rate adds a readout to the status bar.
It is off by default and persists across reloads. Each one-second sample
reports page animation-frame callbacks per second and the slowest interval
between those callbacks. Idle pages still receive callbacks; the readout
does not force canvas paints or measure GPU presentation rate, canvas draw
time, or input latency. Uncapped browser runs can report callback rates above
the display refresh rate.

Sampling runs only while the readout is enabled, the status bar is shown,
and the document is visible.
Hiding the tab discards its incomplete sample; returning starts a fresh
sample, excluding the background pause. Turning the setting off removes the
readout and its animation-frame callback. The existing status-bar visibility
setting still controls whether the bar is shown.
