#!/usr/bin/env bash
set -euo pipefail

if [ "${RUNNER_ENVIRONMENT:-}" = "self-hosted" ]; then
  exec "$HOME/comfy-vibe-station/run_counted_suite.sh" "$@"
fi

exec "$@"
