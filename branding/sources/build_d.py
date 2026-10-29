"""Constructed vector of the Dinkster D, measured from the A+ reference.

The D silhouette is the union of the cyan, coral and yellow planes of
references/A-plus-two-variants.png (left half). Geometry is defined once in
reference-image pixel coordinates (straight edges, one bowl arc, and a fillet
radius per corner), then mapped to a 1000x1000 viewBox. The stem and leg stay
a separate island, as in the reference.

The approved counter reshapes an n=3.2 squircle to 70 percent reference
area, with its nose 62 percent down the counter. --faceted, --stadium and
--echo keep the rejected reference alternatives for comparison.
Run with --fit to re-estimate every fillet radius against the reference.
"""

import io
import math
import sys

import cairosvg
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

REF = "A-plus-two-variants.png"  # run from this directory

# Measured reference geometry (source pixels). Lines at 45 degrees are given
# as x - y = c (rising to the right) or x + y = c (falling to the right).
TOP, BOTTOM = 68.0, 360.0
LEFT_TOP_X = 152.0  # top-left corner
TOP_RIGHT_X = 400.0  # where the top edge meets the top-right chamfer
RIGHT = 497.0  # right edge
CHAMFER_TL = 84.0  # x - y = CHAMFER_TL
CHAMFER_TR = 334.0  # x - y = CHAMFER_TR
CHAMFER_BR = 768.0  # x + y = CHAMFER_BR
APERTURE_TOP = 157.0
BOWL_C, BOWL_R = (338.0, 221.0), 50.0
BOWL_END_DEG = 45.0  # bowl arc spans -45..+45 degrees; 45-degree tangents run to the flat top and bottom
SQUIRCLE_N = 3.2  # squircle exponent (default hole style)
ECHO_CHAMFER = 42.0  # --echo chamfer size (outer chamfer scaled to the hole height)
REFERENCE_APERTURE_BOTTOM = 285.0
APERTURE_BOTTOM = 269.0
COUNTER_AREA_RATIO = 0.70
COUNTER_NOSE_FRACTION = 0.62
COUNTER_PROFILE_X = 324.0
COUNTER_BOTTOM_SHIFT = 16.0
COUNTER_TOP_SCALE = 0.5
BODY_TRIM_X = 232.0
BODY_TRIM_RADIUS = 24.0
CHANNEL_LOW = 583.0  # lower arm inner edge: x + y = CHANNEL_LOW
STEM_TOP = 175.0
STEM_L, STEM_R = 232.0, 298.0
# Reference values are 551 / 471 (gaps 18 top, 11.5 bottom). Both moved out by
# 6.5 so the bottom gap matches the top gap (user choice).
STEM_DIAG = 557.5  # stem/leg right edge: x + y = STEM_DIAG
LEG_DIAG = 477.5  # leg left edge: x + y = LEG_DIAG

K = math.sqrt(0.5)

# Fillet radius per named corner (reference pixels). Right-side corners are
# deliberately equal (user decision); the rest are read from the reference.
RADII = {
    "top_left": 0.0,
    "top_right": 28.0,
    "right_top": 45.0,
    "right_bottom": 45.0,
    "bottom_right": 24.0,
    "bottom_channel": 0.0,
    "aperture_bl": 26.0,
    "aperture_br": None,  # None: exactly consume the 45-degree tangent (see diag_fillet_radius)
    "aperture_tr": None,
    "aperture_tl": 26.0,
    "hole_rt": 20.0,
    "hole_rb": 20.0,
    "stem_tl": 8.0,
    "stem_tr": 10.0,
    "stem_bottom": 10.0,
    "leg_bottom": 0.0,
    "leg_end": 6.0,
    "leg_stem": 0.0,
}


def reference_outline():
    """Original reference silhouette, retained for reproducible comparisons."""
    return [
        ("top_left", LEFT_TOP_X, TOP),
        ("top_right", TOP_RIGHT_X, TOP),
        ("right_top", RIGHT, RIGHT - CHAMFER_TR),
        ("right_bottom", RIGHT, CHAMFER_BR - RIGHT),
        ("bottom_right", CHAMFER_BR - BOTTOM, BOTTOM),
        ("bottom_channel", CHANNEL_LOW - BOTTOM, BOTTOM),
        (
            "aperture_bl",
            CHANNEL_LOW - REFERENCE_APERTURE_BOTTOM,
            REFERENCE_APERTURE_BOTTOM,
        ),
        *reference_bowl_side(),
        ("aperture_tl", APERTURE_TOP + CHAMFER_TL, APERTURE_TOP),
    ]


