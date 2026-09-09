import {
  config,
  assertEvaluateApplicationsConfig,
  resolveRejectionCreditId,
  sleep,
} from "../config.js";
import {
  hasPriorApplicationByEmail,
  isAcceptedActionEligible,
  isPipelineEligible,
  isPromotedToCopilotDb,
  markAcceptedBefore,
  markPromoted,
  markRejectionCreditApplied,
  markRejectionEmailed,
  listRejectedPendingCreditFromBq,
  promoteToCopilotDb,
  ensurePrePipelineColumn,
  getApplicantByNotionPageId,
  statusRank,
  syncApplicantStatusFromNotion,
  upsertApplicant,
} from "../lib/bq/applicants.js";
import { ensureCopilotDbColumns } from "../lib/bq/copilotDb.js";
import {
  getCopilotByEmail,
  markApplicantOnboarded,
  updateCopilotByEmail,
} from "../lib/bq/copilotOps.js";
import {
  clearAdvancedStepsInNotion,
  clearOnboardingNudgeInNotion,
  listAcceptedApplications,
  listDuplicateApplications,
  listOnboardedApplications,
  listEvaluatedApplications,
  listNewApplications,
  listRejectedApplications,
  partitionNewestByEmail,
  markDuplicateApplication,
  markOlderDuplicatesForEmail,
  setApplicationStatus,
  addApplicationComment,
  writeEnrichmentToNotion,
  writeOnboardingNudgeToNotion,
} from "../lib/notion/applications.js";
import { getQualificationIcon } from "../lib/notion/parseProps.js";
import { enrichApplicantFromMt } from "../lib/mt/enrichApplicant.js";
import { applyMtCredit } from "../lib/mt/applyCredit.js";
import { sendRejectionEmail } from "../lib/email/rejectionEmail.js";
import {
  formatNudgeReason,
  getOnboardingBlockers,
  sendOnboardingNudge,
} from "../lib/nudge/onboardingNudge.js";
import {
  enrichInstagramProfilesBatch,
  normalizeInstagramHandle,
} from "../lib/social/enrichProfile.js";
import { findLiveCopilotMembership } from "../lib/Membership/assignCopilotMembership.js";
import { buildOfferLink } from "../lib/offerLink.js";
import { findExistingCopilotPromo } from "../lib/onboard/existingPromo.js";
import {
  holdIfPreviouslyOffboarded,
  isNeverAgain,
  prepareCopilotForReonboard,
  refuseNeverAgainApplication,
  resolveNeedsReview,
} from "../lib/onboard/priorOffboard.js";

/**
 * Skip sending another nudge while Last Nudged is within NUDGE_COOLDOWN_DAYS.
 * Needs Nudge is an ops flag, not proof an email went out.
 */
function isNudgeOnCooldown(app) {
  const raw = app?.lastNudged;
  if (!raw) return false;
  const last = new Date(raw);
  if (Number.isNaN(last.getTime())) return false;
  const days = Number(config.nudgeCooldownDays) || 3;
  return Date.now() - last.getTime() < days * 24 * 60 * 60 * 1000;
}

/** True when copilot_db already has a promo code or an MT identity. */
function isCopilotProvisioned(copilot) {
  if (!copilot) return false;
  const promo = String(copilot.promo_code || "").trim();
  const userId = String(copilot.user_id || "").trim();
  const mtEmail = String(copilot.mt_email || "").trim();
  return Boolean(promo || userId || mtEmail);
}

function reclaimLookbackIsoDate() {
  const days = Number(config.reclaimOnboardedLookbackDays);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return since.toISOString().slice(0, 10);
}

/**
 * Pass 1b: Notion Onboarded with no promo and no MT identity.
 * Pipeline cards → Evaluated (ops reviews again; this job does not Accept).
 * Cards with no BQ row → No Status so they can be enriched.
 * Historical cutoff is left alone.
 */
async function processReclaimIncompleteOnboarded(summary) {
  const editedOnOrAfter = reclaimLookbackIsoDate();
  const cards = await listOnboardedApplications({ editedOnOrAfter });
  summary.reclaimOnboardedScanned = cards.length;
  const window = editedOnOrAfter
    ? `edited on/after ${editedOnOrAfter}`
    : "all Onboarded";
  console.log(
    `\n📋 Reclaim incomplete Onboarded (${window}): ${cards.length} card(s)`
  );

  for (const app of cards) {
    const label = app.fullName || app.email || app.notionPageId;
    const applicant = await getApplicantByNotionPageId(app.notionPageId);
    if (applicant?.pre_pipeline === true || applicant?.accepted_before === true) {
      summary.reclaimOnboardedSkipped++;
      continue;
    }

    const copilot = app.email ? await getCopilotByEmail(app.email) : null;
    if (isCopilotProvisioned(copilot)) {
      summary.reclaimOnboardedLeft++;
      continue;
    }

    const targetStatus = applicant
      ? config.notion.status.evaluated
      : config.notion.status.new;
    console.log(
      `   ↩️  ${label} — Onboarded but no promo / MT identity → ${targetStatus}`
    );
    if (config.dryRun) {
      console.log(
        `   (DRY_RUN: would move Notion → ${targetStatus} and add a page comment)`
      );
      summary.reclaimOnboarded++;
      continue;
    }

    await setApplicationStatus(app.notionPageId, targetStatus);
    if (applicant) {
      await syncApplicantStatusFromNotion({
        notionPageId: app.notionPageId,
        notionStatus: targetStatus,
        clearAdvanced: true,
      });
    }
    if (targetStatus === config.notion.status.evaluated) {
      await clearAdvancedStepsInNotion(app.notionPageId);
    }
    if (copilot?.onboarded_at && app.email) {
      await updateCopilotByEmail(app.email, { onboarded_at: null });
    }
    try {
      await addApplicationComment(
        app.notionPageId,
        targetStatus === config.notion.status.new
          ? "Moved back from Onboarded to No Status — no applicant record, no Mariana Tek identity, and no promo code. The daily job will re-enrich this card."
          : "Moved back from Onboarded to Evaluated — no Mariana Tek identity and no promo code on file. Onboarded is only for people who are actually provisioned. Review and Accept again if they should continue."
      );
    } catch (error) {
      console.warn(`   ⚠️  Page comment failed: ${error.message}`);
    }
    summary.reclaimOnboarded++;
  }
}

