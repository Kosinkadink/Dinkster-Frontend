# Federated asset DTO v1 client seam

Status: implemented with injected transport and fixtures. Routes are injected;
no backend request was made or proven by this slice.

## Frozen boundary

`packages/client/src/federated-assets-v1.ts` owns the additive
`contractVersion: 1` catalog and candidates boundary. Every request is stamped
and every success or error response is version-checked before its operation
codec runs.

| Status | Contract surface |
| --- | --- |
| FROZEN - jointly agreed | Catalog and candidates own `contractVersion: 1`. AssetRef is exactly `{digest,name,size,mediaType,virtualPath}` and a digest is `blake3:` plus 64 lowercase hexadecimal characters. Signed snapshot cursors are opaque strings passed verbatim. |
| JOINTLY FROZEN 2026-08-08 by backend amendment A3 + frontend CONCUR | Field-level catalog and candidates request/response JSON; typed-error JSON discriminants, envelopes, HTTP mapping, and optionality; selected-candidate reason grammar (`reference-mapping`/`explicit-selection`/`trusted-source`/`expected-digest`/`compatible-only`). Closed objects reject unknown fields, all operations are POST-only, and the bounds are limit 1..100, cursor <=4096, providerSources <=64, and candidate-bearing errors <=100 with truthful `truncated`. Routes remain frontend-injected. |

## Validation

Catalog and candidate requests strictly validate context asset kind, schema
node/input identity, optional concrete type id, at most 32 MIME accepts, and
optional expected digest/size, hints, selection, cursor, and limit. Accepts
are exact case-sensitive `type/subtype` or `type/*`; `*/*` is rejected and an
empty list is unrestricted.

Catalog and candidate responses validate strict candidate ordering, exact
local AssetRefs, selected-candidate reasons, and opaque cursors without
parsing or normalization. Shared typed errors retain their code-specific HTTP
status and field validation.

## Scope

This slice adds no backend adapter registration, picker or catalog UI,
acquisition flow, persisted remap choice, asset-source semantic change, or
change to `/api/assets/guess`. All transport proof uses injected fixtures.

Focused proof lives in `packages/client/test/federated-assets-v1.test.ts`.
