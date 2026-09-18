# Maintenance Hazards: invariants that keep former minefields defused

Status: living document. Add an entry whenever a design review or bug reveals
a "this will bite us later unless X stays true" condition.

The old frontend's worst areas (reroutes above all) were not broken by one bad
commit; they eroded, one convenient shortcut at a time, because nothing wrote
down which properties were load-bearing. This file is that writeup for Dinkster.
Each entry states the invariant, why it exists (usually: the exact way
litegraph/ComfyUI_frontend got it wrong), and the failure mode if it breaks.

## Canvas pointer gestures

### P1. Pointer capture is an optimization, never the gesture transport

Safari may throw from `setPointerCapture`, silently leave capture unset, or
revoke it before a final `pointerup`. The canvas controller must establish
pointer ownership before attempting capture and retain window-level
`pointermove`, `pointerup`, and `pointercancel` fallbacks. Capture and release
calls stay guarded. Do not add `buttons !== 1` termination checks: macOS
trackpad move streams can report `buttons === 0` while the gesture is active.

Failure mode if broken: releasing a noodle outside the canvas or after a
capture failure loses the drop and can leave the gesture wedged.

### P2. Link terminal events use the last rendered position exactly once

For link drags, `pointercancel` and unexpected `lostpointercapture` are
release-like terminal events because macOS/Safari can emit either without a
usable `pointerup`. If the last tracked world position resolves to a legal
drop target, commit there. Otherwise cancel cleanly: do not disconnect a
rewire and do not open the empty-drop palette. Clear ownership before
releasing capture so synchronous capture-loss reentrancy and a late
`pointerup` cannot double-commit. Other explicit cancellation paths (Escape,
blur, dispose, or stale-scene cancellation) retain their existing semantics.

Ctrl+left-click may synthesize `contextmenu` before release on macOS. Opening
the context menu first cancels any owned canvas gesture, preventing the later
secondary-semantics release from activating a half-started press.

Failure mode if broken: noodle drops intermittently disappear or duplicate,
rewires disconnect on an abnormal release, or Ctrl-click leaves a stuck drag.

### P3. Missed-release recovery reacts to contradicting events, never to time

macOS trackpads can drop the final `pointerup` entirely while the pointer is
stationary, leaving a gesture stuck until the next move. Recovery listens for
events that contradict a held button instead of guessing from a timer: a
compatibility `mouseup` for the initiating button commits with full pointerup
semantics at the event position; a `pointerdown` that re-presses the button
the gesture believes is already held (or whose `buttons` snapshot lacks it)
and a `wheel` with `buttons === 0` recover conservatively - moved move-family
and link gestures commit at the last tracked position, everything else
cancels, and empty-move-source disconnect never applies. Do not add a blind
timeout: a stationary held drag is indistinguishable from a stuck lift, and a
timer would release gestures the user still holds. The `mouseup` and `wheel`
signals apply only to mouse-typed gestures: a physical mouse's events are
indistinguishable from a pen's compatibility events, so acting on them could
end a drag the pen still holds - pen and touch gestures recover only through
the re-press signal and their existing strict policies. Middle-button pan
cancels its `pointerdown`, which suppresses compatibility mouse events, so it
relies on the re-press and wheel signals rather than `mouseup`. A press that
captures the pointer but starts no gesture (badge clicks, inert pins, failed
link starts) must release ownership immediately: every recovery requires an
active gesture, so stale idle ownership would swallow all later presses.

Failure mode if broken: either a lifted trackpad press stays stuck and
swallows the next click (the recovery this exists for), or - if someone
"simplifies" to a timeout - long deliberate drags start self-releasing.

### P4. Two-finger touch navigation owns all pointers while active

Two live touch points start viewport navigation (`touch-nav.ts` math,
tracked in `InteractionController.touchPoints`/`touchNav`). Navigation is
NOT a `Gesture`: like wheel navigation it only calls `renderer.setViewport`, so it
deliberately survives scene replacement and `cancelGesture`, and Escape does
not end it. The invariants:

