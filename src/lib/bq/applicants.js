import {
  copilotApplicantsRef,
  copilotDbRef,
  getBigQueryClient,
  getBqConfig,
} from "../bqConfig.js";
import { splitIgIdentity } from "../instagram.js";
import { normalizePersonName } from "../notion/parseProps.js";

function tableRef() {
  return copilotApplicantsRef();
}

function queryOptions(params = {}, types = undefined) {
  const { location } = getBqConfig();
  const options = {
    location,
    params,
  };
  if (types) options.types = types;
  return options;
}

/** Coerce Notion/JS numbers to INT64-safe integers (or null). */
function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

const APPLICANT_PARAM_TYPES = {
  notion_page_id: "STRING",
  email: "STRING",
  first_name: "STRING",
  last_name: "STRING",
  full_name: "STRING",
  region: "STRING",
  phone: "STRING",
  ig_handle: "STRING",
  ig_url: "STRING",
  ig_followers: "INT64",
  ig_followers_scraped: "INT64",
  ig_is_public: "BOOL",
  tiktok_handle: "STRING",
  tiktok_followers: "INT64",
  other_channels: "STRING", // JSON text → PARSE_JSON in MERGE
  submitted_at: "TIMESTAMP",
  application_status: "STRING",
  previous_application: "BOOL",
  never_consider: "BOOL",
  mt_user_id: "STRING",
  mt_email: "STRING",
  mt_account_exists: "BOOL",
  mt_class_count: "INT64",
  mt_has_cc: "BOOL",
  mt_home_studio: "STRING",
  mt_profile_link: "STRING",
  social_enrichment_error: "STRING",
  social_enriched_at: "TIMESTAMP",
  mt_enriched_at: "TIMESTAMP",
  enriched_at: "TIMESTAMP",
  pre_pipeline: "BOOL",
  accepted_before: "BOOL",
};

function serializeOtherChannels(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return null;
    return JSON.stringify(value);
  }
  return null;
}

/**
 * Ensure applicant schema: renames legacy IG cols, adds TikTok / other_channels /
 * cutoff columns (idempotent). Batches ADDs + retries on table-update quota.
 */
export async function ensureApplicantSchema() {
  const bigquery = getBigQueryClient();
  const { projectId, dataset, applicantsTable, location } = getBqConfig();
  const tableId = `\`${projectId}.${dataset}.${applicantsTable}\``;

  const [cols] = await bigquery.query({
    query: `
      SELECT LOWER(column_name) AS column_name
      FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = @table
    `,
    location,
    params: { table: applicantsTable },
  });
  const have = new Set(cols.map((r) => r.column_name));

  const renames = [
    ["instagram_handle", "ig_handle"],
    ["instagram_followers_form", "ig_followers"],
    ["instagram_followers_scraped", "ig_followers_scraped"],
    ["instagram_is_public", "ig_is_public"],
  ];
  for (const [from, to] of renames) {
    if (have.has(from) && !have.has(to)) {
      await runAlterWithRetry(
        bigquery,
        location,
        `ALTER TABLE ${tableId} RENAME COLUMN ${from} TO ${to}`
      );
      have.delete(from);
      have.add(to);
      console.log(`   Renamed ${from} → ${to}`);
    }
  }

  const adds = [
    "ig_handle STRING",
    "ig_url STRING",
    "ig_followers INT64",
    "ig_followers_scraped INT64",
    "ig_is_public BOOL",
    "tiktok_handle STRING",
    "tiktok_followers INT64",
    "other_channels JSON",
    "pre_pipeline BOOL",
    "accepted_before BOOL",
    "rejection_emailed_at TIMESTAMP",
    "credit_applied BOOL",
    "credit_applied_at TIMESTAMP",
  ].filter((col) => !have.has(col.split(/\s+/)[0].toLowerCase()));

  if (adds.length) {
    const sql = `ALTER TABLE ${tableId}\n${adds
      .map((c) => `  ADD COLUMN IF NOT EXISTS ${c}`)
      .join(",\n")}`;
    await runAlterWithRetry(bigquery, location, sql);
    console.log(`   Added columns: ${adds.map((c) => c.split(/\s+/)[0]).join(", ")}`);
  }
}

