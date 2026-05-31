import fs from "fs";
import os from "os";
import path from "path";
/** Maximum response size in characters before truncation. */
export const CHARACTER_LIMIT = 25000;
/** Gmail OAuth scopes. Covers read, compose/send, and label management. */
export const SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify", // read + labels + drafts
    "https://www.googleapis.com/auth/gmail.send", // send
    "https://www.googleapis.com/auth/gmail.compose", // drafts
    "https://www.googleapis.com/auth/userinfo.email", // identify the account
];
/**
 * Directory where per-account tokens and the OAuth client credentials live.
 * Override with GMAIL_MCP_DATA_DIR. Defaults to ~/.gmail-mcp.
 */
export function dataDir() {
    return process.env.GMAIL_MCP_DATA_DIR || path.join(os.homedir(), ".gmail-mcp");
}
/**
 * Path to the default OAuth client credentials JSON. Override with
 * GMAIL_OAUTH_CREDENTIALS. Defaults to <dataDir>/credentials.json. Used as the
 * fallback credential for accounts that predate per-account credential files.
 */
export function credentialsPath() {
    return (process.env.GMAIL_OAUTH_CREDENTIALS || path.join(dataDir(), "credentials.json"));
}
/**
 * Discover all OAuth client credential files available for connecting accounts.
 *
 * - If GMAIL_OAUTH_CREDENTIALS is set, that single file is the only candidate.
 * - Otherwise every file in the data dir matching `credentials*.json` is
 *   returned (e.g. credentials.json, credentials2.json, credentials-work.json),
 *   sorted by name. Each may be a distinct OAuth client (different
 *   client_id/secret), which is why accounts record which one they used.
 */
export function credentialsFiles() {
    if (process.env.GMAIL_OAUTH_CREDENTIALS) {
        return [process.env.GMAIL_OAUTH_CREDENTIALS];
    }
    const dir = dataDir();
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((f) => /^credentials.*\.json$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));
}
/** Path to the token store keyed by account email. */
export function tokensPath() {
    return path.join(dataDir(), "tokens.json");
}
/** Loopback port used during the OAuth consent flow. */
export const OAUTH_REDIRECT_PORT = 4773;
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_REDIRECT_PORT}/oauth2callback`;
//# sourceMappingURL=constants.js.map