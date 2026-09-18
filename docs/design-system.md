# Design System

## Source of truth

`packages/core/src/ui/tokens.ts` owns the semantic token values. It exports:

- `semanticDesignTokens`, the host token model;
- `semanticCssVariables` and `semanticCssRoot`, the CSS projection injected
  into the document head before application modules; and
- `canvasSemanticTokens`, the bounded typed subset available to Canvas code.

Redesigned components consume semantic roles rather than copying token values.
Literal colors and dimensions are reserved for user data, media content,
calculated geometry, and other values that are not product styling. A surface
adopts the system when its owner replaces and deletes the old styling.

Declarative host UI accepts semantic tones only. The app renderer maps those
tones to host-owned text, status, and action classes; extension trees cannot
provide classes, style, theme values, tags, or elements.

Product forms use one host-owned language across settings, backend controls,
ordinary widget editors, and modal flows. `ProductField` associates the label,
optional help or validation message, control, and row actions. `ProductNotice`
provides semantic info, warning, error, and polite-status presentation.
`ProductActionFooter` keeps decision actions and optional status copy in one
wrapping footer that stacks at narrow widths. These primitives own structure
and semantic-token styling only; callers retain value, validation, command,
and request lifecycle ownership.

## Token model

| Family | Roles |
| --- | --- |
| Space | 4, 8, 12, 16, 24, 32 px |
| Type | metadata 11/16, body 13/20, section 15/20, title 18/24; regular 400, medium 500, semibold 600 |
| Surface | canvas, panel, inset, raised, selected |
| Text | primary, secondary, muted, disabled, inverse, on-selected |
| Border | subtle, strong, focus, selected |
| Meaning | accent, success, warning, danger, info; each has foreground, background, and border |
| Shape | 4 px small, 6 px control, 8 px card/panel, capsule for tags and removable active filters only |
| Interaction | 32 px compact control, 40 px primary input, 2 px focus ring, hover, pressed, selected, disabled |
| Motion | fast, standard, reduced-motion duration, one product easing curve |
| Elevation | low and high only |

Canvas code receives space, relevant type roles, surfaces, text, borders,
meaning, shapes, and bounded interaction state. It does not receive DOM
elevation or motion tokens. DOM surfaces consume the generated
`--dinkster-*` variables.

Selected surfaces use `text.onSelected` for foreground content. Token objects
and their projections are recursively frozen at runtime.

The shared application shell consumes this projection directly: top bar,
workflow tabs, activity rail, panel hosts, the right zone's tab row, status
bar, focus rings, and responsive sheets use semantic surface, text, border,
space, type, shape, interaction, motion, and elevation roles. Feature panel
bodies do not supply private shell headers, tab chrome, or resize chrome.

Transient product UI shares `.floating-surface` for root chrome and uses
`placeFloatingSurface` for block, inline, or point anchoring. Universal search
uses that chrome while retaining its search-specific dialog geometry. Its
host-owned `SearchInput`, `SearchResultGroup`, `SearchResultRow`, and state
components define searchable hierarchy without accepting provider markup or
styles. The node palette composes the same vocabulary with its category
browser, type-filter dialogs, schema preview, and Canvas placement lifecycle.
`SearchInput` also owns optional clear-button focus restoration and compact or
primary presentation. Assets supplies only its query behavior and result copy;
it does not fork search chrome.
The ASSET widget dialog composes the same `SearchInput` and state vocabulary
inside its shared `CollectionPanel`, uses `ProductNotice` for validation and
source failures, and uses `ProductActionFooter` for upload status and decisions.
Its compact requirements, current selection, semantic preview fallbacks, and
model-variant facts remain product presentation; exact AssetRef identity,
compatibility, source paging, uploads, and command semantics remain with their
existing owners.
Context-menu children and seed-controller options use the same semantic text,
surface, border, spacing, type, shape, and interaction roles. At reduced motion,
loading indicators and animated switches use the zero-duration motion role.
Seed-controller menus use measured point placement so the complete menu stays
inside the canvas as its bounds change, with internal scrolling on short stages.

