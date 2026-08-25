import axios from "axios";
import dotenv from "dotenv";
import { createCopilotDiscount } from "./createDiscount.js";
import {
  TIER_BENEFITS,
  MT_API_BASE_URL,
  API_HEADERS,
  TURF_CONFIG,
} from "../coPilotConstants.js";
import productsData from "./discountProducts.json" assert { type: "json" };
import {
  getNYCProductsForAPI,
  getTorontoProductsForAPI,
} from "./discountProductHelpers.js";
import { copilotDbRef, getBigQueryClient } from "../bqConfig.js";

dotenv.config();

const bigquery = getBigQueryClient();
const COPILOT_DB = copilotDbRef();

//-------------------------------- Helper Functions --------------------------------

/**
 * Determine region from existing products or discount name
 */
function determineRegionFromProductsOrName(discountData) {
  const attributes = discountData?.attributes;
  const name = attributes?.name || "";
  const existingProducts = attributes?.benefit_included_products || [];
  
  // Get Toronto and NYC product IDs
  const torontoProductIds = productsData.toronto.map(p => p.id);
  const nycProductIds = productsData.nyc.map(p => p.id);
  
  // Check existing products to determine region
  let torontoProductCount = 0;
  let nycProductCount = 0;
  
  for (const product of existingProducts) {
    const productId = String(product.id);
    if (torontoProductIds.includes(productId)) {
      torontoProductCount++;
    } else if (nycProductIds.includes(productId)) {
      nycProductCount++;
    }
  }
  
  // If products indicate a region, use that
  if (nycProductCount > 0 && torontoProductCount === 0) {
    return "nyc";
  } else if (torontoProductCount > 0 && nycProductCount === 0) {
    return "toronto";
  }
  
  // Otherwise, check discount name for region indicators
  const nameUpper = name.toUpperCase();
  if (nameUpper.includes("NY") || nameUpper.includes("NEW YORK") || nameUpper.includes("NYC")) {
    return "nyc";
  } else if (nameUpper.includes("TORONTO") || nameUpper.includes("TO")) {
    return "toronto";
  }
  
  // Default to Toronto if can't determine
  return "toronto";
}

/**
 * Fetch existing discount to determine which regions are enabled
 * Returns an object with torontoEnabled, nycEnabled flags, and the full turf config
 */
async function getDiscountRegions(discountId) {
  try {
    const response = await axios.get(
      `${MT_API_BASE_URL}/discounts/${discountId}`,
      {
        headers: API_HEADERS,
      }
    );

    const discountData = response.data?.data;
    const turf = discountData?.attributes?.turf;
    
    if (!turf || !turf.regions) {
      // Default to both if we can't determine
      return {
        torontoEnabled: true,
        nycEnabled: true,
        turf: {
          global_turf: {
            enabled: true,
            can_assign: true,
          },
        },
        discountData,
      };
    }

    const regions = turf.regions;
    const torontoEnabled = regions.some(
      (region) => region.name === "Toronto" && region.enabled === true
    );
    const nycEnabled = regions.some(
      (region) => region.name === "NYC" && region.enabled === true
    );

    return { torontoEnabled, nycEnabled, turf, discountData };
  } catch (error) {
    console.error(
      `Error fetching discount ${discountId} to determine regions:`,
      error.message
    );
    // Default to both if we can't fetch
    return {
      torontoEnabled: true,
      nycEnabled: true,
      turf: {
        global_turf: {
          enabled: true,
          can_assign: true,
        },
      },
      discountData: null,
    };
  }
}

/**
 * Query BigQuery for all rows with promo_code and tier (with or without discount_id)
 */
async function getAllRowsWithDiscountId() {
  console.log(
    `📊 Querying BigQuery for rows with promo_code and tier from ${COPILOT_DB}...`
  );

  try {
    const query = `
      SELECT discount_id, promo_code, tier, region, first_name, last_name
      FROM ${COPILOT_DB}
      WHERE promo_code IS NOT NULL 
      AND promo_code != ''
      AND tier IS NOT NULL
      AND tier != ''
    `;
    const [rows] = await bigquery.query({ query });

    console.log(
      `✅ Found ${rows.length} rows with promo_code and tier to process`
    );
    return rows;
  } catch (error) {
    console.error(`❌ Error querying BigQuery:`, error.message);
    throw error;
  }
}

/**
 * Update BigQuery row with discount_id
 */
