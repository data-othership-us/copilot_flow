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
  "payment_nudge_at TIMESTAMP",
  "freeze_until DATE",
  "never_again BOOL",
  "new_hybrid_sales FLOAT64",
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
 * promo_code, offer_link, decision*, never_again, new_hybrid_sales, promoted_at, onboarded_at, acceptance_emailed_at,
 * payment_nudge_at, tiktok_*, other_channels (applicant/promote-owned), ig_url
 * (derived from every parsed sheet handle; otherwise keep applicant URL), ig_followers
 * (onboard seed; live count is Modash on copilot_performance).
 * Membership / classes come from joins in copilot_performance — not sheet sync.
 */
function splitIgHandlesSql(expr) {
  const { projectId, dataset } = getBqConfig();
  return `\`${projectId}.${dataset}.split_ig_handles\`(${expr})`;
}

/** "@name", or newline-separated "@a\\n@b" so each handle pastes as its own line. */
function storedIgHandleSql(expr) {
  const hs = splitIgHandlesSql(expr);
  return `IF(
    ARRAY_LENGTH(${hs}) > 0,
    ARRAY_TO_STRING(
      ARRAY(SELECT CONCAT('@', h) FROM UNNEST(${hs}) AS h),
      '\\n'
    ),
    NULL
  )`;
}

/** Newline-separated profile URLs, one per parsed handle. */
function igUrlFromHandleSql(expr) {
  const hs = splitIgHandlesSql(expr);
  return `NULLIF(
    ARRAY_TO_STRING(
      ARRAY(
        SELECT CONCAT('https://www.instagram.com/', h, '/')
        FROM UNNEST(${hs}) AS h
      ),
      '\\n'
    ),
    ''
  )`;
}

function missingFromActiveTabsWhere(alias = "T") {
  return `
    LOWER(IFNULL(${alias}.status, '')) != 'inactive'
    AND ${alias}.contact_email IS NOT NULL
    AND TRIM(${alias}.contact_email) != ''
    AND LOWER(${alias}.contact_email) NOT IN UNNEST(@active_emails)
  `;
}

function activeEmailsQueryOptions(emails) {
  return queryOptions({ active_emails: emails }, { active_emails: ["STRING"] });
}

/**
 * Emails currently on a TO/NY active tab. Read-only against the Drive-linked
 * union — do not correlate this into DML on copilot_db (Cloud Run hits
 * "Permission denied while getting Drive credentials").
 */
export async function listActiveSheetEmails() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT DISTINCT LOWER(email) AS email
      FROM ${unionRef()}
      WHERE LOWER(IFNULL(status, '')) = 'active'
        AND email IS NOT NULL
        AND TRIM(email) != ''
    `,
    ...queryOptions(),
  });
  return (rows || []).map((r) => r.email).filter(Boolean);
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
  T.ig_handle = IF(
    LOWER(IFNULL(T.status, '')) = 'active',
    COALESCE(${storedIgHandleSql("S.social_handle")}, T.ig_handle),
    T.ig_handle
  ),
  T.ig_url = IF(
    LOWER(IFNULL(T.status, '')) = 'active',
    COALESCE(${igUrlFromHandleSql("S.social_handle")}, T.ig_url),
    T.ig_url
  ),
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
  const counts = rows[0] || { sheet_rows: 0, would_insert: 0, would_update: 0 };
  const activeEmails = await listActiveSheetEmails();
  let would_inactivate = 0;
  if (activeEmails.length) {
    const [inactiveRows] = await bigquery.query({
      query: `
        SELECT COUNT(*) AS n
        FROM ${copilotRef} T
        WHERE ${missingFromActiveTabsWhere("T")}
      `,
      ...activeEmailsQueryOptions(activeEmails),
    });
    would_inactivate = Number(inactiveRows[0]?.n ?? 0);
  }
  return { ...counts, would_inactivate };
}

/**
 * Active copilot_db emails that are not on any active TO/NY sheet tab.
 */
export async function listMissingFromActiveTabs({ limit = 0 } = {}) {
  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();
  const activeEmails = await listActiveSheetEmails();
  if (!activeEmails.length) return [];
  const limitSql =
    Number(limit) > 0 ? `LIMIT ${Number.parseInt(limit, 10)}` : "";
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        status
      FROM ${copilotRef} T
      WHERE ${missingFromActiveTabsWhere("T")}
      ORDER BY region, contact_email
      ${limitSql}
    `,
    ...activeEmailsQueryOptions(activeEmails),
  });
  return rows || [];
}

