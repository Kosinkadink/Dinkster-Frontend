"""The artifact CLI preserves bundle bytes and identifies their source commit."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BundleArtifactTest(unittest.TestCase):
    def test_manifest_and_repeatable_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dist = root / "dist"
            (dist / "assets").mkdir(parents=True)
            (dist / "index.html").write_bytes(b'<div id="app"></div>')
            (dist / "assets/app.js").write_bytes(b"window.app = true;\n")
            command = [
                sys.executable,
                str(ROOT / "scripts/bundle_artifact.py"),
                "--dist",
                str(dist),
            ]
            first = subprocess.check_output(
                [*command, "--output", str(root / "first")], text=True
            )
            (dist / "index.html").touch()
            subprocess.run(
                [*command, "--output", str(root / "second")],
                check=True,
                capture_output=True,
            )
            archive = (root / "first/bundle.zip").read_bytes()
            self.assertEqual(archive, (root / "second/bundle.zip").read_bytes())
            manifest = json.loads((root / "first/manifest.json").read_text())
            self.assertEqual(
                manifest,
                {
                    "commit": subprocess.check_output(
                        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
                    ).strip(),
                    "sha256": hashlib.sha256(archive).hexdigest(),
                    "size": len(archive),
                    "version": json.loads((ROOT / "package.json").read_text())[
                        "version"
                    ],
                },
            )
            self.assertEqual(first.strip(), f"dinkster-frontend-{manifest['sha256']}")
            with zipfile.ZipFile(root / "first/bundle.zip") as bundle:
                self.assertEqual(bundle.namelist(), ["assets/app.js", "index.html"])
                self.assertEqual(bundle.read("index.html"), b'<div id="app"></div>')
                self.assertEqual(bundle.read("assets/app.js"), b"window.app = true;\n")
            (dist / "assets/app.js").write_bytes(b"window.app = false;\n")
            changed = subprocess.check_output(
                [*command, "--output", str(root / "third")], text=True
            )
            self.assertNotEqual(first, changed)

    def test_missing_entry_document_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/bundle_artifact.py"),
                    "--dist",
                    directory,
                    "--output",
                    str(Path(directory) / "output"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must contain index.html", result.stderr)


if __name__ == "__main__":
    unittest.main()
