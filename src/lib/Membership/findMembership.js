import axios from "axios";
import dotenv from "dotenv";
import { copilotDbRef, getBigQueryClient } from "../bqConfig.js";

dotenv.config();

const bigquery = getBigQueryClient();
const MT_API_BASE_URL = process.env.MT_API_BASE_URL;
const MT_API_KEY = process.env.MT_API_KEY;
const COPILOT_DB = copilotDbRef();

if (!MT_API_BASE_URL || !MT_API_KEY) {
  console.error("Missing MT_API_BASE_URL or MT_API_KEY");
  process.exit(1);
}

/**
 * @deprecated Membership is joined in copilots.copilot_performance from
 * mt_membership_instances. copilot_db.membership_* columns have been dropped.
 */
export async function findMembership() {
  console.log("🚀 find-memberships");
  console.log(
    "⏭️  No-op — copilot_db.membership_* columns were dropped."
  );
  console.log(
    "   Membership is joined in copilots.copilot_performance from mt_membership_instances."
  );
  // Keep unused refs so the module still validates BQ/MT env without writing.
  void bigquery;
  void COPILOT_DB;
}

findMembership().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
