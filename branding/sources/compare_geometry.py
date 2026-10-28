"""Render unselected lower-arm proposals without changing the approved D."""

import argparse
from copy import deepcopy
import shlex
import subprocess
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont

from build_brand import ROOT, SVG, node, symbol_path, write


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
    args = parser.parse_args()
    master = ET.parse(ROOT / "sources/Dinkster_Master.svg").getroot()
    approved = ET.parse(ROOT / "sources/dinkster-d.svg").getroot()[0].get("d")
    assert symbol_path() == approved, (
        "Proposal coordinates must preserve the master frame"
    )
    output = ROOT / "previews/geometry-options"
    output.mkdir(exist_ok=True)
    commands = [
        subprocess.check_output([args.inkscape, "--version"], text=True).strip()
    ]
    for option, radius in (
        ("current", None),
        ("vertical-trim", 0),
        ("rounded-trim", 3),
    ):
        for variant in ("mono", "color"):
            svg = node(
                "svg", {"viewBox": "0 0 1000 1000", "width": "1000", "height": "1000"}
            )
            svg.append(deepcopy(master.find(f"{{{SVG}}}defs")))
            symbol = deepcopy(
                next(e for e in master.iter() if e.get("id") == f"symbol-{variant}")
            )
            symbol.attrib.pop("transform")
            svg.append(symbol)
            for size in (16, 24, 32, 48, 64, 1024):
                path = symbol_path(size, radius)
                copy = deepcopy(svg)
                for element in copy.iter():
                    if element.get("d") == approved:
                        element.set("d", path)
                filename = f"{option}-{variant}" + ("" if size == 1024 else f"-{size}")
                source = output / (
                    f"{filename}.svg" if size in (16, 24) else f"{option}-{variant}.svg"
                )
                write(source, copy)
                command = [
                    args.inkscape,
                    str(source),
                    "--export-type=png",
                    f"--export-width={size}",
                    f"--export-height={size}",
                    f"--export-filename={output / f'{filename}.png'}",
                ]
                subprocess.run(command, check=True)
                commands.append(shlex.join(command))
    (ROOT / "sources/geometry-export-commands.txt").write_text(
        "\n".join(commands) + "\n", encoding="ascii"
    )
    font = ImageFont.truetype("DejaVuSans.ttf", 24)
    sheet = Image.new("RGB", (3152, 4312), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    for column, (option, title) in enumerate(
        (
            ("current", "CURRENT - x=223"),
            ("vertical-trim", "PROPOSAL - vertical x=232"),
            ("rounded-trim", "PROPOSAL - x=232, radius 3"),
        )
    ):
        x = 16 + column * 1048
        draw.text((x, 12), title, font=font, fill="#1F242A")
        for row, (variant, background, foreground) in enumerate(
            (
                ("mono", "#111316", "#F2F4F5"),
                ("color", "#111316", "#F2F4F5"),
                ("mono", "#F7F8FA", "#1F242A"),
                ("color", "#F7F8FA", "#1F242A"),
            )
        ):
            y = 60 + row * 1060
            panel = Image.new("RGBA", (1024, 1024), background)
            icon = Image.open(output / f"{option}-{variant}.png").convert("RGBA")
            if variant == "mono":
                ink = Image.new("RGBA", icon.size, foreground)
                ink.putalpha(icon.getchannel("A"))
                icon = ink
            panel.alpha_composite(icon)
            sheet.paste(panel.convert("RGB"), (x, y))
            draw.text(
                (x, y + 1028), f"{variant} - native 1024 px", font=font, fill="#1F242A"
            )
    sheet.save(ROOT / "previews/bottom-left-options.png")


if __name__ == "__main__":
    main()
