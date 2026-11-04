import { config, sleep } from "../../config.js";
import {
  formatClock,
  formatMatchLabel,
  scheduleSessionUrl,
} from "../mt/classSessionTag.js";
import { getNotionClient } from "./applications.js";
import {
  buildCheckboxUpdate,
  buildDateUpdate,
  buildNumberUpdate,
  buildRichTextUpdate,
  buildTitleUpdate,
  getCheckbox,
  getDateStart,
  getEmail,
  getMultiSelectNames,
  getNumber,
  getRichText,
  getSelect,
  getTitle,
  getUrl,
} from "./parseProps.js";

const LOCATIONS = {
  Adelaide: { city: "Toronto", timeZone: "America/Toronto" },
  Yorkville: { city: "Toronto", timeZone: "America/Toronto" },
  Flatiron: { city: "New York", timeZone: "America/New_York" },
  Williamsburg: { city: "New York", timeZone: "America/New_York" },
};

const CHECKLIST = [
  "Management Approved",
  "Add note linking event page in Mariana Tek",
  "Add into Sauna Schedule",
  "Guest List Received",
  "Guide confirmed + updated",
  "Day of crew notified",
  "Follow up email sent",
];

function rich(content, { bold = false, link } = {}) {
  const text = { content: String(content) };
  if (link) text.link = { url: link };
  return {
    type: "text",
    text,
    annotations: { bold },
  };
}

function paragraph(parts) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: parts },
  };
}

function heading(text) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [rich(text)] },
  };
}

function todo(text) {
  return {
    object: "block",
    type: "to_do",
    to_do: { rich_text: [rich(text)], checked: false },
  };
}

/**
 * "9:00PM" / "9PM" / "21:00" → { hour, minute, hhmmss } in 24-hour local time.
 * @returns {{ hour: number, minute: number, hhmmss: string } | null}
 */
