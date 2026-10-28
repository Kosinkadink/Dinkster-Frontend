# Dinkster vector brand

The approved D is `sources/dinkster-d.svg`. Its path is copied unchanged
into `sources/Dinkster_Master.svg`. The wordmark lettering is a proposed
custom outline, not yet a user-approved production asset. Application
header and favicon assets are not changed here.

## Editing and export

`sources/build_brand.py` builds the layered Inkscape document from the D
and named letter contours. Outfit's original outlined scaffold is retained
on the hidden construction layer. Font source and licensing are documented
in `sources/font-license-and-sources.md`.

The authoring environment uses Python 3.12, fonttools 4.68.0, Pillow,
numpy, scipy and cairosvg. These are standalone artwork-authoring tools;
the frontend build and test dependencies are unchanged.

Run `python sources/build_brand.py --inkscape /path/to/inkscape` from this directory, then
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

`sources/compare_wordmark.py /path/to/wordmark-monochrome-reference.png`
composes the repeatable review sheet from the exported PNGs. The reference
stays an external input, not a production SVG raster dependency.

The regular-only guided comparison uses `export_brand.py
--regular-wordmark-only` to leave symbol rasters and heavier exports
untouched. These commands are recorded in `wordmark-export-commands.txt`.
Letter guides are at y = 0 (i-dot/t upper line), 14 (n/s/e/r tops and
k arm), and 56 (baseline); only the k's lower leg descends to 70.
The enlarged k also carries its x + y = 63 cut/arm continuation guide.
The regular e joins flat top/left segments with a 12-unit circular arc.
The blue line is the start of the k/t top slopes, not their highest
point; the i dot's top edge ends on that line and never rises above it.
The regular k beam ends in a triangle at (7,56), with its cut
meeting the lower leg at (18.5,44.5). The i dot/stem separation is reduced
by moving the stem top up four units. The e counter joins its flat top
and left with a tangent 2-unit arc.
Reference-image guides are measured raster estimates, not vector
constraints imposed on or alterations to the supplied image.

`compare_geometry.py --counter-options --inkscape /path/to/inkscape`
renders the full-size counter proposals without changing the approved
source or master. The comparison includes the current shape, the x=232
trim with a 24-unit corner arc, three smaller counters, and a tangent
24-unit corner alternative. `counter-export-commands.txt` records the
renderer and every CLI export. See `geometry-notes.md` for the corner's
channel-intersection constraint and the counter-area measurement.

For the small-size comparison, run `sources/compare_geometry.py --inkscape
/path/to/inkscape` with Python, then `python sources/compare_small.py`.
The native and nearest-neighbor sheets show mono, cyan and clipped color
on both backgrounds, with the current body and both unselected bottom-left
trims. Only 16/24 px use the narrower-cut optical objects; production
32 px and larger exports retain the approved full gap. The geometry notes
list the parameters; `geometry-export-commands.txt` records each CLI render.

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
Neither proposed weight is selected by this document. The enlarged
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
