# Node-Pack Extension Audit (pre-API-v1 freeze)

Purpose: architecture.md section 11 commits to auditing the extension contract against what
high-usage packs actually do before freezing API v1. This document is that audit. It is
usage-weighted (2-week local telemetry, 2026-07-19, ~70k users) and based on reading the
current frontend source of each pack, not on their READMEs.

Method: each pack's WEB_DIRECTORY code was catalogued under a fixed taxonomy:
(A) custom widgets, (B) node drawing/layout overrides, (C) gesture/keyboard interception,
(D) menus/panels/settings, (E) backend routes + fetches, (F) previews/live media,
(G) frontend-only virtual nodes, (H) automated graph/link mutation, (I) serialization hooks,
(J) badges/decorations, (K) dynamic slots. Findings were then mapped onto Dinkster's existing
contracts (widgets, menus, surfaces, commands, named nets, mode panels, value sources,
dynamic slots, preview channel, replacement engine).

## Audited packs and usage weight

| Pack | Users | % of installs | Frontend intensity |
|------|-------|---------------|--------------------|
| comfyui-kjnodes | 18,400 | 26.1% | very high (Set/Get, spline/points editors, previews) |
| rgthree-comfy | 18,136 | 25.8% | very high (virtual nodes, power widgets, prompt rewrites) |
| comfyui-easy-use | 15,904 | 22.6% | high (theme, group map, getset, image chooser) |
| comfyui-impact-pack | 15,108 | 21.5% | high (SAM editor, preview bridge, dynamic switches) |
| comfyui-videohelpersuite | 13,762 | 19.5% | high (video previews, format widgets; audited previously, see architecture.md sec. 9) |
| comfyui-custom-scripts | 13,325 | 18.9% | high (autocomplete, image feed, workflow image, presets) |
| cg-use-everywhere | 6,776 | 9.6% | very high (inferred virtual topology) |
| comfyui-lora-manager | 4,221 | 6.0% | high (pickers, sidebar app, REST suite) |
| comfyui-mxtoolkit | 4,122 | 5.9% | medium (canvas sliders, seed, stopper, reroute) |
| comfyui-crystools | 3,446 | 4.9% | medium (resource monitor, progress bar, result text) |
| comfyui_custom_nodes_alekpet | 2,356 | 3.3% | high (Fabric.js painter/pose editors) |

## Part 1: What packs actually do (usage-weighted synthesis)

### 1. Frontend-only "virtual" nodes are the single biggest category

Every top pack ships nodes that never execute on the backend but live in the workflow:

- rgthree: Fast Muter/Bypasser (per-target toggles via link traversal through declared
  pass-through nodes), Fast Groups Muter/Bypasser (group-membership driven), Node Mode
  Relay/Repeater (mode propagation), Random Unmuter (queue-time random enable), Reroute,
  Label, Bookmark, Power Conductor (scripted mode changes).
- KJNodes: SetNode/GetNode named variables with lexical graph scoping (own graph, then
  ancestors; siblings isolated), hidden links drawn by patching onDrawBackground, paste
  rename maps held in module globals cleared on setTimeout(0).
- Easy-Use: its own getset pair, bookmark node.
- mxToolkit: virtual reroute with two-arrow-key orientation chords.
- pysssss: PresetText with applyToGraph copying values into real widgets pre-queue.
- Crystools: Show Metadata inspector node.
- cg-use-everywhere: backend-defined controllers whose fan-out is entirely
  frontend-inferred topology (regex/type/color/group matching, priority + ambiguity
  rejection), materialized into real links inside wrapped graphToPrompt/queuePrompt and
  then rolled back; convertToSubgraph is wrapped and repaired; README documents years of
  subgraph breakage.

All of these serialize state so results reproduce: target modes live on target nodes,
names live in widget values, restrictions live in node properties, UE writes
graph.extra.ue_links.

Dinkster verdict: this whole category is why named nets (sec. 5), mode
flags/control-surfaces/mode-panels (sec. 6), value sources (sec. 5b), and first-class
reroutes exist. The audit confirms the shapes chosen are the right ones - and confirms
the failure modes we designed against are real (KJ's paste rename race, UE's
subgraph-restoration classifier, both packs patching computeVisibleNodes/drawBackground
just to render their links).

