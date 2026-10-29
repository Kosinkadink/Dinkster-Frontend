"""Measure optical PNG connectivity and compare with preserved exact-source frames."""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]


def connectivity(image):
    alpha = np.asarray(image.convert("RGBA"))[:, :, 3]
    background, count = ndimage.label(alpha == 0)
    outside = set(
        np.concatenate(
            (background[0], background[-1], background[:, 0], background[:, -1])
        )
    )
    return {
        "foreground_4": ndimage.label(alpha >= 128)[1],
        "foreground_8": ndimage.label(alpha >= 128, np.ones((3, 3)))[1],
        "any_alpha_foreground_8": ndimage.label(alpha > 0, np.ones((3, 3)))[1],
        "zero_alpha_background_4": count,
        "trapped_zero_alpha_pixels": int(
            np.isin(
                background, [n for n in range(1, count + 1) if n not in outside]
            ).sum()
        ),
    }


def main():
    font = ImageFont.truetype("DejaVuSans.ttf", 17)
    sheet = Image.new("RGB", (1440, 2350), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    draw.text(
        (20, 16),
        "EXACT SOURCE vs OPTICAL - native and 12x nearest-neighbor; full-size master unchanged",
        fill="#1F242A",
        font=font,
    )
    report = {}
    for column, size in enumerate((16, 24)):
        x = column * 720
        report[str(size)] = {}
        for theme, background, foreground, y in (
            ("dark", "#111316", "#F2F4F5", 60),
            ("light", "#F7F8FA", "#1F242A", 1200),
        ):
            draw.rectangle((x + 10, y, x + 709, y + 1120), fill=background)
            draw.text(
                (x + 30, y + 16),
                f"{size}px / {theme} - exact source (left), optical (right)",
                fill=foreground,
                font=font,
            )
            for row, variant in enumerate((theme, "cyan", "color")):
                source = "color" if variant == "color" else "mono"
                before = Image.open(
                    ROOT / f"previews/small-exact-source/{source}-{size}.png"
                ).convert("RGBA")
                after = Image.open(
                    ROOT / f"previews/small-vetoed/{source}-{size}.png"
                ).convert("RGBA")
                if variant != "color":
                    ink = Image.new(
                        "RGBA",
                        before.size,
                        "#32E6C5" if variant == "cyan" else foreground,
                    )
                    ink.putalpha(before.getchannel("A"))
                    before = ink
                    ink = ink.copy()
                    ink.putalpha(after.getchannel("A"))
                    after = ink
                name = "mono" if variant == theme else variant
                old = connectivity(before)
                new = connectivity(after)
                report[str(size)][f"{theme}-{name}"] = {"exact": old, "optical": new}
                assert (
                    new["foreground_4"]
                    == new["foreground_8"]
                    == new["any_alpha_foreground_8"]
                    == 2
                )
                assert (
                    new["zero_alpha_background_4"] == 1
                    and new["trapped_zero_alpha_pixels"] == 0
                )
                top = y + 60 + row * 330
                draw.text(
                    (x + 30, top), f"{name}: native / 12x", fill=foreground, font=font
                )
                for image, left in ((before, x + 40), (after, x + 390)):
                    sheet.paste(image, (left + 240, top), image)
                    enlarged = image.resize(
                        (size * 12, size * 12), Image.Resampling.NEAREST
                    )
                    sheet.paste(enlarged, (left, top + 30), enlarged)
            old = report[str(size)][f"{theme}-mono"]["exact"]
            new = report[str(size)][f"{theme}-mono"]["optical"]
            draw.text(
                (x + 30, y + 1064),
                f"FG4/8: {old['foreground_4']}/{old['foreground_8']} -> 2/2",
                fill=foreground,
                font=font,
            )
            draw.text(
                (x + 30, y + 1090),
                f"Trapped transparent pixels: {old['trapped_zero_alpha_pixels']} -> 0",
                fill=foreground,
                font=font,
            )
    sheet.save(ROOT / "previews/small-optical-comparison.png")
    (ROOT / "previews/small-optical-connectivity.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="ascii"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
