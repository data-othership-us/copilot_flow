/**
 * Gmail send helpers (ported from email-automations).
 * Co-Pilot mailbox uses its own OAuth refresh token — not Robbie's.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { config } from "../../config.js";

let cachedGmailClient = null;
let cachedResolvedLabelId = null;

export function getEmailSendMethod() {
  return String(config.email.sendMethod || "gmail_api").trim().toLowerCase();
}

export function getGmailRefreshToken() {
  return String(config.email.gmailRefreshToken || "").trim();
}

export function isEmailSendConfigured() {
  const method = getEmailSendMethod();
  if (method === "gmail_api") {
    return Boolean(
      config.email.gmailClientId &&
        config.email.gmailClientSecret &&
        getGmailRefreshToken()
    );
  }
  return false;
}

export function validateEmailSenderConfig() {
  const method = getEmailSendMethod();
  if (method !== "gmail_api") {
    throw new Error(
      `EMAIL_SEND_METHOD=${method} is not supported in copilot-flow (use gmail_api)`
    );
  }
  const missing = [];
  if (!config.email.gmailClientId) missing.push("GMAIL_API_CLIENT_ID");
  if (!config.email.gmailClientSecret) missing.push("GMAIL_API_CLIENT_SECRET");
  if (!getGmailRefreshToken()) {
    missing.push("GMAIL_REFRESH_TOKEN_COPILOT");
  }
  if (missing.length) {
    throw new Error(`Missing Gmail API config: ${missing.join(", ")}`);
  }
}

/** Minimal HTML → plain text for multipart/alternative. */
function htmlToPlainText(html) {
  return html
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function getGmailClient() {
  if (cachedGmailClient) return cachedGmailClient;
  validateEmailSenderConfig();
  const auth = new google.auth.OAuth2(
    config.email.gmailClientId,
    config.email.gmailClientSecret
  );
  auth.setCredentials({
    refresh_token: getGmailRefreshToken(),
  });
  cachedGmailClient = google.gmail({ version: "v1", auth });
  return cachedGmailClient;
}

function isCustomUserLabelId(labelId) {
  return /^Label_\d+$/i.test(String(labelId || "").trim());
}

async function resolveLabelId(gmail, userId) {
  if (cachedResolvedLabelId) return cachedResolvedLabelId;
  const configuredId = String(config.email.gmailLabelId || "").trim();
  if (configuredId) {
    if (!isCustomUserLabelId(configuredId)) {
      console.warn(
        `⚠️ Ignoring non-custom GMAIL_API_LABEL_ID="${configuredId}". Expected Label_…`
      );
      return "";
    }
    cachedResolvedLabelId = configuredId;
    return configuredId;
  }
  const labelName = String(config.email.gmailLabelName || "").trim();
  if (!labelName) return "";
  const labelsResp = await gmail.users.labels.list({ userId });
  const existing = (labelsResp.data.labels || []).find((l) => l.name === labelName);
  if (existing?.id) {
    cachedResolvedLabelId = existing.id;
    return existing.id;
  }
  const created = await gmail.users.labels.create({
    userId,
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  cachedResolvedLabelId = created.data.id || "";
  return cachedResolvedLabelId;
}

async function applyConfiguredLabel(gmail, userId, messageId) {
  if (!messageId || !config.email.gmailAutoLabel) return;
  const labelId = await resolveLabelId(gmail, userId);
  if (!labelId) return;
  await gmail.users.messages.modify({
    userId,
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function wrapBase64(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trim();
}

function toBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildMimeMessage(p) {
  const boundary = `copilot_flow_${randomBytes(12).toString("hex")}`;
  const cc = sanitizeHeader(p.cc || "");
  const lines = [
    `From: ${sanitizeHeader(p.from)}`,
    `To: ${sanitizeHeader(p.to)}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(p.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(htmlToPlainText(p.html)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(p.html),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

/**
 * @param {object} p
 * @param {string} p.to
 * @param {string} [p.from]
 * @param {string} p.subject
 * @param {string} p.html
 * @param {string} [p.cc]
 * @param {boolean} [p.applyLabel]
 * @param {string} [p.emailKind]
 * @param {Record<string, unknown>} [p.logContext]
 * @returns {Promise<{ messageId: string, threadId: string }>}
 */
export async function sendCopilotEmail(p) {
  validateEmailSenderConfig();
  const from = String(p.from || config.email.from || "").trim();
  if (!from) {
    throw new Error("Missing EMAIL_FROM (or p.from) for Co-Pilot send");
  }

  const gmail = getGmailClient();
  const userId = String(config.email.gmailUser || "me").trim() || "me";
  const response = await gmail.users.messages.send({
    userId,
    requestBody: {
      raw: toBase64Url(
        buildMimeMessage({
          from,
          to: p.to,
          cc: p.cc,
          subject: p.subject,
          html: p.html,
        })
      ),
    },
  });

  const messageId = response.data.id || "";
  const threadId = response.data.threadId || "";
  if (p.applyLabel !== false) {
    await applyConfiguredLabel(gmail, userId, messageId);
  }

  const kind = String(p.emailKind || "").trim();
  if (kind) {
    console.log(
      JSON.stringify({
        event: "copilot_email_sent",
        emailKind: kind,
        to: String(p.to || "").trim(),
        subject: String(p.subject || "").trim().slice(0, 240),
        messageId,
        threadId,
        ...(p.logContext && typeof p.logContext === "object" ? p.logContext : {}),
      })
    );
  }

  return { messageId, threadId };
}

/**
 * @param {string} filePath
 * @param {Record<string, string>} vars
 */
export function renderTemplateFile(filePath, vars) {
  const text = fs.readFileSync(filePath, "utf8");
  return renderTemplateString(text, vars);
}

export function renderTemplateString(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v ?? "");
  }
  return out;
}

export function moduleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}
