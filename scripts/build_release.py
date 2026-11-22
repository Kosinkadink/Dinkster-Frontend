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


def release_version(root: Path, tag: str | None, dev: bool) -> str:
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    if (
        not isinstance(version, str)
        or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) is None
    ):
        raise ValueError("frontend release version must be X.Y.Z")
    if dev:
        revision = int(
            subprocess.check_output(
                ["git", "rev-list", "--count", "HEAD"], cwd=root, text=True
            ).strip()
        )
        major, minor, patch = (int(part) for part in version.split("."))
        return f"{major}.{minor}.{patch + 1}.dev{revision}"
    if tag is not None and tag != f"v{version}":
        raise ValueError("release tag must match the frontend package version")
    return version


def build(
    root: Path,
    dist: Path,
    output: Path,
    tag: str | None = None,
    dev: bool = False,
    site: Path | None = None,
) -> Path:
    version = release_version(root, tag, dev)
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
    site = site if site is not None else root / "packages" / "site" / "dist"
    for required in (
        "account.html",
        "authorization.html",
        "callback.html",
        "about.html",
        "about.js",
        "desktop-library.html",
        "desktop-library.js",
        "desktop-chrome.js",
        "desktop-chrome.json",
        "account-view.js",
        "authorization.js",
        "manifest.json",
    ):
        if not (site / required).is_file():
            raise ValueError(f"site distribution must contain {required}")
    site_manifest = json.loads((site / "manifest.json").read_text(encoding="utf-8"))
    callback = site_manifest.get("callback", {})
    callback_html = (site / "callback.html").read_text(encoding="utf-8")
    style = re.search(r"<style>(.*?)</style>", callback_html, re.DOTALL)
    if style is None:
        raise ValueError("callback template must contain its embedded stylesheet")
    style_hash = base64.b64encode(hashlib.sha256(style[1].encode()).digest()).decode()
    callback_csp = (
        "default-src 'none'; script-src 'none'; connect-src 'none'; "
        f"style-src 'sha256-{style_hash}'; img-src data:; font-src data:; "
        "base-uri 'none'; form-action 'none'"
    )
    if (
        site_manifest.get("format") != "dinkster.site/1"
        or callback.get("template") != "callback.html"
        or callback.get("textSlots")
        != [
            "__CALLBACK_HEADING__",
            "__CALLBACK_MESSAGE__",
            "__CALLBACK_RETURN_LABEL__",
        ]
        or callback.get("destinationSlot") != "__CALLBACK_RETURN_URL__"
        or any(
            slot not in callback_html
            for slot in [*callback["textSlots"], callback["destinationSlot"]]
        )
        or callback.get("csp") != callback_csp
        or f'<meta http-equiv="Content-Security-Policy" content="{callback_csp}">'
        not in callback_html
        or site_manifest.get("files", {}).get("callback.html")
        != hashlib.sha256((site / "callback.html").read_bytes()).hexdigest()
    ):
        raise ValueError(
            "site distribution must contain a valid callback manifest contract"
        )
    chrome = json.loads((site / "desktop-chrome.json").read_text(encoding="utf-8"))
    if (
        chrome.get("format") != "dinkster.desktop-chrome/1"
        or chrome.get("installer") != "desktop-chrome.js"
        or not isinstance(chrome.get("css"), str)
        or not chrome["css"]
        or not isinstance(chrome.get("native"), dict)
        or any(
            site_manifest.get("files", {}).get(name)
            != hashlib.sha256((site / name).read_bytes()).hexdigest()
            for name in ("desktop-chrome.json", "desktop-chrome.js")
        )
    ):
        raise ValueError(
            "site distribution must contain a valid Desktop chrome contract"
        )
    sources = [(dist, ""), (site, "site/")]
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
        f"Project-URL: Source-Commit, https://github.com/Kosinkadink/Dinkster-Frontend/commit/{commit}\n"
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
    parser.add_argument("--site-dist", type=Path, default=Path("packages/site/dist"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--tag")
    mode.add_argument("--dev", action="store_true")
    args = parser.parse_args()
    print(
        build(
            Path(__file__).resolve().parents[1],
            args.dist,
            args.output,
            args.tag,
            args.dev,
            args.site_dist,
        )
    )
