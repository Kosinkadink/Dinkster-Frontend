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
SCALE = 1.05


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
    shift = bottom - 178
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
        "SELECTED D - color planes clipped to the uncorrected reference trace",
        fill="#1F242A",
        font=title,
    )
    draw.text(
        (24, 54),
        "Bottom channel stays open: color does not cross the gap. Enlarged junction below.",
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
            ("current", "Current size / current position", 1.0, 0.0),
            ("aligned", "Current size / baseline aligned", 1.0, shift),
            ("larger", "Larger / current baseline", SCALE, 0.0),
            ("larger-aligned", "Larger / baseline aligned", SCALE, shift),
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
                    f"--export-area=-60:{y - 250}:1456.3999999999999:{y + 630.6}",
                    "--export-width=892",
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
                    f"{label}; scale {scale:.2f}; shift {dy:+.4f}px",
                    "--dark-reference-only",
                    "--letter-scale",
                    str(scale),
                    "--baseline-shift",
                    str(dy),
                ],
                check=True,
            )
        combined = Image.new("RGB", (4580, 1670), "#E4E8EC")
        labels = ImageDraw.Draw(combined)
        for index, (name, label, scale, dy) in enumerate(variants):
            comparison = Image.open(
                ROOT / f"previews/wordmark-{name}-reference-comparison.png"
            )
            x = (index + 1) * 912 + 20
            combined.paste(comparison.crop((486, 50, 932, 568)), (x + 223, 50))
            combined.paste(comparison.crop((932, 624, 1824, 1660)), (x, 624))
            labels.text((x + 8, 14), label, fill="#1F242A", font=font)
            labels.text(
                (x + 8, 584),
                f"2x - scale {scale:.2f}; baseline {dy:+.4f}px native",
                fill="#1F242A",
                font=font,
            )
            if index == 0:
                combined.paste(comparison.crop((20, 50, 466, 568)), (243, 50))
                combined.paste(comparison.crop((20, 624, 912, 1660)), (20, 624))
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
        f"D bottom: {bottom:.9f}px; aligned shift: {shift:.9f}px native; letter scale: {SCALE}"
    )


if __name__ == "__main__":
    main()
