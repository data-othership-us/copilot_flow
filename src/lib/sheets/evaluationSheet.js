import { google } from "googleapis";
import { config } from "../../config.js";
import { igProfileUrl, isPlaceholderIgHandle, parseIgHandles, storedIgHandle } from "../instagram.js";

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
  "promo_code",
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
  "intro_offer_count_current_membership",
  "intro_offer_usd_current_membership",
  "intro_offer_cad_current_membership",
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
  "new_email",
  "mt_email",
  "decision_notes",
];

function headerCol(name) {
  const i = REVIEW_HEADERS.indexOf(name);
  if (i < 0) throw new Error(`missing review header: ${name}`);
  return i;
}

const COL = {
  firstName: headerCol("first_name"),
  lastName: headerCol("last_name"),
  email: headerCol("email"),
  region: headerCol("region"),
  tier: headerCol("tier"),
  daysToExpiry: headerCol("days_to_expiry"),
  membershipStatus: headerCol("membership_status"),
  membershipName: headerCol("membership_name"),
  promoCode: headerCol("promo_code"),
  igHandle: headerCol("ig_handle"),
  igUrl: headerCol("ig_url"),
  igFollowers: headerCol("ig_followers"),
  membershipEnd: headerCol("membership_end"),
  bbSales: headerCol("bb_sales"),
  hybridSales: headerCol("hybrid_sales"),
  newHybridSales: headerCol("new_hybrid_sales"),
  decision: headerCol("decision"),
  freezeUntil: headerCol("freeze_until"),
  newEmail: headerCol("new_email"),
  mtEmail: headerCol("mt_email"),
  decisionNotes: headerCol("decision_notes"),
};

const PRESERVED_COLS = [
  COL.decision,
  COL.freezeUntil,
  COL.newEmail,
  COL.decisionNotes,
  COL.bbSales,
  COL.hybridSales,
  COL.newHybridSales,
];

const UPDATE_INPUT_COLS = [
  COL.firstName,
  COL.lastName,
  COL.promoCode,
  COL.igHandle,
  COL.igUrl,
  COL.newEmail,
  COL.mtEmail,
];

const EDITABLE_COLS = [
  ...new Set([...PRESERVED_COLS, ...UPDATE_INPUT_COLS]),
].sort((a, b) => a - b);

/** Required to add freeze / onboard / update by hand. */
const REQUIRED_MANUAL_COLS = [COL.email, COL.decision];

const OPTIONAL_EDITABLE_COLS = EDITABLE_COLS.filter(
  (i) => !REQUIRED_MANUAL_COLS.includes(i),
);

const FILL_WHITE = { red: 1, green: 1, blue: 1 };
const FILL_EDITABLE = { red: 1, green: 242 / 255, blue: 204 / 255 };
const FILL_REQUIRED = { red: 248 / 255, green: 203 / 255, blue: 173 / 255 };
const FILL_HOLD_GREY = {
  red: 217 / 255,
  green: 217 / 255,
  blue: 217 / 255,
};

/** Sheet dropdown labels. parseDecision maps these (and old lowercase) to keys. */
const DECISION_OPTIONS = [
  { key: "onboard", label: "Onboard" },
  { key: "renew", label: "Renew" },
  { key: "offboard", label: "Offboard" },
  { key: "never again", label: "Never Again" },
  { key: "upgrade", label: "Upgrade Tier" },
  { key: "downgrade", label: "Downgrade Tier" },
  { key: "snooze", label: "Snooze" },
  { key: "freeze", label: "Freeze" },
  { key: "update", label: "Update Profile" },
  { key: "social", label: "Social Nudge" },
];

const DECISION_VALUES = DECISION_OPTIONS.map((o) => o.label);

const DECISION_ALIASES = {
  onboard: "onboard",
  "re-onboard": "onboard",
  reonboard: "onboard",
  "re onboard": "onboard",
  renew: "renew",
  offboard: "offboard",
  "never again": "never again",
  never_again: "never again",
  upgrade: "upgrade",
  "upgrade tier": "upgrade",
  "upgrade membership": "upgrade",
  downgrade: "downgrade",
  "downgrade tier": "downgrade",
  snooze: "snooze",
  freeze: "freeze",
  update: "update",
  "update profile": "update",
  "update info": "update",
  "update details": "update",
  social: "social",
  "social nudge": "social",
  ...Object.fromEntries(DECISION_OPTIONS.map((o) => [o.label.toLowerCase(), o.key])),
};

