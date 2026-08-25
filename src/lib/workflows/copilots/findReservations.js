import fs from "fs";
import dayjs from "dayjs";
import dotenv from "dotenv";
import { copilotDbRef, getBigQueryClient } from "../bqConfig.js";
import { MT_API_BASE_URL, MT_API_KEY } from "../coPilotConstants.js";

dotenv.config();

const CUTOFF_DATE = process.env.RESERVATION_CUTOFF_DATE || "2025-12-01";
const OUTPUT_FILE = process.env.RESERVATION_OUTPUT_FILE || "./future_reservations.txt";

const bigquery = getBigQueryClient();
const COPILOT_DB = copilotDbRef();

async function getTerminatingMemberships() {
  const query = `
    WITH membership_from_pipeline AS (
      SELECT * EXCEPT (rn) FROM (
        SELECT
          CAST(user_id AS STRING) AS user_id,
          CAST(membership_instance_id AS STRING) AS membership_instance_id,
          status AS membership_status,
          COALESCE(cancelled_at, next_charge_date) AS membership_end,
          ROW_NUMBER() OVER (
            PARTITION BY CAST(user_id AS STRING)
            ORDER BY
              CASE
                WHEN REGEXP_CONTAINS(LOWER(IFNULL(membership_name, '')), r'co[\\s-]?pilot')
                THEN 0 ELSE 1
              END,
              started_at DESC NULLS LAST
          ) AS rn
        FROM \`data-pipeline-492715.core.mt_membership_instances\`
        WHERE user_id IS NOT NULL
      )
      WHERE rn = 1
    )
    SELECT
      c.mt_email,
      c.user_id,
      m.membership_instance_id,
      m.membership_status,
      m.membership_end
    FROM ${COPILOT_DB} AS c
    JOIN membership_from_pipeline AS m
      ON m.user_id = CAST(c.user_id AS STRING)
    WHERE m.membership_end < TIMESTAMP('${CUTOFF_DATE}')
  `;

  const [rows] = await bigquery.query({ query });
  return rows.map((row) => ({
    email: row.mt_email,
    userId: row.user_id,
    membershipId: row.membership_instance_id,
    membershipStatus: row.membership_status,
    endDate: row.membership_end,
  }));
}

async function getReservationsForMembership(membershipId) {
  try {
    const resp = await fetch(
      `${MT_API_BASE_URL}/reservations?filter[membership_id]=${membershipId}`,
      {
        headers: {
          Authorization: `Bearer ${MT_API_KEY}`,
          Accept: "application/vnd.api+json",
        },
      }
    );

    if (!resp.ok) {
      const t = await resp.text();
      console.warn(`Reservations fetch failed for membership ${membershipId}: ${t}`);
      return [];
    }

    const data = await resp.json();
    return data.data || [];
  } catch (err) {
    console.warn(`Error fetching reservations for membership ${membershipId}: ${err.message}`);
    return [];
  }
}

function writeMembershipEntry(member, reservations = []) {
  const header = `
Name: ${member.email}
User ID: ${member.userId}
Membership ID: ${member.membershipId}
Membership Status: ${member.membershipStatus}
Membership Ends: ${dayjs(member.endDate).format("YYYY-MM-DD")}
`;

  fs.appendFileSync(OUTPUT_FILE, header, "utf8");

  if (reservations.length === 0) {
    fs.appendFileSync(
      OUTPUT_FILE,
      `No future reservations found.\n--------------------------------------------------\n`,
      "utf8"
    );
  } else {
    for (const r of reservations) {
      const start = r.attributes.start_datetime;
      const className = r.attributes.class_name || "Unknown";
      const location = r.attributes.location_name || "Unknown";

      if (dayjs(start).isAfter(CUTOFF_DATE)) {
        const line = `Reservation ID: ${r.id}\nClass: ${className}\nDate: ${start}\nLocation: ${location}\n--------------------------------------------------\n`;
        fs.appendFileSync(OUTPUT_FILE, line, "utf8");
      }
    }
  }
}

export async function findReservations() {
  console.log("Loading terminating memberships from BigQuery...");

  const memberships = await getTerminatingMemberships();
  console.log(`Found ${memberships.length} memberships ending before ${CUTOFF_DATE}`);

  fs.writeFileSync(OUTPUT_FILE, `FUTURE RESERVATIONS AFTER ${CUTOFF_DATE}\n\n`, "utf8");

  for (const member of memberships) {
    console.log(`Checking membership ${member.membershipId} (${member.email})...`);

    const reservations = await getReservationsForMembership(member.membershipId);
    writeMembershipEntry(member, reservations);
  }

  console.log(`\nDone! Saved to ${OUTPUT_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  findReservations().catch((err) => {
    console.error("ERROR:", err);
    process.exit(1);
  });
}
