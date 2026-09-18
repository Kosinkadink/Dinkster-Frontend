# Imported asset resolution

Dinkster translates legacy ComfyUI LiteGraph workflows when `AppState.openDocument` receives their JSON. Widget arrays are mapped to schema input IDs. Legacy ASSET widget values remain strings until the user decides whether to replace them.

For a native Dinkster connection, the app looks up those strings with `POST /api/assets/guess` after translation. Canonical blake3 hints from the workflow's top-level ComfyUI `models` metadata are sent as `digestHints` for their original imported names. Names that include subdirectories are also queried by basename, but those added basename queries remain unhinted. Basename candidates remain attached to the original imported string and count only as exact-name signals. The lookup does not fetch assets.

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

Each unresolved name is one product radiogroup. Leave unresolved is selected when that name has no chosen candidate. Candidate accessible names include all visible metadata and warnings, including incomplete-descriptor and different-extension cautions. All four arrow keys move and select within the group, wrap at the ends, and skip incomplete disabled candidates. Focus movement alone does not write the workflow; Accept selected remains the only document commit.

The host-owned native modal provides focus containment, background inertness, and opener-focus restoration. Escape, backdrop, close, and Skip cancel the decision and leave every original string unchanged. Host-authored labels, notices, warnings, accessibility names, and staged-count status follow the active locale while the modal remains open. Imported names and candidate digest, path, media, mount and pack identifiers, size, and backend-provided values remain exact. The candidate list scrolls independently so long metadata, warnings, disabled candidates, and the action footer remain reachable on narrow screens and at 200 percent CSS zoom. The decision follows its document when the local tab is promoted to the shared workspace, but a same-lineage document replacement invalidates it. Lookup failures stay outside the decision and appear in Problems; closing the imported document while lookup is in flight prevents a stale decision from opening.

The representative failed-run document `blake3:5932696ceb7c52ed03f0566144103a929047ec68669bebac04aa5efc1f8f3a9a` exposed the exact malformed shape: checkpoint digest `blake3:4c50ebc6e2a5cb19e8d19626d5ede1fb64755562085ce7383d86c72d1d03eb7e`, name `v1-5-pruned-emaonly-fp16.safetensors`, size `2132696762`, and media type `application/octet-stream`, with only `virtualPath` missing. The live guess response supplies `mounts/comfy-model-checkpoints-1/v1-5-pruned-emaonly-fp16.safetensors`; the browser proof uses those values. The same document's raw save prefix `SD1.5` is the representative structured-migration proof. Neither value is tied to a node id or class-name heuristic.

Legacy LiteGraph save prefixes are migrated generically from the current schema, not from node names. When a widget is declared as `SAVE_TARGET`, its schema default is a grammar-valid structured target, and replacing only that default's `prefix` with the imported string remains grammar-valid, import stores the resulting `{mount, prefix}`. This applies to positional and keyed values, including active DynamicCombo branches. The declared default is the only source of mount authority. Unsafe or empty prefixes and missing or invalid defaults remain raw strings and emit `import.saveTarget.invalidLegacy` for review.

The `DinksterConnection.guessAssets` client batches at 64 names per sequential request, preserves response order, and maps unknown confidence values to `other` rather than rejecting a response. Each batch sends only its own canonical lowercase blake3 hints, skips malformed hints, omits an empty `digestHints` field, and retries a hinted HTTP 400 exactly once without hints for pre-amendment backends. Other failures retain their normal error behavior.

## Dynamic construct compatibility

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
