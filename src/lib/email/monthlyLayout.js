/** Othership brand colors for the monthly Co-Pilot email. */
export const BRAND = {
  eggplant: "#372338",
  cloud: "#ECE8E3",
  rust: "#A24E2B",
  lemon: "#DBF572",
  orchid: "#CB72C4",
  teal: "#A7CFC9",
  moss: "#707967",
};

const FONT = "'DM Sans',Helvetica,Arial,sans-serif";

export const MONTHLY_INK = BRAND.eggplant;

export function monthlySectionHeading(title) {
  const label = String(title || "").trim();
  if (!label) return "";
  return [
    `<p style="margin:22px 0 8px;font-family:${FONT};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:${BRAND.rust};">${label}</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px;"><tr><td style="border-top:1px solid ${BRAND.cloud};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`,
  ].join("\n");
}

export function monthlyLocationHeading(location) {
  return `<p style="margin:14px 0 4px;font-family:${FONT};font-size:13px;font-weight:700;color:${BRAND.eggplant};">${location}</p>`;
}

export function monthlyEventLine(html) {
  return `<p style="margin:0 0 6px;font-family:${FONT};font-size:14px;line-height:1.4;color:${BRAND.eggplant};">${html}</p>`;
}

export function monthlyNote(html) {
  return `<p style="margin:0 0 10px;font-family:${FONT};font-size:13px;line-height:1.45;color:${BRAND.eggplant};">${html}</p>`;
}

export function monthlyLink(href, label) {
  return `<a href="${href}" style="color:${BRAND.rust};text-decoration:underline;">${label}</a>`;
}
