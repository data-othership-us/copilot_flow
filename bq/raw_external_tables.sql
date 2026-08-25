-- Google Sheets → BigQuery external tables for Co-Pilot trackers.
-- Apply in BigQuery console (project data-dashboard-463217) or via the Node runner.
--
-- Pattern matches bq/guide_db_example.sql.
-- Existing active-tier tables (raw_to_*/raw_nyc_* Seeker|Wayfinder|Luminary) already
-- live in BQ; this file adds the Inactive tabs.

-- ---------------------------------------------------------------------------
-- TO Inactive  (sheet tab title is "Inactive " with a trailing space)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_to_inactive`
(
  first_name STRING,
  last_name STRING,
  email STRING,
  brandbot_link STRING,
  promo_code STRING,
  social_handle STRING,
  notes STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1WAFw_A-z8yHZp9qGrp_R7HwKXGNKS106SHMq5Q9em8I'],
  sheet_range = "'Inactive '!A:G",
  skip_leading_rows = 1
);

-- ---------------------------------------------------------------------------
-- NY Inactive
-- ---------------------------------------------------------------------------
CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_nyc_inactive`
(
  first_name STRING,
  last_name STRING,
  email STRING,
  brandbot_link STRING,
  promo_code STRING,
  social_handle STRING,
  notes STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/12b7Pv89ds-f6XwSEU9z8s44VG1hVM4C1XiMU3W3SWnQ'],
  sheet_range = 'Inactive!A:G',
  skip_leading_rows = 1
);

-- Smoke checks (optional):
-- SELECT COUNT(*) FROM `data-dashboard-463217.copilots.raw_to_inactive`;
-- SELECT COUNT(*) FROM `data-dashboard-463217.copilots.raw_nyc_inactive`;
-- SELECT * FROM `data-dashboard-463217.copilots.raw_to_inactive` LIMIT 5;
-- SELECT * FROM `data-dashboard-463217.copilots.raw_nyc_inactive` LIMIT 5;
