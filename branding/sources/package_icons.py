"""Package the exact CLI-exported color PNGs without resizing or re-encoding."""

import shlex
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = ROOT / "platform"
    output.mkdir(exist_ok=True)
    sizes = (16, 24, 32, 48, 64, 128, 256)
    pngs = {size: (ROOT / f"raster/color/{size}.png").read_bytes() for size in sizes}
    directory = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))
    offset = 6 + 16 * len(sizes)
    for size in sizes:
        data = pngs[size]
        directory.extend(
            struct.pack(
                "<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset
            )
        )
        offset += len(data)
    (output / "dinkster.ico").write_bytes(bytes(directory) + b"".join(pngs.values()))
    chunks = []
    for kind, size in (
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
        (b"ic11", 32),
        (b"ic12", 64),
        (b"ic13", 256),
        (b"ic14", 512),
    ):
        data = (ROOT / f"raster/color/{size}.png").read_bytes()
        chunks.append(kind + struct.pack(">I", 8 + len(data)) + data)
    payload = b"".join(chunks)
    (output / "dinkster.icns").write_bytes(
        b"icns" + struct.pack(">I", 8 + len(payload)) + payload
    )
    (ROOT / "sources/platform-export-command.txt").write_text(
        shlex.join([sys.executable, str(Path(__file__).resolve())]) + "\n",
        encoding="ascii",
    )


if __name__ == "__main__":
    main()
