"""Check token parity and print the WCAG 2 contrast table for the brand README."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def luminance(color):
    rgb = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb]
    return sum(v * w for v, w in zip(linear, (0.2126, 0.7152, 0.0722)))


def contrast(a, b):
    light, dark = sorted((luminance(a), luminance(b)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def main():
    tokens = json.loads((ROOT / "tokens/dinkster-colors.json").read_text())
    css = (ROOT / "tokens/dinkster-theme.css").read_text()
    dark_css, light_css = css.split('[data-theme="light"]')
    declarations = lambda text: dict(
        re.findall(r"--([a-z-]+):\s*(#[0-9A-Fa-f]{6})", text)
    )
    dark, light = declarations(dark_css), declarations(light_css)
    for name, value in tokens["brand"].items():
        css_name = re.sub(r"([A-Z])", r"-\1", name).lower()
        assert dark[f"brand-{css_name}"] == value["$value"]
    print("| Theme | Text | Canvas | Surface | Raised |")
    print("| --- | --- | --- | --- | --- |")
    for theme, values in (("dark", dark), ("light", light)):
        expected_names = set()
        for group, entries in tokens[theme].items():
            for name, value in entries.items():
                css_name = re.sub(r"([A-Z])", r"-\1", name).lower()
                key = f"{group}-{css_name}"
                expected_names.add(key)
                assert values[key] == value
        assert {
            name for name in values if not name.startswith("brand-")
        } == expected_names
        for text in ("primary", "secondary", "muted"):
            ratios = [
                contrast(tokens[theme]["text"][text], tokens[theme]["bg"][bg])
                for bg in ("canvas", "surface", "raised")
            ]
            print(
                f"| {theme} | {text} | "
                + " | ".join(f"{ratio:.2f}:1" for ratio in ratios)
                + " |"
            )
    print("JSON/CSS values identical")


if __name__ == "__main__":
    main()
