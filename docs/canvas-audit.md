# Canvas scene audit

`packages/canvas/src/scene-audit.ts` exports `auditScene(scene)`: a pure,
read-only, total function over a built `Scene` that returns human-readable
findings (`{ subject, finding }`) naming exactly what is geometrically or
referentially wrong. Empty result = all invariants hold. It is the canvas
twin of the DOM layout audit (`docs/ui-audit.md`): behavioral tests proved
blind to total visual wreckage on 2026-07-25 (noodles anchored to the wrong
pin row when a widget tap shared its id with a real output), so canvas
correctness gets a machine-checkable geometry gate an agent or CI can run
over ANY scene - golden workflows, synthetic matrices, or a live document.

## Current visual-system surface audit (2026-08-15)

Audited commit: `1be5e829de9b568bf4d31f8eac2a768339d14e12`.
The retained Canvas2D scene/layout/renderer architecture is the implementation
boundary. This map covers every current canvas citizen and its host-owned DOM
counterpart before visual-system adoption begins.
This section is the pre-adoption snapshot for that commit;
`design-system.md` and `lenses.md` define the current retained contracts.

### Ownership map

| Concern | Current owner | Contract and observed state |
| --- | --- | --- |
| Semantic design tokens | `packages/core/src/ui/tokens.ts` | `semanticDesignTokens`, CSS variables, and `canvasSemanticTokens` are the #27 source. Canvas does not consume the projection yet. |
| Canvas metrics and paint colors | `packages/canvas/src/tokens.ts` | `DesignTokens` and `defaultTokens` still form a separate renderer-facing authority, with additional literals in painters and app CSS. |
| Document-to-scene derivation | `packages/canvas/src/scene.ts` | Builds nodes, links, reroutes, value sources, selectors, groups, net stubs, boundary pseudo-nodes, diagnostics, and endpoint geometry. Product semantics remain core/document-owned. |
| Node and row geometry | `packages/canvas/src/layout.ts` | Owns headers, port rows, widget rows, sections, growth/fallback rows, preview/text regions, pins, manual size floors, boundary panels, and long-label auto width. |
| Batched paint and viewport | `packages/canvas/src/renderer.ts` | Owns DPR backing-store sizing, grid, fixed paint order, viewport culling, all scene citizens, transient gesture overlays, selection, progress, problem and mode state, previews, badges, and toolbox. |
| Hit geometry | `packages/canvas/src/hit.ts`, `packages/canvas/src/badges.ts`, `packages/canvas/src/toolbox.ts` | Independently traverses scene citizens in visual priority order. Shared helpers cover link curves and selected chrome, but there is no single projected paint/hit description. |
| Pointer and keyboard gestures | `packages/canvas/src/interaction.ts` | Owns gesture state, selection, drag/resize/connect/reroute behavior, keyboard commands, and command dispatch. It does not own document or undo semantics. |
| Widget-row paint | `packages/canvas/src/registry-painter.ts`, `packages/canvas/src/text-fit.ts` | Adapts registered compact widget descriptions to Canvas2D. Text measurement is cached; labels and values truncate or wrap within row geometry. |
| Preview state and paint | `packages/canvas/src/previews.ts`, `packages/app/src/node-previews.ts`, `packages/app/src/scene-overlays.ts` | Host selects and decodes bounded preview sources. Canvas paints images and placeholders; the host mounts video/audio controls and output pagers over projected regions. |
| Overlay state | `packages/app/src/scene-overlays.ts`, `packages/app/src/CanvasHost.tsx` | One host pass derives execution states, problems, companions, badges, previews, output text, selector resolution, and lens state, then installs several parallel renderer/minimap/DOM maps. |
| Tooltip content | `packages/app/src/tooltips.ts`, `packages/app/src/CanvasHost.tsx` | Resolves hit targets separately from painter state. Schema, diagnostics, companion values, disabled reasons, and badge details are assembled at the host boundary. |
| Minimap | `packages/canvas/src/minimap.ts`, `packages/app/src/minimap.ts` | Pure overview painter plus DPR/lifecycle adapter. It intentionally simplifies links and node detail, omits pseudo-nodes, and receives execution state separately. The equivalence rules are not formalized. |
| Bookmarks | `packages/app/src/CanvasHost.tsx`, `packages/app/src/bookmark-camera.ts`, `packages/canvas/src/minimap.ts` | The host reads document bookmark state and owns camera navigation; the pure minimap painter receives and paints marker descriptors. Bookmarks are not part of `Scene` or the main renderer paint path. |
| Canvas chrome | `packages/app/src/CanvasHost.tsx` and app CSS | DOM owns minimap settings, the minimap visibility toggle, zoom/fit controls, menus, transient focused editors, media controls, and accessibility mirrors around one canvas element. |
| Palette preview and placement | `packages/app/src/palette-node-preview.ts`, `packages/app/src/CanvasHost.tsx` | Uses shared node layout for a renderer placement ghost. NodePalette/category/filter/search remain #29-owned. |
| Extension seams | canvas badges/toolbox descriptors, widget registry, and lens registry | Badges, toolbox actions, and widget compact views are typed data. Lens `overlayPaint` still exposes a raw `CanvasRenderingContext2D` and full `Scene`; it is internal debt, not a compatibility surface. |

