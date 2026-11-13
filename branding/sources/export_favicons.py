"""Frame the approved D tightly for browser icons without changing its artwork."""

import argparse
import re
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
    args = parser.parse_args()
    source = ROOT / "svg/dinkster-symbol-color.svg"
    bounds = subprocess.check_output(
        [
            args.inkscape,
            str(source),
            "--query-id=silhouette-clip-path",
            "--query-x",
            "--query-y",
            "--query-width",
            "--query-height",
        ],
        text=True,
    )
    x, y, width, height = map(float, bounds.split())
    top = y + (height - width) / 2
    output = ROOT / "favicon"
    output.mkdir(exist_ok=True)
    svg = output / "favicon.svg"
    svg.write_text(
        re.sub(
            r'viewBox="[^"]+"',
            f'viewBox="{x:g} {top:g} {width:g} {width:g}"',
            source.read_text(encoding="utf-8"),
            count=1,
        ),
        encoding="utf-8",
    )
    for size in SIZES:
        subprocess.run(
            [
                args.inkscape,
                str(svg),
                "--export-type=png",
                "--export-area-page",
                f"--export-width={size}",
                f"--export-height={size}",
                f"--export-filename={output / f'{size}.png'}",
            ],
            check=True,
        )
    frames = {size: (output / f"{size}.png").read_bytes() for size in SIZES if size <= 256}
    directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + 16 * len(frames)
    for size, data in frames.items():
        directory.extend(
            struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        )
        offset += len(data)
    (output / "favicon.ico").write_bytes(bytes(directory) + b"".join(frames.values()))


if __name__ == "__main__":
    main()
