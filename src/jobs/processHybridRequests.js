/**
 * Hybrid requests, every run.
 *
 *   DRY_RUN=1 npm run process-hybrid-requests
 *   DRY_RUN=0 npm run process-hybrid-requests -- --apply
 *
 * A request is emailed right away. Times outside Mon–Fri 7:00 AM–3:30 PM and
 * Mon–Wed from 9:00 PM get a note that they aren't available, with no page
 * link. In-window matches add a to-do per session on the request and email
 * that page. Checking a to-do (the copilot, or Shannon or Stella) creates the
 * Global Events card and tags the session Reduced. The confirmation email
 * goes out once Event Credit Link is filled, with the Brandbot checkout link
 * and the schedule link that opens that class. Local runs stay dry unless
 * --apply.
 */
import { config } from "../config.js";
import { getCopilotByAnyEmail, getCopilotByPromoCode } from "../lib/bq/copilotOps.js";
import {
  sendHybridBookedEmail,
  sendHybridRequestEmail,
} from "../lib/email/hybridEmail.js";
import { isEmailSendConfigured } from "../lib/email/gmailSend.js";
import {
  fitsGuestCount,
  formatRequestedTime,
  formatSuggestion,
  isSlotInHybridWindow,
  listSessionsOnDate,
  loadSessionMatch,
  scheduleSessionUrl,
  sessionsOverlapping,
  tagClassSession,
} from "../lib/mt/classSessionTag.js";
import {
  confirmedSessionIds,
  copilotDisplayName,
  ensureCalendarCard,
  ensureSessionChoices,
  findCreditLink,
  hybridTestCopilot,
  listHybridRequests,
  listSessionChoices,
  parseMatchLog,
  serializeMatchLog,
  updateHybridRequest,
  verifyCopilotMatch,
} from "../lib/notion/hybridRequests.js";

function hasApplyFlag(argv = process.argv) {
  return argv.includes("--apply");
}

export function isHybridDryRun({
  dryRun = config.dryRun,
  argv = process.argv,
} = {}) {
  if (dryRun) return true;
  if (hasApplyFlag(argv)) return false;
  return process.env.NODE_ENV !== "production";
}

function label(request) {
  const slot = request.slots?.[0];
  return [request.code || request.email || request.id, slot?.date, request.locations?.[0]?.name]
    .filter(Boolean)
    .join(" · ");
}

async function findSuggestions(request) {
  const seen = new Set();
  const overlaps = [];
  for (const slot of request.slots || []) {
    if (!slot.hhmmss) continue;
    for (const studio of request.locations || []) {
      const sessions = await listSessionsOnDate(studio.locationId, slot.date);
      const hits = sessionsOverlapping(sessions, {
        location: studio.name,
        date: slot.date,
        hhmmss: slot.hhmmss,
        city: studio.city,
      });
      for (const hit of hits) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        overlaps.push(hit);
      }
    }
  }
  overlaps.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const suggestions = overlaps.filter((match) => fitsGuestCount(match, request.guestCount));
  return { overlaps, suggestions };
}

async function setHold(request, hold, dryRun) {
  const who = label(request);
  if (request.hold === hold) {
    console.log(`   ${who}: still on hold — ${hold}`);
    return;
  }
  if (dryRun) {
    console.log(`   (DRY_RUN) hold ${who}: ${hold}`);
    return;
  }
  await updateHybridRequest(request.id, { hold });
  console.log(`   hold ${who}: ${hold}`);
}

function outsideSlots(request) {
  return (request.slots || []).filter((slot) => slot.hhmmss && !isSlotInHybridWindow(slot));
}

function openSlots(request) {
  return (request.slots || []).filter((slot) => isSlotInHybridWindow(slot));
}

async function copilotFor(request) {
  const testCopilot = hybridTestCopilot(request.email, request.code);
  if (testCopilot) return { copilot: testCopilot, test: true };
  const emailRow = request.email ? await getCopilotByAnyEmail(request.email) : null;
  const codeRow = request.code ? await getCopilotByPromoCode(request.code) : null;
  return {
    test: false,
    ...verifyCopilotMatch({
      emailRow,
      codeRow,
      submittedCode: request.code,
    }),
  };
}

