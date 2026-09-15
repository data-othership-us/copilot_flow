import { config, sleep } from "../config.js";
import {
  copilotDbRef,
  getBigQueryClient,
  getBqConfig,
} from "../lib/bqConfig.js";
import { updateCopilotByEmail } from "../lib/bq/copilotOps.js";
import {
  createCopilotDiscount,
  isDuplicatePromoCodeError,
} from "../lib/Discount/createDiscount.js";
import { buildOfferLink } from "../lib/offerLink.js";
import {
  DISCOUNT_CODES_FROM,
  listTakenPromoCodes,
  lookupDiscountIdByPromoCode,
} from "../lib/onboard/existingPromo.js";
import { basePromoCode, uniquePromoCode } from "../lib/onboard/promoCode.js";
import { normalizePersonName } from "../lib/notion/parseProps.js";

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

function nameSlug(firstName, lastName) {
  const n = normalizePersonName(firstName, lastName);
  return `${slug(n.firstName)}${slug(n.lastName)}`;
}

function nameKeys(firstName, lastName, tier) {
  const name = nameSlug(firstName, lastName);
  if (!name) return [];
  const tiers = ["SEEKER", "WAYFINDER", "LUMINARY"];
  const fromRow = slug(tier);
  if (fromRow && !tiers.includes(fromRow)) tiers.unshift(fromRow);
  return [...new Set([...tiers.map((t) => `${t}${name}`), name])];
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[s.length][t.length];
}

/** Stored code is this person (typo / name slug), not a separate brand voucher. */
function storedCodeBelongsToPerson(stored, foundCode, personSlug) {
  if (!stored) return true;
  if (stored === foundCode) return true;
  if (stored === personSlug) return true;
  if (foundCode && (stored.includes(foundCode) || foundCode.includes(stored))) {
    return true;
  }
  if (foundCode && levenshtein(stored, foundCode) <= 2) return true;
  if (personSlug && levenshtein(stored, personSlug) <= 2) return true;
  return false;
}

function queryOptions(params = {}, types) {
  const { location } = getBqConfig();
  const options = { location, params };
  if (types) options.types = types;
  return options;
}

async function listActiveMissingPromo() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        contact_email,
        first_name,
        last_name,
        region,
        tier,
        promo_code,
        discount_id,
        offer_link,
        ig_handle,
        ig_url
      FROM ${copilotDbRef()}
      WHERE LOWER(IFNULL(status, '')) = 'active'
        AND contact_email IS NOT NULL
        AND TRIM(contact_email) != ''
        AND (
          promo_code IS NULL OR TRIM(promo_code) = ''
          OR discount_id IS NULL OR TRIM(CAST(discount_id AS STRING)) = ''
        )
      ORDER BY last_name, first_name, contact_email
    `,
    ...queryOptions(),
  });
  return rows || [];
}

async function loadDiscountCatalog() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT
        CAST(discount_id AS STRING) AS discount_id,
        attr_name AS name,
        IFNULL(attr_is_active, TRUE) AS is_active,
        UPPER(TRIM(code)) AS promo_code,
        REGEXP_REPLACE(UPPER(IFNULL(attr_name, '')), r'[^A-Z0-9]', '') AS name_slug
      FROM ${DISCOUNT_CODES_FROM}
      WHERE TRIM(IFNULL(code, '')) != ''
    `,
    ...queryOptions(),
  });

  const byCode = new Map();
  const byNameSlug = new Map();
  for (const row of rows || []) {
    const rec = {
      promoCode: row.promo_code,
      discountId: String(row.discount_id || "").trim(),
      name: row.name || "",
      isActive: row.is_active !== false,
    };
    if (rec.promoCode && !byCode.has(rec.promoCode)) byCode.set(rec.promoCode, rec);
    if (row.name_slug) {
      if (!byNameSlug.has(row.name_slug)) byNameSlug.set(row.name_slug, []);
      byNameSlug.get(row.name_slug).push(rec);
    }
  }
  return { byCode, byNameSlug };
}

