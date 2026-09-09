/**
 * Extract Notion database property values into plain JS types.
 */

export function getTitle(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "title") return "";
  return (p.title ?? []).map((t) => t.plain_text).join("").trim();
}

export function getRichText(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "rich_text") return "";
  return (p.rich_text ?? []).map((t) => t.plain_text).join("").trim();
}

export function getEmail(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "email") return "";
  return (p.email ?? "").trim();
}

export function getPhone(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "phone_number") return "";
  return (p.phone_number ?? "").trim();
}

export function getNumber(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "number") return null;
  return typeof p.number === "number" ? p.number : null;
}

export function getSelect(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "select") return "";
  return p.select?.name ?? "";
}

export function getStatus(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "status") return "";
  return p.status?.name ?? "";
}

export function getCheckbox(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "checkbox") return false;
  return Boolean(p.checkbox);
}

export function getDateStart(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "date" || !p.date?.start) return null;
  return p.date.start;
}

export function splitName(fullName) {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function tokenizeName(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Drop consecutive duplicate tokens, case-insensitive ("Nguien Nguien" → "Nguien").
 * Keep the later spelling so "chandran" + "Chandran" becomes "Chandran".
 */
function collapseConsecutiveNameTokens(parts) {
  const out = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev && prev.toLowerCase() === part.toLowerCase()) {
      out[out.length - 1] = part;
      continue;
    }
    out.push(part);
  }
  return out;
}

/**
 * Collapse duplicated first/last tokens from Notion ("Marie" + "Nguien Nguien Nguien"
 * → Marie / Nguien). First name is the first token; the rest is last name.
 */
export function normalizePersonName(firstName, lastName) {
  const all = collapseConsecutiveNameTokens([
    ...tokenizeName(firstName),
    ...tokenizeName(lastName),
  ]);
  if (!all.length) return { firstName: "", lastName: "" };
  if (all.length === 1) return { firstName: all[0], lastName: "" };
  return { firstName: all[0], lastName: all.slice(1).join(" ") };
}

/**
 * Build a page title from first + last without stacking last name
 * ("Jane Smith" + "Smith" → "Jane Smith", not "Jane Smith Smith").
 */
export function composeDisplayName(firstName, lastName) {
  const n = normalizePersonName(firstName, lastName);
  return [n.firstName, n.lastName].filter(Boolean).join(" ");
}

export function getUrl(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "url") return "";
  return (p.url ?? "").trim();
}

export function getInstagramHandle(props, name) {
  const url = getUrl(props, name);
  if (url) {
    const fromUrl = normalizeInstagramHandle(url);
    if (fromUrl) return fromUrl;
  }
  return normalizeInstagramHandle(getRichText(props, name));
}

/** Normalize TikTok / generic @handle or profile URL → bare handle. */
export function normalizeSocialHandle(handle, hosts = []) {
  let raw = String(handle ?? "").trim();
  if (!raw) return "";

  for (const host of hosts) {
    const bare = host.replace(/^www\./, "");
    if (new RegExp(`^(www\\.)?${bare.replace(/\./g, "\\.")}/`, "i").test(raw)) {
      raw = `https://${raw}`;
      break;
    }
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const path = new URL(raw).pathname.replace(/^\/+|\/+$/g, "");
      const segment = path.split("/").filter(Boolean).pop();
      if (segment) return segment.replace(/^@+/, "").split("?")[0].trim();
    } catch {
      // fall through
    }
  }

  return raw.replace(/^@+/, "").split("/")[0].split("?")[0].trim();
}

export function getTiktokHandle(props, name) {
  const url = getUrl(props, name);
  if (url) {
    const fromUrl = normalizeSocialHandle(url, ["tiktok.com", "www.tiktok.com"]);
    if (fromUrl) return fromUrl;
  }
  return normalizeSocialHandle(getRichText(props, name), ["tiktok.com"]);
}

export function getMultiSelectNames(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "multi_select") return [];
  return (p.multi_select ?? []).map((x) => x.name).filter(Boolean);
}

export function getFilesCount(props, name) {
  const p = props?.[name];
  if (!p || p.type !== "files") return 0;
  return (p.files ?? []).length;
}

