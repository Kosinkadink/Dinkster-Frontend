# Image documents

The shared `dinkster-image` format, version 2, remains available to layered
assets, previews and compositor execution. The Image documents workspace and
image editors are parked; no product control opens them. Existing stored image
documents, drafts and assets are not modified or deleted. Their authoring code
and tests are preserved in
[Image documents workspace](https://github.com/Kosinkadink/comfy-vibe-station/issues/1190).

## Shared format

`packages/core/src/image-document/` owns the document model, strict validation,
loading, commands, sessions and stores. A document holds a canvas, ordered layer
tree, masks and asset-backed resources. Fractional affine components are signed
integers in millionths; opacity ranges from 0 to 65,535. Equal layer z indexes
retain serialized sibling order. Pixel content is referenced through resources,
not copied into workflow values.

Core validation bounds document bytes, canvas dimensions, total pixels, layers,
layer depth, masks and resources. Loading and rendering use the same shared
format; removing an editing surface does not change those contracts.

## Assets and execution

Image documents and their resources load directly from the selected backend.
Opening or editing them does not record cleanup file lists or wait for cleanup
receipts. Layered assets and previews retain their normal rendering paths.
[Compositor execution](compositor.md) applies a stored recipe to its authoritative
runtime document without requiring an editor. Output policy continues to support
PNG, JPEG and WebP.
