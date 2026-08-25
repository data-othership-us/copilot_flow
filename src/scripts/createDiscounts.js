import { createDiscounts } from "../lib/workflows/copilots/createDiscounts.js";

createDiscounts()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
