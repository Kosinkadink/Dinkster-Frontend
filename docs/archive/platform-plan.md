# Platform Plan: Cloud Scale, Modularity, Collaboration, Alternative Views

Status: joint plan, agreed with the Dinkster backend. Backend-side contracts are
pinned in Dinkster ROADMAP.md ("Cloud scaling seams", "Identity, tenancy, auth")
and DESIGN.md section 6 as of Dinkster commit f66a916. Frontend-side workstreams
live here; per-feature docs land under docs/ as each ships.

The goal, stated by the user: Dinkster must be an upgrade on ComfyUI's weaknesses
in all ways while taking its strengths to their natural conclusions. ComfyUI's
two fatal structural weaknesses were (1) neither backend nor frontend ever
accounting for cloud/service deployment, and (2) a frontend stack so coupled
(litegraph) that surfaces cannot move, extensions require monkey-patching, and
product iteration is borderline impossible. Everything below exists to make
those two failures impossible here by construction.

---

## 1. Joint contracts (pinned with the backend, Dinkster f66a916)

These are wire/architecture contracts both sides build toward. None require
immediate frontend work beyond not violating them; each names its trigger.

### 1.1 Ports

Bare engine (dinkster-serve) and single-engine supervisor default to **3639**;
station management port defaults to **3649**. One number means "a Dinkster engine
surface" whether bare or supervised. 8188/8189/8199 (ComfyUI, comfy-runner)
are avoided deliberately. The shared dev server on :8765 passes --port
explicitly and is unaffected.

### 1.2 Stateless ingress (cloud seam)

The supervisor proxy is and stays stateless: catch-all forward, WS pump, no
cookies, no affinity. Pinned invariant. Known fleet gaps, honestly assessed
and deferred with triggers on the backend roadmap:

- /api/events gains per-job monotonic sequence numbers + a reconnect cursor
  when a fleet tier lands; the WS stays additive delivery, never authoritative
  state. Frontend rule now: treat the event stream as lossy/replayable, never
  as the source of truth for terminal job state (fetch state on reconnect).
- Job ownership moves to control-plane storage (jobRef -> engine lease) so
  status/cancel route by lookup, not connection affinity.
- Control-plane reads (nodes/templates/catalog) are stateless and cacheable;
  any replica can serve them.

### 1.3 Job identity

Today: client-supplied (clientId, jobId), scoped to one engine. Pinned fleet
contract: submit RETURNS a server-assigned globally unique jobRef (ULID-shaped
run_id promoted); the client pair demotes to an idempotency key (duplicate
submit with the same pair returns the same jobRef); retries/migrations carry
an explicit attemptId; status/cancel/history resolve by jobRef with authz on
every lookup. Frontend keeps sending (clientId, jobId) unchanged and starts
storing the returned jobRef when it appears. ExecutionRef stays
(connectionId, prompt) locally; jobRef slots in as the server-side identity
without disturbing it.

Status: backend shipped jobRef (Dinkster 258382e) on submit 202 / job status /
job_state / history, with runId as a same-value legacy alias (a rerun of the
same client pair mints a NEW jobRef). Frontend decode-side landed:
`SubmitResult.jobRef` is parsed from the 202 body (optional, tolerant of
pre-jobRef servers) and `HistoryRunRecord.jobRef` is admitted. The
idempotency-key demotion, attemptId, and global-jobRef resolution routes
remain deferred to the fleet tier on both sides.

### 1.4 Auth / RBAC (sketch pinned, not built)

- Every request/job carries an explicit execution context (principal,
  workspace/tenant, capability set). No ambient current-user singleton
  anywhere - backend engine, workers, OR frontend connection layer.
- Asset authorization is per asset REFERENCE; CAS digests keep deduplicating
  physically but a digest is never an authorization token.
- Asset scopes: private / workspace-shared / explicitly published.
- Queue admission and quotas key by (tenant, principal, resource class).
- Frontend rule now: the connection layer must be able to attach an auth
  context to every request kind (HTTP + WS) without per-callsite changes;
  new code never assumes anonymous access is the only mode.

### 1.5 Collaboration protocol (envelope pinned, service later)

Session authority is backend-side (a separate dinkster-collab-shaped package
mounting thin routes on dinkster-server; beside the engine, never braided into
the job queue; extractable to its own process without a wire change).
Frontend-peer sync is rejected: RBAC needs a server authority.