### 2. Custom widgets are DOM-mounted editors with JSON values

The dominant pattern across KJNodes (spline/points/transform editors, HDR/WebGL preview,
screen capture), AlekPet (Fabric.js painter and pose editors), Impact (SEGS picker,
mask-rect canvas), LoRA Manager (pickers, autocomplete, Vue-mounted widgets), Easy-Use
(style selector, slider grid), rgthree (Power Lora rows drawn on canvas): a widget is an
interactive editor whose value is a JSON blob (points_store, pose keypoints, lora row
arrays), often backed by one or more hidden companion widgets, and often needing:

- pointer capture, drag, modifier keys, wheel, keyboard inside its own bounds;
- explicit forwarding of middle-drag/wheel back to canvas panning (LoRA Manager and
  KJNodes both hand-roll this);
- image paste/drop onto the widget;
- background media from an upstream node's last output (KJ editor_base watches connected
  LoadImage/VHS nodes - exactly our peek/live-preview lens);
- value rescaling on dimension changes;
- custom serializeValue distinct from displayed value (Impact placeholders, screen-capture
  PNG at queue time).

Dinkster verdict: the WidgetKind/WidgetView split covers semantics/views, and expanded
overlay editors cover the "editor bigger than the node" need. Confirmed gaps are the
interaction envelope and companion-value patterns - see Part 3.

### 3. Menu wrapping is universal; settings and commands are the easy half

Every pack wraps getExtraMenuOptions per node type; most patch getCanvasMenuOptions;
several replace LiteGraph.ContextMenu itself (rgthree auto-nesting, Easy-Use thumbnail
menus, pysssss ships a *context menu monkey-patch bus for other packs*). Link-menu and
slot-menu injection (KJ "Convert to Set/Get" edits generated menu DOM; rgthree
masquerades widget rows as slots to get a slot menu) exist because those anchors have no
contribution API. Settings registration, by contrast, is used cleanly by everyone via
app.ui.settings.

Dinkster verdict: the menu contribution registry with anchors on every surface (node, port,
widget, link, named net, group, canvas, tab) directly absorbs this. The audit adds two
anchor requirements: link menus and widget-row menus must be real anchors (they are the
two places packs resorted to DOM surgery), and long-list nesting/thumbnails must be a
menu *presentation* capability so packs stop replacing the menu widget to get folders.

### 4. Backend routes + typed fetches + push events

- Routes: rgthree (config, model info, previews), Easy-Use (styles, thumbnails, cleangpu,
  reboot, image-chooser messaging), pysssss (autocomplete lists, model images/metadata,
  workflow store), Impact (wildcards, preview-bridge id map, SEGS picker, SAM
  prepare/detect), AlekPet (translate, painter storage), LoRA Manager (a full REST suite
  under /api/lm/). All hand-rolled fetch + PromptServer routes.
- Push events: custom WS message types are load-bearing - impact-preview, img-send,
  latent-send, easyuse-image-choose, kj_preview_override, crystools.monitor,
  alekpet_get_image. Impact's image chooser *pauses execution* and resumes when the
  frontend POSTs a selection.

Dinkster verdict: remote inputs and the preview channel cover the pull side for
combos/media. Two confirmed contracts to add: declared extension event channels
(typed, backend-scoped, execution-aware) and a declared route/fetch binding, Part 3.

### 5. Queue-time prompt rewriting

rgthree seed nodes rewrite -1/-2/-3 into concrete seeds in both formats at queue time;
Random Unmuter briefly unmutes one target during graphToPrompt; pysssss Repeater clones
prompt nodes; MultiPrimitive expands Cartesian permutations; PresetText expands @refs in
serializeValue; UE materializes links; Easy-Use appends workflow.seed_widgets.

Dinkster verdict: most of these are subsumed by first-class features (controllers own seed
advancement and already write resolved values into the snapshot; named nets compile to
real edges; value sources are declared literals). The residue - "my node multiplies into
N prompt nodes" - is a genuine compiler capability, not a hook: see Part 3.

### 6. Global drawing/theming and gesture interception

- Easy-Use Obsidian theme replaces drawNodeShape/drawNodeWidgets wholesale; KJNodes ships
  canvas background patterns and a performance mode that replaces canvas.draw.
