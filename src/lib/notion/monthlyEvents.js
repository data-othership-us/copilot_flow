import { config } from "../../config.js";
import {
  monthlyEventLine,
  monthlyLink,
  monthlyLocationHeading,
  monthlyNote,
  monthlySectionHeading,
} from "../email/monthlyLayout.js";
import { getNotionClient } from "./applications.js";
import {
  getCheckbox,
  getDateStart,
  getMultiSelectNames,
  getRichText,
  getSelect,
  getTitle,
  getUrl,
} from "./parseProps.js";

const HYBRID_TYPES = new Set(["Paid Hybrid", "Free Hybrid"]);
const PRIVATE_TYPES = new Set(["Paid Private", "Private Comped", "Comped Private"]);
const PUBLIC_SPECIAL_TYPES = new Set([
  "Paid Internal Event",
  "Brand Activation",
  "Vibe Bringer",
]);

const NYC_LOCATIONS = ["Flatiron", "Williamsburg"];
const TO_LOCATIONS = ["Adelaide", "Yorkville"];
const LOCATION_SECTION_ORDER = [
  "Adelaide",
  "Yorkville",
  "Flatiron",
  "Williamsburg",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSocialPlayground(event) {
  return /social\s*playground/i.test(event.name || "");
}

function isNamedVibeBringer(event) {
  return /^vibe\s*bringer\s*[-–—]/i.test(String(event.name || "").trim());
}

function hasType(event, set) {
  return (event.eventType || []).some((type) => set.has(type));
}

function isExplicitlyPrivateOnly(event) {
  const flags = event.publicPrivate || [];
  return flags.includes("Private") && !flags.includes("Public");
}

/** Same public cut as event-automations OS email list. */
export function isPublicEmailListEvent(event) {
  if (!event?.name || !event?.date) return false;
  if (isSocialPlayground(event)) return false;
  if (isNamedVibeBringer(event)) return false;
  if (hasType(event, HYBRID_TYPES)) return false;
  if (/^hybrid\b/i.test(event.name)) return false;
  if (hasType(event, PRIVATE_TYPES) && !hasType(event, PUBLIC_SPECIAL_TYPES)) {
    return false;
  }
  if (isExplicitlyPrivateOnly(event) && !hasType(event, PUBLIC_SPECIAL_TYPES)) {
    return false;
  }
  return hasType(event, PUBLIC_SPECIAL_TYPES);
}

export function eventRegion(event) {
  const locs = event.location || [];
  if (locs.some((loc) => NYC_LOCATIONS.includes(loc))) return "NYC";
  if (locs.some((loc) => TO_LOCATIONS.includes(loc))) return "TO";
  const city = String(event.city || "").toUpperCase();
  if (city.includes("NY") || city.includes("NEW YORK")) return "NYC";
  if (city.includes("TO") || city.includes("TORONTO")) return "TO";
  return null;
}

export function eventsForRegion(events, region) {
  const want = String(region || "").toUpperCase() === "NYC" ? "NYC" : "TO";
  return (events || []).filter((event) => eventRegion(event) === want);
}

export function formatOrdinalDay(isoDate) {
  const raw = String(isoDate || "").slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  const weekday = dt.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = dt.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const day = dt.getUTCDate();
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return `${weekday}, ${month} ${day}${suffix}`;
}

function timeRange(event) {
  const start = String(event.startTime || "").trim();
  const end = String(event.endTime || "").trim();
  if (start && end) return `${start}–${end}`;
  return start || end || "";
}

export function resolveEventDescription(event) {
  const name = String(event.name || "").toLowerCase();

  if (isSocialPlayground(event)) {
    if (/beat\s*drop/i.test(name)) {
      return "Co-Pilot Beat Drop Social Playground — connect, shoot content, and share with a live DJ takeover energy. Filming welcome.";
    }
    return "Blocked-out Free Flow for Co-Pilots to connect, shoot content, and share. Filming welcome.";
  }

  if (name.includes("beat drop")) {
    return "Consider this our icy-fresh take on an evening out with friends with a live DJ takeover. A 2-hour sober-curious gathering to connect with others over a shared sense of play and aliveness.";
  }
  if (
    name.includes("friendship") ||
    name.includes("friend(ship)") ||
    name.includes("meet your people")
  ) {
    return "An evening designed for cultivating new connections in an effortless way.";
  }
  if (name.includes("lovership")) {
    return "In a world of lukewarm connections, we prefer to play at the extremes. Join us where singles find their element: 200° of possibility, 39° of presence.";
  }
  if (name.includes("candlelit") || name.includes("candlelight")) {
    return "Come feel peak relaxation at the Restorative Candlelit Free Flow — every overhead light off, real candle flame, music low. Come tired. Leave softer.";
  }
  if (name.includes("runner")) {
    return "Our icy-fresh take on an evening out with friends, with an optional 5km run beforehand led by local run club captains.";
  }
  if (name.includes("harp") || name.includes("quieter")) {
    return "A quieter self-guided journey: sauna, ice, and commons, accompanied by live harp.";
  }
  if (name.includes("tarot")) {
    return "Our icy-fresh take on an evening out with friends — with optional tarot readings in the tea lounge.";
  }
  if (name.includes("human design")) {
    return "Our icy-fresh take on an evening out with friends — with optional Human Design readings in the tea lounge.";
  }
  if (name.includes("astrology")) {
    return "Our icy-fresh take on an evening out with friends — with optional astrology readings in the space.";
  }
  if (name.includes("sanctum")) {
    return "Step out of the sauna and into the breezeway for a movement experience with Sanctum — then flow straight back through our doors.";
  }
  if (name.includes("comedy")) {
    return "Comedians deliver intimate sets in the enveloping heat, with an intermission in icy waters.";
  }

  return "";
}

function primaryLocation(event) {
  const locs = event.location || [];
  for (const preferred of LOCATION_SECTION_ORDER) {
    if (locs.includes(preferred)) return preferred;
  }
  return locs[0] || "Unknown";
}

function isNotionHostedUrl(href) {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return (
      host === "notion.so" ||
      host.endsWith(".notion.so") ||
      host === "notion.site" ||
      host.endsWith(".notion.site")
    );
  } catch {
    return true;
  }
}