Pinned patch envelope: protocolVersion, sessionId (tenant/workspace/document
scoped, opaque), opId (globally unique, idempotent), actorId, baseRevision,
server-assigned revision, forward JSON Patch, timestamp. Inverse patches stay
client-local for undo. v1 concurrency: server-ordered optimistic
(reject/rebase stale bases); protocol versioned so OT/CRDT can replace
ordering later without a new surface. Presence: ephemeral, separately
rate-limited, never persisted. Hard rule both sides: execution consumes
immutable document snapshots, never live session state.

Our command/patch substrate (packages/core/src/commands: serializable
invocations, forward/inverse JSON patches, revisions) maps 1:1 onto this
envelope. That is not an accident; keep it true (see 2.3).

### 1.6 Schema wire version negotiation

Mechanism pinned now, strictness kept in practice:

- ?wire= on /api/nodes is the canonical negotiation: client advertises
  supported versions, server answers with exactly ONE version it can encode,
  or a loud 406. Never a silent downgrade; a node inexpressible at the
  negotiated version is marked unavailable, not stripped.
- Station/ingress exposes per-engine wire versions in the catalog rather than
  flattening a mixed fleet to a guess.
- Neither side builds downgrade encoders or a multi-version decode window
  until a real mixed-version fleet exists; strict single-version stays the
  default posture. /api/nodes already carries dinkster.schemaWire, so mismatch
  is detectable before decode.
- Document/job protocol versioning stays separate from node-schema wire
  versioning; never couple them.

Status: backend shipped ?wire= (Dinkster 3a858e5, live on the shared server):
comma-separated integers; a satisfiable set answers the normal table, an
unsatisfiable one answers 406 {"error": "wire-version-unsupported",
requested, supported}; malformed values are 400. Frontend adopted it:
fetchSchemas advertises `DINKSTER_ACCEPTED_WIRE_VERSIONS` (3,4,5,6,10,11,12,13,14
as of wire v14 - the decoder's exact accept set, source of truth in
core/src/schema/dinkster-wire.ts) and maps the 406 into a "schema wire version
mismatch" error naming both sides' versions. Downgrade encoders and
per-engine catalog exposure stay deferred to the fleet trigger.

---

## 2. Frontend workstreams

### 2.1 Surface system: placement is a property, not a location

Current state (audited): App.tsx composes every shell surface as hardcoded
JSX; the dock is a closed union ('library' | 'logs' | 'backends'); several
substantial surfaces (node search, widget editors, minimap, lens/seed menus,
asset browser placement) live inside CanvasHost. Surfaces cannot move because
they have no identity.

Plan: a surface registry. Every surface registers a descriptor:

- id, title, icon
- component factory with a narrow, explicit props contract (never
  `app: AppState` wholesale)
- allowed placements: dock | rail | modal | floating | window
- default placement + default size

The shell renders from the registry plus a layout configuration. WE move
surfaces by editing one descriptor field (the user does not need to; the
capability is for product iteration). A future desktop app maps the `window`
placement to a real OS window over the same descriptors. docs/shell.md's
dock-vs-modal rule becomes a descriptor property instead of prose.

The extension manifest (packages/core/src/extensions/manifest.ts) gains a
`panel` contribution category, gated exactly like widgets/menus/commands.

### 2.2 CanvasHost decomposition

CanvasHost.tsx is ~4,700 lines coupling scene building, gesture-to-command
translation, and a dozen embedded surfaces to the whole AppState, even though
packages/canvas itself is framework-free and reusable. Rolling extraction,
one surface at a time, no big-bang rewrite:

1. Embedded surfaces (search palette, widget editors, minimap, lens/seed
   menus) move to registry surfaces (2.1) with explicit props.
2. What remains splits into: scene building (document + schemas -> scene),
   interaction adaptation (controller gestures -> dispatched commands), and a
   thin mount.
3. Target contract: `<Canvas session document registry dispatch>` - a
   component any view can embed or omit.

### 2.3 DocumentSession seam (multiplayer readiness)

Wrap DocumentStore behind a `DocumentSession` interface now, with `local` as
the only implementation. The future `shared` implementation speaks the pinned
envelope from 1.5 (server-ordered revisions, client rebase on stale base,
inverse patches staying local for undo). No CRDT; the linear-history model we
already have is the design target.

Rules enforced from now on:

- No new code assumes single-writer document access outside the session
  interface.
