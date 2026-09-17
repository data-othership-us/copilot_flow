/**
 * Monthly Co-Pilot update email (cycle + promo + events).
 *
 *   npm run email-monthly
 *   DRY_RUN=0 npm run email-monthly -- --apply
 */
import { emailMonthlyUpdate } from "../jobs/emailMonthlyUpdate.js";

emailMonthlyUpdate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