async function runAlterWithRetry(bigquery, location, query) {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bigquery.query({ query, location });
      return;
    } catch (error) {
      const msg = error?.message || String(error);
      const rateLimited =
        msg.includes("rate limits") || msg.includes("quota for table update");
      if (!rateLimited || attempt === maxAttempts) throw error;
      const waitMs = attempt * 15000;
      console.warn(
        `   ⏳ Table update quota — retry ${attempt}/${maxAttempts} in ${waitMs / 1000}s`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** @deprecated use ensureApplicantSchema */
export async function ensurePrePipelineColumn() {
  return ensureApplicantSchema();
}

/**
 * Mark current Accepted Notion pages as accepted_before (historical Accepted).
 * Also sets pre_pipeline=TRUE so nudge/promote stays off.
 * @param {string[]} notionPageIds
 * @returns {Promise<number>} rows updated
 */
export async function markAcceptedBefore(notionPageIds) {
  const ids = [...new Set((notionPageIds || []).filter(Boolean))];
  if (!ids.length) return 0;

  const bigquery = getBigQueryClient();
  const query = `
    UPDATE ${tableRef()}
    SET
      accepted_before = TRUE,
      pre_pipeline = TRUE,
      application_status = 'accepted',
      updated_at = CURRENT_TIMESTAMP()
    WHERE notion_page_id IN UNNEST(@ids)
  `;
  const [job] = await bigquery.createQueryJob({
    query,
    ...queryOptions({ ids }, { ids: ["STRING"] }),
  });
  await job.getQueryResults();
  return Number(job.metadata?.statistics?.query?.numDmlAffectedRows || 0);
}

/**
 * @returns {Promise<boolean>}
 */
export async function hasPriorApplicationByEmail(email, excludeNotionPageId) {
  if (!email) return false;
  const bigquery = getBigQueryClient();
  const query = `
    SELECT 1 AS ok
    FROM ${tableRef()}
    WHERE LOWER(email) = LOWER(@email)
      AND notion_page_id != @excludeNotionPageId
    LIMIT 1
  `;
  const [rows] = await bigquery.query({
    query,
    ...queryOptions({ email, excludeNotionPageId }),
  });
  return rows.length > 0;
}

/**
 * @returns {Promise<object|null>}
 */
export async function getApplicantByNotionPageId(notionPageId) {
  const bigquery = getBigQueryClient();
  const query = `
    SELECT *
    FROM ${tableRef()}
    WHERE notion_page_id = @notionPageId
    LIMIT 1
  `;
  const [rows] = await bigquery.query({
    query,
    ...queryOptions({ notionPageId }),
  });
  return rows[0] ?? null;
}

export async function getApplicantByEmail(email) {
  const key = String(email || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  const bigquery = getBigQueryClient();
  const query = `
    SELECT *
    FROM ${tableRef()}
    WHERE LOWER(email) = @email
    ORDER BY promoted_at DESC NULLS LAST, updated_at DESC NULLS LAST
    LIMIT 1
  `;
  const [rows] = await bigquery.query({
    query,
    ...queryOptions({ email: key }),
  });
  return rows[0] ?? null;
}

/**
 * Rejected email/credit: eligible when evaluate has processed the row
 * (pre_pipeline = FALSE). Historical backfill stays TRUE.
 * Missing BQ row → not eligible (safe default).
 * @returns {Promise<boolean>}
 */
export async function isPipelineEligible(notionPageId) {
  const row = await getApplicantByNotionPageId(notionPageId);
  if (!row) return false;
  return row.pre_pipeline === false;
}

/**
 * Accepted nudge/promote: same as pipeline eligible, but never for
 * accepted_before (Accepted cohort before go-live).
 * @returns {Promise<boolean>}
 */
export async function isAcceptedActionEligible(notionPageId) {
  const row = await getApplicantByNotionPageId(notionPageId);
  if (!row) return false;
  if (row.accepted_before === true) return false;
  return row.pre_pipeline === false;
}

/**
 * Full upsert from evaluate / re-evaluate.
 * Defaults: pre_pipeline=FALSE, accepted_before=FALSE (new pipeline rows).
 * Pass pre_pipeline=true + accepted_before=true for historical Accepted refresh.
 * @param {object} row
 */
export async function upsertApplicant(row) {
  const bigquery = getBigQueryClient();
  const prePipeline = row.pre_pipeline === true;
  const acceptedBefore = row.accepted_before === true;

  const query = `
    MERGE ${tableRef()} AS t
    USING (
      SELECT
        @notion_page_id AS notion_page_id,
        @email AS email,
        @first_name AS first_name,
        @last_name AS last_name,
        @full_name AS full_name,
        @region AS region,
        @phone AS phone,
        @ig_handle AS ig_handle,
        @ig_url AS ig_url,
        @ig_followers AS ig_followers,
        @ig_followers_scraped AS ig_followers_scraped,
        @ig_is_public AS ig_is_public,
        @tiktok_handle AS tiktok_handle,
        @tiktok_followers AS tiktok_followers,
        IF(
          @other_channels IS NULL,
          CAST(NULL AS JSON),
          PARSE_JSON(@other_channels)
        ) AS other_channels,
        @submitted_at AS submitted_at,
        @application_status AS application_status,
        @previous_application AS previous_application,
        @never_consider AS never_consider,
        @mt_user_id AS mt_user_id,
        @mt_email AS mt_email,
        @mt_account_exists AS mt_account_exists,
        @mt_class_count AS mt_class_count,
        @mt_has_cc AS mt_has_cc,
        @mt_home_studio AS mt_home_studio,
        @mt_profile_link AS mt_profile_link,
        @social_enrichment_error AS social_enrichment_error,
        @social_enriched_at AS social_enriched_at,
        @mt_enriched_at AS mt_enriched_at,
        @enriched_at AS enriched_at,
        @pre_pipeline AS pre_pipeline,
        @accepted_before AS accepted_before
    ) AS s
    ON t.notion_page_id = s.notion_page_id
    WHEN MATCHED THEN UPDATE SET
      email = s.email,
      first_name = s.first_name,
      last_name = s.last_name,
      full_name = s.full_name,
      region = s.region,
      phone = s.phone,
      ig_handle = s.ig_handle,
      ig_url = s.ig_url,
      ig_followers = s.ig_followers,
      ig_followers_scraped = s.ig_followers_scraped,
      ig_is_public = s.ig_is_public,
      tiktok_handle = s.tiktok_handle,
      tiktok_followers = s.tiktok_followers,
      other_channels = s.other_channels,
      submitted_at = s.submitted_at,
      application_status = s.application_status,
      previous_application = s.previous_application,
      never_consider = s.never_consider,
      mt_user_id = s.mt_user_id,
      mt_email = s.mt_email,
      mt_account_exists = s.mt_account_exists,
      mt_class_count = s.mt_class_count,
      mt_has_cc = s.mt_has_cc,
      mt_home_studio = s.mt_home_studio,
      mt_profile_link = s.mt_profile_link,
      social_enrichment_error = s.social_enrichment_error,
      social_enriched_at = s.social_enriched_at,
      mt_enriched_at = s.mt_enriched_at,
      enriched_at = s.enriched_at,
      pre_pipeline = CASE
        WHEN s.accepted_before IS TRUE THEN TRUE
        ELSE s.pre_pipeline
      END,
      accepted_before = CASE
        WHEN s.accepted_before IS TRUE THEN TRUE
        WHEN t.accepted_before IS TRUE THEN TRUE
        ELSE FALSE
      END,
      updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
      notion_page_id, email, first_name, last_name, full_name, region, phone,
      ig_handle, ig_url, ig_followers, ig_followers_scraped, ig_is_public,
      tiktok_handle, tiktok_followers, other_channels,
      submitted_at, application_status, previous_application,
      never_consider, mt_user_id, mt_email, mt_account_exists, mt_class_count,
      mt_has_cc, mt_home_studio, mt_profile_link, social_enrichment_error,
      social_enriched_at, mt_enriched_at, enriched_at, pre_pipeline,
      accepted_before, created_at, updated_at
    ) VALUES (
      s.notion_page_id, s.email, s.first_name, s.last_name, s.full_name,
      s.region, s.phone, s.ig_handle, s.ig_url, s.ig_followers,
      s.ig_followers_scraped, s.ig_is_public, s.tiktok_handle, s.tiktok_followers,
      s.other_channels, s.submitted_at,
      s.application_status, s.previous_application, s.never_consider,
      s.mt_user_id, s.mt_email, s.mt_account_exists, s.mt_class_count,
      s.mt_has_cc, s.mt_home_studio, s.mt_profile_link, s.social_enrichment_error,
      s.social_enriched_at, s.mt_enriched_at, s.enriched_at, s.pre_pipeline,
      s.accepted_before, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    )
  `;

  await bigquery.query({
    query,
    ...queryOptions(
      {
        notion_page_id: row.notion_page_id,
        email: row.email ?? null,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        full_name: row.full_name ?? null,
        region: row.region ?? null,
        phone: row.phone ?? null,
        ig_handle: row.ig_handle ?? null,
        ig_url: row.ig_url ?? null,
        ig_followers: toIntOrNull(row.ig_followers),
        ig_followers_scraped: toIntOrNull(row.ig_followers_scraped),
        ig_is_public: row.ig_is_public ?? null,
        tiktok_handle: row.tiktok_handle ?? null,
        tiktok_followers: toIntOrNull(row.tiktok_followers),
        other_channels: serializeOtherChannels(row.other_channels),
        submitted_at: row.submitted_at ?? null,
        application_status: row.application_status ?? null,
        previous_application: row.previous_application ?? null,
        never_consider: row.never_consider ?? null,
        mt_user_id: row.mt_user_id ?? null,
        mt_email: row.mt_email ?? null,
        mt_account_exists: row.mt_account_exists ?? null,
        mt_class_count: toIntOrNull(row.mt_class_count),
        mt_has_cc: row.mt_has_cc ?? null,
        mt_home_studio: row.mt_home_studio ?? null,
        mt_profile_link: row.mt_profile_link ?? null,
        social_enrichment_error: row.social_enrichment_error ?? null,
        social_enriched_at: row.social_enriched_at ?? null,
        mt_enriched_at: row.mt_enriched_at ?? null,
        enriched_at: row.enriched_at ?? null,
        pre_pipeline: prePipeline,
        accepted_before: acceptedBefore,
      },
      APPLICANT_PARAM_TYPES
    ),
  });
}

/**
 * Notion snapshot upsert for historical backfill.
 * Sets pre_pipeline = TRUE on insert; never flips an existing FALSE back to TRUE.
 * Does not overwrite MT/social enrichment fields.
 * @param {object} row
 */
export async function upsertApplicantBackfill(row) {
  const bigquery = getBigQueryClient();
  const query = `
    MERGE ${tableRef()} AS t
    USING (
      SELECT
        @notion_page_id AS notion_page_id,
        @email AS email,
        @first_name AS first_name,
        @last_name AS last_name,
        @full_name AS full_name,
        @region AS region,
        @phone AS phone,
        @ig_handle AS ig_handle,
        @ig_url AS ig_url,
        @ig_followers AS ig_followers,
        @tiktok_handle AS tiktok_handle,
        @tiktok_followers AS tiktok_followers,
        IF(
          @other_channels IS NULL,
          CAST(NULL AS JSON),
          PARSE_JSON(@other_channels)
        ) AS other_channels,
        @submitted_at AS submitted_at,
        @application_status AS application_status,
        @never_consider AS never_consider
    ) AS s
    ON t.notion_page_id = s.notion_page_id
    WHEN MATCHED THEN UPDATE SET
      email = s.email,
      first_name = s.first_name,
      last_name = s.last_name,
      full_name = s.full_name,
      region = s.region,
      phone = s.phone,
      ig_handle = s.ig_handle,
      ig_url = s.ig_url,
      ig_followers = s.ig_followers,
      tiktok_handle = s.tiktok_handle,
      tiktok_followers = s.tiktok_followers,
      other_channels = s.other_channels,
      submitted_at = s.submitted_at,
      application_status = s.application_status,
      never_consider = s.never_consider,
      pre_pipeline = CASE
        WHEN t.pre_pipeline IS FALSE THEN FALSE
        WHEN t.enriched_at IS NOT NULL THEN FALSE
        ELSE TRUE
      END,
      updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
      notion_page_id, email, first_name, last_name, full_name, region, phone,
      ig_handle, ig_url, ig_followers, tiktok_handle, tiktok_followers, other_channels,
      submitted_at, application_status, never_consider, pre_pipeline,
      created_at, updated_at
    ) VALUES (
      s.notion_page_id, s.email, s.first_name, s.last_name, s.full_name,
      s.region, s.phone, s.ig_handle, s.ig_url, s.ig_followers, s.tiktok_handle,
      s.tiktok_followers, s.other_channels, s.submitted_at, s.application_status,
      s.never_consider, TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
    )
  `;

  await bigquery.query({
    query,
    ...queryOptions(
      {
        notion_page_id: row.notion_page_id,
        email: row.email ?? null,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        full_name: row.full_name ?? null,
        region: row.region ?? null,
        phone: row.phone ?? null,
        ig_handle: row.ig_handle ?? null,
        ig_url: row.ig_url ?? null,
        ig_followers: toIntOrNull(row.ig_followers),
        tiktok_handle: row.tiktok_handle ?? null,
        tiktok_followers: toIntOrNull(row.tiktok_followers),
        other_channels: serializeOtherChannels(row.other_channels),
        submitted_at: row.submitted_at ?? null,
        application_status: row.application_status ?? null,
        never_consider: row.never_consider ?? null,
      },
      {
        notion_page_id: "STRING",
        email: "STRING",
        first_name: "STRING",
        last_name: "STRING",
        full_name: "STRING",
        region: "STRING",
        phone: "STRING",
        ig_handle: "STRING",
        ig_url: "STRING",
        ig_followers: "INT64",
        tiktok_handle: "STRING",
        tiktok_followers: "INT64",
        other_channels: "STRING",
        submitted_at: "TIMESTAMP",
        application_status: "STRING",
        never_consider: "BOOL",
      }
    ),
  });
}

/**
 * @returns {Promise<boolean>}
 */
export async function isPromotedToCopilotDb(notionPageId) {
  const row = await getApplicantByNotionPageId(notionPageId);
  return Boolean(row?.promoted_at);
}

export async function markPromoted(notionPageId) {
  const bigquery = getBigQueryClient();
  const query = `
    UPDATE ${tableRef()}
    SET
      application_status = 'accepted',
      promoted_at = CURRENT_TIMESTAMP(),
      pre_pipeline = FALSE,
      updated_at = CURRENT_TIMESTAMP()
    WHERE notion_page_id = @notionPageId
  `;
  await bigquery.query({
    query,
    ...queryOptions({ notionPageId }),
  });
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Pipeline depth for detecting backward Notion moves. */
export function statusRank(status) {
  const s = normalizeStatus(status);
  if (!s || s === "no status") return 0;
  if (s === "evaluated") return 1;
  if (s === "accepted" || s === "rejected" || s === "duplicate") return 2;
  if (s === "accepted - contacted" || s === "rejected - contacted") return 3;
  if (s === "onboarded") return 4;
  return 1;
}

/**
 * Sync Notion Status → BQ application_status.
 * When moved backward to Evaluated / No Status, also clear promoted_at.
 * @returns {Promise<'inserted'|'updated'|'cleared'|'noop'|'missing'>}
 */
export async function syncApplicantStatusFromNotion({
  notionPageId,
  notionStatus,
  clearAdvanced = false,
}) {
  const bigquery = getBigQueryClient();
  const status = String(notionStatus || "").trim() || null;
  const existing = await getApplicantByNotionPageId(notionPageId);

  if (!existing) {
    if (!status) return "missing";
    // Lightweight row so status tracking works even before enrich
    const query = `
      INSERT INTO ${tableRef()} (
        notion_page_id, application_status, pre_pipeline, created_at, updated_at
      ) VALUES (
        @notionPageId, @status, TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
      )
    `;
    await bigquery.query({
      query,
      ...queryOptions({ notionPageId, status }),
    });
    return "inserted";
  }

  const prev = normalizeStatus(existing.application_status);
  const next = normalizeStatus(status);
  const movedBack = statusRank(status) < statusRank(existing.application_status);
  const shouldClear =
    clearAdvanced ||
    (movedBack && statusRank(status) <= 1);

  if (prev === next && !shouldClear && !existing.promoted_at) {
    return "noop";
  }

  const query = `
    UPDATE ${tableRef()}
    SET
      application_status = @status,
      promoted_at = IF(@clearAdvanced, NULL, promoted_at),
      rejection_emailed_at = IF(@clearAdvanced, NULL, rejection_emailed_at),
      credit_applied = IF(@clearAdvanced, FALSE, credit_applied),
      credit_applied_at = IF(@clearAdvanced, NULL, credit_applied_at),
      updated_at = CURRENT_TIMESTAMP()
    WHERE notion_page_id = @notionPageId
  `;
  await bigquery.query({
    query,
    ...queryOptions(
      {
        notionPageId,
        status,
        clearAdvanced: shouldClear,
      },
      {
        notionPageId: "STRING",
        status: "STRING",
        clearAdvanced: "BOOL",
      }
    ),
  });

  return shouldClear ? "cleared" : "updated";
}

/**
 * Rejected rows still needing thank-you credit (BQ-driven; Notion stays Rejected).
 * @returns {Promise<object[]>}
 */
export async function listRejectedPendingCreditFromBq() {
  const bigquery = getBigQueryClient();
  const query = `
    SELECT
      notion_page_id AS notionPageId,
      email,
      first_name AS firstName,
      last_name AS lastName,
      full_name AS fullName,
      region,
      rejection_emailed_at AS rejectionEmailedAt,
      credit_applied AS creditApplied
    FROM ${tableRef()}
    WHERE LOWER(IFNULL(application_status, '')) = 'rejected'
      AND pre_pipeline IS FALSE
      AND IFNULL(credit_applied, FALSE) IS FALSE
      AND rejection_emailed_at IS NOT NULL
      AND email IS NOT NULL
      AND email != ''
  `;
  const [rows] = await bigquery.query({ query, ...queryOptions() });
  return rows || [];
}

export async function markRejectionEmailed(notionPageId) {
  const bigquery = getBigQueryClient();
  const query = `
    UPDATE ${tableRef()}
    SET
      application_status = 'rejected',
      rejection_emailed_at = CURRENT_TIMESTAMP(),
      updated_at = CURRENT_TIMESTAMP()
    WHERE notion_page_id = @notionPageId
  `;
  await bigquery.query({
    query,
    ...queryOptions({ notionPageId }),
  });
}

export async function markRejectionCreditApplied(notionPageId) {
  const bigquery = getBigQueryClient();
  const query = `
    UPDATE ${tableRef()}
    SET
      credit_applied = TRUE,
      credit_applied_at = CURRENT_TIMESTAMP(),
      updated_at = CURRENT_TIMESTAMP()
    WHERE notion_page_id = @notionPageId
  `;
  await bigquery.query({
    query,
    ...queryOptions({ notionPageId }),
  });
}

/**
 * When demoting away from Rejected, clear rejection outreach markers.
 */
export async function clearRejectionMarkers(notionPageId) {
  const bigquery = getBigQueryClient();
  const query = `
    UPDATE ${tableRef()}
    SET
      rejection_emailed_at = NULL,
      credit_applied = FALSE,
      credit_applied_at = NULL,
      updated_at = CURRENT_TIMESTAMP()
    WHERE notion_page_id = @notionPageId
  `;
  await bigquery.query({
    query,
    ...queryOptions({ notionPageId }),
  });
}

/** Map Notion/applicant region labels onto copilot_db conventions (TO | NYC). */
function normalizeCopilotRegion(region) {
  const r = String(region || "")
    .trim()
    .toUpperCase();
  if (!r) return null;
  if (r === "TO" || r.includes("TORONTO") || r === "YYZ") return "TO";
  if (r === "NY" || r === "NYC" || r.includes("NEW YORK")) return "NYC";
  return region;
}

/**
 * Insert a minimal row into copilot_db if contact_email is not already present.
 * Writes identity + social (ig / tiktok / other_channels) when available.
 * @returns {'inserted' | 'skipped' | 'exists'}
 */
export async function promoteToCopilotDb(applicant) {
  const email = applicant.email?.trim().toLowerCase();
  if (!email) return "skipped";

  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();

  const [existing] = await bigquery.query({
    query: `
      SELECT promo_code
      FROM ${copilotRef}
      WHERE LOWER(contact_email) = LOWER(@email)
      LIMIT 1
    `,
    ...queryOptions({ email }),
  });
  if (existing.length > 0) {
    await bigquery.query({
      query: `
        UPDATE ${copilotRef}
        SET
          promoted_at = COALESCE(promoted_at, CURRENT_TIMESTAMP()),
          updated_at = CURRENT_TIMESTAMP()
        WHERE LOWER(contact_email) = LOWER(@email)
          AND promoted_at IS NULL
      `,
      ...queryOptions({ email }),
    });
    return "exists";
  }

  const region = normalizeCopilotRegion(applicant.region);
  const tier = applicant.tier?.trim() || "Seeker";
  const person = normalizePersonName(applicant.first_name, applicant.last_name);
  const ig = splitIgIdentity(
    applicant.ig_handle ?? applicant.ig_url ?? applicant.social_handle ?? null
  );
  const igHandle = ig.handle;
  const igUrl = applicant.ig_url || ig.url;
  const igFollowersRaw =
    applicant.ig_followers ?? applicant.followers ?? null;
  const igFollowers =
    igFollowersRaw != null && Number.isFinite(Number(igFollowersRaw))
      ? Math.round(Number(igFollowersRaw))
      : null;
  const tiktokFollowersRaw = applicant.tiktok_followers ?? null;
  const tiktokFollowers =
    tiktokFollowersRaw != null && Number.isFinite(Number(tiktokFollowersRaw))
      ? Math.round(Number(tiktokFollowersRaw))
      : null;
  const otherChannels =
    applicant.other_channels == null
      ? null
      : typeof applicant.other_channels === "string"
        ? applicant.other_channels
        : JSON.stringify(applicant.other_channels);

  const query = `
    INSERT INTO ${copilotRef} (
      contact_email,
      first_name,
      last_name,
      region,
      tier,
      user_id,
      mt_email,
      mt_profile_link,
      ig_handle,
      ig_url,
      ig_followers,
      tiktok_handle,
      tiktok_followers,
      other_channels,
      promoted_at,
      updated_at
    )
    VALUES (
      @email,
      @first_name,
      @last_name,
      @region,
      @tier,
      @mt_user_id,
      @mt_email,
      @mt_profile_link,
      @ig_handle,
      @ig_url,
      @ig_followers,
      @tiktok_handle,
      @tiktok_followers,
      IF(@other_channels IS NULL, CAST(NULL AS JSON), PARSE_JSON(@other_channels)),
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    )
  `;

  await bigquery.query({
    query,
    ...queryOptions(
      {
        email,
        first_name: person.firstName || null,
        last_name: person.lastName || null,
        region,
        tier,
        mt_user_id: applicant.mt_user_id ?? null,
        mt_email: applicant.mt_email ?? null,
        mt_profile_link: applicant.mt_profile_link ?? null,
        ig_handle: igHandle,
        ig_url: igUrl,
        ig_followers: igFollowers,
        tiktok_handle: applicant.tiktok_handle ?? null,
        tiktok_followers: tiktokFollowers,
        other_channels: otherChannels,
      },
      {
        email: "STRING",
        first_name: "STRING",
        last_name: "STRING",
        region: "STRING",
        tier: "STRING",
        mt_user_id: "STRING",
        mt_email: "STRING",
        mt_profile_link: "STRING",
        ig_handle: "STRING",
        ig_url: "STRING",
        ig_followers: "INT64",
        tiktok_handle: "STRING",
        tiktok_followers: "INT64",
        other_channels: "STRING",
      }
    ),
  });

  return "inserted";
}
