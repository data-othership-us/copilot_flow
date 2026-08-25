-- Modash campaign roster (Creators CSV).
-- Slack bot MERGEs one row per (campaign_name, ig_handle).
--
-- Source file pattern:
--   instagram-campaign-{slug}-creators-{YYYY-MM-DD}_to_{YYYY-MM-DD}.csv
-- Parse window_start / window_end from the filename; campaign_name from the CSV.
-- Keep zero-count creators — those show modash_posts = 0.
--
-- MERGE example:
--   MERGE `YOUR_PROJECT.copilots.modash_creators` T
--   USING source S
--   ON T.campaign_name = S.campaign_name
--      AND `YOUR_PROJECT.copilots.normalize_ig_handle`(T.profile)
--        = `YOUR_PROJECT.copilots.normalize_ig_handle`(S.profile)
--   WHEN MATCHED THEN UPDATE SET ...
--   WHEN NOT MATCHED THEN INSERT ...
--
-- Apply via npm run sync-copilot-db (YOUR_PROJECT replaced).

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.copilots.modash_creators` (
  -- Join keys
  campaign_name STRING NOT NULL,   -- CSV "Campaign name" e.g. NY Co-Pilots Luminary Status
  profile STRING NOT NULL,         -- CSV "Profile" e.g. @lizziemizenko
  ig_handle STRING,                -- normalize_ig_handle(profile); bot may set this
  channel STRING,                  -- INSTAGRAM
  modash_id STRING,                -- CSV "Id"
  email_raw STRING,                -- CSV "Email Address" (comma-separated, may be empty)

  -- Window totals from this export (sanity-check only; score from modash_content)
  followers INT64,
  posts INT64,
  stories INT64,
  reels INT64,
  last_content_at TIMESTAMP,       -- CSV "Last content (ISO 8601)"
  added_to_campaign_at TIMESTAMP,  -- CSV "Added to campaign"
  status STRING,
  labels STRING,
  notes STRING,

  -- Ingest (bot)
  window_start DATE NOT NULL,      -- from filename
  window_end DATE NOT NULL,        -- from filename
  source_filename STRING,
  ingested_at TIMESTAMP NOT NULL
)
CLUSTER BY ig_handle, campaign_name;
