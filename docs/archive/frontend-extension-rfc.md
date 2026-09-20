# Dinkster Frontend Extension RFC

## Adoption record (frontend coordinator, 2026-07-28)

ADOPTED as the frontend extension program of record, verbatim from the
inference thread's S14 draft (source: /home/kosin/node-analysis/
FRONTEND-EXTENSION-RFC.md; backend counterpart: Dinkster docs/extension-design.md
at 2fac69c). Adoption terms pinned by the frontend coordinator
(T-019f9e58-7a96-7412-89f1-3bb237db21d9):

1. All five headline recommendations are ACCEPTED: snapshot-driven loading
   only; per-connection/per-snapshot extension worlds; separate declarative
   OverlayScene (no raw canvas or concrete Scene in v1); framework-neutral
   declarative host UI (Solid is not extension ABI); structured-clone/RPC-
   shaped contexts with same-realm as authorization-only.
2. Open questions Q1-Q14: every [RECOMMENDATION, VETOABLE] is ACCEPTED as
   written, with these frontend pins sharpening Q1 and section 4.2:
   - Q1 transport PIN: two endpoints. The schema table response gains an
     additive extensionSnapshotDigest field (tolerated-unknown for old
     clients, consistent with the wire-15 additive-tolerance contract);
     the effective snapshot is a separate fetch verified against that
     digest; on mismatch the client refetches both atomically and never
     mixes epochs. Rationale: schema refetch is frequent (epoch pings),
     snapshots change rarely; do not fatten /api/nodes.
   - frontendApi negotiation PIN: the snapshot declares the host-relevant
     frontendApi version; the CLIENT enforces pack ranges before importing
     any module bytes. Failure is per-pack fail-closed with a loud
     diagnostic (compatSkips precedent), never a whole-connection refusal:
     wire/schema negotiation (?wire= + 406) and frontendApi gating are
     deliberately different mechanisms with different blast radii.
3. The conflicts table (section 16) is verified against the code as of
   frontend main cab0dd2 - notably ExtensionHost's documented partial-
   survival on activation throw (packages/core/src/extensions/host.ts
   register() docstring) conflicts with all-or-none activation and WILL be
   changed in place, and the global ExtensionHost/widget registry in
   AppState moves to per-connection/snapshot child worlds. Section 21's
   closing rule is affirmed: implementation updates the existing host and
   registries in place; no second parallel extension system.
4. Line-number citations are evidence of the checked claim at draft time,
   not a live contract; the cited BEHAVIOR is the record. Files under
   active development (app-state.ts especially) drift daily.
5. Sequencing: the F0+ implementation slices are queued BEHIND the wire-15
   materialization/lowering program and the in-flight batch; F0 must not
   race the AppState/registry surfaces that program touches. S0-B
   (backend per-execution snapshot pinning) may land its wire shape per
   the Q1/negotiation pins above without waiting for F0.

The remainder of this document is the adopted RFC text, unmodified.


Status: Draft for review

Date: 2026-07-28

Owner: S14 frontend half of `DINKSTER-EXTENSION-DESIGN.md`

This RFC defines the frontend half of Dinkster's extension architecture. It is a
clean-break API for Dinkster-Frontend. It is not a compatibility layer for
ComfyUI's LiteGraph objects, `app.registerExtension`, private module URLs, or
prototype patching.

Normative terms such as MUST, SHOULD, and MAY are used in their usual RFC
sense. Items marked `[RECOMMENDATION, VETOABLE]` are this RFC's recommendation,
not a decision inherited from the accepted overall design.

## 1. Source notation and evidence

References use these roots:

- `DESIGN` means `/home/kosin/node-analysis/DINKSTER-EXTENSION-DESIGN.md`.
- `R08` means `/home/kosin/node-analysis/dives/report-08-frontend-server.md`.
- `DF` means
  `/home/kosin/comfy-vibe-station/pr-tracker/stations/station9/Dinkster-Frontend`.

The ecosystem survey found that 341 packs, representing 54.9% of
usage-weighted installs, ship frontend JavaScript. The active spread includes
`registerExtension`, node-definition hooks, API clients, canvas hooks, menus,
settings, and custom widgets (`AGGREGATE.md:59-65`). This is not a niche
compatibility surface.

The detailed pack evidence divides the missing host surface into widget,
canvas, app, and event/push seams (`dives/report-08-frontend-server.md:356-392`).
Those four groups match the separately authorized privileges accepted by P8:
schema/widget, graph-editor/canvas, app/workflow, and server/event producer
access (`DINKSTER-EXTENSION-DESIGN.md:86-92`). On the frontend, the fourth
privilege is the consumer half of server/event producer access.

The frontend is already intentionally split into framework-free core,
transport, widget, and canvas packages plus a SolidJS shell
(`Dinkster-Frontend/README.md:8-20`). This RFC preserves those package boundaries.

## 2. Decisions inherited from the overall architecture

The following are not reopened here:

1. Every extension point declares one of P1's composition modes. There is no
   implicit last-writer-wins (`DINKSTER-EXTENSION-DESIGN.md:33-46`).
2. Manifest discovery is side-effect free, frontend is a distinct entry-point
   scope, activation is transactional, and execution behavior is pinned to an
   immutable extension snapshot (`DINKSTER-EXTENSION-DESIGN.md:96-109`).
3. Pack identity includes pack id, version, package digest, resolved
   contributions and ordering, service-provider choices, and relevant
   configuration (`DINKSTER-EXTENSION-DESIGN.md:102-107`).
4. The four P8 privileges are separately authorized. Capability checks are
   authorization and audit controls, not sandboxing
   (`DINKSTER-EXTENSION-DESIGN.md:86-92`).
5. Runtime compatibility is a clean break. Existing workflows get an importer;
   old Python and frontend runtime APIs do not get a shim
   (`DINKSTER-EXTENSION-DESIGN.md:256-272`).
6. General binary media channels are later work. The first server/event slice
   is typed JSON, and binary framing follows a concrete media use case
   (`DINKSTER-EXTENSION-DESIGN.md:236-245`).

This RFC adds one frontend-specific invariant:

> A frontend never rediscovers pack code independently. It loads only the
> exact frontend entry points selected by a backend-produced immutable
> extension snapshot, then applies frontend deployment policy and user gates
> only as further restrictions.

## 3. Goals and non-goals

### 3.1 Goals

- Make the supported extension path easier than reaching into app, canvas, or
  transport internals.
- Preserve the existing `@dinkster/core` -> `@dinkster/client` / `@dinkster/widgets` /
  `@dinkster/canvas` -> `@dinkster/app` dependency direction.
- Load frontend code by exact pack identity and correlate it with backend
  schemas, services, events, and execution snapshots.
- Support clean activation, per-contribution gating, deactivation, rollback,
  diagnostics, and eventual isolated execution.
- Cover the concrete behavior demonstrated by VHS, rgthree, Crystools, and
  Workspace Manager without reproducing LiteGraph's mutable object graph.
- Keep documents inspectable when frontend code is absent or denied.

### 3.2 Non-goals

- Running legacy ComfyUI frontend scripts.
- Exposing `AppState`, `CanvasHost`, `CanvasRenderer`, the concrete retained
  `Scene`, raw websocket messages, or private DOM nodes as public API.
- Making arbitrary same-realm JavaScript safe through TypeScript types.
- Allowing widgets to mutate node interfaces, links, or layout directly.
- Supporting arbitrary remote module URLs.
- General binary extension channels in the first implementation slice.

The legacy behaviors are requirements evidence, not API shapes to preserve.
For example, rgthree currently replaces canvas and graph prototypes and relies
on private fields (`dives/report-08-frontend-server.md:34-54,94-101`). The
Dinkster answer is typed render, action, navigation, and transaction seams, not a
better prototype wrapper.

## 4. Terms and identities

### 4.1 Pack, entry point, contribution, and instance

- **Pack identity**: `(packId, version, artifactDigest)`. `packId` is the
  stable logical namespace; version and digest identify installed content.
- **Frontend entry point identity**: `(pack identity, entryPointId,
  moduleDigest)`. One pack may split frontend code across privilege boundaries.
- **Contribution identity**: a stable id beginning with `<packId>.`, such as
  `comfy.videohelpersuite.widget.timeline`.
- **Extension instance identity**: `(connectionId, snapshotDigest, frontend
  entry point identity)`. Activation is per connection and per snapshot even
  if the browser reuses one fetched module namespace.
- **Frontend extension world**: the set of active frontend instances and child
  registries for one backend connection and one immutable snapshot.
- **Activation receipt**: the frontend's record of the snapshot, local policy,
  gates, entry points, contribution ids, and contribution ordering it actually
  activated.

The distinction between logical and instance identity is required by the
existing multi-backend frontend. Each `Backend` already owns its own schema
registry and scoped client (`Dinkster-Frontend/packages/app/src/app-state.ts:675-704`),
and tabs can target different backends. A global pack id is therefore not a
sufficient runtime key.

