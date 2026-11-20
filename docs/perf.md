# Performance baselines

Historical measurements from the former `packages/e2e/tests/perf.spec.ts`
and the other workloads identified below. The browser timing cases and their
performance project are removed: their absolute limits were not calibrated
from the slowest hosted runner with a threefold margin. These tables remain
an unchanged measurement record, not active test gates or rerun instructions.

## Optional frame-rate readout (2026-11-19)

The readout is off by default. This production-optimized AFTER report measures
that default state; enabled-state browser checks separately cover persistence,
visibility and rendering, not its performance overhead. BEFORE is the accepted
smooth-wheel run below, landed as `60d7183e`, and was not replayed. The stage 6
branch changes no renderer behavior and does not include the separate flooded
wheel repair. Its tiny zoom medians can still contain unchanged-scale cached
copies, not sustained full-scene raster work or achieved display refresh.

The unchanged audit tools use X570, claimed RTX 4090 Vulkan, Chromium 149,
uncapped 2560x1440 and 2500 ms inputs. Drag is measured separately from wheel
input. The CPU backend changed from BEFORE `09a19d69` to `79f1fb51`, with
packs at `e3cc2acb`. Both launched interpreter inventories verify all41516
sealed files without mismatch. Independent CPU repair verification overlapped
this AFTER report on the shared host. Unequal-time sampling and that overlap
prevent attributing differences to the readout or claiming a causal speedup.

Frame callback interval p50/p95 in milliseconds:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 16.7/17.7 | 3.6/17.7 | 0.4/7.0 | 0.3/8.7 | 1.4/2.1 | 1.5/2.2 |
| 66/fit | 16.7/17.8 | 16.8/17.6 | 0.2/6.4 | 0.3/6.6 | 1.2/17.0 | 1.2/2.9 |
| 300/read | 15.7/17.7 | 1.7/17.6 | 0.3/5.7 | 0.4/7.1 | 1.2/2.0 | 1.4/3.4 |
| 300/fit | 16.7/17.7 | 16.9/17.6 | 0.2/9.8 | 0.3/13.6 | 1.6/2.9 | 1.9/3.3 |
| 1200/read | 4.9/17.7 | 6.8/17.6 | 0.3/6.3 | 0.4/8.8 | 1.7/2.9 | 1.7/2.9 |
| 1200/fit | 16.6/17.7 | 16.7/17.7 | 0.2/23.0 | 0.2/13.2 | 6.2/15.0 | 8.1/17.9 |

Fitted1200 zoom input-to-render-end p95 is1198 ms BEFORE and120.6 ms AFTER.
That variation on the unchanged renderer is not evidence that this readout
fixes input queuing or glide progress. The separate wheel repair owns that
behavior. Fitted1200 drag regresses and pan tails remain around17.7 ms; the
original frame-time goals are not met. The readout itself reports page rAF
callback cadence and maximum interval per one-second sample, not paint cost,
input delay or GPU presentation. It is a diagnostic tool, not a timing gate.

## Wheel coalescing with edit and fresh-glide priority (2026-11-19)

The final candidate adds two correctness controls to raster coalescing: a new
wheel glide cannot inherit an earlier paint's pause, and dirty scene/overlay
updates bypass the pause. The unchanged production reporting tools run after
all local validation, with no owner validation overlapping. Hardware, input,
viewport and backend/pack pins match the preceding coalescing report; both
interpreter inventories again verify all 41516 sealed files without mismatch.
The accepted smooth-wheel BEFORE is reused, never replayed. These are
unequal-time shared-host reports, not isolated causal or display-rate proof.

Probe callback interval p50/p95 in milliseconds, with drag isolated from zoom:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 16.7/17.7 | 16.7/17.7 | 0.4/7.0 | 0.2/6.2 | 1.4/2.1 | 1.4/2.0 |
| 66/fit | 16.7/17.8 | 16.7/17.7 | 0.2/6.4 | 0.2/4.9 | 1.2/17.0 | 1.2/17.1 |
| 300/read | 15.7/17.7 | 4.5/17.6 | 0.3/5.7 | 0.2/5.7 | 1.2/2.0 | 1.3/4.2 |
| 300/fit | 16.7/17.7 | 1.7/17.6 | 0.2/9.8 | 0.2/1.3 | 1.6/2.9 | 1.8/3.5 |
| 1200/read | 4.9/17.7 | 6.7/17.6 | 0.3/6.3 | 0.3/7.7 | 1.7/2.9 | 1.7/2.5 |
| 1200/fit | 16.6/17.7 | 16.6/17.7 | 0.2/23.0 | 0.1/0.3 | 6.2/15.0 | 5.4/16.5 |

Coalescing intentionally omits intermediate rasters, so those tiny zoom
callback intervals are not rendered frame times or full-refresh acceptance.
Actual zoom raster work and newest-input-to-render-end latency are:

| Fixture/camera | Raster p50/p95 (ms) | Paints/s | Input-to-render-end p95 (ms) |
| --- | --- | --- | --- |
| 66/read | 7.4/16.2 | 82.0 | 51.2 |
| 66/fit | 4.3/12.3 | 124.3 | 45.7 |
| 300/read | 4.8/7.9 | 124.3 | 20.0 |
| 300/fit | 6.5/17.6 | 76.2 | 25.8 |
| 1200/read | 7.1/11.4 | 84.9 | 32.9 |
| 1200/fit | 9.2/27.1 | 52.8 | 28.5 |

Fitted 1200-node flood input-to-render-end p95 is 1198 ms BEFORE -> 28.5 ms
AFTER; delivery-queue p95 is 24.9 ms AFTER. The prior unfavorable 11542.4 ms
progress-only result remains below. Latency pairs each actual raster with the
newest input delivered before it, not every input with its own frame. Paints
at changing scales repaint sharp pixels; omitted steps retain the actual
painted camera without rescaling a bitmap. The final target bypasses the
pause. Dirty-edit, new-glide, skipped-paint alignment and 100 ms-plus-frame
settle regressions pass, as do all 741 canvas cases, fast/build checks,
the extended browser wheel contract and full 28-app/286-UI/16-site visual run.
No assertion or baseline changes. Frame-time goals remain unmet, and this
report alone does not explain the original intermittent slow spells.

## Wheel raster coalescing (2026-11-19)

The fitted 1200-node/1140-link production-optimized test-mode AFTER run uses
2560x1440, claimed RTX 4090 Vulkan, and the unchanged 2500 ms asynchronous
1 kHz input tool. The accepted smooth-wheel BEFORE is not replayed. Leaving
half the previous paint's duration for input delivery between intermediate
rasters reduces input-to-render-end p95 from 1198 ms BEFORE (11542.4 ms with
the progress-only correction) to 28.8 ms. Delivery-queue p95 is 25.0 ms.
The final target bypasses the pause; omitted steps keep the painted camera,
not a scaled bitmap. Actual raster p50/p95 is 8.0/26.3 ms and 53.5 paints/s,
so full-refresh targets remain unmet. Probe callback p50/p95 of 0.1/0.3 ms
includes omitted raster steps and is not a graph-paint rate. The same backend
and pack pins as the retarget report below apply. This is a shared-host
candidate report, not independent verification or a landing gate.

## Wheel retargeting under continuous input (2026-11-19)

Before is the accepted smooth-wheel AFTER run below, landed as `60d7183e`;
it was not replayed. After preserves elapsed time when wheel input retargets
from the last painted camera and samples the callback's current clock instead
of its potentially older frame timestamp. X570, claimed RTX 4090, Chromium
149 Vulkan, uncapped 2560x1440, 2500 ms inputs and the unchanged reporting
scripts are retained. Both builds are production-optimized test-mode builds.
The CPU backend pin changed from `09a19d69` to the workflow's `79f1fb51`,
with packs at `e3cc2acb`; engine and shared-interpreter inventories each verify
41516 sealed build files without mismatch. This is an unequal-time,
shared-host report, not isolated frontend causality or a gate. No validation
suite overlaps this AFTER command.

Frame p50/p95 in milliseconds:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 16.7/17.7 | 16.7/17.7 | 0.4/7.0 | 8.0/10.4 | 1.4/2.1 | 1.4/2.1 |
| 66/fit | 16.7/17.8 | 16.7/17.7 | 0.2/6.4 | 4.6/12.3 | 1.2/17.0 | 1.3/17.1 |
| 300/read | 15.7/17.7 | 16.4/17.7 | 0.3/5.7 | 4.7/10.6 | 1.2/2.0 | 1.2/2.0 |
| 300/fit | 16.7/17.7 | 10.5/18.5 | 0.2/9.8 | 7.5/24.7 | 1.6/2.9 | 1.6/2.8 |
| 1200/read | 4.9/17.7 | 15.0/17.7 | 0.3/6.3 | 4.9/9.6 | 1.7/2.9 | 1.4/1.8 |
| 1200/fit | 16.6/17.7 | 20.5/35.5 | 0.2/23.0 | 21.1/36.6 | 6.2/15.0 | 5.1/13.7 |

The earlier tiny zoom medians include unchanged-scale cached copies; the
repair's progressing scales expose full raster work instead. The unchanged
1 kHz asynchronous CDP flood still accumulates delivery backlog. AFTER zoom
input-to-render-end p95 is 2612.7-11542.4 ms, including event-delivery queue
p95 of 2588.6-11495.7 ms. Fitted 1200-node p95 is now 11542.4 ms versus
1198 ms before. These unfavorable cells remain reported; neither the
full-refresh targets nor the complete flood-latency requirement is met.
The report does not establish that the queue is Chrome-only or that the
renderer has no further responsibility.

Separate recorded 600 ms fast/flooded browser-timer inputs exercise the real
wheel handler with the 1200-node image fixture at readable and fitted scales.
Requested 1 ms intervals are timer/render limited, not literal hardware
1 kHz. AFTER camera observations never repeat a scale and reach the final
target 69.2-104.5 ms after the last delivered event; BEFORE fitted flood has
13/16 repeated observations and final-target delays of 137.0/146.6 ms.
These observations precede paint, not presentation. Deterministic regression
coverage independently forces older frame timestamps and requires forward
motion and target arrival within 100 ms plus one frame. Animated intermediate
pixel equivalence is not added by these timing/behavior controls.

## Smooth wheel zoom (2026-11-19)

Before is the accepted regional-redraw run below, whose renderer landed as
`1338449e`; it was not replayed. After adds default-on 100 ms wheel easing
inside the renderer's frame loop. X570, claimed RTX 4090, Chromium 149 Vulkan,
uncapped 2560x1440, 2500 ms inputs and the unchanged audit scripts are retained.
Both are production-optimized test-mode builds. The freshly captured CPU
backend uses the same pinned sources, installed package versions and pack
artifact digests; only local source paths differ. No validation suite overlaps
the after command. These are unequal-time, shared-host reports, not gates.

Frame p50/p95 in milliseconds; drag runs separately from camera input:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 6.1/17.5 | 16.7/17.7 | 7.7/13.9 | 0.4/7.0 | 1.4/2.3 | 1.4/2.1 |
| 66/fit | 2.1/17.6 | 16.7/17.8 | 5.0/14.0 | 0.2/6.4 | 1.2/16.8 | 1.2/17.0 |
| 300/read | 4.1/17.5 | 15.7/17.7 | 4.7/11.2 | 0.3/5.7 | 1.2/2.0 | 1.2/2.0 |
| 300/fit | 9.8/24.4 | 16.7/17.7 | 7.5/25.6 | 0.2/9.8 | 1.9/3.7 | 1.6/2.9 |
| 1200/read | 13.2/17.7 | 4.9/17.7 | 4.7/8.2 | 0.3/6.3 | 2.4/3.5 | 1.7/2.9 |
| 1200/fit | 20.6/33.5 | 16.6/17.7 | 21.8/35.5 | 0.2/23.0 | 6.3/14.2 | 6.2/15.0 |

The zoom distribution contains many tiny renders (renderer p50 0.0-0.1 ms),
with p95 5.2-22.6 ms and frame maxima up to 134.3 ms. Its small frame median
is not evidence of sustained full refresh rate. The unchanged wheel flood
still queues input: fitted 1200-node zoom input-to-render-end p95 is 1198 ms.
Pan has near-zero renderer cost but roughly 17.7 ms frame tails. Neither
observation establishes tab-save or garbage-collection attribution. These
numbers retain unfavorable cells and do not satisfy the whole-issue targets.

Controlled-clock browser checks separately establish intermediate frames,
pointer anchoring, accumulated/reversed input, bookmark and pointer takeover,
disabling an active glide, persisted default-on/off behavior and immediate
reduced-motion behavior. The original two-axis pan and Ctrl-wheel policy
case passes against the production-optimized build and native CPU backend.
These behavior checks do not assert frame-time limits.

## Regional node-edit redraws (2026-11-19)

Before is landed `7410bf20`; after is based on `15ea54ef` and retains distant
graph tiles across node selection, drag, resize and committed/presentation edits.
The intervening recorder repair and gallery additions do not change the
production graph renderer. Both use the same
X570, claimed RTX 4090, Chromium 149 Vulkan, uncapped 2560x1440 viewport,
2500 ms audit inputs and production-optimized test-mode builds. Each side is
one run per workload/camera; the accepted before data was not replayed. The
isolated CPU backend uses the same captured development generation. These
are reports, not timing gates or whole-issue acceptance.

Frame p50/p95 in milliseconds, with drag measured separately from camera input:

| Fixture/camera | Drag before | Drag after | Pan before | Pan after | Zoom before | Zoom after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 5.3/10.3 | 1.4/2.3 | 16.7/17.7 | 6.1/17.5 | 7.8/13.1 | 7.7/13.9 |
| 66/fit | 3.1/22.2 | 1.2/16.8 | 2.2/17.5 | 2.1/17.6 | 5.8/15.5 | 5.0/14.0 |
| 300/read | 6.5/22.3 | 1.2/2.0 | 1.1/17.7 | 4.1/17.5 | 6.6/13.4 | 4.7/11.2 |
| 300/fit | 7.6/23.8 | 1.9/3.7 | 9.8/31.0 | 9.8/24.4 | 6.8/25.1 | 7.5/25.6 |
| 1200/read | 6.4/17.2 | 2.4/3.5 | 1.2/17.5 | 13.2/17.7 | 7.8/15.0 | 4.7/8.2 |
| 1200/fit | 25.0/37.6 | 6.3/14.2 | 25.0/43.7 | 20.6/33.5 | 18.9/47.6 | 21.8/35.5 |

Drag renderer p50/p95 falls from 4.8/7.4 to 1.0/1.7 ms at 66/read,
6.8/23.3 to 1.5/2.7 ms at 300/fit, and 25.4/36.8 to 5.7/8.3 ms at
1200/fit. The fixed 66/300/1200 counting controls independently require
changed-node frames to replace fewer than all visible tiles and retain live
distant images. Exact browser comparisons cover cross-tile drag/reversal,
release, edits, mutable previews and dense overview reroute batching changes.
A batching transition conservatively retires all tiles to avoid stale dots.

The unchanged click tool reports three samples after one warmup. First-frame
p50 in milliseconds:

| Fixture | Select before | Select after | Context menu before | Context menu after |
| --- | --- | --- | --- | --- |
| 66 | 24.4 | 18.7 | 23.7 | 16.5 |
| 300 | 23.8 | 18.2 | 22.8 | 15.6 |
| 1200 | 20.6 | 17.7 | 21.1 | 13.5 |

Selection and menu numbers remain above the small-graph first-frame targets.
Settled observations still include sporadic long gaps; they do not establish
that the tab-save or garbage collector accounts for those gaps.

Pan/zoom frame gaps and regressions remain in the table. The unchanged wheel
flood can queue input into subsequent fitted-camera cells, with multi-second
input-to-render-end observations. Those cells are not isolated click latency
or causal evidence for a renderer speedup. No validation suite overlapped the
after timing command, but this remains a shared-host, unequal-time comparison.
The fitted 1200-node drag tail and camera/zoom results still miss the final
refresh-rate targets; intermittent slow-spell attribution remains open.

## Phase-aligned graph images (2026-11-18)

Development comparison, not an accepted performance improvement. Before is
`8e6b3e9d` (extracted direct graph painter); after is `e0295030` (retained
512-device-pixel graph tiles). X570, RTX 4090, Chromium 149 Vulkan, uncapped,
2560x1440, 2500 ms inputs, three alternating repetitions per side. Both use
production-optimized test-mode builds and the unchanged audit frame harness.
The isolated CPU backend uses the hosted pin `09a19d69` and a verified sealed
pack generation. Ordinary production entry, fast gates and kept units also
pass; that does not establish performance acceptance.

Each cell is the median of three per-run p50/p95 frame times, in milliseconds.
Drag runs separately from pan/zoom. These are not pooled percentiles or a
claim about display refresh rate.

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 1.5/2.0 | 4.9/10.7 | 2.6/5.0 | 6.6/10.3 | 1.5/2.1 | 4.9/11.5 |
| 66/fit | 1.4/2.7 | 2.7/23.5 | 2.5/6.5 | 4.5/12.5 | 1.3/9.1 | 2.8/20.5 |
| 300/read | 1.9/2.6 | 8.4/13.8 | 2.1/3.0 | 7.3/10.4 | 1.9/2.6 | 6.0/19.3 |
| 300/fit | 3.0/11.1 | 6.2/22.7 | 2.8/6.2 | 7.2/24.0 | 3.2/12.3 | 5.8/18.8 |
| 1200/read | 1.9/2.6 | 18.6/24.7 | 2.2/3.3 | 16.6/21.3 | 2.2/3.4 | 9.4/17.1 |
| 1200/fit | 10.8/31.9 | 22.4/37.5 | 6.7/19.9 | 21.6/37.7 | 11.7/37.2 | 22.3/32.7 |

This candidate regresses active movement despite passing retained-history
pixel comparisons and eligible same-phase pan counting checks. Exact-phase
and scale changes retire tiles; each missing tile invokes the graph painter.
Counting reuse for a matching transform alone does not bound work for normal
fractional camera input or repeated graph invalidation. This implementation
is not ready for adoption. A separate 300-node diagnostic confirms that
integer camera steps paint zero tiles, while fractional-phase changes repaint
20 tiles at readable zoom and 24 at fit. All 24 actual pointer-pan samples at
each zoom change phase and repaint graph tiles (470 and 492 graph-painter
invocations respectively). This establishes a cache-miss mechanism on that
input path, not an attribution of every measured frame gap.

The unchanged wheel-flood probe can queue events across camera presets. Some
input-to-render-end values reach seconds, and some subsequent fitted pan
cells include queued work. Those values are not isolated click latency or
proof of a specific tab-save/GC cause. The separate drag runs retain their
existing settle and valid-movement checks. Raw cells are retained rather than
rerun to replace unfavorable measurements.

## Pixel-aligned pan reuse (2026-11-18)

Aligning paint translation to physical pixels keeps the logical camera's
fractional coordinates and avoids resampling retained images. Three new
candidate-only repetitions use the same production build mode, hardware and
unchanged pan/zoom harness as the preceding comparison; the earlier baseline
cells are retained, not rerun. Zoom still rerasterizes at each new scale.
The source remains a development candidate, not an accepted improvement.

Median per-run p50/p95 times in milliseconds:

| Fixture/camera | Pan frame | Pan renderer | Zoom frame | Zoom renderer |
| --- | --- | --- | --- | --- |
| 66/read | 16.7/17.7 | 0.1/0.2 | 8.6/13.2 | 7.5/12.0 |
| 66/fit | 16.0/17.6 | 0.1/0.2 | 5.0/15.0 | 4.4/13.7 |
| 300/read | 5.0/17.7 | 0.1/0.2 | 7.9/11.7 | 7.1/10.7 |
| 300/fit | 6.4/23.3 | 5.4/20.5 | 8.6/24.6 | 7.8/24.1 |
| 1200/read | 14.9/17.7 | 0.1/0.2 | 16.8/22.0 | 16.2/21.0 |
| 1200/fit | 24.3/39.5 | 19.0/33.4 | 20.5/36.8 | 20.1/36.3 |

A separate controlled 300-node pointer-pan probe reduces graph-painter calls
from 470 to 10 at readable zoom (only newly exposed tiles), and from 492 to
zero at fit, across 24 samples per camera. Fractional camera coordinates are
unchanged. The 66/300/1200 counting cases now require reuse on fractional pans
as well as integer pans, and retain bitmap lifetime checks on zoom/theme/
departure/disposal. The prior implementation fails all three new controls.

