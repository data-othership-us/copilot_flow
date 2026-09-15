import { backfillPromoCodes } from "../jobs/backfillPromoCodes.js";

backfillPromoCodes()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