- A second finger CANCELS a touch-owned one-finger gesture
  (`touch-nav-takeover`), never commits it - consistent with the strict
  touch pointercancel policy above. A mouse- or pen-owned gesture keeps
  ownership; the touches stay inert.
- While navigation is live, every other pointerdown (extra fingers, mouse,
  pen) is swallowed. Extra fingers never re-pair or queue.
- A participant lift or pointercancel ends navigation. The remaining finger
  is inert (hover only) until it participates in a NEW two-finger pair.
- Pointer capture stays an optimization (P1): window fallbacks forward any
  tracked touch pointer, not just the gesture owner (`ownsPointer`).
- No timers. Blur and dispose clear all touch tracking, because a stale
  entry would let a later single touch masquerade as a pair.

Failure mode if broken: a second finger commits a half-finished drag as a
document edit, a mouse click mid-pinch starts a gesture that fights the
moving viewport, or a stale touch entry makes the first tap after app
switch zoom wildly instead of selecting.

## Reroutes

The old frontend had TWO reroute implementations: a fake `Reroute` node type
(custom-node era), and native reroutes stored as `extra.reroutes` waypoints
with mutable `parentId` chains threaded through link objects. The native one
interacted catastrophically with subgraphs, undo, and dynamic types, and both
propagated types by mutating wildcard slots in `onConnectionsChange`
callbacks. Every entry below exists to make one of those failure modes
structurally impossible. Keep it that way.

### R1. Exactly one tracing implementation

`traceEndpoint` in `packages/core/src/reroute.ts` is the ONLY code that
answers "what really drives this endpoint". The compiler, the semantic hash,
and the scene builder all call it. Never write a second upstream-walking loop,
even a "simpler local one" - the hash-vs-compiler divergence bug caught in
review (undriven chains hashed as dangling pairs while the compiler omitted
them) is exactly what a second implementation produces. If you need different
trace output, extend `RerouteTrace`, do not fork the walk.

Failure mode if broken: frozen views dirty (or fail to dirty) on edits that
do (or do not) change execution; sync badges lie to the user.

### R2. Derive the effective type; never store it

A reroute has NO type field anywhere - not in the document, not cached on the
scene object between builds, not in view state. Color and compatibility are
traced upstream on scene build. Litegraph stored resolved types in mutable
wildcard slots; a slot that captured a type (or `*`) once kept it forever,
which is the root of most historical reroute/subgraph type bugs.

Failure mode if broken: stale types after undo, after driver rewires, and at
subgraph boundaries; "it shows IMAGE but connects as *" class of bugs.

### R3. Reroutes are definition-scoped; no parent chains

A reroute lives in exactly one `GraphDef`, referenced only by that
definition's links. There is no `parentId`, no reverse `linkIds` array, no
cross-graph reference of any kind. Subgraph correctness is free BECAUSE links
cannot cross definitions - it is not enforced by reroute code, and no reroute
code should ever need to know subgraphs exist. Litegraph's native reroutes
kept parent chains on link objects that had to be fixed up on every
copy/paste/subgraph-extract, and never fully were.

Failure mode if broken: copying a subgraph half-copies a chain; deleting a
graph leaks reroutes; every structural command grows fix-up code.

### R4. Execution and the wire format never see reroutes

The compiler lowers reroutes away (structural feeds omitted, consumer links
traced to the real producer). Prompts, `/history`, the execution store, and
runtime node IDs are reroute-free. Undriven or cyclic chains compile exactly
like an absent link, with a diagnostic.

Failure mode if broken: backend validation errors from junction artifacts;
progress/error events keyed to IDs that do not exist in any graph.

### R5. Pure reroute edits are semantic-hash neutral

