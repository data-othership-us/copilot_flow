import { mtGet, mtPost } from "../mt/marianatekClient.js";
import {
  getValidBankcardId,
  hasValidBankcardOnFile,
  isPaymentMethodError,
  paymentMethodError,
} from "../mt/bankcards.js";
import {
  getCartTotal,
  prepareCartForMembership,
  restoreParkedCartItems,
} from "../mt/cartHelpers.js";
import {
  locationIdFromHomeStudio,
  membershipRegionKey,
  normalizeCopilotRegion,
  normalizeTierKey,
  partnerIdForLocation,
  regionForLocation,
} from "../copilotIdentity.js";

/** Parent product IDs from membership_products.json. */
const PARENT_PRODUCTS = {
  seeker: { NY: "17075", TO: "17073" },
  wayfinder: { NY: "17071", TO: "17069" },
  luminary: { NY: "17067", TO: "17065" },
};

/** Known child membership IDs (Seeker verified in assign-memberships). */
const CHILD_MEMBERSHIPS = {
  seeker: { NY: "17076", TO: "17074" },
  wayfinder: { NY: "17072", TO: "17070" },
  luminary: { NY: "17068", TO: "17066" },
};

const LIVE_STATUSES = new Set(["active", "pending", "frozen", "payment_failure"]);

function isCopilotMembershipName(name) {
  return /co[\s-]?pilot/i.test(String(name || ""));
}

