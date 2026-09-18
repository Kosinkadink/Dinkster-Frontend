# 3D model previews and the orbit viewer

GLB assets (`model/gltf-binary`) and gaussian-splat PLY assets (`model/ply`),
both under the `media/model3d` catalog kind, preview everywhere other media
kinds do: in-node output previews, selected ASSET widget inputs, the peek
pipeline for `dinkster.model3d` and `dinkster.splat` outputs, the asset browser,
and the widget editor selection pane. `packages/app/src/model3d-mime.ts` is
the shared gate for which MIME types route through this pipeline.

## Rendering model

A 3D preview has two presentation modes:

1. A poster still, rendered once per source URL by an offscreen three.js
   WebGL pass (`packages/app/src/model3d-viewer.ts`). The poster is a plain
   ImageBitmap, so the canvas renderer paints it in-canvas exactly like an
   image preview - no DOM overlay, no compositing exception, and thumbnails
   in the asset browser and collection panel reuse the same PNG object URL
   cache. Poster renders queue through a small concurrency gate (browsers
   cap live WebGL contexts) and each render force-loses its context when
   done; the object URL cache is a bounded LRU that revokes evicted URLs.
2. An interactive orbit viewport, mounted on demand. The node preview region
   shows Download and Orbit actions (`NodeModel3dOverlay` in
   `packages/app/src/CanvasHost.tsx`); opening it mounts a live three.js
   scene with OrbitControls into a DOM overlay clipped to the preview
   region, following the video/audio overlay ownership pattern. Closing or
   unmounting disposes the renderer, controls, and GL context.

Recorded outputs retain the backend artifact name and expose a normal browser
download in node and App View previews. Peek renditions use the output ID and
rendition MIME to derive a safe filename. Live frames and selected inputs do
not acquire output-download semantics.

Camera state is per-client and never serialized. Poster rendering frames the
model automatically from its bounding sphere with neutral lighting.

## Lazy loading

three.js and its GLTFLoader/OrbitControls examples load through one cached
dynamic import, triggered only when a 3D preview is actually requested.
Splat rendering additionally imports `@sparkjsdev/spark` through its own
cached dynamic import, so GLB-only sessions never pay for spark and
workflows without 3D content pay for neither.

## Splat rendering

Splat PLY sources load on the main thread (`fetch` -> `SplatMesh` with
`fileBytes`, so blob object URLs work) and rotate 180 degrees about X into
the three.js Y-up convention, matching how ComfyUI and spark's own viewer
treat 3DGS files. Every GL context that draws splats gets its own
`SparkRenderer` added to the scene: poster renders use `autoUpdate: false`
and one awaited `update()` so the single offscreen render captures the
first sorted ordering, while the orbit viewport uses `autoUpdate: true` and
lets the render loop drive sorting. The SparkRenderer is disposed before
the scene it served.

## Source plumbing

- `createPreviewLoader` treats `model/gltf-binary` and `model/ply`
  artifacts, renditions, and selected input assets as `model3d` sources
  keyed like direct media (`asset:<digest>:media:<mime>:url:<url>`).
  Loading renders the poster eagerly; a poster failure produces a `failed`
  preview state instead of rejecting, so the caption reports "3D model
  unavailable" while the source URL remains available for download. Like
  unavailable saved media, a failed poster is cached for its source key; a
  changed source key (new digest, MIME, or backend URL) retries naturally.
- Peek renditions validate GLB bytes by magic (`glTF`, version 2) and PLY
  bytes by magic (`ply` plus an LF or CRLF newline) before accepting them,
  mirroring the video/audio signature checks.
- `selectedPreviewAssetForRows` claims an ASSET row for 3D when a registered
  renderer maps its MIME to `model3d` and the MIME is in the `model/`
  family. The core registry registers `core.model3d-preview` as the
  `model/*` fallback renderer.

## Testing

jsdom has no WebGL: unit tests inject a fake poster renderer through the
`renderModel3dPoster` loader dependency rather than importing the real
viewer module. Real poster and orbit rendering run in Chromium through the
isolated `e2e/tests/model3d-preview-proof.spec.ts`
(`playwright.model3d-proof.config.ts`), which mocks every backend route and
serves a generated single-triangle GLB plus a generated four-gaussian
binary 3DGS PLY.
