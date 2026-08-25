import {
  copilotDbRef,
  getBigQueryClient,
  getBqConfig,
} from "../bqConfig.js";

function queryOptions(params = {}, types = undefined) {
  const { location } = getBqConfig();
  const options = { location, params };
  if (types) options.types = types;
  return options;
}

/** Columns added by migrate_copilot_db.sql — idempotent ensure. */
const COPILOT_DB_EXTRA_COLUMNS = [
  "discount_id STRING",
  // percentage kept on table for legacy rows; no longer written
  "promoted_at TIMESTAMP",
  "onboarded_at TIMESTAMP",
  "acceptance_emailed_at TIMESTAMP",
  "updated_at TIMESTAMP",
  "combined_sales FLOAT64",
  "renewal_amt STRING",
  "modash STRING",
  "in_hub STRING",
  "added_to_modash STRING",
  "social_media_status STRING",
  "monthly_audit STRING",
  "google_review STRING",
  "resharing_video STRING",
  "passes_added STRING",
  "monthly_passes STRING",
  "guest_passes STRING",
  "downgraded STRING",
  "previous_membership STRING",
  "flag_for_expiration STRING",
  "last_update_mbh STRING",
  "last_contact STRING",
  // last_class_taken / classes_taken — legacy; not sheet-synced (use performance view)
  "offer_link STRING",
  "status STRING",
  "decision STRING",
  "decision_notes STRING",
  "decision_at TIMESTAMP",
  "decision_source STRING",
  "decision_applied_at TIMESTAMP",
  "freeze_until DATE",
  "never_again BOOL",
  "ig_handle STRING",
  "ig_url STRING",
  "ig_followers INT64",
  "tiktok_handle STRING",
  "tiktok_followers INT64",
  "other_channels JSON",
];

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

/**
 * Ensure migration columns exist on live copilot_db.
 * Renames social_handle/followers → ig_*; adds TikTok + other_channels.
 */
