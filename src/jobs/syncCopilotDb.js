import { config } from "../config.js";
import {
  applySheetUnionViews,
  ensureCopilotDbColumns,
  mergeSheetIntoCopilotDb,
  previewSheetSync,
} from "../lib/bq/copilotDb.js";

/**
 * Daily Cloud Run job (8:45am ET) or on-demand: Google Sheet external tables → copilot_db.
 * Sheet-owned columns only; MT/discount/system fields are never overwritten.
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
      `   Sheet rows: ${preview.sheet_rows} | would insert: ${preview.would_insert} | would update: ${preview.would_update}`
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

  if (config.dryRun) {
    console.log("\n   (DRY_RUN: skipping MERGE)");
    return { dryRun: true, preview };
  }

  console.log("\n—— MERGE sheet into copilot_db ——");
  const result = await mergeSheetIntoCopilotDb();
  console.log(`   ✅ MERGE done (affected rows: ${result.affected})`);
  return { dryRun: false, preview, result };
}
