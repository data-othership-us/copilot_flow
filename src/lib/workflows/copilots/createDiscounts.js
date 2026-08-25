import dotenv from "dotenv";
import { createCopilotDiscount } from "../../Discount/createDiscount.js";
import {
  TIER_BENEFITS,
} from "../../coPilotConstants.js";
import { copilotDbRef, getBigQueryClient } from "../../bqConfig.js";

dotenv.config();

const bigquery = getBigQueryClient();
const COPILOT_DB = copilotDbRef();

//-------------------------------- Helper Functions --------------------------------

/**
 * Query BigQuery for all rows with promo_code but no discount_id
 */
async function getAllRowsWithoutDiscountId() {
  console.log(
    `📊 Querying BigQuery for rows with promo_code but no discount_id from ${COPILOT_DB}...`
  );

  try {
    const query = `
      SELECT discount_id, promo_code, tier, region, first_name, last_name
      FROM ${COPILOT_DB}
      WHERE promo_code IS NOT NULL 
      AND promo_code != ''
      AND tier IS NOT NULL
      AND tier != ''
      AND (discount_id IS NULL OR discount_id = '')
    `;
    const [rows] = await bigquery.query({ query });

    console.log(
      `✅ Found ${rows.length} rows with promo_code but no discount_id to process`
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

//-------------------------------- Main Function --------------------------------
export async function createDiscounts() {
  console.log("🚀 Starting discount creation process...");

  const results = {
    success: [],
    failed: [],
  };

  try {
    // 1. Get all rows from BigQuery that have promo_code but no discount_id
    const rows = await getAllRowsWithoutDiscountId();

    if (rows.length === 0) {
      console.log("⚠️ No rows found with promo_code but no discount_id");
      return results;
    }

    // 2. Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const promoCode = row.promo_code;
      const tier = row.tier;
      const firstName = row.first_name || "";
      const lastName = row.last_name || "";

      console.log(
        `\n[${i + 1}/${rows.length}] Processing: ${promoCode} (Tier: ${tier})`
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

        // 4. Validate required fields
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

        // 5. Create new discount
        console.log(`   🆕 Creating new discount...`);

        const newDiscountId = await createCopilotDiscount(
          firstName,
          lastName,
          promoCode,
          tier,
          row.region
        );

        if (!newDiscountId) {
          throw new Error("Failed to create discount - no ID returned");
        }

        console.log(
          `   ✅ Successfully created discount with ID: ${newDiscountId}`
        );

        // 6. Update BigQuery with the new discount_id
        await updateDiscountInfo(promoCode, newDiscountId, benefitPercentage);

        results.success.push({
          promoCode,
          tier,
          discountId: newDiscountId,
          benefitPercentage,
        });
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
          error: errorMessage,
        });
      }
    }

    // 7. Summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 SUMMARY");
    console.log("=".repeat(80));
    console.log(`✅ Successfully created: ${results.success.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);

    // 8. Detailed log of all created discounts
    if (results.success.length > 0) {
      console.log("\n" + "=".repeat(80));
      console.log("📋 CREATED DISCOUNTS");
      console.log("=".repeat(80));
      results.success.forEach((item, index) => {
        console.log(
          `${index + 1}. Promo Code: ${item.promoCode} | Tier: ${
            item.tier
          } | Discount ID: ${item.discountId} | Percentage: ${
            item.benefitPercentage
          }%`
        );
      });
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
    console.error(`❌ Fatal error in createDiscounts:`, error.message);
    throw error;
  }
}

// If run directly, execute the function
if (import.meta.url === `file://${process.argv[1]}`) {
  createDiscounts()
    .then((results) => {
      console.log("\n✅ Process completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Process failed:", error);
      process.exit(1);
    });
}
