"""Canonical theme colors for brand comparison surfaces."""

import json
from pathlib import Path

PALETTE = json.loads(
    (Path(__file__).resolve().parents[1] / "tokens/dinkster-colors.json").read_text()
)
