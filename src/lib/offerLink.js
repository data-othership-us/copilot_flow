/**
 * Shared Co-Pilot special-offer URL (BrandBot replacement).
 * One Webflow page; lookup is promo_code in copilots.copilot_db.
 */
export const OFFER_LINK_PREFIX =
  process.env.COPILOT_OFFER_LINK_PREFIX ||
  "https://othership.us/copilot/intro-offer?id=";

export function buildOfferLink(promoCode) {
  const code = String(promoCode || "").trim();
  if (!code) return null;
  return `${OFFER_LINK_PREFIX}${code}`;
}
