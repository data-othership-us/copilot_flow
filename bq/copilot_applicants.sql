-- Co-Pilot application pipeline state (pre-acceptance).
-- Replace YOUR_PROJECT with BQ_PROJECT_ID, then run in BigQuery console or `bq query`.
--
-- Existing tables: prefer ensureApplicantSchema() (Node) or the ALTERs at the bottom.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.copilots.copilot_applicants` (
  notion_page_id STRING NOT NULL,
  email STRING,
  first_name STRING,
  last_name STRING,
  full_name STRING,
  region STRING,
  phone STRING,
  ig_handle STRING,
  ig_url STRING,
  ig_followers INT64,              -- form-submitted Instagram following
  ig_followers_scraped INT64,      -- Apify / enrichment
  ig_is_public BOOL,
  tiktok_handle STRING,
  tiktok_followers INT64,
  -- Sparse extras: youtube / linkedin / twitter / blog / content_topics / …
  other_channels JSON,
  submitted_at TIMESTAMP,
  application_status STRING,
  previous_application BOOL,
  never_consider BOOL,
  mt_user_id STRING,
  mt_email STRING,
  mt_account_exists BOOL,
  mt_class_count INT64,
  mt_has_cc BOOL,
  mt_home_studio STRING,
  mt_profile_link STRING,
  social_enrichment_error STRING,
  social_enriched_at TIMESTAMP,
  mt_enriched_at TIMESTAMP,
  enriched_at TIMESTAMP,
  promoted_at TIMESTAMP,
  -- TRUE = historical backlog (backfill before go-live). Accepted/Rejected
  -- email+credit+promote only run when FALSE (set by evaluate-applications).
  pre_pipeline BOOL,
  -- TRUE = already Accepted before pipeline go-live; never nudge/promote.
  accepted_before BOOL,
  -- Rejection outreach / thank-you credit (tracked in BQ; Notion stays Status=Rejected)
  rejection_emailed_at TIMESTAMP,
  credit_applied BOOL,
  credit_applied_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
);

-- Migrate live tables that still use the old Instagram column names:
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   RENAME COLUMN IF EXISTS instagram_handle TO ig_handle;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   RENAME COLUMN IF EXISTS instagram_followers_form TO ig_followers;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   RENAME COLUMN IF EXISTS instagram_followers_scraped TO ig_followers_scraped;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   RENAME COLUMN IF EXISTS instagram_is_public TO ig_is_public;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   ADD COLUMN IF NOT EXISTS tiktok_handle STRING;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   ADD COLUMN IF NOT EXISTS tiktok_followers INT64;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   ADD COLUMN IF NOT EXISTS other_channels JSON;
-- ALTER TABLE `YOUR_PROJECT.copilots.copilot_applicants`
--   ADD COLUMN IF NOT EXISTS ig_url STRING;