export const PAYMENT_NUDGE_NOTE = "payment method nudge sent";
export const OFFBOARD_END_NOTE_PREFIX = "offboarding end of term on";
const APPLY_FAILED_PREFIX = "apply failed:";

/** Yellow-column draft: email plus edits, no queue membership metrics yet. */
export function isSparseManualReviewRow(cells) {
  if (!cellFilled(cells?.[COL.email])) return false;
  const queueSignals = [
    COL.daysToExpiry,
    COL.membershipStatus,
    COL.membershipName,
    COL.membershipStart,
    COL.membershipEnd,
  ];
  if (queueSignals.some((i) => cellFilled(cells[i]))) return false;
  return UPDATE_INPUT_COLS.some((i) => cellFilled(cells[i]));
}
export function isManualReviewDecision(value) {
  return Boolean(parseDecision(value));
}

export function isNeverAgainDecision(value) {
  return parseDecision(value) === "never again";
}

export function isOffboardLikeDecision(value) {
  const d = parseDecision(value);
  return d === "offboard" || d === "never again";
}

export function reviewRowDecision(r) {
  return parseDecision(r?.cells?.[COL.decision] ?? r?.decision);
}

function parseDaysToExpiry(value) {
  if (value != null && typeof value === "object" && value.value != null) {
    value = value.value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Live Co-Pilot term in active / pending / payment_failure. */
export function hasLiveCopilotMembership(r) {
  const name = String(r?.membership_name || "");
  const status = String(r?.membership_status || "")
    .trim()
    .toLowerCase();
  return (
    /co[\s-]?pilot/i.test(name) &&
    ["active", "pending", "payment_failure", "frozen"].includes(status)
  );
}

/**
 * Membership work for Review: no MT account, no live Co-Pilot term, payment
 * failure, or a live Co-Pilot term within 7 days of ending. Frozen terms
 * stay off Review until they unfreeze.
 */
export function isMembershipReviewRow(r) {
  if (isMissingMtAccountRow(r)) return true;
  const status = String(r?.membership_status || "")
    .trim()
    .toLowerCase();
  if (status === "payment_failure") return true;
  if (status === "frozen") return false;
  if (!hasLiveCopilotMembership(r)) return true;
  const days = parseDaysToExpiry(r?.days_to_expiry);
  return days != null && days <= 7;
}

export function hasResubmitHandlesEmailedNote(existing) {
  return String(existing || "")
    .toLowerCase()
    .includes(RESUBMIT_HANDLES_EMAILED_NOTE);
}

/** Waiting on a public handle — Modash outlier, not a Review membership row. */
export function isSocialOutlierRecord(r) {
  if (isResubmitIgRow(r)) return true;
  if (parseDecision(r?.decision) === "social") return true;
  const notes = String(r?.decision_notes || r?.decisionNotes || "").toLowerCase();
  if (notes.includes("private ig")) return true;
  if (notes.includes("need to resubmit")) return true;
  return false;
}

/**
 * Offboard / never again / renew / upgrade / downgrade: ops can fill
 * Review in the 7-day window, but membership + email wait until last day
 * (days_to_expiry <= 0). Missing days_to_expiry holds queue rows so we do
 * not apply early. Manual off-queue rows with a blank days_to_expiry apply
 * immediately (ops added them on purpose).
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
  if (days == null) return !item?.manual;
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
  if (value == null || String(value).trim() === "") {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Parked Review rows Christine can ignore today.
 * `pending` = last-day apply wait, `nudge` = payment-method hold,
 * `failed` = last apply error.
 */
export function reviewHoldKind(cells) {
  const notes = String(cells?.[COL.decisionNotes] || "").toLowerCase();
  if (notes.includes("payment method nudge")) return "nudge";
  if (notes.includes(APPLY_FAILED_PREFIX)) return "failed";
  if (
    shouldHoldUntilExpiry({
      decision: parseDecision(cells?.[COL.decision]),
      daysToExpiry: parseDaysToExpiry(cells?.[COL.daysToExpiry]),
    })
  ) {
    return "pending";
  }
  return "";
}

export function isReviewHoldRow(cells) {
  return Boolean(reviewHoldKind(cells));
}

const HOLD_KIND_RANK = { pending: 0, nudge: 1, failed: 2 };

/** 0 = needs a decision, 1 = filled and applying, 2 = grey hold. */
function reviewBlockRank(cells) {
  if (reviewHoldKind(cells)) return 2;
  if (parseDecision(cells?.[COL.decision])) return 1;
  return 0;
}

function compareReviewRowDetails(a, b) {
  const days =
    daysSortValue(a[COL.daysToExpiry]) - daysSortValue(b[COL.daysToExpiry]);
  if (days) return days;
  const ra = textKey(a[COL.region]);
  const rb = textKey(b[COL.region]);
  if (!ra !== !rb) return ra ? -1 : 1;
  const region = ra.localeCompare(rb, undefined, { sensitivity: "base" });
  if (region) return region;
  const tier = tierSortRank(a[COL.tier]) - tierSortRank(b[COL.tier]);
  if (tier) return tier;
  return textKey(a[COL.email]).localeCompare(textKey(b[COL.email]), undefined, {
    sensitivity: "base",
  });
}

/**
 * Needs-decision first (soonest expiry), then filled rows the job will apply,
 * then grey nudge/pending/failed holds.
 */
export function compareReviewRows(a, b) {
  const block = reviewBlockRank(a) - reviewBlockRank(b);
  if (block) return block;
  const aHold = reviewHoldKind(a);
  const bHold = reviewHoldKind(b);
  if (aHold || bHold) {
    const kind = (HOLD_KIND_RANK[aHold] ?? 9) - (HOLD_KIND_RANK[bHold] ?? 9);
    if (kind) return kind;
  }
  return compareReviewRowDetails(a, b);
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
  "status",
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
  "notes",
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

/** Create Review / Add to Modash tabs and grow Review to the header width. */
export async function ensureReviewSheetLayout() {
  const sheets = getSheetsClient();
  const id = sheetId();
  await ensureTabs(sheets, id);
  await ensureDropdowns(sheets, id);
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

function consecutiveColRanges(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const ranges = [];
  for (const i of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && i === last.endColumnIndex) last.endColumnIndex = i + 1;
    else ranges.push({ startColumnIndex: i, endColumnIndex: i + 1 });
  }
  return ranges;
}

function fillColumns(sheetId, startColumnIndex, endColumnIndex, color) {
  return fillRange(
    sheetId,
    {
      startRowIndex: 0,
      endRowIndex: VALIDATION_ROW_CAP,
      startColumnIndex,
      endColumnIndex,
    },
    color,
  );
}

function fillRange(sheetId, range, color) {
  return {
    repeatCell: {
      range: { sheetId, ...range },
      cell: {
        userEnteredFormat: { backgroundColor: color },
      },
      fields: "userEnteredFormat.backgroundColor",
    },
  };
}

function consecutiveRowRanges(startRowIndexes) {
  const sorted = [...new Set(startRowIndexes)].sort((a, b) => a - b);
  const ranges = [];
  for (const start of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && start === last.endRowIndex) last.endRowIndex = start + 1;
    else ranges.push({ startRowIndex: start, endRowIndex: start + 1 });
  }
  return ranges;
}

/** Grey the parked nudge / last-day / apply-failed rows after a rebuild. */
async function formatReviewHoldRows(sheets, spreadsheetId, rows) {
  const reviewId = await sheetNumericId(sheets, spreadsheetId, reviewTab());
  if (reviewId == null) return;
  const colCount = REVIEW_HEADERS.length;
  const holdStarts = [];
  for (let i = 0; i < (rows || []).length; i++) {
    if (isReviewHoldRow(rows[i])) holdStarts.push(i + 1);
  }
  const requests = consecutiveRowRanges(holdStarts).map((range) =>
    fillRange(
      reviewId,
      {
        startRowIndex: range.startRowIndex,
        endRowIndex: range.endRowIndex,
        startColumnIndex: 0,
        endColumnIndex: colCount,
      },
      FILL_HOLD_GREY,
    ),
  );
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
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
  const colCount = Math.max(props?.columnCount || 0, REVIEW_HEADERS.length);
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
        fillColumns(reviewId, 0, colCount, FILL_WHITE),
        ...consecutiveColRanges(OPTIONAL_EDITABLE_COLS).map((range) =>
          fillColumns(
            reviewId,
            range.startColumnIndex,
            range.endColumnIndex,
            FILL_EDITABLE,
          ),
        ),
        ...consecutiveColRanges(REQUIRED_MANUAL_COLS).map((range) =>
          fillColumns(
            reviewId,
            range.startColumnIndex,
            range.endColumnIndex,
            FILL_REQUIRED,
          ),
        ),
      ],
    },
  });
}

