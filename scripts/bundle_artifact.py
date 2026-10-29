"""Archive the built frontend with a content-addressed manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path


def publish_bundle(dist: Path, output: Path) -> dict[str, object]:
    root = Path(__file__).resolve().parents[1]
    if not (dist / "index.html").is_file():
        raise ValueError("frontend distribution must contain index.html")
    files = sorted(dist.rglob("*"))
    if any(path.is_symlink() for path in files):
        raise ValueError("frontend distribution must not contain symlinks")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "bundle.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
        for path in files:
            if path.is_file():
                entry = zipfile.ZipInfo(path.relative_to(dist).as_posix())
                entry.external_attr = 0o100644 << 16
                bundle.writestr(entry, path.read_bytes())
    manifest = {
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip(),
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "size": archive.stat().st_size,
        "version": json.loads((root / "package.json").read_text(encoding="utf-8"))[
            "version"
        ],
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=Path("packages/app/dist"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = publish_bundle(args.dist, args.output)
    print(f"dinkster-frontend-{manifest['sha256']}")
