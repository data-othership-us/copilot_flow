#!/usr/bin/env bash
# Hybrid requests — every 15 minutes, 8am–8pm ET, so the first email goes out
# soon after a form submission.
# Emails the request page for in-window matches. A checked session tags Reduced
# and, once Event Credit Link is set, sends the confirmation email.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-hybrid-requests}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-hybrid-requests-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-hybrid-requests}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/processHybridRequests.js}"
export SCHEDULE="${SCHEDULE:-*/15 8-20 * * *}"
exec "${ROOT}/deploy-lifecycle-job.sh"
