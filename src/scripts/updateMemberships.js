import { updateMemberships } from "../lib/workflows/copilots/updateMemberships.js";

updateMemberships()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
