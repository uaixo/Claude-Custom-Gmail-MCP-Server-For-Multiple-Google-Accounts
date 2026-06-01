import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

/**
 * True when the module identified by `importMetaUrl` is the entry point Node was
 * invoked with. Resolves symlinks on both sides, so it still works when launched
 * via a bin shim (e.g. node_modules/.bin/...), where process.argv[1] is a
 * symlink to the real module file. A plain path comparison would miss that case
 * and the entry point would silently never run.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(importMetaUrl))
    );
  } catch {
    return false;
  }
}

/** Maximum response size in characters before truncation. */
export const CHARACTER_LIMIT = 25000;

/**
 * Maximum number of per-thread metadata fetches to run concurrently when
 * expanding search results. Bounds the fan-out so large result sets don't
 * trip Gmail's per-user rate limit.
 */
export const THREAD_FETCH_CONCURRENCY = 5;

/**
 * Gmail's maximum message size (25 MB), applied to the full RFC 2822 message
 * including base64-encoded attachments. We validate against this before calling
 * the API so oversized messages fail with a clear, local error instead of an
 * opaque API rejection.
 */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Maximum number of messages returned from a single thread. Bounds the
 * structuredContent payload (per-message metadata) for pathologically large
 * threads, independent of the body-character budget.
 */
export const MAX_THREAD_MESSAGES = 100;

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
export function dataDir(): string {
  return process.env.GMAIL_MCP_DATA_DIR || path.join(os.homedir(), ".gmail-mcp");
}

/**
 * Path to the default OAuth client credentials JSON. Override with
 * GMAIL_OAUTH_CREDENTIALS. Defaults to <dataDir>/credentials.json. Used as the
 * fallback credential for accounts that predate per-account credential files.
 */
export function credentialsPath(): string {
  return (
    process.env.GMAIL_OAUTH_CREDENTIALS || path.join(dataDir(), "credentials.json")
  );
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
export function credentialsFiles(): string[] {
  if (process.env.GMAIL_OAUTH_CREDENTIALS) {
    return [process.env.GMAIL_OAUTH_CREDENTIALS];
  }
  const dir = dataDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^credentials.*\.json$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Directories from which `path` attachments may be read, set via
 * GMAIL_MCP_ATTACHMENTS_DIR (one or more, separated by the platform path
 * delimiter). When unset, reading local files by path is disabled and callers
 * must supply attachments inline as content_base64. This prevents the server
 * from being coerced into emailing arbitrary local files (e.g. SSH keys, .env).
 */
export function attachmentDirs(): string[] {
  const raw = process.env.GMAIL_MCP_ATTACHMENTS_DIR;
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

/** Path to the token store keyed by account email. */
export function tokensPath(): string {
  return path.join(dataDir(), "tokens.json");
}

/**
 * Preferred loopback port for the OAuth consent flow. If it's busy, add-account
 * falls back to an OS-assigned ephemeral port — Desktop-app OAuth clients accept
 * any loopback port, so no extra Google config is needed.
 */
export const OAUTH_REDIRECT_PORT = 4773;

/** Build the loopback redirect URI for a given port. */
export function oauthRedirectUri(port: number = OAUTH_REDIRECT_PORT): string {
  return `http://localhost:${port}/oauth2callback`;
}

/** Default redirect URI on the preferred port. */
export const OAUTH_REDIRECT_URI = oauthRedirectUri();
