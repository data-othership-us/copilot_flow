import { config } from "../config.js";
import { getApplicantByEmail, markPromoted, promoteToCopilotDb } from "../lib/bq/applicants.js";
import { ensureCopilotDbColumns } from "../lib/bq/copilotDb.js";
import {
  getApplicantPageIdByEmail,
  getCopilotByEmail,
  listPendingOnboard,
  markApplicantOnboarded,
  updateCopilotByEmail,
} from "../lib/bq/copilotOps.js";
import {
  estimatedSeekerEnd,
  formatExpirationDate,
  sendLifecycleEmail,
} from "../lib/email/lifecycleEmail.js";
import {
  assignCopilotMembership,
  findLiveCopilotMembership,
} from "../lib/Membership/assignCopilotMembership.js";
import { enrichApplicantFromMt } from "../lib/mt/enrichApplicant.js";
import {
  findApplicationForReonboard,
  setApplicationStatus,
} from "../lib/notion/applications.js";
import { getOnboardingBlockers } from "../lib/nudge/onboardingNudge.js";
import { buildOfferLink } from "../lib/offerLink.js";
import {
  holdIfPreviouslyOffboarded,
  isNeverAgain,
  reonboardAllowsOnboard,
  resolveNeedsReview,
  wasPreviouslyOffboarded,
} from "../lib/onboard/priorOffboard.js";
import { ensureOnboardDiscount } from "../lib/onboard/ensureDiscount.js";
import {
  findExistingCopilotPromo,
  listTakenPromoCodes,
} from "../lib/onboard/existingPromo.js";
import {
  titleCaseTier,
} from "../lib/copilotIdentity.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function membershipEnd(live) {
  return (
    live?.attributes?.calculated_end_datetime ||
    live?.attributes?.end_datetime ||
    live?.attributes?.cancellation_datetime ||
    ""
  );
}

function recordDiscountSummary(summary, ensured) {
  if (ensured.created) summary.discountsCreated++;
  if (ensured.reactivated) summary.discountsReactivated++;
}

async function provisionPromo({
  email,
  row,
  existingPromo,
  takenCodes,
  tier,
  summary,
}) {
  const owned = Boolean(
    existingPromo?.promoCode ||
      existingPromo?.discountId ||
      row.promo_code ||
      row.discount_id
  );
  const via =
    existingPromo?.source === "stg_mt_discounts"
      ? ` (from MT stg_mt_discounts${existingPromo.name ? `: ${existingPromo.name}` : ""})`
      : existingPromo?.source === "copilot_db"
        ? " (from copilot_db)"
        : "";
  let igHandle = row.ig_handle || row.ig_url || "";
  if (!String(igHandle).trim()) {
    try {
      const applicant = await getApplicantByEmail(email);
      igHandle = applicant?.ig_handle || "";
    } catch (error) {
      console.warn(`   ⚠️  applicant IG lookup failed: ${error.message}`);
    }
  }
  const ensured = await ensureOnboardDiscount({
    firstName: row.first_name,
    lastName: row.last_name,
    email,
    promoCode: existingPromo?.promoCode || row.promo_code,
    discountId: existingPromo?.discountId || row.discount_id,
    tier,
    region: row.region,
    owned,
    takenCodes,
    igHandle,
    dryRun: config.dryRun,
  });
  if (via && owned) {
    console.log(`   ℹ️  existing promo${via}`);
  }
  recordDiscountSummary(summary, ensured);
  if (!config.dryRun) {
    const patch = { promo_code: ensured.promoCode };
    if (ensured.discountId) patch.discount_id = ensured.discountId;
    await updateCopilotByEmail(email, patch);
  }
  return ensured;
}

/**
 * Already has this person's promo code and a live Co-Pilot membership.
 * Stamp Onboarded; do not create a new code, membership, or welcome email.
 * Reactivate their voucher if offboard had expired it.
 */
