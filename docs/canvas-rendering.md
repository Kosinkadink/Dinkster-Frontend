# Canvas rendering

The canvas keeps the graph scene separate from the camera. On browsers with
transferable offscreen bitmaps, graph paint is retained in device-pixel tiles.
A camera-only move reuses visible tiles when the scale and backing density
match. The logical camera retains fractional movement, while painting rounds
translation to physical pixels. This keeps retained text sharp without
resampling and limits visual translation steps to one physical pixel. Newly
exposed tiles are painted from the scene. Tiles outside the visible working
set are closed rather than retained indefinitely.

Tiles are copied at their original pixel size, never stretched. Zoom changes
repaint at the new scale, preserving sharp text and geometry. Scene, overlay, preview, execution-state, theme and style
updates invalidate retained graph images. Disposing the renderer closes its
remaining images. Running-node animation and browsers without transferable
offscreen bitmaps use direct graph painting.

Background and foreground pack contributions, the grid, toolbox and remote
presence remain viewport layers outside the retained graph images. Widgets
still use their registered compact painters; the active editor remains a DOM
overlay rather than part of the graph bitmap.

The browser frame-equivalence check compares a retained-history renderer with
a fresh renderer at each identical state. It compares complete raw RGBA
frames without a tolerance, including fractional-DPR pans, exposed edges,
zoom detail changes, selection, drag, edit, theme, style and resize. Separate
counting checks require camera-only reuse and bounded image copies for the
fixed 66-, 300- and 1200-node fixtures. Frame-time tools and measured results
are documented in [Performance baselines](perf.md); timings are reports, not
CI assertions.
