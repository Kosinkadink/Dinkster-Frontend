# Dinkster-Frontend AGENTS

# Docs discipline

Keep docs concise. No delegation ledgers, promise ledgers, handoff records,
or coordination narratives in this repo: GitHub issues and PRs are the record
of work, decisions, and deferred items. Every user-facing feature or system
(including a lens, panel, interaction mode, or shortcut) must be documented
under `docs/` in the same commit that ships it. Update the active document
that owns current behavior; archived audits are historical and are not update
targets. Undocumented features are unfinished.

# Locale catalogs

The only application locale catalogs are `en.json` and `zh.json`; adding any other locale file requires an explicit user ruling.

# Screenshot validation (user directive, 2026-08-12)

Screenshots are part of the development cycle, not just PR paperwork.
While developing any user-visible change, capture screenshots of the
running UI and actually inspect them to validate BOTH correct behavior AND
acceptable visual quality (layout, alignment, spacing, contrast, no
clipped/overlapping elements) before considering the work done. Code that
passes tests but renders badly is not done. Capture against a locally
stood-up stack (Playwright screenshot, headless browser, or the dev
server).

Every PR that changes user-visible behavior MUST then include those
screenshots in the PR description - before-and-after pairs when changing
existing UI, a single shot for new UI. A frontend PR without screenshots
of the visible change is incomplete.

# Self-serve testing (user directive, 2026-08-12)

Standing authorization: stand up whatever is needed to test - dev servers,
backend processes, mock backends, fixture data - without asking permission.
Ephemeral test instances on unused ports are always fine (leave standing
user-facing services alone per Service safety below). "Blocked waiting for
permission to test" is never an acceptable state; if the full stack is
unavailable, test against the closest achievable approximation and state
what was substituted.

# Backend coordination

The Dinkster backend is developed by a separate Amp thread with its own
checkout; the repos synchronize only through origin. Find the current owner
thread in the workspace root `CURRENT-PRIORITIES.md`; message it with
`steer: false`, include this thread's ID so replies route back, and quote
any user words verbatim. Message the backend only for contract-visible
matters (wire versions, routes, joint contracts) - not frontend-internal
progress.

# Standing push authorization

The user granted standing push permission on 2026-07-27: completed,
validated work on this repo's main branch is pushed to origin as it lands,
without per-slice authorization, so local commits are never the only copy.
This does not extend to force-pushes, history rewrites, or other repos.

# Reset the dev server before E2E runs

The Playwright config reuses an existing dev server on :5199
(`reuseExistingServer: true`), so a long-lived Vite process serves a STALE
module graph and produces uniform bogus E2E failures (e.g. a missing-export
page error on every test). This is the cause almost every time E2E fails
broadly. Resetting is cheap; debugging phantom failures is not. ALWAYS kill
any listener on :5199 before starting an E2E run and let Playwright spawn a
fresh server:

```bash
kill $(ss -tlnp 2>/dev/null | grep :5199 | grep -oP 'pid=\K[0-9]+' | sort -u) 2>/dev/null; true
```

# Service safety

Never signal, kill, restart, or replace the :5199 dev server, the :3639
backend, or any other standing process while a browser or E2E session is
using it. Check for active sessions first. Read-only inspection (process
identity, ports, logs, HTTP state) is always fine.

# Backend selection

Frontend work runs on the frontend host assigned by the workspace-root
`DELEGATION.md`. The only supported frontend backend is the local
`http://127.0.0.1:3639` process from that host's Dinkster checkout. Remote
backends and fallback routes are forbidden; never restore a cross-machine
backend dependency. The service runs real generation with a persistent
library root and the host's ComfyUI checkout/interpreter. Run from the sibling
`Dinkster` checkout (wrap in a systemd user unit once the stack is stood up):

```bash
.venv/bin/dinkster-serve --host 127.0.0.1 \
  --library-root ~/.local/state/dinkster/frontend-backend/library \
  --comfy-root ../ComfyUI --comfy-python ../ComfyUI/venv/bin/python
```

# Restarting the local :5199 dev server

Persistent user-facing test sessions MUST bind only the frontend to
`0.0.0.0:5199` so the same listener is reachable through every active LAN
and Tailscale interface. The LAN browser entry point is
`http://<frontend-host-lan-ip>:5199` - verify this host's actual LAN address
with `ip addr` and confirm an HTTP request through it succeeds before
reporting it; when this host has a Tailscale address, use
`http://<tailscale-ip-or-name>:5199`. Do not report a Tailscale URL unless
that address or name exists and an HTTP request through it succeeds.

Vite's same-origin proxy defaults to the Dinkster server on loopback port 3639.
Set the environment variable explicitly when using another port. Never expose
the backend directly. Canonical restart, from `packages/app`:

```bash
DINKSTER_NATIVE_BACKEND=http://127.0.0.1:3639 nohup pnpm dev --host 0.0.0.0 --strictPort > /tmp/dinkster-frontend-5199.log 2>&1 &
```

Verify the direct and proxied catalogs are byte-identical before reporting
the stack ready:

```bash
curl -fsS "http://127.0.0.1:3639/api/nodes?wire=40" -o /tmp/dinkster-nodes-direct.json
curl -fsS "http://127.0.0.1:5199/api/nodes?wire=40" -o /tmp/dinkster-nodes-proxy.json
cmp /tmp/dinkster-nodes-direct.json /tmp/dinkster-nodes-proxy.json
```

The server currently serves schema wires 22 through 45. If the request returns
406 wire-version-unsupported, use one from the error's `supported` list and
update the example above.

Also verify the frontend through the machine's actual LAN address and, when
present, its actual Tailscale address. An all-interface bind is necessary
but is not proof that Tailscale is installed or reachable. Isolated
ephemeral CI/browser servers that are not kept running for the user may
remain loopback-only.

# Comment policy

Comments explain genuinely difficult behavior, invariants, safety or
compatibility constraints, or non-obvious reasons. They must not embed
plans, task status, implementation history, delegation or review narratives,
or promises of future work. Never use invented plan jargon anywhere a human
reads - milestone tags, slice/commission codes,
track or generation labels, or any code word that only means something with
access to a transient plan. This ban covers comments, commit messages, PR
titles/descriptions, issue text, and docs: name work by what it does, in
plain words a reviewer can understand standalone. Durable real identifiers
are fine (issue/PR numbers, version numbers, wire versions, commit SHAs, API
names). Prefer clearer code and names over comments that narrate obvious
code. Track legitimate future work in GitHub issues, not in comments.

# Code review discipline

Every slice or big change gets a code review (oracle or equivalent reviewer)
after it ships, before the next slice starts. Review findings are fixed or
explicitly deferred to a GitHub issue - never silently dropped. When a group
of slices completes, review the affected area as a whole.

# Performance record

`docs/perf.md` holds measured baselines from
`packages/e2e/tests/perf.spec.ts`. Any change expected to move those numbers
(renderer, scene build, CanvasHost structure, document pipeline) must append
a new dated row with before/after numbers rather than overwriting history.
