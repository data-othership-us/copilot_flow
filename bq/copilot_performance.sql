-- Co-Pilot performance overlay (computed; do not write back to ops sheets).
-- Grain: one row per copilot_db contact_email (active first, then inactive).
--
-- Joins:
--   - data-pipeline mt_users + mt_locations (home_studio from home_location).
--     user_id is mt_users matched on mt_email, else contact_email, else copilot_db.
--   - data-pipeline mt_membership_instances (name / start / end by user_id)
--   - data-pipeline mt_reservations (check-ins → total + since membership_start)
--   - data-pipeline mt_sessions (Social Playground check-ins; private/free MT class)
--   - copilots.discount_redemption (lifetime pretax; matched by every code on
--       this discount_id plus the stored copilot_db code, and by discount name)
--   - data-pipeline stg_mt_discounts (promo_code_status; current code string by discount_id)
--       View promo_code is the current MT code when discount_id matches, else copilot_db.
--       Usage / cycle_points use that live code (and the voucher name via discount_id).
--       copilot_db.promo_code is not rewritten (onboard / offer_link stay as stored).
--   - all_time_data.order_all_time_tax via stg_mt_discounts.attr_name
--       (promo-attributed orders in the current membership term; subtotal_pretax;
--       plus redemption_count_since_membership_end after membership_end)
--   - copilots.copilot_utm_sessions (US snapshot of
--       data-dashboard-463217.utm_tracking.copilot_utm_sessions)
--       Individual offer-link sessions (utm_content = promo_code) joined to
--       mt_orders for Co-Pilot 2-for intro products. Last-touch within 7 days.
--       Added to promo redemptions for cycle_points.
--   - copilots.modash_content + modash_creators (Slack-bot CSV ingest)
--       Join: contact_email ↔ creator email_raw, else split_ig_handles
--       (ops sheets may list several IG accounts in one cell).
--       Campaign impressions since the latest Co-Pilot membership start.
--       Current-term stories / feed posts for the social requirement.
--       modash_followers from Creators CSV. View ig_followers =
--       COALESCE(modash_followers, copilot_db seed). Not written back to copilot_db.
--
-- Membership is join-time from mt_membership_instances (not stored on copilot_db).
-- "Current membership" is the live Co-Pilot instance when one exists
-- (active / pending / frozen / payment_failure), else the latest Co-Pilot
-- start including ended/cancelled terms.
-- membership_start is the Eastern calendar date of started_at.
-- membership_end is Mariana Tek's instance end (calculated_end_at, else
-- scheduled_end_at, else end_date, else cancelled_at) as an Eastern date.
-- days_to_expiry is DATE_DIFF(membership_end, today Eastern).
-- copilot_months_active is the total length of Co-Pilot-named instances only.
-- cycle_points: floor(redemption_subtotal_current_membership / 100).
--   That total is pretax promo-code sales plus Co-Pilot intro-offer (2-for-1)
--   link sales in the latest Co-Pilot term (NYC = USD, TO = CAD).
-- social_requirement_met: 4 stories/month or 1 reel/carousel per month in term.
-- Current-term stories / feed posts: posted_at in [membership_start, membership_end].
-- Modash impressions: posted_at >= latest Co-Pilot membership start.
--
-- Apply via: npm run evaluate-copilots (applies this view + copilot_evaluation_queue)
-- with YOUR_PROJECT replaced.

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_performance` AS
WITH roster_copilots AS (
  SELECT *
  FROM `YOUR_PROJECT.copilots.copilot_db`
),
-- Prefer Co-Pilot-named, then live status, then latest start
membership_from_pipeline AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT
      CAST(user_id AS STRING) AS user_id,
      CAST(membership_instance_id AS STRING) AS membership_instance_id,
      membership_name,
      status AS membership_status,
      started_at AS membership_start,
      cancelled_at,
      COALESCE(
        DATE(calculated_end_at, 'America/New_York'),
        DATE(scheduled_end_at, 'America/New_York'),
        end_date,
        DATE(cancelled_at, 'America/New_York')
      ) AS membership_end_date,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(user_id AS STRING)
        ORDER BY
          CASE
            WHEN REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\s-]?pilot')
            THEN 0 ELSE 1
          END,
          CASE
            WHEN LOWER(IFNULL(status, '')) IN (
              'active', 'pending', 'frozen', 'payment_failure'
            ) THEN 0
            ELSE 1
          END,
          started_at DESC NULLS LAST
      ) AS rn
    FROM `data-pipeline-492715.core.mt_membership_instances`
    WHERE user_id IS NOT NULL AND TRIM(CAST(user_id AS STRING)) != ''
  )
  WHERE rn = 1
),
-- Co-Pilot-named instances only (for tenure).
copilot_instances AS (
  SELECT
    CAST(user_id AS STRING) AS user_id,
    DATE(started_at, 'America/New_York') AS start_date,
    COALESCE(
      DATE(calculated_end_at, 'America/New_York'),
      DATE(scheduled_end_at, 'America/New_York'),
      end_date,
      DATE(cancelled_at, 'America/New_York')
    ) AS end_date
  FROM `data-pipeline-492715.core.mt_membership_instances`
  WHERE user_id IS NOT NULL
    AND TRIM(CAST(user_id AS STRING)) != ''
    AND started_at IS NOT NULL
    AND REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\s-]?pilot')
),
copilot_tenure AS (
  SELECT
    user_id,
    SUM(
      GREATEST(
        0,
        DATE_DIFF(
          LEAST(
            COALESCE(end_date, CURRENT_DATE('America/New_York')),
            CURRENT_DATE('America/New_York')
          ),
          start_date,
          MONTH
        )
      )
    ) AS copilot_months_active
  FROM copilot_instances
  GROUP BY user_id
),
-- Current MT voucher: display name + every code still on the discount.
-- Prefer the copilot_db value when it is still on the discount; otherwise
-- the first remaining code (a rename). Usage joins all of these keys.
current_promo AS (
  SELECT
    CAST(discount_id AS STRING) AS discount_id,
    ANY_VALUE(attr_name) AS discount_name,
    ARRAY_AGG(DISTINCT UPPER(TRIM(code)) IGNORE NULLS ORDER BY UPPER(TRIM(code))) AS promo_keys
  FROM `data-pipeline-492715.stg_mt.stg_mt_discounts`,
    UNNEST(JSON_VALUE_ARRAY(attr_codes)) AS code
  WHERE TRIM(IFNULL(code, '')) != ''
  GROUP BY 1
),
-- One MT user per email (skip merged; prefer active).
mt_users_one AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT
      CAST(user_id AS STRING) AS user_id,
      LOWER(TRIM(email)) AS email,
      home_location_id,
      ROW_NUMBER() OVER (
        PARTITION BY LOWER(TRIM(email))
        ORDER BY
          CASE WHEN IFNULL(is_merged, FALSE) THEN 1 ELSE 0 END,
          CASE WHEN IFNULL(is_active, TRUE) THEN 0 ELSE 1 END,
          CAST(user_id AS STRING)
      ) AS rn
    FROM `data-pipeline-492715.core.mt_users`
    WHERE email IS NOT NULL AND TRIM(email) != ''
  )
  WHERE rn = 1
),
roster_resolved AS (
  SELECT
    c.*,
    COALESCE(
      NULLIF(u_mt.user_id, ''),
      NULLIF(u_contact.user_id, ''),
      NULLIF(CAST(c.user_id AS STRING), '')
    ) AS resolved_user_id
  FROM roster_copilots AS c
  LEFT JOIN mt_users_one AS u_mt
    ON TRIM(IFNULL(c.mt_email, '')) != ''
    AND u_mt.email = LOWER(TRIM(c.mt_email))
  LEFT JOIN mt_users_one AS u_contact
    ON TRIM(IFNULL(c.contact_email, '')) != ''
    AND u_contact.email = LOWER(TRIM(c.contact_email))
),
enriched AS (
  SELECT
    c.* EXCEPT (promo_code, user_id),
    COALESCE(c.resolved_user_id, CAST(c.user_id AS STRING)) AS user_id,
    COALESCE(
      IF(
        UPPER(TRIM(IFNULL(c.promo_code, ''))) IN UNNEST(cp.promo_keys),
        UPPER(TRIM(c.promo_code)),
        NULL
      ),
      cp.promo_keys[SAFE_OFFSET(0)],
      c.promo_code
    ) AS promo_code,
    cp.discount_name AS mt_discount_name,
    ARRAY(
      SELECT DISTINCT k
      FROM UNNEST(
        ARRAY_CONCAT(
          IFNULL(cp.promo_keys, []),
          IF(
            TRIM(IFNULL(c.promo_code, '')) != '',
            [UPPER(TRIM(c.promo_code))],
            CAST([] AS ARRAY<STRING>)
          )
        )
      ) AS k
      WHERE k IS NOT NULL AND TRIM(k) != ''
    ) AS promo_keys,
    `YOUR_PROJECT.copilots.split_ig_handles`(
      CONCAT(IFNULL(c.ig_handle, ''), ' ', IFNULL(c.ig_url, ''))
    ) AS ig_handles,
    CASE CAST(u.home_location_id AS STRING)
      WHEN '48717' THEN 'Adelaide'
      WHEN '48750' THEN 'Yorkville'
      WHEN '48784' THEN 'Flatiron'
      WHEN '48817' THEN 'Williamsburg'
      ELSE NULLIF(TRIM(loc.location_name), '')
    END AS home_studio,
    m.membership_instance_id AS mem_instance_id,
    m.membership_name AS mem_name,
    m.membership_start AS mem_start,
    m.membership_status AS mem_status,
    DATE(m.membership_start, 'America/New_York') AS mem_start_date,
    m.membership_end_date AS mem_end_date
  FROM roster_resolved AS c
  LEFT JOIN current_promo AS cp
    ON cp.discount_id = CAST(c.discount_id AS STRING)
  LEFT JOIN membership_from_pipeline AS m
    ON m.user_id = c.resolved_user_id
  LEFT JOIN `data-pipeline-492715.core.mt_users` AS u
    ON CAST(u.user_id AS STRING) = c.resolved_user_id
  LEFT JOIN `data-pipeline-492715.core.mt_locations` AS loc
    ON CAST(loc.location_id AS STRING) = CAST(u.home_location_id AS STRING)
),
checkins AS (
  SELECT
    CAST(user_id AS STRING) AS user_id,
    session_start_at
  FROM `data-pipeline-492715.core.mt_reservations`
  WHERE LOWER(IFNULL(status, '')) = 'check in'
    AND IFNULL(session_is_cancelled, FALSE) = FALSE
    AND user_id IS NOT NULL
),
session_stats AS (
  SELECT
    e.contact_email,
    COUNT(ci.session_start_at) AS classes_taken_total,
    COUNTIF(
      e.mem_start IS NOT NULL
      AND ci.session_start_at >= e.mem_start
      AND DATE(ci.session_start_at, 'America/New_York') <= e.mem_end_date
    ) AS classes_taken_current_membership,
    MAX(ci.session_start_at) AS last_class_at,
    MAX(DATE(ci.session_start_at)) AS last_class_date,
    MAX(
      IF(
        e.mem_start IS NOT NULL
        AND ci.session_start_at >= e.mem_start
        AND DATE(ci.session_start_at, 'America/New_York') <= e.mem_end_date,
        ci.session_start_at,
        NULL
      )
    ) AS last_class_at_current_membership
  FROM enriched AS e
  LEFT JOIN checkins AS ci
    ON ci.user_id = CAST(e.user_id AS STRING)
  GROUP BY e.contact_email
),
-- Social Playgrounds are private/free MT classes. SOP custom name
-- "Social Playground" is often missing from class_type_display; live
-- bookings are usually Private - 75 Min Free Flow (afternoon) or
-- Private (1.5 HRS) / Social / Free Flow (evening beat-drop).
playground_checkins AS (
  SELECT
    CAST(r.user_id AS STRING) AS user_id,
    r.session_id,
    r.session_start_at,
    r.location_name
  FROM `data-pipeline-492715.core.mt_reservations` AS r
  JOIN `data-pipeline-492715.core.mt_sessions` AS s
    ON s.session_id = r.session_id
  WHERE LOWER(IFNULL(r.status, '')) = 'check in'
    AND IFNULL(r.session_is_cancelled, FALSE) = FALSE
    AND r.user_id IS NOT NULL
    AND IFNULL(s.is_public, TRUE) = FALSE
    AND IFNULL(s.is_free, FALSE) = TRUE
    AND (
      REGEXP_CONTAINS(
        LOWER(IFNULL(s.session_name, '')),
        r'social[\s-]*playground'
      )
      OR TRIM(s.session_name) = 'Private - 75 Min Free Flow'
      OR (
        TRIM(s.session_name) IN ('Private (1.5 HRS)', 'Free Flow', 'Social')
        AND EXTRACT(HOUR FROM DATETIME(s.start_at, 'America/New_York'))
          BETWEEN 20 AND 22
        AND IFNULL(s.capacity, 0) >= 60
      )
      OR (
        TRIM(s.session_name) IN ('Free Flow', 'Social')
        AND EXTRACT(HOUR FROM DATETIME(s.start_at, 'America/New_York'))
          BETWEEN 13 AND 14
      )
    )
),
playground_stats AS (
  SELECT
    e.contact_email,
    COUNT(DISTINCT pc.session_id) AS social_playgrounds_attended,
    MAX_BY(
      CONCAT(
        IFNULL(pc.location_name, 'Unknown'),
        ' · ',
        FORMAT_DATE(
          '%Y-%m-%d',
          DATE(pc.session_start_at, 'America/New_York')
        )
      ),
      pc.session_start_at
    ) AS last_social_playground
  FROM enriched AS e
  LEFT JOIN playground_checkins AS pc
    ON pc.user_id = CAST(e.user_id AS STRING)
   AND e.mem_start IS NOT NULL
   AND pc.session_start_at >= e.mem_start
   AND DATE(pc.session_start_at, 'America/New_York') <= e.mem_end_date
  GROUP BY e.contact_email
),
redemptions AS (
  SELECT
    contact_email,
    SUM(redemption_count) AS redemption_count,
    SUM(IF(UPPER(IFNULL(currency, '')) = 'USD', CAST(subtotal_pretax AS FLOAT64), 0)) AS redemption_subtotal_usd,
    SUM(IF(UPPER(IFNULL(currency, '')) = 'CAD', CAST(subtotal_pretax AS FLOAT64), 0)) AS redemption_subtotal_cad
  FROM (
    SELECT DISTINCT
      e.contact_email,
      r.discount_code_name,
      r.currency,
      r.redemption_count,
      r.subtotal_pretax
    FROM enriched AS e
    JOIN UNNEST(e.promo_keys) AS pk
    JOIN (
      SELECT
        UPPER(TRIM(code)) AS promo_key,
        discount_code_name,
        currency,
        redemption_count,
        subtotal_pretax
      FROM `YOUR_PROJECT.copilots.discount_redemption`,
        UNNEST(IFNULL(discount_code, [])) AS code
      WHERE TRIM(IFNULL(code, '')) != ''
    ) AS r
      ON r.promo_key = pk
    UNION DISTINCT
    SELECT
      e.contact_email,
      r.discount_code_name,
      r.currency,
      r.redemption_count,
      r.subtotal_pretax
    FROM enriched AS e
    JOIN `YOUR_PROJECT.copilots.discount_redemption` AS r
      ON NULLIF(TRIM(e.mt_discount_name), '') IS NOT NULL
     AND TRIM(r.discount_code_name) = TRIM(e.mt_discount_name)
  )
  GROUP BY contact_email
),
-- Map each active copilot → MT discount display name (for order attribution)
discount_names AS (
  SELECT
    CAST(discount_id AS STRING) AS discount_id,
    attr_name AS discount_name,
    UPPER(TRIM(code)) AS promo_key,
    CASE
      WHEN attr_is_active IS FALSE THEN 'inactive'
      WHEN attr_end_datetime IS NOT NULL
        AND attr_end_datetime < CURRENT_TIMESTAMP() THEN 'expired'
      WHEN attr_is_active IS TRUE THEN 'active'
      ELSE CAST(NULL AS STRING)
    END AS promo_code_status
  FROM `data-pipeline-492715.stg_mt.stg_mt_discounts`,
    UNNEST(JSON_VALUE_ARRAY(attr_codes)) AS code
  WHERE code IS NOT NULL AND TRIM(code) != ''
),
promo_status_by_id AS (
  SELECT discount_id, ANY_VALUE(promo_code_status) AS promo_code_status
  FROM discount_names
  GROUP BY discount_id
),
promo_status_by_code AS (
  SELECT promo_key, ANY_VALUE(promo_code_status) AS promo_code_status
  FROM discount_names
  GROUP BY promo_key
),
copilot_discount_name AS (
  SELECT
    e.contact_email,
    e.mem_start AS membership_start,
    COALESCE(d_id.discount_name, d_code.discount_name) AS discount_name
  FROM enriched AS e
  LEFT JOIN (
    SELECT discount_id, ANY_VALUE(discount_name) AS discount_name
    FROM discount_names
    GROUP BY discount_id
  ) AS d_id
    ON d_id.discount_id = CAST(e.discount_id AS STRING)
  LEFT JOIN (
    SELECT promo_key, ANY_VALUE(discount_name) AS discount_name
    FROM discount_names
    GROUP BY promo_key
  ) AS d_code
    ON d_code.promo_key = UPPER(TRIM(e.promo_code))
  WHERE COALESCE(d_id.discount_name, d_code.discount_name) IS NOT NULL
    AND e.mem_start IS NOT NULL
),
-- Promo-attributed orders (buyer used this copilot's discount) in the
-- latest Co-Pilot membership term (Eastern start date through end date).
promo_orders_since AS (
  SELECT DISTINCT
    cdn.contact_email,
    o.order_id,
    o.currency,
    CAST(o.subtotal_pretax AS FLOAT64) AS subtotal_pretax
  FROM copilot_discount_name AS cdn
  JOIN enriched AS e
    ON e.contact_email = cdn.contact_email
  JOIN `data-dashboard-463217.all_time_data.order_all_time_tax` AS o
    ON e.mem_start_date IS NOT NULL
   AND REGEXP_CONTAINS(LOWER(IFNULL(e.mem_name, '')), r'co[\s-]?pilot')
   AND DATE(o.purchase_time, 'America/New_York') >= e.mem_start_date
   AND DATE(o.purchase_time, 'America/New_York')
     <= COALESCE(e.mem_end_date, CURRENT_DATE('America/New_York'))
   AND IFNULL(o.contains_refund, FALSE) = FALSE
  JOIN UNNEST(o.discount_name) AS discount_name_item
  WHERE discount_name_item = cdn.discount_name
),
sales_current_membership AS (
  SELECT
    contact_email,
    COUNT(*) AS redemption_count_current_membership,
    SUM(IF(UPPER(currency) = 'USD', subtotal_pretax, 0)) AS redemption_subtotal_usd_current_membership,
    SUM(IF(UPPER(currency) = 'CAD', subtotal_pretax, 0)) AS redemption_subtotal_cad_current_membership
  FROM promo_orders_since
  GROUP BY contact_email
),
-- Promo-attributed orders after the current membership end date.
promo_orders_after_end AS (
  SELECT DISTINCT
    cdn.contact_email,
    o.order_id
  FROM copilot_discount_name AS cdn
  JOIN enriched AS e
    ON e.contact_email = cdn.contact_email
  JOIN `data-dashboard-463217.all_time_data.order_all_time_tax` AS o
    ON e.mem_end_date IS NOT NULL
   AND DATE(o.purchase_time, 'America/New_York') > e.mem_end_date
   AND IFNULL(o.contains_refund, FALSE) = FALSE
  JOIN UNNEST(o.discount_name) AS discount_name_item
  WHERE discount_name_item = cdn.discount_name
),
sales_after_membership AS (
  SELECT
    contact_email,
    COUNT(*) AS redemption_count_since_membership_end
  FROM promo_orders_after_end
  GROUP BY contact_email
),
-- Co-Pilot intro-offer (2-for-1) sales from the individual offer link.
-- Snapshot is refreshed in applySheetUnionViews from utm_tracking
-- (northeast2 → US). Buyer MT user_id on the session → completed
-- Co-Pilot 2-for order, last-touch within 7 days of session_start.
intro_offer_orders AS (
  SELECT
    s.copilot_code,
    o.order_id,
    o.currency,
    CAST(o.subtotal AS FLOAT64) AS subtotal_pretax,
    o.purchased_at
  FROM `YOUR_PROJECT.copilots.copilot_utm_sessions` AS s
  JOIN `data-pipeline-492715.core.mt_orders` AS o
    ON CAST(o.user_id AS STRING) = CAST(s.user_id AS STRING)
   AND o.purchased_at >= s.session_start_at
   AND o.purchased_at < TIMESTAMP_ADD(s.session_start_at, INTERVAL 7 DAY)
   AND LOWER(IFNULL(o.status, '')) = 'completed'
   AND IFNULL(o.contains_refund, FALSE) = FALSE
   AND CAST(o.subtotal AS FLOAT64) > 0
  WHERE IFNULL(s.is_individual_copilot, FALSE)
    AND s.user_id IS NOT NULL AND TRIM(s.user_id) != ''
    AND s.copilot_code IS NOT NULL AND TRIM(s.copilot_code) != ''
    AND EXISTS (
      SELECT 1
      FROM `data-pipeline-492715.core.mt_order_lines` AS l
      WHERE l.order_id = o.order_id
        AND REGEXP_CONTAINS(
          LOWER(COALESCE(l.product_name, l.title, '')),
          r'co[\s-]?pilot'
        )
        AND REGEXP_CONTAINS(
          LOWER(COALESCE(l.product_name, l.title, '')),
          r'2[ -]?for'
        )
    )
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY o.order_id
    ORDER BY s.session_start_at DESC
  ) = 1
),
intro_orders_current AS (
  SELECT DISTINCT
    e.contact_email,
    i.order_id,
    i.currency,
    i.subtotal_pretax
  FROM enriched AS e
  JOIN UNNEST(e.promo_keys) AS pk
  JOIN intro_offer_orders AS i
    ON UPPER(TRIM(i.copilot_code)) = pk
  WHERE e.mem_start_date IS NOT NULL
    AND REGEXP_CONTAINS(LOWER(IFNULL(e.mem_name, '')), r'co[\s-]?pilot')
    AND DATE(i.purchased_at, 'America/New_York') >= e.mem_start_date
    AND DATE(i.purchased_at, 'America/New_York')
      <= COALESCE(e.mem_end_date, CURRENT_DATE('America/New_York'))
),
intro_sales_current_membership AS (
  SELECT
    contact_email,
    COUNT(*) AS intro_offer_count_current_membership,
    SUM(IF(UPPER(currency) = 'USD', subtotal_pretax, 0))
      AS intro_offer_subtotal_usd_current_membership,
    SUM(IF(UPPER(currency) = 'CAD', subtotal_pretax, 0))
      AS intro_offer_subtotal_cad_current_membership
  FROM intro_orders_current
  GROUP BY contact_email
),
intro_orders_after_end AS (
  SELECT DISTINCT
    e.contact_email,
    i.order_id
  FROM enriched AS e
  JOIN UNNEST(e.promo_keys) AS pk
  JOIN intro_offer_orders AS i
    ON UPPER(TRIM(i.copilot_code)) = pk
  WHERE e.mem_end_date IS NOT NULL
    AND DATE(i.purchased_at, 'America/New_York') > e.mem_end_date
),
intro_sales_after_membership AS (
  SELECT
    contact_email,
    COUNT(*) AS intro_offer_count_since_membership_end
  FROM intro_orders_after_end
  GROUP BY contact_email
),
-- Creator emails exploded for matching when copilot_db.ig_handle is missing.
modash_creator_emails AS (
  SELECT
    `YOUR_PROJECT.copilots.normalize_ig_handle`(c.profile) AS ig_handle,
    LOWER(TRIM(email)) AS email
  FROM `YOUR_PROJECT.copilots.modash_creators` AS c,
    UNNEST(SPLIT(IFNULL(c.email_raw, ''), ',')) AS email
  WHERE `YOUR_PROJECT.copilots.normalize_ig_handle`(c.profile) IS NOT NULL
    AND TRIM(email) != ''
),
-- One copilot → every Modash handle (roster IG + emails on the Creators CSV).
copilot_modash_handles AS (
  SELECT DISTINCT contact_email, ig_handle
  FROM (
    SELECT
      e.contact_email,
      h AS ig_handle
    FROM enriched AS e,
      UNNEST(e.ig_handles) AS h
    UNION ALL
    SELECT
      e.contact_email,
      ce.ig_handle
    FROM enriched AS e
    JOIN modash_creator_emails AS ce
      ON ce.email = LOWER(TRIM(e.contact_email))
  )
  WHERE ig_handle IS NOT NULL
),
-- Campaign posts since the latest Co-Pilot membership start.
modash_posts_in_term AS (
  SELECT
    e.contact_email,
    p.content_key,
    ANY_VALUE(p.impressions) AS impressions
  FROM enriched AS e
  JOIN copilot_modash_handles AS h
    ON h.contact_email = e.contact_email
  JOIN `YOUR_PROJECT.copilots.modash_content` AS p
    ON `YOUR_PROJECT.copilots.normalize_ig_handle`(p.influencer) = h.ig_handle
   AND e.mem_start IS NOT NULL
   AND REGEXP_CONTAINS(LOWER(IFNULL(e.mem_name, '')), r'co[\s-]?pilot')
   AND p.posted_at >= e.mem_start
  WHERE `YOUR_PROJECT.copilots.normalize_ig_handle`(p.influencer) IS NOT NULL
  GROUP BY e.contact_email, p.content_key
),
modash_stats AS (
  SELECT
    contact_email,
    SUM(impressions) AS modash_impressions
  FROM modash_posts_in_term
  GROUP BY contact_email
),
-- Current-term stories vs reel/carousel (grid). Caps at membership_end.
modash_posts_current_membership AS (
  SELECT
    e.contact_email,
    p.content_key,
    ANY_VALUE(LOWER(TRIM(p.content_type))) AS content_type
  FROM enriched AS e
  JOIN copilot_modash_handles AS h
    ON h.contact_email = e.contact_email
  JOIN `YOUR_PROJECT.copilots.modash_content` AS p
    ON `YOUR_PROJECT.copilots.normalize_ig_handle`(p.influencer) = h.ig_handle
   AND e.mem_start IS NOT NULL
   AND e.mem_end_date IS NOT NULL
   AND REGEXP_CONTAINS(LOWER(IFNULL(e.mem_name, '')), r'co[\s-]?pilot')
   AND p.posted_at >= e.mem_start
   AND DATE(p.posted_at, 'America/New_York') <= e.mem_end_date
  WHERE `YOUR_PROJECT.copilots.normalize_ig_handle`(p.influencer) IS NOT NULL
  GROUP BY e.contact_email, p.content_key
),
modash_current_stats AS (
  SELECT
    contact_email,
    COUNTIF(content_type = 'story') AS modash_stories_current_membership,
    COUNTIF(content_type IN ('reel', 'carousel')) AS modash_feed_posts_current_membership
  FROM modash_posts_current_membership
  GROUP BY contact_email
),
-- Latest Modash Followers from the Creators CSV. copilot_db.ig_followers
-- is onboard seed only; sheet sync does not overwrite it.
modash_followers AS (
  SELECT
    h.contact_email,
    MAX_BY(c.followers, c.ingested_at) AS modash_followers
  FROM copilot_modash_handles AS h
  JOIN `YOUR_PROJECT.copilots.modash_creators` AS c
    ON COALESCE(
      `YOUR_PROJECT.copilots.normalize_ig_handle`(c.ig_handle),
      `YOUR_PROJECT.copilots.normalize_ig_handle`(c.profile)
    ) = h.ig_handle
  WHERE c.followers IS NOT NULL
  GROUP BY h.contact_email
)
SELECT
  -- Identity / program
  e.contact_email,
  e.first_name,
  e.last_name,
  e.region,
  e.tier,
  e.status,
  e.decision,
  e.decision_notes,
  e.decision_at,
  e.decision_applied_at,
  e.onboarded_at,
  e.freeze_until,
  e.user_id,
  e.mt_email,
  e.mt_profile_link,
  e.promo_code,
  COALESCE(ps_id.promo_code_status, ps_code.promo_code_status) AS promo_code_status,
  e.discount_id,
  e.offer_link,
  IF(
    ARRAY_LENGTH(e.ig_handles) > 0,
    ARRAY_TO_STRING(
      ARRAY(SELECT CONCAT('@', h) FROM UNNEST(e.ig_handles) AS h),
      '\n'
    ),
    IF(
      REGEXP_CONTAINS(LOWER(IFNULL(e.ig_handle, '')), r're-?submit'),
      're-submit',
      e.ig_handle
    )
  ) AS ig_handle,
  COALESCE(
    NULLIF(
      ARRAY_TO_STRING(
        ARRAY(
          SELECT CONCAT('https://www.instagram.com/', h, '/')
          FROM UNNEST(e.ig_handles) AS h
        ),
        '\n'
      ),
      ''
    ),
    NULLIF(TRIM(e.ig_url), '')
  ) AS ig_url,
  COALESCE(mf.modash_followers, e.ig_followers) AS ig_followers,
  mf.modash_followers,
  e.tiktok_handle,
  e.tiktok_followers,
  e.other_channels,
  e.home_studio,

  -- Membership (pipeline join on user_id; Eastern calendar dates)
  e.mem_instance_id AS membership_instance_id,
  e.mem_name AS membership_name,
  e.mem_start_date AS membership_start,
  e.mem_end_date AS membership_end,
  DATE_DIFF(
    e.mem_end_date,
    CURRENT_DATE('America/New_York'),
    DAY
  ) AS days_to_expiry,
  DATE_DIFF(
    CURRENT_DATE('America/New_York'),
    e.mem_start_date,
    MONTH
  ) AS months_since_membership_start,
  COALESCE(ten.copilot_months_active, 0) AS copilot_months_active,
  e.mem_status AS membership_status,
  e.sheet_membership_expiry,

  -- Sessions (computed from reservations)
  sess.classes_taken_total,
  sess.classes_taken_current_membership,
  sess.last_class_at,
  sess.last_class_date,
  sess.last_class_at_current_membership,
  pg.social_playgrounds_attended,
  pg.last_social_playground,

  -- Modash impressions since latest Co-Pilot start; stories/feed this term
  COALESCE(md.modash_impressions, 0) AS modash_impressions,
  COALESCE(mdc.modash_stories_current_membership, 0) AS modash_stories_current_membership,
  COALESCE(mdc.modash_feed_posts_current_membership, 0) AS modash_feed_posts_current_membership,
  IF(
    e.mem_start_date IS NULL OR e.mem_end_date IS NULL,
    FALSE,
    (
      COALESCE(mdc.modash_stories_current_membership, 0)
        >= 4 * GREATEST(DATE_DIFF(e.mem_end_date, e.mem_start_date, MONTH), 1)
      OR COALESCE(mdc.modash_feed_posts_current_membership, 0)
        >= GREATEST(DATE_DIFF(e.mem_end_date, e.mem_start_date, MONTH), 1)
    )
  ) AS social_requirement_met,

  -- Promo redemptions / sales — lifetime pretax (discount_redemption rollup)
  r.redemption_count,
  r.redemption_subtotal_usd,
  r.redemption_subtotal_cad,

  -- Promo redemptions / sales — pretax in the latest Co-Pilot membership term
  scm.redemption_count_current_membership,
  scm.redemption_subtotal_usd_current_membership,
  scm.redemption_subtotal_cad_current_membership,
  COALESCE(intro.intro_offer_count_current_membership, 0)
    AS intro_offer_count_current_membership,
  COALESCE(intro.intro_offer_subtotal_usd_current_membership, 0)
    AS intro_offer_subtotal_usd_current_membership,
  COALESCE(intro.intro_offer_subtotal_cad_current_membership, 0)
    AS intro_offer_subtotal_cad_current_membership,
  COALESCE(
    IF(
      REGEXP_CONTAINS(
        UPPER(TRIM(IFNULL(e.region, ''))),
        r'^(NYC|NY)$|NEW YORK'
      ),
      COALESCE(scm.redemption_subtotal_usd_current_membership, 0)
        + COALESCE(intro.intro_offer_subtotal_usd_current_membership, 0),
      COALESCE(scm.redemption_subtotal_cad_current_membership, 0)
        + COALESCE(intro.intro_offer_subtotal_cad_current_membership, 0)
    ),
    0
  ) AS redemption_subtotal_current_membership,
  CAST(FLOOR(
    GREATEST(
      COALESCE(
        IF(
          REGEXP_CONTAINS(
            UPPER(TRIM(IFNULL(e.region, ''))),
            r'^(NYC|NY)$|NEW YORK'
          ),
          COALESCE(scm.redemption_subtotal_usd_current_membership, 0)
            + COALESCE(intro.intro_offer_subtotal_usd_current_membership, 0),
          COALESCE(scm.redemption_subtotal_cad_current_membership, 0)
            + COALESCE(intro.intro_offer_subtotal_cad_current_membership, 0)
        ),
        0
      ),
      0
    ) / 100
  ) AS INT64) AS cycle_points,
  COALESCE(sam.redemption_count_since_membership_end, 0)
    + COALESCE(intro_after.intro_offer_count_since_membership_end, 0)
    AS redemption_count_since_membership_end,

  -- Sheet sales fallbacks
  e.combined_sales AS sheet_combined_sales,
  e.bb_sales AS sheet_bb_sales,
  e.mt_sales AS sheet_mt_sales,
  e.hybrid_sales AS sheet_hybrid_sales,
  e.new_hybrid_sales,
  e.bb_facing_amount AS sheet_bb_facing,
  e.mt_facing_amount AS sheet_mt_facing,

  e.notes,
  e.updated_at
FROM enriched AS e
LEFT JOIN copilot_tenure AS ten
  ON ten.user_id = CAST(e.user_id AS STRING)
LEFT JOIN promo_status_by_id AS ps_id
  ON ps_id.discount_id = CAST(e.discount_id AS STRING)
LEFT JOIN promo_status_by_code AS ps_code
  ON ps_code.promo_key = UPPER(TRIM(e.promo_code))
LEFT JOIN session_stats AS sess
  ON sess.contact_email = e.contact_email
LEFT JOIN playground_stats AS pg
  ON pg.contact_email = e.contact_email
LEFT JOIN redemptions AS r
  ON r.contact_email = e.contact_email
LEFT JOIN sales_current_membership AS scm
  ON scm.contact_email = e.contact_email
LEFT JOIN sales_after_membership AS sam
  ON sam.contact_email = e.contact_email
LEFT JOIN intro_sales_current_membership AS intro
  ON intro.contact_email = e.contact_email
LEFT JOIN intro_sales_after_membership AS intro_after
  ON intro_after.contact_email = e.contact_email
LEFT JOIN modash_stats AS md
  ON md.contact_email = e.contact_email
LEFT JOIN modash_current_stats AS mdc
  ON mdc.contact_email = e.contact_email
LEFT JOIN modash_followers AS mf
  ON mf.contact_email = e.contact_email
ORDER BY
  CASE WHEN LOWER(IFNULL(e.status, '')) = 'active' THEN 0 ELSE 1 END,
  e.contact_email
LIMIT 100000;