export async function listMembershipsForUser(userId) {
  const response = await mtGet("/membership_instances", {
    user: String(userId),
  });
  const data = response?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

export function pickLiveCopilotMembership(instances) {
  const live = (instances || []).filter((m) => {
    const status = String(m?.attributes?.status || "").toLowerCase();
    return (
      LIVE_STATUSES.has(status) &&
      isCopilotMembershipName(m?.attributes?.membership_name)
    );
  });
  live.sort((a, b) => {
    const aStart = new Date(a?.attributes?.calculated_start_datetime || 0).getTime();
    const bStart = new Date(b?.attributes?.calculated_start_datetime || 0).getTime();
    return bStart - aStart;
  });
  return live[0] || null;
}

export async function findLiveCopilotMembership(userId) {
  if (!userId) return null;
  const instances = await listMembershipsForUser(userId);
  return pickLiveCopilotMembership(instances);
}

export function copilotMembershipEndAt(instance) {
  const raw =
    instance?.attributes?.calculated_end_datetime ||
    instance?.attributes?.end_datetime ||
    instance?.attributes?.end_date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function membershipStartAt(instance) {
  const raw =
    instance?.attributes?.calculated_start_datetime ||
    instance?.attributes?.start_date ||
    instance?.attributes?.start_datetime;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferTierFromMembershipName(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("luminary")) return "Luminary";
  if (n.includes("wayfinder")) return "Wayfinder";
  if (n.includes("seeker")) return "Seeker";
  return null;
}

/**
 * A Co-Pilot term of `tier` that already starts at/after `startAt`
 * (pending stack) or after `decisionAt` (idempotent retry).
 */
export function pickStackedCopilotMembership(
  instances,
  { tier, startAt = null, decisionAt = null } = {}
) {
  const want = String(tier || "").toLowerCase();
  const intended = startAt instanceof Date && !Number.isNaN(startAt.getTime())
    ? startAt.getTime()
    : null;
  const since = decisionAt ? new Date(decisionAt) : null;
  const sinceMs =
    since && !Number.isNaN(since.getTime()) ? since.getTime() - 5 * 60 * 1000 : null;

  const matches = (instances || []).filter((m) => {
    if (!isCopilotMembershipName(m?.attributes?.membership_name)) return false;
    const liveTier = inferTierFromMembershipName(m?.attributes?.membership_name);
    if (!liveTier || liveTier.toLowerCase() !== want) return false;
    const start = membershipStartAt(m);
    if (!start) return false;
    if (intended != null && Math.abs(start.getTime() - intended) < 24 * 60 * 60 * 1000) {
      return true;
    }
    if (sinceMs != null && start.getTime() >= sinceMs) return true;
    return false;
  });
  matches.sort((a, b) => {
    const aStart = membershipStartAt(a)?.getTime() || 0;
    const bStart = membershipStartAt(b)?.getTime() || 0;
    return bStart - aStart;
  });
  return matches[0] || null;
}

async function resolveChildMembershipId(tier, regionKey) {
  const key = normalizeTierKey(tier);
  const hardcoded = CHILD_MEMBERSHIPS[key]?.[regionKey];
  // Prefer the known Co-Pilot child ids. Listing `/child_product_memberships?product=`
  // is not filtered by parent and can return unrelated memberships (e.g. Adelaide Unlimited).
  if (hardcoded) return hardcoded;

  const parentId = PARENT_PRODUCTS[key]?.[regionKey];
  const want = new RegExp(
    `${key}\\s+${regionKey}\\s+co[\\s-]?pilot`,
    "i"
  );

  if (parentId) {
    try {
      const response = await mtGet("/child_product_memberships", {
        product: parentId,
      });
      const children = response?.data;
      const list = Array.isArray(children) ? children : children ? [children] : [];
      const match = list.find((c) => want.test(String(c?.attributes?.name || "")));
      if (match?.id) return String(match.id);
    } catch {
      // fall through
    }
  }

  throw new Error(`No membership product for tier=${tier} region=${regionKey}`);
}

async function resolveLocationAndPartner({ userId, homeStudio, region }) {
  let locationId = locationIdFromHomeStudio(homeStudio);
  if (!locationId && userId) {
    const user = await mtGet(`/users/${userId}`);
    const home =
      user?.data?.relationships?.home_location?.data ||
      user?.data?.attributes?.home_location?.data ||
      null;
    const loc = Array.isArray(home) ? home[0] : home;
    if (loc?.id) locationId = String(loc.id);
  }
  const partnerId = partnerIdForLocation(locationId);
  const resolvedRegion =
    regionForLocation(locationId) || normalizeCopilotRegion(region);
  return { locationId, partnerId, region: resolvedRegion };
}

/**
 * Assign a Co-Pilot membership via MT cart checkout (no charge).
 * Does not terminate a live term. By default skips if one is already live;
 * `allowAlongsideExpiring` adds a new term starting now on expiry day.
 * @returns {Promise<{ skipped?: string, membership?: object }>}
 */
export async function assignCopilotMembership({
  userId,
  email,
  region,
  homeStudio,
  tier = "Seeker",
  allowAlongsideExpiring = false,
  dryRun = false,
}) {
  if (!userId) throw new Error("userId is required to assign membership");

  const existing = await findLiveCopilotMembership(userId);
  if (existing && !allowAlongsideExpiring) {
    return {
      skipped: "already_has_live_copilot_membership",
      membership: existing,
    };
  }

  const resolved = await resolveLocationAndPartner({
    userId,
    homeStudio,
    region,
  });
  if (!resolved.partnerId || !resolved.region) {
    throw new Error(
      `Could not resolve partner/region for ${email || userId} (studio=${homeStudio || "?"} location=${resolved.locationId || "?"})`
    );
  }

  const regionKey = membershipRegionKey(resolved.region);
  const childId = await resolveChildMembershipId(tier, regionKey);

  const hasCc = await hasValidBankcardOnFile(userId);
  if (!hasCc) {
    throw paymentMethodError("no_cc_on_file");
  }

  if (dryRun) {
    return {
      skipped: "dry_run",
      region: resolved.region,
      partnerId: resolved.partnerId,
      childProductId: childId,
    };
  }

  const paymentMethodId = await getValidBankcardId(userId);
  if (!paymentMethodId) {
    throw paymentMethodError("no_cc_on_file");
  }

  const beforeIds = new Set(
    (await listMembershipsForUser(userId)).map((m) => String(m.id))
  );

  let parked = [];
  let cartId;
  try {
    const prepared = await prepareCartForMembership({
      userId,
      partnerId: resolved.partnerId,
      membershipProductId: childId,
      productType: "child_product_memberships",
    });
    cartId = prepared.cartId;
    parked = prepared.parked || [];

    const amount = await getCartTotal(cartId);
    let checkoutData;
    try {
      checkoutData = await mtPost("/checkouts", {
        data: {
          type: "checkouts",
          attributes: {
            payments: [
              {
                amount,
                type: "bankcard",
                id: String(paymentMethodId),
              },
            ],
            status: null,
          },
          relationships: {
            cart: { data: { type: "carts", id: String(cartId) } },
            for_reservation: { data: null },
            originating_partner: {
              data: { type: "partners", id: String(resolved.partnerId) },
            },
          },
        },
      });
    } catch (error) {
      if (isPaymentMethodError(error)) {
        throw paymentMethodError(error.message);
      }
      throw error;
    }

    if (parked.length) {
      try {
        await restoreParkedCartItems({
          userId,
          partnerId: resolved.partnerId,
          parked,
        });
      } catch (error) {
        console.warn(
          `   ⚠️  Membership assigned but failed to restore parked cart items: ${error.message}`
        );
      }
    }

    const after = await listMembershipsForUser(userId);
    const created = after.filter((m) => !beforeIds.has(String(m.id)));
    const createdId = created[0]?.id ? String(created[0].id) : null;

    return {
      membership: {
        checkoutId: checkoutData?.data?.id ?? null,
        cartId,
        childProductId: childId,
        region: resolved.region,
        partnerId: resolved.partnerId,
        instanceId: createdId,
      },
    };
  } catch (error) {
    if (parked.length) {
      try {
        await restoreParkedCartItems({
          userId,
          partnerId: resolved.partnerId,
          parked,
        });
      } catch (restoreError) {
        console.warn(
          `   ⚠️  Failed to restore parked cart items after membership error: ${restoreError.message}`
        );
      }
    }
    throw error;
  }
}

export async function terminateMembershipInstance(membershipInstanceId) {
  if (!membershipInstanceId) return null;
  const getResponse = await mtGet(
    `/membership_instances/${membershipInstanceId}`
  );
  const membership = getResponse?.data;
  if (!membership) {
    throw new Error(`Membership instance ${membershipInstanceId} not found`);
  }
  const attrs = membership.attributes || {};
  return mtPost(`/membership_instances/${membershipInstanceId}/terminate/`, {
    data: {
      type: "membership_instances",
      id: String(membershipInstanceId),
      attributes: {
        membership: attrs.membership,
        membership_product: attrs.membership_product,
        payment_interval: attrs.payment_interval,
        payment_interval_length: 0,
        renewal_currency: attrs.renewal_currency,
        user: attrs.user,
        cancellation_datetime: new Date().toISOString(),
        adjustment_interval_count: 0,
      },
    },
  });
}

function addCalendarMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

export async function freezeMembershipInstance(membershipInstanceId, reactivationAt) {
  if (!membershipInstanceId) return null;
  return mtPost("/membership_freezes", {
    data: {
      type: "membership_freezes",
      attributes: {
        freeze_datetime: new Date().toISOString(),
        reactivation_datetime: reactivationAt.toISOString(),
      },
      relationships: {
        membership_instance: {
          data: {
            type: "membership_instances",
            id: String(membershipInstanceId),
          },
        },
      },
    },
  });
}

/** Freeze the live Co-Pilot membership until `until`, or 3 months from now. */
export async function freezeLiveCopilotMembership(userId, { months = 3, until = null } = {}) {
  const live = await findLiveCopilotMembership(userId);
  if (!live?.id) {
    throw new Error(
      "no live Co-Pilot membership to freeze — use snooze for copilots without a Co-Pilot membership"
    );
  }
  const status = String(live.attributes?.status || "").toLowerCase();
  if (status === "frozen") {
    return { skipped: "already_frozen", membership: live };
  }
  const reactivationAt =
    until instanceof Date && !Number.isNaN(until.getTime())
      ? until
      : addCalendarMonths(new Date(), months);
  if (reactivationAt.getTime() <= Date.now()) {
    throw new Error("freeze_until must be in the future");
  }
  await freezeMembershipInstance(live.id, reactivationAt);
  return { membership: live, reactivationAt: reactivationAt.toISOString() };
}
