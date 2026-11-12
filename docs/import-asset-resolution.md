# Imported asset resolution

Dinkster translates legacy ComfyUI LiteGraph workflows when `AppState.openDocument` receives their JSON. Widget arrays are mapped to schema input IDs. Legacy ASSET widget values remain strings until the user decides whether to replace them.

The core importer also accepts first-party replacement rules with import-only
node interfaces. These interfaces decode positional widgets without installing
the owning packs and never join the executable schema registry. Conversion
uses the ordinary replacement planner and preserves the source class, owning
pack and version on each translated node. Unknown classes keep their original
values for review. Versioned widget-stream upgrades run before conversion.
Conversion follows chained rules and newly created helper nodes, including
inside subgraph definitions, before resolving packs. A repeated source type
in a primary/helper ancestry stops that branch with a nonblocking diagnostic;
a same-type rule runs once. The final pack is reported while the original
source class remains available for review.
Repeated helper-local names receive deterministic unused names for each import
hop, with their port, family and construct addresses renamed together. Existing
helpers and the ordinary replacement command's collision checks stay intact.

Pack resolution is separate from conversion: translated nodes are installed
only when their exact native type exists in the selected backend registry,
otherwise installable from their recorded pack. Nodes with neither a schema
nor translation remain unknown. Recomputing resolution after a registry change
does not re-import or modify the document. The application import path still
uses its installed catalog unless translation records are supplied to the
selected backend's import catalog. With supplied records, opening does not
require the translated nodes' packs to be installed, but the executable schema
registry must be loaded. Import-only records do not bypass the application's
pre-schema refusal. The Problems panel groups installable nodes
by first-party pack name and shows each source class and graph/node identity.
This report is advisory: the document remains editable, unknown classes keep
their own diagnostics, and registry changes recompute the report without
replacing the document or its undo history.

Installed node schemas supply their ordinary replacement rules directly at
import time, even when no registry metadata is available. These rules take
precedence over fetched records for the same source class. Installed local
packs do not need a release version; absent pack/version provenance stays
absent rather than becoming a fabricated installation pin. Historical
Dinkster-document migrations remain separate from ComfyUI conversion.

Backend startup, schema changes and reconnects read `replacements/index.json`
under the Node catalog static prefix setting (`search.registryUrl`, default
`https://registry.dinkster.org/static`). Per-pack
`packs/<pack>/<version>/schemas.json` supplies import-only interfaces, including
conditional targets and helpers. These public reads omit backend credentials.
Conditional reads revalidate the connection-local index ETag and re-read pack
interfaces; a failed read never falls back to a stale or shipped catalog.
Duplicate-source index rows are invalid. Multiple candidates for one source
remain ambiguous placeholders with a named Problems entry rather than choosing
a pack silently. Alias discovery names use the unchanged canonical rule's
conversion with the authored source identity.

Successful refreshes publish the import catalog before the executable registry;
responses from an earlier server life and their failure warnings are discarded.
When the registry cannot be reached, missing-pack nodes keep their original
values and editable placeholders, with `import.registry.unreachable` naming
each class in Problems. Installed schema rules still convert normally. Clearing
the static prefix disables remote lookup and uses the same installed-only path.
There is no backend translation snapshot route or offline shipped copy.

