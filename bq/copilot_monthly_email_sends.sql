-- One row per copilot contact email per monthly newsletter month.
-- The monthly job skips these addresses on a later run for the same month.
-- Replace YOUR_PROJECT with BQ_PROJECT_ID. The job also creates this table if missing.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.copilots.copilot_monthly_email_sends` (
  contact_email STRING NOT NULL,
  month_key STRING NOT NULL,       -- YYYY-MM
  sent_at TIMESTAMP NOT NULL,
  message_id STRING,
  region STRING,                   -- NYC | TO
  to_email STRING                  -- address Gmail accepted
);