export function parseStartTime(raw) {
  const text = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const clock = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    return {
      hour,
      minute,
      hhmmss: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    };
  }
  const ampm = text.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/);
  if (!ampm) return null;
  let hour = Number(ampm[1]);
  const minute = Number(ampm[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (ampm[3] === "PM") hour += 12;
  return {
    hour,
    minute,
    hhmmss: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  };
}

export function timeOfDay(hour) {
  if (!Number.isFinite(hour)) return "";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

export function locationMeta(name) {
  const key = String(name || "").trim();
  const known = LOCATIONS[key];
  if (!known) return null;
  return {
    name: key,
    city: known.city,
    timeZone: known.timeZone,
    locationId: String(config.mt.locationIds[key] || "").trim(),
  };
}

const REGION_STUDIOS = {
  "New York": ["Flatiron", "Williamsburg"],
  Toronto: ["Adelaide", "Yorkville"],
};

const LOCATION_ALIASES = {
  "Adelaide (TO)": "Adelaide",
  "Yorkville (TO)": "Yorkville",
  "Flatiron (NYC)": "Flatiron",
  "Williamsburg (NYC)": "Williamsburg",
};

function studioName(value) {
  const text = String(value || "").trim();
  if (LOCATIONS[text]) return text;
  if (LOCATION_ALIASES[text]) return LOCATION_ALIASES[text];
  const stripped = text.replace(/\s*\((?:TO|NYC)\)\s*$/i, "");
  return LOCATIONS[stripped] ? stripped : "";
}

const COMMUNITY_PROP = "Tell us more about the community you’re inviting!";
const SECOND_DATE_PROP = "Second Preferred Date & Time ";

/** The promo code is the title until the first confirm, then `code | time location`. */
export function codeFromTitle(title) {
  const text = String(title || "").trim();
  const pipe = text.indexOf("|");
  if (pipe === -1) return text;
  return text.slice(0, pipe).trim();
}

/** Page title written once, when Copilot Confirm is checked. */
export function confirmedRequestTitle(code, session) {
  const time = formatClock(session?.time);
  const location = String(session?.location || "").trim();
  const when = [time, location].filter(Boolean).join(" ");
  const base = String(code || "").trim();
  return when ? `${base} | ${when}` : base;
}

export function calendarCardTitle(copilotName) {
  const name = String(copilotName || "").trim() || "Co-Pilot";
  return `Co-Pilot Hybrid Booking ${name}`;
}

export function copilotDisplayName(copilot, fallbackCode) {
  const name = [copilot?.first_name, copilot?.last_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  return name || String(fallbackCode || "").trim() || "Co-Pilot";
}

function sameCopilot(left, right) {
  const leftEmail = String(left?.contact_email || "")
    .trim()
    .toLowerCase();
  const rightEmail = String(right?.contact_email || "")
    .trim()
    .toLowerCase();
  if (leftEmail && leftEmail === rightEmail) return true;
  const leftCode = String(left?.promo_code || "")
    .trim()
    .toUpperCase();
  const rightCode = String(right?.promo_code || "")
    .trim()
    .toUpperCase();
  return Boolean(leftCode && leftCode === rightCode);
}

/**
 * One test pair, accepted without a copilot_db row. Any other email or code
 * still has to match a real copilot. Clear HYBRID_TEST_EMAIL to turn this off.
 */
export function hybridTestCopilot(email, code) {
  const allowedEmail = String(config.hybrid.testEmail || "")
    .trim()
    .toLowerCase();
  const allowedCode = String(config.hybrid.testCode || "")
    .trim()
    .toUpperCase();
  if (!allowedEmail || !allowedCode) return null;
  const submittedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const submittedCode = String(code || "")
    .trim()
    .toUpperCase();
  if (submittedEmail !== allowedEmail || submittedCode !== allowedCode)
    return null;
  return {
    contact_email: allowedEmail,
    promo_code: allowedCode,
    first_name: "Tina",
    last_name: "",
  };
}

/**
 * Email and code have to point at the same copilot. A mismatch waits on Hold
 * instead of emailing or creating a calendar card.
 */
export function verifyCopilotMatch({ emailRow, codeRow, submittedCode } = {}) {
  const code = String(submittedCode || "")
    .trim()
    .toUpperCase();
  const emailCode = String(emailRow?.promo_code || "")
    .trim()
    .toUpperCase();
  if (emailRow && code && emailCode === code) return { copilot: emailRow };
  if (emailRow && codeRow && sameCopilot(emailRow, codeRow))
    return { copilot: emailRow };
  if (!emailRow && !codeRow)
    return { hold: "No copilot matches that email and code." };
  if (emailRow && !codeRow)
    return { hold: "That code is not on this copilot." };
  if (!emailRow && codeRow)
    return { hold: "That email is not on the copilot for this code." };
  return { hold: "Email and code belong to different copilots." };
}

export function studiosForRequest({
  preferred = [],
  region,
} = {}) {
  const picks = preferred.map(studioName).filter(Boolean);
  const names = [...new Set(picks)];
  const chosen = names.length ? names : REGION_STUDIOS[region] || [];
  return chosen
    .map((name) => locationMeta(name))
    .filter((meta) => meta?.locationId);
}

function readSlot(props, name) {
  const start = getDateStart(props, name);
  if (!start) return null;
  const date = String(start).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let hhmmss = null;
  if (String(start).includes("T")) {
    const match = String(start).match(/T(\d{2}):(\d{2})/);
    if (match) hhmmss = `${match[1]}:${match[2]}:00`;
  }
  return { date, hhmmss };
}

function slotsFrom(props) {
  const first = readSlot(props, "Date");
  const second =
    readSlot(props, SECOND_DATE_PROP) ||
    readSlot(props, SECOND_DATE_PROP.trim());
  const slots = [];
  if (first) slots.push(first);
  if (
    second &&
    !(first && second.date === first.date && second.hhmmss === first.hhmmss)
  ) {
    slots.push(second);
  }
  return slots;
}

function matchPayload(raw) {
  if (!raw) return { sessions: [], slots: null };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { sessions: parsed.filter((item) => item && item.id), slots: null };
    }
    if (parsed && Array.isArray(parsed.sessions)) {
      return {
        sessions: parsed.sessions.filter((item) => item && item.id),
        slots: Array.isArray(parsed.slots) ? parsed.slots : null,
      };
    }
  } catch {
    return { sessions: [], slots: null };
  }
  return { sessions: [], slots: null };
}

export function parseMatchLog(raw) {
  return matchPayload(raw).sessions;
}

/** Slots we last emailed about. Null means this request was saved before we stored them. */
export function parseLoggedSlots(raw) {
  return matchPayload(raw).slots;
}

export function serializeMatchLog(matches, slots) {
  const sessions = (matches || []).map((match) => ({
    id: String(match.id),
    location: match.location || "",
    city: match.city || "",
    date: match.date || "",
    time: match.time || "",
    className: match.className || "",
    capacity: match.capacity ?? null,
    available: match.available ?? null,
  }));
  const payload = JSON.stringify({
    sessions,
    slots: (slots || []).map((slot) => ({
      date: slot.date || "",
      hhmmss: slot.hhmmss || "",
    })),
  });
  if (payload.length > 2000) {
    throw new Error("Too many matching sessions to store on the request");
  }
  return payload;
}

export function confirmedSessionIds(raw) {
  const ids = String(raw || "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{4,}$/.test(part));
  return [...new Set(ids)];
}

export function pageIdFromUrl(url) {
  const text = String(url || "");
  const dashed = text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (dashed) return dashed[0];
  const compact = text.match(/[0-9a-f]{32}/gi);
  return compact ? compact[compact.length - 1] : "";
}

function normalizeRequest(page) {
  const props = page.properties || {};
  const regionRaw = getSelect(props, "City") || getSelect(props, "Format");
  const region =
    regionRaw === "New York" || regionRaw === "Toronto" ? regionRaw : "";
  const preferred = getMultiSelectNames(props, "Preferred Location");
  const slots = slotsFrom(props);
  const estimated = getNumber(props, "Estimated Guest Count");
  return {
    id: page.id,
    url: page.url,
    title: getTitle(props, "Co-pilot Code") || getTitle(props, "Name"),
    code: codeFromTitle(getTitle(props, "Co-pilot Code") || getTitle(props, "Name")),
    email: getEmail(props, "Email"),
    region,
    locations: studiosForRequest({
      preferred,
      region,
    }),
    slots,
    guestCount: estimated == null ? getNumber(props, "Guest Count") : estimated,
    community: getRichText(props, COMMUNITY_PROP),
    notes: getRichText(props, "Notes"),
    calendarCard: getUrl(props, "Calendar Card"),
    eventCreditLink: getUrl(props, "Event Credit Link"),
    availabilitySent: getCheckbox(props, "Availability Sent"),
    windowNoted: getCheckbox(props, "Window Noted"),
    confirmedSession: getRichText(props, "Confirmed Session"),
    matchLog: getRichText(props, "Match Log"),
    hold: getRichText(props, "Hold"),
    copilotEmailed: getCheckbox(props, "Copilot Emailed"),
    copilotConfirm: getCheckbox(props, "Copilot Confirm"),
    mtTagged: getCheckbox(props, "MT Tagged"),
  };
}

async function queryAll(databaseId, filter) {
  const notion = getNotionClient();
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
      ...(filter ? { filter } : {}),
    });
    pages.push(...(res.results || []).filter((page) => page.object === "page"));
    cursor = res.has_more ? res.next_cursor : undefined;
    if (cursor) await sleep(config.requestDelayMs);
  } while (cursor);
  return pages;
}

