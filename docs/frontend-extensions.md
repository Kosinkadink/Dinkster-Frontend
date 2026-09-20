# Frontend extensions

Dinkster loads frontend behavior from an immutable backend extension snapshot. A
native schema response names its snapshot with `extensionSnapshotDigest`; the
client verifies the digest and publishes the schema registry and snapshot
together. A mixed pair is never committed.

## Declarative host UI

`HostUiContributionV1` is the only extension UI contract. It is a versioned,
function-free JSON tree with four host-rendered nodes: row/column groups, text,
semantic status, and command actions. The closed tone vocabulary is neutral,
accent, success, warning, danger, and info. Actions contain a registered
command id and optional JSON payload, never a callback.

`HostUiProviderV1` receives a host-created, cloned, recursively frozen context
for one of `status`, `widget-editor`, or `preview-viewer`. The initial extension
slot is only `status.trailing`. The host catches provider failures, strictly
decodes and clones output, reports diagnostics, and renders local error UI.
Extensions cannot supply elements, tags, class names, CSS, URLs, Canvas
objects, stores, sockets, lifecycle hooks, or network handles.

Packs register host UI through positional metadata:
`hostUi(id, slot, provider, order?, title?)`. There is no extension-owned
registration record. The host constructs and freezes its own record before
publication. Contribution trees and provider context JSON reject Proxy wrappers
at every object and array boundary after the descriptor-safe structural walk.

Trees reject unknown keys, non-plain objects, aliases, cycles, non-JSON values,
duplicate keys, malformed command ids, and values outside the exported depth,
node, child, string, id, and payload-byte limits. Host renderers own markup,
ARIA behavior, semantic classes, command lookup, and invocation-time enabled
checks. Core status uses the same tree and renderer.

The application shell owns `status.trailing` placement inside the status
landmark's ordered Tasks and notifications group. Contributions can provide
only their declarative tree; they cannot alter status-bar layout, responsive
overflow, focus order, semantic tokens, or host ARIA relationships.
On desktop, status column groups flow inline when space permits, preserving
the compact footer instead of reserving stacked rows above the canvas.
The inline rule applies above 520 CSS pixels, complementing the narrow
breakpoint even at fractional viewport widths. It uses `not all and
(max-width: 520px)` rather than requiring media range-syntax support.
At narrow widths, footer groups and text wrap within the viewport. Multiline
contributions retain their content without overlapping core connection,
schema, or backend status; footer actions remain keyboard reachable.

Widget and preview code receives only its scoped client capability through
`WidgetEnv`; raw theme or token objects are not part of the extension contract.
Pack-defined schema widget descriptors retain their declared type and JSON
parameters for `widgetKind` lookup. An active matching kind supplies its normal
compact view and editor. Without one, the node remains usable through the raw
value editor and Problems names the unavailable kind.

Host contributions remain manifest-first and independently gateable.
Registration is transactional: activation or identity failure rolls back the
whole batch, unregisters admitted contributions in reverse order, aborts the
pack, and runs extension resource disposers in LIFO order. A declarative UI
tree owns no renderer resource and therefore has no UI cleanup callback.
The Extensions panel reads the same host transaction and gate snapshot. It
groups contributions under packs and categories, shows complete identities,
and states configured user gates separately from actual registry activity.
Long identifiers and contribution labels use single-line ellipses with their
complete text available in native titles rather than splitting words.
Policy blocks include the matching deny rule or unmatched allow scope. Failed
activation remains visible with bounded diagnostics but has no live
contributions; unregistering the failed presentation returns the panel to its
empty state.
The panel title, guidance, control labels, accessible wrappers, host-derived
state labels, and empty or diagnostic headings follow the active application
locale without changing mounted pack controls or gates. Manifest and
contribution names and identifiers, category identifiers, deployment policy
reasons, and diagnostic severity, code, and message remain extension or
runtime data and are displayed verbatim.
Each live provider owns a distinct app-scoped Problems snapshot. Its current
bounded failure replaces that snapshot, while recovery or removal clears it;
one provider cannot replace another provider's, a tab's, or global diagnostics.

## Search providers

Packs declare the `searchProvider` category and register a provider whose id
matches the manifest contribution id. The provider label defines its host
group, priority defines group order, and an optional single-character prefix
participates in normal search routing. Per-contribution, category, pack, and
deployment gates register and unregister the provider from the same
`SearchRegistry` used by core providers. Initial activation remains
transactional, including search-registry change publication. Gate changes,
pack removal, and whole-host disposal reconcile every affected provider in one
registry batch, so an open session observes only the final provider set and
never invokes a sibling after its pack becomes disabled. Nested batches track
their own staged changes separately from committed reentrant changes, including
cleanup that closes another pack's gate while an outer activation rolls back.

The host calls providers with only a frozen `SearchContext`: active-tab
identity, selected node ids, and the request `AbortSignal`. It never passes
DOM, CSS, theme, app-store, socket, network-client, or Canvas handles. Returned
results are copied, frozen, size-bounded, and strictly decoded as text,
keywords, scores, typed actions, and optional versioned detail previews.
Unknown fields, functions, class instances, accessors, hostile reflection,
duplicate result ids, and malformed actions or previews fail that provider
group. Host actions are a closed union for command lookup, settings focus, tab
activation, and node placement; each exact string parameter shape is decoded
before any recency, modal, tab, Canvas, or document effect.

