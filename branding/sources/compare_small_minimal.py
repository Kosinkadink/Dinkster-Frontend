"""Propose single-pixel channel edits without replacing production exports."""

import json
from pathlib import Path

from compare_small_optical import connectivity
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
CHANNEL_PIXELS = {
    16: {
        "upper": [(x, 5) for x in range(5, 9)],
        "lower": [(7 - n, 9 + n) for n in range(4)],
    },
    24: {
        "upper": [(x, 8) for x in range(8, 13)],
        "lower": [(11 - n, 14 + n) for n in range(5)],
    },
}


def main():
    font = ImageFont.truetype("DejaVuSans.ttf", 17)
    sheet = Image.new("RGB", (2100, 2380), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    draw.text(
        (20, 16),
        "EXACT SOURCE / VETOED WIDE CUTS / MINIMAL PIXEL PROPOSAL - native and 12x; full-size D frozen",
        fill="#1F242A",
        font=font,
    )
    output = ROOT / "previews/small-minimal"
    output.mkdir(exist_ok=True)
    report = {}
    for column, size in enumerate((16, 24)):
        x = column * 1050
        edits = CHANNEL_PIXELS[size]
        report[str(size)] = {"cleared_pixels_xy": edits, "comparisons": {}}
        for variant in ("mono", "color"):
            image = Image.open(
                ROOT / f"previews/small-exact-source/{variant}-{size}.png"
            ).convert("RGBA")
            if variant == "mono":
                report[str(size)]["original_alpha"] = {
                    channel: [image.getpixel(point)[3] for point in points]
                    for channel, points in edits.items()
                }
            for points in edits.values():
                for point in points:
                    r, g, b, alpha = image.getpixel(point)
                    assert alpha > 0
                    image.putpixel(point, (r, g, b, 0))
            image.save(output / f"{variant}-{size}.png")
        for theme, background, foreground, y in (
            ("dark", "#111316", "#F2F4F5", 60),
            ("light", "#F7F8FA", "#1F242A", 1210),
        ):
            draw.rectangle((x + 10, y, x + 1039, y + 1130), fill=background)
            draw.text(
                (x + 30, y + 16),
                f"{size}px / {theme} - exact / vetoed / minimal ({sum(map(len, edits.values()))} pixels cleared)",
                fill=foreground,
                font=font,
            )
            for row, variant in enumerate((theme, "cyan", "color")):
                source = "color" if variant == "color" else "mono"
                name = "mono" if variant == theme else variant
                top = y + 80 + row * 340
                draw.text(
                    (x + 30, top - 23),
                    f"{name}: native / 12x",
                    fill=foreground,
                    font=font,
                )
                measurements = {}
                for index, (label, directory) in enumerate(
                    (
                        ("exact", "small-exact-source"),
                        ("vetoed", "small-vetoed"),
                        ("minimal", "small-minimal"),
                    )
                ):
                    image = Image.open(
                        ROOT / f"previews/{directory}/{source}-{size}.png"
                    ).convert("RGBA")
                    if variant != "color":
                        ink = Image.new(
                            "RGBA",
                            image.size,
                            "#32E6C5" if variant == "cyan" else foreground,
                        )
                        ink.putalpha(image.getchannel("A"))
                        image = ink
                    measurements[label] = connectivity(image)
                    left = x + 35 + index * 340
                    draw.text((left + 110, top), label, fill=foreground, font=font)
                    sheet.paste(image, (left + 270, top), image)
                    enlarged = image.resize(
                        (size * 12, size * 12), Image.Resampling.NEAREST
                    )
                    sheet.paste(enlarged, (left, top + 30), enlarged)
                report[str(size)]["comparisons"][f"{theme}-{name}"] = measurements
            m = report[str(size)]["comparisons"][f"{theme}-mono"]["minimal"]
            draw.text(
                (x + 30, y + 1096),
                f"Minimal diagnostic: FG4/8={m['foreground_4']}/{m['foreground_8']}; trapped={m['trapped_zero_alpha_pixels']} (not a gate)",
                fill=foreground,
                font=font,
            )
    sheet.save(ROOT / "previews/small-minimal-comparison.png")
    (ROOT / "previews/small-minimal-connectivity.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="ascii"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
