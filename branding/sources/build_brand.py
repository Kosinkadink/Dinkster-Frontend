"""Build editable brand geometry. Rendering is performed by export_brand.py."""

from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

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
    return node("g", {
        "id": label,
        f"{{{INK}}}groupmode": "layer",
        f"{{{INK}}}label": label,
        "style": "display:inline" if visible else "display:none",
    }, parent)


def write(path, element):
    ET.indent(element)
    ET.ElementTree(element).write(path, encoding="unicode", xml_declaration=True)


def lettering(parent, fill="currentColor", transform=None, prefix="letter"):
    group = node("g", {"fill": fill, **({"transform": transform} if transform else {})}, parent)
    for letter, contour in LETTERS.items():
        node("path", {"id": f"{prefix}-{letter}", "d": contour,
                      "transform": f"translate({POSITIONS[letter]} 122)",
                      "fill-rule": "evenodd"}, group)
    return group


def main():
    approved = ET.parse(ROOT / "sources/dinkster-d.svg").getroot()[0]
    master = node("svg", {"viewBox": "0 0 1500 3000", "width": "1500", "height": "3000"})
    reference = layer(master, "00_Reference")
    reference.set(f"{{{SOD}}}insensitive", "true")
    node("desc", parent=reference).text = "Approved D source: dinkster-d.svg. Wordmark direction: wrapper notes/reference/branding/wordmark-monochrome-reference.png."
    construction = layer(master, "01_Construction")
    scaffold = node("g", {"id": "outfit-scaffold", "transform": "translate(120 800) scale(.12 -.12)"}, construction)
    font = instantiateVariableFont(TTFont(ROOT / "sources/fonts/Outfit.ttf"), {"wght": 800})
    glyphs = font.getGlyphSet()
    x = 0
    for letter in "inkster":
        glyph = glyphs[font.getBestCmap()[ord(letter)]]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        node("path", {"id": f"scaffold-{letter}", "d": pen.getCommands(), "transform": f"translate({x} 0)"}, scaffold)
        x += glyph.width
    mono = layer(master, "02_Logo_Master_Mono")
    mono.append(deepcopy(approved))
    for label in ("03_Chromatic_Cyan", "04_Chromatic_Coral", "05_Chromatic_Yellow"):
        layer(master, label)
    letters = layer(master, "06_Wordmark_inkster")
    lettering(letters, "#1F242A", "translate(-300 -640) scale(4)", "editable")
    artboards = layer(master, "07_Exports_Artboards", True)
    # A uniform transform preserves the approved D while matching the reference
    # symbol height and its optical overshoot below the letters' baseline.
    for index, (variant, color) in enumerate((("mono", "#1F242A"), ("dark", "#F2F4F5"), ("light", "#1F242A"))):
        wordmark = node("g", {"id": f"wordmark-{variant}", "transform": f"translate(-60 {index * 1000 - 250}) scale(3.4)", "color": color}, artboards)
        symbol = node("g", {"transform": "translate(16.9 76.6) scale(.139)"}, wordmark)
        d = deepcopy(approved)
        d.set("id", f"wordmark-{variant}-d")
        d.set("fill", "currentColor")
        symbol.append(d)
        lettering(wordmark, prefix=variant)
    write(ROOT / "sources/Dinkster_Master.svg", master)
    sheet = node("svg", {"viewBox": "0 0 460 110", "width": "1380", "height": "330"})
    for index, (letter, contour) in enumerate(LETTERS.items()):
        node("path", {"d": contour, "fill": "#1F242A", "fill-rule": "evenodd", "transform": f"translate({index * 65 + 8} 20)"}, sheet)
    write(ROOT / "sources/letter-sheet.svg", sheet)


if __name__ == "__main__":
    main()
