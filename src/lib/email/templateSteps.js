/**
 * Build numbered step HTML for rejection / nudge emails.
 * Nudge: Step 1 (create account) only when no MT account exists.
 */

const ACCOUNT_URL = "https://www.othership.us/account";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Credit thank-you block. Same copy whether or not they already have an MT account;
 * the account-setup sentence is conditional in the prose.
 * @param {{ hasMtAccount?: boolean, applicantEmail: string }} input
 */
export function buildRejectionCreditHtml({ applicantEmail }) {
  const email = escapeHtml(applicantEmail);
  return [
    `<p>As a thank-you for your time, we'd like to send you a complimentary credit for the space.</p>`,
    `<p>If you don't already have an account, set up <a href="${ACCOUNT_URL}">HERE</a> using this exact email <strong>${email}</strong>.</p>`,
    `<p>Once your account is created, a credit will be automatically added within 2 business days. No need to reply to this email.</p>`,
  ].join("\n");
}

/**
 * @param {{ hasMtAccount: boolean, applicantEmail: string }} input
 */
export function buildNudgeStepsHtml({ hasMtAccount, applicantEmail }) {
  const email = escapeHtml(applicantEmail);
  const steps = [];

  if (!hasMtAccount) {
    steps.push(
      `If you don't already have an account, set up <a href="${ACCOUNT_URL}">HERE</a> using this exact email <strong>${email}</strong>.`
    );
  }

  steps.push(
    `Under <a href="${ACCOUNT_URL}">account information</a>, add a bank card as your payment method. This won't result in any charges; our system just requires a card on file to activate any memberships.`
  );

  return ol(steps);
}

export function nudgeIntroLine(hasMtAccount) {
  if (hasMtAccount) {
    return "This step is essential to activate your complimentary membership and set sail as a community member:";
  }
  return "These two steps are essential to activate your complimentary membership and set sail as a community member:";
}

function ol(items) {
  const lis = items.map((item) => `<li>${item}</li>`).join("");
  return `<ol>${lis}</ol>`;
}
