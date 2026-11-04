import { config } from "../../config.js";
import { getEmailSignatureHtml } from "./signature.js";
import { formatClock, formatMatchLabel, scheduleSessionUrl } from "../mt/classSessionTag.js";
import { sendCopilotEmail } from "./gmailSend.js";

const SCHEDULE_URL = "https://www.othership.us/schedule";

const STUDIO_ADDRESS = {
  Adelaide: "425 Adelaide St W, Toronto ON M5V 3C1",
  Yorkville: "110 Bloor St W, Toronto ON M5S 2W7",
  Flatiron: "23 W. 20th St, New York, NY 10011",
  Williamsburg: "25 Kent Ave Suite 100, Brooklyn, NY 11249",
};

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function greeting(displayName) {
  const first = String(displayName || "").trim().split(/\s+/)[0];
  return first && first !== "Co-Pilot" ? `Hi ${first},` : "Hi,";
}

function link(href, label) {
  const url = String(href || "").trim();
  if (!url) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function breathe() {
  return "<p>Breathe in ♾ Breathe out.</p>";
}

function close(html) {
  return [html, breathe(), getEmailSignatureHtml()].filter(Boolean).join("\n");
}

function whenLabel(slot) {
  return formatMatchLabel({ date: slot?.date, time: slot?.hhmmss || slot?.time });
}

function subjectWhen(session) {
  const [year, month, day] = String(session?.date || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const weekday = SHORT_DAYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
  const clock = formatClock(session?.time);
  return `${weekday}, ${SHORT_MONTHS[month - 1]} ${day}${clock ? `, ${clock}` : ""}`;
}

function spotLabel(session) {
  if (session?.available == null) return "";
  const n = Number(session.available);
  return `${n} ${n === 1 ? "spot" : "spots"} open`;
}

function sessionBullet(session) {
  const parts = [whenLabel(session), session.location, session.className || "Free Flow", spotLabel(session)].filter(Boolean);
  return `<li><strong>${escapeHtml(parts.join(" · "))}</strong></li>`;
}

function intro() {
  return "<p>Thanks for requesting a Co-Pilot Hybrid at Othership. A hybrid is a Free Flow session you share with your community: sauna, cold plunge, and time in the room together.</p>";
}

function availableCopy({ sessions, guestCount, requestUrl, formUrl }) {
  const many = sessions.length > 1;
  const guests = escapeHtml(String(guestCount ?? ""));
  const count =
    guestCount == null
      ? many
        ? "<p>Good news. These Free Flows are the ones we'll book your community into:</p>"
        : "<p>Good news. This is the Free Flow we'll book your community into:</p>"
      : many
        ? `<p>Good news. One session can't hold your ${guests} guests, so these Free Flows together have room:</p>`
        : `<p>Good news. This session has room for your ${guests} guests:</p>`;
  const items = sessions.map(sessionBullet).join("");
  const another = formUrl ? ` Just ${link(formUrl, "submit a new request")}.` : "";
  const holds = many ? "every session below" : "the session";
  return [
    intro(),
    count,
    `<ul>${items}</ul>`,
    "<p><strong>To confirm:</strong></p>",
    "<ol>",
    `<li>Open your ${link(requestUrl, "request page")}.</li>`,
    "<li>Check <strong>Copilot Confirm</strong>.</li>",
    "</ol>",
    `<p>That's it. Checking Copilot Confirm holds ${holds} for your community.</p>`,
    `<p>Want a different time?${another}</p>`,
    "<p>Once you confirm, we'll send you two links to share with your guests: one to buy the $35 event credit and one to book the session.</p>",
  ].join("\n");
}

function unavailableCopy({ slots, requestUrl }) {
  const times = (slots || []).map(whenLabel).filter(Boolean);
  const lead =
    times.length === 1
      ? "Unfortunately, the time you requested isn't able to accommodate your group:"
      : "Unfortunately, the times you requested aren't able to accommodate your group:";
  const items = times.map((time) => `<li><strong>${escapeHtml(time)}</strong></li>`).join("");
  return [
    intro(),
    `<p>${lead}</p>`,
    `<ul>${items}</ul>`,
    "<p><strong>Hybrids can be booked:</strong></p>",
    "<ul>",
    "<li>Monday to Friday, 7:00 AM to 3:30 PM</li>",
    "<li>Monday to Wednesday, from 9:00 PM</li>",
    "</ul>",
    "<p>Hybrids are Free Flow only (Lively or Quieter). Guided classes can't be booked as hybrids.</p>",
    `<p><strong>Next step:</strong> Check our ${link(SCHEDULE_URL, "schedule")} for a Free Flow that works for you, then ${link(requestUrl, "update your request")} with the new date and time. We'll check it again right away.</p>`,
  ].join("\n");
}

function studioLine(session) {
  const name = String(session?.location || "").trim();
  const address = STUDIO_ADDRESS[name] || "";
  const place = name ? `Othership ${name}` : "Othership";
  return address ? `${place}, ${address}` : place;
}

export async function sendHybridRequestEmail({
  email,
  displayName,
  sessions,
  guestCount,
  unavailableSlots,
  requestUrl,
  formUrl,
}) {
  const available = sessions?.length
    ? availableCopy({ sessions, guestCount, requestUrl, formUrl })
    : "";
  const unavailable = available ? "" : unavailableCopy({ slots: unavailableSlots, requestUrl });
  const html = close(
    [`<p>${escapeHtml(greeting(displayName))}</p>`, available || unavailable].filter(Boolean).join("\n"),
  );
  const subject = available
    ? "Please Confirm Your Co-Pilot Hybrid Booking"
    : "Let's Find Another Time for Your Co-Pilot Hybrid";
  return sendCopilotEmail({
    to: email,
    from: config.email.from,
    subject,
    html,
    emailKind: "copilot_hybrid_availability",
    logContext: {
      date: sessions?.[0]?.date || unavailableSlots?.[0]?.date || null,
      location: sessions?.[0]?.location || null,
    },
  });
}

export async function sendHybridBookedEmail({
  email,
  displayName,
  session,
  sessions,
  creditUrl,
  scheduleUrl,
}) {
  const list = sessions?.length ? sessions : session ? [session] : [];
  const primary = list[0] || {};
  const many = list.length > 1;
  const subjectWhenText = subjectWhen(primary);
  const place = !many && primary.location ? ` at Othership ${primary.location}` : "";
  const details = list
    .map(
      (item) =>
        [
          `<li><strong>When:</strong> ${escapeHtml(whenLabel(item))}</li>`,
          `<li><strong>Where:</strong> ${escapeHtml(studioLine(item))}</li>`,
        ].join(""),
    )
    .join("");
  const bookSteps = list
    .map((item) => {
      const bookUrl = scheduleSessionUrl(item) || (item === primary ? scheduleUrl : "");
      const label = many ? `Book ${whenLabel(item)}` : "Book this session";
      return `<li><strong>${escapeHtml(label)}</strong>: ${link(bookUrl, "booking link")}</li>`;
    })
    .join("");
  const html = close(
    [
      `<p>${escapeHtml(greeting(displayName))}</p>`,
      "<p>Your Co-Pilot Hybrid is confirmed. Feel free to forward this email to your guests. Everything they need is below.</p>",
      "<hr>",
      `<p><strong>You're invited to ${many ? "Free Flow sessions" : "a Free Flow"} at Othership</strong></p>`,
      `<p>Join ${escapeHtml(displayName || "your Co-Pilot")} and community for sauna, cold plunge, and time in the room together.</p>`,
      `<ul>${details}</ul>`,
      "<p><strong>To join, complete both steps:</strong></p>",
      "<ol>",
      `<li><strong>Buy the Community Event Credit</strong> ($35 + tax): ${link(creditUrl, "purchase link")}</li>`,
      bookSteps,
      "</ol>",
      `<p><strong style="color:#c0392b;">Both steps are needed.</strong> Buying the credit alone does not save your spot. ${many ? "These sessions are" : "This session is"} open to the public, so book ahead to make sure you get in.</p>`,
      "<p>We can't wait to welcome you to the ship.</p>",
    ].join("\n"),
  );
  return sendCopilotEmail({
    to: email,
    from: config.email.from,
    subject: `Hybrid ${many ? "sessions" : "session"} confirmed | ${subjectWhenText}${place}`,
    html,
    emailKind: "copilot_hybrid_booked",
    logContext: { date: primary.date || null, location: primary.location || null },
  });
}