- Gesture interception: KJ node_insert (drag node over link to splice), nodeswap,
  shake-to-disconnect; Easy-Use Alt+1..9 template paste and a replaced pasteFromClipboard;
  mxToolkit consumes gestures only inside node-local hit regions (the acceptable shape).

Dinkster verdict: host-owned semantic tokens cover palette/typography; full node-shape reskinning stays
out (a renderer capability, not a hack path). Node-local gestures inside widget bounds are
the sanctioned envelope. Link-splice-on-drag and link-drop suggestion menus are popular
enough (two packs each) to become core interactions with contribution points rather than
letting packs fight over pointer events.

### 7. Result text/JSON display widgets

Show Text (pysssss), Display Any (rgthree), Crystools displayContext, Easy-Use spent-time
widgets: all bind execution outputs into read-only widgets, all fight serialization
(should the result persist in the workflow? Show Text says yes, Display Any explicitly
clears it), and all hand-resize their nodes.

Dinkster verdict: this is the preview channel generalized to non-media payloads. Cheap to
support: a result channel keyed by (execution, node) feeding a read-only widget view, with
schema-declared persistence (persist result into values vs transient). Node auto-size
already handles the resize half.

## Part 2: Coverage matrix

Status: COVERED (contract exists in code or spec and absorbs the need),
PARTIAL (contract exists, audit adds a requirement), GAP (needs a new contract).

| # | Capability packs use today | Packs (weight) | Dinkster mechanism | Status |
|---|----------------------------|----------------|-----------------|--------|
| 1 | Get/Set variables, scoped, hideable links | KJ 26%, Easy-Use 23% | Named nets (first-class topology, graph-scoped) | COVERED |
| 2 | Mute/bypass control nodes (targets, groups, relays) | rgthree 26%, Easy-Use 23% | Mode flags + control surfaces + mode panels | COVERED |
| 3 | Broadcast/inferred links (UE) | UE 10% | Named nets cover the intent (explicit names instead of regex inference); regex/color auto-matching itself is deliberately NOT reproduced | COVERED (by substitution; decision recorded below) |
| 4 | Virtual reroutes | rgthree, mxToolkit, pysssss | First-class reroutes | COVERED |
| 5 | Primitive/value nodes incl. type-switching | rgthree Power Primitive, mxToolkit sliders | Value sources + constraint editing | COVERED |
| 6 | Dynamic input growth (collectors, switches, multi-batch) | Impact 21%, KJ, rgthree, UE | Autogrow/DynamicSlot (incl. groups, nesting, boundary splitting) | COVERED |
| 7 | Dynamic outputs driven by widget/connection | Impact inversed switch, rgthree Power Puter, mxToolkit | Dynamic slots (outputs planned; on roadmap) | PARTIAL - confirms priority of dynamic outputs |
| 8 | DOM editor widgets with JSON values | KJ, AlekPet, Impact, LoRA Mgr, Easy-Use | WidgetKind/WidgetView + expanded overlay editor | PARTIAL - interaction envelope + companion values (Part 3.1) |
| 9 | Widget backgrounds from upstream outputs | KJ editor_base, AlekPet | Peek/live-preview lens (sec. 9) | COVERED |
| 10 | Custom serializeValue at queue time | Impact, KJ screencap, pysssss presets | Widget commit hook: value finalized on document write, not at queue; queue-time capture needs the result/capture contract (Part 3.5) | PARTIAL |
| 11 | Node/canvas/link/slot menu injection | all packs | Menu contribution registry | PARTIAL - link + widget-row anchors, nested/thumbnail presentation (Part 3.2) |
| 12 | Settings pages | all packs | Settings contributions | COVERED |
| 13 | Topbar buttons, status/progress chrome, favicon | rgthree, Crystools, pysssss, LoRA Mgr | Surface registry (status bar items, panels) | PARTIAL - app-status API incl. favicon/title (Part 3.6) |
| 14 | Sidebar/panel apps | LoRA Mgr, pysssss image feed, Easy-Use group map | Surface registry panels | COVERED |
| 15 | Pack routes + typed fetch | 7 packs | Declared route/fetch binding | GAP (Part 3.3) |
| 16 | Custom WS push events, execution-scoped | Impact, KJ, Crystools, Easy-Use, AlekPet | Extension event channels | GAP (Part 3.3) |
| 17 | Pause-execution interactive nodes (image chooser) | Easy-Use, Impact | Needs backend cooperation; frontend side = event channel + command reply | GAP - record for Dinkster backend co-design (Part 3.3) |
| 18 | Live media previews (WS binary, /view) | KJ, Impact, VHS, pysssss | Preview channel | COVERED |
| 19 | Read-only result text/JSON widgets | pysssss, rgthree, Crystools, Easy-Use | Result channel extension of previews | GAP, cheap (Part 3.5) |
| 20 | Queue-time prompt rewriting | rgthree, pysssss, UE, Easy-Use | Controllers/named nets/value sources subsume most; node multiplication residue | PARTIAL (Part 3.4) |
| 21 | Node badges/overlays + clickable info | rgthree, Impact, UE, LoRA Mgr | Interactive badge contract (popover + actions) | COVERED |
| 22 | Annotation nodes (Label, Bookmark) | rgthree, Easy-Use | Not yet specced | GAP, small (Part 3.7) |
| 23 | Link splice on node-drag, link-drop suggestions | KJ, Easy-Use, pysssss | Core interactions today | PARTIAL - make suggestion list a contribution point (Part 3.8) |
| 24 | Auto-arrange/align/swap/fix-node commands | pysssss, Easy-Use, KJ | Command API over document (atomic, undoable) | COVERED |
| 25 | Workflow import/export formats (PNG/SVG embed, A1111) | pysssss | Importer/exporter registry | COVERED |
| 26 | Namespaced extension data on nodes/document | UE, KJ Ideogram, LoRA Mgr, rgthree | Node/document extension data (preserved by replace engine) | COVERED - add migration hook note (Part 3.9) |
| 27 | Global theme / node reskin | Easy-Use, KJ | Theme tokens only; reskin out of scope | COVERED (boundary; recorded) |
| 28 | Free canvas gesture interception | KJ insert/swap/shake, Easy-Use | Deliberately refused; node-local envelope + canvas tools | COVERED (boundary) |
| 29 | Widget defaults management, per-node user defaults | pysssss widgetDefaults | User settings layered over schema defaults; composes with modified-indicator derivation | PARTIAL - fold into settings design later |
| 30 | Node marking/roles (title emoji, workflow registry) | LoRA Mgr | Extension data + badges | COVERED |

