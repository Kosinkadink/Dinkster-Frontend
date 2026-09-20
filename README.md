# Dinkster-Frontend

Greenfield ComfyUI frontend. Framework-free TypeScript core, retained-canvas
renderer, SolidJS shell. The companion backend rewrite lives in Dinkster.

Full architecture: [docs/architecture.md](docs/architecture.md).

## Layout

- `packages/core` - `@dinkster/core`: document model, schema registry, identity,
  invariants, compiler, event normalization, signals. No DOM at runtime, no framework.
- `packages/client` - `@dinkster/client`: backend connection (HTTP + WS,
  current-ComfyUI wire quarantined behind normalizers), execution store.
- `packages/widgets` - `@dinkster/widgets`: public widget registry + core widget
  kinds (INT/FLOAT/STRING/BOOLEAN/COMBO) built on the same public API extensions use.
- `packages/canvas` - `@dinkster/canvas`: framework-free Canvas2D renderer
  (row-model layout, scene builder, pan/zoom, viewport culling, execution styling).
- `packages/app` - `@dinkster/app`: SolidJS shell (tabs, queue rail, outputs,
  problems). Solid touches core state only through `src/solid-adapter.ts`.
- `packages/e2e` - `@dinkster/e2e`: Playwright smoke tests (need a live backend).

## Development

```bash
pnpm install
pnpm -r typecheck
pnpm test
```

The workspace test command runs one package at a time to avoid competing
worker pools starving child-process tests. Each package keeps its own file
parallelism and test deadlines.

See [Testing](docs/testing.md) for the fast PR subset, full-validation jobs
and branch-ref dispatch commands.

### Persistent user-facing test session

When leaving the frontend running for testing from another machine, bind the
frontend to all active interfaces on its fixed development port:

```bash
DINKSTER_NATIVE_BACKEND=http://127.0.0.1:3639 \
  pnpm --filter @dinkster/app dev --host 0.0.0.0 --strictPort
```

Use `http://<lan-ip>:5199` on the local network or
`http://<tailscale-ip-or-name>:5199` when the host has a working Tailscale
address. Verify each real address with an HTTP request before reporting it as
available; binding to `0.0.0.0` alone does not prove Tailscale connectivity.
The Dinkster backend stays private on `127.0.0.1:3639`; remote browsers reach it
only through the frontend's existing same-origin `/api/*` proxy. This exposes
no additional listener. Isolated short-lived CI or browser-test servers that
are not kept running for a user may remain loopback-only.

### Running the app against a live ComfyUI

The dev server proxies native API routes to local Dinkster at
`http://127.0.0.1:3639` by default; `DINKSTER_NATIVE_BACKEND` overrides that
target. Legacy ComfyUI routes use `http://127.0.0.1:8199` by default;
`DINKSTER_V1_BACKEND` overrides that target and `DINKSTER_BACKEND` remains a
legacy alias. The proxy rewrites the Origin header because ComfyUI 403s
cross-origin POSTs.

```bash
# terminal 1: any ComfyUI instance
python ComfyUI/main.py --cpu --port 8199

# terminal 2
pnpm --filter @dinkster/app dev   # http://127.0.0.1:5199
```

### E2E smoke tests

Require the live backend above. Playwright starts (or reuses) the dev server.

```bash
pnpm --filter @dinkster/e2e exec playwright install chromium   # once
pnpm --filter @dinkster/e2e test:e2e
```

The suite is split into two Playwright projects (see
`packages/e2e/playwright.config.ts`): `parallel-safe` (client-side and
route-mocked specs, run with 10 workers) and `backend-serial`
(specs that execute prompts or write shared server state, plus timing-budget
specs, run one at a time). `test:e2e` runs both in order (~6 min vs ~11 min
all-serial). A new spec that executes prompts or writes server state MUST be
added to `BACKEND_SERIAL_SPECS` in the config, or it will flake across
workers. Fallbacks:

```bash
pnpm --filter @dinkster/e2e test:e2e:serial          # old trustworthy all-serial run
pnpm --filter @dinkster/e2e test:e2e:parallel-only   # quick client-side pass
```

Re-check any parallel-only failure with the serial run before treating it as
a real regression; if it only reproduces in parallel, the spec belongs in
`BACKEND_SERIAL_SPECS`.

### Live client integration tests

```bash
DINKSTER_LIVE_URL=http://127.0.0.1:8199 pnpm --filter @dinkster/client test
```

### Refreshing golden fixtures

`packages/core/fixtures/object_info.json` is a capture from a real ComfyUI:

```bash
curl -s http://127.0.0.1:8188/object_info -o packages/core/fixtures/object_info.json
```

## Status

Contracts + golden fixtures complete:

