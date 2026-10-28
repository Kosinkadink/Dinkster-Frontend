"""Compose the repeatable review layout from Inkscape exports and the reference."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    args = parser.parse_args()
    reference = Image.open(args.reference).convert("RGB")
    font = ImageFont.truetype("DejaVuSans.ttf", 18)
    draft = Image.new("RGB", (892, 1036), "#111316")
    draw = ImageDraw.Draw(draft)
    draw.rectangle((0, 584, 892, 1036), fill="#F7F8FA")
    dark = Image.open(ROOT / "previews/wordmark-dark-2x.png")
    light = Image.open(ROOT / "previews/wordmark-light-2x.png")
    draft.paste(dark, (0, 0), dark)
    draft.paste(light, (0, 506), light)
    draw.text((140, 490), "MONOCHROME (LIGHT ON DARK)", fill="#F2F4F5", font=font)
    draw.text((140, 966), "MONOCHROME (DARK ON LIGHT)", fill="#1F242A", font=font)
    comparison = Image.new("RGB", (1824, 1670), "#E4E8EC")
    draw = ImageDraw.Draw(comparison)
    draw.text((20, 16), "REFERENCE - native size", fill="#1F242A", font=font)
    draw.text((486, 16), "PROPOSED LETTERS - native size", fill="#1F242A", font=font)
    comparison.paste(reference, (20, 50))
    comparison.paste(draft.resize((446, 518), Image.Resampling.LANCZOS), (486, 50))
    draw.text((20, 590), "REFERENCE - 2x", fill="#1F242A", font=font)
    draw.text((932, 590), "PROPOSED LETTERS - 2x", fill="#1F242A", font=font)
    comparison.paste(reference.resize((892, 1036), Image.Resampling.LANCZOS), (20, 624))
    comparison.paste(draft, (932, 624))
    comparison.save(ROOT / "previews/wordmark-reference-comparison.png")


if __name__ == "__main__":
    main()
