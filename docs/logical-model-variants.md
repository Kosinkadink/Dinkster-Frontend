# Logical model variants V1

Status: implemented for model-kind ASSET pickers with local-mount scans and
the codec-frozen Federated Asset DTO V1 Candidate boundary. The optional
`AssetDtoV1Client` issues read-only requests to the contract-injected
Candidate path, currently `POST /api/catalog/candidates`. No resolve or
acquisition request is issued.

## Contract boundary

The existing execution identity and Federated Asset DTO V1 Candidate JSON
surface are frozen contracts. Logical grouping remains frontend presentation
state and never becomes document identity.

| Status | Contract surface |
| --- | --- |
| FROZEN - jointly agreed | An executable local asset is the exact five-field `AssetRef` `{digest,name,size,mediaType,virtualPath}`. Its digest is `blake3:` plus 64 lowercase hexadecimal characters. Logical grouping never adds fields to, rewrites, or fabricates an `AssetRef`. |
| FROZEN - jointly agreed | Federated Asset DTO V1 `CandidateV1`, Candidate request/response envelopes, compatibility and availability fields, provider sources, strict tuple ordering, errors, and exact local `assetRef` validation. The app supplies the route through `AssetDtoV1WireContract`; the shipped integration uses `POST /api/catalog/candidates`. |
| FRONTEND-INTERNAL | Logical-model adapter shapes, merge diagnostics, local-scan synthetic identities, grouping, and picker presentation. These add no backend wire or persisted fields. |
| NOT IMPLEMENTED | Resolve, acquisition, recommendation, and automatic selection. |

## Model and validation

A logical model has an authoritative source-supplied `logicalId`, display
name, semantic asset kind, aliases, and grouped concrete variants. The
frontend never invents or persists logical identity. A variant has its own
source-supplied stable id within the logical model and may describe precision,
quantization, format, safe size, and a canonical BLAKE3 digest. Source refs are
provenance only.

Adapters inject declarative description lists. The core is pure and invokes no
adapter transport. Every object is strictly shape-checked. Unknown fields,
non-plain objects, malformed digests or sizes, inconsistent installed/local
state, duplicate ids within one adapter description, NUL-containing ids,
prototype-polluting ids, and conflicting kinds under one logical id are
rejected with diagnostics rather than normalized or guessed.

## Merge rules

1. An authoritative concrete Candidate identity is the exact
   `(logicalId, variantId, digest)` tuple. Candidates with the same logical and
   variant ids but different digests remain separate siblings, ordered by
   variant id and then digest. Re-ingesting an exact tuple is idempotent and
   unions provider provenance.
2. A digest is not a globally sufficient logical identity. It is used to
   quarantine authoritative claims that assign the same digest to different
   logical ids. Synthetic `local-scan` rows are file evidence and neither
   populate nor trigger that authoritative quarantine.
3. A matching local scan enriches an existing `builtin-catalog` variant. It
   joins a resolver Candidate only when that Candidate is `local` and carries
   the exact codec-validated matching `AssetRef`. A nonlocal Candidate remains
   noncommittable and separate from the independently attested local scan row.
4. Equal local basenames with different digests stay separate and receive
   symmetric `basename-digest-conflict` markers. Neither is preferred.
5. A digestless row combines with a digestful sibling for its exact
   `(logicalId, variantId)` only when exactly one such sibling exists. With no
   digestful sibling it remains standalone; with multiple siblings it remains
   separate rather than choosing arbitrarily. It can never become committable.
6. Contradictory concrete scalar facts on the same tuple emit diagnostics.
   Deterministic first-occurrence facts are retained rather than silently
   overwritten. Model display names retain their existing enrichment behavior.
7. Availability is derived from current source descriptions, not identity.
   A valid local ref makes a variant installed. Otherwise an injected
   resolving signal wins, then an injected acquirable/downloadable signal;
   absent either, the variant is unavailable.
8. Conflicting source claims never change the frozen AssetRef contract.

The grouped result is data only. It writes no document, setting, storage, or
frontend-only identity record.

## Interim local-mount identity

Model-kind ASSET pickers adapt the existing kind-scoped ready mount catalog
without adding a route. The adapter canonicalizes entries by digest first, so
one digest produces one variant with merged mount provenance and aliases. Its
interim presentation identity is `local-name:<primary basename>`, where the
primary basename is the code-unit lexicographically smallest observed name;
the digest is the variant id. Equal primary basenames with different digests
therefore share a logical row and receive the core's symmetric conflict flags.

Renamed same-digest files remain one variant and expose every observed basename
and virtual path as aliases. A non-primary alias that equals another digest's
primary basename currently remains in a separate logical row without a conflict
flag. This is a known interim limitation until the backend S3 catalog supplies
authoritative logical identity. Kind still comes only from the declared
model-kind input and is never inferred from a filename.

## Explicit selection

The picker has no Auto or Recommended path. Compatibility is not a frontend
execution policy: all variants remain visible, while an incompatible selected
variant keeps its supplied reason in the right-side Details disclosure. Any
variant with an exact validated `localRef` can be chosen explicitly. This
includes local-scan rows, whose compatibility is intentionally unknown.
Variants without a local ref remain row-selectable for right-panel details but
are informational and cannot be committed. A user must choose one exact local
variant.

## Execution binding

Binding an installed selection returns its existing exact `AssetRef`
unchanged. Downloadable, unavailable, and resolving variants remain
non-executable data and expose no binding or acquisition action. The frontend
never fabricates an `AssetRef` or an acquisition intent.

## Excluded backend behavior

Candidate V1 supplies stable logical and concrete identity, provider sources,
availability, compatibility, content facts, and an exact `AssetRef` for local
Candidates. This picker does not call resolve, choose a backend-selected
Candidate, acquire content, or invent recommendation policy. Any future
acquisition UI requires a separately frozen contract and implementation.

## Picker integration

`CollectionPanel` is the one browse shell for both model and media ASSET
inputs. Media adapters supply mount entries; the logical-model adapter supplies
the same `CollectionEntry` contract after grouping. The shared primary search
filters models by model name, alias, or variant file name, with distinct empty
and no-match states. Models start in list mode and media starts in grid mode.

A model with one variant renders as one plain row. A model with multiple
variants renders one group header followed by its variant rows. Each row shows
only the model or variant name, size, and availability. Aliases, dtype,
precision, quantization, format, digest, providers, conflicts, incompatibility,
and unavailable download action live in the right selection panel's closed
`Details` disclosure for the staged variant.

Clicking an installed variant stages it into that selection panel and applies
the shared selected-row ring. No row commits or exposes its own choose button.
The dialog footer's one primary button commits the unchanged five-field
AssetRef through the existing widget command path; Cancel discards the staged
change. Model upload remains disabled because this picker has no model-upload
contract. Download remains disabled while the backend has no acquisition
contract.

Focused proof lives in `packages/app/test/logical-model.test.ts`,
`packages/app/test/local-mount-logical-model.test.ts`,
`packages/app/test/LogicalModelCollection.dom.test.tsx`,
`packages/app/test/ModalSurface.dom.test.tsx`, and
`packages/e2e/tests/logical-model-picker.spec.ts`.
