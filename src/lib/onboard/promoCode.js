/** Build a unique MT promo code from a name (FIRSTNAMELASTNAME). */

function slugPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "");
}

export function basePromoCode(firstName, lastName, email) {
  const fromName = `${slugPart(firstName)}${slugPart(lastName)}`.toUpperCase();
  if (fromName) return fromName;
  const local = String(email || "")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return local || "COPILOT";
}

/**
 * @param {string} base
 * @param {Set<string>} takenUpper
 */
export function uniquePromoCode(base, takenUpper) {
  const root = String(base || "COPILOT").toUpperCase();
  if (!takenUpper.has(root)) return root;
  for (let i = 2; i < 100; i++) {
    const candidate = `${root}${i}`;
    if (!takenUpper.has(candidate)) return candidate;
  }
  return `${root}${Date.now().toString().slice(-4)}`;
}
