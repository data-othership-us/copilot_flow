-- Split a copilot_db / ops-sheet IG cell into bare lowercase handles.
-- Old sheets sometimes list several accounts in one social_handle cell
-- (`@a, @b`, `a / b`, `a & b`, mixed profile URLs). Empty / placeholders → [].
-- Hyphens stay inside a token so "Re-Submit" is not split into re + submit.
-- Apply via npm run sync-copilot-db (YOUR_PROJECT replaced).

CREATE OR REPLACE FUNCTION `YOUR_PROJECT.copilots.split_ig_handles`(handle STRING)
RETURNS ARRAY<STRING> AS (
  IF(
    REGEXP_CONTAINS(
      LOWER(TRIM(REGEXP_REPLACE(IFNULL(handle, ''), r'\([^)]*\)', ''))),
      r'^@?re-?submit$'
    ),
    ARRAY<STRING>[],
    ARRAY(
      SELECT h
      FROM (
        SELECT
          `YOUR_PROJECT.copilots.normalize_ig_handle`(part) AS h,
          MIN(off) AS min_off
        FROM UNNEST(
          SPLIT(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REGEXP_REPLACE(
                  REGEXP_REPLACE(
                    IFNULL(handle, ''),
                    r'\([^)]*\)',
                    ' '
                  ),
                  r'(?i)(?:https?://)?(?:www\.)?instagram\.com/',
                  ','
                ),
                r'[/?#][^\s,;]*',
                ''
              ),
              r'[^A-Za-z0-9._@-]+',
              ','
            ),
            ','
          )
        ) AS part WITH OFFSET off
        GROUP BY 1
      )
      WHERE h IS NOT NULL
        AND h NOT IN (
          're-submit',
          'resubmit',
          'www',
          'instagram',
          'com',
          'http',
          'https',
          'and',
          'p',
          'reel',
          'reels',
          'stories',
          'explore',
          'accounts',
          'tv',
          'direct',
          'about',
          'legal'
        )
      ORDER BY min_off
    )
  )
);
