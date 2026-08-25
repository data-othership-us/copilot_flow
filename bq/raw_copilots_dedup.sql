-- Deduped sheet union: one row per email.
-- Prefer active over inactive; among actives ORDER BY tier (Seeker < Luminary < Wayfinder).

CREATE OR REPLACE VIEW `YOUR_PROJECT.copilots.raw_copilots_dedup` AS
SELECT * EXCEPT (rn)
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY email
      ORDER BY
        CASE status WHEN 'active' THEN 0 ELSE 1 END,
        tier
    ) AS rn
  FROM `YOUR_PROJECT.copilots.raw_copilots_union`
)
WHERE rn = 1;
