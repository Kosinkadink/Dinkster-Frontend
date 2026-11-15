"""Regression tests for the public frontend wheel build interface."""

from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class BuildReleaseTest(unittest.TestCase):
    def build(self, *args: str) -> tuple[str, bytes, dict[str, object]]:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            assets = temporary_path / "assets"
            assets.mkdir()
            (assets / "index.html").write_text("<main>release test</main>\n")
            output = temporary_path / "dist"
            subprocess.run(
                [
                    "python3",
                    "scripts/build_release.py",
                    "--dist",
                    str(assets),
                    "--output",
                    str(output),
                    *args,
                ],
                cwd=ROOT,
                check=True,
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

        self.assertEqual(
            wheel_name, f"dinkster_frontend-{version}-py3-none-any.whl"
        )
        self.assertEqual(manifest["version"], version)
        self.assertEqual(manifest["commit"], commit)

    def test_dev_build_uses_next_patch_and_monotonic_history_count(self) -> None:
        base_version = json.loads((ROOT / "package.json").read_text())["version"]
        revision = subprocess.check_output(
            ["git", "rev-list", "--count", "HEAD"], cwd=ROOT, text=True
        ).strip()
        major, minor, patch = (int(part) for part in base_version.split("."))
        version = f"{major}.{minor}.{patch + 1}.dev{revision}"

        wheel_name, wheel_bytes, manifest = self.build("--dev")

        self.assertEqual(
            wheel_name, f"dinkster_frontend-{version}-py3-none-any.whl"
        )
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
