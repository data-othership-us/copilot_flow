/**
 * One-time OAuth for the Co-Pilot Gmail mailbox.
 *
 * Usage:
 *   1. Set GMAIL_API_CLIENT_ID + GMAIL_API_CLIENT_SECRET in .env
 *      (Desktop / Web OAuth client; redirect URI must include http://127.0.0.1:53682/oauth2callback)
 *   2. npm run gmail-oauth
 *   3. Sign in as the Co-Pilot sending account (not a personal/Robbie account unless intended)
 *   4. Paste GMAIL_REFRESH_TOKEN_COPILOT=... into .env
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const PORT = Number(process.env.GMAIL_OAUTH_PORT || 53682);
const REDIRECT_URI =
  process.env.GMAIL_OAUTH_REDIRECT_URI ||
  `http://127.0.0.1:${PORT}/oauth2callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

const clientId = String(process.env.GMAIL_API_CLIENT_ID || "").trim();
const clientSecret = String(process.env.GMAIL_API_CLIENT_SECRET || "").trim();

if (!clientId || !clientSecret) {
  console.error(
    "Missing GMAIL_API_CLIENT_ID / GMAIL_API_CLIENT_SECRET in .env"
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // user can open manually
  }
}

console.log("\n🔐 Co-Pilot Gmail OAuth");
console.log("   Sign in with the Co-Pilot sending mailbox.");
console.log(`   Redirect URI (must be allowed on the OAuth client):\n   ${REDIRECT_URI}`);
console.log("\n   Opening browser…\n");
console.log(authUrl);
console.log("");
openBrowser(authUrl);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const err = url.searchParams.get("error");
    if (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`OAuth error: ${err}`);
      console.error("❌ OAuth error:", err);
      server.close();
      process.exit(1);
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code");
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    const refresh = tokens.refresh_token;
    if (!refresh) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<p>No refresh_token returned. Revoke prior grants for this client and retry with prompt=consent.</p>"
      );
      console.error(
        "❌ No refresh_token. Revoke access at https://myaccount.google.com/permissions then re-run."
      );
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<p>Success — refresh token printed in the terminal. You can close this tab.</p>"
    );

    console.log("\n✅ Paste into .env:\n");
    console.log(`GMAIL_REFRESH_TOKEN_COPILOT=${refresh}`);
    console.log("");
    if (tokens.access_token) {
      console.log("(access_token also received; not needed in .env)");
    }

    server.close();
    process.exit(0);
  } catch (error) {
    console.error("❌ Token exchange failed:", error.message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(error.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`   Listening on ${REDIRECT_URI}`);
});
