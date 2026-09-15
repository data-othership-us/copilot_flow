/**
 * One-time: email active copilots who have a live Co-Pilot membership and
 * whose Instagram is the ops "re-submit" placeholder.
 *
 * Preview (default — no Gmail / sheet / BQ writes):
 *   npm run email-resubmit-handles
 *
 * Send:
 *   DRY_RUN=0 npm run email-resubmit-handles -- --apply
 *
 * Limit to specific people / a cap:
 *   EMAILS=a@example.com,b@example.com DRY_RUN=1 npm run email-resubmit-handles
 *   LIMIT=5 DRY_RUN=1 npm run email-resubmit-handles
 */
import { config, sleep } from "../config.js";
import {
  listActiveResubmitHandleCopilots,
  updateCopilotByEmail,
} from "../lib/bq/copilotOps.js";
import { isEmailSendConfigured } from "../lib/email/gmailSend.js";
import {
  logResubmitHandlesEmailPreview,
  sendResubmitHandlesEmail,
} from "../lib/email/resubmitHandlesEmail.js";
import {
  listReviewDecisionNotesByEmail,
  patchReviewDecisionNotes,
  withResubmitHandlesEmailedNote,
} from "../lib/sheets/evaluationSheet.js";

function emailKey(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function parseEmailList(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(",")
        .map((s) => emailKey(s))
        .filter(Boolean)
    ),
  ];
}

function parseLimit(raw) {
  const n = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hasApplyFlag(argv = process.argv) {
  return argv.includes("--apply");
}

/**
 * Dry-run unless DRY_RUN is off AND `--apply` is passed.
 * Protects against a live .env (DRY_RUN=0) accidentally blasting Gmail.
 */
export function isResubmitHandlesDryRun({
  dryRun = config.dryRun,
  argv = process.argv,
} = {}) {
  return Boolean(dryRun) || !hasApplyFlag(argv);
}

function formatBqDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object" && value.value) return String(value.value);
  return String(value);
}

function personLabel(row) {
  const email = String(row?.contact_email || "").trim();
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(" ");
  return name ? `${name} <${email}>` : email;
}

async function loadReviewNotes() {
  if (!config.evaluation?.sheetId) return new Map();
  try {
    return await listReviewDecisionNotesByEmail();
  } catch (error) {
    console.warn(`   ⚠️  Could not read Review notes: ${error.message}`);
    return new Map();
  }
}

async function stampResubmitNotes({
  email,
  existingNotes,
  dryRun,
  sentAt = new Date(),
}) {
  const notes = withResubmitHandlesEmailedNote(existingNotes, sentAt);
  if (dryRun) {
    console.log(`   📝 DRY_RUN would stamp Review notes: ${notes}`);
    return { notes, patched: false };
  }

  await updateCopilotByEmail(email, { decision_notes: notes });
  const patched = await patchReviewDecisionNotes(email, notes);
  if (patched) {
    console.log(`   📝 Review notes: ${notes}`);
  } else {
    console.warn(
      `   ⚠️  Review row not found to stamp notes for ${email} (copilot_db updated)`
    );
  }
  return { notes, patched };
}

