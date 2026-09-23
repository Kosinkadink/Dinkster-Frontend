# Release document fixtures

Documents saved by the current release of each document kind. Each one loads
through the shared document pipeline (the same `DocumentTypeAdapter` load and
invariant checks every saved or imported document passes) and the registered
migration chain:

- `workflow-release.json`: `dinkster-workflow` document at `formatVersion` 1.
- `image-release.json`: `dinkster-image` document at `formatVersion` 2.
- `video-release.json`: `dinkster.video` document at version 1 (OTIO timeline).

`packages/core/test/release-document-fixtures.test.ts` keeps these honest:
each fixture must load without error diagnostics, round-trip through JSON
unchanged, and stand up in the one shared document engine. When a format
version is minted, refresh these files from a current save and register the
`N -> N+1` migration; the fixtures then replay the real chain instead of only
synthetic steps.