### 4.2 Frontend API version

Dinkster publishes one coarse SemVer `frontendApi` version:

- A major bump may break stable activation, context, or contribution
  contracts.
- A minor bump is additive.
- Experimental capabilities carry their own explicit capability version, for
  example `canvas.overlayScene@1alpha2`, and do not force a global major bump.
- A pack declares a SemVer range. The host checks it before importing any
  module bytes.

[RECOMMENDATION, VETOABLE] Use one global major range plus individually
versioned experimental capabilities. Capability-only versioning everywhere
would make compatibility resolution and author tooling unnecessarily complex.

`frontendApi` is independent from the Dinkster workflow format, schema wire,
server API, and pack version. A pack may support several frontend API minors
without changing its backend contract.

## 5. Authored manifest

### 5.1 Shape

The overall pack manifest owns id, version, requirements, provided services,
and entry points. Frontend declarations remain JSON data so the host can
inspect and authorize them before code runs. The existing frontend already has
this useful manifest-first property, stable namespaced contribution ids, and a
closed category vocabulary (`Dinkster-Frontend/packages/core/src/extensions/manifest.ts:1-35`).

Illustrative authored manifest:

```json
{
  "id": "comfy.videohelpersuite",
  "version": "2.0.0",
  "requires": {
    "frontendApi": ">=1.0.0 <2.0.0"
  },
  "entryPoints": {
    "frontend": [
      {
        "id": "comfy.videohelpersuite.frontend.widgets",
        "module": "./dist/frontend/widgets.js",
        "privileges": ["schema-widget"],
        "contributions": [
          {
            "id": "comfy.videohelpersuite.widget.path",
            "kind": "widgetKind",
            "label": "VHS path"
          },
          {
            "id": "comfy.videohelpersuite.widget.timelineView",
            "kind": "widgetView",
            "label": "Timeline view"
          },
          {
            "id": "comfy.videohelpersuite.preview.media",
            "kind": "previewRenderer",
            "label": "VHS media preview"
          }
        ]
      },
      {
        "id": "comfy.videohelpersuite.frontend.events",
        "module": "./dist/frontend/events.js",
        "privileges": ["event-consumer"],
        "contributions": [
          {
            "id": "comfy.videohelpersuite.event.latentPreview",
            "kind": "eventConsumer",
            "event": "comfy.videohelpersuite.latent-preview",
            "schema": "./schemas/latent-preview.v1.json",
            "schemaVersion": 1,
            "delivery": "latest-per-key"
          }
        ]
      }
    ]
  }
}
```

Rules:

1. `module` is a package-relative asset path, not a URL. The installer and
   backend resolve it inside the installed artifact.
2. Every entry point and contribution id begins with the pack id. `core` stays
   reserved to the host, matching the existing validator
   (`Dinkster-Frontend/packages/core/src/extensions/manifest.ts:37-90`).
3. Privileges are declared per entry point. Authors SHOULD split unrelated
   privileges so a deployment may load schema/widget code without loading an
   app panel or event consumer.
4. Every contribution is declared before module import and has a closed `kind`.
5. Custom event names and stored extension data use the pack namespace.
6. Dependencies name typed services or contribution contracts, not another
   pack's private module.
7. Module top level MUST only define exports. Registration occurs only inside
   `activate`.

The authored manifest does not self-assert `artifactDigest` or final URLs.
Those are installer/host facts in the effective snapshot.

### 5.2 Initial contribution kinds

Stable v1 candidates:

- `widgetKind`, `widgetView`, `previewRenderer`
- `menu`, `command`, `keybinding`, `setting`
- `canvasLayer`, `nodeDecoration`
- `hostUi`, `searchProvider`, `workflowObserver`
- `eventConsumer`
- `workflowImporter`

Not every candidate has to ship in the first implementation slice. Unknown
kinds are rejected before import. New kinds are additive frontend API changes.

### 5.3 Removed kinds

