import axios from "axios";

const JSON_API_HEADERS = {
  Accept: "application/vnd.api+json",
};

/**
 * Marianatek system employee tag (see user_tags in API when include=tags).
 */
export function isEmployeeTagAttributes(attrs) {
  if (!attrs) return false;
  const slug = String(attrs.slug || "").toLowerCase();
  const name = String(attrs.name || "")
    .toLowerCase()
    .trim();
  return slug === "employee-system" || name === "employee";
}

/**
 * @param {object} user - JSON:API user resource
 * @param {object[]} included - response included array (user_tags, etc.)
 */
export function userHasEmployeeTag(user, included = []) {
  const refs = user?.relationships?.tags?.data || [];
  for (const ref of refs) {
    const tag = included.find(
      t => t.type === ref.type && String(t.id) === String(ref.id)
    );
    if (tag && isEmployeeTagAttributes(tag.attributes)) return true;
  }
  return false;
}

async function getUsersByQuery(baseUrl, bearerToken, firstName, lastName) {
  const params = {
    first_name: firstName,
    is_employee: true,
    include: "tags",
  };
  if (lastName) params.last_name = lastName;

  const response = await axios.get(`${baseUrl}/users`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...JSON_API_HEADERS,
    },
    params,
  });
  return response.data;
}

async function getUserByIdWithTags(baseUrl, bearerToken, userId) {
  const response = await axios.get(`${baseUrl}/users/${userId}`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...JSON_API_HEADERS,
    },
    params: { include: "tags" },
  });
  return {
    user: response.data?.data,
    included: response.data?.included || [],
  };
}

function normalizeUserList(data) {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/**
 * Resolve MT user by first/last name, preferring the JSON:API user that has the Employee user_tag.
 * When the list response omits tag sidecars (common with multiple matches), each candidate is
 * loaded with GET /users/:id?include=tags until an employee is found.
 *
 * @returns {Promise<object|null>} user resource or null
 */
export async function findEmployeeUserByName(
  baseUrl,
  bearerToken,
  firstName,
  lastName
) {
  if (!firstName) return null;

  try {
    const payload = await getUsersByQuery(
      baseUrl,
      bearerToken,
      firstName,
      lastName
    );
    const users = normalizeUserList(payload.data);
    if (users.length === 0) return null;

    const included = payload.included || [];

    const taggedFromList = users.filter(u => userHasEmployeeTag(u, included));
    if (taggedFromList.length === 1) return taggedFromList[0];
    if (taggedFromList.length > 1) {
      console.warn(
        `⚠️ Multiple (${taggedFromList.length}) employee-tagged users for ${firstName} ${lastName}; using id=${taggedFromList[0].id}`
      );
      return taggedFromList[0];
    }

    for (const u of users) {
      const { user, included: inc } = await getUserByIdWithTags(
        baseUrl,
        bearerToken,
        u.id
      );
      if (user && userHasEmployeeTag(user, inc)) return user;
    }

    return null;
  } catch (error) {
    if (error.response?.status === 404) return null;
    console.error(
      `❌ Error finding employee user by name ${firstName} ${lastName}:`,
      error.message
    );
    return null;
  }
}
