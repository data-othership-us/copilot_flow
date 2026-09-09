import axios from "axios";
import { config } from "../../config.js";

function mtHeaders() {
  return {
    Authorization: `Bearer ${config.mt.apiKey}`,
    Accept: "application/vnd.api+json",
  };
}

/**
 * @returns {Promise<object[]>} JSON:API bankcard resources
 */
export async function getUserBankcards(userId) {
  if (!userId) return [];

  const response = await axios.get(`${config.mt.baseUrl}/bankcards`, {
    headers: mtHeaders(),
    params: { user: String(userId) },
  });

  const data = response.data?.data;
  return Array.isArray(data) ? data : data ? [data] : [];
}

export const NO_PAYMENT_METHOD = "NO_PAYMENT_METHOD";

function isValidBankcard(card) {
  return card?.attributes?.is_expired !== true;
}

export function paymentMethodError(message = "no_cc_on_file") {
  const error = new Error(message);
  error.code = NO_PAYMENT_METHOD;
  return error;
}

/**
 * True when membership checkout failed because no card is on file
 * or the stored card is expired / invalid.
 */
export function isPaymentMethodError(error) {
  if (!error) return false;
  if (error.code === NO_PAYMENT_METHOD) return true;
  const text = `${error.message || ""} ${JSON.stringify(error.meta ?? "")}`.toLowerCase();
  if (text.includes("no_cc_on_file")) return true;
  if (/no (valid )?(payment method|bankcard|card on file)/.test(text)) return true;
  if (/\b(expired card|card expired|expired payment|payment expired)\b/.test(text)) {
    return true;
  }
  if (/(payment method|bankcard).{0,60}(expired|invalid|missing)/.test(text)) {
    return true;
  }
  if (/(expired|invalid|missing).{0,60}(payment method|bankcard)/.test(text)) {
    return true;
  }
  return text.includes("is_expired");
}

/** Throws if the user has no non-expired bankcard. */
export async function assertValidPaymentMethod(userId) {
  const hasCc = await hasValidBankcardOnFile(userId);
  if (!hasCc) throw paymentMethodError("no_cc_on_file");
}

/**
 * CC on file = at least one non-expired stored bankcard.
 * Expired cards count as no CC.
 */
export async function hasValidBankcardOnFile(userId) {
  const bankcards = await getUserBankcards(userId);
  return bankcards.some(isValidBankcard);
}

/**
 * @returns {Promise<string|null>} First non-expired bankcard ID for checkout
 */
export async function getValidBankcardId(userId) {
  const bankcards = await getUserBankcards(userId);
  const card = bankcards.find(isValidBankcard);
  return card?.id ? String(card.id) : null;
}
