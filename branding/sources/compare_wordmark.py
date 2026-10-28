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
    drafts = []
    for prefix in ("", "heavier-"):
        width = 1024 if prefix else 892
        draft = Image.new("RGB", (width, 1036), "#111316")
        draw = ImageDraw.Draw(draft)
        draw.rectangle((0, 584, width, 1036), fill="#F7F8FA")
        dark = Image.open(ROOT / f"previews/wordmark-{prefix}dark-2x.png")
        light = Image.open(ROOT / f"previews/wordmark-{prefix}light-2x.png")
        draft.paste(dark, (0, 0), dark)
        draft.paste(light, (0, 506), light)
        draw.text((140, 490), "MONOCHROME (LIGHT ON DARK)", fill="#F2F4F5", font=font)
        draw.text((140, 966), "MONOCHROME (DARK ON LIGHT)", fill="#1F242A", font=font)
        drafts.append(draft)
    comparison = Image.new("RGB", (2868, 1670), "#E4E8EC")
    draw = ImageDraw.Draw(comparison)
    draw.text((20, 16), "REFERENCE - native size", fill="#1F242A", font=font)
    draw.text((486, 16), "CURRENT WEIGHT - native size", fill="#1F242A", font=font)
    draw.text((952, 16), "HEAVIER WEIGHT - native size", fill="#1F242A", font=font)
    comparison.paste(reference, (20, 50))
    for index, draft in enumerate(drafts):
        comparison.paste(
            draft.resize((draft.width // 2, 518), Image.Resampling.LANCZOS),
            (486 + index * 466, 50),
        )
    draw.text((20, 590), "REFERENCE - 2x", fill="#1F242A", font=font)
    draw.text((932, 590), "CURRENT WEIGHT - 2x", fill="#1F242A", font=font)
    draw.text(
        (1844, 590),
        "HEAVIER WEIGHT - 2x (stems match the D)",
        fill="#1F242A",
        font=font,
    )
    comparison.paste(reference.resize((892, 1036), Image.Resampling.LANCZOS), (20, 624))
    for index, draft in enumerate(drafts):
        comparison.paste(draft, (932 + index * 912, 624))
    comparison.save(ROOT / "previews/wordmark-reference-comparison.png")
    letters = Image.open(ROOT / "previews/letters-enlarged.png").convert("RGBA")
    letter_comparison = Image.new("RGB", (1680, 880), "#F7F8FA")
    letter_comparison.paste(
        letters.crop((0, 0, 1680, 390)), (0, 50), letters.crop((0, 0, 1680, 390))
    )
    letter_comparison.paste(
        letters.crop((0, 390, 1680, 780)), (0, 490), letters.crop((0, 390, 1680, 780))
    )
    labels = ImageDraw.Draw(letter_comparison)
    labels.text(
        (24, 18),
        "CURRENT WEIGHT - revised i / k / e, uniform exterior spacing",
        fill="#1F242A",
        font=font,
    )
    labels.text(
        (24, 458),
        "HEAVIER WEIGHT - D-matched stems and gap-driven spacing / counters",
        fill="#1F242A",
        font=font,
    )
    letter_comparison.save(ROOT / "previews/letters-weight-comparison.png")


if __name__ == "__main__":
    main()
