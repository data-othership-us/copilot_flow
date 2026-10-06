import { isNycRegion } from "../copilotIdentity.js";
import {
  BRAND,
  monthlyNote,
  monthlySectionHeading,
} from "./monthlyLayout.js";

export const LEADERBOARD_TOP_N = 3;

const FONT = "'DM Sans',Helvetica,Arial,sans-serif";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailKey(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function cyclePointsValue(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "object" && value.value != null) {
    return cyclePointsValue(value.value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function lastInitial(lastName) {
  const last = String(lastName || "").trim();
  const letter = last.match(/[A-Za-z]/);
  return letter ? `${letter[0].toUpperCase()}.` : "";
}

function displayName(row) {
  const first = String(row?.first_name || "").trim();
  const initial = lastInitial(row?.last_name);
  return [first, initial].filter(Boolean).join(" ") || "Copilot";
}

function sortName(row) {
  const first = String(row?.first_name || "").trim();
  const last = String(row?.last_name || "").trim();
  return `${last} ${first}`.trim().toLowerCase();
}

/**
 * Rank live copilots in a region by last month's points (high → low).
 * Name is the tiebreaker so each rank is unique.
 */
export function rankRegionByMonthlyPoints(rows, region) {
  const wantNyc = isNycRegion(region);
  const entries = (rows || [])
    .filter((row) => isNycRegion(row.region) === wantNyc)
    .map((row) => ({
      email: emailKey(row.contact_email),
      name: displayName(row),
      sortName: sortName(row),
      points: Math.round(cyclePointsValue(row.last_month_points)),
    }))
    .filter((entry) => entry.email);

  entries.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.sortName.localeCompare(b.sortName);
  });

  return entries.map((entry, index) => ({
    email: entry.email,
    name: entry.name,
    points: entry.points,
    rank: index + 1,
  }));
}

function rowStyle(highlight) {
  const weight = highlight ? "700" : "400";
  return `padding:3px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${BRAND.eggplant};font-weight:${weight};`;
}

function renderRows(visible, recipientEmail) {
  const you = emailKey(recipientEmail);
  const lines = visible.map((entry) => {
    const highlight = Boolean(you && entry.email === you);
    const style = rowStyle(highlight);
    return [
      `<tr>`,
      `<td style="${style}width:32px;vertical-align:top;padding-right:8px;">${entry.rank}.</td>`,
      `<td style="${style}">${escapeHtml(entry.name)}</td>`,
      `</tr>`,
    ].join("");
  });
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">`,
    ...lines,
    `</table>`,
  ].join("\n");
}

export function renderLeaderboardHtml({
  rows,
  region,
  recipientEmail,
  topN = LEADERBOARD_TOP_N,
} = {}) {
  const ranked = rankRegionByMonthlyPoints(rows, region);
  if (!ranked.length) return "";

  const cutoff = Math.max(1, Number(topN) || LEADERBOARD_TOP_N);
  const visible = ranked.slice(0, cutoff);
  if (!visible.length) return "";

  const city = isNycRegion(region) ? "NYC" : "TO";
  return [
    monthlySectionHeading("The board"),
    monthlyNote(`Here's who led last month in ${city}.`),
    renderRows(visible, recipientEmail),
  ].join("\n");
}
