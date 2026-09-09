/**
 * Instagram handle + profile URL helpers.
 * Stored form: ig_handle = "@name", or "@a\\n@b" (one handle per line).
 * ig_url = one profile URL per handle, newline-separated when there are several.
 * Joins still use copilots.normalize_ig_handle / split_ig_handles (bare, lowercase).
 */

const RESERVED_PATHS = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "explore",
  "accounts",
  "tv",
  "direct",
  "about",
  "legal",
]);

/** Ops placeholders, not real Instagram usernames — never prefix @ or build a URL. */
const PLACEHOLDER_HANDLES = new Set(["re-submit", "resubmit"]);

const IG_URL_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s,;|&]+/gi;
const TOKEN_SPLIT_RE = /[,;|&]+|\s+and\s+|\s*\/\s*|\s+/i;

function igTokens(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return [];

  value = value.replace(/\([^)]*\)/g, " ");

  const tokens = [];
  value = value.replace(IG_URL_RE, (match) => {
    tokens.push(match);
    return " ";
  });
  for (const part of value.split(TOKEN_SPLIT_RE)) {
    const token = part.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Bare lowercase handle, or "". Strips @, profile URLs, query/path. */
export function bareIgHandle(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";

  if (/^(www\.)?instagram\.com\//i.test(value)) {
    value = `https://${value}`;
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return "";
      const parts = url.pathname.split("/").filter(Boolean);
      const user = parts.find((p) => !RESERVED_PATHS.has(p.toLowerCase()));
      value = user || "";
    } catch {
      return "";
    }
  }

  return value
    .replace(/^@+/, "")
    .replace(/^(www\.)?instagram\.com\//i, "")
    .split("/")[0]
    .split("?")[0]
    .trim()
    .toLowerCase();
}

export function isPlaceholderIgHandle(raw) {
  return PLACEHOLDER_HANDLES.has(bareIgHandle(raw));
}

/**
 * Unique bare handles from a sheet/DB cell that may list several
 * (`@a, @b`, `a / b`, mixed URLs). Placeholders and reserved paths dropped.
 */
export function parseIgHandles(raw) {
  const seen = new Set();
  const out = [];
  for (const token of igTokens(raw)) {
    const bare = bareIgHandle(token);
    if (!bare || PLACEHOLDER_HANDLES.has(bare) || RESERVED_PATHS.has(bare)) {
      continue;
    }
    if (seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}

/** Canonical stored handle(s): "@name", or "@a\\n@b" (one handle per line). */
export function storedIgHandle(raw) {
  const parsed = parseIgHandles(raw);
  if (parsed.length) return parsed.map((h) => `@${h}`).join("\n");
  const bare = bareIgHandle(raw);
  if (!bare) return "";
  if (PLACEHOLDER_HANDLES.has(bare)) return bare;
  return `@${bare}`;
}

/** Clickable profile URL(s), newline-separated when there are several, or "". */
export function igProfileUrl(raw) {
  const parsed = parseIgHandles(raw);
  if (parsed.length) {
    return parsed.map((h) => `https://www.instagram.com/${h}/`).join("\n");
  }
  if (isPlaceholderIgHandle(raw)) return "";
  const bare = bareIgHandle(raw);
  return bare ? `https://www.instagram.com/${bare}/` : "";
}

export function splitIgIdentity(raw) {
  const handle = storedIgHandle(raw) || null;
  const url = igProfileUrl(raw) || null;
  return { handle, url };
}
