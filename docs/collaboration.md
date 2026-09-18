# Collaboration (multiplayer shared sessions)

Multiplayer editing of one document by several browsers at once, over the
backend's dinkster-collab surface (protocolVersion 1; joint contract pinned in
docs/promises.md and mirrored in Dinkster/docs/PROMISES.md). This document
covers the app-level lifecycle and UX; the underlying state machine is
`core/src/commands/shared-session.ts` (SharedDocumentSession) and the wire
adapter is `client/src/collab-connection.ts`.

## Using it

Right-click a workflow tab and choose **Share** to publish that tab's document
as a new shared session and swap the tab onto it in place. Everyone who joins
sees and makes the same edits live. The sharer's undo/redo history follows
the tab when the shared session adopts the same document.

The Users button in the top bar opens the Workspace state modal:

- **Join** connects to a session discovered in the session list (the app
  scope `shared`; see below). Joining stands the session up as a tab; if a
  tab with the same document lineage is open it is replaced in place, and
  the session's document is the truth. A join starts with fresh local history.
- **Leave session** downgrades the tab back to an ordinary local tab over
  the CURRENT document (same tab id and position, drill-in preserved). The
  server session lives on for other participants.
- **End for everyone** DELETEs the server session; every participant's
  session settles `closed`, and this tab falls back local as in leave.

A shared tab carries a dot in the tab strip whose color tracks the live
session status (blue live, amber catching-up, red closed/error); the modal
shows the same status in words, the session id, and who is here now - you
plus every remote participant, each with their presence color.

Closing a shared tab (or replacing it by opening another document with the
same lineage) LEAVES the session - it disposes this client's connection and
never deletes the server session. Ending is always an explicit action.

## Session management presentation

The modal separates the active workflow from sessions available to join.
Discovery has distinct loading, unavailable, empty, ready, and failed states;
a failed request never also claims that the list is empty. Active sessions
show the document and session identities, backend, exact
`live`/`catching-up`/`closed`/`error` status, and a bounded, keyboard-scrollable
participant list. Long identities wrap rather than widening the dialog.

Share progress and failure use the application status surface. Join, leave,
end, and refresh expose only their own progress and failure in the Workspace
state modal. Completion is presented only after the AppState action reports
success or the membership signal changes. State changes are announced through
a polite live region. End requires an explicit destructive confirmation;
cancel and failure retain focus, while successful leave/end moves focus to the
resulting local-workflow presentation. The same controls remain reachable at
narrow widths and 200 percent zoom, and loading animation becomes static when
reduced motion is requested.

Leaving removes only this browser's membership. If discovery still returns the
live server session, it remains listed and immediately available to rejoin.

If the server closes a session, AppState remains responsible for falling back
to a local workflow. The panel announces that membership change, restores
focus to the local-workflow state, invalidates stale discovery, and refreshes
the available-session list without replacing the lifecycle announcement. If
an in-flight End request subsequently fails, its error remains visible beside
the local workflow while the ended session stays excluded from discovery.

## Architecture

- One `SharedDocumentSession<D>` owns ordering, pending operations, catch-up,
  resync, retries, undo/redo, checkpoint publication and presence transport.
  Workflow and ImageDocument facades select document adapters; neither owns
  a second session state machine.
- `app/src/collab.ts` - the app-side seam:
  - `stableActorId()`: one actor identity per tab,
    retained in sessionStorage, re-validated against the joint actorId pin
    (`[A-Za-z0-9_-]+`, never `__proto__`) on every load; storage-blocked
    environments get a session-only id.
  - `CollabTransport`: create/list/get/end/connect over the session surface.
    The production implementation wraps `@dinkster/client`; unit tests drive
    AppState through an in-memory fake server.
  - `COLLAB_SCOPE = 'shared'`: the discovery scope for app-created
    sessions. Deliberately not the backend's reserved single-user scope
    `local`, so single-user machinery never surfaces in the join list.
