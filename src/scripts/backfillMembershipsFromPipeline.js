/**
 * @deprecated Membership is joined live in copilot_performance from
 * mt_membership_instances. copilot_db.membership_* columns have been dropped.
 *
 *   DRY_RUN=1 node src/scripts/backfillMembershipsFromPipeline.js
 */
console.log(
  "⏭️  backfill-memberships is a no-op — membership comes from the performance view join."
);
console.log(
  "   See bq/copilot_performance.sql (mt_membership_instances on user_id)."
);
process.exit(0);
