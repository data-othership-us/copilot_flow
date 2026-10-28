/**
 * Co-Pilot menu on the Copilot base spreadsheet.
 * Refresh Review starts copilot-evaluate-copilots the same way the 9:30am
 * schedule does: rebuild Review and Add to Modash, then apply decisions
 * that are due.
 */
const JOB_URL =
  "https://run.googleapis.com/v2/projects/marianatek-webhooks/locations/us-central1/jobs/copilot-evaluate-copilots";
const DEFAULT_ARGS = ["src/scripts/evaluateCopilots.js"];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Co-Pilot")
    .addItem("Refresh Review", "refreshReview")
    .addItem("Refresh status", "refreshStatus")
    .addToUi();
}

function refreshReview() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(
    "Refresh Review",
    "Rebuild Review and Add to Modash, then apply decisions that are due. That updates Mariana Tek and sends emails. Renew, upgrade, downgrade, offboard, and never again still wait until the last day. This usually takes a few minutes.",
    ui.ButtonSet.OK_CANCEL,
  );
  if (ok !== ui.Button.OK) return;

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) {
    ui.alert(
      "Refresh Review",
      "Another refresh is already starting. Check Refresh status in a moment.",
      ui.ButtonSet.OK,
    );
    return;
  }
  try {
    const running = listExecutions_().find((execution) => !execution.completionTime);
    if (running) {
      ui.alert("Refresh Review", describeExecution_(running), ui.ButtonSet.OK);
      return;
    }
    startRefresh_();
    SpreadsheetApp.getActive().toast(
      "Review job started. It rebuilds the tabs and applies decisions that are due. Check Refresh status, then reload when it finishes.",
      "Co-Pilot",
      10,
    );
  } catch (error) {
    showError_(error);
  } finally {
    lock.releaseLock();
  }
}

function refreshStatus() {
  const ui = SpreadsheetApp.getUi();
  try {
    const executions = listExecutions_();
    if (!executions.length) {
      ui.alert("Refresh status", "No refresh has run yet.", ui.ButtonSet.OK);
      return;
    }
    const latest = executions.slice().sort(byNewest_)[0];
    ui.alert("Refresh status", describeExecution_(latest), ui.ButtonSet.OK);
  } catch (error) {
    showError_(error);
  }
}

function startRefresh_() {
  const args = currentArgs_().filter((arg) => arg !== "--skip-apply");
  return api_("post", JOB_URL + ":run", {
    overrides: {
      containerOverrides: [
        {
          args,
          env: [
            { name: "EVALUATE_SKIP_APPLY", value: "0" },
            { name: "DRY_RUN", value: "0" },
          ],
        },
      ],
    },
  });
}

function currentArgs_() {
  try {
    const job = api_("get", JOB_URL);
    const containers =
      (job.template &&
        job.template.template &&
        job.template.template.containers) ||
      [];
    const args = containers[0] && containers[0].args;
    if (args && args.length) return args.slice();
  } catch (error) {
    // Fall back to the deployed entrypoint.
  }
  return DEFAULT_ARGS.slice();
}

function listExecutions_() {
  const data = api_("get", JOB_URL + "/executions?pageSize=10");
  return data.executions || [];
}

function byNewest_(a, b) {
  const aTime = Date.parse(a.createTime || a.startTime || 0);
  const bTime = Date.parse(b.createTime || b.startTime || 0);
  return bTime - aTime;
}

function describeExecution_(execution) {
  const id = String(execution.name || "").split("/").pop();
  const when = formatWhen_(
    execution.completionTime || execution.startTime || execution.createTime,
  );
  if (!execution.completionTime) {
    return "Running (" + id + ") since " + when + ".";
  }
  if ((execution.succeededCount || 0) > 0) {
    return (
      "Finished (" +
      id +
      ") at " +
      when +
      ". Reload the Review tab to see the new rows."
    );
  }
  const logs = execution.logUri ? "\n\nLogs: " + execution.logUri : "";
  return "Failed (" + id + ") at " + when + "." + logs;
}

function formatWhen_(iso) {
  if (!iso) return "an unknown time";
  return (
    Utilities.formatDate(
      new Date(iso),
      "America/New_York",
      "MMM d, h:mm a",
    ) + " ET"
  );
}

function api_(method, url, body) {
  const options = {
    method,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (body) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const text = res.getContentText() || "";
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = {};
  }
  if (code < 200 || code >= 300) {
    const message =
      (data.error && data.error.message) ||
      text.slice(0, 400) ||
      "HTTP " + code;
    const err = new Error(message);
    err.code = code;
    throw err;
  }
  return data;
}

function showError_(error) {
  const ui = SpreadsheetApp.getUi();
  if (error && error.code === 403) {
    ui.alert(
      "Need Cloud Run access",
      "This Google account cannot run copilot-evaluate-copilots. It needs permission to run that job with overrides (Cloud Run Developer).",
      ui.ButtonSet.OK,
    );
    return;
  }
  ui.alert("Refresh failed", (error && error.message) || String(error), ui.ButtonSet.OK);
}