### Surface and state inventory

| Surface | States and geometry that evidence must cover |
| --- | --- |
| Nodes and widget rows | Ordinary, selected, renamed, colored, unknown/missing schema, subgraph/region, manually resized, collapsed sections, hidden-modified marker, growth/fallback rows, compact and multiline widgets, connected/companion/stale values, controller chips, row warnings, long titles/labels/values, and in-body text output. |
| Ports | Input/output, widget taps, static/dynamic members, optional and maybe-absent, ghost/materialize, collapsed-section anchors, compatible drop targets, warning rings, connected state, and multi-type pin shapes. Paint and generous hit radii must stay aligned. |
| Links and reroutes | Normal and named-net links, optional dashed links, mismatch/error links, selection, hover midpoint, rewire ghost, scope dimming, reverse-curve culling, reroute selection and hover sockets, and boundary/effective links. |
| Groups | Fill, header, title, border, selection, drag and resize geometry, overlap order, long titles, and offscreen culling. |
| Selection and transient gestures | Single-node and heterogeneous union outlines, marquee, drag offsets, resize preview, connection targets, splice/rewire previews, placement ghost, toolbox, scope preview, and remote-presence overlays. |
| Execution and document state | Pending, running/progress, cached, done, skipped, runtime error, document error, blocking warning, ordinary warning, inactive/out-of-scope, frozen/cached output, muted, and bypassed. State must not rely on color alone. |
| Previews | Loading, failed, unavailable, decoded image, selected input, execution output paging, cached provenance, video/audio, low-zoom media badge, focused controls, and image viewer. Canvas containment and DOM projection must share one region. |
| Derived pseudo-nodes | Boundary Inputs/Outputs plus add slots and bindings; value-source derived/declared/conflict pills; selector fixed/random/recorded policy, candidate rows, and pins; collapsed net Set/Get tags. |
| Badges, bookmarks, and toolbox | Runtime/document/subgraph/deprecation/pack/mode badges, above-node and header lanes, bookmark numbers, disabled and active toolbox actions, multiple rows, and tooltip/click priority. |
| Corner and zoom controls | Minimap visible/hidden/menu states, zoom out/reset/fit/in, ordinary and narrow containment, touch-sized hit areas, keyboard labels, and no overlap with canvas content. |
| Minimap | Nodes, identity colors, mute/bypass/error states, groups, reroutes, straight link simplification, bookmarks, remote viewports, current viewport, settings toggles, DPR, and empty/large/off-content bounds. Intentional omissions require an explicit equivalence rule. |
| Scale, density, and raster | Interactive zoom `0.05..4`, fit clamp `0.1..2`, ordinary/dense/large graphs, adaptive grid, existing `0.5` and `0.75` detail thresholds, viewport-edge culling, fractional and 2x DPR, and backing-store resize. |
| Accessibility and keyboard mirror | Canvas label, DOM corner controls, focused editors, widget/exposure controls, selected-input preview descriptions, tooltip-on-focus, selection and command shortcuts. There is no virtualized semantic mirror for general nodes, ports, links, groups, or canvas status. |

### Defect and risk inventory

1. **Two token authorities.** Core's typed semantic Canvas projection and
   canvas `defaultTokens` coexist, while badges, groups, controls, and painter
   details also contain local color and geometry literals.
2. **Parallel presentation projections.** Paint, hit testing, tooltips, DOM
   overlays, and minimap derive or receive overlapping state separately. Most
   paths agree today through shared scene geometry, but equivalence is not a
   type-enforced invariant.