Inserting, moving, chaining, or dissolving reroutes (and editing `ext` on
structural feed links - see R6) must never change `semanticHashOf`. This is
what lets users tidy noodles while a workflow runs without the frozen view
reporting divergence. Guarded by tests in `packages/core/test/reroute.test.ts`
("hash-neutral" cases); extend those tests with any new reroute operation.

### R6. Link `ext` is semantic only on consumer-delivering segments

On a link whose `to` is a reroute, `ext` is view-only: the hash ignores it and
dissolve preserves only the consumer segment's `ext`. Documented on `LinkData`.
If an extension ever needs semantic data on structural feeds, that is a
design change requiring an explicit merge contract - do not just add it to
the hash, and do not "fix" dissolve to concatenate exts.

### R7. One driver, acyclic - enforced, not assumed

At most one link may target a reroute; chains are acyclic. `validate.ts`,
`invariants.ts`, and the command layer (cycle checks in `link.connect`/
`link.rewire`/`reroute.*`) all enforce this. Every NEW command that touches
links or reroutes must run `checkDocument` in its tests; the invariant only
holds because commands cannot commit a violating document.

Failure mode if broken: infinite loops in tracing (R1 defends with visited
sets, but downstream code assumes termination), ambiguous lowering.

### R8. The endpoint union is a permanent tax - pay it every time

`LinkEndpoint` is `port | reroute`. Every new feature that reads or writes
links (menus, gestures, dynamic outputs, serialization, analytics) must
handle both arms. TypeScript catches most omissions, but NOT in weakly-typed
areas: gesture code, hit-testing, and anything doing structural filtering by
shape. The two interaction bugs found at review time (Delete ignoring
reroute-only selections; link drops resolving reroutes with different
priority than hover) were both in exactly this blind spot.

Concrete rules that fell out of those bugs:
- Pointer-drop resolution goes through the single `hitTest` so priority
  (pins > node bodies > reroute dots > noodles) has one definition. Never
  call `hitTestReroute`/`hitTestPin` directly to resolve a gesture.
- Any code that enumerates "the selection" must consider all three kinds:
  nodes, links, reroutes.

### R9. Keep tracing out of hot loops

`traceEndpoint` is O(chain length) and runs at scene-build/compile/hash time,
never per-frame. The perf spec's reroute-on-every-link variant
(`packages/e2e/tests/perf.spec.ts`) is the regression gate; keep it passing
and keep tracing calls out of `render()`/pointer-move paths.

### R10. Importer absorption stays import-only

The legacy importer's absorbed-reroute classification (chains feeding only
SetNodes collapse into their nets) is intricate by necessity. It is one-way,
runs only at import, and must never leak into the live editing model - the
editor has no concept of an "absorbed" reroute. If import output looks wrong,
fix the classification; do not add editor-side compensation.

## Primitives / value sources

The legacy frontend PrimitiveNode (`widgetInputs.ts`) is the other historical
minefield: a virtual `*`-output node that adopted the FIRST connected input's
widget by cloning it, stored the adoption as mutation (output type, widget
object, symbol-keyed config on the output slot), and delivered its value by
write-through mutation of consumer widgets at queue time (`applyToGraph`).
The fallout was structural: disconnect deleted the widget (value loss),
rewiring order changed behavior, control_after_generate became phantom
positional widgets, and special cases metastasized into app.ts, groupNode.ts,
ExecutableNodeDTO, and an entire subgraph migration (`primitiveBypass`).
Dinkster's value source (architecture section 5b) exists to make each of those
impossible. Invariants:

### P1. Declared spec is authoritative and serialized; derivation only fills gaps

The document stores value + optional declared partial spec + controller
state. The effective spec = declared fields verbatim, undeclared fields
unified from consumers. Never store a derived field back into the document,
and never let a connection event write spec state ("first connection wins" is
the legacy bug). Consequence to preserve: a fully-declared source is static,
so derivation can be narrowed or removed later without breaking saved
workflows. If a feature ever requires persisting a derived spec, that is a
design regression - stop and redesign.

