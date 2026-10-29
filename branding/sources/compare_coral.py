"""Render coral-only proposals on the selected D and master wordmark geometry."""

import argparse
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET
from copy import deepcopy
from pathlib import Path

import build_d as geometry
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("--inkscape", required=True)
    args = parser.parse_args()
    output = ROOT / "previews/coral-options"
    output.mkdir(exist_ok=True)
    master = ET.parse(ROOT / "sources/Dinkster_Master.svg").getroot()
    commands = [
        subprocess.check_output([args.inkscape, "--version"], text=True).strip()
    ]
    variants = (
        ("thinner", "Previous 40% band / slanted bottom", 20),
        ("selected", "Selected 40% band / vertical bottom", 0),
    )
    renders = []

    def export(source, destination, *options):
        command = [
            args.inkscape,
            str(source),
            *options,
            f"--export-filename={destination}",
        ]
        subprocess.run(command, check=True)
        commands.append(shlex.join(command))

    for name, label, offset in variants:
        tree = deepcopy(master)
        if offset:
            # Continue the existing upper diagonal past the silhouette instead
            # of closing it vertically inside the artwork. Only the inner
            # band boundary moves; the D's clipped outside remains identical.
            boundary = [
                ("start", 303 + offset, 28),
                ("right_top", 424 + offset, 149),
                ("right_bottom", 424 + offset, 299),
                ("end", 363 + offset, 360),
                ("outside_bottom", 650, 440),
                ("outside_top", 650, -40),
                ("outside_left", 303 + offset, -40),
            ]
            contour, _ = geometry.build(
                boundary,
                {key: geometry.RADII[key] for key in ("right_top", "right_bottom")},
            )
            clip = next(e for e in tree.iter() if e.get("id") == "plane-coral")
            clip[0].set("d", geometry.to_svg([contour], geometry.Transform(1, 0, 0)))
        defs = tree.find(f"{{{NS}}}defs")
        color = next(e for e in tree.iter() if e.get("id") == "symbol-color")
        symbol = ET.Element(f"{{{NS}}}svg", {"viewBox": "0 0 446 259"})
        symbol.append(deepcopy(defs))
        group = ET.SubElement(
            symbol, f"{{{NS}}}g", {"transform": "translate(16.9 76.6) scale(.139)"}
        )
        colored = deepcopy(color)
        colored.attrib.pop("transform")
        group.append(colored)
        source = output / f"{name}-d.svg"
        ET.ElementTree(symbol).write(source, encoding="unicode", xml_declaration=True)
        destination = output / f"{name}-d-8x.png"
        export(source, destination, "--export-type=png", "--export-width=3568")
        image = Image.open(destination).convert("RGBA")
        pixels = np.asarray(image)
        row = pixels[145 * 8]
        occupied = np.flatnonzero(row[:, 3] >= 128)
        right = occupied[-1]
        left = right
        while row[left - 1, 3] >= 128:
            left -= 1
        coral = (row[:, :3] == (255, 116, 104)).all(axis=1) & (row[:, 3] >= 128)
        seam = np.flatnonzero(coral)[0]
        print(
            f"{name}: y145 coral {(right - seam) / 8:.3f}px; "
            f"teal {(seam - left) / 8:.3f}px; "
            f"coral share {(right - seam) / (right - left):.3%}"
        )
        renders.append(image)
        for theme, y in (("dark", 1000), ("light", 2000)):
            wordmark = next(
                e for e in tree.iter() if e.get("id") == f"wordmark-{theme}"
            )
            d = next(
                e
                for e in wordmark
                if e.get("transform") == "translate(16.9 76.6) scale(.139)"
            )
            d.clear()
            d.set("transform", "translate(16.9 76.6) scale(.139)")
            colored = deepcopy(color)
            colored.attrib.pop("transform")
            colored.attrib.pop("id")
            d.append(colored)
            source = output / f"{name}-{theme}.svg"
            ET.ElementTree(tree).write(source, encoding="unicode", xml_declaration=True)
            export(
                source,
                ROOT / f"previews/wordmark-coral-{name}-{theme}-2x.png",
                "--export-type=png",
                f"--export-id=wordmark-{theme}",
                "--export-id-only",
                f"--export-area=-60:{y - 250}:1640:{y + 630.6}",
                "--export-width=1000",
                "--export-height=518",
            )
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "sources/compare_wordmark.py"),
                str(args.reference),
                "--prefix",
                f"coral-{name}-",
                "--caption",
                "1.35x; baseline y188; D fixed",
                "--dark-reference-only",
                "--color",
                "--letter-scale",
                "1.35",
                "--baseline-shift",
                "10",
                "--native-width",
                "500",
            ],
            check=True,
        )
    font = ImageFont.truetype("DejaVuSans.ttf", 18)
    sheet = Image.new("RGB", (1600, 2890), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    for column, ((name, label, offset), image) in enumerate(zip(variants, renders)):
        x = column * 800
        draw.text((x + 16, 16), label, fill="#1F242A", font=font)
        for theme, background, foreground, y in (
            ("dark", "#111316", "#F2F4F5", 50),
            ("light", "#F7F8FA", "#1F242A", 1470),
        ):
            draw.rectangle((x + 10, y, x + 789, y + 1399), fill=background)
            draw.text(
                (x + 28, y + 14),
                "Native                     2x native",
                fill=foreground,
                font=font,
            )
            full = image.crop((18 * 8, 85 * 8, 154 * 8, 196 * 8))
            for size, position in (
                ((136, 111), (x + 28, y + 60)),
                ((272, 222), (x + 290, y + 60)),
            ):
                scaled = full.resize(size, Image.Resampling.LANCZOS)
                sheet.paste(scaled, position, scaled)
            draw.text(
                (x + 28, y + 306), "Top end - 12x native", fill=foreground, font=font
            )
            top = image.crop((88 * 8, 92 * 8, 148 * 8, 132 * 8)).resize(
                (720, 480), Image.Resampling.LANCZOS
            )
            sheet.paste(top, (x + 40, y + 346), top)
            draw.text(
                (x + 28, y + 850), "Bottom end - 12x native", fill=foreground, font=font
            )
            bottom = image.crop((88 * 8, 154 * 8, 148 * 8, 194 * 8)).resize(
                (720, 480), Image.Resampling.LANCZOS
            )
            sheet.paste(bottom, (x + 40, y + 890), bottom)
    sheet.save(ROOT / "previews/d-coral-thickness-comparison.png")
    (ROOT / "sources/coral-export-commands.txt").write_text(
        "\n".join(commands) + "\n", encoding="ascii"
    )


if __name__ == "__main__":
    main()
