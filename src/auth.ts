import fs from "fs";
import path from "path";
import { OAuth2Client, Credentials } from "google-auth-library";
import { google } from "googleapis";
import {
  credentialsPath,
  dataDir,
  OAUTH_REDIRECT_URI,
  tokensPath,
} from "./constants.js";

/**
 * A connected account's persisted state: its OAuth tokens plus a reference to
 * the credential file (OAuth client) used to authorize it. The reference is a
 * basename when the file lives in the data dir, otherwise an absolute path.
 * Because refresh tokens are bound to the issuing OAuth client, this file MUST
 * be used to refresh that account's access token.
 */
export interface StoredAccount {
  tokens: Credentials;
  credentialsFile: string;
}

/** Token store keyed by lower-cased account email. */
export interface TokenStore {
  [email: string]: StoredAccount;
}

/**
 * A cached authenticated client plus the refresh token it was built with. The
 * refresh token acts as a freshness signature: if tokens.json is rewritten out
 * from under a long-running server — e.g. the user re-runs `add-account` in a
 * separate process to re-consent after a revoked token — the refresh token on
 * disk changes, and comparing against it lets getAuthedClient rebuild the
 * client instead of using a stale one that holds a dead token until restart.
 */
interface CachedClient {
  client: OAuth2Client;
  refreshToken: string | null | undefined;
}

/**
 * Cache of authenticated OAuth clients, one per account (keyed by lower-cased
 * email). Sharing a single client across concurrent tool calls lets
 * google-auth-library serialize token refreshes and ensures only one `tokens`
 * listener performs the read-modify-write against the token store, avoiding
 * lost updates.
 */
const authedClients = new Map<string, CachedClient>();

interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

/** Type guard for the current on-disk account shape. */
function isStoredAccount(value: unknown): value is StoredAccount {
  return (
    typeof value === "object" &&
    value !== null &&
    "tokens" in value &&
    "credentialsFile" in value
  );
}

/** Read an OAuth "Desktop app" client config from a specific file. */
export function loadClientConfig(file?: string): OAuthClientConfig {
  const target = file || credentialsPath();
  if (!fs.existsSync(target)) {
    throw new Error(
      `OAuth client credentials not found at ${target}. ` +
        `Download an OAuth 2.0 "Desktop app" client JSON from Google Cloud Console ` +
        `and save it in ${dataDir()} (e.g. credentials.json, credentials2.json), ` +
        `or set GMAIL_OAUTH_CREDENTIALS to a specific file.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(target, "utf-8"));
  // Google's downloaded file nests config under "installed" or "web".
  const cfg = raw.installed || raw.web || raw;
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error(
      `Credentials file ${target} is missing client_id/client_secret. ` +
        `Make sure it is an OAuth "Desktop app" client JSON.`
    );
  }
  return cfg;
}

/** Build a fresh OAuth2 client from a specific credential file. */
export function newOAuthClient(
  file?: string,
  redirectUri: string = OAUTH_REDIRECT_URI
): OAuth2Client {
  const cfg = loadClientConfig(file);
  return new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);
}

/** Resolve a stored credentialsFile reference to an absolute path. */
export function resolveCredentialsFile(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(dataDir(), stored);
}

/**
 * Compute how to persist a credential file reference: a basename when the file
 * lives directly in the data dir, otherwise its absolute path.
 */
export function credentialsRefFor(file: string): string {
  const abs = path.resolve(file);
  return path.dirname(abs) === path.resolve(dataDir())
    ? path.basename(abs)
    : abs;
}

/**
 * Whether we've already warned about an unparseable token store this process.
 * loadTokens runs on nearly every tool call, so we warn once (and re-arm on a
 * successful parse) rather than spamming the log on every read.
 */
let warnedCorruptTokenStore = false;

/**
 * Load the token store, migrating any legacy entries (raw Credentials written
 * before per-account credential files) to the current shape, defaulting their
 * credential file to the basename of the default credentials path.
 */
export function loadTokens(): TokenStore {
  const file = tokensPath();
  if (!fs.existsSync(file)) return {};
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    // Guard the shape, not just the syntax. Valid JSON that isn't a plain object
    // (null, an array, a string/number) would otherwise slip past the parse and
    // break the Object.entries walk below: null throws — crashing callers like
    // startup's listAccounts() — while an array or string silently yields bogus
    // index-keyed "accounts". Treat any non-object as a corrupt store.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("token store is not a JSON object");
    }
    raw = parsed as Record<string, unknown>;
    warnedCorruptTokenStore = false;
  } catch (e) {
    // A corrupt store shouldn't crash the server, but failing silently here
    // makes every account look disconnected with no explanation — surface it.
    if (!warnedCorruptTokenStore) {
      warnedCorruptTokenStore = true;
      console.error(
        `Warning: could not load token store at ${file} (${
          (e as Error).message
        }). Treating it as empty; connected accounts will be unavailable until it is repaired or re-created with \`npm run add-account\`.`
      );
    }
    return {};
  }
  const defaultRef = path.basename(credentialsPath());
  const store: TokenStore = {};
  for (const [email, value] of Object.entries(raw)) {
    if (isStoredAccount(value)) {
      store[email] = value;
    } else {
      // Legacy: the value is a raw Credentials object.
      store[email] = {
        tokens: value as Credentials,
        credentialsFile: defaultRef,
      };
    }
  }
  return store;
}

