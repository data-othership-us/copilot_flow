/**
 * Ask a copilot to reply with a public Instagram (and optional TikTok) handle.
 * Used by Review decision `social` and the one-time email-resubmit-handles job.
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
} from "./gmailSend.js";
import { getEmailSignatureHtml } from "./signature.js";
import { htmlToPreview } from "./htmlToPreview.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

export const RESUBMIT_HANDLES_SUBJECT =
  "📸 Othership Copilot, Please Resubmit Your Social Handles";

export function renderResubmitHandlesEmail({ firstName } = {}) {
  const html = renderTemplateFile(
    path.join(emailsDir, "resubmitHandles.html"),
    {
      firstName: firstNameOrHey(firstName),
      signatureHtml: getEmailSignatureHtml(),
    }
  );
  return {
    subject: RESUBMIT_HANDLES_SUBJECT,
    html,
    preview: htmlToPreview(html),
  };
}

export function logResubmitHandlesEmailPreview({ firstName } = {}) {
  const { subject, preview } = renderResubmitHandlesEmail({ firstName });
  console.log(`   Subject: ${subject}`);
  console.log("   --- body ---");
  for (const line of preview.split("\n")) {
    console.log(`   ${line}`);
  }
  console.log("   --- end ---");
}

/**
 * @param {{
 *   email: string,
 *   mtEmail?: string,
 *   firstName?: string,
 *   lastName?: string,
 *   dryRun?: boolean,
 *   requireSend?: boolean,
 *   printBody?: boolean,
 * }} input
 */
export async function sendResubmitHandlesEmail(input) {
  const name =
    [input.firstName, input.lastName].filter(Boolean).join(" ") || input.email;
  const detail = `resubmit_handles ${name} <${input.email}>`;
  const { subject, html, preview } = renderResubmitHandlesEmail({
    firstName: input.firstName,
  });

  if (input.dryRun) {
    console.log(`   📧 DRY_RUN would send`);
    console.log(`      To: ${input.email}`);
    if (
      input.mtEmail &&
      String(input.mtEmail).trim() !== String(input.email || "").trim()
    ) {
      console.log(`      Fallback: ${input.mtEmail}`);
    }
    console.log(`      Subject: ${subject}`);
    if (input.printBody !== false) {
      console.log("      --- body ---");
      for (const line of preview.split("\n")) {
        console.log(`      ${line}`);
      }
      console.log("      --- end ---");
    }
    return { sent: false, channel: "email", detail: `dry_run: ${detail}` };
  }

  if (!isEmailSendConfigured()) {
    if (input.requireSend) {
      throw new Error(
        `Gmail not configured — cannot send resubmit-handles email to ${input.email}`
      );
    }
    console.log(
      `   📧 resubmit-handles (Gmail not configured — skipped): ${detail}`
    );
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
      emailKind: "copilot_resubmit_handles",
    });
  } catch (error) {
    if (isInvalidRecipientError(error)) {
      console.warn(
        `   ⚠️  skip resubmit-handles email — bad To address (${input.email})`
      );
      return { sent: false, channel: "invalid_to", detail };
    }
    throw error;
  }

  console.log(`   📧 resubmit-handles sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    messageId: result.messageId,
  };
}
