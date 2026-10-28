"""Show native 16-64 px exports beside an exact nearest-neighbor enlargement."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]


def main():
    sheet = Image.new("RGB", (1128, 660), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("DejaVuSans.ttf", 12)
    for column, (option, title) in enumerate(
        (
            ("current", "CURRENT BODY - narrower 16/24 cut"),
            ("vertical-trim", "PROPOSED vertical trim + narrow cut"),
            ("rounded-trim", "PROPOSED rounded trim + narrow cut"),
        )
    ):
        offset = column * 376
        draw.text((offset + 8, 12), title, fill="#1F242A", font=font)
        for row, background in enumerate(("#111316", "#F7F8FA")):
            y = 36 + row * 312
            draw.rectangle((offset, y, offset + 359, y + 311), fill=background)
            foreground = "#F2F4F5" if row == 0 else "#1F242A"
            for line, variant in enumerate(("mono", "cyan", "color")):
                draw.text(
                    (offset + 12, y + line * 98 + 6),
                    variant,
                    fill=foreground,
                    font=font,
                )
                x = offset + 68
                for size in (16, 24, 32, 48, 64):
                    source = "color" if variant == "color" else "mono"
                    im = Image.open(
                        ROOT / f"previews/geometry-options/{option}-{source}-{size}.png"
                    ).convert("RGBA")
                    if variant != "color":
                        ink = Image.new(
                            "RGBA",
                            im.size,
                            "#32E6C5" if variant == "cyan" else foreground,
                        )
                        ink.putalpha(im.getchannel("A"))
                        im = ink
                    sheet.paste(im, (x, y + line * 98 + 24 + 64 - size), im)
                    draw.text(
                        (x, y + line * 98 + 8), str(size), fill=foreground, font=font
                    )
                    x += size + 12
    sheet.save(ROOT / "previews/size-proof-native.png")
    sheet.resize((sheet.width * 4, sheet.height * 4), Image.Resampling.NEAREST).save(
        ROOT / "previews/size-proof-zoomed-nearest.png"
    )


if __name__ == "__main__":
    main()
