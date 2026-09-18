# ComfyUI Frontend Behavior Audit (research only - nothing here is approved for implementation)

Audit of the ComfyUI_frontend reference checkout for subtle UX behaviors Dinkster may want
to adopt. Each item: evidence paths (in ComfyUI_frontend), behavior, verdict
(adopt/adapt/skip), complexity (S/M/L). Status column tracks review with the user;
everything starts as "pending review". Do NOT implement items from this list until the
user has approved them.

## Verified implementation status (2026-07-22, code-checked)

The original per-item "Dinkster coverage" notes below were written from a feature LIST and
several were wrong. This table is the authoritative, code-verified status; where it
conflicts with a note below, this table wins. Evidence lives in the Dinkster repo.

ALREADY DONE (original audit wrongly listed as gaps):
- 1 Typed search on link release: link-drop opens a compatibility-filtered palette and
  auto-connects (CanvasHost.tsx LinkDropContext; e2e link-drop.spec.ts).
- 3 Drag output fan-out together: Shift-drag re-sources a fan-out atomically
  (interaction.ts; core-commands.ts).
- 9 Insert reroute on link: double-click splits a link through a new reroute
  (interaction.ts; e2e reroutes.spec.ts).
- 12 First-class branching reroutes: chains, fan-out, two-sided sockets, dissolve
  (core/reroute.ts).
- 24 Context-menu breadth: typed extensible menu registry over nodes/widgets/links/
  reroutes/sections (menus/contract.ts, core-items.ts).
- 31 Running outline + progress bar: painted and paint-tested (renderer.ts,
  renderer-paint.test.ts).
- 40 Boundary slot lifecycle: expose/rename/bind/unbind/remove with cleanup, undo,
  diagnostics (boundary-commands.ts; e2e boundary-editor + boundary-nodes).
- 43 Viewport memory + breadcrumbs: graph-stack navigation, per-graph camera,
  breadcrumb UI (app-state.ts, CanvasHost.tsx).

SUBSTANTIAL FOUNDATIONS, ADAPT NOT ADOPT: 2 (release menu: search exists, no reroute/
default actions), 5 (targets highlighted, no magnetic snap), 11 (ghost sockets + Alt
fan-out exist; no Shift segment rewire/Alt-click insert), 13 (type/color propagate; no
labels), 14 (steppers + direct entry exist; no drag-scrub), 17 (multiline textarea
exists; no Markdown preview), 18 (upload/preview/failure exist; no gallery/compare),
19 (section collapse exists; no whole-node collapse), 20 (corner resize exists), 21
(title command + descriptions exist; no inline header editor/hover tooltip), 23 (size +
section visibility persist; no colors/shapes), 26 (mode panels bulk-apply; no group
context action), 27 (spatial membership carried on drag; not persistent/recursive/pin-
aware), 29 (registry + capture + search exist; chord capture bug, no reference panel),
30 (core shortcuts exist; missing pin/collapse/lock/tab-nav/paste-connect), 33 (image
panels + peek exist; no gallery/latents), 34 (rail + durable history exist; no compact
hover overlay), 35 (weighted ranking exists; no frequency), 36 (filters/categories/
provenance exist; no favorites), 37 (click placement exists; no library sidebar), 39
(error shells + drift diagnostics exist; no install/recovery UI), 41 (promoted widgets
render/edit; no per-instance promote/demote/reorder UI), 44 (metadata parsed; not
rendered as tooltips), 45 (palette preview rich; no selected-node help panel), 46
(pack/error/deprecation badges exist; no pin badge), 47 (fit/zoom/minimap/grid exist;
no FPS overlay).

GENUINELY ABSENT (true adoption candidates): 4 whole-node link-drop targeting, 6 link-
drag edge auto-pan, 7 grid snapping, 8 align/distribute, 10 link-center marker, 15
sliders, 16 seed control-after-generate EXECUTION (metadata persisted; no UI, no
post-run advancement - promised early, being implemented now), 22 pinning, 25 fit
group to contents, 28 keyboard nudge, 32 animated flow links, 38 selection templates,
42 promoted previews, 48 zoom-dependent LOD rendering.

## 1. Canvas interactions

1. **Typed node search on link release** - `src/lib/litegraph/src/LGraphCanvas.ts`.
   Releasing a link on empty canvas opens search/connection menu filtered by the slot
   type; picking a node creates it and auto-connects. Verdict: adopt. Complexity: M.
2. **Link-release connection menu** - `src/lib/litegraph/src/LGraphCanvas.ts`. Release
   menu offers Add Node / Add Reroute / Search / type-specific defaults, preserving
   reroute ancestry. Verdict: adapt (compact typed palette, not the legacy nested
   menu). Complexity: M.