async function finishAlreadyProvisioned({
  email,
  row,
  mt,
  userId,
  existingPromo,
  takenCodes,
  live,
  summary,
  tier,
}) {
  if (!config.dryRun) {
    await ensureCopilotDbRow({ email, row, mt, userId, tier: row.tier || tier });
  }

  const ensured = await provisionPromo({
    email,
    row,
    existingPromo,
    takenCodes,
    tier,
    summary,
  });
  const promoCode = ensured.promoCode;
  const discountId = ensured.discountId;

  const end = formatExpirationDate(membershipEnd(live));
  console.log(
    `   🎫 membership already live (${live.attributes?.membership_name || live.id}` +
      `${end ? `; ends ${end}` : ""})`
  );
  console.log(
    "   ✅ Already provisioned — would skip new code / membership / welcome email"
  );

  const existingRow = await getCopilotByEmail(email);
  if (config.dryRun) {
    console.log(
      existingRow
        ? "   (DRY_RUN: would set onboarded_at + Notion Onboarded)"
        : "   (DRY_RUN: would INSERT copilot_db + set onboarded_at + Notion Onboarded)"
    );
    summary.alreadyProvisioned++;
    summary.onboarded++;
    return;
  }

  const patch = {
    status: "active",
    user_id: userId || row.user_id || null,
    mt_email: mt.mtEmail || row.mt_email || null,
    mt_profile_link: mt.mtProfileLink || row.mt_profile_link || null,
    promo_code: promoCode,
    promoted_at: "NOW",
    onboarded_at: "NOW",
    offer_link: row.offer_link || buildOfferLink(promoCode),
  };
  if (discountId) patch.discount_id = String(discountId);

  await updateCopilotByEmail(email, patch);

  const notionPageId = await getApplicantPageIdByEmail(email);
  if (notionPageId) {
    await setApplicationStatus(notionPageId, config.notion.status.onboarded);
    await markApplicantOnboarded(notionPageId);
    console.log("   ✅ Notion → Onboarded");
  } else {
    console.log("   ⚠️  No applicant Notion page for this email");
  }
  summary.alreadyProvisioned++;
  summary.onboarded++;
}

async function ensureCopilotDbRow({ email, row, mt, userId, tier }) {
  const existing = await getCopilotByEmail(email);
  if (existing) return existing;

  const applicant = await getApplicantByEmail(email);
  const inserted = await promoteToCopilotDb({
    email,
    first_name: row.first_name || applicant?.first_name,
    last_name: row.last_name || applicant?.last_name,
    region: row.region || applicant?.region,
    tier: tier || row.tier || applicant?.tier || "Seeker",
    mt_user_id: userId || applicant?.mt_user_id,
    mt_email: mt.mtEmail || row.mt_email || applicant?.mt_email,
    mt_profile_link:
      mt.mtProfileLink || row.mt_profile_link || applicant?.mt_profile_link,
    ig_handle: applicant?.ig_handle,
    ig_url: applicant?.ig_url,
    ig_followers: applicant?.ig_followers,
    tiktok_handle: applicant?.tiktok_handle,
    tiktok_followers: applicant?.tiktok_followers,
    other_channels: applicant?.other_channels,
  });
  if (inserted === "inserted") {
    console.log("   ✅ Inserted into copilot_db");
  }
  const promotePageId = await getApplicantPageIdByEmail(email);
  if (promotePageId) await markPromoted(promotePageId);
  return getCopilotByEmail(email);
}