/**
 * Mark roster status inactive when the email is gone from every active tab.
 * People still on an active tab stay active (even if they also appear on Inactive).
 * Does not touch rows already inactive. Blank/null status is treated as
 * not on the roster (same as active-but-removed).
 * Active-tab emails are loaded first so the UPDATE does not read Drive.
 */
export async function inactivateMissingFromActiveTabs() {
  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();
  const activeEmails = await listActiveSheetEmails();
  if (!activeEmails.length) {
    throw new Error(
      "No active-tab emails from the ops sheets — refusing to inactivate"
    );
  }
  const query = `
    UPDATE ${copilotRef} T
    SET
      status = 'inactive',
      updated_at = CURRENT_TIMESTAMP()
    WHERE ${missingFromActiveTabsWhere("T")}
  `;
  const [job] = await bigquery.createQueryJob({
    query,
    ...activeEmailsQueryOptions(activeEmails),
  });
  await job.getQueryResults();
  const meta = job.metadata?.statistics?.query;
  return {
    affected: Number(meta?.numDmlAffectedRows ?? 0),
  };
}

function activeIgFromSheetSql() {
  const newHandle = storedIgHandleSql("S.social_handle");
  const newUrl = igUrlFromHandleSql("S.social_handle");
  return {
    newHandle,
    newUrl,
    fromWhere: `
      FROM ${copilotDbRef()} AS T
      JOIN ${unionRef()} AS S
        ON LOWER(T.contact_email) = LOWER(S.email)
      WHERE LOWER(IFNULL(T.status, '')) = 'active'
        AND NULLIF(TRIM(S.social_handle), '') IS NOT NULL
        AND ARRAY_LENGTH(${splitIgHandlesSql("S.social_handle")}) > 0
    `,
  };
}

/**
 * Preview IG handle/URL updates from the ops sheets for copilots who are
 * already status=active in copilot_db. Does not insert or inactivate anyone.
 */
