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
        command = [args.inkscape, str(source), *options, f"--export-filename={destination}"]
        commands.append(shlex.join(command))
        subprocess.run(command, check=True)

    version = subprocess.check_output([args.inkscape, "--version"], text=True).strip()
    master = ROOT / "sources/Dinkster_Master.svg"
    for index, variant in enumerate(("mono", "dark", "light")):
        options = (f"--export-id=wordmark-{variant}", "--export-id-only", f"--export-area=-60:{index * 1000 - 250}:1456.4:{index * 1000 + 630.6}")
        export(master, ROOT / f"svg/dinkster-wordmark-{variant}.svg", "--export-type=svg", "--export-plain-svg", *options)
        export(master, ROOT / f"previews/wordmark-{variant}-2x.png", "--export-type=png", "--export-width=892", "--export-height=518", *options)
    export(ROOT / "sources/letter-sheet.svg", ROOT / "previews/letters-enlarged.png", "--export-type=png")
    (ROOT / "sources/export-commands.txt").write_text(version + "\n" + "\n".join(commands) + "\n", encoding="ascii")


if __name__ == "__main__":
    main()
