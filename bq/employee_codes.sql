-- Staff promo codes from the Toronto and New York team sheets.
-- Apply in data-dashboard-463217 (Drive scope required).
--
-- Role tabs are the source. "Entire Team - Active" / "Whole team - Active"
-- and the TEST tabs are left out so inactive codes still match redemptions
-- and nobody is listed twice.
-- Column order follows each tab. Headers have trailing spaces; names below
-- are the tab titles exactly.

-- ---------------------------------------------------------------------------
-- Toronto  https://docs.google.com/spreadsheets/d/1qKHNg64MbPDCTz8RvVYnga5bSKiJd6xXMVn1zmzWx-8
-- Guides has no Location column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_to_team_guides`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING,
  ny_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1qKHNg64MbPDCTz8RvVYnga5bSKiJd6xXMVn1zmzWx-8'],
  sheet_range = 'Guides!A:H',
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_to_team_stewards`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  location STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1qKHNg64MbPDCTz8RvVYnga5bSKiJd6xXMVn1zmzWx-8'],
  sheet_range = 'Stewards!A:H',
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_to_team_deckhands`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  location STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1qKHNg64MbPDCTz8RvVYnga5bSKiJd6xXMVn1zmzWx-8'],
  sheet_range = 'Deckhands!A:H',
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_to_team_leadership`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  location STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1qKHNg64MbPDCTz8RvVYnga5bSKiJd6xXMVn1zmzWx-8'],
  sheet_range = 'Leadership!A:H',
  skip_leading_rows = 1
);

-- ---------------------------------------------------------------------------
-- New York  https://docs.google.com/spreadsheets/d/1Nrz-CEhf_1FS8CEqLKrQ5XNLMl1GXxc3la_bAPtnqkE
-- Tab titles Guides / Stewards / Deckhands have a trailing space.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_nyc_team_guides`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1Nrz-CEhf_1FS8CEqLKrQ5XNLMl1GXxc3la_bAPtnqkE'],
  sheet_range = "'Guides '!A:G",
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_nyc_team_stewards`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1Nrz-CEhf_1FS8CEqLKrQ5XNLMl1GXxc3la_bAPtnqkE'],
  sheet_range = "'Stewards '!A:G",
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_nyc_team_deckhands`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1Nrz-CEhf_1FS8CEqLKrQ5XNLMl1GXxc3la_bAPtnqkE'],
  sheet_range = "'Deckhands '!A:G",
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.copilots.raw_nyc_team_leadership`
(
  status STRING,
  first_name STRING,
  last_name STRING,
  email STRING,
  promo_code STRING,
  bb_link STRING,
  bb_first_timer_link STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1Nrz-CEhf_1FS8CEqLKrQ5XNLMl1GXxc3la_bAPtnqkE'],
  sheet_range = 'Leadership!A:G',
  skip_leading_rows = 1
);

-- One row per staff promo code. Active wins when the same code is on two tabs.
CREATE OR REPLACE VIEW `data-dashboard-463217.copilots.employee_codes` AS
WITH unioned AS (
  SELECT
    'TO' AS region,
    'guide' AS role,
    status,
    first_name,
    last_name,
    email,
    CAST(NULL AS STRING) AS location,
    promo_code,
    bb_link
  FROM `data-dashboard-463217.copilots.raw_to_team_guides`
  UNION ALL
  SELECT 'TO', 'steward', status, first_name, last_name, email, location, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_to_team_stewards`
  UNION ALL
  SELECT 'TO', 'deckhand', status, first_name, last_name, email, location, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_to_team_deckhands`
  UNION ALL
  SELECT 'TO', 'leadership', status, first_name, last_name, email, location, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_to_team_leadership`
  UNION ALL
  SELECT 'NYC', 'guide', status, first_name, last_name, email, NULL, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_nyc_team_guides`
  UNION ALL
  SELECT 'NYC', 'steward', status, first_name, last_name, email, NULL, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_nyc_team_stewards`
  UNION ALL
  SELECT 'NYC', 'deckhand', status, first_name, last_name, email, NULL, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_nyc_team_deckhands`
  UNION ALL
  SELECT 'NYC', 'leadership', status, first_name, last_name, email, NULL, promo_code, bb_link
  FROM `data-dashboard-463217.copilots.raw_nyc_team_leadership`
),
cleaned AS (
  SELECT
    region,
    role,
    TRIM(status) AS status,
    TRIM(first_name) AS first_name,
    TRIM(last_name) AS last_name,
    LOWER(TRIM(email)) AS email,
    NULLIF(TRIM(location), '') AS location,
    NULLIF(UPPER(TRIM(promo_code)), '') AS promo_code,
    NULLIF(TRIM(bb_link), '') AS bb_link
  FROM unioned
  WHERE NULLIF(UPPER(TRIM(promo_code)), '') IS NOT NULL
)
SELECT * EXCEPT (rn) FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY promo_code
      ORDER BY
        CASE WHEN LOWER(status) = 'active' THEN 0 ELSE 1 END,
        region,
        role,
        email
    ) AS rn
  FROM cleaned
)
WHERE rn = 1;