export async function previewActiveIgFromSheets() {
  const bigquery = getBigQueryClient();
  const { newHandle, newUrl, fromWhere } = activeIgFromSheetSql();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        T.contact_email,
        T.region,
        T.tier,
        T.ig_handle AS db_ig_handle,
        ${newHandle} AS sheet_ig_handle,
        T.ig_url AS db_ig_url,
        COALESCE(${newUrl}, T.ig_url) AS sheet_ig_url,
        S.social_handle AS sheet_social_handle,
        ARRAY_LENGTH(${splitIgHandlesSql("S.social_handle")}) AS handle_count
      ${fromWhere}
      ORDER BY
        ARRAY_LENGTH(${splitIgHandlesSql("S.social_handle")}) DESC,
        T.contact_email
    `,
    ...queryOptions(),
  });
  return rows || [];
}

/**
 * Copy parsed ig_handle + ig_url from the ops sheets onto active copilot_db
 * rows only. Leaves inactive/offboarded copilots untouched; does not MERGE
 * other sheet columns or insert new emails.
 */
export async function syncActiveIgFromSheets() {
  const bigquery = getBigQueryClient();
  const copilotRef = copilotDbRef();
  const source = unionRef();
  const newHandle = storedIgHandleSql("S.social_handle");
  const newUrl = igUrlFromHandleSql("S.social_handle");

  const query = `
    UPDATE ${copilotRef} AS T
    SET
      ig_handle = COALESCE(${newHandle}, T.ig_handle),
      ig_url = COALESCE(${newUrl}, T.ig_url),
      updated_at = CURRENT_TIMESTAMP()
    FROM ${source} AS S
    WHERE LOWER(T.contact_email) = LOWER(S.email)
      AND LOWER(IFNULL(T.status, '')) = 'active'
      AND NULLIF(TRIM(S.social_handle), '') IS NOT NULL
      AND ARRAY_LENGTH(${splitIgHandlesSql("S.social_handle")}) > 0
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

const UTM_SESSIONS_LOCATION = "northamerica-northeast2";
const UTM_SESSIONS_ROW_TYPE = [
  {
    session_id: "STRING",
    session_start_at: "STRING",
    last_event_at: "STRING",
    session_date: "STRING",
    user_id: "STRING",
    copilot_code: "STRING",
    is_individual_copilot: "BOOL",
    reached_checkout: "BOOL",
    cart_value: "FLOAT64",
  },
];

function bqScalar(value) {
  if (value == null) return null;
  if (typeof value === "object" && value.value != null) return value.value;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeUtmSession(row) {
  const start = bqScalar(row.session_start_at);
  const last = bqScalar(row.last_event_at);
  const day = bqScalar(row.session_date);
  const cart = bqScalar(row.cart_value);
  const cartNum = cart == null || cart === "" ? NaN : Number(cart);
  return {
    session_id: row.session_id || null,
    session_start_at: start ? String(start) : null,
    last_event_at: last ? String(last) : null,
    session_date: day ? String(day).slice(0, 10) : null,
    user_id: row.user_id || null,
    copilot_code: row.copilot_code
      ? String(row.copilot_code).trim().toUpperCase()
      : null,
    is_individual_copilot: Boolean(row.is_individual_copilot),
    reached_checkout: Boolean(row.reached_checkout),
    cart_value: Number.isFinite(cartNum) ? cartNum : null,
  };
}

/**
 * Copy `utm_tracking.copilot_utm_sessions` (northamerica-northeast2) into
 * `copilots.copilot_utm_sessions` (US). BigQuery views cannot join across
 * regions; the performance view reads this US snapshot.
 */
export async function refreshCopilotUtmSessions() {
  const bigquery = getBigQueryClient();
  const { projectId, dataset, location } = getBqConfig();
  if (!projectId) throw new Error("Missing BQ_PROJECT_ID");

  const dest = `\`${projectId}.${dataset}.copilot_utm_sessions\``;
  const [sourceRows] = await bigquery.query({
    query: `
      SELECT
        session_id,
        session_start_at,
        last_event_at,
        session_date,
        user_id,
        copilot_code,
        is_individual_copilot,
        reached_checkout,
        cart_value
      FROM \`data-dashboard-463217.utm_tracking.copilot_utm_sessions\`
    `,
    location: UTM_SESSIONS_LOCATION,
  });
  const rows = (sourceRows || []).map(serializeUtmSession);
  console.log(`   Snapshot ${rows.length} copilot UTM session(s) → ${dest}`);

  if (rows.length === 0) {
    await bigquery.query({
      query: `
        CREATE OR REPLACE TABLE ${dest} AS
        SELECT
          CAST(NULL AS STRING) AS session_id,
          CAST(NULL AS TIMESTAMP) AS session_start_at,
          CAST(NULL AS TIMESTAMP) AS last_event_at,
          CAST(NULL AS DATE) AS session_date,
          CAST(NULL AS STRING) AS user_id,
          CAST(NULL AS STRING) AS copilot_code,
          CAST(NULL AS BOOL) AS is_individual_copilot,
          CAST(NULL AS BOOL) AS reached_checkout,
          CAST(NULL AS FLOAT64) AS cart_value
        LIMIT 0
      `,
      location,
    });
    return;
  }

  await bigquery.query({
    query: `
      CREATE OR REPLACE TABLE ${dest} AS
      SELECT
        session_id,
        SAFE.TIMESTAMP(session_start_at) AS session_start_at,
        SAFE.TIMESTAMP(last_event_at) AS last_event_at,
        SAFE.PARSE_DATE('%Y-%m-%d', session_date) AS session_date,
        user_id,
        copilot_code,
        is_individual_copilot,
        reached_checkout,
        cart_value
      FROM UNNEST(@rows)
    `,
    location,
    params: { rows },
    types: { rows: UTM_SESSIONS_ROW_TYPE },
  });
}

/**
 * Apply CREATE OR REPLACE VIEW/FUNCTION (and CREATE TABLE IF NOT EXISTS)
 * for union, dedup, split_ig_handles, Modash ingest, performance,
 * evaluation_queue, and add-to-modash.
 * Replaces YOUR_PROJECT with configured project id.
 */
export async function applySheetUnionViews() {
  const bigquery = getBigQueryClient();
  const { projectId, location } = getBqConfig();
  if (!projectId) throw new Error("Missing BQ_PROJECT_ID");

  console.log("   Refreshing copilot UTM session snapshot…");
  await refreshCopilotUtmSessions();

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  for (const file of [
    "normalize_ig_handle.sql",
    "split_ig_handles.sql",
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
