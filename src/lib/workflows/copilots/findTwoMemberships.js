import axios from "axios";
import dotenv from "dotenv";
import {
  copilotDbRef,
  copilotMembershipsRef,
  getBigQueryClient,
} from "../../bqConfig.js";

dotenv.config();

const bigquery = getBigQueryClient();
const MT_API_BASE_URL = process.env.MT_API_BASE_URL;
const MT_API_KEY = process.env.MT_API_KEY;
const COPILOT_DB = copilotDbRef();
const COPILOT_MEMBERSHIPS = copilotMembershipsRef();

if (!MT_API_BASE_URL || !MT_API_KEY) {
  console.error("Missing MT_API_BASE_URL or MT_API_KEY");
  process.exit(1);
}

/* ---------- API helpers ---------- */

async function getLatestTwoMemberships(userId) {
    try {
        const response = await axios.get(`${MT_API_BASE_URL}/membership_instances`, {
            headers: { Authorization: `Bearer ${MT_API_KEY}` },
            params: {
                user: parseInt(userId),
            }
        });
        
        // Sort by calculated_start_datetime descending (most recently started first) 
        // If start dates are equal, fall back to ID descending (newest ID first)
        const sortedMemberships = response.data?.data?.sort((a, b) => {
            const dateA = new Date(a.attributes.calculated_start_datetime || 0);
            const dateB = new Date(b.attributes.calculated_start_datetime || 0);
            if (dateB.getTime() !== dateA.getTime()) {
                return dateB - dateA; // Most recently started first
            }
            // If start dates are equal, sort by ID descending (newest first)
            return parseInt(b.id || 0) - parseInt(a.id || 0);
        }) || [];
        
        const latest = sortedMemberships[0] || null;
        const second = sortedMemberships[1] || null;
        
        return { latest, second };
    } catch (error) {
        console.error(`Error details:`, error.response?.data || error);
        return { latest: null, second: null };
    }
}

/* ---------- BigQuery helpers ---------- */
async function getUserIds() {
  const [rows] = await bigquery.query({
    query: `
      SELECT DISTINCT CAST(user_id AS STRING) AS user_id
      FROM ${COPILOT_DB}
      WHERE user_id IS NOT NULL AND CAST(user_id AS STRING) != ''
    `,
  });
  return rows.map(r => String(r.user_id));
}

// Convert UTC timestamp string to EST
function convertToEST(utcTimestamp) {
  if (!utcTimestamp) return null;
  const date = new Date(utcTimestamp);
  // Convert to Eastern time (America/New_York) using Intl.DateTimeFormat
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  let hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const second = parts.find(p => p.type === 'second').value;
  // Fix hour 24 to 00 (midnight)
  if (hour === '24') {
    hour = '00';
  }
  // Format as ISO string for BigQuery
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

async function updateRow(userId, latestMembership, secondMembership) {
  // Helper function to extract membership data
  function extractMembershipData(membership) {
    if (!membership) return null;
    return {
      instance_id: membership?.id ? String(membership.id) : null,
      name: membership?.attributes?.membership_name ?? null,
      start: membership?.attributes?.calculated_start_datetime ?? null,
      end: membership?.attributes?.payment_interval_end_date ?? null,
      status: membership?.attributes?.status ?? null,
    };
  }

  const latest = extractMembershipData(latestMembership);
  const second = extractMembershipData(secondMembership);

  // nothing to write? skip
  if (!latest && !second) return;

  // Convert timestamps to EST
  const latest_start_est = convertToEST(latest?.start);
  const latest_end_est = convertToEST(latest?.end);
  const second_start_est = convertToEST(second?.start);
  const second_end_est = convertToEST(second?.end);

  // Escape values
  const escapedUserId = String(userId).replace(/'/g, "''");
  
  // Latest membership fields
  const latest_instance_id = latest?.instance_id ? `'${String(latest.instance_id).replace(/'/g, "''")}'` : 'NULL';
  const latest_name = latest?.name ? `'${String(latest.name).replace(/'/g, "''")}'` : 'NULL';
  const latest_status = latest?.status ? `'${String(latest.status).replace(/'/g, "''")}'` : 'NULL';
  const latest_start = latest_start_est ? `CAST('${latest_start_est}' AS TIMESTAMP)` : 'NULL';
  const latest_end = latest_end_est ? `CAST('${latest_end_est}' AS TIMESTAMP)` : 'NULL';
  
  // Second membership fields
  const second_instance_id = second?.instance_id ? `'${String(second.instance_id).replace(/'/g, "''")}'` : 'NULL';
  const second_name = second?.name ? `'${String(second.name).replace(/'/g, "''")}'` : 'NULL';
  const second_status = second?.status ? `'${String(second.status).replace(/'/g, "''")}'` : 'NULL';
  const second_start = second_start_est ? `CAST('${second_start_est}' AS TIMESTAMP)` : 'NULL';
  const second_end = second_end_est ? `CAST('${second_end_est}' AS TIMESTAMP)` : 'NULL';

  const query = `
    UPDATE ${COPILOT_MEMBERSHIPS}
    SET
      latest_membo = ${latest_name},
      latest_membo_start = ${latest_start},
      latest_membo_end = ${latest_end},
      latest_membo_status = ${latest_status},
      latest_membeo_instance_id = ${latest_instance_id},
      second_membo = ${second_name},
      second_membo_start = ${second_start},
      second_membo_end = ${second_end},
      second_membo_status = ${second_status},
      second_membeo_instance_id = ${second_instance_id}
    WHERE CAST(user_id AS STRING) = '${escapedUserId}'
  `;

  try {
    await bigquery.query({ query });
  } catch (error) {
    console.error(`Error updating row for user ${userId}:`, error.message);
    throw error;
  }
}

/* ---------- Main ---------- */
export async function findTwoMemberships() {
  console.log("🚀 Starting two membership lookup and update process...");

  const userIds = await getUserIds();
  console.log(`📊 Users to process: ${userIds.length}`);

  let updated = 0, missing = 0;

  for (const uid of userIds) {
    console.log(`Processing user ${uid}...`);
        
    // Get latest two memberships from API
    const { latest, second } = await getLatestTwoMemberships(uid);
    
    if (latest || second) {
      const latestName = latest?.attributes?.membership_name || 'None';
      const secondName = second?.attributes?.membership_name || 'None';
      console.log(`  ✅ Updating with memberships:`);
      console.log(`     Latest: ${latest?.id || 'N/A'} - ${latestName}`);
      console.log(`     Second: ${second?.id || 'N/A'} - ${secondName}`);
      await updateRow(uid, latest, second);
      updated++;
      
      // Small delay to avoid concurrent update errors
      await new Promise(resolve => setTimeout(resolve, 100));
    } else {
      console.log(`  ❌ Failed to get API details for user ${uid}`);
      missing++;
    }
  }

  console.log("✅ Done.");
  console.log(`   Updated: ${updated}`);
  console.log(`   No membership found: ${missing}`);
}

/* ---------- Entrypoint ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  findTwoMemberships().catch(err => {
    console.error("Failed:", err);
    process.exit(1);
  });
}

// getLatestMembership("123428").then(latestMembership => {
//     updateRow("123428", latestMembership).catch(err => {
//         console.error("Failed:", err);
//         process.exit(1);
//     });
// }).catch(err => {
//     console.error("Failed:", err);
//     process.exit(1);
// });