import { Client } from "@notionhq/client";
import { config } from "../../config.js";
import {
  buildCheckboxUpdate,
  buildDateUpdate,
  buildEmailUpdate,
  buildNumberUpdate,
  buildRichTextUpdate,
  buildSelectUpdate,
  buildStatusUpdate,
  buildTitleUpdate,
  getCheckbox,
  getDateStart,
  getEmail,
  getNumber,
  getPhone,
  getRichText,
  getSelect,
  getStatus,
  getTitle,
  getTiktokHandle,
  getMultiSelectNames,
  getFilesCount,
  getUrl,
  getQualificationIcon,
  splitName,
  composeDisplayName,
  normalizePersonName,
} from "./parseProps.js";
import { splitIgIdentity } from "../instagram.js";

let client;

export function getNotionClient() {
  if (!client) {
    client = new Client({
      auth: config.notion.token,
      notionVersion: config.notion.version,
    });
  }
  return client;
}

/**
 * @returns {AsyncGenerator<object>}
 */
export async function* queryApplicationsByStatus(statusName, { editedOnOrAfter } = {}) {
  const notion = getNotionClient();
  const databaseId = config.notion.applicationsDatabaseId;
  const statusProp = config.notion.props.status;
  const statusFilter = {
    property: statusProp,
    status: { equals: statusName },
  };
  const filter = editedOnOrAfter
    ? {
        and: [
          statusFilter,
          {
            timestamp: "last_edited_time",
            last_edited_time: { on_or_after: editedOnOrAfter },
          },
        ],
      }
    : statusFilter;

  let startCursor;
  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: startCursor,
      filter,
    });

    for (const page of response.results) {
      if (page.object === "page") yield page;
    }

    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);
}

/**
 * All application pages (any status) — used for BQ backfill.
 * @returns {AsyncGenerator<object>}
 */
export async function* queryAllApplications() {
  const notion = getNotionClient();
  const databaseId = config.notion.applicationsDatabaseId;

  let startCursor;
  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: startCursor,
    });

    for (const page of response.results) {
      if (page.object === "page") yield page;
    }

    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);
}

/**
 * @returns {Promise<object[]>}
 */
