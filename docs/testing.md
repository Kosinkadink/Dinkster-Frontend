# Testing

## Fast pull-request checks

`.github/workflows/ci.yml` runs exactly one job with a five-minute limit.
After `pnpm install --frozen-lockfile`, reproduce it with:

```bash
pnpm ci:fast
```

This command runs the existing `check-ui-strings` and `typecheck` scripts
(the latter also runs `check-path-case`) and a fixed unit subset. Its
Prettier check is limited to `scripts/ci-fast.mjs` and
`packages/desktop/test/ci-workflow.test.ts`; it does not impose formatting
on existing application files. There is no repository-wide formatter or
linter configuration.

The job does not fetch a backend, install or run a browser, execute
performance budgets, or run E2E shards. PR labels do not enable heavy jobs.

The subset uses synthetic inputs and checked-in fixtures:

- Core `format.schema.test.ts`: document schema/runtime validator agreement.
- Core `dinkster-graph.test.ts`: graph validation and wire type round trips.
- Core `dinkster-inline-value.test.ts`: scalar event decoding and invalid inputs.
- Desktop `ci-workflow.test.ts`: workflow triggers, unit selection, credentials
  and browser-isolation contracts.
- Desktop `published-verification.test.ts`: read-only release verification
  contracts, without installing or launching a published application. Its
  existing Windows-only safety cases stay platform-gated.
- `scripts/check-ui-strings.test.mjs` and `scripts/check-path-case.test.mjs`:
  regression tests for source checks.

Selection does not depend on changed files, labels, model availability or a
running service. The job defaults to `[self-hosted, linux, x64]`; repository
variable `DINKSTER_PR_RUNNER` can select hosted Linux with the JSON string
`"ubuntu-latest"` without editing the workflow.

## Full validation

`.github/workflows/full-validation.yml` runs on pushes to main, every two
hours from 06:00 through 22:00 Pacific, daily at 10:43 UTC, on manual
dispatch, and when called by the desktop release workflow. The `on.schedule`
cron list in that file is the single schedule definition; change its first
cron line to change the two-hour cadence. Scheduled runs skip the heavy jobs
when the latest successful main run already validated the same commit. Push
runs cancel superseded push runs, while scheduled and called runs use a
separate non-cancelling concurrency group. To test an unmerged branch that
contains the workflow:

```bash
gh workflow run full-validation.yml --repo Kosinkadink/Dinkster-Frontend --ref <branch>
```

The dispatch ref selects both the workflow and frontend checkout. The jobs
retain their existing assertions and dependency pins:

| Job | Checks |
| --- | --- |
| `ci` | Backend-generated fixture drift, workspace typecheck, UI-string lint, complete unit/component suites including performance budgets, app build and audit-assets browser suite |
| `e2e-suite` | Four parallel-safe shards, two backend-serial shards and the performance browser job |
| `e2e` | Always evaluates the aggregate and requires every E2E matrix leg to succeed |

`release-desktop.yml` calls full validation before its release job, so the
exact selected main commit must pass before publication begins.

The heavy jobs retain the shared memory-only dependency identity action,
clean checkouts without persisted credentials, counted-suite launcher and
`scripts/ci-browser.sh` network isolation. The audit-assets browser uses port
15376; full E2E uses frontend/ComfyUI/native ports 15410/15411/15412 inside
the isolated network. No standing development server is reused or stopped.

Owners still run lint, typecheck, full unit/component suites, app build,
fixture drift and relevant browser checks locally before landing. The fast
subset is feedback, not a substitute for those gates. Desktop publication
and published-install verification remain separate manual workflows; this
split neither publishes a release nor enables the unpublished Desktop gate.