The shared `DinksterConnection` client exposes `planPackInstall` for exact
pack/version selections and `applyPackInstall` for the server-held confirmation
token. Planning returns review text and does not install. A managed bare-host
plan returns a nonempty `commands` string array instead of `confirmation`;
the Problems panel shows and copies these exact host-supplied commands, without
an HTTP confirmation button. Run them in a terminal on the backend host to
plan and apply the managed generation. After activation and reconnect, the
existing document re-resolves against the newly installed schemas.
Desktop gateway plans return `confirmation` instead of `commands` and retain
the explicit HTTP confirmation flow. A response with both execution modes,
neither mode, or malformed commands is rejected. The `plan` member is an opaque
JSON object owned by the host; the renderer does not interpret that payload,
execute terminal commands, or send the plan back for execution.
Both methods accept an optional AbortSignal. Planning starts the shared
prepare/status/cancel lifecycle on either host. Short metadata reads keep their
30-second deadline, while actual stage and integrity-batch progress can carry
healthy preparation beyond 30 seconds. The UI shows that progress and permits
cancellation before confirmation. No progress for 120 seconds or more than
30 minutes overall reports a preparation failure, not a reconnect instruction.
A lost status read reports unavailable preparation status without retrying
preparation or applying. Cancellation requests cooperative stop, suppresses late
review results and leaves read-only cleanup owned by the host until it exits.
Editing/replacing the document, switching tabs or changing its backend cancels
the old observer. Cancelling an apply stops the caller's wait,
not the backend mutation; its outcome requires installed-catalog reconciliation.
Applying never retries automatically: a transport failure may have happened
after the host changed its installation. HTTP failures retain their status and
structured body as `PackInstallError`; absent opt-in routes remain unavailable.
Only a validated successful activation counts as completion. Callers refresh
the same backend's installed registry afterward; the client does not rewrite
the document or assume a topology-specific Desktop install path.

The Problems report offers review for one pack or all missing packs. The
backend's exact plan is shown before the terminal commands or gateway
confirmation; Cancel makes no installation request. Clipboard failures leave
the command text available for manual selection. Editing or replacing the document, switching tabs or
changing its selected backend invalidates the pending confirmation. Applying
uses the captured backend and refreshes that backend's schemas after successful
activation, without re-importing. Host refusals (including disabled routes),
expired plans and installation failures remain visible in the report; apply
is never retried automatically. The document stays editable during requests.

An empty string in an optional file widget omits that input while consuming its
original widget position. Required file widgets, nonempty filenames and named
source selections stay unchanged. Empty strings on ordinary text widgets remain
text; no file is inferred from an omitted optional input.

ASSET descriptors with `selection: true` retain named source choices rather than
ordinary file literals. Their exact kind is `model/vae`, `model/diffusers`,
`directory/input`, or `directory/dataset`; uploads are not permitted. They bind
to COMBO, or to the COMBO/ASSET union for `model/vae` only. Imported source names
stay unchanged and do not enter file guessing or automatic descriptor
replacement, including when carried by a value source. Backend resolution can
select a file, a directory, a VAE pair, or a built-in choice such as `pixel_space`.

For ordinary file literals on a native Dinkster connection, the app looks up the strings with `POST /api/assets/guess` after translation. Canonical blake3 hints from the workflow's top-level ComfyUI `models` metadata are sent as `digestHints` for their original imported names. Names that include subdirectories are also queried by basename, but those added basename queries remain unhinted. Basename candidates remain attached to the original imported string and count only as exact-name signals. The lookup does not fetch assets.

Complete candidates can be applied without a prompt. A `blake3` digest in the workflow's top-level ComfyUI `models` metadata is authoritative; other hash types remain provenance only. An exact `digest`-confidence candidate matching that workflow hint is the strongest evidence tier. Same-digest duplicates choose the lexically first virtual path. A hint-free retry against a pre-amendment backend can still use a complete candidate with the authoritative workflow digest. Without a digest hint, one digest at the exact path tier, or at the case-sensitive basename tier when no path match exists, is deterministic and is applied. Conflicting digests, a workflow digest that matches no candidate, weak confidence tiers, and missing candidates remain unresolved. A digest-known miss never falls back to filename similarity. All automatic replacements from one import are one command batch, one revision, and one undo step, with an info diagnostic recording the original string, selected virtual path, and digest.

A decision modal is installed only for unresolved names. Its summary separates names needing review, selected replacements, and names that remain unresolved. Each name retains the exact imported string and lists the server's ranked candidates with confidence, availability, digest, virtual path, media type, size, and pack facts when supplied. The reason identifies a digest conflict, ambiguous distinct digests, only weak matches, or no complete match.

