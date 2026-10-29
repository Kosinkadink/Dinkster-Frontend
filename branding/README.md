# Dinkster vector brand

The approved D is `sources/dinkster-d.svg`. Its path is copied unchanged
into `sources/Dinkster_Master.svg`. `sources/build_d.py --export-master`
derives the silhouette from the selected dark-on-light trace in
`sources/reference-d.svg`, with a local upward rounding at the body's
bottom-left tip. The original traced input remains unchanged.
The analytic construction is historical, not the active silhouette.
The regular e is accepted. The master regular wordmark uses the selected
1.35x lettering with its baseline at the D bottom; the k leg descends below
the D. Application header and favicon assets are not changed here.

## Editing and export

`sources/build_brand.py` builds the layered Inkscape document from the D
and named letter contours. Outfit's original outlined scaffold is retained
on the hidden construction layer. Font source and licensing are documented
in `sources/font-license-and-sources.md`.

The authoring environment uses Python 3.12, fonttools 4.68.0, Pillow,
numpy, scipy and cairosvg. These are standalone artwork-authoring tools;
the frontend build and test dependencies are unchanged.

Run `python sources/build_d.py --export-master sources/dinkster-d.svg`
from this directory to regenerate the silhouette without reference-image
scratch renders. Then run `python sources/build_brand.py --inkscape /path/to/inkscape`, followed by
`python sources/export_brand.py --inkscape /path/to/inkscape`.
`sources/export-commands.txt` records the renderer build and exact commands.
The current renderer is Ubuntu's Inkscape 1.2.2
(`b0a8486541`, 2022-12-01), package `1.2.2-2ubuntu12`, extracted into the
lane without a system installation. Its extracted library directory is
passed as `LD_LIBRARY_PATH`, and `INKSCAPE_DATADIR` points to the extracted
`usr/share` directory.

The SVGs are exported directly from the master using Inkscape's object-ID
export. PNG wordmarks use a fixed reference-sized frame rather than
tight-cropping, to preserve comparison scale and alignment. All production
wordmark lettering is outlined; no font must be installed to render it.

`sources/compare_wordmark.py /path/to/wordmark-monochrome-reference.png
--native-width 500 --letter-scale 1.35 --baseline-shift 10 --dark-reference-only`
composes the repeatable review sheet from the exported PNGs. The reference
stays an external input, not a production SVG raster dependency.

The regular-only guided comparison uses `export_brand.py
--regular-wordmark-only` to leave symbol rasters and heavier exports
untouched. These commands are recorded in `wordmark-export-commands.txt`.
`--wordmarks-only` regenerates both wordmark weights without exporting
symbol SVGs, rasters or platform assets. The full command regenerates all
assets, including color wordmarks for both themes and platform containers.
Heavier lettering is historical and unselected; its contours and placements
remain frozen. The regular 1.35x wordmark is the production selection.
Separate 16/24 objects retain the selected path under editable vector cut
masks that open its upper and lower stem/bowl channels. Mask cuts are
documented in `sources/geometry-notes.md`; only these small objects use them.
The 16 px color object omits yellow because it cannot retain a fully
covered yellow pixel. The 24 px object keeps yellow; coral is retained at
both sizes. Mono, cyan and color use the same alpha mask.
`export_brand.py --small-icons-only --inkscape /path/to/inkscape` regenerates
only these PNGs and the ICO/ICNS containers, leaving all other exports
byte-identical. Commands are recorded in `small-export-commands.txt`.
`compare_small_optical.py` checks component counts and trapped transparent
pixels, then renders the exact-source/optical native and 12x comparison
on both themes. Exact-source frames are preserved in
`previews/small-exact-source/`; the new optical comparison and JSON report
are separate from the historical exact-source sheets.
Letter guides are at y = 0 (i-dot/t upper line), 14 (n/s/e/r tops and
k arm), and 56 (baseline); only the k's lower leg descends to 70.
The enlarged k also carries its x + y = 63 cut/arm continuation guide.
The regular e is traced directly from the supplied reference at 2x.
The blue line is the start of the k/t top slopes, not their highest
point; the i dot's top edge ends on that line and never rises above it.
The regular k beam ends in a triangle at (7,56), with its cut
meeting the lower leg at approximately (20.1005,42.8995). Both diagonal
strokes have the bar's 14-unit perpendicular thickness, not a 14-unit
horizontal span. The i's opposing faces have slope -0.7 and retain the
accepted 4/sqrt(1+(8/19)^2) perpendicular clearance (about 3.687 units).
Its dot extends 2 units beyond the 15-unit stem on the right. The t's
lower-right face runs from (23,44) to (29,56).
The i bottom slice runs from (15,47) to (6,56), moving its 45-degree line
2 units left without changing the dot, accepted top gap or any other letter.