export async function listAllApplications() {
  const out = [];
  for await (const page of queryAllApplications()) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

export function parseApplicationPage(page) {
  const props = page.properties ?? {};
  const p = config.notion.props;

  const fullNameFromTitle = getTitle(props, p.name);
  const firstFromProp = p.firstName ? getRichText(props, p.firstName) : "";
  const lastFromProp = p.lastName ? getRichText(props, p.lastName) : "";
  const split = splitName(fullNameFromTitle);
  const normalized = normalizePersonName(
    firstFromProp || split.firstName,
    lastFromProp || split.lastName
  );
  const firstName = normalized.firstName;
  const lastName = normalized.lastName;
  const fullName =
    composeDisplayName(firstName, lastName) || fullNameFromTitle;

  const igRaw = getUrl(props, p.instagramHandle) || getRichText(props, p.instagramHandle);
  const ig = splitIgIdentity(igRaw);
  const igFollowers = getNumber(props, p.instagramFollowing);

  return {
    notionPageId: page.id,
    notionUrl: page.url,
    createdTime: page.created_time || null,
    fullName,
    firstName,
    lastName,
    email: getEmail(props, p.email).toLowerCase(),
    phone: getPhone(props, p.phone),
    region: getSelect(props, p.region),
    status: getStatus(props, p.status),
    submittedAt: getDateStart(props, p.submitted),
    igHandle: ig.handle || "",
    igUrl: ig.url || "",
    igFollowers,
    /** @deprecated prefer igHandle */
    instagramHandle: ig.handle || "",
    /** @deprecated prefer igFollowers */
    instagramFollowersForm: igFollowers,
    tiktokHandle: p.tiktokHandle ? getTiktokHandle(props, p.tiktokHandle) : "",
    tiktokFollowers: p.tiktokFollowing
      ? getNumber(props, p.tiktokFollowing)
      : null,
    otherChannels: buildOtherChannels(props, p),
    neverConsider: p.neverConsider
      ? getCheckbox(props, p.neverConsider)
      : false,
    needsNudge: p.needsNudge ? getCheckbox(props, p.needsNudge) : false,
    nudgeReason: p.nudgeReason ? getRichText(props, p.nudgeReason) : "",
    lastNudged: p.lastNudged ? getDateStart(props, p.lastNudged) : null,
    creditApplied: p.creditApplied ? getCheckbox(props, p.creditApplied) : false,
    reOnboard: p.reonboard ? getSelect(props, p.reonboard) : "",
  };
}

/**
 * Sparse bag of non-IG / non-TikTok channel fields from Notion.
 * Stored as JSON object on copilot_applicants.other_channels.
 */
export function buildOtherChannels(props, p = config.notion.props) {
  const out = {};
  const put = (key, value) => {
    if (value == null) return;
    if (typeof value === "string" && !value.trim()) return;
    if (typeof value === "number" && !Number.isFinite(value)) return;
    if (Array.isArray(value) && !value.length) return;
    out[key] = value;
  };

  if (p.tiktokLink) put("tiktok_link", getUrl(props, p.tiktokLink) || null);
  if (p.youtubeLink) put("youtube_link", getUrl(props, p.youtubeLink) || null);
  if (p.youtubeSubscribers) {
    put("youtube_subscribers", getNumber(props, p.youtubeSubscribers));
  }
  if (p.linkedinLink) {
    put("linkedin_link", getUrl(props, p.linkedinLink) || null);
  }
  if (p.linkedinFollowing) {
    put("linkedin_following", getNumber(props, p.linkedinFollowing));
  }
  if (p.twitterHandle) {
    const handle =
      getRichText(props, p.twitterHandle) || getUrl(props, p.twitterHandle);
    put("twitter_handle", handle || null);
  }
  if (p.twitterFollowing) {
    put("twitter_following", getNumber(props, p.twitterFollowing));
  }
  if (p.blogLink) put("blog_link", getUrl(props, p.blogLink) || null);
  if (p.blogSubscribers) {
    put("blog_subscribers", getNumber(props, p.blogSubscribers));
  }
  if (p.contentTopics) {
    const topics = getMultiSelectNames(props, p.contentTopics);
    if (topics.length) put("content_topics", topics);
  }
  if (p.mediaKit) {
    const n = getFilesCount(props, p.mediaKit);
    if (n > 0) put("media_kit_files", n);
  }

  return Object.keys(out).length ? out : null;
}

/** Newest first by Submitted, then created_time. */
export function compareApplicationsNewestFirst(a, b) {
  const ta = a.submittedAt ? Date.parse(a.submittedAt) : 0;
  const tb = b.submittedAt ? Date.parse(b.submittedAt) : 0;
  if (Number.isFinite(tb) && Number.isFinite(ta) && tb !== ta) return tb - ta;
  const ca = a.createdTime ? Date.parse(a.createdTime) : 0;
  const cb = b.createdTime ? Date.parse(b.createdTime) : 0;
  return cb - ca;
}

/**
 * Among No Status apps, keep newest per email for evaluation; rest are dupes.
 * @returns {{ toEvaluate: object[], toReject: object[] }}
 */
export function partitionNewestByEmail(applications) {
  const byEmail = new Map();
  const noEmail = [];

  for (const app of applications) {
    if (!app.email) {
      noEmail.push(app);
      continue;
    }
    const list = byEmail.get(app.email) || [];
    list.push(app);
    byEmail.set(app.email, list);
  }

  const toEvaluate = [...noEmail];
  const toReject = [];

  for (const group of byEmail.values()) {
    group.sort(compareApplicationsNewestFirst);
    toEvaluate.push(group[0]);
    toReject.push(...group.slice(1));
  }

  return { toEvaluate, toReject };
}

/**
 * @returns {Promise<object[]>}
 */
export async function listApplicationsByEmail(email) {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return [];

  const notion = getNotionClient();
  const databaseId = config.notion.applicationsDatabaseId;
  const emailProp = config.notion.props.email;
  const out = [];
  let startCursor;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: startCursor,
      filter: {
        property: emailProp,
        email: { equals: normalized },
      },
    });

    for (const page of response.results) {
      if (page.object === "page") out.push(parseApplicationPage(page));
    }

    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);

  return out;
}

