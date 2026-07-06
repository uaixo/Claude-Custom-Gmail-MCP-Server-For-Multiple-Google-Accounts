import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server } from "../src/index.js";
import { MAX_THREAD_BODY_CHARS } from "../src/constants.js";

// @googleapis/gmail is CommonJS; grab its mutable exports object so the before()
// hook can swap the gmail() factory. Production imports the same named factory,
// which esbuild/tsx compile to a call-time read of this object's `.gmail`, so
// the swap below is what every tool call resolves.
const gmailPkg = createRequire(import.meta.url)("@googleapis/gmail");

// --------------------------------------------------------------------------
// Handler integration tests (review item #4).
//
// These exercise the tool handlers end-to-end through a real in-memory MCP
// client, with the Gmail API faked. gmailFor() reads gmailPkg.gmail at call
// time, so swapping that single factory on the @googleapis/gmail exports object
// intercepts every tool's Gmail access — no network, and no production seam. Each
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
      messages: {
        send: method("messages.send"),
        modify: method("messages.modify"),
        get: method("messages.get"),
      },
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

  realGmail = gmailPkg.gmail;
  gmailPkg.gmail = (opts) => {
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
  gmailPkg.gmail = realGmail;
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
// Recipient validation (M3)
// --------------------------------------------------------------------------
test("gmail_send_message rejects a comma-joined multi-recipient string in one element (M3)", async () => {
  // One string carrying two recipients previously passed validation (only the
  // trailing <...> was checked) and Gmail delivered ONLY to the last one —
  // everyone else silently never received the message.
  const { result } = await callTool("gmail_send_message", {
    to: ["Alice <alice@x.com>, Bob <bob@y.com>"],
    subject: "s",
    body: "b",
    account: "alice@example.com",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /separate array elements/);
});

test("gmail_send_message accepts a quoted comma display name and emits it singly-quoted (M3/L3)", async () => {
  let sentRaw;
  const { result } = await callTool(
    "gmail_send_message",
    {
      to: ['"Doe, John" <j@x.com>'],
      subject: "s",
      body: "b",
      account: "alice@example.com",
    },
    {
      "messages.send": (p) => {
        sentRaw = p.requestBody.raw;
        return { data: { id: "s1", threadId: "t1" } };
      },
    }
  );
  assert.equal(result.isError, undefined);
  const mime = Buffer.from(sentRaw, "base64url")
    .toString("utf-8")
    .replace(/\r\n[ \t]/g, " ");
  assert.match(mime, /^To: "Doe, John" <j@x\.com>$/m);
});

test("gmail_send_message caps recipient length and validates a whitespace-heavy value fast (M2)", async () => {
  // A >1000-char recipient is rejected by the length cap before the regex runs.
  const overLong = "a".repeat(1001) + "@x.com";
  const capped = await callTool("gmail_send_message", {
    to: [overLong],
    subject: "s",
    body: "b",
    account: "alice@example.com",
  });
  assert.equal(capped.result.isError, true);
  assert.match(capped.result.content[0].text, /too long/i);

  // The previously-quadratic ReDoS shape ("a" + whitespace + "a", no '<'), just
  // under the cap: the de-overlapped NAME_ADDR_RE must validate it in linear
  // time. This freezes the whole event loop if the regex ever regresses.
  const redos = "a" + " ".repeat(996) + "a"; // 998 chars, survives .trim(), no '<'
  const t0 = Date.now();
  const bad = await callTool("gmail_send_message", {
    to: [redos],
    subject: "s",
    body: "b",
    account: "alice@example.com",
  });
  assert.equal(bad.result.isError, true); // not a valid recipient -> rejected
  assert.ok(Date.now() - t0 < 1000, "recipient validation must not take pathological time");
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
  // No nextPageToken in the response → none surfaced to the caller.
  assert.equal(result.structuredContent.next_page_token, undefined);
});

test("gmail_search_threads forwards page_token and surfaces next_page_token (#7)", async () => {
  const { result, calls } = await callTool(
    "gmail_search_threads",
    { query: "is:unread", account: "alice@example.com", page_token: "PAGE2" },
    {
      "threads.list": {
        data: { threads: [{ id: "t9" }], nextPageToken: "PAGE3" },
      },
      "threads.get": {
        data: {
          messages: [{ payload: { headers: [{ name: "Subject", value: "Hi" }] } }],
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  const list = calls.find((c) => c.name === "threads.list");
  // The caller's page_token is forwarded to Gmail as pageToken.
  assert.equal(list.params.pageToken, "PAGE2");
  // Gmail's nextPageToken is surfaced as next_page_token for the next call.
  assert.equal(result.structuredContent.next_page_token, "PAGE3");
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

test("gmail_get_thread caps the message count, keeping the newest and reporting how many older were omitted", async () => {
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
  // The 5 OLDEST (m0–m4) are dropped; the newest 100 (m5–m104) are kept, in
  // order, so the most recent messages survive the cap.
  assert.equal(sc.messages[0].message_id, "m5");
  assert.equal(sc.messages[0].body, "body 5");
  assert.equal(sc.messages[99].message_id, "m104");
});

test("gmail_get_thread spends the body budget on the NEWEST messages first (H2)", async () => {
  // 5 messages whose bodies each take ~30% of the budget: only the newest 3
  // fit. The budget must be spent newest-first — the latest replies are what a
  // reader asks for — while the output stays in chronological order.
  const bodySize = Math.ceil(MAX_THREAD_BODY_CHARS * 0.3);
  const bodies = Array.from({ length: 5 }, (_, i) => `B${i}:` + "x".repeat(bodySize - 3));
  const messages = bodies.map((b, i) => ({
    id: `m${i}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: `S${i}` }],
      body: { data: utf8(b).toString("base64url") },
    },
  }));
  const { result } = await callTool(
    "gmail_get_thread",
    { thread_id: "t1", account: "alice@example.com" },
    { "threads.get": { data: { messages } } }
  );
  assert.equal(result.isError, undefined);
  const sc = result.structuredContent;
  assert.equal(sc.truncated, true);
  // Chronological order is preserved...
  assert.deepEqual(sc.messages.map((m) => m.message_id), ["m0", "m1", "m2", "m3", "m4"]);
  // ...the newest three bodies are intact...
  assert.equal(sc.messages[4].body, bodies[4]);
  assert.equal(sc.messages[3].body, bodies[3]);
  assert.equal(sc.messages[2].body, bodies[2]);
  // ...and the budget runs out on the OLDER messages, not the newest.
  assert.match(sc.messages[1].body, /truncated|omitted/);
  assert.match(sc.messages[0].body, /omitted/);
  assert.ok(
    sc.messages[1].body.startsWith("B1:") || /omitted/.test(sc.messages[1].body),
    "the crossing message keeps its own body prefix if partially rendered"
  );
});

test("gmail_get_thread survives a hostile deeply-nested HTML message without failing the thread (H1)", async () => {
  // ~2,200 nested tags used to RangeError inside extractPlainText and turn the
  // ENTIRE thread read into isError — permanently for that thread. With the
  // parser depth limit (+ per-message fault isolation) the hostile message
  // degrades and its neighbors stay readable.
  const hostileHtml = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
  const plainMsg = (id, text) => ({
    id,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: id }],
      body: { data: utf8(text).toString("base64url") },
    },
  });
  const messages = [
    plainMsg("m0", "body zero"),
    {
      id: "m1",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/html",
        headers: [{ name: "Subject", value: "hostile" }],
        body: { data: utf8(hostileHtml).toString("base64url") },
      },
    },
    plainMsg("m2", "body two"),
  ];
  const { result } = await callTool(
    "gmail_get_thread",
    { thread_id: "t1", account: "alice@example.com" },
    { "threads.get": { data: { messages } } }
  );
  assert.equal(result.isError, undefined, "one hostile body must not sink the thread read");
  const sc = result.structuredContent;
  assert.equal(sc.messages[0].body, "body zero");
  assert.equal(sc.messages[2].body, "body two");
  // The hostile body degraded (ellipsis or marker) rather than throwing, and
  // no raw markup leaked through.
  assert.equal(typeof sc.messages[1].body, "string");
  assert.doesNotMatch(sc.messages[1].body, /<div>/);
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

test("gmail_send_message does not retry a 5xx — a transient error can't duplicate a send (#retry)", async () => {
  // messages.send is non-idempotent: a 503 (which may arrive after Gmail already
  // sent the message) must surface immediately, not trigger a retry that could
  // deliver a second copy.
  const { result, calls } = await callTool(
    "gmail_send_message",
    { to: ["x@y.com"], subject: "s", body: "b", account: "alice@example.com" },
    {
      "messages.send": () => {
        const e = new Error("backend unavailable");
        e.code = 503;
        throw e;
      },
    }
  );
  assert.equal(result.isError, true);
  assert.equal(
    calls.filter((c) => c.name === "messages.send").length,
    1,
    "send must be attempted exactly once on a 5xx"
  );
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

// --------------------------------------------------------------------------
// gmail_get_thread compact summary fallback (#B2)
// --------------------------------------------------------------------------
test("gmail_get_thread falls back to a compact summary when the full JSON is over budget (#B2)", async () => {
  // Many messages with large bodies: the full JSON exceeds CHARACTER_LIMIT, so
  // the text channel returns a useful per-message summary (not the bare notice),
  // while structuredContent still carries every message.
  const messages = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Subject number ${i}` },
        { name: "From", value: `sender${i}@example.com` },
      ],
      body: { data: utf8("x".repeat(800)).toString("base64url") },
    },
  }));
  const { result } = await callTool(
    "gmail_get_thread",
    { thread_id: "t1", account: "alice@example.com" },
    { "threads.get": { data: { messages } } }
  );
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.ok(text.length <= 25000, "summary stays within the character budget");
  assert.match(text, /Per-message summary/);
  assert.match(text, /structuredContent/);
  assert.match(text, /\[m0\] sender0@example\.com — Subject number 0/);
  assert.throws(() => JSON.parse(text), "the summary is not raw JSON");
  assert.equal(result.structuredContent.messages.length, 60);
});

// --------------------------------------------------------------------------
// Display-name recipients (#C1)
// --------------------------------------------------------------------------
test("gmail_create_draft accepts a display-name recipient and emits it verbatim (#C1)", async () => {
  let raw = null;
  const { result } = await callTool(
    "gmail_create_draft",
    {
      to: ["Alice Example <alice@x.com>"],
      cc: ["bob@x.com"],
      body: "hi",
      account: "alice@example.com",
    },
    {
      "drafts.create": (p) => {
        raw = p.requestBody.message.raw;
        return { data: { id: "d1", message: { id: "m1" } } };
      },
    }
  );
  assert.equal(result.isError, undefined);
  const mime = Buffer.from(raw, "base64url").toString("utf-8");
  assert.match(mime, /^To: Alice Example <alice@x\.com>$/m);
});

test("gmail_create_draft rejects a malformed recipient at the schema boundary (#C1)", async () => {
  const { result, calls } = await callTool("gmail_create_draft", {
    to: ["not-an-email"],
    body: "hi",
    account: "alice@example.com",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Input validation error/);
  assert.equal(calls.length, 0, "no Gmail call should happen on invalid input");
});

test("gmail_create_draft accepts a dot-less (intranet) recipient domain (#note4)", async () => {
  // "ops@localhost" has no dotted domain; it must be accepted now (Gmail makes
  // the final delivery-time judgment).
  const { result } = await callTool(
    "gmail_create_draft",
    { to: ["ops@localhost"], body: "hi", account: "alice@example.com" },
    { "drafts.create": { data: { id: "d1", message: { id: "m1" } } } }
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.draft_id, "d1");
});

// --------------------------------------------------------------------------
// Review follow-ups: remaining lows and notes (L7, L8, N1, N4)
// --------------------------------------------------------------------------
test("write tools' text channel carries every field their descriptions promise (L7)", async () => {
  // Hosts without structuredContent support only ever see the text.
  const send = await callTool(
    "gmail_send_message",
    { to: ["x@y.com"], subject: "s", body: "b", account: "alice@example.com" },
    { "messages.send": { data: { id: "sent1", threadId: "tSent" } } }
  );
  assert.equal(send.result.isError, undefined);
  assert.match(send.result.content[0].text, /message_id: sent1/);
  assert.match(send.result.content[0].text, /thread_id: tSent/);

  const draft = await callTool(
    "gmail_create_draft",
    { to: ["x@y.com"], subject: "s", body: "b", account: "alice@example.com" },
    { "drafts.create": { data: { id: "d1", message: { id: "dm1" } } } }
  );
  assert.equal(draft.result.isError, undefined);
  assert.match(draft.result.content[0].text, /draft_id: d1/);
  assert.match(draft.result.content[0].text, /message_id: dm1/);

  const mod = await callTool(
    "gmail_modify_labels",
    { message_id: "m1", add_label_ids: ["STARRED"], account: "alice@example.com" },
    { "messages.modify": { data: { id: "m1", labelIds: ["INBOX", "STARRED"] } } }
  );
  assert.equal(mod.result.isError, undefined);
  assert.match(mod.result.content[0].text, /Labels now: INBOX, STARRED/);
});

test("gmail_search_threads surfaces the pagination cursor on an empty page (L8)", async () => {
  // Gmail's q-filtered listing can return an empty page that still carries a
  // nextPageToken; the text must not read as a terminal "no results".
  const { result } = await callTool(
    "gmail_search_threads",
    { query: "from:x", account: "alice@example.com" },
    { "threads.list": { data: { threads: [], nextPageToken: "PAGE2" } } }
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.next_page_token, "PAGE2");
  assert.match(result.content[0].text, /more pages exist/);
  assert.match(result.content[0].text, /page_token: PAGE2/);
  // A truly empty result (no token) still reads as none found.
  const empty = await callTool(
    "gmail_search_threads",
    { query: "from:x", account: "alice@example.com" },
    { "threads.list": { data: { threads: [] } } }
  );
  assert.match(empty.result.content[0].text, /No threads found/);
});

test("gmail_get_message fetches a single message and maps headers/body (N1)", async () => {
  const { result, calls } = await callTool(
    "gmail_get_message",
    { message_id: "m42", account: "alice@example.com" },
    {
      "messages.get": {
        data: {
          id: "m42",
          threadId: "t7",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "x@y.com" },
              { name: "To", value: "me@x.com" },
              { name: "Date", value: "today" },
              { name: "Subject", value: "Hi" },
            ],
            body: { data: utf8("the message body").toString("base64url") },
          },
        },
      },
    }
  );
  assert.equal(result.isError, undefined);
  const get = calls.find((c) => c.name === "messages.get");
  assert.equal(get.params.id, "m42");
  assert.equal(get.params.format, "full");
  assert.deepEqual(result.structuredContent, {
    account: "alice@example.com",
    message_id: "m42",
    thread_id: "t7",
    from: "x@y.com",
    to: "me@x.com",
    date: "today",
    subject: "Hi",
    body: "the message body",
    label_ids: ["INBOX"],
  });
});

test("gmail_send_message requires a subject on a fresh (non-reply) send (N4)", async () => {
  // Omitting subject without thread_id used to deliver "(no subject)"
  // silently and irreversibly.
  const missing = await callTool("gmail_send_message", {
    to: ["x@y.com"],
    body: "b",
    account: "alice@example.com",
  });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /subject is required/);

  // An explicit empty string is a deliberate no-subject send and still works.
  let sentRaw;
  const explicit = await callTool(
    "gmail_send_message",
    { to: ["x@y.com"], subject: "", body: "b", account: "alice@example.com" },
    {
      "messages.send": (p) => {
        sentRaw = p.requestBody.raw;
        return { data: { id: "s1", threadId: "t1" } };
      },
    }
  );
  assert.equal(explicit.result.isError, undefined);
  const mime = Buffer.from(sentRaw, "base64url").toString("utf-8");
  assert.match(mime, /^Subject: $/m);
});
