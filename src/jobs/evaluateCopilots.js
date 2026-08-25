import { config } from "../config.js";
import { applySheetUnionViews, ensureCopilotDbColumns } from "../lib/bq/copilotDb.js";
import {
  getCopilotByEmail,
  listAddToModash,
  listEvaluationQueue,
  updateCopilotByEmail,
} from "../lib/bq/copilotOps.js";
import { applyCopilotDecision } from "../lib/decisions/applyDecision.js";
import {
  appendReviewQueue,
  freezeUntilDateString,
  listReadyDecisionsFromSheet,
  listSalesWritebacks,
  markSheetApplied,
  writeAddToModashQueue,
} from "../lib/sheets/evaluationSheet.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function evaluateCopilots() {
  if (!config.bq.projectId) throw new Error("Missing BQ_PROJECT_ID");
  const sheetId = config.evaluation?.sheetId;
  if (!sheetId) throw new Error("Missing EVALUATION_SHEET_ID");

  const summary = {
    dryRun: config.dryRun,
    queued: 0,
    sheetAppended: 0,
    sheetSkipped: 0,
    addToModash: 0,
    salesUpdated: 0,
    decisionsIngested: 0,
    applied: 0,
    applyFailed: 0,
  };

  console.log("🚀 Co-Pilot evaluation job");
  if (config.dryRun) {
    console.log("   DRY_RUN=1 — preview only; no sheet/BQ/MT writes");
  }

  if (!config.dryRun) {
    await ensureCopilotDbColumns();
    await applySheetUnionViews();
  }

  console.log("\n📋 Evaluation queue (copilot_evaluation_queue)");
  const queue = await listEvaluationQueue();
  summary.queued = queue.length;
  console.log(
    `   ${queue.length} copilot(s) expired, expiring, or with no Co-Pilot membership`
  );

  if (config.dryRun) {
    console.log("   (DRY_RUN: would append new emails to Review — no overwrite)");
    for (const r of queue.slice(0, 15)) {
      console.log(
        `   · ${r.contact_email}  end=${r.membership_end || r.sheet_membership_expiry || "?"}  days=${r.days_to_expiry}`
      );
    }
    if (queue.length > 15) {
      console.log(`   · … +${queue.length - 15} more`);
    }
  } else {
    const written = await appendReviewQueue(queue);
    summary.sheetAppended = written.appended;
    summary.sheetSkipped = written.skipped;
    summary.sheetRebuilt = written.rebuilt ? 1 : 0;
    console.log(
      `   ✅ Review tab — ${written.total} row(s), sorted by region / tier / days to expiry` +
        (written.appended ? ` (${written.appended} new)` : "")
    );
    const salesPatches = await listSalesWritebacks(queue);
    for (const patch of salesPatches) {
      await updateCopilotByEmail(patch.email, patch.fields);
      summary.salesUpdated++;
    }
    if (salesPatches.length) {
      console.log(`   ✅ Wrote ${salesPatches.length} bb_sales / hybrid_sales update(s) to copilot_db`);
    }
  }

  console.log("\n📣 Add to Modash (handles missing from modash_creators)");
  const missingModash = await listAddToModash();
  summary.addToModash = missingModash.length;
  if (config.dryRun) {
    console.log(
      `   (DRY_RUN: would write ${missingModash.length} row(s) to Add to Modash)`
    );
    for (const r of missingModash.slice(0, 15)) {
      console.log(
        `   · ${r.contact_email}  @${String(r.ig_handle || "").replace(/^@/, "")}  ${r.region || "?"} / ${r.tier || "?"}`
      );
    }
    if (missingModash.length > 15) {
      console.log(`   · … +${missingModash.length - 15} more`);
    }
  } else {
    const written = await writeAddToModashQueue(missingModash);
    console.log(
      `   ✅ Add to Modash tab — ${written.total} handle(s) not in modash_creators`
    );
  }

  console.log("\n📥 Ingest + apply sheet decisions");
  const ready = config.dryRun
    ? []
    : await listReadyDecisionsFromSheet();
  if (config.dryRun) {
    console.log("   (DRY_RUN: would read Review tab for filled decisions)");
  } else {
    console.log(`   ${ready.length} row(s) with a filled decision`);
  }

  // Process from the bottom so row deletes don't shift unread row numbers.
  const ordered = [...ready].sort((a, b) => b.rowNumber - a.rowNumber);

  for (const item of ordered) {
    const label = item.email;
    console.log(`\n—— Decision: ${label} → ${item.decision} ——`);
    try {
      if (!config.dryRun) {
        const freezeDate = freezeUntilDateString(item.freezeUntil);
        await updateCopilotByEmail(item.email, {
          decision: item.decision,
          decision_notes: item.decisionNotes || null,
          decision_at: "NOW",
          decision_source: "evaluation_sheet",
          ...(item.bbSales != null ? { bb_sales: item.bbSales } : {}),
          ...(item.hybridSales != null ? { hybrid_sales: item.hybridSales } : {}),
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

      if (copilot.decision_applied_at) {
        console.log("   ⏭️  Already applied in BQ — stamp sheet only");
        if (!config.dryRun) {
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
      console.log(`   ✅ ${result}`);

      if (!config.dryRun) {
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
