-- Expanded union of TO + NY Co-Pilot Google Sheet tabs (external tables).
-- Apply via npm run sync-copilot-db (or BigQuery console with YOUR_PROJECT replaced).
--
-- Dedup (raw_copilots_dedup): prefer status=active over inactive, then ORDER BY tier
--   → lexical Seeker < Luminary < Wayfinder among actives.

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.raw_copilots_union` AS

-- NYC Luminary
SELECT
  'NYC' AS region,
  'Luminary' AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  SAFE_CAST(REGEXP_REPLACE(hybrid, r'[^0-9.\-]', '') AS FLOAT64) AS hybrid,
  SAFE_CAST(REGEXP_REPLACE(bb, r'[^0-9.\-]', '') AS FLOAT64) AS bb_amount,
  SAFE_CAST(REGEXP_REPLACE(bb_facing, r'[^0-9.\-]', '') AS FLOAT64) AS bb_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(mt, r'[^0-9.\-]', '') AS FLOAT64) AS mt_amount,
  SAFE_CAST(REGEXP_REPLACE(mt_facing, r'[^0-9.\-]', '') AS FLOAT64) AS mt_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(combined_sales, r'[^0-9.\-]', '') AS FLOAT64) AS combined_sales,
  membership_expiry AS sheet_membership_expiry,
  social_handle,
  SAFE_CAST(REGEXP_REPLACE(followers, r'[^0-9.\-]', '') AS INT64) AS followers,
  notes,
  CAST(NULL AS STRING) AS renewal_amt,
  modash,
  CAST(NULL AS STRING) AS in_hub,
  CAST(NULL AS STRING) AS added_to_modash,
  social_media AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  monthly_passes,
  guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  last_contact,
  last_class_taken,
  SAFE_CAST(REGEXP_REPLACE(classes_taken, r'[^0-9.\-]', '') AS INT64) AS classes_taken,
  CAST('active' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_nyc_luminary`
WHERE TRIM(COALESCE(email, '')) != ''

UNION ALL

