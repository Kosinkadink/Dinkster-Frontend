"""Show native 16-64 px exports beside an exact nearest-neighbor enlargement."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]


def main():
    sheet = Image.new("RGB", (1120, 450), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("DejaVuSans.ttf", 16)
    draw.text(
        (16, 14),
        "SELECTED D - exact production exports; no small-size contour changes",
        fill="#1F242A",
        font=font,
    )
    for column, (theme, background, foreground) in enumerate(
        (("dark", "#111316", "#F2F4F5"), ("light", "#F7F8FA", "#1F242A"))
    ):
        x0 = column * 560
        draw.rectangle((x0 + 8, 48, x0 + 551, 439), fill=background)
        for row, variant in enumerate((theme, "cyan", "color")):
            y = 70 + row * 120
            draw.text(
                (x0 + 24, y),
                "mono" if variant == theme else variant,
                fill=foreground,
                font=font,
            )
            x = x0 + 120
            for size in (16, 24, 32, 48, 64):
                image = Image.open(ROOT / f"raster/{variant}/{size}.png").convert(
                    "RGBA"
                )
                sheet.paste(image, (x, y + 90 - size), image)
                draw.text((x, y), str(size), fill=foreground, font=font)
                x += size + 24
    sheet.save(ROOT / "previews/size-proof-native.png")
    sheet.resize((sheet.width * 4, sheet.height * 4), Image.Resampling.NEAREST).save(
        ROOT / "previews/size-proof-zoomed-nearest.png"
    )


if __name__ == "__main__":
    main()
