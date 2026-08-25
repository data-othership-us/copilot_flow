import { google } from "googleapis";
import { config } from "../../config.js";

const REVIEW_HEADERS = [
  "first_name",
  "last_name",
  "email",
  "region",
  "tier",
  "days_to_expiry",
  "membership_status",
  "membership_name",
  "membership_start",
  "membership_end",
  "months_since_membership_start",
  "social_playgrounds_attended",
  "last_social_playground",
  "classes_taken_current_membership",
  "last_class_date",
  "ig_handle",
  "ig_url",
  "ig_followers",
  "modash_posts",
  "modash_impressions",
  "modash_reach",
  "modash_views",
  "modash_engagement",
  "redemption_count_current_membership",
  "redemption_count_all_time",
  "sales_effective",
  "bb_sales",
  "hybrid_sales",
  "decision",
  "freeze_until",
  "decision_notes",
];

const COL = {
  email: 2,
  region: 3,
  tier: 4,
  daysToExpiry: 5,
  bbSales: 26,
  hybridSales: 27,
  decision: 28,
  freezeUntil: 29,
  decisionNotes: 30,
};

const PRESERVED_COLS = [
  COL.decision,
  COL.freezeUntil,
  COL.decisionNotes,
  COL.bbSales,
  COL.hybridSales,
];

const DECISION_VALUES = [
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
  const days = daysSortValue(a[COL.daysToExpiry]) - daysSortValue(b[COL.daysToExpiry]);
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
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0)
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
    (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean)
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
    (s) => s.properties?.title === title
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
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        withSheet(listValidation(COL.decision, DECISION_VALUES, { strict: true })),
        withSheet(dateValidation(COL.freezeUntil)),
      ],
    },
  });
}

export function rowFromQueue(r) {
  return [
    r.first_name || "",
    r.last_name || "",
    String(r.contact_email || "").trim().toLowerCase(),
    r.region || "",
    r.tier || "",
    fmtNum(r.days_to_expiry),
    r.membership_status || "",
    r.membership_name || "",
    fmtDate(r.membership_start),
    fmtDate(r.membership_end) || fmtDate(r.sheet_membership_expiry),
    fmtNum(r.months_since_membership_start),
    fmtNum(r.social_playgrounds_attended),
    r.last_social_playground || "",
    fmtNum(r.classes_taken_current_membership),
    fmtDate(r.last_class_date),
    r.ig_handle || "",
    r.ig_url || "",
    fmtNum(r.ig_followers),
    fmtNum(r.modash_posts),
    fmtNum(r.modash_impressions),
    fmtNum(r.modash_reach),
    fmtNum(r.modash_views),
    fmtNum(r.modash_engagement),
    fmtNum(r.redemption_count_current_membership),
    fmtNum(r.redemption_count_all_time),
    fmtNum(r.sales_effective),
    fmtNum(r.bb_sales),
    fmtNum(r.hybrid_sales),
    "",
    "",
    "",
  ];
}

function parseSheetRows(values) {
  const header = values?.[0] || [];
  const idx = {};
  for (let i = 0; i < header.length; i++) {
    idx[String(header[i] || "").trim().toLowerCase()] = i;
  }
  const rows = [];
  for (let r = 1; r < (values || []).length; r++) {
    const line = values[r] || [];
    const email = String(line[idx.email] || "").trim().toLowerCase();
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

async function writeTabRows(sheets, spreadsheetId, tab, headers, rows) {
  const end = colLetter(headers.length - 1);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${tab}'!A:${end}`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tab}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...rows] },
  });
}

async function writeReviewRows(sheets, spreadsheetId, tab, rows) {
  await writeTabRows(sheets, spreadsheetId, tab, REVIEW_HEADERS, rows);
}

export function rowFromAddToModash(r) {
  return [
    r.first_name || "",
    r.last_name || "",
    String(r.contact_email || "").trim().toLowerCase(),
    r.region || "",
    r.tier || "",
    r.ig_handle || "",
    r.ig_url || "",
    fmtNum(r.ig_followers),
    r.membership_status || "",
    fmtDate(r.membership_end),
  ];
}

/**
 * Rebuild the Add to Modash tab from copilots whose IG handle is not
 * on the Modash Creators roster. Full rewrite each run.
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
    const next = rowFromAddToModash(rec);
    const email = next[2];
    if (!email || seen.has(email)) continue;
    rebuilt.push(next);
    seen.add(email);
  }

  await writeTabRows(sheets, id, tab, ADD_TO_MODASH_HEADERS, rebuilt);

  return { total: rebuilt.length, rebuilt: true };
}

/**
 * Rewrite Review from the queue, sorted by region → tier → days to expiry.
 * Preserves Christine's decision / freeze_until / decision_notes / bb_sales /
 * hybrid_sales. Already-applied people are filtered in copilot_evaluation_queue.
 */
export async function appendReviewQueue(queueRows) {
  const sheets = getSheetsClient();
  const id = sheetId();
  const tab = reviewTab();

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
    if (!found) return next;
    const merged = [...next];
    for (const i of PRESERVED_COLS) {
      if (cellFilled(found.cells[i])) merged[i] = found.cells[i];
    }
    return merged;
  }

  const rebuilt = [];
  const seen = new Set();
  let skipped = 0;
  let appended = 0;

  for (const rec of queueRows) {
    const next = rowFromQueue(rec);
    const email = next[COL.email];
    if (!email || seen.has(email)) continue;
    if (byEmail.has(email)) skipped++;
    else appended++;
    rebuilt.push(mergePreserved(next, byEmail.get(email)));
    seen.add(email);
  }

  rebuilt.sort(compareReviewRows);
  await writeReviewRows(sheets, id, tab, rebuilt);
  await ensureDropdowns(sheets, id);

  return {
    appended,
    skipped,
    total: rebuilt.length,
    rebuilt: true,
  };
}

export function parseDecision(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (DECISION_VALUES.includes(v)) return v;
  return "";
}

/**
 * Review rows with a valid decision (not yet applied).
 */
export async function listSalesWritebacks(queueRows) {
  const { rows } = await readTab(reviewTab());
  const fromQueue = new Map(
    (queueRows || []).map((r) => [
      String(r.contact_email || "").trim().toLowerCase(),
      r,
    ])
  );
  const patches = [];
  for (const r of rows) {
    const q = fromQueue.get(r.email) || {};
    const bb = parseMoney(r.cells[COL.bbSales]);
    const hybrid = parseMoney(r.cells[COL.hybridSales]);
    const fields = {};
    if (bb != null && bb !== parseMoney(q.bb_sales)) fields.bb_sales = bb;
    if (hybrid != null && hybrid !== parseMoney(q.hybrid_sales)) {
      fields.hybrid_sales = hybrid;
    }
    if (Object.keys(fields).length) {
      patches.push({ email: r.email, fields });
    }
  }
  return patches;
}

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
      bbSales: parseMoney(r.cells[COL.bbSales]),
      hybridSales: parseMoney(r.cells[COL.hybridSales]),
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
