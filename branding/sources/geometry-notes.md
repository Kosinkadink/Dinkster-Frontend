# Approved D geometry

`reference-d.svg` is the approved complete dark-on-light reference trace.
`build_d.py --export-master` copies its exact path into `dinkster-d.svg`;
the `02_Logo_Master_Mono` layer retains that data unchanged. The editable
`reference-trace-construction` object uses those same Bezier coordinates.
`TRACE_SOURCE` names the trace file relative to the geometry script.

The source is the lower D in the supplied 446x518 reference, resized to
892x1036 with Lanczos. The crop is (44,692)-(294,894), threshold red < 128,
with the two connected components traced by Potrace 1.16, unit=100.
Potrace coordinates map to native wordmark coordinates by
(0.005,0,0,-0.005,22,193), then to the 1000-unit master by the inverse of
translate(16.9,76.6) scale(0.139). No fit-to-bounds or optical correction
is applied. The exact master bounds map to a native bottom y188; the
regular baseline y178 is therefore 10 px above it.

The historical analytic construction remains hidden inside the construction
layer. Its constants also place the existing color planes and define the
paused heavier proposal, but no longer construct the approved silhouette.
The 16/24 master objects currently copy the unadjusted approved trace;
historical optical corrections must not silently replace its geometry.

## Historical analytic constants

`constructed-d.svg` retains the -30 percent reshaped counter with 62 percent
nose and partial r24 for reproducing earlier comparisons. All coordinates
in the following historical sections use its reference-pixel frame rather
than the active trace's 1000-unit frame.

| Constant | Value | Meaning |
| --- | --- | --- |
| REF | A-plus-two-variants.png | Reference image, selected left half only |
| TOP, BOTTOM | 68, 360 | Outer horizontal bounds |
| LEFT_TOP_X | 152 | Outer top-left vertex |
| TOP_RIGHT_X | 400 | Top edge / right chamfer intersection |
| RIGHT | 497 | Right vertical bound |
| CHAMFER_TL | 84 | Top-left line x - y = 84 |
| CHAMFER_TR | 334 | Top-right line x - y = 334 |
| CHAMFER_BR | 768 | Bottom-right line x + y = 768 |
| APERTURE_TOP | 157 | Flat top of interior aperture |
| BOWL_C | (338, 221) | Original reference counter's symmetry center |
| BOWL_R | 50 | Reference arc radius; reference hole's right extreme is 388 |
| BOWL_END_DEG | 45 | Rejected faceted bowl tangent angle |
| SQUIRCLE_N | 3.2 | Approved aperture superellipse exponent |
| ECHO_CHAMFER | 42 | Rejected echo-style aperture chamfer |
| REFERENCE_APERTURE_BOTTOM | 285 | Original flat bottom used for the area baseline |
| APERTURE_BOTTOM | 269 | Selected counter's flat bottom |
| COUNTER_AREA_RATIO | 0.70 | Selected sampled counter area / reference area |
| COUNTER_NOSE_FRACTION | 0.62 | Maximum-right sample's height down the counter |
| COUNTER_PROFILE_X | 324 | Horizontal anchor of the unscaled reshaped profile |
| COUNTER_BOTTOM_SHIFT | 16 | Rightward taper offset at the profile bottom |
| COUNTER_TOP_SCALE | 0.5 | Horizontal scale at profile top, increasing to 1 at bottom |
| BODY_TRIM_X | 232 | Construction boundary of the partial lower-corner circle |
| BODY_TRIM_RADIUS | 24 | Lower-corner radius, cut by the diagonal channel |
| CHANNEL_LOW | 583 | Lower arm's inner line x + y = 583 |
| STEM_TOP | 175 | Island's top; 18 below the aperture top |
| STEM_L, STEM_R | 232, 298 | Island stem bounds |
| STEM_DIAG | 557.5 | Island's right/bottom diagonal x + y = 557.5 |
| LEG_DIAG | 477.5 | Island leg's left diagonal x + y = 477.5 |
| K | sqrt(0.5) | 45-degree sine/cosine for legacy arc tangents |
| RADII | See below | Named single fillet radius per corner |

## Fillets

