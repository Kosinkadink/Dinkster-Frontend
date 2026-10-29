"""Build editable brand geometry. Rendering is performed by export_brand.py."""

import argparse
from copy import deepcopy
import io
import math
from pathlib import Path
import shlex
import subprocess
import xml.etree.ElementTree as ET

import build_d as geometry
import cairosvg
import numpy as np
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SVG = "http://www.w3.org/2000/svg"
INK = "http://www.inkscape.org/namespaces/inkscape"
SOD = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
ET.register_namespace("", SVG)
ET.register_namespace("inkscape", INK)
ET.register_namespace("sodipodi", SOD)

# The outlined Outfit scaffold is retained for editing. These proposed contours
# replace its rounded terminals with the reference's diagonal construction.
# Coordinates use the reference lettering's 56-unit ascender-to-baseline frame.
K_DIAGONAL_SPAN = 14 * math.sqrt(2)
K_ARM_TOP = 63 - K_DIAGONAL_SPAN
K_LEG_INNER = 3 + K_DIAGONAL_SPAN
K_JOIN_X = (63 - K_LEG_INNER) / 2
LETTERS = {
    "i": f"M2 0H19V8L0 16V2Z M0 20L15 {20 - 15 * 8 / 19}V49L8 56H0Z",
    "n": "M0 56V25L12 14H30L42 25V56H28V33Q28 26 21 26Q14 26 14 33V56Z",
    "k": f"M7 0L15.9 -8.9A3 3 0 0 1 21 -6.8V{K_ARM_TOP - 21}L{K_ARM_TOP - 14} 14H49L30 33L67 70H{70 - K_LEG_INNER}L{K_JOIN_X} {63 - K_JOIN_X}L7 56Z",
    "s": "M36 14L30 26H15L32 37Q39 42 35 49Q32 56 23 56H12L0 44H22L5 33Q-2 28 2 21Q6 14 15 14Z",
    "t": "M0 0L14 -11V14H30L24 27H14V39Q14 44 20 44H23L29 56H12L0 44Z",
    "e": "M40 25L16 43H38L31 56H18Q0 56 0 38V26A12 12 0 0 1 12 14H25Q34 14 40 25Z M14 34V28A2 2 0 0 1 16 26H25Z",
    "r": "M0 56V29L17 14H33L21 27H17L14 30V49L7 56Z",
}
POSITIONS = {"i": 149, "n": 167, "k": 212, "s": 263, "t": 302, "e": 331, "r": 374}
HEAVIER_POSITIONS = {
    "i": 149,
    "n": 172,
    "k": 221,
    "s": 276,
    "t": 320,
    "e": 357,
    "r": 403,
}
D_REFERENCE_SCALE = (
    840 / (geometry.RIGHT - (geometry.LEG_DIAG - geometry.BOTTOM)) * 0.139
)
D_STEM_WIDTH = (geometry.STEM_R - geometry.STEM_L) * D_REFERENCE_SCALE
HEAVIER_GAP = (geometry.STEM_TOP - geometry.APERTURE_TOP) * D_REFERENCE_SCALE
HEAVIER_STROKE = D_STEM_WIDTH - 14
N_COUNTER = HEAVIER_GAP + HEAVIER_STROKE
N_RIGHT = 28 + N_COUNTER
I_TOP = 16 + (HEAVIER_GAP + D_STEM_WIDTH - 15) * math.hypot(1, 8 / 15)
E_COUNTER = f"M14 34V{34 - HEAVIER_GAP}H{14 + HEAVIER_GAP * 11 / 8}Z"
HEAVIER_LETTERS = {
    **LETTERS,
    "i": f"M0 0H17V6.933333L-2 17.066667V2Z M0 {I_TOP}L15 {I_TOP - 8}V49L8 56H0Z",
    "n": f"M0 56V25L12 13H{N_RIGHT - 12}L{N_RIGHT} 25V56H{14 + N_COUNTER}V33Q{14 + N_COUNTER} 26 {14 + N_COUNTER / 2} 26Q14 26 14 33V56Z",
    "k": "M0 6L8.9 -2.9A3 3 0 0 1 14 -0.8V22L29 7H49L23 33L65 70H44L16 40L0 56Z",
    "t": f"M0 5L14 -6V14H30L24 27H14V31Q14 {27 + N_COUNTER} 20 {27 + N_COUNTER}H29V56H12L0 44Z",
    "e": f"M40 25L16 43H38L31 56H18Q0 56 0 38V14H25Q34 14 40 25Z {E_COUNTER}",
}