export const RESUBMIT_HANDLE_NOTE = "need to resubmit social handles";
export const RESUBMIT_HANDLES_EMAILED_NOTE = "resubmit handles email sent";
export const NO_MT_ACCOUNT_NOTE = "No MT account found";
export const NO_LIVE_MEMBERSHIP_NOTE = "No active Co-Pilot membership";

export function isResubmitIgRow(r) {
  const raw = `${r?.ig_handle || ""} ${r?.ig_url || ""}`;
  return /re-?submit/i.test(raw) || isPlaceholderIgHandle(r?.ig_handle);
}

export function isMissingMtAccountRow(r) {
  return !String(r?.user_id ?? "").trim();
}

/** True when performance has no Co-Pilot-named term at all (never had one). */
export function isMissingLiveCopilotMembershipRow(r) {
  if (isMissingMtAccountRow(r)) return false;
  return !/co[\s-]?pilot/i.test(String(r?.membership_name || ""));
}

function appendDecisionNote(existing, note) {
  const cur = String(existing || "").trim();
  if (!note) return cur;
  if (!cur) return note;
  if (cur.toLowerCase().includes(note.toLowerCase())) return cur;
  return `${cur}; ${note}`;
}

function withoutDecisionNote(existing, note) {
  const want = String(note || "")
    .trim()
    .toLowerCase();
  if (!want) return String(existing || "").trim();
  return String(existing || "")
    .split(/\s*;\s*/)
    .filter((part) => part && part.toLowerCase() !== want)
    .join("; ");
}

