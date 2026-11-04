#!/usr/bin/env bash
# Hybrid requests — every 15 minutes, 8:00am–9:45pm ET.
# Stays in dry run (logs the email, card, and tag; does not send or write)
# until DRY_RUN_VALUE=0 is passed on a later deploy.
# Emails the Free Flow the group will be booked into. Copilot Confirm tags
# each session Reduced and, once Event Credit Link is set, sends the confirmation.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-hybrid-requests}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-hybrid-requests-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-hybrid-requests}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/processHybridRequests.js}"
export SCHEDULE="${SCHEDULE:-*/15 8-21 * * *}"
export DRY_RUN_VALUE="${DRY_RUN_VALUE:-1}"
exec "${ROOT}/deploy-lifecycle-job.sh"
