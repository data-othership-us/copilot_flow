import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { CYCLE_STAY_POINTS, TIER_BENEFITS } from "../coPilotConstants.js";
import productsData from "../Discount/discountProducts.json" assert { type: "json" };
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

function englishList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join("");
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function productLabel(title) {
  return String(title || "")
    .replace(/^(NY|Toronto)\s+/i, "")
    .replace(/\s+\$\d+(?:\.\d+)?/, "")
    .trim();
}

function pointsPhrase(count) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  return `${n} more ${n === 1 ? "point" : "points"}`;
}

/**
 * Points on the newsletter: how many remain to stay in this tier, or, once
 * that bar is met, how many remain to the next tier. Luminary has no next tier.
 */
export function cycleProgressLine({ cyclePoints, tier } = {}) {
  const points = Math.round(Number(cyclePoints) || 0);
  const key = normalizeTierKey(tier);
  const stay = CYCLE_STAY_POINTS[key] ?? CYCLE_STAY_POINTS.seeker;
  if (points < stay) {
    return `${points} (${pointsPhrase(stay - points)} to stay in ${titleCaseTier(tier)})`;
  }
  const upgrade = nextTier(tier);
  if (!upgrade) return `${points} (top tier)`;
  const upgradeStay =
    CYCLE_STAY_POINTS[normalizeTierKey(upgrade)] ?? CYCLE_STAY_POINTS.wayfinder;
  return `${points} (${pointsPhrase(upgradeStay - points)} to the next tier)`;
}

/**
 * Products the regional Co-Pilot code covers, from the discount catalog.
 */
export function formatPromoProductsLine(region) {
  const products = isNycRegion(region) ? productsData.nyc : productsData.toronto;
  const packs = [];
  const others = [];
  let classPacks = true;
  for (const product of products || []) {
    const name = productLabel(product.title);
    const pack = name.match(/^(\d+)\s+(Class\s+)?Pack$/i);
    if (pack) {
      packs.push(Number(pack[1]));
      if (!pack[2]) classPacks = false;
      continue;
    }
    if (name) others.push(name.toLowerCase());
  }
  packs.sort((a, b) => a - b);
  const packWord = classPacks ? "class packs" : "packs";
  const packPhrase = packs.length
    ? `the ${englishList(packs.map(String))} ${packWord}`
    : "";
  const named = others.filter(Boolean);
  const phrase = named.length
    ? englishList([...named, packPhrase].filter(Boolean))
    : packPhrase;
  if (!phrase) return "";
  return named.length ? `Applies to the ${phrase}.` : `Applies to ${phrase}.`;
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

/** Newsletter Social line: whether last calendar month cleared the bar. */
export function formatSocialRequirementLine({ lastMonthMet } = {}) {
  if (lastMonthMet == null) return "—";
  return lastMonthMet ? "Met last month" : "Not Met last month";
}

export function renderMonthlyEmailHtml(input) {
  const tier = titleCaseTier(input.tier);
  const products = formatPromoProductsLine(input.region);
  return renderTemplateFile(path.join(emailsDir, "monthly.html"), {
    firstName: firstNameOrHey(input.firstName),
    monthLabel: escapeHtml(input.monthLabel || ""),
    tier: escapeHtml(tier),
    cyclePointsLine: escapeHtml(cycleProgressLine(input)),
    promoProductsParen: escapeHtml(products ? ` (${products})` : ""),
    socialStatus: escapeHtml(
      formatSocialRequirementLine({
        lastMonthMet: input.socialRequirementMetLastMonth,
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
    leaderboardHtml: input.leaderboardHtml || "",
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
 *   socialRequirementMetLastMonth?: boolean|null,
 *   socialRequirementMonthsMet?: string,
 *   membershipEnd?: string,
 *   daysToExpiry?: number,
 *   monthLabel?: string,
 *   promoHtml?: string,
 *   playgroundHtml?: string,
 *   publicEventsHtml?: string,
 *   leaderboardHtml?: string,
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
    to: result.to,
  };
}