export async function ensureCopilotDbColumns() {
  const bigquery = getBigQueryClient();
  const { projectId, dataset, copilotTable, location } = getBqConfig();
  const tableId = `\`${projectId}.${dataset}.${copilotTable}\``;

  const [cols] = await bigquery.query({
    query: `
      SELECT LOWER(column_name) AS column_name
      FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = @table
    `,
    location,
    params: { table: copilotTable },
  });
  const have = new Set(cols.map((r) => r.column_name));

  const drops = ["home_studio"];
  for (const col of drops) {
    if (!have.has(col)) continue;
    await runAlterWithRetry(
      bigquery,
      location,
      `ALTER TABLE ${tableId} DROP COLUMN IF EXISTS ${col}`
    );
    have.delete(col);
    console.log(`   Dropped ${col}`);
  }

  const renames = [
    ["social_handle", "ig_handle"],
    ["followers", "ig_followers"],
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

  const adds = COPILOT_DB_EXTRA_COLUMNS.filter(
    (col) => !have.has(col.split(/\s+/)[0].toLowerCase())
  );
  if (!adds.length) return;

  const query = `
    ALTER TABLE ${tableId}
    ${adds.map((col) => `ADD COLUMN IF NOT EXISTS ${col}`).join(",\n      ")}
  `;
  await runAlterWithRetry(bigquery, location, query);
  console.log(
    `   Added columns: ${adds.map((c) => c.split(/\s+/)[0]).join(", ")}`
  );
}

function unionRef() {
  const { projectId, dataset } = getBqConfig();
  return `\`${projectId}.${dataset}.raw_copilots_dedup\``;
}

/**
 * Sheet-owned columns updated by sync.
 * Never overwrite: user_id, mt_*, discount_id,
 * promo_code, offer_link, decision*, never_again, promoted_at, onboarded_at, acceptance_emailed_at,
 * tiktok_*, other_channels (applicant/promote-owned), ig_url (applicant URL;
 * sheet sync only fills when empty), ig_followers
 * (onboard seed; live count is Modash on copilot_performance).
 * Membership / classes come from joins in copilot_performance — not sheet sync.
 */
function normalizeIgSql(expr) {
  const { projectId, dataset } = getBqConfig();
  return `\`${projectId}.${dataset}.normalize_ig_handle\`(${expr})`;
}

function storedIgHandleSql(expr) {
  const n = normalizeIgSql(expr);
  return `IF(${n} IS NULL, NULL, CONCAT('@', ${n}))`;
}

function igUrlFromHandleSql(expr) {
  const n = normalizeIgSql(expr);
  return `IF(${n} IS NULL, NULL, CONCAT('https://www.instagram.com/', ${n}, '/'))`;
}

function sheetUpdateSet() {
  return `
  T.first_name = S.first_name,
  T.last_name = S.last_name,
  T.region = S.region,
  T.tier = IF(
    LOWER(IFNULL(T.decision, '')) IN ('upgrade', 'downgrade')
      AND T.decision_applied_at IS NOT NULL,
    T.tier,
    S.tier
  ),
  T.status = IF(
    IFNULL(T.never_again, FALSE)
    OR (
      LOWER(IFNULL(T.decision, '')) IN ('offboard', 'never again', 'never_again')
      AND T.decision_applied_at IS NOT NULL
    ),
    T.status,
    S.status
  ),
  T.bb_link = S.brandbot_link,
  T.ig_handle = ${storedIgHandleSql("S.social_handle")},
  T.ig_url = COALESCE(NULLIF(TRIM(T.ig_url), ''), ${igUrlFromHandleSql("S.social_handle")}),
  T.sheet_membership_expiry = S.sheet_membership_expiry,
  T.hybrid_sales = S.hybrid,
  T.bb_sales = S.bb_amount,
  T.bb_facing_amount = S.bb_facing_amount,
  T.mt_sales = S.mt_amount,
  T.mt_facing_amount = S.mt_facing_amount,
  T.combined_sales = S.combined_sales,
  T.renewal_amt = S.renewal_amt,
  T.modash = S.modash,
  T.in_hub = S.in_hub,
  T.added_to_modash = S.added_to_modash,
  T.social_media_status = S.social_media_status,
  T.monthly_audit = S.monthly_audit,
  T.google_review = S.google_review,
  T.resharing_video = S.resharing_video,
  T.passes_added = S.passes_added,
  T.monthly_passes = S.monthly_passes,
  T.guest_passes = S.guest_passes,
  T.downgraded = S.downgraded,
  T.previous_membership = S.previous_membership,
  T.flag_for_expiration = S.flag_for_expiration,
  T.last_update_mbh = S.last_update_mbh,
  T.last_contact = S.last_contact,
  T.notes = S.notes,
  T.updated_at = CURRENT_TIMESTAMP()
`;
}

/**
 * Preview counts for dry-run.
 */
export async function previewSheetSync() {
  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();
  const source = unionRef();

  const [rows] = await bigquery.query({
    query: `
      SELECT
        (SELECT COUNT(*) FROM ${source}) AS sheet_rows,
        (SELECT COUNT(*) FROM ${source} S
          WHERE NOT EXISTS (
            SELECT 1 FROM ${copilotRef} T
            WHERE LOWER(T.contact_email) = LOWER(S.email)
          )
        ) AS would_insert,
        (SELECT COUNT(*) FROM ${source} S
          WHERE EXISTS (
            SELECT 1 FROM ${copilotRef} T
            WHERE LOWER(T.contact_email) = LOWER(S.email)
          )
        ) AS would_update
    `,
    ...queryOptions(),
  });

  return rows[0] || { sheet_rows: 0, would_insert: 0, would_update: 0 };
}

/**
 * MERGE sheet dedup view → copilot_db.
 * Updates sheet-owned columns only; never overwrites system-owned MT/discount fields.
 */
export async function mergeSheetIntoCopilotDb() {
  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();
  const source = unionRef();

  const query = `
    MERGE ${copilotRef} T
    USING ${source} S
    ON LOWER(T.contact_email) = LOWER(S.email)
    WHEN MATCHED THEN UPDATE SET
      ${sheetUpdateSet()}
    WHEN NOT MATCHED THEN INSERT (
      contact_email,
      first_name,
      last_name,
      region,
      tier,
      status,
      promo_code,
      bb_link,
      ig_handle,
      ig_url,
      ig_followers,
      sheet_membership_expiry,
      hybrid_sales,
      bb_sales,
      bb_facing_amount,
      mt_sales,
      mt_facing_amount,
      combined_sales,
      renewal_amt,
      modash,
      in_hub,
      added_to_modash,
      social_media_status,
      monthly_audit,
      google_review,
      resharing_video,
      passes_added,
      monthly_passes,
      guest_passes,
      downgraded,
      previous_membership,
      flag_for_expiration,
      last_update_mbh,
      last_contact,
      notes,
      updated_at
    ) VALUES (
      S.email,
      S.first_name,
      S.last_name,
      S.region,
      S.tier,
      S.status,
      S.promo_code,
      S.brandbot_link,
      ${storedIgHandleSql("S.social_handle")},
      ${igUrlFromHandleSql("S.social_handle")},
      S.followers,
      S.sheet_membership_expiry,
      S.hybrid,
      S.bb_amount,
      S.bb_facing_amount,
      S.mt_amount,
      S.mt_facing_amount,
      S.combined_sales,
      S.renewal_amt,
      S.modash,
      S.in_hub,
      S.added_to_modash,
      S.social_media_status,
      S.monthly_audit,
      S.google_review,
      S.resharing_video,
      S.passes_added,
      S.monthly_passes,
      S.guest_passes,
      S.downgraded,
      S.previous_membership,
      S.flag_for_expiration,
      S.last_update_mbh,
      S.last_contact,
      S.notes,
      CURRENT_TIMESTAMP()
    )
  `;

  const [job] = await bigquery.createQueryJob({
    query,
    ...queryOptions(),
  });
  await job.getQueryResults();
  const meta = job.metadata?.statistics?.query;
  return {
    affected: Number(meta?.numDmlAffectedRows ?? 0),
  };
}

/**
 * Copy TikTok + other_channels (+ fill empty ig_*) from copilot_applicants
 * onto matching copilot_db rows by email. Does not overwrite non-empty IG from sheet.
 */
export async function backfillSocialFromApplicants() {
  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();
  const { projectId, dataset, applicantsTable } = getBqConfig();
  const applicantsRef = `\`${projectId}.${dataset}.${applicantsTable}\``;

  const query = `
    UPDATE ${copilotRef} AS c
    SET
      ig_handle = COALESCE(NULLIF(TRIM(c.ig_handle), ''), a.ig_handle),
      ig_url = COALESCE(NULLIF(TRIM(c.ig_url), ''), a.ig_url),
      ig_followers = COALESCE(c.ig_followers, a.ig_followers),
      tiktok_handle = a.tiktok_handle,
      tiktok_followers = a.tiktok_followers,
      other_channels = a.other_channels,
      updated_at = CURRENT_TIMESTAMP()
    FROM (
      SELECT
        LOWER(email) AS email_key,
        ANY_VALUE(ig_handle) AS ig_handle,
        ANY_VALUE(ig_url) AS ig_url,
        ANY_VALUE(ig_followers) AS ig_followers,
        ANY_VALUE(tiktok_handle) AS tiktok_handle,
        ANY_VALUE(tiktok_followers) AS tiktok_followers,
        ANY_VALUE(other_channels) AS other_channels
      FROM ${applicantsRef}
      WHERE email IS NOT NULL AND TRIM(email) != ''
      GROUP BY 1
    ) AS a
    WHERE LOWER(c.contact_email) = a.email_key
      AND (
        a.tiktok_handle IS NOT NULL
        OR a.tiktok_followers IS NOT NULL
        OR a.other_channels IS NOT NULL
        OR (
          (c.ig_handle IS NULL OR TRIM(c.ig_handle) = '')
          AND a.ig_handle IS NOT NULL
        )
        OR (
          (c.ig_url IS NULL OR TRIM(c.ig_url) = '')
          AND a.ig_url IS NOT NULL
        )
        OR (c.ig_followers IS NULL AND a.ig_followers IS NOT NULL)
      )
  `;

  const [job] = await bigquery.createQueryJob({
    query,
    ...queryOptions(),
  });
  await job.getQueryResults();
  const meta = job.metadata?.statistics?.query;
  return {
    affected: Number(meta?.numDmlAffectedRows ?? 0),
  };
}

/**
 * Apply CREATE OR REPLACE VIEW/FUNCTION (and CREATE TABLE IF NOT EXISTS)
 * for union, dedup, Modash ingest, performance, evaluation_queue,
 * and add-to-modash.
 * Replaces YOUR_PROJECT with configured project id.
 */
export async function applySheetUnionViews() {
  const bigquery = getBigQueryClient();
  const { projectId, location } = getBqConfig();
  if (!projectId) throw new Error("Missing BQ_PROJECT_ID");

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  for (const file of [
    "normalize_ig_handle.sql",
    "modash_creators.sql",
    "modash_content.sql",
    "raw_copilots_union.sql",
    "raw_copilots_dedup.sql",
    "copilot_performance.sql",
    "copilot_evaluation_queue.sql",
    "copilot_add_to_modash.sql",
  ]) {
    let sql = await fs.readFile(path.join(root, "bq", file), "utf8");
    sql = sql.replaceAll("YOUR_PROJECT", projectId);
    // Prefer the last CREATE so leading comments cannot match first
    const createAt = Math.max(
      sql.lastIndexOf("CREATE OR REPLACE VIEW"),
      sql.lastIndexOf("CREATE OR REPLACE TABLE"),
      sql.lastIndexOf("CREATE OR REPLACE FUNCTION"),
      sql.lastIndexOf("CREATE TABLE IF NOT EXISTS")
    );
    if (createAt < 0) throw new Error(`No CREATE OR REPLACE in ${file}`);
    sql = sql.slice(createAt);
    console.log(`   Applying ${file}…`);
    await bigquery.query({ query: sql, location });
  }
}
