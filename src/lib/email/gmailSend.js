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
const cachedLabelIds = new Map();

/** Gmail labels for post-application Review / lifecycle mail. */
const MANAGEMENT_EMAIL_KINDS = new Set([
  "copilot_renewal",
  "copilot_offboard",
  "copilot_upgrade",
  "copilot_downgrade",
  "copilot_freeze",
  "copilot_payment_nudge",
  "copilot_resubmit_handles",
  "copilot_monthly",
]);

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

function labelConfigForKind(emailKind) {
  if (MANAGEMENT_EMAIL_KINDS.has(String(emailKind || "").trim())) {
    return {
      name: config.email.gmailLabelNameManagement,
      pinnedId: config.email.gmailLabelIdManagement,
    };
  }
  return {
    name: config.email.gmailLabelName,
    pinnedId: config.email.gmailLabelId,
  };
}

async function resolveLabelId(gmail, userId, { name, pinnedId } = {}) {
  const pin = String(pinnedId || "").trim();
  if (pin) {
    if (!isCustomUserLabelId(pin)) {
      console.warn(
        `⚠️ Ignoring non-custom Gmail label id="${pin}". Expected Label_…`
      );
      return "";
    }
    return pin;
  }
  const labelName = String(name || "").trim();
  if (!labelName) return "";
  if (cachedLabelIds.has(labelName)) return cachedLabelIds.get(labelName);

  const labelsResp = await gmail.users.labels.list({ userId });
  const existing = (labelsResp.data.labels || []).find((l) => l.name === labelName);
  if (existing?.id) {
    cachedLabelIds.set(labelName, existing.id);
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
  const id = created.data.id || "";
  if (id) cachedLabelIds.set(labelName, id);
  return id;
}

async function applyConfiguredLabel(gmail, userId, messageId, emailKind) {
  if (!messageId || !config.email.gmailAutoLabel) return;
  const { name, pinnedId } = labelConfigForKind(emailKind);
  const labelId = await resolveLabelId(gmail, userId, { name, pinnedId });
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

/**
 * Strip wrapping junk so a trailing period / mailto / angle brackets
 * do not fail Gmail's To header.
 */
export function sanitizeEmailAddress(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^mailto:/i, "").trim();
  const angled = s.match(/<([^>]+)>/);
  if (angled) s = angled[1].trim();
  s = s.replace(/^['"]+|['"]+$/g, "").trim();
  s = s.replace(/^[,;:\s]+/, "").replace(/[,;:\s.]+$/g, "");
  return s;
}

export function isPlausibleEmailAddress(value) {
  const s = sanitizeEmailAddress(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function isInvalidRecipientError(error) {
  if (!error) return false;
  if (error.code === "invalid_recipient") return true;
  const blob = `${error.message || ""} ${JSON.stringify(error.response?.data || "")}`;
  return /invalid to header/i.test(blob);
}

function invalidRecipientError(raw) {
  const err = new Error(`Invalid To address: ${JSON.stringify(raw)}`);
  err.code = "invalid_recipient";
  return err;
}

function recipientCandidates(primary, fallback) {
  const out = [];
  const seen = new Set();
  for (const raw of [primary, fallback]) {
    const s = sanitizeEmailAddress(raw);
    if (!s || !isPlausibleEmailAddress(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** Othership eggplant (brand ink) for bold copy. */
export const EGGPLANT = "#372338";

function applyEggplantToBold(html) {
  return String(html || "").replace(/<(strong|b)\b([^>]*)>/gi, (full, tag, attrs) => {
    const attr = attrs || "";
    if (/style\s*=/i.test(attr)) {
      if (/color\s*:/i.test(attr)) return full;
      return `<${tag}${attr.replace(
        /style\s*=\s*(["'])([^"']*)\1/i,
        (_, q, style) => `style=${q}${style}; color: ${EGGPLANT}${q}`
      )}>`;
    }
    return `<${tag}${attr} style="color: ${EGGPLANT}">`;
  });
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
 * @param {string} [p.fallbackTo] MT email if contact To is rejected
 * @param {string} [p.from]
 * @param {string} p.subject
 * @param {string} p.html
 * @param {string} [p.cc]
 * @param {boolean} [p.applyLabel]
 * @param {string} [p.emailKind]
 * @param {Record<string, unknown>} [p.logContext]
 * @returns {Promise<{ messageId: string, threadId: string, to: string }>}
 */
export async function sendCopilotEmail(p) {
  validateEmailSenderConfig();
  const from = String(p.from || config.email.from || "").trim();
  if (!from) {
    throw new Error("Missing EMAIL_FROM (or p.from) for Co-Pilot send");
  }

  const candidates = recipientCandidates(p.to, p.fallbackTo);
  if (!candidates.length) {
    throw invalidRecipientError(p.to);
  }

  const gmail = getGmailClient();
  const userId = String(config.email.gmailUser || "me").trim() || "me";
  const html = applyEggplantToBold(p.html);
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const to = candidates[i];
    try {
      const response = await gmail.users.messages.send({
        userId,
        requestBody: {
          raw: toBase64Url(
            buildMimeMessage({
              from,
              to,
              cc: p.cc,
              subject: p.subject,
              html,
            })
          ),
        },
      });

      const messageId = response.data.id || "";
      const threadId = response.data.threadId || "";
      const kind = String(p.emailKind || "").trim();
      if (p.applyLabel !== false) {
        await applyConfiguredLabel(gmail, userId, messageId, kind);
      }

      if (to.toLowerCase() !== sanitizeEmailAddress(p.to).toLowerCase()) {
        console.warn(
          `   📧 sent to MT email ${to} (contact email failed: ${p.to})`
        );
      }

      if (kind) {
        const { name: gmailLabel } = labelConfigForKind(kind);
        console.log(
          JSON.stringify({
            event: "copilot_email_sent",
            emailKind: kind,
            gmailLabel,
            to,
            subject: String(p.subject || "").trim().slice(0, 240),
            messageId,
            threadId,
            ...(p.logContext && typeof p.logContext === "object"
              ? p.logContext
              : {}),
          })
        );
      }

      return { messageId, threadId, to };
    } catch (error) {
      if (!isInvalidRecipientError(error)) throw error;
      lastError = invalidRecipientError(to);
      const next = candidates[i + 1];
      if (next) {
        console.warn(`   ⚠️  To ${to} rejected — trying ${next}`);
      }
    }
  }

  throw lastError || invalidRecipientError(p.to);
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
