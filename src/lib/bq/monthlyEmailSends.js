import { config } from "../../config.js";
import {
  getGmailClient,
  isEmailSendConfigured,
  sanitizeEmailAddress,
} from "../email/gmailSend.js";
import { getBigQueryClient, getBqConfig } from "../bqConfig.js";

const TABLE = "copilot_monthly_email_sends";
let tableReady = false;

function tableRef() {
  const { projectId, dataset } = getBqConfig();
  if (!projectId) throw new Error("Missing required env var: BQ_PROJECT_ID");
  return `\`${projectId}.${dataset}.${TABLE}\``;
}

function emailKey(email) {
  return sanitizeEmailAddress(email).toLowerCase();
}

function queryOptions(params) {
  const { location } = getBqConfig();
  return { location, params };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureMonthlyEmailSendsTable() {
  if (tableReady) return;
  const { dataset, location } = getBqConfig();
  const bigquery = getBigQueryClient();
  const table = bigquery.dataset(dataset).table(TABLE);
  const [exists] = await table.exists();
  if (exists) {
    tableReady = true;
    return;
  }

  const query = `
    CREATE TABLE IF NOT EXISTS ${tableRef()} (
      contact_email STRING NOT NULL,
      month_key STRING NOT NULL,
      sent_at TIMESTAMP NOT NULL,
      message_id STRING,
      region STRING,
      to_email STRING
    )
  `;
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bigquery.query({ query, location });
      tableReady = true;
      return;
    } catch (error) {
      const message = error?.message || String(error);
      const rateLimited = /quota|rate limits/i.test(message);
      if (!rateLimited || attempt === maxAttempts) throw error;
      const waitMs = attempt * 15000;
      console.warn(
        `   ⏳ Table update quota — retry ${attempt}/${maxAttempts} in ${waitMs / 1000}s`
      );
      await sleep(waitMs);
    }
  }
}

/** Contact emails already recorded for YYYY-MM. */
export async function listMonthlyEmailSends(monthKey) {
  await ensureMonthlyEmailSendsTable();
  const bigquery = getBigQueryClient();
  const [rows] = await bigquery.query({
    query: `
      SELECT DISTINCT LOWER(TRIM(contact_email)) AS contact_email
      FROM ${tableRef()}
      WHERE month_key = @monthKey
        AND contact_email IS NOT NULL
        AND TRIM(contact_email) != ''
    `,
    ...queryOptions({ monthKey }),
  });
  return new Set(
    (rows || []).map((row) => emailKey(row.contact_email)).filter(Boolean)
  );
}

/**
 * Record a successful send. No-op when this contact email is already stored
 * for the month. Returns true when a new row was inserted.
 */
export async function recordMonthlyEmailSend({
  contactEmail,
  monthKey,
  messageId = "",
  region = "",
  toEmail = "",
} = {}) {
  const email = emailKey(contactEmail);
  const month = String(monthKey || "").trim();
  if (!email || !month) return false;
  await ensureMonthlyEmailSendsTable();
  const bigquery = getBigQueryClient();
  const [existing] = await bigquery.query({
    query: `
      SELECT 1 AS found
      FROM ${tableRef()}
      WHERE month_key = @monthKey
        AND LOWER(TRIM(contact_email)) = @email
      LIMIT 1
    `,
    ...queryOptions({ monthKey: month, email }),
  });
  if (existing?.length) return false;
  await bigquery.query({
    query: `
      INSERT INTO ${tableRef()} (
        contact_email, month_key, sent_at, message_id, region, to_email
      ) VALUES (
        @email, @monthKey, CURRENT_TIMESTAMP(), @messageId, @region, @toEmail
      )
    `,
    ...queryOptions({
      email,
      monthKey: month,
      messageId: String(messageId || ""),
      region: String(region || ""),
      toEmail: emailKey(toEmail) || email,
    }),
  });
  return true;
}

function headerMap(payload) {
  return Object.fromEntries(
    (payload?.headers || []).map((header) => [header.name, header.value])
  );
}

function regionFromSubject(subject) {
  if (/\bNYC\b/.test(subject)) return "NYC";
  if (/\bTO\b/.test(subject)) return "TO";
  return "";
}

/**
 * Record October (or whichever month) recipients already in the Co-Pilot
 * sent folder, so a batch that went out before this table existed is skipped.
 */
export async function backfillMonthlyEmailSendsFromGmail(monthLabel, monthKey) {
  if (!isEmailSendConfigured()) return 0;
  const label = String(monthLabel || "").trim();
  const month = String(monthKey || "").trim();
  if (!label || !month) return 0;

  const gmail = getGmailClient();
  const userId = String(config.email.gmailUser || "me").trim() || "me";
  const q = `in:sent subject:"${label} Co-Pilot Monthly Update"`;
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId,
      q,
      maxResults: 100,
      pageToken,
    });
    for (const message of res.data.messages || []) {
      if (message.id) ids.push(message.id);
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  let added = 0;
  for (const id of ids) {
    const meta = await gmail.users.messages.get({
      userId,
      id,
      format: "metadata",
      metadataHeaders: ["To", "Subject"],
    });
    const headers = headerMap(meta.data.payload);
    const subject = String(headers.Subject || "");
    if (!subject.includes(label) || !/Co-Pilot Monthly Update/i.test(subject)) {
      continue;
    }
    const to = emailKey(headers.To || "");
    if (!to) continue;
    const inserted = await recordMonthlyEmailSend({
      contactEmail: to,
      monthKey: month,
      messageId: id,
      region: regionFromSubject(subject),
      toEmail: to,
    });
    if (inserted) added++;
  }
  return added;
}
