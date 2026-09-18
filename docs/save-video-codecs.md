# Save Video codecs

Save Video version 2 encodes an image batch, with optional audio, to a writable save
target. The Format control uses the standard dynamic-combo editor. Selecting a
format shows only that codec's controls.

| Format | File | CRF | Bit depth |
| --- | --- | --- | --- |
| `mp4_h264` | MP4 / H.264 | 0 through 51, default 23 | 8 or 10, default 8 |
| `webm_vp9` | WebM / VP9 | 0 through 63, default 23 | 8 only; no control is shown |
| `webm_av1` | WebM / AV1 | 0 through 63, default 23 | 8 or 10, default 8 |

Changing Format preserves stored controls while they are hidden. The selected
format and values survive save and reopen. Workflows saved with the version-1
flat `format`, `crf`, and `bit_depth` values migrate to the dynamic format
branch on open; an obsolete VP9 bit-depth value is discarded.

Execution requires the selected PyAV encoder (`libx264`, `libvpx-vp9`, or
`libsvtav1`). Invalid formats, CRF values, bit depths, unsupported pixel
formats, and unavailable encoders fail the run without writing an output file.

## Save Video v3 migration contract fixture

The core regression in `packages/core/test/replacement.migration.test.ts`
decodes the exact [wire-38 saver export](../packages/core/fixtures/replacements/save-video-v3-wire38.json)
from [Dinkster PR 1333](https://github.com/Kosinkadink/Dinkster/pull/1333) at
[`4e0dbc25`](https://github.com/Kosinkadink/Dinkster/commit/4258cb557cb684f8723c4dc0cf022b4a65e48baa).
Its SHA256 is `c2b32898aa5b1ea2094310cf144212c45a14518dd3d31e7a13cb47bebd7d40f2`.
The helper schema is normalized from `AssembleVideo.define_schema` at that
same commit. The saver accepts `comfy.VIDEO`, target,
container/codec (default `auto`), optional integer CRF, metadata JSON text,
and an optional static legacy-format combo. It returns unchanged
`comfy.VIDEO` and a separate preview-marked `asset<comfy.VIDEO>` output.

The fixture moves images, FPS, audio and bit depth to a `dinkster.video.assemble`
helper with `color_space=sRGB`, connects its video to the saver, and retargets
historical asset consumers from `video` to `asset`. Nested cases detect stored
values or connections on either `format.crf` or `format.bit_depth`; otherwise
the flat case applies. Neither case predicates on the format choice. Target,
format and CRF copy to the saver; metadata takes its new `{}` default.
Presence checks describe stored document structure and allow linked controls;
value comparisons still reject runtime-driven historical selectors.

Copies read explicit `node.values` first, then `node.dynamic[input].selected`.
Tests preserve `webm_av1` without duplicate `values.format`, explicit-value
precedence, and precedence before a synthetic enum transform. Coverage includes
flat/dynamic controls, each nested predicate with values/links/nets, linked
selectors, helper defaults, asset rewires, archives, one-shot migration and
atomic undo/redo. These are planner/command tests of the published schema,
not proof of deployment, rendering or live v3 execution.

## Comfy SaveVideo alias import

`core/test/import-save-video-alias.test.ts` uses the corrected recursive
SaveVideo source schema and replacement from the unpublished backend registry
SHA256 `891efcaba32f6865ea323c6fc6fce285f8ecb1860000dec2ab2bcdef9965f184`.
This fixture is not the older published PR 1350 registry. The importer reads
active nested format/codec/encoding widgets before replacement mapping;
flattened field paths are not a positional widget order. CRF values and links
use `dinkster.float` followed by `dinkster.value.convert` with `target=int` and
`force_lossy=true`, not a stored value on the converter's widget-less input.

Tests cover nested and keyed selectors, historical flat controls, omitted CRF
defaults, VIDEO links, reload, and undo/redo. A keyed `codec.encoding.crf`
without its active re-encode selector stays in `importer.unknownWidgetValues`
with a warning; it is not silently applied. This is frontend fixture coverage,
not certification of the full backend workflow corpus or live execution.