/**
 * Mark a card Duplicate with a page comment. No rejection email/credit.
 */
async function setDuplicateStatusWithComment(pageId, comment) {
  const notion = getNotionClient();
  const p = config.notion.props;
  await notion.pages.update({
    page_id: pageId,
    properties: {
      ...buildStatusUpdate(p.status, config.notion.status.duplicate),
    },
  });
  await notion.comments.create({
    parent: { page_id: pageId },
    rich_text: [{ type: "text", text: { content: comment } }],
  });
}

/**
 * Mark an older duplicate and leave a page comment.
 * Uses Duplicate (not Rejected) so they never get the rejection email/credit.
 */
export async function markDuplicateApplication(pageId, newestApp) {
  const newestLabel =
    [newestApp.firstName, newestApp.lastName].filter(Boolean).join(" ") ||
    newestApp.email ||
    "newer application";
  await setDuplicateStatusWithComment(
    pageId,
    `Duplicate found — keeping newest application (${newestLabel}) for evaluation. This older application was moved to Duplicate.`
  );
}

/**
 * If this email already has an Onboarded card, move extra No Status /
 * Evaluated / Accepted cards to Duplicate. Leaves the Onboarded card alone.
 * @returns {Promise<string[]>} marked Notion page ids
 */
export async function markExtraApplicationsWhenOnboardedExists(
  email,
  { dryRun = false } = {}
) {
  if (!email) return [];

  const siblings = await listApplicationsByEmail(email);
  const onboarded = config.notion.status.onboarded || "Onboarded";
  const skipStatuses = new Set([
    onboarded,
    config.notion.status.duplicate,
    config.notion.status.rejected,
    config.notion.status.rejectedContacted || "Rejected - Contacted",
  ]);

  if (!siblings.some((s) => s.status === onboarded)) return [];

  const comment =
    "Already an active Co-Pilot — this extra application was moved to Duplicate. The existing Onboarded card was left as-is.";

  const markedIds = [];
  for (const sib of siblings) {
    if (skipStatuses.has(sib.status)) continue;
    if (dryRun) {
      console.log(
        `   (DRY_RUN: would mark extra application Duplicate ${sib.fullName || sib.email} [${sib.status}])`
      );
      markedIds.push(sib.notionPageId);
      continue;
    }
    await setDuplicateStatusWithComment(sib.notionPageId, comment);
    console.log(
      `   🗑️  Extra application → Duplicate: ${sib.fullName || sib.email} (was ${sib.status})`
    );
    markedIds.push(sib.notionPageId);
  }
  return markedIds;
}

/**
 * Mark every other Notion row with the same email that is older than newestApp
 * (skips already-Duplicate / Rejected / accept-onboard pipeline).
 * @returns {Promise<string[]>} marked Notion page ids
 */
export async function markOlderDuplicatesForEmail(newestApp) {
  if (!newestApp?.email) return [];

  const siblings = await listApplicationsByEmail(newestApp.email);
  const skipStatuses = new Set([
    config.notion.status.duplicate,
    config.notion.status.rejected,
    config.notion.status.rejectedContacted || "Rejected - Contacted",
    // Never auto-reject anyone already in the accept/onboard pipeline
    config.notion.status.accepted,
    config.notion.status.acceptedContacted || "Accepted - Contacted",
    config.notion.status.onboarded || "Onboarded",
  ]);

  const markedIds = [];
  for (const sib of siblings) {
    if (sib.notionPageId === newestApp.notionPageId) continue;
    if (skipStatuses.has(sib.status)) continue;
    // Only mark if sibling is older (or same-age but different page)
    if (compareApplicationsNewestFirst(sib, newestApp) < 0) {
      // sib is newer than newestApp — shouldn't mark
      continue;
    }
    if (config.dryRun) {
      console.log(
        `   (DRY_RUN: would mark duplicate ${sib.fullName || sib.email} [${sib.status}])`
      );
      markedIds.push(sib.notionPageId);
      continue;
    }
    await markDuplicateApplication(sib.notionPageId, newestApp);
    console.log(
      `   🗑️  Marked duplicate: ${sib.fullName || sib.email} (was ${sib.status})`
    );
    markedIds.push(sib.notionPageId);
  }
  return markedIds;
}