export async function listHybridRequests() {
  const databaseId = String(
    config.notion.hybridRequestsDatabaseId || "",
  ).trim();
  if (!databaseId)
    throw new Error("Missing NOTION_HYBRID_REQUESTS_DATABASE_ID");
  const pages = await queryAll(databaseId);
  return pages.map(normalizeRequest);
}

function sessionIdFromTitle(title) {
  const text = String(title || "").trim();
  if (/^\d+$/.test(text)) return text;
  const match = text.match(/\b(\d{4,})\b/);
  return match ? match[1] : text;
}

function normalizeConfirmation(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    sessionId: sessionIdFromTitle(
      getTitle(props, "Session") || getTitle(props, "Name"),
    ),
    email: getEmail(props, "Email"),
    code: getRichText(props, "Code"),
    processed: getCheckbox(props, "Processed"),
  };
}

export async function listHybridConfirmations() {
  const databaseId = String(config.hybrid.confirmDatabaseId || "").trim();
  if (!databaseId) return [];
  const pages = await queryAll(databaseId);
  return pages
    .map(normalizeConfirmation)
    .filter((row) => !row.processed && row.sessionId);
}

export async function markConfirmationProcessed(pageId) {
  const notion = getNotionClient();
  await notion.pages.update({
    page_id: pageId,
    properties: buildCheckboxUpdate("Processed", true),
  });
}