### P2. The value is never hostage to the spec

Disconnected source, conflicting consumers, value outside current options,
option list unavailable: diagnostic + raw-value fallback view. NEVER reset
the value, never delete widget state. Same policy as remote combos - one
rule, no exceptions.

### P3. Spec derivation lives in the solver, never elaboration

Deriving a source's spec from consumer interfaces is a downstream-to-source
flow through the existing constraint machinery. Elaboration must stay
ignorant of it (the no-type-feedback DAG invariant). If someone "just reads
the consumer's elaborated widget spec during elaboration", connect-order
sensitivity returns.

### P4. No write-through into consumers - the compiler bakes

A value source's value reaches execution exclusively by the compiler baking
it into each consumer's input in the CompileArtifact. Never mutate a
consumer's stored widget value from a source (the legacy `applyToGraph`
pattern). Breaking this corrupts semantic hashing, frozen-view divergence,
and undo in one stroke.

### P5. Constraint merging is per-kind, closed, and deterministic

Merge rules (range intersection, option intersection, ...) are defined by the
WidgetKind contract, not ad-hoc per call site. An empty merge is a
diagnostic, never a silent pick-one. Adding a widget kind means declaring its
merge rule explicitly or opting out of derivation.

## Dynamic families through subgraph boundaries (forwarding)

The old frontend mutates the shared definition's slot arrays when an instance
connects to a dynamic input, then compensates across every other instance and
nesting level - the bookkeeping nightmare that makes autogrow-in-subgraphs
untrustworthy there. Forwarding (a boundary item exposing a whole inner
family, including split forwarding: definition-local prefix members plus
instance-appended suffix members) is designed so that class of bug is
structurally impossible. These invariants are what keep it that way.

### F1. Member state never merges; only derived artifacts do

Definition-local members persist on the inner node inside the definition
(shared by all instances, like every other definition edit). Instance members
persist on the instance node in its parent graph. The concatenated list
exists ONLY in derived state: the flattener synthesizes a per-occurrence
merged `DynamicPortState` and feeds it to the SAME `elaborateInterface` - no
family-aware fork of elaboration, no persisted merged list, ever.

Failure mode if broken: one list with definition-wide undo semantics in one
segment and per-instance semantics in the other - the braided-state cascade
this design exists to prevent.

### F2. Ordering is pinned: definition prefix, then instance suffix

Recursively for nested forwarding: innermost definition's members first.
Ordinals (and therefore positional api names and labels) are assigned over
the merged list per occurrence at compile/derive time. Never invent a second
ordering, never let view code sort members, never persist ordinals.

Failure mode if broken: instances silently feeding the wrong wire inputs
after a definition edit.

### F3. Renumbering is correct; identity is the member id

A definition adding/removing a prefix member shifts every instance's ordinals
and labels. That is truthful, deterministic, and harmless BECAUSE nothing in
any document keys on ordinal: links and values key on stable member ids,
api names are compile output. Any feature that stores an ordinal (or a label)
as identity reintroduces the positional-widget-array bug this project was
started to kill.

### F4. Capacity arithmetic is baked into the derived schema

`deriveBoundarySchema` computes the forwarded family's effective bounds
(min/max reduced by the prefix count) and the label/ordinal offset, and bakes
them into the derived spec. Instances never inspect definition internals at
runtime; a definition change rederives the boundary schema (the existing
invalidation path). Definition-local members exceeding the family cap is a
derive-time diagnostic; exactly-at-cap is legal (instances see no ghost).

### F5. Ghosts are per-view affordances, never shared

The trailing ghost member is synthesized by elaboration, never persisted,
never compiled. The definition editor's ghost and each instance's ghost are
therefore independent by construction. Any "optimization" that persists a
ghost or shares it across views recreates the two-owners-of-one-slot cascade.

### F6. Compilation discovers every occurrence before resolving anything