## Part 3: Gaps -> proposed contracts (bounded)

### 3.1 Widget interaction envelope (highest priority, blocks widget API freeze)

What packs prove they need inside widget bounds: pointer down/move/up with capture,
drag deltas + cancellation, dblclick, wheel opt-in, modifier keys, focus + keyboard while
focused, paste/drop of files and images. And the two hygiene rules every pack hand-rolls
today must be core-owned, not widget-owned: middle-drag/wheel always pans/zooms the canvas
(core routes it; widgets cannot eat it), and Escape/focus-loss cancels a widget drag.
Deliverable: extend the WidgetView contract with an explicit InteractionEnvelope; document
that global listeners are never needed. Companion values: a WidgetKind may declare derived
companion values (hidden from UI, present in node.values) so patterns like
points_store/coordinates stop being two secretly-coupled widgets.

### 3.2 Menu completeness

Add link and widget-row anchors (the two DOM-surgery sites in the wild). Add declarative
menu presentation options: hierarchical nesting for path-like item lists and optional
thumbnail decoration fetched via remote values - so "folders in the LoRA menu" is a flag,
not a replaced menu widget.

### 3.3 Backend integration contract

Three pieces, all pack-declared, all typed:
1. Route binding: a pack manifest declares its route namespace; the client exposes a typed
   fetch helper bound to that namespace (no hand-built URLs, no api.apiURL patching).
2. Event channels: pack declares channel names; backend pushes tagged messages; frontend
   subscriptions are execution-aware (a channel message carrying an execution id routes to
   that execution's snapshot/frozen view, never "whatever tab is open" - the same
   correctness rule our previews already follow).