3. **Incomplete level of detail.** Grid density, net names, lens detail, and
   media controls have thresholds, but node rows, badges, link handles, and
   overlays have no general density policy across the full zoom range.
4. **Incomplete semantic accessibility.** Existing mirrors cover shell
   controls, connected widget/exposure actions, and selected input previews,
   not general scene navigation or state. A one-DOM-element-per-citizen fix is
   forbidden because it would move graph size onto pan/zoom hot paths.
5. **Unbounded extension paint.** Lens `overlayPaint` receives raw canvas and
   scene handles. It bypasses host culling, ordering, hit budgets, and the typed
   design-token boundary.
6. **Scale-sensitive scans and allocations.** Scene rebuild, paint, hit,
   preview projection, and several overlay derivations scan linear arrays or
   allocate transient maps. Existing culling bounds draw cost, but evidence is
   required before adding caches or a spatial index.
7. **Unspecified minimap equivalence.** The minimap's straight links, reduced
   node detail, omitted pseudo-nodes, and independent state maps are reasonable
   overview choices, but no contract states which semantic cues must survive.
8. **Long-label treatment varies.** Widget rows use measured ASCII ellipsis;
   several node, group, selector, net, and minimap labels rely on Canvas2D
   `maxWidth`, clipping, or omission. Tooltip recovery is not uniform.
9. **DOM preview projection scales with preview count.** Video/audio and output
   pager overlays are reprojected from scene nodes. They must be limited to a
   bounded visible, active, or focused set before richer preview styling.
10. **Responsive corner chrome is unresolved.** Current controls avoid basic
    overlap but do not define a compact narrow layout. The breakpoint and exact
    dimensions require visual reference approval rather than an audit guess.

### Bounded implementation order

1. Add a same-machine merge-base/head Chromium runner and append-only evidence
   format that enforces the three-run median and repeatability rules.
2. Make the #27 typed Canvas projection the visual authority without changing
   document semantics or node geometry.
3. Replace raw lens paint atomically with bounded retained descriptors, fixed
   phases, conservative bounds, host culling, and host-owned hit routing.
4. Use profiler and benchmark evidence to remove repeated hot-path work; do not
   preemptively add a spatial index or split the canvas.
5. Adopt node/link/group/state hierarchy and typed low-zoom detail while
   preserving scene semantics and shared paint/hit geometry.
6. Bound media DOM to visible/active/focused previews, then add a virtualized
   semantic scene mirror disconnected from paint, pan, and zoom.
7. Adopt minimap and responsive corner chrome using the same semantic state and
   approved wide/narrow references.

Each change replaces its superseded path in one PR. No renderer rewrite,
dual visual paths, geometry change hidden in token adoption, or speculative
optimization is part of this order.

### Running-state animation

The renderer paints executing nodes with a pulsing glow and flowing dashed
border accent. Its requestAnimationFrame loop is on demand: ordinary updates
paint one dirty frame, running state keeps frames active, and terminal or idle
state stops the loop. The app supplies the live reduced-motion preference;
reduced motion paints one static glow frame without the flowing accent. Paint
reads no DOM state and allocates no additional steady-state idle work.

### Selection outlines at viewport edges

A selected node or boundary panel keeps one outline around its complete world
geometry. The canvas bitmap clips that outline at viewport edges, so a node
that continues offscreen never gains a false closing edge through its visible
rows, sockets, or badges. Normal viewport culling still skips fully invisible
nodes, including selected nodes.

The retained renderer now derives `overview`, `content`, and `controls` detail
from the shared `0.5` and `0.75` thresholds. Overview paint omits text, rows,
badges, midpoint/toolbox/resize controls, and detailed lens adornments while
retaining groups, typed connectivity, selection, progress, state/problem/mode,
drop, image, and compact media cues. Matching hit policy removes omitted row,
midpoint, socket, badge, toolbox, and resize targets but preserves node/group
dragging and screen-sized pin, reroute, and link targets. Screen-aware stroke,
dash, cull, and hit radii preserve the existing world geometry.

Host-owned media DOM is now limited to 24 visible audio/video roots and 24
output-pager roots, with stable scene order and retention priority for active
interaction. General Canvas semantics are derived only while a virtualized
listbox has focus; exactly five live options represent nodes, typed ports,
links, reroutes, pseudo-citizens, groups, and execution/problem/mode state.
Neither path subscribes per citizen to paint, pan, or zoom updates.