Forwarding makes an inner node's effective interface OCCURRENCE-dependent.
The compiler is therefore phased: (1) walk the complete occurrence tree
outside-in, building every parent->child crossing, occurrence-local
dynamic-state overlay, and projected connectivity; (2) resolve promoted
values; (3) lower values/links/nets. Promoted-value resolution is deferred
(`pendingPromotions`, still outside-in for first-write-wins) because a
chained value can cross several boundaries whose crossings must all already
exist. Do not "simplify" by resolving values during discovery - chained
forwarding breaks the moment a resolver needs a context that has not been
created yet. Type solving and partial-execution topology must eventually
consume this same effective occurrence graph, not rebuild their own.

### F7. One crossing abstraction owns all boundary address interpretation

`crossing.ts` is the ONLY interpreter of forwarded addresses. The same
`FamilyCrossing` (built from the same `resolveBoundaryRoute` schema
derivation uses) owns: outer address -> inner endpoint translation, suffix
member-id rebasing, nested `memberState` key rebasing (boundary id -> inner
construct path), state overlays, connectivity projection, promoted-value
translation, and input/output symmetry. Boundary ITEM selection is part of
this: ids may legally contain '.', so `matchBoundaryItem` enumerates every
candidate interpretation and requires exactly one fit (first-segment
shortcuts and longest-prefix-wins are banned, same as
`resolveBoundaryRoute`); a genuine collision is an explicit ambiguity
diagnostic, never a silent pick. Any second, "local" re-parse of a stamped
path for one concern is how the legacy frontend's boundary bookkeeping
became a minefield; extend the crossing instead.

Nested routes must also be MATERIALIZED: every concrete ancestor member a
forwarding route crosses must be present in that family's persisted
`members` list at the corresponding scope (orphan `memberState` proves
nothing - `members` is the sole membership source, F3). An absent ancestor
is a compile error at the instance site; silently deriving state beneath it
would strand the instance suffix unreachably.

### F8. Rebased ids are derived, occurrence-local, and unmintable

Instance-appended suffix members project into the inner node's namespace
under NUL-prefixed rebased ids (one prefix accumulates per crossing when
chained). They exist only in per-compile derived state - never in documents,
never in commands, and NUL is unmintable by user input, so they can never
collide with definition prefix ids. Persisting a rebased id, or exposing one
through any interface a document could echo back, breaks the identity model.

### F9. Occurrence-local elaboration must not leak between occurrences

A forwarded target elaborates per occurrence (overlay + projected
connectivity); everything else keeps the per-definition cache. The two
caches key differently and must never mix: a definition-cache hit for an
overlaid node silently shows one instance another instance's members - the
exact cross-instance leak F1 exists to prevent. The occurrence cache keys on
the full occurrence key (instance path + node), which is injective because
ids cannot contain the packing character.

### F10. Slot selection filters the derived template, never identity

Slot-selective forwarding (`binds.slots`) filters WHICH template slots the
derived family exposes, in TEMPLATE order regardless of listing order. It
never touches member ids, stored values, capacity arithmetic (F4), or
ordinal offsets - toggling or removing the selection only re-derives the
boundary schema. A family still has ONE forwarding owner (F1); selection
never splits a family across two boundary items, which would need synced
member lists. Instance-appended members stamp the FULL template on the inner
node: unexposed widget-backed slots compile their template defaults, and a
selection leaving a required socket-only slot unexposed on a growable input
family is a DERIVE-TIME error (`boundary.slotStarved`), not a per-instance
compile surprise. Addresses under unexposed slots fail crossing translation
loudly (`compile.boundary.slotNotExposed`); stale VALUES under them are
dormant preserved state, like removed members. An explicit full selection is
NOT redundant with absence: it pins exposure across schema evolution
(template slots added later stay hidden until selected).

