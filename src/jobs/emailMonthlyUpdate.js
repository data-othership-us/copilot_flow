/**
 * Monthly Co-Pilot update: cycle performance + Notion promo + events.
 *
 * Preview (default — no Gmail writes):
 *   npm run email-monthly
 *
 * Send:
 *   DRY_RUN=0 npm run email-monthly -- --apply
 *
 * Limit / target:
 *   EMAILS=a@example.com DRY_RUN=1 npm run email-monthly
 *   LIMIT=3 MONTH=2026-10 DRY_RUN=1 npm run email-monthly
 *   REGION=NYC DRY_RUN=1 npm run email-monthly
 */
import { config, sleep } from "../config.js";
import { listMonthlyEmailCopilots } from "../lib/bq/copilotOps.js";
import {
  isNycRegion,
  normalizeCopilotRegion,
  titleCaseTier,
} from "../lib/copilotIdentity.js";
import { isEmailSendConfigured } from "../lib/email/gmailSend.js";
import { sendMonthlyEmail } from "../lib/email/monthlyEmail.js";
import {
  eventsForRegion,
  queryEventsInDateRange,
  renderPlaygroundHtml,
  renderPublicEventsHtml,
} from "../lib/notion/monthlyEvents.js";
import {
  listMonthlyPromos,
  promosForRegion,
  renderPromoHtml,
} from "../lib/notion/monthlyPromos.js";

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
 * Dry-run unless DRY_RUN is off AND (`--apply` or NODE_ENV=production).
 * Protects a live local .env from blasting Gmail; Cloud Run still sends.
 */
export function isMonthlyEmailDryRun({
  dryRun = config.dryRun,
  argv = process.argv,
} = {}) {
  if (dryRun) return true;
  if (hasApplyFlag(argv)) return false;
  return String(process.env.NODE_ENV || "").toLowerCase() !== "production";
}

function easternYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function resolveMonthWindow(monthKey, { today = easternYmd() } = {}) {
  const key = String(monthKey || today.slice(0, 7)).trim();
  const match = key.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`Invalid MONTH (use YYYY-MM): ${monthKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1, 12));
  const end = new Date(Date.UTC(year, month, 0, 12));
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const monthLabel = start.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const eventsFrom =
    today >= startDate && today <= endDate ? today : startDate;
  return { year, month, startDate, endDate, monthLabel, eventsFrom };
}

function bqNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "object" && value.value != null) return bqNumber(value.value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bqBool(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof value === "object" && value.value != null) return bqBool(value.value);
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

function bqDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object" && value.value != null) return String(value.value).slice(0, 10);
  return String(value).slice(0, 10);
}

function personLabel(row) {
  const email = String(row?.contact_email || "").trim();
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(" ");
  return name ? `${name} <${email}>` : email;
}

function regionFilterValue(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return isNycRegion(value) ? "NYC" : "TO";
}

export async function emailMonthlyUpdate({
  argv = process.argv,
  emailsEnv = process.env.EMAILS,
  limitEnv = process.env.LIMIT,
  monthEnv = process.env.MONTH,
  regionEnv = process.env.REGION,
} = {}) {
  const dryRun = isMonthlyEmailDryRun({ argv });
  const filterEmails = parseEmailList(emailsEnv);
  const limit = parseLimit(limitEnv);
  const regionOnly = regionFilterValue(regionEnv);
  const window = resolveMonthWindow(monthEnv);

  console.log("🚀 Monthly Co-Pilot update");
  console.log(`   Month: ${window.monthLabel} (${window.startDate} → ${window.endDate})`);
  console.log(`   Events from: ${window.eventsFrom} (skip past dates)`);
  if (regionOnly) console.log(`   REGION=${regionOnly}`);
  if (filterEmails.length) console.log(`   EMAILS — ${filterEmails.join(", ")}`);
  if (limit) console.log(`   LIMIT=${limit}`);
  if (dryRun) {
    console.log(
      "   DRY_RUN — listing recipients and previewing email; no Gmail writes"
    );
    if (config.dryRun) {
      console.log("   (DRY_RUN is on — set DRY_RUN=0 to allow send)");
    }
    if (!hasApplyFlag(argv) && String(process.env.NODE_ENV || "").toLowerCase() !== "production") {
      console.log("   (pass --apply to allow send)");
    }
    console.log("   To send: DRY_RUN=0 npm run email-monthly -- --apply");
  } else {
    console.log("   LIVE — will send via Gmail");
  }

  if (!config.bq.projectId) throw new Error("Missing BQ_PROJECT_ID");
  if (!config.notion.token) throw new Error("Missing NOTION_TOKEN");
  if (!dryRun && !isEmailSendConfigured()) {
    throw new Error(
      "Gmail not configured — cannot send (set GMAIL_* or preview with DRY_RUN=1)"
    );
  }

  console.log("\n📅 Loading events from Global Events Calendar…");
  const allEvents = await queryEventsInDateRange(window.eventsFrom, window.endDate);
  const nycEvents = eventsForRegion(allEvents, "NYC");
  const toEvents = eventsForRegion(allEvents, "TO");
  console.log(
    `   ${allEvents.length} event(s) in window · NYC ${nycEvents.length} · TO ${toEvents.length}`
  );

  console.log("\n🛍️  Loading monthly promos from Notion…");
  let promos = [];
  if (!config.notion.monthlyPromosDatabaseId) {
    console.warn("   ⚠️  NOTION_MONTHLY_PROMOS_DATABASE_ID unset — skipping promo section");
  } else {
    try {
      promos = await listMonthlyPromos({
        startDate: window.startDate,
        endDate: window.endDate,
      });
      console.log(`   ${promos.length} ready promo row(s)`);
      if (!promos.length) {
        console.warn(
          "   ⚠️  No Ready promo for this month — check the box on the Notion row to include it"
        );
      }
    } catch (error) {
      console.warn(`   ⚠️  Could not load promos: ${error.message}`);
    }
  }

  const shared = {
    NYC: {
      promoHtml: renderPromoHtml(promosForRegion(promos, "NYC")),
      playgroundHtml: renderPlaygroundHtml(nycEvents),
      publicEventsHtml: renderPublicEventsHtml(nycEvents),
    },
    TO: {
      promoHtml: renderPromoHtml(promosForRegion(promos, "TO")),
      playgroundHtml: renderPlaygroundHtml(toEvents),
      publicEventsHtml: renderPublicEventsHtml(toEvents),
    },
  };

  let rows = await listMonthlyEmailCopilots();
  const matched = rows.length;

  if (regionOnly) {
    rows = rows.filter(
      (row) => (isNycRegion(row.region) ? "NYC" : "TO") === regionOnly
    );
  }
  if (filterEmails.length) {
    const want = new Set(filterEmails);
    rows = rows.filter((row) => want.has(emailKey(row.contact_email)));
    const missing = filterEmails.filter(
      (email) => !rows.some((row) => emailKey(row.contact_email) === email)
    );
    if (missing.length) {
      console.log(
        `   ⚠️  EMAILS not in the active+live-membership set: ${missing.join(", ")}`
      );
    }
  }
  if (limit) rows = rows.slice(0, limit);

  const printBodies = rows.length <= 5;
  const summary = {
    dryRun,
    matched,
    queued: rows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  console.log(
    `\n   ${matched} active with live membership; ${dryRun ? "previewing" : "sending to"} ${rows.length}`
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = String(row.contact_email || "").trim();
    const regionKey = isNycRegion(row.region) ? "NYC" : "TO";
    const blocks = shared[regionKey];
    console.log(`\n—— [${i + 1}/${rows.length}] ${personLabel(row)} ——`);
    console.log(
      `   ${regionKey}/${titleCaseTier(row.tier)}  pts=${bqNumber(row.cycle_points)}` +
        `  social=${bqBool(row.social_requirement_met) ? "yes" : "not yet"}` +
        `  membership=${row.membership_status || "—"}` +
        (bqDate(row.membership_end) ? ` end=${bqDate(row.membership_end)}` : "")
    );

    try {
      const result = await sendMonthlyEmail({
        email,
        mtEmail: row.mt_email,
        firstName: row.first_name,
        lastName: row.last_name,
        region: normalizeCopilotRegion(row.region) || regionKey,
        tier: row.tier,
        promoCode: row.promo_code,
        offerLink: row.offer_link,
        cyclePoints: bqNumber(row.cycle_points),
        socialRequirementMet: bqBool(row.social_requirement_met),
        stories: bqNumber(row.modash_stories_current_membership),
        feedPosts: bqNumber(row.modash_feed_posts_current_membership),
        membershipEnd: bqDate(row.membership_end),
        daysToExpiry: bqNumber(row.days_to_expiry),
        monthLabel: window.monthLabel,
        promoHtml: blocks.promoHtml,
        playgroundHtml: blocks.playgroundHtml,
        publicEventsHtml: blocks.publicEventsHtml,
        dryRun,
        requireSend: !dryRun,
        printBody: printBodies || i === 0,
      });
      if (!(result.sent || dryRun)) {
        summary.skipped++;
        continue;
      }
      summary.sent++;
    } catch (error) {
      summary.failed++;
      console.warn(`   ⚠️  ${error.message}`);
    }

    if (i < rows.length - 1) {
      await sleep(Math.max(config.requestDelayMs, 150));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Monthly update summary");
  console.log("=".repeat(60));
  console.log(`   Month:         ${window.monthLabel}`);
  console.log(`   Matched in BQ: ${summary.matched}`);
  console.log(`   Queued:        ${summary.queued}`);
  console.log(`   ${dryRun ? "Would send" : "Sent"}:      ${summary.sent}`);
  if (!dryRun) console.log(`   Skipped:       ${summary.skipped}`);
  console.log(`   Failed:        ${summary.failed}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  emailMonthlyUpdate()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Monthly update email failed:", error);
      process.exit(1);
    });
}
