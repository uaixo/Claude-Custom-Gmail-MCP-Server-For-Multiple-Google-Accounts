import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractPlainText,
  htmlToText,
  mapWithConcurrency,
  getThreadReplyHeaders,
  buildRawMessage,
  handleGmailError,
  resolveAttachments,
  decodeBase64Url,
  capMessageBodies,
} from "../dist/gmail.js";

const b64url = (s) => Buffer.from(s, "utf-8").toString("base64url");

// --------------------------------------------------------------------------
// extractPlainText / htmlToText  (review item #1)
// --------------------------------------------------------------------------
test("extractPlainText returns a text/plain part verbatim", () => {
  const payload = { mimeType: "text/plain", body: { data: b64url("Hello plain world") } };
  assert.equal(extractPlainText(payload), "Hello plain world");
});

test("extractPlainText prefers text/plain and never leaks HTML in multipart/alternative", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("Plain version") } },
      { mimeType: "text/html", body: { data: b64url("<div>HTML <b>version</b></div>") } },
    ],
  };
  const out = extractPlainText(payload);
  assert.equal(out, "Plain version");
  assert.doesNotMatch(out, /[<>]/);
});

test("extractPlainText falls back to stripped HTML when no plain part exists", () => {
  const payload = {
    mimeType: "text/html",
    body: {
      data: b64url(
        "<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;there</p><br><p>Line&amp;two</p><script>evil()</script></body></html>"
      ),
    },
  };
  const out = extractPlainText(payload);
  assert.doesNotMatch(out, /[<>]/);
  assert.doesNotMatch(out, /color:red|evil/);
  assert.match(out, /Hi there/);
  assert.match(out, /Line&two/);
});

test("extractPlainText finds a text/plain part deep in a nested tree", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Deep plain") } },
          { mimeType: "text/html", body: { data: b64url("<p>deep html</p>") } },
        ],
      },
      { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x" } },
    ],
  };
  assert.equal(extractPlainText(payload), "Deep plain");
});

test("htmlToText converts <br> to a newline", () => {
  assert.equal(htmlToText("a<br>b"), "a\nb");
});

// --------------------------------------------------------------------------
// mapWithConcurrency  (review item #3)
// --------------------------------------------------------------------------
test("mapWithConcurrency preserves order and caps concurrency", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 23 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 5, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, items.map((n) => n * 2));
  // The cap is the invariant (never exceed the limit); a peak above 1 proves it
  // actually parallelizes. An exact peak===5 would be fragile under load.
  assert.ok(peak <= 5, `peak ${peak} exceeded the limit`);
  assert.ok(peak >= 2, `expected some concurrency, got peak ${peak}`);
});

test("mapWithConcurrency handles empty input and fewer items than the limit", async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 10, async (n) => n + 1), [2, 3]);
});

// --------------------------------------------------------------------------
// getThreadReplyHeaders  (review item #2)
// --------------------------------------------------------------------------
function mockGmailThread(messages) {
  return {
    users: { threads: { get: async () => ({ data: { messages } }) } },
  };
}

test("getThreadReplyHeaders derives In-Reply-To, accumulated References, and subject", async () => {
  const gmail = mockGmailThread([
    {
      payload: {
        headers: [
          { name: "Subject", value: "Project kickoff" },
          { name: "Message-ID", value: "<msg-1@mail.example>" },
        ],
      },
    },
    {
      payload: {
        headers: [
          { name: "Subject", value: "Re: Project kickoff" },
          { name: "Message-ID", value: "<msg-2@mail.example>" },
          { name: "References", value: "<msg-1@mail.example>" },
        ],
      },
    },
  ]);
  const reply = await getThreadReplyHeaders(gmail, "thread-123");
  assert.equal(reply.inReplyTo, "<msg-2@mail.example>");
  assert.equal(reply.references, "<msg-1@mail.example> <msg-2@mail.example>");
  assert.equal(reply.subject, "Project kickoff");
});

test("getThreadReplyHeaders returns empty strings for an empty thread", async () => {
  const reply = await getThreadReplyHeaders(mockGmailThread([]), "t");
  assert.deepEqual(reply, { inReplyTo: "", references: "", subject: "" });
});

// --------------------------------------------------------------------------
// buildRawMessage + handleGmailError  (review item #5)
// --------------------------------------------------------------------------
test("buildRawMessage emits headers and base64-encodes the body", () => {
  const raw = buildRawMessage({ to: ["a@b.com"], subject: "hi", body: "hello" });
  const mime = decodeBase64Url(raw);
  assert.match(mime, /To: a@b\.com/);
  assert.match(mime, /Subject: hi/);
  assert.match(mime, new RegExp(Buffer.from("hello", "utf-8").toString("base64")));
});

