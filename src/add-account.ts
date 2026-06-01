#!/usr/bin/env node
/**
 * CLI to manage connected Gmail accounts via OAuth.
 *
 *   npm run add-account            Connect a new account (opens browser consent)
 *   npm run list-accounts          List connected accounts and their cred files
 *   npm run remove-account <email> Remove a connected account
 *
 * Multiple OAuth clients are supported: drop several credential files in the
 * data dir (credentials.json, credentials2.json, ...). When more than one is
 * present, add-account asks which to use. Each account records the credential
 * file it was authorized with, so token refresh later uses the right client.
 *
 * Tokens are stored per account email in <dataDir>/tokens.json.
 */

import http from "http";
import readline from "readline";
import { AddressInfo } from "net";
import { URL } from "url";
import { google } from "googleapis";
import open from "open";
import {
  accountCredentials,
  cleanupStaleTokenTemps,
  credentialsRefFor,
  listAccounts,
  loadTokens,
  newOAuthClient,
  removeAccount,
  saveAccount,
} from "./auth.js";
import {
  OAUTH_REDIRECT_PORT,
  SCOPES,
  credentialsFiles,
  isMainModule,
  oauthRedirectUri,
} from "./constants.js";

/** Minutes to wait for the user to complete Google consent before giving up. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Escape text for safe interpolation into the loopback callback HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Listen on the preferred port, falling back to an OS-assigned ephemeral port
 * if it's already in use. Resolves with the port actually bound.
 */
export function listenWithFallback(
  server: http.Server,
  preferredPort: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const boundPort = () => (server.address() as AddressInfo).port;
    const onFirstError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.once("error", reject);
        server.listen(0, () => resolve(boundPort()));
      } else {
        reject(err);
      }
    };
    server.once("error", onFirstError);
    server.listen(preferredPort, () => {
      server.removeListener("error", onFirstError);
      server.once("error", reject);
      resolve(boundPort());
    });
  });
}

function printAccounts(): void {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log("No accounts connected. Run `npm run add-account` to add one.");
    return;
  }
  const creds = accountCredentials();
  console.log(`Connected accounts (${accounts.length}):`);
  for (const a of accounts) console.log(`  - ${a}  [${creds[a]}]`);
}

/** Prompt the user to choose one credential file from a list. */
async function chooseCredentialFile(files: string[]): Promise<string> {
  if (files.length === 1) return files[0];
  console.log("\nMultiple OAuth credential files found. Choose one to use:");
  files.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) =>
        rl.question(`Enter a number (1-${files.length}): `, resolve)
      );
      const n = parseInt(answer.trim(), 10);
      if (Number.isInteger(n) && n >= 1 && n <= files.length) {
        return files[n - 1];
      }
      console.log("Invalid selection, try again.");
    }
  } finally {
    rl.close();
  }
}

/** Run the loopback OAuth consent flow and persist tokens keyed by email. */
async function addAccount(): Promise<void> {
  const files = credentialsFiles();
  if (files.length === 0) {
    throw new Error(
      "No OAuth credential files found. Save at least one OAuth 'Desktop app' " +
        "client JSON in the data dir (e.g. credentials.json), or set " +
        "GMAIL_OAUTH_CREDENTIALS, then retry."
    );
  }
  const credFile = await chooseCredentialFile(files);
  console.log(`Using credential file: ${credFile}`);

  // Capture the auth code delivered to the loopback callback.
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const serverHttp = http.createServer((req, res) => {
    try {
      if (!req.url) return;
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (err || !authCode) {
        res.end(
          `<h2>Authorization failed</h2><p>${escapeHtml(
            err || "No code returned."
          )}</p>`
        );
        serverHttp.close();
        rejectCode(new Error(err || "No authorization code returned."));
        return;
      }
      res.end(
        "<h2>Account connected.</h2><p>You can close this tab and return to the terminal.</p>"
      );
      serverHttp.close();
      resolveCode(authCode);
    } catch (e) {
      serverHttp.close();
      rejectCode(e instanceof Error ? e : new Error(String(e)));
    }
  });

  // Bind first so we know the actual port, then build the redirect URI and
  // auth URL to match it.
  const port = await listenWithFallback(serverHttp, OAUTH_REDIRECT_PORT);
  const oAuth2Client = newOAuthClient(credFile, oauthRedirectUri(port));
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline", // request a refresh token
    prompt: "consent", // force refresh-token issuance on re-consent
    scope: SCOPES,
  });

  if (port !== OAUTH_REDIRECT_PORT) {
    console.log(`Port ${OAUTH_REDIRECT_PORT} was busy; listening on ${port}.`);
  }
  console.log("Opening browser for Google consent...");
  console.log(`If it doesn't open, visit:\n${authUrl}\n`);
  void open(authUrl);

  // Wait for Google to redirect back to our loopback server with the code, but
  // don't hang forever if the user abandons consent.
  const timeout = setTimeout(() => {
    serverHttp.close();
    rejectCode(
      new Error(
        `Timed out after ${
          CONSENT_TIMEOUT_MS / 60000
        } minutes waiting for Google consent. Re-run and complete sign-in in the browser.`
      )
    );
  }, CONSENT_TIMEOUT_MS);
  let code: string;
  try {
    code = await codePromise;
  } finally {
    clearTimeout(timeout);
  }

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Identify which account just authorized.
  const oauth2 = google.oauth2({ version: "v2", auth: oAuth2Client });
  const me = await oauth2.userinfo.get();
  const email = (me.data.email || "").toLowerCase();
  if (!email) throw new Error("Could not determine the account email.");

  // Preserve an existing refresh token if Google didn't return a new one.
  const existing = loadTokens()[email];
  if (existing?.tokens.refresh_token && !tokens.refresh_token) {
    tokens.refresh_token = existing.tokens.refresh_token;
  }

  await saveAccount(email, tokens, credentialsRefFor(credFile));
  console.log(`\nConnected: ${email}  [${credentialsRefFor(credFile)}]`);
  printAccounts();
}

async function main(): Promise<void> {
  cleanupStaleTokenTemps();
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    printAccounts();
    return;
  }
  if (args.includes("--remove")) {
    const email =
      args[args.indexOf("--remove") + 1] || args.find((a) => a.includes("@"));
    if (!email) {
      console.error("Usage: npm run remove-account <email>");
      process.exit(1);
    }
    console.log(
      (await removeAccount(email))
        ? `Removed ${email}.`
        : `${email} was not connected.`
    );
    return;
  }
  await addAccount();
}

// Only run the CLI when invoked directly (not when imported, e.g. by tests).
if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
