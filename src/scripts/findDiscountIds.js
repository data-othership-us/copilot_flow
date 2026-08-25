import { findDiscountIds } from "../lib/workflows/copilots/findDiscountIds.js";

const dryRun = process.env.DRY_RUN === "1";

findDiscountIds({ dryRun })
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
