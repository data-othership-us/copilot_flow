-- Normalize Instagram handles for Modash ↔ copilot_db joins.
-- Strips @, instagram.com URLs, and path/query. Empty → NULL.
-- Apply via npm run sync-copilot-db (YOUR_PROJECT replaced).

CREATE OR REPLACE FUNCTION `YOUR_PROJECT.copilots.normalize_ig_handle`(handle STRING)
RETURNS STRING AS (
  NULLIF(
    LOWER(TRIM(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            IFNULL(handle, ''),
            r'(?i)^https?://(www\.)?instagram\.com/',
            ''
          ),
          r'^@+',
          ''
        ),
        r'[/?#].*$',
        ''
      )
    )),
    ''
  )
);
