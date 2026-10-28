"""Build editable brand geometry. Rendering is performed by export_brand.py."""

from copy import deepcopy
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import build_d as geometry
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


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
LETTERS = {
    "i": "M0 0H15V14H0Z M0 24L15 16V56H0Z",
    "n": "M0 56V25L12 13H30L42 25V56H28V30L24 26H18L14 30V56Z",
    "k": "M0 4L14 -8V29L29 14H49L30 33L65 70H44L16 42L14 44V56H0Z",
    "s": "M36 14L30 26H15L32 37Q39 42 35 49Q32 56 23 56H0L7 44H22L5 33Q-2 28 2 21Q6 14 15 14Z",
    "t": "M0 5L14 -6V14H30L24 27H14V39Q14 44 20 44H29V56H15Q0 56 0 41Z",
    "e": "M40 25L16 43H38L31 56H18Q0 56 0 36Q0 14 20 14Q34 14 40 25Z M14 34L25 26Q13 22 14 34Z",
    "r": "M0 56V29L17 14H33L21 27H17L14 30V56Z",
}
POSITIONS = {"i": 153, "n": 173, "k": 220, "s": 271, "t": 310, "e": 340, "r": 388}


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


def lettering(parent, fill="currentColor", transform=None, prefix="letter"):
    group = node(
        "g", {"fill": fill, **({"transform": transform} if transform else {})}, parent
    )
    for letter, contour in LETTERS.items():
        node(
            "path",
            {
                "id": f"{prefix}-{letter}",
                "d": contour,
                "transform": f"translate({POSITIONS[letter]} 122)",
                "fill-rule": "evenodd",
            },
            group,
        )
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


def main():
    approved = ET.parse(ROOT / "sources/dinkster-d.svg").getroot()[0]
    master = node(
        "svg", {"viewBox": "0 0 1500 4200", "width": "1500", "height": "4200"}
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
    silhouette_clip = node(
        "clipPath",
        {"id": "approved-silhouette", "clipPathUnits": "userSpaceOnUse"},
        defs,
    )
    outline_copy = deepcopy(approved)
    outline_copy.set("id", "silhouette-clip-path")
    silhouette_clip.append(outline_copy)
    for name, polygon in (
        ("coral", "343,68 424,149 424,299 363,360 600,360 600,40 343,40"),
        ("yellow", "80,240 232,240 232,390 80,390"),
    ):
        clip = node(
            "clipPath", {"id": f"plane-{name}", "clipPathUnits": "userSpaceOnUse"}, defs
        )
        node("polygon", {"points": polygon, "transform": reference_transform}, clip)
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
    color_symbol = node(
        "g", {"id": "symbol-color", "transform": "translate(0 3000)"}, artboards
    )
    node("rect", {"width": "1000", "height": "1000", "opacity": "0"}, color_symbol)
    clipped = node("g", {"clip-path": "url(#approved-silhouette)"}, color_symbol)
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
        (("mono", "#1F242A"), ("dark", "#F2F4F5"), ("light", "#1F242A"))
    ):
        wordmark = node(
            "g",
            {
                "id": f"wordmark-{variant}",
                "transform": f"translate(-60 {index * 1000 - 250}) scale(3.4)",
                "color": color,
            },
            artboards,
        )
        symbol = node("g", {"transform": "translate(16.9 76.6) scale(.139)"}, wordmark)
        d = deepcopy(approved)
        d.set("id", f"wordmark-{variant}-d")
        d.set("fill", "currentColor")
        symbol.append(d)
        lettering(wordmark, prefix=variant)
    write(ROOT / "sources/Dinkster_Master.svg", master)
    sheet = node("svg", {"viewBox": "0 0 460 110", "width": "1380", "height": "330"})
    for index, (letter, contour) in enumerate(LETTERS.items()):
        node(
            "path",
            {
                "d": contour,
                "fill": "#1F242A",
                "fill-rule": "evenodd",
                "transform": f"translate({index * 65 + 8} 20)",
            },
            sheet,
        )
    write(ROOT / "sources/letter-sheet.svg", sheet)


if __name__ == "__main__":
    main()