- `AppState` owns the lifecycle (`shareActiveTab`, `joinCollabSession`,
  `leaveCollabSession`, `endCollabSession`, `listCollabSessions`,
  `collabFor`, `collabTabs`). A shared tab's `store` IS the
  SharedDocumentSession - every consumer (canvas, app view, undo, queueing)
  works unchanged through the DocumentSession seam.
- `WorkflowTabs` hosts the Share menu entry and invokes `shareActiveTab`
  through the app shell. `CollabPanel` invokes the remaining session-management
  actions and renders AppState membership, SharedDocumentSession status, and
  PresenceChannel participants without duplicating lifecycle or transport
  authority.
- Collaboration is native-only: sessions are hosted by a `dinkster`-protocol
  backend's collab surface (v1 servers have no session routes). The panel
  says so in words when no such backend is connected.
- Conflicts (a concurrent edit dropped a local intention during rebase) and
  session errors surface as `collab`-origin diagnostics in the Problems
  panel under the tab's owner id.
- Palette and blueprint link-drop insertion predict new node ids through the
  session allocator, so shared actor-suffixed ids connect and select atomically.

## Connect an agent

An agent acts as a delegate of its user, not as a second user. Its operations
carry a distinct actor id while the authenticated principal remains the user.
The server derives `kind: agent` from the delegation, intersects the user's
grants with their agent permission toggles, and applies the user's session role.
Presence cannot claim a different kind or owner. Toggles affect agents only;
the user's own edits are not masked. Static and JWT-authenticated users can
list and edit their own toggles in the backend's Agent permissions panel.

Choose **Connect agent**, select a scope, optionally restrict it to one session,
and create a 10-minute delegation. Copy the token once and supply it to the
agent through `DINKSTER_AGENT_TOKEN` (preferred over a shell command containing
a secret) or `--token`. Revoke it from the same panel. Expiry is capped by
the user's JWT expiry. The server stores only token hashes in bounded memory;
server restart revokes all delegations. Never give the agent the user's full JWT.

The human-operated CLI login also accepts private credential files:

```sh
pnpm --filter @dinkster/agent-host exec tsx src/main.ts --base-url http://127.0.0.1:8765 login --scope shared --session-token-file /private/user-session --token-file /private/agent-delegation
```

Login exclusively creates the output file with mode 0600 and does not print
the credential. Load that file into the agent's environment outside recorded
commands. `@dinkster/agent-host` CLI, MCP and `headless-demo` accept the token.
`CollabHttpConnection` accepts `{token, actorKind}`; HTTP uses Bearer authorization
and each WebSocket connection mints a fresh single-use `/api/auth/ws-ticket`.
Missing credentials against an authenticated server fail with a diagnostic,
not a reconnect loop. Auth-off installations require no credential or prompt:
agents use the local principal and the agent activity/budget category.

Session-scoped credentials can only access their named session and the ticket
endpoint. Use a scope-wide credential for discovery, session creation or jobs.
Job submitters use their agent actor id as the existing job `clientId`; run
attribution records that id along with the user principal and credential kind.
The command catalog advertises every command in `coreCommandRegistry`, with
generic JSON metadata when richer parameter documentation is unavailable.

### Ownership, throughput and denials

Before allocating shared document ids, the browser binds its actor id with
`POST /api/sessions/{id}/actors`. A 409 `actor-principal-mismatch` causes one
fresh-id attempt, never an infinite retry. Server ownership persists for the
session, including across restarts. Bindings are capped at 256 per principal
and 4096 per session; the cap is reported as 429 `actor-limit`.

Server rate buckets are keyed by `(principalId, actorKind)` across sessions:
the human op budget is 60/second with burst 240, and agents get half of each.
Agent traffic cannot consume the human budget; rotating actor ids cannot
multiply it. Idle buckets are removed and the bucket count is bounded.

403, actor-ownership 409, and 429 become distinct `PostOpOutcome` denials with
a structured diagnostic: `{version: 1, type: "collab.denial", code, status,
message, sessionId, actorId, opId?, operation?, retryAfterMs?}`. Submission stops, the app
reports a collaboration Problem, and agent `settle()` rejects an Error whose
`diagnostic` property is that object. The current local document remains
available to recover by leaving the errored session; denied work is not
automatically retried or reported as committed.