`sources/compare_wordmark_sizes.py /path/to/wordmark-monochrome-reference.png
--inkscape /path/to/inkscape` renders the color junction and four size proofs.
The control retains the existing regular-letter baseline at native y178.
The larger variants uniformly scale the regular contours by 1.25 and 1.35
about (145.75,178), preserving aspect ratio, relative stroke weight
and tracking proportions; there is no added stroke or heavier contour.
Each scale is shown at the current baseline y178 and with the yellow
regular-letter baseline aligned to the D's y188 bottom. The latter moves
letters down 10 native px (20 px at 2x), leaving the k leg below the D.
The ink-bottom alignment is not a supported variant. The D never scales
or moves across variants.
The comparison frame adds 54 native pixels of right padding, not a scale
change, so the 1.35 lettering is not clipped. The 1.35/y188 transform is
also applied to all three regular master wordmarks and SVG exports.
Other size transforms remain historical preview options.
`size-export-commands.txt` records the Inkscape build and each export.
The yellow cut is vertical at master x331.6546762589928.
The yellow starts at y395, above the lower-left accent
but below the top body, so its hidden horizontal boundary cannot create
a visible step. The body tip is locally rounded above the yellow plane;
no yellow falls on the body, and the negative-space channel stays open.
Coral uses the selected thinner upper boundary from (323,28) through
(444,149), with its radius-45 turn, then continues vertically at x444
past the D bottom. The historical construction transform maps the band;
the D exterior is the same shared clip. No lower diagonal or lower
inner rounding is inserted. The upper no-divot geometry is unchanged.

`sources/compare_coral.py /path/to/wordmark-monochrome-reference.png
--inkscape /path/to/inkscape` compares the previous thinner band with the
selected vertical-bottom version. At native y145 near the counter nose,
both are about 41/59 coral/teal by raster width. The comparison shows
native, 2x and 12x top/bottom details on both backgrounds, followed by
color wordmark sheets at the selected 1.35x/y188 placement.
`coral-export-commands.txt` records every Inkscape export. Earlier
comparison files are historical, not additional production selections.

## Product integration inventory

- Editable source: `sources/Dinkster_Master.svg`; immutable selected trace
  in `sources/reference-d.svg` and derived mono silhouette in `sources/dinkster-d.svg`.
- Header/website: `svg/dinkster-wordmark-color-dark.svg` and
  `svg/dinkster-wordmark-color-light.svg`; mono lettering/mark alternatives
  are `dinkster-wordmark-dark.svg`, `-light.svg` and `-mono.svg`.
- D-only: `svg/dinkster-symbol-color.svg`, `-cyan.svg`, `-mono.svg`, `-white.svg`.
  Color has the same silhouette as mono, with no effect required for recognition.
- Raster: 16, 24, 32, 48, 64, 128, 256, 512 and 1024 px in `raster/color/`,
  `cyan/`, `mono/`, `white/`, `dark/` (white) and `light/` (ink).
  The 16/24 exports use separate optical objects; 32 px and larger retain
  the unchanged selected master silhouette.
- Windows/favicon container: `platform/dinkster.ico`, with 16, 24, 32, 48,
  64, 128 and 256 px color PNG entries. Apple: `platform/dinkster.icns`,
  16 through 1024 px including 2x representations. `sources/package_icons.py`
  embeds the CLI PNG bytes unchanged; `platform-export-command.txt` records the command.
- Palette: `tokens/dinkster-colors.json` and `tokens/dinkster-theme.css`.
  Identity names are `brand.cyan` = `#32E6C5`, `brand.coral` = `#FF7468`,
  `brand.yellow` = `#FFD86B`, `brand.offWhite` = `#F2F4F5`, `brand.ink` = `#1F242A`.
  Theme groups cover backgrounds, border, primary/secondary/muted text,
  primary action and success/info/warning/danger; values are preserved in
  both token files. Semantic danger is not a brand-plane alias.

Product integration belongs to separate frontend/Desktop changes using a
landed asset commit. No header, favicon, application icon, palette runtime
or package dependency is changed by this asset branch.

`sources/trace_reference_e.py /path/to/wordmark-monochrome-reference.png
--potrace /path/to/potrace` rebuilds the regular e from the light-on-dark
reference at 2x, using threshold 128 and Potrace 1.16 (Ubuntu package
1.16-2build1). It retains the source bitmap in `reference-e-2x.pbm`, the
mapped contour in `reference-e.svg`, and the CLI in `e-trace-command.txt`.
The x-height band y134..178 maps uniformly to y14..56; there is no
independent width correction or optical adjustment. The overlay proof
`previews/e-reference-overlay.png` shows thin/bold outlines over the
reference and filled threshold differences at the original registration.
The thresholded trace overlaps 99.04 percent by intersection-over-union,
not exact raster identity. Regular letter placements are explicit:
the traced e retains the 3-unit clearance from t; every other regular
letter retains its established placement except r, shifted 2 units right
to increase the sampled e-to-r clearance from about 1.5 to 3.5 units.
The complete regular-letter group sits 2 units closer to the D, preserving
that e/r opening and all other inter-letter spacing rather than moving i alone.
Heavier contours and placements remain unchanged.
Reference-image guides are measured raster estimates, not vector
constraints imposed on or alterations to the supplied image.

