# Asset source abstraction

Status: implemented as a framework-free, mock-only foundation. There is no
backend adapter, ComfyUI adapter, product catalog surface, or change to the
existing imported-asset dialog in this slice.

## Contract boundary

`packages/app/src/asset-browser/asset-source.ts` separates three facts that
must not be treated as interchangeable:

1. `AssetContentIdentity` is a source-verified digest with the exact spelling
   `blake3:` followed by 64 lowercase hexadecimal characters.
2. `AssetReferenceMetadata` contains labels, foreign ids, tags, and
   provenance. These fields can narrow a source lookup and support export,
   but none proves content identity or grants access.
3. `AuthorizedAssetLocation` contains a non-empty `virtualPath` obtained from
   catalog or mount authority. A foreign `loader_path`, filename, id, or URL
   is not an authorized Dinkster location.

An `AssetSource` adapter supplies two operations: candidate resolution and
catalog query. A future backend-wire adapter or ComfyUI adapter implements
this interface. The resolver, catalog store, and consuming code do not need
to change for a new transport. This slice deliberately supplies mock
adapters only and makes no network request.

## Resolution

Sources return `AssetSourceMatch` records with a required lossless envelope
and source-local stable match id. A match is promoted only when:

- `digestVerified` is true;
- `digest` has canonical BLAKE3 syntax; and
- an authorized, non-empty `virtualPath` is present.

The result is a discriminated union:

- `resolved`: all promoted candidates share exactly one verified digest;
- `unresolved`: no promoted candidate exists; or
- `ambiguous`: promoted candidates contain two or more different digests.

Filename-only and foreign-id-only matches therefore remain unresolved.
Multiple authorized locations holding the same digest are not content
ambiguity. They sort by `virtualPath`, adapter source id, reference name, then
the source-local match id using stable code-unit ordering. Complete canonical
metadata and its values provide final deterministic tie-breakers if an adapter
violates match-id uniqueness. `selected` is the first candidate in that order,
so duplicate same-content locations never prompt merely because they are
duplicates.

The canonical five-field AssetRef shape is derived from the existing asset
commit gate's return type. Promotion additionally requires size to be a safe
non-negative integer and media type to be a non-empty string. Partial or
malformed source metadata does not enter the canonical ref and remains
reachable through the candidate's required foreign envelope.

## Foreign metadata envelope

`ForeignAssetEnvelope<T>` keeps the complete foreign object by identity. It
does not clone, normalize, select known keys, or rewrite values. The open
record types name the known ComfyUI Asset API fields and workflow `models[]`
fields while allowing unknown fields to survive.

The envelope can carry a derived candidate next to the untouched foreign
record. This separation preserves `id`, `name`, `hash`/`asset_hash`,
`loader_path`, `display_name`, `size`, `mime_type`, `tags`, `user_metadata`,
`metadata`, `is_immutable`, workflow `name`/`url`/`directory`/`hash`/
`hash_type`, and future fields without granting any of them authority. The
round-trip helper returns the exact original object.

This is an in-memory import envelope only. Persisting it in a workflow or
adding export serialization remains outside this slice.

## Catalog state

`AssetCatalogStore` and `reduceAssetCatalog` own adapter-agnostic query,
filter, pagination, selection, loading, ready, and error state. Query changes
clear stale rows and selection. Request ids prevent an old response from
repopulating a newer query. Concurrent loads coalesce, terminal pages cannot
reload page one, and a failed continuation retains its cursor for retry.
Selection accepts only a currently listed id.

The Assets source-health panel polls mount status while any source is scanning.
It shows indexed and total files, indexed and total bytes, and elapsed time so
a large model folder remains observable. Already indexed entries from a
scanning mount remain browsable and available to generation; the scanning
health row marks the results as partial until indexing finishes.

The store is framework-free and has no rendering contract. Product catalog
UI, React/Solid bindings, `App.tsx` integration, and existing asset-browser
behavior are unchanged.

## Proof

`packages/app/test/asset-source.test.ts` covers:

- canonical digest syntax and explicit verification;
- foreign ids never acting as authority;
- resolved, unresolved, and ambiguous outcomes;
- stable duplicate-location ordering;
- canonical size and media-type gates;
- identity-preserving Comfy Asset API and workflow model envelopes, including
  unknown fields; and
- catalog query, load, append, selection, error, and stale-response state
  transitions against mock adapters.
