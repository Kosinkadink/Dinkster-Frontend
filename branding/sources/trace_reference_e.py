"""Trace the supplied raster e at 2x and show the uncorrected contour fit."""

import argparse
import io
import shlex
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import cairosvg
import numpy as np
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import binary_dilation, binary_erosion, label

ROOT = Path(__file__).resolve().parents[1]
NS = "http://www.w3.org/2000/svg"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("--potrace", required=True)
    args = parser.parse_args()
    reference = Image.open(args.reference).convert("RGB")
    # Keep source pixel coordinates: guides are y=134 and y=178.
    crop = reference.resize((892, 1036), Image.Resampling.LANCZOS).crop(
        (672, 260, 776, 364)
    )
    components, _ = label(np.asarray(crop)[:, :, 0] > 128)
    selected = components[20, 48]
    assert selected != 0
    mask = components == selected
    bitmap = ROOT / "sources/reference-e-2x.pbm"
    Image.fromarray(np.where(mask, 0, 255).astype("uint8")).convert("1").save(bitmap)
    command = [
        args.potrace,
        "--svg",
        "--flat",
        "--alphamax=1",
        "--opttolerance=0.2",
        "--unit=100",
        str(bitmap),
        "--output",
        "-",
    ]
    svg = ET.fromstring(subprocess.check_output(command))
    paths = svg.findall(f".//{{{NS}}}path")
    pen = SVGPathPen(None)
    # Potrace uses bottom-up hundredths of a 2x pixel. Map the reference
    # x-height band uniformly from 44 source pixels to 42 lettering units.
    scale = 42 / 44
    transform = (scale / 200, 0, 0, -scale / 200, -2 * scale, 14 + 48 * scale)
    for path in paths:
        parse_path(path.get("d"), TransformPen(pen, transform))
    contour = pen.getCommands()
    source = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 10 54 50">'
        f'<path fill-rule="evenodd" d="{contour}"/></svg>\n'
    )
    (ROOT / "sources/reference-e.svg").write_text(source, encoding="ascii")
    version = subprocess.check_output([args.potrace, "--version"], text=True)
    (ROOT / "sources/e-trace-command.txt").write_text(
        version.splitlines()[0]
        + "\n"
        + shlex.join(command)
        + "\nInput: reference light-on-dark, crop (336,130)-(388,182), at 2x.\n"
        + "Threshold: red > 128; retain connected e component.\n"
        + "Uniform map: x=(source_x-338)*42/44; y=14+(source_y-134)*42/44.\n"
        + "Rerun: "
        + shlex.join(
            [
                "python",
                str(Path(__file__)),
                str(args.reference),
                "--potrace",
                args.potrace,
            ]
        )
        + "\n",
        encoding="ascii",
    )
    # Inverse mapping overlays the trace at its original 2x pixel position.
    inverse = 2 / scale
    overlay_svg = (
        f'<svg xmlns="{NS}" width="104" height="104" viewBox="0 0 104 104">'
        f'<path fill="white" fill-rule="evenodd" transform="translate(4 {8 - 14 * inverse}) scale({inverse})" '
        f'd="{contour}"/></svg>'
    )
    alpha = np.asarray(
        Image.open(io.BytesIO(cairosvg.svg2png(bytestring=overlay_svg.encode())))
    )[:, :, 3]
    fitted = alpha >= 128
    intersection = (fitted & mask).sum()
    union = (fitted | mask).sum()
    print(f"Reference/trace 2x threshold IoU: {intersection / union:.6f}")
    reference_edge = mask & ~binary_erosion(mask)
    fit_edge = fitted & ~binary_erosion(fitted)
    panels = []
    for width in (1, 2):
        panel = crop.copy()
        a = np.array(panel)
        a[binary_dilation(reference_edge, iterations=width)] = (50, 183, 203)
        a[binary_dilation(fit_edge, iterations=width)] = (240, 112, 96)
        panels.append(Image.fromarray(a))
    difference = np.full((104, 104, 3), (17, 19, 22), dtype=np.uint8)
    difference[mask & fitted] = (170, 175, 180)
    difference[mask & ~fitted] = (50, 183, 203)
    difference[fitted & ~mask] = (240, 112, 96)
    panels.append(Image.fromarray(difference))
    sheet = Image.new("RGB", (1680, 860), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("DejaVuSans.ttf", 18)
    draw.text(
        (24, 18),
        "REFERENCE e TRACE - no optical corrections",
        fill="#1F242A",
        font=font,
    )
    draw.text(
        (24, 52),
        "Cyan: reference outline / reference-only fill. Coral: trace outline / trace-only fill.",
        fill="#1F242A",
        font=font,
    )
    draw.text(
        (24, 82),
        f"Trace at 2x; threshold 128; IoU {intersection / union:.4%}. Gray: common fill. Zoom: nearest neighbor.",
        fill="#1F242A",
        font=font,
    )
    for index, (panel, title) in enumerate(
        zip(
            panels,
            (
                "Thin outlines over reference",
                "Bold outlines over reference",
                "Filled difference at threshold 128",
            ),
        )
    ):
        x = 24 + index * 552
        draw.text((x, 130), title, fill="#1F242A", font=font)
        sheet.paste(panel.resize((520, 520), Image.Resampling.NEAREST), (x, 166))
    draw.text(
        (24, 710),
        "Source crop: (336,130)-(388,182). Trace shown in source registration, not manually aligned.",
        fill="#1F242A",
        font=font,
    )
    draw.text(
        (24, 742),
        "Uniform wordmark scale: 42/44. Reference x-height y134 / baseline y178 -> lettering y14 / y56.",
        fill="#1F242A",
        font=font,
    )
    draw.text(
        (24, 774),
        "Raster threshold and curve fit are visible in the difference; this is not a claim of pixel identity.",
        fill="#1F242A",
        font=font,
    )
    sheet.save(ROOT / "previews/e-reference-overlay.png")


if __name__ == "__main__":
    main()
