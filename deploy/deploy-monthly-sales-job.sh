#!/usr/bin/env bash
# Monthly Co-Pilot code sales — noon ET on the 1st (after the monthly email).
# Writes the previous complete Eastern month to the Toronto and New York reports.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JOB_NAME="${JOB_NAME:-copilot-monthly-sales}"
export SCHEDULER_NAME="${SCHEDULER_NAME:-copilot-monthly-sales-scheduler}"
export IMAGE_NAME="${IMAGE_NAME:-copilot-monthly-sales}"
export JOB_ARGS="${JOB_ARGS:-src/scripts/reportMonthlyPromoSales.js}"
export SCHEDULE="${SCHEDULE:-0 12 1 * *}"
exec "${ROOT}/deploy-lifecycle-job.sh"
