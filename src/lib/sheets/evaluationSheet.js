import { google } from "googleapis";
import { config } from "../../config.js";
import { isPlaceholderIgHandle, parseIgHandles } from "../instagram.js";

const REVIEW_HEADERS = [
  "first_name",
  "last_name",
  "email",
  "region",
  "tier",
  "days_to_expiry",
  "membership_status",
  "membership_name",
  "promo_code_status",
  "membership_start",
  "membership_end",
  "months_since_membership_start",
  "copilot_months_active",
  "social_playgrounds_attended",
  "last_social_playground",
  "classes_taken_current_membership",
  "last_class_date",
  "ig_handle",
  "ig_url",
  "ig_followers",
  "modash_impressions",
  "modash_stories_current_membership",
  "modash_feed_posts_current_membership",
  "social_requirement_met",
  "redemption_count_current_membership",
  "redemption_usd_current_membership",
  "redemption_cad_current_membership",
  "cycle_points",
  "redemption_count_all_time",
  "redemption_usd_all_time",
  "redemption_cad_all_time",
  "redemption_count_since_membership_end",
  "bb_sales",
  "hybrid_sales",
  "new_hybrid_sales",
  "decision",
  "freeze_until",
  "decision_notes",
];

function headerCol(name) {
  const i = REVIEW_HEADERS.indexOf(name);
  if (i < 0) throw new Error(`missing review header: ${name}`);
  return i;
}

const COL = {
  email: headerCol("email"),
  region: headerCol("region"),
  tier: headerCol("tier"),
  daysToExpiry: headerCol("days_to_expiry"),
  bbSales: headerCol("bb_sales"),
  hybridSales: headerCol("hybrid_sales"),
  newHybridSales: headerCol("new_hybrid_sales"),
  decision: headerCol("decision"),
  freezeUntil: headerCol("freeze_until"),
  decisionNotes: headerCol("decision_notes"),
};

const PRESERVED_COLS = [
  COL.decision,
  COL.freezeUntil,
  COL.decisionNotes,
  COL.bbSales,
  COL.hybridSales,
  COL.newHybridSales,
];

const DECISION_VALUES = [
  "onboard",
  "renew",
  "offboard",
  "never again",
  "upgrade",
  "downgrade",
  "snooze",
  "freeze",
];

export function isNeverAgainDecision(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return v === "never again" || v === "never_again";
}

export function isOffboardLikeDecision(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return v === "offboard" || isNeverAgainDecision(v);
}

function parseDaysToExpiry(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Offboard / never again / renew / upgrade / downgrade: ops can fill
 * Review in the 7-day window, but membership + email wait until last day
 * (days_to_expiry <= 0). Missing days_to_expiry holds so we do not apply early.
 */
export function shouldHoldUntilExpiry(item) {
  const decision = String(item?.decision || "")
    .trim()
    .toLowerCase();
  const hold =
    isOffboardLikeDecision(decision) ||
    decision === "renew" ||
    decision === "upgrade" ||
    decision === "downgrade";
  if (!hold) return false;
  const days = parseDaysToExpiry(item?.daysToExpiry);
  if (days == null) return true;
  return days > 0;
}

/** @deprecated use shouldHoldUntilExpiry */
export function shouldHoldOffboardUntilExpiry(item) {
  return shouldHoldUntilExpiry(item);
}

const VALIDATION_ROW_CAP = 8000;

function colLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function lastCol() {
  return colLetter(REVIEW_HEADERS.length - 1);
}

const TIER_SORT_RANK = {
  seeker: 0,
  wayfinder: 1,
  luminary: 2,
};

function textKey(value) {
  return String(value || "").trim();
}

function tierSortRank(tier) {
  const key = textKey(tier).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIER_SORT_RANK, key)
    ? TIER_SORT_RANK[key]
    : 9;
}

function daysSortValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** Region A–Z, then Seeker → Wayfinder → Luminary, then soonest expiry. */
export function compareReviewRows(a, b) {
  const ra = textKey(a[COL.region]);
  const rb = textKey(b[COL.region]);
  if (!ra !== !rb) return ra ? -1 : 1;
  const region = ra.localeCompare(rb, undefined, { sensitivity: "base" });
  if (region) return region;
  const tier = tierSortRank(a[COL.tier]) - tierSortRank(b[COL.tier]);
  if (tier) return tier;
  const days =
    daysSortValue(a[COL.daysToExpiry]) - daysSortValue(b[COL.daysToExpiry]);
  if (days) return days;
  return textKey(a[COL.email]).localeCompare(textKey(b[COL.email]), undefined, {
    sensitivity: "base",
  });
}

function sheetId() {
  const id = config.evaluation?.sheetId || process.env.EVALUATION_SHEET_ID;
  if (!id) throw new Error("Missing EVALUATION_SHEET_ID");
  return id;
}

function reviewTab() {
  return config.evaluation?.reviewTab || "Review";
}

function addToModashTab() {
  return config.evaluation?.addToModashTab || "Add to Modash";
}

const ADD_TO_MODASH_HEADERS = [
  "first_name",
  "last_name",
  "email",
  "region",
  "tier",
  "ig_handle",
  "ig_url",
  "ig_followers",
  "membership_status",
  "membership_end",
];

export function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  return google.sheets({ version: "v4", auth });
}

function fmtTs(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && typeof value.value === "string") {
    return value.value;
  }
  return String(value);
}

/** Eastern wall-clock from copilot_performance DATETIME columns. */
function fmtEst(value) {
  if (!value) return "";
  if (typeof value === "object" && typeof value.value === "string") {
    return value.value.replace("T", " ").replace(/Z$/, "").slice(0, 19);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(value);
  }
  return String(value).replace("T", " ").replace(/Z$/, "").slice(0, 19);
}

function fmtNum(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object" && value.value != null) return value.value;
  return value;
}

function fmtBool(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object" && value.value != null)
    return fmtBool(value.value);
  if (value === true || value === "true") return "TRUE";
  if (value === false || value === "false") return "FALSE";
  return String(value);
}

function fmtDate(value) {
  if (!value) return "";
  if (typeof value === "object" && typeof value.value === "string") {
    return value.value.slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }
  return String(value).slice(0, 10);
}

