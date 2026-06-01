import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import { listenWithFallback, escapeHtml } from "../dist/add-account.js";
import {
  oauthRedirectUri,
  OAUTH_REDIRECT_PORT,
  attachmentDirs,
} from "../dist/constants.js";

const close = (s) => new Promise((r) => s.close(r));
const listen = (s, port) => new Promise((r) => s.listen(port, r));
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
  assert.equal(oauthRedirectUri(12345), "http://localhost:12345/oauth2callback");
  assert.equal(oauthRedirectUri(), `http://localhost:${OAUTH_REDIRECT_PORT}/oauth2callback`);
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
