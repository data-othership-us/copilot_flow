/**
 * One-time: apply Mariana Tek offboarding thank-you credits to a fixed
 * email list. Resolves MT user_id + region from copilot_db.
 *
 * Preview (default — no MT writes):
 *   npm run apply-offboard-credits
 *
 * Apply:
 *   DRY_RUN=0 npm run apply-offboard-credits -- --apply
 */
import { config, resolveRejectionCreditId, sleep } from "../config.js";
import { listCopilotsByEmails } from "../lib/bq/copilotOps.js";
import { applyMtCredit } from "../lib/mt/applyCredit.js";

const OFFBOARD_CREDIT_NOTE = "Co-Pilot offboarding thank-you credit";

const OFFBOARD_CREDIT_EMAILS = [
  "alexiarmonize@gmail.com",
  "naelton.rosa@gmail.com",
  "romanyourphysio@gmail.com",
  "alexgrgicmanagement@gmail.com",
  "contact@asaldabbaghchian.com",
  "maryanne.wayland@hotmail.com",
  "elli@elliraynai.com",
  "geer.than@hotmail.com",
  "HELEN.LT.LIN@GMAIL.COM",
  "hylanayeri@gmail.com",
  "inaratoronto@gmail.com",
  "j.mango@beyondtheiron.ca",
  "joshuablodans@gmail.com",
  "juriameow@gmail.com",
  "kristiana.hurley9@gmail.com",
  "lauracolucci012@gmail.com",
  "katebpitfield@gmail.com",
  "lizbianch.r@gmail.com",
  "mrphoenixgrey@gmail.com",
  "nathan95taylor@gmail.com",
  "portia.alight@gmail.com",
  "inquiries.siennafaria@gmail.com",
  "tashherz@gmail.com",
  "mariahsousasampson@gmail.com",
  "zacholesinski@gmail.com",
  "vallaisa@gmail.com",
  "makerspace158@gmail.com",
  "Marcofvena@gmail.com",
  "heathererinfit@gmail.com",
  "aisabella53@gmail.com",
  "kareemsouth@gmail.com",
  "nastasiairons@gmail.com",
];

function emailKey(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function uniqueEmails(emails) {
  const seen = new Set();
  const out = [];
  for (const email of emails) {
    const key = emailKey(email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function hasApplyFlag(argv = process.argv) {
  return argv.includes("--apply");
}

/**
 * Dry-run unless DRY_RUN is off AND `--apply` is passed.
 * Protects against a live .env (DRY_RUN=0) accidentally applying credits.
 */
export function isOffboardCreditsDryRun({
  dryRun = config.dryRun,
  argv = process.argv,
} = {}) {
  return Boolean(dryRun) || !hasApplyFlag(argv);
}

function assertConfig({ dryRun }) {
  const missing = [];
  if (!config.bq.projectId) missing.push("BQ_PROJECT_ID");
  if (!dryRun) {
    if (!config.mt.baseUrl) missing.push("MT_API_BASE_URL");
    if (!config.mt.apiKey) missing.push("MT_API_KEY");
  }
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

function personLabel(row, email) {
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(" ");
  return name ? `${name} <${email}>` : email;
}

export async function applyOffboardCredits({
  emails = OFFBOARD_CREDIT_EMAILS,
  argv = process.argv,
} = {}) {
  const dryRun = isOffboardCreditsDryRun({ argv });
  const list = uniqueEmails(emails);

  console.log("🚀 Apply offboarding credits (one-time)");
  console.log(`   ${list.length} unique email(s)`);
  if (dryRun) {
    console.log(
      "   DRY_RUN — looking up copilot_db only; no Mariana Tek writes"
    );
    if (config.dryRun) {
      console.log("   (DRY_RUN is on — set DRY_RUN=0 to allow apply)");
    }
    if (!hasApplyFlag(argv)) {
      console.log("   (pass --apply to allow apply)");
    }
    console.log("   To apply: DRY_RUN=0 npm run apply-offboard-credits -- --apply");
  } else {
    console.log("   LIVE — will POST credit transactions to Mariana Tek");
  }

  assertConfig({ dryRun });

  const rows = await listCopilotsByEmails(list);
  const byEmail = new Map(
    rows.map((row) => [emailKey(row.contact_email), row])
  );

  const summary = {
    listed: list.length,
    found: 0,
    applied: 0,
    skippedNoRow: 0,
    skippedNoUserId: 0,
    skippedNoCreditId: 0,
    failed: 0,
  };

  for (let i = 0; i < list.length; i++) {
    const email = list[i];
    const row = byEmail.get(email);
    const label = personLabel(row, email);
    console.log(`\n[${i + 1}/${list.length}] ${label}`);

    if (!row) {
      console.log("   ⏭️  not in copilot_db");
      summary.skippedNoRow++;
      continue;
    }

    summary.found++;
    const userId = String(row.user_id || "").trim();
    const region = row.region || "";
    const creditId = resolveRejectionCreditId(region);

    console.log(
      `   copilot_db: user_id=${userId || "—"} region=${region || "—"} status=${row.status || "—"} decision=${row.decision || "—"}`
    );

    if (!userId) {
      console.log("   ⏭️  no user_id on copilot_db — cannot apply credit");
      summary.skippedNoUserId++;
      continue;
    }

    if (!creditId) {
      console.log(
        `   ⏭️  no credit product id for region "${region}" (set COPILOT_REJECTION_MT_CREDIT_ID_NY / _TO)`
      );
      summary.skippedNoCreditId++;
      continue;
    }

    if (dryRun) {
      console.log(
        `   (DRY_RUN: would apply credit ${creditId} to MT user ${userId} [region=${region || "?"}])`
      );
      summary.applied++;
      continue;
    }

    try {
      const result = await applyMtCredit({
        mtUserId: userId,
        mtUserEmail: row.mt_email || email,
        creditId,
        note: OFFBOARD_CREDIT_NOTE,
        source: "copilot_offboard",
        logContext: {
          contactEmail: email,
          region: region || null,
        },
      });
      console.log(
        `   ✅ Credit applied (${creditId}, txn=${result.creditTransactionId || "—"})`
      );
      summary.applied++;
    } catch (error) {
      console.warn(`   ⚠️  Credit apply failed: ${error.message}`);
      summary.failed++;
    }

    if (i < list.length - 1) await sleep(config.requestDelayMs);
  }

  console.log("\n—— Summary ——");
  console.log(`   Listed:            ${summary.listed}`);
  console.log(`   Found in copilot_db: ${summary.found}`);
  console.log(
    `   ${dryRun ? "Would apply" : "Applied"}:      ${summary.applied}`
  );
  console.log(`   Not in copilot_db: ${summary.skippedNoRow}`);
  console.log(`   Missing user_id:   ${summary.skippedNoUserId}`);
  console.log(`   Missing credit id: ${summary.skippedNoCreditId}`);
  console.log(`   Failed:            ${summary.failed}`);

  return summary;
}
