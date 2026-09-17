#!/usr/bin/env bash
# Monthly Co-Pilot update — 11:00am ET on the 1st (after event lists at 10:00).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-monthly-email}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-monthly-email-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-monthly-email}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/emailMonthlyUpdate.js}"
export SCHEDULE="${SCHEDULE:-0 11 1 * *}"
exec "${ROOT}/deploy-lifecycle-job.sh"
