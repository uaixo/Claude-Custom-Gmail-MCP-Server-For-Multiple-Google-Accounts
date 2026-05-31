import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { credentialsPath, dataDir, OAUTH_REDIRECT_URI, tokensPath, } from "./constants.js";
/** Type guard for the current on-disk account shape. */
function isStoredAccount(value) {
    return (typeof value === "object" &&
        value !== null &&
        "tokens" in value &&
        "credentialsFile" in value);
}
/** Read an OAuth "Desktop app" client config from a specific file. */
export function loadClientConfig(file) {
    const target = file || credentialsPath();
    if (!fs.existsSync(target)) {
        throw new Error(`OAuth client credentials not found at ${target}. ` +
            `Download an OAuth 2.0 "Desktop app" client JSON from Google Cloud Console ` +
            `and save it in ${dataDir()} (e.g. credentials.json, credentials2.json), ` +
            `or set GMAIL_OAUTH_CREDENTIALS to a specific file.`);
    }
    const raw = JSON.parse(fs.readFileSync(target, "utf-8"));
    // Google's downloaded file nests config under "installed" or "web".
    const cfg = raw.installed || raw.web || raw;
    if (!cfg.client_id || !cfg.client_secret) {
        throw new Error(`Credentials file ${target} is missing client_id/client_secret. ` +
            `Make sure it is an OAuth "Desktop app" client JSON.`);
    }
    return cfg;
}
/** Build a fresh OAuth2 client from a specific credential file. */
export function newOAuthClient(file) {
    const cfg = loadClientConfig(file);
    return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, OAUTH_REDIRECT_URI);
}
/** Resolve a stored credentialsFile reference to an absolute path. */
export function resolveCredentialsFile(stored) {
    return path.isAbsolute(stored) ? stored : path.join(dataDir(), stored);
}
/**
 * Compute how to persist a credential file reference: a basename when the file
 * lives directly in the data dir, otherwise its absolute path.
 */
export function credentialsRefFor(file) {
    const abs = path.resolve(file);
    return path.dirname(abs) === path.resolve(dataDir())
        ? path.basename(abs)
        : abs;
}
/**
 * Load the token store, migrating any legacy entries (raw Credentials written
 * before per-account credential files) to the current shape, defaulting their
 * credential file to the basename of the default credentials path.
 */
export function loadTokens() {
    const file = tokensPath();
    if (!fs.existsSync(file))
        return {};
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return {};
    }
    const defaultRef = path.basename(credentialsPath());
    const store = {};
    for (const [email, value] of Object.entries(raw)) {
        if (isStoredAccount(value)) {
            store[email] = value;
        }
        else {
            // Legacy: the value is a raw Credentials object.
            store[email] = {
                tokens: value,
                credentialsFile: defaultRef,
            };
        }
    }
    return store;
}
export function saveTokens(store) {
    const dir = dataDir();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const file = tokensPath();
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
    // Best-effort tighten permissions (no-op on platforms that ignore it).
    try {
        fs.chmodSync(file, 0o600);
    }
    catch {
        /* ignore */
    }
}
/** Persist (or update) one account's tokens and credential-file reference. */
export function saveAccount(email, tokens, credentialsFile) {
    const store = loadTokens();
    store[email.toLowerCase()] = { tokens, credentialsFile };
    saveTokens(store);
}
export function listAccounts() {
    return Object.keys(loadTokens());
}
/** Return the credentialsFile reference recorded for each account. */
export function accountCredentials() {
    const store = loadTokens();
    const out = {};
    for (const [email, entry] of Object.entries(store)) {
        out[email] = entry.credentialsFile;
    }
    return out;
}
export function removeAccount(email) {
    const store = loadTokens();
    const key = email.toLowerCase();
    if (!(key in store))
        return false;
    delete store[key];
    saveTokens(store);
    return true;
}
/**
 * Resolve which account to use. If `requested` is provided it must exist.
 * Otherwise, if exactly one account is connected, use it; if several are
 * connected, require the caller to disambiguate.
 */
export function resolveAccount(requested) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        throw new Error("No Gmail accounts connected. Run `npm run add-account` to connect one.");
    }
    if (requested) {
        const key = requested.toLowerCase();
        if (!accounts.includes(key)) {
            throw new Error(`Account '${requested}' is not connected. Connected accounts: ${accounts.join(", ")}. Run \`npm run add-account\` to add it.`);
        }
        return key;
    }
    if (accounts.length === 1)
        return accounts[0];
    throw new Error(`Multiple accounts connected (${accounts.join(", ")}). Specify the 'account' parameter to choose one.`);
}
/**
 * Return an authenticated OAuth2 client for the given (resolved) account,
 * built from the credential file that account was authorized with. Refreshed
 * access tokens are persisted automatically.
 */
export function getAuthedClient(account) {
    const store = loadTokens();
    const key = account.toLowerCase();
    const entry = store[key];
    if (!entry) {
        throw new Error(`No stored tokens for account '${account}'.`);
    }
    const credFile = resolveCredentialsFile(entry.credentialsFile);
    if (!fs.existsSync(credFile)) {
        throw new Error(`Credential file '${entry.credentialsFile}' for account '${account}' not found at ${credFile}. ` +
            `This must be the same OAuth client used when the account was added; restore that file or re-run \`npm run add-account\`.`);
    }
    const client = newOAuthClient(credFile);
    client.setCredentials(entry.tokens);
    // Persist refreshed tokens whenever the library rotates them.
    client.on("tokens", (fresh) => {
        const current = loadTokens();
        const cur = current[key];
        if (cur) {
            cur.tokens = { ...cur.tokens, ...fresh };
            saveTokens(current);
        }
    });
    return client;
}
//# sourceMappingURL=auth.js.map