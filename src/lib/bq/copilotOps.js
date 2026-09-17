import {
  copilotApplicantsRef,
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

function emailKey(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * Resolve an MT user_id from core.mt_users: mt_email first, then contact email.
 * Skips merged rows; prefers is_active.
 */
export async function lookupMtUserIdByEmails({ mtEmail, contactEmail } = {}) {
  const emails = [...new Set(
    [mtEmail, contactEmail].map((e) => emailKey(e)).filter(Boolean),
  )];
  if (!emails.length) return null;
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        CAST(user_id AS STRING) AS user_id,
        LOWER(TRIM(email)) AS email
      FROM \`data-pipeline-492715.core.mt_users\`
      WHERE LOWER(TRIM(email)) IN UNNEST(@emails)
        AND IFNULL(is_merged, FALSE) = FALSE
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY LOWER(TRIM(email))
        ORDER BY IF(IFNULL(is_active, TRUE), 0, 1), CAST(user_id AS STRING)
      ) = 1
    `,
    ...queryOptions({ emails }),
  });
  const byEmail = new Map(
    (rows || []).map((r) => [emailKey(r.email), String(r.user_id || "")]),
  );
  for (const email of emails) {
    const userId = byEmail.get(email);
    if (userId) return { userId, email };
  }
  return null;
}

/** Sheet MERGE kept mixed-case column names (Promo_Code, First_Name, …). */
function copilotField(row, name) {
  if (!row) return undefined;
  if (row[name] != null && row[name] !== "") return row[name];
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function normalizeCopilotRow(row) {
  if (!row) return null;
  return {
    ...row,
    contact_email: copilotField(row, "contact_email"),
    first_name: copilotField(row, "first_name"),
    last_name: copilotField(row, "last_name"),
    region: copilotField(row, "region"),
    tier: copilotField(row, "tier"),
    user_id: copilotField(row, "user_id"),
    mt_email: copilotField(row, "mt_email"),
    promo_code: copilotField(row, "promo_code"),
    discount_id: copilotField(row, "discount_id"),
    offer_link: copilotField(row, "offer_link"),
    ig_handle: copilotField(row, "ig_handle"),
    status: copilotField(row, "status"),
    onboarded_at: copilotField(row, "onboarded_at"),
    promoted_at: copilotField(row, "promoted_at"),
    acceptance_emailed_at: copilotField(row, "acceptance_emailed_at"),
    decision: copilotField(row, "decision"),
    decision_notes: copilotField(row, "decision_notes"),
    decision_at: copilotField(row, "decision_at"),
    decision_source: copilotField(row, "decision_source"),
    decision_applied_at: copilotField(row, "decision_applied_at"),
    payment_nudge_at: copilotField(row, "payment_nudge_at"),
    freeze_until: copilotField(row, "freeze_until"),
    never_again: copilotField(row, "never_again") === true,
  };
}

export async function listPendingOnboard() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        user_id,
        mt_email,
        mt_profile_link,
        promo_code,
        discount_id,
        offer_link,
        ig_handle,
        status,
        promoted_at,
        onboarded_at,
        acceptance_emailed_at,
        decision,
        decision_applied_at,
        never_again
      FROM ${copilotDbRef()}
      WHERE promoted_at IS NOT NULL
        AND onboarded_at IS NULL
        AND contact_email IS NOT NULL
        AND TRIM(contact_email) != ''
      ORDER BY promoted_at
    `,
    ...queryOptions(),
  });
  return (rows || []).map(normalizeCopilotRow);
}

export async function listExistingPromoCodes() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT UPPER(TRIM(promo_code)) AS promo_code
      FROM ${copilotDbRef()}
      WHERE promo_code IS NOT NULL AND TRIM(promo_code) != ''
    `,
    ...queryOptions(),
  });
  return new Set((rows || []).map((r) => r.promo_code).filter(Boolean));
}

/**
 * Patch system-owned onboard fields by email. Only sets provided keys.
 */
