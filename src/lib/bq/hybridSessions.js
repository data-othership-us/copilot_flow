import { getBigQueryClient, getBqConfig } from "../bqConfig.js";
import {
  confirmedSessionIds,
  listHybridRequests,
  parseMatchLog,
} from "../notion/hybridRequests.js";

const ROW_TYPE = {
  session_id: "STRING",
  contact_email: "STRING",
  promo_code: "STRING",
};

function tableRef() {
  const { projectId, dataset } = getBqConfig();
  if (!projectId) throw new Error("Missing BQ_PROJECT_ID");
  return `\`${projectId}.${dataset}.copilot_hybrid_sessions\``;
}

/**
 * Confirmed hybrid sessions, one row per Mariana Tek session.
 * A session counts once Copilot Confirm is checked or the session id is stored.
 * @param {object[]} requests
 */
export function hybridSessionRows(requests) {
  const bySession = new Map();
  for (const request of requests || []) {
    const email = String(request.email || "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    const ids = new Set(confirmedSessionIds(request.confirmedSession));
    if (request.copilotConfirm || request.mtTagged) {
      for (const session of parseMatchLog(request.matchLog)) {
        const id = String(session?.id || "").trim();
        if (/^\d{4,}$/.test(id)) ids.add(id);
      }
    }
    if (!ids.size) continue;
    for (const sessionId of ids) {
      bySession.set(sessionId, {
        session_id: sessionId,
        contact_email: email,
        promo_code: String(request.code || "").trim(),
      });
    }
  }
  return [...bySession.values()];
}

/**
 * Replace copilots.copilot_hybrid_sessions from Hybrid Requests.
 * @returns {Promise<number>} rows written
 */
export async function syncHybridSessions() {
  const { location } = getBqConfig();
  const bigquery = getBigQueryClient();
  const dest = tableRef();
  const rows = hybridSessionRows(await listHybridRequests());
  if (!rows.length) {
    await bigquery.query({
      query: `
        CREATE OR REPLACE TABLE ${dest} (
          session_id STRING,
          contact_email STRING,
          promo_code STRING,
          updated_at TIMESTAMP
        )
      `,
      location,
    });
    return 0;
  }
  await bigquery.query({
    query: `
      CREATE OR REPLACE TABLE ${dest} AS
      SELECT
        session_id,
        contact_email,
        promo_code,
        CURRENT_TIMESTAMP() AS updated_at
      FROM UNNEST(@rows)
    `,
    location,
    params: { rows },
    types: { rows: [ROW_TYPE] },
  });
  return rows.length;
}
