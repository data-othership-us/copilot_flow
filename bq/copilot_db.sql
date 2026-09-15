-- Co-Pilot dimension table (post-acceptance / ops tracker).
-- Replace YOUR_PROJECT with BQ_PROJECT_ID, then run in BigQuery console or `bq query`.
--
-- Live table may already exist with mixed-case sheet-era names (First_Name, Promo_Code, …).
-- BigQuery resolves column names case-insensitively; prefer snake_case going forward.
-- For existing tables, run bq/migrate_copilot_db.sql instead of CREATE.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.copilots.copilot_db` (
  -- A. Identity / provisioning
  contact_email STRING,
  first_name STRING,
  last_name STRING,
  region STRING,              -- TO | NYC
  tier STRING,                -- Seeker | Wayfinder | Luminary
  user_id STRING,             -- Mariana Tek user id (system-owned)
  mt_email STRING,
  mt_profile_link STRING,
  promo_code STRING,
  bb_link STRING,             -- Brandbot / offer link
  ig_handle STRING,           -- Instagram @handle(s); several accounts are newline-separated
  ig_url STRING,              -- clickable profile URL(s); newline-separated when several
  ig_followers INT64,
  tiktok_handle STRING,      -- from application promote / applicant backfill
  tiktok_followers INT64,
  other_channels JSON,       -- youtube / linkedin / twitter / blog / …
  discount_id STRING,         -- MT discount id (system-owned)
  -- percentage FLOAT64 — legacy; unused (join stg_mt_discounts if needed)
  offer_link STRING,          -- New special-offer URL (system-owned)
  status STRING,              -- active | inactive (ops sheet tabs)
  decision STRING,            -- onboard | renew | offboard | never again | upgrade | downgrade | snooze | freeze | update | social
  decision_notes STRING,
  decision_at TIMESTAMP,
  decision_source STRING,     -- e.g. evaluation_sheet | manual
  decision_applied_at TIMESTAMP,
  payment_nudge_at TIMESTAMP,   -- last payment-method nudge for a held Review decision
  freeze_until DATE,
  never_again BOOL,           -- sticky: do not accept if they re-apply
  promoted_at TIMESTAMP,      -- When promoted from applicants / first seen
  onboarded_at TIMESTAMP,     -- Discount + membership complete (management job)
  acceptance_emailed_at TIMESTAMP,
  updated_at TIMESTAMP,

  -- B. Membership expiry from ops sheet only (live membership via performance view join)
  sheet_membership_expiry STRING,

  -- C. Sales (sheet-owned; performance view also has join overlays)
  bb_sales FLOAT64,
  bb_facing_amount FLOAT64,
  mt_sales FLOAT64,
  mt_facing_amount FLOAT64,
  hybrid_sales FLOAT64,
  new_hybrid_sales FLOAT64,   -- Review-tab ops input (evaluation-owned)
  combined_sales FLOAT64,     -- was MT_BB_HB on live table
  recovered_sales FLOAT64,

  -- Legacy session columns (unused by sync; use copilot_performance)
  last_session TIMESTAMP,
  total_sessions INT64,
  last_class_taken STRING,
  classes_taken INT64,

  -- D. Ops / tracking (sheet-owned)
  renewal_amt STRING,
  modash STRING,
  in_hub STRING,
  added_to_modash STRING,
  social_media_status STRING,
  monthly_audit STRING,
  google_review STRING,
  resharing_video STRING,
  passes_added STRING,
  monthly_passes STRING,
  guest_passes STRING,
  downgraded STRING,
  previous_membership STRING,
  flag_for_expiration STRING,
  last_update_mbh STRING,
  last_contact STRING,
  notes STRING
);

-- Column ownership:
--   Sheet-owned (ops sync may UPDATE): identity display fields, bb_link,
--     ig_handle (@handle, newline-separated when several), sales, sheet_membership_expiry, section D ops, notes, status.
--     NOT synced: classes_*, tiktok_*, other_channels, ig_followers
--     (ig_followers is onboard seed only; live count is Modash on copilot_performance).
--     ig_url is rebuilt from every parsed sheet handle; kept when the sheet cell is empty.
--     After MERGE, copilot_db emails that are not already inactive and are
--     missing from every active tab (including blank status) are set inactive.
--   System-owned (never overwrite from ops sheet): user_id, mt_email, mt_profile_link,
--     discount_id, promo_code, offer_link,
--     promoted_at, onboarded_at, acceptance_emailed_at, tiktok_*, other_channels.
--   Evaluation-owned (evaluation Sheet → DB; never ops sync): decision,
--     decision_notes, decision_at, decision_source, decision_applied_at, freeze_until,
--     never_again, new_hybrid_sales, payment_nudge_at.
--   Computed (copilot_performance view): membership (instances join), home_studio
--     (mt_users home_location), classes, promo redemptions, Modash posting
--     (modash_content / modash_creators; not written to this table).
