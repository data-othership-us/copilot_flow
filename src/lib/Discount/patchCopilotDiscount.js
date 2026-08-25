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