Entries are DOTTED PATHS: a bare id exposes a slot (for a nested autogrow,
its whole subtree, tracking nested schema evolution); 'sub.s' exposes the
nested construct NARROWED to the listed descendants, with ancestor exposure
implied. Splitting on '.' is the field's own grammar, never id parsing -
template slot ids may not contain dots (`elab.id.reserved` warns; the safe
id set is `[A-Za-z0-9_-]+`, with all structural punctuation reserved for
future selector/address syntax). Whole-subtree and narrowed selection of the
same construct are mutually exclusive (`boundary.slotConflict`); narrowing
recurses through autogrow constructs only (`boundary.slotNotNestable`).
Starvation is selection-aware with one deliberate asymmetry: hiding a whole
min-0 nested family is legal (it materializes nothing), but a NARROWED
nested family is exposed and growable from the instance, so a hidden
required socket-only slot inside it starves regardless of its min. Crossing
exposure matches segment-wise: an address at/under a selected path is
exposed, and so is an ANCESTOR construct of one (growth and member state
target the construct itself); everything else is stale and fails loudly.

## Type-driven dynamic constructs

The tempting design for "this slot changes based on what type is plugged in"
is letting elaboration look at types - which is the solving->elaboration
feedback edge the whole pipeline exists to prevent. The settled mechanism
(architecture section 3) is a materialized choice; these invariants keep it
from regressing into the callback cascade.

### T1. Specialization is a stored choice, never a solved type

The connect gesture writes the chosen variant into the node's stored values;
elaboration reads only (schema, stored values, link existence), as always.
Two reads stay forbidden no matter how convenient: elaboration reading
solved types, and elaboration reading another node's elaborated interface
(declared-type dispatch was rejected - cross-node elaboration reads can
cycle once producer ports are themselves dynamic). A future construct that
seems to need either gets an explicit, documented stratification or gets
rejected - never a special case.

Failure mode if broken: fixpoint elaboration, ordering-sensitive "connect A
then B differs from B then A" bugs - the legacy frontend's cascade.

### T2. Stale choices are diagnostics, never auto-repairs

An upstream type change makes the stored variant stale; the advisory solver
marks the mismatch. Only a user-visible command may rewrite the stored
choice - no derive-time "helpful" rewriting, which would be document mutation
from derived state and would break undo, replay, and exact reproduction.

## Nested dynamics and member paths

Dynamic constructs nest arbitrarily inside Autogrow templates - including
Autogrow-in-Autogrow - because custom packs invent their own dynamic schemes
and the system must absorb them without hacks. The generalization is bought
with exactly one identity change (member id -> member-id path) plus the
invariants below; each one closes a treadmill the design review identified.

### N1. Member identity is a path of stable ids; ordering lives in ONE place

`PortRef.members` is one generated id per family crossed, outermost first.
The family's `members` list is the sole ordering source; nested per-member
state lives in member-ID-KEYED metadata (`memberState[id]`), never in
array-indexed structures (an array-index patch changes meaning when an
earlier member is removed). Ids are never recycled (`seq` is monotonic),
never derived from ordinals, labels, or api names.

### N2. One canonical state representation - no unions, ever

`DynamicPortState` has exactly one serialized shape. Two representations of
the same state ("string member" vs "object member") would give equivalent
documents different semantic hashes, different patch paths, and different
validation branches - canonical form must not depend on which command last
touched the state. Terse authoring belongs in test builders, not the format.

### N3. Materialization is atomic and command-side

A gesture on any port in a ghost subtree (connect, assign, select) is ONE
transaction: materialize implicit minimum ancestors, promote the single
ghost ancestor, bump each affected family's `seq`, write the link/value/
selection, one undo step. "Normalization catches up a frame later" is not a
valid steady state: a committed document never references unmaterialized
members, and a loaded violation is a diagnostic - elaboration NEVER mutates
state to compensate. At most one ghost ancestor exists on any rendered
address (no ghosts under ghosts), so promotion is never ambiguous.

### N4. Handlers get a scope-local state cursor and compositional ancestry

