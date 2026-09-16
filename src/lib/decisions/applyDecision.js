import { sendLifecycleEmail, formatExpirationDate } from "../email/lifecycleEmail.js";
import {
  deactivateCopilotDiscount,
  patchCopilotDiscount,
} from "../Discount/patchCopilotDiscount.js";
import {
  assignCopilotMembership,
  copilotMembershipEndAt,
  findLiveCopilotMembership,
  freezeLiveCopilotMembership,
  listMembershipsForUser,
  pickLiveCopilotMembership,
  pickStackedCopilotMembership,
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
  patchReviewDecisionNotes,
  withPaymentNudgeNote,
  withResubmitHandlesEmailedNote,
  RESUBMIT_HANDLES_EMAILED_NOTE,
} from "../sheets/evaluationSheet.js";
import { updateCopilotByEmail, getCopilotByEmail, getCopilotCycleStats } from "../bq/copilotOps.js";
import {
  assertValidPaymentMethod,
  isPaymentMethodError,
} from "../mt/bankcards.js";
import { igProfileUrl, storedIgHandle } from "../instagram.js";
import { buildOfferLink } from "../offerLink.js";
import { listTakenPromoCodes } from "../onboard/existingPromo.js";
import {
  hasPaymentNudgeBeenSent,
  sendPaymentMethodNudge,
  coerceTimestamp,
} from "../nudge/paymentMethodNudge.js";
import { sendResubmitHandlesEmail } from "../email/resubmitHandlesEmail.js";

export { isPaymentNudgeHold } from "../nudge/paymentMethodNudge.js";

