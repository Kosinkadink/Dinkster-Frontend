"""Render unselected lower-arm proposals without changing the approved D."""

import argparse
from copy import deepcopy
import math
import shlex
import subprocess
import xml.etree.ElementTree as ET

import build_d as geometry
from PIL import Image, ImageDraw, ImageFont

from build_brand import ROOT, SVG, node, symbol_path, write


def counter_options(inkscape):
    output = ROOT / "previews/counter-options"
    output.mkdir(exist_ok=True)
    scale = 840 / (geometry.RIGHT - (geometry.LEG_DIAG - geometry.BOTTOM))
    transform = geometry.Transform(
        scale,
        80 - (geometry.LEG_DIAG - geometry.BOTTOM) * scale,
        (1000 - (geometry.BOTTOM - geometry.TOP) * scale) / 2 - geometry.TOP * scale,
    )
    bowl = geometry.bowl_side()[0][1]
    left = bowl[0][0]
    # Counter area is measured right of the island's straight stem edge.
    points = [
        (geometry.STEM_R, geometry.APERTURE_BOTTOM),
        *bowl,
        (geometry.STEM_R, geometry.APERTURE_TOP),
    ]
    area = abs(
        sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
        / 2
    )
    fixed = (left - geometry.STEM_R) * (
        geometry.APERTURE_BOTTOM - geometry.APERTURE_TOP
    )
    commands = [subprocess.check_output([inkscape, "--version"], text=True).strip()]
    font = ImageFont.truetype("DejaVuSans.ttf", 23)
    sheet = Image.new("RGB", (6296, 4350), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    for column, reduction in enumerate((0, 0, 10, 20, 30, 0)):
        factor = (area * (1 - reduction / 100) - fixed) / (area - fixed)
        contour = geometry.outline()
        if reduction:
            contour = [
                ("poly", [(left + (x - left) * factor, y) for x, y in vertex[1]])
                if vertex[0] == "poly"
                else vertex
                for vertex in contour
            ]
        if 0 < column < 5:
            # The channel cuts off this circle before its x=232 tangent.
            # Keep that non-tangent join visible rather than overlap the arc.
            radius = 24
            cx, cy = geometry.STEM_L + radius, geometry.BOTTOM - radius
            offset = geometry.CHANNEL_LOW - cx - cy
            dx = (offset - math.sqrt(2 * radius**2 - offset**2)) / 2
            dy = offset - dx
            angle = math.degrees(math.atan2(dy, dx))
            contour = [
                ("arc", cx, cy, radius, 90, angle)
                if vertex[0] == "bottom_channel"
                else vertex
                for vertex in contour
            ]
        radii = {**geometry.RADII, "bottom_channel": 24 if column == 5 else 0}
        path = geometry.to_svg(
            [
                geometry.build(contour, radii)[0],
                geometry.build(geometry.stem(), geometry.RADII)[0],
            ],
            transform,
        )
        name = (
            "current"
            if not column
            else "tangent-round"
            if column == 5
            else "round-only"
            if not reduction
            else f"counter-minus-{reduction}"
        )
        for variant in ("mono", "color"):
            source = ET.parse(
                output.parent / f"geometry-options/current-{variant}.svg"
            ).getroot()
            approved = symbol_path()
            for element in source.iter():
                if element.get("d") == approved:
                    element.set("d", path)
            svg = output / f"{name}-{variant}.svg"
            png = svg.with_suffix(".png")
            write(svg, source)
            command = [
                inkscape,
                str(svg),
                "--export-type=png",
                "--export-width=1024",
                "--export-height=1024",
                f"--export-filename={png}",
            ]
            subprocess.run(command, check=True)
            commands.append(shlex.join(command))
        x = 12 + column * 1048
        title = (
            "CURRENT"
            if not column
            else "ALTERNATIVE - TANGENT R24"
            if column == 5
            else "X232 CONSTRUCTION / PARTIAL R24"
            if not reduction
            else f"COUNTER AREA -{reduction}% / PARTIAL R24"
        )
        draw.text((x, 12), title, font=font, fill="#1F242A")
        for row, (variant, background, foreground) in enumerate(
            (
                ("mono", "#111316", "#F2F4F5"),
                ("color", "#111316", "#F2F4F5"),
                ("mono", "#F7F8FA", "#1F242A"),
                ("color", "#F7F8FA", "#1F242A"),
            )
        ):
            icon = Image.open(output / f"{name}-{variant}.png").convert("RGBA")
            if variant == "mono":
                ink = Image.new("RGBA", icon.size, foreground)
                ink.putalpha(icon.getchannel("A"))
                icon = ink
            panel = Image.new("RGBA", icon.size, background)
            panel.alpha_composite(icon)
            y = 60 + row * 1060
            sheet.paste(panel.convert("RGB"), (x, y))
            draw.text(
                (x, y + 1026), f"{variant} - native 1024 px", font=font, fill="#1F242A"
            )
        print(
            f"{name}: horizontal squircle factor={factor:.9f}; right={left + 64 * factor:.6f}"
        )
    sheet.save(output.parent / "counter-size-options.png")
    (ROOT / "sources/counter-export-commands.txt").write_text(
        "\n".join(commands) + "\n", encoding="ascii"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
    parser.add_argument("--counter-options", action="store_true")
    args = parser.parse_args()
    if args.counter_options:
        counter_options(args.inkscape)
        return
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
