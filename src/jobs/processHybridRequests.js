/**
 * Hybrid requests, every run.
 *
 *   DRY_RUN=1 npm run process-hybrid-requests
 *   DRY_RUN=0 npm run process-hybrid-requests -- --apply
 *
 * A request is emailed right away with the Free Flow the group will be booked
 * into. One session when it has room for the guest count. When it does not,
 * the smallest set of sessions that covers the count. Checking Copilot Confirm
 * on the request creates the Global Events card and tags each session Reduced.
 * The confirmation email goes out once Event Credit Link is filled. Local runs
 * stay dry unless --apply.
 */
import { config } from "../config.js";
import {
  getCopilotByAnyEmail,
  getCopilotByPromoCode,
} from "../lib/bq/copilotOps.js";
import {
  sendHybridBookedEmail,
  sendHybridRequestEmail,
} from "../lib/email/hybridEmail.js";
import { notifyHybridDiscord } from "../lib/discord/hybridNotify.js";
import { isEmailSendConfigured } from "../lib/email/gmailSend.js";
import {
  formatRequestedTime,
  formatSuggestion,
  isHybridFreeFlow,
  isHybridWindow,
  isSlotInHybridWindow,
  listSessionsOnDate,
  loadSessionMatch,
  pickBookingPlan,
  scheduleSessionUrl,
  sessionsOnDate,
  tagClassSession,
} from "../lib/mt/classSessionTag.js";
import {
  confirmedRequestTitle,
  copilotDisplayName,
  copilotNotes,
  ensureCalendarCard,
  findCreditLink,
  hybridTestCopilot,
  listHybridRequests,
  parseLoggedSlots,
  parseMatchLog,
  serializeMatchLog,
  syncBookingNote,
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
  return [
    request.code || request.email || request.id,
    slot?.date,
    request.locations?.[0]?.name,
  ]
    .filter(Boolean)
    .join(" · ");
}

function hybridDiscordText({ title, request, displayName, sessions, extra, link }) {
  const who = [
    displayName || request.code,
    request.email,
    request.guestCount == null ? "" : `${request.guestCount} guests`,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `**${title}**`,
    "",
    who,
    ...(sessions || []).map((match) => `• ${formatSuggestion(match)}`),
    extra || "",
    link || "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function loadDay(request, slot) {
  const matches = [];
  const seen = new Set();
  for (const studio of request.locations || []) {
    const sessions = await listSessionsOnDate(studio.locationId, slot.date);
    for (const match of sessionsOnDate(sessions, {
      location: studio.name,
      date: slot.date,
      city: studio.city,
    })) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      matches.push(match);
    }
  }
  const atTime = matches.filter((match) => match.time === slot.hhmmss);
  const freeAtStart = atTime.filter(
    (match) =>
      isHybridFreeFlow(match.className) &&
      isHybridWindow({ date: match.date, hhmmss: match.time }),
  );
  const later = matches.filter(
    (match) =>
      match.time > slot.hhmmss &&
      isHybridFreeFlow(match.className) &&
      isHybridWindow({ date: match.date, hhmmss: match.time }),
  );
  return {
    anySessions: matches.length > 0,
    guidedOnly: atTime.length > 0 && freeAtStart.length === 0,
    suggestions: pickBookingPlan(freeAtStart, later, request.guestCount),
  };
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
  return (request.slots || []).filter(
    (slot) => slot.hhmmss && !isSlotInHybridWindow(slot),
  );
}

function openSlots(request) {
  return (request.slots || []).filter((slot) => isSlotInHybridWindow(slot));
}

async function copilotFor(request) {
  const testCopilot = hybridTestCopilot(request.email, request.code);
  if (testCopilot) return { copilot: testCopilot, test: true };
  const emailRow = request.email
    ? await getCopilotByAnyEmail(request.email)
    : null;
  const codeRow = request.code
    ? await getCopilotByPromoCode(request.code)
    : null;
  return {
    test: false,
    ...verifyCopilotMatch({
      emailRow,
      codeRow,
      submittedCode: request.code,
    }),
  };
}