async function updateDiscountInfo(promoCode, discountId, percentage) {
  try {
    // Escape single quotes
    const escapedCode = promoCode.replace(/'/g, "''");
    const escapedDiscountId = String(discountId).replace(/'/g, "''");

    const updateQuery = `
      UPDATE ${COPILOT_DB}
      SET discount_id = '${escapedDiscountId}'
      WHERE promo_code = '${escapedCode}'
    `;

    await bigquery.query({ query: updateQuery });
    console.log(`   💾 Updated BigQuery with discount_id: ${discountId}`);
  } catch (error) {
    console.error(
      `   ❌ Error updating BigQuery with discount_id:`,
      error.message
    );
    throw error;
  }
}

/**
 * Get promo code from an existing discount
 */
async function getDiscountPromoCode(discountId) {
  try {
    const response = await axios.get(
      `${MT_API_BASE_URL}/discounts/${discountId}`,
      {
        headers: API_HEADERS,
      }
    );

    const codes = response.data?.data?.attributes?.codes;
    if (!codes || codes.length === 0) {
      throw new Error(`No promo codes found for discount ${discountId}`);
    }

    return codes[0]; // Return the first promo code
  } catch (error) {
    const errorMessage = error.response
      ? `API Error: ${error.response.status} ${JSON.stringify(
          error.response.data
        )}`
      : error.message;
    console.error(`Error fetching discount ${discountId}:`, errorMessage);
    throw error;
  }
}

/**
 * Update discount benefit_value using PATCH
 */
async function patchDiscount(discountId, newPercentage, promoCode, regionFromTable = null) {
  try {
    // Fetch existing discount to preserve turf config
    const { turf } = await getDiscountRegions(discountId);
    
    // Get products based on region from table - separate by region
    // Toronto discounts get Toronto products, NYC discounts get NYC products
    let products = [];
    let updatedTurf = turf; // Will modify if needed
    
    // Normalize region from table (case-insensitive)
    const normalizedRegion = regionFromTable ? regionFromTable.toLowerCase().trim() : null;
    const isNYC = normalizedRegion === "nyc" || normalizedRegion === "new york" || normalizedRegion === "ny";
    const isToronto = normalizedRegion === "toronto" || normalizedRegion === "to";
    
    // If turf doesn't have regions, create proper structure from TURF_CONFIG
    if (!updatedTurf || !updatedTurf.regions) {
      updatedTurf = {
        global_turf: TURF_CONFIG.global_turf,
        regions: JSON.parse(JSON.stringify(TURF_CONFIG.regions)), // Deep copy
      };
    }
    
    if (isNYC) {
      // NYC region from table - use NYC products only
      products = getNYCProductsForAPI();
      console.log(`   📦 Region from table: NYC - Using NYC products (${products.length} products)`);
      
      // Update turf to only have NYC enabled
      updatedTurf = {
        ...updatedTurf,
        regions: updatedTurf.regions.map((region) => {
          if (region.name === "NYC") {
            return { ...region, enabled: true };
          } else if (region.name === "Toronto") {
            return { ...region, enabled: false };
          }
          return region;
        }),
      };
    } else if (isToronto) {
      // Toronto region from table - use Toronto products only
      products = getTorontoProductsForAPI();
      console.log(`   📦 Region from table: Toronto - Using Toronto products (${products.length} products)`);
      
      // Update turf to only have Toronto enabled
      updatedTurf = {
        ...updatedTurf,
        regions: updatedTurf.regions.map((region) => {
          if (region.name === "Toronto") {
            return { ...region, enabled: true };
          } else if (region.name === "NYC") {
            return { ...region, enabled: false };
          }
          return region;
        }),
      };
    } else {
      // No region specified or unknown - default to Toronto
      products = getTorontoProductsForAPI();
      console.log(`   ⚠️ No valid region in table (got: "${regionFromTable}"), defaulting to Toronto products (${products.length} products)`);
      
      // Update turf to only have Toronto enabled
      updatedTurf = {
        ...updatedTurf,
        regions: updatedTurf.regions.map((region) => {
          if (region.name === "Toronto") {
            return { ...region, enabled: true };
          } else if (region.name === "NYC") {
            return { ...region, enabled: false };
          }
          return region;
        }),
      };
    }
    
    const patchPayload = {
      data: {
        id: discountId,
        type: "discounts",
        attributes: {
          benefit_type: "Percentage",
          benefit_value: Number(newPercentage),
          codes: [promoCode.toUpperCase()],
          benefit_includes_all_products: false,
          benefit_included_products: products,
          turf: updatedTurf, // Use updated turf configuration
          user_segment_type: "everyone",
        },
      },
    };

    const patchResponse = await axios.patch(
      `${MT_API_BASE_URL}/discounts/${discountId}`,
      patchPayload,
      {
        headers: API_HEADERS,
      }
    );

    if (patchResponse.status !== 200) {
      throw new Error(`PATCH failed: ${patchResponse.status}`);
    }

    return patchResponse.data;
  } catch (error) {
    const errorMessage = error.response
      ? `API Error: ${error.response.status} ${JSON.stringify(
          error.response.data
        )}`
      : error.message;
    console.error(`Error patching discount ${discountId}:`, errorMessage);
    throw error;
  }
}

//-------------------------------- Main Function --------------------------------
export async function updateDiscounts() {
  console.log("🚀 Starting discount update process...");

  const results = {
    success: [],
    failed: [],
    created: [],
    updated: [],
  };

  try {
    // 1. Get all rows from BigQuery
    const rows = await getAllRowsWithDiscountId();

    if (rows.length === 0) {
      console.log("⚠️ No rows found with promo_code and tier");
      return results;
    }

    // 2. Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const discountId = row.discount_id;
      const promoCode = row.promo_code;
      const tier = row.tier;
      const region = row.region || null; // Get region from table
      const firstName = row.first_name || "";
      const lastName = row.last_name || "";

      console.log(
        `\n[${i + 1}/${rows.length}] Processing: ${promoCode} (Tier: ${tier}${region ? `, Region: ${region}` : ''})`
      );

      try {
        // 3. Validate tier
        const normalizedTier = tier.toLowerCase();
        if (!(normalizedTier in TIER_BENEFITS)) {
          console.log(`   ⚠️ No discount mapping found for tier: ${tier}`);
          results.failed.push({
            promoCode,
            tier,
            error: `No discount mapping for tier: ${tier}. Valid tiers are: ${Object.keys(
              TIER_BENEFITS
            ).join(", ")}`,
          });
          continue;
        }
        const benefitPercentage = TIER_BENEFITS[normalizedTier];
        console.log(
          `   📊 Matched tier "${tier}" to discount: ${benefitPercentage}%`
        );

        // 4. Check if discount_id exists
        if (discountId) {
          // Update existing discount
          console.log(`   🔍 Found existing discount_id: ${discountId}`);
          console.log(`   🔄 Updating discount to ${benefitPercentage}%...`);

          await patchDiscount(discountId, benefitPercentage, promoCode, region);

          console.log(
            `   ✅ Successfully updated discount ${discountId} to ${benefitPercentage}%`
          );
          results.updated.push({
            promoCode,
            tier,
            discountId,
            benefitPercentage,
          });
          results.success.push({
            promoCode,
            tier,
            discountId,
            benefitPercentage,
            action: "updated",
          });
        } else {
          // Create new discount
          console.log(`   ⚠️ No discount_id found. Creating new discount...`);

          if (!promoCode || (!firstName && !lastName) || !tier) {
            let errorMsg = "";

            if (!promoCode) {
              errorMsg = "Missing promo_code. Cannot create discount.";
            } else if (!firstName && !lastName) {
              errorMsg =
                "Missing first_name and last_name. Cannot create discount.";
            } else if (!tier) {
              errorMsg = "Missing tier. Cannot create discount.";
            }

            console.log(`   ⚠️ ${errorMsg}`);
            results.failed.push({
              promoCode,
              tier,
              error: errorMsg,
            });
            continue;
          }

          const newDiscountId = await createCopilotDiscount(
            firstName,
            lastName,
            promoCode,
            tier
          );

          if (!newDiscountId) {
            throw new Error("Failed to create discount - no ID returned");
          }

          console.log(
            `   ✅ Successfully created discount with ID: ${newDiscountId}`
          );

          // Update BigQuery with the new discount_id
          await updateDiscountInfo(promoCode, newDiscountId, benefitPercentage);

          results.created.push({
            promoCode,
            tier,
            discountId: newDiscountId,
          });
          results.success.push({
            promoCode,
            tier,
            discountId: newDiscountId,
            action: "created",
          });
        }
      } catch (error) {
        const errorMessage = error.response
          ? `API Error: ${error.response.status} ${JSON.stringify(
              error.response.data
            )}`
          : error.message;
        console.error(`   ❌ Error processing ${promoCode}:`, errorMessage);
        results.failed.push({
          promoCode,
          tier,
          discountId: discountId || null,
          error: errorMessage,
        });
      }
    }

    // 6. Summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 SUMMARY");
    console.log("=".repeat(80));
    console.log(`✅ Successfully processed: ${results.success.length}`);
    console.log(`🆕 Created: ${results.created.length}`);
    console.log(`🔄 Updated: ${results.updated.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);

    // 7. Detailed log of all processed discounts
    if (results.created.length > 0 || results.updated.length > 0) {
      console.log("\n" + "=".repeat(80));
      console.log("📋 DETAILED RESULTS");
      console.log("=".repeat(80));

      // Log created discounts
      if (results.created.length > 0) {
        console.log("\n🆕 CREATED DISCOUNTS:");
        console.log("-".repeat(80));
        results.created.forEach((item, index) => {
          console.log(
            `${index + 1}. Promo Code: ${item.promoCode} | Tier: ${
              item.tier
            } | Discount ID: ${item.discountId} | Percentage: ${
              item.benefitPercentage
            }%`
          );
        });
      }

      // Log updated discounts
      if (results.updated.length > 0) {
        console.log("\n🔄 UPDATED DISCOUNTS:");
        console.log("-".repeat(80));
        results.updated.forEach((item, index) => {
          console.log(
            `${index + 1}. Promo Code: ${item.promoCode} | Tier: ${
              item.tier
            } | Discount ID: ${item.discountId} | Percentage: ${
              item.benefitPercentage
            }%`
          );
        });
      }
    }

    // Log failed discounts if any
    if (results.failed.length > 0) {
      console.log("\n❌ FAILED DISCOUNTS:");
      console.log("-".repeat(80));
      results.failed.forEach((item, index) => {
        console.log(
          `${index + 1}. Promo Code: ${item.promoCode} | Tier: ${
            item.tier
          } | Error: ${item.error}`
        );
      });
    }

    console.log("\n" + "=".repeat(80));

    return results;
  } catch (error) {
    console.error(`❌ Fatal error in updateDiscounts:`, error.message);
    throw error;
  }
}

/**
 * Test function to update a specific discount by ID
 */
export async function updateSpecificDiscount(discountId, tier) {
  console.log(`🚀 Updating discount ${discountId} with tier: ${tier}...`);

  try {
    // Validate tier
    const normalizedTier = tier.toLowerCase();
    if (!(normalizedTier in TIER_BENEFITS)) {
      throw new Error(
        `Invalid tier: ${tier}. Valid tiers are: ${Object.keys(TIER_BENEFITS).join(", ")}`
      );
    }

    const benefitPercentage = TIER_BENEFITS[normalizedTier];
    console.log(`   📊 Tier "${tier}" maps to discount: ${benefitPercentage}%`);

    // Get the promo code from the existing discount
    const promoCode = await getDiscountPromoCode(discountId);
    console.log(`   🔍 Found promo code: ${promoCode}`);

    // Update the discount
    await patchDiscount(discountId, benefitPercentage, promoCode);

    console.log(
      `   ✅ Successfully updated discount ${discountId} to ${benefitPercentage}%`
    );

    return {
      success: true,
      discountId,
      tier,
      benefitPercentage,
      promoCode,
    };
  } catch (error) {
    const errorMessage = error.response
      ? `API Error: ${error.response.status} ${JSON.stringify(
          error.response.data
        )}`
      : error.message;
    console.error(`   ❌ Error updating discount ${discountId}:`, errorMessage);
    throw error;
  }
}

// If run directly, execute the function
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check if command line arguments are provided for testing a specific discount
  if (process.argv[2] && process.argv[3]) {
    const discountId = process.argv[2];
    const tier = process.argv[3];
    updateSpecificDiscount(discountId, tier)
      .then((result) => {
        console.log("\n✅ Discount updated successfully");
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      })
      .catch((error) => {
        console.error("❌ Update failed:", error);
        process.exit(1);
      });
  } else {
    // Run the full update process
    updateDiscounts()
      .then((results) => {
        console.log("\n✅ Process completed successfully");
        process.exit(0);
      })
      .catch((error) => {
        console.error("❌ Process failed:", error);
        process.exit(1);
      });
  }
}