/** Replace the resubmit flag with a sent marker. Keeps any other ops notes. */
export function withResubmitHandlesEmailedNote(existing, sentAt = new Date()) {
  const date = freezeUntilDateString(sentAt);
  const emailed = date
    ? `${RESUBMIT_HANDLES_EMAILED_NOTE} ${date}`
    : RESUBMIT_HANDLES_EMAILED_NOTE;
  const notes = withoutDecisionNote(existing, RESUBMIT_HANDLE_NOTE);
  if (notes.toLowerCase().includes(RESUBMIT_HANDLES_EMAILED_NOTE)) {
    return notes;
  }
  return appendDecisionNote(notes, emailed);
}

/** Review decision_notes by contact email (lowercase). */
export async function listReviewDecisionNotesByEmail() {
  const { rows } = await readTab(reviewTab());
  const map = new Map();
  for (const r of rows) {
    if (!r.email) continue;
    map.set(r.email, String(r.cells[COL.decisionNotes] || "").trim());
  }
  return map;
}

/** Stamp queue-flag notes without wiping ops / payment-nudge notes. */
export function withQueueFlagNotes(cells, rec) {
  const out = [...cells];
  let notes = out[COL.decisionNotes];
  if (
    isResubmitIgRow(rec) &&
    !String(notes || "")
      .toLowerCase()
      .includes(RESUBMIT_HANDLES_EMAILED_NOTE)
  ) {
    notes = appendDecisionNote(notes, RESUBMIT_HANDLE_NOTE);
  }
  if (isMissingMtAccountRow(rec)) {
    notes = appendDecisionNote(notes, NO_MT_ACCOUNT_NOTE);
  }
  if (isMissingLiveCopilotMembershipRow(rec)) {
    notes = appendDecisionNote(notes, NO_LIVE_MEMBERSHIP_NOTE);
  } else {
    notes = withoutDecisionNote(notes, NO_LIVE_MEMBERSHIP_NOTE);
  }
  out[COL.decisionNotes] = notes;
  return withOffboardHoldNotes(out);
}

/** Keep ops notes; set / refresh the end-of-term offboard marker. */
export function withOffboardEndOfTermNote(existing, membershipEnd) {
  const date = fmtDate(membershipEnd);
  if (!date) return String(existing || "").trim();
  const note = `${OFFBOARD_END_NOTE_PREFIX} ${date}`;
  const kept = String(existing || "")
    .split(/\s*;\s*/)
    .filter(
      (part) =>
        part && !part.toLowerCase().startsWith(OFFBOARD_END_NOTE_PREFIX),
    )
    .join("; ");
  return appendDecisionNote(kept, note);
}