3. **Drag multiple output links together** - `LGraphCanvas.ts`,
   `src/lib/litegraph/src/canvas/LinkConnector.ts` (+ integration test). Dragging from
   a fan-out output can move all links as a set, compatibility checked once.
   Verdict: adopt. Complexity: M. Dinkster's Shift-drag move-source gesture applies to
   real outputs, widget taps, and reroute outputs. A pointer-up on another valid
   source re-sources every grabbed link; a pointer-up on empty canvas disconnects
   every grabbed link in one undoable transaction. Escape and platform cancellation
   preserve the original links. The empty drop does not open search or snap back.
4. **Whole-node link-drop targeting** -
   `src/renderer/core/canvas/links/linkDropOrchestrator.ts`,
   `src/renderer/extensions/vueNodes/composables/useSlotLinkInteraction.ts`. Dropping a
   link on a node body resolves to the first compatible slot. Verdict: adopt.
   Complexity: M.
5. **Link-drag snapping + target highlighting** - `LGraphCanvas.ts`,
   `canvas/LinkConnector.ts`, `src/renderer/core/canvas/links/slotLinkDragUIState.ts`.
   Compatible sockets attract the dragged endpoint and highlight their node.
   Verdict: adopt. Complexity: M.
6. **Link-drag edge auto-pan** - `LGraphCanvas.ts` (+ linkDragAutoPan tests). Viewport
   pans when dragging a link near the canvas edge. Verdict: adopt. Complexity: S.
7. **Grid snapping everywhere** - `LGraph.ts`, `LGraphCanvas.ts`, `LGraphNode.ts`,
   `LGraphGroup.ts`, `Reroute.ts`, `subgraph/SubgraphIONodeBase.ts`. Snap applies to
   move/create/resize for nodes, groups, reroutes, boundary IO; pinned items exempt.
   Verdict: adopt. Complexity: M.
8. **Align / distribute / layout-grid tools** -
   `src/lib/litegraph/src/utils/arrange.ts`,
   `src/components/graph/selectionToolbox/ArrangeButton.vue`. Multi-selection align,
   distribute, spacing, grid arrange from context menu + toolbox. Verdict: adopt.
   Complexity: M.

## 2. Reroutes and links

9. **Insert reroute on a link segment** - `LGraphCanvas.ts`, `LGraph.ts`. Link context
   menu Add Reroute at pointer; Alt-click on a segment creates a reroute and enters
   drag placement. Verdict: adopt. Complexity: S.
10. **Link-center interaction marker** - `LGraphCanvas.ts`,
    `src/renderer/core/canvas/pathRenderer.ts`. At sufficient zoom, links render a
    center marker opening Add Node / Add Reroute / Delete. Verdict: adapt (hover or
    selection only). Complexity: S.
