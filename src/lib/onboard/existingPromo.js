import { copilotDbRef, getBigQueryClient, getBqConfig } from "../bqConfig.js";
import { normalizePersonName } from "../notion/parseProps.js";
import { basePromoCode } from "./promoCode.js";

/** Live MT discounts from the data-pipeline staging table. Codes are JSON. */
export const DISCOUNT_CODES_REF =
  "`data-pipeline-492715.stg_mt.stg_mt_discounts`";

/** FROM clause: one row per remaining voucher code. */
export const DISCOUNT_CODES_FROM = `${DISCOUNT_CODES_REF},
        UNNEST(JSON_VALUE_ARRAY(attr_codes)) AS code`;

function slug(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

function emailKey(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function discountNameKeys(firstName, lastName, tier) {
  const n = normalizePersonName(firstName, lastName);
  const name = `${slug(n.firstName)}${slug(n.lastName)}`;
  if (!name) return [];
  const tiers = ["SEEKER", "WAYFINDER", "LUMINARY"];
  const fromRow = slug(tier);
  if (fromRow && !tiers.includes(fromRow)) tiers.unshift(fromRow);
  return [...new Set([...tiers.map((t) => `${t}${name}`), name])];
}

function asPromo(row) {
  if (!row) return null;
  return {
    promoCode: String(row.promo_code || "").trim(),
    discountId: String(row.discount_id || "").trim(),
    name: row.name || "",
    isActive: row.is_active !== false,
    source: "stg_mt_discounts",
  };
}

/**
 * Match Co-Pilot vouchers in `stg_mt.stg_mt_discounts` by exact code, discount id,
 * or "Seeker First Last" / FIRSTNAMELASTNAME name slug. Includes inactive
 * (offboarded) vouchers so we can reactivate on re-onboard.
 */
async function lookupDiscountCodes({ code, discountId, nameKeys }) {
  const codeUpper = String(code || "")
    .trim()
    .toUpperCase();
  const id = String(discountId || "").trim();
  const keys = (nameKeys || []).filter(Boolean);
  if (!codeUpper && !id && !keys.length) return [];

  const { location } = getBqConfig();
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        CAST(discount_id AS STRING) AS discount_id,
        attr_name AS name,
        IFNULL(attr_is_active, TRUE) AS is_active,
        UPPER(TRIM(code)) AS promo_code,
        CASE
          WHEN @code != '' AND UPPER(TRIM(code)) = @code THEN 0
          WHEN @discount_id != '' AND CAST(discount_id AS STRING) = @discount_id THEN 1
          ELSE 2
        END AS rank_score
      FROM ${DISCOUNT_CODES_FROM}
      WHERE TRIM(IFNULL(code, '')) != ''
        AND (
          (@code != '' AND UPPER(TRIM(code)) = @code)
          OR (@discount_id != '' AND CAST(discount_id AS STRING) = @discount_id)
          OR (
            ARRAY_LENGTH(@name_keys) > 0
            AND REGEXP_REPLACE(UPPER(IFNULL(attr_name, '')), r'[^A-Z0-9]', '')
              IN UNNEST(@name_keys)
          )
        )
      ORDER BY rank_score, IFNULL(attr_is_active, TRUE) DESC, SAFE_CAST(discount_id AS INT64) DESC
      LIMIT 20
    `,
    location,
    params: { code: codeUpper, discount_id: id, name_keys: keys },
    types: { code: "STRING", discount_id: "STRING", name_keys: ["STRING"] },
  });
  return rows || [];
}

async function promoOwnersByCode(codes) {
  const unique = [
    ...new Set(
      (codes || [])
        .map((c) =>
          String(c || "")
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    ),
  ];
  if (!unique.length) return new Map();

  const { location } = getBqConfig();
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT UPPER(TRIM(promo_code)) AS promo_code, LOWER(contact_email) AS email
      FROM ${copilotDbRef()}
      WHERE promo_code IS NOT NULL AND TRIM(promo_code) != ''
        AND UPPER(TRIM(promo_code)) IN UNNEST(@codes)
    `,
    location,
    params: { codes: unique },
    types: { codes: ["STRING"] },
  });

  const map = new Map();
  for (const row of rows || []) {
    const code = row.promo_code;
    if (!map.has(code)) map.set(code, new Set());
    if (row.email) map.get(code).add(row.email);
  }
  return map;
}

function ownerKind(code, email, ownerMap) {
  const owners = ownerMap.get(String(code || "").toUpperCase());
  if (!owners || owners.size === 0) return "unowned";
  if (email && owners.has(emailKey(email))) return "self";
  return "other";
}

/**
 * Discount id for a promo code, including inactive vouchers (offboard deactivate).
 */
