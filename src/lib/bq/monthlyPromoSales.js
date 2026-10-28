import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBigQueryClient, getBqConfig } from "../bqConfig.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function salesViewRef() {
  const { projectId, dataset } = getBqConfig();
  if (!projectId) throw new Error("Missing required env var: BQ_PROJECT_ID");
  return `\`${projectId}.${dataset}.copilot_monthly_promo_sales\``;
}

export async function applyMonthlyPromoSalesView() {
  const bigquery = getBigQueryClient();
  const { projectId, location } = getBqConfig();
  if (!projectId) throw new Error("Missing required env var: BQ_PROJECT_ID");

  let sql = await readFile(
    path.join(root, "bq", "copilot_monthly_promo_sales.sql"),
    "utf8"
  );
  sql = sql.replaceAll("YOUR_PROJECT", projectId);
  const createAt = sql.lastIndexOf("CREATE OR REPLACE VIEW");
  if (createAt < 0) {
    throw new Error("No CREATE OR REPLACE VIEW in copilot_monthly_promo_sales.sql");
  }
  await bigquery.query({ query: sql.slice(createAt), location });
}

function queryOptions(params) {
  const { location } = getBqConfig();
  return { location, params };
}

function salesByCopilotSql() {
  return `
  SELECT
    FORMAT_DATE('%Y-%m-%d', month) AS month,
    contact_email,
    ANY_VALUE(first_name) AS first_name,
    ANY_VALUE(last_name) AS last_name,
    ANY_VALUE(region) AS region,
    ANY_VALUE(tier) AS tier,
    ANY_VALUE(status) AS status,
    ANY_VALUE(promo_code) AS promo_code,
    COUNT(DISTINCT IF(source = 'promo_code', order_id, NULL)) AS promo_orders,
    SUM(IF(source = 'promo_code' AND currency = 'USD', subtotal_pretax, 0)) AS promo_usd,
    SUM(IF(source = 'promo_code' AND currency = 'CAD', subtotal_pretax, 0)) AS promo_cad,
    COUNT(DISTINCT IF(source = 'intro_offer', order_id, NULL)) AS offer_orders,
    SUM(IF(source = 'intro_offer' AND currency = 'USD', subtotal_pretax, 0)) AS offer_usd,
    SUM(IF(source = 'intro_offer' AND currency = 'CAD', subtotal_pretax, 0)) AS offer_cad
  FROM ${salesViewRef()}
  WHERE contact_email IS NOT NULL
`;
}

/**
 * One row per copilot with promo-code and 2-for-1 sales in the Eastern
 * month starting on monthStart (YYYY-MM-DD).
 */
