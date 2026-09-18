# Retained value rendition client

`DinksterValuesClient.peek(query)` reads descriptors and advertised renditions from
`/api/values`. `query.element` is exclusively nested-list descent. Tensor batch
selection belongs in `rendition(query, kind, { batch })`; a query with
`element: [1, 2]` and options `{ batch: 3 }` sends `element=1,2&batch=3`.

Each `RenditionInfo` keeps `kind`, `mime`, and `default`, plus optional provider
`version`, `parameters: string[]`, `defaults: Record<string, string>`, and
`limits: Record<string, number>`. Malformed optional fields are omitted, not
coerced. Controls must check `info.parameters?.includes(parameter)` and consume
that provider's defaults and limits. A kind without capability metadata does
not advertise selectors; the client does not supply duplicate bounds tables.

Rendition options also include `frame` (index or decimal seconds with `s`),
`thumbs` (count), `waveform: { width, height }`, and
`window: { start, duration }` (seconds). The server remains authoritative about
supported selectors and provider bounds.

`rendererVersion: info.version` is an optional cache-only request hint, never a
query parameter. Successful peeks automatically register the descriptor's
fingerprint and advertised renderer versions for that exact query. A late peek
cannot replace a newer successful announcement. Later rendition calls, including
callers without the hint and requests for `default`,
cannot reuse bytes under an older announcement. Completed cache reads include
the request URL/selectors, announced identity, version hint, and opaque ETag
(or fingerprint/kind fallback). The cache retains at most 64 entries and 64 MiB;
announcement and request indexes are bounded too. Unchanged repeats need no
network request. A renderer change unknown to both peek and the caller cannot
be discovered by a no-network cache hit.

Successful results preserve raw response headers as `colorTransform`,
`sourceTransfer`, `previewColorSpace`, and `waveform`. These correspond to
`X-Dinkster-Color-Transform`, `X-Dinkster-Source-Transfer`,
`X-Dinkster-Preview-Color-Space`, and `X-Dinkster-Waveform`. Missing headers remain
absent; never infer a conversion. `waveform: 'sampled-peak'` reports sampled,
not exhaustive, peaks. Cross-origin use requires server CORS exposure.

Refusals preserve `available: false`, reason, HTTP status, and message. A
`no-rendition` response's `renditions: string[]` is retained as `renditionKinds`;
object declarations remain in `renditions` without inventing MIME types for
kind-only responses. Invalid selectors (400), bad list/batch indices (404),
unavailable providers (406), and existing refusal reasons remain distinct.
There is no retry-all-406, download fallback, or polling route. Both reads
accept `signal`; aborted or failed body reads are structured refusals and are
never cached.
