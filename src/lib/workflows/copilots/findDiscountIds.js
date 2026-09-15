import dotenv from "dotenv";
import { copilotDbRef, getBigQueryClient, getBqConfig } from "../../bqConfig.js";
import { OFFER_LINK_PREFIX } from "../../offerLink.js";
import {
  DISCOUNT_CODES_FROM,
  DISCOUNT_CODES_REF,
} from "../../onboard/existingPromo.js";

dotenv.config();

const bigquery = getBigQueryClient();
const COPILOT_DB = copilotDbRef();
const { location } = getBqConfig();

/**
 * Look up existing MT discount ids from `stg_mt.stg_mt_discounts`
 * (does NOT create discounts — that's onboarding-only via create-discounts).
 *
 * Writes:
 *   - discount_id for rows with promo_code match
 *   - offer_link = https://othership.us/copilot/intro-offer?id={promo_code}
 */
export async function findDiscountIds({ dryRun = false } = {}) {
  console.log("🚀 find-discount-ids");
  console.log(`   DRY_RUN=${dryRun ? 1 : 0}`);
  console.log(`   Source: ${DISCOUNT_CODES_REF} (lookup only — no MT create)`);

  const previewQuery = `
    WITH discount_by_code AS (
      SELECT
        UPPER(TRIM(code)) AS promo_key,
        ANY_VALUE(CAST(discount_id AS STRING)) AS discount_id
      FROM ${DISCOUNT_CODES_FROM}
      WHERE code IS NOT NULL AND TRIM(code) != ''
      GROUP BY 1
    )
    SELECT
      COUNTIF(c.promo_code IS NOT NULL AND TRIM(c.promo_code) != '') AS with_promo,
      COUNTIF(
        (c.discount_id IS NULL OR c.discount_id = '')
        AND d.discount_id IS NOT NULL
      ) AS would_set_discount_id,
      COUNTIF(
        c.promo_code IS NOT NULL AND TRIM(c.promo_code) != ''
        AND (c.offer_link IS NULL OR c.offer_link = ''
             OR c.offer_link != CONCAT('${OFFER_LINK_PREFIX}', TRIM(c.promo_code)))
      ) AS would_set_offer_link,
      COUNTIF(
        c.promo_code IS NOT NULL AND TRIM(c.promo_code) != ''
        AND (c.discount_id IS NULL OR c.discount_id = '')
        AND d.discount_id IS NULL
      ) AS promo_unmatched
    FROM ${COPILOT_DB} c
    LEFT JOIN discount_by_code d
      ON UPPER(TRIM(c.promo_code)) = d.promo_key
  `;

  const [preview] = await bigquery.query({ query: previewQuery, location });
  console.log("—— Preview ——");
  console.log(`   with promo_code:        ${preview[0].with_promo}`);
  console.log(`   would set discount_id:  ${preview[0].would_set_discount_id}`);
  console.log(`   would set offer_link:   ${preview[0].would_set_offer_link}`);
  console.log(`   promo unmatched in BQ:  ${preview[0].promo_unmatched}`);

  if (dryRun) {
    console.log("   (DRY_RUN — no writes)");
    return preview[0];
  }

  const updateQuery = `
    UPDATE ${COPILOT_DB} AS c
    SET
      discount_id = COALESCE(
        NULLIF(TRIM(c.discount_id), ''),
        d.discount_id
      ),
      offer_link = IF(
        c.promo_code IS NOT NULL AND TRIM(c.promo_code) != '',
        CONCAT('${OFFER_LINK_PREFIX}', TRIM(c.promo_code)),
        c.offer_link
      )
    FROM (
      SELECT
        UPPER(TRIM(code)) AS promo_key,
        ANY_VALUE(CAST(discount_id AS STRING)) AS discount_id
      FROM ${DISCOUNT_CODES_FROM}
      WHERE code IS NOT NULL AND TRIM(code) != ''
      GROUP BY 1
    ) AS d
    WHERE c.promo_code IS NOT NULL
      AND TRIM(c.promo_code) != ''
      AND UPPER(TRIM(c.promo_code)) = d.promo_key
      AND (
        c.discount_id IS NULL OR c.discount_id = ''
        OR c.offer_link IS NULL OR c.offer_link = ''
        OR c.offer_link != CONCAT('${OFFER_LINK_PREFIX}', TRIM(c.promo_code))
      )
  `;

  console.log("—— UPDATE matched promo → discount_id / offer_link ——");
  const [matchedJob] = await bigquery.createQueryJob({
    query: updateQuery,
    location,
  });
  await matchedJob.getQueryResults();
  const matchedMeta = matchedJob.metadata?.statistics?.query;
  console.log(
    `   ✅ Matched update done (affected: ${matchedMeta?.numDmlAffectedRows ?? "?"})`
  );

  // Offer links for promos not yet in stg_mt_discounts (still no create).
  const offerOnlyQuery = `
    UPDATE ${COPILOT_DB}
    SET offer_link = CONCAT('${OFFER_LINK_PREFIX}', TRIM(promo_code))
    WHERE promo_code IS NOT NULL
      AND TRIM(promo_code) != ''
      AND (
        offer_link IS NULL OR offer_link = ''
        OR offer_link != CONCAT('${OFFER_LINK_PREFIX}', TRIM(promo_code))
      )
  `;

  console.log("—— UPDATE remaining offer_link from promo_code ——");
  const [offerJob] = await bigquery.createQueryJob({
    query: offerOnlyQuery,
    location,
  });
  await offerJob.getQueryResults();
  const offerMeta = offerJob.metadata?.statistics?.query;
  console.log(
    `   ✅ Offer-link update done (affected: ${offerMeta?.numDmlAffectedRows ?? "?"})`
  );

  return preview[0];
}
