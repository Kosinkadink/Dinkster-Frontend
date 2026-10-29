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
    for prefix in ("",):
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
    guides = (
        ("upper: i top / k,t slope start", "#32B7CB"),
        ("x-height", "#F07060"),
        ("baseline", "#C99B28"),
    )
    reference = reference.copy()
    reference_draw = ImageDraw.Draw(reference)
    for upper, xheight, baseline in ((122, 134, 178), (376, 388, 432)):
        for (_, color), y in zip(guides, (upper, xheight, baseline)):
            reference_draw.line((140, y, 430, y), fill=color, width=1)
    for draft in drafts:
        guide_draw = ImageDraw.Draw(draft)
        for offset in (0, 506):
            for (_, color), y in zip(guides, (244, 272, 356)):
                guide_draw.line((280, y + offset, 870, y + offset), fill=color, width=1)
    comparison = Image.new("RGB", (1844, 1670), "#E4E8EC")
    draw = ImageDraw.Draw(comparison)
    draw.text((20, 16), "REFERENCE - native size", fill="#1F242A", font=font)
    draw.text((486, 16), "CURRENT WEIGHT - native size", fill="#1F242A", font=font)
    for index, (name, color) in enumerate(guides):
        draw.text((952, 64 + index * 28), f"{name} guide", fill=color, font=font)
    draw.text(
        (952, 170),
        "Reference-traced e; selected D unchanged",
        fill="#1F242A",
        font=font,
    )
    comparison.paste(reference, (20, 50))
    for index, draft in enumerate(drafts):
        comparison.paste(
            draft.resize((draft.width // 2, 518), Image.Resampling.LANCZOS),
            (486 + index * 466, 50),
        )
    draw.text((20, 590), "REFERENCE - 2x", fill="#1F242A", font=font)
    draw.text((932, 590), "CURRENT WEIGHT - 2x", fill="#1F242A", font=font)
    comparison.paste(reference.resize((892, 1036), Image.Resampling.LANCZOS), (20, 624))
    for index, draft in enumerate(drafts):
        comparison.paste(draft, (932 + index * 912, 624))
    comparison.save(ROOT / "previews/wordmark-reference-comparison.png")
    letters = Image.open(ROOT / "previews/letters-enlarged.png").convert("RGBA")
    letter_comparison = Image.new("RGB", (1680, 440), "#F7F8FA")
    letter_comparison.paste(
        letters.crop((0, 0, 1680, 390)), (0, 50), letters.crop((0, 0, 1680, 390))
    )
    labels = ImageDraw.Draw(letter_comparison)
    labels.text(
        (24, 18),
        "REGULAR - blue: i top / k,t slope start; red: x-height; gold: baseline; magenta: k continuation",
        fill="#1F242A",
        font=font,
    )
    for (_, color), y in zip(guides, (110, 152, 278)):
        labels.line((8, y, 1672, y), fill=color, width=1)
    labels.line((504, 299, 651, 152), fill="#B750C8", width=1)
    letter_comparison.save(ROOT / "previews/letters-weight-comparison.png")


if __name__ == "__main__":
    main()
