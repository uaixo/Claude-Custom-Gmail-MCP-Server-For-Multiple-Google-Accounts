import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { google } from "googleapis";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server } from "../dist/index.js";

// --------------------------------------------------------------------------
// Handler integration tests (review item #4).
//
// These exercise the tool handlers end-to-end through a real in-memory MCP
// client, with the Gmail API faked. gmailFor() reads google.gmail at call time,
// so swapping that single factory on the shared googleapis singleton intercepts
// every tool's Gmail access — no network, and no production-code seam. Each
// fake records what it was called with, so we can assert the handler shaped the
// request correctly (q/maxResults, threadId, requestBody, metadata format, ...)
// and mapped the response into structuredContent.
// --------------------------------------------------------------------------

let dataDir;
let realGmail;
let client;
let currentFake = null;

/**
 * Build a fake gmail_v1 client whose methods record their params and return
 * canned responses. `handlers` maps "threads.list", "messages.send", etc. to a
 * response object or a function of the call params; an unmapped call throws so a
 * test can't silently pass against an unexpected request.
 */
function makeFake(handlers) {
  const calls = [];
  const method = (name) => async (params) => {
    calls.push({ name, params });
    const impl = handlers[name];
    if (impl === undefined) throw new Error(`unexpected Gmail call: ${name}`);
    return typeof impl === "function" ? impl(params) : impl;
  };
  const fakeClient = {
    users: {
      threads: {
        list: method("threads.list"),
        get: method("threads.get"),
        modify: method("threads.modify"),
      },
      messages: { send: method("messages.send"), modify: method("messages.modify") },
      drafts: { create: method("drafts.create") },
      labels: { list: method("labels.list"), create: method("labels.create") },
    },
  };
  return { client: fakeClient, calls };
}

/** Invoke a tool through the MCP client with a per-call fake Gmail. */
async function callTool(name, args, handlers = {}) {
  const fake = makeFake(handlers);
  currentFake = fake;
  try {
    const result = await client.callTool({ name, arguments: args });
    return { result, calls: fake.calls };
  } finally {
    currentFake = null;
  }
}

const utf8 = (s) => Buffer.from(s, "utf-8");

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-index-"));
  process.env.GMAIL_MCP_DATA_DIR = dataDir;
  fs.writeFileSync(
    path.join(dataDir, "credentials.json"),
    JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } })
  );
  // Two connected accounts so we also cover the disambiguation behavior.
  fs.writeFileSync(
    path.join(dataDir, "tokens.json"),
    JSON.stringify({
      "alice@example.com": {
        tokens: { access_token: "a", refresh_token: "ra" },
        credentialsFile: "credentials.json",
      },
      "bob@example.com": {
        tokens: { access_token: "b", refresh_token: "rb" },
        credentialsFile: "credentials.json",
      },
    })
  );

  realGmail = google.gmail;
  google.gmail = (opts) => {
    if (!currentFake) throw new Error("no fake Gmail installed for this call");
    currentFake.lastAuth = opts.auth;
    return currentFake.client;
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  google.gmail = realGmail;
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.GMAIL_MCP_DATA_DIR;
});

// --------------------------------------------------------------------------
// Account selection
// --------------------------------------------------------------------------
test("gmail_list_accounts lists every connected account", async () => {
  const { result } = await callTool("gmail_list_accounts", {});
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.count, 2);
  assert.deepEqual(result.structuredContent.accounts, [
    "alice@example.com",
    "bob@example.com",
  ]);
});

