/**
 * Monthly Co-Pilot promo-code sales.
 *
 *   npm run report-monthly-sales
 *   MONTH=2026-09 npm run report-monthly-sales
 *   MONTH=2026-09 REGION=NYC npm run report-monthly-sales
 *
 * Default month is the previous complete Eastern calendar month.
 * Prints pretax order totals (excluding tax) for roster promo codes and
 * Co-Pilot 2-for-1 offers, then refreshes the Monthly sales tab on Copilot base.
 */
import { refreshCopilotUtmSessions } from "../lib/bq/copilotDb.js";
import {
  applyMonthlyPromoSalesView,
  listMonthlyPromoSales,
  listPromoSalesHistory,
  listUnassignedIntroOffers,
  listUnmatchedCopilotDiscounts,
} from "../lib/bq/monthlyPromoSales.js";
import { normalizeCopilotRegion } from "../lib/copilotIdentity.js";
import {
  salesSheetUrl,
  writeMonthlySalesSheet,
} from "../lib/sheets/monthlySalesSheet.js";

function easternYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function previousCompleteMonth(today = easternYmd()) {
  const [year, month] = today.slice(0, 7).split("-").map(Number);
  const prev = new Date(Date.UTC(year, month - 2, 1, 12));
  return prev.toISOString().slice(0, 7);
}

