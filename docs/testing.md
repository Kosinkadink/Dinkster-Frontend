# Testing

## Fast pull-request checks

`.github/workflows/ci.yml` runs exactly one job with a ten-minute limit.
After `pnpm install --frozen-lockfile`, reproduce it with:

```bash
pnpm ci:fast
```

This command runs `check-extension-literals`, `check-ui-strings`, and
`typecheck` (the latter also runs `check-path-case`) and a fixed unit subset.
The extension check pins every intentional backend node-id literal and widget
type comparison to an exact source location, owning issue, and non-increasing
ceiling. The committed ceilings are zero node-id literals and 93 widget-type
comparisons. Both have zero slack, so each ceiling must equal its measured
count, and the fast check rejects any increase from the merge base even when
the allowlist is edited to match. New and stale entries also fail. After merging main, run
`node scripts/check-extension-literals.mjs --write`, review that only expected
line or column coordinates changed and no ceiling changed, then run
`pnpm ci:fast`. The Prettier check is limited
to `scripts/ci-fast.mjs` and
`packages/e2e/test/ci-workflow.test.ts`; it does not impose formatting
on existing application files. There is no repository-wide formatter or
linter configuration.

The job does not fetch a backend, install or run a browser, execute
performance budgets, or run E2E shards. PR labels do not enable heavy jobs.

The subset uses synthetic inputs and checked-in fixtures:

- Core `format.schema.test.ts`: document schema/runtime validator agreement.
- Core `dinkster-graph.test.ts`: graph validation and wire type round trips.
- Core `dinkster-inline-value.test.ts`: scalar event decoding and invalid inputs.
- E2E `ci-workflow.test.ts`: workflow triggers, unit selection, credentials
  and browser-isolation contracts.
- App `extension-dogfooding.test.ts`: built-in widget, command, and editor
  registrations use the same public doors available to packs.
- `scripts/check-extension-literals.test.mjs`, `scripts/check-ui-strings.test.mjs`,
  and `scripts/check-path-case.test.mjs`: regression tests for source checks.

Selection does not depend on changed files, labels, model availability or a
running service. The job defaults to `[self-hosted, linux, x64]`; repository
variable `DINKSTER_PR_RUNNER` can select hosted Linux with the JSON string
`"ubuntu-latest"` without editing the workflow.

## Full validation

`.github/workflows/full-validation.yml` runs on pushes to main, every two
hours from 06:00 through 22:00 Pacific, daily at 10:43 UTC, and on manual
dispatch. The `on.schedule`
cron list in that file is the single schedule definition; change its first
cron line to change the two-hour cadence. Scheduled runs skip the heavy jobs
when the latest successful durable main run already validated the same commit;
reduced push runs do not satisfy that check. Main pushes use one non-cancelling
concurrency group. GitHub keeps one active push run and only the newest pending
push run, replacing older pending runs as new commits arrive. A merge whose
pending run is replaced is covered by the next completed run at a descendant
head. Find candidate runs in the Actions `Full validation` history, then confirm
coverage from a local clone with
`git merge-base --is-ancestor <merge-sha> <run-head-sha>`. Scheduled,
dispatched runs use a separate non-cancelling durable group,
so push traffic neither queues nor replaces them. To test an unmerged branch
that contains the workflow:

```bash
gh workflow run full-validation.yml --repo Kosinkadink/Dinkster-Frontend --ref <branch>
```

The dispatch ref selects both the workflow and frontend checkout. Main pushes
run the fast formatting, type, UI-string and contract subset plus parallel-safe
shard 4/4 and backend-serial shard 1/2. The latter retains the software Vulkan
check. Scheduled and dispatched runs keep the complete matrix.
All seven durable E2E lanes may run concurrently across the Linux runner pool,
and each remains behind its host's counted-suite launcher so Actions and owner
gates share one admission limit. The jobs retain their existing assertions
and dependency pins:

| Job         | Checks                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast`      | Push-only formatting, typecheck, UI-string and contract subset                                                                                                                                                                                        |
| `ci`        | Backend-generated fixture drift, workspace typecheck, UI-string lint, complete unit/component suites including performance budgets, app build and audit-assets browser suite                                                                          |
| `e2e-suite` | Two representative lanes on pushes; four parallel-safe shards, two backend-serial shards and the performance browser job for durable runs. Backend-serial 1/2 also proves an ordinary third-party pack against a server composed with only that pack. |
| `e2e`       | Always evaluates the aggregate and requires every E2E matrix leg to succeed                                                                                                                                                                           |

The heavy jobs retain the shared memory-only dependency identity action,
clean checkouts without persisted credentials, counted-suite launcher and
`scripts/ci-browser.sh` network isolation. The audit-assets browser starts the
pinned Dinkster checkout and uses frontend/native ports 15376/15377. Full E2E
uses frontend/ComfyUI/native ports 15410/15411/15412 and installs the locked
compatibility dependencies into the pinned ComfyUI interpreter used by its
full composition. Its contract proof separately starts Dinkster with
`--no-default-packs --pack tests/fixtures/extension-contract-pack/dinkster-pack.toml`
on ports 15420/15421, activates the fixture pack's immutable frontend module,
renders two custom nodes linked through the pack's custom value type, executes
the consumer, and observes its typed route and event in host-owned UI.
Both browser modes run inside the isolated network. Base, hosted and audit
Playwright servers explicitly enable the v1 compatibility probe required by
route-mocked specs; production startup remains native-only. No standing
development server is reused or stopped.

Owners still run lint, typecheck, full unit/component suites, app build,
fixture drift and relevant browser checks locally before landing. The fast
subset is feedback, not a substitute for those gates. Desktop publication
and published-install verification remain separate manual workflows; this
split neither publishes a release nor enables the unpublished Desktop gate.
