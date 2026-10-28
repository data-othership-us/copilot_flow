import { config } from "../config.js";
import {
  applySheetUnionViews,
  ensureCopilotDbColumns,
  listActivatingFromMembership,
  listInactivatingWithoutMembership,
  mergeSheetIntoCopilotDb,
  previewSheetSync,
  reconcileRosterStatus,
} from "../lib/bq/copilotDb.js";
import { fillMissingMtAccounts } from "../lib/mt/fillMissingMtAccounts.js";

/**
 * Daily Cloud Run job (8:45am ET) or on-demand: Google Sheet external tables → copilot_db.
 * Sheet-owned columns only; MT/discount/system fields are never overwritten.
 * After MERGE, fills missing user_id / mt_email from Mariana Tek, then sets
 * roster status from the Co-Pilot membership: live term → active (applied
 * offboard / never again stay inactive), otherwise not on an active tab →
 * inactive.
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
      `   Sheet rows: ${preview.sheet_rows} | would insert: ${preview.would_insert} | would update: ${preview.would_update} | would activate (live membership): ${Number(preview.would_activate ?? 0)} | would inactivate (no live membership, not on an active tab): ${Number(preview.would_inactivate ?? 0)}`
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

  const wouldActivate = Number(preview.would_activate ?? 0);
  const wouldInactivate = Number(preview.would_inactivate ?? 0);

  if (config.dryRun) {
    console.log("\n   (DRY_RUN: skipping MERGE + roster status)");
    await logRosterSample(
      "activate",
      wouldActivate,
      listActivatingFromMembership
    );
    await logRosterSample(
      "inactivate",
      wouldInactivate,
      listInactivatingWithoutMembership
    );
    const mtAccounts = await fillMissingMtAccounts({ dryRun: true });
    return { dryRun: true, preview, mtAccounts };
  }

  console.log("\n—— MERGE sheet into copilot_db ——");
  const result = await mergeSheetIntoCopilotDb();
  console.log(`   ✅ MERGE done (affected rows: ${result.affected})`);

  const mtAccounts = await fillMissingMtAccounts({ dryRun: false });

  console.log("\n—— Roster status from membership ——");
  const roster = await reconcileRosterStatus();
  console.log(
    `   ✅ status=active for ${roster.activated} copilot_db row(s) with a live Co-Pilot membership`
  );
  console.log(
    `   ✅ status=inactive for ${roster.inactivated} copilot_db row(s) with no live membership and not on an active tab`
  );

  return { dryRun: false, preview, result, roster, mtAccounts };
}

async function logRosterSample(label, total, listFn) {
  if (total <= 0) return;
  const sample = await listFn({ limit: 15 });
  for (const r of sample) {
    console.log(
      `   · ${label} ${r.contact_email}  ${r.region || "?"}/${r.tier || "?"}`
    );
  }
  if (total > sample.length) {
    console.log(`   · … +${total - sample.length} more`);
  }
}