def outline():
    """Approved body with a channel-clipped r24 and the selected counter."""
    if any(flag in sys.argv for flag in ("--faceted", "--stadium", "--echo")):
        return reference_outline()
    radius = BODY_TRIM_RADIUS
    cx, cy = BODY_TRIM_X + radius, BOTTOM - radius
    offset = CHANNEL_LOW - cx - cy
    dx = (offset - math.sqrt(2 * radius**2 - offset**2)) / 2
    angle = math.degrees(math.atan2(offset - dx, dx))
    return [
        ("arc", cx, cy, radius, 90, angle)
        if vertex[0] == "bottom_channel"
        else ("aperture_bl", CHANNEL_LOW - APERTURE_BOTTOM, APERTURE_BOTTOM)
        if vertex[0] == "aperture_bl"
        else ("poly", bowl_side()[0][1])
        if vertex[0] == "poly"
        else vertex
        for vertex in reference_outline()
    ]


def diag_fillet_radius():
    """Radius at which the fillet between a flat and its 45-degree tangent
    swallows the whole tangent segment, so the flat flows into the bowl arc
    with no straight facet in between (curvature 1/r -> 1/BOWL_R)."""
    _, cy = BOWL_C
    tan_top_y = cy - BOWL_R * K
    diag_len = tan_top_y - APERTURE_TOP  # the 45-degree segment's vertical extent
    return diag_len / math.tan(math.radians(22.5))


def reference_bowl_side():
    """Right side of the aperture. Faceted: 45-degree tangents from the flats
    into the bowl arc. Stadium: one semicircle tangent to both flats, keeping
    the bowl's right extreme in place."""
    cx, cy = BOWL_C
    right = cx + BOWL_R  # right extreme of the hole, shared by all styles
    half = (REFERENCE_APERTURE_BOTTOM - APERTURE_TOP) / 2
    if "--stadium" in sys.argv:
        return [("arc", right - half, cy, half, 90.0, -90.0)]
    if not any(f in sys.argv for f in ("--faceted", "--stadium", "--echo")):
        # Superellipse half, exponent SQUIRCLE_N: squarer than a circle, curvature
        # varies smoothly (no radius jump), tangent to both flats.
        n = SQUIRCLE_N
        pts = []
        for i in range(97):
            t = math.pi / 2 - math.pi * i / 96  # +90 (bottom) .. -90 (top), clockwise
            c, sn = math.cos(t), math.sin(t)
            pts.append(
                (
                    right - half + half * abs(c) ** (2 / n),
                    cy + half * math.copysign(abs(sn) ** (2 / n), sn),
                )
            )
        return [("poly", pts)]
    if "--echo" in sys.argv:
        # The outer D's right side in miniature: 45-degree chamfers around a vertical flat.
        ch = ECHO_CHAMFER
        return [
            ("aperture_br", right - ch, REFERENCE_APERTURE_BOTTOM),
            ("hole_rb", right, REFERENCE_APERTURE_BOTTOM - ch),
            ("hole_rt", right, APERTURE_TOP + ch),
            ("aperture_tr", right - ch, APERTURE_TOP),
        ]
    tan_top = (cx + BOWL_R * K, cy - BOWL_R * K)
    tan_bot = (cx + BOWL_R * K, cy + BOWL_R * K)
    diag_top_x = tan_top[0] - (tan_top[1] - APERTURE_TOP)
    diag_bot_x = tan_bot[0] - (REFERENCE_APERTURE_BOTTOM - tan_bot[1])
    return [
        ("aperture_br", diag_bot_x, REFERENCE_APERTURE_BOTTOM),
        ("arc", cx, cy, BOWL_R, BOWL_END_DEG, -BOWL_END_DEG),
        ("aperture_tr", diag_top_x, APERTURE_TOP),
    ]


def bowl_side():
    """Reshape, lift and area-normalize the approved sampled counter."""
    bowl = reference_bowl_side()[0][1]
    reference_height = REFERENCE_APERTURE_BOTTOM - APERTURE_TOP
    height = APERTURE_BOTTOM - APERTURE_TOP
    profile = []
    for x, y in bowl:
        u = (y - APERTURE_TOP) / reference_height
        profile.append(
            (
                COUNTER_PROFILE_X
                + COUNTER_BOTTOM_SHIFT * u
                + (x - COUNTER_PROFILE_X)
                * (COUNTER_TOP_SCALE + (1 - COUNTER_TOP_SCALE) * u),
                APERTURE_TOP + height * u,
            )
        )
    nose = (max(profile, key=lambda point: point[0])[1] - APERTURE_TOP) / height
    power = math.log(COUNTER_NOSE_FRACTION) / math.log(nose)
    profile = [
        (x, APERTURE_TOP + height * ((y - APERTURE_TOP) / height) ** power)
        for x, y in profile
    ]

    def area(points):
        return abs(
            sum(
                a[0] * b[1] - b[0] * a[1]
                for a, b in zip(points, points[1:] + points[:1])
            )
            / 2
        )

    reference_area = area(
        [(STEM_R, REFERENCE_APERTURE_BOTTOM), *bowl, (STEM_R, APERTURE_TOP)]
    )

    def counter_area(factor):
        polygon = build(
            [
                ("aperture_bl", CHANNEL_LOW - APERTURE_BOTTOM, APERTURE_BOTTOM),
                ("poly", [(STEM_R + (x - STEM_R) * factor, y) for x, y in profile]),
                ("close_top", STEM_R, APERTURE_TOP),
                ("close_bottom", STEM_R, REFERENCE_APERTURE_BOTTOM),
            ],
            RADII,
        )[1]
        return area(polygon)

    base_area = counter_area(1)
    area_slope = (counter_area(1.2) - base_area) / 0.2
    factor = 1 + (reference_area * COUNTER_AREA_RATIO - base_area) / area_slope
    return [("poly", [(STEM_R + (x - STEM_R) * factor, y) for x, y in profile])]