test("a tool requires the account parameter when several are connected", async () => {
  const { result } = await callTool("gmail_search_threads", { query: "x" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Multiple accounts connected/);
});

test("a tool rejects an unknown account with an actionable error", async () => {
  const { result } = await callTool("gmail_list_labels", {
    account: "nobody@example.com",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not connected/);
});

// --------------------------------------------------------------------------
// gmail_search_threads
// --------------------------------------------------------------------------
test("gmail_search_threads forwards the query/max_results and maps summaries", async () => {
  const { result, calls } = await callTool(
    "gmail_search_threads",
    { query: "is:unread", account: "alice@example.com", max_results: 7 },
    {
      "threads.list": { data: { threads: [{ id: "t1" }] } },
      "threads.get": {
        data: {
          messages: [
            {
              snippet: "snip",
              payload: {
                headers: [
                  { name: "Subject", value: "Hello" },
                  { name: "From", value: "x@y.com" },
                  { name: "Date", value: "today" },
                ],
              },
            },
          ],
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  const list = calls.find((c) => c.name === "threads.list");
  assert.equal(list.params.q, "is:unread");
  assert.equal(list.params.maxResults, 7);
  assert.equal(result.structuredContent.account, "alice@example.com");
  assert.deepEqual(result.structuredContent.threads, [
    { thread_id: "t1", subject: "Hello", from: "x@y.com", date: "today", snippet: "snip" },
  ]);
});

// --------------------------------------------------------------------------
// gmail_get_thread
// --------------------------------------------------------------------------
test("gmail_get_thread maps headers/body/labels for each message", async () => {
  const { result } = await callTool(
    "gmail_get_thread",
    { thread_id: "t1", account: "alice@example.com" },
    {
      "threads.get": {
        data: {
          messages: [
            {
              id: "m1",
              labelIds: ["INBOX", "UNREAD"],
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: "x@y.com" },
                  { name: "To", value: "me@x.com" },
                  { name: "Date", value: "d" },
                  { name: "Subject", value: "Hi" },
                ],
                body: { data: utf8("the body").toString("base64url") },
              },
            },
          ],
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  const [msg] = result.structuredContent.messages;
  assert.deepEqual(msg, {
    message_id: "m1",
    from: "x@y.com",
    to: "me@x.com",
    date: "d",
    subject: "Hi",
    body: "the body",
    label_ids: ["INBOX", "UNREAD"],
  });
  assert.equal(result.structuredContent.truncated, undefined);
});

test("gmail_get_thread caps the message count and reports how many were omitted", async () => {
  const messages = Array.from({ length: 105 }, (_, i) => ({
    id: `m${i}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: `S${i}` }],
      body: { data: utf8(`body ${i}`).toString("base64url") },
    },
  }));
  const { result } = await callTool(
    "gmail_get_thread",
    { thread_id: "t1", account: "alice@example.com" },
    { "threads.get": { data: { messages } } }
  );
  assert.equal(result.isError, undefined);
  const sc = result.structuredContent;
  assert.equal(sc.messages.length, 100); // MAX_THREAD_MESSAGES
  assert.equal(sc.omitted_message_count, 5);
  assert.equal(sc.truncated, true);
  assert.equal(sc.messages[0].message_id, "m0");
  assert.equal(sc.messages[0].body, "body 0");
});

// --------------------------------------------------------------------------
// gmail_send_message — reply threading wiring
// --------------------------------------------------------------------------
test("gmail_send_message threads a reply: metadata fetch, derived headers, send with threadId", async () => {
  let sentRaw = null;
  const { result, calls } = await callTool(
    "gmail_send_message",
    { to: ["x@y.com"], body: "thanks", account: "alice@example.com", thread_id: "t1" },
    {
      "threads.get": {
        data: {
          messages: [
            {
              payload: {
                headers: [
                  { name: "Subject", value: "Project kickoff" },
                  { name: "Message-ID", value: "<m1@x>" },
                ],
              },
            },
            {
              payload: {
                headers: [
                  { name: "Message-ID", value: "<m2@x>" },
                  { name: "References", value: "<m1@x>" },
                ],
              },
            },
          ],
        },
      },
      "messages.send": (p) => {
        sentRaw = p.requestBody.raw;
        return { data: { id: "sent1", threadId: "t1" } };
      },
    }
  );
  assert.equal(result.isError, undefined);
  // The reply-header derivation must use the cheap metadata format.
  const tg = calls.find((c) => c.name === "threads.get");
  assert.equal(tg.params.format, "metadata");
  // The send must carry the threadId so Gmail files it into the conversation.
  const send = calls.find((c) => c.name === "messages.send");
  assert.equal(send.params.requestBody.threadId, "t1");
  // ...and the derived threading headers/subject must land in the raw MIME.
  const mime = Buffer.from(sentRaw, "base64url").toString("utf-8");
  assert.match(mime, /In-Reply-To: <m2@x>/);
  assert.match(mime, /References: <m1@x> <m2@x>/);
  assert.match(mime, /^Subject: Re: Project kickoff$/m);
  assert.equal(result.structuredContent.message_id, "sent1");
  assert.equal(result.structuredContent.thread_id, "t1");
});

// --------------------------------------------------------------------------
// gmail_create_draft
// --------------------------------------------------------------------------
test("gmail_create_draft creates a draft and returns its ids", async () => {
  const { result, calls } = await callTool(
    "gmail_create_draft",
    { to: ["x@y.com"], subject: "Hi", body: "draft body", account: "alice@example.com" },
    { "drafts.create": { data: { id: "d1", message: { id: "msg1" } } } }
  );
  assert.equal(result.isError, undefined);
  const dc = calls.find((c) => c.name === "drafts.create");
  assert.ok(dc.params.requestBody.message.raw, "draft carries a raw message");
  assert.equal(result.structuredContent.draft_id, "d1");
  assert.equal(result.structuredContent.message_id, "msg1");
});

// --------------------------------------------------------------------------
// gmail_list_labels / gmail_create_label
// --------------------------------------------------------------------------
test("gmail_list_labels maps labels and defaults a missing type to 'user'", async () => {
  const { result } = await callTool(
    "gmail_list_labels",
    { account: "alice@example.com" },
    {
      "labels.list": {
        data: {
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "Label_1", name: "Acme" }, // no type
          ],
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.labels, [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "Acme", type: "user" },
  ]);
});

test("gmail_create_label sends the expected visibility settings", async () => {
  const { result, calls } = await callTool(
    "gmail_create_label",
    { name: "Clients/Acme", account: "alice@example.com" },
    { "labels.create": { data: { id: "Label_1", name: "Clients/Acme" } } }
  );
  assert.equal(result.isError, undefined);
  const lc = calls.find((c) => c.name === "labels.create");
  assert.deepEqual(lc.params.requestBody, {
    name: "Clients/Acme",
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  });
  assert.equal(result.structuredContent.id, "Label_1");
});

// --------------------------------------------------------------------------
// gmail_modify_labels — validation + target handling
// --------------------------------------------------------------------------
test("gmail_modify_labels requires exactly one of thread_id or message_id", async () => {
  const neither = await callTool("gmail_modify_labels", {
    add_label_ids: ["UNREAD"],
    account: "alice@example.com",
  });
  assert.equal(neither.result.isError, true);
  assert.match(neither.result.content[0].text, /exactly one of thread_id or message_id/);

  const both = await callTool("gmail_modify_labels", {
    thread_id: "t1",
    message_id: "m1",
    add_label_ids: ["UNREAD"],
    account: "alice@example.com",
  });
  assert.equal(both.result.isError, true);
  assert.match(both.result.content[0].text, /exactly one of thread_id or message_id/);
});

test("gmail_modify_labels requires at least one label to add or remove", async () => {
  const { result } = await callTool("gmail_modify_labels", {
    thread_id: "t1",
    account: "alice@example.com",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /at least one of add_label_ids or remove_label_ids/);
});

test("gmail_modify_labels on a thread reports the union of labels across messages", async () => {
  const { result, calls } = await callTool(
    "gmail_modify_labels",
    { thread_id: "t1", remove_label_ids: ["UNREAD"], account: "alice@example.com" },
    {
      "threads.modify": {
        data: {
          id: "t1",
          messages: [
            { id: "m1", labelIds: ["INBOX", "IMPORTANT"] },
            { id: "m2", labelIds: ["INBOX", "STARRED"] },
          ],
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  const mod = calls.find((c) => c.name === "threads.modify");
  assert.deepEqual(mod.params.requestBody, { addLabelIds: [], removeLabelIds: ["UNREAD"] });
  assert.equal(result.structuredContent.target, "thread");
  assert.deepEqual(
    [...result.structuredContent.label_ids].sort(),
    ["IMPORTANT", "INBOX", "STARRED"]
  );
});

test("gmail_modify_labels on a single message returns that message's labels", async () => {
  const { result, calls } = await callTool(
    "gmail_modify_labels",
    { message_id: "m1", add_label_ids: ["STARRED"], account: "alice@example.com" },
    { "messages.modify": { data: { id: "m1", labelIds: ["INBOX", "STARRED"] } } }
  );
  assert.equal(result.isError, undefined);
  const mod = calls.find((c) => c.name === "messages.modify");
  assert.equal(mod.params.id, "m1");
  assert.deepEqual(mod.params.requestBody, { addLabelIds: ["STARRED"], removeLabelIds: [] });
  assert.equal(result.structuredContent.target, "message");
  assert.deepEqual(result.structuredContent.label_ids, ["INBOX", "STARRED"]);
});

// --------------------------------------------------------------------------
// Error surfacing
// --------------------------------------------------------------------------
test("a Gmail API error is surfaced as an isError result, not thrown", async () => {
  const { result } = await callTool(
    "gmail_list_labels",
    { account: "alice@example.com" },
    {
      "labels.list": () => {
        const e = new Error("boom");
        e.code = 404;
        throw e;
      },
    }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);
});

// --------------------------------------------------------------------------
// gmail_list_labels caps oversized text like the other read tools (#1)
// --------------------------------------------------------------------------
test("gmail_list_labels routes oversized output through the text budget (#1)", async () => {
  // Enough labels that the pretty-printed JSON exceeds CHARACTER_LIMIT (25000):
  // the text channel must fall back to the structuredContent notice rather than
  // dumping oversized JSON, while structuredContent still carries every label.
  const labels = Array.from({ length: 1200 }, (_, i) => ({
    id: `Label_${i}`,
    name: `A reasonably descriptive label name number ${i}`,
    type: "user",
  }));
  const { result } = await callTool(
    "gmail_list_labels",
    { account: "alice@example.com" },
    { "labels.list": { data: { labels } } }
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.labels.length, 1200);
  // The text is the safe notice (not parseable JSON), pointing at structuredContent.
  assert.throws(() => JSON.parse(result.content[0].text));
  assert.match(result.content[0].text, /structuredContent/);
});

// --------------------------------------------------------------------------
// gmail_get_thread body budget is decoupled from the render budget (#2)
// --------------------------------------------------------------------------
test("gmail_get_thread keeps a large single body within the text channel (#2)", async () => {
  // A body larger than the thread body budget but, once truncated, small enough
  // that the rendered JSON still fits CHARACTER_LIMIT — so the text channel
  // returns real JSON, not the "too large" notice. This only holds because the
  // body budget (MAX_THREAD_BODY_CHARS) is below the render budget.
  const bigBody = "x".repeat(30000);
  const { result } = await callTool(
    "gmail_get_thread",
    { thread_id: "t1", account: "alice@example.com" },
    {
      "threads.get": {
        data: {
          messages: [
            {
              id: "m1",
              labelIds: ["INBOX"],
              payload: {
                mimeType: "text/plain",
                headers: [{ name: "Subject", value: "Big" }],
                body: { data: utf8(bigBody).toString("base64url") },
              },
            },
          ],
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.truncated, true);
  const body = result.structuredContent.messages[0].body;
  assert.ok(body.length < bigBody.length, "body should be truncated");
  assert.match(body, /truncated/);
  // The text channel rendered real JSON rather than the oversized notice...
  assert.doesNotMatch(result.content[0].text, /Result too large/);
  // ...and it round-trips to the same structuredContent body.
  assert.equal(JSON.parse(result.content[0].text).messages[0].body, body);
});

// --------------------------------------------------------------------------
// attachment schema enforces "exactly one of path / content_base64" (#4)
// --------------------------------------------------------------------------
test("gmail_create_draft rejects an attachment with both path and content_base64 (#4)", async () => {
  // The union schema fails validation at the boundary (Zod 'unrecognized_keys'),
  // so the input is rejected as a schema-level validation error before the
  // handler runs — not via resolveAttachments' runtime check. An empty call list
  // proves the handler never reached the Gmail API.
  const { result, calls } = await callTool("gmail_create_draft", {
    to: ["x@y.com"],
    body: "b",
    account: "alice@example.com",
    attachments: [{ path: "/x", content_base64: "QQ==", filename: "a.bin" }],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Input validation error/);
  assert.equal(calls.length, 0, "no Gmail call should happen on invalid input");
});

test("gmail_create_draft rejects inline content_base64 without a filename (#4)", async () => {
  // The inline branch requires filename, so this fails union validation at the
  // schema boundary.
  const { result, calls } = await callTool("gmail_create_draft", {
    to: ["x@y.com"],
    body: "b",
    account: "alice@example.com",
    attachments: [{ content_base64: "QQ==" }],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Input validation error/);
  assert.equal(calls.length, 0, "no Gmail call should happen on invalid input");
});

test("gmail_create_draft accepts a valid inline attachment (#4)", async () => {
  // The happy path still works through the union schema.
  const { result, calls } = await callTool(
    "gmail_create_draft",
    {
      to: ["x@y.com"],
      body: "b",
      account: "alice@example.com",
      attachments: [{ content_base64: "QQ==", filename: "a.bin" }],
    },
    { "drafts.create": { data: { id: "d1", message: { id: "msg1" } } } }
  );
  assert.equal(result.isError, undefined);
  const dc = calls.find((c) => c.name === "drafts.create");
  assert.ok(dc.params.requestBody.message.raw, "draft carries a raw message");
  assert.equal(result.structuredContent.draft_id, "d1");
});