Lower renderer CPU cost is not display-frame acceptance: the uncapped frame
probe still reports gaps around 17 ms, whose initiating cause is not yet
established. Fitted pan cells follow wheel flooding and retain the preceding
queue-contamination limitation. Zoom remains more expensive than direct
painting. No frame, zoom, or whole-issue target is accepted from these runs.

## Tile-region scene culling (2026-11-18)

Before rebuilding missing graph tiles, nodes and links are culled once to
complete tile bounds, including bleed. Each tile retains its own exact
painter, clipping and raster origin. The overview batching threshold still
uses the complete scene, not the reduced candidate list. Integer/fractional
pan reuse and bitmap retirement behavior are unchanged.

One candidate production-optimized test-mode run uses the same X570 RTX 4090,
Chromium 149 Vulkan, uncapped 2560x1440 and 2500 ms audit inputs. Before values
below are the preceding three-run aligned medians, not new paired runs; after
values are one run. Shared-host CPU validation overlapped this run. These
frame p50/p95 values are reporting evidence, not causal speedup or acceptance.

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag after |
| --- | --- | --- | --- | --- | --- |
| 300/read | 5.0/17.7 | 5.1/17.5 | 7.9/11.7 | 6.3/11.7 | 7.1/23.7 |
| 300/fit | 6.4/23.3 | 2.0/17.5 | 8.6/24.6 | 9.0/28.7 | 12.4/37.6 |
| 1200/read | 14.9/17.7 | 5.9/17.4 | 16.8/22.0 | 8.6/13.9 | 13.6/17.5 |
| 1200/fit | 24.3/39.5 | 1.1/17.4 | 20.5/36.8 | 22.0/43.6 | 27.6/64.0 |

Readable pan renderer p50/p95 is 0.1/0.3 ms at both sizes. Fitted zoom/drag
remain expensive and wheel queues contaminate later cells; the seconds-long
input delays are not isolated click measurements. No target is accepted.
A separate instrumented zoom probe reduces readable endpoint projections
from about 11970 to 2955 per 300-node frame and 36480 to 3665 at 1200 nodes.
Its full-scene control retains the preliminary culling pass, so its render
means are not an independent baseline. The fixed 66/300/1200 tests bound
reads of offscreen geometry as well as image copies and fractional reuse;
the prior painter fails all three geometry bounds. Raw GPU diagnostic
readbacks also show an initial fitted-frame mismatch in an unchanged
control; that diagnostic is not counted as strict equivalence acceptance.
The separate 97-case fresh-renderer browser comparison and 90 unchanged
gallery comparisons pass. Four fractional-DPR anatomy/overview captures in
both themes are byte-identical to the prior renderer and were inspected.

## GPU frame readback control (2026-11-18)

The earlier fitted-frame mismatch is reproducible without changing the
painter, scene or camera. On the same production-optimized 1200-node fitted
canvas, five consecutive invalidated redraws with default context options
have adjacent RGBA channel differences of 0, 33786, 0 and 0. Chromium also
warns about repeated readbacks. Explicitly choosing either
`willReadFrequently: false` or `true` at initial context creation yields
zero differences for all four adjacent comparisons, without a warning.
Fresh full-scene and region-culled renderers also match at 300 and 1200
nodes, with and without app layers. These controls isolate the diagnostic's
readback-policy transition, not a culling change or a frame-time cause.

The whole-frame helper now explicitly chooses `willReadFrequently: false`
for both retained and fresh canvases. On Chromium 149 Vulkan, six execution-
state cases fail before this setup change; all 97 cases pass after it, with
identical zero-tolerance assertions. Production contexts are unchanged.
These pixel controls do not accept a performance target, explain the user's
original slow spells or replace any preceding timing sample.

## Per-tile candidate binning (2026-11-18)

Missing tiles receive only intersecting nodes and links, in scene order.
Bounds are computed once per rebuild, including live offsets, resize geometry,
paint padding and bleed. Conservative neighboring bins are checked with the
painter's world-space comparisons so floating-point edge rounding cannot
exclude a touched tile. Tile raster origins, clipping and transfers are unchanged.

Production-optimized test-mode build, X570 RTX 4090, Chromium 149 Vulkan,
uncapped 2560x1440, unchanged audit harness, 2500 ms inputs. Before values at
300/1200 nodes are the single region-culling run above; the 66-node baseline
is the earlier three-run aligned median. After is one candidate run. These
are not paired causal estimates. CPU validation overlapped candidate timing.

Frame p50/p95 in milliseconds:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 16.7/17.7 | 1.8/17.6 | 8.6/13.2 | 8.5/13.7 | not measured | 5.6/16.8 |
| 66/fit | 16.0/17.6 | 16.8/17.5 | 5.0/15.0 | 5.6/17.6 | not measured | 3.0/24.7 |
| 300/read | 5.1/17.5 | 3.7/17.5 | 6.3/11.7 | 5.4/13.9 | 7.1/23.7 | 8.1/24.9 |
| 300/fit | 2.0/17.5 | 2.0/17.5 | 9.0/28.7 | 9.5/32.7 | 12.4/37.6 | 9.7/30.9 |
| 1200/read | 5.9/17.4 | 1.3/17.5 | 8.6/13.9 | 7.1/12.2 | 13.6/17.5 | 7.7/16.7 |
| 1200/fit | 1.1/17.4 | 3.6/17.5 | 22.0/43.6 | 22.5/48.1 | 27.6/64.0 | 25.0/64.8 |

A separate same-browser instrumented comparison calls the actual preceding
and candidate tile methods across 12 scales. Excluding the first scale,
300-node fitted endpoint projections fall from 13624 to 570 per frame and
node-candidate visits from 7200 to 366; at 1200 fitted they fall from 31946
to 2280 and 16882 to 1225. Graph-painter calls remain 24 and 15 respectively.
Synchronous fitted render means are 6.12 -> 5.02 ms at 300 nodes but
15.95 -> 17.63 ms at 1200. Thus work counts improve without establishing
fitted-frame speedup. Sixteen raw GPU frame comparisons across both sizes,
readable/fitted cameras, exposed pans and zoom match the prior renderer.

The fixed 66/300/1200 tests retain fractional reuse and lifetime assertions
and bound public link-endpoint reads by the scene count plus 128. The prior
renderer fails all three: 390>194, 1056>428 and 1956>1328. A separate boundary
probe finds 245 missed inclusions in 5856 arithmetic-only bin checks; the
conservative world-space check has none. The preliminary arithmetic-only
candidate's timing and captures are retained separately, not substituted
for final measurements. Four final anatomy/overview captures at DPR1.25
are byte-identical to prior-renderer controls and were inspected.

Readable pan renderer p50/p95 remains 0.1/0.2-0.3 ms, while frame p95 stays
near 17.5 ms. Fitted zoom/drag remain expensive. Wheel flooding queues events
across cells, with seconds-long input delays that are not isolated clicks;
the preceding queue and shared-host limitations still apply. No target,
slow-spell cause, display refresh rate or whole-issue acceptance is claimed.

## Canonical uncached repaint and badge extent integration (2026-11-18)

One candidate run uses the unchanged production-optimized audit harness on
X570 RTX 4090, Chromium 149 Vulkan, uncapped 2560x1440, with 2500 ms inputs.
The candidate includes the canonical uncached full-scene raster path and
landed badge extent API; production badge layout remains chips. Before is
the preceding title/palette candidate run, not a replay. These unpaired,
shared-host observations overlap browser checks and builds; they do not
establish a causal speedup or satisfy a performance gate.

Frame p50/p95 in milliseconds:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 15.5/17.7 | 1.3/17.6 | 7.9/13.3 | 8.7/14.3 | 5.1/15.4 | 5.8/14.0 |
| 66/fit | 2.0/17.6 | 1.4/17.5 | 5.3/16.0 | 6.3/16.5 | 2.9/22.3 | 4.1/22.8 |
| 300/read | 6.2/17.7 | 1.1/17.5 | 5.0/12.7 | 6.6/12.9 | 7.9/23.8 | 10.4/18.7 |
| 300/fit | 1.8/17.5 | 1.1/17.5 | 10.0/35.7 | 10.1/30.0 | 9.6/30.6 | 6.6/23.0 |
| 1200/read | 3.1/17.6 | 1.5/17.5 | 6.0/15.8 | 7.9/12.6 | 6.4/19.2 | 7.7/15.0 |
| 1200/fit | 1.3/17.6 | 4.0/17.6 | 19.2/43.0 | 17.2/44.3 | 24.7/51.8 | 26.0/47.4 |

Readable pan renderer p50/p95 is 0.1-0.2/0.2-0.3 ms, while frame p95 remains
17.5-17.6 ms. Fitted 1200 drag input-to-render-end p50/p95 is
18582.5/25380.6 ms with renderer p50/p95 25.1/46.4 ms. Wheel-queued input
contaminates that value; it is not isolated click latency or an explanation
of the intermittent slow spells. The measured frame targets remain unmet.
The unchanged sealed native generation verifies 42185 files with no errors.

## Graph images with adopted title and palette paint (2026-11-18)

The cache candidate includes the normal-width title ellipsis and per-theme
type colors adopted in main `07018799`. One candidate run uses the unchanged audit
harness, X570 RTX 4090, Chromium 149 Vulkan, uncapped 2560x1440 and 2500 ms
inputs. Before is the preceding single tile-binning run, not a replay.
These are unpaired reports, not causal speedup or target acceptance. CPU
browser validation and capture work overlapped part of the candidate run.

Frame p50/p95 in milliseconds:

| Fixture/camera | Pan before | Pan after | Zoom before | Zoom after | Drag before | Drag after |
| --- | --- | --- | --- | --- | --- | --- |
| 66/read | 1.8/17.6 | 15.5/17.7 | 8.5/13.7 | 7.9/13.3 | 5.6/16.8 | 5.1/15.4 |
| 66/fit | 16.8/17.5 | 2.0/17.6 | 5.6/17.6 | 5.3/16.0 | 3.0/24.7 | 2.9/22.3 |
| 300/read | 3.7/17.5 | 6.2/17.7 | 5.4/13.9 | 5.0/12.7 | 8.1/24.9 | 7.9/23.8 |
| 300/fit | 2.0/17.5 | 1.8/17.5 | 9.5/32.7 | 10.0/35.7 | 9.7/30.9 | 9.6/30.6 |
| 1200/read | 1.3/17.5 | 3.1/17.6 | 7.1/12.2 | 6.0/15.8 | 7.7/16.7 | 6.4/19.2 |
| 1200/fit | 3.6/17.5 | 1.3/17.6 | 22.5/48.1 | 19.2/43.0 | 25.0/64.8 | 24.7/51.8 |

Readable-pan renderer p50/p95 remains 0.1/0.2-0.3 ms, but frame p95 remains
17.5-17.7 ms. Wheel flooding still queues events: the final fitted drag has
input-to-render-end p50/p95 18523.8/25119.8 ms despite renderer p50/p95
24.3/47.3 ms. This is contaminated queued-input reporting, not isolated
click latency or an explanation of the original intermittent slow spells.

The integrated retained-history/fresh-tile comparisons pass, but an
additional main-direct versus tiled control at physically aligned DPR1.25
finds 785/697 different RGBA channels in dark/light anatomy and 1872/892
in overview. Fractional-paint alignment also intentionally differs from
main's former fractional raster origin. The aligned control still requires
source discrimination; it is not explained away by that tradeoff. No pixel
tolerance or assertion was relaxed, and direct painting is now checked as
an additional independent oracle. This candidate is not ready for adoption.

## Canvas click and save reporting (2026-11-17)

The reporting tools in `scripts/canvas-performance/` retain the input and
frame probes from the canvas audit. They impose no timing assertions and
are not part of CI. Counting checks run in the fast and browser lanes.
Use a production-optimized **test-mode** build to expose the workload bridge;
ordinary production builds deliberately omit it. Start a local backend and
preview separately, then run from the repository root:

```bash
pnpm --filter @dinkster/app exec vite build --mode test
# In packages/app, with DINKSTER_NATIVE_BACKEND pointing at the local engine:
pnpm preview --host 127.0.0.1 --port 4173 --strictPort
# In another shell, from the repository root:
node scripts/canvas-performance/discrete.mjs url=http://127.0.0.1:4173/ mode=gpu uncapped=1 size=2560x1440 workload=syn1200 "only=select node,node context menu" out=.amp/in/clicks.json
node scripts/canvas-performance/measure.mjs url=http://127.0.0.1:4173/ mode=gpu uncapped=1 size=2560x1440 workloads=default7,trellis66,syn300,syn1200 cameras=read,fit interactions=hover,pan out=.amp/in/frames.json
```

Create and ignore `.amp/in/` locally before writing results there. On shared
GPU hosts, run each browser command through the host's GPU claim tool.
`mode=gpu` uses headless Chromium Vulkan; `uncapped=1` disables the frame
limiter and vsync. `mode=sw` requires `AUDIT_DISPLAY` naming the caller's
private DUMMY0 X server, whose configured modes the tool changes. It never
selects a desktop display automatically.

The frame tool reports idle, hover, pan, zoom, drag and marquee when named
in `interactions`. Run `interactions=drag` separately from wheel flooding:
queued wheel events can distort subsequent drag latency. A valid drag
must change the picked node's position. Do not treat a skipped or invalid
scenario as a passing measurement. `read` is 100% zoom and `fit` shows the
whole graph. The click tool reports one warmup and then three samples by
default (`reps` overrides this). Frame and click data include medians,
percentiles and maxima. The target is <4 ms/frame through 300 nodes,
<6.9 ms/frame at 1200, next-frame pointer redraw with <2 ms page time through
300, and first click feedback <8 ms through 300 or <16 ms at 1200. Menus,
panels and rails target <16 ms. These are reporting targets, not CI gates.

X570, RTX 4090, Chromium 149, 2560x1440, same optimized build configuration.
Before: `b1a951b6`; after: `67ff2856`. Three measured samples after warmup.
All values below are first-frame p50 in milliseconds. The large-graph
improvement does not yet meet the final timing targets.

| Nodes | Selection before | Selection after | Node menu before | Node menu after |
| --- | --- | --- | --- | --- |
| 7 | 19.0 | 19.0 | 17.9 | 18.6 |
| 66 | 20.8 | 21.1 | 19.0 | 19.1 |
| 300 | 26.2 | 19.7 | 25.4 | 18.9 |
| 1200 | 114.4 | 20.7 | 87.8 | 17.8 |

A separate 1200-node delayed-save observation used three camera updates and
three edits, observing 350-1500 ms after each command. Maximum frame gaps:

| Operation | Before trials (ms) | After trials (ms) |
| --- | --- | --- |
| Camera save | 86.4 / 87.7 / 83.6 | 19.2 / 17.4 / 17.4 |
| Edit save | 114.3 / 121.2 / 115.9 | 31.8 / 24.3 / 19.9 |

The baseline produced >50 ms long tasks near the 400 ms save timer. The
after save windows produced none and no main-thread JSON.stringify result
above 100 KB. CPU-profile GC samples totaled 80.4 ms before and 34.4 ms after
across the complete camera/edit run. This shows save work and GC contribute;
it does not establish that all remaining frame gaps are GC. One 216.1 ms
gap ended 208.8 ms after edit dispatch, before the save timer, so it is not
attributed to delayed saving.

## Retained minimap and per-frame cleanup (2026-11-18)

Camera movement retains the minimap graph bitmap and repaints its camera,
bookmark and presence overlays. Scene, execution-state, size and explicit host
refreshes invalidate the bitmap. The grid uses one world-anchored repeating
tile fill; both scratch surfaces use detached HTML canvases when OffscreenCanvas
is unavailable. Connectivity lookups rebuild on scene installation. Renderer and
editor camera feedback remain immediate. App-state camera writes coalesce
until 100 ms without another camera update, or flush before graph switching,
host disposal and tab persistence (including page exit).

Before is main `63583ad7`; after is the per-frame implementation in PR 517.
The unchanged reporting harness used X570 GPU0 (RTX 4090), headless Chromium
Vulkan, uncapped frames, a 2560x1440 viewport, 2500 ms inputs, three repetitions,
and optimized test-mode builds exposing only the workload bridge. The ordinary
production entry also builds and verifies without that bridge. The local CPU
backend was `3bc0f22c`, not the hosted pin. These are median per-run p50/p95
frame times, in milliseconds, not pooled percentiles or display refresh rates.
Unit checks overlapped late baseline cells; possible CPU contention is disclosed.
The after runs preceded a persistence-flush ordering fix; that fix changes
teardown, not the timed active-camera path. Final browser checks cover it.

| Nodes | Camera | Input | Before p50/p95 | After p50/p95 |
| --- | --- | --- | --- | --- |
| 66 | Read | Pan | 2.3/3.4 | 2.0/3.9 |
| 66 | Read | Zoom | 3.1/6.1 | 3.3/7.7 |
| 66 | Read | Drag | 2.1/3.0 | 2.0/6.2 |
| 66 | Fit | Pan | 5.1/8.3 | 1.4/3.3 |
| 66 | Fit | Zoom | 5.7/10.8 | 2.8/8.0 |
| 66 | Fit | Drag | 5.0/7.2 | 1.4/5.0 |
| 300 | Read | Pan | 3.3/5.5 | 1.9/2.9 |
| 300 | Read | Zoom | 3.0/4.5 | 2.3/3.4 |
| 300 | Read | Drag | 2.6/3.4 | 1.9/3.9 |
| 300 | Fit | Pan | 5.7/13.4 | 3.4/12.3 |
| 300 | Fit | Zoom | 5.4/11.1 | 3.7/8.3 |
| 300 | Fit | Drag | 4.7/15.3 | 3.7/16.3 |
| 1200 | Read | Pan | 9.7/20.4 | 2.1/3.6 |
| 1200 | Read | Zoom | 7.7/16.9 | 2.4/3.9 |
| 1200 | Read | Drag | 3.3/4.6 | 2.0/3.1 |
| 1200 | Fit | Pan | 20.2/54.3 | 11.5/36.9 |
| 1200 | Fit | Zoom | 16.2/34.3 | 6.9/20.0 |
| 1200 | Fit | Drag | 21.4/56.5 | 14.2/37.6 |

These numbers do not meet the whole-canvas targets at every zoom. The fitted
1200-node graph still needs less graph painting, and tail latency remains.
Wheel flooding queues input, so its subsequent drag/input latency is not an
isolated click measurement. The timing script gates nothing. Counting checks
cover fixed 66/300/1200-node drawing budgets, no camera-only minimap geometry
paint or link-lookup rebuild, and one next-frame draw per drag pointer event.
Camera persistence checks retain the zero workflow reserialization/checksum
contract and cover pause coalescing, graph switching and page-exit restoration.

## Viewport (pan + zoom, 120 frames, read-only hot path)

| Workload | Date | Commit | avg frame | p95 frame |
| --- | --- | --- | --- | --- |
| 1200 nodes | 2026-07-23 | pre-decomposition baseline | 19.5 ms | 31-33 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | pre-decomposition baseline | 21.8 ms | 38-41 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 1 (NodePalette) | 19.6 ms | 30.4 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 1 (NodePalette) | 21.9 ms | 39.5 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 2 (setupMinimap) | 19.5 ms | 30.8 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 2 (setupMinimap) | 22.1 ms | 39.0 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 3 (createPreviewLoader) | 19.4 ms | 30.4 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 3 (createPreviewLoader) | 22.0 ms | 38.8 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 4 (WidgetEditor) | 19.4 ms | 30.1 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 4 (WidgetEditor) | 21.9 ms | 38.0 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 5 (ContextMenu) run 1 | 19.4 ms | 30.4 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 5 (ContextMenu) run 1 | 22.9 ms | 42.6 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 5 (ContextMenu) run 2 | 19.6 ms | 31.8 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 5 (ContextMenu) run 2 | 21.9 ms | 38.3 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 6 (BadgePopover) | 19.4 ms | 30.0 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 6 (BadgePopover) | 22.2 ms | 40.4 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 7 (NamePrompt) | 19.7 ms | 30.8 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 7 (NamePrompt) | 22.2 ms | 39.0 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 8 (camera bookmarks) | 19.4 ms | 30.4 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 8 (camera bookmarks) | 22.0 ms | 39.0 ms |
| 1200 nodes | 2026-07-23 | decomposition slice 9 (scene overlays) | 19.5 ms | 30.1 ms |
| 1200 nodes + 1140 reroutes | 2026-07-23 | decomposition slice 9 (scene overlays) | 22.2 ms | 40.2 ms |

## Document open and edit loop (1200-node doc)