401/403 on session probes, snapshots, catch-up reads or WebSocket tickets are
terminal transport denials too. The connection cancels pending probes, ticket
resolution and reconnects, aborts outstanding HTTP requests, and emits one
`denial` event carrying the same diagnostic retained in `connection.denial`.
Read denials name the `operation` instead of inventing an `opId`. App and agent
owners settle on that event to surface the error immediately, including when
no edit is queued. Network failures and server errors still retry.

### Agent activity

Agents announce tool calls and pending asks through additive presence:
`activity: {v: 1, type: "agent_tool_call", tool, status, pendingAsks: [{id, prompt}]}`.
Status is `running`, `success` or `error`. Tool text is bounded to 128 characters,
asks to 8, ids to 128, and prompts to 280. The participants list displays this
alongside the server-stamped agent identity. Activity is ephemeral, untrusted
display state, never authorization or an operation. A lost/revoked connection
cannot promise delivery of a final activity frame. Unknown or invalid activity
is ignored. The op envelope, revision model and `protocolVersion: 1` are unchanged.

## Checkpoint publication

Every connected shared session helps bound future join work by publishing
client-materialized checkpoints. Publication never reads the optimistic
document shown by the UI: it captures the session's separate authoritative
`confirmed` document at exactly `confirmedRevision`, so pending local
intentions cannot leak into a snapshot before the server orders them.

- A client becomes eligible after 200 confirmed ops beyond the last known
  checkpoint, or after 20 confirmed ops once that checkpoint is 60 seconds
  old. It waits a random 0-5 seconds and re-checks before PUT so peers do not
  stampede the same revision.
- The last-known checkpoint comes from the initial GET snapshot, reconnect
  descriptors, conflict-resolution GETs, and this client's successful PUTs.
  A newer observed checkpoint resets the op count and age.
- There is at most one snapshot PUT in flight per session and at least 30
  seconds between this client's successful publications. A 409
  `snapshot-invalid` is a benign competing publisher: the client GETs the
  current snapshot revision and resets its counters. A network failure waits
  for newer confirmed work before another periodic attempt.
- Disconnected and catching-up sessions do not publish. Close performs one
  non-blocking, best-effort flush only when the threshold is already met, the
  transport is connected, no PUT is in flight, and the confirmed document is
  synchronously available.
- Successful publications log the revision, folded-op count, and reason for
  profiling catch-up improvements. The join sequence is unchanged: GET
  snapshot, GET retained ops after its revision, then WS descriptor/replay.

The pure cadence/counter state is in
`core/src/commands/snapshot-publication-policy.ts`; SharedDocumentSession owns
timers and I/O. Proving coverage is in
`core/test/snapshot-publication-policy.test.ts` and the checkpoint publication
cases in `core/test/shared-session.test.ts`. The gated two-client live spec in
`client/test/collab-live.integration.test.ts` now authors a 200-op checkpoint
and joins a third client from it; it is not run as part of this slice.

## Lifecycle guarantees

These are pinned by `app/test/collab.test.ts`:

- Share and join are single-flight per tab / per session: a duplicate
  concurrent request is refused instead of creating a second server session
  or a racing membership.
- A share commits only if the tab still exists with the same store at the
  same revision when the connection is up. Edits made - or the tab being
  closed - while create/connect were in flight abort the share (the local
  tab is untouched, never resurrected) and the just-created orphan server
  session is best-effort deleted.
- A stale `endCollabSession` completion (the tab left and joined another
  session while the DELETE was in flight) never tears down the newer
  membership.
