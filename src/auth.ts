import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { OAuth2Client, Credentials } from "google-auth-library";
import {
  credentialsPath,
  dataDir,
  gmailRequestTimeoutMs,
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

/**
 * Type guard for the current on-disk account shape. Checks field TYPES, not
 * just key presence: an entry like `{ tokens: null }` (a hand-edit, e.g. to
 * "disable" an account) previously passed a key-presence check and then threw
 * raw TypeErrors deep in getAuthedClient — and crashed add-account AFTER the
 * user completed browser consent, making the bad entry unrepairable.
 */
function isStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { tokens?: unknown; credentialsFile?: unknown };
  return (
    typeof v.tokens === "object" &&
    v.tokens !== null &&
    typeof v.credentialsFile === "string"
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
  const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
  const root: Record<string, unknown> =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  // Google's downloaded file nests config under "installed" or "web".
  const cfg = (root.installed ?? root.web ?? root) as Partial<OAuthClientConfig>;
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error(
      `Credentials file ${target} is missing client_id/client_secret. ` +
        `Make sure it is an OAuth "Desktop app" client JSON.`
    );
  }
  return {
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    redirect_uris: cfg.redirect_uris,
  };
}

/** Build a fresh OAuth2 client from a specific credential file. */
export function newOAuthClient(
  file?: string,
  redirectUri: string = OAUTH_REDIRECT_URI
): OAuth2Client {
  const cfg = loadClientConfig(file);
  // Use the object form (not the positional one) so transporterOptions is
  // honored — the positional constructor calls super({}) and drops it. The
  // timeout MUST live on the auth client's own transporter: token refreshes
  // POST directly through it, NOT through the Gmail API client, so the
  // client-level timeout set in gmailFor does not cover them. Without this a
  // silently-hung refresh socket wedges every tool call for the account
  // (google-auth-library serializes refreshes per client, so subsequent calls
  // await the same never-settling promise) until the server is restarted.
  return new OAuth2Client({
    clientId: cfg.client_id,
    clientSecret: cfg.client_secret,
    redirectUri,
    transporterOptions: { timeout: gmailRequestTimeoutMs() },
    // When credentials carry an expiry_date (ours always do), the library only
    // refresh-and-retries a 401/403 response if this is set. Without it, an
    // access token invalidated server-side BEFORE its local expiry (Workspace
    // session policies, security events) makes every call fail with re-auth
    // instructions for up to ~55 minutes although one refresh — performed at
    // most once per request — would fix it.
    //
    // Tradeoff (kept deliberately): the library couples the 401 and 403 cases
    // (isAuthErr = 401 || 403) with no per-status setting, so this also fires a
    // refresh + re-request on 403s a refresh can never fix (permission and
    // rate-limit errors), which stacks on top of withRetry's own retries. Under
    // sustained throttling that roughly doubles the request/refresh count per
    // attempt. We accept that bounded, self-recovering cost because avoiding a
    // ~55-minute outage on a pre-expiry invalidation is the better user
    // experience; it is the one intentional exception to withRetry being the
    // sole bounded retry layer (see gmailFor in gmail.ts).
    forceRefreshOnFailure: true,
  });
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

/** Malformed store entries we've already warned about this process (per key). */
const warnedInvalidEntryKeys = new Set<string>();

/**
 * Load the token store, migrating any legacy entries (raw Credentials written
 * before per-account credential files) to the current shape, defaulting their
 * credential file to the basename of the default credentials path.
 */
/**
 * Read the token store from disk, distinguishing three states so that writers
 * can refuse to overwrite a store they couldn't read:
 *  - a missing file is a normal empty store (`corrupt: false`);
 *  - a present-but-unparseable file is `corrupt: true` (readers still degrade to
 *    an empty store so the server keeps running, but writers must not clobber it);
 *  - a readable file is migrated to the current shape and returned.
 */
function readTokenStore(): {
  store: TokenStore;
  corrupt: boolean;
  preserved: Record<string, unknown>;
} {
  const file = tokensPath();
  if (!fs.existsSync(file)) return { store: {}, corrupt: false, preserved: {} };
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
    return { store: {}, corrupt: true, preserved: {} };
  }
  const defaultRef = path.basename(credentialsPath());
  const store: TokenStore = {};
  // Raw entries we couldn't interpret, kept by their ORIGINAL key so a
  // subsequent write round-trips them unchanged instead of erasing them.
  const preserved: Record<string, unknown> = {};
  for (const [email, value] of Object.entries(raw)) {
    // Normalize keys to the documented lower-case invariant. saveAccount always
    // writes lower-cased keys, but a hand-edited or externally written store
    // may not — and without normalizing, resolveAccount (raw keys) and
    // getAuthedClient (lowercased lookup) disagree, making the account listed
    // yet unusable with contradictory errors.
    const key = email.toLowerCase();
    if (isStoredAccount(value)) {
      store[key] = value;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !("tokens" in value) &&
      !("credentialsFile" in value)
    ) {
      // Legacy: the value is a raw Credentials object (pre-per-account
      // credential files). Only a plain object WITHOUT the current shape's
      // keys qualifies — an object that has them but with wrong types is a
      // malformed current-shape entry, not legacy data.
      store[key] = {
        tokens: value,
        credentialsFile: defaultRef,
      };
    } else {
      // Malformed entry (null, wrong-typed fields, ...). Skip it for READERS —
      // wrapping it used to plant raw TypeErrors in every downstream consumer —
      // but PRESERVE the raw value so a later write doesn't erase it: it may
      // still hold a refresh token recoverable by hand (the same invariant the
      // whole-file corrupt-store refusal protects). Warn once, since silently
      // dropping a listed account from the usable set is confusing.
      preserved[email] = value;
      if (!warnedInvalidEntryKeys.has(key)) {
        warnedInvalidEntryKeys.add(key);
        console.error(
          `Warning: ignoring malformed token-store entry for '${email}' in ${file} ` +
            `(it will be kept on disk, not usable). Repair it by hand or re-run ` +
            `\`npm run add-account\` for that account.`
        );
      }
    }
  }
  return { store, corrupt: false, preserved };
}