async function findExistingCalendarCard({ title, date }) {
  const databaseId = String(config.notion.eventsDatabaseId || "").trim();
  if (!databaseId || !date) return null;
  const pages = await queryAll(databaseId, {
    and: [
      { property: "Name", title: { equals: title } },
      { property: "Date", date: { equals: date } },
    ],
  });
  return pages[0] || null;
}

function inferFormat(className) {
  const text = String(className || "").toLowerCase();
  if (text.includes("free flow")) return "Free Flow";
  if (text.includes("guided")) return "Guided Class";
  return "";
}

function mention(userId) {
  return {
    type: "mention",
    mention: { type: "user", user: { id: userId } },
  };
}

function holdNotice() {
  const ids = [
    config.hybrid.shannonNotionUserId,
    config.hybrid.stellaNotionUserId,
  ]
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const parts = [];
  ids.forEach((id, index) => {
    if (index) parts.push(rich(" "));
    parts.push(mention(id));
  });
  parts.push(
    rich(
      " Confirmed session. Toronto uses the shared Co-Pilot hybrid credit link unless Event Credit Link is filled. New York needs that link pasted. This session is tagged Reduced, and the copilot is emailed once a credit link is available.",
    ),
  );
  return paragraph(parts);
}

function cardBlocks({
  displayName,
  email,
  code,
  requestUrl,
  guestCount,
  community,
  notes,
  sessions,
}) {
  const blocks = [holdNotice()];
  for (const session of sessions) {
    const spots =
      session.available == null
        ? ""
        : ` · ${session.available}${session.capacity == null ? "" : ` of ${session.capacity}`} spots open`;
    const when = [
      session.date,
      session.time,
      session.location,
      session.className,
    ]
      .filter(Boolean)
      .join(" · ");
    blocks.push(paragraph([rich(`${when}${spots} · MT ${session.id}`)]));
  }
  blocks.push(
    paragraph([
      rich("Copilot: ", { bold: true }),
      rich(displayName || "—"),
      rich(email ? ` <${email}>` : ""),
    ]),
    paragraph([rich("Code: ", { bold: true }), rich(code || "—")]),
  );
  if (community) {
    blocks.push(
      paragraph([rich("Community: ", { bold: true }), rich(community)]),
    );
  }
  blocks.push(
    paragraph([
      rich("Expected guests: ", { bold: true }),
      rich(guestCount == null ? "—" : String(guestCount)),
    ]),
  );
  if (notes)
    blocks.push(paragraph([rich("Notes: ", { bold: true }), rich(notes)]));
  if (requestUrl) {
    blocks.push(
      paragraph([
        rich("Request: ", { bold: true }),
        rich(requestUrl, { link: requestUrl }),
      ]),
    );
  }
  blocks.push(heading("Booking Checklist [Internal Use]"));
  for (const item of CHECKLIST) blocks.push(todo(item));
  return blocks;
}

function cardProperties({ displayName, guestCount, sessions }) {
  const primary = sessions[0];
  const title = calendarCardTitle(displayName);
  const hour = Number(String(primary?.time || "").slice(0, 2));
  const locations = [
    ...new Set(sessions.map((session) => session.location).filter(Boolean)),
  ];
  const formats = [
    ...new Set(
      sessions.map((session) => inferFormat(session.className)).filter(Boolean),
    ),
  ];
  const props = {
    ...buildTitleUpdate("Name", title),
    ...buildDateUpdate("Date", primary?.date),
    ...buildRichTextUpdate("Start Time", formatCompactClock(primary?.time)),
    ...buildNumberUpdate("Attending Guests", guestCount),
    "Event Type": { multi_select: [{ name: "Paid Hybrid" }] },
    "Public/Private": { multi_select: [{ name: "Public" }] },
  };
  if (locations.length)
    props.Location = { multi_select: locations.map((name) => ({ name })) };
  const reserveUrl = scheduleSessionUrl(primary);
  if (reserveUrl) props["Public Link"] = { url: reserveUrl };
  if (primary?.city) props.City = { select: { name: primary.city } };
  if (formats.length === 1)
    props.Format = { multi_select: [{ name: formats[0] }] };
  const dayPart = timeOfDay(hour);
  if (dayPart) props["Time of Day"] = { multi_select: [{ name: dayPart }] };
  return props;
}

