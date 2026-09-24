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

`packages/client/test/executable-examples.test.ts` checks every authored document
against its compiled graph during the normal test suite. With a compatible local
Dinkster backend, set `DINKSTER_LIVE_URL` to also assert all nine successful results:

```sh
DINKSTER_LIVE_URL=http://127.0.0.1:8765 pnpm --filter @dinkster/client test
```

The browser CPU acceptance imports all nine documents through the app menu,
confirms their authored region structure, submits the region, and checks the
same result table through the execution store:

```sh
DINKSTER_NATIVE_BACKEND=http://127.0.0.1:8765 pnpm --filter @dinkster/e2e exec playwright test --config=playwright.isolated.config.ts tests/executable-examples-live.spec.ts
```
