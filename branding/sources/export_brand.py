"""Export vectors and raster proofs with Inkscape, retaining exact CLI commands."""

import argparse
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
    wordmarks = parser.add_mutually_exclusive_group()
    wordmarks.add_argument("--regular-wordmark-only", action="store_true")
    wordmarks.add_argument("--wordmarks-only", action="store_true")
    args = parser.parse_args()
    commands = []

    def export(source, destination, *options):
        command = [
            args.inkscape,
            str(source),
            *options,
            f"--export-filename={destination}",
        ]
        commands.append(shlex.join(command))
        subprocess.run(command, check=True)

    version = subprocess.check_output([args.inkscape, "--version"], text=True).strip()
    master = ROOT / "sources/Dinkster_Master.svg"
    for variant, y in (
        ("mono", 0),
        ("dark", 1000),
        ("light", 2000),
        ("heavier-dark", 4000),
        ("heavier-light", 5000),
        ("color-dark", 8000),
        ("color-light", 9000),
    ):
        if args.regular_wordmark_only and variant.startswith("heavier"):
            continue
        width = 1024 if variant.startswith("heavier") else 1000
        options = (
            f"--export-id=wordmark-{variant}",
            "--export-id-only",
            f"--export-area=-60:{y - 250}:{width * 1.7 - 60}:{y + 630.6}",
        )
        export(
            master,
            ROOT / f"svg/dinkster-wordmark-{variant}.svg",
            "--export-type=svg",
            "--export-plain-svg",
            *options,
        )
        export(
            master,
            ROOT / f"previews/wordmark-{variant}-2x.png",
            "--export-type=png",
            f"--export-width={width}",
            "--export-height=518",
            *options,
        )
    for variant in ("mono", "cyan", "white", "color", "dark", "light"):
        if args.regular_wordmark_only or args.wordmarks_only:
            break
        symbol = {"dark": "white", "light": "mono"}.get(variant, variant)
        options = (
            f"--export-id=symbol-{symbol}",
            "--export-id-only",
            "--export-area=0:3000:1000:4000",
        )
        export(
            master,
            ROOT / f"svg/dinkster-symbol-{variant}.svg",
            "--export-type=svg",
            "--export-plain-svg",
            *options,
        )
        for size in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
            destination = ROOT / f"raster/{variant}/{size}.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
            raster_options = options
            if size in (16, 24):
                raster_options = (
                    f"--export-id=symbol-small-{size}-{symbol}",
                    *options[1:],
                )
            export(
                master,
                destination,
                "--export-type=png",
                f"--export-width={size}",
                f"--export-height={size}",
                *raster_options,
            )
    export(
        master,
        ROOT / "previews/letters-enlarged.png",
        "--export-type=png",
        "--export-id=letter-sheet",
        "--export-id-only",
        "--export-area=0:7000:560:7260",
        "--export-width=1680",
        "--export-height=780",
    )
    record = (
        "wordmark-export-commands.txt"
        if args.regular_wordmark_only or args.wordmarks_only
        else "export-commands.txt"
    )
    (ROOT / "sources" / record).write_text(
        version + "\n" + "\n".join(commands) + "\n", encoding="ascii"
    )
    if not (args.regular_wordmark_only or args.wordmarks_only):
        subprocess.run(
            [sys.executable, str(ROOT / "sources/package_icons.py")], check=True
        )


if __name__ == "__main__":
    main()