/**
 * Already provisioned (promo code AND live Co-Pilot membership), including
 * people ops onboarded by hand who are not in copilot_db yet.
 * Insert if missing, stamp onboarded — do not create a second membership/email.
 */
async function stampOnboardedIfAlreadyProvisioned(app, email, userId, mt = null) {
  let copilot = await getCopilotByEmail(email);

  const existingPromo = await findExistingCopilotPromo({
    firstName: copilot?.first_name || app.firstName,
    lastName: copilot?.last_name || app.lastName,
    email,
    promoCode: copilot?.promo_code,
    discountId: copilot?.discount_id,
    tier: copilot?.tier || "Seeker",
  });
  const promo = String(existingPromo?.promoCode || "").trim();
  if (!promo) return false;

  const uid = userId || copilot?.user_id;
  const live = await findLiveCopilotMembership(uid);
  if (!live) {
    console.log(
      `   ℹ️  Has promo ${promo} but no live Co-Pilot membership — onboard job will assign`
    );
    return false;
  }
  if (copilot?.onboarded_at) return true;

  if (config.dryRun) {
    console.log(
      copilot
        ? `   (DRY_RUN: would mark Onboarded — promo ${promo} + live Co-Pilot membership)`
        : `   (DRY_RUN: would INSERT copilot_db + mark Onboarded — promo ${promo} + live Co-Pilot membership)`
    );
    return true;
  }

  if (!copilot) {
    await promoteToCopilotDb({
      email,
      first_name: app.firstName,
      last_name: app.lastName,
      region: app.region,
      tier: "Seeker",
      mt_user_id: uid,
      mt_email: mt?.mtEmail,
      mt_profile_link: mt?.mtProfileLink,
      ig_handle: app.igHandle || null,
      ig_url: app.igUrl || null,
      ig_followers: app.igFollowers ?? null,
      tiktok_handle: app.tiktokHandle || null,
      tiktok_followers: app.tiktokFollowers ?? null,
      other_channels: app.otherChannels || null,
    });
    if (app.notionPageId) await markPromoted(app.notionPageId);
    copilot = await getCopilotByEmail(email);
  }

  const offerLink = buildOfferLink(promo);
  const patch = {
    onboarded_at: "NOW",
    promoted_at: "NOW",
    promo_code: promo,
  };
  if (existingPromo.discountId) patch.discount_id = existingPromo.discountId;
  if (offerLink && !String(copilot?.offer_link || "").trim()) {
    patch.offer_link = offerLink;
  }
  await updateCopilotByEmail(email, patch);
  if (app.notionPageId) {
    await setApplicationStatus(app.notionPageId, config.notion.status.onboarded);
    await markApplicantOnboarded(app.notionPageId);
  }
  console.log(
    `   ✅ Promo ${promo} + live Co-Pilot membership — Notion Onboarded (skip onboard job)`
  );
  return true;
}

/**
 * Sync Notion Status → BQ. If card moved backward to Evaluated / No Status,
 * clear advanced Notion flags (nudge/credit) and BQ promoted_at.
 */
async function reconcileOneApplication(app, summary) {
  const label = app.fullName || app.email || app.notionPageId;
  const notionStatus = app.status || "";
  const bqRow = await getApplicantByNotionPageId(app.notionPageId);
  const bqStatus = bqRow?.application_status || "";
  const movedBack =
    Boolean(bqRow) && statusRank(notionStatus) < statusRank(bqStatus);
  const resetLane = statusRank(notionStatus) <= 1; // No Status / Evaluated
  const hasAdvancedNotion =
    Boolean(app.needsNudge) ||
    Boolean(app.lastNudged) ||
    Boolean(app.creditApplied);
  const shouldClear =
    resetLane && (movedBack || hasAdvancedNotion || Boolean(bqRow?.promoted_at));

  if (config.dryRun) {
    if (shouldClear) {
      console.log(
        `   (DRY_RUN: would sync status "${notionStatus}"` +
          `${bqStatus ? ` (was BQ "${bqStatus}")` : ""} + clear advanced steps) — ${label}`
      );
      summary.statusCleared++;
    } else if (!bqRow || String(bqStatus).toLowerCase() !== String(notionStatus).toLowerCase()) {
      console.log(
        `   (DRY_RUN: would sync status → "${notionStatus}") — ${label}`
      );
      summary.statusSynced++;
    } else {
      summary.statusUnchanged++;
    }
    return;
  }

  try {
    const result = await syncApplicantStatusFromNotion({
      notionPageId: app.notionPageId,
      notionStatus,
      clearAdvanced: shouldClear,
    });
    if (shouldClear) {
      await clearAdvancedStepsInNotion(app.notionPageId);
      console.log(
        `   ↩️  Synced "${notionStatus}" + cleared advanced steps — ${label}`
      );
      summary.statusCleared++;
    } else if (result === "updated" || result === "inserted") {
      console.log(`   🔄 Synced status → "${notionStatus}" — ${label}`);
      summary.statusSynced++;
    } else {
      summary.statusUnchanged++;
    }
  } catch (error) {
    console.warn(`   ⚠️  Status sync failed for ${label}: ${error.message}`);
    summary.statusSyncFailed++;
  }
}

/**
 * Pass 0: reconcile Notion Status with BQ + clear demoted advanced steps.
 * Scans No Status + Evaluated + Accepted + Rejected + Duplicate.
 */
