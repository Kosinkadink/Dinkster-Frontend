# Templates browser

The Library sidebar contains a Templates collection for complete native Dinkster workflow documents shipped by packs. Search is server-owned and covers template identity, names, descriptions, and tags. The pack selector applies the backend's exact pack filter; results page through the same query-bound cursor contract as the workflow library.

Each row shows the template name, pack, description, tags, and declared asset requirements. Asset ids are pack-local and are resolved against the pack table from `/api/nodes`; a missing descriptor is displayed as its raw id instead of hiding the requirement.

Select a row and choose **Open template** to fetch its immutable body and load it through the normal native-document pipeline as a new, unsaved tab targeted at the serving backend. Opening does not acquire assets. Missing assets remain behind the existing submit-time consent flow. The selected row also exposes the exact template id, pack, backend, digest, tags, and declared requirements in the Library detail presentation.

## Remote catalog (future, not implemented)

The registry service (backend commit 495120c) additionally serves a remote template catalog for packs that are NOT installed locally:

- `GET /index/templates` - query-first paged catalog over each pack's latest release (`q=`, `tag=`, `pack=`, `limit`/`cursor` with query-bound keyset cursors - the same collection contract and descriptor vocabulary as the local `/api/templates`). Descriptors carry `pack` and `version` fields over the local shape; asset requirements remain pack-local ids.
- `GET /index/packs/{pack}/versions/{version}/templates/{id}` - digest-verified template body with the usual immutable rendition caching (quoted digest ETag, If-None-Match -> 304).

No frontend surface consumes these yet. When a "browse templates from packs you haven't installed" UX is built, these endpoints are its backing surface; it will need a story for resolving asset requirements without the local pack table.
