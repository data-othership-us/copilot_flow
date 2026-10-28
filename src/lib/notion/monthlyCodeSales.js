import { config } from "../../config.js";
import { normalizeCopilotRegion } from "../copilotIdentity.js";
import { getNotionClient } from "./applications.js";
import { buildNumberUpdate, buildStatusUpdate, buildTitleUpdate, getStatus } from "./parseProps.js";

const MONTH_PROP = "Month";
const REVENUE_PROP = "Code Revenue";
const STATUS_PROP = "Status";
const IN_PROGRESS = "In progress";
const DONE = "Done";
const STAT_PROPS = [
  ["pilots", "Total Pilots"],
  ["onboarded", "Total Onboarded"],
  ["offboarded", "Total Off Boarded"],
  ["sessions", "Sessions Redeemed"],
];

const REGIONS = [
  { key: "TO", label: "Toronto", currency: "CAD" },
  { key: "NYC", label: "New York", currency: "USD" },
];

function databaseId(regionKey) {
  return regionKey === "NYC"
    ? config.notion.nycReportsDatabaseId
    : config.notion.toReportsDatabaseId;
}

function bqNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "object" && value.value != null) return bqNumber(value.value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function bqString(value) {
  if (value == null) return "";
  if (typeof value === "object" && value.value != null) return String(value.value);
  return String(value);
}

function roundMoney(value) {
  return Math.round(bqNumber(value) * 100) / 100;
}

function personName(row) {
  return [bqString(row.first_name), bqString(row.last_name)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

function moneyText(value) {
  return roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function promoSales(row, regionKey) {
  return regionKey === "NYC" ? bqNumber(row.promo_usd) : bqNumber(row.promo_cad);
}

function offerSales(row, regionKey) {
  return regionKey === "NYC" ? bqNumber(row.offer_usd) : bqNumber(row.offer_cad);
}

function otherPromoSales(row, regionKey) {
  return regionKey === "NYC" ? bqNumber(row.promo_cad) : bqNumber(row.promo_usd);
}

function otherOfferSales(row, regionKey) {
  return regionKey === "NYC" ? bqNumber(row.offer_cad) : bqNumber(row.offer_usd);
}

/** Region currency, with the other currency in parentheses when it is non-zero. */
function salesCell(primary, other, otherCode) {
  const text = moneyText(primary);
  if (roundMoney(other) === 0) return text;
  return `${text} (${moneyText(other)} ${otherCode})`;
}

function unassignedSales(row, regionKey) {
  return regionKey === "NYC" ? bqNumber(row.usd) : bqNumber(row.cad);
}

/** Offer product name decides the region. Currency is the fallback. */
export function unassignedMatchesRegion(row, regionKey) {
  const product = bqString(row.product || row.discount_name).toLowerCase();
  const nyc = /new york|\bnyc\b/.test(product);
  const to = /toronto/.test(product);
  if (regionKey === "NYC") {
    if (nyc) return true;
    if (to) return false;
    return bqNumber(row.usd) > 0 && bqNumber(row.cad) === 0;
  }
  if (to) return true;
  if (nyc) return false;
  return bqNumber(row.cad) > 0 && bqNumber(row.usd) === 0;
}

function textCell(value) {
  return [{ type: "text", text: { content: String(value ?? "").slice(0, 2000) } }];
}

function tableBlock(headers, dataRows) {
  const width = headers.length;
  const children = [headers, ...dataRows].map((cells) => ({
    object: "block",
    type: "table_row",
    table_row: {
      cells: cells.map((cell) => textCell(cell)),
    },
  }));
  return {
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children,
    },
  };
}

function headingBlock(type, text) {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

function heading2(text) {
  return headingBlock("heading_2", text);
}

function heading(text) {
  return headingBlock("heading_3", text);
}

function blockText(block) {
  const data = block?.[block.type];
  const rich = data?.rich_text;
  if (!Array.isArray(rich)) return "";
  return rich.map((part) => part.plain_text || "").join("");
}

const OURS = {
  heading: "Code usage",
  unassigned: "2-for-1 not tied to a copilot",
  empty: "No roster promo-code or 2-for-1 sales this month.",
};

function isOurStaticBlock(block) {
  const text = blockText(block);
  return (
    (block.type === "heading_2" && text === OURS.heading) ||
    (block.type === "heading_3" && text === OURS.unassigned) ||
    (block.type === "paragraph" && text === OURS.empty)
  );
}

async function isOurTable(notion, block) {
  if (block.type !== "table") return false;
  const response = await notion.blocks.children.list({
    block_id: block.id,
    page_size: 1,
  });
  const row = (response.results || []).find((child) => child.type === "table_row");
  if (!row) return false;
  const headers = row.table_row.cells
    .map((cell) => cell.map((part) => part.plain_text || "").join(""))
    .join("|");
  return headers.startsWith("Name|Code|Promo orders") || headers.startsWith("Product|Orders|");
}

export function codeRevenue(rows, regionKey) {
  return roundMoney(
    rows.reduce(
      (total, row) => total + promoSales(row, regionKey) + offerSales(row, regionKey),
      0
    )
  );
}

function reportBlocks(rows, unassigned, regionKey) {
  const currency = regionKey === "NYC" ? "USD" : "CAD";
  const otherCurrency = regionKey === "NYC" ? "CAD" : "USD";
  const sorted = [...rows].sort(
    (a, b) =>
      promoSales(b, regionKey) +
      offerSales(b, regionKey) -
      (promoSales(a, regionKey) + offerSales(a, regionKey))
  );
  const blocks = [
    heading2("Code usage"),
    tableBlock(
      [
        "Name",
        "Code",
        "Promo orders",
        `Promo sales (${currency})`,
        "2-for-1 orders",
        `2-for-1 sales (${currency})`,
      ],
      sorted.map((row) => [
        personName(row) || bqString(row.contact_email) || "—",
        bqString(row.promo_code) || "—",
        String(bqNumber(row.promo_orders)),
        salesCell(promoSales(row, regionKey), otherPromoSales(row, regionKey), otherCurrency),
        String(bqNumber(row.offer_orders)),
        salesCell(offerSales(row, regionKey), otherOfferSales(row, regionKey), otherCurrency),
      ])
    ),
  ];
  if (!sorted.length) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "No roster promo-code or 2-for-1 sales this month." } },
        ],
      },
    });
  }
  if (unassigned.length) {
    blocks.push(heading("2-for-1 not tied to a copilot"));
    blocks.push(
      tableBlock(
        ["Product", "Orders", `Sales (${currency})`],
        unassigned.map((row) => [
          bqString(row.product || row.discount_name) || "—",
          String(bqNumber(row.orders)),
          moneyText(unassignedSales(row, regionKey)),
        ])
      )
    );
  }
  return blocks;
}