The bounded Canvas projection is available and tested. The renderer consumes
it through the `DesignTokens` adapter rather than maintaining a second color
authority.

## Canvas visual-system contract

### Token projection

`packages/core/src/ui/tokens.ts` is the only semantic token authority.
`CanvasSemanticTokenProjection` selects the roles available to Canvas2D:
spacing, compact typography, canvas/surface/text/border meanings, status
meanings, shape, focus, selection, and disabled state. Canvas-only metrics such
as row height, pin radius, link width, hit slop, preview thresholds, and grid
spacing may be typed geometry tokens, but must be derived beside this
projection and may not redefine a semantic color, type role, or state meaning.

`packages/canvas/src/tokens.ts` constructs the existing `DesignTokens` adapter
from that projection. Canvas, raised node, panel header, and inset widget roles
own the primary surfaces; primary/secondary/disabled text, subtle/selected
borders, accent selection, selected overlay, and info/success/warning/danger
meanings own their matching paint roles. The adapter remains the shared mutable
`defaultTokens` object accepted by custom renderers. Compact Canvas typography,
all layout and text-measurement metrics, the data-type palette, and unmatched
run/mute/bypass meanings remain unchanged. The focused multiline editor uses
the corresponding CSS variables while retaining the same projected geometry.
The strong-border role owns structural node and pseudo-node outlines; the
subtle-border role remains available for inset preview and widget chrome.

Groups keep user-authored colors as document data. Uncolored groups use the
semantic strong-border role for their existing fill, header, and border
alphas. Selection uses the shared selected-border role plus the existing
dashed outset, without changing group paint order, geometry, or hit targets.

Canvas navigation chrome uses the DOM projection directly. The minimap frame,
settings and switches, zoom/fit cluster, and Graph/Lens controls share panel,
raised, text, border, focus, selection, shape, motion, and elevation roles with
the shell while retaining their labels and behavior. Above 520px the corner
cluster remains 250 by 200 pixels. At 520px and below it becomes 210 by 172
pixels, with a 210 by 122 minimap and a separate 210 by 44 zoom/fit footer.
Every action keeps a hit target of at least 36 by 36 pixels.

DOM chrome consumes the CSS projection of the same source. A canvas adoption
change therefore updates the projection or its canvas geometry adapter once;
it must not patch Canvas2D, app CSS, minimap, and tooltip colors independently.
Type colors remain data semantics, while selection, focus, status, warning,
error, mute, and bypass remain visual meanings. Every status also needs a
shape, label, line style, icon, or other non-color cue.

### Shared state and geometry

The document and core model own graph/product semantics. `scene.ts` owns the
immutable document-to-scene projection and `layout.ts` owns world geometry.
The app host owns runtime-derived presentation state: progress, diagnostics,
mode, companions, previews, badges, selector resolutions, remote presence,
and focused/transient controls. Command and undo ownership do not move into
the renderer.

One typed host projection must feed paint, hit, tooltip, keyboard mirror, DOM
overlay, and minimap consumers. Consumers may simplify presentation, but may
not re-derive semantic truth. In particular:

- paint and hit use the same committed bounds and shared geometry helpers;
  an unpainted affordance is not hittable;
- tooltips resolve the same target identity and state that paint exposes;
- DOM media/editors project the same node region and are transient;
- the minimap uses the same citizen identity, bounds, selection, mode,
  progress/error precedence, bookmarks, and viewport state, while intentionally
  simplifying curves, text, row content, pins, badges, and previews; and
- resizing and dragging use explicit transient geometry, then return to one
  committed scene after dispatch.

The main renderer's fixed paint phases are groups, links, reroutes/net views,
nodes and boundary nodes, value sources/selectors, selection/gesture
adornments, and screen-sized toolbox chrome. Host-owned bookmark state is
painted as minimap marker descriptors, outside the main renderer. Changes may
insert only into a named phase and must preserve occlusion and matching hit
priority.

