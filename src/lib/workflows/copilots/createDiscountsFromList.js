import fs from "fs";
import path from "path";
import { createCopilotDiscount } from "../../Discount/createDiscount.js";

/**
 * Parse a list file: one person per line.
 * Formats (header row optional):
 *   first_name,last_name,code
 *   first_name\tlast_name\tcode
 * Lines starting with # are ignored.
 */
export function parseDiscountListFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const delimiter = trimmed.includes("\t") ? "\t" : ",";
    const parts = trimmed.split(delimiter).map((p) => p.trim());
    if (parts.length < 3) {
      throw new Error(
        `Invalid line (need first_name, last_name, code): ${trimmed}`
      );
    }

    const [first, second, third, fourth] = parts;
    const headerLike =
      first.toLowerCase() === "first_name" ||
      first.toLowerCase() === "first name";
    if (headerLike && rows.length === 0) continue;

    let firstName;
    let lastName;
    let code;
    let tier = "seeker";

    if (parts.length >= 4) {
      firstName = first;
      lastName = second;
      code = third;
      tier = fourth;
    } else {
      firstName = first;
      lastName = second;
      code = third;
    }

    rows.push({
      firstName,
      lastName,
      code,
      tier,
    });
  }

  return rows;
}

export async function createDiscountsFromList(filePath, { tier: defaultTier } = {}) {
  const resolved = path.resolve(filePath);
  const rows = parseDiscountListFile(resolved);

  if (rows.length === 0) {
    console.log("⚠️ No rows to process in", resolved);
    return { success: [], failed: [] };
  }

  console.log(`🚀 Creating ${rows.length} discount(s) from ${resolved}...`);

  const results = { success: [], failed: [] };

  for (let i = 0; i < rows.length; i++) {
    const { firstName, lastName, code, tier } = rows[i];
    const effectiveTier = defaultTier || tier;

    console.log(
      `\n[${i + 1}/${rows.length}] ${effectiveTier} ${firstName} ${lastName} → ${code}`
    );

    try {
      const discountId = await createCopilotDiscount(
        firstName,
        lastName,
        code,
        effectiveTier
      );
      results.success.push({
        firstName,
        lastName,
        code,
        tier: effectiveTier,
        discountId,
      });
      console.log(`   ✅ Created discount ID: ${discountId}`);
    } catch (error) {
      const message = error.response
        ? `API ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      results.failed.push({
        firstName,
        lastName,
        code,
        tier: effectiveTier,
        error: message,
      });
      console.error(`   ❌ ${message}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`✅ Success: ${results.success.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  if (results.success.length) {
    console.log("\nCreated:");
    for (const r of results.success) {
      console.log(
        `  ${r.discountId} | ${r.tier} ${r.firstName} ${r.lastName} | ${r.code}`
      );
    }
  }

  return results;
}