function statProperties(schema, stats) {
  const properties = {};
  for (const [key, name] of STAT_PROPS) {
    const prop = schema?.[name];
    const value = Number(stats?.[key] ?? 0);
    if (!prop || !Number.isFinite(value)) continue;
    if (prop.type === "number") {
      Object.assign(properties, buildNumberUpdate(name, value));
    } else if (prop.type === "rich_text") {
      properties[name] = {
        rich_text: [{ type: "text", text: { content: String(value) } }],
      };
    }
  }
  return properties;
}

function statsLabel(stats) {
  const pilots = Number(stats?.pilots ?? 0);
  const onboarded = Number(stats?.onboarded ?? 0);
  const offboarded = Number(stats?.offboarded ?? 0);
  const sessions = Number(stats?.sessions ?? 0);
  return `${pilots} pilots · ${onboarded} onboarded · ${offboarded} offboarded · ${sessions} sessions`;
}

async function findMonthPage(notion, id, monthLabel) {
  const response = await notion.databases.query({
    database_id: id,
    filter: {
      property: MONTH_PROP,
      title: { equals: monthLabel },
    },
  });
  return (response.results || []).find((page) => page.object === "page") || null;
}

async function listChildren(notion, blockId) {
  const blocks = [];
  let cursor;
  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    });
    blocks.push(...(response.results || []));
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