export function parseFreezeUntil(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value != null && typeof value === "object" && value.value != null) {
    return parseFreezeUntil(value.value);
  }
  const s = String(value ?? "").trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0),
    );
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD for BigQuery DATE, or null if empty/invalid. */
export function freezeUntilDateString(value) {
  const d = parseFreezeUntil(value);
  if (!d) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function cellFilled(value) {
  return String(value ?? "").trim() !== "";
}

export function parseMoney(value) {
  if (value != null && typeof value === "object" && value.value != null) {
    value = value.value;
  }
  const s = String(value ?? "")
    .replace(/[$,\s]/g, "")
    .trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function ensureTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = new Set(
    (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean),
  );
  const requests = [];
  for (const title of [reviewTab(), addToModashTab()]) {
    if (!titles.has(title)) {
      requests.push({ addSheet: { properties: { title } } });
    }
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

async function sheetProps(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = (meta.data.sheets || []).find(
    (s) => s.properties?.title === title,
  );
  if (!found) return null;
  return {
    sheetId: found.properties?.sheetId,
    rowCount: found.properties?.gridProperties?.rowCount ?? 0,
    columnCount: found.properties?.gridProperties?.columnCount ?? 0,
  };
}

async function sheetNumericId(sheets, spreadsheetId, title) {
  const props = await sheetProps(sheets, spreadsheetId, title);
  return props?.sheetId;
}

/** Grow a tab so validation / writes are inside the grid. */
async function ensureGridSize(sheets, spreadsheetId, title, { rows, columns }) {
  const props = await sheetProps(sheets, spreadsheetId, title);
  if (props?.sheetId == null) return null;
  const requests = [];
  if (columns > props.columnCount) {
    requests.push({
      appendDimension: {
        sheetId: props.sheetId,
        dimension: "COLUMNS",
        length: columns - props.columnCount,
      },
    });
  }
  if (rows > props.rowCount) {
    requests.push({
      appendDimension: {
        sheetId: props.sheetId,
        dimension: "ROWS",
        length: rows - props.rowCount,
      },
    });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
  return props.sheetId;
}

function dateValidation(columnIndex) {
  return {
    setDataValidation: {
      range: {
        startRowIndex: 1,
        endRowIndex: VALIDATION_ROW_CAP,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rule: {
        condition: { type: "DATE_IS_VALID" },
        strict: false,
        showCustomUi: true,
      },
    },
  };
}

function listValidation(columnIndex, values, { strict }) {
  return {
    setDataValidation: {
      range: {
        startRowIndex: 1,
        endRowIndex: VALIDATION_ROW_CAP,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: values.map((v) => ({ userEnteredValue: v })),
        },
        strict,
        showCustomUi: true,
      },
    },
  };
}

function clearValidations(endColumnIndex) {
  return {
    setDataValidation: {
      range: {
        startRowIndex: 1,
        endRowIndex: VALIDATION_ROW_CAP,
        startColumnIndex: 0,
        endColumnIndex: Math.max(endColumnIndex, REVIEW_HEADERS.length + 8),
      },
    },
  };
}

async function ensureDropdowns(sheets, spreadsheetId) {
  const reviewId = await ensureGridSize(sheets, spreadsheetId, reviewTab(), {
    rows: VALIDATION_ROW_CAP,
    columns: REVIEW_HEADERS.length,
  });
  if (reviewId == null) return;
  const withSheet = (req) => ({
    setDataValidation: {
      ...req.setDataValidation,
      range: { ...req.setDataValidation.range, sheetId: reviewId },
    },
  });
  const props = await sheetProps(sheets, spreadsheetId, reviewTab());
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        withSheet(
          clearValidations(props?.columnCount || REVIEW_HEADERS.length),
        ),
        withSheet(
          listValidation(COL.decision, DECISION_VALUES, { strict: true }),
        ),
        withSheet(dateValidation(COL.freezeUntil)),
      ],
    },
  });
}

export const RESUBMIT_HANDLE_NOTE = "need to resubmit social handles";
export const NO_MT_ACCOUNT_NOTE = "No MT account found";

export function isResubmitIgRow(r) {
  const raw = `${r?.ig_handle || ""} ${r?.ig_url || ""}`;
  return /re-?submit/i.test(raw) || isPlaceholderIgHandle(r?.ig_handle);
}

export function isMissingMtAccountRow(r) {
  return !String(r?.user_id ?? "").trim();
}

function appendDecisionNote(existing, note) {
  const cur = String(existing || "").trim();
  if (!note) return cur;
  if (!cur) return note;
  if (cur.toLowerCase().includes(note.toLowerCase())) return cur;
  return `${cur}; ${note}`;
}

/** Stamp queue-flag notes without wiping ops / payment-nudge notes. */
export function withQueueFlagNotes(cells, rec) {
  const out = [...cells];
  let notes = out[COL.decisionNotes];
  if (isResubmitIgRow(rec)) {
    notes = appendDecisionNote(notes, RESUBMIT_HANDLE_NOTE);
  }
  if (isMissingMtAccountRow(rec)) {
    notes = appendDecisionNote(notes, NO_MT_ACCOUNT_NOTE);
  }
  out[COL.decisionNotes] = notes;
  return out;
}