export function resolveReportMonth(monthKey, { today = easternYmd() } = {}) {
  const key = String(monthKey || previousCompleteMonth(today)).trim();
  const match = key.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error(`Invalid MONTH (use YYYY-MM): ${monthKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid MONTH (use YYYY-MM): ${monthKey}`);
  }
  const start = new Date(Date.UTC(year, month - 1, 1, 12));
  return {
    monthKey: key,
    monthStart: start.toISOString().slice(0, 10),
    monthLabel: start.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
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

function money(value) {
  return bqNumber(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function personName(row) {
  return [bqString(row.first_name), bqString(row.last_name)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

function sumField(rows, field) {
  return rows.reduce((total, row) => total + bqNumber(row[field]), 0);
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function rowOrders(row) {
  return bqNumber(row.promo_orders) + bqNumber(row.offer_orders);
}

function rowUsd(row) {
  return bqNumber(row.promo_usd) + bqNumber(row.offer_usd);
}

function rowCad(row) {
  return bqNumber(row.promo_cad) + bqNumber(row.offer_cad);
}

function printDetail(rows) {
  const prepared = rows.map((row) => ({
    name: personName(row) || bqString(row.contact_email),
    code: bqString(row.promo_code),
    region: bqString(row.region),
    tier: bqString(row.tier),
    promo: String(bqNumber(row.promo_orders)),
    offer: String(bqNumber(row.offer_orders)),
    usd: money(rowUsd(row)),
    cad: money(rowCad(row)),
  }));
  const widths = {
    name: Math.max(4, ...prepared.map((row) => row.name.length)),
    code: Math.max(4, ...prepared.map((row) => row.code.length)),
    region: 6,
    tier: Math.max(4, ...prepared.map((row) => row.tier.length)),
  };
  const header = [
    pad("Name", widths.name),
    pad("Code", widths.code),
    pad("Region", widths.region),
    pad("Tier", widths.tier),
    padLeft("Promo", 5),
    padLeft("2for1", 5),
    padLeft("USD", 12),
    padLeft("CAD", 12),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of prepared) {
    console.log(
      [
        pad(row.name, widths.name),
        pad(row.code, widths.code),
        pad(row.region, widths.region),
        pad(row.tier, widths.tier),
        padLeft(row.promo, 5),
        padLeft(row.offer, 5),
        padLeft(row.usd, 12),
        padLeft(row.cad, 12),
      ].join("  ")
    );
  }
}

function printRegions(rows) {
  const byRegion = new Map();
  for (const row of rows) {
    const region = bqString(row.region) || "(none)";
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(row);
  }
  for (const [region, group] of byRegion) {
    console.log(
      `  ${region.padEnd(6)} ${String(group.length).padStart(3)} copilots   ${String(
        group.reduce((total, row) => total + rowOrders(row), 0)
      ).padStart(4)} orders   USD ${money(
        group.reduce((total, row) => total + rowUsd(row), 0)
      )}   CAD ${money(group.reduce((total, row) => total + rowCad(row), 0))}`
    );
  }
}

function printUnmatched(rows) {
  if (!rows.length) {
    console.log("None.");
    return;
  }
  for (const row of rows) {
    const orders = bqNumber(row.orders);
    console.log(
      `  ${bqString(row.promo_code).padEnd(16)} ${String(orders).padStart(3)} ${
        orders === 1 ? "order " : "orders"
      }   USD ${money(row.usd)}   CAD ${money(row.cad)}   ${bqString(row.discount_name)}`
    );
  }
}

export async function reportMonthlyPromoSales({
  monthKey = process.env.MONTH,
  region = process.env.REGION,
} = {}) {
  const report = resolveReportMonth(monthKey);
  const regionFilter = String(region || "").trim();
  const regionKey = regionFilter ? normalizeCopilotRegion(regionFilter) : null;

  console.log(`Co-Pilot sales — ${report.monthLabel}`);
  console.log(
    "Pretax order total, excluding tax. Completed orders only; refunds left out."
  );
  if (regionKey) console.log(`Region: ${regionKey}`);
  console.log("");
  console.log("Refreshing offer-link sessions…");
  await refreshCopilotUtmSessions();
  console.log("Refreshing copilot_monthly_promo_sales…");
  await applyMonthlyPromoSalesView();

  let rows = await listMonthlyPromoSales(report.monthStart);
  if (regionKey) {
    rows = rows.filter((row) => normalizeCopilotRegion(row.region) === regionKey);
  }
  const unassigned = regionKey
    ? []
    : await listUnassignedIntroOffers(report.monthStart);
  const unmatched = regionKey ? [] : await listUnmatchedCopilotDiscounts(report.monthStart);

  const promoOrders = sumField(rows, "promo_orders");
  const offerOnRoster = sumField(rows, "offer_orders");
  const offerUnassigned = unassigned.reduce(
    (total, row) => total + bqNumber(row.orders),
    0
  );
  const promoUsd = sumField(rows, "promo_usd");
  const promoCad = sumField(rows, "promo_cad");
  const offerUsd =
    sumField(rows, "offer_usd") +
    unassigned.reduce((total, row) => total + bqNumber(row.usd), 0);
  const offerCad =
    sumField(rows, "offer_cad") +
    unassigned.reduce((total, row) => total + bqNumber(row.cad), 0);

  console.log("");
  console.log(
    `Promo codes   ${promoOrders} orders   USD ${money(promoUsd)}   CAD ${money(promoCad)}`
  );
  console.log(
    `2-for-1       ${offerOnRoster + offerUnassigned} orders   USD ${money(offerUsd)}   CAD ${money(offerCad)}`
  );
  console.log(`  tied to a copilot   ${offerOnRoster}`);
  console.log(`  not tied to a code  ${offerUnassigned}`);
  console.log(
    `Total         ${promoOrders + offerOnRoster + offerUnassigned} orders   USD ${money(
      promoUsd + offerUsd
    )}   CAD ${money(promoCad + offerCad)}`
  );

  if (rows.length) {
    console.log("");
    console.log("By region");
    printRegions(rows);
    console.log("");
    console.log("By copilot");
    printDetail(rows);
  } else {
    console.log("");
    console.log("No roster sales in this month.");
  }

  if (!regionKey) {
    console.log("");
    console.log("Copilot-like discounts not on the roster");
    printUnmatched(unmatched);
    if (unassigned.length) {
      console.log("");
      console.log("2-for-1 orders not tied to a copilot");
      printUnmatched(
        unassigned.map((row) => ({
          promo_code: row.promo_code || "(no code)",
          orders: row.orders,
          usd: row.usd,
          cad: row.cad,
          discount_name: row.product,
        }))
      );
    }
  }

  console.log("");
  console.log("Writing Copilot base…");
  const history = await listPromoSalesHistory();
  const unassignedHistory = await listUnassignedIntroOffers();
  const written = await writeMonthlySalesSheet({
    sales: history,
    unassigned: unassignedHistory,
  });
  console.log(
    `Monthly sales tab: ${written.salesRows} copilot-months · ${salesSheetUrl()}`
  );

  return {
    month: report.monthKey,
    copilots: rows.length,
    orders: promoOrders + offerOnRoster + offerUnassigned,
    usd: promoUsd + offerUsd,
    cad: promoCad + offerCad,
    unmatched: unmatched.length,
    sheetUrl: salesSheetUrl(),
  };
}
