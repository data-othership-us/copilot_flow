/**
 * Onboarding nudge for Accepted applicants missing MT account and/or CC.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import {
  isEmailSendConfigured,
  renderTemplateFile,
  sendCopilotEmail,
} from "../email/gmailSend.js";
import { getEmailSignatureHtml } from "../email/signature.js";
import {
  buildNudgeStepsHtml,
  nudgeIntroLine,
} from "../email/templateSteps.js";

const emailsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails"
);

export function getOnboardingBlockers(mt) {
  const blockers = [];
  if (!mt?.mtAccountExists) blockers.push("no_mt_account");
  else if (!mt?.mtHasCc) blockers.push("no_cc");
  return blockers;
}

export function formatNudgeReason(blockers) {
  if (!blockers.length) return "";
  if (blockers.includes("no_mt_account") && blockers.includes("no_cc")) {
    return "Missing Othership account and credit card on file";
  }
  if (blockers.includes("no_mt_account")) {
    return "Missing Othership (Mariana Tek) account";
  }
  if (blockers.includes("no_cc")) {
    return "Missing valid credit card on file";
  }
  return blockers.join(", ");
}

function firstNameOrHey(firstName) {
  return String(firstName || "").trim() || "there";
}

/**
 * @param {{
 *   email: string,
 *   firstName?: string,
 *   lastName?: string,
 *   blockers: string[],
 *   hasMtAccount?: boolean,
 *   dryRun?: boolean,
 * }} input
 * @returns {Promise<{ sent: boolean, channel: string, detail: string, messageId?: string }>}
 */
export async function sendOnboardingNudge(input) {
  const reason = formatNudgeReason(input.blockers);
  const name =
    [input.firstName, input.lastName].filter(Boolean).join(" ") || input.email;
  const hasMtAccount =
    input.hasMtAccount != null
      ? Boolean(input.hasMtAccount)
      : !input.blockers.includes("no_mt_account");
  const detail = `Nudge ${name} <${input.email}> — ${reason}`;

  if (input.dryRun) {
    console.log(`   (DRY_RUN: would send onboarding nudge email: ${detail})`);
    return { sent: false, channel: "email", detail: `dry_run: ${detail}` };
  }

  if (!isEmailSendConfigured()) {
    console.log(
      `   📧 Onboarding nudge (Gmail not configured yet — Notion flags only): ${detail}`
    );
    return { sent: false, channel: "stub", detail };
  }

  const html = renderTemplateFile(
    path.join(emailsDir, "nudgeAccountCc.html"),
    {
      firstName: firstNameOrHey(input.firstName),
      signatureHtml: getEmailSignatureHtml(),
      introLine: nudgeIntroLine(hasMtAccount),
      stepsHtml: buildNudgeStepsHtml({
        hasMtAccount,
        applicantEmail: input.email,
      }),
    }
  );

  const result = await sendCopilotEmail({
    to: input.email,
    from: config.email.from,
    subject: "🧑‍🚀 One Step to Activate Your Co-Pilots Membership",
    html,
    emailKind: "copilot_onboarding_nudge",
    logContext: {
      blockers: input.blockers.join(","),
      hasMtAccount,
    },
  });

  console.log(`   📧 Onboarding nudge sent (${result.messageId || "ok"})`);
  return {
    sent: true,
    channel: "gmail_api",
    detail,
    messageId: result.messageId,
  };
}
