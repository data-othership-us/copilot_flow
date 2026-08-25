#!/usr/bin/env bash
# Onboard job — 9:15am America/New_York (after evaluate-applications).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-onboard}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-onboard-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-onboard}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/onboardCopilots.js}"
export SCHEDULE="${SCHEDULE:-15 9 * * *}"
exec "${ROOT}/deploy-lifecycle-job.sh"