function withinLookback(submittedAt) {
  const days = config.applicationLookbackDays;
  if (!days || days <= 0 || !submittedAt) return true;
  const start = new Date(submittedAt);
  if (Number.isNaN(start.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return start >= cutoff;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listNewApplications() {
  const out = [];
  for await (const page of queryApplicationsByStatus(config.notion.status.new)) {
    const app = parseApplicationPage(page);
    if (withinLookback(app.submittedAt)) out.push(app);
  }
  return out;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listEvaluatedApplications() {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.evaluated
  )) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listDuplicateApplications() {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.duplicate
  )) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listAcceptedApplications() {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.accepted
  )) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

/**
 * Onboarded cards, optionally only those edited on/after an ISO date (YYYY-MM-DD).
 * Used to catch mistaken manual Onboarded moves without scanning the full history.
 * @param {{ editedOnOrAfter?: string }} [options]
 * @returns {Promise<object[]>}
 */
export async function listOnboardedApplications({ editedOnOrAfter } = {}) {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.onboarded,
    { editedOnOrAfter }
  )) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

/**
 * Rejected rows that still need rejection email (+ first credit attempt).
 * @returns {Promise<object[]>}
 */
export async function listRejectedApplications() {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.rejected
  )) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

/**
 * Rejected - Contacted rows still waiting on MT account for thank-you credit.
 * @returns {Promise<object[]>}
 */
export async function listRejectedContactedPendingCredit() {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.rejectedContacted || "Rejected - Contacted"
  )) {
    const app = parseApplicationPage(page);
    if (!app.creditApplied) out.push(app);
  }
  return out;
}

/**
 * All Rejected - Contacted applications (for status sync).
 * @returns {Promise<object[]>}
 */
export async function listRejectedContactedApplications() {
  const out = [];
  for await (const page of queryApplicationsByStatus(
    config.notion.status.rejectedContacted || "Rejected - Contacted"
  )) {
    out.push(parseApplicationPage(page));
  }
  return out;
}

/**
 * After rejection email: move to Rejected - Contacted; optionally mark credit.
 */
export async function markRejectedContacted(pageId, { creditApplied = false, mt } = {}) {
  const p = config.notion.props;
  const properties = {
    ...buildStatusUpdate(
      p.status,
      config.notion.status.rejectedContacted || "Rejected - Contacted"
    ),
  };
  if (p.creditApplied) {
    Object.assign(properties, buildCheckboxUpdate(p.creditApplied, creditApplied));
  }
  assignMtWriteback(properties, mt);

  const notion = getNotionClient();
  await notion.pages.update({ page_id: pageId, properties });
}

export async function markCreditApplied(pageId, { mt } = {}) {
  const p = config.notion.props;
  const properties = {};
  if (p.creditApplied) {
    Object.assign(properties, buildCheckboxUpdate(p.creditApplied, true));
  }
  assignMtWriteback(properties, mt);
  if (!Object.keys(properties).length) return;

  const notion = getNotionClient();
  await notion.pages.update({ page_id: pageId, properties });
}

/** Page icon after an onboarding nudge email is sent. */
const NUDGE_SENT_ICON = "📤";

/**
 * Mark Accepted applicant as needing an onboarding nudge (MT/CC blockers).
 * When `nudgedAt` is set (email actually sent), the page icon becomes 📤.
 */
export async function writeOnboardingNudgeToNotion(pageId, { reason, mt, nudgedAt }) {
  const p = config.notion.props;
  const properties = {};

  if (p.needsNudge) {
    Object.assign(properties, buildCheckboxUpdate(p.needsNudge, true));
  }
  if (p.nudgeReason && reason) {
    Object.assign(properties, buildRichTextUpdate(p.nudgeReason, reason));
  }
  if (p.lastNudged && nudgedAt) {
    Object.assign(properties, buildDateUpdate(p.lastNudged, nudgedAt));
  }

  assignMtWriteback(properties, mt);

  const update = { page_id: pageId, properties };
  if (nudgedAt) {
    update.icon = { type: "emoji", emoji: NUDGE_SENT_ICON };
  }

  if (!Object.keys(properties).length && !update.icon) return;

  const notion = getNotionClient();
  await notion.pages.update(update);
}