def stem():
    return [
        ("stem_tl", STEM_L, STEM_TOP),
        ("stem_tr", STEM_R, STEM_TOP),
        ("stem_bottom", STEM_R, STEM_DIAG - STEM_R),
        ("leg_bottom", STEM_DIAG - BOTTOM, BOTTOM),
        ("leg_end", LEG_DIAG - BOTTOM, BOTTOM),
        ("leg_stem", STEM_L, LEG_DIAG - STEM_L),
    ]


def arc_points(cx, cy, r, a0, a1, steps=48):
    return [
        (
            cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / steps)),
            cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / steps)),
        )
        for i in range(steps + 1)
    ]


def build(contour, radii):
    """Return (svg_commands, polygon_points). Commands are in reference coords:
    ('M'|'L', x, y) or ('A', r, sweep, x, y)."""
    # Expand to a list of entries: ('v', name, x, y) or ('arc', pts) where arc endpoints are tangent.
    entries = []
    for v in contour:
        if v[0] == "arc":
            entries.append(("arc", arc_points(*v[1:]), v[3], 0 if v[5] < v[4] else 1))
        elif v[0] == "poly":
            entries.append(("poly", v[1]))
        else:
            entries.append(("v", v[0], v[1], v[2]))
    n = len(entries)

    def point_before(i):
        e = entries[(i - 1) % n]
        return e[2:4] if e[0] == "v" else e[1][-1]

    def point_after(i):
        e = entries[(i + 1) % n]
        return e[2:4] if e[0] == "v" else e[1][0]

    cmds, poly = [], []
    for i, e in enumerate(entries):
        if e[0] == "poly":
            poly.extend(e[1])
            cmds.extend(("L", *p) for p in e[1])
            continue
        if e[0] == "arc":
            _, pts, r, sweep = e
            poly.extend(pts)
            cmds.append(("L", *pts[0]))  # arcs start at their own tangent point
            cmds.append(("A", r, sweep, *pts[-1]))
            continue
        _, name, x, y = e
        r = radii.get(name, 0.0)
        if r is None:
            r = ECHO_CHAMFER * 0.3 if "--echo" in sys.argv else diag_fillet_radius()
        if r <= 0:
            cmds.append(("L", x, y))
            poly.append((x, y))
            continue
        px, py = point_before(i)
        qx, qy = point_after(i)
        d1 = (x - px, y - py)
        d2 = (qx - x, qy - y)
        l1, l2 = math.hypot(*d1), math.hypot(*d2)
        d1 = (d1[0] / l1, d1[1] / l1)
        d2 = (d2[0] / l2, d2[1] / l2)
        cross = d1[0] * d2[1] - d1[1] * d2[0]
        dot = d1[0] * d2[0] + d1[1] * d2[1]
        turn = math.atan2(abs(cross), dot)  # deflection angle
        t = r * math.tan(turn / 2)
        a = (x - d1[0] * t, y - d1[1] * t)
        b = (x + d2[0] * t, y + d2[1] * t)
        sweep = 1 if cross > 0 else 0
        # center: offset from a perpendicular to d1, on the inside of the turn
        nx, ny = (-d1[1], d1[0]) if cross > 0 else (d1[1], -d1[0])
        cx, cy = a[0] + nx * r, a[1] + ny * r
        a0 = math.atan2(a[1] - cy, a[0] - cx)
        a1 = math.atan2(b[1] - cy, b[0] - cx)
        if sweep and a1 < a0:
            a1 += 2 * math.pi
        if not sweep and a1 > a0:
            a1 -= 2 * math.pi
        cmds.append(("L", *a))
        cmds.append(("A", r, sweep, *b))
        for k in range(17):
            ang = a0 + (a1 - a0) * k / 16
            poly.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    cmds[0] = ("M", *cmds[0][1:]) if cmds[0][0] == "L" else cmds[0]
    return cmds, poly


