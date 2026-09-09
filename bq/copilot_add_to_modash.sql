-- Active copilots whose Instagram handle is not on the Modash Creators roster.
-- Grain: one row per missing handle (never two handles in ig_handle).
-- Copy the ig_handle column into a Modash campaign — one @handle per row.
-- Placeholders (re-submit) are dropped; they are not real usernames.
--
-- Each handle is matched on its own (split_ig_handles). A copilot with
-- @a and @b on the roster is tracked for both; only a handle that is
-- actually missing is listed.
--
-- Used by evaluate-copilots to rebuild the "Add to Modash" sheet tab.
-- Apply via npm run sync-copilot-db (YOUR_PROJECT replaced).

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_add_to_modash` AS
WITH roster AS (
  SELECT DISTINCT
    COALESCE(
      `YOUR_PROJECT.copilots.normalize_ig_handle`(c.ig_handle),
      `YOUR_PROJECT.copilots.normalize_ig_handle`(c.profile)
    ) AS roster_handle
  FROM `YOUR_PROJECT.copilots.modash_creators` AS c
),
handles AS (
  SELECT
    c.contact_email,
    p.first_name,
    p.last_name,
    p.region,
    p.tier,
    h AS handle,
    p.ig_followers,
    p.membership_status,
    p.membership_name,
    p.membership_end
  FROM `YOUR_PROJECT.copilots.copilot_db` AS c
  JOIN `YOUR_PROJECT.copilots.copilot_performance` AS p
    ON LOWER(p.contact_email) = LOWER(c.contact_email)
  CROSS JOIN UNNEST(
    `YOUR_PROJECT.copilots.split_ig_handles`(
      CONCAT(IFNULL(c.ig_handle, ''), ' ', IFNULL(c.ig_url, ''))
    )
  ) AS h
  WHERE LOWER(IFNULL(c.status, '')) = 'active'
    AND h IS NOT NULL
)
SELECT
  x.contact_email,
  x.first_name,
  x.last_name,
  x.region,
  x.tier,
  CONCAT('@', x.handle) AS ig_handle,
  CONCAT('https://www.instagram.com/', x.handle, '/') AS ig_url,
  x.ig_followers,
  x.membership_status,
  x.membership_name,
  x.membership_end
FROM handles AS x
LEFT JOIN roster AS r
  ON r.roster_handle = x.handle
WHERE r.roster_handle IS NULL
;
