import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import {
  isEmailSendConfigured,
  renderTemplateFile,
  sendCopilotEmail,
} from "./gmailSend.js";
import { getEmailSignatureHtml } from "./signature.js";
import {
  estimatedTermEnd,
  firstNameOrHey,
  isNycRegion,
} from "../copilotIdentity.js";
import { TIER_BENEFITS } from "../coPilotConstants.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

const KINDS = {
  acceptance: {
    file: "acceptance.html",
    subject: "🧑‍🚀 Welcome Aboard the Othership Co-Pilot Program",
    emailKind: "copilot_acceptance",
  },
  renewal: {
    file: "renewal.html",
    subject: "[PLACEHOLDER] Your Co-Pilot membership is renewed",
    emailKind: "copilot_renewal",
  },
  offboard: {
    file: "offboard.html",
    subject: "[PLACEHOLDER] Your Co-Pilot term is wrapping up",
    emailKind: "copilot_offboard",
  },
  upgrade: {
    file: "upgrade.html",
    subject: "[PLACEHOLDER] You've been upgraded in the Co-Pilot program",
    emailKind: "copilot_upgrade",
  },
  downgrade: {
    file: "downgrade.html",
    subject: "[PLACEHOLDER] Your Co-Pilot tier has been updated",
    emailKind: "copilot_downgrade",
  },
  freeze: {
    file: "freeze.html",
    subject: "[PLACEHOLDER] Your Co-Pilot membership is frozen",
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

function applyLinkHtml() {
  const href = String(config.copilotLinks?.applyUrl || "").trim();
  if (!href) return "Send them here to apply.";
  return `<a href="${escapeHtml(href)}">Send them here to apply.</a>`;
}

function htmlToPreview(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function locationName(region) {
  return isNycRegion(region) ? "New York" : "Toronto";
}

function discountPercent(tier) {
  const key = String(tier || "seeker").toLowerCase();
  return TIER_BENEFITS[key] ?? TIER_BENEFITS.seeker;
}

function renderLifecycleHtml(kind, input) {
  const spec = KINDS[kind];
  const tier = input.tier || "Seeker";
  return renderTemplateFile(path.join(emailsDir, spec.file), {
    firstName: firstNameOrHey(input.firstName),
    tier: escapeHtml(tier),
    tierUpper: escapeHtml(String(tier).toUpperCase()),
    newTier: escapeHtml(input.newTier || ""),
    region: escapeHtml(input.region || ""),
    locationName: escapeHtml(locationName(input.region)),
    offerLink: escapeHtml(input.offerLink || ""),
    promoCode: escapeHtml(input.promoCode || ""),
    expirationDate: escapeHtml(input.expirationDate || ""),
    discountPercent: escapeHtml(String(discountPercent(tier))),
    breathworkPersonalLink: linkOrPlaceholder(
      config.copilotLinks?.breathworkPersonalUrl
    ),
    breathworkCommunityLink: linkOrPlaceholder(
      config.copilotLinks?.breathworkCommunityUrl
    ),
    applyLink: applyLinkHtml(),
    signatureHtml: getEmailSignatureHtml(),
  });
}

/**
 * @param {{
 *   kind: 'acceptance'|'renewal'|'offboard'|'upgrade'|'downgrade'|'freeze',
 *   email: string,
 *   firstName?: string,
 *   lastName?: string,
 *   tier?: string,
 *   newTier?: string,
 *   region?: string,
 *   offerLink?: string,
 *   promoCode?: string,
 *   expirationDate?: string,
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

  if (input.dryRun) {
    console.log(`   📧 DRY_RUN would send`);
    console.log(`      To: ${input.email}`);
    console.log(`      Subject: ${spec.subject}`);
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

  const result = await sendCopilotEmail({
    to: input.email,
    from: config.email.from,
    subject: spec.subject,
    html,
    emailKind: spec.emailKind,
    logContext: {
      tier: input.tier || null,
      newTier: input.newTier || null,
    },
  });

  console.log(`   📧 ${input.kind} sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    messageId: result.messageId,
  };
}
