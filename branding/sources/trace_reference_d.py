"""Trace only the dark-on-light D and render isolated wordmark proposals."""

import argparse
import io
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import cairosvg
import numpy as np
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import binary_dilation, binary_erosion, label

ROOT = Path(__file__).resolve().parents[1]
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)


def reversed_segment(operations, start):
    result = RecordingPen()
    reverse = ReverseContourPen(result)
    reverse.moveTo(start)
    for operation, points in operations:
        getattr(reverse, operation)(*points)
    reverse.endPath()
    return result.value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("--potrace", required=True)
    parser.add_argument("--inkscape", required=True)
    args = parser.parse_args()
    output = ROOT / "previews/reference-d-options"
    output.mkdir(exist_ok=True)
    reference = Image.open(args.reference).convert("RGB")
    crop = reference.resize((892, 1036), Image.Resampling.LANCZOS).crop(
        (44, 692, 294, 894)
    )
    components, _ = label(np.asarray(crop)[:, :, 0] < 128)
    body, island = components[40, 100], components[130, 80]
    assert body and island and body != island
    mask = np.isin(components, (body, island))
    bitmap = output / "dark-on-light-d-2x.pbm"
    Image.fromarray(np.where(mask, 0, 255).astype("uint8")).convert("1").save(bitmap)
    command = [
        args.potrace,
        "--svg",
        "--flat",
        "--unit=100",
        str(bitmap),
        "--output",
        "-",
    ]
    traced = ET.fromstring(subprocess.check_output(command))
    raw = traced.find(f".//{{{NS}}}path").get("d")
    # Native reference coordinates with the lower reference's 254px row offset
    # removed. No fit-to-bounds, anisotropic scaling or optical changes.
    native = RecordingPen()
    parse_path(raw, TransformPen(native, (0.005, 0, 0, -0.005, 22, 193)))
    trace = RecordingPen()
    native.replay(
        TransformPen(trace, (1 / 0.139, 0, 0, 1 / 0.139, -16.9 / 0.139, -76.6 / 0.139))
    )
    full = SVGPathPen(None)
    trace.replay(full)
    approved = RecordingPen()
    approved_path = ET.parse(ROOT / "sources/constructed-d.svg").getroot()[0].get("d")
    parse_path(approved_path, approved)
    # These spans retain the exterior through the selected partial r24, then
    # reverse the traced inner boundary from the lower channel to upper lip.
    # Straight connectors expose the splice rather than alter traced curves.
    assert len(trace.value) == 36 and len(approved.value) == 127
    inner_body = reversed_segment(trace.value[3:11], trace.value[2][1][-1])
    inner_island = reversed_segment(
        trace.value[30:35] + trace.value[22:23], trace.value[29][1][-1]
    )
    hybrid = SVGPathPen(None)
    hybrid.moveTo(inner_body[0][1][0])
    for operation, points in inner_body[1:-1]:
        getattr(hybrid, operation)(*points)
    hybrid.lineTo(approved.value[111][1][-1])
    hybrid.closePath()
    body_inner = hybrid.getCommands()
    hybrid = SVGPathPen(None)
    hybrid.moveTo(inner_island[0][1][0])
    for operation, points in inner_island[1:-1]:
        getattr(hybrid, operation)(*points)
    hybrid.closePath()
    # Preserve the actual SVG arcs outside the counter, not parse_path's
    # cubic approximations to circles. Each splice starts at an explicit M.
    body_outer = approved_path.split(" L498.1 638.6", 1)[0]
    stem = approved_path.split(" Z M", 1)[1]
    stem_outer = stem[
        stem.index("L257.1 823.2") : stem.index(" L333.4 569.7") + len(" L333.4 569.7")
    ]
    hybrid_path = (
        body_outer
        + " L"
        + body_inner[1:]
        + " M"
        + stem_outer[1:]
        + " L"
        + hybrid.getCommands()[1:]
    )
    commands = [
        subprocess.check_output([args.inkscape, "--version"], text=True).strip()
    ]

    def export(source, destination, *options):
        cli = [args.inkscape, str(source), *options, f"--export-filename={destination}"]
        subprocess.run(cli, check=True)
        commands.append(shlex.join(cli))

    for name, contour in (
        ("full-trace", full.getCommands()),
        ("counter-only", hybrid_path),
    ):
        symbol = ET.Element(f"{{{NS}}}svg", {"viewBox": "0 0 1000 1000"})
        ET.SubElement(
            symbol,
            f"{{{NS}}}path",
            {"d": contour, "fill": "#1F242A", "fill-rule": "evenodd"},
        )
        symbol_source = output / f"{name}.svg"
        ET.ElementTree(symbol).write(
            symbol_source, encoding="utf-8", xml_declaration=True
        )
        export(
            symbol_source,
            output / f"{name}-1024.png",
            "--export-type=png",
            "--export-width=1024",
            "--export-height=1024",
        )
        # Copy the master in memory. Nothing in sources/, svg/, raster/ or
        # platform/ is rewritten; each copied letter keeps its transform.
        for variant, y in (("dark", 1000), ("light", 2000)):
            master = ET.parse(ROOT / "sources/Dinkster_Master.svg").getroot()
            for element in master.iter():
                if element.get("id") == f"wordmark-{variant}-d":
                    element.set("d", contour)
                    element.set("fill-rule", "evenodd")
            source = output / f"{name}-{variant}-master.svg"
            ET.ElementTree(master).write(source, encoding="utf-8", xml_declaration=True)
            export(
                source,
                ROOT / f"previews/wordmark-{name}-{variant}-2x.png",
                "--export-type=png",
                f"--export-id=wordmark-{variant}",
                "--export-id-only",
                f"--export-area=-60:{y - 250}:1456.3999999999999:{y + 630.6}",
                "--export-width=892",
                "--export-height=518",
            )
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "sources/compare_wordmark.py"),
                str(args.reference),
                "--prefix",
                name + "-",
                "--caption",
                "A: full dark-on-light trace"
                if name == "full-trace"
                else "B: approved exterior + traced counter",
                "--dark-reference-only",
            ],
            check=True,
        )
    commands.insert(
        0,
        subprocess.check_output([args.potrace, "--version"], text=True).splitlines()[0],
    )
    commands.insert(1, shlex.join(command))
    commands.append(
        "Rerun: "
        + shlex.join(
            [
                sys.executable,
                str(Path(__file__)),
                str(args.reference),
                "--potrace",
                args.potrace,
                "--inkscape",
                args.inkscape,
            ]
        )
    )
    (output / "commands.txt").write_text("\n".join(commands) + "\n", encoding="ascii")
    # Overlay the full trace in the original 2x crop registration.
    overlay_svg = f'<svg xmlns="{NS}" width="250" height="202"><path fill="white" fill-rule="evenodd" transform="translate(-10.2 -30.8) scale(.278)" d="{full.getCommands()}"/></svg>'
    alpha = np.asarray(
        Image.open(io.BytesIO(cairosvg.svg2png(bytestring=overlay_svg.encode())))
    )[:, :, 3]
    fitted = alpha >= 128
    common = int((mask & fitted).sum())
    missed = int((mask & ~fitted).sum())
    extra = int((~mask & fitted).sum())
    iou = common / (common + missed + extra)
    print(
        f"2x full-D IoU {iou:.8%}; shared {common}; reference-only {missed}; trace-only {extra}"
    )
    reference_edge = mask & ~binary_erosion(mask)
    trace_edge = fitted & ~binary_erosion(fitted)
    panels = []
    for width in (0, 1):
        panel = np.array(crop)
        a = (
            binary_dilation(reference_edge, iterations=width)
            if width
            else reference_edge
        )
        b = binary_dilation(trace_edge, iterations=width) if width else trace_edge
        panel[a] = (50, 183, 203)
        panel[b] = (240, 112, 96)
        panels.append(Image.fromarray(panel))
    difference = np.full((202, 250, 3), (247, 248, 250), dtype=np.uint8)
    difference[mask & fitted] = (100, 105, 110)
    difference[mask & ~fitted] = (50, 183, 203)
    difference[~mask & fitted] = (240, 112, 96)
    panels.append(Image.fromarray(difference))
    sheet = Image.new("RGB", (2320, 940), "#E4E8EC")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("DejaVuSans.ttf", 20)
    for y, text in (
        (
            18,
            "DARK-ON-LIGHT REFERENCE D ONLY - direct 2x trace; no optical corrections",
        ),
        (
            54,
            "Cyan: reference / reference-only. Coral: trace / trace-only. Gray: common fill.",
        ),
        (
            90,
            f"Fixed-registration IoU {iou:.5%}; common {common}; reference-only {missed}; trace-only {extra}.",
        ),
    ):
        draw.text((24, y), text, font=font, fill="#1F242A")
    for index, (panel, title) in enumerate(
        zip(
            panels,
            (
                "Thin outlines over reference",
                "Bold outlines over reference",
                "Filled threshold difference",
            ),
        )
    ):
        x = 24 + index * 768
        draw.text((x, 144), title, font=font, fill="#1F242A")
        sheet.paste(panel.resize((750, 606), Image.Resampling.NEAREST), (x, 184))
    draw.text(
        (24, 820),
        "Reference crop: (22,346)-(147,447), enlarged 2x before threshold red<128. No light-on-dark D used.",
        font=font,
        fill="#1F242A",
    )
    draw.text(
        (24, 860),
        "Candidate B keeps approved outside edges; traced inner body and island faces use visible straight splice joins.",
        font=font,
        fill="#1F242A",
    )
    sheet.save(ROOT / "previews/d-dark-reference-overlay.png")


if __name__ == "__main__":
    main()
