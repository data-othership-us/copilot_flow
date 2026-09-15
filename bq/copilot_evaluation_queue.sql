-- Co-Pilots who need Christine's onboard / renew / offboard / never again /
-- upgrade / downgrade / snooze / freeze review.
-- Active roster only (program status=active). Inactive copilots stay on
-- copilot_performance but are excluded from Review.
--
-- Included when:
--   1. There is an MT user_id and a Co-Pilot membership (name matches
--      co-pilot) whose performance-view days_to_expiry is within 7 days
--      or already expired (days_to_expiry <= 7). Missing end dates are
--      excluded. Frozen memberships stay off this path.
--   2. Or the IG handle / URL contains the ops placeholder "re-submit" /
--      "resubmit" (they stay until the handle is a real username).
--   3. Or there is no Mariana Tek user_id (MT account not found).
--   4. Or there is no live Co-Pilot membership (no Co-Pilot-named instance
--      in active / pending / payment_failure — includes gym-only, ended,
--      cancelled, frozen, or missing). They stay until a live Co-Pilot
--      term exists or ops marks them inactive.
-- membership_end / days_to_expiry come from copilot_performance (MT
-- calculated_end_at / scheduled_end_at / end_date / cancelled_at).
--
-- After a decision is applied, stay out of Review until:
--   - snooze: 3 months after decision_at
--   - freeze: freeze_until (or applied + 3 months), and not currently frozen
--   - update / social: no hide; they return immediately if still in the 7-day / re-submit / no-MT window
--   - onboard / renew / upgrade / downgrade: a new membership_start is on/after
--     decision_applied_at AND that term is again in the 7-day window
--   - offboard / never again: status=inactive; still on copilot_performance,
--     but excluded from this queue
-- Re-submit / no-MT / no-live-membership rows skip those applied-term gates
-- so they stay on Review until the handle is real, they get a user_id, they
-- have a live Co-Pilot term, or ops marks them inactive.
-- membership_start / membership_end / days_to_expiry are from copilot_performance.
-- Change the `days_to_expiry <= 7` filter below to change the window, then:
--   npm run sync-copilot-db

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_evaluation_queue` AS
WITH queued AS (
  SELECT
    p.contact_email,
    p.first_name,
    p.last_name,
    p.region,
    p.tier,
    p.user_id,
    p.mt_email,
    p.membership_status,
    p.promo_code_status,
    p.promo_code,
    p.ig_handle,
    p.ig_url,
    p.ig_followers,
    p.membership_name,
    p.membership_start,
    p.membership_end,
    p.days_to_expiry,
    p.months_since_membership_start,
    p.copilot_months_active,
    p.social_playgrounds_attended,
    p.last_social_playground,
    p.modash_impressions,
    p.modash_stories_current_membership,
    p.modash_feed_posts_current_membership,
    p.social_requirement_met,
    p.classes_taken_current_membership,
    p.last_class_date,
    p.redemption_count_current_membership,
    p.redemption_count AS redemption_count_all_time,
    p.redemption_subtotal_usd_current_membership AS redemption_usd_current_membership,
    p.redemption_subtotal_cad_current_membership AS redemption_cad_current_membership,
    p.redemption_subtotal_usd AS redemption_usd_all_time,
    p.redemption_subtotal_cad AS redemption_cad_all_time,
    p.redemption_count_since_membership_end,
    p.cycle_points,
    p.sheet_bb_sales AS bb_sales,
    p.sheet_hybrid_sales AS hybrid_sales,
    p.new_hybrid_sales,
    p.sheet_membership_expiry,
    p.decision,
    p.decision_at,
    p.decision_applied_at,
    p.freeze_until
  FROM `YOUR_PROJECT.copilots.copilot_performance` AS p
  WHERE LOWER(IFNULL(p.status, '')) = 'active'
),
flagged AS (
  SELECT
    *,
    (
      user_id IS NULL
      OR TRIM(CAST(user_id AS STRING)) = ''
    ) AS no_mt_account,
    REGEXP_CONTAINS(
      LOWER(CONCAT(IFNULL(ig_handle, ''), ' ', IFNULL(ig_url, ''))),
      r're-?submit'
    ) AS ig_resubmit,
    NOT (
      REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\s-]?pilot')
      AND LOWER(IFNULL(membership_status, '')) IN (
        'active', 'pending', 'payment_failure'
      )
    ) AS no_live_copilot
  FROM queued
)
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
  membership_name,
  membership_start,
  membership_end,
  months_since_membership_start,
  copilot_months_active,
  days_to_expiry,
  social_playgrounds_attended,
  last_social_playground,
  modash_impressions,
  modash_stories_current_membership,
  modash_feed_posts_current_membership,
  social_requirement_met,
  classes_taken_current_membership,
  last_class_date,
  redemption_count_current_membership,
  redemption_usd_current_membership,
  redemption_cad_current_membership,
  cycle_points,
  redemption_count_all_time,
  redemption_usd_all_time,
  redemption_cad_all_time,
  redemption_count_since_membership_end,
  bb_sales,
  hybrid_sales,
  new_hybrid_sales,
  sheet_membership_expiry
FROM flagged
WHERE (
    (
      REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\s-]?pilot')
      AND NOT no_mt_account
      AND days_to_expiry <= 7
      AND LOWER(IFNULL(membership_status, '')) != 'frozen'
    )
    OR ig_resubmit
    OR no_mt_account
    OR no_live_copilot
  )
  AND NOT (
    LOWER(IFNULL(decision, '')) = 'snooze'
    AND decision_applied_at IS NOT NULL
    AND DATE(decision_at, 'America/New_York')
      > DATE_SUB(CURRENT_DATE('America/New_York'), INTERVAL 3 MONTH)
  )
  AND NOT (
    LOWER(IFNULL(decision, '')) = 'freeze'
    AND decision_applied_at IS NOT NULL
    AND COALESCE(
      freeze_until,
      DATE_ADD(DATE(decision_applied_at, 'America/New_York'), INTERVAL 3 MONTH)
    ) > CURRENT_DATE('America/New_York')
  )
  AND (
    ig_resubmit
    OR no_mt_account
    OR no_live_copilot
    OR decision_applied_at IS NULL
    OR LOWER(IFNULL(decision, '')) IN ('snooze', 'freeze', 'update', 'social')
    OR (
      LOWER(IFNULL(decision, '')) IN ('onboard', 'renew', 'upgrade', 'downgrade')
      AND DATE(membership_start) >= DATE(decision_applied_at, 'America/New_York')
    )
  );
