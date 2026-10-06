-- Monthly Co-Pilot sales: promo-code redemptions plus 2-for-1 intro offers.
-- Grain: one row per completed order and source (promo_code | intro_offer).
--
-- Promo codes: Mariana Tek order discount name → stg_mt_discounts, then
-- copilot_db on discount_id, or on promo_code when that voucher has at most
-- 3 codes. Pretax total is the order subtotal excluding tax.
--
-- 2-for-1 offers: every completed Co-Pilot "2 for" product order. A copilot
-- is attached when an individual offer-link session (utm_content = their
-- code, not link_in_bio) is the last touch within 7 days, same rule as
-- cycle points. Orders with no matching session stay on the report with a
-- null copilot so the month total is every 2-for-1 sale. An order already
-- counted as a promo redemption is not counted again as an offer.
--
-- Month is the Eastern calendar date of the order. Refunds are left out.
-- Offer-link sessions are the US snapshot copilots.copilot_utm_sessions.
-- Apply via: npm run report-monthly-sales

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_monthly_promo_sales` AS
WITH orders AS (
  SELECT
    o.order_id,
    UPPER(o.attr_currency) AS currency,
    CAST(o.attr_subtotal AS FLOAT64) AS subtotal_pretax,
    DATE(o.attr_date_placed, 'America/New_York') AS order_date,
    DATE_TRUNC(DATE(o.attr_date_placed, 'America/New_York'), MONTH) AS month,
    REGEXP_REPLACE(TRIM(JSON_VALUE(d, '$.name')), r'\s+', ' ') AS discount_name
  FROM `data-pipeline-492715.stg_mt.stg_mt_orders` AS o,
    UNNEST(JSON_QUERY_ARRAY(o.attr_discounts)) AS d
  WHERE IFNULL(o.attr_contains_refund, FALSE) = FALSE
    AND LOWER(IFNULL(o.attr_status, '')) = 'completed'
    AND TRIM(IFNULL(JSON_VALUE(d, '$.name'), '')) != ''
),
discount_codes AS (
  SELECT
    CAST(discount_id AS STRING) AS discount_id,
    REGEXP_REPLACE(TRIM(attr_name), r'\s+', ' ') AS discount_name,
    UPPER(TRIM(code)) AS promo_code
  FROM `data-pipeline-492715.stg_mt.stg_mt_discounts`,
    UNNEST(JSON_VALUE_ARRAY(attr_codes)) AS code
  WHERE TRIM(IFNULL(code, '')) != ''
),
discounts AS (
  SELECT
    discount_id,
    discount_name,
    ARRAY_AGG(DISTINCT promo_code) AS promo_codes
  FROM discount_codes
  GROUP BY 1, 2
),
roster AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT
      LOWER(TRIM(contact_email)) AS contact_email,
      first_name,
      last_name,
      region,
      tier,
      status,
      CAST(discount_id AS STRING) AS discount_id,
      NULLIF(UPPER(TRIM(promo_code)), '') AS promo_code,
      ROW_NUMBER() OVER (
        PARTITION BY LOWER(TRIM(contact_email))
        ORDER BY
          CASE WHEN LOWER(IFNULL(status, '')) = 'active' THEN 0 ELSE 1 END,
          CASE
            WHEN REGEXP_CONTAINS(
              LOWER(TRIM(contact_email)),
              r'^[^@\s]+@[^@\s]+\.[^@\s]+$'
            ) THEN 0
            ELSE 1
          END,
          contact_email
      ) AS rn
    FROM `YOUR_PROJECT.copilots.copilot_db`
    WHERE contact_email IS NOT NULL AND TRIM(contact_email) != ''
  )
  WHERE rn = 1
),
promo_attributed AS (
  SELECT
    orders.month,
    orders.order_date,
    orders.order_id,
    orders.currency,
    orders.subtotal_pretax,
    discounts.discount_id,
    discounts.discount_name,
    discounts.promo_codes,
    roster.contact_email,
    roster.first_name,
    roster.last_name,
    roster.region,
    roster.tier,
    roster.status,
    roster.promo_code AS roster_promo_code,
    ROW_NUMBER() OVER (
      PARTITION BY orders.order_id, discounts.discount_id
      ORDER BY
        CASE WHEN LOWER(IFNULL(roster.status, '')) = 'active' THEN 0 ELSE 1 END,
        CASE
          WHEN REGEXP_CONTAINS(
            roster.contact_email,
            r'^[^@\s]+@[^@\s]+\.[^@\s]+$'
          ) THEN 0
          ELSE 1
        END,
        roster.contact_email
    ) AS copilot_rn
  FROM orders
  JOIN discounts
    ON discounts.discount_name = orders.discount_name
  JOIN roster
    ON roster.discount_id = discounts.discount_id
    OR (
      roster.promo_code IN UNNEST(discounts.promo_codes)
      AND ARRAY_LENGTH(discounts.promo_codes) <= 3
    )
),
promo_sales AS (
  SELECT
    month,
    order_date,
    order_id,
    currency,
    subtotal_pretax,
    discount_id,
    discount_name,
    COALESCE(
      IF(roster_promo_code IN UNNEST(promo_codes), roster_promo_code, NULL),
      promo_codes[SAFE_OFFSET(0)]
    ) AS promo_code,
    contact_email,
    first_name,
    last_name,
    region,
    tier,
    status,
    'promo_code' AS source
  FROM promo_attributed
  WHERE copilot_rn = 1
),
twofor_orders AS (
  SELECT
    o.order_id,
    ANY_VALUE(CAST(o.user_id AS STRING)) AS user_id,
    ANY_VALUE(o.purchased_at) AS purchased_at,
    ANY_VALUE(UPPER(o.currency)) AS currency,
    ANY_VALUE(CAST(o.subtotal AS FLOAT64)) AS subtotal_pretax,
    ANY_VALUE(DATE(o.purchased_at, 'America/New_York')) AS order_date,
    ANY_VALUE(DATE_TRUNC(DATE(o.purchased_at, 'America/New_York'), MONTH)) AS month,
    ANY_VALUE(TRIM(COALESCE(l.product_name, l.title))) AS product_name
  FROM `data-pipeline-492715.core.mt_orders` AS o
  JOIN `data-pipeline-492715.core.mt_order_lines` AS l
    ON l.order_id = o.order_id
  WHERE LOWER(IFNULL(o.status, '')) = 'completed'
    AND IFNULL(o.contains_refund, FALSE) = FALSE
    AND CAST(o.subtotal AS FLOAT64) > 0
    AND REGEXP_CONTAINS(
      LOWER(COALESCE(l.product_name, l.title, '')),
      r'co[\s-]?pilot'
    )
    AND REGEXP_CONTAINS(
      LOWER(COALESCE(l.product_name, l.title, '')),
      r'2[ -]?for'
    )
  GROUP BY o.order_id
),
offer_touch AS (
  SELECT
    t.order_id,
    UPPER(TRIM(s.copilot_code)) AS promo_code
  FROM twofor_orders AS t
  JOIN `YOUR_PROJECT.copilots.copilot_utm_sessions` AS s
    ON CAST(s.user_id AS STRING) = t.user_id
   AND s.session_start_at <= t.purchased_at
   AND t.purchased_at < TIMESTAMP_ADD(s.session_start_at, INTERVAL 7 DAY)
  WHERE IFNULL(s.is_individual_copilot, FALSE)
    AND NULLIF(TRIM(s.user_id), '') IS NOT NULL
    AND NULLIF(TRIM(s.copilot_code), '') IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY t.order_id
    ORDER BY s.session_start_at DESC
  ) = 1
),
intro_ranked AS (
  SELECT
    t.month,
    t.order_date,
    t.order_id,
    t.currency,
    t.subtotal_pretax,
    CAST(NULL AS STRING) AS discount_id,
    t.product_name AS discount_name,
    touch.promo_code,
    roster.contact_email,
    roster.first_name,
    roster.last_name,
    roster.region,
    roster.tier,
    roster.status,
    ROW_NUMBER() OVER (
      PARTITION BY t.order_id
      ORDER BY
        CASE WHEN roster.contact_email IS NULL THEN 1 ELSE 0 END,
        CASE WHEN LOWER(IFNULL(roster.status, '')) = 'active' THEN 0 ELSE 1 END,
        CASE
          WHEN REGEXP_CONTAINS(
            IFNULL(roster.contact_email, ''),
            r'^[^@\s]+@[^@\s]+\.[^@\s]+$'
          ) THEN 0
          ELSE 1
        END,
        roster.contact_email
    ) AS copilot_rn
  FROM twofor_orders AS t
  LEFT JOIN offer_touch AS touch
    ON touch.order_id = t.order_id
  LEFT JOIN roster
    ON roster.promo_code = touch.promo_code
  WHERE NOT EXISTS (
    SELECT 1
    FROM promo_sales AS p
    WHERE p.order_id = t.order_id
  )
)
SELECT
  month,
  order_date,
  order_id,
  currency,
  subtotal_pretax,
  discount_id,
  discount_name,
  promo_code,
  contact_email,
  first_name,
  last_name,
  region,
  tier,
  status,
  source
FROM promo_sales
UNION ALL
SELECT
  month,
  order_date,
  order_id,
  currency,
  subtotal_pretax,
  discount_id,
  discount_name,
  promo_code,
  contact_email,
  first_name,
  last_name,
  region,
  tier,
  status,
  'intro_offer' AS source
FROM intro_ranked
WHERE copilot_rn = 1;
