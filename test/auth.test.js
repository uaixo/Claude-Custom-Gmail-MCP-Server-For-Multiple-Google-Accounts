import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Point the data dir at a throwaway location before exercising the module.
// dataDir() reads this env var at call time, so setting it here is sufficient.
let dataDir;
before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-auth-"));
  process.env.GMAIL_MCP_DATA_DIR = dataDir;
  fs.writeFileSync(
    path.join(dataDir, "credentials.json"),
    JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } })
  );
});
after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.GMAIL_MCP_DATA_DIR;
});

const auth = await import("../src/auth.js");

test("saveAccount/loadTokens roundtrip, atomic write, 0600 perms, no temp leftover", async () => {
  await auth.saveAccount("a@b.com", { access_token: "x", refresh_token: "y" }, "credentials.json");

  const store = auth.loadTokens();
  assert.equal(store["a@b.com"].tokens.access_token, "x");
  assert.equal(store["a@b.com"].credentialsFile, "credentials.json");

  // Unix permission bits are meaningless on Windows, where file mode doesn't
  // map to 0o600; only assert on POSIX platforms.
  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(dataDir, "tokens.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const leftover = fs.readdirSync(dataDir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftover, []);
});

// Each test provisions the accounts it relies on itself (idempotent saves), so
// running any single test in isolation — `--test-name-pattern`, sharding, a
// future concurrent runner — behaves identically to the full-file run.
test("getAuthedClient caches one client per account with a single tokens listener", async () => {
  await auth.saveAccount("a@b.com", { access_token: "x", refresh_token: "y" }, "credentials.json");
  const c1 = auth.getAuthedClient("a@b.com");
  const c2 = auth.getAuthedClient("A@B.com"); // case-insensitive key
  assert.equal(c1, c2);
  assert.equal(c1.listenerCount("tokens"), 1);
});

test("different accounts get different cached clients", async () => {
  await auth.saveAccount("a@b.com", { access_token: "x", refresh_token: "y" }, "credentials.json");
  await auth.saveAccount("c@d.com", { access_token: "z", refresh_token: "w" }, "credentials.json");
  assert.notEqual(auth.getAuthedClient("c@d.com"), auth.getAuthedClient("a@b.com"));
});

test("removeAccount evicts the cached client and the stored tokens", async () => {
  await auth.saveAccount("a@b.com", { access_token: "x", refresh_token: "y" }, "credentials.json");
  const before = auth.getAuthedClient("a@b.com");
  assert.equal(await auth.removeAccount("a@b.com"), true);
  assert.ok(!auth.listAccounts().includes("a@b.com"));

  await auth.saveAccount("a@b.com", { access_token: "x2", refresh_token: "y2" }, "credentials.json");
  assert.notEqual(auth.getAuthedClient("a@b.com"), before);
});

test("resolveAccount disambiguates by count and validates explicit requests", async () => {
  // Leave exactly one account connected (c@d.com) for a deterministic check,
  // regardless of what other tests (if any) ran before this one.
  await auth.saveAccount("c@d.com", { access_token: "z", refresh_token: "w" }, "credentials.json");
  for (const account of auth.listAccounts()) {
    if (account !== "c@d.com") await auth.removeAccount(account);
  }
  assert.equal(auth.listAccounts().length, 1);
  assert.equal(auth.resolveAccount(), "c@d.com");
  assert.equal(auth.resolveAccount("C@D.com"), "c@d.com");
  assert.throws(() => auth.resolveAccount("missing@x.com"), /not connected/);
});

test("cleanupStaleTokenTemps removes only stale temp files (#6)", () => {
  const stale = path.join(dataDir, ".tokens.1.1.tmp");
  const fresh = path.join(dataDir, ".tokens.2.2.tmp");
  fs.writeFileSync(stale, "x");
  fs.writeFileSync(fresh, "y");
  // Age the stale one well past the threshold.
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(stale, old, old);

  auth.cleanupStaleTokenTemps(60_000);

  assert.ok(!fs.existsSync(stale), "stale temp should be removed");
  assert.ok(fs.existsSync(fresh), "fresh temp should be kept");
  fs.rmSync(fresh, { force: true });
});

test("cleanupStaleTokenTemps removes an abandoned lock but keeps a fresh one (#3)", () => {
  const lock = path.join(dataDir, "tokens.json.lock");

  // A lock left by a crashed holder long ago must be swept.
  fs.writeFileSync(lock, "999999");
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(lock, old, old);
  auth.cleanupStaleTokenTemps();
  assert.ok(!fs.existsSync(lock), "abandoned lock should be removed");

  // A fresh lock (a live holder mid-write) must be left untouched.
  fs.writeFileSync(lock, `${process.pid}`);
  auth.cleanupStaleTokenTemps();
  assert.ok(fs.existsSync(lock), "a fresh lock must not be swept");
  fs.rmSync(lock, { force: true });
});

test("token store mutations steal a stale lock and release it (#7)", async () => {
  const lock = path.join(dataDir, "tokens.json.lock");
  fs.writeFileSync(lock, "999999");
  // Make the lock look like it was left by a long-dead process.
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(lock, old, old);

  await auth.saveAccount("lock@test.com", { access_token: "z" }, "credentials.json");

  assert.ok(auth.listAccounts().includes("lock@test.com"), "write should succeed");
  assert.ok(!fs.existsSync(lock), "lock should be released after the write");
});

test("a fresh (live) lock is never stolen; the write times out without clobbering (L1)", async () => {
  // Token-verified stealing only takes a lock older than LOCK_STALE_MS. A fresh
  // lock — a live holder mid-write — must be left intact, and the contending
  // write must fail loud (time out) rather than proceed unlocked and clobber.
  await auth.saveAccount("keep@x.com", { access_token: "k", refresh_token: "RT_KEEP" }, "credentials.json");
  const lock = path.join(dataDir, "tokens.json.lock");
  const prevTimeout = process.env.GMAIL_MCP_LOCK_TIMEOUT_MS;
  try {
    fs.writeFileSync(lock, "another-holder-token"); // fresh mtime => not stale
    process.env.GMAIL_MCP_LOCK_TIMEOUT_MS = "250";
    await assert.rejects(
      () => auth.saveAccount("new@x.com", { access_token: "n", refresh_token: "RT_NEW" }, "credentials.json"),
      /Could not acquire the token-store lock/
    );
    assert.ok(!auth.listAccounts().includes("new@x.com"), "the timed-out write must not apply");
    assert.ok(auth.listAccounts().includes("keep@x.com"), "the existing store is untouched");
    assert.equal(fs.readFileSync(lock, "utf-8"), "another-holder-token", "the live holder's lock is left intact");
  } finally {
    if (prevTimeout === undefined) delete process.env.GMAIL_MCP_LOCK_TIMEOUT_MS;
    else process.env.GMAIL_MCP_LOCK_TIMEOUT_MS = prevTimeout;
    fs.rmSync(lock, { force: true });
  }
});

test("an unstealable stale lock backs off asynchronously instead of busy-spinning the event loop (round-6 M1)", async () => {
  // Make the lock path a DIRECTORY: openSync/readFileSync fail with a
  // non-ENOENT error (EISDIR on Linux/macOS, EISDIR/EPERM on Windows), the
  // same class as an unreadable root-owned lock or a Windows AV holding the
  // file. tryStealStaleLock used to report ANY error as "lock gone", making
  // withTokenLock `continue` past its only await — a synchronous busy-spin
  // that froze the whole event loop at 100% CPU for the acquire timeout.
  const lock = path.join(dataDir, "tokens.json.lock");
  const prevTimeout = process.env.GMAIL_MCP_LOCK_TIMEOUT_MS;
  fs.mkdirSync(lock);
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(lock, old, old); // stale by mtime, but unstealable
  let ticks = 0;
  const interval = setInterval(() => (ticks += 1), 5);
  try {
    process.env.GMAIL_MCP_LOCK_TIMEOUT_MS = "250";
    await assert.rejects(
      () => auth.saveAccount("spin@x.com", { access_token: "s" }, "credentials.json"),
      /Could not acquire the token-store lock/
    );
    // The event loop must have kept turning during the 250ms wait. The old
    // synchronous spin yielded ZERO ticks; the async backoff yields dozens —
    // assert a conservative floor so a loaded CI runner can't flake it.
    assert.ok(ticks >= 3, `event loop starved during lock wait (${ticks} ticks)`);
    assert.ok(fs.existsSync(lock), "the unstealable lock must be left in place");
  } finally {
    clearInterval(interval);
    if (prevTimeout === undefined) delete process.env.GMAIL_MCP_LOCK_TIMEOUT_MS;
    else process.env.GMAIL_MCP_LOCK_TIMEOUT_MS = prevTimeout;
    fs.rmdirSync(lock);
  }
});

test("loadTokens returns empty without throwing on a corrupt store (#8)", () => {
  const file = path.join(dataDir, "tokens.json");
  // Guard the read: under --test-name-pattern / sharding no earlier test has
  // created tokens.json, and an unconditional read ENOENTs spuriously.
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    fs.writeFileSync(file, "{ not valid json");
    let result;
    assert.doesNotThrow(() => {
      result = auth.loadTokens();
    });
    // Spread first: the store is deliberately a null-prototype object (so a
    // key literally named "__proto__" stays an ordinary entry), and strict
    // deepEqual would otherwise fail on the prototype difference alone.
    assert.deepEqual({ ...result }, {});
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("loadTokens treats valid-but-non-object JSON as corrupt instead of crashing (#1)", () => {
  const file = path.join(dataDir, "tokens.json");
  // Guarded like the test above: isolated runs start with no tokens.json.
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    // `null` is the dangerous case: Object.entries(null) throws, which would
    // crash callers like startup's listAccounts(). An array or bare string used
    // to slip through and produce bogus index-keyed "accounts" ("0", "1", ...).
    // All must degrade to an empty store, exactly like unparseable JSON.
    for (const bad of ["null", '["a@b.com"]', '"hello"', "42"]) {
      fs.writeFileSync(file, bad);
      let result;
      assert.doesNotThrow(() => {
        result = auth.loadTokens();
      }, `loadTokens threw on ${bad}`);
      // Spread first — the store is a null-prototype object by design.
      assert.deepEqual({ ...result }, {}, `loadTokens(${bad}) should be empty`);
      assert.deepEqual(auth.listAccounts(), [], `listAccounts(${bad}) should be empty`);
    }
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("updateTokens refuses to overwrite a corrupt store, preserving the refresh tokens (M1)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  // A realistic hand-edit typo: the refresh tokens are still present as text,
  // but a missing closing brace makes the file unparseable. loadTokens degrades
  // to {} for readers, but any writer must NOT persist that empty fallback over
  // this recoverable file (that would destroy every account's refresh token).
  const corrupt =
    '{\n "alice@x.com": {"tokens":{"refresh_token":"RT_ALICE"},"credentialsFile":"credentials.json"},\n' +
    ' "bob@x.com": {"tokens":{"refresh_token":"RT_BOB"},"credentialsFile":"credentials.json"\n';
  try {
    // saveAccount must throw and leave the file byte-for-byte unchanged.
    fs.writeFileSync(file, corrupt);
    await assert.rejects(
      () => auth.saveAccount("carol@x.com", { access_token: "c", refresh_token: "RT_C" }, "credentials.json"),
      /Refusing to modify the token store/
    );
    assert.equal(fs.readFileSync(file, "utf-8"), corrupt, "corrupt file must be untouched");

    // removeAccount must refuse too.
    fs.writeFileSync(file, corrupt);
    await assert.rejects(() => auth.removeAccount("alice@x.com"), /Refusing to modify/);
    assert.equal(fs.readFileSync(file, "utf-8"), corrupt);

    // The fire-and-forget refresh listener must not wipe it either.
    fs.writeFileSync(file, corrupt);
    const client = auth.getAuthedClient("alice@x.com", {
      "alice@x.com": {
        tokens: { refresh_token: "RT_ALICE", access_token: "a", expiry_date: 1 },
        credentialsFile: "credentials.json",
      },
    });
    client.emit("tokens", { access_token: "NEW", expiry_date: 9999999999999 });
    await new Promise((r) => setTimeout(r, 100));
    const after = fs.readFileSync(file, "utf-8");
    assert.equal(after, corrupt, "refresh listener must not overwrite a corrupt store");
    assert.match(after, /RT_ALICE/);
    assert.match(after, /RT_BOB/);

    // Once repaired, writes resume normally.
    fs.writeFileSync(file, JSON.stringify({}));
    await auth.saveAccount("dave@x.com", { access_token: "d", refresh_token: "RT_D" }, "credentials.json");
    assert.ok(auth.listAccounts().includes("dave@x.com"), "writes resume after repair");
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("newOAuthClient sets a transport timeout so a hung token refresh can't wedge the account (H1)", async () => {
  const prev = process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS;
  const server = http.createServer(() => {
    /* accept the connection, never respond */
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/token`;
  try {
    process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS = "300";
    const client = auth.newOAuthClient(path.join(dataDir, "credentials.json"), url);
    // Point the token endpoint at the hung server and force a refresh (expired).
    client.endpoints = { ...client.endpoints, oauth2TokenUrl: url };
    client.setCredentials({ refresh_token: "rt", access_token: "at", expiry_date: 1 });
    // Without the transporter timeout this refresh hangs forever; assert it
    // rejects well within a ceiling instead (the ceiling wins => "hung" => fail).
    const outcome = await Promise.race([
      client.getAccessToken().then(
        () => "resolved",
        () => "rejected"
      ),
      new Promise((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    assert.equal(outcome, "rejected", "a hung token refresh must time out and reject, not hang");
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS;
    else process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS = prev;
    // Destroy any live connection BEFORE the graceful close: in the failure
    // mode this test guards (the transporter timeout stops applying), the
    // still-pending refresh holds its socket open forever, and a bare
    // server.close() waits on it — hanging the whole test run at the workflow
    // timeout instead of reporting the crisp assertion failure above.
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("getAuthedClient rebuilds when the on-disk refresh token changes (#1)", async () => {
  await auth.saveAccount(
    "rotate@x.com",
    { access_token: "a1", refresh_token: "r1" },
    "credentials.json"
  );
  const first = auth.getAuthedClient("rotate@x.com");
  // Unchanged tokens on disk → the same cached client is reused.
  assert.equal(auth.getAuthedClient("rotate@x.com"), first);

  // Simulate re-consent in a separate process: tokens.json is rewritten with a
  // new refresh token WITHOUT going through removeAccount (which clears the
  // cache). A long-running server must notice and rebuild rather than keep
  // using the stale client holding the now-dead token.
  await auth.saveAccount(
    "rotate@x.com",
    { access_token: "a2", refresh_token: "r2" },
    "credentials.json"
  );
  const rebuilt = auth.getAuthedClient("rotate@x.com");
  assert.notEqual(rebuilt, first, "a changed refresh token must invalidate the cache");
  // The rebuilt client must still carry exactly one persistence listener.
  assert.equal(rebuilt.listenerCount("tokens"), 1);
});

test("getAuthedClient keeps the cached client across a refresh-token rotation (#2)", async () => {
  await auth.saveAccount(
    "rotate2@x.com",
    { access_token: "a1", refresh_token: "r1" },
    "credentials.json"
  );
  const first = auth.getAuthedClient("rotate2@x.com");

  // Simulate google-auth-library rotating the refresh token during a refresh:
  // it emits 'tokens' carrying a new refresh_token, which the cache listener
  // persists to disk. The cached freshness signature must move with it, so the
  // next lookup doesn't mistake our own rotation for an out-of-process
  // re-consent and needlessly rebuild a still-valid client.
  first.emit("tokens", { access_token: "a2", refresh_token: "r2" });
  await new Promise((r) => setTimeout(r, 50)); // let the async persist settle

  assert.equal(
    auth.getAuthedClient("rotate2@x.com"),
    first,
    "an in-process rotation should not invalidate the cached client"
  );
  assert.equal(first.listenerCount("tokens"), 1, "no duplicate persistence listener");

  // Control: a change made WITHOUT going through this client's listener (an
  // out-of-process re-consent) must still force a rebuild — proving the
  // signature check itself is intact, not simply disabled.
  await auth.saveAccount(
    "rotate2@x.com",
    { access_token: "a3", refresh_token: "r3" },
    "credentials.json"
  );
  assert.notEqual(
    auth.getAuthedClient("rotate2@x.com"),
    first,
    "an out-of-process refresh-token change must still rebuild"
  );
});

test("the data dir is created owner-only (0700) (#3)", async () => {
  // Unix permission bits are meaningless on Windows; only assert on POSIX.
  if (process.platform === "win32") return;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-perms-"));
  const nested = path.join(parent, "fresh", ".gmail-mcp"); // does not exist yet
  const prev = process.env.GMAIL_MCP_DATA_DIR;
  try {
    process.env.GMAIL_MCP_DATA_DIR = nested;
    // saveAccount -> updateTokens -> withTokenLock/saveTokens both go through
    // ensureDataDir, which must create the dir 0700 (tokens.json is already 0600).
    await auth.saveAccount("perms@x.com", { access_token: "t" }, "credentials.json");
    const mode = fs.statSync(nested).mode & 0o777;
    assert.equal(mode, 0o700, `expected 0700, got 0${mode.toString(8)}`);
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_DATA_DIR;
    else process.env.GMAIL_MCP_DATA_DIR = prev;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a removed account isn't resurrected by a late token refresh from its old client (#C4)", async () => {
  await auth.saveAccount(
    "ghost@x.com",
    { access_token: "a1", refresh_token: "r1" },
    "credentials.json"
  );
  const client = auth.getAuthedClient("ghost@x.com");
  assert.equal(await auth.removeAccount("ghost@x.com"), true);
  assert.ok(!auth.listAccounts().includes("ghost@x.com"));

  // The evicted client emits a token refresh AFTER removal. Its listener must
  // not write the account back into the store.
  client.emit("tokens", { access_token: "a2", refresh_token: "r2" });
  await new Promise((r) => setTimeout(r, 50)); // let the async persist settle

  assert.ok(
    !auth.listAccounts().includes("ghost@x.com"),
    "a removed account must stay removed"
  );
});

test("withTokenLock fails instead of writing unlocked when the lock is held (#B3)", async () => {
  const lock = path.join(dataDir, "tokens.json.lock");
  // A fresh (non-stale) lock that won't be stolen within the short window.
  fs.writeFileSync(lock, "424242");
  const prev = process.env.GMAIL_MCP_LOCK_TIMEOUT_MS;
  process.env.GMAIL_MCP_LOCK_TIMEOUT_MS = "150";
  try {
    await assert.rejects(
      auth.saveAccount("contend@x.com", { access_token: "t" }, "credentials.json"),
      /Could not acquire the token-store lock/
    );
    assert.ok(
      !auth.listAccounts().includes("contend@x.com"),
      "must not write the account when the lock couldn't be acquired"
    );
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_LOCK_TIMEOUT_MS;
    else process.env.GMAIL_MCP_LOCK_TIMEOUT_MS = prev;
    fs.rmSync(lock, { force: true });
  }
});

// --------------------------------------------------------------------------
// Review cleanup: remaining lows and notes
// --------------------------------------------------------------------------
test("the tokens listener persists a snapshot taken at emit time, not the later-mutated object (low)", async () => {
  // google-auth-library mutates the emitted object AFTER emitting (it stamps
  // the old refresh token back on). If the persist is delayed by lock
  // contention, merging the live object would revert a rotation. Hold the lock
  // during the emit, mutate the object post-emit, then release and check what
  // actually got persisted.
  const key = "snap@x.com";
  await auth.saveAccount(key, { access_token: "A0", refresh_token: "RT_old" }, "credentials.json");
  auth.getAuthedClient(key); // installs the persistence listener
  const client = auth.getAuthedClient(key);

  const lock = path.join(dataDir, "tokens.json.lock");
  fs.writeFileSync(lock, `${process.pid}`); // fresh lock → persist must wait
  try {
    const emitted = { access_token: "A_new", refresh_token: "R_new" };
    client.emit("tokens", emitted);
    // Simulate the library's post-emit mutation of the same object.
    emitted.refresh_token = "R_stale_mutation";
    emitted.access_token = "A_stale_mutation";
    await new Promise((r) => setTimeout(r, 80)); // listener now parked on the lock
  } finally {
    fs.rmSync(lock, { force: true });
  }
  // Poll until the delayed persist lands (lock backoff is 25-50ms per retry).
  let persisted;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    persisted = auth.loadTokens()[key]?.tokens;
    if (persisted?.refresh_token !== "RT_old") break;
  }
  assert.equal(persisted?.refresh_token, "R_new", "must persist the value as of emit time");
  assert.equal(persisted?.access_token, "A_new");
  await auth.removeAccount(key);
});

test("loadTokens lowercases store keys so resolveAccount and getAuthedClient agree (low)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        "Alice@Gmail.com": {
          tokens: { access_token: "a", refresh_token: "r" },
          credentialsFile: "credentials.json",
        },
      })
    );
    const store = auth.loadTokens();
    assert.deepEqual(Object.keys(store), ["alice@gmail.com"]);
    // Previously: resolveAccount listed the account yet claimed it wasn't
    // connected, and the single-account path handed getAuthedClient a key it
    // couldn't find. Both consumers must now work.
    assert.equal(auth.resolveAccount("ALICE@gmail.com", store), "alice@gmail.com");
    assert.equal(auth.resolveAccount(undefined, store), "alice@gmail.com");
    assert.ok(auth.getAuthedClient("alice@gmail.com", store));
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("loadTokens skips malformed entries instead of planting TypeErrors (low)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        "null-entry@x.com": null,
        "null-tokens@x.com": { tokens: null, credentialsFile: "credentials.json" },
        "bad-credfile@x.com": { tokens: { access_token: "a" }, credentialsFile: 42 },
        "ok@x.com": {
          tokens: { access_token: "a", refresh_token: "r" },
          credentialsFile: "credentials.json",
        },
      })
    );
    let store;
    assert.doesNotThrow(() => {
      store = auth.loadTokens();
    });
    // Only the well-formed entry survives; the rest are skipped (with a
    // one-time stderr warning), not wrapped into crash-later shapes.
    assert.deepEqual(Object.keys(store), ["ok@x.com"]);
    assert.ok(auth.getAuthedClient("ok@x.com", store));
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("a malformed entry's recoverable refresh token survives an unrelated write (round-3 M1)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    // bob is malformed (credentialsFile has the wrong type from a hand-edit)
    // but still holds a refresh token recoverable by hand. Skipping it on READ
    // must NOT let a subsequent WRITE for an unrelated account erase it — that
    // silently destroyed the credential (defeating the corrupt-store-refusal
    // invariant it was meant to uphold).
    fs.writeFileSync(
      file,
      JSON.stringify({
        "alice@x.com": {
          tokens: { access_token: "a", refresh_token: "RT_ALICE" },
          credentialsFile: "credentials.json",
        },
        "bob@x.com": {
          tokens: { access_token: "b", refresh_token: "RT_BOB_RECOVERABLE" },
          credentialsFile: 42,
        },
      })
    );
    // Readers never see the malformed entry.
    assert.deepEqual(auth.listAccounts(), ["alice@x.com"]);

    // An unrelated write must preserve bob's token on disk.
    await auth.saveAccount("carol@x.com", { access_token: "c", refresh_token: "RT_CAROL" }, "credentials.json");
    let disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(disk["bob@x.com"]?.tokens?.refresh_token, "RT_BOB_RECOVERABLE", "malformed entry must survive an unrelated saveAccount");

    // ...and a removal of a DIFFERENT account must not destroy it either.
    await auth.removeAccount("alice@x.com");
    disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(disk["bob@x.com"]?.tokens?.refresh_token, "RT_BOB_RECOVERABLE", "malformed entry must survive an unrelated removeAccount");

    // Re-adding bob properly REPLACES the malformed copy (no stale duplicate).
    await auth.saveAccount("bob@x.com", { access_token: "b2", refresh_token: "RT_BOB_NEW" }, "credentials.json");
    disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(disk["bob@x.com"]?.credentialsFile, "credentials.json");
    assert.equal(disk["bob@x.com"]?.tokens?.refresh_token, "RT_BOB_NEW");
    assert.ok(auth.listAccounts().includes("bob@x.com"), "bob is usable after repair");
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("removeAccount purges a malformed (preserved) entry instead of misreporting it as not-connected (round-4)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    // bob is malformed on read (credentialsFile has the wrong type) but still
    // holds a recoverable refresh token, so it lives only in the `preserved`
    // map, never in the readable store. A user who runs a disconnect for bob
    // must actually remove that on-disk record — including the recoverable
    // secret — not get told "was not connected" while the token lingers.
    fs.writeFileSync(
      file,
      JSON.stringify({
        "alice@x.com": {
          tokens: { access_token: "a", refresh_token: "RT_ALICE" },
          credentialsFile: "credentials.json",
        },
        "bob@x.com": {
          tokens: { access_token: "b", refresh_token: "RT_BOB_RECOVERABLE" },
          credentialsFile: 42,
        },
      })
    );
    // Readers never see the malformed entry, and it's not in the usable set.
    assert.deepEqual(auth.listAccounts(), ["alice@x.com"]);

    // Removing bob must report success (it DID exist on disk) and wipe the
    // record, recoverable refresh token and all. Case-insensitively, too.
    assert.equal(await auth.removeAccount("BOB@x.com"), true, "removeAccount must report a preserved entry as removed");
    const disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.ok(!("bob@x.com" in disk), "the malformed entry must be gone from disk");
    assert.equal(disk["alice@x.com"]?.tokens?.refresh_token, "RT_ALICE", "unrelated accounts are untouched");

    // A second removal now finds nothing and reports it honestly.
    assert.equal(await auth.removeAccount("bob@x.com"), false, "a second removal reports not-connected");
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("loadTokens migrates a legacy raw-Credentials entry to the current shape (low)", () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    // Pre-per-account-credential stores mapped email -> raw Credentials.
    fs.writeFileSync(
      file,
      JSON.stringify({ "legacy@x.com": { access_token: "la", refresh_token: "lr" } })
    );
    const store = auth.loadTokens();
    assert.deepEqual(store["legacy@x.com"], {
      tokens: { access_token: "la", refresh_token: "lr" },
      credentialsFile: "credentials.json",
    });
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("legacy migration keeps an external GMAIL_OAUTH_CREDENTIALS ref absolute (round-5 M1)", () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  const prevEnv = process.env.GMAIL_OAUTH_CREDENTIALS;
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-extcred-"));
  const extCred = path.join(extDir, "gmail-client.json");
  try {
    // README-documented setup: the OAuth client lives OUTSIDE the data dir.
    fs.writeFileSync(
      extCred,
      JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } })
    );
    process.env.GMAIL_OAUTH_CREDENTIALS = extCred;
    fs.writeFileSync(
      file,
      JSON.stringify({ "legacy@x.com": { access_token: "la", refresh_token: "lr" } })
    );
    const store = auth.loadTokens();
    // A basename-only ref would resolve against the data dir — where this file
    // does not exist — breaking every call for the migrated account and baking
    // the broken ref into tokens.json on the next write.
    assert.equal(store["legacy@x.com"]?.credentialsFile, extCred);
    assert.ok(
      auth.getAuthedClient("legacy@x.com", store),
      "the migrated account must be usable with the env-configured credentials"
    );
  } finally {
    if (prevEnv === undefined) delete process.env.GMAIL_OAUTH_CREDENTIALS;
    else process.env.GMAIL_OAUTH_CREDENTIALS = prevEnv;
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }
});

test("prototype-named keys are ordinary entries: listed, preserved across writes, removable (round-5)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    // tokens.json is user-editable, so keys named after Object.prototype
    // properties must behave like any other key. "__proto__" used to mutate
    // the store's prototype (an invisible phantom entry, erased by the next
    // write); a malformed "constructor" was dropped by the preserve merge
    // (`in` consulted the prototype chain) and removeAccount("constructor")
    // reported success on a store that never contained it.
    fs.writeFileSync(
      file,
      // Computed keys: a literal `"__proto__":` in an object initializer sets
      // the object's PROTOTYPE (spec B.3.1) instead of creating an own
      // property, so JSON.stringify would silently drop the entry.
      JSON.stringify({
        "keep@x.com": {
          tokens: { access_token: "k", refresh_token: "RT_KEEP" },
          credentialsFile: "credentials.json",
        },
        ["__proto__"]: {
          tokens: { access_token: "p", refresh_token: "RT_PROTO" },
          credentialsFile: "credentials.json",
        },
        ["constructor"]: {
          tokens: { access_token: "c", refresh_token: "RT_CTOR" },
          credentialsFile: 42, // malformed → lives in the preserved map
        },
      })
    );
    const store = auth.loadTokens();
    assert.ok(
      Object.keys(store).includes("__proto__"),
      "a valid-shaped __proto__ entry is a real, listed entry"
    );
    assert.equal(store["tokens"], undefined, "no prototype pollution");
    assert.equal(store["credentialsFile"], undefined, "no prototype pollution");

    // accountCredentials (the list-accounts data source) must record the
    // entry too: its plain-{} output map used to hit the __proto__ setter,
    // printing "[object Object]" for this account (round-6).
    const creds = auth.accountCredentials();
    assert.equal(
      creds["__proto__"],
      "credentials.json",
      "accountCredentials must carry a __proto__-keyed account"
    );

    // An unrelated write must keep BOTH prototype-named records on disk.
    await auth.saveAccount(
      "other@x.com",
      { access_token: "o", refresh_token: "RT_OTHER" },
      "credentials.json"
    );
    let disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(
      disk["__proto__"]?.tokens?.refresh_token,
      "RT_PROTO",
      "__proto__ entry must survive an unrelated write"
    );
    assert.equal(
      disk["constructor"]?.tokens?.refresh_token,
      "RT_CTOR",
      "preserved 'constructor' entry must survive an unrelated write"
    );

    // Removal reports honestly and actually removes.
    assert.equal(await auth.removeAccount("nosuch@x.com"), false);
    assert.equal(await auth.removeAccount("constructor"), true);
    assert.equal(await auth.removeAccount("__proto__"), true);
    assert.equal(
      await auth.removeAccount("constructor"),
      false,
      "a second removal reports not-connected"
    );
    disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.ok(!Object.keys(disk).includes("__proto__"));
    assert.ok(!Object.keys(disk).includes("constructor"));
    assert.equal(disk["keep@x.com"]?.tokens?.refresh_token, "RT_KEEP");
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("an array-valued entry is preserved as malformed, not misclassified as legacy (round-5)", async () => {
  const file = path.join(dataDir, "tokens.json");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    // An array is `typeof "object"` without the current shape's keys, so it
    // used to take the legacy-Credentials branch: listed as a connected
    // account, failing opaquely on every call, and rewritten on disk in
    // wrapped form. It must be treated as malformed instead: unlisted, warned
    // about, and round-tripped on writes byte-for-byte.
    fs.writeFileSync(
      file,
      JSON.stringify({
        "ok@x.com": {
          tokens: { access_token: "a", refresh_token: "r" },
          credentialsFile: "credentials.json",
        },
        "work@x.com": [],
      })
    );
    assert.deepEqual(auth.listAccounts(), ["ok@x.com"], "array entry must not be listed");

    await auth.saveAccount(
      "carol@x.com",
      { access_token: "c", refresh_token: "rc" },
      "credentials.json"
    );
    const disk = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.deepEqual(
      disk["work@x.com"],
      [],
      "the array must survive on disk untouched (preserved, not wrapped)"
    );
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test("newOAuthClient enables forceRefreshOnFailure so a server-side-invalidated token self-heals (note)", () => {
  const client = auth.newOAuthClient(path.join(dataDir, "credentials.json"));
  assert.equal(client.forceRefreshOnFailure, true);
});