async function processStatusReconcile(summary) {
  console.log("\n📋 Status reconcile (Notion → BQ, clear demotions)");
  const [fresh, evaluated, accepted, rejected, duplicates] = await Promise.all([
    listNewApplications(),
    listEvaluatedApplications(),
    listAcceptedApplications(),
    listRejectedApplications(),
    listDuplicateApplications(),
  ]);

  const byId = new Map();
  for (const app of [
    ...fresh,
    ...evaluated,
    ...accepted,
    ...rejected,
    ...duplicates,
  ]) {
    byId.set(app.notionPageId, app);
  }
  const unique = [...byId.values()];
  summary.statusScanned = unique.length;
  console.log(`   Scanning ${unique.length} Notion page(s) across active statuses`);

  for (const app of unique) {
    await reconcileOneApplication(app, summary);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function emptySocial() {
  return {
    instagramFollowersScraped: null,
    instagramIsPublic: null,
    instagramVerified: null,
    instagramIsBusiness: null,
    instagramFullName: null,
    instagramBiography: null,
    instagramPostsCount: null,
    instagramFollowsCount: null,
    instagramExternalUrl: null,
    instagramBusinessCategory: null,
    instagramCountry: null,
    instagramProfileUrl: null,
    error: null,
  };
}

function logSocial(social) {
  if (social.error) {
    console.log(`   ⚠️  Social enrichment: ${social.error}`);
    return;
  }
  if (social.instagramFollowersScraped != null) {
    console.log(
      `   Social: followers=${social.instagramFollowersScraped} public=${social.instagramIsPublic} verified=${social.instagramVerified ?? "?"} business=${social.instagramIsBusiness ?? "?"}`
    );
    return;
  }
  console.log("   Social: no follower count returned");
}

function tallyIcon(summary, icon) {
  if (icon === "🟢") summary.highlyQualified++;
  if (icon === "🟡") summary.partiallyQualified++;
  if (icon === "🔴") summary.followerLies++;
}

function logSaved(icon, { reevaluate = false } = {}) {
  const verb = reevaluate
    ? "Re-enriched"
    : "Saved to BigQuery and moved Notion → Evaluated";
  if (icon === "🟢") {
    console.log(`   ✅ ${verb} (🟢 fully qualified)`);
  } else if (icon === "🟡") {
    console.log(`   ✅ ${verb} (🟡 social OK, missing MT/CC)`);
  } else if (icon === "🔴") {
    console.log(`   ✅ ${verb} (🔴 under ${config.qualifiedMinFollowers} followers or mismatch)`);
  } else {
    console.log(`   ✅ ${verb}`);
  }
}

/**
 * Enrich one application (MT + social map lookup) and write Notion (+ BQ when possible).
 * @param {object} options
 * @param {boolean} [options.previousApplication]
 * @param {boolean} [options.reevaluate]
 * @param {boolean} [options.keepNotionStatus] — do not change Notion Status
 * @param {string} [options.bqApplicationStatus] — BQ application_status value
 * @param {boolean} [options.acceptedBefore] — historical Accepted marker
 * @param {boolean} [options.prePipeline] — BQ pre_pipeline (default false)
 * @param {string} [options.statusName] — Notion Status to set (default Evaluated)
 * @param {boolean} [options.neverConsider]
 */
async function enrichOneApplication(app, socialByHandle, summary, options = {}) {
  const {
    previousApplication = false,
    reevaluate = false,
    keepNotionStatus = false,
    bqApplicationStatus = "evaluated",
    acceptedBefore = false,
    prePipeline = false,
    statusName,
    neverConsider,
  } = options;

  let mt = {
    mtAccountExists: false,
    mtUserId: null,
    mtEmail: null,
    mtClassCount: null,
    mtHasCc: null,
    mtHomeStudio: null,
    mtProfileLink: null,
  };

  if (app.email) {
    console.log(`   🔍 MT lookup: ${app.email}`);
    mt = await enrichApplicantFromMt(app.email);
    await sleep(config.requestDelayMs);
    console.log(
      `   MT: account=${mt.mtAccountExists} user=${mt.mtUserId ?? "—"} classes=${mt.mtClassCount ?? "?"} cc=${mt.mtHasCc === null ? "?" : mt.mtHasCc} studio=${mt.mtHomeStudio ?? "?"}`
    );
    if (mt.mtProfileLink) {
      console.log(`   MT profile: ${mt.mtProfileLink}`);
    }
  }

  let social = emptySocial();
  if (app.instagramHandle && config.social.provider !== "none") {
    const key = normalizeInstagramHandle(app.instagramHandle);
    social = socialByHandle.get(key) || emptySocial();
    console.log(`   🔍 Social lookup: @${key}`);
    logSocial(social);
  }

  const icon = getQualificationIcon({
    followers: social.instagramFollowersScraped,
    formFollowers: app.instagramFollowersForm,
    isPublic: social.instagramIsPublic,
    mtAccountExists: mt.mtAccountExists,
    mtHasCc: mt.mtHasCc,
    minFollowers: config.qualifiedMinFollowers,
  });

  if (config.dryRun) {
    const pageName = [app.firstName, app.lastName].filter(Boolean).join(" ");
    console.log(
      `   (DRY_RUN: would ${reevaluate ? "refresh" : "upsert"} enrichment` +
        `${keepNotionStatus ? " (keep Notion status)" : ""}` +
        `${pageName ? `; Name="${pageName}"` : ""}` +
        `${mt.mtClassCount != null ? `; MT Class Count=${mt.mtClassCount}` : ""}` +
        `${icon ? `; icon=${icon}` : ""})`
    );
    summary.evaluated++;
    tallyIcon(summary, icon);
    return;
  }

  const enrichedAt = nowIso();
  const applicantRow = {
    notion_page_id: app.notionPageId,
    email: app.email || null,
    first_name: app.firstName || null,
    last_name: app.lastName || null,
    full_name: app.fullName || null,
    region: app.region || null,
    phone: app.phone || null,
    ig_handle: app.igHandle || null,
    ig_url: app.igUrl || null,
    ig_followers: app.igFollowers,
    ig_followers_scraped: social.instagramFollowersScraped,
    ig_is_public: social.instagramIsPublic,
    tiktok_handle: app.tiktokHandle || null,
    tiktok_followers: app.tiktokFollowers,
    other_channels: app.otherChannels || null,
    submitted_at: app.submittedAt,
    application_status: bqApplicationStatus,
    previous_application: previousApplication,
    never_consider: neverConsider === true ? true : app.neverConsider,
    mt_user_id: mt.mtUserId,
    mt_email: mt.mtEmail,
    mt_account_exists: mt.mtAccountExists,
    mt_class_count: mt.mtClassCount,
    mt_has_cc: mt.mtHasCc,
    mt_home_studio: mt.mtHomeStudio,
    mt_profile_link: mt.mtProfileLink,
    social_enrichment_error: social.error,
    social_enriched_at: social.error ? null : enrichedAt,
    mt_enriched_at: app.email ? enrichedAt : null,
    enriched_at: enrichedAt,
    pre_pipeline: acceptedBefore ? true : prePipeline,
    accepted_before: acceptedBefore,
  };

  try {
    await upsertApplicant(applicantRow);
  } catch (error) {
    console.warn(`   ⚠️  BigQuery upsert failed (continuing Notion write): ${error.message}`);
    summary.bqFailures = (summary.bqFailures || 0) + 1;
  }

  await writeEnrichmentToNotion(
    app.notionPageId,
    {
      firstName: app.firstName,
      lastName: app.lastName,
      previousApplication,
      neverConsider: neverConsider === true ? true : app.neverConsider,
      mtClassCount: mt.mtClassCount,
      mtEmail: mt.mtEmail,
      mtAccountExists: mt.mtAccountExists,
      mtHasCc: mt.mtHasCc,
      mtHomeStudio: mt.mtHomeStudio,
      instagramFollowersForm: app.instagramFollowersForm,
      instagramFollowersScraped: social.instagramFollowersScraped,
      instagramIsPublic: social.instagramIsPublic,
      instagramVerified: social.instagramVerified,
      instagramBusiness: social.instagramIsBusiness,
      instagramPosts: social.instagramPostsCount,
    },
    keepNotionStatus
      ? { setStatus: false }
      : statusName
        ? { statusName }
        : undefined
  );

  summary.evaluated++;
  tallyIcon(summary, icon);
  logSaved(icon, { reevaluate });
}

/**
 * Pass 1: Notion "No Status" → enrich → copilot_applicants → Notion "Evaluated"
 * Duplicates (same email): only newest → Evaluated; older → Duplicate + comment.
 */
async function processNewApplications(summary) {
  const allNew = await listNewApplications();
  console.log(`📋 Found ${allNew.length} new application(s) in Notion`);

  const { toEvaluate: newestOnly, toReject: olderInQueue } =
    partitionNewestByEmail(allNew);

  if (olderInQueue.length) {
    console.log(
      `🗑️  Marking ${olderInQueue.length} older duplicate(s) in No Status (keeping newest per email)`
    );
    for (const dup of olderInQueue) {
      console.log(
        `   —— Duplicate: ${dup.fullName || dup.email || dup.notionPageId} ——`
      );
      if (config.dryRun) {
        console.log("   (DRY_RUN: would set Duplicate + comment Duplicate found)");
        summary.duplicatesRejected++;
        continue;
      }
      const newest =
        newestOnly.find((a) => a.email && a.email === dup.email) || dup;
      await markDuplicateApplication(dup.notionPageId, newest);
      await syncApplicantStatusFromNotion({
        notionPageId: dup.notionPageId,
        notionStatus: config.notion.status.duplicate,
      });
      summary.duplicatesRejected++;
      console.log("   ✅ Moved to Duplicate");
    }
  }

  let applications = newestOnly;
  if (config.evaluateLimit > 0) {
    applications = applications.slice(0, config.evaluateLimit);
    console.log(
      `📋 Evaluating ${applications.length} newest unique application(s) (EVALUATE_LIMIT=${config.evaluateLimit})`
    );
  } else {
    console.log(
      `📋 Evaluating ${applications.length} newest unique application(s)`
    );
  }
  summary.newCandidates = applications.length;

  let socialByHandle = new Map();
  if (config.social.provider !== "none") {
    const handles = applications
      .map((app) => app.instagramHandle)
      .filter(Boolean);
    socialByHandle = await enrichInstagramProfilesBatch(handles);
  }

  for (const app of applications) {
    console.log(`\n—— ${app.fullName || app.email || app.notionPageId} ——`);

    const olderDupes = await markOlderDuplicatesForEmail(app);
    summary.duplicatesRejected += olderDupes.length;
    if (olderDupes.length > 0) {
      console.log(`   ↩️  Marked ${olderDupes.length} older application(s) as duplicate`);
      if (!config.dryRun) {
        for (const pageId of olderDupes) {
          await syncApplicantStatusFromNotion({
            notionPageId: pageId,
            notionStatus: config.notion.status.duplicate,
          });
        }
      }
    }

    let previousFromBq = false;
    if (app.email) {
      try {
        previousFromBq = await hasPriorApplicationByEmail(
          app.email,
          app.notionPageId
        );
      } catch (error) {
        console.warn(
          `   ⚠️  BigQuery prior-app check failed (continuing): ${error.message}`
        );
      }
    }

    const previousApplication =
      olderDupes.length > 0 ||
      olderInQueue.some((d) => d.email && d.email === app.email) ||
      previousFromBq;

    if (previousApplication) {
      console.log("   ↩️  Previous application detected for this email");
    }

    let copilot = null;
    if (app.email) {
      try {
        copilot = await getCopilotByEmail(app.email);
      } catch (error) {
        console.warn(`   ⚠️  copilot_db lookup failed: ${error.message}`);
      }
    }
    const banned = isNeverAgain(copilot);

    await enrichOneApplication(app, socialByHandle, summary, {
      previousApplication: previousApplication || banned,
      ...(banned
        ? {
            bqApplicationStatus: "rejected",
            statusName: config.notion.status.rejected,
            neverConsider: true,
          }
        : {}),
    });

    if (banned) {
      await refuseNeverAgainApplication(app, copilot, {
        dryRun: config.dryRun,
        setStatus: false,
      });
      summary.neverAgainRejected = (summary.neverAgainRejected || 0) + 1;
    }
  }
}

/**
 * Re-run MT + Apify enrichment for every Status=Accepted page.
 * Keeps Notion status Accepted; marks accepted_before=TRUE (no nudge/promote).
 */
async function processReevaluateAccepted(summary) {
  let applications = await listAcceptedApplications();
  console.log(`📋 Found ${applications.length} Accepted application(s) to refresh`);

  if (config.evaluateLimit > 0) {
    applications = applications.slice(0, config.evaluateLimit);
    console.log(
      `📋 Limiting Accepted re-eval to ${applications.length} (EVALUATE_LIMIT=${config.evaluateLimit})`
    );
  }
  summary.newCandidates = applications.length;

  if (!config.dryRun && applications.length) {
    await ensurePrePipelineColumn();
    const marked = await markAcceptedBefore(
      applications.map((a) => a.notionPageId)
    );
    console.log(
      `   🏷️  marked accepted_before=TRUE for ${marked} BQ row(s) (nudge/promote blocked)`
    );
  }

  let socialByHandle = new Map();
  if (config.social.provider !== "none") {
    const handles = applications
      .map((app) => app.instagramHandle)
      .filter(Boolean);
    socialByHandle = await enrichInstagramProfilesBatch(handles);
  }

  for (const app of applications) {
    console.log(
      `\n—— Accepted re-eval: ${app.fullName || app.email || app.notionPageId} ——`
    );
    let previousApplication = false;
    if (app.email) {
      try {
        previousApplication = await hasPriorApplicationByEmail(
          app.email,
          app.notionPageId
        );
      } catch (error) {
        console.warn(
          `   ⚠️  BigQuery prior-app check failed (continuing): ${error.message}`
        );
      }
    }

    await enrichOneApplication(app, socialByHandle, summary, {
      previousApplication,
      reevaluate: true,
      keepNotionStatus: true,
      bqApplicationStatus: "accepted",
      acceptedBefore: true,
      prePipeline: true,
    });
  }
}

/**
 * Re-run MT + Apify enrichment for every Status=Evaluated page.
 */
async function processReevaluateEvaluated(summary) {
  let applications = await listEvaluatedApplications();
  console.log(`📋 Found ${applications.length} Evaluated application(s) to refresh`);

  if (config.evaluateLimit > 0) {
    applications = applications.slice(0, config.evaluateLimit);
    console.log(
      `📋 Limiting re-eval to ${applications.length} (EVALUATE_LIMIT=${config.evaluateLimit})`
    );
  }
  summary.newCandidates = applications.length;

  let socialByHandle = new Map();
  if (config.social.provider !== "none") {
    const handles = applications
      .map((app) => app.instagramHandle)
      .filter(Boolean);
    socialByHandle = await enrichInstagramProfilesBatch(handles);
  }

  for (const app of applications) {
    console.log(`\n—— Re-eval: ${app.fullName || app.email || app.notionPageId} ——`);
    let previousApplication = false;
    if (app.email) {
      try {
        previousApplication = await hasPriorApplicationByEmail(
          app.email,
          app.notionPageId
        );
      } catch (error) {
        console.warn(
          `   ⚠️  BigQuery prior-app check failed (continuing): ${error.message}`
        );
      }
    }
    await enrichOneApplication(app, socialByHandle, summary, {
      previousApplication,
      reevaluate: true,
    });
  }
}

/**
 * Pass 2: Notion "Accepted"
 * - Re-onboard=Needs review + inactive/missing roster → Status=Evaluated
 * - Re-onboard=Needs review + already active in copilot_db → Status=Onboarded
 * - Missing MT account or CC → nudge (cooldown) and skip promote/onboard
 * - Ready → clear nudge flags and promote to copilot_db
 */
async function processAcceptedApplications(summary) {
  const applications = await listAcceptedApplications();
  summary.acceptedCandidates = applications.length;
  console.log(`\n📋 Found ${applications.length} accepted application(s) in Notion`);

  for (const app of applications) {
    console.log(`\n—— Accepted: ${app.fullName || app.email || app.notionPageId} ——`);

    const eligible = await isAcceptedActionEligible(app.notionPageId);
    if (!eligible) {
      console.log(
        "   ⏭️  Pre-pipeline / accepted_before — skip nudge & promote (cutoff)"
      );
      summary.acceptedCutoffSkipped++;
      continue;
    }

    if (!app.email) {
      console.log("   ⚠️  No email — cannot check MT / promote");
      summary.acceptedFailed++;
      continue;
    }

    let copilot = null;
    try {
      copilot = await getCopilotByEmail(app.email);
    } catch (error) {
      console.warn(`   ⚠️  copilot_db lookup failed: ${error.message}`);
    }

    const needsReviewAction = await resolveNeedsReview(app, copilot, {
      dryRun: config.dryRun,
      email: app.email,
    });
    if (needsReviewAction === "evaluated") {
      summary.acceptedReonboardHold++;
      continue;
    }
    if (needsReviewAction === "onboarded") {
      summary.acceptedReonboardOnboarded++;
      continue;
    }

    const mt = await enrichApplicantFromMt(app.email);
    await sleep(config.requestDelayMs);
    console.log(
      `   MT: account=${mt.mtAccountExists} user=${mt.mtUserId ?? "—"} cc=${mt.mtHasCc === null ? "?" : mt.mtHasCc} studio=${mt.mtHomeStudio ?? "?"}`
    );

    const hold = await holdIfPreviouslyOffboarded(app, copilot, {
      dryRun: config.dryRun,
    });
    if (hold.held) {
      if (hold.reason === "never_again") {
        await refuseNeverAgainApplication(app, copilot, {
          dryRun: config.dryRun,
        });
        summary.acceptedNeverAgain = (summary.acceptedNeverAgain || 0) + 1;
      } else if (hold.reason === "decline") {
        summary.acceptedReonboardDeclined++;
      } else {
        summary.acceptedReonboardHold++;
      }
      continue;
    }
    if (hold.reason === "proceed") {
      await prepareCopilotForReonboard(app.email, copilot, {
        dryRun: config.dryRun,
      });
    }

    const blockers = getOnboardingBlockers(mt);
    if (blockers.length) {
      const reason = formatNudgeReason(blockers);
      console.log(`   🚧 Blocked from onboard: ${reason}`);

      if (isNudgeOnCooldown(app)) {
        const days = Number(config.nudgeCooldownDays) || 3;
        console.log(
          `   ⏭️  Nudge cooldown (${days}d)` +
            `${app.lastNudged ? ` — last sent ${app.lastNudged}` : ""} — refresh MT only`
        );
        if (!config.dryRun) {
          await writeOnboardingNudgeToNotion(app.notionPageId, {
            reason,
            mt,
            nudgedAt: null,
          });
        }
        summary.acceptedNudgeSkipped++;
        continue;
      }

      if (config.dryRun) {
        console.log(`   (DRY_RUN: would nudge + set Needs Nudge — ${reason})`);
        summary.acceptedNudged++;
        continue;
      }

      const nudgeSend = await sendOnboardingNudge({
        email: app.email,
        firstName: app.firstName,
        lastName: app.lastName,
        blockers,
        hasMtAccount: Boolean(mt.mtAccountExists),
        dryRun: false,
      });

      if (!nudgeSend?.sent) {
        console.warn(
          `   ⚠️  Nudge email not sent (${nudgeSend?.channel || "unknown"}) — Needs Nudge set, Last Nudged not stamped; will retry next run`
        );
        await writeOnboardingNudgeToNotion(app.notionPageId, {
          reason,
          mt,
          nudgedAt: null,
        });
        summary.acceptedNudgeFailed++;
        continue;
      }

      await writeOnboardingNudgeToNotion(app.notionPageId, {
        reason,
        mt,
        nudgedAt: nowIso(),
      });

      console.log("   ✅ Nudged — Needs Nudge set; skipped promote");
      summary.acceptedNudged++;
      continue;
    }

    // Ready to promote
    let alreadyPromoted = false;
    try {
      alreadyPromoted = await isPromotedToCopilotDb(app.notionPageId);
    } catch (error) {
      console.warn(
        `   ⚠️  BigQuery promoted check failed (continuing): ${error.message}`
      );
    }

    if (alreadyPromoted) {
      const stamped = await stampOnboardedIfAlreadyProvisioned(
        app,
        app.email,
        mt.mtUserId,
        mt
      );
      if (stamped) {
        summary.acceptedSkipped++;
        continue;
      }
      console.log("   ⏭️  Already promoted");
      if (!config.dryRun && app.needsNudge) {
        await clearOnboardingNudgeInNotion(app.notionPageId, { mt });
      }
      summary.acceptedSkipped++;
      continue;
    }

    const promotePayload = {
      email: app.email,
      first_name: app.firstName,
      last_name: app.lastName,
      region: app.region,
      tier: "Seeker",
      mt_user_id: mt.mtUserId,
      mt_email: mt.mtEmail,
      mt_home_studio: mt.mtHomeStudio,
      mt_profile_link: mt.mtProfileLink,
      ig_handle: app.igHandle || null,
      ig_url: app.igUrl || null,
      ig_followers: app.igFollowers ?? null,
      tiktok_handle: app.tiktokHandle || null,
      tiktok_followers: app.tiktokFollowers ?? null,
      other_channels: app.otherChannels || null,
    };

    if (config.dryRun) {
      const stamped = await stampOnboardedIfAlreadyProvisioned(
        app,
        app.email,
        mt.mtUserId,
        mt
      );
      if (stamped) {
        summary.acceptedSkipped++;
        continue;
      }
      console.log("   (DRY_RUN: would clear nudge flags + promote to copilot_db)");
      summary.acceptedPromoted++;
      continue;
    }

    await clearOnboardingNudgeInNotion(app.notionPageId, { mt });

    try {
      const result = await promoteToCopilotDb(promotePayload);
      if (result === "skipped") {
        console.log("   ⚠️  Promotion skipped (no email)");
        summary.acceptedFailed++;
        continue;
      }
      if (result === "exists") {
        console.log("   ℹ️  contact_email already in copilot_db");
      } else {
        console.log("   ✅ Inserted into copilot_db");
      }
      await stampOnboardedIfAlreadyProvisioned(app, app.email, mt.mtUserId, mt);
      await markPromoted(app.notionPageId);
      summary.acceptedPromoted++;
    } catch (error) {
      console.warn(`   ⚠️  Promote failed: ${error.message}`);
      summary.acceptedFailed++;
    }
  }
}

/**
 * Try to apply rejection thank-you credit when MT account exists.
 * @returns {Promise<boolean>} true if credit applied
 */
async function tryApplyRejectionCredit(app, mt, summary) {
  if (!mt?.mtAccountExists || !mt.mtUserId) {
    console.log("   ⏳ No MT account yet — credit pending until they sign up");
    summary.rejectedCreditPending++;
    return false;
  }

  const creditId = resolveRejectionCreditId(app.region);
  if (!creditId) {
    console.log(
      `   ⚠️  No rejection credit id for region "${app.region || ""}" — skipping credit apply`
    );
    summary.rejectedCreditSkipped++;
    return false;
  }

  if (config.dryRun) {
    console.log(
      `   (DRY_RUN: would apply rejection credit ${creditId} to MT user ${mt.mtUserId} [region=${app.region || "?"}])`
    );
    summary.rejectedCreditApplied++;
    return true;
  }

  try {
    await applyMtCredit({
      mtUserId: mt.mtUserId,
      mtUserEmail: mt.mtEmail || app.email,
      creditId,
      logContext: {
        notionPageId: app.notionPageId,
        region: app.region || null,
      },
    });
    console.log(
      `   ✅ Rejection credit applied (${creditId}, region=${app.region || "?"})`
    );
    summary.rejectedCreditApplied++;
    return true;
  } catch (error) {
    console.warn(`   ⚠️  Credit apply failed: ${error.message}`);
    summary.rejectedCreditFailed++;
    return false;
  }
}

/**
 * Pass 3a: Notion Rejected → send rejection email once (tracked in BQ).
 * Credit apply attempted here if MT exists; otherwise Pass 3b retries from BQ.
 * Notion Status stays Rejected (no Rejected - Contacted).
 */
async function processRejectedApplications(summary) {
  const fresh = await listRejectedApplications();
  summary.rejectedCandidates = fresh.length;
  console.log(`\n📋 Found ${fresh.length} rejected application(s) in Notion`);

  for (const app of fresh) {
    console.log(`\n—— Rejected: ${app.fullName || app.email || app.notionPageId} ——`);

    const eligible = await isPipelineEligible(app.notionPageId);
    if (!eligible) {
      console.log(
        "   ⏭️  Pre-pipeline / historical — skip rejection email & credit (cutoff)"
      );
      summary.rejectedCutoffSkipped++;
      continue;
    }

    if (!app.email) {
      console.log("   ⚠️  No email — cannot send rejection");
      summary.rejectedFailed++;
      continue;
    }

    const bqRow = await getApplicantByNotionPageId(app.notionPageId);
    if (bqRow?.rejection_emailed_at || bqRow?.rejectionEmailedAt) {
      console.log("   ⏭️  Rejection already emailed (BQ) — credit handled in BQ pass");
      summary.rejectedEmailedSkipped++;
      continue;
    }

    let mt = {
      mtAccountExists: false,
      mtUserId: null,
      mtEmail: null,
      mtHasCc: null,
      mtClassCount: null,
      mtHomeStudio: null,
    };
    mt = await enrichApplicantFromMt(app.email);
    await sleep(config.requestDelayMs);
    console.log(
      `   MT: account=${mt.mtAccountExists} user=${mt.mtUserId ?? "—"}`
    );

    const rejectionSend = await sendRejectionEmail({
      email: app.email,
      firstName: app.firstName,
      lastName: app.lastName,
      hasMtAccount: Boolean(mt.mtAccountExists),
      dryRun: config.dryRun,
    });

    const alreadyCredited = Boolean(
      bqRow?.credit_applied || bqRow?.creditApplied
    );
    const credited = alreadyCredited
      ? true
      : await tryApplyRejectionCredit(app, mt, summary);

    if (config.dryRun) {
      summary.rejectedEmailed++;
      console.log(
        "   (DRY_RUN: would set BQ rejection_emailed_at" +
          `${credited ? " + credit_applied" : " (credit pending in BQ)"}` +
          "; Notion stays Rejected)"
      );
      continue;
    }

    if (!rejectionSend?.sent) {
      console.warn(
        `   ⚠️  Rejection email not sent (${rejectionSend?.channel || "unknown"}) — not stamping rejection_emailed_at; will retry next run`
      );
      summary.rejectedEmailFailed++;
      if (credited && !alreadyCredited) {
        await ensurePrePipelineColumn();
        await markRejectionCreditApplied(app.notionPageId);
      }
      continue;
    }

    summary.rejectedEmailed++;
    await ensurePrePipelineColumn();
    await markRejectionEmailed(app.notionPageId);
    if (credited) {
      await markRejectionCreditApplied(app.notionPageId);
    }
    console.log(
      `   ✅ Rejection emailed (Notion stays Rejected)${
        credited ? "; credit applied" : "; credit pending in BQ"
      }`
    );
  }
}

/**
 * Pass 3b: BQ rejected rows with email sent but credit not applied → retry MT credit.
 */
async function processRejectedCreditsFromBq(summary) {
  await ensurePrePipelineColumn();
  const pending = await listRejectedPendingCreditFromBq();
  summary.rejectedCreditRetryCandidates = pending.length;
  console.log(
    `\n📋 Found ${pending.length} BQ rejected row(s) pending thank-you credit`
  );

  for (const row of pending) {
    const label = row.fullName || row.email || row.notionPageId;
    console.log(`\n—— Credit pending: ${label} ——`);

    if (!row.email) {
      summary.rejectedFailed++;
      continue;
    }

    const mt = await enrichApplicantFromMt(row.email);
    await sleep(config.requestDelayMs);
    console.log(
      `   MT: account=${mt.mtAccountExists} user=${mt.mtUserId ?? "—"}`
    );

    const app = {
      notionPageId: row.notionPageId,
      email: row.email,
      region: row.region,
    };
    const credited = await tryApplyRejectionCredit(app, mt, summary);
    if (!credited) continue;

    if (config.dryRun) {
      console.log("   (DRY_RUN: would set BQ credit_applied=TRUE)");
      continue;
    }
    await markRejectionCreditApplied(row.notionPageId);
    console.log("   ✅ Credit applied + flagged in BQ");
  }
}

export async function evaluateApplications() {
  assertEvaluateApplicationsConfig();

  const summary = {
    dryRun: config.dryRun,
    socialProvider: config.social.provider,
    newCandidates: 0,
    evaluated: 0,
    highlyQualified: 0,
    partiallyQualified: 0,
    followerLies: 0,
    duplicatesRejected: 0,
    reclaimOnboardedScanned: 0,
    reclaimOnboarded: 0,
    reclaimOnboardedSkipped: 0,
    reclaimOnboardedLeft: 0,
    acceptedCandidates: 0,
    acceptedPromoted: 0,
    acceptedNudged: 0,
    acceptedNudgeSkipped: 0,
    acceptedNudgeFailed: 0,
    acceptedSkipped: 0,
    acceptedFailed: 0,
    acceptedCutoffSkipped: 0,
    acceptedReonboardHold: 0,
    acceptedReonboardOnboarded: 0,
    acceptedReonboardDeclined: 0,
    acceptedNeverAgain: 0,
    neverAgainRejected: 0,
    rejectedCandidates: 0,
    rejectedEmailed: 0,
    rejectedEmailedSkipped: 0,
    rejectedEmailFailed: 0,
    rejectedCreditRetryCandidates: 0,
    rejectedCreditApplied: 0,
    rejectedCreditPending: 0,
    rejectedCreditSkipped: 0,
    rejectedCreditFailed: 0,
    rejectedFailed: 0,
    rejectedCutoffSkipped: 0,
    statusScanned: 0,
    statusSynced: 0,
    statusCleared: 0,
    statusUnchanged: 0,
    statusSyncFailed: 0,
  };

  console.log("🚀 Co-Pilot application evaluation job");
  if (config.dryRun) {
    console.log(
      "   DRY_RUN=1 — MT + social run; no writes to Notion or BigQuery"
    );
  }
  if (config.social.provider !== "none") {
    console.log(`   Social provider: ${config.social.provider}`);
  }

  if (!config.dryRun) {
    await ensurePrePipelineColumn();
    await ensureCopilotDbColumns();
  }

  if (config.reevaluateAccepted) {
    console.log(
      "   Mode: REEVALUATE_ACCEPTED — refreshing Accepted (accepted_before; no nudge/email)"
    );
    await processReevaluateAccepted(summary);
  } else if (config.reevaluateEvaluated) {
    console.log("   Mode: REEVALUATE_EVALUATED — refreshing Evaluated pages only");
    await processReevaluateEvaluated(summary);
  } else {
    await processStatusReconcile(summary);
    await processReclaimIncompleteOnboarded(summary);
    await processNewApplications(summary);

    const skipAccepted =
      config.evaluateLimit > 0 && !config.evaluateIncludeAccepted;
    if (skipAccepted) {
      console.log(
        "\n⏭️  Skipping accepted/rejected passes (EVALUATE_LIMIT set; use EVALUATE_INCLUDE_ACCEPTED=1 to include)"
      );
    } else {
      await processAcceptedApplications(summary);
      await processRejectedApplications(summary);
      await processRejectedCreditsFromBq(summary);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Summary");
  console.log("=".repeat(60));
  console.log(`   Candidates scanned: ${summary.newCandidates}`);
  console.log(`   Enriched: ${summary.evaluated}`);
  console.log(`   Highly qualified (🟢): ${summary.highlyQualified}`);
  console.log(`   Partial (🟡 social OK, missing MT/CC): ${summary.partiallyQualified}`);
  console.log(`   Red (🔴 under ${config.qualifiedMinFollowers} or mismatch): ${summary.followerLies}`);
  console.log(`   Duplicates marked: ${summary.duplicatesRejected}`);
  console.log(
    `   Incomplete Onboarded scanned: ${summary.reclaimOnboardedScanned}`
  );
  console.log(`   Moved Onboarded → Evaluated: ${summary.reclaimOnboarded}`);
  if (summary.reclaimOnboardedSkipped) {
    console.log(
      `   Onboarded reclaim skipped (historical): ${summary.reclaimOnboardedSkipped}`
    );
  }
  if (summary.bqFailures) {
    console.log(`   BigQuery failures (Notion still updated): ${summary.bqFailures}`);
  }
  console.log(`   Status reconcile scanned: ${summary.statusScanned}`);
  console.log(`   Status synced: ${summary.statusSynced}`);
  console.log(`   Status demotions cleared: ${summary.statusCleared}`);
  console.log(`   Status already in sync: ${summary.statusUnchanged}`);
  if (summary.statusSyncFailed) {
    console.log(`   Status sync failed: ${summary.statusSyncFailed}`);
  }
  console.log(`   Accepted scanned: ${summary.acceptedCandidates}`);
  console.log(`   Promoted to copilot_db: ${summary.acceptedPromoted}`);
  console.log(`   Nudged (missing MT/CC): ${summary.acceptedNudged}`);
  console.log(
    `   Nudge skipped (cooldown): ${summary.acceptedNudgeSkipped}`
  );
  if (summary.acceptedNudgeFailed) {
    console.log(`   Nudge email not sent (will retry): ${summary.acceptedNudgeFailed}`);
  }
  console.log(`   Already promoted: ${summary.acceptedSkipped}`);
  console.log(`   Promotion failed/skipped: ${summary.acceptedFailed}`);
  console.log(
    `   Accepted cutoff skipped (historical): ${summary.acceptedCutoffSkipped}`
  );
  if (summary.acceptedReonboardHold) {
    console.log(
      `   Previously offboarded — moved to Evaluated (Needs review): ${summary.acceptedReonboardHold}`
    );
  }
  if (summary.acceptedReonboardOnboarded) {
    console.log(
      `   Needs review but already active — Notion Onboarded: ${summary.acceptedReonboardOnboarded}`
    );
  }
  if (summary.acceptedReonboardDeclined) {
    console.log(
      `   Previously offboarded — declined: ${summary.acceptedReonboardDeclined}`
    );
  }
  if (summary.acceptedNeverAgain || summary.neverAgainRejected) {
    console.log(
      `   Never again — refused: ${(summary.neverAgainRejected || 0) + (summary.acceptedNeverAgain || 0)}`
    );
  }
  console.log(`   Rejected scanned: ${summary.rejectedCandidates}`);
  console.log(`   Rejection emails: ${summary.rejectedEmailed}`);
  console.log(
    `   Rejection email skipped (already sent): ${summary.rejectedEmailedSkipped}`
  );
  if (summary.rejectedEmailFailed) {
    console.log(
      `   Rejection email not sent (will retry): ${summary.rejectedEmailFailed}`
    );
  }
  console.log(
    `   BQ credit retries pending: ${summary.rejectedCreditRetryCandidates}`
  );
  console.log(`   Credits applied: ${summary.rejectedCreditApplied}`);
  console.log(`   Credits pending (no MT): ${summary.rejectedCreditPending}`);
  console.log(`   Credits skipped (no product id): ${summary.rejectedCreditSkipped}`);
  console.log(`   Credits failed: ${summary.rejectedCreditFailed}`);
  console.log(
    `   Rejected cutoff skipped (historical): ${summary.rejectedCutoffSkipped}`
  );

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  evaluateApplications()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Job failed:", error);
      process.exit(1);
    });
}
