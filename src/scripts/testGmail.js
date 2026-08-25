/**
 * Smoke-test Co-Pilot Gmail send.
 *
 *   npm run test-gmail -- you@othership.com
 */
import dotenv from "dotenv";
import { config } from "../config.js";
import {
  isEmailSendConfigured,
  sendCopilotEmail,
  validateEmailSenderConfig,
} from "../lib/email/gmailSend.js";

dotenv.config();

const to = String(process.argv[2] || "").trim();
if (!to) {
  console.error("Usage: npm run test-gmail -- recipient@example.com");
  process.exit(1);
}

if (!isEmailSendConfigured()) {
  validateEmailSenderConfig();
}

const result = await sendCopilotEmail({
  to,
  from: config.email.from,
  subject: "[copilot-flow] Gmail API smoke test",
  html: `<p>Hello from <strong>copilot-flow</strong>.</p><p>If you received this, Gmail API auth for the Co-Pilot mailbox is working.</p>`,
  emailKind: "gmail_smoke_test",
});

console.log("✅ Sent", result);
