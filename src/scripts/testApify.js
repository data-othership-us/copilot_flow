/**
 * Smoke-test Apify Instagram profile scrape (batched).
 *
 * Usage:
 *   npm run test-apify -- nasa
 *   npm run test-apify -- nasa humansofny bathhouse
 */
import dotenv from "dotenv";

dotenv.config();

const handles = process.argv.slice(2);

if (handles.length === 0) {
  console.error("Usage: npm run test-apify -- <handle> [handle...]");
  process.exit(1);
}

if (!process.env.APIFY_API_TOKEN) {
  console.error("Missing APIFY_API_TOKEN in .env");
  process.exit(1);
}

process.env.SOCIAL_ENRICHMENT_PROVIDER = "apify";

const { config } = await import("../config.js");
const {
  enrichInstagramProfilesBatch,
  normalizeInstagramHandle,
} = await import("../lib/social/enrichProfile.js");

config.social.provider = "apify";

console.log(`Testing Apify batch scrape for ${handles.length} handle(s)`);
console.log(`Actor: ${config.social.apifyActor}`);
console.log(`Wait: ${config.social.apifyWaitSecs}s`);

const map = await enrichInstagramProfilesBatch(handles);
let failed = 0;

for (const handle of handles) {
  const key = normalizeInstagramHandle(handle);
  const result = map.get(key);
  const {
    raw: _raw,
    instagramBiography,
    ...summary
  } = result || { error: "missing result" };

  console.log(`\n—— @${key} ——`);
  console.log(
    JSON.stringify(
      {
        ...summary,
        instagramBiography: instagramBiography
          ? `${instagramBiography.slice(0, 120)}${
              instagramBiography.length > 120 ? "…" : ""
            }`
          : null,
      },
      null,
      2
    )
  );
  if (!result || result.error) failed += 1;
}

if (failed) process.exit(1);