async function offerAvailability(request, { dryRun }) {
  if (request.availabilitySent) return;
  const who = label(request);
  const outside = outsideSlots(request);
  const open = openSlots(request);
  if (!outside.length && !open.length) return;

  if (!request.email || !request.code) {
    await setHold(
      request,
      request.email ? "Missing a co-pilot code." : "Missing an email.",
      dryRun
    );
    return;
  }
  if (!request.slots.some((slot) => slot.hhmmss)) {
    console.log(`   ${who}: no time on the request — left for the next run`);
    return;
  }
  if (open.length && !request.locations.length) {
    console.log(`   ${who}: no preferred location — left for the next run`);
    if (!outside.length) return;
  }

  const verdict = await copilotFor(request);
  if (verdict.test) console.log(`   ${who}: test copilot`);
  if (verdict.hold) {
    await setHold(request, verdict.hold, dryRun);
    return;
  }

  let suggestions = [];
  if (open.length && request.locations.length) {
    const found = await findSuggestions({ ...request, slots: open });
    suggestions = found.suggestions;
    if (!suggestions.length && found.overlaps.length && request.guestCount != null) {
      console.log(
        `   ${who}: ${found.overlaps.length} overlapping session(s), none have room for ${request.guestCount}`
      );
      for (const match of found.overlaps) console.log(`     ${formatSuggestion(match)}`);
    }
  }

  const tellWindow = outside.length > 0 && !request.windowNoted;
  const tellSuggestions = suggestions.length > 0;
  if (!tellWindow && !tellSuggestions) {
    if (open.length) {
      console.log(`   ${who}: no overlapping hybrid session yet — left for the next run`);
    }
    return;
  }

  const displayName = copilotDisplayName(verdict.copilot, request.code);
  const notedOutside = tellWindow ? outside : [];
  for (const slot of notedOutside) {
    console.log(`   ${who}: outside the window — ${formatRequestedTime(slot)}`);
  }
  for (const match of suggestions) {
    console.log(`   ${who}: suggest ${formatSuggestion(match)}`);
  }

  if (dryRun) {
    const where = tellSuggestions ? ` and link ${request.url}` : "";
    console.log(`   (DRY_RUN) email ${request.email}${where}`);
    return;
  }

  if (tellSuggestions) await ensureSessionChoices(request.id, suggestions);
  await sendHybridRequestEmail({
    email: request.email,
    displayName,
    sessions: suggestions,
    guestCount: request.guestCount,
    outsideSlots: notedOutside,
    requestUrl: request.url,
  });
  const finished = tellSuggestions || open.length === 0;
  await updateHybridRequest(request.id, {
    windowNoted: true,
    ...(finished ? { availabilitySent: true } : {}),
    ...(tellSuggestions ? { matchLog: serializeMatchLog(suggestions), hold: "" } : {}),
  });
  request.windowNoted = true;
  if (finished) request.availabilitySent = true;
  if (tellSuggestions) request.matchLog = serializeMatchLog(suggestions);
  console.log(`   emailed ${request.email}`);
}

async function confirmChoice(request, sessionId, { dryRun }) {
  const who = label(request);
  const done = new Set(confirmedSessionIds(request.confirmedSession));
  if (done.has(sessionId)) return;

  const { session, match } = await loadSessionMatch(sessionId);
  const offered = parseMatchLog(request.matchLog).some((item) => item.id === sessionId);
  if (offered && !fitsGuestCount(match, request.guestCount)) {
    console.log(
      `   ${who}: ${formatSuggestion(match)} does not have room for ${request.guestCount}`
    );
    return;
  }

  const verdict = await copilotFor(request);
  if (verdict.hold) {
    await setHold(request, verdict.hold, dryRun);
    return;
  }
  const creditUrl = await findCreditLink(request.id, request.eventCreditLink);
  const scheduleUrl = scheduleSessionUrl(match);
  const displayName = copilotDisplayName(verdict.copilot, request.code);

  if (dryRun) {
    console.log(
      `   (DRY_RUN) card for ${formatSuggestion(match)}, tag Reduced, ${
        creditUrl ? `email ${request.email}` : "wait on Event Credit Link"
      }`
    );
    console.log(`   schedule ${scheduleUrl}`);
    return;
  }

  if (!request.calendarCard) {
    const card = await ensureCalendarCard({
      displayName,
      email: request.email,
      code: request.code,
      requestUrl: request.url,
      guestCount: request.guestCount,
      community: request.community,
      notes: request.notes,
      sessions: [match],
    });
    await updateHybridRequest(request.id, { calendarCard: card.url });
    request.calendarCard = card.url;
    console.log(`   hold card ${card.url}`);
  }

  const tagged = await tagClassSession(session);
  console.log(
    `   MT session ${tagged.sessionId}${tagged.alreadyTagged ? " already tagged" : " tagged Reduced"}`
  );
  await updateHybridRequest(request.id, { mtTagged: true });
  request.mtTagged = true;

  if (!creditUrl) {
    console.log(
      `   ${who}: session ${sessionId} is held. Confirmation email waits on Event Credit Link.`
    );
    return;
  }
  if (!request.email) throw new Error(`${who} is confirmed but has no email`);
  if (!scheduleUrl) throw new Error(`${who} is confirmed but session ${sessionId} has no schedule link`);

  await sendHybridBookedEmail({
    email: request.email,
    displayName,
    session: match,
    creditUrl,
    scheduleUrl,
  });
  const confirmed = [...done, sessionId].join(", ");
  await updateHybridRequest(request.id, {
    confirmedSession: confirmed,
    copilotEmailed: true,
    hold: "",
  });
  request.confirmedSession = confirmed;
  request.copilotEmailed = true;
  console.log(`   confirmation emailed to ${request.email}`);
}

async function confirmChecked(request, { dryRun }) {
  const choices = await listSessionChoices(request.id);
  const checked = choices.filter((choice) => choice.checked);
  if (!checked.length) {
    if (choices.length && !confirmedSessionIds(request.confirmedSession).length) {
      console.log(`   ${label(request)}: waiting on a checked session`);
    }
    return;
  }
  for (const choice of checked) {
    await confirmChoice(request, choice.id, { dryRun });
  }
}

async function processRequest(request, { dryRun }) {
  await offerAvailability(request, { dryRun });
  await confirmChecked(request, { dryRun });
}

export async function processHybridRequests() {
  const dryRun = isHybridDryRun();
  if (!config.notion.token) throw new Error("NOTION_TOKEN is required");
  if (!dryRun && !isEmailSendConfigured()) {
    throw new Error("Gmail is not configured — cannot email hybrid updates");
  }

  const requests = await listHybridRequests();
  console.log(
    `\n🟤 Hybrid requests: ${requests.length} row(s)${dryRun ? " (dry run)" : ""}`
  );

  let failed = 0;
  for (const request of requests) {
    try {
      await processRequest(request, { dryRun });
    } catch (error) {
      failed += 1;
      console.error(`   ❌ ${label(request)}: ${error.message}`);
    }
  }

  if (failed) {
    throw new Error(`${failed} hybrid request(s) failed`);
  }
}