export async function lookupDiscountIdByPromoCode(promoCode) {
  const codeUpper = String(promoCode || "")
    .trim()
    .toUpperCase();
  if (!codeUpper) return "";

  const { location } = getBqConfig();
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT CAST(discount_id AS STRING) AS discount_id
      FROM ${DISCOUNT_CODES_FROM}
      WHERE UPPER(TRIM(code)) = @code
      ORDER BY IFNULL(attr_is_active, TRUE) DESC, SAFE_CAST(discount_id AS INT64) DESC
      LIMIT 1
    `,
    location,
    params: { code: codeUpper },
  });
  return String(rows?.[0]?.discount_id || "").trim();
}

/**
 * Codes already used on copilot_db or in the MT stg_mt_discounts sync
 * (active and inactive — expired vouchers still occupy the code in MT).
 */
export async function listTakenPromoCodes() {
  const { location } = getBqConfig();
  const bigquery = getBigQueryClient();
  try {
    const [rows] = await bigquery.query({
      query: `
      SELECT promo_code FROM (
        SELECT UPPER(TRIM(promo_code)) AS promo_code
        FROM ${copilotDbRef()}
        WHERE promo_code IS NOT NULL AND TRIM(promo_code) != ''
        UNION DISTINCT
        SELECT UPPER(TRIM(code)) AS promo_code
        FROM ${DISCOUNT_CODES_FROM}
        WHERE TRIM(IFNULL(code, '')) != ''
      )
    `,
      location,
    });
    return new Set((rows || []).map((r) => r.promo_code).filter(Boolean));
  } catch (error) {
    console.warn(
      `   ⚠️  taken promo lookup (stg_mt_discounts) failed: ${error.message}`
    );
    const [rows] = await bigquery.query({
      query: `
        SELECT UPPER(TRIM(promo_code)) AS promo_code
        FROM ${copilotDbRef()}
        WHERE promo_code IS NOT NULL AND TRIM(promo_code) != ''
      `,
      location,
    });
    return new Set((rows || []).map((r) => r.promo_code).filter(Boolean));
  }
}

/**
 * Resolve this person's Co-Pilot promo.
 *
 * - Code / discount_id already on their copilot_db row is always theirs,
 *   including an inactive voucher from offboard (reactivate, don't mint).
 * - Name / FIRSTNAMELASTNAME match is only reused when it is not already
 *   assigned to a different copilot. Unowned *active* codes are treated as
 *   a manual onboard of this person. Unowned inactive codes are left alone.
 *
 * @returns {Promise<{ promoCode: string, discountId: string, name: string, source: string, isActive: boolean | null } | null>}
 */
export async function findExistingCopilotPromo({
  firstName,
  lastName,
  email,
  promoCode,
  discountId,
  tier,
} = {}) {
  const fromRow = String(promoCode || "")
    .trim()
    .toUpperCase();
  const fromId = discountId ? String(discountId).trim() : "";
  const expected = fromRow ? "" : basePromoCode(firstName, lastName, email);
  const keys = fromRow || fromId ? [] : discountNameKeys(firstName, lastName, tier);

  let candidates = [];
  try {
    candidates = await lookupDiscountCodes({
      code: fromRow || expected,
      discountId: fromId,
      nameKeys: keys,
    });
  } catch (error) {
    console.warn(`   ⚠️  stg_mt_discounts lookup failed: ${error.message}`);
  }

  if (fromRow || fromId) {
    const matchByCode =
      candidates.find(
        (c) => fromRow && String(c.promo_code || "").toUpperCase() === fromRow
      ) || null;
    const matchById =
      candidates.find(
        (c) => fromId && String(c.discount_id || "").trim() === fromId
      ) || null;
    const match = matchByCode || matchById || null;
    // Prefer the current MT string when our stored code is no longer on the voucher.
    const resolvedCode = String(
      (matchByCode ? fromRow : match?.promo_code) || fromRow || ""
    ).trim();
    const resolvedId = fromId || String(match?.discount_id || "").trim();
    if (!resolvedCode && !resolvedId) return null;
    return {
      promoCode: resolvedCode,
      discountId: resolvedId,
      name: match?.name || "",
      isActive: match ? match.is_active !== false : null,
      source: fromRow ? "copilot_db" : "stg_mt_discounts",
    };
  }

  const owners = await promoOwnersByCode(candidates.map((c) => c.promo_code));
  let skippedOther = "";
  for (const row of candidates) {
    const kind = ownerKind(row.promo_code, email, owners);
    if (kind === "other") {
      skippedOther = row.promo_code;
      continue;
    }
    if (kind === "self") return asPromo(row);
  }
  for (const row of candidates) {
    if (ownerKind(row.promo_code, email, owners) !== "unowned") continue;
    if (row.is_active === false) continue;
    return asPromo(row);
  }

  if (skippedOther) {
    console.log(
      `   ℹ️  ${skippedOther} belongs to another copilot — will mint a unique code`
    );
  }
  return null;
}
