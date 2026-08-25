import dotenv from "dotenv";

dotenv.config();

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

const baseRaw = required("MT_API_BASE_URL").replace(/\/+$/, "");
export const MT_API_BASE_URL = baseRaw.endsWith("/api") ? baseRaw : `${baseRaw}/api`;
export const MT_API_KEY = required("MT_API_KEY");

export const API_HEADERS = {
  Authorization: `Bearer ${MT_API_KEY}`,
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
};

export const TIER_BENEFITS = {
  seeker: Number(process.env.COPILOT_SEEKER_DISCOUNT_PERCENT || 11),
  wayfinder: Number(process.env.COPILOT_WAYFINDER_DISCOUNT_PERCENT || 14),
  luminary: Number(process.env.COPILOT_LUMINARY_DISCOUNT_PERCENT || 18),
};

export const TIER_TO_PRODUCT_KEY = {
  seeker: "coPilot",
  wayfinder: "wayfinder",
  luminary: "luminary",
};

export const TURF_CONFIG = {
  global_turf: {
    enabled: true,
    can_assign: true,
  },
};

/** Matches live Co-Pilot discount turf (e.g. discount 3906). */
export const TURF_CONFIG_WITH_REGIONS = {
  global_turf: {
    enabled: true,
    can_assign: true,
  },
  regions: [
    {
      name: "NYC",
      id: 48575,
      enabled: true,
      can_assign: true,
      locations: [
        {
          name: "Flatiron",
          id: 48784,
          currency_code: "USD",
          enabled: true,
          can_assign: true,
        },
        {
          name: "Williamsburg",
          id: 48817,
          currency_code: "USD",
          enabled: true,
          can_assign: true,
        },
      ],
    },
    {
      name: "Toronto",
      id: 48541,
      enabled: true,
      can_assign: true,
      locations: [
        {
          name: "Adelaide",
          id: 48717,
          currency_code: "CAD",
          enabled: true,
          can_assign: true,
        },
        {
          name: "Yorkville",
          id: 48750,
          currency_code: "CAD",
          enabled: true,
          can_assign: true,
        },
      ],
    },
  ],
};