test("buildRawMessage emits threading headers when provided", () => {
  const raw = buildRawMessage({
    to: ["a@b.com"],
    subject: "Re: x",
    body: "thanks",
    inReplyTo: "<msg-2@mail.example>",
    references: "<msg-1@mail.example> <msg-2@mail.example>",
  });
  const mime = decodeBase64Url(raw);
  assert.match(mime, /In-Reply-To: <msg-2@mail\.example>/);
  assert.match(mime, /References: <msg-1@mail\.example> <msg-2@mail\.example>/);
});

test("buildRawMessage neutralizes CRLF header injection via subject", () => {
  const raw = buildRawMessage({
    to: ["a@b.com"],
    subject: "Hello\r\nBcc: evil@attacker.com",
    body: "hi",
  });
  const mime = decodeBase64Url(raw);
  // The injected text must NOT become its own header line...
  assert.doesNotMatch(mime, /^Bcc: evil@attacker\.com/m);
  // ...it stays folded into the Subject value (CRLF collapsed to a space).
  assert.match(mime, /^Subject: Hello Bcc: evil@attacker\.com$/m);
});

test("buildRawMessage neutralizes injection via attachment filename and mime type", () => {
  const raw = buildRawMessage({
    to: ["a@b.com"],
    subject: "s",
    body: "b",
    attachments: [
      {
        filename: 'evil"\r\nX-Injected: 1.txt',
        mimeType: "text/plain\r\nX-Evil: 1",
        contentBase64: "QQ==",
      },
    ],
  });
  const mime = decodeBase64Url(raw);
  assert.doesNotMatch(mime, /^X-Injected:/m);
  assert.doesNotMatch(mime, /^X-Evil:/m);
  // The raw quote in the filename is neutralized, so it can't break the quoting.
  assert.doesNotMatch(mime, /filename="evil"/);
});

test("buildRawMessage neutralizes CRLF injection via in_reply_to", () => {
  const raw = buildRawMessage({
    to: ["a@b.com"],
    subject: "s",
    body: "b",
    inReplyTo: "<x@y>\r\nBcc: evil@attacker.com",
    references: "<x@y>",
  });
  assert.doesNotMatch(decodeBase64Url(raw), /^Bcc:/m);
});

test("buildRawMessage rejects a message over the 25 MB limit with a clear error", () => {
  const overB64 = Buffer.alloc(26 * 1024 * 1024, 0x41).toString("base64");
  assert.throws(
    () =>
      buildRawMessage({
        to: ["a@b.com"],
        subject: "s",
        body: "b",
        attachments: [
          { filename: "big.bin", mimeType: "application/octet-stream", contentBase64: overB64 },
        ],
      }),
    /exceeding Gmail's 25\.0 MB limit/
  );
});

test("handleGmailError distinguishes local errors from API errors", () => {
  const local = handleGmailError(new Error("Message is too big"));
  assert.ok(local.startsWith("Error: "));
  assert.doesNotMatch(local, /Gmail API request failed/);

  const api = handleGmailError({ code: 500, message: "boom" });
  assert.match(api, /Gmail API request failed \(status 500\)/);

  assert.match(handleGmailError({ code: 401 }), /Re-run `npm run add-account`/);
});