export function loadTokens(): TokenStore {
  return readTokenStore().store;
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

export function saveTokens(
  store: TokenStore,
  preserved: Record<string, unknown> = {}
): void {
  const dir = ensureDataDir();
  const file = tokensPath();
  // Merge any preserved (malformed-on-read) entries back in, keyed as they were
  // on disk, so an unrelated write never erases a hand-recoverable token. A
  // preserved entry is dropped only when the same account (case-insensitively)
  // now exists as a real store entry — i.e. it was repaired or re-added, so the
  // stale malformed copy should not linger.
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(preserved)) {
    if (!(k.toLowerCase() in store)) merged[k] = v;
  }
  Object.assign(merged, store);
  // Write to a temp file in the same directory, then atomically rename over the
  // target. This prevents a concurrent reader (or a crash mid-write) from ever
  // seeing a partial/corrupt token store. fsync the temp's contents before the
  // rename, and the directory after, so a crash/power-loss can't leave a
  // present-but-garbage tokens.json — the corrupt state that would otherwise be
  // finished off (overwritten with {}) by the next token refresh.
  const tmp = path.join(dir, `.tokens.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(merged, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Best-effort tighten permissions (no-op on platforms that ignore it).
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
  // Best-effort durability of the rename itself. Opening a directory for fsync
  // isn't supported everywhere (e.g. Windows), so ignore failures.
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* ignore */
  }
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

/**
 * Best-effort removal of a token-store lock that appears abandoned (older than
 * LOCK_STALE_MS). Returns true if a stale lock was cleared (or had already
 * vanished), false if the lock is fresh/live or turned out to be live and was
 * left untouched.
 *
 * The removal is token-verified to avoid the stat/rename TOCTOU that a plain
 * "rename it aside" cannot close: rename targets the PATH, not the specific
 * stale inode we stat'd, so a live holder that recreated the lock between our
 * stat and our rename would otherwise be silently displaced. We therefore
 * re-read the lock's content, rename it aside, and confirm the moved file still
 * carries the exact content we observed as stale. If it doesn't, we grabbed a
 * fresh lock — restore it untouched and report failure so no one proceeds as if
 * the slot were free.
 */
function tryStealStaleLock(lockPath: string): boolean {
  let observed: string;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
    observed = fs.readFileSync(lockPath, "utf-8");
  } catch {
    return true; // gone already → nothing holds it
  }
  if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false; // fresh/live holder
  // Graveyard name matches the `.tokens.*.tmp` pattern so a crash mid-steal
  // leaves a file the existing temp sweep cleans up.
  const graveyard = path.join(
    path.dirname(lockPath),
    `.tokens.lock-stale.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`
  );
  try {
    fs.renameSync(lockPath, graveyard);
  } catch {
    return true; // another contender moved it first → gone from our POV
  }
  let grabbed: string | null;
  try {
    grabbed = fs.readFileSync(graveyard, "utf-8");
  } catch {
    grabbed = null;
  }
  if (grabbed === observed) {
    fs.rmSync(graveyard, { force: true }); // took the exact stale lock we saw
    return true;
  }
  // We displaced a DIFFERENT (fresh) lock — a live holder recreated it between
  // our stat and our rename. Restore it and report failure.
  try {
    fs.renameSync(graveyard, lockPath);
  } catch {
    fs.rmSync(graveyard, { force: true });
  }
  return false;
}

async function withTokenLock<T>(fn: (assertHeld: () => void) => T): Promise<T> {
  ensureDataDir();
  const lockPath = `${tokensPath()}.lock`;
  const timeoutMs = lockAcquireTimeoutMs();
  // A token unique to THIS acquisition, written into the lock file. It lets the
  // holder prove at commit time that it still owns the lock (see assertHeld),
  // and lets tryStealStaleLock distinguish the exact stale inode from a fresh
  // one recreated concurrently.
  const token = `${process.pid}.${randomBytes(8).toString("hex")}.${Date.now()}`;
  let held = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Atomic exclusive create; only one process can win it for a given path.
      fs.writeFileSync(lockPath, token, { flag: "wx" });
      held = true;
      break;
    } catch (e) {
      // A non-EEXIST error is a real filesystem failure (permissions, etc.);
      // surface it rather than masking it as lock contention.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A lock exists. If it's abandoned (crashed holder), token-verified-steal
      // it and retry immediately; otherwise back off. Operations under the lock
      // are sub-millisecond, so a lock older than LOCK_STALE_MS is abandoned.
      if (tryStealStaleLock(lockPath)) continue;
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
  // Confirm we still own the lock. Call this immediately before committing a
  // write. Token-verified stealing prevents a live lock from being taken in the
  // first place (the finding's two-writer interleaving), and for this tool's
  // at-most-two-writers reality that is sufficient; assertHeld is the backstop
  // for the irreducible micro-windows (e.g. a lock briefly absent during a
  // restore) — if our token is no longer in the file, we abort the write and
  // let the caller retry rather than clobber another process's update.
  const assertHeld = (): void => {
    let current: string | null = null;
    try {
      current = fs.readFileSync(lockPath, "utf-8");
    } catch {
      /* lock gone → we no longer hold it */
    }
    if (current !== token) {
      throw new Error(
        `Lost the token-store lock at ${lockPath} to a concurrent writer before ` +
          `committing; aborting to avoid clobbering its update. Please retry.`
      );
    }
  };
  try {
    return fn(assertHeld);
  } finally {
    // Release only the lock we still own, so we never delete a lock another
    // process legitimately created after ours was stolen.
    try {
      if (fs.readFileSync(lockPath, "utf-8") === token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      /* already gone / unreadable — nothing to release */
    }
  }
}

/** Atomically (under the token lock) load the store, mutate it, and save it. */
async function updateTokens(mutate: (store: TokenStore) => void): Promise<void> {
  await withTokenLock((assertHeld) => {
    const { store, corrupt, preserved } = readTokenStore();
    if (corrupt) {
      // The file exists but couldn't be parsed. Proceeding would persist the
      // empty fallback (mutated) OVER it, permanently destroying the refresh
      // tokens that are still recoverable from the corrupt file by hand. Refuse
      // and surface an actionable error. The refresh-persistence listener
      // swallows this (best-effort), so an in-memory access token keeps working
      // until the store is repaired or the server restarts.
      throw new Error(
        `Refusing to modify the token store: ${tokensPath()} exists but is ` +
          `unreadable. Repair or delete it, then retry — overwriting it now ` +
          `would destroy the connected accounts' saved refresh tokens.`
      );
    }
    mutate(store);
    // We're about to overwrite tokens.json. Confirm we still hold the lock: if
    // a concurrent writer displaced us, abort rather than clobber its update.
    assertHeld();
    saveTokens(store, preserved);
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
  // Also remove a lock file abandoned by a crashed holder, via the same
  // token-verified steal withTokenLock uses so this sweep never displaces a
  // lock a live contender recreated between our staleness check and our removal.
  tryStealStaleLock(`${tokensPath()}.lock`);
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
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return only;
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
    // Snapshot the emitted object SYNCHRONOUSLY: google-auth-library mutates it
    // after emitting (getRequestMetadataAsync stamps the OLD refresh token back
    // onto it), and the persist below can run delayed when the token lock is
    // contended — merging the by-then-mutated object would silently revert a
    // concurrent re-consent's new refresh token to the old one.
    const snapshot = { ...fresh };
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
    if (snapshot.refresh_token) cached.refreshToken = snapshot.refresh_token;
    void updateTokens((store) => {
      const cur = store[key];
      if (cur) cur.tokens = { ...cur.tokens, ...snapshot };
    }).catch(() => {
      /* best-effort persistence; ignore write failures */
    });
  });
  authedClients.set(key, { client, refreshToken: entry.tokens.refresh_token });
  return client;
}
