#!/usr/bin/env bash
# Sheet → copilot_db MERGE — 8:45am America/New_York (before evaluate-applications).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-sync-db}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-sync-db-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-sync-db}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/syncCopilotDb.js}"
export SCHEDULE="${SCHEDULE:-45 8 * * *}"
exec "${ROOT}/deploy-lifecycle-job.sh"
