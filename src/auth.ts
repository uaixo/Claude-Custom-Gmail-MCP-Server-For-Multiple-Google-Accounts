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
 * Cache of authenticated OAuth clients, one per account (keyed by lower-cased
 * email). Sharing a single client across concurrent tool calls lets
 * google-auth-library serialize token refreshes and ensures only one `tokens`
 * listener performs the read-modify-write against the token store, avoiding
 * lost updates.
 */
const authedClients = new Map<string, OAuth2Client>();

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
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    warnedCorruptTokenStore = false;
  } catch (e) {
    // A corrupt store shouldn't crash the server, but failing silently here
    // makes every account look disconnected with no explanation — surface it.
    if (!warnedCorruptTokenStore) {
      warnedCorruptTokenStore = true;
      console.error(
        `Warning: could not parse token store at ${file} (${
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

export function saveTokens(store: TokenStore): void {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
 * would otherwise lose one account's update). The lock is advisory: if it can't
 * be acquired within a short window we proceed anyway, so behavior never
 * regresses below the previous unlocked baseline. Waiting is async so the event
 * loop is never blocked. `fn` itself is synchronous (load/mutate/save).
 */
async function withTokenLock<T>(fn: () => T): Promise<T> {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lockPath = `${tokensPath()}.lock`;
  let held = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx")); // atomic exclusive create
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break; // unexpected → proceed unlocked
      try {
        // Steal an obviously-stale lock left behind by a crashed process.
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 10_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // lock vanished between stat and unlink → retry immediately
      }
      await sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
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
export function resolveAccount(requested?: string): string {
  const accounts = listAccounts();
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
export function getAuthedClient(account: string): OAuth2Client {
  const key = account.toLowerCase();
  const cached = authedClients.get(key);
  if (cached) return cached;

  const store = loadTokens();
  const entry = store[key];
  if (!entry) {
    throw new Error(`No stored tokens for account '${account}'.`);
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
    void updateTokens((store) => {
      const cur = store[key];
      if (cur) cur.tokens = { ...cur.tokens, ...fresh };
    }).catch(() => {
      /* best-effort persistence; ignore write failures */
    });
  });
  authedClients.set(key, client);
  return client;
}
