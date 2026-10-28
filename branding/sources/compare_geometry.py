"""Render unselected lower-arm proposals without changing the approved D."""

import argparse
from copy import deepcopy
import shlex
import subprocess
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont

import build_d as geometry
from build_brand import ROOT, SVG, node, write


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
    args = parser.parse_args()
    master = ET.parse(ROOT / "sources/Dinkster_Master.svg").getroot()
    approved = ET.parse(ROOT / "sources/dinkster-d.svg").getroot()[0].get("d")
    scale = 840 / (geometry.RIGHT - (geometry.LEG_DIAG - geometry.BOTTOM))
    transform = geometry.Transform(
        scale,
        80 - (geometry.LEG_DIAG - geometry.BOTTOM) * scale,
        (1000 - (geometry.BOTTOM - geometry.TOP) * scale) / 2 - geometry.TOP * scale,
    )
    original = geometry.to_svg(
        [
            geometry.build(c, geometry.RADII)[0]
            for c in (geometry.outline(), geometry.stem())
        ],
        transform,
    )
    assert original == approved, "Proposal coordinates must preserve the master frame"
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
        contour = geometry.outline()
        if radius is not None:
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
        path = (
            approved
            if radius is None
            else geometry.to_svg(
                [
                    geometry.build(contour, {**geometry.RADII, "bottom_trim": radius})[
                        0
                    ],
                    geometry.build(geometry.stem(), geometry.RADII)[0],
                ],
                transform,
            )
        )
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
            for element in svg.iter():
                if element.get("d") == approved:
                    element.set("d", path)
            source = output / f"{option}-{variant}.svg"
            write(source, svg)
            command = [
                args.inkscape,
                str(source),
                "--export-type=png",
                "--export-width=1024",
                "--export-height=1024",
                f"--export-filename={output / f'{option}-{variant}.png'}",
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