An unresolved row preselects its first candidate only for `path` and `name` confidence and only when it has a complete executable descriptor: canonical blake3 digest, string name, safe nonnegative integer size, string media type, and string virtual path. `held` is informational, not an eligibility requirement. Incomplete candidates remain visible with an explanation but are disabled. `name-insensitive`, `stem`, unknown future tiers, and unmatched names remain unresolved until explicitly selected. Labels are:

- `digest`: exact digest
- `path`: path match
- `name`: exact name
- `name-insensitive`: case differs
- `stem`: extension differs, with a caution to verify the asset
- unknown future tiers: other match

Candidate rows also show held status, declaring pack IDs, and size when supplied. Accept selected replaces each chosen string with the complete `{digest, name, size, mediaType, virtualPath}` ASSET value. Descriptor fields are never invented. All replacements are one command batch and therefore one undo step. Unselected and unmatched names keep their imported string values. Normal execution preflight and asset acquisition consent are unchanged.

Automatic resolution waits for final command acceptance before recording
provenance or offering leftover names. Closed or replaced stores and changed
backend registries cannot receive a stale completion prompt. Manual Accept
keeps the dialog and exact choices while pending, disables candidate changes
and duplicate acceptance, and closes only on acceptance. Refusal leaves the
choices available for retry. Dismissing a pending dialog does not cancel the
submitted command; its completion cannot reopen the dialog or close a newer
request.

Each unresolved name is one product radiogroup. Leave unresolved is selected when that name has no chosen candidate. Candidate accessible names include all visible metadata and warnings, including incomplete-descriptor and different-extension cautions. All four arrow keys move and select within the group, wrap at the ends, and skip incomplete disabled candidates. Focus movement alone does not write the workflow; Accept selected remains the only document commit.

The host-owned native modal provides focus containment, background inertness, and opener-focus restoration. Escape, backdrop, close, and Skip dismiss the decision without submitting further changes. Host-authored labels, notices, warnings, accessibility names, and staged-count status follow the active locale while the modal remains open. Imported names and candidate digest, path, media, mount and pack identifiers, size, and backend-provided values remain exact. The candidate list scrolls independently so long metadata, warnings, disabled candidates, and the action footer remain reachable on narrow screens and at 200 percent CSS zoom. The decision follows its document when the local tab is promoted to the shared workspace, but a same-lineage document replacement invalidates it. Lookup failures stay outside the decision and appear in Problems; closing the imported document while lookup is in flight prevents a stale decision from opening.

The representative failed-run document `blake3:5932696ceb7c52ed03f0566144103a929047ec68669bebac04aa5efc1f8f3a9a` exposed the exact malformed shape: checkpoint digest `blake3:4c50ebc6e2a5cb19e8d19626d5ede1fb64755562085ce7383d86c72d1d03eb7e`, name `v1-5-pruned-emaonly-fp16.safetensors`, size `2132696762`, and media type `application/octet-stream`, with only `virtualPath` missing. The live guess response supplies `mounts/comfy-model-checkpoints-1/v1-5-pruned-emaonly-fp16.safetensors`; the browser proof uses those values. Asset resolution is not tied to a node id or class-name heuristic.

LiteGraph filename prefixes remain ordinary STRING values. An optional scalar STRING mount input uses the MOUNT presentation independently; null or omission selects the backend snapshot's default output mount. Import never combines the two values or derives a mount from a prefix or node name.

The `DinksterConnection.guessAssets` client batches at 64 names per sequential request, preserves response order, and maps unknown confidence values to `other` rather than rejecting a response. Each batch sends only its own canonical lowercase blake3 hints, skips malformed hints, omits an empty `digestHints` field, and retries a hinted HTTP 400 exactly once without hints for pre-amendment backends. Other failures retain their normal error behavior.

## Dynamic construct compatibility

