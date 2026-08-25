/**
 * Assign Seeker co-pilot memberships by email via cart/checkout.
 *
 * Usage:
 *   node assignMembershipsToUsers.js [emails.txt]
 *   EMAILS="a@x.com,b@x.com" node assignMembershipsToUsers.js
 *   DRY_RUN=1 node assignMembershipsToUsers.js seeker_emails.txt
 */
import { assignMembershipsToUsers, loadEmails } from "../lib/workflows/copilots/assignMembershipsToUsers.js";

const EMAILS_ENV = process.env.EMAILS || "";
const EMAILS_FILE = process.env.EMAILS_FILE || process.argv[2] || "seeker_emails.txt";
const cliEmails = process.argv.slice(EMAILS_FILE && process.argv[2] === EMAILS_FILE ? 3 : 2);

if (loadEmails({ emailsEnv: EMAILS_ENV, emailsFile: EMAILS_FILE, cliEmails }).length === 0) {
  console.error("No emails provided. Pass a file path or set EMAILS / EMAILS_FILE.");
  console.error("Example: node assignMembershipsToUsers.js seeker_emails.txt");
  process.exit(1);
}

assignMembershipsToUsers({ emailsEnv: EMAILS_ENV, emailsFile: EMAILS_FILE, cliEmails })
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
