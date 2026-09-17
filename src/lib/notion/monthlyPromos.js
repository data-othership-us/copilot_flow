import { config } from "../../config.js";
import { normalizeCopilotRegion } from "../copilotIdentity.js";
import { monthlyLink, monthlyNote, monthlySectionHeading } from "../email/monthlyLayout.js";
import { getCheckbox, getDateStart, getSelect, getTitle, getUrl } from "./parseProps.js";
import { getNotionClient } from "./applications.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function richTextToHtml(rich) {
  return (rich || [])
    .map((part) => {
      const text = escapeHtml(part.plain_text || "").replace(/\n/g, "<br>");
      const href = part.href || part.text?.link?.url;
      if (href && text) {
        return `<a href="${escapeHtml(href)}">${text}</a>`;
      }
      return text;
    })
    .join("");
}

function getRichHtml(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "rich_text") return "";
  return richTextToHtml(p.rich_text);
}

function promoMatchesRegion(promoRegion, copilotRegion) {
  const promo = String(promoRegion || "All").trim();
  if (!promo || promo.toLowerCase() === "all") return true;
  return normalizeCopilotRegion(promo) === normalizeCopilotRegion(copilotRegion);
}

function normalizePromo(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    name: getTitle(props, "Name"),
    month: getDateStart(props, "Month"),
    region: getSelect(props, "Region") || "All",
    headline: getRichHtml(props, "Headline"),
    body: getRichHtml(props, "Body"),
    code: getRichHtml(props, "Code"),
    link: getUrl(props, "Link"),
    ready: getCheckbox(props, "Ready"),
  };
}

/**
 * Ready promo rows whose Month falls in [startDate, endDate].
 */
export async function listMonthlyPromos({ startDate, endDate } = {}) {
  const databaseId = String(config.notion.monthlyPromosDatabaseId || "").trim();
  if (!databaseId) return [];
  if (!config.notion.token) {
    throw new Error("NOTION_TOKEN is required to load monthly promos");
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
          { property: "Ready", checkbox: { equals: true } },
          { property: "Month", date: { on_or_after: startDate } },
          { property: "Month", date: { on_or_before: endDate } },
        ],
      },
      sorts: [{ property: "Month", direction: "ascending" }],
    });
    pages.push(...(res.results || []).filter((p) => p.object === "page"));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages.map(normalizePromo);
}

export function promosForRegion(promos, region) {
  return (promos || []).filter((promo) => promoMatchesRegion(promo.region, region));
}

export function renderPromoHtml(promos) {
  const items = (promos || []).filter(
    (promo) => promo.headline || promo.body || promo.code || promo.link
  );
  if (!items.length) return "";

  const blocks = items.map((promo) => {
    const parts = [];
    if (promo.headline) {
      parts.push(monthlyNote(`<strong>${promo.headline}</strong>`));
    }
    if (promo.body) parts.push(monthlyNote(promo.body));
    const extras = [];
    if (promo.code) extras.push(`Code: <strong>${promo.code}</strong>`);
    if (promo.link) {
      extras.push(monthlyLink(escapeHtml(promo.link), escapeHtml(promo.link)));
    }
    if (extras.length) parts.push(monthlyNote(extras.join(" · ")));
    return parts.join("\n");
  });

  return `${monthlySectionHeading("This month")}\n${blocks.join("\n")}`;
}