async function promoOwners() {
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT UPPER(TRIM(promo_code)) AS promo_code, LOWER(contact_email) AS email
      FROM ${copilotDbRef()}
      WHERE promo_code IS NOT NULL AND TRIM(promo_code) != ''
    `,
    ...queryOptions(),
  });
  const map = new Map();
  for (const row of rows || []) {
    const code = row.promo_code;
    if (!map.has(code)) map.set(code, new Set());
    if (row.email) map.get(code).add(row.email);
  }
  return map;
}

function pickNameMatch(row, catalog, owners) {
  const email = emailKey(row.contact_email);
  const keys = nameKeys(row.first_name, row.last_name, row.tier);
  const candidates = [];
  for (const key of keys) {
    for (const rec of catalog.byNameSlug.get(key) || []) {
      candidates.push(rec);
    }
  }
  const seen = new Set();
  for (const rec of candidates) {
    const code = rec.promoCode;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const holder = owners.get(code);
    if (holder && holder.size > 0 && !holder.has(email)) continue;
    return rec;
  }
  return null;
}

async function mintDiscount({ firstName, lastName, code, tier, region }) {
  try {
    const id = String(
      await createCopilotDiscount(firstName || "", lastName || "", code, tier, region)
    ).trim();
    if (!id) throw new Error("Mariana Tek created a discount with no id");
    return id;
  } catch (error) {
    if (!isDuplicatePromoCodeError(error)) throw error;
    const existing = await lookupDiscountIdByPromoCode(code);
    if (existing) return existing;
    throw new Error(
      `${code} already exists in Mariana Tek but is not in stg_mt_discounts yet`
    );
  }
}

export async function backfillPromoCodes() {
  if (!config.bq.projectId) throw new Error("Missing BQ_PROJECT_ID");

  const summary = {
    dryRun: config.dryRun,
    scanned: 0,
    stamped: 0,
    renamed: 0,
    created: 0,
    mintedCode: 0,
    skipped: 0,
    failed: 0,
  };

  console.log("🚀 One-time promo_code / discount_id backfill (active copilots)");
  console.log(`   DRY_RUN=${config.dryRun ? "1" : "0"}`);
  console.log("   Memberships are not assigned");

  const rows = await listActiveMissingPromo();
  summary.scanned = rows.length;
  console.log(`   ${rows.length} active row(s) missing promo_code and/or discount_id`);

  const catalog = await loadDiscountCatalog();
  const owners = await promoOwners();
  const taken = await listTakenPromoCodes();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = String(row.contact_email || "").trim();
    const label =
      [row.first_name, row.last_name].filter(Boolean).join(" ") || email;
    const storedCode = String(row.promo_code || "")
      .trim()
      .toUpperCase();
    const storedId = String(row.discount_id || "").trim();
    const person = nameSlug(row.first_name, row.last_name);
    const tier = row.tier || "Seeker";

    console.log(`\n—— [${i + 1}/${rows.length}] ${label} <${email}> ——`);
    console.log(
      `   stored code=${storedCode || "—"} id=${storedId || "—"} ${row.region || "?"}/${tier}`
    );

    try {
      let promoCode = storedCode;
      let discountId = storedId;
      let action = "stamp";

      if (storedId && catalog.byCode.has(storedCode)) {
        const live = catalog.byCode.get(storedCode);
        if (live.discountId && live.discountId !== storedId) {
          discountId = live.discountId;
        }
      }

      const byStored = storedCode ? catalog.byCode.get(storedCode) : null;
      if (!discountId && byStored) {
        promoCode = byStored.promoCode;
        discountId = byStored.discountId;
        action = "stamp";
      }

      if (!discountId) {
        const named = pickNameMatch(row, catalog, owners);
        if (
          named &&
          storedCodeBelongsToPerson(storedCode, named.promoCode, person)
        ) {
          promoCode = named.promoCode;
          discountId = named.discountId;
          action = storedCode && storedCode !== named.promoCode ? "rename" : "stamp";
          console.log(
            `   ℹ️  matched stg_mt_discounts ${named.promoCode} id=${named.discountId}` +
              (named.name ? ` (${named.name})` : "")
          );
        }
      }

      if (!promoCode) {
        promoCode = uniquePromoCode(
          basePromoCode(row.first_name, row.last_name, email),
          taken,
          {
            igHandle: row.ig_handle || row.ig_url || "",
            email,
          }
        );
        action = "mint";
        summary.mintedCode++;
        console.log(`   🏷️  minted promo_code=${promoCode}`);
      }

      if (!discountId) {
        console.log(
          `   🎟️  create MT ${tier} discount ${promoCode} (${row.region || "region?"})`
        );
        if (!config.dryRun) {
          discountId = await mintDiscount({
            firstName: row.first_name,
            lastName: row.last_name,
            code: promoCode,
            tier,
            region: row.region,
          });
          await sleep(config.requestDelayMs);
        }
        summary.created++;
        if (action !== "mint") action = "create";
      } else if (action === "rename") {
        summary.renamed++;
      } else {
        summary.stamped++;
      }

      taken.add(promoCode);
      if (!owners.has(promoCode)) owners.set(promoCode, new Set());
      owners.get(promoCode).add(emailKey(email));

      const offerLink = buildOfferLink(promoCode);
      if (config.dryRun) {
        console.log(
          `   (DRY_RUN: would set promo_code=${promoCode} discount_id=${discountId || "(create)"} offer_link=${offerLink})`
        );
      } else {
        if (!discountId) {
          throw new Error("resolved promo_code but no discount_id");
        }
        await updateCopilotByEmail(email, {
          promo_code: promoCode,
          discount_id: discountId,
          offer_link: offerLink,
        });
        console.log(
          `   ✅ ${action} promo_code=${promoCode} discount_id=${discountId}`
        );
      }
    } catch (error) {
      summary.failed++;
      console.warn(`   ⚠️  ${error.message}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Promo backfill summary");
  console.log("=".repeat(60));
  console.log(`   Scanned: ${summary.scanned}`);
  console.log(`   Stamped existing id: ${summary.stamped}`);
  console.log(`   Renamed to live MT code: ${summary.renamed}`);
  console.log(`   Created MT voucher: ${summary.created}`);
  console.log(`   Minted a new code: ${summary.mintedCode}`);
  console.log(`   Failed: ${summary.failed}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillPromoCodes()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Promo backfill failed:", error);
      process.exit(1);
    });
}