export function normalizeInstagramHandle(handle) {
  let raw = String(handle ?? "").trim();
  if (!raw) return "";

  // Bare instagram.com/... links (missing protocol) — common from form fills
  if (/^(www\.)?instagram\.com\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const path = new URL(raw).pathname.replace(/^\/+|\/+$/g, "");
      const segment = path.split("/").filter(Boolean).pop();
      if (segment) return segment.replace(/^@+/, "").split("?")[0].trim();
    } catch {
      // fall through
    }
  }

  return raw
    .replace(/^@+/, "")
    .replace(/^(www\.)?instagram\.com\//i, "")
    .split("/")[0]
    .split("?")[0]
    .trim();
}

/**
 * Build Notion API property update payloads.
 */
export function buildTitleUpdate(propName, value) {
  if (!value) return {};
  return {
    [propName]: {
      title: [{ type: "text", text: { content: String(value) } }],
    },
  };
}

export function buildStatusUpdate(propName, statusName) {
  return {
    [propName]: {
      status: { name: statusName },
    },
  };
}

export function buildSelectUpdate(propName, optionName) {
  if (!propName) return {};
  if (!optionName) {
    return { [propName]: { select: null } };
  }
  return {
    [propName]: {
      select: { name: optionName },
    },
  };
}

export function buildCheckboxUpdate(propName, value) {
  return {
    [propName]: {
      checkbox: Boolean(value),
    },
  };
}

export function buildNumberUpdate(propName, value) {
  if (value === null || value === undefined) return {};
  return {
    [propName]: {
      number: value,
    },
  };
}

export function buildRichTextUpdate(propName, value) {
  if (!value) return {};
  return {
    [propName]: {
      rich_text: [{ type: "text", text: { content: String(value) } }],
    },
  };
}

export function buildEmailUpdate(propName, value) {
  if (!value) return {};
  return {
    [propName]: {
      email: String(value),
    },
  };
}

export function buildDateUpdate(propName, isoDate) {
  if (!isoDate) return {};
  const start = String(isoDate).slice(0, 10);
  return {
    [propName]: {
      date: { start },
    },
  };
}

/**
 * Form follower count looks inflated vs scrape.
 * Default: form ≥ 2× scraped AND ≥ 500 absolute overstatement.
 */
export function isFollowerCountLie({
  formFollowers,
  scrapedFollowers,
  minRatio = 2,
  minAbsolute = 500,
}) {
  if (
    typeof formFollowers !== "number" ||
    typeof scrapedFollowers !== "number" ||
    !Number.isFinite(formFollowers) ||
    !Number.isFinite(scrapedFollowers)
  ) {
    return false;
  }
  if (formFollowers <= 0 || scrapedFollowers < 0) return false;
  const overBy = formFollowers - scrapedFollowers;
  return overBy >= minAbsolute && formFollowers >= scrapedFollowers * minRatio;
}

/**
 * Qualification icons for Notion page (priority order):
 * - 🔴 lied: form followers clearly inflated vs scraped
 * - 🔴 under threshold: scraped followers known and < minFollowers
 * - 🔴 private IG: scraped profile is not public
 * - 🟢 full: 1500+ scraped, public IG, MT account, valid CC
 * - 🟡 social-ready: 1500+ scraped + public, but missing MT and/or CC
 * - null otherwise (e.g. no scrape result yet)
 */
export function getQualificationIcon({
  followers,
  formFollowers,
  isPublic,
  mtAccountExists,
  mtHasCc,
  minFollowers = 1500,
}) {
  if (
    isFollowerCountLie({
      formFollowers,
      scrapedFollowers: followers,
    })
  ) {
    return "🔴";
  }

  if (typeof followers === "number" && followers < minFollowers) {
    return "🔴";
  }

  // Private / not public — never 🟢/🟡; mark red once we know from scrape
  if (isPublic === false) {
    return "🔴";
  }

  const socialReady =
    typeof followers === "number" &&
    followers >= minFollowers &&
    isPublic === true;

  if (!socialReady) return null;

  if (mtAccountExists === true && mtHasCc === true) return "🟢";
  return "🟡";
}

/** @deprecated Prefer getQualificationIcon — kept for call-site clarity */
export function isHighlyQualified(args) {
  return getQualificationIcon(args) === "🟢";
}
