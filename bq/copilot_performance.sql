-- Co-Pilot performance overlay (computed; do not write back to ops sheets).
-- Grain: one row per *active* copilot_db contact_email.
--
-- Joins:
--   - data-pipeline mt_users + mt_locations (home_studio from home_location)
--   - data-pipeline mt_membership_instances (name / start / end by user_id)
--   - data-pipeline mt_reservations (check-ins → total + since membership_start)
--   - data-pipeline mt_sessions (Social Playground check-ins; private/free MT class)
--   - copilots.discount_redemption (promo code → lifetime pretax redemptions)
--   - all_time_data.order_all_time_tax via discount_codes.name
--       (promo-attributed orders in the current membership term; subtotal_pretax)
--   - copilots.modash_content + modash_creators (Slack-bot CSV ingest)
--       Join: contact_email ↔ creator email_raw, else normalize_ig_handle.
--       Campaign posts + impressions / reach / views / engagement
--       (likes + comments) for the current membership term.
--       modash_followers from Creators CSV. View ig_followers =
--       COALESCE(modash_followers, copilot_db seed). Not written back to copilot_db.
--
-- Membership is join-time from mt_membership_instances (not stored on copilot_db).
-- "Current membership" is the latest Co-Pilot instance by started_at,
-- including ended/cancelled terms (not only live status).
-- membership_start is the Eastern calendar date of started_at.
-- membership_end is start + interval count (monthly): Seeker/weekly 3,
-- Wayfinder 6, Luminary/annual 12.
-- Current-membership metrics use [membership_start, membership_end]
-- (Eastern dates), even when the instance is no longer live.
--
-- Apply via: npm run sync-copilot-db (applies this view + copilot_evaluation_queue)
-- with YOUR_PROJECT replaced.

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_performance` AS
WITH active_copilots AS (
  SELECT *
  FROM `YOUR_PROJECT.copilots.copilot_db`
  WHERE LOWER(IFNULL(status, '')) = 'active'
),
-- Prefer Co-Pilot-named, then latest start (include ended terms)
membership_from_pipeline AS (
  SELECT * EXCEPT (rn) FROM (
    SELECT
      CAST(user_id AS STRING) AS user_id,
      CAST(membership_instance_id AS STRING) AS membership_instance_id,
      membership_name,
      status AS membership_status,
      started_at AS membership_start,
      CASE
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'luminary|annual')
          THEN 12
        WHEN REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'wayfinder')
          THEN 6
        ELSE 3
      END AS interval_count,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(user_id AS STRING)
        ORDER BY
          CASE
            WHEN REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\s-]?pilot')
            THEN 0 ELSE 1
          END,
          started_at DESC NULLS LAST
      ) AS rn
    FROM `data-pipeline-492715.core.mt_membership_instances`
    WHERE user_id IS NOT NULL AND TRIM(CAST(user_id AS STRING)) != ''
  )
  WHERE rn = 1
),
enriched AS (
  SELECT
    c.*,
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
    m.interval_count AS mem_interval_count,
    m.membership_status AS mem_status,
    DATE(m.membership_start, 'America/New_York') AS mem_start_date,
    DATE_ADD(
      DATE(m.membership_start, 'America/New_York'),
      INTERVAL COALESCE(
        m.interval_count,
        CASE
          WHEN REGEXP_CONTAINS(LOWER(IFNULL(c.tier, '')), r'luminary') THEN 12
          WHEN REGEXP_CONTAINS(LOWER(IFNULL(c.tier, '')), r'wayfinder') THEN 6
          ELSE 3
        END
      ) MONTH
    ) AS mem_end_date
  FROM active_copilots AS c
  LEFT JOIN membership_from_pipeline AS m
    ON m.user_id = CAST(c.user_id AS STRING)
  LEFT JOIN `data-pipeline-492715.core.mt_users` AS u
    ON CAST(u.user_id AS STRING) = CAST(c.user_id AS STRING)
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
redemption_by_code_currency AS (
  SELECT
    UPPER(TRIM(code)) AS promo_key,
    currency,
    SUM(redemption_count) AS redemption_count,
    SUM(CAST(subtotal_pretax AS FLOAT64)) AS subtotal_pretax
  FROM `YOUR_PROJECT.copilots.discount_redemption`,
    UNNEST(discount_code) AS code
  WHERE code IS NOT NULL AND TRIM(code) != ''
  GROUP BY 1, 2
),
redemptions AS (
  SELECT
    promo_key,
    SUM(redemption_count) AS redemption_count,
    SUM(IF(UPPER(currency) = 'USD', subtotal_pretax, 0)) AS redemption_subtotal_usd,
    SUM(IF(UPPER(currency) = 'CAD', subtotal_pretax, 0)) AS redemption_subtotal_cad
  FROM redemption_by_code_currency
  GROUP BY 1
),
-- Map each active copilot → MT discount display name (for order attribution)
discount_names AS (
  SELECT
    CAST(id AS STRING) AS discount_id,
    name AS discount_name,
    UPPER(TRIM(code)) AS promo_key
  FROM `data-dashboard-463217.all_time_data.discount_codes`,
    UNNEST(codes) AS code
  WHERE code IS NOT NULL AND TRIM(code) != ''
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
-- current membership term (start through membership_end, even if ended).
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
    ON o.purchase_time >= cdn.membership_start
   AND DATE(o.purchase_time, 'America/New_York') <= e.mem_end_date
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
      `YOUR_PROJECT.copilots.normalize_ig_handle`(e.ig_handle) AS ig_handle
    FROM enriched AS e
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
-- One row per copilot × campaign post in the current membership term.
modash_posts_in_term AS (
  SELECT
    e.contact_email,
    p.content_key,
    ANY_VALUE(p.impressions) AS impressions,
    ANY_VALUE(p.reach) AS reach,
    ANY_VALUE(p.views) AS views,
    ANY_VALUE(p.likes) AS likes,
    ANY_VALUE(p.comments) AS comments
  FROM enriched AS e
  JOIN copilot_modash_handles AS h
    ON h.contact_email = e.contact_email
  JOIN `YOUR_PROJECT.copilots.modash_content` AS p
    ON `YOUR_PROJECT.copilots.normalize_ig_handle`(p.influencer) = h.ig_handle
   AND e.mem_start IS NOT NULL
   AND p.posted_at >= e.mem_start
   AND DATE(p.posted_at, 'America/New_York') <= e.mem_end_date
  WHERE `YOUR_PROJECT.copilots.normalize_ig_handle`(p.influencer) IS NOT NULL
  GROUP BY e.contact_email, p.content_key
),
modash_stats AS (
  SELECT
    contact_email,
    COUNT(*) AS modash_posts,
    SUM(impressions) AS modash_impressions,
    SUM(reach) AS modash_reach,
    SUM(views) AS modash_views,
    SUM(IFNULL(likes, 0) + IFNULL(comments, 0)) AS modash_engagement
  FROM modash_posts_in_term
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
  e.freeze_until,
  e.user_id,
  e.mt_email,
  e.mt_profile_link,
  e.promo_code,
  e.discount_id,
  e.offer_link,
  e.ig_handle,
  COALESCE(
    NULLIF(TRIM(e.ig_url), ''),
    IF(
      `YOUR_PROJECT.copilots.normalize_ig_handle`(e.ig_handle) IS NULL,
      NULL,
      CONCAT(
        'https://www.instagram.com/',
        `YOUR_PROJECT.copilots.normalize_ig_handle`(e.ig_handle),
        '/'
      )
    )
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
    CURRENT_DATE('America/New_York'),
    e.mem_start_date,
    MONTH
  ) AS months_since_membership_start,
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

  -- Modash campaign posts in the current membership term
  COALESCE(md.modash_posts, 0) AS modash_posts,
  COALESCE(md.modash_impressions, 0) AS modash_impressions,
  COALESCE(md.modash_reach, 0) AS modash_reach,
  COALESCE(md.modash_views, 0) AS modash_views,
  COALESCE(md.modash_engagement, 0) AS modash_engagement,

  -- Promo redemptions / sales — lifetime pretax (discount_redemption rollup)
  r.redemption_count,
  r.redemption_subtotal_usd,
  r.redemption_subtotal_cad,

  -- Promo redemptions / sales — pretax in the current membership term
  scm.redemption_count_current_membership,
  scm.redemption_subtotal_usd_current_membership,
  scm.redemption_subtotal_cad_current_membership,

  -- Sheet sales fallbacks
  e.combined_sales AS sheet_combined_sales,
  e.bb_sales AS sheet_bb_sales,
  e.mt_sales AS sheet_mt_sales,
  e.hybrid_sales AS sheet_hybrid_sales,
  e.bb_facing_amount AS sheet_bb_facing,
  e.mt_facing_amount AS sheet_mt_facing,
  COALESCE(
    NULLIF(scm.redemption_subtotal_usd_current_membership, 0),
    NULLIF(scm.redemption_subtotal_cad_current_membership, 0),
    NULLIF(r.redemption_subtotal_usd, 0),
    NULLIF(r.redemption_subtotal_cad, 0),
    e.combined_sales
  ) AS sales_effective,

  e.notes,
  e.updated_at
FROM enriched AS e
LEFT JOIN session_stats AS sess
  ON sess.contact_email = e.contact_email
LEFT JOIN playground_stats AS pg
  ON pg.contact_email = e.contact_email
LEFT JOIN redemptions AS r
  ON r.promo_key = UPPER(TRIM(e.promo_code))
LEFT JOIN sales_current_membership AS scm
  ON scm.contact_email = e.contact_email
LEFT JOIN modash_stats AS md
  ON md.contact_email = e.contact_email
LEFT JOIN modash_followers AS mf
  ON mf.contact_email = e.contact_email;