export async function updateCopilotByEmail(email, fields) {
  const key = emailKey(email);
  if (!key) throw new Error("email is required");

  const allowed = {
    status: "STRING",
    promo_code: "STRING",
    discount_id: "STRING",
    offer_link: "STRING",
    first_name: "STRING",
    last_name: "STRING",
    contact_email: "STRING",
    ig_handle: "STRING",
    ig_url: "STRING",
    tier: "STRING",
    user_id: "STRING",
    mt_email: "STRING",
    mt_profile_link: "STRING",
    onboarded_at: "TIMESTAMP",
    promoted_at: "TIMESTAMP",
    acceptance_emailed_at: "TIMESTAMP",
    decision: "STRING",
    decision_notes: "STRING",
    decision_at: "TIMESTAMP",
    decision_source: "STRING",
    decision_applied_at: "TIMESTAMP",
    payment_nudge_at: "TIMESTAMP",
    freeze_until: "DATE",
    never_again: "BOOL",
    bb_sales: "FLOAT64",
    hybrid_sales: "FLOAT64",
    new_hybrid_sales: "FLOAT64",
  };

  const sets = ["updated_at = CURRENT_TIMESTAMP()"];
  const params = { email: key };
  const types = { email: "STRING" };

  for (const [col, type] of Object.entries(allowed)) {
    if (!(col in fields)) continue;
    if (col === "onboarded_at" && fields[col] === "NOW") {
      sets.push("onboarded_at = CURRENT_TIMESTAMP()");
      continue;
    }
    if (col === "promoted_at" && fields[col] === "NOW") {
      sets.push("promoted_at = COALESCE(promoted_at, CURRENT_TIMESTAMP())");
      continue;
    }
    if (col === "acceptance_emailed_at" && fields[col] === "NOW") {
      sets.push("acceptance_emailed_at = CURRENT_TIMESTAMP()");
      continue;
    }
    if (col === "decision_at" && fields[col] === "NOW") {
      sets.push("decision_at = CURRENT_TIMESTAMP()");
      continue;
    }
    if (col === "decision_applied_at" && fields[col] === "NOW") {
      sets.push("decision_applied_at = CURRENT_TIMESTAMP()");
      continue;
    }
    if (col === "payment_nudge_at" && fields[col] === "NOW") {
      sets.push("payment_nudge_at = CURRENT_TIMESTAMP()");
      continue;
    }
    sets.push(`${col} = @${col}`);
    params[col] = fields[col] ?? null;
    types[col] = type;
  }

  if (sets.length === 1) return;

  const bigquery = getBigQueryClient();
  await bigquery.query({
    query: `
      UPDATE ${copilotDbRef()}
      SET ${sets.join(",\n        ")}
      WHERE LOWER(contact_email) = @email
    `,
    ...queryOptions(params, types),
  });
}

