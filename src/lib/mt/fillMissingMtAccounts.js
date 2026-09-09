import { config, sleep } from "../../config.js";
import {
  listCopilotsMissingUserId,
  updateCopilotByEmail,
} from "../bq/copilotOps.js";
import {
  findCopilotUserByName,
  findMtUserByEmail,
} from "./copilotUserLookup.js";

function profileLink(userId) {
  if (!userId) return null;
  return `https://${config.mt.tenantHost}/admin/user/profile/${userId}`;
}

function userFields(user) {
  const userId = user?.id ? String(user.id) : "";
  if (!userId) return null;
  return {
    user_id: userId,
    mt_email: user.attributes?.email || null,
    mt_profile_link: profileLink(userId),
  };
}

/**
 * Fill copilot_db user_id / mt_email / mt_profile_link for rows that have none.
 * Email first; name + Co-Pilot membership only if email misses.
 */
export async function fillMissingMtAccounts({ dryRun = false } = {}) {
  const summary = { scanned: 0, found: 0, updated: 0, notFound: 0, failed: 0 };
  const baseUrl = config.mt.baseUrl;
  const apiKey = config.mt.apiKey;

  console.log("\n—— Find missing Mariana Tek accounts ——");
  if (!baseUrl || !apiKey) {
    console.log("   ⚠️  MT_API_BASE_URL / MT_API_KEY missing — skip");
    return summary;
  }

  const rows = await listCopilotsMissingUserId();
  summary.scanned = rows.length;
  console.log(`   ${rows.length} copilot_db row(s) with no user_id`);

  if (!rows.length) return summary;
  if (dryRun) {
    console.log("   (DRY_RUN: would look up each email, then name if needed)");
    return summary;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = String(row.contact_email || "").trim();
    const label =
      [row.first_name, row.last_name].filter(Boolean).join(" ") || email;
    console.log(`   🔍 [${i + 1}/${rows.length}] ${label} <${email}>`);

    let user = await findMtUserByEmail(baseUrl, apiKey, email);
    let foundBy = user ? "email" : "";
    if (!user && row.first_name && row.last_name) {
      user = await findCopilotUserByName(
        baseUrl,
        apiKey,
        row.first_name,
        row.last_name
      );
      if (user) foundBy = "name";
    }

    const fields = userFields(user);
    if (!fields) {
      console.log("      not found");
      summary.notFound++;
    } else {
      summary.found++;
      try {
        await updateCopilotByEmail(email, fields);
        summary.updated++;
        console.log(`      ✅ user_id=${fields.user_id} (${foundBy})`);
      } catch (error) {
        summary.failed++;
        console.warn(`      ⚠️  BigQuery update failed: ${error.message}`);
      }
    }

    if (i < rows.length - 1) await sleep(config.requestDelayMs);
  }

  console.log(
    `   Done — found ${summary.found}, updated ${summary.updated}, not found ${summary.notFound}, failed ${summary.failed}`
  );
  return summary;
}
