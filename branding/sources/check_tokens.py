"""Print the WCAG 2 contrast table from the canonical JSON palette."""

import json
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
    print("| Theme | Text | Canvas | Surface | Raised |")
    print("| --- | --- | --- | --- | --- |")
    for theme in ("dark", "light"):
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


if __name__ == "__main__":
    main()
