import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import { listenWithFallback } from "../dist/add-account.js";
import {
  oauthRedirectUri,
  OAUTH_REDIRECT_PORT,
  attachmentDirs,
} from "../dist/constants.js";

const close = (s) => new Promise((r) => s.close(r));

// --------------------------------------------------------------------------
// oauthRedirectUri / attachmentDirs  (config helpers)
// --------------------------------------------------------------------------
test("oauthRedirectUri formats per-port and defaults to the preferred port", () => {
  assert.equal(oauthRedirectUri(12345), "http://localhost:12345/oauth2callback");
  assert.equal(oauthRedirectUri(), `http://localhost:${OAUTH_REDIRECT_PORT}/oauth2callback`);
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
  const s = http.createServer();
  try {
    const port = await listenWithFallback(s, OAUTH_REDIRECT_PORT);
    assert.equal(port, OAUTH_REDIRECT_PORT);
    assert.equal(s.listening, true);
  } finally {
    await close(s);
  }
});

test("listenWithFallback falls back to an ephemeral port when the preferred one is busy", async () => {
  const holder = http.createServer();
  const fallback = http.createServer();
  try {
    const held = await listenWithFallback(holder, OAUTH_REDIRECT_PORT);
    assert.equal(held, OAUTH_REDIRECT_PORT);

    const port = await listenWithFallback(fallback, OAUTH_REDIRECT_PORT);
    assert.notEqual(port, OAUTH_REDIRECT_PORT);
    assert.ok(port > 0);
    assert.equal(fallback.listening, true);
  } finally {
    await close(holder);
    await close(fallback);
  }
});