| Metric | Date | Commit | Value |
| --- | --- | --- | --- |
| openDocument (loadDocument + tab) | 2026-07-23 | pre-decomposition baseline | 51.7 ms |
| first paint after open | 2026-07-23 | pre-decomposition baseline | 50.6 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | pre-decomposition baseline | 26.5 ms |
| repaint after dispatch avg | 2026-07-23 | pre-decomposition baseline | 34.0 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 1 (NodePalette) | 51.9 ms |
| first paint after open | 2026-07-23 | decomposition slice 1 (NodePalette) | 49.9 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 1 (NodePalette) | 25.9 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 1 (NodePalette) | 35.3 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 2 (setupMinimap) | 58.5 ms |
| first paint after open | 2026-07-23 | decomposition slice 2 (setupMinimap) | 48.5 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 2 (setupMinimap) | 26.3 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 2 (setupMinimap) | 34.1 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 3 (createPreviewLoader) | 49.4 ms |
| first paint after open | 2026-07-23 | decomposition slice 3 (createPreviewLoader) | 48.3 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 3 (createPreviewLoader) | 25.7 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 3 (createPreviewLoader) | 34.1 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 4 (WidgetEditor) | 47.9 ms |
| first paint after open | 2026-07-23 | decomposition slice 4 (WidgetEditor) | 50.2 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 4 (WidgetEditor) | 26.2 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 4 (WidgetEditor) | 34.6 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 5 (ContextMenu) | 51.3 / 54.1 ms |
| first paint after open | 2026-07-23 | decomposition slice 5 (ContextMenu) | 48.7 / 49.5 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 5 (ContextMenu) | 26.1 / 26.8 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 5 (ContextMenu) | 36.0 / 35.2 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 6 (BadgePopover) | 51.6 ms |
| first paint after open | 2026-07-23 | decomposition slice 6 (BadgePopover) | 50.6 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 6 (BadgePopover) | 25.9 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 6 (BadgePopover) | 34.4 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 7 (NamePrompt) | 50.9 ms |
| first paint after open | 2026-07-23 | decomposition slice 7 (NamePrompt) | 47.2 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 7 (NamePrompt) | 26.4 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 7 (NamePrompt) | 35.0 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 8 (camera bookmarks) | 55.3 ms |
| first paint after open | 2026-07-23 | decomposition slice 8 (camera bookmarks) | 48.2 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 8 (camera bookmarks) | 26.9 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 8 (camera bookmarks) | 35.3 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | decomposition slice 9 (scene overlays) | 51.5 ms |
| first paint after open | 2026-07-23 | decomposition slice 9 (scene overlays) | 53.9 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | decomposition slice 9 (scene overlays) | 26.2 ms |
| repaint after dispatch avg | 2026-07-23 | decomposition slice 9 (scene overlays) | 36.2 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-23 | connection slices 1-3 (discovery + default) | 19.4 / 32.2 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-23 | connection slices 1-3 (discovery + default) | 21.8 / 38.7 ms |
| openDocument (loadDocument + tab) | 2026-07-23 | connection slices 1-3 (discovery + default) | 48.4 / 51.7 / 53.4 ms |
| first paint after open | 2026-07-23 | connection slices 1-3 (discovery + default) | 51.8 / 47.1 / 51.3 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | connection slices 1-3 (discovery + default) | 27.3-28.3 ms |
| repaint after dispatch avg | 2026-07-23 | connection slices 1-3 (discovery + default) | 34.2-34.7 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-23 | assets/previews slice | 19.6 / 33.2 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-23 | assets/previews slice | 21.6 / 39.4 ms |
| 1200 nodes + a decoded preview panel on EVERY node, frame avg / p95 | 2026-07-23 | assets/previews slice (NEW workload) | 21.2 / 35.5 ms |
| cold decode, 64 unique 256x256 pngs, concurrent HTMLImageElement.decode (the loader's asset path) | 2026-07-23 | assets/previews slice (NEW workload) | 58 ms total |
| openDocument (loadDocument + tab) | 2026-07-23 | assets/previews slice | 50.8 ms |
| first paint after open | 2026-07-23 | assets/previews slice | 49.7 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | assets/previews slice | 27.9 ms |
| repaint after dispatch avg | 2026-07-23 | assets/previews slice | 34.6 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-23 | CV baseline (81c4547) | 19.11 / 29.7 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-23 | CV baseline (81c4547) | 21.41 / 38.6 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-07-23 | CV baseline (81c4547) | 20.9 / 34.2 ms |
| cold decode, 64 unique 256x256 pngs, concurrent decode | 2026-07-23 | CV baseline (81c4547) | 55.6 ms total |
| openDocument (loadDocument + tab) | 2026-07-23 | CV baseline (81c4547) | 62.3 ms |
| first paint after open | 2026-07-23 | CV baseline (81c4547) | 49.5 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | CV baseline (81c4547) | 27.3 ms |
| repaint after dispatch avg | 2026-07-23 | CV baseline (81c4547) | 34.2 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-23 | CV slice, intermediate run | 19.0 / 30.1 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-23 | CV slice, intermediate run | 21.5 / 38.8 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-07-23 | CV slice, intermediate run | 21.1 / 35.4 ms |
| cold decode, 64 unique 256x256 pngs, concurrent decode | 2026-07-23 | CV slice, intermediate run | 53.2 ms total |
| openDocument (loadDocument + tab) | 2026-07-23 | CV slice, intermediate run | 82.9 ms |
| first paint after open | 2026-07-23 | CV slice, intermediate run | 50.7 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | CV slice, intermediate run | 24.2 ms |
| repaint after dispatch avg | 2026-07-23 | CV slice, intermediate run | 34.9 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-23 | CV slice, final (canonical) | 19.2 / 31.9 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-23 | CV slice, final (canonical) | 21.8 / 40.2 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-07-23 | CV slice, final (canonical) | 22.0 / 39.8 ms |
| cold decode, 64 unique 256x256 pngs, concurrent decode | 2026-07-23 | CV slice, final (canonical) | 56.0 ms total |
| openDocument (loadDocument + tab) | 2026-07-23 | CV slice, final (canonical) | 64.7 ms |
| first paint after open | 2026-07-23 | CV slice, final (canonical) | 45.8 ms |
| node.move dispatch avg (20 moves) | 2026-07-23 | CV slice, final (canonical) | 30.3 ms |
| repaint after dispatch avg | 2026-07-23 | CV slice, final (canonical) | 38.7 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-24 | field-failure batch (intrinsic widget defaults, boundary migration, unresolved rendering, row marks, white drop targets) | 19.40 / 31.6 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-24 | field-failure batch | 22.04 / 39.7 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-07-24 | field-failure batch | 20.90 / 36.1 ms |
| cold decode, 64 unique 256x256 pngs, concurrent decode | 2026-07-24 | field-failure batch | 56.5 ms total |
| openDocument (loadDocument + tab) | 2026-07-24 | field-failure batch | 65.5 ms |
| first paint after open | 2026-07-24 | field-failure batch | 51.9 ms |
| node.move dispatch avg (20 moves) | 2026-07-24 | field-failure batch | 26.15 ms |
| repaint after dispatch avg | 2026-07-24 | field-failure batch | 35.95 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-27 | batch 7 merged (63d7729: reroute ranges/presence, pin rings, partial scope, exec modes) | 19.41 / 31.5 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-27 | batch 7 merged (63d7729) | 22.58 / 42.0 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-07-27 | batch 7 merged (63d7729) | 22.45 / 39.7 ms |
| cold decode, 64 unique 256x256 pngs, concurrent decode | 2026-07-27 | batch 7 merged (63d7729) | 52.7 ms total |
| openDocument (loadDocument + tab) | 2026-07-27 | batch 7 merged (63d7729) | 88.3 ms |
| first paint after open | 2026-07-27 | batch 7 merged (63d7729) | 53.0 ms |
| node.move dispatch avg (20 moves) | 2026-07-27 | batch 7 merged (63d7729) | 30.30 ms |
| repaint after dispatch avg | 2026-07-27 | batch 7 merged (63d7729) | 38.57 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-07-28 | batch 8 merged (93df1a3: gesture guards, tab strip, settings search, shell chrome, exec availability + between) | 19.57 / 32.9 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-07-28 | batch 8 merged (93df1a3) | 22.07 / 40.8 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-07-28 | batch 8 merged (93df1a3) | 21.08 / 35.3 ms |
| cold decode, 64 unique 256x256 pngs, concurrent decode | 2026-07-28 | batch 8 merged (93df1a3) | 50.9 ms total |
| openDocument (loadDocument + tab) | 2026-07-28 | batch 8 merged (93df1a3) | 87.1 ms |
| first paint after open | 2026-07-28 | batch 8 merged (93df1a3) | 53.3 ms |
| node.move dispatch avg (20 moves) | 2026-07-28 | batch 8 merged (93df1a3) | 29.22 ms |
| repaint after dispatch avg | 2026-07-28 | batch 8 merged (93df1a3) | 36.14 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-08-07 | audit before direct non-multiline fast path (204f20c) | 17.31 / 23.40 ms |
| 1200-node pan/zoom frame avg / p95 | 2026-08-07 | audit after direct non-multiline fast path (41d47f2) | 17.33 / 23.50 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-08-07 | audit before direct non-multiline fast path (204f20c) | 18.73 / 28.80 ms |
| 1200-node + 1140 reroutes frame avg / p95 | 2026-08-07 | audit after direct non-multiline fast path (41d47f2) | 18.73 / 29.00 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-08-07 | audit before direct non-multiline fast path (204f20c) | 18.34 / 26.60 ms |
| 1200 nodes + 1200 previews frame avg / p95 | 2026-08-07 | audit after direct non-multiline fast path (41d47f2) | 18.07 / 25.50 ms |

audit was measured twice on fresh Playwright-owned servers with the tracked
`playwright.isolated.config.ts` (port 5299, `reuseExistingServer: false`) and
the three pan/zoom workloads in `perf.spec.ts`. The native isolated startup
has two initial tabs rather than the legacy fixture's three, so the
measurement-only runs relaxed that one tab-count assertion; the workload,
frame loop, budgets, and timing annotations were unchanged, and the tracked
test was restored afterward. The exact invocation was
`pnpm exec playwright test --config=playwright.isolated.config.ts perf.spec.ts
--grep 'pans and zooms' --reporter=json`. All three workloads passed before
and after. The readings are perf-neutral: the plain and reroute deltas are at
or below 0.2 ms and the preview-heavy after-run is slightly lower. The final
painter preserves the old direct non-`core.text` path, avoiding the temporary
one-element array and iterator on every ordinary registry text operation.
Caching or bounding `core.text` wrap preparation remains deferred until a
multiline-heavy measured workload or these frame budgets show a regression.

The 2026-07-24 field-failure batch (compile-time intrinsic widget defaults,
atomic boundary migration, full-body unresolved-node rendering with fallback
rows and inferred pins, diagnosed-row red outlines, white drop targets) is
perf-neutral: every number sits inside the band of the 07-23 runs. The
unresolved-rendering path only activates for missing-schema nodes, and row
marks are an O(marked rows) map lookup during node paint.

Slice 1 (NodePalette extraction, CanvasHost 4686 -> 4211 lines) is perf-
neutral, as expected for a pure extraction: the palette renders only while
open and is not on the pan/zoom or dispatch hot paths.

Slice 2 (setupMinimap factory, CanvasHost 4211 -> 4108 lines) is perf-
neutral on frames and dispatch; the 58.5 ms openDocument reading is single-
run noise on an unchanged code path (frame and repaint numbers identical) -
watch the next slice's row rather than reacting to one sample.

Slice 3 (createPreviewLoader, CanvasHost 4108 -> 3981 lines) is perf-
neutral across the board, and its 49.4 ms openDocument confirms slice 2's
58.5 ms reading was noise (back inside the baseline's 49-52 ms band).

Slice 4 (WidgetEditor, CanvasHost 3981 -> 3032 lines) is perf-neutral: the
editor overlay only mounts while an editor is open, so pan/zoom, open, and
dispatch paths are untouched. All readings sit inside the established bands.

Slice 5 (ContextMenu + menu-target, CanvasHost 3032 -> 2877 lines) is perf-
neutral; the menu never mounts during pan or dispatch. Run 1's reroute p95
(42.6 ms) landed above the 38-41 ms band, so the suite was rerun: run 2's
21.9 ms avg / 38.3 ms p95 is back inside it, marking run 1 as noise (same
verdict pattern as slice 2's openDocument reading). Both runs recorded.

Slice 6 (BadgePopover + badge-info, CanvasHost 2877 -> 2695 lines) is perf-
neutral; the popover only mounts on a badge click and its content resolvers
run lazily at render. All readings inside the established bands (the 40.4 ms
reroute p95 sits within the 38-41 ms band).

Slice 7 (NamePrompt dedup, CanvasHost 2695 -> 2640 lines) is perf-neutral;
the prompt only mounts on a rename/create action. All readings inside the
established bands.

Slice 8 (camera bookmarks: bookmarkJumpPlan + createCameraAnimator,
CanvasHost 2640 -> 2595 lines) is perf-neutral; the animator and jump
planner only run on a digit keypress, never on the pan/zoom or dispatch hot
paths. Frame and dispatch readings are inside the established bands; the
55.3 ms openDocument sits just above the 49-52 ms band on an unchanged code
path - same single-run-noise pattern as slice 2 (watch the next row).

Slice 9 (deriveSceneOverlays, CanvasHost 2595 -> 2493 lines) restructures
the overlay refresh (derive one model, then install it) without adding
paints or reactive effects - the derivation runs the same work in the same
two call sites (post-scene-rebuild, execution/preview/registry ticks). All
readings inside the established bands; slice 8's 55.3 ms openDocument
confirmed as noise (back to 51.5 ms).

Connection slices 1-3 (protocol discovery, backend persistence, native-first
same-origin default) add a pre-render same-origin discovery (three small
concurrent probes; the v1 probe uses /system_stats, deliberately NOT the
megabytes-heavy /object_info) and are neutral on every canvas metric - all
readings inside the established bands. A one-off 71.6 ms openDocument under
full parallel suite load did not reproduce in isolation (48-53 ms over three
runs).

Assets/previews slice adds the first preview-heavy workload row: the same
1200-node graph with a decoded image panel installed on EVERY node (64
unique 256x256 images shared across the 1200 panels - decode work scales
with unique content, matching PREVIEW_CACHE_MAX=64, while paint work scales
with visible panels). Pan/zoom lands at 21.2 ms avg / 35.5 ms p95 - inside
the no-preview REROUTE band and the 33/100 ms budgets, only ~+1.6 ms avg
over the bare 1200-node run. Cold decode through the loader's actual asset
path (concurrent HTMLImageElement.decode from URLs, off the frame loop) is
58 ms total for all 64 unique images - negligible. (An earlier draft of
this row reported ~1.07 s, but that timed serial in-page PNG GENERATION,
test scaffolding, not the decode path; methodology fixed in review before
commit.) Verdict recorded in docs/promises.md: rendering LoD stays deferred
- neither paint nor decode cost justifies it at this scale; the revival
trigger is these rows exceeding budget or markedly larger imagery. The
27.9 ms dispatch reading matches the connection-slices band on an unchanged
code path.

CV canvas review slice (canvas gestures/geometry/DPR hardening, review
ledger CV1-CV10: pointer-owned gestures, adaptive De Casteljau link hit
testing, link-inclusive visual bounds/culling with LINK_PAINT_PAD, atomic
group movement, fractional-DPR backing stores, running-only nested
progress) measured against a fresh baseline run at 81c4547 taken the same
session. Two after-runs were taken because the hit-testing implementation
changed after the first (the fixed-depth subdivision cap was replaced with
numeric-floor termination in review); both runs are recorded above, and the
"final (canonical)" rows are the run on the tree as committed, all four
scenarios passing. Pan/zoom, reroutes, previews,
open, and decode sit at or within run noise of baseline despite the hit
path moving from fixed 25-point sampling to unbounded-depth adaptive
flattening (hit testing is not on the frame loop) and culling gaining
link-hull padding; the final open reading also marks the intermediate
82.9 ms as single-run noise (back inside the 48-65 ms band). First paint is
slightly faster (49.5 -> 45.8 ms). Dispatch and repaint read somewhat higher
in the final run (27.3 -> 30.3 ms, 34.2 -> 38.7 ms) and p95s sit at the top
of their bands - within budget, but recorded honestly as neutral-to-
slightly-noisier, not an improvement. The preview-heavy LoD verdict is
unchanged: still no LoD needed at this scale.

The dispatch number includes the synchronous scene rebuild triggered through
the document signal - the main CanvasHost-decomposition-sensitive cost.
Record a new row (do not overwrite old ones) after any change expected to
move these numbers, with the commit hash.

**2026-07-27 Slice 29 measurement deferred:** exact diagnostic pin rings add
one sparse per-node/per-input lookup to the paint path. This delegated slice
was explicitly prohibited from running Playwright/E2E or touching the live
dev/backend processes, so no browser number is fabricated here. The canvas
unit performance suite remains green. Revival trigger: the frontend
orchestrator runs `packages/e2e/tests/perf.spec.ts` on a fresh server after
integrating Slice 29 and appends the measured rows above with the landed
commit hash.

**2026-07-27 deferral resolved (batch 7 merged, 63d7729):** measured rows
appended above. Frame avg/p95, previews, cold decode, first paint, and
repaint all sit inside the established bands; move dispatch (30.30 ms) ties
the CV-final canonical reading. The 88.3 ms openDocument matches the prior
82.9 ms intermediate-run peak pattern (cold first run after a fresh server
spawn) rather than a regression - frame and repaint numbers are unchanged;
watch the next batch's row per the slice-2/slice-8 noise precedent.

## Core dispatch throughput (unit-level, `packages/core/test/perf-dispatch.test.ts`)

Node-side vitest microbench (not the browser e2e loop above): a synthetic
1200-node document driven straight through DocumentStore.dispatch, no
renderer. Measures the command pipeline cost of the document ownership and
JSON command boundary.
The uncalibrated timing cases are removed; these measurements remain historical.

| Workload | Date | State | us/op |
| --- | --- | --- | --- |
| node.setValue x1000 | 2026-07-23 | before CO slice (04bba9a) | 1870.2 |
| node.add x300 | 2026-07-23 | before CO slice (04bba9a) | 2170.8 |
| graph.deleteItems 200 nodes | 2026-07-23 | before CO slice (04bba9a) | 1676.5 |
| undo x200 | 2026-07-23 | before CO slice (04bba9a) | 183.3 |
| redo x200 | 2026-07-23 | before CO slice (04bba9a) | 179.6 |
| node.setValue x1000 | 2026-07-23 | after CO slice | 2080.4 |
| node.add x300 | 2026-07-23 | after CO slice | 2277.2 |
| graph.deleteItems 200 nodes | 2026-07-23 | after CO slice | 1733.8 |
| undo x200 | 2026-07-23 | after CO slice | 191.0 |
| redo x200 | 2026-07-23 | after CO slice | 189.2 |
| node.setValue x1000 | 2026-10-28 | X570, before workload reduction | 2278.5 |
| node.setValue x300 | 2026-10-28 | X570, reduced workload | 2448.0 |

The setValue check runs 300 writes with a two-second bound and verifies the
last committed value. The recorded 2080.4us/op reference gives 624.12ms for
300 writes, so the bound has 3.2x margin on that reference. The October 28
local runs took 2278.5ms for 1000 writes and 734.4ms for 300 writes. These
are local measurements, not a slowest-hosted-runner baseline or a dispatch
optimization; the command pipeline is unchanged.

The feature-heavy type-solver check counts node, elaborated-port and
recursive type-pair visits at 30, 60 and 120 chains instead of timing the
host. Each 20-node chain visits 79 ports and 20 type pairs, with all 18
consumer-link verdicts and its named-net verdict checked as valid.

The CO slice costs roughly +5-11% on setValue and +3-5% elsewhere: every
dispatch now owns (detaches + deep-freezes + JSON-validates) its params and
recorded patch values, and replay re-freezes applied containers. Accepted
as the price of the ownership boundary; the transaction-local COW-draft
ledger item below is the lever if this grows.

### Open performance work retained from the 2026-07-23 review

| Item | Status | Completion trigger |
| --- | --- | --- |
| Replace per-op container cloning with transaction-local copy-on-write drafts | deferred | Ownership-path profiling shows material dispatch overhead |
| Replace whole-document invariant scans on every dispatch with affected-scope checks | deferred | Dispatch profiling shows invariant scans are a material cost and scoped checks can retain exact validation |
| Reuse compile traversal and `scopeClosure` results instead of discarding most of the artifact | deferred | Compile profiling shows redundant traversal is a material cost |

## 2026-07-30 lazy-selector would-run closure regression (batch 21)

`perf.spec.ts` "opens a 1200-node document and repaints after a command
within budget": node.move dispatch avg regressed from within its 50ms
budget (batch-20 green run) to a deterministic 73.9ms after structural
routing I2 (fa7a825): `scopeClosureCached` derived a full would-run
compile on every revision bump inside overlay refresh. Fixed same day by
gating the closure derivation on `documentHasLazySelector` (cheap
O(nodes) type-memoized scan): selector-less documents - including this
fixture - provably yield an empty inactive-exclusive overlay and now skip
the compile entirely; the test passes again within budget. Known bound,
recorded not fixed: documents that DO contain a lazy selector still pay
one full would-run compile per revision. The lever if a selector-heavy
large document exceeds budgets is deferring the closure derivation off
the dispatch path (idle/async recompute with the existing cache).

## 2026-08-15 Canvas visual-system merge-base baseline

Commit: `1be5e829de9b568bf4d31f8eac2a768339d14e12` (`origin/main`).
This is the baseline for issue #30 until main changes materially.
The tracked fixture/config added beside this record does not change measured
app, canvas, or core product source from that commit.

Environment: hostname `270K-Plus2`; Intel Core Ultra 7 270K Plus (24 logical
CPUs); 62 GiB RAM; Linux `7.0.0-28-generic`; NVIDIA GeForce RTX 5070 Ti,
driver `595.84`; Node `22.17.1`; pnpm `11.20.0`; Playwright `1.61.1`;
headless Google Chrome for Testing `149.0.7827.55` from Playwright Chromium
`1228`.

Method: unchanged `packages/e2e/tests/perf.spec.ts`, project
`backend-serial`, one worker, three separate Chromium runs. The Vite frontend
used isolated `127.0.0.1:5429`; a local read-only legacy fixture used
`127.0.0.1:5439`; the native backend target was the unused
`http://127.0.0.1:9`. The fixture served the tracked `object_info.json` plus
local system, queue, history, and WebSocket responses. Protected ports 5199
and 8765 were not used or signaled.

That commit retains the historical setup in
`packages/e2e/playwright.perf-isolated.config.ts` and
`packages/e2e/bench/local-comfy-fixture.mjs`. Those files and their timing
cases are no longer part of the active suite.

| Metric | Run 1 | Run 2 | Run 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.20 ms | 17.46 ms | 17.54 ms | 17.46 ms |
| 1200 plain p95 frame | 22.50 ms | 22.90 ms | 24.50 ms | 22.90 ms |
| 1140 reroute average frame | 18.63 ms | 18.69 ms | 18.51 ms | 18.63 ms |
| 1140 reroute p95 frame | 28.60 ms | 28.80 ms | 28.30 ms | 28.60 ms |
| 1200 preview average frame | 18.22 ms | 18.34 ms | 18.48 ms | 18.34 ms |
| 1200 preview p95 frame | 26.10 ms | 26.60 ms | 25.90 ms | 26.10 ms |
| Preview decode | 58.0 ms | 58.6 ms | 68.7 ms | 58.6 ms |
| Open | 102.7 ms | 107.2 ms | 105.5 ms | 105.5 ms |
| First paint | 43.9 ms | 44.6 ms | 44.3 ms | 44.3 ms |
| Node-move dispatch average | 67.04 ms | 64.63 ms | 65.54 ms | 65.54 ms |
| Repaint after dispatch | 26.46 ms | 26.42 ms | 26.82 ms | 26.46 ms |

Frame, first-paint, and repaint absolute backstops passed in all runs. Each
run reported the same existing unexpected failure: node-move dispatch average
exceeded the test's `<50 ms` backstop. The baseline commands therefore exited
nonzero with 3 expected tests and 1 unexpected failure per run. The failure is
part of the retained distribution and must not be hidden by a favorable
sample; canvas implementation remains responsible for making the full
authoritative test pass.

## 2026-08-15 execution-free comparison compile gate

Merge base: `87209203ec0c9c3d5c4da1399eb330bb0b024e6a` (`origin/main`).
The head changes only `CanvasHost` comparison-compile eligibility and the
authoritative benchmark assertion: an editable tab without a bound execution
artifact has no recorded recipe to compare, so its document revisions no
longer compile during overlay refresh. Execution-backed exactness and retained
partial-run data keep the cached comparison path.

Base and head each used three separate Chromium processes on the same
`270K-Plus2` setup and isolated frontend/fixture ports 5429/5439 described
above. Both used Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and headless
Google Chrome for Testing 149.0.7827.55. The head benchmark also counted calls
to `compileTabCached()` during the 20 execution-free moves and restored the
method immediately after measurement.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.21 ms | 17.31 ms | 17.30 ms | 17.30 ms | 17.30 ms | 17.30 ms | 17.27 ms | 17.30 ms |
| 1200 plain p95 frame | 21.70 ms | 23.10 ms | 22.00 ms | 22.00 ms | 22.90 ms | 22.40 ms | 21.90 ms | 22.40 ms |
| 1140 reroute average frame | 19.00 ms | 18.74 ms | 18.71 ms | 18.74 ms | 18.51 ms | 18.52 ms | 18.61 ms | 18.52 ms |
| 1140 reroute p95 frame | 30.10 ms | 28.90 ms | 27.80 ms | 28.90 ms | 28.40 ms | 27.10 ms | 29.10 ms | 28.40 ms |
| 1200 preview average frame | 18.96 ms | 18.36 ms | 17.98 ms | 18.36 ms | 17.94 ms | 18.37 ms | 18.18 ms | 18.18 ms |
| 1200 preview p95 frame | 27.60 ms | 25.90 ms | 26.00 ms | 26.00 ms | 25.80 ms | 25.50 ms | 25.50 ms | 25.50 ms |
| Preview decode | 64.2 ms | 62.6 ms | 58.0 ms | 62.6 ms | 55.7 ms | 67.2 ms | 70.9 ms | 67.2 ms |
| Open | 130.8 ms | 101.9 ms | 129.0 ms | 129.0 ms | 78.4 ms | 71.2 ms | 104.4 ms | 78.4 ms |
| First paint | 42.9 ms | 39.9 ms | 43.4 ms | 42.9 ms | 41.1 ms | 39.5 ms | 44.0 ms | 41.1 ms |
| Node-move dispatch average | 66.97 ms | 66.95 ms | 59.32 ms | 66.95 ms | 40.07 ms | 39.96 ms | 37.97 ms | 39.96 ms |
| Repaint after dispatch | 25.97 ms | 26.65 ms | 26.22 ms | 26.22 ms | 25.84 ms | 25.81 ms | 25.44 ms | 25.81 ms |
| Comparison compiles during 20 moves | not instrumented | not instrumented | not instrumented | not instrumented | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | 0.00 ms (0.0%) | 1.00 ms | pass |
| Plain p95 frame | +0.40 ms (+1.8%) | 2.20 ms | pass |
| Reroute average frame | -0.22 ms (-1.2%) | 1.00 ms | pass |
| Reroute p95 frame | -0.50 ms (-1.7%) | 2.89 ms | pass |
| Preview average frame | -0.18 ms (-1.0%) | 1.00 ms | pass |
| Preview p95 frame | -0.50 ms (-1.9%) | 2.60 ms | pass |
| First paint | -1.80 ms (-4.2%) | 5.00 ms | pass |
| Repaint after dispatch | -0.41 ms (-1.6%) | 3.00 ms | pass |

Every head run passed all four authoritative scenarios. Frame averages remain
below 33 ms, p95 values below 100 ms, first paint below 1000 ms, repaint below
100 ms, and node-move dispatch now passes its 50 ms backstop in all three runs.

## 2026-08-15 semantic Canvas token projection

Merge base: `a8ef25070347cd943e96ffbce1f663a9608fd8a2` (`origin/main`).
Head constructs the existing Canvas `defaultTokens` adapter from matching #27
semantic projection leaves and gives the focused multiline editor the same CSS
projection. Geometry, compact typography, data-type colors, and unmatched
execution/mode colors are unchanged.

Base and head each used three separate Chromium processes on `270K-Plus2`
with the tracked isolated frontend/fixture ports 5429/5439 and one worker.
Both used Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright
1.61.1, and headless Google Chrome for Testing 149.0.7827.55. Protected ports
5199 and 8765 were inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.39 ms | 17.35 ms | 17.19 ms | 17.35 ms | 17.43 ms | 17.24 ms | 17.32 ms | 17.32 ms |
| 1200 plain p95 frame | 24.40 ms | 22.20 ms | 21.80 ms | 22.20 ms | 24.30 ms | 22.10 ms | 22.70 ms | 22.70 ms |
| 1140 reroute average frame | 18.59 ms | 18.72 ms | 18.40 ms | 18.59 ms | 19.12 ms | 18.56 ms | 18.44 ms | 18.56 ms |
| 1140 reroute p95 frame | 27.80 ms | 29.00 ms | 27.90 ms | 27.90 ms | 29.60 ms | 27.20 ms | 27.40 ms | 27.40 ms |
| 1200 preview average frame | 17.75 ms | 18.18 ms | 18.18 ms | 18.18 ms | 18.63 ms | 18.23 ms | 18.06 ms | 18.23 ms |
| 1200 preview p95 frame | 25.40 ms | 27.00 ms | 27.00 ms | 27.00 ms | 27.50 ms | 25.60 ms | 25.90 ms | 25.90 ms |
| Preview decode | 53.2 ms | 59.4 ms | 70.4 ms | 59.4 ms | 55.2 ms | 64.5 ms | 58.0 ms | 58.0 ms |
| Open | 71.9 ms | 73.7 ms | 78.2 ms | 73.7 ms | 74.9 ms | 75.9 ms | 101.9 ms | 75.9 ms |
| First paint | 41.1 ms | 42.9 ms | 42.4 ms | 42.4 ms | 43.9 ms | 39.1 ms | 44.5 ms | 43.9 ms |
| Node-move dispatch average | 39.31 ms | 39.77 ms | 37.95 ms | 39.31 ms | 40.76 ms | 38.07 ms | 36.13 ms | 38.07 ms |
| Repaint after dispatch | 25.86 ms | 25.68 ms | 25.51 ms | 25.68 ms | 25.76 ms | 25.52 ms | 25.25 ms | 25.52 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.03 ms (-0.2%) | 1.00 ms | pass |
| Plain p95 frame | +0.50 ms (+2.3%) | 2.22 ms | pass |
| Reroute average frame | -0.03 ms (-0.2%) | 1.00 ms | pass |
| Reroute p95 frame | -0.50 ms (-1.8%) | 2.79 ms | pass |
| Preview average frame | +0.05 ms (+0.3%) | 1.00 ms | pass |
| Preview p95 frame | -1.10 ms (-4.1%) | 2.70 ms | pass |
| First paint | +1.50 ms (+3.5%) | 5.00 ms | pass |
| Repaint after dispatch | -0.16 ms (-0.6%) | 3.00 ms | pass |

All three head samples pass the absolute workload average `<33 ms`, p95
`<100 ms`, open `<2000 ms`, first-paint `<1000 ms`, dispatch `<50 ms`, and
repaint `<100 ms` backstops. No relative or absolute budget was breached.

## 2026-08-15 semantic Canvas token projection rebaseline

`origin/main` advanced materially to
`9aa7d2e0452dc75698010965bc060686bc489e26` with the node palette redesign
before this change entered review. The token projection branch merged that
base without a renderer conflict and repeated the complete comparison.

Base and head each used three new Chromium processes on `270K-Plus2` with the
tracked isolated frontend/fixture ports 5429/5439 and one worker. Both used
Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and
headless Google Chrome for Testing 149.0.7827.55. Protected ports 5199 and
8765 were inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.27 ms | 17.33 ms | 17.20 ms | 17.27 ms | 17.23 ms | 17.27 ms | 17.36 ms | 17.27 ms |
| 1200 plain p95 frame | 22.60 ms | 23.20 ms | 22.40 ms | 22.60 ms | 22.70 ms | 22.20 ms | 23.50 ms | 22.70 ms |
| 1140 reroute average frame | 19.13 ms | 18.76 ms | 18.69 ms | 18.76 ms | 18.52 ms | 18.36 ms | 18.69 ms | 18.52 ms |
| 1140 reroute p95 frame | 28.50 ms | 28.60 ms | 27.90 ms | 28.50 ms | 27.40 ms | 26.70 ms | 29.10 ms | 27.40 ms |
| 1200 preview average frame | 18.54 ms | 18.37 ms | 18.14 ms | 18.37 ms | 18.63 ms | 18.82 ms | 18.06 ms | 18.63 ms |
| 1200 preview p95 frame | 26.60 ms | 25.50 ms | 26.30 ms | 26.30 ms | 25.60 ms | 27.50 ms | 25.60 ms | 25.60 ms |
| Preview decode | 62.8 ms | 50.6 ms | 61.8 ms | 61.8 ms | 65.8 ms | 51.8 ms | 71.4 ms | 65.8 ms |
| Open | 96.0 ms | 73.9 ms | 102.4 ms | 96.0 ms | 100.1 ms | 74.0 ms | 75.6 ms | 75.6 ms |
| First paint | 42.8 ms | 42.3 ms | 44.0 ms | 42.8 ms | 46.6 ms | 42.7 ms | 43.5 ms | 43.5 ms |
| Node-move dispatch average | 36.45 ms | 40.17 ms | 37.10 ms | 37.10 ms | 38.18 ms | 38.33 ms | 40.72 ms | 38.33 ms |
| Repaint after dispatch | 25.61 ms | 26.11 ms | 24.98 ms | 25.61 ms | 25.74 ms | 25.95 ms | 26.27 ms | 25.95 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.00 ms (+0.0%) | 1.00 ms | pass |
| Plain p95 frame | +0.10 ms (+0.4%) | 2.26 ms | pass |
| Reroute average frame | -0.24 ms (-1.3%) | 1.00 ms | pass |
| Reroute p95 frame | -1.10 ms (-3.9%) | 2.85 ms | pass |
| Preview average frame | +0.26 ms (+1.4%) | 1.00 ms | pass |
| Preview p95 frame | -0.70 ms (-2.7%) | 2.63 ms | pass |
| First paint | +0.70 ms (+1.6%) | 5.00 ms | pass |
| Repaint after dispatch | +0.34 ms (+1.3%) | 3.00 ms | pass |

All three rebased head samples pass the absolute workload average `<33 ms`,
p95 `<100 ms`, open `<2000 ms`, first-paint `<1000 ms`, dispatch `<50 ms`,
and repaint `<100 ms` backstops. No relative or absolute budget was breached.

## 2026-08-15 bounded Types-lens adornments

Merge base: `c4811ecb10a385381132ad7815083e489245d06a` (`origin/main`).
Head replaces the Types lens raw paint callback with renderer-owned retained
type-label descriptors. The authoritative benchmark runs the Standard lens,
so this comparison also checks that the disabled capability adds no hot-path
paint work.

Base and head each used three separate Chromium processes on `270K-Plus2`
with the tracked isolated frontend/fixture ports 5429/5439 and one worker.
Both used Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright
1.61.1, and Playwright Chromium 1228. Protected ports 5199 and 8765 were
inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.30 ms | 17.28 ms | 17.34 ms | 17.30 ms | 17.45 ms | 17.18 ms | 17.26 ms | 17.26 ms |
| 1200 plain p95 frame | 21.60 ms | 22.50 ms | 22.70 ms | 22.50 ms | 22.10 ms | 22.10 ms | 22.50 ms | 22.10 ms |
| 1140 reroute average frame | 18.69 ms | 18.51 ms | 18.56 ms | 18.56 ms | 18.48 ms | 18.50 ms | 18.52 ms | 18.50 ms |
| 1140 reroute p95 frame | 27.70 ms | 27.50 ms | 27.10 ms | 27.50 ms | 27.60 ms | 28.40 ms | 27.70 ms | 27.70 ms |
| 1200 preview average frame | 18.37 ms | 18.22 ms | 18.35 ms | 18.35 ms | 17.93 ms | 18.07 ms | 18.06 ms | 18.06 ms |
| 1200 preview p95 frame | 25.30 ms | 25.70 ms | 25.10 ms | 25.30 ms | 25.50 ms | 26.70 ms | 25.00 ms | 25.50 ms |
| Preview decode | 66.8 ms | 53.3 ms | 67.9 ms | 66.8 ms | 71.7 ms | 71.7 ms | 60.0 ms | 71.7 ms |
| Open | 78.5 ms | 72.6 ms | 71.0 ms | 72.6 ms | 73.0 ms | 104.7 ms | 101.3 ms | 101.3 ms |
| First paint | 39.9 ms | 41.8 ms | 39.4 ms | 39.9 ms | 41.8 ms | 42.6 ms | 43.9 ms | 42.6 ms |
| Node-move dispatch average | 39.94 ms | 38.04 ms | 39.83 ms | 39.83 ms | 40.06 ms | 36.65 ms | 36.90 ms | 36.90 ms |
| Repaint after dispatch | 25.58 ms | 25.58 ms | 25.53 ms | 25.58 ms | 25.78 ms | 25.20 ms | 24.84 ms | 25.20 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.04 ms (-0.2%) | 1.00 ms | pass |
| Plain p95 frame | -0.40 ms (-1.8%) | 2.25 ms | pass |
| Reroute average frame | -0.06 ms (-0.3%) | 1.00 ms | pass |
| Reroute p95 frame | +0.20 ms (+0.7%) | 2.75 ms | pass |
| Preview average frame | -0.29 ms (-1.6%) | 1.00 ms | pass |
| Preview p95 frame | +0.20 ms (+0.8%) | 2.53 ms | pass |
| First paint | +2.70 ms (+6.8%) | 5.00 ms | pass |
| Repaint after dispatch | -0.38 ms (-1.5%) | 3.00 ms | pass |

All three head samples pass the absolute workload average `<33 ms`, p95
`<100 ms`, open `<2000 ms`, first-paint `<1000 ms`, dispatch `<50 ms`, and
repaint `<100 ms` backstops. No relative or absolute budget was breached.

## 2026-08-15 semantic group hierarchy

Merge base: `56b39ced234d459f95fa6266ceab1707c5ba35eb` (`origin/main`).
Head moves the uncolored group fallback and selected outline onto existing
semantic Canvas roles. Group geometry, culling, and the group-free
authoritative workloads are unchanged.

Base and head used separate Chromium processes on `270K-Plus2` with the
tracked isolated frontend/fixture ports 5429/5439 and one worker. Both used
Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and
Playwright Chromium 1228. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled.

The first complete comparison produced one relative breach: the head plain
p95 median was 25.50 ms against a 24.31 ms limit. Every absolute gate passed.
The full distribution is retained rather than selecting favorable samples.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Initial head run 1 | Initial head run 2 | Initial head run 3 | Initial head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.22 ms | 17.27 ms | 17.34 ms | 17.27 ms | 20.00 ms | 17.64 ms | 17.53 ms | 17.64 ms |
| 1200 plain p95 frame | 22.00 ms | 22.10 ms | 22.80 ms | 22.10 ms | 34.90 ms | 25.50 ms | 23.30 ms | 25.50 ms |
| 1140 reroute average frame | 18.76 ms | 18.55 ms | 19.33 ms | 18.76 ms | 19.25 ms | 19.02 ms | 18.54 ms | 19.02 ms |
| 1140 reroute p95 frame | 28.40 ms | 27.40 ms | 30.00 ms | 28.40 ms | 29.80 ms | 29.10 ms | 27.40 ms | 29.10 ms |
| 1200 preview average frame | 18.18 ms | 18.05 ms | 18.77 ms | 18.18 ms | 18.77 ms | 18.05 ms | 18.30 ms | 18.30 ms |
| 1200 preview p95 frame | 26.20 ms | 25.40 ms | 27.60 ms | 26.20 ms | 28.00 ms | 27.30 ms | 26.30 ms | 27.30 ms |
| Preview decode | 72.0 ms | 55.2 ms | 55.3 ms | 55.3 ms | 54.6 ms | 50.5 ms | 60.6 ms | 54.6 ms |
| Open | 75.3 ms | 73.3 ms | 81.4 ms | 75.3 ms | 103.3 ms | 76.7 ms | 75.4 ms | 76.7 ms |
| First paint | 41.6 ms | 42.3 ms | 42.1 ms | 42.1 ms | 48.0 ms | 44.3 ms | 42.8 ms | 44.3 ms |
| Node-move dispatch average | 40.15 ms | 39.88 ms | 39.61 ms | 39.88 ms | 45.14 ms | 41.23 ms | 40.26 ms | 41.23 ms |
| Repaint after dispatch | 25.82 ms | 25.66 ms | 26.28 ms | 25.82 ms | 29.64 ms | 26.72 ms | 25.82 ms | 26.72 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Per the repeatability rule, head then ran a complete fresh three-process
distribution. The plain p95 breach did not repeat, and every relative and
absolute gate passed.

| Metric | Base median | Repeat head run 1 | Repeat head run 2 | Repeat head run 3 | Repeat head median |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.27 ms | 17.18 ms | 17.22 ms | 17.25 ms | 17.22 ms |
| 1200 plain p95 frame | 22.10 ms | 21.60 ms | 21.80 ms | 22.80 ms | 21.80 ms |
| 1140 reroute average frame | 18.76 ms | 18.57 ms | 18.75 ms | 18.80 ms | 18.75 ms |
| 1140 reroute p95 frame | 28.40 ms | 27.50 ms | 28.30 ms | 28.50 ms | 28.30 ms |
| 1200 preview average frame | 18.18 ms | 18.39 ms | 18.28 ms | 18.32 ms | 18.32 ms |
| 1200 preview p95 frame | 26.20 ms | 25.90 ms | 26.60 ms | 26.30 ms | 26.30 ms |
| Preview decode | 55.3 ms | 63.3 ms | 70.3 ms | 57.7 ms | 63.3 ms |
| Open | 75.3 ms | 70.7 ms | 76.7 ms | 73.9 ms | 73.9 ms |
| First paint | 42.1 ms | 39.0 ms | 45.4 ms | 41.8 ms | 41.8 ms |
| Node-move dispatch average | 39.88 ms | 38.30 ms | 38.33 ms | 41.30 ms | 38.33 ms |
| Repaint after dispatch | 25.82 ms | 25.81 ms | 26.77 ms | 26.40 ms | 26.40 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Repeat median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.05 ms (-0.3%) | 1.00 ms | pass |
| Plain p95 frame | -0.30 ms (-1.4%) | 2.21 ms | pass |
| Reroute average frame | -0.01 ms (-0.1%) | 1.00 ms | pass |
| Reroute p95 frame | -0.10 ms (-0.4%) | 2.84 ms | pass |
| Preview average frame | +0.14 ms (+0.8%) | 1.00 ms | pass |
| Preview p95 frame | +0.10 ms (+0.4%) | 2.62 ms | pass |
| First paint | -0.30 ms (-0.7%) | 5.00 ms | pass |
| Repaint after dispatch | +0.58 ms (+2.2%) | 3.00 ms | pass |

Every repeat-head sample also passes average `<33 ms`, p95 `<100 ms`, open
`<2000 ms`, first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and
zero execution-free comparison compiles.

## 2026-08-15 semantic Canvas navigation chrome

Merge base: `c0e52d3129a7e9d63568f887512ebb776731c90c` (`origin/main`).
Head moves the minimap frame and navigation controls onto semantic CSS roles.
Canvas rendering, scene build, minimap paint, geometry, and interaction code
are unchanged.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture ports 5509/5519 and 5529/5539 respectively,
one worker, and native target `127.0.0.1:9`. Both used Linux
7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome
for Testing 149.0.7827.55. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.35 ms | 17.20 ms | 17.27 ms | 17.27 ms | 17.31 ms | 17.32 ms | 17.14 ms | 17.31 ms |
| 1200 plain p95 frame | 22.50 ms | 22.50 ms | 22.20 ms | 22.50 ms | 21.90 ms | 22.60 ms | 21.60 ms | 21.90 ms |
| 1140 reroute average frame | 18.55 ms | 18.57 ms | 18.54 ms | 18.55 ms | 18.37 ms | 18.40 ms | 18.42 ms | 18.40 ms |
| 1140 reroute p95 frame | 27.40 ms | 27.40 ms | 27.10 ms | 27.40 ms | 26.70 ms | 27.30 ms | 26.40 ms | 26.70 ms |
| 1200 preview average frame | 18.02 ms | 18.66 ms | 18.01 ms | 18.02 ms | 18.07 ms | 18.39 ms | 17.98 ms | 18.07 ms |
| 1200 preview p95 frame | 25.80 ms | 26.20 ms | 25.50 ms | 25.80 ms | 25.60 ms | 26.80 ms | 25.10 ms | 25.60 ms |
| Preview decode | 54.0 ms | 62.9 ms | 77.3 ms | 62.9 ms | 59.4 ms | 64.3 ms | 62.3 ms | 62.3 ms |
| Open | 109.1 ms | 72.5 ms | 98.5 ms | 98.5 ms | 97.9 ms | 73.3 ms | 74.1 ms | 74.1 ms |
| First paint | 42.3 ms | 40.1 ms | 43.6 ms | 42.3 ms | 49.4 ms | 39.9 ms | 41.9 ms | 41.9 ms |
| Node-move dispatch average | 37.99 ms | 39.83 ms | 36.86 ms | 37.99 ms | 36.58 ms | 40.02 ms | 38.14 ms | 38.14 ms |
| Repaint after dispatch | 25.28 ms | 25.54 ms | 25.29 ms | 25.29 ms | 25.15 ms | 25.46 ms | 25.47 ms | 25.46 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.04 ms (+0.2%) | 1.00 ms | pass |
| Plain p95 frame | -0.60 ms (-2.7%) | 2.25 ms | pass |
| Reroute average frame | -0.15 ms (-0.8%) | 1.00 ms | pass |
| Reroute p95 frame | -0.70 ms (-2.6%) | 2.74 ms | pass |
| Preview average frame | +0.05 ms (+0.3%) | 1.00 ms | pass |
| Preview p95 frame | -0.20 ms (-0.8%) | 2.58 ms | pass |
| First paint | -0.40 ms (-0.9%) | 5.00 ms | pass |
| Repaint after dispatch | +0.17 ms (+0.7%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-21 App view preview promotion

Comparison base: `6ff98009` (App view use/arrange mode). The head adds
preview-surface exposure controls to the canvas and renders promoted previews
in App view through the shared preview-source derivation and loader.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture ports 5429/5439, one worker, and native target
`127.0.0.1:9`. Both used Linux 7.0.0-29-generic, Node 22.17.1, pnpm 10.31.0,
Playwright 1.61.1, and Chrome for Testing 149.0.7827.55. Protected ports 5199
and 8765 were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 16.88 ms | 17.01 ms | 16.83 ms | 16.88 ms | 17.02 ms | 16.91 ms | 16.88 ms | 16.91 ms |
| 1200 plain p95 frame | 18.20 ms | 17.90 ms | 17.90 ms | 17.90 ms | 21.40 ms | 18.30 ms | 17.80 ms | 18.30 ms |
| 1140 reroute average frame | 17.72 ms | 17.78 ms | 17.77 ms | 17.77 ms | 17.71 ms | 17.76 ms | 17.68 ms | 17.71 ms |
| 1140 reroute p95 frame | 18.00 ms | 18.00 ms | 18.10 ms | 18.00 ms | 18.20 ms | 17.90 ms | 18.30 ms | 18.20 ms |
| 1200 preview average frame | 16.50 ms | 16.52 ms | 16.52 ms | 16.52 ms | 16.85 ms | 16.47 ms | 16.44 ms | 16.47 ms |
| 1200 preview p95 frame | 18.10 ms | 18.30 ms | 17.80 ms | 18.10 ms | 18.10 ms | 18.00 ms | 17.30 ms | 18.00 ms |
| Preview decode | 74.3 ms | 55.6 ms | 69.7 ms | 69.7 ms | 50.1 ms | 62.3 ms | 70.2 ms | 62.3 ms |
| Open | 78.3 ms | 80.5 ms | 77.8 ms | 78.3 ms | 78.3 ms | 77.4 ms | 78.3 ms | 78.3 ms |
| First paint | 20.3 ms | 24.4 ms | 20.3 ms | 20.3 ms | 20.9 ms | 21.0 ms | 20.6 ms | 20.9 ms |
| Node-move dispatch average | 35.31 ms | 35.66 ms | 35.42 ms | 35.42 ms | 36.49 ms | 37.13 ms | 35.85 ms | 36.49 ms |
| Repaint after dispatch | 14.59 ms | 13.86 ms | 13.14 ms | 13.86 ms | 13.01 ms | 14.43 ms | 13.56 ms | 13.56 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | ---: |
| Plain average frame | +0.03 ms (+0.2%) | 1.00 ms | pass |
| Plain p95 frame | +0.40 ms (+2.2%) | 2.00 ms | pass |
| Reroute average frame | -0.06 ms (-0.3%) | 1.00 ms | pass |
| Reroute p95 frame | +0.20 ms (+1.1%) | 2.00 ms | pass |
| Preview average frame | -0.05 ms (-0.3%) | 1.00 ms | pass |
| Preview p95 frame | -0.10 ms (-0.6%) | 2.00 ms | pass |
| First paint | +0.60 ms (+3.0%) | 5.00 ms | pass |
| Repaint after dispatch | -0.30 ms (-2.2%) | 3.00 ms | pass |

Every sample passed the absolute budgets and every guarded median stayed
inside its relative threshold. The preview-heavy frame median improved by
0.05 ms, and execution-free comparison compiles remained zero.

## 2026-08-19 Shared multi-window document authority

Comparison base: `302be2d12cea23c6d1382e04db85f49c407572ea`. The head
moves live workflow commands onto the same-origin SharedWorker authority. The
head probe explicitly waits for that promotion before measuring dispatch.

Base and head each used three fresh Chromium pages with isolated fixture and
frontend servers on `DESKTOP-FB41N5T` (Windows 10.0.26200, Node 22.22.0, pnpm
10.31.0, Playwright 1.61.1, Chromium 145.0.7632.6). The base used ports
5449/5459 and the head used 5429/5439. Protected ports 5199 and 8765 were not
contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 16.91 ms | 16.65 ms | 16.57 ms | 16.65 ms | 18.04 ms | 17.48 ms | 17.44 ms | 17.48 ms |
| 1200 plain p95 frame | 20.10 ms | 18.10 ms | 18.20 ms | 18.20 ms | 20.30 ms | 18.10 ms | 18.20 ms | 18.20 ms |
| 1140 reroute average frame | 17.21 ms | 17.01 ms | 17.16 ms | 17.16 ms | 18.74 ms | 18.89 ms | 18.56 ms | 18.74 ms |
| 1140 reroute p95 frame | 21.90 ms | 20.20 ms | 22.00 ms | 21.90 ms | 22.80 ms | 23.30 ms | 20.50 ms | 22.80 ms |
| 1200 preview average frame | 17.92 ms | 18.38 ms | 17.84 ms | 17.92 ms | 18.40 ms | 18.77 ms | 18.66 ms | 18.66 ms |
| 1200 preview p95 frame | 26.00 ms | 24.60 ms | 23.50 ms | 24.60 ms | 24.80 ms | 25.10 ms | 24.50 ms | 24.80 ms |
| Preview decode | 60.1 ms | 55.9 ms | 52.3 ms | 55.9 ms | 53.7 ms | 56.2 ms | 52.8 ms | 53.7 ms |
| Open | 138.4 ms | 124.8 ms | 126.6 ms | 126.6 ms | 96.2 ms | 94.0 ms | 101.1 ms | 96.2 ms |
| First paint | 26.8 ms | 25.2 ms | 24.8 ms | 25.2 ms | 26.5 ms | 21.2 ms | 23.1 ms | 23.1 ms |
| Node-move dispatch average | 57.80 ms | 54.15 ms | 51.74 ms | 54.15 ms | 48.94 ms | 47.91 ms | 53.46 ms | 48.94 ms |
| Repaint after dispatch | 17.17 ms | 16.96 ms | 16.49 ms | 16.96 ms | 16.23 ms | 17.06 ms | 18.82 ms | 17.06 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.83 ms (+5.0%) | 1.00 ms | pass |
| Plain p95 frame | +0.00 ms (+0.0%) | 2.00 ms | pass |
| Reroute average frame | +1.58 ms (+9.2%) | 1.00 ms | fail |
| Reroute p95 frame | +0.90 ms (+4.1%) | 2.00 ms | pass |
| Preview average frame | +0.74 ms (+4.1%) | 1.00 ms | pass |
| Preview p95 frame | +0.20 ms (+0.8%) | 2.00 ms | pass |
| First paint | -2.10 ms (-8.3%) | 5.00 ms | pass |
| Repaint after dispatch | +0.10 ms (+0.6%) | 3.00 ms | pass |

All frame, open, first-paint, and repaint samples stay inside their absolute
budgets. The reroute median exceeds the historical relative guard by 0.58 ms.
The base misses the 50 ms dispatch budget in all three samples; the shared
authority improves its median by 5.21 ms, with two of three head samples below
50 ms. Zero execution-free comparison compiles occurred.

## 2026-08-17 drilled MatchType input resolution

Merge base: `506e46795aaf4157bac9f343d57a3a8c40bcac43`
(`origin/main`). The head adds occurrence-aware parent input constraints to
drilled scene type solving. Root scenes take the unchanged fast path.

Base and exact head each used three separate Chromium processes on
`270K-Plus2`, one worker, and native target `127.0.0.1:9`. Base used isolated
frontend/fixture ports 5600/5601, 5602/5603, and 5604/5605; head used
5610/5611, 5612/5613, and 5614/5615. Both used Linux 7.0.0-28-generic, Node
22.17.1, pnpm 10.31.0, and Playwright 1.61.1. Protected ports 5199 and 8765
were inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.27 ms | 17.37 ms | 17.26 ms | 17.27 ms | 17.21 ms | 17.28 ms | 17.27 ms | 17.27 ms |
| 1200 plain p95 frame | 21.80 ms | 22.40 ms | 22.00 ms | 22.00 ms | 22.10 ms | 22.20 ms | 22.00 ms | 22.10 ms |
| 1140 reroute average frame | 18.55 ms | 18.67 ms | 18.35 ms | 18.55 ms | 18.46 ms | 18.52 ms | 18.58 ms | 18.52 ms |
| 1140 reroute p95 frame | 28.60 ms | 28.30 ms | 27.40 ms | 28.30 ms | 27.80 ms | 27.60 ms | 27.90 ms | 27.80 ms |
| 1200 preview average frame | 18.39 ms | 18.36 ms | 18.77 ms | 18.39 ms | 17.92 ms | 18.51 ms | 18.38 ms | 18.38 ms |
| 1200 preview p95 frame | 25.80 ms | 25.90 ms | 26.60 ms | 25.90 ms | 25.90 ms | 26.00 ms | 25.50 ms | 25.90 ms |
| Preview decode | 64.6 ms | 50.8 ms | 67.4 ms | 64.6 ms | 55.6 ms | 65.6 ms | 64.2 ms | 64.2 ms |
| Open | 72.3 ms | 98.8 ms | 105.0 ms | 98.8 ms | 104.2 ms | 74.7 ms | 79.2 ms | 79.2 ms |
| First paint | 40.0 ms | 44.5 ms | 43.0 ms | 43.0 ms | 45.5 ms | 42.9 ms | 41.3 ms | 42.9 ms |
| Node-move dispatch average | 40.64 ms | 37.05 ms | 39.16 ms | 39.16 ms | 38.55 ms | 40.20 ms | 40.23 ms | 40.20 ms |
| Repaint after dispatch | 25.06 ms | 25.63 ms | 25.18 ms | 25.18 ms | 24.89 ms | 25.99 ms | 26.20 ms | 25.99 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | 0.00 ms (0.0%) | 1.00 ms | pass |
| Plain p95 frame | +0.10 ms (+0.5%) | 2.20 ms | pass |
| Reroute average frame | -0.03 ms (-0.2%) | 1.00 ms | pass |
| Reroute p95 frame | -0.50 ms (-1.8%) | 2.83 ms | pass |
| Preview average frame | -0.01 ms (-0.1%) | 1.00 ms | pass |
| Preview p95 frame | 0.00 ms (0.0%) | 2.59 ms | pass |
| First paint | -0.10 ms (-0.2%) | 5.00 ms | pass |
| Repaint after dispatch | +0.81 ms (+3.2%) | 3.00 ms | pass |

Every final-head sample passes average `<33 ms`, p95 `<100 ms`, open
`<2000 ms`, first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`,
and zero execution-free comparison compiles. No relative or final absolute
gate was breached.

## 2026-08-16 shared Canvas detail thresholds

Merge base: `e77e0eee40d491fd72fca011a85554fa58b510fd` (`origin/main`).
Head gives renderer text detail and transient media DOM one existing `0.5`
boundary, and makes output paging consume the existing `0.75` media-control
token. Values, geometry, paint, media behavior, and renderer signatures are
unchanged.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture ports 5589/5599 and 5609/5619 respectively,
one worker, and native target `127.0.0.1:9`. Both used Linux
7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome
for Testing 149.0.7827.55. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled. The detached base worktree needed
`pnpm install --frozen-lockfile --force` after an initial successful install
reported an up-to-date lockfile without creating `node_modules`; the failed
first benchmark attempt never started either service.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.30 ms | 17.23 ms | 17.22 ms | 17.23 ms | 17.23 ms | 17.34 ms | 17.21 ms | 17.23 ms |
| 1200 plain p95 frame | 22.10 ms | 22.10 ms | 21.80 ms | 22.10 ms | 22.20 ms | 23.60 ms | 22.80 ms | 22.80 ms |
| 1140 reroute average frame | 18.67 ms | 18.52 ms | 18.63 ms | 18.63 ms | 18.43 ms | 18.51 ms | 18.63 ms | 18.51 ms |
| 1140 reroute p95 frame | 28.00 ms | 27.50 ms | 28.20 ms | 28.00 ms | 27.00 ms | 27.60 ms | 29.60 ms | 27.60 ms |
| 1200 preview average frame | 18.63 ms | 18.05 ms | 18.19 ms | 18.19 ms | 18.34 ms | 18.21 ms | 18.14 ms | 18.21 ms |
| 1200 preview p95 frame | 26.70 ms | 27.80 ms | 26.00 ms | 26.70 ms | 26.00 ms | 26.30 ms | 26.00 ms | 26.00 ms |
| Preview decode | 69.0 ms | 66.8 ms | 73.1 ms | 69.0 ms | 54.3 ms | 59.6 ms | 53.8 ms | 54.3 ms |
| Open | 70.8 ms | 72.8 ms | 101.9 ms | 72.8 ms | 73.9 ms | 73.4 ms | 72.1 ms | 73.4 ms |
| First paint | 39.2 ms | 38.9 ms | 48.5 ms | 39.2 ms | 42.5 ms | 41.9 ms | 40.6 ms | 41.9 ms |
| Node-move dispatch average | 40.30 ms | 40.54 ms | 38.79 ms | 40.30 ms | 39.77 ms | 40.45 ms | 40.01 ms | 40.01 ms |
| Repaint after dispatch | 25.54 ms | 26.28 ms | 25.05 ms | 25.54 ms | 26.98 ms | 26.18 ms | 25.98 ms | 26.18 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.00 ms (+0.0%) | 1.00 ms | pass |
| Plain p95 frame | +0.70 ms (+3.2%) | 2.21 ms | pass |
| Reroute average frame | -0.12 ms (-0.6%) | 1.00 ms | pass |
| Reroute p95 frame | -0.40 ms (-1.4%) | 2.80 ms | pass |
| Preview average frame | +0.02 ms (+0.1%) | 1.00 ms | pass |
| Preview p95 frame | -0.70 ms (-2.6%) | 2.67 ms | pass |
| First paint | +2.70 ms (+6.9%) | 5.00 ms | pass |
| Repaint after dispatch | +0.64 ms (+2.5%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-16 shared Canvas detail thresholds rebaseline

`origin/main` advanced to `3c5f237da0986906021d495f45b23ac43709b0fa`
with extension widget-editor hosting, including CanvasHost changes. The branch
merged that base normally and repeated the complete comparison.

Base and head each used three new Chromium processes on `270K-Plus2` with
isolated frontend/fixture ports 5649/5659 and 5669/5679 respectively, one
worker, and native target `127.0.0.1:9`. Both used Linux 7.0.0-28-generic,
Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome for Testing
149.0.7827.55. Protected ports 5199 and 8765 were inspected only and were not
contacted or signaled. One setup invocation installed in the owner checkout
instead of the detached base worktree; the resulting first benchmark command
found no Playwright binary and exited before either service started. The
recorded distribution begins after the correct frozen install.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.22 ms | 17.24 ms | 17.43 ms | 17.24 ms | 17.77 ms | 17.34 ms | 17.71 ms | 17.71 ms |
| 1200 plain p95 frame | 22.40 ms | 21.80 ms | 23.00 ms | 22.40 ms | 24.20 ms | 22.90 ms | 24.20 ms | 24.20 ms |
| 1140 reroute average frame | 18.68 ms | 18.57 ms | 18.54 ms | 18.57 ms | 19.05 ms | 18.71 ms | 18.98 ms | 18.98 ms |
| 1140 reroute p95 frame | 28.10 ms | 27.90 ms | 27.60 ms | 27.90 ms | 29.80 ms | 27.70 ms | 29.40 ms | 29.40 ms |
| 1200 preview average frame | 18.39 ms | 18.05 ms | 18.77 ms | 18.39 ms | 18.14 ms | 19.21 ms | 21.09 ms | 19.21 ms |
| 1200 preview p95 frame | 26.00 ms | 26.10 ms | 28.20 ms | 26.10 ms | 26.20 ms | 28.40 ms | 34.70 ms | 28.40 ms |
| Preview decode | 63.0 ms | 58.6 ms | 61.3 ms | 61.3 ms | 71.5 ms | 71.2 ms | 74.2 ms | 71.5 ms |
| Open | 72.6 ms | 73.5 ms | 77.1 ms | 73.5 ms | 98.8 ms | 79.2 ms | 85.4 ms | 85.4 ms |
| First paint | 42.0 ms | 42.7 ms | 43.5 ms | 42.7 ms | 46.4 ms | 41.6 ms | 46.5 ms | 46.4 ms |
| Node-move dispatch average | 40.15 ms | 38.47 ms | 41.57 ms | 40.15 ms | 37.42 ms | 40.89 ms | 43.84 ms | 40.89 ms |
| Repaint after dispatch | 25.77 ms | 26.07 ms | 26.79 ms | 26.07 ms | 27.16 ms | 26.11 ms | 27.63 ms | 27.16 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.47 ms (+2.7%) | 1.00 ms | pass |
| Plain p95 frame | +1.80 ms (+8.0%) | 2.24 ms | pass |
| Reroute average frame | +0.41 ms (+2.2%) | 1.00 ms | pass |
| Reroute p95 frame | +1.50 ms (+5.4%) | 2.79 ms | pass |
| Preview average frame | +0.82 ms (+4.5%) | 1.00 ms | pass |
| Preview p95 frame | +2.30 ms (+8.8%) | 2.61 ms | pass |
| First paint | +3.70 ms (+8.7%) | 5.00 ms | pass |
| Repaint after dispatch | +1.09 ms (+4.2%) | 3.00 ms | pass |

Every rebased-head sample passes average `<33 ms`, p95 `<100 ms`, open
`<2000 ms`, first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`,
and zero execution-free comparison compiles. No relative or absolute gate
was breached.

## 2026-08-16 Canvas file-drop presentation

Merge base: `bd03149745de4d4e442c24604f93fe49b21ba988`
(`origin/main`). The head adds an inactive CanvasHost signal and conditional
host surface for file-drop presentation. Renderer geometry, scene building,
paint, and command semantics are unchanged.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture ports 5702/5703 and 5700/5701 respectively,
one worker, and native target `127.0.0.1:9`. Both used Linux
7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome
for Testing 149.0.7827.55. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled. The detached base worktree required
`pnpm install --frozen-lockfile --force` after an up-to-date install did not
create `node_modules`.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.28 ms | 17.26 ms | 17.20 ms | 17.26 ms | 17.22 ms | 17.34 ms | 17.28 ms | 17.28 ms |
| 1200 plain p95 frame | 21.60 ms | 22.70 ms | 22.50 ms | 22.50 ms | 22.60 ms | 23.10 ms | 22.50 ms | 22.60 ms |
| 1140 reroute average frame | 18.72 ms | 18.59 ms | 19.20 ms | 18.72 ms | 18.62 ms | 18.53 ms | 18.39 ms | 18.53 ms |
| 1140 reroute p95 frame | 28.50 ms | 27.10 ms | 30.40 ms | 28.50 ms | 28.60 ms | 27.50 ms | 26.60 ms | 27.50 ms |
| 1200 preview average frame | 18.26 ms | 18.36 ms | 18.38 ms | 18.36 ms | 17.93 ms | 17.98 ms | 18.16 ms | 17.98 ms |
| 1200 preview p95 frame | 25.60 ms | 26.10 ms | 26.00 ms | 26.00 ms | 26.00 ms | 25.90 ms | 25.70 ms | 25.90 ms |
| Preview decode | 62.3 ms | 65.4 ms | 61.3 ms | 62.3 ms | 69.8 ms | 76.2 ms | 58.5 ms | 69.8 ms |
| Open | 107.0 ms | 73.0 ms | 73.2 ms | 73.2 ms | 72.0 ms | 72.7 ms | 73.3 ms | 72.7 ms |
| First paint | 42.8 ms | 40.2 ms | 43.1 ms | 42.8 ms | 40.7 ms | 40.5 ms | 41.7 ms | 40.7 ms |
| Node-move dispatch average | 37.23 ms | 41.08 ms | 40.92 ms | 40.92 ms | 40.60 ms | 40.50 ms | 40.07 ms | 40.50 ms |
| Repaint after dispatch | 26.09 ms | 25.70 ms | 25.92 ms | 25.92 ms | 25.69 ms | 25.49 ms | 25.89 ms | 25.69 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.02 ms (+0.1%) | 1.00 ms | pass |
| Plain p95 frame | +0.10 ms (+0.4%) | 2.25 ms | pass |
| Reroute average frame | -0.19 ms (-1.0%) | 1.00 ms | pass |
| Reroute p95 frame | -1.00 ms (-3.5%) | 2.85 ms | pass |
| Preview average frame | -0.38 ms (-2.1%) | 1.00 ms | pass |
| Preview p95 frame | -0.10 ms (-0.4%) | 2.60 ms | pass |
| First paint | -2.10 ms (-4.9%) | 5.00 ms | pass |
| Repaint after dispatch | -0.23 ms (-0.9%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-17 Canvas menu pointer handoff

Merge base: `9663e48548a8d928d0756a1d37705ce63ab5957a`
(`origin/main`). The head removes the hit-testable Canvas-stage backdrop from
the Views/Lenses menu and lets its capture listener dismiss the menu without
consuming the outside pointerdown. It also defers menu Escape handling while
an open native dialog owns the key. Renderer geometry, scene building, paint,
and Canvas interaction code are unchanged.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture ports 16975/16976 and 16977/16978 respectively,
one worker, and native target `127.0.0.1:9`. Both used Linux
7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome
for Testing 149.0.7827.55. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled. The matrix was rerun after integrating
the current base and the review fix.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.28 ms | 17.42 ms | 17.38 ms | 17.38 ms | 17.30 ms | 17.23 ms | 17.51 ms | 17.30 ms |
| 1200 plain p95 frame | 21.90 ms | 24.50 ms | 23.10 ms | 23.10 ms | 23.20 ms | 21.80 ms | 24.70 ms | 23.20 ms |
| 1140 reroute average frame | 18.59 ms | 19.03 ms | 19.15 ms | 19.03 ms | 18.73 ms | 18.51 ms | 19.13 ms | 18.73 ms |
| 1140 reroute p95 frame | 27.90 ms | 29.20 ms | 28.00 ms | 28.00 ms | 28.20 ms | 28.20 ms | 29.80 ms | 28.20 ms |
| 1200 preview average frame | 17.97 ms | 18.61 ms | 18.79 ms | 18.61 ms | 18.04 ms | 20.06 ms | 19.48 ms | 19.48 ms |
| 1200 preview p95 frame | 25.90 ms | 27.30 ms | 27.70 ms | 27.30 ms | 26.00 ms | 35.50 ms | 27.60 ms | 27.60 ms |
| Preview decode | 61.7 ms | 62.1 ms | 53.0 ms | 61.7 ms | 46.4 ms | 54.9 ms | 68.1 ms | 54.9 ms |
| Open | 72.8 ms | 82.1 ms | 79.7 ms | 79.7 ms | 83.0 ms | 74.0 ms | 102.8 ms | 83.0 ms |
| First paint | 40.6 ms | 46.3 ms | 40.8 ms | 40.8 ms | 49.7 ms | 42.1 ms | 42.2 ms | 42.2 ms |
| Node-move dispatch average | 40.41 ms | 41.69 ms | 43.52 ms | 41.69 ms | 40.48 ms | 40.83 ms | 45.54 ms | 40.83 ms |
| Repaint after dispatch | 25.57 ms | 27.14 ms | 27.35 ms | 27.14 ms | 27.74 ms | 26.02 ms | 27.31 ms | 27.31 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.08 ms (-0.5%) | 1.00 ms | pass |
| Plain p95 frame | +0.10 ms (+0.4%) | 2.31 ms | pass |
| Reroute average frame | -0.30 ms (-1.6%) | 1.00 ms | pass |
| Reroute p95 frame | +0.20 ms (+0.7%) | 2.80 ms | pass |
| Preview average frame | +0.87 ms (+4.7%) | 1.00 ms | pass |
| Preview p95 frame | +0.30 ms (+1.1%) | 2.73 ms | pass |
| First paint | +1.40 ms (+3.4%) | 5.00 ms | pass |
| Repaint after dispatch | +0.17 ms (+0.6%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open
`<2000 ms`, first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`,
and zero execution-free comparison compiles. No relative or absolute gate
was breached.

## 2026-08-17 Canvas hierarchy and overview detail

Merge base: `8ecf18cab605c32b3b29a0bce85a890bf399352c`
(`origin/main`). The head derives typed `overview`, `content`, and `controls`
detail from the existing `0.5` and `0.75` thresholds. Overview omits text,
rows, badges, midpoint/toolbox/resize controls, and detailed lens adornments
while preserving screen-stable groups, typed connectivity, selection,
execution/problem/mode, drop, image, and compact media cues. Paint and hit
consume the same tier.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture port pairs 5792/5793, 5794/5795, 5796/5797 and
5812/5813, 5814/5815, 5816/5817 respectively, one worker, and native target
`127.0.0.1:9`. Both used Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0,
Playwright 1.61.1, and Chrome for Testing 149.0.7827.55. Protected ports 5199
and 8765 were inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.13 ms | 17.33 ms | 17.19 ms | 17.19 ms | 16.60 ms | 16.57 ms | 16.58 ms | 16.58 ms |
| 1200 plain p95 frame | 22.50 ms | 23.10 ms | 22.40 ms | 22.50 ms | 18.00 ms | 17.80 ms | 17.40 ms | 17.80 ms |
| 1140 reroute average frame | 18.40 ms | 18.49 ms | 18.44 ms | 18.44 ms | 16.57 ms | 16.68 ms | 16.63 ms | 16.63 ms |
| 1140 reroute p95 frame | 27.00 ms | 28.20 ms | 27.40 ms | 27.40 ms | 17.90 ms | 17.50 ms | 17.30 ms | 17.50 ms |
| 1200 preview average frame | 18.38 ms | 18.41 ms | 18.34 ms | 18.38 ms | 16.86 ms | 16.52 ms | 16.88 ms | 16.86 ms |
| 1200 preview p95 frame | 25.60 ms | 26.10 ms | 26.00 ms | 26.00 ms | 18.00 ms | 17.90 ms | 18.10 ms | 18.00 ms |
| Preview decode | 66.0 ms | 61.8 ms | 69.3 ms | 66.0 ms | 62.5 ms | 58.2 ms | 80.9 ms | 62.5 ms |
| Open | 101.0 ms | 104.2 ms | 72.5 ms | 101.0 ms | 97.9 ms | 99.2 ms | 73.1 ms | 97.9 ms |
| First paint | 43.9 ms | 44.7 ms | 42.4 ms | 43.9 ms | 18.0 ms | 18.6 ms | 16.7 ms | 18.0 ms |
| Node-move dispatch average | 35.84 ms | 35.69 ms | 40.28 ms | 35.84 ms | 35.09 ms | 37.04 ms | 36.57 ms | 36.57 ms |
| Repaint after dispatch | 24.95 ms | 25.55 ms | 25.88 ms | 25.55 ms | 13.51 ms | 17.07 ms | 14.16 ms | 14.16 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.61 ms (-3.5%) | 1.00 ms | pass |
| Plain p95 frame | -4.70 ms (-20.9%) | 2.25 ms | pass |
| Reroute average frame | -1.81 ms (-9.8%) | 1.00 ms | pass |
| Reroute p95 frame | -9.90 ms (-36.1%) | 2.74 ms | pass |
| Preview average frame | -1.52 ms (-8.3%) | 1.00 ms | pass |
| Preview p95 frame | -8.00 ms (-30.8%) | 2.60 ms | pass |
| First paint | -25.90 ms (-59.0%) | 5.00 ms | pass |
| Repaint after dispatch | -11.39 ms (-44.6%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-17 Canvas hierarchy review corrections

Merge base: `8ecf18cab605c32b3b29a0bce85a890bf399352c`
(`origin/main`). The head includes the Canvas hierarchy change plus two review
corrections: higher-priority execution and diagnostic outlines own their dash
style, and overview culling includes the full screen-stable pin and reroute
status-ring extent.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture port pairs 5941/5942, 5943/5944, 5945/5946 and
5951/5952, 5953/5954, 5955/5956 respectively, one worker, and native target
`127.0.0.1:9`. Both used Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0,
Playwright 1.61.1, and Chrome for Testing 149.0.7827.55. Protected ports 5199
and 8765 were inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 17.29 ms | 17.28 ms | 17.23 ms | 17.28 ms | 16.61 ms | 16.56 ms | 16.57 ms | 16.57 ms |
| 1200 plain p95 frame | 21.90 ms | 21.70 ms | 21.60 ms | 21.70 ms | 18.10 ms | 18.10 ms | 18.20 ms | 18.10 ms |
| 1140 reroute average frame | 18.41 ms | 18.46 ms | 18.36 ms | 18.41 ms | 16.69 ms | 16.65 ms | 16.56 ms | 16.65 ms |
| 1140 reroute p95 frame | 27.00 ms | 27.60 ms | 26.60 ms | 27.00 ms | 18.10 ms | 17.50 ms | 18.20 ms | 18.10 ms |
| 1200 preview average frame | 18.39 ms | 17.93 ms | 17.88 ms | 17.93 ms | 16.83 ms | 16.87 ms | 16.53 ms | 16.83 ms |
| 1200 preview p95 frame | 25.40 ms | 25.80 ms | 25.00 ms | 25.40 ms | 18.10 ms | 18.10 ms | 18.00 ms | 18.10 ms |
| Preview decode | 66.9 ms | 57.6 ms | 61.2 ms | 61.2 ms | 66.5 ms | 64.1 ms | 70.6 ms | 66.5 ms |
| Open | 71.1 ms | 105.4 ms | 74.6 ms | 74.6 ms | 72.7 ms | 72.8 ms | 72.2 ms | 72.7 ms |
| First paint | 41.4 ms | 46.4 ms | 40.7 ms | 41.4 ms | 18.2 ms | 20.1 ms | 21.9 ms | 20.1 ms |
| Node-move dispatch average | 40.17 ms | 36.15 ms | 40.36 ms | 40.17 ms | 33.64 ms | 36.20 ms | 33.30 ms | 33.64 ms |
| Repaint after dispatch | 25.73 ms | 25.00 ms | 25.92 ms | 25.73 ms | 14.16 ms | 14.32 ms | 14.15 ms | 14.16 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.71 ms (-4.1%) | 1.00 ms | pass |
| Plain p95 frame | -3.60 ms (-16.6%) | 2.17 ms | pass |
| Reroute average frame | -1.76 ms (-9.6%) | 1.00 ms | pass |
| Reroute p95 frame | -8.90 ms (-33.0%) | 2.70 ms | pass |
| Preview average frame | -1.10 ms (-6.1%) | 1.00 ms | pass |
| Preview p95 frame | -7.30 ms (-28.7%) | 2.54 ms | pass |
| First paint | -21.30 ms (-51.4%) | 5.00 ms | pass |
| Repaint after dispatch | -11.57 ms (-45.0%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-17 Bounded Canvas media and semantic navigation

Merge base: `6252175a56735845e61c15256e8745676f7a172c`
(`origin/main`). The head limits visible host-owned audio/video and output-pager
DOM to 24 roots per family with focused, playing, selected, and open-viewer
retention priority. It also adds a focus-deferred Canvas semantic inventory
whose listbox keeps exactly five live option rows and remains disconnected from
paint, pan, and zoom updates.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture port pairs 62391/62392, 62393/62394,
62395/62396 and 62411/62412, 62413/62414, 62415/62416 respectively, one
worker, and native target `127.0.0.1:9`. Both used Linux
7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome
for Testing 149.0.7827.55. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled. The detached base worktree required
`pnpm install --frozen-lockfile --force` after an up-to-date install did not
create `node_modules`.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 16.54 ms | 16.56 ms | 16.58 ms | 16.56 ms | 16.54 ms | 16.65 ms | 16.64 ms | 16.64 ms |
| 1200 plain p95 frame | 18.00 ms | 18.10 ms | 17.60 ms | 18.00 ms | 17.90 ms | 18.10 ms | 18.30 ms | 18.10 ms |
| 1140 reroute average frame | 16.63 ms | 16.65 ms | 16.58 ms | 16.63 ms | 16.64 ms | 16.57 ms | 16.66 ms | 16.64 ms |
| 1140 reroute p95 frame | 18.20 ms | 17.40 ms | 17.20 ms | 17.40 ms | 17.90 ms | 17.70 ms | 17.30 ms | 17.70 ms |
| 1200 preview average frame | 16.50 ms | 16.49 ms | 16.49 ms | 16.49 ms | 16.85 ms | 16.88 ms | 16.48 ms | 16.85 ms |
| 1200 preview p95 frame | 17.90 ms | 17.90 ms | 17.80 ms | 17.90 ms | 17.90 ms | 17.60 ms | 18.00 ms | 17.90 ms |
| Preview decode | 61.2 ms | 62.1 ms | 61.7 ms | 61.7 ms | 64.7 ms | 62.9 ms | 61.1 ms | 62.9 ms |
| Open | 74.2 ms | 104.2 ms | 70.7 ms | 74.2 ms | 101.7 ms | 70.3 ms | 71.1 ms | 71.1 ms |
| First paint | 20.1 ms | 18.4 ms | 21.9 ms | 20.1 ms | 19.0 ms | 15.6 ms | 15.9 ms | 15.9 ms |
| Node-move dispatch average | 34.09 ms | 37.09 ms | 35.54 ms | 35.54 ms | 36.54 ms | 36.28 ms | 35.86 ms | 36.28 ms |
| Repaint after dispatch | 14.32 ms | 14.99 ms | 13.85 ms | 14.32 ms | 15.61 ms | 14.00 ms | 14.54 ms | 14.54 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.08 ms (+0.5%) | 1.00 ms | pass |
| Plain p95 frame | +0.10 ms (+0.6%) | 2.00 ms | pass |
| Reroute average frame | +0.01 ms (+0.1%) | 1.00 ms | pass |
| Reroute p95 frame | +0.30 ms (+1.7%) | 2.00 ms | pass |
| Preview average frame | +0.36 ms (+2.2%) | 1.00 ms | pass |
| Preview p95 frame | +0.00 ms (+0.0%) | 2.00 ms | pass |
| First paint | -4.20 ms (-20.9%) | 5.00 ms | pass |
| Repaint after dispatch | +0.22 ms (+1.5%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-17 Bounded Canvas media keys and semantic connectivity

Merge base: `6252175a56735845e61c15256e8745676f7a172c`
(`origin/main`). The head includes bounded Canvas media and semantic navigation,
canonicalizes duplicate overlay keys before the 24-root cap, clears stale
active keys, and reports widget-tap and boundary connectivity through retained
semantic pin identities. Semantic derivation remains focus-deferred and outside
paint, pan, and zoom updates.

Base and head each used three separate Chromium processes on `270K-Plus2`
with isolated frontend/fixture port pairs 62601/62602, 62603/62604,
62605/62606 and 62611/62612, 62613/62614, 62615/62616 respectively, one
worker, and native target `127.0.0.1:9`. Both used Linux
7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1, and Chrome
for Testing 149.0.7827.55. Protected ports 5199 and 8765 were inspected only
and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 16.58 ms | 16.63 ms | 16.56 ms | 16.58 ms | 16.63 ms | 16.52 ms | 16.64 ms | 16.63 ms |
| 1200 plain p95 frame | 18.00 ms | 18.00 ms | 18.00 ms | 18.00 ms | 17.50 ms | 17.20 ms | 17.50 ms | 17.50 ms |
| 1140 reroute average frame | 16.68 ms | 16.59 ms | 16.59 ms | 16.59 ms | 16.68 ms | 16.53 ms | 16.68 ms | 16.68 ms |
| 1140 reroute p95 frame | 18.20 ms | 18.10 ms | 18.00 ms | 18.10 ms | 18.20 ms | 17.30 ms | 18.20 ms | 18.20 ms |
| 1200 preview average frame | 16.82 ms | 16.49 ms | 16.53 ms | 16.53 ms | 16.84 ms | 16.53 ms | 16.85 ms | 16.84 ms |
| 1200 preview p95 frame | 18.00 ms | 18.00 ms | 17.70 ms | 18.00 ms | 17.30 ms | 17.70 ms | 18.00 ms | 17.70 ms |
| Preview decode | 68.6 ms | 62.1 ms | 57.5 ms | 62.1 ms | 65.8 ms | 59.1 ms | 66.5 ms | 65.8 ms |
| Open | 73.6 ms | 72.4 ms | 72.7 ms | 72.7 ms | 72.6 ms | 71.8 ms | 73.9 ms | 72.6 ms |
| First paint | 22.9 ms | 22.7 ms | 17.8 ms | 22.7 ms | 16.0 ms | 20.8 ms | 21.2 ms | 20.8 ms |
| Node-move dispatch average | 35.99 ms | 36.45 ms | 36.16 ms | 36.16 ms | 36.32 ms | 36.37 ms | 36.37 ms | 36.37 ms |
| Repaint after dispatch | 13.64 ms | 14.08 ms | 14.10 ms | 14.08 ms | 13.81 ms | 14.25 ms | 14.15 ms | 14.15 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | +0.05 ms (+0.3%) | 1.00 ms | pass |
| Plain p95 frame | -0.50 ms (-2.8%) | 2.00 ms | pass |
| Reroute average frame | +0.09 ms (+0.5%) | 1.00 ms | pass |
| Reroute p95 frame | +0.10 ms (+0.6%) | 2.00 ms | pass |
| Preview average frame | +0.31 ms (+1.9%) | 1.00 ms | pass |
| Preview p95 frame | -0.30 ms (-1.7%) | 2.00 ms | pass |
| First paint | -1.90 ms (-8.4%) | 5.00 ms | pass |
| Repaint after dispatch | +0.07 ms (+0.5%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-17 Canonical Canvas overlay root consumption

Comparison base: `f59f9df42628e9911f61db1a2b39e04b4ae66a51`. The
head renders the already bounded canonical media and output-pager key lists
directly, so duplicate source entries cannot expand into duplicate DOM roots
after the 24-root cap.

The comparison-base samples are the exact-source head samples from the
preceding record. The new head used three separate Chromium processes on
`270K-Plus2` with isolated frontend/fixture port pairs 6331/6332, 6333/6334,
and 6335/6336, one worker, and native target `127.0.0.1:9`. Both measurements
used Linux 7.0.0-28-generic, Node 22.17.1, pnpm 10.31.0, Playwright 1.61.1,
and Chrome for Testing 149.0.7827.55. Protected ports 5199 and 8765 were
inspected only and were not contacted or signaled.

| Metric | Base run 1 | Base run 2 | Base run 3 | Base median | Head run 1 | Head run 2 | Head run 3 | Head median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1200 plain average frame | 16.63 ms | 16.52 ms | 16.64 ms | 16.63 ms | 16.61 ms | 16.53 ms | 16.56 ms | 16.56 ms |
| 1200 plain p95 frame | 17.50 ms | 17.20 ms | 17.50 ms | 17.50 ms | 17.80 ms | 18.20 ms | 17.80 ms | 17.80 ms |
| 1140 reroute average frame | 16.68 ms | 16.53 ms | 16.68 ms | 16.68 ms | 16.56 ms | 16.61 ms | 16.60 ms | 16.60 ms |
| 1140 reroute p95 frame | 18.20 ms | 17.30 ms | 18.20 ms | 18.20 ms | 17.70 ms | 17.90 ms | 18.00 ms | 17.90 ms |
| 1200 preview average frame | 16.84 ms | 16.53 ms | 16.85 ms | 16.84 ms | 16.48 ms | 16.85 ms | 16.83 ms | 16.83 ms |
| 1200 preview p95 frame | 17.30 ms | 17.70 ms | 18.00 ms | 17.70 ms | 18.30 ms | 18.00 ms | 17.90 ms | 18.00 ms |
| Preview decode | 65.8 ms | 59.1 ms | 66.5 ms | 65.8 ms | 77.2 ms | 64.3 ms | 68.6 ms | 68.6 ms |
| Open | 72.6 ms | 71.8 ms | 73.9 ms | 72.6 ms | 77.5 ms | 72.4 ms | 74.0 ms | 74.0 ms |
| First paint | 16.0 ms | 20.8 ms | 21.2 ms | 20.8 ms | 20.0 ms | 20.4 ms | 22.1 ms | 20.4 ms |
| Node-move dispatch average | 36.32 ms | 36.37 ms | 36.37 ms | 36.37 ms | 35.57 ms | 36.33 ms | 36.13 ms | 36.13 ms |
| Repaint after dispatch | 13.81 ms | 14.25 ms | 14.15 ms | 14.15 ms | 14.20 ms | 14.43 ms | 14.19 ms | 14.20 ms |
| Comparison compiles during 20 moves | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Guarded metric | Median delta | Allowed regression | Verdict |
| --- | ---: | ---: | --- |
| Plain average frame | -0.07 ms (-0.4%) | 1.00 ms | pass |
| Plain p95 frame | +0.30 ms (+1.7%) | 2.00 ms | pass |
| Reroute average frame | -0.08 ms (-0.5%) | 1.00 ms | pass |
| Reroute p95 frame | -0.30 ms (-1.6%) | 2.00 ms | pass |
| Preview average frame | -0.01 ms (-0.1%) | 1.00 ms | pass |
| Preview p95 frame | +0.30 ms (+1.7%) | 2.00 ms | pass |
| First paint | -0.40 ms (-1.9%) | 5.00 ms | pass |
| Repaint after dispatch | +0.05 ms (+0.4%) | 3.00 ms | pass |

Every head sample passes average `<33 ms`, p95 `<100 ms`, open `<2000 ms`,
first paint `<1000 ms`, dispatch `<50 ms`, repaint `<100 ms`, and zero
execution-free comparison compiles. No relative or absolute gate was
breached.

## 2026-08-20 Execution progress presentation

Comparison base: `db7ddd3cb06f74e60d70d22fc50430d8c455db85`. Both sides
used three isolated Chromium processes on `DESKTOP-HD25QGE`, with frontend
port 5309, fixture port 5319, one worker, and native target `127.0.0.1:9`.
The table records three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 17.72 ms | 17.76 ms |
| 1200 plain p95 frame | 19.90 ms | 18.50 ms |
| 1140 reroute average frame | 19.62 ms | 19.81 ms |
| 1140 reroute p95 frame | 26.50 ms | 24.10 ms |
| 1200 preview average frame | 17.11 ms | 18.49 ms |
| 1200 preview p95 frame | 22.00 ms | 24.70 ms |
| Preview decode | 48.2 ms | 55.8 ms |
| Open | 105.2 ms | 107.6 ms |
| First paint | 28.0 ms | 26.1 ms |
| Node-move dispatch average | 50.74 ms | 53.57 ms |
| Repaint after dispatch | 18.85 ms | 18.61 ms |
| Comparison compiles during 20 moves | 0 | 0 |

The first complete base and head runs passed all four tests. Repeat samples 2
and 3 on both revisions exceeded only the existing 50 ms node-move dispatch
budget: base 50.74/54.32 ms and head 53.57/59.04 ms. All six samples passed
the frame, p95, open, first-paint, repaint, and zero-comparison-compile gates.
Execution progress adds no renderer work or allocation while idle; its focused
browser proof activates progress only for a running execution.

## 2026-08-21 Executing-node animation

Comparison base: `51b06fe524e4d8bc70c1986aca13043b3fda7345`. Both sides
used three isolated Chromium processes on `DESKTOP-HD25QGE`, frontend port
5309, and one worker. The table records three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 17.21 ms | 17.45 ms |
| 1200 plain p95 frame | 18.10 ms | 18.20 ms |
| 1140 reroute average frame | 19.10 ms | 18.29 ms |
| 1140 reroute p95 frame | 21.80 ms | 19.80 ms |
| 1200 preview average frame | 17.86 ms | 16.68 ms |
| 1200 preview p95 frame | 22.50 ms | 18.40 ms |
| Preview decode | 49.5 ms | 41.2 ms |
| Open | 92.1 ms | 108.7 ms |
| First paint | 28.1 ms | 29.2 ms |
| Node-move dispatch average | 46.08 ms | 40.71 ms |
| Repaint after dispatch | 17.91 ms | 16.67 ms |
| Comparison compiles during 20 moves | 0 | 0 |

Every sample passed the average-frame, p95-frame, open, first-paint, repaint,
and zero-comparison-compile budgets. One base sample (52.93 ms) and one head
sample (53.55 ms) exceeded only the existing 50 ms node-move dispatch budget;
the other two samples on each side passed it. Idle rendering now stops its rAF
loop after the dirty frame. Running nodes alone keep the loop active, while
reduced motion paints one static glow frame.

## 2026-08-22 Identical-scene rebuild skip

Comparison base: `ea1543f347e9367a4c53b53667a88f99e3d74ae5`. Both sides ran
three samples on `DESKTOP-HD25QGE`, frontend port 5321, one worker. The
CanvasHost scene effect now compares the freshly built scene against the
current one (`scenesEqual`) and skips renderer scene replacement when the
content is identical, so the comparison itself is the only new work on this
hot path. The table records three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 17.57 ms | 17.74 ms |
| 1200 plain p95 frame | 17.90 ms | 18.00 ms |
| 1140 reroute average frame | 18.24 ms | 18.46 ms |
| 1140 reroute p95 frame | 18.30 ms | 18.30 ms |
| 1200 preview average frame | 16.61 ms | 16.63 ms |
| 1200 preview p95 frame | 17.90 ms | 18.00 ms |
| Preview decode | 37.8 ms | 38.2 ms |
| Open | 79.8 ms | 79.9 ms |
| First paint | 23.7 ms | 24.0 ms |
| Node-move dispatch average | 39.01 ms | 39.79 ms |
| Repaint after dispatch | 15.10 ms | 16.67 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples passed every budget, including the 50 ms node-move dispatch
budget. Node moves change node positions, so their rebuilds still replace the
scene; the structural comparison adds under 1 ms at 1200 nodes and the skip
path only engages for content-identical rebuilds such as workspace tab
promotion.

## 2026-08-22 Canvas preview caption strip

Comparison base: `fc5b54f05d932fa4aa532e843426994d98b08aca`. Both sides ran
one isolated Chromium sample on `DESKTOP-HD25QGE`, frontend port 5325, and one
worker. The caption-strip layout adds one divider and up to three labels to
each decoded preview at content-detail zoom.

| Metric | Base | Head |
| --- | ---: | ---: |
| 1200 plain average frame | 17.97 ms | 17.71 ms |
| 1200 plain p95 frame | 18.00 ms | 18.20 ms |
| 1140 reroute average frame | 18.25 ms | 18.22 ms |
| 1140 reroute p95 frame | 18.70 ms | 18.50 ms |
| 1200 preview average frame | 16.64 ms | 16.66 ms |
| 1200 preview p95 frame | 18.10 ms | 18.10 ms |
| Preview decode | 39.7 ms | 36.9 ms |
| Open | 103.3 ms | 81.4 ms |
| First paint | 26.8 ms | 24.9 ms |
| Node-move dispatch average | 33.42 ms | 39.41 ms |
| Repaint after dispatch | 16.17 ms | 14.27 ms |
| Comparison compiles during 20 moves | 0 | 0 |

Both samples passed every performance budget. The preview-heavy frame average
moved by +0.02 ms and its p95 was unchanged; no renderer budget regressed.

## 2026-08-30 Stable preview layout

Comparison base: `deb1c3ee1774cfbed309fcafca8d681dc997c56d`. Both sides ran
three isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with frontend
port 5550, fixture port 5560, and one worker. The table records three-run
medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 19.02 ms | 19.59 ms |
| 1200 plain p95 frame | 20.80 ms | 24.60 ms |
| 1140 reroute average frame | 21.85 ms | 21.87 ms |
| 1140 reroute p95 frame | 27.60 ms | 28.90 ms |
| 1200 preview average frame | 17.84 ms | 19.37 ms |
| 1200 preview p95 frame | 25.10 ms | 30.70 ms |
| Preview decode | 54.6 ms | 66.1 ms |
| Open | 175.8 ms | 220.3 ms |
| First paint | 42.9 ms | 52.2 ms |
| Node-move dispatch average | 62.05 ms | 66.39 ms |
| Repaint after dispatch | 19.13 ms | 20.81 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples ran under sustained concurrent host load and exceeded only
the existing 50 ms node-move dispatch budget. Both revisions stayed within
the frame, p95, open, first-paint, repaint, and zero-comparison-compile
budgets. Preview-capable nodes now add a compact layout projection, while the
unchanged fast path returns the source scene directly when no node needs a
preview or text-output region.

## 2026-08-30 Text widget views and completion

Comparison base: `75e7bf35f5ad418b6a7a269fcdc98379d1d9424e`. Both sides ran
three sequential isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with
frontend ports 5429/5449, fixture ports 5439/5459, and one worker. The table
records three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 18.40 ms | 18.55 ms |
| 1200 plain p95 frame | 17.50 ms | 17.60 ms |
| 1140 reroute average frame | 20.57 ms | 20.36 ms |
| 1140 reroute p95 frame | 22.50 ms | 23.10 ms |
| 1200 preview average frame | 17.33 ms | 16.92 ms |
| 1200 preview p95 frame | 20.30 ms | 18.70 ms |
| Preview decode | 50.8 ms | 47.6 ms |
| Open | 145.0 ms | 167.7 ms |
| First paint | 40.2 ms | 44.2 ms |
| Node-move dispatch average | 54.99 ms | 53.41 ms |
| Repaint after dispatch | 16.91 ms | 16.24 ms |
| Comparison compiles during 20 moves | 0 | 0 |

Every frame and paint metric remained within its budget. All six samples
exceeded only the existing 50 ms node-move dispatch budget, including all
three base samples, while the head median was 1.58 ms lower. Document open
increased by 22.7 ms but remained far below its 2 s budget. Text view actions
are derived during scene presentation and do not add work to the frame loop.

## 2026-09-01 Node implementation presentation

Comparison base: `86fd96a97553c1ac64a3be2e38a0f4dbc1d2e7a0`. Both sides ran
three sequential isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with
frontend port 5429, fixture port 5439, and one worker. The table records
three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 18.48 ms | 18.41 ms |
| 1200 plain p95 frame | 17.50 ms | 17.50 ms |
| 1140 reroute average frame | 20.39 ms | 20.24 ms |
| 1140 reroute p95 frame | 23.30 ms | 22.30 ms |
| 1200 preview average frame | 17.32 ms | 17.09 ms |
| 1200 preview p95 frame | 19.70 ms | 20.40 ms |
| Preview decode | 51.5 ms | 50.0 ms |
| Open | 165.9 ms | 165.8 ms |
| First paint | 43.3 ms | 40.7 ms |
| Node-move dispatch average | 54.16 ms | 55.14 ms |
| Repaint after dispatch | 16.77 ms | 16.83 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples exceeded only the existing 50 ms node-move dispatch budget;
every frame, p95, open, first-paint, repaint, and zero-comparison-compile gate
passed. Hidden compatibility inputs remain in document and compile projection
but are omitted from scene rows, while implementation badges are no longer
derived for ordinary nodes. The comparison is performance-neutral.

## 2026-09-01 Scalar/list match pin presentation

Comparison base: `86fd96a97553c1ac64a3be2e38a0f4dbc1d2e7a0`. Both sides ran
three sequential isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with
separate frontend and fixture ports and one worker. The table records
three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 18.43 ms | 18.52 ms |
| 1200 plain p95 frame | 17.60 ms | 17.60 ms |
| 1140 reroute average frame | 20.52 ms | 20.25 ms |
| 1140 reroute p95 frame | 22.60 ms | 22.20 ms |
| 1200 preview average frame | 17.00 ms | 17.34 ms |
| 1200 preview p95 frame | 20.50 ms | 19.60 ms |
| Preview decode | 50.6 ms | 49.9 ms |
| Open | 165.3 ms | 159.4 ms |
| First paint | 40.6 ms | 39.5 ms |
| Node-move dispatch average | 56.21 ms | 55.04 ms |
| Repaint after dispatch | 17.67 ms | 16.71 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples exceeded only the existing 50 ms node-move dispatch budget;
the head median was 1.17 ms lower. Frame, open, paint, repaint, and decode
medians remained within their budgets. Match identity is derived only for
generic declarations, so ordinary concrete pins retain the existing scene
build fast path.

## 2026-09-01 Bounded Advanced groups

Comparison base: `298dd7dd2f0f67d788058b84db8fc11de081b8bb`. Both sides ran
three sequential isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with
separate frontend and fixture ports and one worker. The table records
three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 18.88 ms | 18.47 ms |
| 1200 plain p95 frame | 19.10 ms | 18.20 ms |
| 1140 reroute average frame | 21.72 ms | 21.21 ms |
| 1140 reroute p95 frame | 26.80 ms | 25.70 ms |
| 1200 preview average frame | 18.27 ms | 17.55 ms |
| 1200 preview p95 frame | 24.30 ms | 23.50 ms |
| Preview decode | 54.0 ms | 57.3 ms |
| Open | 163.4 ms | 179.2 ms |
| First paint | 44.9 ms | 43.9 ms |
| Node-move dispatch average | 63.19 ms | 59.75 ms |
| Repaint after dispatch | 19.36 ms | 18.84 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples exceeded only the existing 50 ms node-move dispatch budget;
the head median was 3.44 ms lower. Every frame, p95, open, first-paint,
repaint, decode, and zero-comparison-compile gate passed. Advanced enclosure
bounds are projected with row layout and add three constant-cost paint calls
only on expanded nodes that declare the group.

## 2026-09-01 Advanced placement and widget-output type resolution

Comparison base: `83c9429d205013378d1ec660c3989e74bc45803f`. Both sides ran
three sequential isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with
separate frontend ports, the same isolated native backend, and one worker.
The table records three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 19.54 ms | 19.61 ms |
| 1200 plain p95 frame | 20.30 ms | 20.90 ms |
| 1140 reroute average frame | 24.31 ms | 24.55 ms |
| 1140 reroute p95 frame | 27.60 ms | 28.40 ms |
| 1200 preview average frame | 19.45 ms | 19.55 ms |
| 1200 preview p95 frame | 27.70 ms | 29.40 ms |
| Preview decode | 49.4 ms | 53.2 ms |
| Open | 201.6 ms | 196.5 ms |
| First paint | 41.4 ms | 44.4 ms |
| Node-move dispatch average | 130.29 ms | 129.74 ms |
| Repaint after dispatch | 24.65 ms | 24.32 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples exceeded only the existing 50 ms node-move dispatch budget;
the head median was 0.55 ms lower. Every frame, p95, open, first-paint,
repaint, decode, and zero-comparison-compile gate passed. Advanced row
ordering and widget-tap constraints are resolved while building a scene and
do not add work to the frame loop.

## 2026-09-02 Persistent minimized nodes

Comparison base: `4de69c41d8f950aa30c558f76db23547c846a26b`. Both sides ran
three sequential isolated Chromium samples on `kosin-X570-AORUS-ULTRA`, with
separate frontend and fixture ports and one worker. The table records
three-run medians.

| Metric | Base median | Head median |
| --- | ---: | ---: |
| 1200 plain average frame | 18.44 ms | 18.47 ms |
| 1200 plain p95 frame | 19.60 ms | 17.70 ms |
| 1140 reroute average frame | 20.78 ms | 21.13 ms |
| 1140 reroute p95 frame | 25.30 ms | 26.30 ms |
| 1200 preview average frame | 17.45 ms | 17.22 ms |
| 1200 preview p95 frame | 22.70 ms | 19.80 ms |
| Preview decode | 51.9 ms | 49.9 ms |
| Open | 151.7 ms | 155.8 ms |
| First paint | 34.7 ms | 40.5 ms |
| Node-move dispatch average | 66.48 ms | 58.28 ms |
| Repaint after dispatch | 18.44 ms | 17.39 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All six samples exceeded only the existing 50 ms node-move dispatch budget;
the head median was 8.20 ms lower. Every frame, p95, open, first-paint,
repaint, decode, and zero-comparison-compile gate passed. Expanded nodes add
only constant-time minimized-state checks; compact preview and aggregate pin
work runs only for minimized nodes.

## 2026-09-06 Position-only scene projection

Three sequential isolated Chromium runs against the CPU ComfyUI fixture
measured 38.83, 42.07, and 41.87 ms node-move dispatch averages before the
position-only path and 16.55, 13.96, and 15.05 ms after it. Repaint averages
remained within budget at 21.56, 20.31, and 20.51 ms after the change. The
fast path reuses a root scene only when graph semantics, non-position view
state, schema identity, widget capabilities, and extension capabilities are
unchanged.

## 2026-09-06 Large overview path batching

The hosted CPU runner measured the 1200-node, 1140-reroute pan and zoom proof
at 43.52 ms per frame before large overview noodles and reroute dots were
batched by rendered type. An isolated local Chromium run after batching
measured 18.23 ms average and 21.10 ms p95 while retaining the existing 33 ms
average and 100 ms p95 budgets. Selected, dragged, mismatched, optional, and
scope-highlighted paths remain on their individual rendering paths.

## 2026-09-06 View-only scene rebuilds

The failing hosted-suite reproduction measured node-move dispatch at 56.15 ms
before layout and text measurement reuse. Three sequential isolated Chromium
runs against the CPU ComfyUI fixture measured 38.83, 42.07, and 41.87 ms after
the change (41.87 ms median). Repaint medians remained within budget at 16.53,
16.67, and 16.30 ms, with zero comparison compiles in every run.

## 2026-09-06 Full conditional boundary forwarding

Comparison base: `a4f85311db888e6bb3e57199f8701eb0320bb726`. One sequential
isolated Chromium sample per side on LesserRipperPC, with frontend port 5397,
fixture port 5398, and `playwright.perf-isolated.config.ts`.

| Metric | Base | Full boundary forwarding |
| --- | ---: | ---: |
| 1200 plain average frame | 18.42 ms | 17.79 ms |
| 1200 plain p95 frame | 19.00 ms | 17.80 ms |
| 1140 reroute average frame | 22.32 ms | 19.50 ms |
| 1140 reroute p95 frame | 28.30 ms | 23.00 ms |
| 1200 preview average frame | 18.70 ms | 17.05 ms |
| 1200 preview p95 frame | 27.20 ms | 20.00 ms |
| Preview decode | 56.4 ms | 51.5 ms |
| Open | 142.1 ms | 107.6 ms |
| First paint | 37.4 ms | 35.5 ms |
| Node-move dispatch average | 60.63 ms | 37.31 ms |
| Repaint after dispatch | 18.41 ms | 18.90 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All four head tests pass without budget changes. The base exceeds only the
50 ms dispatch budget. Scene builds reuse text measurements within one build,
not across rebuilds. Widget accessibility refreshes index scene links once
rather than scanning every link for every widget; selector rows still exclude
synthetic boundary connections. Conditional state inheritance is derived
only for instances that expose full subtrees.

## 2026-09-06 Transparent media preview backgrounds

Comparison base: `6da85e095b1c77837a4dd7c827f13700038a45e9`. One sequential
isolated Chromium sample per side on DESKTOP-FB41N5T (Windows), with frontend
port 54873, fixture port 54874 and `playwright.perf-isolated.config.ts`.

| Metric | Base | Checkerboard previews and media diagnostics |
| --- | ---: | ---: |
| 1200 plain average frame | 18.43 ms | 19.66 ms |
| 1200 plain p95 frame | 21.40 ms | 25.70 ms |
| 1140 reroute average frame | 21.74 ms | 21.98 ms |
| 1140 reroute p95 frame | 28.90 ms | 31.00 ms |
| 1200 preview average frame | 18.87 ms | 21.28 ms |
| 1200 preview p95 frame | 29.00 ms | 35.50 ms |
| Preview decode | 64.6 ms | 62.6 ms |
| Open | 126.9 ms | 140.7 ms |
| First paint | 40.8 ms | 45.3 ms |
| Node-move dispatch average | 46.02 ms | 46.17 ms |
| Repaint after dispatch | 22.73 ms | 22.41 ms |
| Comparison compiles during 20 moves | 0 | 0 |

All four tests pass on both sides without budget changes. Transparent preview
backgrounds use one cached 16-pixel pattern per renderer, painted only inside
the fitted image rectangle. These single samples include host scheduling
variation and do not isolate the cost of the extra background fill.

## 2026-09-06 Position-only scene updates with media inspection

Comparison base: [Windows test readiness](https://github.com/Kosinkadink/Dinkster-Frontend/commit/d4d3802d4ef196b9278c634c79d15f99d36b3d9b).
One focused base sample and one integrated Chromium sample on
DESKTOP-FB41N5T, using isolated frontend port 54873 and fixture port 54874.

| Metric | Base | Position-only update and media inspection |
| --- | ---: | ---: |
| Open | 140.5 ms | 135.2 ms |
| First paint | 44.8 ms | 43.6 ms |
| Node-move dispatch average | 52.60 ms | 17.01 ms |
| Repaint after dispatch | 25.04 ms | 21.49 ms |
| Comparison compiles during 20 moves | 0 | 0 |

The base exceeded the unchanged 50 ms dispatch budget. The integrated
four-test suite passes all budgets: plain average/p95 18.52/25.40 ms,
1140 reroutes 21.16/32.40 ms, 1200 previews 19.29/28.10 ms, and cold decode
66.6 ms. Position-only immutable updates reuse semantic layout and diagnostics;
other scene inputs still force a full build.

## 2026-09-07 In-place graph mutation cache validation

Comparison base: [Full E2E head before native media completion](https://github.com/Kosinkadink/Dinkster-Frontend/commit/d4d3802d4ef196b9278c634c79d15f99d36b3d9b).
One prior base sample and one integrated Chromium sample on 5800XT1L. The
integrated sample used isolated CPU-only hosted ports 5490-5492.

| Metric | Base | Graph mutation snapshots and bounded media cleanup |
| --- | ---: | ---: |
| Node-move dispatch average | 17.76 ms | 14.28 ms |

The integrated sample also measured 91.0 ms open, 33.2 ms first paint,
18.96 ms repaint after dispatch, and zero comparison compiles. Graph and view
snapshots now reject position-only reuse after in-place structural mutation;
the unchanged 50 ms dispatch budget still passes without narrowing the test.

## 2026-09-20 Virtual note scene model

Comparison base: `fd40f5c257add1bd40ad57b6459729917035e7a6`. One base
sample and one integrated sample on ripperpc with Node 22.23.2, using the
unchanged `packages/canvas/test/perf.test.ts` 1200-node workloads.

| Scene build | Base | Virtual note model |
| --- | ---: | ---: |
| Plain 1200-node graph | 56.2 ms | 53.5 ms |
| Feature-heavy 1200-node graph | 81.5 ms | 77.2 ms |
| 60-instance subgraph root | 3.7 ms | 3.9 ms |

All unchanged 2-second budgets pass. The registered virtual-node lookup and
optional render-model field add no measurable regression to ordinary scenes.
The integrated isolated Chromium suite also passes: plain average/p95
21.75/43.90 ms, 1140 reroutes 29.33/48.10 ms, 1200 previews 20.78/37.00 ms,
open/first paint 283.5/75.3 ms, move dispatch/repaint 24.48/31.07 ms, zero
comparison compiles, and 102.1 ms cold decode.

## 2026-09-22 Node decoration registry

Comparison base: `0904f0407da90268dbd78c78e28834d81ed0c791`. One base
sample and one integrated sample ran consecutively on X570 with Node 22.23.2
and the tracked `playwright.perf-isolated.config.ts` fixture.

| Metric | Base | Node decorations |
| --- | ---: | ---: |
| 1200-node pan/zoom average / p95 | 27.90 / 67.60 ms | 24.76 / 50.90 ms |
| 1200 nodes + 1140 reroutes average / p95 | 37.48 / 86.60 ms | 29.59 / 54.40 ms |
| 1200 nodes + 1200 previews average / p95 | 24.38 / 50.00 ms | 29.21 / 62.70 ms |
| Open / first paint | 266.7 / 114.4 ms | 268.4 / 84.2 ms |
| Node-move dispatch / repaint average | 31.27 / 40.24 ms | 28.89 / 34.88 ms |
| Cold decode, 64 unique 256 px images | 104.4 ms | 125.1 ms |

The integrated run passed all unchanged budgets. The base reroute sample
exceeded the unchanged 33 ms average-frame budget while the integrated sample
passed it. Node decoration lookups retain the direct title path when a node has
no color, suffix, or status, avoiding per-frame array allocation on ordinary
nodes.

## 2026-09-27 Occurrence-aware region schemas

Comparison base: `987e3ed127525fc1f54197617beec49f0ac18b8f`. One base
sample and one integrated sample ran concurrently on X570 with Node 22.23.2
and the unchanged `packages/canvas/test/perf.test.ts` workloads.

| Scene build | Base | Occurrence-aware schemas |
| --- | ---: | ---: |
| Plain 1200-node graph | 48 ms | 51 ms |
| Feature-heavy 1200-node graph | 75 ms | 74 ms |
| 60-instance subgraph root | 3 ms | 5 ms |

All unchanged 2-second budgets pass. Scene solving now resolves concrete
subgraph nodes through their occurrence contracts, including region list
ports; ordinary backend-node resolution remains unchanged.

## 2026-10-26 Adjacent widget border sockets

X570 CPU, Node 26.12.1. Before: `4ba0a2ffef43e7c394d94a2bad3b28920d23a780`;
after: `225c5f3b6811c8ce611d3a57e7d19527031423ac`. Median of seven warm
scene builds using the existing 60-chain, 20-node synthetic workloads and
the same fixture schemas. These are scene-build times, not browser frame times.

| Scene build | Before | After |
| --- | ---: | ---: |
| Plain 1200-node graph | 54.24 ms | 48.22 ms |
| Feature-heavy 1200-node graph | 76.21 ms | 77.02 ms |

The feature-heavy workload includes reroutes, value sources, nets, groups and
selectors. Ordinary sockets remain on node borders; adjacent widget sockets
use separate vertical slots without per-endpoint horizontal overrides.

## 2026-10-27 Exported literal presentation

X570 CPU, Chromium, Node 26.12.1. Median of seven batches of 100 queries
after 50 warmups on a two-graph, four-runtime-node fixture. The document
measurement includes resolver construction and one source query.

| Source specification query | Graph-local derivation | Document-aware derivation |
| --- | ---: | ---: |
| Exported literal | 0.001 ms | 0.110 ms |

The graph-local query misses exported consumers; the document query resolves
their shared constraints. These are query times, not whole-scene or frame
measurements, and do not measure backend execution.

## 2026-10-27 Promoted literal widgets

X570 CPU, Node 26.12.1, two warmups and median of seven scene builds.
Compared the preceding scene implementation with the integrated scene using
the same current core and historical fixture schemas, 60 chains of 20 nodes.
This isolates scene resolution cost, not a complete revision comparison.

| Scene build | Previous scene | Promoted literal widgets |
| --- | ---: | ---: |
| Plain 1200-node graph | 52.61 ms | 51.77 ms |
| Feature-heavy 1200-node graph | 79.72 ms | 71.07 ms |

Both workloads remain below the unchanged 2-second scene-build budget.
These measurements do not measure browser frame time or backend execution.

## 2026-10-30 Staged command publication

X570 CPU, Node 26.12.0, consecutive single runs of the unchanged
`packages/core/test/perf-dispatch.test.ts` 1200-node fixture. Compared
`0fa869384081` with `97fd6420e6a6` using the same installed dependencies.

| Operation | Before total (ms) | Staged total (ms) |
| --- | ---: | ---: |
| 300 node.setValue dispatches | 1144.7 | 1043.4 |
| 300 node.add dispatches | 1149.6 | 1096.4 |
| Delete 200 nodes | 421.7 | 392.5 |
| 200 undo operations | 51.0 | 50.3 |
| 200 redo operations | 52.6 | 47.1 |

All unchanged test budgets pass. These single-run observations include
shared-host variation and do not establish a causal speed improvement. They
measure synchronous dispatch with candidate/history snapshots, not network
admission, rendering or backend execution.

## 2026-10-31 Workflow asset admission

X570 CPU, Node 26.12.0, two warmups and median of five samples. Each sample
creates 200 single-input asset edits and admits one further edit through an
immediately acknowledged fake connection. Compared `0fb15f748825` with the
shared census and root-only journal, using identical fixtures and dependencies.

| Nodes / history records | Admission before (ms) | Admission after (ms) | Journal before (bytes) | Journal after (bytes) | Exact roots |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 / 200 | 2.17 | 1.54 | 189213 | 15212 | 202 |
| 1200 / 200 | 449.21 | 48.64 | 545625 | 103938 | 1401 |

Admission includes census, serialization, exact acknowledgment validation and
commit, not network latency, rendering or backend collection. The harness
asserted every expected digest independently in each sample. Node-only history
visits changed nodes, while subgraph instances and structural changes retain
full snapshot checks. History replay still copies patched document paths; these
numbers do not establish a constant-time bound. Unresolved owners still remain
journaled until acknowledged reconciliation/release is implemented.

## Ordinary dispatch retention selection (2026-11-02, X570)

Native `AppState.dispatchTo` compares the current and candidate document census
before selecting awaited retention. A Node 26 Vitest probe measured 20 title
changes after 10 warmup edits, using an unresolved EmptyImage schema and no
network or rendering. The baseline is direct session dispatch, equivalent to
the previous application route for this title command. Each sample asserted
successful synchronous publication and the expected title.

| Nodes | Direct session baseline mean (ms) | Application selection mean (ms) |
| --- | --- | --- |
| 1 | 0.040 | 0.054 |
| 1200 | 1.350 | 2.696 |

This measures selection overhead, not backend acknowledgment latency or frame
time. Selection does not replay history; awaited admission still includes it.

## Local publication guard (2026-11-02, X570)

The same Node 26 title-edit probe measured 20 changes after 10 warmups with
the local session publication guard enabled. Direct commits now compare the
two document censuses before inspecting history: asset-neutral edits do not
need historical roots. Application dispatch already checks the candidate and
does not repeat that work at commit.

| Nodes | Direct guard before fast path mean (ms) | Direct guard after fast path mean (ms) | Application before (ms) | Application after (ms) |
| --- | --- | --- | --- | --- |
| 1 | 0.220 | 0.072 | 0.054 | 0.057 |
| 1200 | 8.166 | 3.224 | 2.704 | 2.669 |

These consecutive shared-host runs measure synchronous publication, not
network latency, rendering or a causal application speed improvement. Direct
dispatch pays the document census cost relative to the unguarded baseline
above; only candidates introducing an identity absent from the current
document need the additional history census.

## Live resident availability (2026-11-15, X570)

Chromium through Playwright, Node 26.12.1, 1200 resident-output nodes. A probe
alternated 24 node moves with live compilation enabled and bypassed, discarding
the first two samples of each mode and reporting medians. Each edit awaited
two animation frames. The fixture asserted its node count and successful moves.

| Position edit | Live compile bypassed (ms) | Live availability enabled (ms) | Compile time per edit (ms) |
| --- | ---: | ---: | ---: |
| Before position-only reuse | 32.7 | 60.6 | 27.9 |
| With position-only reuse | 33.4 | 33.5 | 0.0 |

The optimized probe observed zero compile calls for position-only edits;
availability still recompiles when graph semantics or schemas change. These
shared-host observations include frame scheduling and do not establish a
causal speed improvement, an absolute frame budget or backend execution cost.
The browser problem-surface cases separately check that moving a refused node
retains its reason, disconnecting clears a graph-specific refusal and undo
restores it, while host-declared unavailability survives disconnection.

## Large-graph numeric increment clicks (2026-11-19, X570)

Ordinary production app builds, real local native backend and the same
1200-node/1140-link workflow at 68% zoom in a 2560x1440 Chromium viewport.
One warmup increment followed by ten real pointer down/up pairs requested
100 ms apart on the first Upscale Image By `scale_by` increment arrow.
Input-to-frame ends at the JavaScript main-canvas copy frame containing the
new value or a superseding value, not physical display presentation.

| Build | Click-to-frame upper median (ms) | Click-to-frame range (ms) | Distinct incremented values painted |
| --- | ---: | ---: | ---: |
| Unchanged production PR 548 head 703fbce597f6 | 702.4 | 239.3-903.4 | 3 of 10 |
| Deferred comparison compile only | 93.8 | 81.2-101.4 | 10 of 10 |
| Deferred comparison and static numeric scene reuse | 47.1 | 41.3-65.0 | 10 of 10 |
| Same repair with static numeric asset-root proof | 51.1 | 42.7-65.0 | 10 of 10 |

All ten increments committed in every run; the last value was 1.11. Each row
is one ten-click sequence on a shared host, not three trials or a native-display
latency claim. The final row ran alongside independent CPU browser validation;
it does not demonstrate a timing win over the scene-reuse-only row. It still
misses the issue's click target. The static proof was separately exercised on
the actual fixture/catalog and avoids both admission-comparison censuses.
A separate instrumented before profile attributed 67-116 ms per edit to
whole-workflow compilation, 23-46 ms to scene building, 15-24 ms to scene
installation/comparison and 11-34 ms to asset-root scans. Those profiler costs
include instrumentation overhead and are not substituted for the timing rows.
Asset admission, history and save semantics are unchanged. Comparison results
remain pending during edits; queue validation is still independent and fresh.

## Mirror estimate continuity during authority promotion (2026-11-19)

Controlled browser diagnostic on X570, CPU-only native backend and route-mocked
2x2 mirror fixture. The real authority promotion starts only after the estimate
is ready; 30 samples are taken 10 ms apart. This is a development-build
continuity observation, not production frame-rate or clean latency acceptance.

| Build | Missing estimate samples | Observed absence |
| --- | ---: | ---: |
| Main 4ccb133e5584 | 10 of 30 | 111.2 ms |
| Equivalent-session comparison continuation | 0 of 30 | None observed |

Both sessions were observed, with a different Tab/store and a live shared
session after promotion. All new-session preview publications before disabling
estimates retained the 2x2 estimate. Original exact complement pixels, setting-off
and page-error controls pass. Full artifact snapshots/revisions remain fresh;
changed documents, assets, schemas, extensions, targets and unrelated replacement
sessions cannot inherit comparison proof. The originating hosted failure did not
capture promotion, so attribution of that exact event remains conditional.

## Metadata-only title edits (2026-11-19, X570)

Optimized production test-mode bundles, local pinned native CPU backend,
RTX 4090 Vulkan Chromium uncapped, 2560x1440/DPR 1. The same synthetic
1200-node/1140-link workflow and reading camera received three ordinary
`node.setTitle` session commands, 1.8 seconds apart. Chrome trace, CPU profiler
and wrappers around validation and compilation were enabled in both runs.
These are diagnostic observations from one sequence per build on a shared
host, not clean acceptance timings, a native-display latency measurement or
a timing gate. The before build already contains deferred comparison work
from the numeric-edit repair; that earlier improvement is not credited here.

| Metric (ms, three edits in order) | Before title-only reuse | After title-only reuse |
| --- | --- | --- |
| Synchronous dispatch | 131.0 / 84.4 / 88.1 | 80.2 / 71.6 / 67.4 |
| Maximum frame gap through 1.6 s | 132.9 / 97.7 / 95.6 | 82.0 / 81.1 / 72.4 |
| Retention validation inside dispatch | 30.0 / 12.6 / 13.7 | 0.5 / 0.4 / 0.4 |
| Deferred comparison compile | 98.4 / 77.5 / 71.1 | No calls |
| Maximum frame gap, 350-1600 ms after edit | 41.9 / 44.7 / 47.5 | 41.7 / 51.1 / 37.4 |

Before, compilation began 191-241 ms after dispatch started. After, advisory
resident/unavailable diagnostics reuse their anchors and reasons only when
structural sharing proves that node titles alone changed. Full artifacts,
exports and queue validation still use the current snapshot and revision;
semantic edits, registry or extension changes, target changes and replacement
sessions invalidate the advisory cache. The same title proof avoids asset-root
rescans without admitting new asset identities. Title add/remove and undo/redo
retain their ordinary document history.

Neither sequence had a later long task in the 350-1600 ms window. The remaining
67-80 ms dispatches and up to 51.1 ms later frame gap still miss a no-missed-frame
or high-refresh click goal. This change removes the measured redundant work,
not all document validation, scene reconstruction or reactive update cost.
The after sequence measured [title-only reuse cd926868713e](https://github.com/Kosinkadink/Dinkster-Frontend/commit/cd926868713e86f169135927e138a74171a684c5). A subsequent cache-hit update
advances the comparison document to retain reuse across alternating titles and
position edits; a cache regression covers that case, but it was not retimed.
