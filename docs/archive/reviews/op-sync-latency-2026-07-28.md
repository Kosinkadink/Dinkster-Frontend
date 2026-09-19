# Multiplayer op-sync latency investigation - 2026-07-28

## Conclusion

On two local browser contexts with dispatch phase randomized across the 60 Hz
frame, a single widget edit measured 12.15 ms p50 / 18.4 ms p95 from local
dispatch to the receiver's post-render rAF; repeated node moves measured
11.85 ms / 18.41 ms. The combined local HTTP, backend, and WS interval was
2.0-2.4 ms p50 and 2.81 ms p95. For these small ops, the largest measured
segment was waiting for the renderer's next frame, not frontend document
publication.

Large atomic patches change the result. A 20-node paste (60 patch entries,
about 7.1 KB in the JSON request body) measured 25.2 ms p50 / 47.46 ms p95 to
the post-render rAF. The dominant measured stage distribution was POST entry to
the receiver's WS op event at 17.2 ms / 38.51 ms; client-only timestamps cannot
split that interval among HTTP, server ordering/fanout, WS delivery, and JSON
parsing. Receiver WS event to document publication remained 0.4 ms / 0.83 ms
against the fixed small baseline document. The frontend nevertheless rebuilds
the complete active scene for every document signal; that is an amplification
risk on real schema-heavy workflows, not a bottleneck established by this
synthetic small-document run.

No send debounce, throttle, or multi-op batching was found. Dispatch publishes
optimistic local state synchronously, schedules the send pump on a microtask,
and the pump permits one POST at a time. This is good for isolated edits, but a
burst faster than POST completion queues behind the in-flight head. A normal
node drag does not generate document ops on every pointer move: presence carries
the in-progress ghost and one `node.move` commits on release. The repeated-move
scenario below therefore represents successive committed moves, not one drag's
pointer events.

## Method

The manual, disabled-by-default probe is
`packages/e2e/bench/op-sync-latency.mjs`. It is not referenced by package test
scripts or CI. It:

1. Opened two isolated headless Chromium browser contexts against the already
   running frontend on `http://127.0.0.1:5199`.
2. Created and later deleted a unique `scope=shared` collab session on the
   already running backend at `http://127.0.0.1:8765`. Neither service was
   restarted.
3. Connected a real `SharedDocumentSession` and `CollabHttpConnection` in each
   context. Both contexts used `performance.timeOrigin + performance.now()`,
   placing their stamps on Chromium's common epoch-based high-resolution
   timeline without a server timestamp.
4. Stamped sender dispatch, POST start, POST resolve, receiver op event after
   WS JSON shaping, receiver document-subscriber entry after safe apply and
   store reconstruction, scene-build completion, and the next animation frame.
   The receiver used the real `buildScene` and `CanvasRenderer`; its renderer
   loop was registered before the measurement rAF, so the final stamp follows
   the renderer's dirty frame callback.
5. Ran 40 isolated samples for each scenario. Each dispatch waited a random
   0-20 ms after the previous post-render rAF to avoid phase-locking to the
   receiver's frame cadence. The paste was undone after each measured sample,
   keeping the graph baseline at one node; cleanup ops were not included.
   Percentiles use linear interpolation over sorted observations.

Command used:

```text
DINKSTER_FRONTEND_SOURCE_ROOT=/home/kosin/comfy-vibe-station/pr-tracker/stations/station11/Dinkster-Frontend \
DINKSTER_OP_SYNC_SAMPLES=40 \
pnpm --filter @dinkster/e2e exec node bench/op-sync-latency.mjs
```

The already-running Vite process served the canonical sibling checkout rather
than this delegate worktree. Before measurement, the shared-session, collab
connection, renderer, and CanvasHost source files were byte-compared and were
identical between the served checkout and this worktree.

## Results

All latency values are milliseconds. Size and patch-entry columns describe the
client op envelope before the POST.

| Scenario (40 samples) | JSON body bytes p50/p95 | Patch entries p50/p95 | Dispatch -> postOp entry p50/p95 | postOp entry -> remote WS op event p50/p95 | POST round trip p50/p95 | WS event -> document publication p50/p95 | Publication -> scene ready p50/p95 | Scene ready -> post-render rAF p50/p95 | Dispatch -> post-render rAF p50/p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Single widget edit | 204 / 204 | 1 / 1 | 0.1 / 0.3 | 2 / 2.81 | 2.1 / 3.01 | 0.1 / 0.2 | 0 / 0.1 | 9.25 / 16.01 | 12.15 / 18.4 |
| Successive node moves | 212 / 212 | 1 / 1 | 0.1 / 0.2 | 2.4 / 2.81 | 2.45 / 2.81 | 0.1 / 0.2 | 0 / 0.1 | 9 / 15.52 | 11.85 / 18.41 |
| 20-node atomic paste, fixed one-node baseline | 7121 / 7141 | 60 / 60 | 0.4 / 1.31 | 17.2 / 38.51 | 18 / 42.58 | 0.4 / 0.83 | 0.1 / 0.4 | 9.15 / 15.11 | 25.2 / 47.46 |