- Closing or replacing a shared tab disposes its transport connection.
- A session that settles `closed` REMOTELY (session_closed from another
  participant's end, or the gone-session probe) falls back local as in
  leave: membership dropped, tab kept over the current document. The
  status watcher distinguishes remote closure from the explicit leave/end
  path because `dropCollabFor` removes the membership BEFORE closing the
  session. A terminal ERROR keeps the membership so the red status stays
  visible until the user leaves. (Found live 2026-07-27: previously only
  the presence channel was disposed and the dead membership lingered.)
- A join whose session ends during the join itself (a session_closed frame
  buffered by the transport replays synchronously at subscription) is
  refused - a dead session never stands up as a membership.
- The transport buffers WS frames that arrive before the session
  subscribes: the WS connects while the HTTP snapshot fetch is still in
  flight, so the descriptor frame (the catch-up baseline) and replayed ops
  can land pre-subscription. They replay to the first subscriber in
  arrival order, exactly once. Without this a rejoin whose session already
  held ops above the snapshot revision never caught up (found live
  2026-07-27). Only authoritative frames buffer (descriptor, ops,
  session_closed - never presence or disconnected), the buffer is bounded
  at 4096, and overflow evicts the oldest op, never the descriptor: a
  maximum-retention replay of descriptor + 4096 ops is one event over the
  cap, and a dropped op is repaired by gap detection while a dropped
  baseline is not. A frame provoked reentrantly during the flush queues
  behind the older buffered events, preserving arrival order.

## Presence (remote cursors, selections, viewports, hover, drags, noodles)

While a shared tab is active on the canvas, every participant sees where
the others are: a colored, labeled cursor per remote actor, colored rings
around the nodes and reroute dots each has selected, a fainter ring on the
node each is hovering, dashed ghost outlines where each is dragging nodes
or reroutes mid-gesture, and a ghosted dashed noodle while each is pulling a
link from a node socket or reroute,
that actor's viewport rectangle on the minimap, and the participant list
in the modal. Presence is ephemeral by contract (the platform pin: NEVER
stored in shared document state) - the backend relays presence WS frames
to other subscribers and never persists or echoes them.

- The payload schema is owned by the client transport
  (`client/src/presence-payload.ts`, `PRESENCE_VERSION = 1`) since the backend
  and core treat it as opaque
  Json: `{v, graph, cursor, selection}` (where `selection` is node ids)
  plus optional additive fields `reroutes` (selected reroute ids), `view`
  (the visible world rect `{x, y, w, h}`), `hover` (hovered node id), and
  `drag` (in-progress scene-entity offsets as `[sceneId, dx, dy]` tuples -
  tuple form deliberately, so peer ids are never object keys on the wire),
  and `link` (an in-progress noodle with a semantic origin - node id, port id,
  and side, or reroute id - plus its current world-space cursor point),
  `identity` (`{kind: 'human' | 'agent', displayName?, owner?, harness?}`), and
  agent `proposals` (`{id, settingId, value, note?}`).
  Identity is self-declared by the sender and is not verified by the server.
  Identity strings are limited to 64 characters; malformed identity fields
  are ignored without dropping the rest of the frame. A `{v, gone}` departure
  frame is also valid. Old v1 frames without the optional
  fields stay valid; unknown fields are ignored (additive growth).
  Frames from other builds or malformed peers are noise - validated and
  dropped, never an error.
- Presence is graph-scoped: cursors and selection rings only render for
  actors viewing the SAME graph (drill-in aware). The current graph id
  travels in every frame.
- Cadence: local changes coalesce to at most one frame per 66ms
  (trailing-edge throttle); an idle client heartbeats every 2s; an actor
  silent for 6s expires. Leave/end/close sends a best-effort `gone` frame
  so peers drop the actor immediately instead of waiting out the TTL.
- Channel lifetime follows the membership from every direction: explicit
  leave/end/close disposes it before the connection closes (so the gone
  frame rides the live socket), a session ended REMOTELY disposes it via a
  status-signal watcher, and when the canvas rebinds to another tab (or
  unmounts) the old channel is blurred - peers see an off-canvas cursor
  and empty selection instead of a frozen ghost.
- Each membership owns one `PresenceChannel` (created and disposed with
  `CollabTabState`); CanvasHost feeds it pointer/selection/graph plus the
  visible world rect (derived from the renderer viewport and canvas CSS
  size, republished on camera changes and resize), the hovered node, and
  in-progress drag offsets (via the interaction controller's
  `onNodeHover`/`onDragOffsets` callbacks - offsets stream per move and
  clear once on commit or cancel), and projects remote state into the
  renderer's own presence channel (`setPresence` - separate from
  OverlayState, which the interaction controller replaces wholesale).
  Link presence receives the active gesture's semantic fixed endpoint from
  the interaction controller, avoiding coordinate inference from paint
  geometry. Only ordinary node-port and reroute link drags publish; a
  post-drop palette ghost and multi-source fan-out move do not. It reuses the
  same trailing-edge cursor cadence and clears by omitting `link` on the
  first complete snapshot after commit or cancel.
  Reroute selection comes from the same selection callback; generic drag
  offsets already include reroutes moved alone or with selected nodes.
  Actor colors are a deterministic hash of the actor id, so every
  participant paints every actor the same color with no coordination.
  Participant rows and cursor labels prefer `identity.displayName`, with the
  actor-id prefix as a fallback. Agents show a badge, owner, and harness.
