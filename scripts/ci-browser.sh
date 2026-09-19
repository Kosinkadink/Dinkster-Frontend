#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUNNER_OS:-}" == Linux && "${RUNNER_ENVIRONMENT:-}" == self-hosted ]]; then
  if command -v bwrap >/dev/null 2>&1; then
    exec bwrap --unshare-net --bind / / --dev-bind /dev /dev --proc /proc --die-with-parent -- "$@"
  fi
  printf '%s\n' 'bwrap is unavailable; running browser command without network isolation.' >&2
fi

exec "$@"
