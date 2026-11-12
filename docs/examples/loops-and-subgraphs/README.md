# Loop and subgraph executable examples

The nine `*.json` files are importable workflow documents. Each matching
`*.compiled.json` file is the canonical native graph produced by the frontend
compiler. `expected-results.json` records only deterministic terminal outcomes;
it intentionally excludes job identities, timestamps, cache state, and runtime
fingerprints.

Fold regions may omit state ports when only ordered execution is needed. Region
outputs may use `last` to return the final body value or typed absence for zero
iterations. A region's `cachePolicy` is `reuse` when omitted; `rerun` bypasses
cache reads, writes, and same-run single-flight reuse for its body occurrences.
Nested regions apply their own policy and retain occurrence-scoped identity.

The arithmetic bodies use `dinkster.utilities.primitive_int` to bind their typed
integer boundaries into `dinkster.utilities.comfy_math_expression` input families.
The While body uses the expression's `BOOL` output for its continue flag.

`packages/client/test/executable-examples.test.ts` checks every authored document
against its compiled graph during the normal test suite. Seven examples execute
on the current backend. Nested Map inside Fold retains the withdrawn
`std.list.length` node, and Lazy Gate inside Map retains `dinkster.route.gate`;
neither has a current replacement. Those two documents and their structural
compiler checks remain available, but their live execution requires the
withdrawn nodes. Their status is tracked on
[the withdrawn-draft inventory](https://github.com/Kosinkadink/comfy-vibe-station/issues/773).
Set `DINKSTER_LIVE_URL` to assert the available deterministic results:

```sh
DINKSTER_LIVE_URL=http://127.0.0.1:8765 pnpm --filter @dinkster/client test
```

The browser CPU acceptance imports available documents through the app menu,
confirms their authored region structure, submits the region, and checks the
same result table through the execution store:

```sh
DINKSTER_NATIVE_BACKEND=http://127.0.0.1:8765 pnpm --filter @dinkster/e2e exec playwright test --config=playwright.isolated.config.ts tests/executable-examples-live.spec.ts
```