function formatCompactClock(hhmmss) {
  const match = String(hhmmss || "").match(/^(\d{2}):(\d{2})/);
  if (!match) return "";
  const hour24 = Number(match[1]);
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return `${hour}:${match[2]}${suffix}`;
}

/**
 * Create one Global Events Calendar card listing every matched session, or
 * reuse the card already titled for this copilot on the first session's date.
 * @returns {Promise<{ id: string, url: string, created: boolean }>}
 */
export async function ensureCalendarCard(details) {
  const databaseId = String(config.notion.eventsDatabaseId || "").trim();
  if (!databaseId) throw new Error("Missing NOTION_EVENTS_DATABASE_ID");
  const sessions = details.sessions || [];
  if (!sessions.length)
    throw new Error("Need at least one session for the calendar card");
  const title = calendarCardTitle(details.displayName);
  const existing = await findExistingCalendarCard({
    title,
    date: sessions[0].date,
  });
  if (existing?.url) {
    const reserveUrl = scheduleSessionUrl(sessions[0]);
    const current = getUrl(existing.properties || {}, "Public Link");
    if (reserveUrl && !current) {
      const notion = getNotionClient();
      await notion.pages.update({
        page_id: existing.id,
        properties: { "Public Link": { url: reserveUrl } },
      });
    }
    return { id: existing.id, url: existing.url, created: false };
  }
  const notion = getNotionClient();
  const created = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: "emoji", emoji: "🟤" },
    properties: cardProperties(details),
    children: cardBlocks(details),
  });
  return { id: created.id, url: created.url, created: true };
}

/** Date, start time, location, format, and guest count currently on the card. */
export async function readCalendarCard(pageId) {
  const notion = getNotionClient();
  const page = await notion.pages.retrieve({ page_id: pageId });
  const props = page.properties || {};
  const startTime = getRichText(props, "Start Time");
  const parsed = parseStartTime(startTime);
  const locations = getMultiSelectNames(props, "Location")
    .map((name) => locationMeta(name))
    .filter((meta) => meta?.locationId);
  return {
    date: String(getDateStart(props, "Date") || "").slice(0, 10),
    startTime,
    hhmmss: parsed?.hhmmss || null,
    locations,
    formats: getMultiSelectNames(props, "Format"),
    guestCount: getNumber(props, "Attending Guests"),
    city: getSelect(props, "City"),
  };
}

