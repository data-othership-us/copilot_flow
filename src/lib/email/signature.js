import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";

const defaultSignaturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails/defaultSignature.html"
);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyLinkHtml() {
  const href = String(config.copilotLinks?.applyUrl || "").trim();
  if (!href) return "Send them here to apply.";
  return `<a href="${escapeHtml(href)}">${escapeHtml("Send them here to apply.")}</a>`;
}

/**
 * Othership Copilot signoff HTML. Gmail’s named mailbox signature is not
 * appended over the API, so this file is injected into every send.
 * @param {{ includeApplyLine?: boolean }} [opts]
 */
export function getEmailSignatureHtml({ includeApplyLine = true } = {}) {
  let html = fs.readFileSync(defaultSignaturePath, "utf8").trim();
  if (!includeApplyLine) {
    html = html.replace(
      /<div align="left"[\s\S]*?<\/div>\s*/,
      ""
    );
    return html.split("{{applyLink}}").join("");
  }
  return html.split("{{applyLink}}").join(applyLinkHtml());
}