function withOffboardHoldNotes(cells) {
  if (!isOffboardLikeDecision(cells?.[COL.decision])) return cells;
  const out = [...cells];
  out[COL.decisionNotes] = withOffboardEndOfTermNote(
    out[COL.decisionNotes],
    out[COL.membershipEnd],
  );
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
    r.promo_code || "",
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
    fmtNum(r.intro_offer_count_current_membership),
    fmtNum(r.intro_offer_usd_current_membership),
    fmtNum(r.intro_offer_cad_current_membership),
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
    r.mt_email || "",
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

export async function listReviewSheetRows() {
  return readTab(reviewTab());
}

function reviewRowAsRecord(r) {
  return {
    contact_email: r.email,
    email: r.email,
    first_name: r.cells[COL.firstName],
    last_name: r.cells[COL.lastName],
    region: r.cells[COL.region],
    tier: r.cells[COL.tier],
    ig_handle: r.cells[COL.igHandle],
    ig_url: r.cells[COL.igUrl],
    ig_followers: r.cells[COL.igFollowers],
    decision: r.cells[COL.decision],
    decision_notes: r.cells[COL.decisionNotes],
    days_to_expiry: r.cells[COL.daysToExpiry],
    membership_status: r.cells[COL.membershipStatus],
    membership_name: r.cells[COL.membershipName],
    membership_end: r.cells[COL.membershipEnd],
  };
}

/** One row per email: re-submit / private / social-decision people. */
export function collectSocialOutliers({
  queue = [],
  reviewRows = [],
  unappliedRows = [],
} = {}) {
  const byEmail = new Map();
  const add = (rec) => {
    const email = String(rec?.contact_email || rec?.email || "")
      .trim()
      .toLowerCase();
    if (!email) return;
    const prev = byEmail.get(email) || {};
    const nextNotes = rec.decision_notes || rec.decisionNotes || "";
    const prevNotes = prev.decision_notes || "";
    const notes = hasResubmitHandlesEmailedNote(nextNotes)
      ? nextNotes
      : hasResubmitHandlesEmailedNote(prevNotes)
        ? prevNotes
        : nextNotes || prevNotes;
    byEmail.set(email, {
      ...prev,
      ...rec,
      contact_email: email,
      email,
      decision_notes: notes,
    });
  };
  const offboardEmails = new Set();
  for (const r of reviewRows) {
    const rec = reviewRowAsRecord(r);
    if (isOffboardLikeDecision(rec.decision)) offboardEmails.add(rec.email);
  }
  for (const r of unappliedRows) {
    const email = String(r?.contact_email || "")
      .trim()
      .toLowerCase();
    if (email && isOffboardLikeDecision(r?.decision)) offboardEmails.add(email);
  }
  for (const r of queue) {
    if (isResubmitIgRow(r) || isSocialOutlierRecord(r)) add(r);
  }
  for (const r of reviewRows) {
    const rec = reviewRowAsRecord(r);
    if (isResubmitIgRow(rec) || isSocialOutlierRecord(rec)) add(rec);
  }
  for (const r of unappliedRows) {
    if (isSocialOutlierRecord(r)) add(r);
  }
  for (const email of offboardEmails) byEmail.delete(email);
  return [...byEmail.values()];
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
    "Not Tracking",
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
    "",
  ]);
}

function rowFromSocialOutlier(r) {
  const email = String(r.contact_email || r.email || "")
    .trim()
    .toLowerCase();
  const handleRaw = r.ig_handle || r.ig_url || "";
  const handle = storedIgHandle(handleRaw) || handleRaw || "re-submit";
  const url = igProfileUrl(handleRaw);
  return [
    "Resubmit",
    r.first_name || "",
    r.last_name || "",
    email,
    r.region || "",
    r.tier || "",
    handle,
    url,
    fmtNum(r.ig_followers),
    r.membership_status || "",
    fmtDate(r.membership_end),
    String(r.decision_notes || r.decisionNotes || "").trim(),
  ];
}

/**
 * Rewrite Add to Modash in place. `NOT TRACKING` rows are paste-ready handles
 * missing from modash_creators. `resubmit` rows are re-submit / private /
 * waiting — do not paste those into a Modash campaign.
 */
