import { config } from "../config.js";
import {
  applySheetUnionViews,
  ensureCopilotDbColumns,
  inactivateMissingFromActiveTabs,
  listMissingFromActiveTabs,
  mergeSheetIntoCopilotDb,
  previewSheetSync,
} from "../lib/bq/copilotDb.js";
import { fillMissingMtAccounts } from "../lib/mt/fillMissingMtAccounts.js";

/**
 * Daily Cloud Run job (8:45am ET) or on-demand: Google Sheet external tables → copilot_db.
 * Sheet-owned columns only; MT/discount/system fields are never overwritten.
 * After MERGE, marks copilot_db emails missing from every active tab as
 * inactive, then fills missing user_id / mt_email from Mariana Tek.
 */
export async function syncCopilotDb({ applyViews = true } = {}) {
  console.log("🚀 sync-copilot-db");
  console.log(`   DRY_RUN=${config.dryRun ? "1" : "0"}`);

  console.log("\n—— Ensure copilot_db columns ——");
  if (config.dryRun) {
    console.log("   (DRY_RUN: would ADD COLUMN IF NOT EXISTS for migration fields)");
  } else {
    await ensureCopilotDbColumns();
    console.log("   ✅ Columns ensured");
  }

  if (applyViews) {
    console.log("\n—— Apply sheet union / dedup views ——");
    if (config.dryRun) {
      console.log("   (DRY_RUN: would CREATE OR REPLACE union / performance / evaluation_queue views)");
    } else {
      await applySheetUnionViews();
      console.log("   ✅ Views applied");
    }
  }

  console.log("\n—— Preview sheet → copilot_db ——");
  let preview;
  try {
    preview = await previewSheetSync();
    console.log(
      `   Sheet rows: ${preview.sheet_rows} | would insert: ${preview.would_insert} | would update: ${preview.would_update} | would inactivate (not on an active tab): ${Number(preview.would_inactivate ?? 0)}`
    );
  } catch (error) {
    console.error(
      `   ⚠️  Preview failed (Drive/external table access?): ${error.message}`
    );
    if (config.dryRun) {
      console.log("   Ending dry-run after schema/view steps.");
      return { dryRun: true, previewError: error.message };
    }
    throw error;
  }

  const wouldInactivate = Number(preview.would_inactivate ?? 0);

  if (config.dryRun) {
    console.log("\n   (DRY_RUN: skipping MERGE + inactivate)");
    if (wouldInactivate > 0) {
      const sample = await listMissingFromActiveTabs({ limit: 15 });
      for (const r of sample) {
        console.log(
          `   · ${r.contact_email}  ${r.region || "?"}/${r.tier || "?"}`
        );
      }
      if (wouldInactivate > sample.length) {
        console.log(`   · … +${wouldInactivate - sample.length} more`);
      }
    }
    const mtAccounts = await fillMissingMtAccounts({ dryRun: true });
    return { dryRun: true, preview, mtAccounts };
  }

  console.log("\n—— MERGE sheet into copilot_db ——");
  const result = await mergeSheetIntoCopilotDb();
  console.log(`   ✅ MERGE done (affected rows: ${result.affected})`);

  console.log("\n—— Inactivate emails not on an active tab ——");
  const inactivated = await inactivateMissingFromActiveTabs();
  console.log(
    `   ✅ status=inactive for ${inactivated.affected} copilot_db row(s) missing from every active tab`
  );

  const mtAccounts = await fillMissingMtAccounts({ dryRun: false });
  return { dryRun: false, preview, result, inactivated, mtAccounts };
}