- [x] Identity scheme (node/port/dynamic-member/occurrence, `(connection, prompt)` executions)
- [x] Workflow document format v1 (ID-keyed values, semantic/view split, subgraph defs + instances, named nets)
- [x] Unified Diagnostic model
- [x] Normalized NodeSchema model (ordered interface, symmetric dynamic inputs/outputs, TypeExpr)
- [x] /object_info parser (V1-shaped wire with embedded V3 constructs) + golden fixture (810 real nodes)
- [x] Structural invariant checker (the test oracle)
- [x] CompileArtifact + provenance contract (types)
- [x] Event normalization contract (types)
- [x] WidgetKind/WidgetView/PreviewRenderer contracts v1 (types)
- [x] Event normalizer implementation (comfy-v1) + recorded event-stream fixtures (success/cached/error/interrupted/validation)
- [x] JSON Schema for the document format (published spec, cross-checked against the runtime validator) + migration pipeline skeleton (version gates, stepwise chain, foreign-format detection)
- [x] Workflow golden fixtures (minimal, subgraph/nets/dynamic, legacy litegraph reject)
- [x] Prompt (compile output) golden fixtures - workflow/prompt pairs validated against a real server, pinning occurrence-key runtime ids, ID-keyed values, `[id, outputIndex]` links, and promoted-value flattening
- [x] Command/patch interfaces (serializable PatchOps with pure inversion, transaction builder, store contract; property-tested undo round-trip)
- [x] Subgraph boundary -> NodeSchema derivation (widget promotion, per-node type-variable namespacing, output-node propagation; tested against real parsed schemas)

The walking skeleton runs end-to-end against a live ComfyUI:

- [x] Compiler: subgraph flattening (occurrence-key runtime ids), named-net expansion, promoted-value overrides, partial-scope upstream closure, mute handling, canonical-JSON semantic hash
- [x] Client: schema registry from /object_info, prompt submission with provenance-anchored rejection diagnostics, WS event normalization (JSON + binary previews), execution store keyed by `(connection, promptId)` - multiple executions first-class, event/HTTP race safe, /history output hydration for cached runs
- [x] Widgets: core INT/FLOAT/STRING/BOOLEAN/COMBO through the public registry (no private hooks)
- [x] Canvas: row-model layout (paired input/output lines, full-width widget rows, overflow-output rows), automatic initial node sizing, scene builder, Canvas2D renderer with pan/zoom/DPR/culling/per-node execution styling; subgraph instances render via boundary-derived NodeSchema
- [x] Solid shell: tabs, queue rail, outputs, problems, status; core signals bridged through one adapter file; execution -> tab routing by artifact lineage, never "the active tab"
- [x] Playwright smoke suite against a real backend (connect, render, queue-to-completion with outputs, subgraph lineage routing)
- [x] Benchmark harness: deterministic synthetic-workload generator (`syntheticWorkflow`), CI budget tests for load/compile/scene-build on 1200 nodes, a Playwright frame-time spec driving the real renderer, and a comparative bench against the current ComfyUI frontend (see below)

### Renderer benchmark vs current ComfyUI frontend

`node packages/e2e/bench/compare.mjs` drives Dinkster, the stock LiteGraph
renderer, and Nodes 2.0 (`Comfy.VueNodes.Enabled`) through the identical
workload and camera path: the same 1,200-node / 1,140-link synthetic graph
(EmptyImage -> 18x ImageScaleBy -> PreviewImage chains) on the same
world-space grid, deterministic load (no UI gestures), fit-to-scene, then 120
measured frames of pan + oscillating zoom at 1600x900 in the same headless
Chromium with vsync uncapped, 3 reps, medians reported.

Latest run (Chromium 149, ComfyUI 0.28.0, frontend package 1.45.21, Linux):

| target                    | load (ms) | avg frame | p50   | p95   | p99   | frames >33ms |
|---------------------------|-----------|-----------|-------|-------|-------|--------------|
| Dinkster                     | 12        | 2.6       | 0.4   | 13.2  | 13.7  | 0/120        |
| ComfyUI LiteGraph         | 491       | 14.4      | 9.7   | 45.2  | 49.0  | 14/120       |
| ComfyUI Nodes 2.0 (beta)  | 925       | 316.3     | 296.5 | 410.3 | 425.0 | 120/120      |

Caveats: node pixel sizes differ per renderer, Nodes 2.0 is in beta, and
headless rasterization differs from desktop GPUs - treat this as
architecture-level signal, not marketing. Raw JSON + verification screenshots
land in `packages/e2e/bench/results/` (gitignored).

Next: editing - commands/undo wired to the UI, link/widget editing, subgraph drill-in.
