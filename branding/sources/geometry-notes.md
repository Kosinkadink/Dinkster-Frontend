# Approved D geometry

`build_d.py` is the unchanged geometry source from the approved wrapper
reference. `dinkster-d.svg` is the unchanged approved silhouette. The
`02_Logo_Master_Mono` layer retains that path's exact data. Rendering and
clipping copies never replace it. All source coordinates below are in the
reference image's pixel frame, not the 1000-unit SVG frame.

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
| BOWL_C | (338, 221) | Aperture symmetry center; legacy bowl center |
| BOWL_R | 50 | Legacy arc radius; fixes hole's right extreme at 388 |
| BOWL_END_DEG | 45 | Rejected faceted bowl tangent angle |
| SQUIRCLE_N | 3.2 | Approved aperture superellipse exponent |
| ECHO_CHAMFER | 42 | Rejected echo-style aperture chamfer |
| APERTURE_BOTTOM | 285 | Flat bottom, symmetric about y = 221 |
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
path, each clipped by a hard polygon in the same reference frame.
Coral follows an inset 45-degree top chamfer, vertical right plane and
lower chamfer. Yellow is restricted to the lower-left leg, left of
STEM_L and below source y = 240. No gradient, blur, stroke expansion or
second silhouette is introduced. Plane placement is a visual proposal
for checkpoint 2, not a modification of the approved D.

The export object applies the master silhouette as one outer clip to
solid color planes. This is coverage-equivalent to the editable clipped
path copies, but avoids repeatedly antialiasing the outer edge. Mono and
color therefore have identical alpha coverage, including antialiasing.