-- NYC Wayfinder
SELECT
  'NYC' AS region,
  'Wayfinder' AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  SAFE_CAST(REGEXP_REPLACE(hybrid, r'[^0-9.\-]', '') AS FLOAT64) AS hybrid,
  CAST(NULL AS FLOAT64) AS bb_amount,
  SAFE_CAST(REGEXP_REPLACE(bb_facing, r'[^0-9.\-]', '') AS FLOAT64) AS bb_facing_amount,
  CAST(NULL AS FLOAT64) AS mt_amount,
  SAFE_CAST(REGEXP_REPLACE(mt_facing, r'[^0-9.\-]', '') AS FLOAT64) AS mt_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(combined_sales, r'[^0-9.\-]', '') AS FLOAT64) AS combined_sales,
  membership_expiry AS sheet_membership_expiry,
  social_handle,
  SAFE_CAST(REGEXP_REPLACE(followers, r'[^0-9.\-]', '') AS INT64) AS followers,
  notes,
  renewed_amt AS renewal_amt,
  modash,
  in_hub,
  CAST(NULL AS STRING) AS added_to_modash,
  social_media AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  CAST(NULL AS STRING) AS monthly_passes,
  CAST(NULL AS STRING) AS guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  CAST(NULL AS STRING) AS last_class_taken,
  CAST(NULL AS INT64) AS classes_taken,
  CAST('active' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_nyc_wayfinder`
WHERE TRIM(COALESCE(email, '')) != ''

UNION ALL

-- NYC Seeker
SELECT
  'NYC' AS region,
  'Seeker' AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  SAFE_CAST(REGEXP_REPLACE(hybrid, r'[^0-9.\-]', '') AS FLOAT64) AS hybrid,
  SAFE_CAST(REGEXP_REPLACE(bb, r'[^0-9.\-]', '') AS FLOAT64) AS bb_amount,
  SAFE_CAST(REGEXP_REPLACE(bb_facing, r'[^0-9.\-]', '') AS FLOAT64) AS bb_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(mt, r'[^0-9.\-]', '') AS FLOAT64) AS mt_amount,
  SAFE_CAST(REGEXP_REPLACE(mt_facing, r'[^0-9.\-]', '') AS FLOAT64) AS mt_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(combined_sales, r'[^0-9.\-]', '') AS FLOAT64) AS combined_sales,
  membership_expiry AS sheet_membership_expiry,
  social_handle,
  SAFE_CAST(REGEXP_REPLACE(followers, r'[^0-9.\-]', '') AS INT64) AS followers,
  CAST(NULL AS STRING) AS notes,
  COALESCE(NULLIF(TRIM(renewed_amt), ''), renewal_amt_july) AS renewal_amt,
  modash_cp AS modash,
  in_hub,
  added_to_modash,
  social_media AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  monthly_passes,
  CAST(NULL AS STRING) AS guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  previous_membership,
  flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  CAST(NULL AS STRING) AS last_class_taken,
  CAST(NULL AS INT64) AS classes_taken,
  CAST('active' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_nyc_seeker`
WHERE TRIM(COALESCE(email, '')) != ''

UNION ALL

-- TO Luminary
SELECT
  'TO' AS region,
  'Luminary' AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  SAFE_CAST(REGEXP_REPLACE(hybrid, r'[^0-9.\-]', '') AS FLOAT64) AS hybrid,
  SAFE_CAST(REGEXP_REPLACE(bb, r'[^0-9.\-]', '') AS FLOAT64) AS bb_amount,
  SAFE_CAST(REGEXP_REPLACE(bb_facing, r'[^0-9.\-]', '') AS FLOAT64) AS bb_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(mt, r'[^0-9.\-]', '') AS FLOAT64) AS mt_amount,
  SAFE_CAST(REGEXP_REPLACE(mt_facing, r'[^0-9.\-]', '') AS FLOAT64) AS mt_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(combined_sales, r'[^0-9.\-]', '') AS FLOAT64) AS combined_sales,
  membership_expiry AS sheet_membership_expiry,
  social_handle,
  SAFE_CAST(REGEXP_REPLACE(followers, r'[^0-9.\-]', '') AS INT64) AS followers,
  CAST(NULL AS STRING) AS notes,
  CAST(NULL AS STRING) AS renewal_amt,
  CAST(NULL AS STRING) AS modash,
  CAST(NULL AS STRING) AS in_hub,
  CAST(NULL AS STRING) AS added_to_modash,
  social_media AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  google_review,
  resharing_video,
  passes_added,
  monthly_passes,
  guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  last_class_taken,
  SAFE_CAST(REGEXP_REPLACE(classes_taken, r'[^0-9.\-]', '') AS INT64) AS classes_taken,
  CAST('active' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_to_luminary`
WHERE TRIM(COALESCE(email, '')) != ''

UNION ALL

-- TO Wayfinder
SELECT
  'TO' AS region,
  'Wayfinder' AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  SAFE_CAST(REGEXP_REPLACE(hybrid, r'[^0-9.\-]', '') AS FLOAT64) AS hybrid,
  SAFE_CAST(REGEXP_REPLACE(bb, r'[^0-9.\-]', '') AS FLOAT64) AS bb_amount,
  SAFE_CAST(REGEXP_REPLACE(bb_facing, r'[^0-9.\-]', '') AS FLOAT64) AS bb_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(mt, r'[^0-9.\-]', '') AS FLOAT64) AS mt_amount,
  SAFE_CAST(REGEXP_REPLACE(mt_facing, r'[^0-9.\-]', '') AS FLOAT64) AS mt_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(combined_sales, r'[^0-9.\-]', '') AS FLOAT64) AS combined_sales,
  expiration_date AS sheet_membership_expiry,
  social_handle,
  SAFE_CAST(REGEXP_REPLACE(followers, r'[^0-9.\-]', '') AS INT64) AS followers,
  notes,
  renewed_amt AS renewal_amt,
  modash,
  in_hub,
  CAST(NULL AS STRING) AS added_to_modash,
  social_media AS social_media_status,
  monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  CAST(NULL AS STRING) AS monthly_passes,
  CAST(NULL AS STRING) AS guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  CAST(NULL AS STRING) AS last_class_taken,
  CAST(NULL AS INT64) AS classes_taken,
  CAST('active' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_to_wayfinder`
WHERE TRIM(COALESCE(email, '')) != ''

UNION ALL

-- TO Seeker
SELECT
  'TO' AS region,
  'Seeker' AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  SAFE_CAST(REGEXP_REPLACE(hybrid, r'[^0-9.\-]', '') AS FLOAT64) AS hybrid,
  SAFE_CAST(REGEXP_REPLACE(bb, r'[^0-9.\-]', '') AS FLOAT64) AS bb_amount,
  SAFE_CAST(REGEXP_REPLACE(bb_facing, r'[^0-9.\-]', '') AS FLOAT64) AS bb_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(mt, r'[^0-9.\-]', '') AS FLOAT64) AS mt_amount,
  SAFE_CAST(REGEXP_REPLACE(mt_facing, r'[^0-9.\-]', '') AS FLOAT64) AS mt_facing_amount,
  SAFE_CAST(REGEXP_REPLACE(combined_sales, r'[^0-9.\-]', '') AS FLOAT64) AS combined_sales,
  actual_expiration AS sheet_membership_expiry,
  social_handle,
  SAFE_CAST(REGEXP_REPLACE(followers, r'[^0-9.\-]', '') AS INT64) AS followers,
  notes,
  renewal_amt,
  modash_cp AS modash,
  in_hub,
  added_to_modash,
  social_media AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  CAST(NULL AS STRING) AS monthly_passes,
  CAST(NULL AS STRING) AS guest_passes,
  downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  CAST(NULL AS STRING) AS last_class_taken,
  CAST(NULL AS INT64) AS classes_taken,
  CAST('active' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_to_seeker`
WHERE TRIM(COALESCE(email, '')) != ''

UNION ALL

-- NYC Inactive
SELECT
  'NYC' AS region,
  CAST(NULL AS STRING) AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  CAST(NULL AS FLOAT64) AS hybrid,
  CAST(NULL AS FLOAT64) AS bb_amount,
  CAST(NULL AS FLOAT64) AS bb_facing_amount,
  CAST(NULL AS FLOAT64) AS mt_amount,
  CAST(NULL AS FLOAT64) AS mt_facing_amount,
  CAST(NULL AS FLOAT64) AS combined_sales,
  CAST(NULL AS STRING) AS sheet_membership_expiry,
  social_handle,
  CAST(NULL AS INT64) AS followers,
  notes,
  CAST(NULL AS STRING) AS renewal_amt,
  CAST(NULL AS STRING) AS modash,
  CAST(NULL AS STRING) AS in_hub,
  CAST(NULL AS STRING) AS added_to_modash,
  CAST(NULL AS STRING) AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  CAST(NULL AS STRING) AS monthly_passes,
  CAST(NULL AS STRING) AS guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  CAST(NULL AS STRING) AS last_class_taken,
  CAST(NULL AS INT64) AS classes_taken,
  CAST('inactive' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_nyc_inactive`
-- Require a real email (skips month section headers + any remaining shifted junk).
WHERE REGEXP_CONTAINS(TRIM(COALESCE(email, '')), r'@')

UNION ALL

-- TO Inactive
SELECT
  'TO' AS region,
  CAST(NULL AS STRING) AS tier,
  first_name,
  last_name,
  LOWER(TRIM(email)) AS email,
  brandbot_link,
  promo_code,
  CAST(NULL AS FLOAT64) AS hybrid,
  CAST(NULL AS FLOAT64) AS bb_amount,
  CAST(NULL AS FLOAT64) AS bb_facing_amount,
  CAST(NULL AS FLOAT64) AS mt_amount,
  CAST(NULL AS FLOAT64) AS mt_facing_amount,
  CAST(NULL AS FLOAT64) AS combined_sales,
  CAST(NULL AS STRING) AS sheet_membership_expiry,
  social_handle,
  CAST(NULL AS INT64) AS followers,
  notes,
  CAST(NULL AS STRING) AS renewal_amt,
  CAST(NULL AS STRING) AS modash,
  CAST(NULL AS STRING) AS in_hub,
  CAST(NULL AS STRING) AS added_to_modash,
  CAST(NULL AS STRING) AS social_media_status,
  CAST(NULL AS STRING) AS monthly_audit,
  CAST(NULL AS STRING) AS google_review,
  CAST(NULL AS STRING) AS resharing_video,
  CAST(NULL AS STRING) AS passes_added,
  CAST(NULL AS STRING) AS monthly_passes,
  CAST(NULL AS STRING) AS guest_passes,
  CAST(NULL AS STRING) AS downgraded,
  CAST(NULL AS STRING) AS previous_membership,
  CAST(NULL AS STRING) AS flag_for_expiration,
  CAST(NULL AS STRING) AS last_update_mbh,
  CAST(NULL AS STRING) AS last_contact,
  CAST(NULL AS STRING) AS last_class_taken,
  CAST(NULL AS INT64) AS classes_taken,
  CAST('inactive' AS STRING) AS status
FROM `YOUR_PROJECT.copilots.raw_to_inactive`
WHERE REGEXP_CONTAINS(TRIM(COALESCE(email, '')), r'@');
