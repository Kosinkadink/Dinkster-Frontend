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


def counter_options(inkscape, nose_options=False):
    output = ROOT / (
        "previews/nose-options" if nose_options else "previews/counter-options"
    )
    output.mkdir(exist_ok=True)
    scale = 840 / (geometry.RIGHT - (geometry.LEG_DIAG - geometry.BOTTOM))
    transform = geometry.Transform(
        scale,
        80 - (geometry.LEG_DIAG - geometry.BOTTOM) * scale,
        (1000 - (geometry.BOTTOM - geometry.TOP) * scale) / 2 - geometry.TOP * scale,
    )
    bowl = geometry.bowl_side()[0][1]
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
    # Retain n=3.2 corner sampling, but taper the upper shoulder and bias the
    # rounded nose downward. The top stays fixed to preserve the island gap.
    reshaped = []
    for x, y in bowl:
        u = (y - 157) / 128
        reshaped.append((324 + 16 * u + (x - 324) * (0.5 + 0.5 * u), 157 + 112 * u))

    def counter_area(factor):
        profile = [(298 + (x - 298) * factor, y) for x, y in reshaped]
        contour = [
            ("aperture_bl", 314, 269),
            ("poly", profile),
            ("close_top", 298, 157),
            ("close_bottom", 298, 285),
        ]
        polygon = geometry.build(contour, geometry.RADII)[1]
        return abs(
            sum(
                a[0] * b[1] - b[0] * a[1]
                for a, b in zip(polygon, polygon[1:] + polygon[:1])
            )
            / 2
        )

    original_profile = reshaped
    nose_fraction = (max(reshaped, key=lambda point: point[0])[1] - 157) / 112
    commands = [subprocess.check_output([inkscape, "--version"], text=True).strip()]
    font = ImageFont.truetype("DejaVuSans.ttf", 23)
    options = (None, 0.70, 0.62, 0.55) if nose_options else (0, 0, 10, 20, 30)
    sheet = Image.new(
        "RGB", (8 + len(options) * 1048, 4560 if nose_options else 4350), "#E4E8EC"
    )
    draw = ImageDraw.Draw(sheet)
    for column, option in enumerate(options):
        reduction = 30 if nose_options else option
        if nose_options:
            power = math.log(option) / math.log(nose_fraction) if option else 1
            reshaped = [
                (x, 157 + 112 * ((y - 157) / 112) ** power) for x, y in original_profile
            ]
        base_area = counter_area(1)
        area_slope = (counter_area(1.2) - base_area) / 0.2
        factor = 1 + (area * (1 - reduction / 100) - base_area) / area_slope
        contour = geometry.outline()
        if column or nose_options:
            contour = [
                ("poly", [(298 + (x - 298) * factor, y) for x, y in reshaped])
                if vertex[0] == "poly"
                else ("aperture_bl", 314, 269)
                if vertex[0] == "aperture_bl"
                else vertex
                for vertex in contour
            ]
        if column or nose_options:
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
        path = geometry.to_svg(
            [
                geometry.build(contour, geometry.RADII)[0],
                geometry.build(geometry.stem(), geometry.RADII)[0],
            ],
            transform,
        )
        name = (
            (f"nose-{round(option * 100)}" if option else "current-selected")
            if nose_options
            else "current"
            if not column
            else "counter-reshaped"
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
            write(svg, source)
            for size in (1024, 64) if nose_options else (1024,):
                png = svg.with_name(svg.stem + ("-64" if size == 64 else "") + ".png")
                command = [
                    inkscape,
                    str(svg),
                    "--export-type=png",
                    f"--export-width={size}",
                    f"--export-height={size}",
                    f"--export-filename={png}",
                ]
                subprocess.run(command, check=True)
                commands.append(shlex.join(command))
        x = 12 + column * 1048
        title = (
            (
                f"NOSE AT {round(option * 100)}% / AREA -30%"
                if option
                else "CURRENT SELECTED / AREA -30%"
            )
            if nose_options
            else "CURRENT"
            if not column
            else "RESHAPED / SAME AREA / PARTIAL R24"
            if not reduction
            else f"RESHAPED / AREA -{reduction}% / PARTIAL R24"
        )
        draw.text((x, 12), title, font=font, fill="#1F242A")
        if nose_options:
            nose_y = max(reshaped, key=lambda point: point[0])[1]
            alpha = Image.open(output / f"{name}-mono.png").getchannel("A")
            scan_x = round(transform(338, 0)[0] * 1.024)
            empty = [
                row
                for row in range(
                    round(transform(0, 145)[1] * 1.024),
                    round(transform(0, 300)[1] * 1.024),
                )
                if alpha.getpixel((scan_x, row)) < 128
            ]
            top_stroke = (min(empty) / 1.024 - transform.dy) / scale - geometry.TOP
            bottom_stroke = (
                geometry.BOTTOM - (max(empty) / 1.024 - transform.dy) / scale
            )
            draw.text(
                (x, 38),
                f"Nose {(nose_y - 157) / 112:.2%}, y={nose_y:.2f}; x338 top/bottom {top_stroke:.2f}/{bottom_stroke:.2f} source units",
                font=ImageFont.truetype("DejaVuSans.ttf", 18),
                fill="#1F242A",
            )
            draw.text(
                (x, 62),
                "Flat-reference top/bottom strokes: 89/91 source units; partial R24 retained",
                font=ImageFont.truetype("DejaVuSans.ttf", 18),
                fill="#1F242A",
            )
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
            y = (90 if nose_options else 60) + row * 1060
            sheet.paste(panel.convert("RGB"), (x, y))
            draw.text(
                (x, y + 1026), f"{variant} - native 1024 px", font=font, fill="#1F242A"
            )
            if nose_options:
                small = Image.open(output / f"{name}-{variant}-64.png").convert("RGBA")
                if variant == "mono":
                    ink = Image.new("RGBA", small.size, foreground)
                    ink.putalpha(small.getchannel("A"))
                    small = ink
                tile = Image.new("RGBA", (240, 140), background)
                tile.alpha_composite(small, (88, 12))
                ImageDraw.Draw(tile).text(
                    (12, 100),
                    f"64 px {variant} / {'dark' if row < 2 else 'light'}",
                    font=ImageFont.truetype("DejaVuSans.ttf", 17),
                    fill=foreground,
                )
                sheet.paste(tile.convert("RGB"), (x + row * 250, 4390))
        if nose_options:
            draw.text(
                (x, 4350),
                "NATIVE 64 PX - same geometry, no optical substitution",
                font=font,
                fill="#1F242A",
            )
        print(
            f"{name}: horizontal profile factor={factor if column or nose_options else 1:.9f}; "
            f"right={max(298 + (x - 298) * factor for x, _ in reshaped) if column or nose_options else 388:.6f}"
        )
    sheet.save(
        output.parent
        / ("nose-height-options.png" if nose_options else "counter-size-options.png")
    )
    (
        ROOT
        / (
            "sources/nose-export-commands.txt"
            if nose_options
            else "sources/counter-export-commands.txt"
        )
    ).write_text("\n".join(commands) + "\n", encoding="ascii")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
    parser.add_argument("--counter-options", action="store_true")
    parser.add_argument("--nose-options", action="store_true")
    args = parser.parse_args()
    if args.counter_options or args.nose_options:
        counter_options(args.inkscape, args.nose_options)
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
