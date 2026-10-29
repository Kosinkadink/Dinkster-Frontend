# Lettering source

The scaffold is Outfit, version 1.100;gftools[0.9.27], instantiated at
weight 800 from the variable font. It is licensed under SIL Open Font
License 1.1; the complete license is in `fonts/OFL.txt`.

Source: https://github.com/google/fonts/tree/9862abc066c9b83bf84c3e8ed1fc2d8d48f9bbf0/ofl/outfit

`fonts/Outfit.ttf` SHA-256:
`fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade`.

`build_brand.py` retains original outlined glyphs in the construction layer.
The visible lettering is a proposed custom redrawing using the scaffold's
geometric sans construction and the reference's proportions, square i-dot,
diagonal terminals and open counters. The regular e is instead a direct
2x trace of the supplied wordmark reference, without optical corrections;
`reference-e.svg` retains the traced contour. `trace_reference_e.py`
records the threshold, connected-component isolation, uniform coordinate
mapping and Potrace command. Other letters remain custom redrawn contours.
This is not an approved font. The font binary is unchanged.
Production SVGs contain outlined paths only and require no installed font.