- Agent setting proposals appear as cards in the collaboration panel. The
  browser resolves each proposal against its local settings registry and
  validates the proposed value before enabling Apply. Applying is an explicit
  human action that writes through the browser's registry; agents have no
  direct setting write channel. Dismissal is local to the panel session.
  Proposals are capped, ephemeral presence and disappear when the publishing
  agent disconnects.
- A remote drag paints dashed node outlines and reroute circles at the
  offset positions while the real entities stay put - the document only
  moves when the op commits on release. A remote actor's node and reroute
  selection rings ride that actor's own drag offsets, exactly like the local
  selection rides local drag. If multiple actors select one reroute, their
  halos use deterministic concentric radii so every actor color remains
  visible. The binding
  from a membership channel to the current graph is stable across document
  ops and local gesture completion: one participant dropping a node never
  clears another participant's still-active drag. The remote outline clears
  only when that remote actor's complete snapshot omits `drag`, the actor
  leaves, or the channel expires.
- A remote noodle resolves its semantic origin against the receiving scene
  and paints in that actor's deterministic color at reduced alpha with the
  same short dash as other presence ghosts. It is paint-only: it never enters
  the interaction overlay, hit testing, compatible-target calculation, or
  drop handling. Missing scene origins are ignored.
- Remote viewports paint on the minimap only (each actor's `view` rect in
  their color, beneath the local viewport rectangle, never affecting fit
  bounds) - the main canvas stays uncluttered.

Pinned by `client/test/presence-payload.test.ts` and
`app/test/collab-presence.test.ts` (schema incl. additive reroute
selection, generic drag, and noodle fields; old/new frame tolerance; complete
active-drag snapshots; noodle clear-on-end; stable projection across local
document/gesture updates, remote gesture end, throttle, heartbeat, TTL,
gone), `app/test/collab.test.ts` (relay
between memberships, departure on leave), `canvas/test/interaction.test.ts`
(drag-offset/hover callback discipline), `canvas/test/renderer-paint.test.ts`
(actor-colored reroute selection halo, offset reroute drag ghost, multiple
actors coexisting with unchanged node presence), and `canvas/test/minimap.test.ts` (remote viewport
rects).

## Leaving establishes a fresh history baseline

After leave (or end), the retained local tab starts with an empty undo
stack (`canUndo` is false). This is deliberate: shared history interleaves
other actors' server-ordered ops, so replaying pre-leave inverse patches
against the departed document is not meaningful. History works forward from
the new baseline as usual.

## Reload rejoin

A browser reload rejoins shared sessions instead of silently downgrading
their tabs to local forks. Only the membership persists (session id, base
URL, document lineage, tab title - `dinkster.collabSessions`, versioned
envelope like tabs and backends); the authoritative document is always the
server's. Membership identity is `(baseUrl, sessionId)` - the same session
id on two backends is two memberships.

- On every adopt/drop, AppState mirrors the live memberships from
  `collabTabs` (the single source of membership truth) into storage.