async function onboardOne(row, takenCodes, summary) {
  const email = String(row.contact_email || "").trim();
  const label = [row.first_name, row.last_name].filter(Boolean).join(" ") || email;
  console.log(`\n—— Onboard: ${label} <${email}> ——`);

  const mt = await enrichApplicantFromMt(email);
  await sleep(config.requestDelayMs);
  console.log(
    `   MT: account=${mt.mtAccountExists} user=${mt.mtUserId ?? "—"} cc=${mt.mtHasCc === null ? "?" : mt.mtHasCc}`
  );
  if (mt.mtAccountExists) {
    console.log("   👤 account: already exists — would not create an MT account");
  }

  if (isNeverAgain(row)) {
    console.log("   🚫 never again — skip onboard");
    summary.neverAgain++;
    return;
  }

  let notionApp = null;
  try {
    notionApp = await findApplicationForReonboard(email);
  } catch (error) {
    console.warn(`   ⚠️  Notion re-onboard lookup failed: ${error.message}`);
  }
  const needsReviewAction = await resolveNeedsReview(notionApp, row, {
    dryRun: config.dryRun,
    email,
  });
  if (needsReviewAction === "onboarded") {
    summary.alreadyProvisioned++;
    summary.onboarded++;
    return;
  }
  if (needsReviewAction === "evaluated") {
    summary.reonboardHold++;
    return;
  }

  const tier = titleCaseTier(row.tier || "Seeker");
  const userId = mt.mtUserId || row.user_id;
  const live = await findLiveCopilotMembership(userId);
  const existingPromo = await findExistingCopilotPromo({
    firstName: row.first_name,
    lastName: row.last_name,
    email,
    promoCode: row.promo_code,
    discountId: row.discount_id,
    tier,
  });
  let promoCode = existingPromo?.promoCode || "";
  let offerLink = String(row.offer_link || "").trim();

  if (promoCode && live) {
    await finishAlreadyProvisioned({
      email,
      row,
      mt,
      userId,
      existingPromo,
      takenCodes,
      live,
      summary,
      tier,
    });
    return;
  }

  const blockers = getOnboardingBlockers(mt);
  if (blockers.length) {
    console.log(`   🚧 Still blocked (${blockers.join(", ")}) — skip`);
    summary.blocked++;
    return;
  }

  if (wasPreviouslyOffboarded(row)) {
    if (!reonboardAllowsOnboard(notionApp?.reOnboard)) {
      const hold = await holdIfPreviouslyOffboarded(
        notionApp || { notionPageId: null, reOnboard: "" },
        row,
        { dryRun: config.dryRun }
      );
      if (hold.held) {
        console.log("   ⏸️  Previously offboarded — skip onboard");
        summary.reonboardHold++;
        return;
      }
    }
  }

  if (!config.dryRun) {
    await ensureCopilotDbRow({ email, row, mt, userId, tier });
  }

  const ensured = await provisionPromo({
    email,
    row,
    existingPromo,
    takenCodes,
    tier,
    summary,
  });
  promoCode = ensured.promoCode;

  const desiredLink = buildOfferLink(promoCode);
  if (desiredLink && offerLink !== desiredLink) {
    offerLink = desiredLink;
    if (!config.dryRun) {
      await updateCopilotByEmail(email, { offer_link: offerLink });
    }
    console.log(`   🔗 offer_link=${offerLink} (would write to copilot_db)`);
    summary.offerLinksWritten++;
  } else {
    console.log(`   ⏭️  offer_link already set`);
  }

  let expirationDate = "";
  if (live) {
    const endRaw =
      live.attributes?.calculated_end_datetime ||
      live.attributes?.end_datetime ||
      live.attributes?.cancellation_datetime;
    expirationDate = formatExpirationDate(endRaw);
    console.log(
      `   🎫 membership: already live (${live.attributes?.membership_name || live.id}` +
        `${expirationDate ? `; ends ${expirationDate}` : ""}) — would not assign another`
    );
    summary.membershipSkipped++;
  } else if (config.dryRun) {
    const preview = await assignCopilotMembership({
      userId,
      email,
      region: row.region,
      homeStudio: mt.mtHomeStudio,
      tier,
      dryRun: true,
    });
    expirationDate = formatExpirationDate(estimatedSeekerEnd());
    console.log(
      `   🎫 membership: would assign Co-Pilot ${tier}` +
        ` (product ${preview.childProductId || "?"}, region ${preview.region || row.region || "?"})` +
        `; estimated end ${expirationDate}`
    );
    summary.membershipsAssigned++;
  } else {
    const assigned = await assignCopilotMembership({
      userId,
      email,
      region: row.region,
      homeStudio: mt.mtHomeStudio,
      tier,
      dryRun: false,
    });
    if (assigned.skipped) {
      console.log(`   ⏭️  membership: ${assigned.skipped}`);
      summary.membershipSkipped++;
    } else {
      console.log(`   ✅ membership assigned (${assigned.membership?.checkoutId || "ok"})`);
      summary.membershipsAssigned++;
    }
    expirationDate = formatExpirationDate(estimatedSeekerEnd());
  }

  const patchIdentity = {
    status: "active",
    user_id: userId || row.user_id || null,
    mt_email: mt.mtEmail || row.mt_email || null,
    mt_profile_link: mt.mtProfileLink || row.mt_profile_link || null,
    tier,
  };

  if (!row.acceptance_emailed_at) {
    await sendLifecycleEmail({
      kind: "acceptance",
      email,
      mtEmail: mt.mtEmail || row.mt_email || null,
      firstName: row.first_name,
      lastName: row.last_name,
      tier,
      region: row.region,
      offerLink,
      promoCode,
      expirationDate,
      dryRun: config.dryRun,
      requireSend: !config.dryRun,
    });
    if (!config.dryRun) {
      patchIdentity.acceptance_emailed_at = "NOW";
    }
    summary.emailed++;
  } else {
    console.log("   ⏭️  acceptance already emailed");
    summary.emailSkipped++;
  }

  if (config.dryRun) {
    console.log("   (DRY_RUN: would set onboarded_at + Notion Onboarded)");
    summary.onboarded++;
    return;
  }

  patchIdentity.onboarded_at = "NOW";
  await updateCopilotByEmail(email, patchIdentity);

  const notionPageId = await getApplicantPageIdByEmail(email);
  if (notionPageId) {
    await setApplicationStatus(notionPageId, config.notion.status.onboarded);
    await markApplicantOnboarded(notionPageId);
    console.log("   ✅ Notion → Onboarded");
  } else {
    console.log("   ⚠️  No applicant Notion page for this email");
  }

  summary.onboarded++;
}