`linkDecoration`, `canvasTool`, and `workflowGuard` were removed from the
extension vocabulary. Their intended uses, benefits, risks, and criteria for
reconsideration are recorded in
[the removal issue](https://github.com/Kosinkadink/comfy-vibe-station/issues/147).

## 6. Effective backend snapshot and frontend correlation

### 6.1 The backend is the source of truth

The backend resolves installed artifacts, dependencies, service providers,
entry-point assets, contribution order, and deployment authorization into an
immutable snapshot. The frontend MUST NOT scan a `WEB_DIRECTORY`, guess a
static path, import `/scripts/app.js`, or wait for side effects. Workspace
Manager demonstrates why that bootstrap style is fragile: it loads through a
timer, private module URLs, and a direct `document.body` mount
(`dives/report-08-frontend-server.md:168-180,218-223`).

The implemented wire format is `dinkster.extension-snapshot`, version 1. The
snapshot digest is verified over the response bytes and carried separately by
`/api/nodes` as `extensionSnapshotDigest`. Optional frontend/event fields extend
each backend extension row without changing the snapshot version. A frontend
row has this shape (digests abbreviated):

```json
{
  "format": "dinkster.extension-snapshot",
  "version": 1,
  "frontendApi": "1.0.0",
  "extensions": [
    {
      "id": "comfy.videohelpersuite",
      "version": "2.0.0",
      "packageDigest": "sha256:...",
      "contributionIds": [],
      "selectorResolutions": [],
      "serviceProviders": [],
      "capabilities": [],
      "behaviorConfiguration": [],
      "frontend": [
        {
          "id": "comfy.videohelpersuite.frontend.widgets",
          "moduleUrl": "/api/extension-assets/comfy.videohelpersuite/sha256:.../comfy.videohelpersuite.frontend.widgets.js",
          "moduleDigest": "sha256:...",
          "authorizedPrivileges": ["schema-widget"],
          "contributions": [
            {
              "id": "comfy.videohelpersuite.widget.path",
              "kind": "widgetKind"
            }
          ]
        }
      ]
    }
  ]
}
```

The route is `/api/extension-assets/{pack}/{sha256:hex}/{entry}.js`. The browser
requires a same-origin connection proxy, immutable JavaScript responses, and
matching SHA-256 bytes before import. Bundles are self-contained and confined
to the installed pack by the backend. Arbitrary remote URLs are not admitted.

### 6.2 Atomic schema/snapshot pairing

Node schemas and frontend code are one compatibility surface. A schema may
name `widgetType`, custom event, or service metadata whose implementation comes
from the selected frontend entry point. The normalized frontend model already
uses `WidgetSpec.widgetType` as the registry key and keeps kind-specific
options (`Dinkster-Frontend/packages/core/src/schema/model.ts:131-151`). The
legacy schema adapter already preserves explicit `widgetType` plus remaining
options (`Dinkster-Frontend/packages/core/src/schema/object-info.ts:127-168`).

Therefore every schema table response MUST identify the snapshot digest and
schema epoch it belongs to. On a schema-change notification, the client fetches
an atomically paired schema table and snapshot, builds a new extension world
off to the side, then switches both together. If the digests or epochs do not
match, it refetches; it never mixes versions.

The native client treats `schema_changed` as an epoch-based invalidation ping
and commits only digest-verified schema/snapshot pairs. AppState awaits the
child world's activation before publishing the registry, and rechecks the
request generation after loading so a superseded response cannot win.

### 6.3 Per-connection worlds

The application builds child registries per backend connection and snapshot:

```text
core built-in registries
  -> connection A / snapshot X child registries
  -> connection B / snapshot Y child registries
  -> retained snapshot Z registries for an in-flight or frozen execution
```

The active tab selects widget, canvas, menu, service, and event contexts from
its target connection. A frozen execution selects the world named by its
pinned execution snapshot. Host UI providers are instantiated per connection and are
given an explicit connection label/context.

`ExtensionWorld` uses the existing transactional `ExtensionHost`, owns local
registrations, and mounts only the selected world's projection into the shell.
Widget registrations stay local: each visible canvas, App view, and widget editor
resolves through its own tab's live or pinned schema registry, not shell focus.
Conflicting versions on two connections never share registration identities.
Worlds are retained with live schema registries, pending submission leases, and
execution artifacts, then disposed when those references are gone. A queue leases
its compile-time world before any await; consent retains it until cancellation or
the final retry response. Successful submission transfers ownership to the run.
Module loading is cancelled on removal.

Module bytes MAY be fetched or evaluated once when the complete frontend entry
point identity matches, but `activate` still runs once per extension instance
because clients, events, settings scopes, and teardown are connection-scoped.

### 6.4 Execution pinning

Execution submission and all execution events MUST carry or resolve an
`extensionSnapshotDigest`. The client retains the corresponding event decoders,
preview renderers, and presentation contributions while an in-flight
execution or open frozen view references them. A later pack load/unload creates
a new world and does not mutate the old one.

If old frontend assets are unavailable, the execution remains inspectable
through generic event, value, and preview fallbacks. The host diagnoses the
missing presentation; it does not reinterpret old payloads with newer code.

An activation receipt records:

- backend connection and snapshot digest;
- host frontend API version;
- exact pack, artifact, entry-point, and module digests;
- locally denied entry points or contributions;
- committed contribution order and exclusive-provider choices;
- diagnostics.

The backend snapshot is authoritative. Local user and deployment gates may
subtract frontend behavior but may not add unlisted code, replace versions, or
change provider choices. Disabling frontend UI never disables backend nodes;
the existing host already correctly separates frontend gates from schemas
(`Dinkster-Frontend/packages/core/src/extensions/host.ts:1-17`).

The management surface is a read-only projection of that same authority. It
shows pack/category/contribution hierarchy, exact identities, policy cause,
configured gates, committed registry activity, missing contributions, and
transaction diagnostics. A failed activation may remain visible for diagnosis
without becoming a second activation world or retaining any live registry
entry.

## 7. Loading and activation

### 7.1 Package ownership

The implementation fits the existing package graph as follows:

- `@dinkster/core`: serializable manifest/snapshot types, public contribution
  contracts, identities, diagnostics, workflow observers, and activation
  transaction interfaces. It remains DOM- and framework-free.
- `@dinkster/client`: fetches snapshots/assets, checks schema/snapshot pairing,
  normalizes custom events, and exposes connection-scoped clients.
- `@dinkster/widgets`: implements child widget registries and generic fallbacks.
- `@dinkster/canvas`: implements declarative overlay compilation, render phases,
  semantic hit regions, and host-owned hit arbitration.
- `@dinkster/app`: owns authorization UI, dynamic imports, activation worlds,
  Solid shell slot containers, lifecycle dispatch, and teardown orchestration.

Extension code consumes a small public facade, proposed as
`@dinkster/extension-api`, consisting of types plus the activation context passed
by the host. It MUST NOT import `@dinkster/app`, `@dinkster/canvas` internals, or a
second SolidJS runtime. A pack bundle is self-contained except for type-only
imports and the host-provided activation context.

### 7.2 Activation contract

An entry module exports one inert descriptor:

```ts
export const frontendExtension = {
  activate(ctx: FrontendActivationContext): void {
    ctx.widgetKind(
      "comfy.videohelpersuite.widget.path",
      pathWidgetKind
    )
    ctx.onDispose(() => pathCache.dispose())
  }
}
```

The implemented `FrontendActivationContext` contains only:

- immutable extension instance and snapshot identity;
- exact authorized privileges and declared contribution set;
- registration APIs for those declarations;
- own-pack declared-route queries and own-contribution UI invalidation, gated
  by `app-workflow` rather than implied by `event-consumer`;
- `AbortSignal` for activation lifetime;
- `onDispose` for resources not owned by a registry.

Identity contains `connection`, `snapshotDigest`, `pack`, `version`,
`entryPoint`, and `moduleDigest`. Registration methods use the existing
positional `PackActivationApi`, including `eventConsumer(id, callback)`.
Entry activation must be synchronous. `queryRoute(id, request?)` uses only the
owning pack's snapshot `routes`, a fixed GET/POST method, closed scalar JSON
schemas, a 65536-byte budget, and the instance abort signal. GET has no request
fields. `If-Match` pins dispatch to the world digest; the response must echo
`X-Dinkster-Extension-Snapshot`. `invalidateHostUi(id)` refreshes only an owned,
declared and enabled host-rendered contribution. Media/asset capabilities and
a public diagnostics sink are not exposed by this activation contract.

The module cannot contribute an undeclared id, wrong kind, or unauthorized
privilege. The existing host already performs declaration/category/payload-id
checks (`Dinkster-Frontend/packages/core/src/extensions/host.ts:219-278`); the new
loader retains that behavior inside a transaction.

### 7.3 Transactional activation

Activation is staged:

1. Read and validate manifest and effective snapshot without importing code.
2. Apply backend policy, frontend deployment policy, and user gates.
3. Check `frontendApi`, privilege grants, dependencies, module and artifact
   identity.
4. Import all admitted frontend entry points for the pack.
5. Run `activate` against staging registries. Collect registration handles and
   disposers, but expose none to live consumers.
6. Validate required contributions, exclusive-provider selections, ids, and
   ordering.
7. Commit the whole admitted pack atomically, publish one registry revision,
   and emit an activation receipt.
8. On any failure, abort the scope and dispose staged resources in reverse
   order. No contribution becomes visible.

The existing `ExtensionHost` stages payloads, validates every admitted required
contribution, and commits or rolls back the complete pack. The child-world
loader also enforces each entry's own declaration scope, including violations
caught by extension code. Failure presentation remains in the Extensions panel
without live registrations. Future contribution kinds fail closed.

### 7.4 Deactivation and cleanup

Every registration returns an idempotent disposer. The host also gives every
entry point an abort signal and a LIFO disposal stack. Deactivation is:

1. Mark the instance closing and stop new callbacks.
2. Abort async work and event queues.
3. Close active widget editors, host UI surfaces, popovers, and tool modes owned by
   the instance.
4. Unregister contributions in reverse commit order.
5. Run extension-owned disposers in reverse registration order.
6. Remove the child registry world after no view or execution retains it.

Settings values and namespaced workflow data remain stored when UI code is
disabled. They are data, not live resources. Re-enabling reconstructs behavior
from the manifest and document.

ES modules cannot be unloaded from a realm. Deactivation removes behavior but
not evaluated module code. For v1, changing module content, API major, or
snapshot package versions MAY require a page reload even though ordinary
contribution enable/disable uses live teardown. Content-addressed URLs prevent
the ESM cache from confusing two versions.

Entries excluded before import by initial gates require a reload after those
gates are enabled. The module contract is for trusted installed code: the host
does not hand out DOM/canvas/store/socket handles, but an ES module is not a
security sandbox for hostile JavaScript.

## 8. P8 privileges mapped to Dinkster-Frontend

The privileges are orthogonal capability grants, not a ladder where a higher
number automatically includes lower ones.

| Privilege | Public package surface | Allows | Does not allow |
|---|---|---|---|
| `schema-widget` | `@dinkster/core`, `@dinkster/widgets`, canvas widget adapter | Widget kinds, views, preview renderers, pure import migrations, scoped schema metadata reads | Runtime schema mutation, graph edits outside registered commands, raw DOM/canvas/network |
| `graph-editor-canvas` | `@dinkster/core`, `@dinkster/canvas` public contribution facade | Declarative render layers, decorations, semantic hit regions, menus, commands, optional exclusive tools | Raw renderer/scene/controller, prototype patches, arbitrary gesture interception |
| `app-workflow` | `@dinkster/core`, `@dinkster/app` declarative host UI and lifecycle facade | Host-rendered UI trees, workflow observers/guards, settings, commands, storage granted by policy | Elements, styles, `AppState`, arbitrary body selectors, backend filesystem, unrestricted route access |
| `event-consumer` | `@dinkster/core`, `@dinkster/client` event facade | Typed core execution subscriptions and declared custom event subscriptions | Raw websocket, undeclared events, server route access, event production |

The backend's matching fourth privilege authorizes event producers. A custom
event reaches a frontend consumer only when the snapshot resolves an
authorized producer and an authorized declared consumer.

## 9. Extension point matrix

The matrix is normative for composition and teardown. No generic frontend
point uses a delegating wrapper chain in v1. Method wrapping is the failure
mode this API is replacing; a future wrapper point requires a demonstrated
case and an explicit `next(...)` contract.

| Extension point | Package / privilege | P1 composition mode | Callback context | Cleanup contract |
|---|---|---|---|---|
| Widget kind | core/widgets / schema-widget | Keyed registry, exclusive owner per `widgetType` | Immutable `WidgetSpec`, value, validation context | Unregister kind; active editors close; unknown-kind fallback takes over |
| Widget view | core/widgets / schema-widget | Keyed registry by `(kind,id)`; many views coexist | Bounded `SceneBuilder`, immutable value/spec/state, or cloned frozen JSON for declarative expanded UI | Unregister view; host removes declarative output; release scoped media |
| Preview renderer | core/widgets / schema-widget | Exclusive strategy selected by exact channel id; collision diagnosed | Preview frame descriptor, bounded builder, or cloned frozen JSON for declarative expanded UI | Cancel stream, release decoded resources, unregister channel |
| Import migration | core / schema-widget | Keyed registry by source format + legacy node/widget identity | Hostile raw JSON, resolved target schema, diagnostics, pure migration helpers | Unregister adapter; no live resource allowed |
| Canvas render layer | canvas / graph-editor-canvas | Ordered list by fixed phase, snapshot order, contribution id | Immutable `CanvasReadContext`; returns overlay primitives and hit regions | Unregister provider; drop its overlay next scene revision; abort async assets |
| Node decoration | canvas / graph-editor-canvas | Ordered list | Stable node identity, schema, execution projection, tokens | Unregister provider; remove badges/decorations/popovers |
| Link decoration | canvas / graph-editor-canvas | Ordered transform list over host-owned style plus additive overlays | Stable link/end identities, solved type, selection/execution state | Unregister transform; base style resumes |
| Semantic hit action | canvas/core / graph-editor-canvas | Keyed registry by namespaced action id; hit arbitration follows layer order | Semantic target, pointer modifiers, command dispatcher | Unregister action; remove associated regions first |
| Menu contribution | core/app / graph-editor-canvas or app-workflow | Ordered list by anchor/group/order/id | Plain immutable target, selection, document, location, declared selectors | Unregister provider; close an open menu if its item disappears |
| Graph command | core / graph-editor-canvas | Keyed registry; one owner per command id | Validated params, transaction builder constrained by invariants | Unregister command after in-flight transaction completes/cancels |
| Canvas tool | canvas/app / graph-editor-canvas | Exclusive strategy selected by user/host | Tool session, semantic hits, command dispatcher, pointer capture capability | `exit` then dispose; host restores default tool even on exception |
| Host UI contribution | app / app-workflow | Keyed registry for identity; ordered list within a named slot | Cloned frozen JSON context; returns a strictly decoded group/text/status/action tree | Unregister provider; host removes rendered output; no contribution-owned UI lifecycle |
| Search provider | core/app / app-workflow | Keyed registry by contribution id; provider priority then id orders host groups | Frozen active-tab/selection identity and AbortSignal; returns strictly decoded results, actions, and preview data | Unregister provider; active search reruns through provider churn and rejects stale work |
| Workflow lifecycle observer | core/app / app-workflow | Fan-out observer list | Immutable lifecycle event and document/workflow identity | Unsubscribe; queued callbacks dropped on abort |
| Workflow guard | core/app / app-workflow | Ordered guard list; any deny vetoes; no rewriting | Named operation, immutable proposed action, deadline/abort | Unregister; timeout is diagnosed and treated by operation policy |
| Setting definition | app / app-workflow | Keyed registry, exclusive id | Namespaced storage facade and typed definition | Unregister definition; persisted override retained |
| Setting change | app / app-workflow | Fan-out observer list | Own setting id/value and source | Unsubscribe |
| App command/keybinding | app / app-workflow | Keyed registry; key conflicts diagnosed, user arbitration explicit | Named selectors/services only | Unregister command and default keybinding |
| Core execution event | core/client / event-consumer | Fan-out observer list | Typed normalized event, connection/execution/snapshot identity, provenance resolver | Idempotent unsubscribe; host auto-unsubscribes on abort |
| Custom JSON event | core/client / event-consumer | Fan-out observer list after one schema validator | Declared namespaced event, validated payload, optional execution/node correlation | Unsubscribe and discard bounded queue |
| Binary channel, later | client/widgets / event-consumer | Fan-out observers or exclusive renderer per declared channel | Versioned frame metadata plus bounded buffer/stream handle | Cancel subscription, release buffers/decoder, enforce backpressure |

The common rule is immutable inputs and explicit output. A provider returns
data, commands, or a decoded declarative tree. It never mutates host-owned
objects. Where a context names services from another privilege, those services
are present only when the same entry point was also granted that privilege.
For example, a host UI provider does not receive execution events unless its entry
point also has `event-consumer`.

## 10. Schema and widget extensions

### 10.1 Runtime schema ownership

Backend node schemas remain authoritative. A frontend extension does not get a
`beforeRegisterNodeDef` equivalent and cannot replace a schema after parsing.
The current ecosystem uses that hook heavily to mutate constructors
(`dives/report-08-frontend-server.md:18-30,325-341`), but Dinkster's schema
registry is a normalized data boundary rather than a constructor registry.

The join is:

```text
backend snapshot schema
  -> normalized WidgetSpec { widgetType, options, ... }
  -> connection/snapshot WidgetRegistry
  -> WidgetKind semantics + selected WidgetView presentation
  -> generic fallback when no implementation is active
```

This flow already exists in part. `WidgetSpec.widgetType` selects a registered
kind (`Dinkster-Frontend/packages/core/src/schema/model.ts:135-151`), and the
canvas registry painter resolves a row through the widget registry before
falling back (`Dinkster-Frontend/packages/canvas/src/registry-painter.ts:14-38`).

### 10.2 Widget kinds and views

`WidgetKind` owns JSON value shape, migration, default, validation, and default
view. `WidgetView` owns compact presentation and an optional expanded editor.
The existing public contract already makes that split and allows many views
without changing stored values
(`Dinkster-Frontend/packages/core/src/widgets/contract.ts:1-10,37-112`). Core
widget kinds already register through the same registry API
(`Dinkster-Frontend/packages/widgets/src/registry.ts:1-44`).

The extension API retains those contracts with these refinements:

- A pack-defined kind id MUST be namespaced by pack id.
- A kind is exclusive. Duplicate ownership is resolved by the backend snapshot
  or fails activation; no last-wins behavior.
- Views are independently named registry entries. A pack may add a view to a
  kind provided by another pack only when it declares that dependency.
- Compact drawing receives a bounded retained builder, never
  `CanvasRenderingContext2D`.
- Every inline action is a namespaced semantic hit region. It dispatches a
  registered action or command; it does not install canvas listeners.
- `WidgetView` owns compact retained `SceneBuilder` drawing and optional
  declarative `editorUi` only. The host owns expanded editor elements and
  contents, placement, focus, dismissal, readonly behavior, error boundaries,
  lifecycle and cleanup, and command invocation.
- Query and media access use the connection-scoped client. The current client
  already confines route construction to a single-slash path relative to its
  connection base and deduplicates GETs
  (`Dinkster-Frontend/packages/client/src/scoped-client.ts:1-8,33-77`).

One existing gap is concrete: `SceneBuilder.hitRegion` is part of the widget
contract, but the Canvas2D adapter currently discards hit regions
(`Dinkster-Frontend/packages/core/src/widgets/contract.ts:58-63`;
`Dinkster-Frontend/packages/canvas/src/registry-painter.ts:50-76`). Widget-level
inline interaction cannot be called complete until those regions join the
host hit pipeline.

### 10.3 Dynamic widget/input reconciliation

VHS currently inserts and removes widgets and graph inputs from backend format
metadata, changes config, and refits nodes (`dives/report-08-frontend-server.md:309-314`).
The host-seam inventory therefore asks for atomic dynamic reconciliation and
complete per-input metadata (`dives/report-08-frontend-server.md:358-364`).

Dinkster does not satisfy that need by allowing widget code to mutate rows. It
uses two supported paths:

1. Backend schema data expresses dynamic interfaces through normalized dynamic
   constructs and `WidgetSpec.options`. A document command changes the selected
   variant or materialized members. Elaboration derives the new interface and
   the retained scene rebuilds. The existing schema model already represents
   autogrow, dynamic combo, and typed dynamic slot constructs
   (`Dinkster-Frontend/packages/core/src/schema/model.ts:162-208,227-262`).
2. A genuinely pack-specific dynamic construct must first become a versioned
   schema capability with a pure elaboration contract. It is not smuggled in
   through frontend code.

This preserves the document -> schema/elaboration -> scene direction. It also
makes dynamic behavior work in subgraphs and imports, where mutable widget
arrays would not.

### 10.4 Media and previews

VHS requires aspect-aware media display, native/transcoded media sources,
uploads, context actions, pointer interaction, and cleanup
(`dives/report-08-frontend-server.md:245-264,303-307,358-363`). Dinkster already has a
preview renderer contract and a node-preview overlay type
(`Dinkster-Frontend/packages/core/src/widgets/contract.ts:114-145`;
`Dinkster-Frontend/packages/canvas/src/previews.ts:1-49`).

The VHS-style extension should compose existing pieces rather than create a
special DOM widget embedded in every node:

- schema metadata selects an ASSET/path/timeline widget kind;
- the compact view emits retained image/poster and semantic controls;
- activation opens one host-rendered declarative media viewer when rich controls are
  needed;
- media URLs come from declared backend services through `ScopedClient`;
- execution previews use an exact channel-selected `PreviewRenderer`;
- upload progress and cancellation use an explicit asset service, not raw XHR.

`PreviewRenderer.canRender()` currently uses first-match list order
(`Dinkster-Frontend/packages/widgets/src/registry.ts:34-43`). The extension API
must replace implicit first match with exact channel ownership and explicit
fallback ordering.

## 11. Canvas extensions

### 11.1 Evidence and current mismatch

rgthree needs node foreground drawing, group overlays, link decoration,
hit-testing, menus, navigation, and graph transactions. Today it obtains them
by replacing draw and hit methods and mutating link records
(`dives/report-08-frontend-server.md:34-47`). The required host seams are
stable z-ordered render layers, typed menus, graph transactions, navigation,
input capture, and lifecycle parity (`dives/report-08-frontend-server.md:365-372`).

The greenfield frontend has retained data, but not yet a general retained
extension scene:

- `Scene` is a concrete closed record of nodes, links, reroutes, value sources,
  selectors, net stubs, groups, and boundaries
  (`Dinkster-Frontend/packages/canvas/src/scene.ts:378-396`).
- `buildScene` directly constructs those collections
  (`Dinkster-Frontend/packages/canvas/src/scene.ts:433-457,912-930,1085-1088`).
- `CanvasRenderer` directly walks them in fixed group/link/node/overlay order
  (`Dinkster-Frontend/packages/canvas/src/renderer.ts:641-760,983-1085`).
- Base hit testing is a closed `Hit` union and directly traverses the same
  geometry (`Dinkster-Frontend/packages/canvas/src/hit.ts:53-182,204-260`).

There are useful narrow precedents: badge data is host-rendered and hit-tested
before gestures (`Dinkster-Frontend/packages/canvas/src/badges.ts:1-27,83-113`),
and node previews are separate view overlays
(`Dinkster-Frontend/packages/canvas/src/previews.ts:1-20`). However, badge content
is assembled and interpreted through hardcoded ids in `CanvasHost`
(`Dinkster-Frontend/packages/app/src/CanvasHost.tsx:1414-1445,2351-2381`). It is not
yet a general contribution registry.

The app-internal lens registry exposes no arbitrary paint hook. Its Types lens
selects a closed renderer capability that compiles retained, bounded labels;
it receives no `CanvasRenderingContext2D`, concrete `Scene`, overlay, or token
handle. This narrow built-in path is not a general contribution registry.

### 11.2 Declarative overlay scene

[RECOMMENDATION, VETOABLE] Add a separate retained `OverlayScene` compiled
after the base scene, rather than allowing extensions to append arbitrary
members to `Scene`.

A canvas provider receives `CanvasReadContext`:

- connection, snapshot, document, graph, and stable semantic identities;
- a stable geometry projection for visible nodes, links, groups, pins, and
  viewport, not the concrete `Scene` object;
- immutable selection, solved-type, and execution projection;
- public design tokens;
- a command dispatcher and namespaced action registry;
- scoped image/media handles;
- activation abort signal.

It returns bounded primitives such as paths, rects, text, icons, badges, image
handles, style transforms, and semantic hit regions. Each primitive names one
fixed phase:

1. `under-groups`
2. `over-groups-under-links`
3. `over-links-under-nodes`
4. `node-foreground`
5. `over-scene`

The exact phase names are vetoable; the important property is a small closed
set. Inside a phase, order is backend snapshot order, then contribution id,
then primitive ordinal. There is no arbitrary numeric z-index across packs.

Why a separate overlay scene first:

- It does not perturb base layout, topology, solver diagnostics, or gestures.
- It can be dropped atomically on disable.
- It is serializable enough to cross a Worker/iframe boundary later.
- It allows one host culling and hit index.
- It contains the blast radius in a renderer that currently assumes concrete
  base collections.

Typed third-party base-scene fragments remain an option when a real use case
needs layout-affecting geometry. They should not be the first API because they
would force the renderer, interaction controller, minimap, fitting, selection,
and accessibility layers to understand arbitrary entity kinds at once.

### 11.3 Decorations and hit testing

Node decoration providers return additive badges, outlines, labels, and
foreground primitives. Link decoration providers may transform a closed
host-owned visual style in deterministic order and add overlays; they may not
mutate link type, endpoints, or the document.

Every interactive primitive carries:

```ts
interface SemanticHitRegion {
  id: string
  shape: Rect | Circle | Path
  action: string
  target: SemanticCanvasTarget
  cursor?: string
  tooltip?: TooltipDescriptor
}
```

The host indexes and arbitrates regions with base hits using the declared
phase. An action receives semantic identity and dispatches a command or named
host action. It never receives raw pointer listeners, drag state, or the
interaction controller.

This generalizes the badge pattern that already keeps drawing and hit geometry
consistent (`Dinkster-Frontend/packages/canvas/src/badges.ts:76-113`) and fills the
widget adapter's currently ignored hit-region contract.

### 11.4 Menus, transactions, navigation, and tools

The current menu registry is a strong base. Contributions resolve plain data
from a plain `MenuContext`, actions are commands or named host actions, and
ordering is group/order/id (`Dinkster-Frontend/packages/core/src/menus/contract.ts:1-20,75-125,136-174`).
It should be extended with missing anchors and nested/submenu descriptors, not
replaced.

Graph writes go through commands. Extension commands receive a constrained
transaction builder whose commit runs the same invariants and undo machinery
as core commands. There is no raw graph mutation. Common rgthree behavior
should use core commands for reroute insertion, selection, group operations,
link rewiring, viewport navigation, and subgraph navigation. The evidence for
these needs is the direct manipulation rgthree performs today
(`dives/report-08-frontend-server.md:49-54,365-371`).

Gesture interception is not an ordered observer list. A registered custom tool
is an exclusive strategy selected by the user or host, with explicit
`enter`/`exit`, pointer capture, and cleanup. Ordinary decorations use semantic
hit regions and do not become tools.

## 12. App and workflow extensions

### 12.1 Declarative host UI

Crystools reaches into menu internals and host DOM ids to insert its monitor
(`dives/report-08-frontend-server.md:105-116,159-166`). Workspace Manager mounts
a complete React application directly on `document.body` and replaces workflow
methods because there is no app plugin lifecycle
(`dives/report-08-frontend-server.md:172-182,206-223`). These require an app
surface, not more node hooks.

The shell owns a versioned declarative tree contract. Its generic closed node
vocabulary is group, text, status, and action. Widget editors may instead use
the root-only `asset-editor` node, whose closed presentation records cover a
viewport state, display fields and origin labels, capabilities, notices, facts,
tool slots, and generic command states. Extensions provide data only; host code
owns all elements, layout, semantic classes, ARIA, and command invocation. The
initial named slot is `status.trailing`. Slot composition is registry identity
plus deterministic order.

Registration uses positional primitives - `hostUi(id, slot, provider, order?,
title?)` - so no extension-owned metadata object crosses the registry boundary.
The host validates the values and constructs a frozen contribution record.

Providers receive cloned, frozen JSON context and return `unknown` for strict
host decoding. Trees cannot contain callbacks, arbitrary tags, CSS, URLs,
stores, sockets, Canvas objects, or network handles. Widget editor and preview
viewer providers use the same contract without adding more shell slots. A
descriptor-safe structural walk rejects accessors first, then a structured-clone
preflight rejects Proxy wrappers at every tree and context object/array boundary.
Asset Editor fields remain display-only; an authored editable capability may
offer a registered no-payload command. Unknown field or capability kinds render
host-owned unsupported UI and expose neither their value nor their action. The
shell does not assign semantic origin identities or define transform, fact,
progress, draft, gesture, command-payload, or route semantics.

### 12.2 Workflow document service

Workflow lifecycle operations currently live as methods on the large
`AppState`: opening/importing (`Dinkster-Frontend/packages/app/src/app-state.ts:1207-1232`),
closing (`Dinkster-Frontend/packages/app/src/app-state.ts:1141-1171`), saving
(`Dinkster-Frontend/packages/app/src/app-state.ts:1296-1353`), and queueing
(`Dinkster-Frontend/packages/app/src/app-state.ts:1714-1768`). Extensions must not
patch those methods.

The workflow service exposes:

- read-only current workflow identity, active tab/view, connection, revision,
  dirty state, metadata, and document snapshot selectors;
- command dispatch for mutations;
- host operations for create, import, open, save, close, version snapshot,
  export, and queue;
- namespaced metadata/storage access;
- lifecycle subscriptions.

Observer events are:

- `workflow.created`
- `workflow.opened`
- `workflow.activeChanged`
- `workflow.dirtyChanged`
- `workflow.saveStarted`, `workflow.saved`, `workflow.saveFailed`
- `workflow.imported`
- `workflow.closeStarted`, `workflow.closed`
- `workflow.queueStarted`, `workflow.queued`, `workflow.queueFailed`
- `workflow.snapshotCreated`

Observers receive immutable data after the host has established operation
identity. They cannot mutate, cancel, or replace a document.

### 12.3 Settings, commands, and keybindings

The app already has framework-neutral settings, command, and keybinding
registries, dynamic unregister functions, a change signal, and override-only
persistence (`Dinkster-Frontend/packages/app/src/settings.ts:1-8,30-80,82-94,138-178`).
These should be reused.

Required additions are:

- connection/user/document setting scope declared per setting;
- manifest ownership and snapshot identity;
- value schema version and migration;
- async option providers through declared scoped services;
- explicit reset/remove behavior when a pack disappears;
- per-contribution policy and diagnostics;
- no arbitrary custom settings-row callback at schema/widget privilege.

A rich custom settings page is a host UI contribution and requires `app-workflow`.
Ordinary settings remain declarative. Crystools' hardware-driven dynamic
settings demonstrate the need for capability discovery and option refresh
(`dives/report-08-frontend-server.md:118-157`), but not for arbitrary settings
DOM in the basic registry.

Commands are keyed registry entries. Keybindings refer to command ids and go
through the existing user-remappable conflict UI; extensions do not attach
global key listeners.

## 13. Event consumers

### 13.1 Core execution events

The existing connection boundary already normalizes raw protocol messages and
ensures execution identity is `(connection, prompt)` rather than active tab.
It also models node progress as a per-node map with no single-current-node
assumption (`Dinkster-Frontend/packages/core/src/events/contract.ts:1-17,75-122`).
Both native and compatibility connections expose subscriptions that return an
unsubscribe function (`Dinkster-Frontend/packages/client/src/connection.ts:181-196`;
`Dinkster-Frontend/packages/client/src/dinkster-connection.ts:438-448`).

The following general core subscription API is proposed, not implemented.
An event consumer would subscribe through a filtered `ExtensionEventBus`, never
a connection object or socket. Core event filters include:

- execution started/completed/interrupted/error;
- node state/progress/cache/skipped/output;
- preview channel availability;
- queue state;
- schema/snapshot changed for connection-scoped host UI.

The callback receives typed event data, connection and execution identity,
snapshot digest, stable runtime node id, and a provenance resolver. It does
not receive raw server envelopes.

Subscriptions are fan-out observers. Each callback runs behind an extension
error boundary and bounded queue. Slow observers cannot block transport or
the core execution store. Delivery policy is explicit: lossless ordered for
terminal lifecycle, coalesced latest for progress/monitoring, and bounded
drop-oldest only for declared advisory telemetry.

### 13.2 Custom namespaced JSON events

The deep dive shows three recurring custom-event cases: Crystools periodic
resource snapshots, rgthree metadata refresh completion, and VHS preview
initialization (`dives/report-08-frontend-server.md:346-355,383-390`).

A custom JSON event declaration includes:

- exact namespaced event id;
- producer pack and consumer contribution;
- payload schema and schema version;
- connection-wide or execution-correlated scope;
- optional node correlation with nested/runtime identity;
- broadcast or client-targeted delivery;
- delivery/backpressure policy;
- maximum encoded payload size.

The client validates at the normalization boundary. A valid event becomes a
typed `extensionEvent`; malformed, undeclared, wrong-owner, and wrong-version
events become rate-limited diagnostics and never reach extension code.

The implemented custom-event subset uses optional snapshot
`events: [{name, payload: {field: scalarType}}]` declarations. All fields are
required, objects are closed, and scalar types are string/integer/number/boolean.
The contract fixes schema version 1, execution scope, 65536 payload bytes, and
advisory drop-oldest delivery. The `node_event` envelope carries
`extensionSnapshotDigest`, `schemaVersion`, producer `pack`, sequence, and job
identity, with optional `worker`, `executionArm`, and runtime `nodeId`. Unknown
envelope fields are tolerated. Existing core events retain their normal path.

Frontend declarations use `{id, kind: "eventConsumer", event}` and independently
require `event-consumer`. The normalizer validates against the job snapshot's
producer declaration; the child world matches the exact producer/event and
connection/digest before delivery. Each consumer receives frozen typed data
through an asynchronous 64-event drop-oldest queue with failure isolation and
queued-delivery cancellation on gate changes or world disposal. No socket or
connection handle reaches the extension callback.

`event-consumer` does not imply query, media, route, filesystem, app, or canvas
access. Those are separately declared capabilities.

### 13.3 Binary channels later

The existing native transport already decodes one self-describing binary
preview frame with a JSON header and payload
(`Dinkster-Frontend/packages/core/src/events/dinkster.ts:1-11,42-60`). This is useful
precedent, not yet a general extension binary API.

The later binary contract must declare:

- channel id and framing version;
- MIME/codec and schema metadata;
- connection, execution, node, sequence, and stream correlation;
- maximum frame and stream size;
- bounded buffering and backpressure;
- cancellation and end/error lifecycle;
- unicast/broadcast policy;
- exclusive renderer or observer composition.

VHS demonstrates why these cannot be guessed: it pairs a JSON initialization
event with a custom 24-byte binary header that truncates long node ids
(`dives/report-08-frontend-server.md:293-301`). The first general binary slice
should be proven by a VHS-style port and should not overload the core preview
event.

## 14. Trust, authorization, and sandboxing

### 14.1 Same-realm JavaScript is authorization-only

Loading an ES module in the app window gives it the authority of that window.
TypeScript interfaces, unexported package internals, a scoped context, and a
policy saying "do not call fetch" do not stop code from reaching `window`,
`document`, storage, network APIs, or prototypes. Content digests and CSP help
integrity and origin control; they do not confine behavior.

This corrects two overstatements in the current codebase:

- The widget contract labels `ScopedClient` as the only network access and
  says there is no ambient DOM access
  (`Dinkster-Frontend/packages/core/src/widgets/contract.ts:16-31`), but
  same-realm code can still use browser globals.
- The current extension-host comment says disabled code has no path back
  because there is no raw canvas/DOM escape hatch
  (`Dinkster-Frontend/packages/core/src/extensions/host.ts:5-17`), but the
  activation callback itself is ordinary same-realm JavaScript.

The API still enforces authorization at host service boundaries, produces an
audit trail, and prevents accidental coupling. It is not a security sandbox,
consistent with P8.

### 14.2 Execution modes

The manifest declares required UI/capability shape; deployment policy chooses
an execution mode:

1. **Declarative/data-only**: no extension JS. Menus, setting definitions,
   badges, static schema metadata, and simple app descriptors are validated
   data. This is the safest and preferred form where sufficient.
2. **Worker logic**: non-DOM widget semantics, import migrations, event
   aggregation, and canvas overlay production run in a dedicated Worker via
   structured-clone RPC. CPU, queue, message size, and lifetime are bounded.
3. **Sandboxed iframe UI**: panels or rich editors run in an iframe without
   same-origin authority. State arrives through capability RPC; writes are
   commands. The iframe gets no raw app DOM, canvas, socket, or storage.
4. **Trusted same-realm module**: needed initially for the broadest current UI
   integration. It is explicitly labeled authorization-only and requires
   deployment/user trust.

[RECOMMENDATION, VETOABLE] Start implementation with trusted same-origin,
content-addressed modules plus explicit privilege consent, while designing all
contexts as message-shaped capabilities. Then move event/import logic to
Workers and app panels/editors to sandboxed iframes without changing the
contribution model.

Direct canvas or DOM handles make Worker/iframe migration impossible. This is
another reason for declarative overlays and host-rendered containers. If a
raw immediate-mode canvas hook is ever exposed, it must be a distinct
same-realm-only privilege, not `graph-editor-canvas` v1.

### 14.3 Module and asset policy

- Modules and chunks are served from installed pack content, not arbitrary
  URLs.
- Snapshot identity includes package, entry-point, and module digests.
- Assets use immutable content-addressed routes.
- The host checks API range and privilege policy before import.
- Same-realm import top-level side effects are a trust risk the host cannot
  roll back reliably. Isolated realms can be terminated; trusted modules rely
  on contract, review, signatures, and deployment policy.
- Route and media capabilities remain same-origin and namespaced. Browser
  globals make this enforceable only in isolated modes.

## 15. Workflow and schema import compatibility

The runtime stays a clean break. The frontend does not execute legacy pack JS,
construct LiteGraph nodes, emulate `beforeRegisterNodeDef`, or call legacy
widget factories.

The current importer already has the correct base policy: legacy
`widgets_values` is positional, so it maps values against current schema order
and reports mismatches rather than silently shifting values
(`Dinkster-Frontend/packages/core/src/format/import-litegraph.ts:1-25`). If a
schema is absent, raw widget values are retained for review; missing, excess,
and unknown keyed values get diagnostics and retained raw data
(`Dinkster-Frontend/packages/core/src/format/import-litegraph.ts:385-433`). Its
output passes the normal shape and invariant gates
(`Dinkster-Frontend/packages/core/src/format/import-litegraph.ts:683-697`).

Required extension-aware import sequence:

1. Resolve legacy node class/type through backend/pack migration metadata to a
   stable Dinkster schema id.
2. Use that schema's ordered widget-backed inputs to map positional values to
   stable input ids.
3. Read each target input's backend-declared `widgetType`. The frontend widget
   implementation is not required to identify or preserve the value.
4. If the target `WidgetKind.valueSchema` version differs, invoke its pure
   value migration.
5. If a pack declares a historical importer for a legacy node/widget version,
   run the keyed pure `workflowImporter` contribution in a Worker-compatible
   context. It returns values, namespaced `ext` data, and diagnostics, not a
   live node.
6. If no adapter can interpret data, preserve the original JSON under import
   provenance, render a generic/unknown widget or unknown-node shell, and
   diagnose exactly what is missing.
7. Write only Dinkster's ID-keyed workflow format. Legacy constructor names and
   positional arrays do not become runtime identity.

Dinkster workflows already provide namespaced `ext` escape hatches that
round-trip unknown data (`Dinkster-Frontend/packages/core/src/format/document.ts:1-16,106-123`).
Use those for unresolved import provenance and pack data, not for executable
callbacks.

An absent frontend widget implementation alone must not block execution when
the backend schema and stored value are valid; the generic view is sufficient.
An unresolved backend node schema or invalid required value follows normal
compiler diagnostics and may block queueing. This preserves the independence
of backend nodes and frontend presentation.

[RECOMMENDATION, VETOABLE] Keep historical import adapters pure and keyed by
source format plus legacy type/version. Do not let a general app extension
take over the import pipeline or mutate the document after import.

## 16. What exists and what must be added

| Area | Existing Dinkster-Frontend capability | Required work / conflict |
|---|---|---|
| Manifest | JSON manifest, namespaced ids, closed contribution categories, validation (`Dinkster-Frontend/packages/core/src/extensions/manifest.ts:1-91`) | Add pack version/API range, frontend entry points, privileges, snapshot/module identity, event declarations, ordering, and broader kinds |
| Host/gating | Pack/category/contribution gates, deployment allow/deny, typed registry routing, diagnostics (`Dinkster-Frontend/packages/core/src/extensions/host.ts:31-155,290-398`) | Stage and atomically commit; add pack/world disposal; correlate snapshot; current partial-survival on throw conflicts with DESIGN 3.0 |
| Multi-backend | Per-backend schema registry, connection, scoped client, tab targeting (`Dinkster-Frontend/packages/app/src/app-state.ts:675-704,820-857`) | Replace one global extension/widget world with per-connection/snapshot child worlds; retain old execution worlds |
| Schema | Normalized `WidgetSpec`, explicit `widgetType`, open options (`Dinkster-Frontend/packages/core/src/schema/model.ts:131-160`; `Dinkster-Frontend/packages/core/src/schema/object-info.ts:127-168`) | Pair schema with snapshot digest; define native namespaced metadata; prevent public runtime schema overrides |
| Widgets | Public kind/view/preview contracts, core dogfood, unregister functions (`Dinkster-Frontend/packages/core/src/widgets/contract.ts:37-145`; `Dinkster-Frontend/packages/widgets/src/registry.ts:9-44`) | Exact preview-channel arbitration, extension contexts, per-world registries, isolated-compatible RPC, implement compact hit regions |
| Menus | Plain-data context/actions and deterministic group/order/id composition (`Dinkster-Frontend/packages/core/src/menus/contract.ts:75-174`) | Add missing anchors, nested descriptors, declarative visibility selectors, connection/snapshot context |
| Canvas | Retained base scene, injected widget painter, badges, previews, internal lens hook (`Dinkster-Frontend/packages/canvas/src/scene.ts:378-457`; `Dinkster-Frontend/packages/canvas/src/renderer.ts:342-456`) | Add separate overlay scene, fixed phases, generic hit regions/actions, decoration registries; do not publish raw lens context |
| App shell | Solid topbar/sidebar/canvas/rail/dialogs (`Dinkster-Frontend/packages/app/src/App.tsx:308-340,454-525`) | Declarative host UI registry, connection instances, error boundaries, app contribution teardown |
| Workflow | Command/store model and explicit open/save/close/queue methods (`Dinkster-Frontend/packages/app/src/app-state.ts:1106-1171,1207-1261,1296-1353,1714-1768`) | Read-only workflow service, observers, narrow guards, namespaced storage; do not expose or patch AppState |
| Settings | Extensible definitions, commands, keybindings, change signal, persistence (`Dinkster-Frontend/packages/app/src/settings.ts:1-80,82-178`) | Ownership, scope, schema migration, async options, snapshot diagnostics, isolated facade |
| Events | Typed normalized core events, execution identity, unsubscribe handles, self-describing native preview binary (`Dinkster-Frontend/packages/core/src/events/contract.ts:1-17,75-199`; `Dinkster-Frontend/packages/core/src/events/dinkster.ts:42-60`) | Add snapshot identity, validated custom JSON events, per-extension queues and policies; custom events are currently dropped |
| Import | One-way LiteGraph importer with raw-value preservation and diagnostics (`Dinkster-Frontend/packages/core/src/format/import-litegraph.ts:1-25,385-433`) | Add stable pack mapping data, pure keyed historical adapters, WidgetKind value migration integration, generic review UI |
| Trust | Scoped API shapes and hidden internal exports | Correct authorization-only claims; add Worker/iframe hosts for actual isolation |

Two current frontend choices should not become public extension behavior:

1. `registerSchemas` layers frontend schemas over every backend globally
   (`Dinkster-Frontend/packages/app/src/app-state.ts:1549-1573`). That is useful
   test/prototype machinery but conflicts with backend snapshot ownership and
   multi-backend versioning.
2. `SurfaceRegistry` is a typed document control-surface decoder registry
   (`Dinkster-Frontend/packages/core/src/surfaces/contract.ts:1-70`), not an app
   host UI registry. The current `SurfacePanel` handles the one core mode
   panel directly (`Dinkster-Frontend/packages/app/src/SurfacePanel.tsx:176-220`).
   It should not be stretched to mean app panels.

## 17. Failure handling and diagnostics

The host reports, at minimum:

- malformed manifest or snapshot;
- API range mismatch;
- artifact/module digest mismatch;
- denied privilege or contribution;
- missing dependency/service/provider;
- duplicate keyed identity;
- missing exclusive strategy selection;
- activation exception and rollback result;
- cleanup timeout or leaked resource/subscription known to the host;
- schema/snapshot epoch mismatch;
- unavailable historical snapshot presentation;
- malformed or undeclared custom event;
- event queue overflow according to declared delivery policy;
- isolated realm termination or budget violation.

Diagnostics include connection, snapshot, pack, entry point, and contribution
identity. A pack error never crashes schema loading, document inspection, or
core event processing. Missing frontend code degrades to generic widgets,
plain data, standard canvas, and inert unknown app surfaces.

Composition is deterministic. Ordered points use snapshot order and stable ids;
registries reject collisions; exclusive points require an explicit selected
owner; observers never mutate shared input. There is no last registration wins.

## 18. Demo-first frontend implementation slices

All slices inherit the overall proof gate: two extensions coexist,
deterministic ordering is visible, an exception rolls back, disable/unload
returns to baseline, and snapshot identity is stable. This matches the overall
vertical-slice acceptance rule (`DINKSTER-EXTENSION-DESIGN.md:283-290`).

### F0. Snapshot loader and transactional world

Build:

- authored/effective manifest types and validation;
- paired schema/snapshot fetch;
- per-connection child world;
- exact module loading and API-range check;
- staged activation/rollback, receipts, gates, disposal, diagnostics;
- minimal named `status.trailing` host UI contribution and one setting/menu contribution.

Real-extension proof: a thin Crystools-style monitor entry point shows its
connection name and an inert "monitor unavailable until F3" status item, while
a VHS manifest contributes one disabled declarative setting. Toggle each
independently, connect two backends with different snapshot digests, inject an
activation throw, and verify no partial UI survives.

### F1. VHS-style schema/widget/media pack

Build:

- per-world widget kind/view/preview registries;
- backend `widgetType` and options flow;
- exact preview-channel ownership;
- compact semantic hit regions;
- host-owned expanded media editor;
- scoped media/query/asset services and cleanup;
- unknown/disabled widget fallback.

Real-extension proof: port VHS path, constrained number, timestamp, and media
preview behavior from the evidence
(`dives/report-08-frontend-server.md:232-264,309-315`). Load a workflow, disable
the widget contribution while its editor is open, preserve the value, fall
back generically, re-enable, and verify all URLs/listeners/decoded images are
released on teardown.

### F2. rgthree-style canvas QoL pack

Build:

- declarative overlay scene and fixed phases;
- node/group/link decorations;
- semantic hit regions and generic badge actions;
- complete menu anchors;
- public graph/navigation commands;
- optional exclusive tool session.

Real-extension proof: port a useful subset of rgthree behavior: group fast
toggle decoration, link type/color emphasis, a node foreground label, and
ordered canvas/node menu items. It must use no renderer, scene, DOM, or
interaction-controller reference. Run two decoration packs in reversed
discovery order and show snapshot order is unchanged; unload removes overlay
and hit regions in one scene revision.

### F3. Crystools-style app monitor and custom JSON events

Build:

- named host UI slots and framework-neutral declarative providers;
- connection-scoped settings with async options;
- typed custom JSON event validation and fan-out;
- bounded/coalesced extension event queues;
- panel error boundary and cleanup.

Real-extension proof: port the Crystools resource monitor flow of capability
discovery -> dynamic settings -> server configuration -> periodic push
(`dives/report-08-frontend-server.md:118-157`). Show two backend monitors with
different devices, coalesce rapid snapshots, deny route capability while still
allowing event consumption, and verify panel/event/settings teardown.

### F4. Workspace-style workflow lifecycle

Build:

- read-only workflow document service;
- open/active/dirty/save/close/queue observers;
- namespaced workflow metadata and storage capability;
- narrow close guard if the port proves it necessary;
- version snapshot host operation.

Real-extension proof: port Workspace Manager's workflow identity, dirty-state,
save/version, and browser panel behavior without replacing `onConfigure`,
watching document clicks, or calling `graph.serialize`
(`dives/report-08-frontend-server.md:206-223`). Verify one observer failure does
not prevent core save and that unload leaves no dirty-state heuristic behind.

### F5. Extension-aware ComfyUI workflow import

Build:

- stable legacy node/type mapping metadata;
- pure keyed `workflowImporter` registry;
- WidgetKind value migration integration;
- import provenance and review diagnostics;
- unknown custom-widget fallback UI.

Real-extension proof: import real VHS and rgthree workflows containing custom
widgets, old widget ordering, and frontend-only constructs. Supported values
land on stable ids; unsupported virtual constructs remain inspectable and
diagnosed; no legacy script executes. Disable the importer and confirm raw data
is preserved rather than reassigned.

### F6. Isolation pilot and later binary media

Build after F0-F5 establish the message-shaped contracts:

- Worker host for event aggregation/import migrations;
- sandboxed iframe provider realm;
- budgets and termination diagnostics;
- versioned binary channels with backpressure.

Real-extension proof: run the Crystools event reducer in a Worker and its panel
in a sandboxed iframe, then port VHS latent-preview initialization and frames to
the negotiated binary channel. Kill the realm mid-stream and verify core event
processing, cancellation, and cleanup remain correct.

## 19. Recommendations for review

These are the RFC's most consequential recommendations. Each is vetoable, but
a veto should choose an explicit alternative before implementation.

1. **Snapshot-driven only.** The backend effective snapshot selects exact
   frontend modules. The browser may further deny but never independently
   discovers or upgrades them.
2. **Per-connection and per-snapshot extension worlds.** Do not place pack
   widget/event/app contributions in today's global registries.
3. **Separate declarative overlay scene first.** Do not expose raw canvas,
   concrete `Scene`, renderer wrappers, or arbitrary scene entity injection in
   frontend API v1.
4. **Framework-neutral declarative host UI.** Solid owns rendering and slot
   containers; Solid component types and runtime are not extension ABI.
5. **Trusted same-realm is explicitly authorization-only.** Keep contexts
   structured-clone compatible so Worker/iframe isolation can replace it.
6. **One coarse frontend API major plus versioned experimental capabilities.**
7. **Observers by default, narrow guards by proof.** No generic workflow method
   wrappers or serialization transforms.
8. **Exact custom event schemas and exact preview channel ownership.** No
   first-listener-wins predicates.
9. **No arbitrary remote frontend URLs.** Installed, content-addressed,
   same-backend-origin assets only.
10. **Teardown from day one, reload for code updates initially.** Live gates
    use disposers; package/module version changes may require a full reload
    until retained snapshot worlds are proven.

## 20. Open questions

### Q1. Snapshot transport

Should schema and snapshot be one response, two responses tied by digest/epoch,
or bootstrap HTML plus an immutable endpoint?

[RECOMMENDATION, VETOABLE] Use one backend-generated effective snapshot and
include its digest in the schema table. Two endpoints are acceptable if the
client verifies both and retries mismatched epochs atomically.

### Q2. Multi-backend host UI

Should connection-scoped app panels render one instance per connected backend,
only for the active tab's backend, or aggregate through a host service?

[RECOMMENDATION, VETOABLE] Default to active-connection instances for sidebar
and rail panels, allow an explicit `multiConnection` aggregation capability
later, and always label status-bar items with connection identity when more
than one backend is connected.

### Q3. Historical snapshot retention

How long must a backend retain old frontend assets and manifests for frozen
executions?

[RECOMMENDATION, VETOABLE] Managed installations retain content-addressed
frontend assets while any retained execution snapshot references the artifact.
If storage policy evicts them, the frontend uses generic fallback and an
explicit missing-presentation diagnostic.

### Q4. Frontend API granularity

Should all stable capabilities share one SemVer or should widgets/canvas/app/
events each negotiate independently?

[RECOMMENDATION, VETOABLE] One stable major plus per-experimental-capability
versions, as specified in section 4.2.

### Q5. Canvas phase vocabulary

Are the five proposed phases sufficient for rgthree-style group, link, node,
and foreground behavior? Does a pack need layout-affecting scene fragments?

[RECOMMENDATION, VETOABLE] Prototype the separate overlay against the rgthree
port before freezing names. Add a typed base fragment only when a concrete
behavior cannot be represented as overlay + command.

### Q6. Raw same-realm hooks

Should trusted desktop deployments get a raw canvas/DOM escape hatch?

[RECOMMENDATION, VETOABLE] No in v1. If later unavoidable, make it a separately
named full-host privilege, unavailable in cloud/isolated modes, with no claim
of compatibility or sandboxing.

### Q7. App UI technology

Should host UI providers receive a declarative context in the main realm or
over iframe RPC?

[RECOMMENDATION, VETOABLE] Use the versioned group/text/status/action tree in
all realms. Keep contexts iframe-compatible; extensions never own elements,
styles, framework roots, or UI disposal.

### Q8. Lifecycle veto semantics

Can extensions veto close, save, import, or queue? What happens on timeout?

[RECOMMENDATION, VETOABLE] Observers never veto. Initially allow a deny-only,
timed guard for close and queue, with fail-open or fail-closed chosen per
operation and made visible to the user. Do not allow save payload transforms.

### Q9. Settings scope

Which settings are user-global, backend-connection, workspace, or document
state, and how do values follow a pack across changing connection ids?

[RECOMMENDATION, VETOABLE] Definitions declare scope. User preferences key by
pack id; backend-dependent values key by stable backend identity plus pack id;
document behavior belongs in namespaced document data, not settings.

### Q10. Frontend-only virtual nodes

rgthree uses many frontend-only nodes and expects lifecycle parity
(`dives/report-08-frontend-server.md:18-32,49-54`). Which should become core
document constructs, and is any general virtual-node extension point required?

[RECOMMENDATION, VETOABLE] Do not ship a general frontend-only node constructor
API. Port reroutes, bookmarks, labels, control panels, and aliases to explicit
document/view constructs or plan-compiler contributions. Revisit only after a
real executable node cannot be modeled by backend schema plus those constructs.

### Q11. Duplicate and dependency resolution

Does the backend snapshot always choose one provider for exclusive ids, or may
the frontend resolve after local gates?

[RECOMMENDATION, VETOABLE] Snapshot chooses the provider and records it.
Locally disabling that provider produces a missing-provider fallback; it does
not silently promote a different implementation with different behavior.

### Q12. Hot update policy

Can snapshot changes activate/deactivate without reload, including while
editors and executions use the old world?

[RECOMMENDATION, VETOABLE] Support live contribution gates and connection
removal from day one. Require full reload for changed module identity in the
first release, while retaining old worlds conceptually for in-flight execution
correctness. Remove the reload restriction only after a stress test proves
world retention and ESM asset behavior.

### Q13. Custom event schema language

Should event payloads use JSON Schema, generated TypeScript codecs, or a Dinkster
wire schema?

[RECOMMENDATION, VETOABLE] Use the same versioned schema/codec mechanism the
server adopts for route/event validation. Require a machine validator at the
client boundary; TypeScript declarations alone are insufficient.

### Q14. Binary channel timing

Should general binary channels ship with frontend v1 or remain the later media
slice accepted by the overall design?

[RECOMMENDATION, VETOABLE] Defer. Use typed JSON for Crystools/rgthree first,
then let the VHS port establish framing, cancellation, decoder ownership, and
backpressure requirements.

## 21. Review acceptance criteria

This RFC is ready to move from draft when reviewers agree on:

- authored manifest and effective snapshot ownership;
- per-connection/snapshot world model;
- frontend API compatibility rule;
- transactional activation and teardown semantics;
- declarative canvas strategy and phase prototype plan;
- declarative host UI boundary;
- lifecycle observer/guard split;
- custom event schema and queue policy;
- initial same-realm trust posture and isolation roadmap;
- F0-F5 slice ordering and real-pack proofs.

Implementation should then update the existing extension host and registries in
place. It should not create a second, parallel extension system.
