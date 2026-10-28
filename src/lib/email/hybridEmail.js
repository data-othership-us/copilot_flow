import { config } from "../../config.js";
import {
  formatMatchLabel,
  formatRequestedTime,
  formatSuggestion,
  scheduleSessionUrl,
} from "../mt/classSessionTag.js";
import { sendCopilotEmail } from "./gmailSend.js";

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

function outsideCopy(slots) {
  const times = (slots || []).map((slot) => formatRequestedTime(slot)).filter(Boolean);
  if (!times.length) return "";
  const listed = times.map((time) => `<li>${escapeHtml(time)}</li>`).join("");
  return [
    `<p>${times.length === 1 ? "This time isn't" : "These times aren't"} available right now:</p>`,
    `<ul>${listed}</ul>`,
    "<p>If you're willing to wait, reply to this email and we'll look for a session that works.</p>",
  ].join("\n");
}

function suggestionCopy(sessions, guestCount, requestUrl) {
  if (!sessions?.length || !requestUrl) return "";
  const count =
    guestCount == null
      ? "<p>There was no guest count on the request, so this is every session that overlaps a time inside the hybrid window.</p>"
      : `<p>These have room for your ${escapeHtml(String(guestCount))} guests:</p>`;
  const items = sessions
    .map((session) => `<li>${escapeHtml(formatSuggestion(session))}</li>`)
    .join("");
  return [
    "<p>These sessions match the time you asked for:</p>",
    count,
    `<ul>${items}</ul>`,
    `<p><a href="${escapeHtml(requestUrl)}">Open your request</a> and check the session you want.</p>`,
    "<p>That creates the hold. We'll email you the link for your community to buy the $35 event credit, and the link to book that class. If you can't check the box, reply and Shannon or Stella will check the session that works.</p>",
  ].join("\n");
}

export async function sendHybridRequestEmail({
  email,
  displayName,
  sessions,
  guestCount,
  outsideSlots,
  requestUrl,
}) {
  const pageUrl = sessions?.length ? requestUrl : "";
  const outside = outsideCopy(outsideSlots);
  const suggestions = suggestionCopy(sessions, guestCount, pageUrl);
  const html = [`<p>${escapeHtml(greeting(displayName))}</p>`, outside, suggestions]
    .filter(Boolean)
    .join("\n");
  const subject = sessions?.length
    ? "Hybrid sessions that match your request"
    : "Hybrid time isn't available right now";
  return sendCopilotEmail({
    to: email,
    from: config.email.from,
    subject,
    html,
    emailKind: "copilot_hybrid_availability",
    logContext: {
      date: sessions?.[0]?.date || outsideSlots?.[0]?.date || null,
      location: sessions?.[0]?.location || null,
    },
  });
}

export async function sendHybridBookedEmail({
  email,
  displayName,
  session,
  creditUrl,
  scheduleUrl,
}) {
  const bookUrl = scheduleUrl || scheduleSessionUrl(session?.id);
  const html = [
    `<p>${escapeHtml(greeting(displayName))}</p>`,
    "<p>Your hybrid is confirmed:</p>",
    `<ul><li>${escapeHtml(formatMatchLabel(session))}</li></ul>`,
    "<p>Your community reserves a spot in two steps. Purchasing the event credit does not book them in.</p>",
    "<ol>",
    `<li>Buy the $35 + tax Community Event Credit: <a href="${escapeHtml(creditUrl)}">purchase the event credit</a>.</li>`,
    `<li>Book themselves into this session: <a href="${escapeHtml(bookUrl)}">book this class</a>. The credit does not hold a spot. Each guest still has to book this class.</li>`,
    "</ol>",
    "<p>Share both links. A guest who only buys the credit will not be in the session until they book it.</p>",
  ].join("\n");
  return sendCopilotEmail({
    to: email,
    from: config.email.from,
    subject: "Your hybrid is confirmed",
    html,
    emailKind: "copilot_hybrid_booked",
    logContext: { date: session?.date || null, location: session?.location || null },
  });
}