export async function getApplicantPageIdByEmail(email) {
  const key = emailKey(email);
  if (!key) return null;
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT notion_page_id AS notionPageId
      FROM ${copilotApplicantsRef()}
      WHERE LOWER(email) = @email
      ORDER BY promoted_at DESC NULLS LAST, updated_at DESC NULLS LAST
      LIMIT 1
    `,
    ...queryOptions({ email: key }),
  });
  return rows?.[0]?.notionPageId || null;
}

export async function markApplicantOnboarded(notionPageId) {
  if (!notionPageId) return;
  const bigquery = getBigQueryClient();
  await bigquery.query({
    query: `
      UPDATE ${copilotApplicantsRef()}
      SET
        application_status = 'onboarded',
        updated_at = CURRENT_TIMESTAMP()
      WHERE notion_page_id = @notionPageId
    `,
    ...queryOptions({ notionPageId }),
  });
}

export async function listEvaluationQueue() {
  const { projectId, dataset } = getBqConfig();
  const queueRef = `\`${projectId}.${dataset}.copilot_evaluation_queue\``;
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        user_id,
        mt_email,
        membership_status,
        promo_code_status,
        promo_code,
        ig_handle,
        ig_url,
        ig_followers,
        modash_impressions,
        modash_stories_current_membership,
        modash_feed_posts_current_membership,
        social_requirement_met,
        membership_name,
        membership_start,
        membership_end,
        months_since_membership_start,
        copilot_months_active,
        days_to_expiry,
        social_playgrounds_attended,
        last_social_playground,
        classes_taken_current_membership,
        last_class_date,
        redemption_count_current_membership,
        redemption_usd_current_membership,
        redemption_cad_current_membership,
        intro_offer_count_current_membership,
        intro_offer_usd_current_membership,
        intro_offer_cad_current_membership,
        cycle_points,
        redemption_count_all_time,
        redemption_usd_all_time,
        redemption_cad_all_time,
        redemption_count_since_membership_end,
        sheet_membership_expiry,
        bb_sales,
        hybrid_sales,
        new_hybrid_sales
      FROM ${queueRef}
      ORDER BY
        region ASC NULLS LAST,
        CASE LOWER(TRIM(CAST(tier AS STRING)))
          WHEN 'seeker' THEN 0
          WHEN 'wayfinder' THEN 1
          WHEN 'luminary' THEN 2
          ELSE 9
        END,
        days_to_expiry ASC NULLS LAST,
        contact_email
    `,
    ...queryOptions(),
  });
  return rows || [];
}

/**
 * Active copilots whose IG handle(s) are not on the Modash Creators roster.
 * One row per missing handle (a copilot with several accounts can appear twice).
 */
export async function listAddToModash() {
  const { projectId, dataset } = getBqConfig();
  const viewRef = `\`${projectId}.${dataset}.copilot_add_to_modash\``;
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        ig_handle,
        ig_url,
        ig_followers,
        membership_status,
        membership_name,
        membership_end
      FROM ${viewRef}
      ORDER BY
        region ASC NULLS LAST,
        CASE LOWER(TRIM(CAST(tier AS STRING)))
          WHEN 'seeker' THEN 0
          WHEN 'wayfinder' THEN 1
          WHEN 'luminary' THEN 2
          ELSE 9
        END,
        last_name ASC NULLS LAST,
        contact_email,
        ig_handle
    `,
    ...queryOptions(),
  });
  return rows || [];
}

export async function listCopilotsMissingUserId() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name
      FROM ${copilotDbRef()}
      WHERE (user_id IS NULL OR TRIM(CAST(user_id AS STRING)) = '')
        AND contact_email IS NOT NULL
        AND TRIM(contact_email) != ''
      ORDER BY contact_email
    `,
    ...queryOptions(),
  });
  return (rows || []).map(normalizeCopilotRow);
}

export async function getCopilotByEmail(email) {
  const key = emailKey(email);
  if (!key) return null;
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT *
      FROM ${copilotDbRef()}
      WHERE LOWER(contact_email) = @email
      LIMIT 1
    `,
    ...queryOptions({ email: key }),
  });
  return normalizeCopilotRow(rows?.[0]) || null;
}

/**
 * Look up copilot_db rows for a list of emails (case-insensitive).
 * @param {string[]} emails
 */
export async function listCopilotsByEmails(emails) {
  const keys = [
    ...new Set(
      (emails || [])
        .map((e) => emailKey(e))
        .filter(Boolean)
    ),
  ];
  if (!keys.length) return [];

  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT *
      FROM ${copilotDbRef()}
      WHERE LOWER(contact_email) IN UNNEST(@emails)
    `,
    ...queryOptions({ emails: keys }),
  });
  return (rows || []).map(normalizeCopilotRow);
}

/**
 * Active copilots with a live Co-Pilot membership whose IG is the ops
 * "re-submit" placeholder (same flag as Review: need to resubmit social handles).
 * Live = membership name matches co-pilot and status is active / pending /
 * payment_failure (frozen / ended / cancelled stay out).
 * Queries copilot_db + mt_membership_instances directly so it does not
 * depend on copilot_performance (stg_mt_discounts).
 */
