/**
 * One-time: email active copilots with live memberships who need to
 * resubmit social handles.
 *
 *   npm run email-resubmit-handles
 *   DRY_RUN=0 npm run email-resubmit-handles -- --apply
 */
import { emailResubmitHandles } from "../jobs/emailResubmitHandles.js";

emailResubmitHandles()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