### Visual reference and evidence matrix

Every visible change captures and inspects before/after pairs at `1600x950`,
`1366x768`, and a genuine narrow `390x844` viewport. Capture 1x and 2x device
scale where raster or alignment can differ. The narrow capture is evidence,
not the implementation breakpoint; responsive dimensions remain subject to
review.

The graph matrix is: ordinary graph at 100%, dense overlapping links at 100%,
large 1200-node graph at fit and low zoom, long title/port/widget/group/net
labels, preview-heavy graph, and pseudo-node graph. The state matrix includes
selection/focus, hover/drop, running/progress, cached/done/skipped, runtime and
document errors, blocking warning, mute, bypass, inactive scope, preview
loading/failure/media, minimap open/menu/hidden, and keyboard-only focus.

Inspection records hierarchy, non-color state cues, semantic contrast,
paint/hit alignment, clipping or overlap, focus and tooltip recovery,
keyboard/accessibility equivalence, minimap equivalence, DPR sharpness, and
the performance distribution required by `docs/design-system.md`.

## Invariants (auditScene)

Per node (and boundary pseudo-node):

- every pin's y lies inside the node body (0 < y <= height);
- pin identity is unambiguous IN THE KEYSPACE it is looked up in: real
  ports by (portId, direction), taps by (address.port, direction) - the
  same-id widget-tap/real-output collision class;
- no two PAINTED same-direction pins share a row (family-owner pins are
  paint-suppressed and exempt); opposite-edge same-y alignment (widget
  input pin + its tap) is deliberately legal, and connected ports hidden
  by the SAME collapsed section legally co-locate on the section header
  row (`PinLayout.collapsedSection`);
- rows stay inside the body (below the header, above the bottom edge).

Per link endpoint (both ends of every noodle):

- the end resolves to an existing scene entity of the RIGHT kind: port
  ends to real port pins of the correct direction (a same-id widget tap
  must never satisfy the lookup - when only a tap carries the id, the
  finding names the collision), tap ends to out-side widget tap pins,
  reroute/valueSource/selector/boundary ends to their arrays;
- direction legality: value sources and widget taps never consume;
  selector candidates never produce and selector outputs never consume;
  the boundary Inputs panel only produces and the Outputs panel only
  consumes;
- the link's stored (x1,y1)/(x2,y2) equal the resolved entity's anchor
  (0.5 world-unit tolerance). A resolving endpoint whose geometry
  disagrees is exactly the "noodle from the wrong row" bug class;
- boundary noodles distinguish exact from family bindings via
  `SceneLink.boundaryFamily` (set by the builder from `binds.kind`): only
  family-bound noodles get the builder's anchor fallback (first
  family-member pin, else header center) - an exact port binding whose
  precise pin is missing or whose anchor drifted IS a finding.

Per collapsed-net stub tag:

- the tag's node exists and carries a REAL pin of the role's direction
  (source = out, sink = in; nets never ride widget taps - a tap-only id
  names the collision), and the stored pinX/pinY equal that pin's anchor;
- a solver-proven mismatch marks the affected sink tag and the source tag when
  any delivery mismatches, using the same error color as a mismatch noodle.

## How to run it

Unit suite (golden workflows x every graph, corruption sensitivity, and
the same-id collision matrix):

```bash
pnpm --filter @dinkster/canvas test -- --run scene-audit
```

In any test or tool with a `Scene` in hand:

```ts
import { auditScene } from '@dinkster/canvas'
expect(auditScene(scene)).toEqual([])
```

Every golden-workflow spec asserts the finding list is EMPTY, so a failure
prints which entity violates which invariant. The suite also carries
corruption sensitivity pins - a shifted link anchor, an out-of-body pin, a
duplicated pin identity, a tap used as a consumer, and real-output-vs-tap
row swaps in both directions - so the invariants cannot be silently
weakened past the failure class they were born from.

## Type color policy

Pins, links, reroutes, selectors, value sources, and widget taps share one
`typeColor` resolution path. Native Dinkster schemas namespace ComfyUI types as
`comfy.TYPE`, while legacy schemas commonly use bare `TYPE`; both forms, and
case variants, resolve to the same palette entry. Structured `list<T>` and
`asset<T>` values inherit T's color.

