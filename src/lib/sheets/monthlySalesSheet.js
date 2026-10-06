import { config } from "../../config.js";
import { getSheetsClient } from "./evaluationSheet.js";

const SALES_TAB = "Monthly sales";
const UNASSIGNED_TAB = "2-for-1 unassigned";

const SALES_HEADERS = [
  "month",
  "region",
  "tier",
  "status",
  "first_name",
  "last_name",
  "email",
  "promo_code",
  "promo_orders",
  "promo_usd",
  "promo_cad",
  "offer_orders",
  "offer_usd",
  "offer_cad",
  "total_orders",
  "total_usd",
  "total_cad",
];

const UNASSIGNED_HEADERS = [
  "month",
  "promo_code",
  "product",
  "orders",
  "usd",
  "cad",
];

function sheetId() {
  const id = config.evaluation?.sheetId || process.env.EVALUATION_SHEET_ID;
  if (!id) throw new Error("Missing EVALUATION_SHEET_ID");
  return id;
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

function salesRow(row) {
  const promoOrders = bqNumber(row.promo_orders);
  const offerOrders = bqNumber(row.offer_orders);
  const promoUsd = bqNumber(row.promo_usd);
  const promoCad = bqNumber(row.promo_cad);
  const offerUsd = bqNumber(row.offer_usd);
  const offerCad = bqNumber(row.offer_cad);
  return [
    bqString(row.month),
    bqString(row.region),
    bqString(row.tier),
    bqString(row.status),
    bqString(row.first_name),
    bqString(row.last_name),
    bqString(row.contact_email),
    bqString(row.promo_code),
    promoOrders,
    promoUsd,
    promoCad,
    offerOrders,
    offerUsd,
    offerCad,
    promoOrders + offerOrders,
    promoUsd + offerUsd,
    promoCad + offerCad,
  ];
}

function unassignedRow(row) {
  return [
    bqString(row.month),
    bqString(row.promo_code),
    bqString(row.product),
    bqNumber(row.orders),
    bqNumber(row.usd),
    bqNumber(row.cad),
  ];
}

async function ensureTab(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = (meta.data.sheets || []).find((s) => s.properties?.title === title);
  if (found) return found.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return res.data.replies?.[0]?.addSheet?.properties?.sheetId;
}

async function writeTab(sheets, spreadsheetId, title, headers, rows) {
  const numericId = await ensureTab(sheets, spreadsheetId, title);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const props = (meta.data.sheets || []).find((s) => s.properties?.title === title)
    ?.properties;
  const grid = props?.gridProperties || {};
  const requests = [];
  if (headers.length > (grid.columnCount || 0)) {
    requests.push({
      appendDimension: {
        sheetId: numericId,
        dimension: "COLUMNS",
        length: headers.length - (grid.columnCount || 0),
      },
    });
  }
  const neededRows = rows.length + 1;
  if (neededRows > (grid.rowCount || 0)) {
    requests.push({
      appendDimension: {
        sheetId: numericId,
        dimension: "ROWS",
        length: neededRows - (grid.rowCount || 0),
      },
    });
  }
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: title,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers, ...rows] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: numericId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: numericId,
              startRowIndex: 0,
              endRowIndex: 1,
            },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
      ],
    },
  });
}

/**
 * Refresh Monthly sales and 2-for-1 unassigned on the Copilot base sheet.
 * Does not touch Review or the roster tabs.
 */
export async function writeMonthlySalesSheet({ sales, unassigned }) {
  const id = sheetId();
  const sheets = getSheetsClient();
  await writeTab(sheets, id, SALES_TAB, SALES_HEADERS, sales.map(salesRow));
  await writeTab(
    sheets,
    id,
    UNASSIGNED_TAB,
    UNASSIGNED_HEADERS,
    unassigned.map(unassignedRow)
  );
  return {
    spreadsheetId: id,
    url: `https://docs.google.com/spreadsheets/d/${id}`,
    salesRows: sales.length,
    unassignedRows: unassigned.length,
  };
}

export function salesSheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${sheetId()}`;
}