def node(tag, attrs=None, parent=None):
    element = ET.Element(f"{{{SVG}}}{tag}", attrs or {})
    if parent is not None:
        parent.append(element)
    return element


def layer(parent, label, visible=False):
    return node(
        "g",
        {
            "id": label,
            f"{{{INK}}}groupmode": "layer",
            f"{{{INK}}}label": label,
            "style": "display:inline" if visible else "display:none",
        },
        parent,
    )


def write(path, element):
    ET.indent(element)
    ET.ElementTree(element).write(path, encoding="unicode", xml_declaration=True)


def lettering(
    parent, fill="currentColor", transform=None, prefix="letter", heavier=False
):
    group = node(
        "g", {"fill": fill, **({"transform": transform} if transform else {})}, parent
    )
    for letter, contour in (HEAVIER_LETTERS if heavier else LETTERS).items():
        positions = HEAVIER_POSITIONS if heavier else POSITIONS
        path = node(
            "path",
            {
                "id": f"{prefix}-{letter}",
                "d": contour,
                "transform": f"translate({positions[letter]} 122)",
                "fill-rule": "evenodd",
            },
            group,
        )
        if heavier:
            path.set("stroke", fill)
            path.set("stroke-width", str(D_STEM_WIDTH - (15 if letter == "i" else 14)))
            path.set("stroke-linejoin", "miter")
            if letter == "e":
                path.set("clip-path", "url(#e-open-counter)")
            elif letter == "k":
                path.set("clip-path", "url(#k-beam-baseline)")
    return group


def construction_geometry(parent):
    scale = 840 / (geometry.RIGHT - (geometry.LEG_DIAG - geometry.BOTTOM))
    dx = 80 - (geometry.LEG_DIAG - geometry.BOTTOM) * scale
    dy = (1000 - (geometry.BOTTOM - geometry.TOP) * scale) / 2 - geometry.TOP * scale
    group = node(
        "g",
        {
            "id": "d-named-construction",
            "transform": f"translate({dx} {dy}) scale({scale})",
            "fill": "none",
            "stroke": "#FF7468",
            "stroke-width": "0.5",
        },
        parent,
    )
    for contour in (geometry.outline(), geometry.stem()):
        commands, _ = geometry.build(contour, geometry.RADII)
        path = geometry.to_svg([commands], geometry.Transform(1, 0, 0))
        node("path", {"d": path}, group)
        vertices = [v for v in contour if v[0] not in ("arc", "poly")]
        for name, x, y in vertices:
            node(
                "circle",
                {"id": f"vertex-{name}", "cx": str(x), "cy": str(y), "r": "1"},
                group,
            )
        for index, vertex in enumerate(contour):
            if vertex[0] in ("arc", "poly"):
                continue
            name, x, y = vertex
            radius = geometry.RADII[name]
            if not radius:
                continue
            previous, following = (
                contour[index - 1],
                contour[(index + 1) % len(contour)],
            )
            p = previous[1][-1] if previous[0] == "poly" else previous[1:3]
            q = following[1][0] if following[0] == "poly" else following[1:3]
            a, b = (x - p[0], y - p[1]), (q[0] - x, q[1] - y)
            la, lb = math.hypot(*a), math.hypot(*b)
            a, b = (a[0] / la, a[1] / la), (b[0] / lb, b[1] / lb)
            cross = a[0] * b[1] - a[1] * b[0]
            turn = math.atan2(abs(cross), a[0] * b[0] + a[1] * b[1])
            t = radius * math.tan(turn / 2)
            nx, ny = (-a[1], a[0]) if cross > 0 else (a[1], -a[0])
            cx, cy = x - a[0] * t + nx * radius, y - a[1] * t + ny * radius
            node(
                "circle",
                {
                    "id": f"fillet-{name}",
                    "cx": str(cx),
                    "cy": str(cy),
                    "r": str(radius),
                },
                group,
            )
    lines = {
        "TOP": (80, geometry.TOP, 520, geometry.TOP),
        "BOTTOM": (80, geometry.BOTTOM, 520, geometry.BOTTOM),
        "RIGHT": (geometry.RIGHT, 40, geometry.RIGHT, 390),
        "APERTURE_TOP": (220, geometry.APERTURE_TOP, 410, geometry.APERTURE_TOP),
        "APERTURE_BOTTOM": (
            220,
            geometry.APERTURE_BOTTOM,
            410,
            geometry.APERTURE_BOTTOM,
        ),
        "STEM_TOP": (210, geometry.STEM_TOP, 320, geometry.STEM_TOP),
        "STEM_L": (geometry.STEM_L, 160, geometry.STEM_L, 380),
        "STEM_R": (geometry.STEM_R, 160, geometry.STEM_R, 380),
    }
    for name, (x1, y1, x2, y2) in lines.items():
        node(
            "line",
            {
                "id": f"guide-{name}",
                "x1": str(x1),
                "y1": str(y1),
                "x2": str(x2),
                "y2": str(y2),
            },
            group,
        )
    for name in ("CHAMFER_TL", "CHAMFER_TR"):
        c = getattr(geometry, name)
        node("path", {"id": f"guide-{name}", "d": f"M{40 + c} 40L{390 + c} 390"}, group)
    for name in ("CHAMFER_BR", "CHANNEL_LOW", "STEM_DIAG", "LEG_DIAG"):
        c = getattr(geometry, name)
        node("path", {"id": f"guide-{name}", "d": f"M{c - 40} 40L{c - 390} 390"}, group)
    node(
        "circle",
        {
            "id": "BOWL_R-construction",
            "cx": str(geometry.BOWL_C[0]),
            "cy": str(geometry.BOWL_C[1]),
            "r": str(geometry.BOWL_R),
        },
        group,
    )
    return f"translate({dx} {dy}) scale({scale})"


