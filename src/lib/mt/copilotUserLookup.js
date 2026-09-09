import axios from "axios";

const JSON_API_HEADERS = {
  Accept: "application/vnd.api+json",
};

function normalizeUserList(data) {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function isCopilotMembershipName(name) {
  if (!name) return false;
  return /co[\s-]?pilot/i.test(String(name));
}

/**
 * Fetch membership instances for a user and return those whose name looks like Co-Pilot.
 */
export async function getCopilotMembershipsForUser(baseUrl, bearerToken, userId) {
  const response = await axios.get(`${baseUrl}/membership_instances`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...JSON_API_HEADERS,
    },
    params: { user: parseInt(userId, 10) },
  });

  const instances = normalizeUserList(response.data?.data);
  return instances.filter((m) =>
    isCopilotMembershipName(m?.attributes?.membership_name)
  );
}

function rankCopilotMembership(membership) {
  const status = String(membership?.attributes?.status || "").toLowerCase();
  // Prefer active / pending over expired / terminated
  const statusScore =
    status === "active" || status === "pending" || status === "frozen"
      ? 2
      : status === "expired" || status === "terminated" || status === "canceled"
        ? 0
        : 1;
  const start = new Date(
    membership?.attributes?.calculated_start_datetime || 0
  ).getTime();
  return { statusScore, start };
}

function pickBestCopilotCandidate(candidates) {
  // candidates: [{ user, memberships }]
  const scored = candidates.map(({ user, memberships }) => {
    let best = { statusScore: -1, start: 0 };
    for (const m of memberships) {
      const r = rankCopilotMembership(m);
      if (
        r.statusScore > best.statusScore ||
        (r.statusScore === best.statusScore && r.start > best.start)
      ) {
        best = r;
      }
    }
    return { user, memberships, ...best };
  });

  scored.sort((a, b) => {
    if (b.statusScore !== a.statusScore) return b.statusScore - a.statusScore;
    return b.start - a.start;
  });
  return scored[0];
}

/**
 * Resolve MT user by email. First list hit, or null.
 * @returns {Promise<object|null>}
 */
export async function findMtUserByEmail(baseUrl, bearerToken, email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  try {
    const response = await axios.get(`${baseUrl}/users`, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        ...JSON_API_HEADERS,
      },
      params: { email: normalized },
    });
    const users = normalizeUserList(response.data?.data);
    return users[0] || null;
  } catch (error) {
    if (error.response?.status === 404) return null;
    console.error(
      `❌ Error finding MT user by email ${normalized}:`,
      error.message
    );
    return null;
  }
}

/**
 * Resolve MT user by first/last name for Co-Pilots (NOT employees).
 * When multiple users match the name, only keep candidates that have a
 * Co-Pilot membership instance — never just take the first list hit.
 *
 * @returns {Promise<object|null>} user resource or null
 */
export async function findCopilotUserByName(
  baseUrl,
  bearerToken,
  firstName,
  lastName
) {
  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();
  if (!first || !last) return null;

  try {
    const response = await axios.get(`${baseUrl}/users`, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        ...JSON_API_HEADERS,
      },
      params: {
        first_name: first,
        last_name: last,
      },
    });

    const users = normalizeUserList(response.data?.data);
    if (users.length === 0) return null;

    const withCopilot = [];
    for (const user of users) {
      try {
        const memberships = await getCopilotMembershipsForUser(
          baseUrl,
          bearerToken,
          user.id
        );
        if (memberships.length > 0) {
          withCopilot.push({ user, memberships });
        }
      } catch (err) {
        console.warn(
          `   ⚠️ Could not load memberships for user ${user.id}: ${err.message}`
        );
      }
    }

    if (withCopilot.length === 0) {
      console.log(
        `   ⚠️ ${users.length} name match(es) for ${first} ${last}, none with Co-Pilot membership`
      );
      return null;
    }

    if (withCopilot.length === 1) {
      const names = withCopilot[0].memberships
        .map((m) => m.attributes?.membership_name)
        .filter(Boolean);
      console.log(
        `   ✅ Name match with Co-Pilot membership (user ${withCopilot[0].user.id}): ${names.join(", ")}`
      );
      return withCopilot[0].user;
    }

    const best = pickBestCopilotCandidate(withCopilot);
    console.warn(
      `   ⚠️ ${withCopilot.length} name matches with Co-Pilot membership for ${first} ${last}; using user ${best.user.id} (best membership status/start)`
    );
    return best.user;
  } catch (error) {
    if (error.response?.status === 404) return null;
    console.error(
      `❌ Error finding Co-Pilot user by name ${first} ${last}:`,
      error.message
    );
    return null;
  }
}