Imported `CreateList` and `GetItemFromList` retain their registered native
identities. Their schemas own family members, widgets, and output names;
the importer adds no collection, tuple, singleton, or index-selection nodes.
Native node execution concatenates declared list envelopes and treats scalar
envelopes as single elements, without inspecting payload shape. A list-valued
index is admitted only when the input declares whole-list consumption.

Declared list outputs feeding ordinary scalar inputs are persisted as explicit
map regions. Linked scalar inputs consume elements while other widget values
broadcast unchanged. Mapping propagates through connected consumers regardless
of serialized node order, including reroutes and named nets. Output-only
consumers are mapped as well. Expanding controls retain their native paths.

Native catalogs that register an expanding `StartLoop` retain the registered
loop nodes for engine execution. List-backed `EndLoop` results use an explicit
flatten map to preserve the source execution-list shape; scalar results keep
their ordinary result list. Legacy schemas use structural region
translation. Promoted widgets retain their authored instance values through
generated loop definitions, including nested loops inside imported subgraphs.

ComfyUI serializes widget values positionally. For a DynamicCombo it writes
the selector first, then the selected branch's widget values in schema order,
then resumes the containing branch or node. Dinkster's importer decodes that
stream recursively and persists branch values with the same keys used by the
normal elaboration path, such as `model.[wan2.7-r2v].prompt`. Controller
companions such as `control_after_generate` consume their extra position and
preserve their stored mode inside branches exactly as they do at node top
level. Changing or advancing a nested controller remains deferred because the
controller command and execution paths currently resolve top-level inputs.

If a selector is not a valid schema branch, import keeps the schema default,
emits `import.dynamic.unknownSelector`, stops decoding that node, and stores
the unaligned tail in `ext["importer.excessWidgetValues"]`. It never assigns
later values after positional alignment is lost.

Autogrow links are reconstructed from the current node schema. Prefix families
accept their declared ordinal vocabulary and grouped forms; names families
accept only declared member names. Recognized links create persisted members
and member-qualified Dinkster endpoints instead of retaining ComfyUI wire names.
Unlinked socket-only placeholders do not create members beyond the declared
minimum. Widget-backed members retain their authored values and order.
Prefix member IDs follow first linked input-slot appearance, not numeric or
object-key sorting: sparse or out-of-order `image2`, `image0` becomes `m0`,
`m1`. Names families retain the declared name as identity. A family-scoped
wire name that matches no declared family emits
`import.dynamic.autogrowWireUnknown` and remains unresolved rather than being
guessed.

Positional Autogrow widget values remain deferred. Encountering Autogrow at
node top level or while traversing an active DynamicCombo branch emits
`import.dynamic.autogrowUnsupported`, stops decoding that node, and preserves
the remaining positional values in the same excess-value extension. Link
cardinality alone does not establish an unambiguous foreign widget walk, so
the importer does not guess-assign that tail. DynamicSlot is not traversed or
treated as a stop boundary; if ComfyUI
serializes connected slot dependents positionally, later values may still be
misaligned. Its foreign positional/connectivity semantics and LiteGraph
subgraph definitions are deferred; see `rework-queue.md`.

## Backend compat-boundary porting (server-side, informational)

Independent of this client-side flow, the backend's ComfyUI compat prompt boundary (`POST /api/compat/comfy/prompt`, Dinkster commit 26bbc68) ports legacy string `image` inputs on `comfy.LoadImage` server-side: exact-path lookup on the derived `comfy-input` mount converts them to native asset wire values, and the translated graph never carries a filename. Failures return anchored problem codes on the 400 response: `prompt.load_image.invalid` (absolute path, traversal, non-string) and `prompt.load_image.unresolved` (name not cataloged on `comfy-input`). Unresolved problems direct clients to `POST /api/assets/guess` - the same resolver this dialog uses - and the backend never substitutes by name silently.

Deferred backend-side (their roadmap, coordinate before building against either): legacy model-loader name porting (`ckpt_name` and similar) and embedding guess candidates inline in unresolved problem payloads for one-round-trip resolution.
