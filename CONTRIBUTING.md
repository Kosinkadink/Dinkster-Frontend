# Contributing to Dinkster-Frontend

## Local checks

Install Node.js 22 and pnpm 10.31.0. Clone Dinkster beside this repository, or
set `DINKSTER_SOURCE_ROOT` to a Dinkster checkout, then run:

```sh
pnpm install --frozen-lockfile
pnpm ci:fast
pnpm test
pnpm --filter @dinkster/app build
```

See [Testing](docs/testing.md) for the full validation matrix, live-backend
setup, browser suites, and test isolation requirements.

## Pull requests

- Keep each pull request focused and include tests for behavior changes.
- Update the current document under `docs/` when user-visible behavior or a
  system contract changes.
- Include inspected screenshots in the pull request description for every
  user-visible change.
- Keep backend inputs pinned to immutable 40-character commits.
- Do not put repository credentials, release tokens, or backend credentials in
  source, build artifacts, fixtures, or browser storage.
- Use ASCII in source, tests, documentation, commit messages, and pull request
  text. Locale catalogs may use their target language.

GitHub may hold workflows from fork pull requests until a maintainer approves
the run. That approval is the repository's fork CI security gate.

Contributions are licensed under GPL-3.0.
