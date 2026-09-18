# Reusable execution results

Dinkster keeps proven results from completed native runs available when another
branch executes and after a browser reload. A value copied from an older run
is labeled as retained/cached. It becomes stale or disappears when the current
workflow can no longer prove the same computation.

## Proof and invalidation

Each persisted result is partitioned by project, backend URL, stable backend
client identity, server version, and schema wire. Reload accepts it only when:

- the schema hash still matches;
- durable history and the live job agree on job, source-document, and
  authenticated principal identity;
- the source-document asset can be loaded and deterministically recompiled to
  the saved prompt, scope, selector choices, and provenance; and
- each reusable value is still available from the job-scoped value API.

Workflow edits invalidate only affected upstream recipe cones. A random
selector invalidates values in its own downstream cone on every roll; unrelated
cones remain reusable. Runs without complete compile and source-document proof
are not adopted, including unproven foreign or reconciled runs.

## Browser storage

The browser stores compile proof, terminal node summaries, inline JSON scalars,
content digests, and small preview metadata. Runtime tensors, models, preview
frames, logs, and raw output payloads are never stored. The project-scoped
envelope is capped at 40 results and 1,000,000 serialized bytes, evicting the
oldest results first. Browser quota failures also evict oldest-first.

Removing a backend or clearing its run history clears its persisted results.
Changing backend/runtime/client identity prunes the old partition. Missing or
evicted jobs, assets, and values fail closed instead of showing an unproven
cached value.
