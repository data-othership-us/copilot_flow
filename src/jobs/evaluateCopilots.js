import { config } from "../config.js";
import {
  applySheetUnionViews,
  ensureCopilotDbColumns,
} from "../lib/bq/copilotDb.js";
import {
  getCopilotByEmail,
  listAddToModash,
  listEvaluationQueue,
  listUnappliedDecisions,
  updateCopilotByEmail,
} from "../lib/bq/copilotOps.js";
import {
  applyCopilotDecision,
  isExpiryHold,
  isPaymentNudgeHold,
  isSocialNudgeHold,
} from "../lib/decisions/applyDecision.js";
import { storedIgHandle } from "../lib/instagram.js";
import {
  appendReviewQueue,
  collectSocialOutliers,
  ensureReviewSheetLayout,
  freezeUntilDateString,
  hasResubmitHandlesEmailedNote,
  isMembershipReviewRow,
  isOffboardLikeDecision,
  listReviewSheetRows,
  listSalesWritebacks,
  markSheetApplied,
  patchReviewDecisionNotes,
  readyDecisionsFromReviewCells,
  reviewRowDecision,
  shouldHoldUntilExpiry,
  withApplyFailedNote,
  writeAddToModashQueue,
} from "../lib/sheets/evaluationSheet.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skipApplyRequested() {
  return (
    config.evaluateSkipApply ||
    process.argv.includes("--skip-apply")
  );
}

function requestedEmails() {
  return config.evaluateEmails || [];
}

function filterReady(ready, emails) {
  if (!emails.length) return ready;
  const want = new Set(emails);
  const matched = ready.filter((r) => want.has(r.email));
  for (const email of emails) {
    if (!matched.some((r) => r.email === email)) {
      console.warn(`   ⚠️  ${email} — not on Review with a filled decision`);
    }
  }
  return matched;
}

