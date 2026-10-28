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

Run `python sources/build_brand.py` from this directory, then
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

## Palette

`tokens/` preserves the supplied sRGB identity and semantic theme values.
Identity coral and semantic danger are distinct tokens even where their
dark-theme values coincide. No light-mode cyan substitution is made.