def symbol_path(size=None, trim_radius=None):
    gap = {16: 4, 24: 8}.get(size)
    adjustments = (
        {
            "STEM_TOP": geometry.APERTURE_TOP + gap,
            "STEM_DIAG": geometry.CHANNEL_LOW - gap * math.sqrt(2),
        }
        if gap is not None
        else {}
    )
    scale = 840 / (geometry.RIGHT - (geometry.LEG_DIAG - geometry.BOTTOM))
    transform = geometry.Transform(
        scale,
        80 - (geometry.LEG_DIAG - geometry.BOTTOM) * scale,
        (1000 - (geometry.BOTTOM - geometry.TOP) * scale) / 2 - geometry.TOP * scale,
    )
    original = {name: getattr(geometry, name) for name in adjustments}
    try:
        for name, value in adjustments.items():
            setattr(geometry, name, value)
        contour = geometry.outline()
        if trim_radius is not None:
            index = next(
                i for i, vertex in enumerate(contour) if vertex[0] == "bottom_channel"
            )
            contour[index : index + 1] = [
                ("bottom_trim", geometry.STEM_L, geometry.BOTTOM),
                (
                    "trim_channel",
                    geometry.STEM_L,
                    geometry.CHANNEL_LOW - geometry.STEM_L,
                ),
            ]
        radii = {**geometry.RADII, "bottom_trim": trim_radius or 0}
        return geometry.to_svg(
            [
                geometry.build(contour, radii)[0],
                geometry.build(geometry.stem(), geometry.RADII)[0],
            ],
            transform,
        )
    finally:
        for name, value in original.items():
            setattr(geometry, name, value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", required=True)
    args = parser.parse_args()
    approved = ET.parse(ROOT / "sources/dinkster-d.svg").getroot()[0]
    master = node(
        "svg", {"viewBox": "0 0 1700 8000", "width": "1700", "height": "8000"}
    )
    reference = layer(master, "00_Reference")
    reference.set(f"{{{SOD}}}insensitive", "true")
    node(
        "desc", parent=reference
    ).text = "Approved D source: dinkster-d.svg. Wordmark direction: wrapper notes/reference/branding/wordmark-monochrome-reference.png."
    construction = layer(master, "01_Construction")
    reference_transform = construction_geometry(construction)
    scaffold = node(
        "g",
        {"id": "outfit-scaffold", "transform": "translate(120 800) scale(.12 -.12)"},
        construction,
    )
    font = instantiateVariableFont(
        TTFont(ROOT / "sources/fonts/Outfit.ttf"), {"wght": 800}
    )
    glyphs = font.getGlyphSet()
    x = 0
    for letter in "inkster":
        glyph = glyphs[font.getBestCmap()[ord(letter)]]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        node(
            "path",
            {
                "id": f"scaffold-{letter}",
                "d": pen.getCommands(),
                "transform": f"translate({x} 0)",
            },
            scaffold,
        )
        x += glyph.width
    mono = layer(master, "02_Logo_Master_Mono")
    mono.append(deepcopy(approved))
    defs = node("defs", parent=master)
    e_clip = node(
        "clipPath", {"id": "e-open-counter", "clipPathUnits": "userSpaceOnUse"}, defs
    )
    node(
        "path",
        {
            "d": f"M-20 -20H100V100H-20Z {E_COUNTER}",
            "clip-rule": "evenodd",
        },
        e_clip,
    )
    k_clip = node(
        "clipPath", {"id": "k-beam-baseline", "clipPathUnits": "userSpaceOnUse"}, defs
    )
    node("path", {"d": f"M-20 -20H100V100H14V{56 + HEAVIER_STROKE / 2}H-20Z"}, k_clip)
    silhouette_clip = node(
        "clipPath",
        {"id": "approved-silhouette", "clipPathUnits": "userSpaceOnUse"},
        defs,
    )
    outline_copy = deepcopy(approved)
    outline_copy.set("id", "silhouette-clip-path")
    silhouette_clip.append(outline_copy)
    coral_boundary = [
        ("start", 343, 68),
        ("right_top", 424, 149),
        ("right_bottom", 424, 299),
        ("end", 363, 360),
        ("outside_bottom", 600, 360),
        ("outside_top", 600, 40),
        ("outside_left", 343, 40),
    ]
    coral_commands, _ = geometry.build(
        coral_boundary,
        {name: geometry.RADII[name] for name in ("right_top", "right_bottom")},
    )
    for name, contour in (
        ("coral", geometry.to_svg([coral_commands], geometry.Transform(1, 0, 0))),
        ("yellow", "M80 240H232V390H80Z"),
    ):
        clip = node(
            "clipPath", {"id": f"plane-{name}", "clipPathUnits": "userSpaceOnUse"}, defs
        )
        node("path", {"d": contour, "transform": reference_transform}, clip)
    for label, color, name in (
        ("03_Chromatic_Cyan", "#32E6C5", "cyan"),
        ("04_Chromatic_Coral", "#FF7468", "coral"),
        ("05_Chromatic_Yellow", "#FFD86B", "yellow"),
    ):
        plane = layer(master, label)
        copy = deepcopy(approved)
        copy.set("id", f"master-plane-{name}")
        copy.set("fill", color)
        if name != "cyan":
            copy.set("clip-path", f"url(#plane-{name})")
        plane.append(copy)
    letters = layer(master, "06_Wordmark_inkster")
    lettering(letters, "#1F242A", "translate(-300 -640) scale(4)", "editable")
    artboards = layer(master, "07_Exports_Artboards", True)
    for name, fill in (("mono", "#1F242A"), ("cyan", "#32E6C5"), ("white", "#F2F4F5")):
        symbol = node(
            "g", {"id": f"symbol-{name}", "transform": "translate(0 3000)"}, artboards
        )
        node("rect", {"width": "1000", "height": "1000", "opacity": "0"}, symbol)
        copy = deepcopy(approved)
        copy.set("id", f"export-{name}-d")
        copy.set("fill", fill)
        symbol.append(copy)
        for size in (16, 24):
            optical = node(
                "g",
                {"id": f"symbol-small-{size}-{name}", "transform": "translate(0 3000)"},
                artboards,
            )
            node("rect", {"width": "1000", "height": "1000", "opacity": "0"}, optical)
            node(
                "path",
                {"id": f"optical-{size}-{name}", "d": symbol_path(size), "fill": fill},
                optical,
            )
    for size in (None, 16, 24):
        clip_id = "approved-silhouette"
        if size is not None:
            clip_id = f"optical-silhouette-{size}"
            clip = node(
                "clipPath", {"id": clip_id, "clipPathUnits": "userSpaceOnUse"}, defs
            )
            node("path", {"d": symbol_path(size)}, clip)
        color_symbol = node(
            "g",
            {
                "id": "symbol-color" if size is None else f"symbol-small-{size}-color",
                "transform": "translate(0 3000)",
            },
            artboards,
        )
        node("rect", {"width": "1000", "height": "1000", "opacity": "0"}, color_symbol)
        clipped = node("g", {"clip-path": f"url(#{clip_id})"}, color_symbol)
        node("rect", {"width": "1000", "height": "1000", "fill": "#32E6C5"}, clipped)
        for name, fill in (("coral", "#FF7468"), ("yellow", "#FFD86B")):
            node(
                "rect",
                {
                    "width": "1000",
                    "height": "1000",
                    "fill": fill,
                    "clip-path": f"url(#plane-{name})",
                },
                clipped,
            )
    # A uniform transform preserves the approved D while matching the reference
    # symbol height and its optical overshoot below the letters' baseline.
    for index, (variant, color) in enumerate(
        (
            ("mono", "#1F242A"),
            ("dark", "#F2F4F5"),
            ("light", "#1F242A"),
            ("heavier-dark", "#F2F4F5"),
            ("heavier-light", "#1F242A"),
        )
    ):
        wordmark = node(
            "g",
            {
                "id": f"wordmark-{variant}",
                "transform": f"translate(-60 {(index if index < 3 else index + 1) * 1000 - 250}) scale(3.4)",
                "color": color,
            },
            artboards,
        )
        symbol = node("g", {"transform": "translate(16.9 76.6) scale(.139)"}, wordmark)
        d = deepcopy(approved)
        d.set("id", f"wordmark-{variant}-d")
        d.set("fill", "currentColor")
        symbol.append(d)
        lettering(wordmark, prefix=variant, heavier=variant.startswith("heavier"))
    sheet = node(
        "g", {"id": "letter-sheet", "transform": "translate(0 7000)"}, artboards
    )
    node("rect", {"width": "560", "height": "260", "opacity": "0"}, sheet)
    for row, heavier in enumerate((False, True)):
        for index, (letter, contour) in enumerate(
            (HEAVIER_LETTERS if heavier else LETTERS).items()
        ):
            path = node(
                "path",
                {
                    "d": contour,
                    "fill": "#1F242A",
                    "fill-rule": "evenodd",
                    "transform": f"translate({index * 80 + 8} {row * 130 + 20})",
                },
                sheet,
            )
            if heavier:
                path.set("stroke", "#1F242A")
                path.set(
                    "stroke-width", str(D_STEM_WIDTH - (15 if letter == "i" else 14))
                )
                path.set("stroke-linejoin", "miter")
                if letter == "e":
                    path.set("clip-path", "url(#e-open-counter)")
                elif letter == "k":
                    path.set("clip-path", "url(#k-beam-baseline)")

    def ink_profile(element):
        svg = node("svg", {"viewBox": "-10 0 180 200", "color": "#000000"})
        svg.append(deepcopy(defs))
        svg.append(deepcopy(element))
        raster = cairosvg.svg2png(
            bytestring=ET.tostring(svg), output_width=1440, output_height=1600
        )
        mask = np.asarray(Image.open(io.BytesIO(raster)))[:, :, 3] >= 128
        rows = mask.any(axis=1)
        left = np.argmax(mask, axis=1) / 8 - 10
        right = (mask.shape[1] - np.argmax(mask[:, ::-1], axis=1)) / 8 - 10
        return rows, left, right

    for variant in ("mono", "dark", "light", "heavier-dark", "heavier-light"):
        heavier = variant.startswith("heavier")
        gap = HEAVIER_GAP if heavier else 3.0
        d = next(e for e in master.iter() if e.get("id") == f"wordmark-{variant}-d")
        symbol = node("g", {"transform": "translate(16.9 76.6) scale(.139)"})
        symbol.append(deepcopy(d))
        previous_rows, _, previous_right = ink_profile(symbol)
        for letter in LETTERS:
            element = next(
                e for e in master.iter() if e.get("id") == f"{variant}-{letter}"
            )
            element.set("transform", "translate(0 122)")
            rows, left, right = ink_profile(element)
            shared = rows & previous_rows
            position = float(np.max(previous_right[shared] - left[shared])) + gap
            element.set("transform", f"translate({position} 122)")
            previous_rows, previous_right = rows, right + position
    write(ROOT / "sources/Dinkster_Master.svg", master)
    command = [args.inkscape, str(ROOT / "sources/Dinkster_Master.svg"), "--query-all"]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    (ROOT / "sources/layout-command.txt").write_text(
        shlex.join(command) + "\n", encoding="ascii"
    )


if __name__ == "__main__":
    main()
