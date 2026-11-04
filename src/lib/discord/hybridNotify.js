import { config } from "../../config.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_CONTENT = 2000;

function channelId() {
  return String(config.hybrid.discordChannelId || "").trim();
}

function botToken() {
  return String(config.hybrid.discordBotToken || "").trim();
}

export function hybridDiscordConfigured() {
  return Boolean(channelId() && botToken());
}

async function postDiscordMessage(content) {
  const url = `${DISCORD_API}/channels/${channelId()}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: String(content || "").slice(0, MAX_CONTENT),
      allowed_mentions: { parse: [] },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Discord message failed (${res.status})`);
  }
  return data.id || "";
}

/**
 * Post a hybrid update. Dry runs log the text. A missing bot token is skipped
 * so the email path still finishes.
 * @returns {Promise<{ posted?: boolean, dryRun?: boolean, skipped?: string }>}
 */
export async function notifyHybridDiscord(content, { dryRun = false } = {}) {
  const text = String(content || "").trim();
  if (!text) return { skipped: "empty" };
  if (!channelId()) return { skipped: "no_channel" };
  if (dryRun) {
    console.log(`   (DRY_RUN) discord ${channelId()}\n${text}`);
    return { dryRun: true };
  }
  if (!botToken()) {
    console.log(`   discord skipped — DISCORD_BOT_TOKEN is not set`);
    return { skipped: "no_token" };
  }
  try {
    const id = await postDiscordMessage(text);
    console.log(`   discord ${channelId()} message ${id}`);
    return { posted: true };
  } catch (error) {
    console.error(`   discord failed: ${error.message}`);
    return { skipped: "post_failed" };
  }
}
