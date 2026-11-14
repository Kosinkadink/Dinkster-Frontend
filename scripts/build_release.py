"""Build the versioned frontend wheel without a Python build environment."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path


def build(root: Path, dist: Path, output: Path, tag: str | None = None) -> Path:
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    if (
        not isinstance(version, str)
        or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) is None
    ):
        raise ValueError("frontend release version must be X.Y.Z")
    if tag is not None and tag != f"v{version}":
        raise ValueError("release tag must match the frontend package version")
    api = json.loads((root / "frontend-release.json").read_text(encoding="utf-8"))[
        "engineApi"
    ]
    if (
        not isinstance(api, dict)
        or type(api.get("min")) is not int
        or type(api.get("max")) is not int
        or not 1 <= api["min"] <= api["max"]
    ):
        raise ValueError(
            "engineApi must declare an inclusive positive integer min/max range"
        )
    if not (dist / "index.html").is_file():
        raise ValueError("frontend distribution must contain index.html")
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    manifest = {
        "format": "dinkster.frontend/1",
        "version": version,
        "repository": "Kosinkadink/Dinkster-Frontend",
        "commit": commit,
        "engineApi": api,
    }
    files = {
        "dinkster_frontend/__init__.py": b'"""Versioned Dinkster browser assets."""\n',
        "dinkster_frontend/manifest.json": (
            json.dumps(manifest, indent=2) + "\n"
        ).encode(),
    }
    sources = [(dist, "")]
    sources.extend(
        (root / "branding" / directory, f"branding/{directory}/")
        for directory in (
            "platform",
            "raster/color",
            "raster/mono",
            "svg",
            "tokens",
            "favicon",
        )
    )
    for source, prefix in sources:
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("frontend distribution must not contain symlinks")
            if path.is_file():
                files[
                    f"dinkster_frontend/static/{prefix}{path.relative_to(source).as_posix()}"
                ] = path.read_bytes()
    metadata = f"dinkster_frontend-{version}.dist-info"
    files[f"{metadata}/METADATA"] = (
        f"Metadata-Version: 2.1\nName: dinkster-frontend\nVersion: {version}\n"
        "Summary: Versioned Dinkster browser assets\nRequires-Python: >=3.10\n"
        "Description-Content-Type: text/plain\n\n"
        "Built browser application and canonical branding for Dinkster.\n"
    ).encode()
    files[f"{metadata}/WHEEL"] = (
        b"Wheel-Version: 1.0\nGenerator: dinkster-frontend\nRoot-Is-Purelib: true\n"
        b"Tag: py3-none-any\n"
    )
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for name, payload in sorted(files.items()):
        digest = (
            base64.urlsafe_b64encode(hashlib.sha256(payload).digest())
            .rstrip(b"=")
            .decode()
        )
        writer.writerow((name, f"sha256={digest}", len(payload)))
    writer.writerow((f"{metadata}/RECORD", "", ""))
    files[f"{metadata}/RECORD"] = record.getvalue().encode()
    output.mkdir(parents=True, exist_ok=True)
    wheel = output / f"dinkster_frontend-{version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in sorted(files.items()):
            entry = zipfile.ZipInfo(name)
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, payload)
    release = {
        **manifest,
        "file": wheel.name,
        "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "size": wheel.stat().st_size,
    }
    (output / "frontend-manifest.json").write_text(
        json.dumps(release, indent=2) + "\n", encoding="utf-8"
    )
    (output / "SHA256SUMS").write_text(
        "".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
            for path in (wheel, output / "frontend-manifest.json")
        ),
        encoding="ascii",
    )
    return wheel


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=Path("packages/app/dist"))
    parser.add_argument("--output", type=Path, default=Path("dist"))
    parser.add_argument("--tag")
    args = parser.parse_args()
    print(build(Path(__file__).resolve().parents[1], args.dist, args.output, args.tag))