/**
 * Clear nudge flags once MT + CC are ready (before promote / onboard).
 */
export async function clearOnboardingNudgeInNotion(pageId, { mt } = {}) {
  const p = config.notion.props;
  const properties = {};

  if (p.needsNudge) {
    Object.assign(properties, buildCheckboxUpdate(p.needsNudge, false));
  }
  if (p.nudgeReason) {
    properties[p.nudgeReason] = { rich_text: [] };
  }

  assignMtWriteback(properties, mt);

  if (!Object.keys(properties).length) return;

  const notion = getNotionClient();
  await notion.pages.update({ page_id: pageId, properties });
}

/**
 * Clear post-evaluate "advanced" Notion fields after a card is moved backward
 * (e.g. Accepted/Rejected → Evaluated).
 */
export async function clearAdvancedStepsInNotion(pageId) {
  const p = config.notion.props;
  const properties = {};

  if (p.needsNudge) {
    Object.assign(properties, buildCheckboxUpdate(p.needsNudge, false));
  }
  if (p.nudgeReason) {
    properties[p.nudgeReason] = { rich_text: [] };
  }
  if (p.lastNudged) {
    properties[p.lastNudged] = { date: null };
  }
  if (p.creditApplied) {
    Object.assign(properties, buildCheckboxUpdate(p.creditApplied, false));
  }

  if (!Object.keys(properties).length) return;

  const notion = getNotionClient();
  await notion.pages.update({ page_id: pageId, properties });
}

function assignMtWriteback(properties, mt) {
  if (!mt) return;
  const p = config.notion.props;
  if (p.mtClassCount && mt.mtClassCount != null) {
    Object.assign(properties, buildNumberUpdate(p.mtClassCount, mt.mtClassCount));
  }
  if (p.mtEmail && mt.mtEmail) {
    Object.assign(properties, buildEmailUpdate(p.mtEmail, mt.mtEmail));
  }
  if (p.mtHasCc && mt.mtHasCc != null) {
    Object.assign(properties, buildCheckboxUpdate(p.mtHasCc, mt.mtHasCc));
  }
  if (p.mtHomeStudio && mt.mtHomeStudio) {
    Object.assign(
      properties,
      buildRichTextUpdate(p.mtHomeStudio, mt.mtHomeStudio)
    );
  }
}

/**
 * Write enrichment fields back to Notion (only properties configured in env).
 * @param {string} pageId
 * @param {object} enrichment
 * @param {{ setStatus?: boolean, statusName?: string }} [options]
 *   setStatus false → leave Notion Status unchanged (e.g. Accepted refresh)
 */