Native dinkster boundary types alias to their ComfyUI names through
`typeDisplayAliases` in `packages/canvas/src/tokens.ts`. One table feeds both
the label and the color lookup, so the displayed name and color can never
disagree: `dinkster.model` -> MODEL, `dinkster.conditioning` -> CONDITIONING,
`dinkster.latent` -> LATENT, `dinkster.control` -> CONTROL_NET,
`dinkster.clip` -> CLIP, `dinkster.vae` -> VAE, `dinkster.sampler` -> SAMPLER,
`dinkster.sigmas` -> SIGMAS, `dinkster.guider` -> GUIDER,
`dinkster.noise` -> NOISE, `dinkster.image` -> IMAGE, `dinkster.mask` -> MASK. The
pre-rename spellings
`dinkster.text_encoder` and `dinkster.codec` stay in the table so an older backend
presents identically. The alias is presentation only - wire payloads and
compatibility logic keep the raw dinkster id (documents persist no boundary
type ids; scene types derive from live schemas) - and the pin tooltip shows
the canonical id as secondary detail, e.g. `CLIP (dinkster.clip)`. Unaliased
dinkster types keep the hash fallback below.

Separately from display, the `dinkster.image`/`comfy.IMAGE` and
`dinkster.mask`/`comfy.MASK` pairs are each one atom for compatibility
arithmetic: the backend registers both ids of a pair with the identical
image-array codec, so `INTERCHANGEABLE_TYPE_IDS` in
`packages/core/src/schema/compat.ts` canonicalizes each pair inside
`atomNamesOf`, the single entry into atom-set math. A native `dinkster.image`
output therefore legally drives a `comfy.IMAGE` input (and `dinkster.mask` a
`comfy.MASK` input, and vice versa) with no solver mismatch, including
through `list<...>`/`asset<...>` structure. Image and mask stay distinct
atoms from each other. Scene type names (`canonicalCompatTypeIdOf`) use the
canonical spellings (`comfy.IMAGE`, `comfy.MASK`), so equality-based traces -
a selector's "do all driven branches agree on one type" check - treat the
spellings of a pair as one type; the `comfy.IMAGE` and `comfy.MASK` display
aliases keep those canonical spellings presenting as IMAGE and MASK.
Document and wire type ids are never rewritten. The resident-handle types
(`dinkster.model`, `dinkster.clip`, `dinkster.vae`, ...) are NOT interchangeable with
their comfy counterparts - they share a name and color, not a runtime
representation.

Values that later match against type ids stay canonical: the node palette's
input/output filter options carry canonical ids (`typeExprCanonicalLabel`)
and only render through the alias (`typeIdDisplayLabel`), so selecting the
CLIP filter still matches `dinkster.clip` ports. Solver mismatch
diagnostics deliberately keep canonical ids for precision.

Every type defined by ComfyUI's default dark palette is pinned exactly:

| Type | Color | Type | Color |
| --- | --- | --- | --- |
| CLIP | `#FFD500` | CLIP_VISION | `#A8DADC` |
| CLIP_VISION_OUTPUT | `#ad7452` | CONDITIONING | `#FFA931` |
| CONTROL_NET | `#6EE7B7` | IMAGE | `#64B5F6` |
| LATENT | `#FF9CF9` | MASK | `#81C784` |
| MODEL | `#B39DDB` | STYLE_MODEL | `#C2FFAE` |
| VAE | `#FF6E6E` | NOISE | `#B0B0B0` |
| GUIDER | `#66FFFF` | SAMPLER | `#ECB4B4` |
| SIGMAS | `#CDFFCD` | TAESD | `#DCC274` |

Dinkster-only primitive types use deliberately darker colors
that remain distinct from those canonical meanings: STRING `#2E7D32`, INT
`#7B1FA2`, FLOAT `#00838F`, BOOLEAN `#C2185B`, COMBO `#5D4037`, and AUDIO
`#1565C0`. Unknown named types use a deterministic `hsl(...)` hash fallback;
that output format cannot exactly equal any hex table entry.

COMBO is concrete `core.combo`, rendered with the COMBO label, `#5D4037`
color, and `COMBO (string with choices)` tooltip. The payload remains a plain
string, but direct core.string<->core.combo links are hard-invalid. Canvas
drag legality and emphasis use one TypeExpr-compatible `dropTargets` set;
there is no marker, provenance metadata, or choice-list comparison. Traced
reroute types remain core.combo, so noodle and dot presentation follows type.

## Hover affordances

