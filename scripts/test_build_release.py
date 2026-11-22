"""Regression tests for the public frontend wheel build interface."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BuildReleaseTest(unittest.TestCase):
    def build(
        self,
        *args: str,
        corrupt_callback: str | None = None,
        corrupt_chrome: str | None = None,
    ) -> tuple[str, bytes, dict[str, object]]:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            assets = temporary_path / "assets"
            assets.mkdir()
            (assets / "index.html").write_text("<main>release test</main>\n")
            site = temporary_path / "site"
            site.mkdir()
            for name in (
                "account.html",
                "authorization.html",
                "about.html",
                "about.js",
                "desktop-library.html",
                "desktop-library.js",
                "desktop-chrome.js",
                "desktop-chrome.json",
                "account-view.js",
                "authorization.js",
            ):
                (site / name).write_text(f"site fixture: {name}\n")
            style = "body {}"
            style_hash = base64.b64encode(
                hashlib.sha256(style.encode()).digest()
            ).decode()
            csp = (
                "default-src 'none'; script-src 'none'; connect-src 'none'; "
                f"style-src 'sha256-{style_hash}'; img-src data:; font-src data:; "
                "base-uri 'none'; form-action 'none'"
            )
            callback = (
                f'<meta http-equiv="Content-Security-Policy" content="{csp}">'
                f"<style>{style}</style><h1>__CALLBACK_HEADING__</h1>"
                '<p>__CALLBACK_MESSAGE__</p><a href="__CALLBACK_RETURN_URL__">'
                "__CALLBACK_RETURN_LABEL__</a>"
            ).encode()
            (site / "callback.html").write_bytes(callback)
            site_manifest = {
                "format": "dinkster.site/1",
                "files": {"callback.html": hashlib.sha256(callback).hexdigest()},
                "callback": {
                    "template": "callback.html",
                    "textSlots": [
                        "__CALLBACK_HEADING__",
                        "__CALLBACK_MESSAGE__",
                        "__CALLBACK_RETURN_LABEL__",
                    ],
                    "destinationSlot": "__CALLBACK_RETURN_URL__",
                    "csp": csp,
                },
            }
            if corrupt_callback == "missing":
                (site / "callback.html").unlink()
            elif corrupt_callback == "digest":
                (site / "callback.html").write_bytes(callback + b"changed")
            elif corrupt_callback == "contract":
                del site_manifest["callback"]
            elif corrupt_callback == "slots":
                site_manifest["callback"]["destinationSlot"] = "__CALLBACK_MESSAGE__"
            elif corrupt_callback == "csp":
                site_manifest["callback"]["csp"] = "default-src *"
            elif corrupt_callback in ("missing-slot", "embedded-csp"):
                old, new = (
                    (b"__CALLBACK_RETURN_URL__", b"/")
                    if corrupt_callback == "missing-slot"
                    else (b"default-src 'none'", b"default-src *")
                )
                callback = callback.replace(old, new)
                (site / "callback.html").write_bytes(callback)
                site_manifest["files"]["callback.html"] = hashlib.sha256(
                    callback
                ).hexdigest()
            chrome = json.dumps(
                {
                    "format": "dinkster.desktop-chrome/1",
                    "installer": "desktop-chrome.js",
                    "css": ".dinkster-desktop-bar {}",
                    "native": {},
                }
            ).encode()
            (site / "desktop-chrome.json").write_bytes(chrome)
            for name in ("desktop-chrome.json", "desktop-chrome.js"):
                site_manifest["files"][name] = hashlib.sha256(
                    (site / name).read_bytes()
                ).hexdigest()
            if corrupt_chrome == "missing":
                (site / "desktop-chrome.js").unlink()
            elif corrupt_chrome == "digest":
                (site / "desktop-chrome.js").write_text("changed")
            elif corrupt_chrome == "contract":
                (site / "desktop-chrome.json").write_text("{}")
                site_manifest["files"]["desktop-chrome.json"] = hashlib.sha256(
                    b"{}"
                ).hexdigest()
            (site / "manifest.json").write_text(json.dumps(site_manifest))
            output = temporary_path / "dist"
            subprocess.run(
                [
                    "python3",
                    "scripts/build_release.py",
                    "--dist",
                    str(assets),
                    "--output",
                    str(output),
                    "--site-dist",
                    str(site),
                    *args,
                ],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            wheel = next(output.glob("*.whl"))
            manifest = json.loads((output / "frontend-manifest.json").read_text())
            return wheel.name, wheel.read_bytes(), manifest

    def test_stable_tag_uses_the_exact_package_version_and_commit(self) -> None:
        version = json.loads((ROOT / "package.json").read_text())["version"]
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()

        wheel_name, _, manifest = self.build("--tag", f"v{version}")

        self.assertEqual(wheel_name, f"dinkster_frontend-{version}-py3-none-any.whl")
        self.assertEqual(manifest["version"], version)
        self.assertEqual(manifest["commit"], commit)

    def test_site_pages_and_renderer_ship_inside_the_existing_wheel(self) -> None:
        _, payload, _ = self.build()
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for name in (
                "account.html",
                "authorization.html",
                "about.html",
                "about.js",
                "desktop-library.html",
                "desktop-library.js",
                "desktop-chrome.js",
                "account-view.js",
                "authorization.js",
            ):
                self.assertEqual(
                    archive.read(f"dinkster_frontend/static/site/{name}"),
                    f"site fixture: {name}\n".encode(),
                )

            chrome = json.loads(
                archive.read("dinkster_frontend/static/site/desktop-chrome.json")
            )
            self.assertEqual(chrome["format"], "dinkster.desktop-chrome/1")
            site_manifest = json.loads(
                archive.read("dinkster_frontend/static/site/manifest.json")
            )
            callback = archive.read("dinkster_frontend/static/site/callback.html")
            self.assertEqual(
                hashlib.sha256(callback).hexdigest(),
                site_manifest["files"]["callback.html"],
            )
            self.assertIn(b"__CALLBACK_RETURN_URL__", callback)

    def test_incomplete_callback_distribution_cannot_produce_a_wheel(self) -> None:
        for corruption in (
            "missing",
            "digest",
            "contract",
            "slots",
            "csp",
            "missing-slot",
            "embedded-csp",
        ):
            with self.subTest(corruption=corruption):
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.build(corrupt_callback=corruption)
                self.assertIn("callback", failure.exception.stderr)

    def test_incomplete_desktop_chrome_cannot_produce_a_wheel(self) -> None:
        for corruption in ("missing", "digest", "contract"):
            with self.subTest(corruption=corruption):
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.build(corrupt_chrome=corruption)
                self.assertIn("chrome", failure.exception.stderr)

    def test_dev_build_uses_next_patch_and_monotonic_history_count(self) -> None:
        base_version = json.loads((ROOT / "package.json").read_text())["version"]
        revision = subprocess.check_output(
            ["git", "rev-list", "--count", "HEAD"], cwd=ROOT, text=True
        ).strip()
        major, minor, patch = (int(part) for part in base_version.split("."))
        version = f"{major}.{minor}.{patch + 1}.dev{revision}"

        wheel_name, wheel_bytes, manifest = self.build("--dev")

        self.assertEqual(wheel_name, f"dinkster_frontend-{version}-py3-none-any.whl")
        self.assertEqual(manifest["version"], version)
        with zipfile.ZipFile(io.BytesIO(wheel_bytes)) as archive:
            metadata = archive.read(
                f"dinkster_frontend-{version}.dist-info/METADATA"
            ).decode()
        self.assertIn(f"Version: {version}\n", metadata)
        commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()
        self.assertEqual(manifest["commit"], commit)
        self.assertIn(
            f"Project-URL: Source-Commit, https://github.com/Kosinkadink/Dinkster-Frontend/commit/{commit}\n",
            metadata,
        )


if __name__ == "__main__":
    unittest.main()