export async function emailResubmitHandles({
  argv = process.argv,
  emailsEnv = process.env.EMAILS,
  limitEnv = process.env.LIMIT,
} = {}) {
  const dryRun = isResubmitHandlesDryRun({ argv });
  const filterEmails = parseEmailList(emailsEnv);
  const limit = parseLimit(limitEnv);

  console.log("🚀 Email resubmit-handles (one-time)");
  console.log(
    "   Active copilots with a live Co-Pilot membership and re-submit IG"
  );
  if (filterEmails.length) {
    console.log(`   EMAILS — ${filterEmails.join(", ")}`);
  }
  if (limit) {
    console.log(`   LIMIT=${limit}`);
  }
  if (dryRun) {
    console.log(
      "   DRY_RUN — listing recipients and previewing email; no Gmail / sheet / BQ writes"
    );
    if (config.dryRun) {
      console.log("   (DRY_RUN is on — set DRY_RUN=0 to allow send)");
    }
    if (!hasApplyFlag(argv)) {
      console.log("   (pass --apply to allow send)");
    }
    console.log(
      "   To send: DRY_RUN=0 npm run email-resubmit-handles -- --apply"
    );
  } else {
    console.log("   LIVE — will send via Gmail and stamp Review decision_notes");
  }

  console.log("\n📧 Email");
  logResubmitHandlesEmailPreview();

  if (!config.bq.projectId) throw new Error("Missing BQ_PROJECT_ID");
  if (!dryRun && !isEmailSendConfigured()) {
    throw new Error(
      "Gmail not configured — cannot send (set GMAIL_* or preview with DRY_RUN=1)"
    );
  }
  if (!dryRun && !config.evaluation?.sheetId) {
    throw new Error(
      "Missing EVALUATION_SHEET_ID — cannot stamp Review notes after send"
    );
  }

  let rows = await listActiveResubmitHandleCopilots();
  const matched = rows.length;

  if (filterEmails.length) {
    const want = new Set(filterEmails);
    rows = rows.filter((row) => want.has(emailKey(row.contact_email)));
    const missing = filterEmails.filter(
      (email) => !rows.some((row) => emailKey(row.contact_email) === email)
    );
    if (missing.length) {
      console.log(
        `   ⚠️  EMAILS not in the resubmit+live-membership set: ${missing.join(", ")}`
      );
    }
  }
  if (limit) rows = rows.slice(0, limit);

  const reviewNotes = await loadReviewNotes();

  const summary = {
    dryRun,
    matched,
    queued: rows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    noted: 0,
    notedMissingReview: 0,
    notedFailed: 0,
  };

  console.log(
    `\n   ${matched} match(es); ${dryRun ? "previewing" : "sending to"} ${rows.length}`
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = String(row.contact_email || "").trim();
    const membershipEnd = formatBqDate(row.membership_end);
    console.log(`\n—— [${i + 1}/${rows.length}] ${personLabel(row)} ——`);
    console.log(
      `   ig=${row.ig_handle || "—"}  ${row.region || "?"}/${row.tier || "?"}` +
        `  membership=${row.membership_status || "—"}` +
        (membershipEnd ? ` end=${membershipEnd}` : "")
    );

    try {
      const result = await sendResubmitHandlesEmail({
        email,
        mtEmail: row.mt_email,
        firstName: row.first_name,
        lastName: row.last_name,
        dryRun,
        requireSend: !dryRun,
        printBody: false,
      });
      if (!(result.sent || dryRun)) {
        summary.skipped++;
        continue;
      }
      summary.sent++;

      const existingNotes =
        reviewNotes.get(emailKey(email)) || row.decision_notes || "";
      try {
        const stamped = await stampResubmitNotes({
          email,
          existingNotes,
          dryRun,
        });
        if (stamped.patched || dryRun) {
          summary.noted++;
          reviewNotes.set(emailKey(email), stamped.notes);
        } else {
          summary.notedMissingReview++;
        }
      } catch (noteError) {
        summary.notedFailed++;
        console.warn(`   ⚠️  Could not stamp Review notes: ${noteError.message}`);
      }
    } catch (error) {
      summary.failed++;
      console.warn(`   ⚠️  ${error.message}`);
    }

    if (i < rows.length - 1) await sleep(config.requestDelayMs);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Resubmit-handles email summary");
  console.log("=".repeat(60));
  console.log(`   Matched in BQ: ${summary.matched}`);
  console.log(`   Queued:        ${summary.queued}`);
  console.log(`   ${dryRun ? "Would send" : "Sent"}:      ${summary.sent}`);
  console.log(
    `   ${dryRun ? "Would stamp" : "Stamped"} notes: ${summary.noted}`
  );
  if (!dryRun) {
    console.log(`   Skipped:       ${summary.skipped}`);
    console.log(`   No Review row: ${summary.notedMissingReview}`);
    console.log(`   Note failed:   ${summary.notedFailed}`);
  }
  console.log(`   Failed:        ${summary.failed}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  emailResubmitHandles()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Resubmit-handles email failed:", error);
      process.exit(1);
    });
}
