import dotenv from "dotenv";

dotenv.config();

function env(name, fallback = "") {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const config = {
  dryRun: envBool("DRY_RUN", true),
  requestDelayMs: envInt("REQUEST_DELAY_MS", 100),
  applicationLookbackDays: envInt("APPLICATION_LOOKBACK_DAYS", 0),
  /** Process at most N new applications (0 = no limit). Skips accepted pass unless EVALUATE_INCLUDE_ACCEPTED=1. */
  evaluateLimit: envInt("EVALUATE_LIMIT", 0),
  /** Process at most N pending onboard rows (0 = no limit). */
  onboardLimit: envInt("ONBOARD_LIMIT", 0),
  /** Comma-separated emails to onboard (dry-run preview of specific people). */
  onboardEmails: env("ONBOARD_EMAILS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  evaluateIncludeAccepted: envBool("EVALUATE_INCLUDE_ACCEPTED", false),
  /** Re-run MT + social enrichment for all Status=Evaluated pages (skips new/accepted passes). */
  reevaluateEvaluated: envBool("REEVALUATE_EVALUATED", false),
  /** Re-run MT + social enrichment for all Status=Accepted pages (keeps Accepted; no nudge/email). */
  reevaluateAccepted: envBool("REEVALUATE_ACCEPTED", false),
  /** Rebuild Review / Add to Modash without ingesting or applying filled decisions. */
  evaluateSkipApply: envBool("EVALUATE_SKIP_APPLY", false),
  /** Comma-separated emails: apply (or dry-run) only these people; still rebuild Review / Modash. */
  evaluateEmails: env("EVALUATE_EMAILS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  notion: {
    token: env("NOTION_TOKEN"),
    version: env("NOTION_VERSION", "2022-06-28"),
    applicationsDatabaseId: env("NOTION_APPLICATIONS_DATABASE_ID"),
    props: {
      name: env("NOTION_PROP_NAME", "Name"),
      firstName: env("NOTION_PROP_FIRST_NAME", "First Name"),
      lastName: env("NOTION_PROP_LAST_NAME", "Last Name"),
      email: env("NOTION_PROP_EMAIL", "Email"),
      status: env("NOTION_PROP_STATUS", "Status"),
      region: env("NOTION_PROP_REGION", "Region"),
      submitted: env("NOTION_PROP_SUBMITTED", "Submitted"),
      instagramHandle: env("NOTION_PROP_INSTAGRAM_HANDLE", "Instagram Handle"),
      instagramFollowing: env(
        "NOTION_PROP_INSTAGRAM_FOLLOWING",
        "Instagram Following"
      ),
      phone: env("NOTION_PROP_PHONE", "Phone #"),
      previousApplication: env("NOTION_PROP_PREVIOUS_APPLICATION", ""),
      neverConsider: env("NOTION_PROP_NEVER_CONSIDER", ""),
      mtClassCount: env("NOTION_PROP_MT_CLASS_COUNT", ""),
      mtEmail: env("NOTION_PROP_MT_EMAIL", ""),
      mtHasCc: env("NOTION_PROP_MT_HAS_CC", ""),
      mtHomeStudio: env("NOTION_PROP_MT_HOME_STUDIO", ""),
      instagramFollowersScraped: env(
        "NOTION_PROP_INSTAGRAM_FOLLOWERS_SCRAPED",
        ""
      ),
      instagramIsPublic: env("NOTION_PROP_INSTAGRAM_IS_PUBLIC", ""),
      instagramVerified: env("NOTION_PROP_INSTAGRAM_VERIFIED", ""),
      instagramBusiness: env("NOTION_PROP_INSTAGRAM_BUSINESS", ""),
      instagramPosts: env("NOTION_PROP_INSTAGRAM_POSTS", ""),
      tiktokHandle: env("NOTION_PROP_TIKTOK_HANDLE", "Tiktok Handle"),
      tiktokFollowing: env("NOTION_PROP_TIKTOK_FOLLOWING", "Tiktok Following"),
      tiktokLink: env("NOTION_PROP_TIKTOK_LINK", "Tik Tok Link"),
      youtubeLink: env("NOTION_PROP_YOUTUBE_LINK", "YouTube link"),
      youtubeSubscribers: env(
        "NOTION_PROP_YOUTUBE_SUBSCRIBERS",
        "YouTube Subscribers"
      ),
      linkedinLink: env("NOTION_PROP_LINKEDIN_LINK", "LinkedIn Link"),
      linkedinFollowing: env(
        "NOTION_PROP_LINKEDIN_FOLLOWING",
        "LinkedIn Following"
      ),
      twitterHandle: env("NOTION_PROP_TWITTER_HANDLE", "Twitter Handle"),
      twitterFollowing: env(
        "NOTION_PROP_TWITTER_FOLLOWING",
        "Twitter Following"
      ),
      blogLink: env("NOTION_PROP_BLOG_LINK", "Blog Link"),
      blogSubscribers: env("NOTION_PROP_BLOG_SUBSCRIBERS", "Blog Subscribers"),
      contentTopics: env("NOTION_PROP_CONTENT_TOPICS", "Content Topics"),
      mediaKit: env("NOTION_PROP_MEDIA_KIT", "Media Kit"),
      needsNudge: env("NOTION_PROP_NEEDS_NUDGE", "Needs Nudge"),
      nudgeReason: env("NOTION_PROP_NUDGE_REASON", "Nudge Reason"),
      lastNudged: env("NOTION_PROP_LAST_NUDGED", "Last Nudged"),
      creditApplied: env("NOTION_PROP_CREDIT_APPLIED", "Credit Applied"),
      reonboard: env("NOTION_PROP_REONBOARD", "Re-onboard"),
    },
    status: {
      new: env("NOTION_STATUS_NEW", "No Status"),
      evaluated: env("NOTION_STATUS_EVALUATED", "Evaluated"),
      accepted: env("NOTION_STATUS_ACCEPTED", "Accepted"),
      acceptedContacted: env(
        "NOTION_STATUS_ACCEPTED_CONTACTED",
        "Accepted - Contacted"
      ),
      rejected: env("NOTION_STATUS_REJECTED", "Rejected"),
      duplicate: env("NOTION_STATUS_DUPLICATE", "Duplicate"),
      rejectedContacted: env(
        "NOTION_STATUS_REJECTED_CONTACTED",
        "Rejected - Contacted"
      ),
      onboarded: env("NOTION_STATUS_ONBOARDED", "Onboarded"),
    },
    /**
     * Monthly update: promo rows + Global Events Calendar (same source as
     * event-automations). Share both databases with the Notion integration.
     */
    monthlyPromosDatabaseId: env(
      "NOTION_MONTHLY_PROMOS_DATABASE_ID",
      "9d4abbed5e94442d95a2699ead116776"
    ),
    eventsDatabaseId: env(
      "NOTION_EVENTS_DATABASE_ID",
      "dbb6515ea7334a38bd439e43aec85dee"
    ),
    reonboard: {
      needsReview: env("NOTION_REONBOARD_NEEDS_REVIEW", "Needs review"),
      proceed: env("NOTION_REONBOARD_PROCEED", "Proceed"),
      decline: env("NOTION_REONBOARD_DECLINE", "Decline"),
    },
  },

  bq: {
    projectId: env("BQ_PROJECT_ID"),
    dataset: env("BQ_DATASET", "copilots"),
    applicantsTable: env("BQ_APPLICANTS_TABLE", "copilot_applicants"),
    copilotTable: env("BQ_COPILOT_TABLE", "copilot_db"),
    location: env("BQ_QUERY_LOCATION", "US"),
  },

  mt: {
    baseUrl: env("MT_API_BASE_URL"),
    apiKey: env("MT_API_KEY"),
    tenantHost: env("MT_TENANT_HOST", "othership.marianatek.com"),
    creditTransactionEndpoint: env(
      "MT_CREDIT_TRANSACTION_ENDPOINT",
      "/credit_transactions"
    ),
    /**
     * MT credit product ids for Co-Pilot rejection thank-you credits.
     * Prefer region-specific; COPILOT_REJECTION_MT_CREDIT_ID is a legacy fallback.
     */
    rejectionCreditId: env("COPILOT_REJECTION_MT_CREDIT_ID"),
    rejectionCreditIdNy: env("COPILOT_REJECTION_MT_CREDIT_ID_NY"),
    rejectionCreditIdTo: env("COPILOT_REJECTION_MT_CREDIT_ID_TO"),
    rejectionCreditAmount: envInt("COPILOT_REJECTION_MT_CREDIT_AMOUNT", 1),
    rejectionCreditExpiryDays: envInt(
      "COPILOT_REJECTION_MT_CREDIT_EXPIRY_DAYS",
      30
    ),
    rejectionCreditNote: env(
      "COPILOT_REJECTION_MT_CREDIT_NOTE",
      "Co-Pilot application thank-you credit"
    ),
  },

  social: {
    provider: env("SOCIAL_ENRICHMENT_PROVIDER", "none").toLowerCase(),
    apifyToken: env("APIFY_API_TOKEN"),
    apifyActor: env(
      "APIFY_INSTAGRAM_ACTOR",
      "apify/instagram-profile-scraper"
    ),
    apifyWaitSecs: envInt("APIFY_WAIT_SECS", 300),
  },

  /** Min scraped followers for 🟢 / 🟡 / 🔴 page icons */
  qualifiedMinFollowers: envInt("QUALIFIED_MIN_FOLLOWERS", 1500),

  /**
   * Only inspect Onboarded cards edited in this many days when moving
   * incomplete Onboarded cards back to Evaluated (0 = scan every Onboarded card).
   */
  reclaimOnboardedLookbackDays: envInt("RECLAIM_ONBOARDED_LOOKBACK_DAYS", 30),

    /**
     * Gmail API — Co-Pilot mailbox.
     * Applications label: rejection + onboarding nudge.
     * Management label: Review lifecycle (renew / offboard / upgrade / downgrade / freeze / payment nudge / resubmit handles / monthly).
     * Auth a separate Google account via: npm run gmail-oauth
     */
  email: {
    sendMethod: env("EMAIL_SEND_METHOD", "gmail_api").toLowerCase(),
    from: env("EMAIL_FROM", "Othership Co-Pilot Program <copilots@othership.us>"),
    gmailClientId: env("GMAIL_API_CLIENT_ID"),
    gmailClientSecret: env("GMAIL_API_CLIENT_SECRET"),
    /** Prefer Co-Pilot-specific token; GMAIL_API_REFRESH_TOKEN is a generic fallback */
    gmailRefreshToken:
      env("GMAIL_REFRESH_TOKEN_COPILOT") || env("GMAIL_API_REFRESH_TOKEN"),
    gmailUser: env("GMAIL_API_USER", "me"),
    gmailLabelName: env("GMAIL_API_LABEL_NAME", "Co-Pilot Applications"),
    gmailLabelId: env("GMAIL_API_LABEL_ID", ""),
    gmailLabelNameManagement: env(
      "GMAIL_API_LABEL_NAME_MANAGEMENT",
      "Co-Pilot Management"
    ),
    gmailLabelIdManagement: env("GMAIL_API_LABEL_ID_MANAGEMENT", ""),
    gmailAutoLabel: envBool("GMAIL_API_AUTO_LABEL", true),
  },

  /** Optional URLs interpolated into lifecycle emails. */
  copilotLinks: {
    applyUrl: env("COPILOT_APPLY_URL", "https://tally.so/r/mDVGpq"),
    breathworkPersonalUrl: env("COPILOT_BREATHWORK_PERSONAL_URL", ""),
    breathworkCommunityUrl: env(
      "COPILOT_BREATHWORK_COMMUNITY_URL",
      "https://apps.apple.com/redeem?ctx=offercodes&id=1590348936&code=COPILOT1"
    ),
    seekerHubUrl: env(
      "COPILOT_SEEKER_HUB_URL",
      "https://app.notion.com/p/othership/Seeker-Hub-299271660d72803d8291e80032fdff4c"
    ),
    wayfinderHubUrl: env(
      "COPILOT_WAYFINDER_HUB_URL",
      "https://app.notion.com/p/othership/Wayfinder-Hub-299271660d7280398958ed331855e188"
    ),
    luminaryHubUrl: env(
      "COPILOT_LUMINARY_HUB_URL",
      "https://app.notion.com/p/othership/Luminary-Hub-299271660d7280f0be49fa910625ecc4"
    ),
  },

  /** Christine evaluation sheet (queue from copilot_evaluation_queue). */
  evaluation: {
    sheetId: env("EVALUATION_SHEET_ID"),
    reviewTab: env("EVALUATION_SHEET_REVIEW_TAB", "Review"),
    addToModashTab: env("EVALUATION_SHEET_ADD_TO_MODASH_TAB", "Add to Modash"),
  },
};

/**
 * Resolve rejection thank-you credit product id from Notion Region.
 * @param {string | null | undefined} region
 * @returns {string} credit product id, or "" if none configured for that region
 */
export function resolveRejectionCreditId(region) {
  const normalized = String(region || "")
    .trim()
    .toLowerCase();
  const isNy =
    normalized === "ny" ||
    normalized === "nyc" ||
    normalized === "new york" ||
    normalized === "new york city";
  const isTo =
    normalized === "to" ||
    normalized === "toronto" ||
    normalized === "tor";

  if (isNy) {
    return String(
      config.mt.rejectionCreditIdNy || config.mt.rejectionCreditId || ""
    ).trim();
  }
  if (isTo) {
    return String(
      config.mt.rejectionCreditIdTo || config.mt.rejectionCreditId || ""
    ).trim();
  }
  // Unknown / missing region — only use legacy single id if set
  return String(config.mt.rejectionCreditId || "").trim();
}

export function assertEvaluateApplicationsConfig() {
  const missing = [];
  if (!config.notion.token) missing.push("NOTION_TOKEN");
  if (!config.notion.applicationsDatabaseId) {
    missing.push("NOTION_APPLICATIONS_DATABASE_ID");
  }
  if (!config.bq.projectId) missing.push("BQ_PROJECT_ID");
  if (!config.mt.baseUrl) missing.push("MT_API_BASE_URL");
  if (!config.mt.apiKey) missing.push("MT_API_KEY");
  if (config.social.provider === "apify" && !config.social.apifyToken) {
    missing.push("APIFY_API_TOKEN");
  }
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