`compare_geometry.py --counter-options --inkscape /path/to/inkscape`
renders the full-size counter proposals without changing the approved
source or master. The comparison includes the current shape and a
vertically shallower, bottom-biased rounded counter at unchanged, -10,
-20 and -30 percent area, each with the partial radius-24 x=232 corner.
`counter-export-commands.txt` records the
renderer and every CLI export. See `geometry-notes.md` for the corner's
channel-intersection constraint and the counter-area measurement.

`compare_geometry.py --nose-options --inkscape /path/to/inkscape` keeps
the selected -30 percent area and partial r24 corner, comparing its
current nose with heights 70, 62 and 55 percent down the counter. It
exports 1024 and 64 px proofs, not production raster assets. The single
`previews/nose-height-options.png` sheet includes both backgrounds and
mono/color at both sizes, plus per-option nose and stroke measurements.
`nose-export-commands.txt` records the renderer and sixteen CLI exports.
These historical option sheets do not change the master or constants.
The 62 percent option is historical, retained in `constructed-d.svg` for
reproducing the counter-only comparison rather than as the active master.

`sources/trace_reference_d.py /path/to/wordmark-monochrome-reference.png
--potrace /path/to/potrace --inkscape /path/to/inkscape` generates review-only
D candidates under `previews/`. Only the dark-on-light reference D is
sampled, at 2x and threshold red < 128. Candidate A is the complete trace,
registered to the native reference with no optical corrections. Candidate
B retains the historical constructed exterior SVG arcs and edges, replacing the inner
body and inward island faces with the traced segments. Straight joins at
the splice boundaries remain visible; no fitting or smoothing conceals
them. The island's exterior leg edge and baseline remain approved geometry.
The script does not rewrite the source D, layered master, letter paths/placements,
heavier artwork or production exports. The full-trace IoU overlay and both
regular comparison sheets use only the dark-on-light D; its upper
comparison appearance is an explicitly labeled inversion of that source,
not the different light-on-dark drawing. Potrace/Inkscape versions and
commands are recorded in `previews/reference-d-options/commands.txt`.

After the full CLI export, `python sources/compare_small.py` composes the
native 16-64 px sheet and nearest-neighbor enlargement directly from the
current mono, cyan and color PNGs on both backgrounds. It does not repair
or resample the source exports. `compare_geometry.py` and its option files
retain the historical analytic small-size proposals, not active revisions.

The weight comparison retains the revised current-weight outlines and a
heavier proposal with main stems at 20.31 reference units, matching the
D island stem after its wordmark transform. The heavier proposal uses
editable mitered outline expansion. Its gap parameter is 18 D-reference
px, converted to 5.538 lettering units. Letter spacing uses the minimum
horizontal clearance between occupied scanlines, including D/i, rather
than whole-glyph boxes that over-space the k's descending leg. The layout
is sampled at eight pixels per lettering unit with CairoSVG; production
exports still use Inkscape. The current weight uses a uniform 3-unit gap.
The i's parallel dot/stem clearance, n's straight counter, t's hook
clearance and e's counter height derive from the heavier gap.
Curved caps and triangular
counters taper rather than retaining a constant width everywhere.
The e counter is clipped open, and the t's inside hook retains its curve.
The heavier k's beam is clipped at the n's baseline without shortening
its descending leg. `sources/layout-command.txt` records the final
Inkscape bounds query that checks the generated document.
The heavier comparison frame is wider, not scaled down: both weights
retain the same D scale and the reference-size/2x row layout.
The heavier weight remains unselected. The enlarged
letters are exported from the same master, not a separate SVG source.

## Palette

`tokens/` preserves the supplied sRGB identity and semantic theme values.
Identity coral and semantic danger are distinct tokens even where their
dark-theme values coincide. No light-mode cyan substitution is made.

Run `python sources/check_tokens.py` to compare every JSON/CSS value and
recompute WCAG 2 sRGB relative-luminance contrast ratios:

| Theme | Text | Canvas | Surface | Raised |
| --- | --- | --- | --- | --- |
| dark | primary | 16.87:1 | 14.99:1 | 12.73:1 |
| dark | secondary | 8.76:1 | 7.78:1 | 6.61:1 |
| dark | muted | 5.10:1 | 4.53:1 | 3.85:1 |
| light | primary | 14.54:1 | 15.45:1 | 13.41:1 |
| light | secondary | 5.78:1 | 6.14:1 | 5.33:1 |
| light | muted | 4.54:1 | 4.82:1 | 4.19:1 |

Primary and secondary body text meet 4.5:1 on all three backgrounds in
both themes. Exceptions: muted text on dark raised (3.85:1) and light
raised (4.19:1) does not meet 4.5:1 for normal body text. Do not use these
pairings for normal-size body text; use secondary text instead. Palette
values are preserved, not silently retuned. These ratios do not certify
components, focus rings or status-only communication.
