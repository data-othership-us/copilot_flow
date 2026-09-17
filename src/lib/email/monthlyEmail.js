import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { CYCLE_STAY_POINTS, TIER_BENEFITS } from "../coPilotConstants.js";
import {
  firstNameOrHey,
  isNycRegion,
  nextTier,
  normalizeCopilotRegion,
  normalizeTierKey,
  titleCaseTier,
} from "../copilotIdentity.js";
import {
  isEmailSendConfigured,
  isInvalidRecipientError,
  renderTemplateFile,
  sendCopilotEmail,
} from "./gmailSend.js";
import { htmlToPreview } from "./htmlToPreview.js";
import { monthlyLink, monthlySectionHeading } from "./monthlyLayout.js";
import { getEmailSignatureHtml } from "./signature.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

export const MONTHLY_EMAIL_KIND = "copilot_monthly";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hubUrlForTier(tier) {
  const key = normalizeTierKey(tier);
  if (key === "luminary") return String(config.copilotLinks?.luminaryHubUrl || "").trim();
  if (key === "seeker") return String(config.copilotLinks?.seekerHubUrl || "").trim();
  return String(config.copilotLinks?.wayfinderHubUrl || "").trim();
}

function hubLinkHtml(tier) {
  const titled = titleCaseTier(tier);
  const label = `${titled} Hub`;
  const href = hubUrlForTier(titled);
  if (!href) return escapeHtml(label);
  return monthlyLink(escapeHtml(href), escapeHtml(label));
}

