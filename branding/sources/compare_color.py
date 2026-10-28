"""Compose native-size color and silhouette-coverage proofs from CLI exports."""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]


def main():
    font = ImageFont.truetype("DejaVuSans.ttf", 20)
    sheet = Image.new("RGB", (2112, 1450), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    for column, (name, background, foreground) in enumerate(
        (("dark", "#111316", "#F2F4F5"), ("light", "#F7F8FA", "#1F242A"))
    ):
        x = 16 + column * 1040
        draw.rectangle((x, 48, x + 1023, 1433), fill=background)
        draw.text(
            (x + 20, 12), f"CHROMATIC D - {name} - 1024 px", fill="#1F242A", font=font
        )
        icon = Image.open(ROOT / "raster/color/1024.png")
        sheet.paste(icon, (x, 48), icon)
        small = Image.open(ROOT / "raster/color/256.png")
        sheet.paste(small, (x + 48, 1120), small)
        draw.text(
            (x + 320, 1220),
            "256 px - same geometry, no effects",
            fill=foreground,
            font=font,
        )
    sheet.save(ROOT / "previews/color-dark-light.png")
    proof = Image.new("RGB", (1600, 600), "#E4E8EC")
    draw = ImageDraw.Draw(proof)
    for index, size in enumerate((64, 256, 1024)):
        mono = np.asarray(Image.open(ROOT / f"raster/mono/{size}.png"))[:, :, 3]
        color = np.asarray(Image.open(ROOT / f"raster/color/{size}.png"))[:, :, 3]
        difference = mono != color
        assert not difference.any(), f"Silhouette mismatch at {size}px"
        # Neutral coverage means agreement; red would indicate disagreement.
        overlay = np.full((size, size, 3), 247, dtype=np.uint8)
        overlay[mono > 0] = (31, 36, 42)
        overlay[difference] = (255, 0, 0)
        image = Image.fromarray(overlay).resize((480, 480), Image.Resampling.NEAREST)
        x = 20 + index * 525
        proof.paste(image, (x, 50))
        draw.text(
            (x, 15), f"{size} px mono/color alpha overlay", fill="#1F242A", font=font
        )
        draw.text(
            (x, 550), "0 differing pixels (red = mismatch)", fill="#1F242A", font=font
        )
    proof.save(ROOT / "previews/mono-color-overlay.png")


if __name__ == "__main__":
    main()
