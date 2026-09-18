# Federated asset DTO v1 client seam

Status: implemented with injected transport and fixtures. No route is
registered and no backend request was made or proven by this slice.

## Frozen and provisional boundary

The semantic contract and the concrete JSON wire are at different stages.
This table is the source of truth for the distinction in this slice.

| Status | Contract surface |
| --- | --- |
| FROZEN - jointly agreed | `contractVersion: 1` owns catalog, candidates, and resolve; AssetRef is exactly `{digest,name,size,mediaType,virtualPath}`; digest is `blake3:` plus 64 lowercase hexadecimal characters; signed snapshot cursors are opaque strings passed verbatim; MIME accepts are exact case-sensitive `type/subtype` or `type/*`, `*/*` is illegal, and empty means unrestricted; accept has at most 32 entries and document occurrences at most 256; resolve modes are `existing` and `acquire-managed`; resolve statuses are `resolved-existing`, `resolved-remapped`, and `acquired`; ready authorized same-digest remap/failover is silent; prompts are limited to digestless/different-digest ambiguity, credentials, license, cost, or explicit policy override; wrong kind and integrity mismatch are errors; filenames never rank; repair is atomic and all-or-none, uses RFC 6901 pointers including list elements, deep-equals current AssetRefs as preconditions, and echoes the opaque frontend-supplied document token verbatim. |
| JOINTLY FROZEN 2026-08-08 by backend amendment A3 + frontend CONCUR (previously provisional) | Field-level catalog and candidates request/response JSON; typed-error JSON discriminants, envelopes, HTTP mapping, and optionality; selected-candidate reason container and grammar (`reference-mapping`/`explicit-selection`/`trusted-source`/`expected-digest`/`compatible-only`); and exact JSON field spelling of the repair envelope (`type: 'asset-ref-repair'`, `version: 1`, `atomic: true`, `documentDigest` echoing `document.digest` verbatim, `preconditions`/`replacements`). A3 also pins closed objects with `contractVersion: 1` and unknown-field rejection everywhere, POST-only operations, consent requirement IDs (opaque, server-issued, revalidated; no credential consent category), and the full bound set (limit 1..100 default 50, cursor <=4096 generation-bound, occurrences <=256, providerSources <=64, candidate-bearing errors cap 100 with truthful `truncated`). Route paths remain frontend-injected by design and are excluded from the freeze. The injected codecs still carry the provisional spellings in code; the adoption slice replaces them with the frozen definitions and adds live contract proof, gated on the backend implementation landing. |

## Frozen semantic validation

`packages/client/src/federated-assets-v1.ts` owns the additive
`contractVersion: 1` boundary. Every request is stamped and every success or
error response is version-checked before its operation codec runs.

Resolve requests strictly validate:

- mode `existing` or `acquire-managed`;
- context asset kind, schema node/input identity, optional concrete type id,
  and at most 32 MIME accepts;
- accepts as exact case-sensitive `type/subtype` or `type/*`, with `*/*`
  rejected and an empty list unrestricted;
- optional expected canonical BLAKE3 digest and safe non-negative size;
- only the five declared foreign hint keys, which remain non-authoritative;
- an opaque document token and at most 256 occurrences; and
- RFC 6901 pointers, including array indices, plus exact five-field AssetRefs.

Resolve success decoding admits only the three pinned statuses, a strict
five-field selected AssetRef, a selected-candidate reason decoded by the
configured reason codec, and an optional atomic repair envelope using this
frontend fixture's provisional field spelling. The repair semantics are
frozen; that exact JSON spelling is not. Cursors belong to the provisional
catalog/candidates codecs and are passed as opaque strings without parsing or
normalization.

## Atomic repair planning

`packages/core/src/asset-ref-repair.ts` is DocumentStore-adjacent because it
plans existing core commands over the core workflow model and has no product
UI or transport dependency. It does not add a command or mutate a document.

The planner checks the echoed document token, requires nonempty matching
precondition/replacement target sets, rejects duplicate or ancestor/descendant
targets, resolves only widget-value and widget-list-element pointers, and
deep-compares each current five-field AssetRef. It then consolidates list
element edits and returns one flat `batch` of `node.setValues` invocations.
One dispatch therefore advances `DocumentStore.revision` once and creates one
undo record. Every rejection returns before dispatch and cannot mutate state.

## Pending backend wire amendment

The joint contract did not pin catalog request/response fields, candidates
request/response fields, route paths, remote error discriminants, the
selected-candidate reason wire, or exact repair-envelope field spelling.
`AssetDtoV1WireContract` makes the operation shapes, errors, routes, and reason
wire mandatory injected strict codecs/configuration. The repair-envelope
decoder is likewise labeled as a frontend-proposed fixture shape rather than
a backend adapter claim. There is intentionally no default route or guessed
backend payload.

No live call is permitted until the backend publishes an explicit wire
amendment and the frontend concurs. After both events, replace the provisional
configuration/spelling with the agreed definitions and add live contract
proof.

## Scope

This slice adds no backend adapter registration, picker or catalog UI,
acquisition flow, persisted remap choice, asset-source semantic change, or
change to `/api/assets/guess`. All transport proof uses injected fixtures.

Focused proof lives in:

- `packages/client/test/federated-assets-v1.test.ts`; and
- `packages/core/test/asset-ref-repair.test.ts`.