export function isSocialNudgeHold(result) {
  return String(result || "").startsWith("nudged_social");
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function isExpiryHold(result) {
  return result === "held_until_expiry";
}

function describeLiveMembership(live) {
  if (!live?.id) return "none";
  const a = live.attributes || {};
  const end =
    a.calculated_end_datetime || a.end_datetime || a.end_date || "?";
  return `${a.membership_name || "Co-Pilot"} #${live.id} status=${a.status || "?"} end=${end}`;
}

function defaultFreezeUntil() {
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
  return d;
}

function emailFields(row, extra = {}) {
  return {
    email: row.contact_email,
    mtEmail: row.mt_email,
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
  const cycleKinds = new Set(["renewal", "upgrade", "downgrade", "offboard"]);
  const cycle =
    cycleKinds.has(kind) && extra.cyclePoints == null
      ? await getCopilotCycleStats(row.contact_email)
      : null;
  const result = await sendLifecycleEmail({
    kind,
    requireSend: !dryRun,
    ...emailFields(row, extra),
    cyclePoints: extra.cyclePoints ?? cycle?.cycle_points,
    socialRequirementMet:
      extra.socialRequirementMet ?? cycle?.social_requirement_met,
  });
  if (!dryRun && !result.sent && result.channel !== "invalid_to") {
    throw new Error(
      `${kind} email was not sent to ${row.contact_email} (${result.channel})`
    );
  }
  return result;
}

/**
 * Assign a Co-Pilot term of `tier`. Never terminates a live term.
 * If a live membership still has more than a day left, wait until last day.
 * On expiry day (or after), add a new membership starting now.
 * Idempotent when a stacked term of that tier already exists after decision_at.
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
  const instances = userId ? await listMembershipsForUser(userId) : [];
  const stacked = pickStackedCopilotMembership(instances, {
    tier,
    decisionAt,
  });
  if (stacked) {
    console.log(
      `   ⏭️  already on ${tier} term starting ${describeLiveMembership(stacked)}`
    );
    return { skipped: "already_on_target_term", membership: stacked };
  }

  const live = pickLiveCopilotMembership(instances);

  const endAt = copilotMembershipEndAt(live);
  const expiringToday =
    Boolean(live?.id) &&
    endAt &&
    endAt.getTime() <= Date.now() + ONE_DAY_MS;
  if (live?.id && !expiringToday) {
    console.log(
      `   ⏳ hold until last day — ${describeLiveMembership(live)}`
    );
    return { skipped: "held_until_expiry", membership: live };
  }

  await assertValidPaymentMethod(userId);

  if (dryRun) {
    if (live?.id) {
      console.log(
        `   (DRY_RUN: would leave ${describeLiveMembership(live)} and assign ${tier} starting now)`
      );
    } else {
      console.log(`   (DRY_RUN: would assign ${tier} starting now)`);
    }
    return { skipped: "dry_run" };
  }

  if (live?.id) {
    console.log(
      `   ⏳ leave ${describeLiveMembership(live)}; assign ${tier} starting now`
    );
  }

  return assignCopilotMembership({
    userId,
    email,
    region,
    homeStudio,
    tier,
    allowAlongsideExpiring: Boolean(live?.id),
    dryRun: false,
  });
}

async function stampPaymentNudgeNote(row) {
  const notes = withPaymentNudgeNote(row.decision_notes);
  row.decision_notes = notes;
  await updateCopilotByEmail(row.contact_email, {
    decision_notes: notes,
  });
  const patched = await patchReviewDecisionNotes(row.contact_email, notes);
  if (patched) {
    console.log(`   📝 Review notes: ${notes}`);
  } else {
    console.warn(
      `   ⚠️  Review row not found to stamp notes for ${row.contact_email}`
    );
  }
}

async function holdForPaymentMethod(row, { dryRun, decision }) {
  console.log(
    `   🚧 No valid payment method on file — holding ${decision} until a card is added`
  );

  if (hasPaymentNudgeBeenSent(row)) {
    const last = coerceTimestamp(row.payment_nudge_at);
    console.log(
      "   ⏭️  payment nudge already sent" +
        `${last ? ` ${last.toISOString()}` : ""} — keep Review row`
    );
    return "nudged_payment_method:already_sent";
  }

  const result = await sendPaymentMethodNudge({
    email: row.contact_email,
    mtEmail: row.mt_email,
    firstName: row.first_name,
    lastName: row.last_name,
    decision,
    dryRun,
    requireSend: !dryRun,
  });

  if (!dryRun) {
    if (!result?.sent && result?.channel !== "invalid_to") {
      throw new Error(
        `payment-method nudge was not sent to ${row.contact_email} (${result?.channel})`
      );
    }
    if (result?.sent) {
      await updateCopilotByEmail(row.contact_email, {
        payment_nudge_at: "NOW",
      });
      await stampPaymentNudgeNote(row);
    }
  } else {
    console.log(
      `   (DRY_RUN: would stamp Review notes "${withPaymentNudgeNote(row.decision_notes)}")`
    );
  }

  return "nudged_payment_method";
}

async function withPaymentMethodFallback(row, { dryRun, decision, run }) {
  try {
    return await run();
  } catch (error) {
    if (!isPaymentMethodError(error)) throw error;
    return holdForPaymentMethod(row, { dryRun, decision });
  }
}

async function applyRenew(row, { dryRun }) {
  return withPaymentMethodFallback(row, {
    dryRun,
    decision: "renew",
    run: async () => {
      const tier = titleCaseTier(row.tier || "Seeker");
      const result = await ensureCopilotTerm({
        userId: row.user_id,
        email: row.contact_email,
        region: row.region,
        homeStudio: row.home_studio,
        tier,
        decisionAt: row.decision_at,
        dryRun,
      });
      if (
        result.skipped &&
        result.skipped !== "already_on_target_term" &&
        result.skipped !== "dry_run"
      ) {
        console.log(`   ⏭️  renew membership: ${result.skipped}`);
      }
      if (result.skipped === "held_until_expiry") return "held_until_expiry";

      const termStart = result.startAt || new Date();
      const end = formatExpirationDate(estimatedTermEnd(tier, termStart));

      await notifyCopilot(row, "renewal", {
        tier,
        expirationDate: end,
        dryRun,
      });

      if (!dryRun) {
        await updateCopilotByEmail(row.contact_email, {
          status: "active",
          decision_applied_at: "NOW",
          payment_nudge_at: null,
        });
      }
      return "renewed";
    },
  });
}

async function applyOnboard(row, { dryRun }) {
  return withPaymentMethodFallback(row, {
    dryRun,
    decision: "onboard",
    run: async () => {
      const tier = titleCaseTier(row.tier || "Seeker");
      const result = await ensureCopilotTerm({
        userId: row.user_id,
        email: row.contact_email,
        region: row.region,
        homeStudio: row.home_studio,
        tier,
        decisionAt: row.decision_at,
        dryRun,
      });
      if (
        result.skipped &&
        result.skipped !== "already_on_target_term" &&
        result.skipped !== "dry_run"
      ) {
        console.log(`   ⏭️  onboard membership: ${result.skipped}`);
      }
      if (result.skipped === "held_until_expiry") return "held_until_expiry";

      const termStart = result.startAt || new Date();
      const end = formatExpirationDate(estimatedTermEnd(tier, termStart));

      await notifyCopilot(row, "acceptance", {
        tier,
        expirationDate: end,
        dryRun,
      });

      if (!dryRun) {
        await updateCopilotByEmail(row.contact_email, {
          status: "active",
          onboarded_at: "NOW",
          acceptance_emailed_at: "NOW",
          decision_applied_at: "NOW",
          payment_nudge_at: null,
        });
      }
      return "onboarded";
    },
  });
}

async function applyOffboard(row, { dryRun, neverAgain = false }) {
  const tier = titleCaseTier(row.tier || "Seeker");
  const promoLabel = String(row.promo_code || "").trim() || "?";
  if (dryRun) {
    const live = row.user_id
      ? await findLiveCopilotMembership(row.user_id)
      : null;
    console.log(
      `   (DRY_RUN: would leave ${describeLiveMembership(live)} through expiry, set status=inactive` +
        `${neverAgain ? ", never_again=TRUE" : ""}` +
        `, deactivate discount ${promoLabel}` +
        `${row.discount_id ? ` id=${row.discount_id}` : ""})`
    );
  } else {
    if (row.user_id) {
      const live = await findLiveCopilotMembership(row.user_id);
      if (live?.id) {
        console.log(
          `   ⏳ leave live membership through expiry: ${describeLiveMembership(live)}`
        );
      } else {
        console.log("   ⏳ no live Co-Pilot membership to leave in place");
      }
    }
    const deactivated = await deactivateCopilotDiscount({
      discountId: row.discount_id,
      promoCode: row.promo_code,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.contact_email,
      tier: row.tier,
    });
    if (deactivated.skipped === "already_inactive") {
      console.log(
        `   💤 discount ${promoLabel} id=${deactivated.discountId} already inactive`
      );
    } else if (deactivated.skipped) {
      console.log(`   ⚠️  skip discount deactivate: ${deactivated.skipped}`);
    } else {
      console.log(
        `   💤 discount ${promoLabel} id=${deactivated.discountId} inactive`
      );
    }
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

  return withPaymentMethodFallback(row, {
    dryRun,
    decision: direction,
    run: async () => {
      const result = await ensureCopilotTerm({
        userId: row.user_id,
        email: row.contact_email,
        region: row.region,
        homeStudio: row.home_studio,
        tier: newTier,
        decisionAt: row.decision_at,
        dryRun,
      });
      if (
        result.skipped &&
        result.skipped !== "already_on_target_term" &&
        result.skipped !== "dry_run"
      ) {
        console.log(`   ⏭️  ${direction} membership: ${result.skipped}`);
      }
      if (result.skipped === "held_until_expiry") return "held_until_expiry";
      const termStart = result.startAt || new Date();
      const end = formatExpirationDate(estimatedTermEnd(newTier, termStart));
      if (dryRun && row.discount_id && row.promo_code) {
        console.log(
          `   (DRY_RUN: would patch discount ${row.promo_code} → ${newTier})`
        );
      } else if (!dryRun && row.discount_id && row.promo_code) {
        await patchCopilotDiscount({
          discountId: row.discount_id,
          promoCode: row.promo_code,
          tier: newTier,
          region: row.region,
          firstName: row.first_name,
          lastName: row.last_name,
        });
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
          payment_nudge_at: null,
        });
      }
      return `${direction}d:${newTier}`;
    },
  });
}

async function applySnooze(row, { dryRun }) {
  if (dryRun) {
    console.log(
      "   (DRY_RUN: would stamp decision_applied_at; hide from Review for 3 months)"
    );
  } else {
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

  if (dryRun) {
    const live = await findLiveCopilotMembership(row.user_id);
    if (!live?.id) {
      throw new Error(
        "no live Co-Pilot membership to freeze — use snooze for copilots without a Co-Pilot membership"
      );
    }
    const status = String(live.attributes?.status || "").toLowerCase();
    if (status === "frozen") {
      console.log(`   ⏭️  freeze: already_frozen`);
    } else {
      console.log(
        `   (DRY_RUN: would freeze ${describeLiveMembership(live)} until ${freezeDate})`
      );
    }
  } else {
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

function fieldEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function namesEqual(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

async function applySocial(row, { dryRun }) {
  const existing = String(row.decision_notes || "");
  const alreadySent = existing
    .toLowerCase()
    .includes(RESUBMIT_HANDLES_EMAILED_NOTE);
  const notes = withResubmitHandlesEmailedNote(existing);

  if (alreadySent) {
    console.log("   ⏭️  social nudge already sent — waiting on a public handle");
    return "nudged_social:already_sent";
  }

  const result = await sendResubmitHandlesEmail({
    email: row.contact_email,
    mtEmail: row.mt_email,
    firstName: row.first_name,
    lastName: row.last_name,
    dryRun,
    requireSend: !dryRun,
  });

  if (dryRun) {
    console.log(`   (DRY_RUN: would stamp Review notes "${notes}")`);
    return "nudged_social";
  }

  if (!result?.sent && result?.channel !== "invalid_to") {
    throw new Error(
      `social nudge was not sent to ${row.contact_email} (${result?.channel})`
    );
  }

  if (!result?.sent) return "nudged_social";

  row.decision_notes = notes;
  try {
    await updateCopilotByEmail(row.contact_email, {
      decision_notes: notes,
    });
    const patched = await patchReviewDecisionNotes(row.contact_email, notes);
    if (patched) {
      console.log(`   📝 Review notes: ${notes}`);
    } else {
      console.warn(
        `   ⚠️  Review row not found to stamp notes for ${row.contact_email}`
      );
    }
  } catch (error) {
    console.warn(
      `   ⚠️  social email sent but could not stamp notes: ${error.message}`
    );
  }
  return "nudged_social";
}

async function applyUpdate(row, { dryRun, patch = {} }) {
  const lookupEmail = fieldEmail(row.contact_email);
  const fields = {};
  const changes = [];

  const newEmail = fieldEmail(patch.newEmail);
  if (newEmail && newEmail !== lookupEmail) {
    const taken = await getCopilotByEmail(newEmail);
    if (taken) {
      throw new Error(`new_email already in copilot_db: ${newEmail}`);
    }
    fields.contact_email = newEmail;
    changes.push(`contact_email ${lookupEmail} → ${newEmail}`);
  }

  const firstName = String(patch.firstName || "").trim();
  if (firstName && !namesEqual(firstName, row.first_name)) {
    fields.first_name = firstName;
    changes.push(`first_name → ${firstName}`);
  }
  const lastName = String(patch.lastName || "").trim();
  if (lastName && !namesEqual(lastName, row.last_name)) {
    fields.last_name = lastName;
    changes.push(`last_name → ${lastName}`);
  }

  const mtEmail = fieldEmail(patch.mtEmail);
  if (mtEmail && mtEmail !== fieldEmail(row.mt_email)) {
    fields.mt_email = mtEmail;
    changes.push(`mt_email ${fieldEmail(row.mt_email) || "(none)"} → ${mtEmail}`);
  }

  const igRaw = String(patch.igHandle || patch.igUrl || "").trim();
  if (igRaw) {
    const nextHandle = storedIgHandle(igRaw);
    const curHandle = storedIgHandle(row.ig_handle || row.ig_url || "");
    if (nextHandle && nextHandle !== curHandle) {
      fields.ig_handle = nextHandle;
      fields.ig_url = igProfileUrl(igRaw) || null;
      changes.push(`ig_handle → ${nextHandle.replace(/\n/g, ", ")}`);
    }
  }

  const promo = String(patch.promoCode || "")
    .trim()
    .toUpperCase();
  const currentPromo = String(row.promo_code || "")
    .trim()
    .toUpperCase();
  if (promo && promo !== currentPromo) {
    const taken = await listTakenPromoCodes();
    if (taken.has(promo)) {
      throw new Error(`promo_code already used: ${promo}`);
    }
    fields.promo_code = promo;
    fields.offer_link = buildOfferLink(promo);
    changes.push(`promo_code ${currentPromo || "(none)"} → ${promo}`);
  }

  if (!changes.length) {
    console.log("   ⏭️  All update fields already match copilot_db — nothing to change");
    await updateCopilotByEmail(lookupEmail, { decision_applied_at: "NOW" });
    return "updated:no_changes";
  }

  if (dryRun) {
    console.log(`   (DRY_RUN: would update ${changes.join("; ")})`);
    if (fields.promo_code && row.discount_id) {
      console.log(
        `   (DRY_RUN: would patch MT discount ${row.discount_id} code → ${fields.promo_code})`,
      );
    }
    return "updated";
  }

  if (fields.contact_email) {
    console.log(
      "   ℹ️  Also change this email on the ops tracker sheet so sync does not recreate the old row",
    );
  }

  if (fields.promo_code && row.discount_id) {
    await patchCopilotDiscount({
      discountId: row.discount_id,
      promoCode: fields.promo_code,
      tier: row.tier,
      region: row.region,
      firstName: fields.first_name || row.first_name,
      lastName: fields.last_name || row.last_name,
    });
  }

  await updateCopilotByEmail(lookupEmail, {
    ...fields,
    decision_applied_at: "NOW",
  });
  return `updated:${changes.join("; ")}`;
}

export async function applyCopilotDecision(row, { dryRun = false, freezeUntil = "", patch = {} } = {}) {
  const decision = String(row.decision || "")
    .trim()
    .toLowerCase();
  const userId = row.user_id;

  if (
    !userId &&
    decision !== "offboard" &&
    decision !== "snooze" &&
    decision !== "update" &&
    decision !== "social" &&
    !isNeverAgainDecision(decision)
  ) {
    throw new Error("missing user_id");
  }

  if (decision === "onboard") return applyOnboard(row, { dryRun });
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
  if (decision === "update") return applyUpdate(row, { dryRun, patch });
  if (decision === "social") return applySocial(row, { dryRun });

  throw new Error(`Unknown decision: ${decision}`);
}