Idle pointer hit testing carries one detailed node-surface identity in the
ephemeral renderer overlay. An ordinary input or output pin is identified by
node id, elaborated port id, and side; a widget row is identified by node id
and value key. The hovered circle or diamond pin paints at 1.35 times its
normal radius. The hovered widget row receives a low-alpha selection-color
wash after its normal widget paint, while diagnostics and controller chrome
remain above it.

The interaction controller stores these identities as primitive fields. A
move within the same pin or row does not allocate overlay identity objects or
request another repaint. Pointer leave, every scene replacement, and gesture
ownership clear the detailed hover. Owned pointer moves do not repopulate it,
so link candidate rings and existing drag overlays keep their established
semantics and cost.

## Selection outlines at viewport edges

The ordinary-node and boundary-node selection paths keep their established
outset while they fit inside the visible canvas. When an edge would cross the
canvas bitmap, the renderer intersects that path with an inset visible-world
rectangle. The inset includes half the centered stroke plus half a CSS pixel,
so the complete antialiased stroke remains inside the rounded backing store at
fractional DPR. This is paint-only clipping geometry: node positions, sizes,
hit targets, serialization, and document revisions do not change. Shell and
graph-local overlay chrome remains above the canvas by design and explicitly
occludes content beneath it.

`renderer-paint.test.ts` pins all four edge calculations. The isolated
Chromium proof in `selected-outline-edges.spec.ts` samples the rendered canvas
at every edge for DPR 1, 1.25, 1.5, and 2 at 0.75x and 1.75x zoom, while
asserting that selection and viewport changes leave the document revision
unchanged.

## Live node resize

Dragging a node corner paints the node itself at the current pointer-derived
geometry. The body, header, rows, widget chrome, pins, selection outline, and
attached preview panel all use the transient x, y, width, and height. The
committed node is not painted underneath and there is no dashed resize box.
Horizontal changes therefore affect clipping and right-side chrome on every
frame, while extra vertical space grows continuously below the fixed row
layout.

This geometry is renderer overlay state only. Pointer movement issues no
document command and does not replace the scene, so hit testing remains on the
committed scene during pointer capture. Pointer release sends exactly one
rounded `view.setNodeSize` command containing position and size. Cancellation,
graph replacement, or deletion of the resized node clears the preview without
dispatch. A same-graph rebuild preserves it only while the node id survives.

## Select All scope and parity

Select All uses the currently rendered `Scene` as its complete scope. In the
root graph it selects that graph's nodes, reroutes, value sources, selectors,
groups, and any rendered boundary pseudo-nodes. While editing a subgraph it
selects only the citizens projected for that subgraph; ids from the parent
scene are never retained.

The result is the same heterogeneous selection a full-canvas marquee creates.
Anything that marquee selection does not treat as a selectable citizen, such
as links, pins, rows, net stubs, and toolbox chrome, is not selected by Select
All. Delete, copy, drag, and toolbox actions consume the resulting selection
through their existing mixed-selection paths. They keep their existing type
rules: for example, structural boundary pseudo-nodes survive Delete, and
node-only toolbox actions receive only real nodes.

Groups are explicit selection citizens. A mixed drag moves each selected
group rectangle and each explicitly selected contained citizen exactly once;
group membership does not add a second movement. A group-only header drag
retains the existing behavior of carrying the citizens spatially inside it.
`canvas/test/interaction.test.ts` pins full-marquee parity, subgraph scope,
the node-only move fast path, and group/content single-move behavior.

## Honest limitations

- The audit checks the built `Scene` data structure, not painted pixels:
  a renderer that ignores correct scene geometry needs the paint tests
  (`renderer-paint.test.ts`) and human/agent screenshot review.
- It validates geometry/identity coherence, not document semantics (type
  correctness, solver verdicts, values) - those belong to core
  validation and the Problems surface.
- Interaction-produced transient states (drag ghosts, previews) are not
  scenes and are covered by `interaction.test.ts` instead.
- A FAMILY-bound boundary noodle with no laid-out member pin legally
  anchors at the header center, so a missing-pin finding cannot fire for
  that case by construction; one anchored at the header while a member
  pin exists, and every exact-port boundary defect, IS flagged.
- The auditor deliberately duplicates (rather than shares) the builder's
  endpoint resolution: an independent resolver can catch a builder that
  picked the wrong pin. Shared vocabulary (`portEndKey`, pin position
  helpers) is imported; drift is controlled by the golden + corruption
  suites.