export async function writeEnrichmentToNotion(pageId, enrichment, options = {}) {
  const p = config.notion.props;
  const setStatus = options.setStatus !== false;
  const statusName =
    options.statusName ?? config.notion.status.evaluated;
  const properties = {};
  if (setStatus) {
    Object.assign(properties, buildStatusUpdate(p.status, statusName));
  }

  const pageName = composeDisplayName(
    enrichment.firstName,
    enrichment.lastName
  );
  if (pageName) {
    Object.assign(properties, buildTitleUpdate(p.name, pageName));
  }

  if (p.previousApplication) {
    Object.assign(
      properties,
      buildCheckboxUpdate(p.previousApplication, enrichment.previousApplication)
    );
  }
  if (p.neverConsider && enrichment.neverConsider !== undefined) {
    Object.assign(
      properties,
      buildCheckboxUpdate(p.neverConsider, enrichment.neverConsider)
    );
  }
  if (p.mtClassCount && enrichment.mtClassCount != null) {
    Object.assign(
      properties,
      buildNumberUpdate(p.mtClassCount, enrichment.mtClassCount)
    );
  }
  if (p.mtEmail && enrichment.mtEmail) {
    Object.assign(properties, buildEmailUpdate(p.mtEmail, enrichment.mtEmail));
  }
  if (p.mtHasCc && enrichment.mtHasCc != null) {
    Object.assign(
      properties,
      buildCheckboxUpdate(p.mtHasCc, enrichment.mtHasCc)
    );
  }
  if (p.mtHomeStudio && enrichment.mtHomeStudio) {
    Object.assign(
      properties,
      buildRichTextUpdate(p.mtHomeStudio, enrichment.mtHomeStudio)
    );
  }
  if (
    p.instagramFollowersScraped &&
    enrichment.instagramFollowersScraped != null
  ) {
    Object.assign(
      properties,
      buildNumberUpdate(
        p.instagramFollowersScraped,
        enrichment.instagramFollowersScraped
      )
    );
  }
  if (p.instagramIsPublic && enrichment.instagramIsPublic != null) {
    Object.assign(
      properties,
      buildCheckboxUpdate(p.instagramIsPublic, enrichment.instagramIsPublic)
    );
  }
  if (p.instagramVerified && enrichment.instagramVerified != null) {
    Object.assign(
      properties,
      buildCheckboxUpdate(p.instagramVerified, enrichment.instagramVerified)
    );
  }
  if (p.instagramBusiness && enrichment.instagramBusiness != null) {
    Object.assign(
      properties,
      buildCheckboxUpdate(p.instagramBusiness, enrichment.instagramBusiness)
    );
  }
  if (p.instagramPosts && enrichment.instagramPosts != null) {
    Object.assign(
      properties,
      buildNumberUpdate(p.instagramPosts, enrichment.instagramPosts)
    );
  }

  const update = {
    page_id: pageId,
    properties,
  };

  const icon = getQualificationIcon({
    followers: enrichment.instagramFollowersScraped,
    formFollowers: enrichment.instagramFollowersForm,
    isPublic: enrichment.instagramIsPublic,
    mtAccountExists: enrichment.mtAccountExists,
    mtHasCc: enrichment.mtHasCc,
    minFollowers: config.qualifiedMinFollowers,
  });
  if (icon) {
    update.icon = { type: "emoji", emoji: icon };
  }

  const notion = getNotionClient();
  await notion.pages.update(update);
}

/**
 * Move an application card to a Notion Status (e.g. Onboarded).
 */
export async function setApplicationStatus(pageId, statusName) {
  if (!pageId || !statusName) return;
  const notion = getNotionClient();
  await notion.pages.update({
    page_id: pageId,
    properties: buildStatusUpdate(config.notion.props.status, statusName),
  });
}

/**
 * Leave an ops-visible note on the application page (Notion comments).
 * @param {string} pageId
 * @param {string} text
 */
export async function addApplicationComment(pageId, text) {
  const content = String(text || "").trim();
  if (!pageId || !content) return;
  const notion = getNotionClient();
  await notion.comments.create({
    parent: { page_id: pageId },
    rich_text: [{ type: "text", text: { content } }],
  });
}

/**
 * @param {string} pageId
 * @returns {Promise<object|null>}
 */
export async function getApplicationPage(pageId) {
  if (!pageId) return null;
  const notion = getNotionClient();
  const page = await notion.pages.retrieve({ page_id: pageId });
  if (!page || page.object !== "page") return null;
  return parseApplicationPage(page);
}

/**
 * Prefer the current Accepted card for this email (ops Re-onboard lives there).
 * Falls back to the newest card of any status.
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function findApplicationForReonboard(email) {
  const apps = await listApplicationsByEmail(email);
  if (!apps.length) return null;
  const acceptedName = config.notion.status.accepted;
  const accepted = apps.filter((a) => a.status === acceptedName);
  const pool = accepted.length ? accepted : apps;
  pool.sort(compareApplicationsNewestFirst);
  return pool[0] || null;
}

/**
 * Set the Re-onboard select (Needs review / Proceed / Decline).
 * @param {string} pageId
 * @param {string} optionName
 */
export async function writeReonboardDecision(pageId, optionName) {
  const prop = config.notion.props.reonboard;
  if (!pageId || !prop || !optionName) return;
  const notion = getNotionClient();
  await notion.pages.update({
    page_id: pageId,
    properties: buildSelectUpdate(prop, optionName),
  });
}

/**
 * Stamp Never Consider when configured (Review "never again" re-applications).
 */
export async function writeNeverConsider(pageId, value) {
  const prop = config.notion.props.neverConsider;
  if (!pageId || !prop) return;
  const notion = getNotionClient();
  await notion.pages.update({
    page_id: pageId,
    properties: buildCheckboxUpdate(prop, Boolean(value)),
  });
}