export async function listMonthlyPromoSales(monthStart) {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      ${salesByCopilotSql()}
        AND month = DATE(@month)
      GROUP BY month, contact_email
      ORDER BY region, promo_usd + promo_cad + offer_usd + offer_cad DESC, contact_email
    `,
    ...queryOptions({ month: monthStart }),
  });
  return rows;
}

/** Every copilot-month, for the Copilot base sheet. */
export async function listPromoSalesHistory() {
  const bigquery = getBigQueryClient();
  const { location } = getBqConfig();
  const [rows] = await bigquery.query({
    query: `
      ${salesByCopilotSql()}
      GROUP BY month, contact_email
      ORDER BY month DESC, region, promo_usd + promo_cad + offer_usd + offer_cad DESC
    `,
    location,
  });
  return rows;
}

/**
 * 2-for-1 orders that did not match a roster copilot. Includes offer-link
 * codes that are not on copilot_db and orders with no offer-link session.
 */
export async function listUnassignedIntroOffers(monthStart = null) {
  const bigquery = getBigQueryClient();
  const monthClause = monthStart ? "AND month = DATE(@month)" : "";
  const [rows] = await bigquery.query({
    query: `
      SELECT
        FORMAT_DATE('%Y-%m-%d', month) AS month,
        IFNULL(promo_code, '') AS promo_code,
        discount_name AS product,
        COUNT(DISTINCT order_id) AS orders,
        SUM(IF(currency = 'USD', subtotal_pretax, 0)) AS usd,
        SUM(IF(currency = 'CAD', subtotal_pretax, 0)) AS cad
      FROM ${salesViewRef()}
      WHERE source = 'intro_offer'
        AND contact_email IS NULL
        ${monthClause}
      GROUP BY month, promo_code, product
      ORDER BY month DESC, usd + cad DESC, product
    `,
    ...(monthStart
      ? queryOptions({ month: monthStart })
      : { location: getBqConfig().location }),
  });
  return rows;
}

/**
 * Discounts whose names look like Co-Pilot vouchers but did not match
 * copilot_db for this month. Surfaced so a renamed or off-roster code
 * is not dropped from the sales total.
 */
export async function listUnmatchedCopilotDiscounts(monthStart) {
  const bigquery = getBigQueryClient();
  const { projectId } = getBqConfig();
  const [rows] = await bigquery.query({
    query: `
      WITH orders AS (
        SELECT
          o.order_id,
          UPPER(o.attr_currency) AS currency,
          CAST(o.attr_subtotal AS FLOAT64) AS subtotal_pretax,
          REGEXP_REPLACE(TRIM(JSON_VALUE(d, '$.name')), r'\\s+', ' ') AS discount_name
        FROM \`data-pipeline-492715.stg_mt.stg_mt_orders\` AS o,
          UNNEST(JSON_QUERY_ARRAY(o.attr_discounts)) AS d
        WHERE IFNULL(o.attr_contains_refund, FALSE) = FALSE
          AND LOWER(IFNULL(o.attr_status, '')) = 'completed'
          AND DATE_TRUNC(DATE(o.attr_date_placed, 'America/New_York'), MONTH) = DATE(@month)
          AND TRIM(IFNULL(JSON_VALUE(d, '$.name'), '')) != ''
      ),
      discounts AS (
        SELECT
          CAST(discount_id AS STRING) AS discount_id,
          REGEXP_REPLACE(TRIM(attr_name), r'\\s+', ' ') AS discount_name,
          ARRAY_AGG(DISTINCT UPPER(TRIM(code)) IGNORE NULLS) AS promo_codes
        FROM \`data-pipeline-492715.stg_mt.stg_mt_discounts\`,
          UNNEST(JSON_VALUE_ARRAY(attr_codes)) AS code
        WHERE TRIM(IFNULL(code, '')) != ''
        GROUP BY 1, 2
      ),
      matched AS (
        SELECT DISTINCT discount_id
        FROM \`${projectId}.${getBqConfig().dataset}.copilot_monthly_promo_sales\`
        WHERE month = DATE(@month)
          AND source = 'promo_code'
      )
      SELECT
        discounts.discount_name,
        IF(
          ARRAY_LENGTH(discounts.promo_codes) <= 3,
          discounts.promo_codes[SAFE_OFFSET(0)],
          CONCAT(CAST(ARRAY_LENGTH(discounts.promo_codes) AS STRING), ' codes')
        ) AS promo_code,
        COUNT(DISTINCT orders.order_id) AS orders,
        SUM(IF(orders.currency = 'USD', orders.subtotal_pretax, 0)) AS usd,
        SUM(IF(orders.currency = 'CAD', orders.subtotal_pretax, 0)) AS cad
      FROM orders
      JOIN discounts USING (discount_name)
      LEFT JOIN matched USING (discount_id)
      WHERE matched.discount_id IS NULL
        AND REGEXP_CONTAINS(
          LOWER(discounts.discount_name),
          r'co[\\s-]?pilot|seeker |wayfinder |luminary '
        )
      GROUP BY 1, 2
      ORDER BY usd + cad DESC, discounts.discount_name
    `,
    ...queryOptions({ month: monthStart }),
  });
  return rows;
}

function monthEndDate(monthStart) {
  const [year, month] = String(monthStart).slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
}

/**
 * Headcount for one Eastern month, from Co-Pilot memberships.
 * Pilots were live on the last day. Onboarded is a first Co-Pilot term
 * starting in the month. Offboarded is a last term ending in the month
 * with no membership still open. Sessions are check-ins during a live term.
 */
