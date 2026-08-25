/** Map Notion/sheet/MT region labels onto copilot_db conventions (TO | NYC). */
export function normalizeCopilotRegion(region) {
  const r = String(region || "")
    .trim()
    .toUpperCase();
  if (!r) return null;
  if (r === "TO" || r.includes("TORONTO") || r === "YYZ" || r === "TOR") {
    return "TO";
  }
  if (r === "NY" || r === "NYC" || r.includes("NEW YORK")) return "NYC";
  return region;
}

/** NY vs TO suffix used by membership product titles. */
export function membershipRegionKey(region) {
  return normalizeCopilotRegion(region) === "NYC" ? "NY" : "TO";
}

export function isNycRegion(region) {
  return normalizeCopilotRegion(region) === "NYC";
}

export function titleCaseTier(tier) {
  const t = String(tier || "").trim();
  if (!t) return "Seeker";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

export function normalizeTierKey(tier) {
  return titleCaseTier(tier).toLowerCase();
}

/** Next program tier, or null if already Luminary / unknown. */
export function nextTier(tier) {
  const key = normalizeTierKey(tier);
  if (key === "seeker") return "Wayfinder";
  if (key === "wayfinder") return "Luminary";
  return null;
}

/** Previous program tier, or null if already Seeker / unknown. */
export function previousTier(tier) {
  const key = normalizeTierKey(tier);
  if (key === "luminary") return "Wayfinder";
  if (key === "wayfinder") return "Seeker";
  return null;
}

/** Seeker 3 / Wayfinder 6 / Luminary 12. */
export function termLengthMonths(tier) {
  const key = normalizeTierKey(tier);
  if (key === "luminary") return 12;
  if (key === "wayfinder") return 6;
  return 3;
}

export function estimatedTermEnd(tier, from = new Date()) {
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + termLengthMonths(tier));
  return d;
}

const LOCATION_IDS = {
  Adelaide: "48717",
  Yorkville: "48750",
  Flatiron: "48784",
  Williamsburg: "48817",
};

const LOCATION_TO_PARTNER = {
  48717: "41362",
  48750: "41395",
  48784: "41429",
  48817: "41462",
};

const LOCATION_TO_REGION = {
  48717: "TO",
  48750: "TO",
  48784: "NYC",
  48817: "NYC",
};

export function locationIdFromHomeStudio(homeStudio) {
  const name = String(homeStudio || "").trim();
  if (!name) return null;
  if (LOCATION_IDS[name]) return LOCATION_IDS[name];
  const lower = name.toLowerCase();
  for (const [label, id] of Object.entries(LOCATION_IDS)) {
    if (lower.includes(label.toLowerCase())) return id;
  }
  if (/^\d+$/.test(name)) return name;
  return null;
}

export function partnerIdForLocation(locationId) {
  return LOCATION_TO_PARTNER[String(locationId)] ?? null;
}

export function regionForLocation(locationId) {
  return LOCATION_TO_REGION[String(locationId)] ?? null;
}

export function firstNameOrHey(firstName) {
  return String(firstName || "").trim() || "there";
}