function formatPoints(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

function discountPercent(tier) {
  const key = normalizeTierKey(tier);
  return TIER_BENEFITS[key] ?? TIER_BENEFITS.seeker;
}

export function regionLabel(region) {
  return isNycRegion(region) ? "NYC" : "TO";
}

export function monthlySubject(monthLabel, region) {
  const city = regionLabel(region);
  return `🚀 ${city} ${monthLabel} Co-Pilot Monthly Update 🚀`;
}

export function cycleProgressLine({ cyclePoints, tier } = {}) {
  const points = Number(cyclePoints) || 0;
  const stay = CYCLE_STAY_POINTS[normalizeTierKey(tier)] ?? CYCLE_STAY_POINTS.seeker;
  const upgrade = nextTier(tier);
  const upgradeStay = upgrade
    ? CYCLE_STAY_POINTS[normalizeTierKey(upgrade)]
    : null;

  if (upgradeStay != null && points >= upgradeStay) {
    return `on track for ${upgrade} (${upgradeStay}+)`;
  }
  if (points >= stay) {
    if (upgradeStay != null) {
      const more = upgradeStay - points;
      return `on track to stay in ${titleCaseTier(tier)}; ${more} more to ${upgrade}`;
    }
    return `on track to stay in ${titleCaseTier(tier)}`;
  }
  const more = stay - points;
  return `${more} more point${more === 1 ? "" : "s"} to stay in ${titleCaseTier(tier)}`;
}

export function formatTermRemaining({ membershipEnd, daysToExpiry } = {}) {
  const days = Number(daysToExpiry);
  const endLabel = formatLongDate(membershipEnd);
  if (Number.isFinite(days) && endLabel) {
    if (days < 0) return `ended ${endLabel}`;
    if (days === 0) return `ends today (${endLabel})`;
    const unit = days === 1 ? "day" : "days";
    return `${days} ${unit} (ends ${endLabel})`;
  }
  if (endLabel) return `ends ${endLabel}`;
  return "—";
}

function formatLongDate(value) {
  if (!value) return "";
  const raw =
    typeof value === "object" && value.value != null
      ? String(value.value)
      : String(value);
  const day = raw.slice(0, 10);
  const match = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const dt = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  );
  return dt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function offerLinkHtml(url) {
  const href = String(url || "").trim();
  if (!href) return "—";
  const safe = escapeHtml(href);
  return monthlyLink(safe, safe);
}

function socialCountsLine({ stories, feedPosts } = {}) {
  const s = Number(stories) || 0;
  const f = Number(feedPosts) || 0;
  const storyWord = s === 1 ? "story" : "stories";
  const feedWord = f === 1 ? "feed post" : "feed posts";
  return `${s} ${storyWord}, ${f} ${feedWord} this term`;
}

export function renderMonthlyEmailHtml(input) {
  const tier = titleCaseTier(input.tier);
  return renderTemplateFile(path.join(emailsDir, "monthly.html"), {
    firstName: firstNameOrHey(input.firstName),
    monthLabel: escapeHtml(input.monthLabel || ""),
    tier: escapeHtml(tier),
    cyclePoints: escapeHtml(formatPoints(input.cyclePoints)),
    cycleProgress: escapeHtml(cycleProgressLine(input)),
    socialStatus: input.socialRequirementMet ? "Yes" : "Not yet",
    socialCounts: escapeHtml(
      socialCountsLine({
        stories: input.stories,
        feedPosts: input.feedPosts,
      })
    ),
    termRemaining: escapeHtml(formatTermRemaining(input)),
    promoCode: escapeHtml(input.promoCode || "—"),
    discountPercent: escapeHtml(String(discountPercent(tier))),
    offerLinkHtml: offerLinkHtml(input.offerLink),
    hubHtml: hubLinkHtml(tier),
    cycleHeadingHtml: monthlySectionHeading("This cycle"),
    offerHeadingHtml: monthlySectionHeading("To share"),
    reminderHeadingHtml: monthlySectionHeading("The monthly ask"),
    hubHeadingHtml: monthlySectionHeading("Your hub"),
    promoHtml: input.promoHtml || "",
    playgroundHtml: input.playgroundHtml || "",
    publicEventsHtml: input.publicEventsHtml || "",
    signatureHtml: getEmailSignatureHtml(),
  });
}

export function previewMonthlyEmail(input) {
  const html = renderMonthlyEmailHtml(input);
  return {
    subject: monthlySubject(input.monthLabel, input.region),
    html,
    preview: htmlToPreview(html),
  };
}

/**
 * @param {{
 *   email: string,
 *   mtEmail?: string,
 *   firstName?: string,
 *   lastName?: string,
 *   region?: string,
 *   tier?: string,
 *   promoCode?: string,
 *   offerLink?: string,
 *   cyclePoints?: number,
 *   socialRequirementMet?: boolean,
 *   stories?: number,
 *   feedPosts?: number,
 *   membershipEnd?: string,
 *   daysToExpiry?: number,
 *   monthLabel?: string,
 *   promoHtml?: string,
 *   playgroundHtml?: string,
 *   publicEventsHtml?: string,
 *   dryRun?: boolean,
 *   requireSend?: boolean,
 *   printBody?: boolean,
 * }} input
 */
export async function sendMonthlyEmail(input) {
  const name =
    [input.firstName, input.lastName].filter(Boolean).join(" ") || input.email;
  const detail = `monthly ${name} <${input.email}>`;
  const { subject, html, preview } = previewMonthlyEmail(input);

  if (input.printBody !== false) {
    console.log(`   📧 ${input.dryRun ? "DRY_RUN would send" : "Sending"}`);
    console.log(`      To: ${input.email}`);
    if (
      input.mtEmail &&
      String(input.mtEmail).trim() !== String(input.email || "").trim()
    ) {
      console.log(`      Fallback: ${input.mtEmail}`);
    }
    console.log(`      Subject: ${subject}`);
    console.log("      --- body ---");
    for (const line of preview.split("\n")) {
      console.log(`      ${line}`);
    }
    console.log("      --- end ---");
  } else if (input.dryRun) {
    console.log(
      `   📧 DRY_RUN would send ${detail} (${regionLabel(input.region)}/${titleCaseTier(input.tier)} · ${formatPoints(input.cyclePoints)} pts)`
    );
  }

  if (input.dryRun) {
    return { sent: false, channel: "email", detail: `dry_run: ${detail}`, subject };
  }

  if (!isEmailSendConfigured()) {
    if (input.requireSend) {
      throw new Error(
        `Gmail not configured — cannot send monthly email to ${input.email}`
      );
    }
    console.log(`   📧 monthly (Gmail not configured — skipped): ${detail}`);
    return { sent: false, channel: "stub", detail, subject };
  }

  let result;
  try {
    result = await sendCopilotEmail({
      to: input.email,
      fallbackTo: input.mtEmail,
      from: config.email.from,
      subject,
      html,
      emailKind: MONTHLY_EMAIL_KIND,
      logContext: {
        region: normalizeCopilotRegion(input.region),
        tier: titleCaseTier(input.tier),
        monthLabel: input.monthLabel || null,
      },
    });
  } catch (error) {
    if (isInvalidRecipientError(error)) {
      console.warn(
        `   ⚠️  skip monthly email — bad To address (${input.email})`
      );
      return { sent: false, channel: "invalid_to", detail, subject };
    }
    throw error;
  }

  console.log(`   📧 monthly sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    subject,
    messageId: result.messageId,
  };
}
