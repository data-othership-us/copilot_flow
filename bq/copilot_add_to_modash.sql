-- Active copilots whose Instagram handle is not on the Modash Creators roster.
-- Grain: one row per contact_email with a non-empty handle.
--
-- Match is handle-only (normalize_ig_handle), same as copilot_performance.
-- Email matches on email_raw do not hide a missing handle — that person
-- still needs adding under the roster IG.
--
-- Used by evaluate-copilots to rebuild the "Add to Modash" sheet tab.
-- Apply via npm run sync-copilot-db (YOUR_PROJECT replaced).

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.copilot_add_to_modash` AS
WITH roster AS (
  SELECT DISTINCT
    COALESCE(
      `YOUR_PROJECT.copilots.normalize_ig_handle`(c.ig_handle),
      `YOUR_PROJECT.copilots.normalize_ig_handle`(c.profile)
    ) AS ig_handle
  FROM `YOUR_PROJECT.copilots.modash_creators` AS c
)
SELECT
  p.contact_email,
  p.first_name,
  p.last_name,
  p.region,
  p.tier,
  p.ig_handle,
  p.ig_url,
  p.ig_followers,
  p.membership_status,
  p.membership_name,
  p.membership_end
FROM `YOUR_PROJECT.copilots.copilot_performance` AS p
LEFT JOIN roster AS r
  ON r.ig_handle = `YOUR_PROJECT.copilots.normalize_ig_handle`(p.ig_handle)
WHERE `YOUR_PROJECT.copilots.normalize_ig_handle`(p.ig_handle) IS NOT NULL
  AND r.ig_handle IS NULL;
