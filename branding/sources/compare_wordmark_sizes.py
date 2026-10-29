"""Render the selected D's color junction and locked-proportion size options."""

import argparse
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET
from copy import deepcopy
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.svgLib.path import parse_path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
NATIVE_WIDTH = 500


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("--inkscape", required=True)
    parser.add_argument("--junction-only", action="store_true")
    args = parser.parse_args()
    output = ROOT / "previews/size-options"
    output.mkdir(exist_ok=True)
    master = ET.parse(ROOT / "sources/Dinkster_Master.svg").getroot()
    selected = ET.parse(ROOT / "sources/dinkster-d.svg").getroot()[0]
    contour = selected.get("d")
    bounds = BoundsPen(None)
    parse_path(contour, bounds)
    bottom = 76.6 + 0.139 * bounds.bounds[3]
    letter_bottom = 178
    for element in master.iter():
        if element.get("id") in {f"dark-{letter}" for letter in "inkster"}:
            letter_bounds = BoundsPen(None)
            parse_path(element.get("d"), letter_bounds)
            letter_bottom = max(letter_bottom, 122 + letter_bounds.bounds[3])
    commands = [
        subprocess.check_output([args.inkscape, "--version"], text=True).strip()
    ]

    def export(source, destination, *options):
        command = [
            args.inkscape,
            str(source),
            *options,
            f"--export-filename={destination}",
        ]
        subprocess.run(command, check=True)
        commands.append(shlex.join(command))

    # Use precisely the same clipped planes as the layered master. Replacing
    # only the silhouette cannot add fill across the traced negative space.
    for element in master.iter():
        if element.get("id") == "silhouette-clip-path":
            element.set("d", contour)
            element.set("fill-rule", "evenodd")
    defs = master.find(f"{{{NS}}}defs")
    color = next(e for e in master.iter() if e.get("id") == "symbol-color")
    symbol = ET.Element(f"{{{NS}}}svg", {"viewBox": "0 0 446 259"})
    symbol.append(deepcopy(defs))
    group = ET.SubElement(
        symbol, f"{{{NS}}}g", {"transform": "translate(16.9 76.6) scale(.139)"}
    )
    color = deepcopy(color)
    color.attrib.pop("transform")
    group.append(color)
    source = output / "selected-d-color.svg"
    ET.ElementTree(symbol).write(source, encoding="unicode", xml_declaration=True)
    export(
        source,
        output / "selected-d-color-8x.png",
        "--export-type=png",
        "--export-width=3568",
        "--export-height=2072",
    )
    image = Image.open(output / "selected-d-color-8x.png").convert("RGBA")
    font = ImageFont.truetype("DejaVuSans.ttf", 19)
    title = ImageFont.truetype("DejaVuSans.ttf", 24)
    sheet = Image.new("RGB", (1640, 940), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    draw.text(
        (24, 18),
        "CORRECTED D - rounded body tip; straight vertical color boundaries",
        fill="#1F242A",
        font=title,
    )
    draw.text(
        (24, 54),
        "No yellow on the body; yellow and coral meet teal along straight vertical cuts.",
        fill="#1F242A",
        font=font,
    )
    for column, background in enumerate(("#111316", "#F7F8FA")):
        x = 20 + column * 810
        foreground = "#F2F4F5" if column == 0 else "#1F242A"
        draw.rectangle((x, 96, x + 789, 919), fill=background)
        draw.text(
            (x + 20, 112),
            "Native size             2x reference size",
            fill=foreground,
            font=font,
        )
        full = image.crop((18 * 8, 85 * 8, 154 * 8, 196 * 8))
        for size, position in (
            ((136, 111), (x + 28, 160)),
            ((272, 222), (x + 270, 160)),
        ):
            scaled = full.resize(size, Image.Resampling.LANCZOS)
            sheet.paste(scaled, position, scaled)
        draw.text(
            (x + 20, 406),
            "Bottom junction - 12x native size",
            fill=foreground,
            font=font,
        )
        junction = image.crop((60 * 8, 156 * 8, 112 * 8, 192 * 8)).resize(
            (624, 432), Image.Resampling.LANCZOS
        )
        sheet.paste(junction, (x + 72, 452), junction)
    sheet.save(ROOT / "previews/d-selected-color-junction.png")
    if not args.junction_only:
        variants = (
            ("115-current", "1.15x / current baseline", 1.15, 0.0),
            (
                "115-bottoms",
                "1.15x / letter bottoms aligned",
                1.15,
                bottom - (178 + (letter_bottom - 178) * 1.15),
            ),
            ("125-current", "1.25x / current baseline", 1.25, 0.0),
            (
                "125-bottoms",
                "1.25x / letter bottoms aligned",
                1.25,
                bottom - (178 + (letter_bottom - 178) * 1.25),
            ),
        )
        for name, label, scale, dy in variants:
            for variant, y in (("dark", 1000), ("light", 2000)):
                tree = deepcopy(master)
                wordmark = next(
                    e for e in tree.iter() if e.get("id") == f"wordmark-{variant}"
                )
                d = next(
                    e for e in wordmark.iter() if e.get("id") == f"wordmark-{variant}-d"
                )
                d.set("d", contour)
                d.set("fill-rule", "evenodd")
                letters = next(e for e in wordmark if e.get("fill") == "currentColor")
                letters.set(
                    "transform",
                    f"translate(147.75 {178 + dy}) scale({scale}) translate(-147.75 -178)",
                )
                source = output / f"{name}-{variant}.svg"
                ET.ElementTree(tree).write(
                    source, encoding="unicode", xml_declaration=True
                )
                export(
                    source,
                    ROOT / f"previews/wordmark-{name}-{variant}-2x.png",
                    "--export-type=png",
                    f"--export-id=wordmark-{variant}",
                    "--export-id-only",
                    f"--export-area=-60:{y - 250}:{NATIVE_WIDTH * 3.4 - 60}:{y + 630.6}",
                    f"--export-width={NATIVE_WIDTH * 2}",
                    "--export-height=518",
                )
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "sources/compare_wordmark.py"),
                    str(args.reference),
                    "--prefix",
                    name + "-",
                    "--caption",
                    f"{label}; shift {dy:+.2f}px; e/r +2 units",
                    "--dark-reference-only",
                    "--letter-scale",
                    str(scale),
                    "--baseline-shift",
                    str(dy),
                    "--native-width",
                    str(NATIVE_WIDTH),
                ],
                check=True,
            )
        column_width = NATIVE_WIDTH * 2 + 20
        combined = Image.new("RGB", (column_width * 5 + 20, 1670), "#E4E8EC")
        labels = ImageDraw.Draw(combined)
        for index, (name, label, scale, dy) in enumerate(variants):
            comparison = Image.open(
                ROOT / f"previews/wordmark-{name}-reference-comparison.png"
            )
            x = (index + 1) * column_width + 20
            native_x = NATIVE_WIDTH + 40
            double_x = NATIVE_WIDTH * 2 + 40
            combined.paste(
                comparison.crop((native_x, 50, native_x + NATIVE_WIDTH, 568)),
                (x + NATIVE_WIDTH // 2, 50),
            )
            combined.paste(
                comparison.crop((double_x, 624, double_x + NATIVE_WIDTH * 2, 1660)),
                (x, 624),
            )
            labels.text((x + 8, 14), label, fill="#1F242A", font=font)
            labels.text(
                (x + 8, 584),
                f"2x - scale {scale:.2f}; baseline shift {dy:+.2f}px native",
                fill="#1F242A",
                font=font,
            )
            if index == 0:
                combined.paste(
                    comparison.crop((20, 50, 20 + NATIVE_WIDTH, 568)),
                    (20 + NATIVE_WIDTH // 2, 50),
                )
                combined.paste(
                    comparison.crop((20, 624, 20 + NATIVE_WIDTH * 2, 1660)), (20, 624)
                )
        labels.text(
            (24, 14),
            "Dark-on-light reference (upper inverted)",
            fill="#1F242A",
            font=font,
        )
        labels.text(
            (24, 584),
            "Reference - 2x",
            fill="#1F242A",
            font=font,
        )
        combined.save(ROOT / "previews/wordmark-size-comparison.png")
    (ROOT / "sources/size-export-commands.txt").write_text(
        "\n".join(commands) + "\n", encoding="ascii"
    )
    print(
        f"D bottom: {bottom:.9f}px; letter bottom before scaling: {letter_bottom}; scales: 1.15, 1.25"
    )


if __name__ == "__main__":
    main()
