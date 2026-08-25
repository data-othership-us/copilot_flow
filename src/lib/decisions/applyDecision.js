import { sendLifecycleEmail, formatExpirationDate } from "../email/lifecycleEmail.js";
import { patchCopilotDiscount } from "../Discount/patchCopilotDiscount.js";
import {
  assignCopilotMembership,
  findLiveCopilotMembership,
  freezeLiveCopilotMembership,
  terminateMembershipInstance,
} from "../Membership/assignCopilotMembership.js";
import {
  estimatedTermEnd,
  nextTier,
  previousTier,
  titleCaseTier,
} from "../copilotIdentity.js";
import {
  freezeUntilDateString,
  isNeverAgainDecision,
  parseFreezeUntil,
} from "../sheets/evaluationSheet.js";
import { updateCopilotByEmail } from "../bq/copilotOps.js";

function inferTierFromMembershipName(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("luminary")) return "Luminary";
  if (n.includes("wayfinder")) return "Wayfinder";
  if (n.includes("seeker")) return "Seeker";
  return null;
}

function membershipStartTime(live) {
  const raw =
    live?.attributes?.calculated_start_datetime ||
    live?.attributes?.start_datetime ||
    live?.attributes?.started_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function membershipStartedOnOrAfter(live, decisionAt) {
  if (!live || !decisionAt) return false;
  const start = membershipStartTime(live);
  const since = new Date(decisionAt);
  if (!start || Number.isNaN(since.getTime())) return false;
  return start.getTime() >= since.getTime() - 5 * 60 * 1000;
}

function defaultFreezeUntil() {
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
  return d;
}

function emailFields(row, extra = {}) {
  return {
    email: row.contact_email,
    firstName: row.first_name,
    lastName: row.last_name,
    region: row.region,
    offerLink: row.offer_link,
    promoCode: row.promo_code,
    ...extra,
  };
}

/** Send after MT side-effects. Live apply fails (and retries later) if mail does not go out. */
async function notifyCopilot(row, kind, extra = {}) {
  const dryRun = Boolean(extra.dryRun);
  const result = await sendLifecycleEmail({
    kind,
    requireSend: !dryRun,
    ...emailFields(row, extra),
  });
  if (!dryRun && !result.sent) {
    throw new Error(
      `${kind} email was not sent to ${row.contact_email} (${result.channel})`
    );
  }
  return result;
}

async function terminateLiveIfPresent(userId) {
  const live = await findLiveCopilotMembership(userId);
  if (!live?.id) return null;
  await terminateMembershipInstance(live.id);
  return live.id;
}

/**
 * Assign a Co-Pilot term of `tier`. If a live membership is already that
 * tier and started on/after decision_at, skip (idempotent retry).
 */
export async function ensureCopilotTerm({
  userId,
  email,
  region,
  homeStudio,
  tier,
  decisionAt,
  dryRun = false,
}) {
  if (dryRun) {
    return { skipped: "dry_run" };
  }

  const live = await findLiveCopilotMembership(userId);
  const liveTier = inferTierFromMembershipName(live?.attributes?.membership_name);
  if (
    live &&
    liveTier &&
    liveTier.toLowerCase() === String(tier).toLowerCase() &&
    membershipStartedOnOrAfter(live, decisionAt)
  ) {
    console.log(`   ⏭️  already on ${tier} term started after decision`);
    return { skipped: "already_on_target_term", membership: live };
  }

  if (live?.id) {
    await terminateMembershipInstance(live.id);
  }

  return assignCopilotMembership({
    userId,
    email,
    region,
    homeStudio,
    tier,
    dryRun: false,
  });
}

async function applyRenew(row, { dryRun }) {
  const tier = titleCaseTier(row.tier || "Seeker");
  const end = formatExpirationDate(estimatedTermEnd(tier));

  if (!dryRun) {
    const result = await ensureCopilotTerm({
      userId: row.user_id,
      email: row.contact_email,
      region: row.region,
      homeStudio: row.home_studio,
      tier,
      decisionAt: row.decision_at,
      dryRun: false,
    });
    if (result.skipped && result.skipped !== "already_on_target_term") {
      console.log(`   ⏭️  renew membership: ${result.skipped}`);
    }
  }

  await notifyCopilot(row, "renewal", { tier, expirationDate: end, dryRun });

  if (!dryRun) {
    await updateCopilotByEmail(row.contact_email, {
      status: "active",
      decision_applied_at: "NOW",
    });
  }
  return "renewed";
}

async function applyOffboard(row, { dryRun, neverAgain = false }) {
  const tier = titleCaseTier(row.tier || "Seeker");
  if (!dryRun && row.user_id) {
    await terminateLiveIfPresent(row.user_id);
  }

  await notifyCopilot(row, "offboard", { tier, dryRun });

  if (!dryRun) {
    const fields = {
      status: "inactive",
      decision_applied_at: "NOW",
    };
    if (neverAgain) fields.never_again = true;
    await updateCopilotByEmail(row.contact_email, fields);
  }
  return neverAgain ? "never_again" : "offboarded";
}

async function applyTierChange(row, { dryRun, direction }) {
  const tier = titleCaseTier(row.tier || "Seeker");
  const newTier = direction === "upgrade" ? nextTier(tier) : previousTier(tier);

  if (!newTier || newTier.toLowerCase() === tier.toLowerCase()) {
    if (direction === "upgrade") {
      console.log(
        `   ⚠️  upgrade with no higher tier (current=${tier}) — treating as renew`
      );
      return applyRenew(row, { dryRun });
    }
    throw new Error(
      `cannot downgrade ${tier} — pick offboard to leave the program`
    );
  }

  const end = formatExpirationDate(estimatedTermEnd(newTier));

  if (!dryRun) {
    const result = await ensureCopilotTerm({
      userId: row.user_id,
      email: row.contact_email,
      region: row.region,
      homeStudio: row.home_studio,
      tier: newTier,
      decisionAt: row.decision_at,
      dryRun: false,
    });
    if (result.skipped && result.skipped !== "already_on_target_term") {
      console.log(`   ⏭️  ${direction} membership: ${result.skipped}`);
    }
    if (row.discount_id && row.promo_code) {
      await patchCopilotDiscount({
        discountId: row.discount_id,
        promoCode: row.promo_code,
        tier: newTier,
        region: row.region,
        firstName: row.first_name,
        lastName: row.last_name,
      });
    }
  }

  await notifyCopilot(row, direction, {
    tier,
    newTier,
    expirationDate: end,
    dryRun,
  });

  if (!dryRun) {
    await updateCopilotByEmail(row.contact_email, {
      tier: newTier,
      status: "active",
      decision_applied_at: "NOW",
    });
  }
  return `${direction}d:${newTier}`;
}

async function applySnooze(row, { dryRun }) {
  if (!dryRun) {
    await updateCopilotByEmail(row.contact_email, {
      decision_applied_at: "NOW",
    });
  }
  return "snoozed";
}

async function applyFreeze(row, { dryRun, freezeUntil }) {
  const until = parseFreezeUntil(freezeUntil);
  if (String(freezeUntil || "").trim() && !until) {
    throw new Error(`invalid freeze_until: ${freezeUntil}`);
  }
  const resolvedUntil = until || defaultFreezeUntil();
  const freezeDate = freezeUntilDateString(resolvedUntil);

  if (!dryRun) {
    const frozen = await freezeLiveCopilotMembership(row.user_id, {
      until: resolvedUntil,
    });
    if (frozen.skipped) {
      console.log(`   ⏭️  freeze: ${frozen.skipped}`);
    } else {
      console.log(`   ❄️  freeze until ${frozen.reactivationAt}`);
    }
  }

  const tier = titleCaseTier(row.tier || "Seeker");
  await notifyCopilot(row, "freeze", {
    tier,
    expirationDate: formatExpirationDate(resolvedUntil),
    dryRun,
  });

  if (!dryRun) {
    await updateCopilotByEmail(row.contact_email, {
      status: "active",
      freeze_until: freezeDate,
      decision_applied_at: "NOW",
    });
  }
  return "frozen";
}

export async function applyCopilotDecision(row, { dryRun = false, freezeUntil = "" } = {}) {
  const decision = String(row.decision || "")
    .trim()
    .toLowerCase();
  const userId = row.user_id;

  if (
    !userId &&
    decision !== "offboard" &&
    decision !== "snooze" &&
    !isNeverAgainDecision(decision)
  ) {
    throw new Error("missing user_id");
  }

  if (decision === "renew") return applyRenew(row, { dryRun });
  if (decision === "offboard") return applyOffboard(row, { dryRun });
  if (isNeverAgainDecision(decision)) {
    return applyOffboard(row, { dryRun, neverAgain: true });
  }
  if (decision === "upgrade") {
    return applyTierChange(row, { dryRun, direction: "upgrade" });
  }
  if (decision === "downgrade") {
    return applyTierChange(row, { dryRun, direction: "downgrade" });
  }
  if (decision === "snooze") return applySnooze(row, { dryRun });
  if (decision === "freeze") {
    return applyFreeze(row, { dryRun, freezeUntil });
  }

  throw new Error(`Unknown decision: ${decision}`);
}