/** Replace the code-usage section and leave screenshots and other blocks in place. */
async function replaceChildren(notion, pageId, children) {
  const existing = await listChildren(notion, pageId);
  const remove = [];
  for (const block of existing) {
    if (isOurStaticBlock(block) || (await isOurTable(notion, block))) remove.push(block.id);
  }
  for (const id of remove) {
    await notion.blocks.delete({ block_id: id });
  }
  if (children.length) {
    await notion.blocks.children.append({ block_id: pageId, children });
  }
}

/**
 * Upsert one page per region for this month.
 * Code Revenue is roster promo sales plus 2-for-1 sales tied to those copilots.
 * Unassigned 2-for-1 orders are listed on the page and left out of Code Revenue.
 * Total Pilots, onboarding, offboarding, and sessions come from Co-Pilot memberships.
 * Hybrid Rev stays as entered: the sheet figure is a running total, not this month.
 * A page already marked Done is left alone unless monthExplicit is set.
 */
export async function publishMonthlyCodeReports({
  monthLabel,
  rows,
  unassigned = [],
  statsByRegion = {},
  regionKey = null,
  monthExplicit = false,
  dryRun = true,
} = {}) {
  if (!config.notion.token) {
    throw new Error("NOTION_TOKEN is required to publish monthly code sales");
  }
  const notion = dryRun ? null : getNotionClient();
  const reader = getNotionClient();
  const targets = REGIONS.filter((region) => !regionKey || region.key === regionKey);
  const results = [];

  for (const region of targets) {
    const id = String(databaseId(region.key) || "").trim();
    if (!id) throw new Error(`Missing Notion reports database id for ${region.label}`);
    const regionRows = (rows || []).filter(
      (row) => normalizeCopilotRegion(row.region) === region.key
    );
    const regionUnassigned = (unassigned || []).filter((row) =>
      unassignedMatchesRegion(row, region.key)
    );
    const revenue = codeRevenue(regionRows, region.key);
    const stats = statsByRegion[region.key] || {};
    const existing = await findMonthPage(reader, id, monthLabel);
    const status = existing ? getStatus(existing.properties, STATUS_PROP) : "";
    const skipped = Boolean(existing && status === DONE && !monthExplicit);
    const schema = dryRun || skipped ? null : (await reader.databases.retrieve({ database_id: id })).properties;

    if (dryRun || skipped) {
      console.log(
        `   ${dryRun ? "(DRY_RUN) " : ""}${region.label} ${monthLabel}: Code Revenue ${revenue} ${region.currency}` +
          ` · ${statsLabel(stats)}` +
          (existing ? ` · ${status || "existing"}` : " · new page") +
          (skipped ? " · left Done" : "")
      );
      results.push({
        region: region.key,
        revenue,
        copilots: regionRows.length,
        created: !existing,
        skipped,
        dryRun,
      });
      continue;
    }

    const properties = {
      ...buildNumberUpdate(REVENUE_PROP, revenue),
      ...statProperties(schema, stats),
    };
    let pageId = existing?.id;
    if (!existing) {
      const created = await notion.pages.create({
        parent: { database_id: id },
        properties: {
          ...buildTitleUpdate(MONTH_PROP, monthLabel),
          ...properties,
          ...buildStatusUpdate(STATUS_PROP, IN_PROGRESS),
        },
      });
      pageId = created.id;
    } else {
      await notion.pages.update({ page_id: pageId, properties });
    }
    await replaceChildren(notion, pageId, reportBlocks(regionRows, regionUnassigned, region.key));
    console.log(
      `   ${region.label} ${monthLabel}: Code Revenue ${revenue} ${region.currency}` +
        ` · ${statsLabel(stats)} · ${existing ? "updated" : "created"}`
    );
    results.push({
      region: region.key,
      revenue,
      copilots: regionRows.length,
      created: !existing,
      skipped: false,
      dryRun: false,
      pageId,
    });
  }

  return results;
}