export async function writeAddToModashQueue(addRows, { outliers = [] } = {}) {
  const sheets = getSheetsClient();
  const id = sheetId();
  const tab = addToModashTab();
  const outlierEmails = new Set(
    (outliers || []).map((r) =>
      String(r.contact_email || r.email || "")
        .trim()
        .toLowerCase(),
    ).filter(Boolean),
  );

  await ensureTabs(sheets, id);

  const rebuilt = [];
  const seenHandles = new Set();
  for (const rec of addRows || []) {
    const email = String(rec.contact_email || rec.email || "")
      .trim()
      .toLowerCase();
    if (outlierEmails.has(email) || isResubmitIgRow(rec)) continue;
    for (const next of rowsFromAddToModash(rec)) {
      const key = handleKey(next[6]);
      if (!key || seenHandles.has(key)) continue;
      rebuilt.push(next);
      seenHandles.add(key);
    }
  }

  const seenEmails = new Set();
  for (const rec of outliers || []) {
    const email = String(rec.contact_email || rec.email || "")
      .trim()
      .toLowerCase();
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);
    rebuilt.push(rowFromSocialOutlier(rec));
  }

  await ensureGridSize(sheets, id, tab, {
    rows: Math.max(rebuilt.length + 1, 2),
    columns: ADD_TO_MODASH_HEADERS.length,
  });

  await writeTabRows(sheets, id, tab, ADD_TO_MODASH_HEADERS, rebuilt, {
    valueInputOption: "USER_ENTERED",
  });

  return {
    total: rebuilt.length,
    added: seenHandles.size,
    outliers: seenEmails.size,
    rebuilt: true,
  };
}

/**
 * Rewrite Review from the queue. Holds (payment-method, last-day wait,
 * apply-failed) sort last; otherwise region → tier → days to expiry.
 * Preserves Christine's decision / freeze_until / decision_notes / bb_sales /
 * hybrid_sales / new_hybrid_sales for people still in the queue. Filled yellow
 * update cells (name, promo, ig, emails) are kept when they differ from the
 * queue or the row is a sparse manual draft (email + edits, no membership
 * metrics). Those drafts stay even with a blank decision. If someone
 * drops out (live term with more than 7 days left), they leave Review.
 * Sparse manual rows (email + yellow edits, blank decision) stay until
 * they are applied or ops clears them. Unapplied off-queue rows with a
 * filled decision stay until apply succeeds;
 * applied rows are deleted and not restored. Social-only people (live term
 * more than 7 days out, waiting on a public handle) are not carried back
 * onto Review unless they are a payment-method hold, apply-failed hold, or
 * a filled offboard / never again waiting until end of term.

 * `unappliedByEmail` restores those cells from copilot_db when they re-enter
 * and the sheet cell is blank, and restores off-queue freeze / onboard /
 * offboard after a failed apply. Update rows are restored from the sheet
 * only (the new field values live there).
 */
function unappliedMap(unappliedByEmail) {
  if (unappliedByEmail instanceof Map) return unappliedByEmail;
  return new Map(
    Object.entries(unappliedByEmail || {}).map(([k, v]) => [
      String(k).trim().toLowerCase(),
      v,
    ]),
  );
}

/**
 * Merge queue + current Review + unapplied copilot_db into one row per email.
 * Later duplicate sheet rows win (same as apply's high-row-first skip).
 */
function socialOnlySet(socialOnlyEmails) {
  if (socialOnlyEmails instanceof Set) return socialOnlyEmails;
  return new Set(
    [...(socialOnlyEmails || [])]
      .map((email) => String(email || "").trim().toLowerCase())
      .filter(Boolean),
  );
}

function keepSocialOnlyHold({ notes, decision } = {}) {
  if (isOffboardLikeDecision(decision)) return true;
  const text = String(notes || "").toLowerCase();
  return (
    text.includes("payment method nudge") ||
    text.includes(APPLY_FAILED_PREFIX)
  );
}

