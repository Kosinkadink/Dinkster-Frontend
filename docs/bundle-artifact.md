# Frontend bundle artifacts

CI publishes `dinkster-frontend-<sha256>` after fast checks pass for every
main push and pull request head. The bundle job checks out the head commit,
not GitHub's temporary pull request merge. Artifacts are retained for 90 days.

Each artifact contains `bundle.zip` and `manifest.json`. The manifest fields
are `commit` (full Git commit), `sha256` (lowercase SHA-256 of bundle.zip),
`size` (archive bytes), and `version` (package.json version). The archive
contains the files of `packages/app/dist`, with relative POSIX paths sorted
lexically, ZIP_STORED compression, the ZIP epoch timestamp, and regular-file
mode 0644. File modification times do not affect the hash. Symlinks are refused.

To produce the same artifact locally after building the app:

```sh
pnpm --filter @dinkster/app build
python3 scripts/bundle_artifact.py --output .ci/bundle
```

Dinkster pins the commit and archive hash in `scripts/release_sources.json`.
Its release builder verifies the downloaded archive and manifest before
packaging the files into the frontend wheel. No Node toolchain runs during
release packaging. Missing or expired artifacts fail rather than rebuild;
update the pin to an available tested commit or restore publication through
normal frontend CI before releasing.