export function rowFromQueue(r) {
  return [
    r.first_name || "",
    r.last_name || "",
    String(r.contact_email || "")
      .trim()
      .toLowerCase(),
    r.region || "",
    r.tier || "",
    fmtNum(r.days_to_expiry),
    r.membership_status || "",
    r.membership_name || "",
    r.promo_code_status || "",
    fmtDate(r.membership_start),
    fmtDate(r.membership_end),
    fmtNum(r.months_since_membership_start),
    fmtNum(r.copilot_months_active),
    fmtNum(r.social_playgrounds_attended),
    r.last_social_playground || "",
    fmtNum(r.classes_taken_current_membership),
    fmtDate(r.last_class_date),
    ...reviewIgCells(r),
    fmtNum(r.ig_followers),
    fmtNum(r.modash_impressions),
    fmtNum(r.modash_stories_current_membership),
    fmtNum(r.modash_feed_posts_current_membership),
    fmtBool(r.social_requirement_met),
    fmtNum(r.redemption_count_current_membership),
    fmtNum(r.redemption_usd_current_membership),
    fmtNum(r.redemption_cad_current_membership),
    fmtNum(r.cycle_points),
    fmtNum(r.redemption_count_all_time),
    fmtNum(r.redemption_usd_all_time),
    fmtNum(r.redemption_cad_all_time),
    fmtNum(r.redemption_count_since_membership_end),
    fmtNum(r.bb_sales),
    fmtNum(r.hybrid_sales),
    fmtNum(r.new_hybrid_sales),
    "",
    "",
    "",
  ];
}

function parseSheetRows(values) {
  const header = values?.[0] || [];
  const idx = {};
  for (let i = 0; i < header.length; i++) {
    idx[
      String(header[i] || "")
        .trim()
        .toLowerCase()
    ] = i;
  }
  const rows = [];
  for (let r = 1; r < (values || []).length; r++) {
    const line = values[r] || [];
    const email = String(line[idx.email] || "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    rows.push({
      rowNumber: r + 1,
      email,
      cells: REVIEW_HEADERS.map((h) => line[idx[h]] ?? ""),
    });
  }
  return { idx, rows };
}

export async function readTab(tabName) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId(),
    range: `'${tabName}'!A:${lastCol()}`,
  });
  return parseSheetRows(res.data.values || []);
}

async function writeTabRows(
  sheets,
  spreadsheetId,
  tab,
  headers,
  rows,
  { valueInputOption = "RAW" } = {},
) {
  const props = await sheetProps(sheets, spreadsheetId, tab);
  const end = colLetter(Math.max(headers.length, props?.columnCount || 0) - 1);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${tab}'!A:${end}`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tab}'!A1`,
    valueInputOption,
    requestBody: { values: [headers, ...rows] },
  });
}

async function writeReviewRows(sheets, spreadsheetId, tab, rows) {
  await writeTabRows(sheets, spreadsheetId, tab, REVIEW_HEADERS, rows);
}

function reviewIgCells(r) {
  const raw = r.ig_handle || r.ig_url || "";
  const handles = parseIgHandles(raw);
  if (handles.length) {
    return [
      handles.map((h) => `@${h}`).join("\n"),
      handles.map((h) => `https://www.instagram.com/${h}/`).join("\n"),
    ];
  }
  if (isPlaceholderIgHandle(raw) || /re-?submit/i.test(String(raw))) {
    return ["re-submit", ""];
  }
  return [r.ig_handle || "", r.ig_url || ""];
}

function handleKey(handle) {
  const parsed = parseIgHandles(handle);
  return parsed[0] || "";
}

/** One sheet row per missing handle so the ig_handle column pastes into Modash. */
export function rowsFromAddToModash(r) {
  const handles = parseIgHandles(
    [r.ig_handle, r.ig_url].filter(Boolean).join("\n")
  );
  return handles.map((bare) => [
    r.first_name || "",
    r.last_name || "",
    String(r.contact_email || "").trim().toLowerCase(),
    r.region || "",
    r.tier || "",
    `@${bare}`,
    `https://www.instagram.com/${bare}/`,
    fmtNum(r.ig_followers),
    r.membership_status || "",
    fmtDate(r.membership_end),
  ]);
}

/**
 * Rewrite Add to Modash in place. Creates the tab only if it is missing;
 * never deletes the sheet. Clears values, then writes today's queue
 * (one row per missing handle + clickable ig_url). Copy the ig_handle
 * column into a Modash campaign.
 */
