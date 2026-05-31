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
import { URL } from "url";
import { google } from "googleapis";
import open from "open";
import { accountCredentials, credentialsRefFor, listAccounts, loadTokens, newOAuthClient, removeAccount, saveAccount, } from "./auth.js";
import { OAUTH_REDIRECT_PORT, SCOPES, credentialsFiles, } from "./constants.js";
function printAccounts() {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        console.log("No accounts connected. Run `npm run add-account` to add one.");
        return;
    }
    const creds = accountCredentials();
    console.log(`Connected accounts (${accounts.length}):`);
    for (const a of accounts)
        console.log(`  - ${a}  [${creds[a]}]`);
}
/** Prompt the user to choose one credential file from a list. */
async function chooseCredentialFile(files) {
    if (files.length === 1)
        return files[0];
    console.log("\nMultiple OAuth credential files found. Choose one to use:");
    files.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        while (true) {
            const answer = await new Promise((resolve) => rl.question(`Enter a number (1-${files.length}): `, resolve));
            const n = parseInt(answer.trim(), 10);
            if (Number.isInteger(n) && n >= 1 && n <= files.length) {
                return files[n - 1];
            }
            console.log("Invalid selection, try again.");
        }
    }
    finally {
        rl.close();
    }
}
/** Run the loopback OAuth consent flow and persist tokens keyed by email. */
async function addAccount() {
    const files = credentialsFiles();
    if (files.length === 0) {
        throw new Error("No OAuth credential files found. Save at least one OAuth 'Desktop app' " +
            "client JSON in the data dir (e.g. credentials.json), or set " +
            "GMAIL_OAUTH_CREDENTIALS, then retry.");
    }
    const credFile = await chooseCredentialFile(files);
    console.log(`Using credential file: ${credFile}`);
    const oAuth2Client = newOAuthClient(credFile);
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline", // request a refresh token
        prompt: "consent", // force refresh-token issuance on re-consent
        scope: SCOPES,
    });
    // Wait for Google to redirect back to our loopback server with the code.
    const code = await new Promise((resolve, reject) => {
        const serverHttp = http.createServer((req, res) => {
            try {
                if (!req.url)
                    return;
                const url = new URL(req.url, `http://localhost:${OAUTH_REDIRECT_PORT}`);
                if (url.pathname !== "/oauth2callback") {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                const err = url.searchParams.get("error");
                const authCode = url.searchParams.get("code");
                res.writeHead(200, { "Content-Type": "text/html" });
                if (err || !authCode) {
                    res.end(`<h2>Authorization failed</h2><p>${err || "No code returned."}</p>`);
                    serverHttp.close();
                    reject(new Error(err || "No authorization code returned."));
                    return;
                }
                res.end("<h2>Account connected.</h2><p>You can close this tab and return to the terminal.</p>");
                serverHttp.close();
                resolve(authCode);
            }
            catch (e) {
                serverHttp.close();
                reject(e);
            }
        });
        serverHttp.listen(OAUTH_REDIRECT_PORT, () => {
            console.log("Opening browser for Google consent...");
            console.log(`If it doesn't open, visit:\n${authUrl}\n`);
            void open(authUrl);
        });
        serverHttp.on("error", reject);
    });
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    // Identify which account just authorized.
    const oauth2 = google.oauth2({ version: "v2", auth: oAuth2Client });
    const me = await oauth2.userinfo.get();
    const email = (me.data.email || "").toLowerCase();
    if (!email)
        throw new Error("Could not determine the account email.");
    // Preserve an existing refresh token if Google didn't return a new one.
    const existing = loadTokens()[email];
    if (existing?.tokens.refresh_token && !tokens.refresh_token) {
        tokens.refresh_token = existing.tokens.refresh_token;
    }
    saveAccount(email, tokens, credentialsRefFor(credFile));
    console.log(`\nConnected: ${email}  [${credentialsRefFor(credFile)}]`);
    printAccounts();
}
async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--list")) {
        printAccounts();
        return;
    }
    if (args.includes("--remove")) {
        const email = args[args.indexOf("--remove") + 1] || args.find((a) => a.includes("@"));
        if (!email) {
            console.error("Usage: npm run remove-account <email>");
            process.exit(1);
        }
        console.log(removeAccount(email) ? `Removed ${email}.` : `${email} was not connected.`);
        return;
    }
    await addAccount();
}
main().catch((error) => {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
});
//# sourceMappingURL=add-account.js.map