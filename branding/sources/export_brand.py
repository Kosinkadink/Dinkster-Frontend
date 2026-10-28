"""Export vectors and raster proofs with Inkscape, retaining exact CLI commands."""

import argparse
from pathlib import Path
import shlex
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inkscape", default="inkscape")
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
    for index, variant in enumerate(
        ("mono", "dark", "light", "heavier-dark", "heavier-light")
    ):
        y = (index if index < 3 else index + 1) * 1000
        options = (
            f"--export-id=wordmark-{variant}",
            "--export-id-only",
            f"--export-area=-60:{y - 250}:1456.4:{y + 630.6}",
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
            "--export-width=892",
            "--export-height=518",
            *options,
        )
    for variant in ("mono", "cyan", "white", "color"):
        options = (
            f"--export-id=symbol-{variant}",
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
            if size in (16, 24) and variant != "color":
                raster_options = (
                    f"--export-id=symbol-small-{size}-{variant}",
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
    (ROOT / "sources/export-commands.txt").write_text(
        version + "\n" + "\n".join(commands) + "\n", encoding="ascii"
    )


if __name__ == "__main__":
    main()