export async function writeAddToModashQueue(queueRows) {
  const sheets = getSheetsClient();
  const id = sheetId();
  const tab = addToModashTab();

  await ensureTabs(sheets, id);
  await ensureGridSize(sheets, id, tab, {
    rows: Math.max(queueRows.length + 1, 2),
    columns: ADD_TO_MODASH_HEADERS.length,
  });

  const rebuilt = [];
  const seen = new Set();
  for (const rec of queueRows) {
    for (const next of rowsFromAddToModash(rec)) {
      const key = handleKey(next[5]);
      if (!key || seen.has(key)) continue;
      rebuilt.push(next);
      seen.add(key);
    }
  }

  await ensureGridSize(sheets, id, tab, {
    rows: Math.max(rebuilt.length + 1, 2),
    columns: ADD_TO_MODASH_HEADERS.length,
  });

  await writeTabRows(sheets, id, tab, ADD_TO_MODASH_HEADERS, rebuilt, {
    valueInputOption: "USER_ENTERED",
  });

  return { total: rebuilt.length, rebuilt: true };
}

/**
 * Rewrite Review from the queue, sorted by region → tier → days to expiry.
 * Preserves Christine's decision / freeze_until / decision_notes / bb_sales /
 * hybrid_sales / new_hybrid_sales for people still in the queue. If someone
 * drops out (live term with more than 7 days left), they leave Review.
 * `unappliedByEmail` restores those cells from copilot_db when they re-enter
 * and the sheet cell is blank.
 */
export async function appendReviewQueue(queueRows, { unappliedByEmail } = {}) {
  const sheets = getSheetsClient();
  const id = sheetId();
  const tab = reviewTab();
  const unapplied =
    unappliedByEmail instanceof Map
      ? unappliedByEmail
      : new Map(
          Object.entries(unappliedByEmail || {}).map(([k, v]) => [
            String(k).trim().toLowerCase(),
            v,
          ]),
        );

  await ensureTabs(sheets, id);

  const existingRes = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `'${tab}'!A:${lastCol()}`,
  });
  const existingValues = existingRes.data.values || [];
  const { rows: reviewRows } = parseSheetRows(existingValues);

  await ensureDropdowns(sheets, id);

  const byEmail = new Map(reviewRows.map((r) => [r.email, r]));

  function mergePreserved(next, found) {
    let merged = [...next];
    if (found) {
      for (const i of PRESERVED_COLS) {
        if (cellFilled(found.cells[i])) merged[i] = found.cells[i];
      }
    }
    const email = String(merged[COL.email] || "")
      .trim()
      .toLowerCase();
    return overlayUnappliedDecision(merged, unapplied.get(email));
  }

  const rebuilt = [];
  const seen = new Set();
  let skipped = 0;
  let appended = 0;
  const carried = 0;

  for (const rec of queueRows) {
    const next = rowFromQueue(rec);
    const email = next[COL.email];
    if (!email || seen.has(email)) continue;
    if (byEmail.has(email)) skipped++;
    else appended++;
    rebuilt.push(
      withQueueFlagNotes(mergePreserved(next, byEmail.get(email)), rec),
    );
    seen.add(email);
  }

  rebuilt.sort(compareReviewRows);
  await writeReviewRows(sheets, id, tab, rebuilt);
  await ensureDropdowns(sheets, id);

  return {
    appended,
    skipped,
    carried,
    total: rebuilt.length,
    rebuilt: true,
  };
}

function padReviewCells(cells) {
  const out = Array(REVIEW_HEADERS.length).fill("");
  for (let i = 0; i < REVIEW_HEADERS.length; i++) {
    out[i] = cells?.[i] ?? "";
  }
  return out;
}

function sheetDecisionValue(value) {
  const parsed = parseDecision(value);
  if (parsed) return parsed;
  if (isNeverAgainDecision(value)) return "never again";
  return "";
}