export function buildReviewRows(
  queueRows,
  reviewRows,
  unappliedByEmail,
  { socialOnlyEmails } = {},
) {
  const unapplied = unappliedMap(unappliedByEmail);
  const socialOnly = socialOnlySet(socialOnlyEmails);
  const byEmail = new Map();
  const duplicates = [];
  for (const r of reviewRows || []) {
    if (!r.email) continue;
    const prev = byEmail.get(r.email);
    if (prev) {
      duplicates.push({
        email: r.email,
        keptRow: r.rowNumber,
        droppedRow: prev.rowNumber,
        keptDecision: parseDecision(r.cells[COL.decision]),
        droppedDecision: parseDecision(prev.cells[COL.decision]),
      });
    }
    byEmail.set(r.email, r);
  }

  function sheetUpdateCellWins(found, next, col) {
    const value = found.cells[col];
    if (!cellFilled(value)) return false;
    if (col === COL.igHandle || col === COL.igUrl) {
      const rec = {
        ig_handle: found.cells[COL.igHandle],
        ig_url: found.cells[COL.igUrl],
      };
      if (isResubmitIgRow(rec) || isPlaceholderIgHandle(value)) return false;
    }
    if (parseDecision(found.cells[COL.decision]) === "update") return true;
    if (isSparseManualReviewRow(found.cells)) return true;
    const a = String(value ?? "").trim();
    const b = String(next[col] ?? "").trim();
    if (col === COL.igHandle || col === COL.igUrl) {
      const ah = parseIgHandles(`${found.cells[COL.igHandle] || ""} ${found.cells[COL.igUrl] || ""}`).join("\n");
      const bh = parseIgHandles(`${next[COL.igHandle] || ""} ${next[COL.igUrl] || ""}`).join("\n");
      return ah !== bh;
    }
    if (col === COL.newEmail || col === COL.mtEmail) {
      return a.toLowerCase() !== b.toLowerCase();
    }
    return a !== b;
  }

  function mergePreserved(next, found) {
    let merged = [...next];
    if (found) {
      for (const i of PRESERVED_COLS) {
        if (i === COL.decision && parseDecision(found.cells[i]) === "social") {
          continue;
        }
        if (cellFilled(found.cells[i])) merged[i] = found.cells[i];
      }
      for (const i of UPDATE_INPUT_COLS) {
        if (sheetUpdateCellWins(found, next, i)) merged[i] = found.cells[i];
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
  let carried = 0;

  for (const rec of queueRows || []) {
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

  for (const existing of byEmail.values()) {
    if (!existing.email || seen.has(existing.email)) continue;
    if (
      !isManualReviewDecision(existing.cells[COL.decision]) &&
      !isSparseManualReviewRow(existing.cells)
    ) {
      continue;
    }
    if (parseDecision(existing.cells[COL.decision]) === "social") continue;
    if (
      socialOnly.has(existing.email) &&
      !isSparseManualReviewRow(existing.cells) &&
      !keepSocialOnlyHold({
        notes: existing.cells[COL.decisionNotes],
        decision: existing.cells[COL.decision],
      })
    ) {
      continue;
    }
    rebuilt.push(
      overlayUnappliedDecision(
        padReviewCells(existing.cells),
        unapplied.get(existing.email),
      ),
    );
    seen.add(existing.email);
    carried++;
  }

  for (const [email, rec] of unapplied) {
    if (!email || seen.has(email)) continue;
    if (parseDecision(rec?.decision) === "update") continue;
    if (parseDecision(rec?.decision) === "social") continue;
    if (!isManualReviewDecision(rec?.decision)) continue;
    if (
      socialOnly.has(email) &&
      !keepSocialOnlyHold({
        notes: rec?.decision_notes,
        decision: rec?.decision,
      })
    ) {
      continue;
    }
    rebuilt.push(rowFromUnapplied(rec));
    seen.add(email);
    carried++;
  }

  rebuilt.sort(compareReviewRows);
  return {
    rebuilt: rebuilt.map((cells) => withOffboardHoldNotes(withDecisionLabel(cells))),
    appended,
    skipped,
    carried,
    total: rebuilt.length,
    duplicates,
  };
}

export async function appendReviewQueue(
  queueRows,
  { unappliedByEmail, dryRun = false, socialOnlyEmails } = {},
) {
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
  const built = buildReviewRows(queueRows, reviewRows, unappliedByEmail, {
    socialOnlyEmails,
  });

  for (const dup of built.duplicates) {
    const diff =
      dup.keptDecision &&
      dup.droppedDecision &&
      dup.keptDecision !== dup.droppedDecision
        ? ` (${dup.keptDecision}, dropping ${dup.droppedDecision} on row ${dup.droppedRow})`
        : ` (dropping row ${dup.droppedRow})`;
    console.warn(
      `   ⚠️  duplicate Review rows for ${dup.email} — keeping row ${dup.keptRow}${diff}`,
    );
  }

  if (!dryRun) {
    await ensureDropdowns(sheets, id);
    await writeReviewRows(sheets, id, tab, built.rebuilt);
    await ensureDropdowns(sheets, id);
    await formatReviewHoldRows(sheets, id, built.rebuilt);
  }

  return {
    appended: built.appended,
    skipped: built.skipped,
    carried: built.carried,
    total: built.total,
    rebuilt: !dryRun,
    rows: built.rebuilt,
    duplicates: built.duplicates,
  };
}

function padReviewCells(cells) {
  const out = Array(REVIEW_HEADERS.length).fill("");
  for (let i = 0; i < REVIEW_HEADERS.length; i++) {
    out[i] = cells?.[i] ?? "";
  }
  return out;
}

function rowFromUnapplied(unapplied) {
  const out = Array(REVIEW_HEADERS.length).fill("");
  out[COL.firstName] = unapplied?.first_name || "";
  out[COL.lastName] = unapplied?.last_name || "";
  out[COL.email] = String(unapplied?.contact_email || "")
    .trim()
    .toLowerCase();
  out[COL.region] = unapplied?.region || "";
  out[COL.tier] = unapplied?.tier || "";
  out[COL.promoCode] = unapplied?.promo_code || "";
  out[COL.mtEmail] = unapplied?.mt_email || "";
  return overlayUnappliedDecision(out, unapplied);
}

function decisionLabel(value) {
  const key = parseDecision(value);
  return DECISION_OPTIONS.find((o) => o.key === key)?.label || "";
}

function withDecisionLabel(cells) {
  const out = padReviewCells(cells);
  const label = decisionLabel(out[COL.decision]);
  if (label) out[COL.decision] = label;
  return out;
}

function overlayUnappliedDecision(merged, unapplied) {
  if (!unapplied) return merged;
  const out = [...merged];
  const fromBq = parseDecision(unapplied.decision);
  if (!cellFilled(out[COL.decision]) && fromBq && fromBq !== "social") {
    out[COL.decision] = decisionLabel(fromBq);
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
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ");
  return DECISION_ALIASES[v] || "";
}

/** Keep ops notes; replace any previous apply-failed line. */
export function withApplyFailedNote(existing, message) {
  const cur = String(existing || "").trim();
  const kept = cur
    .split(/\s*;\s*/)
    .filter((part) => part && !part.toLowerCase().startsWith(APPLY_FAILED_PREFIX))
    .join("; ");
  const detail = String(message || "unknown error").trim() || "unknown error";
  return appendDecisionNote(kept, `${APPLY_FAILED_PREFIX} ${detail}`);
}

export function hasPaymentNudgeNote(existing) {
  return String(existing || "")
    .toLowerCase()
    .includes("payment method nudge");
}

/** Keep ops notes; add the hold marker if it is not already there. */
export function withPaymentNudgeNote(existing) {
  const cur = String(existing || "").trim();
  if (!cur) return PAYMENT_NUDGE_NOTE;
  if (hasPaymentNudgeNote(cur)) return cur;
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
  const id = sheetId();
  const tab = reviewTab();
  await ensureGridSize(sheets, id, tab, {
    rows: Math.max(found.rowNumber, 2),
    columns: REVIEW_HEADERS.length,
  });
  const col = colLetter(COL.decisionNotes);
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: `'${tab}'!${col}${found.rowNumber}`,
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

function readyDecisionFromReviewRow(r) {
  return {
    rowNumber: r.rowNumber,
    email: r.email,
    decision: parseDecision(r.cells[COL.decision]),
    decisionNotes: String(r.cells[COL.decisionNotes] || "").trim(),
    freezeUntil: String(r.cells[COL.freezeUntil] || "").trim(),
    newEmail: String(r.cells[COL.newEmail] || "").trim().toLowerCase(),
    mtEmail: String(r.cells[COL.mtEmail] || "").trim().toLowerCase(),
    promoCode: String(r.cells[COL.promoCode] || "").trim(),
    igHandle: String(r.cells[COL.igHandle] || "").trim(),
    igUrl: String(r.cells[COL.igUrl] || "").trim(),
    firstName: String(r.cells[COL.firstName] || "").trim(),
    lastName: String(r.cells[COL.lastName] || "").trim(),
    daysToExpiry: parseDaysToExpiry(r.cells[COL.daysToExpiry]),
    bbSales: parseMoney(r.cells[COL.bbSales]),
    hybridSales: parseMoney(r.cells[COL.hybridSales]),
    newHybridSales: parseMoney(r.cells[COL.newHybridSales]),
    cells: r.cells,
  };
}

/** Review rows with a valid decision (not yet applied). */
export async function listReadyDecisionsFromSheet() {
  const { rows } = await readTab(reviewTab());
  return rows
    .filter((r) => parseDecision(r.cells[COL.decision]))
    .map(readyDecisionFromReviewRow);
}

/** Same mapping from rebuilt cell rows (header is row 1, data starts at 2). */
export function readyDecisionsFromReviewCells(cellRows) {
  return (cellRows || [])
    .map((cells, i) =>
      readyDecisionFromReviewRow({
        rowNumber: i + 2,
        email: String(cells?.[COL.email] || "")
          .trim()
          .toLowerCase(),
        cells: cells || [],
      }),
    )
    .filter((r) => r.email && r.decision);
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
