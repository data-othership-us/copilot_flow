import { config } from "../../config.js";
import { mtGet, mtPatch } from "./marianatekClient.js";

function sessionStart(session) {
  return String(session?.attributes?.start_time || "").slice(0, 8);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function weekdayIndex(date) {
  const [year, month, day] = String(date || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function clockMinutes(hhmmss) {
  const match = String(hhmmss || "").match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Hybrid windows: Mon–Fri 7:00 AM–3:30 PM, and Mon–Wed from 9:00 PM.
 */
export function isHybridWindow({ date, hhmmss }) {
  const day = weekdayIndex(date);
  const mins = clockMinutes(hhmmss);
  if (day == null || mins == null) return false;
  const weekday = day >= 1 && day <= 5;
  const monWed = day >= 1 && day <= 3;
  const daytime = weekday && mins >= 7 * 60 && mins <= 15 * 60 + 30;
  const evening = monWed && mins >= 21 * 60;
  return daytime || evening;
}

export function isSlotInHybridWindow(slot) {
  return isHybridWindow({ date: slot?.date, hhmmss: slot?.hhmmss });
}

export function formatRequestedTime(slot) {
  return formatMatchLabel({ date: slot?.date, time: slot?.hhmmss });
}

export function formatClock(hhmmss, { compact = false } = {}) {
  const match = String(hhmmss || "").match(/^(\d{2}):(\d{2})/);
  if (!match) return "";
  const hour24 = Number(match[1]);
  const minute = match[2];
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  const gap = compact ? "" : " ";
  return `${hour}:${minute}${gap}${suffix}`;
}

export function formatMatchLabel(match) {
  const [year, month, day] = String(match?.date || "").split("-").map(Number);
  const clock = formatClock(match?.time);
  let when = match?.date || "";
  if (year && month && day) {
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
    when = `${weekday}, ${MONTHS[month - 1]} ${day}${clock ? `, ${clock}` : ""}`;
  }
  return [when, match?.location, match?.className].filter(Boolean).join(" — ");
}

function isBookableSession(session) {
  const attrs = session?.attributes || {};
  if (attrs.cancelled || attrs.cancellation_datetime || attrs.archived) return false;
  return Boolean(session?.id && sessionStart(session));
}

function sessionBounds(session) {
  const start = clockMinutes(sessionStart(session));
  if (start == null) return null;
  const duration = Number(session?.attributes?.duration);
  if (Number.isFinite(duration) && duration > 0) return { start, end: start + duration };
  const startAt = Date.parse(session?.attributes?.start_datetime || "");
  const endAt = Date.parse(session?.attributes?.end_datetime || "");
  if (Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt) {
    return { start, end: start + Math.round((endAt - startAt) / 60000) };
  }
  return { start, end: start + 1 };
}

export function sessionToMatch(session, location, city = "") {
  const spots = session?.attributes?.available_spots;
  const capacity = Number(session?.attributes?.capacity);
  return {
    id: String(session.id),
    location,
    city,
    date: String(session?.attributes?.start_date || "").slice(0, 10),
    time: sessionStart(session),
    className: String(session?.attributes?.class_type_display || "").trim(),
    duration: Number(session?.attributes?.duration) || null,
    capacity: Number.isFinite(capacity) ? capacity : null,
    available: Array.isArray(spots) ? spots.length : null,
  };
}

function sessionDate(session, fallback) {
  return String(session?.attributes?.start_date || fallback || "").slice(0, 10);
}

function onDateInWindow(session, { location, date }) {
  const day = sessionDate(session, date);
  if (date && day !== date) return false;
  return isHybridWindow({ date: day, hhmmss: sessionStart(session) });
}

/** Sessions running at the requested local time, including ones that started earlier. */
export function sessionsOverlapping(sessions, { location, date, hhmmss, city } = {}) {
  const requested = clockMinutes(hhmmss);
  if (requested == null) return [];
  return (sessions || [])
    .filter(isBookableSession)
    .filter((session) => onDateInWindow(session, { location, date }))
    .filter((session) => {
      const bounds = sessionBounds(session);
      return bounds && requested >= bounds.start && requested < bounds.end;
    })
    .map((session) => sessionToMatch(session, location, city));
}

/** Sessions whose local start time is exactly the one on the confirmed card. */
export function sessionsAtStart(sessions, { location, date, hhmmss, city } = {}) {
  if (!hhmmss) return [];
  return (sessions || [])
    .filter(isBookableSession)
    .filter((session) => !date || sessionDate(session, date) === date)
    .filter((session) => sessionStart(session) === hhmmss)
    .map((session) => sessionToMatch(session, location, city));
}

export function fitsGuestCount(match, guestCount) {
  if (guestCount == null) return true;
  if (match?.available == null) return false;
  return match.available >= guestCount;
}

function classMatchesFormat(className, formats) {
  const text = String(className || "").toLowerCase();
  return (formats || []).some((format) => {
    const name = String(format || "").toLowerCase();
    if (name === "free flow") return text.includes("free flow");
    if (name === "guided class") return text.includes("guided");
    return name && text.includes(name);
  });
}

/** One session, or the single class that matches the card's format. */
export function pickConfirmedSession(sessions, formats = []) {
  if (!sessions?.length) return null;
  if (sessions.length === 1) return sessions[0];
  if (formats.length !== 1) return null;
  const narrowed = sessions.filter((session) => classMatchesFormat(session.className, formats));
  return narrowed.length === 1 ? narrowed[0] : null;
}

export function formatSuggestion(match) {
  const label = formatMatchLabel(match);
  if (match?.available == null) return label;
  const capacity = match.capacity == null ? "" : ` of ${match.capacity}`;
  return `${label} — ${match.available}${capacity} spots open`;
}

export async function listSessionsOnDate(locationId, date) {
  const sessions = [];
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const data = await mtGet("/class_sessions", {
      location: locationId,
      min_date: date,
      max_date: date,
      page_size: 100,
      page,
    });
    sessions.push(...(data.data || []));
    pages = Number(data.meta?.pagination?.pages) || 1;
    page += 1;
  }
  return sessions;
}

function tagRefs(session) {
  const refs = session?.relationships?.tags?.data || [];
  return refs.map((ref) => ({
    type: ref.type || "class_session_tags",
    id: String(ref.id),
  }));
}

async function patchReducedTag(session) {
  const tagId = String(config.mt.reducedClassTagId || "").trim();
  if (!tagId) throw new Error("Missing MT_REDUCED_CLASS_TAG_ID");
  const existing = tagRefs(session);
  if (existing.some((ref) => ref.id === tagId)) {
    return { sessionId: String(session.id), alreadyTagged: true };
  }
  await mtPatch(`/class_sessions/${session.id}`, {
    data: {
      type: "class_sessions",
      id: String(session.id),
      relationships: {
        tags: {
          data: [...existing, { type: "class_session_tags", id: tagId }],
        },
      },
    },
  });
  return { sessionId: String(session.id), alreadyTagged: false };
}

const CITY_BY_STUDIO = {
  Adelaide: "Toronto",
  Yorkville: "Toronto",
  Flatiron: "New York",
  Williamsburg: "New York",
};

function studioForSession(session) {
  const locationId = String(session?.relationships?.location?.data?.id || "");
  const known = Object.entries(config.mt.locationIds).find(
    ([, id]) => String(id) === locationId
  );
  const display = String(session?.attributes?.location_display || "").trim();
  const name = known?.[0] || display;
  return { name, city: CITY_BY_STUDIO[name] || "" };
}

/**
 * Schedule page that opens this class in the Booko modal.
 * The iframe path is `/schedule/daily/{region}?locations={id}&activeDate={date}`,
 * and `_bookoClass` is the class session id on the parent page.
 */
export function scheduleSessionUrl(session) {
  const id = String(session?.id || "").trim();
  const date = String(session?.date || "").slice(0, 10);
  const locationId = String(
    session?.locationId || config.mt.locationIds[session?.location] || ""
  ).trim();
  const regionId = String(
    session?.regionId || config.mt.regionIds[session?.city] || ""
  ).trim();
  if (!/^\d+$/.test(id) || !/^\d+$/.test(locationId) || !/^\d+$/.test(regionId)) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const path = `/schedule/daily/${regionId}?locations=${locationId}&activeDate=${date}`;
  return `https://www.othership.us/schedule?_mt=${encodeURIComponent(path)}&_bookoClass=${id}`;
}

/**
 * Live class session, mapped the same way suggestions are.
 * @returns {Promise<{ session: object, match: object }>}
 */
export async function loadSessionMatch(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Missing a Mariana Tek session id");
  const data = await mtGet(`/class_sessions/${id}`);
  const session = data?.data;
  if (!session?.id) throw new Error(`Mariana Tek session ${id} was not found`);
  const studio = studioForSession(session);
  return { session, match: sessionToMatch(session, studio.name, studio.city) };
}

/**
 * Add Reduced to a class session already loaded. Existing tags stay on it.
 * @returns {Promise<{ sessionId: string, alreadyTagged: boolean }>}
 */
export async function tagClassSession(session) {
  if (!session?.id) throw new Error("Missing a Mariana Tek session");
  return patchReducedTag(session);
}

/**
 * Add Reduced to a known class session. Existing tags stay on it.
 * @returns {Promise<{ sessionId: string, alreadyTagged: boolean }>}
 */
export async function tagSessionById(sessionId) {
  const { session } = await loadSessionMatch(sessionId);
  return tagClassSession(session);
}