### Culling and level of detail

Interactive zoom remains `0.05..4`; fit remains clamped to `0.1..2`. Every
world-space descriptor supplies finite conservative bounds. The host culls
groups, link control hulls, reroutes, nodes, pseudo-nodes, and adornments
before expensive paint. Screen-sized strokes and controls expand bounds by
their full paint radius so they do not pop at viewport edges.

`CANVAS_DETAIL_MIN_SCALE` is the shared `0.5` boundary for renderer text
detail and transient media DOM. `defaultTokens.mediaControlMinScale` is the
shared `0.75` boundary for interactive media controls and output paging. The
renderer derives one `CanvasDetailLevel` from those owners and the Canvas host
passes the same tier into hit testing:

| Scale and tier | Required detail |
| --- | --- |
| `0.75..4` - `controls` | Full node and row detail; interactive media controls may mount for a visible, active, or focused preview. |
| `0.5..<0.75` - `content` | Node, group, row, badge, net-name, and detailed lens text remain; media is visible but compact controls are non-interactive. |
| `0.05..<0.5` - `overview` | Node rows, titles, badges, link midpoint handles, detailed lens paint, toolbox, and resize targets are omitted. Typed pins, links, reroutes, groups, selection, progress, execution/problem/mode outlines, drop targets, decoded images, and compact video/audio type/count badges remain. Omitted row and handle regions fall back to structural body, link, or group-header hits. |

The grid doubles world spacing until dots are at least 12 CSS pixels apart.
Critical outlines, links, typed pins, reroutes, selection, and dash patterns
retain a minimum screen-space weight at low zoom; their conservative culling
and hit radii expand by the same scale policy. Pending, cached, skipped, error,
muted, bypassed, done, and running states combine thickness, dash, alpha,
progress, or wash cues with color. Level of detail changes paint and hit
complexity, not document/scene identity or world geometry. Offscreen or omitted
detail must not retain DOM, decode, tooltip, or hit work.

### Accessibility mirrors

The canvas keeps one accessible host label and DOM shell controls. Focused
editors, media controls, and popovers remain host-owned DOM. General semantic
navigation is a host-owned listbox over the shared presentation projection.
Its semantic inventory is derived only while the listbox has focus and it
mounts exactly five option rows regardless of graph size. `aria-posinset`,
`aria-setsize`, and `aria-activedescendant` preserve the complete reading
position without one live DOM node per graph citizen or subscriptions to
pan/zoom updates.

Mirror entries expose deterministic scene order, citizen kind and name,
selection, port direction/type/optionality, link endpoints, group membership,
and execution/problem/mode state. Arrow, Page, Home, and End keys move only the
reading cursor. Enter or Space selects and centers the current citizen without
changing the document; Escape restores Canvas focus. Paint and camera movement
remain independent until activation.

Host-owned audio/video previews and finished-output pagers mount only when
their projected region intersects the clipped Canvas stage. At most 24 media
or pager roots from each family may be live at once. Visible scene order is
stable, while a focused, playing, selected, or open-viewer item may displace
the last ordinary item so interaction is not destroyed by the cap. Tab changes
clear transient ownership. Canvas2D images and compact low-zoom media cues do
not add DOM roots.

### Extension descriptors

Extensions never receive canvas, DOM, CSS, theme, app-store, socket, network,
or full-scene handles. The Types lens uses renderer-owned retained text
descriptors instead of a raw paint callback. Its link-midpoint and node-output
anchors have stable ids, semantic text/font roles, conservative local bounds,
the fixed `over-scene` phase, retained scene ordering, host culling/clipping,
a 512-code-unit text limit, an 8,192-visible-descriptor frame limit, and zero
authored path segments or hit regions.

Future adornments use retained typed descriptors containing a namespaced
stable id, semantic token roles, an anchor, conservative bounds, one fixed
paint phase, bounded primitives, and at most one optional host-routed hit
action. The app-internal lens registry is not a general extension provider.

