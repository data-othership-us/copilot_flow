/**
 * Instagram handle + profile URL helpers.
 * Stored form: ig_handle = "@name", ig_url = "https://www.instagram.com/name/"
 * Joins still use copilots.normalize_ig_handle (bare, lowercase).
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

/** Canonical stored handle ("@name"), or "". */
export function storedIgHandle(raw) {
  const bare = bareIgHandle(raw);
  return bare ? `@${bare}` : "";
}

/** Clickable profile URL, or "". */
export function igProfileUrl(raw) {
  const bare = bareIgHandle(raw);
  return bare ? `https://www.instagram.com/${bare}/` : "";
}

export function splitIgIdentity(raw) {
  const handle = storedIgHandle(raw) || null;
  const url = igProfileUrl(raw) || null;
  return { handle, url };
}