/** Guest-facing signup URL only — never a Notion page. */
export function publicSignupUrl(event) {
  const href = String(event?.publicLink || "").trim();
  if (!/^https?:\/\//i.test(href)) return "";
  if (isNotionHostedUrl(href)) return "";
  return href;
}

function publicFacingUrl(props) {
  const fromUrl = getUrl(props, "Public Link");
  if (fromUrl) return fromUrl;
  const fromText = getRichText(props, "Public Link");
  const match = String(fromText || "").match(/https?:\/\/\S+/i);
  return match ? match[0].replace(/[).,]+$/, "") : "";
}

function normalizeEventPage(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    name: getTitle(props, "Name").replace(/\*+/g, "").trim(),
    date: String(getDateStart(props, "Date") || "").slice(0, 10),
    startTime: getRichText(props, "Start Time"),
    endTime: getRichText(props, "End Time"),
    location: getMultiSelectNames(props, "Location"),
    city: getSelect(props, "City"),
    eventType: getMultiSelectNames(props, "Event Type"),
    publicPrivate: getMultiSelectNames(props, "Public/Private"),
    eventBriefLink: getUrl(props, "Event Brief Link"),
    publicLink: publicFacingUrl(props),
    addedIntoMt: getCheckbox(props, "Added into MT"),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Global Events Calendar rows whose Date falls in [startDate, endDate].
 * Same source as event-automations monthly lists.
 */
export async function queryEventsInDateRange(startDate, endDate) {
  const databaseId = String(config.notion.eventsDatabaseId || "").trim();
  if (!databaseId) {
    throw new Error("Missing NOTION_EVENTS_DATABASE_ID");
  }
  if (!config.notion.token) {
    throw new Error("NOTION_TOKEN is required to load monthly events");
  }

  const notion = getNotionClient();
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        and: [
          { property: "Date", date: { on_or_after: startDate } },
          { property: "Date", date: { on_or_before: endDate } },
        ],
      },
      sorts: [{ property: "Date", direction: "ascending" }],
    });
    pages.push(
      ...(res.results || [])
        .filter((page) => page.object === "page")
        .map(normalizeEventPage)
    );
    cursor = res.has_more ? res.next_cursor : undefined;
    if (cursor) await sleep(350);
  } while (cursor);

  return pages;
}

function titleLine(event) {
  const when = formatOrdinalDay(event.date);
  const times = timeRange(event);
  if (times) return `${event.name} — ${when} ${times}`;
  return `${event.name} — ${when}`;
}

function groupByLocation(events) {
  const groups = new Map();
  for (const loc of LOCATION_SECTION_ORDER) groups.set(loc, []);
  for (const event of events) {
    const loc = primaryLocation(event);
    if (!groups.has(loc)) groups.set(loc, []);
    groups.get(loc).push(event);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const dateCmp = String(a.date).localeCompare(String(b.date));
      if (dateCmp) return dateCmp;
      return String(a.startTime || "").localeCompare(String(b.startTime || ""));
    });
  }
  return groups;
}

function renderEventGroupHtml(events) {
  const groups = groupByLocation(events);
  const parts = [];
  for (const loc of [
    ...LOCATION_SECTION_ORDER,
    ...[...groups.keys()].filter((k) => !LOCATION_SECTION_ORDER.includes(k)),
  ]) {
    const list = groups.get(loc) || [];
    if (!list.length) continue;
    parts.push(monthlyLocationHeading(escapeHtml(loc)));
    for (const event of list) {
      const link = publicSignupUrl(event);
      const title = escapeHtml(titleLine(event));
      if (isSocialPlayground(event) && link) {
        parts.push(monthlyEventLine(monthlyLink(escapeHtml(link), title)));
      } else {
        parts.push(monthlyEventLine(title));
      }
    }
  }
  return parts.join("\n");
}

export function renderPlaygroundHtml(events) {
  const playgrounds = (events || []).filter(isSocialPlayground);
  if (!playgrounds.length) return "";
  return [
    monthlySectionHeading("Social Playgrounds"),
    monthlyNote(
      "Private time to film and connect — copilot-only, and these don't use your monthly credits. Please cancel if you can't make it; no-shows are $45."
    ),
    renderEventGroupHtml(playgrounds),
  ].join("\n");
}

export function renderPublicEventsHtml(events) {
  const publics = (events || []).filter(isPublicEmailListEvent);
  if (!publics.length) return "";
  return [
    monthlySectionHeading("Public events"),
    monthlyNote(
      "Feel free to share these with your community. Some need special event credits rather than Co-Pilot passes."
    ),
    renderEventGroupHtml(publics),
  ].join("\n");
}

export { isSocialPlayground, LOCATION_SECTION_ORDER };
