# Testing

## Fast pull-request checks

`.github/workflows/ci.yml` runs product screenshots and source checks on
pull requests. Ready pull requests also run every kept unit test and the
native startup browser job. The required fast check fails if screenshots
or required native startup fail, so neither can bypass the merge requirement.
Returning a pull request to draft stops selecting unit and native startup
jobs; marking it ready starts them without another push.
After `pnpm install --frozen-lockfile`, reproduce source checks with:

```bash
pnpm ci:fast
```

This command runs `check-extension-literals`, `check-ui-strings`, and
`typecheck` (the latter also runs `check-path-case`). Run `pnpm test` for the
complete kept unit suite, including its performance budgets.
The extension check pins every intentional backend node-id literal and widget
type comparison to an exact source location, owning issue, and non-increasing
ceiling. The committed ceilings are zero node-id literals and 85 widget-type
comparisons. Both have zero slack, so each ceiling must equal its measured
count, and the fast check rejects any increase from the merge base even when
the allowlist is edited to match. New and stale entries also fail. After merging main, run
`node scripts/check-extension-literals.mjs --write`, review that only expected
line or column coordinates changed and no ceiling changed, then run
`pnpm ci:fast`. The six region starter occurrences have separate
`nodeIdExceptions` entries naming their exact file, node ID and owning
[issue 813](https://github.com/Kosinkadink/comfy-vibe-station/issues/813).
They do not raise the zero node-ID ceiling: an additional occurrence, another
ID or the same ID in another file still fails. `--write` refreshes locations,
not the permitted file, ID or number of occurrences. The Prettier check is limited
to `scripts/ci-fast.mjs`; it does not impose formatting
on existing application files. There is no repository-wide formatter or
linter configuration.

The fast job runs source checks and, on ready pull requests, unit tests.
The screenshot job installs Chromium and runs `pnpm test:visual` on the same
Linux runner image as full validation, without a live backend. It discovers
specs containing screenshot assertions so new screenshot specs join the check.
The separate native startup job prepares the pinned default packs and dev
pack, starts the real native servers, runs the live client/app cases, then
runs `playwright.hosted.config.ts --project=native-startup --workers=1`.
It retains browser failures and live Vitest reports. The execution interpreter
installs CPU Torch for the live Preview Any node; no ComfyUI checkout or model
inference dependencies are needed. Browser shards stay on main full
validation. PR labels do not enable heavy jobs.

CPU catalog preparation sets `UV_TORCH_BACKEND=cpu` for its child package
installers. `--accelerator cpu` selects pack requirements, while the uv
setting selects CPU PyTorch wheels and avoids installing CUDA runtimes on
the hosted CPU runners.

`pnpm test` runs the kept unit and component tests through each workspace
package's test command. Tests of repository scripts and workflow files are
not part of the suite. `pnpm --filter @dinkster/app build`
checks its emitted HTML, nonempty module entry and inline semantic-token
content/order after Vite builds once; unit tests do not invoke a second build.
The `production-build` browser keeper
loads a separately built production app, checks that its shell and Settings
work, and verifies that `window.__dinksterTest` is absent even with test-like
URL parameters. Only Vite's explicit `--mode test` publishes the mutable app,
canvas and synthetic-workload bridge. Browser configurations opt in to that
mode; ordinary development and production builds do not expose it.
The widget document-value matrix runs in core alongside its store contract.
Execution and backend component tests check mounted labels, ownership and
actions; the tooltip AST check only bans native HTML titles. The existing
settings multiwindow browser keeper checks hover and keyboard focus on missing
panel and workflow return controls rather than matching stylesheet text.

Selection does not depend on changed files, labels, model availability or a
running service. The required `CI_RUNNERS` repository variable controls every
job. Pull requests select its `linux` entry for same-repository branches and
`forkLinux` for forks. Both entries name GitHub-hosted Linux runners; the other
values select hosted images for main validation, schedules, and manual runs.

## Full validation

The live image upload proof requires `dinkster.image.load_image` and
`dinkster.image.save_image` from the same-origin catalog and fails with the
missing node IDs when either is absent. Its execution graph connects the
loader's `IMAGE` output to the saver's `images` input; upload byte equality,
canonical asset references, export/reopen and completed execution remain
required.

The hosted guide backend composes only `packages/e2e/fixtures/guide-pack`,
a node-free pack with one guide, in a separate library. Its port defaults to
the native backend port plus two (`DINKSTER_E2E_GUIDE_PORT` overrides it).
`DINKSTER_E2E_GUIDE_BACKEND` identifies it to `guide-browsing.spec.ts`, which
checks Learn with an empty primary guide catalog, reads the second backend's
real immutable page, and withdraws Learn when that server disconnects. The
shared native catalog excludes test-only guide packs so its exact digest
continues to describe the pinned default packs and dev pack.

The App View queue fixture creates its submission-release promise before the
request handler runs, so observing Submitting can release either an already
waiting request or one that arrives afterward without losing the release.

The Activity, Extensions and Media locale proofs flush fixture persistence and
wait for a committed version-1 snapshot with no pending workspace candidates
before recording request baselines. Document recovery slots remain available
after a commit and are not pending workspace writes. The locale assertions
still count every backend request.

Screenshots use the product's bundled fonts, including canvas text, without
test-only font injection or host font configuration. Baseline paths are shared
across projects and platforms; all validation lanes compare the same images.
The shared Playwright configuration pins device scale to 1 and disables GPU
rasterization/compositing, partial rasterization and font hinting. Repainting
complete tiles avoids rounded control-edge differences from partial repaints.
Exact decoded-pixel comparisons use the lockfile-pinned Linux Chromium;
native Windows/macOS validate bundled
font loading and geometry rather than cross-platform raster identity.
Visual fixtures use fixed timestamps and wait for catalogs before capture.
Run `pnpm test:visual --update-snapshots=all` to regenerate every baseline after
reviewing a deliberate appearance change. Screenshot thresholds stay unchanged.
Failed hosted browser lanes retain their actual,
expected and diff images in `browser-failure-*` artifacts for seven days.

`.github/workflows/full-validation.yml` runs on pushes to main, every two
hours from 06:00 through 22:00 Pacific, daily at 10:43 UTC, and on manual
dispatch. The `on.schedule`
cron list in that file is the single schedule definition; change its first
cron line to change the two-hour cadence. Scheduled runs skip the heavy jobs
when that exact main commit already has a completed full-validation run,
whether its conclusion was red or green. Main pushes use one non-cancelling
concurrency group. GitHub keeps one active push run and only the newest pending
push run, replacing older pending runs as new commits arrive. A merge whose
pending run is replaced is covered by the next completed run at a descendant
head. Find candidate runs in the Actions `Full validation` history, then confirm
coverage from a local clone with
`git merge-base --is-ancestor <merge-sha> <run-head-sha>`. Scheduled,
dispatched runs use a separate non-cancelling durable group,
so push traffic neither queues nor replaces them. Pull requests use their
required checks, not full-validation dispatches or reruns.

The dispatch ref selects both the workflow and frontend checkout. Main pushes,
scheduled runs, called runs, and dispatched runs all use the complete matrix.
Parallel-safe runs as six shards, backend-serial as two, and native startup
as one isolated job. Every E2E lane installs
and checks the software Vulkan driver selected by `VK_DRIVER_FILES`, including
browser WebGL and native headless rendering.
Both the server and Torch worker interpreters install the pinned checkout's
first-party pack sources; catalog composition alone does not prove that the
execution interpreter can import those packs.
The product-surface visual matrix runs only in the fast visual job; its
route-mocked screenshots do not require a second run against hosted backends.
Synthetic noodle and boundary interaction proofs run only in parallel-safe.
All 10 E2E lanes may run concurrently on
GitHub-hosted Linux. The jobs retain their existing assertions and dependency
pins:

| Job           | Checks                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`          | Backend-generated fixture drift, workspace typecheck, UI-string lint, complete unit/component suites including performance budgets, app build and audit-assets browser suite                                                                             |
| `e2e-suite`   | Six parallel-safe shards, two backend-serial shards, native startup, and the performance browser job. Backend-serial 1/2 also proves an ordinary third-party pack against a server composed with only that pack. |
| `e2e`         | Always evaluates the aggregate and requires every E2E matrix leg to succeed                                                                                                                                                                              |
| `main-status` | Uploads one lane-result JSON artifact and fails unless every selected main lane passed                                                                                                                                                                   |

The heavy jobs retain the shared memory-only dependency identity action and
clean checkouts without persisted credentials. The audit-assets browser starts the
pinned Dinkster checkout and uses frontend/native ports 15376/15377. Its subgraph
import readiness count follows the served `/api/nodes` catalog; graph structure
and diagnostic expectations remain fixed goldens in `native-catalog.json`.
Full E2E
uses frontend/native ports 15410/15412 and installs the locked
inference dependencies into the native execution interpreter used by its
rootless native composition. It neither starts a stock ComfyUI server nor
passes a ComfyUI root to Dinkster. The isolated library configures a read-only
`checkpoints` mount with kind `model/checkpoint` for the missing-model picker
fixture, alongside its writable `output` mount. The native startup
job runs the 16 native client and six native app live Vitest cases once inside
its native server lifetime, serially, and retains their JSON reports with exact
case-count checks. Current cases must pass. A skipped case is accepted only when
its required node or served template is absent and recorded in the single
`packages/e2e/tests/withdrawn-drafts.json` list. The While / Until execution
fixture remains mandatory even though its served template was withdrawn.
Its contract proof separately starts Dinkster with
`--no-default-packs --pack tests/fixtures/extension-contract-pack/dinkster-pack.toml`
on ports 15420/15421, activates the fixture pack's immutable frontend module,
renders two custom nodes linked through the pack's custom value type, executes
the consumer, and observes its typed route and event in host-owned UI.
The isolated hosted library explicitly enables templates for positive gallery
and loop-template coverage. Template-dependent route fixtures also report
templates enabled. Disabled-feature specs override that capability to assert
the production default, which remains disabled.
Shared browser fixtures leave native catalog and supervisor routes reachable.
Specs either use the isolated native backend or supply their own native wire
schemas and API routes. The shared fixture does not select a stock protocol,
block native discovery, or add backend settings responses. App View remains an
explicit per-test option, and spec-local routes take precedence over context
routes. No standing development server is reused or stopped.
Product option fixtures resolve controls by option ID rather than global list
position so collection updates cannot redirect a pending selection.
Palette surface fixtures await startup ownership before publishing schemas or
opening their document so they do not invalidate the restored inventory's acknowledgment.
Remote combo refresh proof waits for the previous option to detach and the
refreshed menu to be ready after a successful HTTP response. It does not wait
for Playwright's transport-completion event: Chromium can report a streamed
response as canceled after the application has consumed its complete body.
Hosted native launches declare `--engine-variant linux-cpu`. After composition,
global setup requires an empty workflow to return an empty requirement plan
without a request variant. Mock-only native fixtures explicitly answer that
read-only plan request; live native cases use the pinned backend route.
The hosted native server also accepts the `localhost` Host alias so the
run-history backend-switch test can address the same server through two
distinct backend identities without an HTTP 421 schema rejection.

Owners run source checks, app build, fixture drift and relevant browser
checks locally before landing. Ready pull requests require the complete unit
suite and native startup at the exact head; draft source checks do not
substitute for those gates. Desktop publication
and published-install verification remain separate manual workflows; this
split neither publishes a release nor enables the unpublished Desktop gate.

The runner variable value is:

```json
{
  "linux": ["ubuntu-latest"],
  "windows": ["windows-latest"],
  "macos": ["macos-latest"],
  "forkLinux": ["ubuntu-latest"]
}
```