Preview descriptors contain only a title, description, and label/value fields.
The Universal Search host owns the preview markup, semantic tokens, layout,
overflow, focus relationships, and ARIA. Provider errors remain isolated to
their host-rendered group, and gate or pack removal reruns an open session
without stale results.

## Snapshot boundary

The v1 backend snapshot optionally carries `frontend` module declarations and
`events` payload schemas on each extension. Snapshots without these fields
remain supported. The browser never discovers packs or upgrades their code.
Only declared `/api/extension-assets/{pack}/{sha256:hex}/{entry}.js` URLs are
loaded through the connection's same-origin proxy. The loader requires an
immutable JavaScript response and verifies its SHA-256 before importing it.
Bundles must be self-contained and export `frontendExtension.activate(context)`.

Each connection/snapshot pair owns a child of the existing transactional host.
The focused tab selects global shell contributions. Every visible pane resolves
widget kinds, views, validation, and preview renderers from its own tab's world,
including core fallbacks. Frozen panes keep their compiled world's presentation
beside live panes on a newer snapshot. Switching focus does not rerun activation.
Unreferenced worlds abort pending loads and dispose registrations and resources;
in-flight and retained execution worlds remain available. Missing or rejected
frontend code leaves native schemas, generic widgets, and execution available.

Queueing leases the exact compile-time world before source uploads or submission
awaits. A successful response transfers retention to the registered execution.
Asset consent keeps the lease across retry stages, releasing it on rejection,
cancellation, replacement, or tab cleanup. Dismissing an already-posted retry
does not discard its eventual run; its lease lasts until that response settles.
App disposal releases all submission leases and prevents late run installation.

The four privileges are independent: `schema-widget`, `graph-editor-canvas`,
`app-workflow`, and `event-consumer`. Backend grants, local deployment
restrictions, and initial user gates are checked before imports. The frozen
activation context exposes identity, exact declarations and grants, scoped
registration methods, an abort signal, and `onDispose`. It exposes no app store,
DOM, canvas, socket, route client, or legacy pack APIs. Declaration or activation
failure rolls back every admitted entry in the pack. Entry activation is
synchronous; asynchronous work belongs behind registered callbacks.

Contribution toggles remove and restore already-loaded registrations. An entry
excluded before import needs a page reload after its gate is enabled. Evaluated
ES modules cannot be unloaded; these are trusted installed bundles with a
restricted host API, not a JavaScript security sandbox.

## Own-pack routes and presentation

`context.queryRoute(id, request?)` requires `app-workflow` and an enabled
app contribution. It can call only that pack's snapshot-declared `routes`.
The host selects the declared method, validates closed scalar request and
response schemas and the 65536-byte JSON budget, and returns frozen data.
GET takes no arguments; POST sends JSON. The module receives no URL, fetch,
socket, authorization header, or route handler reference.

Requests carry `If-Match: sha256:hex`. The backend must reject a stale world
before dispatch and echo `X-Dinkster-Extension-Snapshot` on success; the host
rejects a missing or different digest. Pending requests abort on transaction
rollback, pack removal, or world disposal. Requests do not begin until the
synchronous activation transaction has committed.

An `app-workflow` entry can call `context.invalidateHostUi(id)` to refresh its
own declared, enabled host UI. Inactive worlds and disposed instances cannot
refresh another world's presentation. An `event-consumer` grant alone permits
neither route queries nor presentation invalidation.

The first-party video-preview module renders policy defaults/limits from
`preview-policy` and the latest node's fps, frame count, width, and height from
`video-preview.initialized`. It identifies the connection/snapshot, warns when
the video exceeds the declared preview policy, and shows a generic fallback
when policy data is unavailable. Its UI and event consumer are separate gates.

## Custom JSON events

An `eventConsumer` declaration names one snapshot-authorized producer event.
Its module registers `context.eventConsumer(contributionId, callback)`. The
native normalizer validates `node_event` against the job's snapshot digest,
producer pack, `schemaVersion: 1`, nonnegative sequence, and closed required
scalar payload fields (`string`, `integer`, `number`, `boolean`). Payloads are
limited to 65536 encoded bytes. Binary extension payloads are not supported.
Unknown envelope fields are tolerated; undeclared, wrong-owner, wrong-version,
or malformed events never reach a consumer.

Reconnect invalidation clears all prior server-lifetime snapshot authority,
including custom-event declarations. An in-flight old-lifetime schema fetch
cannot restore it; only a current-generation paired fetch reauthorizes events.

Callbacks receive immutable typed data with connection/job identity, snapshot
digest, producer pack, event name, sequence, and optional runtime node, worker,
and execution arm. Delivery is execution-scoped advisory telemetry, with an
asynchronous 64-event drop-oldest queue per consumer. Failures are isolated;
closing a gate cancels queued delivery. Core lifecycle/progress/preview events
keep their existing path; a general core-event subscription API is not exposed.
