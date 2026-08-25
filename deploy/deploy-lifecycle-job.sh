#!/usr/bin/env bash
# Deploy a copilot-flow Cloud Run Job + Scheduler. Does NOT execute the job.
#
# Usage:
#   JOB_NAME=copilot-onboard JOB_ARGS=src/scripts/onboardCopilots.js \
#     SCHEDULE="15 9 * * *" ./deploy/deploy-lifecycle-job.sh
#
# Wrappers: deploy-onboard-job.sh, deploy-evaluate-copilots-job.sh,
#           deploy-sync-copilot-db-job.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="${PROJECT_ID:-marianatek-webhooks}"
REGION="${REGION:-us-central1}"
JOB_NAME="${JOB_NAME:?JOB_NAME is required}"
SCHEDULER_NAME="${SCHEDULER_NAME:-${JOB_NAME}-scheduler}"
REPOSITORY="${REPOSITORY:-cloud-run-source-deploy}"
IMAGE_NAME="${IMAGE_NAME:-${JOB_NAME}}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${IMAGE_TAG}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-769349409098-compute@developer.gserviceaccount.com}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/deploy/evaluate-applications.env.yaml}"
JOB_ARGS="${JOB_ARGS:-src/index.js}"
SCHEDULE="${SCHEDULE:-0 9 * * *}"
TIME_ZONE="${TIME_ZONE:-America/New_York}"
MEMORY="${MEMORY:-1Gi}"
CPU="${CPU:-1}"
TASK_TIMEOUT="${TASK_TIMEOUT:-3600}"
EXECUTE_NOW="${EXECUTE_NOW:-0}"

echo "==> Project:   ${PROJECT_ID}"
echo "==> Region:    ${REGION}"
echo "==> Job:       ${JOB_NAME}"
echo "==> Args:      node ${JOB_ARGS}"
echo "==> Scheduler: ${SCHEDULER_NAME} (${SCHEDULE} ${TIME_ZONE})"
echo "==> Image:     ${IMAGE_URI}"
echo "==> SA:        ${SERVICE_ACCOUNT}"

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  echo "Missing .env — copy from .env.example and fill values first."
  exit 1
fi

echo "==> Building env file from .env → ${ENV_FILE}"
python3 - <<'PY'
from pathlib import Path

root = Path.cwd()
src = root / ".env"
dst = root / "deploy" / "evaluate-applications.env.yaml"
dst.parent.mkdir(parents=True, exist_ok=True)

skip = {
    "GOOGLE_APPLICATION_CREDENTIALS",
    "PORT",
    "EVALUATE_LIMIT",
    "EVALUATE_INCLUDE_ACCEPTED",
    "REEVALUATE_EVALUATED",
    "REEVALUATE_ACCEPTED",
    "APPLICATION_LOOKBACK_DAYS",
}
forced = {
    "DRY_RUN": "0",
    "NODE_ENV": "production",
    "SOCIAL_ENRICHMENT_PROVIDER": "apify",
    "BQ_PROJECT_ID": "data-dashboard-463217",
}

env = {}
for line in src.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k = k.strip()
    v = v.strip().strip('"').strip("'")
    if k in skip or not v:
        continue
    env[k] = v

env.update(forced)

lines = []
for k in sorted(env):
    val = env[k].replace("\\", "\\\\").replace('"', '\\"')
    lines.append(f'{k}: "{val}"')
dst.write_text("\n".join(lines) + "\n")
print(f"wrote {len(env)} env vars (DRY_RUN={env['DRY_RUN']})")
PY

gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  --project="${PROJECT_ID}"

if ! gcloud artifacts repositories describe "${REPOSITORY}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "==> Creating Artifact Registry repo: ${REPOSITORY}"
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}"
fi

echo "==> Building and pushing image (Cloud Build)"
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --tag="${IMAGE_URI}" \
  .

echo "==> Creating/updating Cloud Run Job (no execute)"
if gcloud run jobs describe "${JOB_NAME}" --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${IMAGE_URI}" \
    --service-account="${SERVICE_ACCOUNT}" \
    --memory="${MEMORY}" \
    --cpu="${CPU}" \
    --task-timeout="${TASK_TIMEOUT}" \
    --max-retries=1 \
    --command=node \
    --args="${JOB_ARGS}" \
    --env-vars-file="${ENV_FILE}"
else
  gcloud run jobs create "${JOB_NAME}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${IMAGE_URI}" \
    --service-account="${SERVICE_ACCOUNT}" \
    --memory="${MEMORY}" \
    --cpu="${CPU}" \
    --task-timeout="${TASK_TIMEOUT}" \
    --max-retries=1 \
    --command=node \
    --args="${JOB_ARGS}" \
    --env-vars-file="${ENV_FILE}"
fi

URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"

echo "==> Creating/updating Cloud Scheduler (no immediate run)"
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${SCHEDULER_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="${SCHEDULE}" \
    --time-zone="${TIME_ZONE}" \
    --uri="${URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SERVICE_ACCOUNT}" \
    --message-body="{}"
else
  gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="${SCHEDULE}" \
    --time-zone="${TIME_ZONE}" \
    --uri="${URI}" \
    --http-method=POST \
    --oauth-service-account-email="${SERVICE_ACCOUNT}" \
    --message-body="{}"
fi

echo ""
echo "✅ Deployed (scheduled only; job not executed)"
echo "   Job:       ${JOB_NAME}"
echo "   Scheduler: ${SCHEDULER_NAME}"
echo "   Cron:      ${SCHEDULE} (${TIME_ZONE})"
echo ""
echo "Manual run later:"
echo "  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --project=${PROJECT_ID}"

if [[ "${EXECUTE_NOW}" == "1" ]]; then
  echo "==> EXECUTE_NOW=1 — executing once"
  gcloud run jobs execute "${JOB_NAME}" --region="${REGION}" --project="${PROJECT_ID}"
fi
