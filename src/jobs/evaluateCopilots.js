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
} from "../lib/decisions/applyDecision.js";
import { storedIgHandle } from "../lib/instagram.js";
import {
  appendReviewQueue,
  freezeUntilDateString,
  listReadyDecisionsFromSheet,
  listSalesWritebacks,
  markSheetApplied,
  shouldHoldUntilExpiry,
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
    salesUpdated: 0,
    decisionsIngested: 0,
    applied: 0,
    heldUntilExpiry: 0,
    paymentNudged: 0,
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
      `   EVALUATE_EMAILS — ${emails.join(", ")} (skip queue rebuild / Add to Modash)`,
    );
  }

  if (!config.dryRun) {
    await ensureCopilotDbColumns();
    if (!emailsOnly) {
      await applySheetUnionViews();
    }
  }

  if (!emailsOnly) {
    console.log("\n📋 Evaluation queue (copilot_evaluation_queue)");
    const queue = await listEvaluationQueue();
    summary.queued = queue.length;
    console.log(
      `   ${queue.length} copilot(s) expiring within 7 days, re-submit IG, or no MT account`,
    );

    if (config.dryRun) {
      console.log(
        "   (DRY_RUN: would rebuild Review from the queue; keep unapplied decision / notes / sales cells)",
      );
      for (const r of queue.slice(0, 15)) {
        console.log(
          `   · ${r.contact_email}  end=${r.membership_end || "?"}  days=${r.days_to_expiry}`,
        );
      }
      if (queue.length > 15) {
        console.log(`   · … +${queue.length - 15} more`);
      }
    } else {
      const unappliedRows = await listUnappliedDecisions();
      const unappliedByEmail = new Map(
        unappliedRows.map((r) => [
          String(r.contact_email || "").trim().toLowerCase(),
          r,
        ]).filter(([email]) => email)
      );
      const written = await appendReviewQueue(queue, { unappliedByEmail });
      summary.sheetAppended = written.appended;
      summary.sheetSkipped = written.skipped;
      summary.sheetRebuilt = written.rebuilt ? 1 : 0;
      console.log(
        `   ✅ Review tab — ${written.total} row(s), sorted by region / tier / days to expiry` +
          (written.appended ? ` (${written.appended} new)` : "") +
          (written.carried
            ? `; kept ${written.carried} unapplied decision(s) not in queue`
            : ""),
      );
      if (!skipApply) {
        const salesPatches = await listSalesWritebacks(queue);
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
    }

    console.log("\n📣 Add to Modash (handles missing from modash_creators)");
    const missingModash = await listAddToModash();
    summary.addToModash = missingModash.length;
    if (config.dryRun) {
      console.log(
        `   (DRY_RUN: would write ${missingModash.length} row(s) to Add to Modash)`,
      );
      for (const r of missingModash.slice(0, 15)) {
        console.log(
          `   · ${r.contact_email}  ${storedIgHandle(r.ig_handle || r.ig_url) || r.ig_handle || "?"}  ${r.region || "?"} / ${r.tier || "?"}`,
        );
      }
      if (missingModash.length > 15) {
        console.log(`   · … +${missingModash.length - 15} more`);
      }
    } else {
      const written = await writeAddToModashQueue(missingModash);
      console.log(
        `   ✅ Add to Modash tab — ${written.total} handle(s) not in modash_creators`,
      );
    }
  }

  console.log("\n📥 Ingest + apply sheet decisions");
  if (skipApply) {
    console.log("   ⏭️  Skip apply — filled Review decisions left as-is");
  }
  const ready = skipApply ? [] : await listReadyDecisionsFromSheet();
  const filtered = skipApply ? [] : filterReady(ready, emails);
  if (!skipApply) {
    if (emailsOnly) {
      console.log(
        `   ${filtered.length} of ${ready.length} filled decision(s) match EVALUATE_EMAILS`,
      );
    } else {
      console.log(`   ${filtered.length} row(s) with a filled decision`);
    }
  }

  // Process from the bottom so row deletes don't shift unread row numbers.
  const ordered = [...filtered].sort((a, b) => b.rowNumber - a.rowNumber);

  for (const item of ordered) {
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

      const copilot = await getCopilotByEmail(item.email);
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

      if (copilot.decision_applied_at) {
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
      });

      if (isPaymentNudgeHold(result)) {
        console.log(
          `   🚧 ${result} — Review row kept until a valid payment method is on file`
        );
        summary.paymentNudged++;
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
    }
    await sleep(config.requestDelayMs);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Evaluation summary");
  console.log("=".repeat(60));
  console.log(`   Queued from view: ${summary.queued}`);
  console.log(`   Sheet appended: ${summary.sheetAppended}`);
  console.log(`   Already on Review: ${summary.sheetSkipped}`);
  console.log(`   Add to Modash: ${summary.addToModash}`);
  console.log(`   Sales fields updated: ${summary.salesUpdated}`);
  console.log(`   Decisions ingested: ${summary.decisionsIngested}`);
  console.log(`   Applied: ${summary.applied}`);
  console.log(`   Held until last day: ${summary.heldUntilExpiry}`);
  console.log(`   Payment nudge (held): ${summary.paymentNudged}`);
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