function overlayUnappliedDecision(merged, unapplied) {
  if (!unapplied) return merged;
  const out = [...merged];
  const fromBq = sheetDecisionValue(unapplied.decision);
  if (!cellFilled(out[COL.decision]) && fromBq) {
    out[COL.decision] = fromBq;
  }
  if (
    !cellFilled(out[COL.decisionNotes]) &&
    cellFilled(unapplied.decision_notes)
  ) {
    out[COL.decisionNotes] = String(unapplied.decision_notes).trim();
  }
  if (!cellFilled(out[COL.freezeUntil]) && unapplied.freeze_until) {
    const freeze = freezeUntilDateString(unapplied.freeze_until);
    if (freeze) out[COL.freezeUntil] = freeze;
  }
  return out;
}

export function parseDecision(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (DECISION_VALUES.includes(v)) return v;
  return "";
}

const PAYMENT_NUDGE_NOTE = "payment method nudge sent";

/** Keep ops notes; add the hold marker if it is not already there. */
export function withPaymentNudgeNote(existing) {
  const cur = String(existing || "").trim();
  if (!cur) return PAYMENT_NUDGE_NOTE;
  if (cur.toLowerCase().includes("payment method nudge")) return cur;
  return `${cur}; ${PAYMENT_NUDGE_NOTE}`;
}

/** Write decision_notes on the Review row for this email. Returns false if missing. */
export async function patchReviewDecisionNotes(email, notes) {
  const key = String(email || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  const { rows } = await readTab(reviewTab());
  const found = rows.find((r) => r.email === key);
  if (!found) return false;
  const sheets = getSheetsClient();
  const col = colLetter(COL.decisionNotes);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId(),
    range: `'${reviewTab()}'!${col}${found.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[notes]] },
  });
  return true;
}

export async function listSalesWritebacks(queueRows) {
  const { rows } = await readTab(reviewTab());
  const fromQueue = new Map(
    (queueRows || []).map((r) => [
      String(r.contact_email || "")
        .trim()
        .toLowerCase(),
      r,
    ]),
  );
  const patches = [];
  for (const r of rows) {
    const q = fromQueue.get(r.email) || {};
    const bb = parseMoney(r.cells[COL.bbSales]);
    const hybrid = parseMoney(r.cells[COL.hybridSales]);
    const newHybrid = parseMoney(r.cells[COL.newHybridSales]);
    const fields = {};
    if (bb != null && bb !== parseMoney(q.bb_sales)) fields.bb_sales = bb;
    if (hybrid != null && hybrid !== parseMoney(q.hybrid_sales)) {
      fields.hybrid_sales = hybrid;
    }
    if (newHybrid != null && newHybrid !== parseMoney(q.new_hybrid_sales)) {
      fields.new_hybrid_sales = newHybrid;
    }
    if (Object.keys(fields).length) {
      patches.push({ email: r.email, fields });
    }
  }
  return patches;
}

/** Review rows with a valid decision (not yet applied). */
export async function listReadyDecisionsFromSheet() {
  const { rows } = await readTab(reviewTab());
  return rows
    .filter((r) => parseDecision(r.cells[COL.decision]))
    .map((r) => ({
      rowNumber: r.rowNumber,
      email: r.email,
      decision: parseDecision(r.cells[COL.decision]),
      decisionNotes: String(r.cells[COL.decisionNotes] || "").trim(),
      freezeUntil: String(r.cells[COL.freezeUntil] || "").trim(),
      daysToExpiry: parseDaysToExpiry(r.cells[COL.daysToExpiry]),
      bbSales: parseMoney(r.cells[COL.bbSales]),
      hybridSales: parseMoney(r.cells[COL.hybridSales]),
      newHybridSales: parseMoney(r.cells[COL.newHybridSales]),
      cells: r.cells,
    }));
}

export async function markSheetApplied({ rowNumber }) {
  const sheets = getSheetsClient();
  const id = sheetId();
  const review = reviewTab();

  const sheetNumeric = await sheetNumericId(sheets, id, review);
  if (sheetNumeric == null) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetNumeric,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });
}