/**
 * Ensure the data dir exists, creating it owner-only (0700) so the token store
 * and any credential files beside it aren't traversable by other local users.
 * tokens.json itself is written 0600; this hardens the containing directory to
 * match. Only applied on creation — an existing dir's mode is left untouched.
 */
function ensureDataDir(): string {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function saveTokens(store: TokenStore): void {
  const dir = ensureDataDir();
  const file = tokensPath();
  // Write to a temp file in the same directory, then atomically rename over the
  // target. This prevents a concurrent reader (or a crash mid-write) from ever
  // seeing a partial/corrupt token store.
  const tmp = path.join(dir, `.tokens.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Best-effort tighten permissions (no-op on platforms that ignore it).
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
}

/**
 * Async millisecond sleep used between lock-acquisition retries. Unlike a
 * synchronous spin (Atomics.wait), this yields the event loop, so the server
 * stays responsive while waiting for a contended lock.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding a best-effort cross-process lock on the token store, so
 * a load-modify-write here isn't clobbered by a concurrent writer (e.g. the
 * server refreshing a token while add-account connects another account, which
 * would otherwise lose one account's update). If the lock can't be acquired
 * within the window we throw rather than write unlocked, so a contended update
 * fails loudly instead of silently risking a lost update. (The server's
 * best-effort token-refresh persistence swallows that rejection; account
 * mutations surface it to the user, who can retry.) Waiting is async so the
 * event loop is never blocked. `fn` itself is synchronous (load/mutate/save).
 */
/** A token-store lock older than this is treated as stale (a crashed holder). */
const LOCK_STALE_MS = 10_000;
/**
 * How long to try to acquire the lock before giving up and throwing. Override
 * with GMAIL_MCP_LOCK_TIMEOUT_MS (milliseconds). Deliberately longer than
 * LOCK_STALE_MS by default: a crashed holder's lock is always waited out and
 * stolen at the stale threshold rather than causing a spurious failure, so we
 * only throw under sustained *live* contention (realistically never, given at
 * most the server plus one add-account process).
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 12_000;

function lockAcquireTimeoutMs(): number {
  const override = Number(process.env.GMAIL_MCP_LOCK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : LOCK_ACQUIRE_TIMEOUT_MS;
}

async function withTokenLock<T>(fn: () => T): Promise<T> {
  ensureDataDir();
  const lockPath = `${tokensPath()}.lock`;
  const timeoutMs = lockAcquireTimeoutMs();
  let held = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Atomic exclusive create; record the holder PID so a stuck lock is
      // diagnosable (and a future holder can tell who left it behind).
      fs.writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      held = true;
      break;
    } catch (e) {
      // A non-EEXIST error is a real filesystem failure (permissions, etc.);
      // surface it rather than masking it as lock contention.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        // Steal a lock left behind by a crashed holder. Operations under the
        // lock are sub-millisecond, so a lock older than LOCK_STALE_MS is
        // almost certainly abandoned rather than a live, slow holder.
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between stat and remove → retry immediately
      }
      // Jittered backoff so the server and a concurrent add-account don't retry
      // in lock-step and keep colliding on the same slot.
      await sleep(25 + Math.floor(Math.random() * 25));
    }
  }
  if (!held) {
    // Couldn't acquire within the window. Fail rather than write unlocked, so a
    // concurrent update is never silently clobbered.
    throw new Error(
      `Could not acquire the token-store lock at ${lockPath} within ${timeoutMs} ms. ` +
        `Another process may be updating it; please retry.`
    );
  }
  try {
    return fn();
  } finally {
    // force:true → no throw if the lock was already removed (e.g. stolen).
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Atomically (under the token lock) load the store, mutate it, and save it. */
async function updateTokens(mutate: (store: TokenStore) => void): Promise<void> {
  await withTokenLock(() => {
    const store = loadTokens();
    mutate(store);
    saveTokens(store);
  });
}

/**
 * Best-effort removal of stale atomic-write temp files (`.tokens.*.tmp`) left
 * behind if a process crashed between writing and renaming. Only files older
 * than `maxAgeMs` are removed, to avoid racing a concurrent write in progress.
 */
export function cleanupStaleTokenTemps(maxAgeMs = 60_000): void {
  const dir = dataDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!/^\.tokens\..*\.tmp$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  // Also remove a lock file abandoned by a crashed holder, so a stale
  // `tokens.json.lock` doesn't linger in the data dir until the next writer
  // happens to contend on it. A lock older than LOCK_STALE_MS can't belong to a
  // live holder — operations under it are sub-millisecond — which is exactly the
  // threshold withTokenLock uses to steal one, so applying it here is safe.
  const lockPath = `${tokensPath()}.lock`;
  try {
    if (now - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    /* no lock present, or it vanished under us — nothing to clean up */
  }
}

/** Persist (or update) one account's tokens and credential-file reference. */
export async function saveAccount(
  email: string,
  tokens: Credentials,
  credentialsFile: string
): Promise<void> {
  await updateTokens((store) => {
    store[email.toLowerCase()] = { tokens, credentialsFile };
  });
}

export function listAccounts(): string[] {
  return Object.keys(loadTokens());
}

/** Return the credentialsFile reference recorded for each account. */
export function accountCredentials(): Record<string, string> {
  const store = loadTokens();
  const out: Record<string, string> = {};
  for (const [email, entry] of Object.entries(store)) {
    out[email] = entry.credentialsFile;
  }
  return out;
}

export async function removeAccount(email: string): Promise<boolean> {
  const key = email.toLowerCase();
  let existed = false;
  await updateTokens((store) => {
    if (key in store) {
      delete store[key];
      existed = true;
    }
  });
  authedClients.delete(key);
  return existed;
}

/**
 * Resolve which account to use. If `requested` is provided it must exist.
 * Otherwise, if exactly one account is connected, use it; if several are
 * connected, require the caller to disambiguate.
 */
export function resolveAccount(requested?: string, store?: TokenStore): string {
  const accounts = Object.keys(store ?? loadTokens());
  if (accounts.length === 0) {
    throw new Error(
      "No Gmail accounts connected. Run `npm run add-account` to connect one."
    );
  }
  if (requested) {
    const key = requested.toLowerCase();
    if (!accounts.includes(key)) {
      throw new Error(
        `Account '${requested}' is not connected. Connected accounts: ${accounts.join(
          ", "
        )}. Run \`npm run add-account\` to add it.`
      );
    }
    return key;
  }
  if (accounts.length === 1) return accounts[0];
  throw new Error(
    `Multiple accounts connected (${accounts.join(
      ", "
    )}). Specify the 'account' parameter to choose one.`
  );
}

