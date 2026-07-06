import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import {
  listenWithFallback,
  escapeHtml,
  validateCallback,
} from "../src/add-account.js";
import {
  oauthRedirectUri,
  OAUTH_REDIRECT_PORT,
  attachmentDirs,
  gmailRequestTimeoutMs,
  GMAIL_REQUEST_TIMEOUT_MS,
} from "../src/constants.js";

const close = (s) => new Promise((r) => s.close(r));
// Bind on the loopback interface, matching listenWithFallback. A wildcard
// (0.0.0.0) holder would not reliably collide with a specific 127.0.0.1 bind on
// the same port on macOS/Windows (only Linux returns EADDRINUSE there), which
// would make the "port is busy" fallback test pass on Linux but fail elsewhere.
const listen = (s, port) => new Promise((r) => s.listen(port, "127.0.0.1", r));
// Bind an ephemeral port, read it, release it — a port we know was free.
const aFreePort = async () => {
  const s = http.createServer();
  await listen(s, 0);
  const { port } = s.address();
  await close(s);
  return port;
};

// --------------------------------------------------------------------------
// oauthRedirectUri / attachmentDirs  (config helpers)
// --------------------------------------------------------------------------
test("oauthRedirectUri formats per-port and defaults to the preferred port", () => {
  assert.equal(oauthRedirectUri(12345), "http://127.0.0.1:12345/oauth2callback");
  assert.equal(oauthRedirectUri(), `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/oauth2callback`);
});

// --------------------------------------------------------------------------
// validateCallback  (OAuth state / CSRF guard)
// --------------------------------------------------------------------------
test("validateCallback returns the code when state matches", () => {
  const params = new URLSearchParams({ state: "abc123", code: "auth-code" });
  assert.deepEqual(validateCallback(params, "abc123"), {
    status: "ok",
    code: "auth-code",
  });
});

test("validateCallback ignores a mismatched state instead of aborting (CSRF guard) (#2)", () => {
  // A stray or forged loopback hit must be classified "ignore" so the consent
  // server keeps waiting for the genuine callback rather than tearing down.
  const params = new URLSearchParams({ state: "attacker", code: "auth-code" });
  assert.equal(validateCallback(params, "abc123").status, "ignore");
});

test("validateCallback checks state before an error param, so a forged error can't abort it (#2)", () => {
  // An attacker racing the loopback with ?error=...&state=wrong must not be able
  // to fail the flow: state is verified first, so this is ignored, not surfaced.
  const params = new URLSearchParams({ error: "access_denied", state: "wrong" });
  assert.equal(validateCallback(params, "abc123").status, "ignore");
});

test("validateCallback surfaces an OAuth error once the state matches", () => {
  const params = new URLSearchParams({ error: "access_denied", state: "abc123" });
  assert.deepEqual(validateCallback(params, "abc123"), {
    status: "error",
    error: "access_denied",
  });
});

test("validateCallback reports a missing code (with matching state) as an error", () => {
  const params = new URLSearchParams({ state: "abc123" });
  assert.equal(validateCallback(params, "abc123").status, "error");
});

test("escapeHtml neutralizes HTML metacharacters in the OAuth callback page", () => {
  assert.equal(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
});

test("attachmentDirs is empty when unset and splits the env var on the path delimiter", () => {
  const prev = process.env.GMAIL_MCP_ATTACHMENTS_DIR;
  try {
    delete process.env.GMAIL_MCP_ATTACHMENTS_DIR;
    assert.deepEqual(attachmentDirs(), []);

    process.env.GMAIL_MCP_ATTACHMENTS_DIR = ["/tmp/a", "/tmp/b"].join(path.delimiter);
    assert.deepEqual(attachmentDirs(), [path.resolve("/tmp/a"), path.resolve("/tmp/b")]);
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_ATTACHMENTS_DIR;
    else process.env.GMAIL_MCP_ATTACHMENTS_DIR = prev;
  }
});

// --------------------------------------------------------------------------
// listenWithFallback  (OAuth port nit)
// --------------------------------------------------------------------------
test("listenWithFallback binds the preferred port when it is free", async () => {
  // Use a port we just confirmed free, rather than assuming 4773 is available.
  const free = await aFreePort();
  const s = http.createServer();
  try {
    const port = await listenWithFallback(s, free);
    assert.equal(port, free);
    assert.equal(s.listening, true);
    // Must bind to loopback, not all interfaces, so it isn't LAN-reachable.
    assert.equal(s.address().address, "127.0.0.1");
  } finally {
    await close(s);
  }
});

test("listenWithFallback falls back to an ephemeral port when the preferred one is busy", async () => {
  const holder = http.createServer();
  const fallback = http.createServer();
  try {
    // Occupy a port, then ask listenWithFallback to prefer that same busy port.
    await listen(holder, 0);
    const busy = holder.address().port;

    const port = await listenWithFallback(fallback, busy);
    assert.notEqual(port, busy);
    assert.ok(port > 0);
    assert.equal(fallback.listening, true);
  } finally {
    await close(holder);
    await close(fallback);
  }
});

test("gmailRequestTimeoutMs defaults, honors a valid override, and falls back on garbage (M7)", () => {
  const prev = process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS;
    assert.equal(gmailRequestTimeoutMs(), GMAIL_REQUEST_TIMEOUT_MS);

    process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS = "5000";
    assert.equal(gmailRequestTimeoutMs(), 5000);

    // Non-numeric, non-positive, and empty overrides must fall back to the
    // default rather than disabling or corrupting the timeout.
    for (const bad of ["abc", "-5", "0", ""]) {
      process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS = bad;
      assert.equal(
        gmailRequestTimeoutMs(),
        GMAIL_REQUEST_TIMEOUT_MS,
        `override ${JSON.stringify(bad)} must fall back to the default`
      );
    }
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS;
    else process.env.GMAIL_MCP_REQUEST_TIMEOUT_MS = prev;
  }
});