async function rowsFromEmails(emails) {
  const rows = [];
  for (const email of emails) {
    let copilot = null;
    try {
      copilot = await getCopilotByEmail(email);
    } catch (error) {
      console.warn(
        `   ⚠️  copilot_db lookup skipped for ${email}: ${error.message}`
      );
    }
    if (copilot) {
      rows.push(copilot);
      continue;
    }
    const app = await getApplicantByEmail(email);
    if (app) {
      rows.push({
        contact_email: app.email || email,
        first_name: app.first_name,
        last_name: app.last_name,
        region: app.region,
        tier: "Seeker",
        user_id: app.mt_user_id || app.user_id,
        mt_email: app.mt_email,
        promo_code: null,
        discount_id: null,
        offer_link: null,
        ig_handle: app.ig_handle,
        acceptance_emailed_at: null,
      });
      continue;
    }
    rows.push({
      contact_email: email,
      first_name: "",
      last_name: "",
      region: null,
      tier: "Seeker",
    });
  }
  return rows;
}

export async function onboardCopilots() {
  if (!config.bq.projectId) throw new Error("Missing BQ_PROJECT_ID");
  if (!config.mt.baseUrl || !config.mt.apiKey) {
    throw new Error("Missing MT_API_BASE_URL / MT_API_KEY");
  }

  const summary = {
    dryRun: config.dryRun,
    scanned: 0,
    onboarded: 0,
    blocked: 0,
    discountsCreated: 0,
    discountsReactivated: 0,
    offerLinksWritten: 0,
    membershipsAssigned: 0,
    membershipSkipped: 0,
    emailed: 0,
    emailSkipped: 0,
    alreadyProvisioned: 0,
    reonboardHold: 0,
    neverAgain: 0,
    failed: 0,
  };

  console.log("🚀 Co-Pilot onboard job");
  if (config.dryRun) {
    console.log("   DRY_RUN=1 — no writes to MT / BigQuery / Notion / email");
  }

  if (!config.dryRun) {
    await ensureCopilotDbColumns();
  }

  let rows;
  if (config.onboardEmails?.length) {
    rows = await rowsFromEmails(config.onboardEmails);
    console.log(
      `📋 ${rows.length} email(s) from ONBOARD_EMAILS (not the pending queue)`
    );
  } else {
    rows = await listPendingOnboard();
    if (config.onboardLimit > 0) {
      rows = rows.slice(0, config.onboardLimit);
      console.log(
        `📋 ${rows.length} pending onboard (ONBOARD_LIMIT=${config.onboardLimit})`
      );
    } else {
      console.log(`📋 ${rows.length} promoted row(s) pending onboard`);
    }
  }
  summary.scanned = rows.length;

  const takenCodes = await listTakenPromoCodes();

  for (const row of rows) {
    try {
      await onboardOne(row, takenCodes, summary);
    } catch (error) {
      console.warn(
        `   ⚠️  Onboard failed for ${row.contact_email}: ${error.message}`
      );
      summary.failed++;
    }
    await sleep(config.requestDelayMs);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Onboard summary");
  console.log("=".repeat(60));
  console.log(`   Scanned: ${summary.scanned}`);
  console.log(`   Onboarded: ${summary.onboarded}`);
  console.log(`   Already provisioned (code + live membership): ${summary.alreadyProvisioned}`);
  console.log(`   Blocked (no MT/CC): ${summary.blocked}`);
  console.log(
    `   Previously offboarded / Needs review → Evaluated: ${summary.reonboardHold}`
  );
  if (summary.neverAgain) {
    console.log(`   Never again — skipped: ${summary.neverAgain}`);
  }
  console.log(`   Discounts created: ${summary.discountsCreated}`);
  console.log(`   Discounts reactivated: ${summary.discountsReactivated}`);
  console.log(`   Offer links written: ${summary.offerLinksWritten}`);
  console.log(`   Memberships assigned: ${summary.membershipsAssigned}`);
  console.log(`   Membership skipped: ${summary.membershipSkipped}`);
  console.log(`   Acceptance emails: ${summary.emailed}`);
  console.log(`   Email already sent: ${summary.emailSkipped}`);
  console.log(`   Failed: ${summary.failed}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  onboardCopilots()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Onboard job failed:", error);
      process.exit(1);
    });
}