/**
 * Return an authenticated OAuth2 client for the given (resolved) account,
 * built from the credential file that account was authorized with. Refreshed
 * access tokens are persisted automatically.
 */
export function getAuthedClient(account: string, store?: TokenStore): OAuth2Client {
  const key = account.toLowerCase();
  const entry = (store ?? loadTokens())[key];
  if (!entry) {
    throw new Error(`No stored tokens for account '${account}'.`);
  }
  // Reuse the cached client only while the on-disk refresh token still matches
  // the one it was built with; otherwise the stored credentials changed (e.g.
  // a re-consent in another process) and we must rebuild (see CachedClient).
  const cached = authedClients.get(key);
  if (cached && cached.refreshToken === entry.tokens.refresh_token) {
    return cached.client;
  }

  const credFile = resolveCredentialsFile(entry.credentialsFile);
  if (!fs.existsSync(credFile)) {
    throw new Error(
      `Credential file '${entry.credentialsFile}' for account '${account}' not found at ${credFile}. ` +
        `This must be the same OAuth client used when the account was added; restore that file or re-run \`npm run add-account\`.`
    );
  }
  const client = newOAuthClient(credFile);
  client.setCredentials(entry.tokens);
  // Persist refreshed tokens whenever the library rotates them, under the lock
  // so a concurrent writer's update isn't lost. Fire-and-forget: the library
  // doesn't await listeners, and persistence is best-effort.
  client.on("tokens", (fresh) => {
    // Only the client that is still the cached one for this account may persist.
    // If this client has been superseded (an out-of-process re-consent rebuilt
    // it) or evicted (removeAccount), a late token refresh from it must not
    // resurrect a removed account or clobber the replacement — so bail out.
    const cached = authedClients.get(key);
    if (cached?.client !== client) return;
    // Keep this cache entry's freshness signature in step with a rotated refresh
    // token we're about to persist; otherwise the next getAuthedClient() would
    // read the new token off disk, see it differ from the cached signature, and
    // mistake our own rotation for an out-of-process re-consent — needlessly
    // rebuilding a perfectly good client.
    if (fresh.refresh_token) cached.refreshToken = fresh.refresh_token;
    void updateTokens((store) => {
      const cur = store[key];
      if (cur) cur.tokens = { ...cur.tokens, ...fresh };
    }).catch(() => {
      /* best-effort persistence; ignore write failures */
    });
  });
  authedClients.set(key, { client, refreshToken: entry.tokens.refresh_token });
  return client;
}