`postOp entry -> remote WS op event` includes request serialization, local HTTP
transport, backend receive/order/fanout, browser WS delivery, and JSON shaping.
Server-side receive-to-fanout instrumentation was intentionally not requested,
per the paused direction. `POST round trip` is reported independently because
the WS fanout can reach the receiver before the sender finishes consuming the
HTTP response. Every percentile is calculated independently and stage
percentiles are not additive.

## Where the time lives

### Small ops: next-frame scheduling dominates

The session executes the command and publishes optimistic local state before
sending. `pump()` starts through `Promise.resolve().then(...)`; there is no
timer or coalescing window. Dispatch-to-postOp-entry was at most 0.3 ms p95 for
the small ops in the isolated runs. The receiver's op event synchronously
validates the envelope, applies the patch, checks whole-document invariants,
rebuilds the session store, and publishes its document. Subscriber entry
followed the WS event by at most 0.2 ms p95 for one-entry patches on this tiny
document.

The renderer is a continuously scheduled rAF loop with a dirty bit. Scene
replacement invalidates it, so an op that arrives just after a frame naturally
waits nearly one frame. The scene-to-post-render-rAF p95 was 15.52-16.01 ms and
was the largest measured small-op segment. This is expected frame alignment,
not a 66 ms collaboration throttle; the 66 ms throttle belongs only to
ephemeral presence.

### Large ops: the combined POST-to-WS interval dominates this fixed-baseline run

The 60-entry paste exposed two material distributions:

- postOp-entry-to-frame rose to 17.2 / 38.51 ms. Client-only timestamps cannot
  split HTTP upload, backend order/fanout, WS delivery, and JSON parsing; the
  increase is consistent with the roughly 35x larger envelope and the backend's
  known patch-proportional fanout. No backend change is needed to establish the
  frontend result.
- Scene-ready-to-post-render-rAF measured 9.15 / 15.11 ms, reflecting frame
  alignment plus synchronous renderer work before the stamp.

The frontend apply path was not dominant on this fixed one-node baseline:
WS-event-to-document-publication was 0.4 / 0.83 ms. Foreign ingress still
owns/freezes the untrusted patch, immutably applies every entry, runs the full
document invariant checker, and calls `rebase()`, which constructs a new
`DocumentStore`. Those whole-document costs need a large-document follow-up;
this run does not attribute the 47.46 ms end-to-end p95 to them.

### Every remote op causes a full active-scene rebuild

`SharedDocumentSession.rebase()` emits one document signal after each accepted
foreign op. `CanvasHost` converts any document signal to `docTick`, and its
scene effect runs `buildScene` over the complete active graph, replaces the
renderer scene, reprojects presence and overlays, recomputes diagnostics, and
prunes interaction state. The canvas then redraws the complete scene in its
dirty rAF loop. There is no op-aware incremental scene update.

The probe deliberately used unresolved synthetic nodes so it could isolate the
shared pipeline without loading a backend schema catalog. Its sub-1 ms scene
build result is therefore a lower bound, not proof that full rebuilding is
cheap for a large real workflow. Existing 1200-node performance coverage is the
right baseline for that separate cost; this investigation did not overwrite
`docs/perf.md` because it changed no renderer or document behavior.

## Follow-up slices

1. **Profile safe remote apply for large patches.** Add temporary client-side
   marks around envelope validation, `ownJson`/`applyOps`, `checkDocument`, and
   `rebase` on 20/100/500-node pastes into 1k-node documents. If store
   reconstruction is material, evaluate reducing or avoiding that work on the
   no-pending path while preserving the invariant and untrusted-ingress gates.
2. **Measure full CanvasHost amplification with real schemas.** Extend the
   manual probe to drive the actual shared app tab and add disabled user-timing
   marks at document publication, scene-effect completion, and renderer
   draw completion. Use the standard 1200-node fixture and compare one-entry
   edits with large pastes. This will decide whether incremental scene
   projection is warranted; do not implement an incremental renderer solely
   from the lower bound in this report.
3. **Stress the serial send queue separately.** Dispatch at controlled 16 ms,
   8 ms, and burst cadences while recording pending depth and dispatch-to-POST
   start. Keep one-op-at-a-time ordering unless evidence shows ordinary UI
   actions outrun the local POST. Do not debounce semantic ops without first
   specifying undo, conflict, and stale-base behavior.
4. **Track a user-facing budget.** Once the full-app marks exist, choose budgets
   from randomized-phase runs over representative document sizes. Keep the
   manual live-backend probe opt-in so shared infrastructure does not make
   normal CI flaky.

## Limitations

- These are same-machine, headless Chromium numbers. They characterize the
  frontend and local-service floor, not internet RTT or remote deployment load.
- The final timestamp is the next rAF callback after the real renderer's dirty
  callback. It proves synchronous canvas draw completion before that callback,
  not browser paint/compositing or display presentation.
- The receiver used the real scene builder and canvas renderer but not the full
  Solid `CanvasHost` effect or real node schemas. The report treats scene cost
  as a lower bound and bases the full-rebuild finding on code inspection.
- Samples isolated one measured op at a time and intentionally excluded queue
  saturation, reconnect/catch-up, stale-base conflicts, checkpoint publication,
  and simultaneous local intentions on the receiver.
