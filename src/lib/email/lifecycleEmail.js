import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import {
  isEmailSendConfigured,
  isInvalidRecipientError,
  renderTemplateFile,
  sendCopilotEmail,
} from "./gmailSend.js";
import { getEmailSignatureHtml } from "./signature.js";
import { htmlToPreview } from "./htmlToPreview.js";
import {
  estimatedTermEnd,
  firstNameOrHey,
  normalizeTierKey,
  termLengthMonths,
} from "../copilotIdentity.js";
import { CYCLE_STAY_POINTS, TIER_BENEFITS } from "../coPilotConstants.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

const KINDS = {
  acceptance: {
    file: "acceptance.html",
    subject: "🧑‍🚀 Welcome Aboard the Othership Copilot Program",
    emailKind: "copilot_acceptance",
  },
  renewal: {
    file: "renewal.html",
    subject: "💫 You're Renewed, Co-Pilot!",
    emailKind: "copilot_renewal",
  },
  offboard: {
    file: "offboard.html",
    subject: "🌘 Your Co-Pilot Term Is Wrapping Up",
    emailKind: "copilot_offboard",
  },
  upgrade: {
    file: "upgrade.html",
    subject: (input) => upgradeSubject(input.newTier),
    emailKind: "copilot_upgrade",
  },
  downgrade: {
    file: "downgrade.html",
    subject: "🛰️ A Change to Your Co-Pilot Tier",
    emailKind: "copilot_downgrade",
  },
  freeze: {
    file: "freeze.html",
    subject: "🧊 Your Co-Pilot Membership Is Paused",
    emailKind: "copilot_freeze",
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkOrPlaceholder(url, label = "[link]") {
  const href = String(url || "").trim();
  if (!href) return label;
  return `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
}

const UPGRADE_PERKS = {
  wayfinder: [
    "4 passes + 1 guest pass per month for 6 months (up from 2+1)",
    "13% discount code off credit packs",
    "Hybrid access expanded to Mon–Fri",
    "Earn 1 free pass for every 10 hybrid guests you bring",
    "Shopify: 7% commission + 11% community discount code",
  ],
  luminary: [
    "5 passes + 2 guest passes per month for 1 year",
    "15% discount code off credit packs",
    "Earn 1 free pass for every 5 hybrid guests you bring",
    "3-month app code to share with your community (up from 1 month)",
    "Early access to new class drops",
    "Shopify: 11% commission + 11% community discount code",
    "Product seeding, exclusive contests + partnership gifts",
  ],
};

function upgradeSubject(newTier) {
  const titled = String(newTier || "Wayfinder").trim() || "Wayfinder";
  const emoji = normalizeTierKey(titled) === "luminary" ? "🌕" : "🌗";
  return `${emoji} You've Been Upgraded — Welcome to ${titled}`;
}

function upgradePerkListHtml(newTier) {
  const key = normalizeTierKey(newTier);
  const items = UPGRADE_PERKS[key] || UPGRADE_PERKS.wayfinder;
  const lis = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<ul>${lis}</ul>`;
}

function hubUrlForTier(tier) {
  const key = normalizeTierKey(tier);
  if (key === "luminary") return String(config.copilotLinks?.luminaryHubUrl || "").trim();
  if (key === "seeker") return String(config.copilotLinks?.seekerHubUrl || "").trim();
  return String(config.copilotLinks?.wayfinderHubUrl || "").trim();
}

function hubLinkHtml(tier) {
  const titled = String(tier || "").trim() || "Wayfinder";
  const label = `${titled} Hub`;
  const href = hubUrlForTier(titled);
  if (!href) return escapeHtml(label);
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function salesToPoints(sales) {
  if (sales == null || sales === "") return null;
  const n = Number(sales);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n / 100);
}

function formatPoints(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

function resolveSubject(spec, input) {
  return typeof spec.subject === "function" ? spec.subject(input) : spec.subject;
}

export function formatExpirationDate(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function estimatedSeekerEnd(from = new Date()) {
  return estimatedTermEnd("Seeker", from);
}

export { estimatedTermEnd };

function discountPercent(tier) {
  const key = String(tier || "seeker").toLowerCase();
  return TIER_BENEFITS[key] ?? TIER_BENEFITS.seeker;
}

function termLengthPhrase(tier) {
  const months = termLengthMonths(tier);
  if (months === 12) return "twelve months";
  if (months === 6) return "six months";
  return "three months";
}

function formatYesNo(value) {
  if (value == null || value === "") return "—";
  const normalized = String(value).trim().toLowerCase();
  if (value === true || value === 1 || normalized === "yes" || normalized === "true") {
    return "Yes";
  }
  if (value === false || value === 0 || normalized === "no" || normalized === "false") {
    return "No";
  }
  return "—";
}

const DOWNGRADE_PERKS = {
  wayfinder: [
    "4 passes + 1 guest pass per month for 6 months",
    "13% discount code off credit packs",
    "Shopify: 7% commission + 11% community discount code",
  ],
  seeker: [
    "2 passes + 1 guest pass per month for 3 months",
    "11% discount code off credit packs",
  ],
};

function downgradePerkListHtml(newTier) {
  const key = normalizeTierKey(newTier);
  const items = DOWNGRADE_PERKS[key] || DOWNGRADE_PERKS.wayfinder;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderLifecycleHtml(kind, input) {
  const spec = KINDS[kind];
  const tier = input.tier || "Seeker";
  const newTier = input.newTier || "";
  const stayTier = newTier || tier;
  return renderTemplateFile(path.join(emailsDir, spec.file), {
    firstName: firstNameOrHey(input.firstName),
    tier: escapeHtml(tier),
    tierUpper: escapeHtml(String(tier).toUpperCase()),
    newTier: escapeHtml(newTier),
    region: escapeHtml(input.region || ""),
    offerLink: escapeHtml(input.offerLink || ""),
    promoCode: escapeHtml(input.promoCode || ""),
    expirationDate: escapeHtml(input.expirationDate || ""),
    termMonths: escapeHtml(String(termLengthMonths(tier))),
    termLength: escapeHtml(termLengthPhrase(tier)),
    cycleLength: escapeHtml(String(termLengthMonths(newTier || tier))),
    cyclePoints: escapeHtml(
      formatPoints(input.cyclePoints ?? salesToPoints(input.cycleSales))
    ),
    socialRequirementMet: escapeHtml(formatYesNo(input.socialRequirementMet)),
    discountPercent: escapeHtml(String(discountPercent(stayTier))),
    stayPoints: escapeHtml(
      formatPoints(CYCLE_STAY_POINTS[normalizeTierKey(stayTier)])
    ),
    wayfinderStayPoints: escapeHtml(formatPoints(CYCLE_STAY_POINTS.wayfinder)),
    luminaryStayPoints: escapeHtml(formatPoints(CYCLE_STAY_POINTS.luminary)),
    benchmarkPoints: escapeHtml(
      formatPoints(CYCLE_STAY_POINTS[normalizeTierKey(tier)])
    ),
    perkListHtml:
      kind === "downgrade"
        ? downgradePerkListHtml(newTier)
        : upgradePerkListHtml(newTier),
    hubHtml: hubLinkHtml(newTier || tier),
    hubLink: hubLinkHtml(newTier || tier),
    breathworkPersonalLink: linkOrPlaceholder(
      config.copilotLinks?.breathworkPersonalUrl
    ),
    breathworkCommunityLink: linkOrPlaceholder(
      config.copilotLinks?.breathworkCommunityUrl
    ),
    applyUrl: escapeHtml(
      String(config.copilotLinks?.applyUrl || "").trim()
    ),
    signatureHtml: getEmailSignatureHtml({
      includeApplyLine: kind !== "offboard",
    }),
  });
}

/**
 * @param {{
 *   kind: 'acceptance'|'renewal'|'offboard'|'upgrade'|'downgrade'|'freeze',
 *   email: string,
 *   mtEmail?: string,
 *   firstName?: string,
 *   lastName?: string,
 *   tier?: string,
 *   newTier?: string,
 *   region?: string,
 *   offerLink?: string,
 *   promoCode?: string,
 *   expirationDate?: string,
 *   cycleSales?: number|string|null,
 *   cyclePoints?: number|string|null,
 *   socialRequirementMet?: boolean|string|null,
 *   dryRun?: boolean,
 *   requireSend?: boolean,
 * }} input
 */
export async function sendLifecycleEmail(input) {
  const spec = KINDS[input.kind];
  if (!spec) throw new Error(`Unknown lifecycle email kind: ${input.kind}`);

  const name =
    [input.firstName, input.lastName].filter(Boolean).join(" ") || input.email;
  const detail = `${input.kind} ${name} <${input.email}>`;
  const html = renderLifecycleHtml(input.kind, input);
  const subject = resolveSubject(spec, input);

  if (input.dryRun) {
    console.log(`   📧 DRY_RUN would send`);
    console.log(`      To: ${input.email}`);
    if (input.mtEmail && String(input.mtEmail).trim() !== String(input.email || "").trim()) {
      console.log(`      Fallback: ${input.mtEmail}`);
    }
    console.log(`      Subject: ${subject}`);
    console.log("      --- body ---");
    for (const line of htmlToPreview(html).split("\n")) {
      console.log(`      ${line}`);
    }
    console.log("      --- end ---");
    return { sent: false, channel: "email", detail: `dry_run: ${detail}` };
  }

  if (!isEmailSendConfigured()) {
    if (input.requireSend) {
      throw new Error(
        `Gmail not configured — cannot send ${input.kind} email to ${input.email}`
      );
    }
    console.log(`   📧 ${input.kind} (Gmail not configured — skipped): ${detail}`);
    return { sent: false, channel: "stub", detail };
  }

  let result;
  try {
    result = await sendCopilotEmail({
      to: input.email,
      fallbackTo: input.mtEmail,
      from: config.email.from,
      subject,
      html,
      emailKind: spec.emailKind,
      logContext: {
        tier: input.tier || null,
        newTier: input.newTier || null,
      },
    });
  } catch (error) {
    if (isInvalidRecipientError(error)) {
      console.warn(
        `   ⚠️  skip ${input.kind} email — bad To address (${input.email})`
      );
      return { sent: false, channel: "invalid_to", detail };
    }
    throw error;
  }

  console.log(`   📧 ${input.kind} sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    messageId: result.messageId,
  };
}
