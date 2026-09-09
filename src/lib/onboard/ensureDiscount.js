import { createCopilotDiscount, isDuplicatePromoCodeError } from "../Discount/createDiscount.js";
import { activateCopilotDiscount } from "../Discount/patchCopilotDiscount.js";
import { lookupDiscountIdByPromoCode } from "./existingPromo.js";
import { basePromoCode, promoCodeFromIgHandle, uniquePromoCode } from "./promoCode.js";

const CREATE_ATTEMPTS = 8;

async function reactivateExisting({
  discountId,
  promoCode,
  firstName,
  lastName,
  email,
  tier,
  dryRun,
}) {
  const activated = await activateCopilotDiscount({
    discountId,
    promoCode,
    firstName,
    lastName,
    email,
    tier,
    dryRun,
  });
  if (activated.skipped === "no_discount_id") {
    return { discountId: "", reactivated: false };
  }
  if (activated.skipped === "already_active") {
    console.log(`   ⏭️  discount already active (${activated.discountId})`);
    return { discountId: String(activated.discountId), reactivated: false };
  }
  const id = String(activated.discountId || discountId);
  if (dryRun) {
    console.log(`   ♻️  discount: would reactivate ${promoCode} id=${id}`);
  } else {
    console.log(`   ♻️  discount ${promoCode} id=${id} reactivated`);
  }
  return { discountId: id, reactivated: true };
}

/**
 * Give this copilot a live MT voucher.
 *
 * Returning copilots (`owned`): reuse their code, look up the expired
 * voucher, and turn it back on. Never mint a replacement.
 *
 * New copilots: mint FIRSTNAMELASTNAME from `takenCodes`. If that name is
 * taken, use their IG handle (symbols stripped). If Mariana Tek still says
 * the code is taken, try the next candidate (email local-part).
 */
export async function ensureOnboardDiscount({
  firstName,
  lastName,
  email,
  promoCode,
  discountId,
  tier,
  region,
  owned = false,
  takenCodes,
  igHandle = "",
  dryRun = false,
} = {}) {
  const taken = takenCodes || new Set();
  const base = basePromoCode(firstName, lastName, email);
  let code = String(promoCode || "")
    .trim()
    .toUpperCase();
  let id = discountId ? String(discountId).trim() : "";
  let generated = false;
  let created = false;
  let reactivated = false;

  if (!code) {
    code = uniquePromoCode(base, taken, { igHandle, email });
    generated = true;
    owned = false;
    const igCode = promoCodeFromIgHandle(igHandle);
    const why =
      code === base
        ? "would create"
        : code === igCode
          ? "name taken; using IG handle"
          : "name taken; unique";
    console.log(`   🏷️  promo_code=${code} (${why})`);
  } else {
    console.log(`   🏷️  promo_code already set (${code})`);
  }
  taken.add(code);

  if (owned && !id) {
    try {
      id = await lookupDiscountIdByPromoCode(code);
    } catch (error) {
      console.warn(`   ⚠️  existing voucher lookup failed: ${error.message}`);
    }
  }

  if (id) {
    const active = await reactivateExisting({
      discountId: id,
      promoCode: code,
      firstName,
      lastName,
      email,
      tier,
      dryRun,
    });
    if (active.discountId) id = active.discountId;
    reactivated = active.reactivated;
    return { promoCode: code, discountId: id, generated, created, reactivated };
  }

  console.log(
    `   🎟️  discount: would create MT ${tier} discount for ${code} (${region || "region?"})`
  );
  if (dryRun) {
    return { promoCode: code, discountId: id, generated, created: true, reactivated };
  }

  for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt++) {
    try {
      id = String(
        await createCopilotDiscount(firstName || "", lastName || "", code, tier, region)
      );
      taken.add(code);
      created = true;
      console.log(`   ✅ discount_id=${id}`);
      return { promoCode: code, discountId: id, generated, created, reactivated };
    } catch (error) {
      if (!isDuplicatePromoCodeError(error)) throw error;
      taken.add(code);
      if (owned) {
        try {
          id = await lookupDiscountIdByPromoCode(code);
        } catch (lookupError) {
          console.warn(`   ⚠️  duplicate-code lookup failed: ${lookupError.message}`);
        }
        if (id) {
          const active = await reactivateExisting({
            discountId: id,
            promoCode: code,
            firstName,
            lastName,
            email,
            tier,
            dryRun,
          });
          if (active.discountId) {
            return {
              promoCode: code,
              discountId: active.discountId,
              generated,
              created: false,
              reactivated: active.reactivated,
            };
          }
        }
        throw error;
      }
      const next = uniquePromoCode(base, taken, { igHandle, email });
      console.log(
        `   ⚠️  ${code} already exists in Mariana Tek — trying ${next}`
      );
      code = next;
      generated = true;
    }
  }

  throw new Error(`Could not mint a unique promo code from ${base}`);
}
