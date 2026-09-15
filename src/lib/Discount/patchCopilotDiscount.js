import axios from "axios";
import {
  TIER_BENEFITS,
  MT_API_BASE_URL,
  API_HEADERS,
  TURF_CONFIG_WITH_REGIONS,
} from "../coPilotConstants.js";
import {
  formatDiscountName,
  getNYCProductsForAPI,
  getTorontoProductsForAPI,
} from "./discountProductHelpers.js";
import { isNycRegion } from "../copilotIdentity.js";
import {
  findExistingCopilotPromo,
  lookupDiscountIdByPromoCode,
} from "../onboard/existingPromo.js";

function productsForRegion(region) {
  return isNycRegion(region)
    ? getNYCProductsForAPI()
    : getTorontoProductsForAPI();
}

function turfForRegion(region) {
  const nyc = isNycRegion(region);
  const turf = JSON.parse(JSON.stringify(TURF_CONFIG_WITH_REGIONS));
  turf.regions = (turf.regions || []).map((r) => ({
    ...r,
    enabled: nyc ? r.name === "NYC" : r.name === "Toronto",
    locations: (r.locations || []).map((loc) => ({
      ...loc,
      enabled: nyc ? r.name === "NYC" : r.name === "Toronto",
    })),
  }));
  return turf;
}

/**
 * Update an existing MT discount to a new tier % / name / regional products.
 */
export async function patchCopilotDiscount({
  discountId,
  promoCode,
  tier,
  region,
  firstName,
  lastName,
}) {
  if (!discountId) throw new Error("discountId is required");
  const normalizedTier = String(tier || "").toLowerCase();
  if (!(normalizedTier in TIER_BENEFITS)) {
    throw new Error(`Invalid tier: ${tier}`);
  }
  const benefitValue = TIER_BENEFITS[normalizedTier];

  const payload = {
    data: {
      id: String(discountId),
      type: "discounts",
      attributes: {
        name: formatDiscountName(normalizedTier, firstName, lastName),
        benefit_type: "Percentage",
        benefit_value: Number(benefitValue),
        codes: [String(promoCode).toUpperCase()],
        benefit_includes_all_products: false,
        benefit_included_products: productsForRegion(region),
        turf: turfForRegion(region),
        user_segment_type: "everyone",
      },
    },
  };

  const response = await axios.patch(
    `${MT_API_BASE_URL}/discounts/${discountId}`,
    payload,
    { headers: API_HEADERS }
  );
  return response.data;
}

async function resolveDiscountId({
  discountId,
  promoCode,
  firstName,
  lastName,
  email,
  tier,
}) {
  const fromRow = String(discountId || "").trim();
  if (fromRow) return fromRow;
  try {
    const byCode = await lookupDiscountIdByPromoCode(promoCode);
    if (byCode) return byCode;
  } catch (error) {
    console.warn(`   ⚠️  stg_mt_discounts lookup failed: ${error.message}`);
  }
  try {
    const existing = await findExistingCopilotPromo({
      firstName,
      lastName,
      email,
      promoCode,
      discountId,
      tier,
    });
    return String(existing?.discountId || "").trim();
  } catch (error) {
    console.warn(`   ⚠️  existing promo lookup failed: ${error.message}`);
    return "";
  }
}

const DISCOUNT_PATCH_OMIT = new Set([
  "user_has_all_locations",
  "user_has_any_locations",
]);

function writableDiscountAttributes(attributes) {
  const out = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (DISCOUNT_PATCH_OMIT.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function voucherIsLive(attributes) {
  if (attributes?.is_active === false) return false;
  const end = attributes?.end_datetime;
  if (end && !Number.isNaN(new Date(end).getTime()) && new Date(end).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

function discountPatchError(discountId, error, action = "patch") {
  const detail = error?.response?.data ?? error.message;
  const wrapped = new Error(
    `${action} discount ${discountId} failed: ${JSON.stringify(detail)}`
  );
  wrapped.status = error?.response?.status;
  return wrapped;
}

/**
 * Turn off a Co-Pilot voucher in Mariana Tek.
 * `is_active` is derived from the voucher window, so we expire it
 * (`end_datetime` = now). Promo code / offer_link stay on copilot_db.
 */
export async function deactivateCopilotDiscount({
  discountId,
  promoCode,
  firstName,
  lastName,
  email,
  tier,
}) {
  const id = await resolveDiscountId({
    discountId,
    promoCode,
    firstName,
    lastName,
    email,
    tier,
  });
  if (!id) {
    return { skipped: "no_discount_id" };
  }

  let current;
  try {
    const response = await axios.get(
      `${MT_API_BASE_URL}/discounts/${id}`,
      { headers: API_HEADERS }
    );
    current = response.data?.data?.attributes || {};
  } catch (error) {
    throw discountPatchError(id, error, "deactivate");
  }

  if (current.is_active === false) {
    return { discountId: id, skipped: "already_inactive" };
  }

  const attributes = writableDiscountAttributes(current);
  attributes.is_active = false;
  attributes.end_datetime = new Date().toISOString();

  try {
    await axios.patch(
      `${MT_API_BASE_URL}/discounts/${id}`,
      {
        data: {
          id: String(id),
          type: "discounts",
          attributes,
        },
      },
      { headers: API_HEADERS }
    );
  } catch (error) {
    throw discountPatchError(id, error, "deactivate");
  }

  return { discountId: id };
}

/**
 * Reopen an expired / inactive Co-Pilot voucher (returning copilot).
 * Clears `end_datetime` and sets `is_active` so the existing promo works again.
 */
export async function activateCopilotDiscount({
  discountId,
  promoCode,
  firstName,
  lastName,
  email,
  tier,
  dryRun = false,
}) {
  const id = await resolveDiscountId({
    discountId,
    promoCode,
    firstName,
    lastName,
    email,
    tier,
  });
  if (!id) {
    return { skipped: "no_discount_id" };
  }

  let current;
  try {
    const response = await axios.get(
      `${MT_API_BASE_URL}/discounts/${id}`,
      { headers: API_HEADERS }
    );
    current = response.data?.data?.attributes || {};
  } catch (error) {
    throw discountPatchError(id, error, "activate");
  }

  if (voucherIsLive(current)) {
    return { discountId: id, skipped: "already_active" };
  }

  if (dryRun) {
    return { discountId: id, dryRun: true };
  }

  const attributes = writableDiscountAttributes(current);
  attributes.is_active = true;
  attributes.end_datetime = null;

  try {
    await axios.patch(
      `${MT_API_BASE_URL}/discounts/${id}`,
      {
        data: {
          id: String(id),
          type: "discounts",
          attributes,
        },
      },
      { headers: API_HEADERS }
    );
  } catch (error) {
    throw discountPatchError(id, error, "activate");
  }

  return { discountId: id };
}
