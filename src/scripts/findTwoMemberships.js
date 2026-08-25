import { findTwoMemberships } from "../lib/workflows/copilots/findTwoMemberships.js";

findTwoMemberships()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
