import { BigQuery } from "@google-cloud/bigquery";

export function getBqConfig() {
  const projectId = process.env.BQ_PROJECT_ID;
  const dataset = process.env.BQ_DATASET || "copilots";
  const copilotTable = process.env.BQ_COPILOT_TABLE || "copilot_db";
  const applicantsTable =
    process.env.BQ_APPLICANTS_TABLE || "copilot_applicants";
  const membershipsTable =
    process.env.BQ_COPILOT_MEMBERSHIPS_TABLE || "copilot_memberships";
  const location = process.env.BQ_QUERY_LOCATION || "US";

  return { projectId, dataset, copilotTable, applicantsTable, membershipsTable, location };
}

export function getBigQueryClient() {
  const { projectId } = getBqConfig();
  // Drive scope required to query Google Sheets external tables (raw_to_* / raw_nyc_*).
  const options = {
    scopes: [
      "https://www.googleapis.com/auth/bigquery",
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/drive",
    ],
  };
  if (projectId) options.projectId = projectId;
  return new BigQuery(options);
}

export function copilotDbRef() {
  const { projectId, dataset, copilotTable } = getBqConfig();
  if (!projectId) {
    throw new Error("Missing required env var: BQ_PROJECT_ID");
  }
  return `\`${projectId}.${dataset}.${copilotTable}\``;
}

export function copilotApplicantsRef() {
  const { projectId, dataset, applicantsTable } = getBqConfig();
  if (!projectId) {
    throw new Error("Missing required env var: BQ_PROJECT_ID");
  }
  return `\`${projectId}.${dataset}.${applicantsTable}\``;
}

export function copilotMembershipsRef() {
  const { projectId, dataset, membershipsTable } = getBqConfig();
  if (!projectId) {
    throw new Error("Missing required env var: BQ_PROJECT_ID");
  }
  return `\`${projectId}.${dataset}.${membershipsTable}\``;
}
