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

function isValidBankcard(card) {
  return card?.attributes?.is_expired !== true;
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
