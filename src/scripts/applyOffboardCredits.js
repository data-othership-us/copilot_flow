/**
 * One-time offboarding credit apply.
 *
 *   npm run apply-offboard-credits
 *   DRY_RUN=0 npm run apply-offboard-credits -- --apply
 */
import { applyOffboardCredits } from "../jobs/applyOffboardCredits.js";

applyOffboardCredits().catch((error) => {
  console.error(error);
  process.exit(1);
});
