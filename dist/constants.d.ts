/** Maximum response size in characters before truncation. */
export declare const CHARACTER_LIMIT = 25000;
/** Gmail OAuth scopes. Covers read, compose/send, and label management. */
export declare const SCOPES: string[];
/**
 * Directory where per-account tokens and the OAuth client credentials live.
 * Override with GMAIL_MCP_DATA_DIR. Defaults to ~/.gmail-mcp.
 */
export declare function dataDir(): string;
/**
 * Path to the default OAuth client credentials JSON. Override with
 * GMAIL_OAUTH_CREDENTIALS. Defaults to <dataDir>/credentials.json. Used as the
 * fallback credential for accounts that predate per-account credential files.
 */
export declare function credentialsPath(): string;
/**
 * Discover all OAuth client credential files available for connecting accounts.
 *
 * - If GMAIL_OAUTH_CREDENTIALS is set, that single file is the only candidate.
 * - Otherwise every file in the data dir matching `credentials*.json` is
 *   returned (e.g. credentials.json, credentials2.json, credentials-work.json),
 *   sorted by name. Each may be a distinct OAuth client (different
 *   client_id/secret), which is why accounts record which one they used.
 */
export declare function credentialsFiles(): string[];
/** Path to the token store keyed by account email. */
export declare function tokensPath(): string;
/** Loopback port used during the OAuth consent flow. */
export declare const OAUTH_REDIRECT_PORT = 4773;
export declare const OAUTH_REDIRECT_URI = "http://localhost:4773/oauth2callback";