3. Interactive pause (image-chooser pattern): frontend sees a "waiting for user input"
   execution state on the owning execution object, renders the declared chooser surface,
   replies via a command that POSTs to the pack route. Record as a Dinkster-backend
   co-design item; do not emulate the current hijack-the-dialog approach.

### 3.4 Compile passes (decide the boundary now)

Decision recorded: no free graphToPrompt hook. The audited uses decompose as:
- seeds/randomization -> controllers (already resolve into the snapshot);
- get/set + UE-style wiring -> named nets;
- presets/primitives -> value sources;
- muting/bypass tricks -> mode flags + control surfaces.
The one residual power (pysssss Repeater node multiplication) becomes, if ever needed, a
declared schema-level expansion (node declares it expands to N copies of a template) that
the compiler executes deterministically - visible in the CompileArtifact and the frozen
view, reproducible from the document. Until a real pack needs it in Dinkster, do not build
it; record it as the sanctioned shape so nobody adds a hook instead.

UE-style regex/color inference is deliberately not reproduced: implicit topology that
depends on node titles/colors breaks reproducibility-from-document readability and is the
documented source of UE's subgraph pain. Named nets are the migration target (explicit
name, same convenience, scoped, renderable).

### 3.5 Result channel (generalize previews)

Extend the preview channel with non-media payloads (text/JSON), keyed by
(executionId, nodeId, outputKey). A schema flag or widget view binds a read-only widget to
the channel; a second flag opts the last result into node.values (Show Text semantics:
persists and reproduces) vs transient (Display Any semantics: cleared on serialize).
Frozen views show the results of THEIR execution - which fixes the current frontend's
wrong-tab/wrong-run result text for free.

### 3.6 App-status API

Small surface: status-bar items already exist; add queue/progress state selectors
(pack-readable) and an app-badge API (favicon/title decoration) so faviconStatus-type
features are a registration, not DOM/document.title fights.

### 3.7 Annotations

Label and Bookmark are cheap, popular, and pure-frontend. Make them core document
citizens (annotation objects: styled label; bookmark = named viewport with keybinding via
the command/keymap registry), not pack nodes. They serialize with the workflow, ignore
compile, and get menu/badge anchors like everything else.

### 3.8 Link-drop and drag-splice contribution points

Core owns the gestures (drop-a-link menu, drag-node-over-link splice). Packs contribute:
link-drop suggestion providers (declarative: given port type/direction, contribute
ranked node templates - same `when` clause machinery as menus) and splice compatibility
comes from the type solver, not pack code.

### 3.9 Extension data migration

Node/document extension data is namespaced and preserved by node.replace. Add: a pack may
register a migration hook (namespace, fromVersion) run at document load, mirroring the
core format upgrader - so packs never wrap loadGraphData to migrate their blobs.

## Part 4: Anti-hack boundaries confirmed by the audit

Refused, with the declared alternative:
- Global canvas draw/gesture patching -> node-local widget envelope, badges/overlays,
  canvas tools with enter/exit lifecycle.
- Menu widget replacement -> presentation options on the menu registry.
- Prompt-serialization wrapping -> controllers, named nets, value sources, (future)
  declared expansions.
- graph.extra scribbling -> namespaced extension data + migration hooks.
- computeVisibleNodes/drawBackground patching to render virtual links -> named nets are
  real topology and render natively.
- DTO/prototype introspection (KJ probes function source to detect frontend versions) ->
  versioned API surface.
- Hidden-widget side channels for backend values -> companion values (3.1) and the
  result channel (3.5).

## Part 5: Recommended next slice

1. Widget InteractionEnvelope + companion values (3.1) - blocks freezing the widget API,
   which everything DOM-editor-shaped depends on.
2. Result channel (3.5) - small, high pack coverage (4 of the top 6 packs ship a
   Show-Text-alike), and exercises execution-scoped routing that the event-channel work
   (3.3) will reuse.
3. Menu anchors for links/widget rows + nested presentation (3.2) - closes the two
   remaining DOM-surgery sites.
4. Annotations (3.7) - cheap, and removes the last reason for "frontend-only pack nodes"
   that are neither control surfaces nor value sources.
Backend integration (3.3) and expansions (3.4) wait for Dinkster backend co-design; the
decisions above are recorded so the API v1 freeze does not paint over them.
