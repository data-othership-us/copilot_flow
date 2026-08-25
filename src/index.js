import { evaluateApplications } from "./jobs/evaluateApplications.js";

evaluateApplications().catch((error) => {
  console.error(error);
  process.exit(1);
});
