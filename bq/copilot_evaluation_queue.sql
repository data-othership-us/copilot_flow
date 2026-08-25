-- Co-Pilots who need Christine's renew / offboard / never again / upgrade /
-- downgrade / snooze / freeze review.
-- Active roster only (same grain as copilot_performance).
--
-- Included when:
--   - a Co-Pilot membership (name matches co-pilot) ends on or before
--     today + 14 days Eastern (already expired counts), or
--   - sheet_membership_expiry is in that window, or
--   - there is no Co-Pilot membership and no sheet expiry
--     (active copilots like ronbat — snooze is the usual action)
-- Non-Co-Pilot memberships are ignored for the 14-day window so a gym
-- term does not hide someone from Review.
--
-- After a decision is applied, stay out of Review until:
--   - snooze: 3 months after decision_at
--   - freeze: freeze_until (or applied + 3 months), and not currently frozen
--   - renew / upgrade / downgrade: a new membership_start is on/after
--     decision_applied_at AND that term is again in the 14-day window
--   - offboard / never again: status=inactive, not in copilot_performance
-- membership_start / membership_end are America/New_York dates.
-- Change the INTERVAL below to change the window, then:
--   npm run sync-copilot-db

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_evaluation_queue` AS
WITH queued AS (
  SELECT
    p.contact_email,
    p.first_name,
    p.last_name,
    p.region,
    p.tier,
    p.membership_status,
    p.ig_handle,
    p.ig_url,
    p.ig_followers,
    p.membership_name,
    p.membership_start,
    p.membership_end,
    p.months_since_membership_start,
    p.social_playgrounds_attended,
    p.last_social_playground,
    p.modash_posts,
    p.modash_impressions,
    p.modash_reach,
    p.modash_views,
    p.modash_engagement,
    p.classes_taken_current_membership,
    p.last_class_date,
    p.redemption_count_current_membership,
    p.redemption_count AS redemption_count_all_time,
    p.sales_effective,
    p.sheet_bb_sales AS bb_sales,
    p.sheet_hybrid_sales AS hybrid_sales,
    p.sheet_membership_expiry,
    p.decision,
    p.decision_at,
    p.decision_applied_at,
    p.freeze_until,
    COALESCE(
      CASE
        WHEN REGEXP_CONTAINS(
          LOWER(IFNULL(p.membership_name, '')),
          r'co[\s-]?pilot'
        )
        THEN DATE(p.membership_end)
      END,
      SAFE.PARSE_DATE(
        '%Y-%m-%d',
        SUBSTR(CAST(p.sheet_membership_expiry AS STRING), 1, 10)
      )
    ) AS expiry_date
  FROM `YOUR_PROJECT.copilots.copilot_performance` AS p
)
SELECT
  contact_email,
  first_name,
  last_name,
  region,
  tier,
  membership_status,
  ig_handle,
  ig_url,
  ig_followers,
  membership_name,
  membership_start,
  membership_end,
  months_since_membership_start,
  expiry_date,
  DATE_DIFF(expiry_date, CURRENT_DATE('America/New_York'), DAY) AS days_to_expiry,
  social_playgrounds_attended,
  last_social_playground,
  modash_posts,
  modash_impressions,
  modash_reach,
  modash_views,
  modash_engagement,
  classes_taken_current_membership,
  last_class_date,
  redemption_count_current_membership,
  redemption_count_all_time,
  sales_effective,
  bb_sales,
  hybrid_sales,
  sheet_membership_expiry
FROM queued
WHERE (
    expiry_date IS NULL
    OR expiry_date <= DATE_ADD(CURRENT_DATE('America/New_York'), INTERVAL 14 DAY)
  )
  AND LOWER(IFNULL(membership_status, '')) != 'frozen'
  AND (
    decision_applied_at IS NULL
    OR (
      LOWER(IFNULL(decision, '')) = 'snooze'
      AND DATE(decision_at, 'America/New_York')
        <= DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 3 MONTH)
    )
    OR (
      LOWER(IFNULL(decision, '')) = 'freeze'
      AND COALESCE(
        freeze_until,
        DATE_ADD(DATE(decision_applied_at, 'America/New_York'), INTERVAL 3 MONTH)
      ) <= CURRENT_DATE('America/New_York')
    )
    OR (
      LOWER(IFNULL(decision, '')) IN ('renew', 'upgrade', 'downgrade')
      AND DATE(membership_start) >= DATE(decision_applied_at, 'America/New_York')
    )
  );
