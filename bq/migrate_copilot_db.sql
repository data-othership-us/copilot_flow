-- Idempotent migration: add missing columns to live copilots.copilot_db.
-- Replace YOUR_PROJECT with BQ_PROJECT_ID.
-- Single ALTER (batched) to avoid table-update quota.
-- Does NOT drop or rename existing mixed-case columns (BQ is case-insensitive).

ALTER TABLE `YOUR_PROJECT.copilots.copilot_db`
  ADD COLUMN IF NOT EXISTS discount_id STRING,
  ADD COLUMN IF NOT EXISTS percentage FLOAT64,
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS acceptance_emailed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS combined_sales FLOAT64,
  ADD COLUMN IF NOT EXISTS renewal_amt STRING,
  ADD COLUMN IF NOT EXISTS modash STRING,
  ADD COLUMN IF NOT EXISTS in_hub STRING,
  ADD COLUMN IF NOT EXISTS added_to_modash STRING,
  ADD COLUMN IF NOT EXISTS social_media_status STRING,
  ADD COLUMN IF NOT EXISTS monthly_audit STRING,
  ADD COLUMN IF NOT EXISTS google_review STRING,
  ADD COLUMN IF NOT EXISTS resharing_video STRING,
  ADD COLUMN IF NOT EXISTS passes_added STRING,
  ADD COLUMN IF NOT EXISTS monthly_passes STRING,
  ADD COLUMN IF NOT EXISTS guest_passes STRING,
  ADD COLUMN IF NOT EXISTS downgraded STRING,
  ADD COLUMN IF NOT EXISTS previous_membership STRING,
  ADD COLUMN IF NOT EXISTS flag_for_expiration STRING,
  ADD COLUMN IF NOT EXISTS last_update_mbh STRING,
  ADD COLUMN IF NOT EXISTS last_contact STRING,
  ADD COLUMN IF NOT EXISTS last_class_taken STRING,
  ADD COLUMN IF NOT EXISTS classes_taken INT64,
  ADD COLUMN IF NOT EXISTS offer_link STRING,
  ADD COLUMN IF NOT EXISTS status STRING,
  ADD COLUMN IF NOT EXISTS decision STRING,
  ADD COLUMN IF NOT EXISTS decision_notes STRING,
  ADD COLUMN IF NOT EXISTS decision_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS decision_source STRING,
  ADD COLUMN IF NOT EXISTS decision_applied_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS freeze_until DATE,
  ADD COLUMN IF NOT EXISTS never_again BOOL,
  ADD COLUMN IF NOT EXISTS ig_handle STRING,
  ADD COLUMN IF NOT EXISTS ig_url STRING,
  ADD COLUMN IF NOT EXISTS ig_followers INT64,
  ADD COLUMN IF NOT EXISTS tiktok_handle STRING,
  ADD COLUMN IF NOT EXISTS tiktok_followers INT64,
  ADD COLUMN IF NOT EXISTS other_channels JSON;

-- Prefer ensureCopilotDbColumns() which also renames:
--   social_handle → ig_handle, followers → ig_followers

-- Optional backfill: copy MT_BB_HB → combined_sales where empty
-- UPDATE `YOUR_PROJECT.copilots.copilot_db`
-- SET combined_sales = MT_BB_HB
-- WHERE combined_sales IS NULL AND MT_BB_HB IS NOT NULL;