export async function listMonthlyProgramStats(monthStart) {
  const bigquery = getBigQueryClient();
  const { projectId, dataset } = getBqConfig();
  const [rows] = await bigquery.query({
    query: `
      WITH mem AS (
        SELECT
          CAST(user_id AS STRING) AS user_id,
          DATE(started_at, 'America/New_York') AS start_date,
          COALESCE(
            DATE(cancelled_at, 'America/New_York'),
            DATE(calculated_end_at, 'America/New_York'),
            DATE(scheduled_end_at, 'America/New_York'),
            end_date
          ) AS end_date,
          started_at,
          COALESCE(
            cancelled_at,
            calculated_end_at,
            scheduled_end_at,
            TIMESTAMP(end_date)
          ) AS ended_at,
          CASE
            WHEN REGEXP_CONTAINS(LOWER(membership_name), r'\\b(ny|nyc|new york)\\b') THEN 'NYC'
            WHEN REGEXP_CONTAINS(LOWER(membership_name), r'\\b(to|toronto)\\b') THEN 'TO'
            WHEN CAST(purchase_location_id AS STRING) IN ('48784', '48817') THEN 'NYC'
            WHEN CAST(purchase_location_id AS STRING) IN ('48717', '48750') THEN 'TO'
          END AS membership_region
        FROM \`data-pipeline-492715.core.mt_membership_instances\`
        WHERE REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\\s-]?pilot')
      ),
      roster AS (
        SELECT DISTINCT
          CAST(user_id AS STRING) AS user_id,
          CASE
            WHEN UPPER(TRIM(region)) IN ('NYC', 'NY', 'NEW YORK') THEN 'NYC'
            WHEN UPPER(TRIM(region)) IN ('TO', 'TORONTO') THEN 'TO'
          END AS region
        FROM \`${projectId}.${dataset}.copilot_db\`
        WHERE user_id IS NOT NULL AND TRIM(CAST(user_id AS STRING)) != ''
      ),
      scoped AS (
        SELECT
          m.user_id,
          COALESCE(m.membership_region, r.region) AS region,
          m.start_date,
          m.end_date,
          m.started_at,
          m.ended_at
        FROM mem AS m
        LEFT JOIN roster AS r ON r.user_id = m.user_id
        WHERE COALESCE(m.membership_region, r.region) IS NOT NULL
      ),
      person AS (
        SELECT
          region,
          user_id,
          MIN(start_date) AS first_start,
          MAX(end_date) AS last_end,
          MAX(IF(end_date IS NULL, 1, 0)) AS still_open
        FROM scoped
        GROUP BY region, user_id
      ),
      headcount AS (
        SELECT
          region,
          COUNT(DISTINCT IF(
            start_date <= DATE(@end)
            AND (end_date IS NULL OR end_date >= DATE(@end)),
            user_id,
            NULL
          )) AS pilots
        FROM scoped
        GROUP BY region
      ),
      movement AS (
        SELECT
          region,
          COUNTIF(first_start BETWEEN DATE(@start) AND DATE(@end)) AS onboarded,
          COUNTIF(
            still_open = 0 AND last_end BETWEEN DATE(@start) AND DATE(@end)
          ) AS offboarded
        FROM person
        GROUP BY region
      ),
      sessions AS (
        SELECT
          s.region,
          COUNT(DISTINCT CONCAT(
            CAST(res.user_id AS STRING), '|', CAST(res.session_id AS STRING)
          )) AS sessions
        FROM \`data-pipeline-492715.core.mt_reservations\` AS res
        JOIN scoped AS s
          ON s.user_id = CAST(res.user_id AS STRING)
          AND res.session_start_at >= s.started_at
          AND (s.ended_at IS NULL OR res.session_start_at <= s.ended_at)
        WHERE LOWER(IFNULL(res.status, '')) = 'check in'
          AND IFNULL(res.session_is_cancelled, FALSE) = FALSE
          AND IFNULL(res.is_guest, FALSE) = FALSE
          AND IFNULL(res.classpass_booking, FALSE) = FALSE
          AND IFNULL(res.wellhub_booking, FALSE) = FALSE
          AND DATE(res.session_start_at, 'America/New_York')
            BETWEEN DATE(@start) AND DATE(@end)
        GROUP BY s.region
      )
      SELECT
        h.region,
        h.pilots,
        IFNULL(m.onboarded, 0) AS onboarded,
        IFNULL(m.offboarded, 0) AS offboarded,
        IFNULL(se.sessions, 0) AS sessions
      FROM headcount AS h
      LEFT JOIN movement AS m USING (region)
      LEFT JOIN sessions AS se USING (region)
    `,
    ...queryOptions({ start: monthStart, end: monthEndDate(monthStart) }),
  });
  return rows;
}
