"""Compose the repeatable review layout from Inkscape exports and the reference."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--caption", default="Reference-traced e; selected D unchanged")
    parser.add_argument("--dark-reference-only", action="store_true")
    parser.add_argument("--letter-scale", type=float, default=1.0)
    parser.add_argument("--baseline-shift", type=float, default=0.0)
    parser.add_argument("--native-width", type=int, default=446)
    args = parser.parse_args()
    reference = Image.open(args.reference).convert("RGB")
    if args.dark_reference_only:
        lower = reference.copy()
        reference = Image.new("RGB", (446, 518), "#111316")
        reference.paste(lower.crop((0, 292, 446, 518)), (0, 292))
        reference.paste(ImageOps.invert(lower.crop((0, 310, 446, 447))), (0, 56))
        ImageDraw.Draw(reference).text(
            (70, 245),
            "DARK-ON-LIGHT REFERENCE - INVERTED",
            fill="#F2F4F5",
            font=ImageFont.truetype("DejaVuSans.ttf", 9),
        )
    native_width = args.native_width
    if native_width != reference.width:
        padded = Image.new("RGB", (native_width, 518), "#111316")
        ImageDraw.Draw(padded).rectangle((0, 292, native_width, 518), fill="#F7F8FA")
        padded.paste(reference, (0, 0))
        reference = padded
    native_x = native_width + 40
    double_x = native_width * 2 + 40
    font = ImageFont.truetype("DejaVuSans.ttf", 18)
    drafts = []
    for prefix in (args.prefix,):
        width = native_width * 2
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
            positions = tuple(
                2 * (178 + args.baseline_shift + (y - 178) * args.letter_scale)
                for y in (122, 136, 178)
            )
            for (_, color), y in zip(guides, positions):
                guide_draw.line(
                    (280, y + offset, width - 22, y + offset), fill=color, width=1
                )
    comparison = Image.new("RGB", (native_width * 4 + 60, 1670), "#E4E8EC")
    draw = ImageDraw.Draw(comparison)
    draw.text((20, 16), "REFERENCE - native size", fill="#1F242A", font=font)
    draw.text((native_x, 16), "CURRENT WEIGHT - native size", fill="#1F242A", font=font)
    for index, (name, color) in enumerate(guides):
        draw.text(
            (double_x + 20, 64 + index * 28), f"{name} guide", fill=color, font=font
        )
    draw.text(
        (double_x + 20, 170),
        args.caption,
        fill="#1F242A",
        font=font,
    )
    if args.dark_reference_only:
        draw.text(
            (double_x + 20, 205),
            "Upper reference: lower artwork inverted",
            fill="#1F242A",
            font=font,
        )
    comparison.paste(reference, (20, 50))
    for index, draft in enumerate(drafts):
        comparison.paste(
            draft.resize((draft.width // 2, 518), Image.Resampling.LANCZOS),
            (native_x + index * (native_width + 20), 50),
        )
    draw.text((20, 590), "REFERENCE - 2x", fill="#1F242A", font=font)
    draw.text((double_x, 590), "CURRENT WEIGHT - 2x", fill="#1F242A", font=font)
    comparison.paste(
        reference.resize((native_width * 2, 1036), Image.Resampling.LANCZOS), (20, 624)
    )
    for index, draft in enumerate(drafts):
        comparison.paste(draft, (double_x + index * (native_width * 2 + 20), 624))
    comparison.save(ROOT / f"previews/wordmark-{args.prefix}reference-comparison.png")
    if args.prefix:
        return
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