- At startup (`start()`, after backends connect), each persisted
  membership is bound to its RESTORED tab (same lineage id as the
  record's document) and probed with GET on the session:
  - Live: the session is re-adopted; the restored tab is replaced in
    place with the shared document - server state wins over the persisted
    tab snapshot. Rejoin never steals focus: the user's restored active
    tab stays active.
  - Gone (404), or the tab was not restored: the record dies silently.
    Rejoin never appends a fresh tab - a membership without its tab has
    nothing to rejoin into.
  - Transient failure (backend down, network): the tab stays local and
    the record survives for the next reload to retry.
- Rejoin is race-hardened: adoption commits only while the restored tab's
  exact DocumentSession still owns its id (the token is the store, not the
  Tab object, so an editor-kind switch during the flight does not cancel a
  valid rejoin). A tab the user closes or replaces while the probe or
  connect is in flight is never resurrected - the freshly created session
  transport is closed and the record dies, even when the flight itself then
  fails. An unresolved in-flight membership counts as pending, so persists
  that run mid-flight (or a crash before it settles) never lose the record.
  Concurrent rejoin calls single-flight per membership; nothing duplicates
  or leaks connections.
- Explicit leave/end/close removes the record - including a record whose
  rejoin failed transiently and is waiting for the next reload. Only a
  reload-shaped interruption rejoins.
- The reloaded client reuses its persisted actor id, so its own pre-reload
  ops replay during catch-up as "previous incarnation" history - adopted
  quietly, by the session core's design.
- Corrupt or version-mismatched storage means "no memberships" and never
  blocks startup.

Pinned by `app/test/collab.test.ts` "reload rejoin" (rejoin + convergence,
404 cleanup, transient retention, leave removal, malformed storage,
close/replace-during-rejoin races, pending-record death on explicit close,
per-backend membership identity, repeated-rejoin idempotence).

## Editor-readiness pins (document surfaces)

Dinkster's image editor and future Video, Audio, and Text editors use new editor
kinds (docs/editors.md). These pins make those surfaces collaborative and
agent-capable without reworking this layer.

- **Commands are the only mutation path, namespaced per surface.** Editors
  mutate shared state only by dispatching maintained serializable commands
  (the editor contract). Each surface gets its own command family -
  `image.*`, `video.*`, `audio.*`, `text.*` - registered in the same
  CommandRegistry. `image.applyAsset` is the first image command: it replaces
  one typed image AssetRef only while its source digest still matches, so a
  concurrent source replacement drops the pending apply during rebase.
  `text.splice` is another shipped precedent: its forward
  patch stays a whole-value replace so the backend remains semantics-blind
  and `protocolVersion` stays 1, while `transformForRebase` carries the
  range semantics client-side. New editor kinds must not require backend
  or wire changes; needing one is a design smell.
- **Ephemeral state rides presence, never the document.** Per-editor view
  state - playheads, brush cursors, timeline selections, crop handles -
  travels as additive fields in the client-owned presence payload
  (`client/src/presence-payload.ts`), namespaced per editor kind the way
  graph presence fields are graph-scoped today. Unknown fields are already
  ignored, so each editor's presence grows additively. Nothing ephemeral
  is ever written into shared document state.
- **Heavy media is referenced, never embedded.** Documents and commands
  reference image/video/audio content by asset digest; bytes travel the
  asset routes out of band. Ops and presence frames stay small enough to
  order, retain, replay, and relay.
- **Agent conventions generalize per surface.** Agents act through the
  same command families humans use, subject to the same backend permission
  categories. Actions a human should confirm follow the settings-proposal
  pattern: the agent publishes a proposal over presence and the human
  click is the only write path.
- **Hosting stays movable.** Ops are the replication unit and the session
  orderer is a movable seam (see the dinkster-collab README's future
  direction pins): peer-hosted sessions and short offline windows with
  rebase-on-reconnect must stay reachable, so nothing client-side may
  assume one permanent cloud server is the only possible orderer.

## Not in this slice

- Permissions UI: per-agent permission toggles are managed in the Backends
  panel for backends that expose `/api/principals`. The section stays hidden
  when the current principal lacks the `principals:manage` capability.