Every descriptor provider requires design review and declares enforceable
limits for descriptors per anchor and frame, path segments, text length, and
interactive regions. The host validates the limits, culls by declared bounds,
clips to the allowed anchor region, orders by phase and stable id, and resolves
actions through registered commands. A provider without approved numeric
limits or a conservative bounds function cannot register. Default descriptors
are non-interactive; descriptor data can name an action but cannot carry an
arbitrary callback.

### Performance methodology and budget

`packages/e2e/tests/perf.spec.ts` is authoritative. Every PR that touches
canvas/minimap paint, scene build, CanvasHost structure, or document hot paths
runs the 1200-node plain, 1140-reroute, and 1200-preview workloads at least
three times on merge-base and three times on head. Both sets use the same
machine, Chromium build, headless/headed mode, viewport, device scale, fixture,
frontend/backend ports, worker count, and environment. Record each run and the
per-metric median in append-only `docs/perf.md`.

For a merge-base median `B` and head median `H`, the change passes only when:

- average frame `H - B <= max(1.0 ms, 0.05 * B)` for every workload;
- p95 frame `H - B <= max(2.0 ms, 0.10 * B)` for every workload;
- every workload remains below 33 ms average and 100 ms p95;
- first paint `H - B <= max(5 ms, 0.10 * B)`;
- repaint after dispatch `H - B <= max(3 ms, 0.10 * B)`; and
- all authoritative absolute test backstops, including open/dispatch checks,
  pass.

A repeatable relative breach blocks the PR even when absolute gates pass. A
noise claim requires reruns and the full distributions, never a selected
favorable sample. Profiler evidence is also required for hot-path caching or
algorithm changes. Nodes, links, groups, overlays, and minimap remain batched
and cullable Canvas2D; no per-node DOM may enter paint, pan, or zoom paths.

## Surface ownership registry

Each row has one implementation owner. Shared semantics stay with their
existing feature issue; these owners govern visual-system adoption and host
composition.

| Surface or contribution anchor | Owner |
| --- | --- |
| Semantic tokens, CSS projection, Canvas token projection | #27 |
| Panel, header, search, facet, row/card, scroll, state, field, inspector/editor, and action primitives | #27 |
| Declarative extension contribution validation, rendering, commands, lifecycle, ordering, and fixture gallery | #27 |
| App boot frame, top bar, app menu, tab strip, activity rail, dock regions, status bar, notifications, panel headers, resizing, and layout customization | #28 |
| Shell extension regions, including the replacement for `status.trailing` raw mounts | #28 |
| Node palette, category browser, palette preview, filters, and keyboard placement flow | #29 |
| Universal search trigger/dialog, grouped results, previews, actions, and extension result providers | #29 |
| Canvas nodes, compact rows, ports, links, reroutes, groups, selection, execution, error, mute, and bypass paint | #30 |
| Canvas previews, bookmarks, toolbox, corner controls, zoom/fit controls, overlays, minimap, hit geometry, accessibility mirrors, and extension scene adornments | #30 |
| Settings navigation/search, generic settings form presentation, product controls, validation, help, dialogs, modal chrome, menus, and popovers | #31 |
| Ordinary expanded widget editors, generic suggestion surfaces, color editor, image editor mask tools, and host dismissal/focus behavior | #31 |
| Embedded-PNG image/workflow choice dialog and action routing | #31 |
| Assets sidebar, Assets collection content, source/facet/search/health/details states, upload, and exact AssetRef selection | #32 |
| ASSET widget browser, logical-model picker, cross-mount selection, and source-health presentation | #32 |
| Plain-image file drop, upload, and Load Image insertion | #32 |
| Latent file-drop ingress, Load Latent AssetRef selection, latent metadata and VAE-intent hints, failures, cancellation, and Assets integration | #32 |
| Asset Editor host rendering and presentation: media viewport, inspector/editor layout, value-origin fields, timeline/crop regions, and action/progress states | #32 |
| Library, packs, templates, workflows, Activity, subgraph-definition visual adoption, and deferred Control Surfaces | #33 |
| JSON workflow file-drop import and open | #33 |
| App View and exposed-parameter content | #21 |
| Problems content and whole-document/contextual diagnostics | #22 |
| History, Runs, workflow queue, and live Executions | #35 |
| Outputs and executed-output viewer | #36 |
| Backends and runtime settings | #37 |
| Memory and Aimdo observability | #38 |
| Extension management | #39 |
| Boundary editor content | #40 |
| Asset acquisition consent and import resolution | #41 |
| Collaboration session management | #42 |

