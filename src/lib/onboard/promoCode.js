/** Build a unique MT promo code from a name (FIRSTNAMELASTNAME). */

import { bareIgHandle, isPlaceholderIgHandle, parseIgHandles } from "../instagram.js";
import { normalizePersonName } from "../notion/parseProps.js";

function slugPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "");
}

export function basePromoCode(firstName, lastName, email) {
  const n = normalizePersonName(firstName, lastName);
  const fromName = `${slugPart(n.firstName)}${slugPart(n.lastName)}`.toUpperCase();
  if (fromName) return fromName;
  const local = emailLocalSlug(email);
  return local || "COPILOT";
}

function emailLocalSlug(email) {
  return String(email || "")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

/** Alphanumeric promo from an IG handle (`@jane.smith` → JANESMITH). */
export function promoCodeFromIgHandle(igHandle) {
  const bare = parseIgHandles(igHandle)[0] || bareIgHandle(igHandle);
  if (!bare || isPlaceholderIgHandle(bare)) return "";
  return slugPart(bare).toUpperCase();
}

/**
 * FIRSTNAMELASTNAME when free. If that name is taken, the IG handle
 * (symbols stripped). Email local-part only if the handle is missing or
 * also taken.
 *
 * @param {string} base
 * @param {Set<string>} takenUpper
 * @param {{ igHandle?: string, email?: string }} [opts]
 */
export function uniquePromoCode(base, takenUpper, { igHandle, email } = {}) {
  const taken = takenUpper || new Set();
  const candidates = [];
  const add = (value) => {
    const code = String(value || "").toUpperCase();
    if (code && !candidates.includes(code)) candidates.push(code);
  };

  add(String(base || "COPILOT").toUpperCase());
  add(promoCodeFromIgHandle(igHandle));
  add(emailLocalSlug(email));

  for (const code of candidates) {
    if (!taken.has(code)) return code;
  }

  const fallback = `${candidates[0] || "COPILOT"}${Date.now().toString().slice(-4)}`;
  if (!taken.has(fallback)) return fallback;
  return `${candidates[0] || "COPILOT"}${Date.now()}`;
}
