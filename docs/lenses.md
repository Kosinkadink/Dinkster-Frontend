# Canvas lenses

A lens is a named canvas presentation and interaction preset. The active lens
is consulted while rendering the canvas and choosing tooltip detail. Lens
selection is per-tab view state: it is never written to the workflow document
and does not change execution semantics.

## Registry and integration seams

`packages/app/src/lenses.ts` defines `LensDefinition` and `LensRegistry`. A
definition registered with `register()` has an `id`, user-visible `label`, and
`description`. It may also declare these consumed capabilities:

- `typeAdornments`: asks the renderer to compile and paint its closed set of
  retained pin/noodle type labels. The Types lens never receives canvas,
  scene, overlay, or token handles.
- `nodeBodyContent(node, context)`: returns panel rows that replace a node's
  body content, or `null` to leave it unchanged. The Data lens derives these
  rows from the bound execution context.
- `detailedPinTooltips`: makes pin tooltips detailed without requiring the
  usual modifier.

The registry rejects duplicate ids and resolves an unknown or absent choice to
the registered default, `standard`. `AppState.lenses` is the single per-tab
active-lens signal. `CanvasHost` resolves that id through the registry and
hands its capabilities to the renderer and tooltip system. The renderer only
receives declarative capabilities or bounded content functions and never
receives or branches on a lens id.
The former `interactionModifiers` seam was removed because no shipped lens
used it; it can return when a concrete interaction requirement exists.

## Shipped lenses

- **Standard** (`standard`): the normal graph editing presentation.
- **Data** (`data`): replaces ordinary node-body content with rows derived from
  the bound execution. It shows non-default run states, skip reasons, recorded
  output values, output type descriptors, and list lengths. Multiple runtime
  occurrences report a run count and say `varies` when their states, values, or
  types disagree. Live values are marked stale unless the exactness check
  proves their producers current; frozen-run values are exact. Unknown
  occurrence paths show `-`, nodes without a recorded occurrence show
  `not run`, and subgraph instance nodes have no panel because their values
  belong to inner nodes. Layout, hit testing, and editing semantics are
  unchanged.
- **Types** (`types`): labels pin and noodle types when canvas zoom is above
  0.5 and uses detailed pin tooltips by default.

## UI and shortcut

The canvas top-left holds one horizontal control cluster: **Views** followed
by **Lenses**. Views names the active editor projection and offers Graph and
App view through the tab's ordinary editor-kind state. Lenses names the active
graph presentation and its menu lists every registered lens under a Lenses
heading; editor modes do not appear in that menu. A subgraph breadcrumb moves
the cluster below itself. Press Escape or pointer down outside either menu to
dismiss it; the outside gesture is consumed instead of reaching the canvas.
Both controls opt into the shell's delegated tooltip system. The stable shell
stage owns the cluster, so it remains available and names App while the App
projection replaces CanvasHost.

The Views menu also holds a **Named nets** section with three set-all
actions (`net-display-all-noodle`, `net-display-all-tags`,
`net-display-all-guide`) that put every net in the current definition into
one display mode: full noodles, endpoint tags only, or tags plus a dashed
Set-to-Get guide curve. Each net also has its own mutually exclusive mode in
its context menu (`core.net.display` submenu, backed by `view.setNetDisplay`;
set-all dispatches `view.setAllNetsDisplay`). The mode is document view state
(`collapsedNets`/`guideNets`), so it persists with the workflow and every
change is one undoable step. Guide curves ride the same drag offsets as the
endpoint tags and use screen-aware dashed strokes over a background casing so
they stay readable at any zoom and over ordinary noodles.

Press **D** while focus is outside an input field to select Data. Press **D**
again to return to Standard. There are no other lens shortcuts.

## Adding a lens

1. Add a `LensDefinition` registration in `createCoreLensRegistry()` with a
   stable lowercase id, label, and concise description. The registry is an
   app-internal catalog, not a third-party contribution API.
2. Implement only an existing bounded capability. The renderer-owned Types
   capability and host-owned Data rows are the current visual seams. A new
   canvas adornment shape requires its own reviewed descriptor, culling,
   ordering, and hit budget; arbitrary paint callbacks are not accepted.
3. If the lens has a shortcut, call `AppState.setLens()` or `toggleLens()` so
   the registry-backed per-tab signal remains the only activation state.
4. Add focused registry/rendering tests and browser coverage for the switcher
   or shortcut, then update this document and
   `docs/feature-coverage-audit.md` in the same change.