- Commands stay serializable and deterministic; patches stay JSON-safe and
  invertible. Anything that breaks this breaks the collab mapping and is a
  contract bug.

Status: the seam is in. `DocumentSession` (core/src/commands/session.ts)
extends the store contract with the reactive document view, a stable
actorId, and an envelope-shaped op feed (opId, actorId, baseRevision,
revision, forward patch, timestamp, origin) emitted for every committed
dispatch/undo/redo; `toWirePatch` strips local-only fields (oldValue) into
the exact collab wire shape. Backend shipped the matching document-session
surface v1 (Dinkster ae67663 + ca01157, live on the shared server): segment-
array paths as decided in our favor, POST /api/sessions{,/{id}/ops},
op replay with ?after=, snapshot checkpointing, WS descriptor+op feed;
server-ordered optimistic concurrency with 409 stale-base. Tab.store is now
typed as DocumentSession (local implementation only); the `shared`
implementation targeting those routes is the remaining half, deferred until
the collab UX slice.

### 2.4 Exposed parameters + alternative views

Alternative views (form-style "app view"; an asset-centric editor that drives
workflows under the hood, opening Dinkster to users who prefer auto1111-style
interfaces) are different surfaces over the SAME substrate: document +
commands + execution store + schema registry. The architecture already keeps
element identities stable for this (architecture.md "App-mode-ready").

Two enablers:

- **Exposed parameters**: a declared subset of inputs/widgets promoted as the
  document's public controls - a namespaced section in WorkflowDocument (the
  format already has namespaced extension escape hatches). This is what turns
  any workflow into an app. Document data, not a separate app-manifest
  format.
- **View registration**: a view is a surface claiming the center slot,
  registered through 2.1.

Proof-of-substrate: a thin app view rendering exposed parameters as a form,
queueing through the same execution path, zero canvas imports. It doubles as
the test that 2.1-2.3 actually decoupled things.

Status: shipped (docs/app-view.md). Exposed parameters live under the root
ext escape hatch `doc.ext['dinkster.exposed']` with (graphId, nodeId,
elaborated inputId) identity and go through serializable `params.*`
commands (expose/unexpose/setLabel/move; whole-list canonical writes,
tolerant reads, stale entries render inert with a remove affordance). The
app view is the first non-graph editor kind (`app`) registered through the
2.1 EditorRegistry: same DocumentSession, same `node.setValue` writes, same
queue path, zero `@dinkster/canvas` imports. Tabs persist (document,
editorKind) and switch projections without replacing the session; registry
command shortcuts moved to a shell-level dispatcher so they work under any
editor kind. Inline control coverage v1 (INT/FLOAT/STRING/BOOLEAN/static
COMBO; the rest read-only) is ledgered in docs/promises.md.

### 2.5 Unified connection model

Already planned (see the backend-connectivity investigation): URL-only add
with protocol discovery (/supervisor/status -> /api/nodes -> /object_info),
backend persistence, same-origin native probe as default, station groups
(management port enumerates installs; each install port is a normal
connection), v1-ComfyUI demoted to a badged legacy bridge. Cloud extends this
for free: a cloud deployment is a connection whose URL fronts an ingress tier
instead of one engine (1.2 keeps that transparent), with the auth context
from 1.4 attached at the connection layer.

---

## 3. Sequencing

1. Surface registry + shell migration (2.1) - unblocks everything else and
   fixes standing shell complaints as a consequence.
2. Connection model foundation (2.5): persistence + discovery probe + default
   backend; station groups after.
3. CanvasHost extraction (2.2) - rolling, alongside other work.
4. DocumentSession seam (2.3) - local-only, cheap once 2.2 gives commands a
   single throat.
5. Exposed parameters + app-view prototype (2.4).
6. Joint items as triggers fire: jobRef adoption when submit returns it,
   ?wire= when a second wire version exists, event cursors when the fleet
   tier lands, collab transport when the backend surface exists.

## 4. Standing rules distilled (both sides)

- Ingress stays stateless; the event stream is additive, never authoritative.
- No ambient identity anywhere; execution context is explicit.
- A digest is identity, never authorization.
- Execution consumes snapshots, never live session state.
- Commands are the only document write path; they stay serializable,
  deterministic, and invertible.
- Surfaces have identity and declared placements; nothing composes into the
  shell by hardcoding.
- Registries over switches; manifest-gated contribution over reachable
  internals. Monkey-patching stays impossible by construction.