Entering a member hands the child scope that member's nested state as its
root; combo/slot scopes extend a local prefix. Handlers NEVER resolve state
by walking or parsing paths outward - that couples the accessor to every
dynamic kind. Elaborated ancestry (member path, ghost flag) is orthogonal
to the leaf role (member/selector/branch/slot/dependent), and ghost-subtree
compile exclusion is enforced centrally by scoped emission - a third-party
handler must not be able to accidentally compile a ghost descendant.

### N5. Hard budgets, not warnings

Nested caps multiply (10^depth). Parser, validator, and elaborator enforce
hard depth AND total-item/port budgets that fail deterministically (declared
/member order) with ONE error - never exponential work followed by a warning,
never a silently truncated prompt.

### N6. Packed keys are opaque and injective

`items.sub#m0#g0` is an address-derived key for value maps and elab keys.
It is built from structured `PortAddress` only, via the canonical helpers
(`portAddressKey`/`samePortAddress` and kin) - every endpoint comparison
uses them, no ad hoc packing. Nothing ever splits a stored key to recover
semantics, and reserved characters are strictly rejected in ids (injectivity
is load-bearing). Safe because segments are stable ids, not ordinals; it
becomes the positional bug again the moment a member id is recomputed from
position.

## General watch-list (non-reroute)

- **Named nets are port-only hyperedges.** A net's source/sinks are node
  ports, never reroutes (reroutes feeding nets collapse at import; the UI
  never offers a reroute as a net endpoint). Loosening this quietly recreates
  litegraph's Get/Set-through-Reroute ambiguity.
- **Frozen tabs reject ALL commands centrally** (`app-state.ts::dispatchTo`).
  Never add a per-feature "but this edit is harmless on frozen tabs" carve-out;
  route legitimate needs through a new read-only channel instead.
- **Formats: v1 is unstable pre-release and revised in place.** Validate
  upgradeability with tests, but do not accrete internal-only version bumps.
- **No second copy of graph state.** The document store is the single source;
  scene/overlay are derived projections. The old frontend's 6-layer sync
  (litegraph objects / JSON / Vue mirrors / Pinia / Yjs) is the cautionary
  tale - if a feature "just needs a little mirror state", derive it or put it
  in the document.

## Lessons from the pack audit (see node-pack-extension-audit.md)

Failure modes observed in the wild that our contracts must not re-enable:

- **Paste/clone identity races.** KJNodes Set/Get coordinates pasted pairs via
  a module-global rename map cleared on `setTimeout(0)` - it breaks the moment
  paste ordering is async or two pairs share an old name. Our rule: anything
  that must survive copy/paste rides the document (IDs, extension data), never
  module state keyed by timing.
- **Inferred topology + subgraphs do not mix.** cg-use-everywhere's
  regex/color-matched links require wrapping convertToSubgraph and a
  four-way link classifier to survive one subgraph conversion, with documented
  years of breakage. Named nets stay explicit and port-anchored precisely to
  avoid this; never add "smart" matching to them.
- **Version probing.** KJNodes introspects frontend function source to decide
  which private prototype to patch. The API surface must be versioned so
  capability detection is a lookup, not source-string sniffing.
- **Hidden-widget side channels.** Packs pair a visible editor with hidden
  widgets whose values the backend actually reads (spline points_store vs
  coordinates). In Dinkster that pattern is declared companion values on a
  WidgetKind - two secretly-coupled widgets are a smell, not a technique.
- **Queue-time mutation of the editable graph.** rgthree's Random Unmuter and
  UE both mutate the live graph during graphToPrompt and restore it after -
  any crash mid-queue corrupts the document. Compile reads the document; it
  never writes it. Controllers resolve into the snapshot instead.
- **Results routed to "whatever is open".** Every result/preview display in
  the audited packs assumes the current canvas is the executing workflow.
  All channel payloads (previews, results, pack events) are keyed by
  execution id and route to that execution's snapshot/frozen view.
