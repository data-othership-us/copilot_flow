import axios from "axios";
import { config } from "../../config.js";
import { hasValidBankcardOnFile } from "./bankcards.js";

const LOCATION_NAMES = {
  48717: "Adelaide",
  48750: "Yorkville",
  48784: "Flatiron",
  48817: "Williamsburg",
};

function normalizeHomeLocationId(user) {
  const homeLocationData =
    user?.relationships?.home_location?.data ||
    user?.attributes?.home_location?.data ||
    null;
  const location = Array.isArray(homeLocationData)
    ? homeLocationData[0]
    : homeLocationData;
  return location?.id ? String(location.id) : null;
}

function homeStudioName(user) {
  const locationId = normalizeHomeLocationId(user);
  if (!locationId) return null;
  return LOCATION_NAMES[locationId] ?? locationId;
}

/**
 * @param {string} email
 * @returns {Promise<object>}
 */
export async function enrichApplicantFromMt(email) {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) {
    return {
      mtAccountExists: false,
      mtUserId: null,
      mtEmail: null,
      mtClassCount: null,
      mtHasCc: null,
      mtHomeStudio: null,
      mtProfileLink: null,
    };
  }

  try {
    const response = await axios.get(`${config.mt.baseUrl}/users`, {
      headers: { Authorization: `Bearer ${config.mt.apiKey}` },
      params: { email: normalized },
    });

    const user = Array.isArray(response.data?.data)
      ? response.data.data[0]
      : response.data?.data;

    if (!user) {
      return {
        mtAccountExists: false,
        mtUserId: null,
        mtEmail: null,
        mtClassCount: null,
        mtHasCc: false,
        mtHomeStudio: null,
        mtProfileLink: null,
      };
    }

    const userId = String(user.id);
    const attrs = user.attributes ?? {};
    const classCount =
      typeof attrs.completed_class_count === "number"
        ? attrs.completed_class_count
        : null;

    const mtHasCc = await hasValidBankcardOnFile(userId);

    return {
      mtAccountExists: true,
      mtUserId: userId,
      mtEmail: attrs.email ?? normalized,
      mtClassCount: classCount,
      mtHasCc,
      mtHomeStudio: homeStudioName(user),
      mtProfileLink: `https://${config.mt.tenantHost}/admin/user/profile/${userId}`,
    };
  } catch (error) {
    const message = error.response
      ? `MT ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;
    throw new Error(`Mariana Tek lookup failed for ${normalized}: ${message}`);
  }
}
