"""Show native 16-64 px exports beside an exact nearest-neighbor enlargement."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]


def main():
    sheet = Image.new("RGB", (360, 416), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("DejaVuSans.ttf", 12)
    for row, (background, variants) in enumerate(
        (("#111316", ("white", "cyan")), ("#F7F8FA", ("mono", "cyan")))
    ):
        y = row * 208
        draw.rectangle((0, y, 359, y + 207), fill=background)
        for line, variant in enumerate(variants):
            foreground = "#F2F4F5" if row == 0 else "#1F242A"
            draw.text(
                (12, y + line * 98 + 6),
                "mono" if variant != "cyan" else "cyan",
                fill=foreground,
                font=font,
            )
            x = 68
            for size in (16, 24, 32, 48, 64):
                im = Image.open(ROOT / f"raster/{variant}/{size}.png")
                sheet.paste(im, (x, y + line * 98 + 24 + 64 - size), im)
                draw.text((x, y + line * 98 + 8), str(size), fill=foreground, font=font)
                x += size + 12
    sheet.save(ROOT / "previews/size-proof-native.png")
    sheet.resize((1440, 1664), Image.Resampling.NEAREST).save(
        ROOT / "previews/size-proof-zoomed-nearest.png"
    )


if __name__ == "__main__":
    main()