`RADII` values: top_left 0, top_right 28, right_top 45,
right_bottom 45, bottom_right 24, bottom_channel 0, aperture_bl 26,
aperture_br None, aperture_tr None, aperture_tl 26, hole_rt 20,
hole_rb 20, stem_tl 8, stem_tr 10, stem_bottom 10, leg_bottom 0,
leg_end 6, leg_stem 0.

Zero preserves a sharp corner. `None` consumes the complete tangent in the
rejected faceted variant, using `diag_fillet_radius()`. `hole_rt`,
`hole_rb`, `aperture_br` and `aperture_tr` are unused by the approved
superellipse, but remain documented so the source is fully interpretable.
The construction layer includes each active fillet's circle at its
computed center, the uncolored contour, named vertices, edge/chamfer
guides, the legacy bowl circle, and the sampled approved superellipse.
The circle is construction material, never a circular replacement hole.
The selected partial r24 has its own circle centered at (256,336);
neighboring fillets use its channel endpoint, not its center.

## Mapping and sampling

The local `LEFT` is LEG_DIAG - BOTTOM = 117.5. `ref_w` = 379.5 and
`ref_h` = 292. The uniform scale is 840 / max(ref_w, ref_h), centered in
the 1000x1000 frame; this gives 80 units of left/right margin.
`Transform` applies the scale and offsets; `to_svg` rounds coordinates to
one decimal place. The approved superellipse uses 97 samples from +90
to -90 degrees; fillets are SVG arcs. The construction contour's source
sampling and the unchanged master path remain distinct editable objects.

## Color planes

The base is the full cyan D. Coral and yellow are copies of its exact
path, each clipped by a hard-edged path in the same reference frame.
Coral follows an inset 45-degree top chamfer, vertical right plane and
lower chamfer. Its two central turns use the master's `right_top` and
`right_bottom` fillet radii (45 reference px). Yellow covers the region
left of STEM_L and below source y = 240. The selected lower-body corner
removes the old body's yellow baseline tip without changing that color
region. No gradient, blur, stroke expansion or second silhouette is
introduced. All planes share the selected master silhouette.

The export object applies the master silhouette as one outer clip to
solid color planes. This is coverage-equivalent to the editable clipped
path copies, but avoids repeatedly antialiasing the outer edge. Mono and
color therefore have identical alpha coverage, including antialiasing.

## Unselected lower-arm proposals

`compare_geometry.py` keeps the approved source and master unchanged and
renders two historical lower-arm trims beside the original shape, in mono and
color at 1024 px on both backgrounds. Both replace the body's corner at
`CHANNEL_LOW - BOTTOM = 223` with a vertical end at `STEM_L = 232`,
from y = 360 to `CHANNEL_LOW - STEM_L = 351`. The straight trim is sharp;
the rounded trim uses a 3 reference px radius at the baseline corner.
The island, aperture, diagonal channel and all other outer corners are
unchanged. The equal 18 px gaps along the channel are not shifted; the
local trim only removes material at its baseline end. Neither proposal
is selected or used in the production master or raster exports.
`geometry-export-commands.txt` records the Inkscape build and commands;
`previews/geometry-options/` retains each proposal SVG and PNG.

## Proposed small-size optical objects

The master also retains separate `symbol-small-16-*` and
`symbol-small-24-*` objects. These do not replace the approved path.
The proposal keeps the approved aperture, channel and fillets, but
expands the island toward the body so the small mark reads as one D with
a narrow cut. The original coordinate transform is retained. The one
size-specific gap sets both the upper vertical separation and the lower
diagonal's perpendicular separation.

| Source parameter | Approved | 16 px proposal | 24 px proposal |
| --- | --- | --- | --- |
| Gap in reference px | 18 | 4 | 8 |
| STEM_TOP | 175 | 161 | 165 |
| STEM_DIAG | 557.5 | 583 - 4 * sqrt(2) | 583 - 8 * sqrt(2) |
| APERTURE_TOP | 157 | 157 | 157 |
| APERTURE_BOTTOM | 285 | 285 | 285 |
| CHANNEL_LOW | 583 | 583 | 583 |
| aperture_bl radius | 26 | 26 | 26 |

All other source geometry is retained. The resulting straight cuts are
about 0.142 output px at 16 and 0.425 px at 24. This intentionally favors
a much less visible separation and a fuller island. The cuts are
subpixel antialiased coverage, not fully transparent pixel channels.

