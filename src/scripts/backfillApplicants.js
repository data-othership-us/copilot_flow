/**
 * Stream all Notion Co-Pilot Applications into BigQuery copilots.copilot_applicants
 * with pre_pipeline = TRUE (historical cutoff marker).
 *
 * Rows already enriched by evaluate-applications (enriched_at set / pre_pipeline FALSE)
 * stay pipeline-eligible.
 *
 * Usage:
 *   DRY_RUN=1 npm run backfill-applicants
 *   npm run backfill-applicants
 */
import { config, assertEvaluateApplicationsConfig } from "../config.js";
import {
  ensurePrePipelineColumn,
  upsertApplicantBackfill,
} from "../lib/bq/applicants.js";
import { listAllApplications } from "../lib/notion/applications.js";

async function main() {
  assertEvaluateApplicationsConfig();

  console.log("🚀 Backfill Notion applications → copilot_applicants");
  console.log(
    `   Marker: pre_pipeline=TRUE (historical). Evaluate sets FALSE going forward.`
  );
  if (config.dryRun) {
    console.log("   DRY_RUN=1 — list only; no BigQuery writes");
  }

  if (!config.dryRun) {
    console.log("   Ensuring pre_pipeline column exists…");
    await ensurePrePipelineColumn();
  }

  const apps = await listAllApplications();
  console.log(`📋 Found ${apps.length} Notion application page(s)`);

  const byStatus = new Map();
  for (const app of apps) {
    const key = app.status || "(blank)";
    byStatus.set(key, (byStatus.get(key) || 0) + 1);
  }
  console.log("   By status:");
  for (const [status, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${status}: ${n}`);
  }

  let written = 0;
  let failed = 0;
  const concurrency = Number(process.env.BACKFILL_CONCURRENCY || 8);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < apps.length) {
      const i = nextIndex++;
      const app = apps[i];
      const label = app.fullName || app.email || app.notionPageId;
      if ((i + 1) % 50 === 0 || i === 0) {
        console.log(`   … ${i + 1}/${apps.length}`);
      }

      const row = {
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
        tiktok_handle: app.tiktokHandle || null,
        tiktok_followers: app.tiktokFollowers,
        other_channels: app.otherChannels || null,
        submitted_at: app.submittedAt,
        application_status: app.status || null,
        never_consider: app.neverConsider,
      };

      if (config.dryRun) {
        written++;
        continue;
      }

      try {
        await upsertApplicantBackfill(row);
        written++;
      } catch (error) {
        failed++;
        console.warn(`   ⚠️  Failed ${label}: ${error.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, apps.length) }, () => worker())
  );

  console.log("\n" + "=".repeat(60));
  console.log("📊 Backfill summary");
  console.log("=".repeat(60));
  console.log(`   Notion pages: ${apps.length}`);
  console.log(`   Upserted${config.dryRun ? " (dry-run)": ""}: ${written}`);
  console.log(`   Failed: ${failed}`);
  console.log(
    "\nCutoff rule: Accepted/Rejected actions only when pre_pipeline=FALSE"
  );
  console.log(
    "(set automatically the next time evaluate-applications enriches a row)."
  );
}

main().catch((error) => {
  console.error("❌ Backfill failed:", error);
  process.exit(1);
});