function queueEmailSet(queue) {
  return new Set(
    (queue || [])
      .map((r) =>
        String(r.contact_email || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

async function applyReadyItems(items, summary, attempted) {
  const ordered = [...items].sort((a, b) => b.rowNumber - a.rowNumber);
  for (const item of ordered) {
    if (attempted.has(item.email)) continue;
    attempted.add(item.email);
    const label = item.email;
    console.log(`\n—— Decision: ${label} → ${item.decision} ——`);
    try {
      if (shouldHoldUntilExpiry(item)) {
        const days =
          item.daysToExpiry == null ? "?" : item.daysToExpiry;
        if (config.dryRun) {
          console.log(
            `   ⏳ hold until last day (days_to_expiry=${days}) — keep Review ${item.decision}; apply waits`,
          );
          console.log(
            "   (DRY_RUN: would ingest decision to copilot_db so a Review rewrite can restore it)",
          );
        } else {
          await updateCopilotByEmail(item.email, {
            decision: item.decision,
            decision_notes: item.decisionNotes || null,
            decision_at: "NOW",
            decision_source: "evaluation_sheet",
            ...(item.bbSales != null ? { bb_sales: item.bbSales } : {}),
            ...(item.hybridSales != null
              ? { hybrid_sales: item.hybridSales }
              : {}),
            ...(item.newHybridSales != null
              ? { new_hybrid_sales: item.newHybridSales }
              : {}),
          });
          summary.decisionsIngested++;
        }
        summary.heldUntilExpiry++;
        continue;
      }
      const freezeDate = freezeUntilDateString(item.freezeUntil);
      if (config.dryRun) {
        console.log(
          `   (DRY_RUN: would ingest decision=${item.decision}` +
            `${item.decisionNotes ? ` notes=${JSON.stringify(item.decisionNotes)}` : ""}` +
            `${freezeDate ? ` freeze_until=${freezeDate}` : ""} to copilot_db)`,
        );
      } else {
        await updateCopilotByEmail(item.email, {
          decision: item.decision,
          decision_notes: item.decisionNotes || null,
          decision_at: "NOW",
          decision_source: "evaluation_sheet",
          ...(item.bbSales != null ? { bb_sales: item.bbSales } : {}),
          ...(item.hybridSales != null
            ? { hybrid_sales: item.hybridSales }
            : {}),
          ...(item.newHybridSales != null
            ? { new_hybrid_sales: item.newHybridSales }
            : {}),
          ...(freezeDate ? { freeze_until: freezeDate } : {}),
        });
        summary.decisionsIngested++;
      }

      let copilot = await getCopilotByEmail(item.email);
      if (!copilot && item.decision === "update" && item.newEmail) {
        copilot = await getCopilotByEmail(item.newEmail);
      }
      if (!copilot) {
        throw new Error("email not found in copilot_db");
      }
      copilot.decision = item.decision;
      copilot.decision_notes = item.decisionNotes;
      console.log(
        `   ${copilot.region || "?"} / ${copilot.tier || "?"}` +
          `  user_id=${copilot.user_id || "?"}` +
          `  promo=${copilot.promo_code || "?"}`
      );

      if (copilot.decision_applied_at && item.decision !== "social") {
        console.log("   ⏭️  Already applied in BQ — stamp sheet only");
        if (config.dryRun) {
          console.log(`   (DRY_RUN: would delete Review row ${item.rowNumber})`);
        } else {
          await markSheetApplied({
            rowNumber: item.rowNumber,
          });
        }
        summary.applied++;
        continue;
      }

      const result = await applyCopilotDecision(copilot, {
        dryRun: config.dryRun,
        freezeUntil: item.freezeUntil,
        patch: {
          newEmail: item.newEmail,
          mtEmail: item.mtEmail,
          promoCode: item.promoCode,
          igHandle: item.igHandle,
          igUrl: item.igUrl,
          firstName: item.firstName,
          lastName: item.lastName,
        },
      });

      if (isPaymentNudgeHold(result)) {
        console.log(
          `   🚧 ${result} — Review row kept until a valid payment method is on file`
        );
        summary.paymentNudged++;
        continue;
      }

      if (isSocialNudgeHold(result)) {
        console.log(
          `   📸 ${result} — waiting on a public handle (Modash outliers)`,
        );
        summary.socialNudged++;
        continue;
      }

      if (isExpiryHold(result)) {
        console.log(
          `   ⏳ ${result} — Review row kept until last day of the live term`
        );
        summary.heldUntilExpiry++;
        continue;
      }

      console.log(`   ✅ ${result}`);

      if (config.dryRun) {
        console.log(`   (DRY_RUN: would delete Review row ${item.rowNumber})`);
      } else {
        await markSheetApplied({
          rowNumber: item.rowNumber,
        });
      }
      summary.applied++;
    } catch (error) {
      console.warn(`   ⚠️  Apply failed: ${error.message}`);
      summary.applyFailed++;
      if (!config.dryRun) {
        const notes = withApplyFailedNote(item.decisionNotes, error.message);
        try {
          const patched = await patchReviewDecisionNotes(item.email, notes);
          if (patched) {
            console.log(`   📝 Review notes: ${notes}`);
          } else {
            console.warn(
              `   ⚠️  Review row not found to stamp apply-failed note for ${item.email}`,
            );
          }
          await updateCopilotByEmail(item.email, { decision_notes: notes });
        } catch (noteError) {
          console.warn(
            `   ⚠️  Could not stamp apply-failed note: ${noteError.message}`,
          );
        }
      }
    }
    await sleep(config.requestDelayMs);
  }
}

export async function evaluateCopilots() {
  if (!config.bq.projectId) throw new Error("Missing BQ_PROJECT_ID");
  const sheetId = config.evaluation?.sheetId;
  if (!sheetId) throw new Error("Missing EVALUATION_SHEET_ID");
  const skipApply = skipApplyRequested();
  const emails = requestedEmails();
  const emailsOnly = emails.length > 0;

  const summary = {
    dryRun: config.dryRun,
    skipApply,
    queued: 0,
    sheetAppended: 0,
    sheetSkipped: 0,
    addToModash: 0,
    socialOutliers: 0,
    salesUpdated: 0,
    decisionsIngested: 0,
    applied: 0,
    heldUntilExpiry: 0,
    paymentNudged: 0,
    socialNudged: 0,
    applyFailed: 0,
  };

  console.log("🚀 Co-Pilot evaluation job");
  if (config.dryRun) {
    console.log("   DRY_RUN=1 — preview only; no sheet/BQ/MT writes");
  }
  if (skipApply) {
    console.log(
      "   EVALUATE_SKIP_APPLY — rebuild Review / Add to Modash only; leave filled decisions untouched",
    );
  }
  if (emailsOnly) {
    console.log(
      `   EVALUATE_EMAILS — ${emails.join(", ")} (rebuild Review / Modash; apply only these)`,
    );
  }

  if (!config.dryRun) {
    await ensureCopilotDbColumns();
    await ensureReviewSheetLayout();
    await applySheetUnionViews();
  }

  const attempted = new Set();

  console.log("\n📋 Evaluation queue (copilot_evaluation_queue)");
  const queue = await listEvaluationQueue();
  const { rows: reviewRows } = await listReviewSheetRows();
  const unappliedRows = await listUnappliedDecisions();
  const offboardHoldEmails = new Set();
  for (const r of reviewRows) {
    if (isOffboardLikeDecision(reviewRowDecision(r))) {
      offboardHoldEmails.add(r.email);
    }
  }
  for (const r of unappliedRows) {
    if (!isOffboardLikeDecision(r.decision)) continue;
    const email = String(r.contact_email || "")
      .trim()
      .toLowerCase();
    if (email) offboardHoldEmails.add(email);
  }
  const membershipQueue = queue.filter((r) => {
    const email = String(r.contact_email || "")
      .trim()
      .toLowerCase();
    return isMembershipReviewRow(r) || offboardHoldEmails.has(email);
  });
  const socialOnlyEmails = queue
    .filter((r) => {
      const email = String(r.contact_email || "")
        .trim()
        .toLowerCase();
      return !isMembershipReviewRow(r) && !offboardHoldEmails.has(email);
    })
    .map((r) =>
      String(r.contact_email || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const inQueue = queueEmailSet(membershipQueue);
  summary.queued = queue.length;
  console.log(
    `   ${queue.length} in queue; ${membershipQueue.length} membership Review; ${socialOnlyEmails.length} social-only → Modash outliers` +
      (offboardHoldEmails.size
        ? `; keep ${offboardHoldEmails.size} offboard until end of term`
        : ""),
  );

  const unappliedByEmail = new Map(
    unappliedRows
      .map((r) => [
        String(r.contact_email || "")
          .trim()
          .toLowerCase(),
        r,
      ])
      .filter(([email]) => email),
  );

  const outliers = collectSocialOutliers({
    queue,
    reviewRows,
    unappliedRows,
  });
  summary.socialOutliers = outliers.length;

  if (!skipApply && outliers.length) {
    console.log(`\n📸 Social outliers (${outliers.length})`);
    const want = emails.length ? new Set(emails) : null;
    for (const rec of outliers) {
      const email = String(rec.contact_email || rec.email || "")
        .trim()
        .toLowerCase();
      if (!email) continue;
      if (want && !want.has(email)) continue;
      if (attempted.has(email)) continue;
      const copilot = await getCopilotByEmail(email);
      if (!copilot) {
        console.warn(`   ⚠️  ${email} — not in copilot_db`);
        continue;
      }
      const filledDecision =
        rec.decision || copilot.decision || "";
      if (isOffboardLikeDecision(filledDecision)) {
        console.log(`   ⏭️  ${email} — ${filledDecision}, skip social nudge`);
        continue;
      }
      const notes =
        rec.decision_notes || rec.decisionNotes || copilot.decision_notes;
      const already =
        hasResubmitHandlesEmailedNote(notes) ||
        hasResubmitHandlesEmailedNote(copilot.decision_notes);
      if (already) {
        rec.decision_notes =
          notes && hasResubmitHandlesEmailedNote(notes)
            ? notes
            : copilot.decision_notes || notes;
        console.log(`   ⏭️  ${email} — social email already sent`);
        continue;
      }
      attempted.add(email);
      copilot.decision = "social";
      copilot.decision_notes = notes;
      console.log(`\n—— Social outlier: ${email} ——`);
      try {
        const result = await applyCopilotDecision(copilot, {
          dryRun: config.dryRun,
        });
        if (isSocialNudgeHold(result)) {
          summary.socialNudged++;
          rec.decision_notes = copilot.decision_notes || rec.decision_notes;
        }
      } catch (error) {
        summary.applyFailed++;
        console.warn(`   ⚠️  ${error.message}`);
      }
      await sleep(config.requestDelayMs);
    }
  }

  if (config.dryRun) {
    console.log(
      "\n   (DRY_RUN: planning Review rebuild in memory; no sheet write)",
    );
  }
  const written = await appendReviewQueue(membershipQueue, {
    unappliedByEmail,
    dryRun: config.dryRun,
    socialOnlyEmails,
  });
  const rebuiltCells = written.rows;
  summary.sheetAppended = written.appended;
  summary.sheetSkipped = written.skipped;
  summary.sheetRebuilt = written.rebuilt ? 1 : 0;
  console.log(
    `   ${config.dryRun ? "Would rebuild" : "✅ Review tab —"} ${written.total} row(s), needs-decision first (soonest expiry), grey nudge/pending at bottom` +
      (written.appended ? ` (${written.appended} new)` : "") +
      (written.carried
        ? `; keep ${written.carried} unapplied off-queue row(s)`
        : ""),
  );
  for (const r of membershipQueue.slice(0, 15)) {
    console.log(
      `   · ${r.contact_email}  end=${r.membership_end || "?"}  days=${r.days_to_expiry}`,
    );
  }
  if (membershipQueue.length > 15) {
    console.log(`   · … +${membershipQueue.length - 15} more`);
  }

  if (!config.dryRun && !skipApply) {
    const salesPatches = await listSalesWritebacks(membershipQueue);
    for (const patch of salesPatches) {
      await updateCopilotByEmail(patch.email, patch.fields);
      summary.salesUpdated++;
    }
    if (salesPatches.length) {
      console.log(
        `   ✅ Wrote ${salesPatches.length} bb_sales / hybrid_sales / new_hybrid_sales update(s) to copilot_db`,
      );
    }
  }

  console.log("\n📣 Add to Modash (paste-ready + social outliers)");
  const missingModash = await listAddToModash();
  if (config.dryRun) {
    const outlierEmails = new Set(
      outliers.map((o) =>
        String(o.contact_email || o.email || "")
          .trim()
          .toLowerCase(),
      ),
    );
    const addPreview = missingModash.filter((r) => {
      const email = String(r.contact_email || "")
        .trim()
        .toLowerCase();
      return email && !outlierEmails.has(email);
    });
    summary.addToModash = addPreview.length;
    console.log(
      `   (DRY_RUN: would write ${addPreview.length} add row(s) + ${outliers.length} outlier(s))`,
    );
    for (const r of addPreview.slice(0, 10)) {
      console.log(
        `   · NOT TRACKING ${r.contact_email}  ${storedIgHandle(r.ig_handle || r.ig_url) || r.ig_handle || "?"}`,
      );
    }
    for (const r of outliers.slice(0, 10)) {
      console.log(
        `   · resubmit ${r.contact_email}  ${r.ig_handle || "re-submit"}`,
      );
    }
  } else {
    const writtenModash = await writeAddToModashQueue(missingModash, {
      outliers,
    });
    summary.addToModash = writtenModash.added;
    summary.socialOutliers = writtenModash.outliers;
    console.log(
      `   ✅ Add to Modash — ${writtenModash.added} add (paste ig_handle); ${writtenModash.outliers} social outlier(s)`,
    );
  }

  console.log("\n📥 Ingest + apply sheet decisions");
  if (skipApply) {
    console.log("   ⏭️  Skip apply — filled Review decisions left as-is");
  }
  const ready = skipApply
    ? []
    : readyDecisionsFromReviewCells(rebuiltCells || [])
        .filter((r) => r.decision !== "social")
        .map((r) => ({
          ...r,
          manual: !inQueue.has(r.email),
        }));
  const filtered = skipApply ? [] : filterReady(ready, emails);
  if (!skipApply) {
    if (emailsOnly) {
      console.log(
        `   ${filtered.length} of ${ready.length} filled decision(s) match EVALUATE_EMAILS`,
      );
    } else {
      const offQueue = filtered.filter((r) => r.manual).length;
      console.log(
        `   ${filtered.length} filled decision(s)` +
          (offQueue ? ` (${offQueue} off-queue)` : ""),
      );
    }
    await applyReadyItems(filtered, summary, attempted);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Evaluation summary");
  console.log("=".repeat(60));
  console.log(`   Queued from view: ${summary.queued}`);
  console.log(`   Sheet appended: ${summary.sheetAppended}`);
  console.log(`   Already on Review: ${summary.sheetSkipped}`);
  console.log(`   Add to Modash: ${summary.addToModash}`);
  console.log(`   Social outliers: ${summary.socialOutliers ?? 0}`);
  console.log(`   Sales fields updated: ${summary.salesUpdated}`);
  console.log(`   Decisions ingested: ${summary.decisionsIngested}`);
  console.log(`   Applied: ${summary.applied}`);
  console.log(`   Held until last day: ${summary.heldUntilExpiry}`);
  console.log(`   Payment nudge (held): ${summary.paymentNudged}`);
  console.log(`   Social nudge (held): ${summary.socialNudged}`);
  console.log(`   Apply failed: ${summary.applyFailed}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  evaluateCopilots()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Evaluation job failed:", error);
      process.exit(1);
    });
}
