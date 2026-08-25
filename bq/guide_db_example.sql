CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.payroll.to_guides`
(
  full_name STRING, status STRING, bonus_rate FLOAT64, currency STRING,
  first_name STRING, last_name STRING, is_mentor BOOL, is_og_guide BOOL,
  is_class_guide BOOL, mt_id STRING, mt_employee_id STRING, mt_email STRING,
  region STRING, seven_shifts_id STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1iZwra_m0IsGeIQe2pY9vsH9vr5-2GCEycUfmSoHbaCQ'],
  sheet_range = 'TO_Guide!A:N',
  skip_leading_rows = 1
);

CREATE OR REPLACE EXTERNAL TABLE `data-dashboard-463217.payroll.nyc_guides`
(
  full_name STRING, status STRING, bonus_rate FLOAT64, currency STRING,
  first_name STRING, last_name STRING, is_mentor BOOL, is_og_guide BOOL,
  is_class_guide BOOL, mt_id STRING, mt_employee_id STRING, mt_email STRING,
  region STRING, seven_shifts_id STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['https://docs.google.com/spreadsheets/d/1iZwra_m0IsGeIQe2pY9vsH9vr5-2GCEycUfmSoHbaCQ'],
  sheet_range = 'NY_Guide!A:N',
  skip_leading_rows = 1
);

MERGE `data-dashboard-463217.payroll.all_guides` AS target
USING (
  SELECT
    TRIM(full_name) AS full_name, TRIM(status) AS status, bonus_rate,
    TRIM(currency) AS currency, TRIM(first_name) AS first_name,
    TRIM(last_name) AS last_name, is_mentor, is_og_guide, is_class_guide,
    NULLIF(TRIM(mt_id), '') AS mt_id,
    NULLIF(TRIM(mt_employee_id), '') AS mt_employee_id,
    NULLIF(TRIM(mt_email), '') AS mt_email,
    TRIM(region) AS region,
    NULLIF(TRIM(seven_shifts_id), '') AS seven_shifts_id
  FROM `data-dashboard-463217.payroll.to_guides`
  WHERE COALESCE(TRIM(full_name), '') != ''
  UNION ALL
  SELECT
    TRIM(full_name), TRIM(status), bonus_rate, TRIM(currency),
    TRIM(first_name), TRIM(last_name), is_mentor, is_og_guide, is_class_guide,
    NULLIF(TRIM(mt_id), ''), NULLIF(TRIM(mt_employee_id), ''),
    NULLIF(TRIM(mt_email), ''), TRIM(region), NULLIF(TRIM(seven_shifts_id), '')
  FROM `data-dashboard-463217.payroll.nyc_guides`
  WHERE COALESCE(TRIM(full_name), '') != ''
) AS source
ON target.full_name = source.full_name AND target.region = source.region
WHEN MATCHED THEN UPDATE SET
  status = source.status, bonus_rate = source.bonus_rate, currency = source.currency,
  first_name = source.first_name, last_name = source.last_name,
  is_mentor = source.is_mentor, is_og_guide = source.is_og_guide,
  is_class_guide = source.is_class_guide, mt_id = source.mt_id,
  mt_employee_id = source.mt_employee_id, mt_email = source.mt_email,
  seven_shifts_id = source.seven_shifts_id
WHEN NOT MATCHED THEN INSERT VALUES (
  source.full_name, source.status, source.bonus_rate, source.currency,
  source.first_name, source.last_name, source.is_mentor, source.is_og_guide,
  source.is_class_guide, source.mt_id, source.mt_employee_id, source.mt_email,
  source.region, source.seven_shifts_id
);

-- Update a single column in all_guides from the external sheet tables
UPDATE `data-dashboard-463217.payroll.all_guides` AS target
SET target.seven_shifts_id = source.seven_shifts_id
FROM (
  SELECT TRIM(full_name) AS full_name, TRIM(region) AS region,
         NULLIF(TRIM(seven_shifts_id), '') AS seven_shifts_id
  FROM `data-dashboard-463217.payroll.to_guides`
  WHERE COALESCE(TRIM(full_name), '') != ''

  UNION ALL

  SELECT TRIM(full_name), TRIM(region),
         NULLIF(TRIM(seven_shifts_id), '')
  FROM `data-dashboard-463217.payroll.nyc_guides`
  WHERE COALESCE(TRIM(full_name), '') != ''
) AS source
WHERE target.full_name = source.full_name
  AND target.region    = source.region;

