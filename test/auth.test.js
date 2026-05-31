import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const auth = await import("../dist/auth.js");

test("saveAccount/loadTokens roundtrip, atomic write, 0600 perms, no temp leftover", () => {
  auth.saveAccount("a@b.com", { access_token: "x", refresh_token: "y" }, "credentials.json");

  const store = auth.loadTokens();
  assert.equal(store["a@b.com"].tokens.access_token, "x");
  assert.equal(store["a@b.com"].credentialsFile, "credentials.json");

  const mode = fs.statSync(path.join(dataDir, "tokens.json")).mode & 0o777;
  assert.equal(mode, 0o600);

  const leftover = fs.readdirSync(dataDir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftover, []);
});

test("getAuthedClient caches one client per account with a single tokens listener", () => {
  const c1 = auth.getAuthedClient("a@b.com");
  const c2 = auth.getAuthedClient("A@B.com"); // case-insensitive key
  assert.equal(c1, c2);
  assert.equal(c1.listenerCount("tokens"), 1);
});

test("different accounts get different cached clients", () => {
  auth.saveAccount("c@d.com", { access_token: "z", refresh_token: "w" }, "credentials.json");
  assert.notEqual(auth.getAuthedClient("c@d.com"), auth.getAuthedClient("a@b.com"));
});

test("removeAccount evicts the cached client and the stored tokens", () => {
  const before = auth.getAuthedClient("a@b.com");
  assert.equal(auth.removeAccount("a@b.com"), true);
  assert.ok(!auth.listAccounts().includes("a@b.com"));

  auth.saveAccount("a@b.com", { access_token: "x2", refresh_token: "y2" }, "credentials.json");
  assert.notEqual(auth.getAuthedClient("a@b.com"), before);
});

test("resolveAccount disambiguates by count and validates explicit requests", () => {
  // Leave exactly one account connected (c@d.com) for a deterministic check.
  auth.removeAccount("a@b.com");
  assert.equal(auth.listAccounts().length, 1);
  assert.equal(auth.resolveAccount(), "c@d.com");
  assert.equal(auth.resolveAccount("C@D.com"), "c@d.com");
  assert.throws(() => auth.resolveAccount("missing@x.com"), /not connected/);
});
