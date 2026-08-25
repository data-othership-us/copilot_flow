-- Modash campaign content (Content CSV). Grain: one row per post/story/reel.
-- Slack bot MERGEs on content_key. Append across overlapping exports; do not truncate.
--
-- Source file pattern:
--   campaign-{slug}-content-{YYYY-MM-DD}_to_{YYYY-MM-DD}.csv
-- Captions contain newlines — parse as real CSV, never paste into Sheets.
--
-- content_key: query param postPreview from "Preview link", else "Link to post".
-- Prefix with campaign_name if the same post can appear in two campaigns.
--
-- MERGE example:
--   MERGE `YOUR_PROJECT.copilots.modash_content` T
--   USING source S
--   ON T.content_key = S.content_key
--   WHEN MATCHED THEN UPDATE SET ...
--   WHEN NOT MATCHED THEN INSERT ...
--
-- Apply via npm run sync-copilot-db (YOUR_PROJECT replaced).

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.copilots.modash_content` (
  content_key STRING NOT NULL,     -- campaign_name + '|' + postPreview (or post URL)
  campaign_name STRING NOT NULL,   -- CSV "Campaign name"
  channel STRING,                  -- INSTAGRAM
  influencer STRING NOT NULL,      -- CSV "Influencer" e.g. @jkmckay
  ig_handle STRING,                -- normalize_ig_handle(influencer); bot may set this
  content_type STRING NOT NULL,    -- story | reel | carousel (lowercase)
  posted_at TIMESTAMP NOT NULL,    -- CSV "Posting date (ISO 8601)"
  link_to_post STRING,             -- empty for most stories
  preview_link STRING,
  caption STRING,
  hashtags STRING,                 -- comma-separated
  mentions STRING,                 -- comma-separated, no @
  likes INT64,
  comments INT64,
  views INT64,
  impressions INT64,
  reach INT64,

  -- Ingest (bot)
  window_start DATE NOT NULL,      -- from filename
  window_end DATE NOT NULL,
  source_filename STRING,
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(posted_at)
CLUSTER BY ig_handle, campaign_name;
