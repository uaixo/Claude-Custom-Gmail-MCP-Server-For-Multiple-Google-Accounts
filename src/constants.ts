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

/**
 * The package version, read from package.json so it stays the single source of
 * truth (rather than being duplicated as a literal in the server metadata).
 * package.json sits one level above the compiled module in dist/, and at the
 * package root when installed, so `../package.json` resolves in both layouts.
 * Falls back to "0.0.0" if it can't be read.
 */
export function packageVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(fs.readFileSync(pkgUrl, "utf-8"));
    const version =
      pkg && typeof pkg === "object" && "version" in pkg
        ? (pkg as { version?: unknown }).version
        : undefined;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Maximum response size in characters before truncation. */
export const CHARACTER_LIMIT = 25000;

/**
 * Character budget for the *combined* message bodies of a single thread, kept
 * below CHARACTER_LIMIT on purpose. gmail_get_thread renders the whole result
 * object — bodies plus per-message metadata (ids, headers, label arrays) and
 * JSON punctuation — to the text channel via renderJsonText, which falls back
 * to a notice once the serialized form exceeds CHARACTER_LIMIT. Reserving
 * headroom for that structural overhead lets a typical thread with large bodies
 * still render as JSON in the text channel instead of collapsing to the notice.
 * Pathologically large or many-message threads still fall back, with
 * structuredContent carrying the authoritative result either way.
 */
export const MAX_THREAD_BODY_CHARS = 20000;

/**
 * Character budget for a single message body (gmail_get_message). Unlike a
 * thread read, a single-message result carries no combined per-message
 * metadata, so it can use the full render budget: a body up to this size is
 * preserved in structuredContent (the authoritative channel), and the text
 * channel still renders it as JSON whenever the whole serialized object fits
 * under CHARACTER_LIMIT, falling back to the notice only for the largest
 * bodies. Reusing the thread's smaller 20000 budget here needlessly dropped —
 * and made unretrievable — the 20000..25000 char band of a message.
 */
export const MAX_MESSAGE_BODY_CHARS = CHARACTER_LIMIT;

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

/**
 * Per-request timeout (milliseconds) applied to every Gmail API call. Bounds a
 * single request's duration so a hung socket fails fast — and, for idempotent
 * calls, is retried by withRetry — instead of blocking a tool call until the OS
 * TCP timeout (which can be minutes). withRetry bounds the number of attempts;
 * this bounds each attempt. Defaults to 30s; override with
 * GMAIL_MCP_REQUEST_TIMEOUT_MS (a positive number of milliseconds).
 */
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;

/** Resolve the per-request timeout, honoring the env override when valid. */
export function gmailRequestTimeoutMs(): number {
  const override = Number(process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : GMAIL_REQUEST_TIMEOUT_MS;
}

/**
 * Gmail OAuth scopes (kept minimal). `gmail.modify` covers read, label
 * management, and draft create/update; `gmail.send` covers sending. We
 * intentionally do NOT request `gmail.compose` — it only adds draft/send
 * abilities already granted by the other two, so omitting it follows least
 * privilege. `userinfo.email` identifies which account just authorized.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read + labels + drafts
  "https://www.googleapis.com/auth/gmail.send", // send
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
 * - As a convenience, if no `credentials*.json` is present we fall back to
 *   Google's default download name `client_secret*.json`, so the common "forgot
 *   to rename the download" case still works. The fallback only kicks in when
 *   no renamed file exists, so it never double-lists the same client.
 */
export function credentialsFiles(): string[] {
  if (process.env.GMAIL_OAUTH_CREDENTIALS) {
    return [process.env.GMAIL_OAUTH_CREDENTIALS];
  }
  const dir = dataDir();
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir);
  const pick = (re: RegExp): string[] =>
    names
      .filter((f) => re.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  const primary = pick(/^credentials.*\.json$/i);
  return primary.length ? primary : pick(/^client_secret.*\.json$/i);
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

/**
 * Build the loopback redirect URI for a given port. Uses the loopback IP
 * (127.0.0.1) rather than "localhost": Desktop-app OAuth clients accept both,
 * and the literal IP avoids a name-resolution mismatch when the callback server
 * binds to 127.0.0.1 but "localhost" resolves to ::1 (IPv6) on some systems.
 */
export function oauthRedirectUri(port: number = OAUTH_REDIRECT_PORT): string {
  return `http://127.0.0.1:${port}/oauth2callback`;
}

/** Default redirect URI on the preferred port. */
export const OAUTH_REDIRECT_URI = oauthRedirectUri();
