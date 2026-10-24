# Graph-native compositor

The compositor keeps source images and masks in the graph. `Add Layer` appends
one image batch and optional transparency mask to an ordered `dinkster.layers`
value. `Layers From Bounding Boxes` creates placements from an image batch and
matching regions or detections. `Create Layered Image` renders at most 50
expanded layers and exposes its `Compositor` row through the existing Image
editor.

Run `Create Layered Image` once before opening the editor. The run supplies an
authoritative ImageDocument v2, its digest, bounded layer previews, native
placements, and canvas size. The editor can reorder layers, rename or hide them,
set opacity and a blend mode, drag or enter placement, resize, rotate, flip, and
configure the canvas background. Apply uses the maintained
`image.compositorApply` command to compare the opened workflow value and
document digest, then writes one undoable ImageDocument delta. Layer transforms
also carry each attached mask's relative affine placement and source dimensions.
Apply refuses a concurrently changed document, driven input, or mask placement
that would require shear outside the component-transform grammar. Cancel writes
nothing. The compact row reports the saved command count.

The node supports perceptual and linear-light compositing. The backend remains
authoritative for all 27 blend modes, transforms, masks, output pixels, and the
transparency mask; the editor preview is interactive guidance. A saved delta is
replayed only when its document digest matches the current layer document. If
sources change, execution uses native graph placements instead, marks the result
stale, and leaves the saved delta untouched.

The current schema retains the exact fieldless `COMPOSITOR` widget descriptor only
on concrete `dinkster.compositor`. Its exact empty default is
`{"version":2,"documentDigest":null,"commands":[]}`. A configured delta binds
typed canvas, layer, transform, mask-transform, and reorder commands to the
runtime document digest. Pixel content remains in digest-owned ImageDocument
resources and never enters the workflow value. The compositor and persistent
image workspace therefore share the same asset-backed layer document model.

The [live compositor editor](https://raw.githubusercontent.com/Kosinkadink/dinkster-evidence/main/frontend/issue-400/graph-native-compositor.png)
shows the two-layer native execution state and edited placement.