class Transform:
    def __init__(self, scale, dx, dy):
        self.scale, self.dx, self.dy = scale, dx, dy

    def __call__(self, x, y):
        return x * self.scale + self.dx, y * self.scale + self.dy


def to_svg(cmds_list, tf):
    parts = []
    for cmds in cmds_list:
        for c in cmds:
            if c[0] in ("M", "L"):
                x, y = tf(c[1], c[2])
                parts.append(f"{c[0]}{x:.1f} {y:.1f}")
            else:
                _, r, sweep, x, y = c
                x, y = tf(x, y)
                rr = r * tf.scale
                parts.append(f"A{rr:.1f} {rr:.1f} 0 0 {sweep} {x:.1f} {y:.1f}")
        parts.append("Z")
    return " ".join(parts)


def reference_mask():
    im = Image.open(REF).convert("RGB")
    a = np.asarray(im).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = ~((r < 60) & (g < 60) & (b < 70))
    m = ndimage.binary_closing(m[:470, :560], iterations=2)
    lab, n = ndimage.label(m)
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    keep = np.argsort(sizes)[::-1][:2] + 1
    return np.isin(lab, keep)


def rasterize(radii):
    mask = Image.new("L", (560, 470), 0)
    d = ImageDraw.Draw(mask)
    for contour in (outline(), stem()):
        d.polygon(build(contour, radii)[1], fill=255)
    return np.asarray(mask) > 127


def fit_radii(ref):
    radii = dict(RADII)
    corners = {
        v[0]: (v[1], v[2]) for v in outline() + stem() if v[0] not in ("arc", "poly")
    }
    for name, (x, y) in corners.items():
        x0, x1 = int(x) - 25, int(x) + 25
        y0, y1 = int(y) - 25, int(y) + 25
        best = None
        for r in [0.0] + [float(v) for v in range(2, 61, 1)]:
            trial = dict(radii, **{name: r})
            ours = rasterize(trial)[y0:y1, x0:x1]
            win = ref[y0:y1, x0:x1]
            err = (ours ^ win).sum()
            if best is None or err < best[0]:
                best = (err, r)
        radii[name] = best[1]
        print(f"{name:16s} r={best[1]:5.1f}  mismatch={best[0]}")
    return radii


def main():
    export_master = "--export-master" in sys.argv
    if not export_master or "--fit" in sys.argv:
        ref = reference_mask()
    radii = fit_radii(ref) if "--fit" in sys.argv else RADII

    LEFT = LEG_DIAG - BOTTOM
    ref_w, ref_h = RIGHT - LEFT, BOTTOM - TOP
    scale = 840.0 / max(ref_w, ref_h)
    width, height = ref_w * scale, ref_h * scale
    tf = Transform(
        scale, (1000 - width) / 2 - LEFT * scale, (1000 - height) / 2 - TOP * scale
    )
    d = to_svg([build(outline(), radii)[0], build(stem(), radii)[0]], tf)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">\n'
        f'  <path id="dinkster-d" fill="#32E6C5" d="{d}"/>\n'
        "</svg>\n"
    )
    if export_master:
        destination = sys.argv[sys.argv.index("--export-master") + 1]
        with open(destination, "w", encoding="ascii") as f:
            f.write(svg)
        return
    with open("dinkster-d-draft.svg", "w") as f:
        f.write(svg)

    ours = rasterize(radii)
    print(f"IoU vs reference union: {(ours & ref).sum() / (ours | ref).sum():.4f}")
    ov = np.zeros((470, 560, 3), np.uint8)
    ov[ref & ours] = (235, 235, 235)
    ov[ref & ~ours] = (255, 60, 60)
    ov[~ref & ours] = (60, 120, 255)
    Image.fromarray(ov[40:380, 90:520]).resize((860, 680), Image.NEAREST).save(
        "overlay.png"
    )

    cairosvg.svg2png(
        bytestring=svg.encode(),
        write_to="d-1024.png",
        output_width=1024,
        output_height=1024,
    )
    strip = Image.new("RGB", (16 + 32 + 64 + 128 + 5 * 24, 128 + 48), (17, 19, 22))
    x = 24
    for size in (16, 32, 64, 128):
        png = cairosvg.svg2png(
            bytestring=svg.encode(), output_width=size, output_height=size
        )
        icon = Image.open(io.BytesIO(png)).convert("RGBA")
        strip.paste(icon, (x, 24 + (128 - size)), icon)
        x += size + 24
    strip.resize((strip.width * 3, strip.height * 3), Image.NEAREST).save(
        "size-proof-nearest.png"
    )


if __name__ == "__main__":
    main()
