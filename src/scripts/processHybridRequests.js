/**
 * Process Co-Pilot hybrid requests.
 *
 *   DRY_RUN=1 npm run process-hybrid-requests
 *   DRY_RUN=0 npm run process-hybrid-requests -- --apply
 *
 * Emails the request page when an in-window session matches. A checked
 * session on that page creates the hold card and tags it Reduced. The
 * confirmation email goes out once Event Credit Link is filled.
 */
import "../config.js";
import { processHybridRequests } from "../jobs/processHybridRequests.js";

processHybridRequests()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
