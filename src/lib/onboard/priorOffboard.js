import { config } from "../../config.js";
import { updateCopilotByEmail } from "../bq/copilotOps.js";
import { syncApplicantStatusFromNotion } from "../bq/applicants.js";
import {
  addApplicationComment,
  setApplicationStatus,
  writeNeverConsider,
  writeReonboardDecision,
} from "../notion/applications.js";
import {
  isNeverAgainDecision,
  isOffboardLikeDecision,
} from "../sheets/evaluationSheet.js";

/**
 * Sticky ban from Review "never again": do not accept if they apply again.
 * True when copilot_db.never_again is set, or an applied never-again decision.
 */
export function isNeverAgain(copilot) {
  if (!copilot) return false;
  if (copilot.never_again === true) return true;
  return (
    isNeverAgainDecision(copilot.decision) && Boolean(copilot.decision_applied_at)
  );
}

/**
 * True when this email already left the program and is not currently active:
 * applied offboard / never-again decision, or copilot_db status inactive (includes
 * historical sheet offboards). Active rows are not held even if an old
 * offboard decision is still on the row.
 */
export function wasPreviouslyOffboarded(copilot) {
  if (!copilot) return false;
  const status = String(copilot.status || "")
    .trim()
    .toLowerCase();
  if (status === "active") return false;
  if (isOffboardLikeDecision(copilot.decision) && copilot.decision_applied_at) {
    return true;
  }
  return status === "inactive";
}

/** @returns {'' | 'proceed' | 'decline' | 'needs_review'} */
export function normalizeReonboardDecision(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (!v) return "";
  if (v === "proceed" || v === "approve" || v === "approved") return "proceed";
  if (
    v === "decline" ||
    v === "do not onboard" ||
    v === "reject" ||
    v === "denied"
  ) {
    return "decline";
  }
  if (v === "needs review" || v === "hold" || v === "waiting") {
    return "needs_review";
  }
  return v;
}

export function reonboardAllowsOnboard(value) {
  return normalizeReonboardDecision(value) === "proceed";
}

function offboardHoldComment(copilot) {
  const decision = String(copilot?.decision || "").trim() || "none";
  const status = String(copilot?.status || "").trim() || "unknown";
  const applied = copilot?.decision_applied_at
    ? String(copilot.decision_applied_at).slice(0, 10)
    : "";
  const prop = config.notion.props.reonboard || "Re-onboard";
  const proceed = config.notion.reonboard.proceed;
  const decline = config.notion.reonboard.decline;
  return (
    `Previously offboarded from the Co-Pilot program ` +
    `(copilot_db status=${status}, decision=${decision}` +
    `${applied ? `, applied ${applied}` : ""}). ` +
    `Automatic onboard is on hold. Set ${prop} to ${proceed} to provision again, ` +
    `or ${decline} to leave them out.`
  );
}

function neverAgainComment() {
  return (
    "Marked never again on a prior Co-Pilot review. " +
    "This application is not eligible for acceptance."
  );
}

/**
 * Move a re-application to Rejected and stamp Decline / Never Consider.
 * Does not honor Re-onboard = Proceed.
 *
 * @returns {Promise<boolean>} true when a refusal was applied (or would be, in dry run)
 */
export async function refuseNeverAgainApplication(
  app,
  copilot,
  { dryRun, setStatus = true } = {}
) {
  if (!isNeverAgain(copilot) || !app?.notionPageId) return false;

  console.log("   🚫 never again — will not accept this application");
  if (dryRun) {
    console.log(
      "   (DRY_RUN: would set Rejected + Re-onboard=Decline + Never Consider)"
    );
    return true;
  }

  const rejected = config.notion.status.rejected;
  const decline = config.notion.reonboard.decline;

  if (setStatus) {
    try {
      await setApplicationStatus(app.notionPageId, rejected);
    } catch (error) {
      console.warn(`   ⚠️  Status → Rejected failed: ${error.message}`);
    }
    try {
      await syncApplicantStatusFromNotion({
        notionPageId: app.notionPageId,
        notionStatus: rejected,
      });
    } catch (error) {
      console.warn(`   ⚠️  BQ status sync failed: ${error.message}`);
    }
  }

  try {
    await writeReonboardDecision(app.notionPageId, decline);
  } catch (error) {
    console.warn(`   ⚠️  Re-onboard property write failed: ${error.message}`);
  }
  try {
    await writeNeverConsider(app.notionPageId, true);
  } catch (error) {
    console.warn(`   ⚠️  Never Consider write failed: ${error.message}`);
  }
  try {
    await addApplicationComment(app.notionPageId, neverAgainComment());
  } catch (error) {
    console.warn(`   ⚠️  Page comment failed: ${error.message}`);
  }
  return true;
}

/**
 * If this Accepted applicant was offboarded before, block auto-onboard until
 * ops sets Re-onboard = Proceed. Comments once and stamps Needs review.
 * "never again" always refuses, including when Re-onboard is Proceed.
 *
 * @returns {Promise<{ held: boolean, reason: string }>}
 */
export async function holdIfPreviouslyOffboarded(app, copilot, { dryRun } = {}) {
  if (isNeverAgain(copilot)) {
    return { held: true, reason: "never_again" };
  }

  if (!wasPreviouslyOffboarded(copilot)) {
    return { held: false, reason: "" };
  }

  const decision = normalizeReonboardDecision(app?.reOnboard);
  if (decision === "proceed") {
    return { held: false, reason: "proceed" };
  }
  if (decision === "decline") {
    console.log("   ⏭️  Previously offboarded — Re-onboard=Decline, skip");
    return { held: true, reason: "decline" };
  }

  const needsReview = config.notion.reonboard.needsReview;
  if (decision === "needs_review") {
    console.log(
      `   ⏸️  Previously offboarded — waiting on ops (${config.notion.props.reonboard}=${needsReview})`
    );
    return { held: true, reason: "needs_review" };
  }

  console.log("   ⏸️  Previously offboarded — holding auto-onboard for ops");
  if (dryRun) {
    console.log(
      `   (DRY_RUN: would comment + set ${config.notion.props.reonboard}=${needsReview})`
    );
    return { held: true, reason: "flag" };
  }

  try {
    await writeReonboardDecision(app.notionPageId, needsReview);
  } catch (error) {
    console.warn(`   ⚠️  Re-onboard property write failed: ${error.message}`);
  }
  try {
    await addApplicationComment(app.notionPageId, offboardHoldComment(copilot));
  } catch (error) {
    console.warn(`   ⚠️  Page comment failed: ${error.message}`);
  }
  return { held: true, reason: "flag" };
}

/**
 * After ops sets Proceed: reopen the copilot_db row so the onboard job
 * can assign a new term. Keeps promo / discount / offer_link, and leaves
 * the offboard decision in place so sheet sync cannot overwrite status
 * back to inactive. No-op when never_again is set.
 */
export async function prepareCopilotForReonboard(email, copilot, { dryRun } = {}) {
  if (!email || !wasPreviouslyOffboarded(copilot)) return false;
  if (isNeverAgain(copilot)) {
    console.log("   🚫 never again — will not reopen for onboard");
    return false;
  }
  if (dryRun) {
    console.log(
      "   (DRY_RUN: would clear onboarded_at so the onboard job can run)"
    );
    return true;
  }

  await updateCopilotByEmail(email, {
    onboarded_at: null,
  });
  console.log("   ♻️  Cleared onboarded_at — onboard job will provision");
  return true;
}
