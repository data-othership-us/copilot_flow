import { ApifyClient } from "apify-client";
import { config } from "../../config.js";
import { bareIgHandle, parseIgHandles } from "../instagram.js";

export function normalizeInstagramHandle(handle) {
  return parseIgHandles(handle)[0] || bareIgHandle(handle);
}

function pickFollowers(profile) {
  const candidates = [
    profile?.followersCount,
    profile?.followers,
    profile?.follower_count,
    profile?.edge_followed_by?.count,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function pickIsPublic(profile) {
  const candidates = [
    profile?.isPrivate,
    profile?.private,
    profile?.is_private,
  ];
  for (const value of candidates) {
    if (typeof value === "boolean") return !value;
  }
  return null;
}

function emptySocial(error = null) {
  return {
    instagramFollowersScraped: null,
    instagramIsPublic: null,
    instagramVerified: null,
    instagramIsBusiness: null,
    instagramFullName: null,
    instagramBiography: null,
    instagramPostsCount: null,
    instagramFollowsCount: null,
    instagramExternalUrl: null,
    instagramBusinessCategory: null,
    instagramCountry: null,
    instagramProfileUrl: null,
    raw: null,
    error,
  };
}

function mapProfile(profile) {
  if (!profile) return emptySocial("apify returned no profile rows");
  if (profile.error || profile.errorDescription) {
    return emptySocial(
      profile.errorDescription || profile.error || "apify profile scrape failed"
    );
  }

  return {
    instagramFollowersScraped: pickFollowers(profile),
    instagramIsPublic: pickIsPublic(profile),
    instagramVerified:
      typeof profile.verified === "boolean" ? profile.verified : null,
    instagramIsBusiness:
      typeof profile.isBusinessAccount === "boolean"
        ? profile.isBusinessAccount
        : null,
    instagramFullName: profile.fullName || null,
    instagramBiography: profile.biography || null,
    instagramPostsCount:
      typeof profile.postsCount === "number" ? profile.postsCount : null,
    instagramFollowsCount:
      typeof profile.followsCount === "number" ? profile.followsCount : null,
    instagramExternalUrl: profile.externalUrl || null,
    instagramBusinessCategory: profile.businessCategoryName || null,
    instagramCountry: profile.about?.country || null,
    instagramProfileUrl: profile.url || null,
    raw: profile,
    error: null,
  };
}

function profileUsernameKey(profile) {
  const fromUsername = normalizeInstagramHandle(profile?.username);
  if (fromUsername) return fromUsername;
  return normalizeInstagramHandle(profile?.inputUrl || profile?.url || "");
}

/**
 * Batch-scrape Instagram profiles in a single Apify actor run.
 * @param {string[]} handles
 * @returns {Promise<Map<string, ReturnType<typeof mapProfile>>>}
 */
export async function enrichInstagramProfilesBatch(handles) {
  const results = new Map();
  const unique = [
    ...new Set(
      (handles || [])
        .map(normalizeInstagramHandle)
        .filter(Boolean)
    ),
  ];

  for (const username of unique) {
    results.set(username, emptySocial(null));
  }

  if (unique.length === 0) return results;

  if (config.social.provider === "none") {
    return results;
  }

  if (config.social.provider !== "apify") {
    for (const username of unique) {
      results.set(
        username,
        emptySocial(`unknown SOCIAL_ENRICHMENT_PROVIDER: ${config.social.provider}`)
      );
    }
    return results;
  }

  const token = config.social.apifyToken;
  if (!token) {
    for (const username of unique) {
      results.set(username, emptySocial("APIFY_API_TOKEN not set"));
    }
    return results;
  }

  try {
    console.log(
      `   🔍 Social (apify batch): ${unique.length} handle(s) in one actor run`
    );
    const client = new ApifyClient({ token });
    const run = await client.actor(config.social.apifyActor).call(
      { usernames: unique },
      { waitSecs: config.social.apifyWaitSecs }
    );

    if (run.status && run.status !== "SUCCEEDED") {
      const err = `apify run ${run.status}${
        run.statusMessage ? `: ${run.statusMessage}` : ""
      }`;
      for (const username of unique) {
        results.set(username, emptySocial(err));
      }
      return results;
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems({
      limit: Math.max(unique.length * 2, 100),
    });

    for (const profile of items || []) {
      const key = profileUsernameKey(profile);
      if (!key) continue;
      results.set(key, mapProfile(profile));
    }

    for (const username of unique) {
      const current = results.get(username);
      if (
        current &&
        !current.error &&
        current.instagramFollowersScraped == null &&
        current.instagramIsPublic == null &&
        !current.raw
      ) {
        results.set(username, emptySocial("apify returned no profile for handle"));
      }
    }

    return results;
  } catch (error) {
    for (const username of unique) {
      results.set(username, emptySocial(error.message));
    }
    return results;
  }
}

/**
 * @param {{ platform?: string, handle?: string }} input
 */
export async function enrichSocialProfile({ platform = "instagram", handle }) {
  const cleanHandle = (handle ?? "").trim();
  if (!cleanHandle) return emptySocial(null);

  if (platform !== "instagram") {
    return emptySocial(`unsupported platform for apify: ${platform}`);
  }

  const map = await enrichInstagramProfilesBatch([cleanHandle]);
  const key = normalizeInstagramHandle(cleanHandle);
  return map.get(key) || emptySocial("apify returned no profile for handle");
}