// --------------------------------------------------------------------------
// resolveAttachments allowlist  (review item #8 — security)
// --------------------------------------------------------------------------
test("resolveAttachments enforces the path allowlist and blocks escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-att-"));
  const allowed = path.join(root, "allowed");
  const secretDir = path.join(root, "secret");
  fs.mkdirSync(allowed);
  fs.mkdirSync(secretDir);
  const okFile = path.join(allowed, "doc.txt");
  fs.writeFileSync(okFile, "hello attachment");
  const secretFile = path.join(secretDir, "id_rsa");
  fs.writeFileSync(secretFile, "PRIVATE KEY");
  // Symlinks need privilege on some platforms (e.g. Windows); skip just the
  // symlink-escape assertion there rather than failing the whole test.
  const escapeLink = path.join(allowed, "sneaky.txt");
  let symlinkOk = true;
  try {
    fs.symlinkSync(secretFile, escapeLink);
  } catch {
    symlinkOk = false;
  }

  const prev = process.env.GMAIL_MCP_ATTACHMENTS_DIR;
  try {
    // content_base64 always works, even with no allowlist.
    delete process.env.GMAIL_MCP_ATTACHMENTS_DIR;
    const inline = resolveAttachments([
      { filename: "a.txt", content_base64: Buffer.from("hi").toString("base64") },
    ]);
    assert.equal(inline[0].contentBase64, Buffer.from("hi").toString("base64"));

    // path disabled when the env var is unset.
    assert.throws(() => resolveAttachments([{ path: okFile }]), /GMAIL_MCP_ATTACHMENTS_DIR/);

    // With the allowlist set: file inside is read; escapes are refused.
    process.env.GMAIL_MCP_ATTACHMENTS_DIR = allowed;
    const good = resolveAttachments([{ path: okFile }]);
    assert.equal(good[0].contentBase64, Buffer.from("hello attachment").toString("base64"));

    if (symlinkOk) {
      assert.throws(() => resolveAttachments([{ path: escapeLink }]), /outside the allowed/);
    }
    assert.throws(() => resolveAttachments([{ path: secretFile }]), /outside the allowed/);
    assert.throws(
      () => resolveAttachments([{ path: path.join(allowed, "..", "secret", "id_rsa") }]),
      /outside the allowed/
    );
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_ATTACHMENTS_DIR;
    else process.env.GMAIL_MCP_ATTACHMENTS_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAttachments requires exactly one of path or content_base64", () => {
  assert.throws(() => resolveAttachments([{}]), /exactly one of 'path' or 'content_base64'/);
  assert.throws(
    () => resolveAttachments([{ path: "/x", content_base64: "QQ==" }]),
    /exactly one of 'path' or 'content_base64'/
  );
});

test("resolveAttachments rejects invalid base64 and normalizes base64url", () => {
  // Garbage is rejected rather than silently shipped corrupt.
  assert.throws(
    () => resolveAttachments([{ filename: "a.bin", content_base64: "not valid base64!!" }]),
    /not valid base64/
  );
  // base64url input (with - and _) is accepted and canonicalized to standard
  // base64, decoding back to the original bytes.
  const bytes = Buffer.from([0xfb, 0xff, 0xbf]); // -> "-_-_"-style in base64url
  const urlSafe = bytes.toString("base64url");
  const out = resolveAttachments([{ filename: "a.bin", content_base64: urlSafe }]);
  assert.doesNotMatch(out[0].contentBase64, /[-_]/);
  assert.equal(
    Buffer.from(out[0].contentBase64, "base64").toString("hex"),
    bytes.toString("hex")
  );
});

// --------------------------------------------------------------------------
// capMessageBodies  (review item #7)
// --------------------------------------------------------------------------
test("capMessageBodies keeps bodies that fit within the budget", () => {
  const r = capMessageBodies([{ body: "aaa" }, { body: "bbb" }], 100);
  assert.equal(r.truncated, false);
  assert.equal(r.messages[0].body, "aaa");
  assert.equal(r.messages[1].body, "bbb");
});

test("capMessageBodies truncates the crossing body and omits later ones", () => {
  const big = [{ body: "x".repeat(30) }, { body: "y".repeat(30) }, { body: "z".repeat(30) }];
  const r = capMessageBodies(big, 20);
  assert.equal(r.truncated, true);
  assert.ok(r.messages[0].body.startsWith("x".repeat(20)));
  assert.match(r.messages[0].body, /truncated/);
  assert.match(r.messages[1].body, /omitted/);
  // First body is the 20-char budget plus a single marker line; later bodies
  // are a single fixed marker. Bound the total against those known sizes.
  const marker = "\n[Body truncated: thread exceeds size limit]";
  const omitted = "[Body omitted: thread exceeds size limit]";
  const total = r.messages.reduce((n, m) => n + m.body.length, 0);
  assert.ok(total <= 20 + marker.length + 2 * omitted.length);
});

test("capMessageBodies treats an exact-fit body as not truncated", () => {
  const r = capMessageBodies([{ body: "a".repeat(20) }], 20);
  assert.equal(r.truncated, false);
  assert.equal(r.messages[0].body, "a".repeat(20));
});

test("capMessageBodies does not flag a trailing empty body", () => {
  const r = capMessageBodies([{ body: "a".repeat(20) }, { body: "" }], 20);
  assert.equal(r.truncated, false);
  assert.equal(r.messages[1].body, "");
});

test("capMessageBodies preserves non-body fields", () => {
  const r = capMessageBodies([{ body: "x".repeat(50), message_id: "m1", from: "a@b" }], 10);
  assert.equal(r.messages[0].message_id, "m1");
  assert.equal(r.messages[0].from, "a@b");
});