export async function listActiveResubmitHandleCopilots() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      WITH queued AS (
        SELECT
          contact_email,
          first_name,
          last_name,
          region,
          tier,
          mt_email,
          ig_handle,
          ig_url,
          tiktok_handle,
          decision_notes,
          CAST(user_id AS STRING) AS user_id
        FROM ${copilotDbRef()}
        WHERE LOWER(IFNULL(status, '')) = 'active'
          AND contact_email IS NOT NULL
          AND TRIM(contact_email) != ''
          AND REGEXP_CONTAINS(
            LOWER(CONCAT(IFNULL(ig_handle, ''), ' ', IFNULL(ig_url, ''))),
            r're-?submit'
          )
      ),
      live AS (
        SELECT * EXCEPT (rn) FROM (
          SELECT
            CAST(user_id AS STRING) AS user_id,
            membership_name,
            status AS membership_status,
            COALESCE(
              DATE(calculated_end_at, 'America/New_York'),
              DATE(scheduled_end_at, 'America/New_York'),
              end_date,
              DATE(cancelled_at, 'America/New_York')
            ) AS membership_end,
            ROW_NUMBER() OVER (
              PARTITION BY CAST(user_id AS STRING)
              ORDER BY started_at DESC NULLS LAST
            ) AS rn
          FROM \`data-pipeline-492715.core.mt_membership_instances\`
          WHERE user_id IS NOT NULL
            AND TRIM(CAST(user_id AS STRING)) != ''
            AND REGEXP_CONTAINS(
              LOWER(IFNULL(membership_name, '')),
              r'co[\\s-]?pilot'
            )
            AND LOWER(IFNULL(status, '')) IN (
              'active', 'pending', 'payment_failure'
            )
        )
        WHERE rn = 1
      )
      SELECT
        q.contact_email,
        q.first_name,
        q.last_name,
        q.region,
        q.tier,
        q.mt_email,
        q.ig_handle,
        q.ig_url,
        q.tiktok_handle,
        q.decision_notes,
        m.membership_name,
        m.membership_status,
        m.membership_end
      FROM queued AS q
      INNER JOIN live AS m
        ON m.user_id = q.user_id
      ORDER BY
        q.region ASC NULLS LAST,
        q.last_name ASC NULLS LAST,
        q.first_name ASC NULLS LAST,
        q.contact_email
    `,
    ...queryOptions(),
  });
  return rows || [];
}

/**
 * Active copilots with a live Co-Pilot membership — monthly update list.
 * Live = Co-Pilot-named instance in active / pending / payment_failure.
 */
export async function listMonthlyEmailCopilots() {
  const { projectId, dataset } = getBqConfig();
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        mt_email,
        promo_code,
        offer_link,
        cycle_points,
        social_requirement_met,
        modash_stories_current_membership,
        modash_feed_posts_current_membership,
        membership_end,
        days_to_expiry,
        membership_status,
        membership_name,
        months_since_membership_start
      FROM \`${projectId}.${dataset}.copilot_performance\`
      WHERE LOWER(IFNULL(status, '')) = 'active'
        AND contact_email IS NOT NULL
        AND TRIM(contact_email) != ''
        AND REGEXP_CONTAINS(
          LOWER(IFNULL(membership_name, '')),
          r'co[\\s-]?pilot'
        )
        AND LOWER(IFNULL(membership_status, '')) IN (
          'active', 'pending', 'payment_failure'
        )
      ORDER BY
        region ASC NULLS LAST,
        last_name ASC NULLS LAST,
        first_name ASC NULLS LAST,
        contact_email
    `,
    ...queryOptions(),
  });
  return rows || [];
}

/** Cycle stats for lifecycle emails (from copilot_performance, not copilot_db). */
export async function getCopilotCycleStats(email) {
  const key = emailKey(email);
  if (!key) return null;
  const { projectId, dataset } = getBqConfig();
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        cycle_points,
        social_requirement_met
      FROM \`${projectId}.${dataset}.copilot_performance\`
      WHERE LOWER(contact_email) = @email
      LIMIT 1
    `,
    ...queryOptions({ email: key }),
  });
  return rows?.[0] || null;
}

/** Filled decisions that still need apply (never applied, or a newer decision_at). */
export async function listUnappliedDecisions() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        user_id,
        mt_email,
        promo_code,
        discount_id,
        offer_link,
        status,
        decision,
        decision_notes,
        decision_at,
        decision_source,
        freeze_until,
        never_again
      FROM ${copilotDbRef()}
      WHERE LOWER(IFNULL(decision, '')) IN (
          'onboard', 'renew', 'offboard', 'never again', 'never_again',
          'upgrade', 'downgrade', 'snooze', 'freeze', 'update', 'social'
        )
        AND (
          decision_applied_at IS NULL
          OR (
            decision_at IS NOT NULL
            AND decision_applied_at < decision_at
          )
        )
        AND contact_email IS NOT NULL
      ORDER BY decision_at NULLS LAST, contact_email
    `,
    ...queryOptions(),
  });
  return rows || [];
}
