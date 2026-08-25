#!/usr/bin/env bash
# Evaluation + decisions job — 9:30am America/New_York.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-evaluate-copilots}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-evaluate-copilots-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-evaluate-copilots}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/evaluateCopilots.js}"
export SCHEDULE="${SCHEDULE:-30 9 * * *}"
exec "${ROOT}/deploy-lifecycle-job.sh"
