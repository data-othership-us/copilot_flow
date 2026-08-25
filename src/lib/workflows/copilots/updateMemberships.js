import dotenv from "dotenv";
import { setMembershipEnd } from "../../Membership/setMembershipEnd.js";
import { copilotMembershipsRef, getBigQueryClient } from "../../bqConfig.js";

dotenv.config();

const bigquery = getBigQueryClient();
const COPILOT_MEMBERSHIPS = copilotMembershipsRef();

// Memberships to end now
const MEMBERSHIPS_TO_END = [
  "Toronto Co-pilot Annual Weekly",
  "Co-Pilot Bi-Weekly",
  "Co-Pilot Weekly",
  "NY Co-Pilot Bi-Weekly",
  "NY Co-pilot Annual Weekly",
  "NY Co-pilot Weekly",
];


/* ---------- Main Function ---------- */
export async function updateMemberships() {
  console.log("🚀 Starting membership update process...");

  // Track counts for summary
  let endedCount = 0;
  let errorCount = 0;
  
  // Collect instance IDs that need to be cancelled
  const instanceIdsToCancel = [];

  try {
    // Step 1: Query BigQuery for all rows with user_id not null
    console.log("📊 Querying BigQuery for all rows with user_id...");
    const query = `
      SELECT *
      FROM ${COPILOT_MEMBERSHIPS}
      WHERE user_id IS NOT NULL
    `;

    const [rows] = await bigquery.query({ query });
    console.log(`✅ Found ${rows.length} rows to process`);

    // Step 2: First pass - Collect all matching memberships
    console.log("\n📋 Step 1: Collecting matching memberships...");
    for (const row of rows) {
      const userId = String(row.user_id);
      const latestMembo = row.latest_membo || "";
      const secondMembo = row.second_membo || "";
      const latestStatus = row.latest_membo_status || "";
      const secondStatus = row.second_membo_status || "";
      const latestInstanceId = row.latest_membeo_instance_id || null;
      const secondInstanceId = row.second_membeo_instance_id || null;

      // Check if latest membership matches and is active
      const latestMatches = MEMBERSHIPS_TO_END.some((name) =>
        latestMembo.toLowerCase().includes(name.toLowerCase())
      );
      const latestIsActive = latestStatus.toLowerCase() === "active";

      // Check if second membership matches and is active
      const secondMatches = MEMBERSHIPS_TO_END.some((name) =>
        secondMembo.toLowerCase().includes(name.toLowerCase())
      );
      const secondIsActive = secondStatus.toLowerCase() === "active";

      // Collect matching memberships
      if (latestMatches && latestIsActive && latestInstanceId) {
        instanceIdsToCancel.push({
          instanceId: latestInstanceId,
          userId: userId,
          membershipName: latestMembo,
          status: latestStatus,
          type: "latest"
        });
      }

      if (secondMatches && secondIsActive && secondInstanceId) {
        instanceIdsToCancel.push({
          instanceId: secondInstanceId,
          userId: userId,
          status: secondStatus,
          membershipName: secondMembo,
          type: "second"
        });
      }
    }

    // Log the list of matching memberships
    console.log(`\n📋 Found ${instanceIdsToCancel.length} matching memberships to end:`);
    instanceIdsToCancel.forEach((item, index) => {
      console.log(`  ${index + 1}. User ${item.userId} - ${item.membershipName} (${item.type}, Instance ID: ${item.instanceId})`);
    });

    // Step 3: Second pass - Actually end the memberships
    console.log(`\n🔚 Step 2: Ending ${instanceIdsToCancel.length} memberships...`);
    for (const item of instanceIdsToCancel) {
      try {
        console.log(`\n📝 Processing user ${item.userId}...`);
        console.log(`  🔚 Ending ${item.type} membership: ${item.membershipName} (${item.instanceId})`);
        
        const result = await setMembershipEnd(item.instanceId);
        if (result) {
          endedCount++;
          console.log(`  ✅ Successfully ended ${item.type} membership: ${item.membershipName}`);
        } else {
          errorCount++;
          console.error(`  ❌ Failed to end ${item.type} membership: ${item.membershipName}`);
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        errorCount++;
        console.error(`  ❌ Error ending membership for user ${item.userId}:`, error.message);
      }
    }

    // Step 4: Log summary
    console.log("\n✅ Update process completed!");
    console.log(`   Total rows processed: ${rows.length}`);
    console.log(`   Memberships ended: ${endedCount}`);
    console.log(`   Errors: ${errorCount}`);
    console.log(`\n📋 Full details of memberships to cancel:`);
    console.log(JSON.stringify(instanceIdsToCancel, null, 2));
    console.log(`\n📋 User IDs and Instance IDs pairs:`);
    const userIdInstanceIdPairs = instanceIdsToCancel.map(item => ({
      user_id: item.userId,
      membership_instance_id: item.instanceId
    }));
    console.log(JSON.stringify(userIdInstanceIdPairs, null, 2));

    return {
      totalRows: rows.length,
      endedMemberships: endedCount,
      errors: errorCount,
      instanceIdsToCancel: instanceIdsToCancel,
      userIdInstanceIdPairs: userIdInstanceIdPairs,
    };
  } catch (error) {
    console.error("❌ Fatal error in updateMemberships:", error);
    throw error;
  }
}

/* ---------- Entrypoint ---------- */
// Uncomment to run directly
// updateMemberships().catch((err) => {
//   console.error("Failed:", err);
//   process.exit(1);
// });