11. **Shift-rewire and Alt-reroute gestures** - `LGraphCanvas.ts`. Shift-click a link
    to start a drag from that segment; Alt-click inserts a reroute; reroutes expose
    two-sided hit areas. Verdict: adapt (compare exact modifier semantics with
    Dinkster's, adopt missing Alt insertion). Complexity: S.
12. **First-class branching reroutes** - `Reroute.ts`, `canvas/LinkConnector.ts`.
    Route ancestry, floating endpoints, fan-out paths, copied chains. Verdict: adapt
    if Dinkster reroutes are only visual bend points. Complexity: L.
13. **Legacy typed reroute node** - `src/extensions/core/rerouteNode.ts`. Type/color
    propagation through chains, optional type labels. Verdict: skip/adapt (copy type
    propagation + labels only). Complexity: M.

## 3. Widget direct manipulation

14. **Numeric arrows + horizontal scrubbing** -
    `src/lib/litegraph/src/widgets/NumberWidget.ts`, `BaseSteppedWidget.ts`. Side
    zones step; center drag scrubs; center click opens direct entry. Verdict: adopt.
    Complexity: S.
15. **Slider / gradient-slider / knob modes** - `widgets/SliderWidget.ts`,
    `GradientSliderWidget.ts`, `src/extensions/core/customWidgets.ts`. Numeric
    metadata selects presentation mode. Verdict: adapt (plain slider first).
    Complexity: M.
16. **Seed / control-after-generate** - `src/extensions/core/widgetInputs.ts`,
    `src/renderer/extensions/vueNodes/widgets/components/WidgetWithControl.vue`,
    `ValueControlButton.vue`, `ValueControlPopover.vue`. Fixed/increment/decrement/
    randomize post-generation mutation, preserved through subgraph promotion.
    Verdict: adopt. Complexity: M.
17. **Multiline text expansion + rich read-only text widgets** -
    `widgets/TextWidget.ts`, `TextareaWidget.ts`,
    `src/extensions/core/textPreviewWidgets.ts`. DOM-backed editors; Markdown
    previews. Verdict: adopt. Complexity: M.
18. **Upload / gallery / image-compare widgets** - `widgets/FileUploadWidget.ts`,
    `GalleriaWidget.ts`, `ImageCompareWidget.ts`,
    `widgets/composables/useImageUploadWidget.ts`. Verdict: adapt (upload + gallery
    first; compare is specialized). Complexity: L.

## 4. Node body UX

19. **Collapse with live execution feedback** -
    `src/renderer/extensions/vueNodes/components/NodeHeader.vue`, `LGraphNode.vue`,
    `LGraphCanvas.ts`. Collapsed nodes keep sockets and show progress in the header.
    Verdict: adopt. Complexity: M.
20. **Multi-edge resize with snap-aware minimums** - `LGraphNode.ts`,
    `LGraphCanvas.ts`, `interactions/resize/useNodeResize.ts`. Verdict: adapt (SE
    resize + fit-to-content minimum). Complexity: M.
21. **Inline node title edit + description tooltip** - `NodeHeader.vue`,
    `src/components/common/EditableText.vue`, `useNodeTooltips.ts`. Verdict: adopt.
    Complexity: S.
22. **Pinning (nodes, groups, reroutes, boundary IO)** - `interfaces.ts`,
    `LGraphNode.ts`, `LGraphGroup.ts`, `SubgraphIONodeBase.ts`,
    `src/composables/useCoreCommands.ts`. Pin blocks move/resize/snap; `P` shortcut;
    header indicator. Verdict: adopt. Complexity: S.
23. **Node colors, shapes, advanced-widget visibility, resize-to-content** -
    `LGraphCanvas.ts`, `src/composables/graph/useNodeCustomization.ts`. Verdict: adapt
    (colors + advanced-widget visibility; skip shapes). Complexity: M.
24. **Context-menu breadth** - `LGraphCanvas.ts`,
    `src/composables/graph/useMoreOptionsMenu.ts`. Use as completeness checklist.
    Verdict: adapt. Complexity: M.

## 5. Groups

25. **Fit group to contents** - `src/composables/graph/useGroupMenuOptions.ts`,
    `LGraphGroup.ts`. Verdict: adopt. Complexity: S.
26. **Group-level execution mode** - `useGroupMenuOptions.ts`. Set all contained
    nodes Always/Never/Bypass; menu adapts to mixed state. Verdict: adopt.
    Complexity: S.
27. **Group move carries recursive contents** - `LGraphGroup.ts`,
    `utils/collections.ts`. Nested groups/reroutes included, pinned children exempt;
    containment by node centers. Verdict: adopt if missing. Complexity: M.

## 6. Selection and keyboard

28. **Keyboard nudge by grid unit** - `useCoreCommands.ts`,
    `src/platform/keybindings/defaults.ts`. Verdict: adopt. Complexity: S.
29. **Shortcut registry + discoverable shortcut panel** -
    `src/platform/keybindings/*`, `KeybindingPanel.vue`, `ShortcutsList.vue`.
    Command/keybinding decoupling, overrides, conflicts, Ctrl+Shift+K panel.
    Verdict: adapt (searchable reference first, rebinding later). Complexity: L.
30. **Shortcut set audit** - `defaults.ts`, `useCoreCommands.ts`. Queue-front,
    interrupt, fit view, pin, collapse, convert-to-subgraph, canvas lock, workflow
    tab nav, paste-with-connect. Verdict: adapt (audit, not verbatim copy).
    Complexity: M. Note: ComfyUI has no invert-selection; arrows are nudges.

## 7. Execution UX

31. **Running-node outline + progress bar** -
    `execution/useNodeExecutionState.ts`, `LGraphNode.vue`. Verdict: adapt (keep
    Dinkster badges, add unmistakable running emphasis). Complexity: S.
32. **Animated data-flow links** - `pathRenderer.ts`, `litegraphLinkAdapter.ts`.
    Particles along executing links, globally suppressible. Verdict: adapt (active
    paths only). Complexity: M.
33. **Node output + latent previews** - `LGraphNodePreview.vue`, `ImagePreview.vue`,
    `LivePreview.vue`, `useNodePreviewState.ts`. Live sampling previews, final
    media galleries with keyboard nav, download, mask/edit. Verdict: adopt (top
    priority beyond badges). Complexity: L.
34. **Queue overlay progressive disclosure** - `src/components/queue/Queue*.vue`.
    Compact overlay (total + current-node progress, hover controls) expanding to
    running/queued/history tabs with per-job actions. Verdict: adapt. Complexity: L.

## 8. Search and library

35. **Fuzzy search with frequency ranking** -
    `src/components/searchbox/v2/NodeSearchContent.vue`,
    `src/services/nodeSearchService.ts`, `src/utils/fuseUtil.ts`. Verdict: adapt (add
    recency/frequency + typed filters). Complexity: M.
36. **Search categories, favorites, source badges** -
    `NodeSearchCategorySidebar.vue`, `NodeSearchFilterBar.vue`,
    `NodeSearchListItem.vue`, `src/stores/nodeBookmarkStore.ts`. Verdict: adopt
    (provenance matters as packs multiply). Complexity: M.
37. **Drag / click-place from sidebar** -
    `src/composables/node/useNodeDragToCanvas.ts`, `NodeDragPreview.vue`. Placement
    preview, Escape cancel, prefilled widget values. Verdict: adapt (needs a library
    sidebar first). Complexity: M.
38. **Reusable node templates** - `src/extensions/core/nodeTemplates.ts`. Save a
    selection as a named fragment; insert/rename/reorder/import/export.
    Verdict: adopt. Complexity: M.
39. **Missing-node / missing-pack recovery** -
    `src/components/rightSidePanel/errors/*`,
    `src/platform/nodeReplacement/missingNodeScan.ts`. Grouped by pack, locate on
    canvas, registry install, pending-restart state. Verdict: adopt. Complexity: L.

## 9. Subgraph specifics

40. **Boundary slot lifecycle completeness** - `src/lib/litegraph/src/subgraph/
    SubgraphInputNode.ts`, `SubgraphOutputNode.ts`, `SubgraphInput.ts`,
    `SubgraphOutput.ts`. Add/rename/remove with link cleanup and invalid-connection
    feedback. Verdict: adapt (verify Dinkster handles cleanup/undo/feedback, not just
    rename). Complexity: M.
41. **Promoted interior widgets on instances** -
    `src/components/rightSidePanel/subgraph/SubgraphEditor.vue`,
    `src/core/graph/subgraph/promotionUtils.ts`, `promotedInputWidget.ts`.
    Promote/demote/reorder interior widgets per instance; control-after-generate
    preserved. Verdict: adopt (key subgraph ergonomics). Complexity: L.
42. **Promoted previews on instances** -
    `src/core/graph/subgraph/preview/previewExposureChain.ts`,
    `src/stores/previewExposureStore.ts`. Interior node's preview exposed on the
    outer node per instance, nesting-safe. Verdict: adopt after 41. Complexity: L.
43. **Per-subgraph viewport memory + breadcrumbs** -
    `src/stores/subgraphNavigationStore.ts`,
    `src/components/breadcrumb/SubgraphBreadcrumb*.vue`. Verdict: adopt.
    Complexity: M.

## 10. Polish and rendering

44. **Node/socket/widget tooltips** - `src/components/graph/NodeTooltip.vue`,
    `useNodeTooltips.ts`. Definition-provided help on hover, localizable, globally
    disableable. Verdict: adopt. Complexity: M.
45. **Structured node help panel** - `src/components/node/NodeHelpContent.vue`,
    `selectionToolbox/InfoButton.vue`. Verdict: adopt. Complexity: M.
46. **Provenance/status badges** -
    `src/renderer/extensions/vueNodes/components/NodeBadges.vue`,
    `src/types/nodeSource.ts`. Source pack, core/custom, mute/bypass, pin.
    Verdict: adapt (source pack + mode + pin; avoid badge overload). Complexity: M.
47. **Canvas controls + info overlay** - `src/components/graph/GraphCanvasMenu.vue`,
    `LGraphCanvas.ts`. Fit view, zoom controls, optional FPS/render diagnostics.
    Verdict: adapt (diagnostics dev-only). Complexity: S.
48. **Zoom-dependent low-quality rendering** - `LGraphCanvas.ts`, `LGraphNode.ts`,
    `src/renderer/core/layout/transform/useTransformSettling.ts`. Below a readable
    threshold, skip shadows/text/detail; temporary low quality while panning/zooming.
    Verdict: adopt (likely essential for large graphs). Complexity: M.

## Suggested discussion order

1. Typed link-release search + whole-node link targets (1, 4).
2. Node previews + richer execution progress (33, 31).
3. Promoted subgraph widgets/previews (41, 42).
4. Missing-node recovery + source-pack provenance (39, 46).
5. Snap/align/distribute + keyboard nudge (7, 8, 28).
6. Seed controls + numeric scrubbing (16, 14).
7. Queue overlay details (34).
8. Rendering LOD + edge auto-pan (48, 6).
9. Templates, help, badges, visual customization (38, 44, 45, 23).