The CLI exports use these objects for 16/24 px mono, white, cyan and
three-plane color, all sharing the same alpha coverage. The full-size
mono SVG and 32 px and larger production PNGs retain the approved D and
full gap. `compare_geometry.py` also renders both unselected bottom-left
trims at 16-64 px with those same small-size cuts. `compare_small.py`
composes all three geometry columns on both backgrounds in mono, cyan
and color, plus an exact 4x nearest-neighbor enlargement. The trimmed
proof variants are not production selections.

## Counter and larger-corner proposals

`compare_geometry.py --counter-options` retains the approved geometry and
renders full D proposals at 1024 px. The reshaped counter reduces the
157..285 vertical range to 157..269. Its upper shoulder tapers into a
lower-biased rounded nose, rather than a symmetric squircle. It starts
from the n=3.2 sample points (x,y), with u=(y-157)/128, then maps them to
(324+16*u+(x-324)*(0.5+0.5*u), 157+112*u). This warp is the explicit
counter shape change; the unchanged reference still uses the unwarped
n=3.2 profile. The left corner radii remain 26; the bottom-left vertex
moves along the existing channel to (314,269). Island and channel lines,
their gaps and outer radii stay unchanged.

The sampled counter-area metric closes at the island's straight right
edge x=298, excluding the open channels. It includes the new bottom-left
fillet before measuring. A horizontal scale around x=298 is solved from
the area target, showing unchanged, -10, -20 and -30 percent area versus
the current counter. All four use the same vertical profile. Maintaining
the old area with less height requires a wider counter; the sheet shows
that explicitly, rather than silently discarding the same-area option.

At the horizontal flats, the current top stroke is 157-68 = 89 source
units and the bottom stroke is 360-285 = 75. The proposals keep top 89
and increase bottom to 360-269 = 91. The hole's maximum vertical span
between the central flats reduces from 128 to 112 units; the left
channel still follows its unchanged line. At common interior source x=338, the
counter upper shoulder changes the actual vertical clearances; the
checkpoint comment reports those measured per-option stroke thicknesses
as well as these flat-reference values.

The x=232 trim's corner uses a real radius-24 circle centered at
(256,336). The old vertical trim segment is only 9 units tall, so a full
quarter-circle cannot fit between it and the unchanged diagonal channel.
The proposal ends the circle at its exact intersection with x+y=583,
approximately (235.1369,347.8631). The arc is tangent to the baseline but
not to the channel; no self-overlapping vertical/arc segment is inserted.
The x=232 trim line is therefore a construction boundary rather than a
surviving straight segment. The partial arc is the historical construction;
the fully tangent alternative was not selected. The 62 percent nose at
-30 percent area is retained in `constructed-d.svg`. Historical option SVGs and
PNGs remain proof artifacts with matching mono/color alpha. Production
symbol exports remain paused and are not regenerated by wordmark-only
export.

## Lifted nose proofs

`compare_geometry.py --nose-options` uses the selected -30 percent
counter-area target and partial r24 corner without replacing the master.
The nose is defined as the maximum-right sample of the counter boundary,
not the center of the D or the counter's area centroid. Counter height is
measured from its upper flat y=157 to its lower flat y=269. The selected
profile's nose is at y=246.6321, or about 80.03 percent down that height.

The three nose heights are 70, 62 and 55 percent, at y=235.40, 226.44 and
218.60. Let v=(y-157)/112 and let c be the selected nose's height fraction.
The vertical warp is y'=157+112*v**p, with p=log(target)/log(c). This keeps
both flats fixed and lifts the tapered shoulder and nose continuously.
The horizontal profile scale is recalculated for each warp to retain the
same -30 percent sampled-area target, rather than accepting an area
change as a side effect of the nose lift. All noses remain below the
counter's vertical center y=213.

The original left radii, channel/island geometry, outer corners, partial
r24 and color planes are unchanged. Flat-reference strokes remain 89/91
source units. The sheet additionally measures top/bottom strokes on the
same x=338 pixel scan per option, using alpha below 128 for the counter
boundary. These measurements include raster threshold error and do not
claim uniform ring thickness. Native 64 px proofs use the same full-gap
geometry with no optical substitution. Sixteen Inkscape commands and the
renderer version are recorded in `nose-export-commands.txt`.
