import { evaluateCopilots } from "../jobs/evaluateCopilots.js";

evaluateCopilots().catch((error) => {
  console.error(error);
  process.exit(1);
});
