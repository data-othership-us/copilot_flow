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
