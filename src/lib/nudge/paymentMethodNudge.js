/**
 * Review-tab nudge when a new Co-Pilot membership cannot be assigned
 * because there is no payment method on file, or the card is expired.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { firstNameOrHey } from "../copilotIdentity.js";
import {
  isEmailSendConfigured,
  isInvalidRecipientError,
  renderTemplateFile,
  sendCopilotEmail,
} from "../email/gmailSend.js";
import { getEmailSignatureHtml } from "../email/signature.js";
import { htmlToPreview } from "../email/htmlToPreview.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

const COPY = {
  onboard: {
    actionPhrase: "activate your Co-Pilot membership",
    completionPhrase: "your onboarding",
    subject: "💳 One Step to Activate Your Co-Pilot Membership",
  },
  renew: {
    actionPhrase: "renew your Co-Pilot membership",
    completionPhrase: "your renewal",
    subject: "💳 One Step to Complete Your Co-Pilot Renewal",
  },
  upgrade: {
    actionPhrase: "upgrade your Co-Pilot membership",
    completionPhrase: "your upgrade",
    subject: "💳 One Step to Complete Your Co-Pilot Upgrade",
  },
  downgrade: {
    actionPhrase: "update your Co-Pilot membership",
    completionPhrase: "the membership change",
    subject: "💳 One Step to Complete Your Co-Pilot Membership Change",
  },
};

function copyForDecision(decision) {
  const key = String(decision || "")
    .trim()
    .toLowerCase();
  return COPY[key] || COPY.renew;
}

export function coerceTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "object" && typeof value.value === "string") {
    const d = new Date(value.value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isPaymentNudgeOnCooldown(row) {
  const last = coerceTimestamp(row?.payment_nudge_at);
  if (!last) return false;
  const days = Number(config.nudgeCooldownDays) || 3;
  return Date.now() - last.getTime() < days * 24 * 60 * 60 * 1000;
}

export function isPaymentNudgeHold(result) {
  return String(result || "").startsWith("nudged_payment_method");
}

/**
 * @param {{
 *   email: string,
 *   mtEmail?: string,
 *   firstName?: string,
 *   lastName?: string,
 *   decision: string,
 *   dryRun?: boolean,
 *   requireSend?: boolean,
 * }} input
 */
export async function sendPaymentMethodNudge(input) {
  const copy = copyForDecision(input.decision);
  const name =
    [input.firstName, input.lastName].filter(Boolean).join(" ") || input.email;
  const detail = `payment_nudge ${name} <${input.email}> (${input.decision})`;
  const html = renderTemplateFile(path.join(emailsDir, "nudgePaymentMethod.html"), {
    firstName: firstNameOrHey(input.firstName),
    actionPhrase: copy.actionPhrase,
    completionPhrase: copy.completionPhrase,
    signatureHtml: getEmailSignatureHtml(),
  });

  if (input.dryRun) {
    console.log(`   📧 DRY_RUN would send payment-method nudge`);
    console.log(`      To: ${input.email}`);
    console.log(`      Subject: ${copy.subject}`);
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
        `Gmail not configured — cannot send payment-method nudge to ${input.email}`
      );
    }
    console.log(`   📧 payment nudge (Gmail not configured — skipped): ${detail}`);
    return { sent: false, channel: "stub", detail };
  }

  let result;
  try {
    result = await sendCopilotEmail({
      to: input.email,
      fallbackTo: input.mtEmail,
      from: config.email.from,
      subject: copy.subject,
      html,
      emailKind: "copilot_payment_nudge",
      logContext: { decision: input.decision || null },
    });
  } catch (error) {
    if (isInvalidRecipientError(error)) {
      console.warn(
        `   ⚠️  skip payment-method nudge — bad To address (${input.email})`
      );
      return { sent: false, channel: "invalid_to", detail };
    }
    throw error;
  }

  console.log(`   📧 payment-method nudge sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    messageId: result.messageId,
  };
}
