import { onboardCopilots } from "../jobs/onboardCopilots.js";

onboardCopilots().catch((error) => {
  console.error(error);
  process.exit(1);
});
