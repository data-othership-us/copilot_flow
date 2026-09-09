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

//-------------------------------- Create Discount --------------------------------
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
  }));
  return turf;
}

/**
 * @param {string} first_name
 * @param {string} last_name
 * @param {string} code
 * @param {string} tier
 * @param {string|null} [region] TO | NYC — selects products + turf
 */
export async function createCopilotDiscount(
  first_name,
  last_name,
  code,
  tier,
  region = null
) {
  if (!code || !tier) {
    throw new Error("Code and tier are required");
  }

  if (!first_name && !last_name) {
    throw new Error("First name or last name is required");
  }

  // Normalize and validate tier
  const normalizedTier = tier.toLowerCase();
  if (!(normalizedTier in TIER_BENEFITS)) {
    throw new Error(
      `Invalid tier: ${tier}. Valid tiers are: ${Object.keys(TIER_BENEFITS).join(", ")}`
    );
  }
  const benefit_value = TIER_BENEFITS[normalizedTier];

  // Build discount payload
  const discountPayload = {
    data: {
      type: "discounts",
      attributes: {
        name: formatDiscountName(normalizedTier, first_name, last_name),
        start_datetime: new Date().toISOString(),
        end_datetime: null,
        codes: [code.toUpperCase()],
        benefit_type: "Percentage",
        benefit_proxy_class: "oscar.apps.offer.benefits.PercentageDiscountBenefit",
        benefit_value: `${benefit_value}`,
        benefit_currency: null,
        max_global_applications: null,
        max_user_applications: 1,
        benefit_includes_all_products: false,
        offer_type: "Voucher",
        benefit_excluded_products: [],
        benefit_included_product_classes: [],
        benefit_included_products: productsForRegion(region),
        condition_includes_all_memberships: false,
        condition_membership_contracts: [],
        is_active: true,
        user_segment_type: "everyone",
        condition_user_tag: null,
        turf: turfForRegion(region),
      },
    },
  };

  try {
    const response = await axios.post(`${MT_API_BASE_URL}/discounts`, discountPayload, {
      headers: API_HEADERS,
    });

    return response.data?.data?.id;
  } catch (error) {
    const errorMessage = error.response
      ? `API Error: ${error.response.status} ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`Failed to create discount for ${code}:`, errorMessage);
    throw error;
  }
}

/** True when Mariana Tek rejected the voucher because the code is already in use. */
export function isDuplicatePromoCodeError(error) {
  const status = error?.response?.status;
  if (status && ![400, 409, 422].includes(status)) return false;
  const blob = JSON.stringify(error?.response?.data ?? error.message ?? "").toLowerCase();
  if (!blob) return false;
  return (
    /(already|exist|unique|taken|duplicate|in use)/.test(blob) &&
    /code/.test(blob)
  );
}

//-----Testing the createCopilotDiscount function-----
// createCopilotDiscount("Kathryn", "Doe", "KATHRYNSAUSER", "Seeker")
//   .then((id) => {
//     console.log(`✅ Discount created successfully. ID: ${id}`);
//   })
//   .catch((err) => {
//     console.error("❌ Failed to create discount:", err.message || err);
//   });