function slotKey(slots) {
  return (slots || [])
    .map((slot) => `${slot.date || ""} ${slot.hhmmss || ""}`.trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

async function offerAvailability(request, { dryRun }) {
  if (request.availabilitySent && !request.confirmedSession && !request.copilotEmailed) {
    const logged = parseLoggedSlots(request.matchLog);
    if (logged && slotKey(logged) !== slotKey(request.slots)) {
      console.log(`   ${label(request)}: requested time changed — looking again`);
      request.availabilitySent = false;
      request.windowNoted = false;
      if (!dryRun) {
        await updateHybridRequest(request.id, {
          availabilitySent: false,
          windowNoted: false,
          copilotConfirm: false,
        });
      }
      request.copilotConfirm = false;
    }
  }
  if (request.availabilitySent) return;
  const who = label(request);
  const outside = outsideSlots(request);
  const open = openSlots(request);
  if (!outside.length && !open.length) return;

  if (!request.email || !request.code) {
    await setHold(
      request,
      request.email ? "Missing a co-pilot code." : "Missing an email.",
      dryRun,
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
  let guidedOnly = false;
  let schedulePending = false;
  const missed = [];
  if (request.locations.length) {
    for (const slot of open) {
      const day = await loadDay(request, slot);
      if (!day.anySessions) {
        schedulePending = true;
        continue;
      }
      if (day.suggestions.length) {
        suggestions = day.suggestions;
        break;
      }
      if (day.guidedOnly) {
        guidedOnly = true;
        console.log(
          `   ${who}: ${formatRequestedTime(slot)} isn't a Free Flow — hybrids are Free Flow only`,
        );
      } else if (request.guestCount != null) {
        console.log(
          `   ${who}: ${formatRequestedTime(slot)} can't hold ${request.guestCount} guests`,
        );
      }
      missed.push(slot);
    }
  }

  const tellSuggestions = suggestions.length > 0;
  const tellUnavailable =
    !tellSuggestions &&
    !schedulePending &&
    (guidedOnly || missed.length > 0 || (outside.length > 0 && !request.windowNoted));
  if (!tellSuggestions && !tellUnavailable) {
    if (schedulePending) {
      console.log(`   ${who}: no sessions on that day yet — left for the next run`);
    }
    return;
  }

  const displayName = copilotDisplayName(verdict.copilot, request.code);
  for (const slot of tellSuggestions ? [] : outside) {
    console.log(`   ${who}: outside the window — ${formatRequestedTime(slot)}`);
  }
  for (const match of suggestions) {
    console.log(`   ${who}: suggest ${formatSuggestion(match)}`);
  }

  const discordText = hybridDiscordText({
    title: tellSuggestions
      ? "Hybrid request — session offered"
      : "Hybrid request — no room at that time",
    request,
    displayName,
    sessions: suggestions,
    extra: tellSuggestions
      ? "Waiting on Copilot Confirm."
      : "Emailed them to pick another time.",
    link: request.url,
  });
  if (dryRun) {
    const where = tellSuggestions ? ` and link ${request.url}` : "";
    console.log(`   (DRY_RUN) email ${request.email}${where}`);
    await notifyHybridDiscord(discordText, { dryRun: true });
    return;
  }

  if (tellSuggestions) {
    await syncBookingNote(request.id, suggestions, request.notes);
    request.notes = copilotNotes(request.notes);
  }
  const unavailableSlots = tellSuggestions
    ? []
    : [...missed, ...outside].filter((slot, index, all) => {
        const key = `${slot.date} ${slot.hhmmss}`;
        return all.findIndex((item) => `${item.date} ${item.hhmmss}` === key) === index;
      });
  await sendHybridRequestEmail({
    email: request.email,
    displayName,
    sessions: suggestions,
    guestCount: request.guestCount,
    unavailableSlots,
    requestUrl: request.url,
    formUrl: config.hybrid.requestFormUrl,
  });
  const finished = tellSuggestions || tellUnavailable;
  const matchLog = serializeMatchLog(suggestions, request.slots);
  await updateHybridRequest(request.id, {
    windowNoted: true,
    matchLog,
    ...(finished ? { availabilitySent: true } : {}),
    ...(tellSuggestions ? { hold: "", copilotConfirm: false } : {}),
  });
  request.windowNoted = true;
  request.matchLog = matchLog;
  if (finished) request.availabilitySent = true;
  if (tellSuggestions) request.copilotConfirm = false;
  console.log(`   emailed ${request.email}`);
  await notifyHybridDiscord(discordText);
}

function defaultCreditUrl(matches) {
  const cities = [
    ...new Set((matches || []).map((match) => match.city).filter(Boolean)),
  ];
  if (cities.length !== 1) return "";
  if (cities[0] === "Toronto") return String(config.hybrid.creditUrlToronto || "").trim();
  if (cities[0] === "New York") return String(config.hybrid.creditUrlNewYork || "").trim();
  return "";
}

async function creditLinkFor(request, matches) {
  const pasted = await findCreditLink(request.id, request.eventCreditLink);
  return pasted || defaultCreditUrl(matches);
}

async function confirmPlan(request, { dryRun }) {
  const who = label(request);
  if (request.copilotEmailed) return;
  const plan = parseMatchLog(request.matchLog);
  if (!request.copilotConfirm) {
    if (plan.length && request.availabilitySent) {
      console.log(`   ${who}: waiting on Copilot Confirm`);
    }
    return;
  }
  if (!plan.length) return;

  const loaded = [];
  for (const item of plan) {
    const row = await loadSessionMatch(item.id);
    if (!isHybridFreeFlow(row.match.className)) {
      console.log(
        `   ${who}: ${row.match.className || item.id} isn't a Free Flow — hybrids are Free Flow only`,
      );
      return;
    }
    loaded.push(row);
  }
  const matches = loaded.map((row) => row.match);
  const seats = matches.reduce((sum, match) => sum + (Number(match.available) || 0), 0);
  if (request.guestCount != null && seats < request.guestCount) {
    console.log(
      `   ${who}: the offered sessions now have ${seats} spots, short of ${request.guestCount}`,
    );
    return;
  }

  const verdict = await copilotFor(request);
  if (verdict.hold) {
    await setHold(request, verdict.hold, dryRun);
    return;
  }
  const creditUrl = await creditLinkFor(request, matches);
  const displayName = copilotDisplayName(verdict.copilot, request.code);
  const missingLink = matches.find((match) => !scheduleSessionUrl(match));

  const hadCard = Boolean(request.calendarCard);
  const confirmText = (emailed) =>
    hybridDiscordText({
      title: emailed ? "Hybrid confirmed" : "Hybrid held — needs a credit link",
      request,
      displayName,
      sessions: matches,
      extra: emailed
        ? "Tagged Reduced. Confirmation email sent."
        : "Tagged Reduced. Confirmation email waits on Event Credit Link.",
      link: request.calendarCard || request.url,
    });

  if (dryRun) {
    console.log(
      `   (DRY_RUN) card for ${matches.length} session(s), tag Reduced, ${
        creditUrl ? `email ${request.email}` : "wait on Event Credit Link"
      }`,
    );
    for (const match of matches) console.log(`   schedule ${scheduleSessionUrl(match)}`);
    await notifyHybridDiscord(confirmText(Boolean(creditUrl)), { dryRun: true });
    return;
  }

  const nextTitle = confirmedRequestTitle(request.code, matches[0]);
  if (request.title && !String(request.title).includes("|") && nextTitle !== request.title) {
    if (dryRun) {
      console.log(`   (DRY_RUN) title ${nextTitle}`);
    } else {
      await updateHybridRequest(request.id, { title: nextTitle });
      request.title = nextTitle;
      console.log(`   title ${nextTitle}`);
    }
  }

  if (!request.calendarCard) {
    const card = await ensureCalendarCard({
      displayName,
      email: request.email,
      code: request.code,
      requestUrl: request.url,
      guestCount: request.guestCount,
      community: request.community,
      notes: copilotNotes(request.notes),
      sessions: matches,
    });
    await updateHybridRequest(request.id, { calendarCard: card.url });
    request.calendarCard = card.url;
    console.log(`   hold card ${card.url}`);
  }

  for (const row of loaded) {
    const tagged = await tagClassSession(row.session);
    console.log(
      `   MT session ${tagged.sessionId}${tagged.alreadyTagged ? " already tagged" : " tagged Reduced"}`,
    );
  }
  await updateHybridRequest(request.id, { mtTagged: true });
  request.mtTagged = true;

  if (!creditUrl) {
    console.log(`   ${who}: sessions are held. Confirmation email waits on a credit link.`);
    if (!hadCard) await notifyHybridDiscord(confirmText(false));
    return;
  }
  if (!request.eventCreditLink) {
    await updateHybridRequest(request.id, { eventCreditLink: creditUrl });
    request.eventCreditLink = creditUrl;
  }
  if (!request.email) throw new Error(`${who} is confirmed but has no email`);
  if (missingLink) {
    throw new Error(`${who} is confirmed but session ${missingLink.id} has no schedule link`);
  }

  await sendHybridBookedEmail({
    email: request.email,
    displayName,
    sessions: matches,
    creditUrl,
  });
  const confirmed = matches.map((match) => match.id).join(", ");
  await updateHybridRequest(request.id, {
    confirmedSession: confirmed,
    copilotEmailed: true,
    hold: "",
  });
  request.confirmedSession = confirmed;
  request.copilotEmailed = true;
  console.log(`   confirmation emailed to ${request.email}`);
  await notifyHybridDiscord(confirmText(true));
}

async function processRequest(request, { dryRun }) {
  await offerAvailability(request, { dryRun });
  await confirmPlan(request, { dryRun });
}

export async function processHybridRequests() {
  const dryRun = isHybridDryRun();
  if (!config.notion.token) throw new Error("NOTION_TOKEN is required");
  if (!dryRun && !isEmailSendConfigured()) {
    throw new Error("Gmail is not configured — cannot email hybrid updates");
  }

  const requests = await listHybridRequests();
  console.log(
    `\n🟤 Hybrid requests: ${requests.length} row(s)${dryRun ? " (dry run)" : ""}`,
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