Activity rows apply the shared data-rich surface language directly: separate
metadata fields, semantic badges and row markers, selectable message text,
keyboard-focusable overflow, and responsive reflow. The bottom-panel host
continues to own title, Clear, close, and resize chrome.

Library content applies the same language inside the existing left-dock host.
Packs, Templates, and Workflows expose source-specific empty/error copy,
selectable identity and provenance, semantic badges, and a selected-item detail
rail that collapses back into the row at narrow widths. The backend context is
always visible and distinguishes protocol and connection state without relying
on color alone. See [Library](library.md).

Subgraph-definition cleanup applies the same language without changing core
authority: named reachability badges, labelled impact facts, exact wrapping
identifiers and dependency names, focusable list overflow, and explicit empty
and unavailable states. The shared modal and action footer continue to own
dialog and destructive-action presentation.

Output inspection applies this language to read-only execution media. The rail
and modal use semantic surface, border, text, accent, success, warning, danger,
focus, spacing, radius, and control tokens. Preview imagery remains supporting
content: visible text carries backend, execution, runtime node, output,
descriptor, source, media, identity, and availability meaning. Long identities
wrap in metadata regions, while image stages and metadata tails scroll
independently at narrow widths and browser CSS zoom. See
[Output inspection](output-inspection.md).

## Extension boundary

Extensions contribute namespaced serializable content and commands. The host
owns layout, breakpoints, tokens, focus order, ARIA wiring, transient-surface
placement, error boundaries, cleanup, and contribution ordering. Extension
DOM, CSS, class names, inline styles, themes, raw Canvas handles, app stores,
sockets, and unrestricted network handles are outside the contract.

Core surfaces use the same contract as extensions. A rich interaction that
the contract cannot express becomes a reviewed host primitive rather than an
escape hatch.

Extension management uses nested semantic groups for pack, category, and
contribution identity. Complete ids wrap instead of truncating. Text labels
distinguish deployment policy, user gates, registration, activity, missing
contributions, and activation failure; color and checkbox state only reinforce
those labels. Disabled controls reference a visible reason, diagnostic rows
retain severity and code, and stable list positions preserve keyboard focus
when a gate changes. The body owns contained scrolling and reachable tails at
narrow widths and browser CSS zoom.

## Asset Editor boundary

Issue #32 owns Asset Editor host rendering and presentation only. Dinkster #119
owns proxy and range behavior; authoritative output-fact schemas, content,
and semantics; transform and operation-node semantics; media interaction;
jobs; provenance; draft history; normalization; execution kernels; and
Apply/Cancel behavior. All specification origins use the same frontend shell
without private UI-only semantic state.

The shared shell is the root-only `asset-editor` node on the existing
`WidgetView.editorUi` path. It uses product tabs, fields, notices, and action
footers for supplied display fields, origin labels, capabilities, facts, tool
slots, and command states. Unknown field and capability kinds fail closed.
Command slots are registered no-payload invocations; the shell does not author
or reinterpret any state listed above as owned by #119.

## Replacement rule

Dinkster is unreleased. A redesigned surface deletes the superseded UI, styles,
exports, tests, docs, and contribution path in the same change. There are no
deprecation windows, shims, adapters, feature-flagged dual paths, or migration
periods for superseded frontend APIs. Internal work coordinates by sequencing
against the new contract.
