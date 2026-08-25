import { syncCopilotDb } from "../jobs/syncCopilotDb.js";

const skipViews = process.argv.includes("--skip-views");

syncCopilotDb({ applyViews: !skipViews }).catch((error) => {
  console.error(error);
  process.exit(1);
});