async function listChildBlocks(pageId) {
  const notion = getNotionClient();
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

function todoText(block) {
  return (block.to_do?.rich_text || [])
    .map((part) => part.plain_text)
    .join("")
    .trim();
}

/**
 * @returns {Promise<{ found: boolean, checked: boolean }>}
 */
export async function managementApproval(pageId) {
  const blocks = await listChildBlocks(pageId);
  for (const block of blocks) {
    if (block.type !== "to_do") continue;
    if (todoText(block) === "Management Approved") {
      return { found: true, checked: Boolean(block.to_do.checked) };
    }
  }
  return { found: false, checked: false };
}

const BOOKING_NOTE_PREFIX = "We'll book your community into:";
const BOOKING_CONFIRM_LINE =
  "Check the box underneath Copilot Confirm below to confirm the hybrid booking.";

function blockPlainText(block) {
  if (block.type === "to_do") return todoText(block);
  const parts = block[block.type]?.rich_text || [];
  return parts.map((part) => part.plain_text || "").join("").trim();
}

/** Copilot-written notes, without the booking line this job adds. */
export function copilotNotes(notes) {
  const text = String(notes || "").trim();
  const at = text.indexOf(BOOKING_NOTE_PREFIX);
  if (at === -1) return text;
  return text.slice(0, at).trim();
}

function bookingNoteProperty(sessions, existingNotes = "") {
  const lines = (sessions || [])
    .map((session) => {
      const spots =
        session.available == null ? "" : ` · ${session.available} spots open`;
      return `${formatMatchLabel(session)}${spots}`;
    })
    .filter(Boolean);
  const kept = copilotNotes(existingNotes);
  const richText = [];
  if (kept) {
    richText.push({ type: "text", text: { content: `${kept}\n` } });
  }
  if (lines.length) {
    richText.push({
      type: "text",
      text: { content: `${BOOKING_NOTE_PREFIX} ${lines.join("; ")}. ` },
    });
    richText.push({
      type: "text",
      text: { content: BOOKING_CONFIRM_LINE },
      annotations: {
        bold: true,
        italic: false,
        strikethrough: false,
        underline: true,
        code: false,
        color: "purple",
      },
    });
  }
  return { rich_text: richText };
}

/**
 * Write the session we'll book into Notes. The page body stays empty.
 * A note the copilot already typed is kept above the booking line.
 */
export async function syncBookingNote(pageId, sessions, existingNotes = "") {
  const blocks = await listChildBlocks(pageId);
  const notion = getNotionClient();
  for (const block of blocks) {
    const text = blockPlainText(block);
    const stale =
      (block.type === "to_do" && /Confirm this session · \d{4,}/.test(text)) ||
      (block.type === "paragraph" &&
        (!text ||
          text.startsWith("Check the Free Flow you want") ||
          text.startsWith(BOOKING_NOTE_PREFIX) ||
          text.startsWith("Check Copilot Confirm")));
    if (!stale) continue;
    await notion.blocks.delete({ block_id: block.id });
  }
  await notion.pages.update({
    page_id: pageId,
    properties: { Notes: bookingNoteProperty(sessions, existingNotes) },
  });
}

function creditUrlFromBlocks(blocks) {
  for (const block of blocks) {
    const parts = block[block.type]?.rich_text || [];
    for (const part of parts) {
      const url = String(part?.text?.link?.url || part?.href || "").trim();
      if (/brandbot|checkout/i.test(url)) return url;
    }
  }
  return "";
}

/** Event Credit Link on the request, or a Brandbot URL pasted in the page. */
export async function findCreditLink(pageId, propertyUrl = "") {
  const direct = String(propertyUrl || "").trim();
  if (direct) return direct;
  const blocks = await listChildBlocks(pageId);
  return creditUrlFromBlocks(blocks);
}

function richTextValue(value) {
  const text = String(value || "").slice(0, 2000);
  if (!text) return { rich_text: [] };
  return { rich_text: [{ type: "text", text: { content: text } }] };
}

export async function updateHybridRequest(pageId, fields) {
  const properties = {
    ...(fields.title ? buildTitleUpdate("Co-pilot Code", fields.title) : {}),
    ...(fields.calendarCard
      ? { "Calendar Card": { url: fields.calendarCard } }
      : {}),
    ...(fields.eventCreditLink
      ? { "Event Credit Link": { url: fields.eventCreditLink } }
      : {}),
    ...(fields.availabilitySent != null
      ? buildCheckboxUpdate("Availability Sent", fields.availabilitySent)
      : {}),
    ...(fields.windowNoted != null
      ? buildCheckboxUpdate("Window Noted", fields.windowNoted)
      : {}),
    ...(fields.confirmedSession != null
      ? { "Confirmed Session": richTextValue(fields.confirmedSession) }
      : {}),
    ...(fields.copilotEmailed != null
      ? buildCheckboxUpdate("Copilot Emailed", fields.copilotEmailed)
      : {}),
    ...(fields.copilotConfirm != null
      ? buildCheckboxUpdate("Copilot Confirm", fields.copilotConfirm)
      : {}),
    ...(fields.mtTagged != null
      ? buildCheckboxUpdate("MT Tagged", fields.mtTagged)
      : {}),
    ...(fields.matchLog != null
      ? { "Match Log": richTextValue(fields.matchLog) }
      : {}),
    ...(fields.hold != null ? { Hold: richTextValue(fields.hold) } : {}),
  };
  if (!Object.keys(properties).length) return;
  const notion = getNotionClient();
  await notion.pages.update({ page_id: pageId, properties });
}
