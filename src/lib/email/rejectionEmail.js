import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import {
  isEmailSendConfigured,
  renderTemplateFile,
  sendCopilotEmail,
} from "./gmailSend.js";
import { getEmailSignatureHtml } from "./signature.js";
import { buildRejectionCreditHtml } from "./templateSteps.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

function firstNameOrHey(firstName) {
  return String(firstName || "").trim() || "there";
}

/**
 * @param {{
 *   email: string,
 *   firstName?: string,
 *   lastName?: string,
 *   hasMtAccount?: boolean,
 *   dryRun?: boolean,
 * }} input
 */
export async function sendRejectionEmail(input) {
  const name =
    [input.firstName, input.lastName].filter(Boolean).join(" ") || input.email;
  const hasMtAccount = Boolean(input.hasMtAccount);
  const detail = `Rejection ${name} <${input.email}> (mt=${hasMtAccount})`;

  if (input.dryRun) {
    console.log(`   (DRY_RUN: would send rejection email: ${detail})`);
    return { sent: false, channel: "email", detail: `dry_run: ${detail}` };
  }

  if (!isEmailSendConfigured()) {
    console.log(
      `   📧 Rejection email (Gmail not configured yet — Notion/status only): ${detail}`
    );
    return { sent: false, channel: "stub", detail };
  }

  const html = renderTemplateFile(path.join(emailsDir, "rejection.html"), {
    firstName: firstNameOrHey(input.firstName),
    signatureHtml: getEmailSignatureHtml(),
    creditHtml: buildRejectionCreditHtml({
      hasMtAccount,
      applicantEmail: input.email,
    }),
  });

  const result = await sendCopilotEmail({
    to: input.email,
    from: config.email.from,
    subject: "🪐 Your Co-Pilot Application",
    html,
    emailKind: "copilot_rejection",
    logContext: { hasMtAccount },
  });

  console.log(`   📧 Rejection email sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    messageId: result.messageId,
  };
}
