import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractPlainText,
  extractPlainTextSafe,
  htmlToText,
  mapWithConcurrency,
  getThreadReplyHeaders,
  buildReplyHeaders,
  summarizeThread,
  buildRawMessage,
  handleGmailError,
  resolveAttachments,
  decodeBase64Url,
  capMessageBodies,
  decodeRfc2047,
  deriveReplySubject,
  requireField,
  renderJsonText,
  jsonTooLargeNotice,
  withRetry,
  listAttachments,
  sanitizeAttachmentFilename,
  saveAttachment,
} from "../src/gmail.js";
import { packageVersion } from "../src/constants.js";

const b64url = (s) => Buffer.from(s, "utf-8").toString("base64url");
// base64url of raw bytes, for exercising non-UTF-8 charset decoding.
const b64urlBytes = (bytes) => Buffer.from(bytes).toString("base64url");

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

test("extractPlainText skips a text attachment and returns the real HTML body", () => {
  // HTML-only message that also carries a text/plain attachment (e.g. a .csv).
  // The attachment's bytes must not be surfaced as the body.
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "text/plain",
        filename: "report.csv",
        headers: [
          { name: "Content-Disposition", value: 'attachment; filename="report.csv"' },
        ],
        body: { data: b64url("col1,col2\n1,2") },
      },
      { mimeType: "text/html", body: { data: b64url("<p>The <b>real</b> body</p>") } },
    ],
  };
  const out = extractPlainText(payload);
  assert.doesNotMatch(out, /col1,col2/);
  assert.match(out, /The real body/);
});

test("extractPlainText skips a text/plain attachment that precedes the body part", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "text/plain",
        filename: "notes.txt",
        headers: [{ name: "Content-Disposition", value: "attachment" }],
        body: { data: b64url("ATTACHMENT TEXT") },
      },
      { mimeType: "text/plain", body: { data: b64url("ACTUAL BODY") } },
    ],
  };
  assert.equal(extractPlainText(payload), "ACTUAL BODY");
});

test("htmlToText survives pathologically deep nesting without a stack overflow (H1)", () => {
  // ~2,200 nested tags used to overflow the recursive DOM walk (RangeError).
  // With limits.maxDepth the conversion degrades to the library's ellipsis.
  const hostile = "<div>".repeat(5000) + "deep text" + "</div>".repeat(5000);
  let out;
  assert.doesNotThrow(() => {
    out = htmlToText(hostile);
  });
  assert.equal(typeof out, "string");
  // Legitimate nesting (real emails are a few dozen levels) is unaffected.
  const legit = "<div>".repeat(40) + "hello world" + "</div>".repeat(40);
  assert.equal(htmlToText(legit), "hello world");
});

test("extractPlainTextSafe degrades a throwing extraction to a marker body (H1)", () => {
  // A payload whose traversal throws must yield a marker, not an exception —
  // one hostile message must not sink a whole-thread read.
  const hostile = {
    mimeType: "multipart/mixed",
    get parts() {
      throw new Error("boom during traversal");
    },
  };
  const out = extractPlainTextSafe(hostile);
  assert.match(out, /\[Body could not be extracted: boom during traversal\]/);
  // Normal payloads pass through unchanged.
  const ok = { mimeType: "text/plain", body: { data: b64url("fine") } };
  assert.equal(extractPlainTextSafe(ok), "fine");
});

test("extractPlainText treats an inline part WITH a filename as an attachment (M2)", () => {
  // Some senders (notably Apple Mail) dispose attached files as
  // 'inline; filename="x.txt"'. Such a file must not shadow the real body: an
  // HTML-only email with an inline .txt attachment previously returned the
  // FILE's contents as the message body and never showed the actual message.
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/html", body: { data: b64url("<p>The actual email body</p>") } },
      {
        mimeType: "text/plain",
        filename: "notes.txt",
        headers: [
          { name: "Content-Disposition", value: 'inline; filename="notes.txt"' },
        ],
        body: { data: b64url("ATTACHMENT FILE CONTENT") },
      },
    ],
  };
  const out = extractPlainText(payload);
  assert.doesNotMatch(out, /ATTACHMENT FILE CONTENT/);
  assert.match(out, /The actual email body/);
});

test("extractPlainText keeps an inline text part as the body", () => {
  // Content-Disposition: inline must NOT be treated as an attachment.
  const payload = {
    mimeType: "text/plain",
    headers: [{ name: "Content-Disposition", value: "inline" }],
    body: { data: b64url("inline body") },
  };
  assert.equal(extractPlainText(payload), "inline body");
});

// --------------------------------------------------------------------------
// decodeBase64Url charset handling  (review item #2)
// --------------------------------------------------------------------------
test("decodeBase64Url defaults to UTF-8 and is unchanged for ASCII/UTF-8", () => {
  assert.equal(decodeBase64Url(b64url("Hello world")), "Hello world");
  assert.equal(decodeBase64Url(b64url("café"), "UTF-8"), "café");
  assert.equal(decodeBase64Url(b64url("café"), "us-ascii"), "café");
});

test("decodeBase64Url honors a declared non-UTF-8 charset (ISO-8859-1)", () => {
  // "Salut été" encoded as ISO-8859-1: é is the single byte 0xE9.
  const data = b64urlBytes([0x53, 0x61, 0x6c, 0x75, 0x74, 0x20, 0xe9, 0x74, 0xe9]);
  assert.equal(decodeBase64Url(data, "ISO-8859-1"), "Salut été");
  // Decoding the same bytes as UTF-8 must NOT yield the correct text (0xE9 is
  // an invalid lone byte) — this is exactly the bug the charset arg fixes.
  assert.notEqual(decodeBase64Url(data), "Salut été");
});

test("decodeBase64Url accepts the windows-1252 label and decodes high bytes", () => {
  // Use a Latin-1-range byte (0xE9 = é), which every ICU build maps identically.
  // The C1 range (0x80–0x9F, e.g. € at 0x80) is ICU-version-dependent — Node
  // bundles differ — so we deliberately don't assert on it here.
  assert.equal(
    decodeBase64Url(b64urlBytes([0x63, 0x61, 0x66, 0xe9]), "windows-1252"),
    "café"
  );
});

test("decodeBase64Url falls back to UTF-8 for an unknown charset label", () => {
  const data = b64url("café");
  assert.equal(decodeBase64Url(data, "totally-bogus-charset"), "café");
});

test("extractPlainText decodes a text/plain part using its declared charset", () => {
  const payload = {
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }],
    body: { data: b64urlBytes([0x63, 0x61, 0x66, 0xe9]) }, // "café" in ISO-8859-1
  };
  assert.equal(extractPlainText(payload), "café");
});

test("htmlToText converts <br> to a newline", () => {
  assert.equal(htmlToText("a<br>b"), "a\nb");
});

test("htmlToText drops <head>/<title> content and keeps the body (#7)", () => {
  const html =
    "<html><head><title>SECRET TITLE</title>" +
    "<meta name='description' content='hidden meta'></head>" +
    "<body><p>Visible body</p></body></html>";
  const out = htmlToText(html);
  assert.match(out, /Visible body/);
  assert.doesNotMatch(out, /SECRET TITLE/);
  assert.doesNotMatch(out, /hidden meta/);
  assert.doesNotMatch(out, /[<>]/);
});

test("htmlToText drops a stray <title> outside <head>", () => {
  assert.equal(htmlToText("<title>Just a title</title>Body text"), "Body text");
});

test("htmlToText decodes entities in one pass without double-decoding (#B)", () => {
  // &amp;lt; must render as the literal &lt;, not < (the old chained-replace bug).
  assert.equal(htmlToText("x &amp;lt; y"), "x &lt; y");
  // A plain &amp; still decodes to a single &.
  assert.equal(htmlToText("a &amp; b"), "a & b");
  // Decimal and hex numeric character references.
  assert.equal(htmlToText("&#65;&#x42;&#67;"), "ABC");
  assert.equal(htmlToText("&#039;"), "'"); // leading zeros, decimal apostrophe
});

test("htmlToText survives an out-of-range numeric entity without throwing (#B)", () => {
  // > 0x10FFFF would make String.fromCodePoint throw; must be swallowed.
  assert.doesNotThrow(() => htmlToText("hello &#x110000; world"));
  assert.match(htmlToText("hello &#x110000; world"), /hello/);
});

test("htmlToText removes HTML comments even when they contain '>'", () => {
  // The generic <[^>]+> pass stops at the first '>', so comments are stripped
  // up front instead. Collapse internal whitespace just for the comparison.
  assert.equal(
    htmlToText("Hello <!-- a > b --> World").replace(/\s+/g, " ").trim(),
    "Hello World"
  );
  // A script hidden inside a comment is removed with the comment.
  assert.doesNotMatch(htmlToText("x<!-- <script>evil()</script> -->y"), /evil/);
});

test("htmlToText strips an unclosed <style>/<script> block to end of input (#L4)", () => {
  // A truncated/malformed email with no closing tag must not leak CSS/JS text.
  assert.equal(htmlToText("<p>Hi</p><style>p{color:red}"), "Hi");
  assert.doesNotMatch(htmlToText("<p>Hi</p><style>p{color:red}"), /color:red/);
  assert.doesNotMatch(htmlToText("<p>Body</p><script>steal()"), /steal/);
  assert.match(htmlToText("<p>Body</p><script>steal()"), /Body/);
});

test("htmlToText strips an unclosed <head>/<title> to end of input (#3)", () => {
  // No closing </head>: head text (title, meta) must not leak into the body.
  assert.doesNotMatch(htmlToText("<head><title>SECRET</title><meta x=1>"), /SECRET/);
  // No closing </title> either.
  assert.doesNotMatch(htmlToText("<title>SECRET TITLE"), /SECRET TITLE/);
});

test("htmlToText does not mistake <header> for <head> (#3)", () => {
  // The \b guard matters most with the end-of-input fallback: without it, a
  // <header> with no following </head> would be eaten all the way to EOF.
  const out = htmlToText("<header>Visible nav</header><p>Body text</p>");
  assert.match(out, /Visible nav/);
  assert.match(out, /Body text/);
});

test("htmlToText preserves literal < and > that aren't real markup", () => {
  // "3 < 5 and 5 > 3": the '<'/'>' are body text, not tags. The narrowed tag
  // matcher only strips a '<' that opens a real tag, so this survives — the old
  // catch-all /<[^>]+>/ ate "< 5 and 5 >" as a bogus tag.
  assert.equal(htmlToText("<p>3 < 5 and 5 > 3</p>"), "3 < 5 and 5 > 3");
  // A lone '<' with a space after it is not a tag opener either.
  assert.equal(htmlToText("<div>a < b</div>"), "a < b");
});

test("htmlToText still strips real tags, declarations, and end tags", () => {
  // The narrowed matcher must keep removing genuine markup: start tags, a
  // <!DOCTYPE> declaration, namespaced Outlook tags, and end tags.
  const out = htmlToText('<!DOCTYPE html><o:p>Outlook</o:p><a href="x">link</a>');
  assert.equal(out, "Outlooklink");
  assert.doesNotMatch(out, /[<>]/);
  assert.doesNotMatch(out, /DOCTYPE|href/);
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

test("getThreadReplyHeaders keeps In-Reply-To consistent with the References tail", async () => {
  // Threading is only well-formed when In-Reply-To names the message the reply
  // answers and References ends with that same Message-ID. Verify both: the
  // last message's id is used, and the accumulated chain terminates with it.
  const gmail = mockGmailThread([
    {
      payload: {
        headers: [
          { name: "Subject", value: "Topic" },
          { name: "Message-ID", value: "<a@x>" },
        ],
      },
    },
    {
      payload: {
        headers: [
          { name: "Message-ID", value: "<b@x>" },
          { name: "References", value: "<a@x>" },
        ],
      },
    },
    {
      payload: {
        headers: [
          { name: "Message-ID", value: "<c@x>" },
          { name: "References", value: "<a@x> <b@x>" },
        ],
      },
    },
  ]);
  const reply = await getThreadReplyHeaders(gmail, "t");
  assert.equal(reply.inReplyTo, "<c@x>"); // the thread's most recent message
  assert.equal(reply.references, "<a@x> <b@x> <c@x>");
  assert.ok(
    reply.references.endsWith(reply.inReplyTo),
    "References chain must end with the In-Reply-To message id"
  );
});

// --------------------------------------------------------------------------
// buildReplyHeaders consistency  (review item #3)
// --------------------------------------------------------------------------
test("buildReplyHeaders returns nothing to thread on without a thread or in_reply_to", () => {
  assert.deepEqual(buildReplyHeaders(undefined), {
    inReplyTo: undefined,
    references: undefined,
  });
});

test("buildReplyHeaders passes a consistent thread chain through unchanged", () => {
  const reply = { inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>", subject: "T" };
  assert.deepEqual(buildReplyHeaders(reply), {
    inReplyTo: "<c@x>",
    references: "<a@x> <b@x> <c@x>",
  });
});

test("buildReplyHeaders truncates the chain at an explicit in_reply_to (#3/#C)", () => {
  // Replying to an earlier message in the thread: In-Reply-To and the
  // References tail must agree. The chain is truncated at the answered message
  // (its ancestor path), not reordered — messages after it aren't ancestors.
  const reply = { inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>", subject: "T" };
  const out = buildReplyHeaders(reply, "<b@x>");
  assert.equal(out.inReplyTo, "<b@x>");
  assert.ok(out.references.endsWith("<b@x>"), "References must end with In-Reply-To");
  assert.equal(out.references, "<a@x> <b@x>"); // truncated at <b@x>
});

test("buildReplyHeaders appends an in_reply_to that isn't in the chain (#C)", () => {
  const reply = { inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>", subject: "T" };
  const out = buildReplyHeaders(reply, "<z@x>");
  assert.equal(out.inReplyTo, "<z@x>");
  assert.equal(out.references, "<a@x> <b@x> <c@x> <z@x>"); // appended to terminate
});

test("buildReplyHeaders threads on an explicit in_reply_to with no thread", () => {
  assert.deepEqual(buildReplyHeaders(undefined, "<only@x>"), {
    inReplyTo: "<only@x>",
    references: "<only@x>",
  });
});

// --------------------------------------------------------------------------
// summarizeThread — per-thread degradation on search  (review item #A)
// --------------------------------------------------------------------------
function mockGmailGet(handler) {
  return { users: { threads: { get: handler } } };
}

test("summarizeThread returns first-message metadata for a thread", async () => {
  const gmail = mockGmailGet(async () => ({
    data: {
      messages: [
        {
          snippet: "real snippet",
          payload: {
            headers: [
              { name: "Subject", value: "Hello" },
              { name: "From", value: "a@b.com" },
              { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 -0000" },
            ],
          },
        },
      ],
    },
  }));
  const out = await summarizeThread(gmail, { id: "t1", snippet: "list snippet" });
  assert.equal(out.thread_id, "t1");
  assert.equal(out.subject, "Hello");
  assert.equal(out.from, "a@b.com");
  assert.equal(out.snippet, "real snippet"); // prefers the fetched snippet
  assert.equal(out.error, undefined);
});

test("summarizeThread degrades to an error entry when the fetch fails (#A)", async () => {
  const gmail = mockGmailGet(async () => {
    const e = new Error("boom");
    e.code = 429;
    throw e;
  });
  // retries:0 → degrade immediately (the retry path is covered separately below).
  const out = await summarizeThread(
    gmail,
    { id: "t2", snippet: "fallback" },
    { retries: 0 }
  );
  assert.equal(out.thread_id, "t2"); // still identified from the list result
  assert.equal(out.snippet, "fallback"); // falls back to the list snippet
  assert.equal(out.subject, "");
  assert.match(out.error, /Rate limit/);
});

test("summarizeThread retries a transient per-thread 429 before degrading (#4)", async () => {
  let calls = 0;
  const gmail = mockGmailGet(async () => {
    calls++;
    if (calls === 1) {
      const e = new Error("rate limited");
      e.code = 429;
      throw e;
    }
    return {
      data: { messages: [{ payload: { headers: [{ name: "Subject", value: "Recovered" }] } }] },
    };
  });
  // baseDelayMs:0 keeps the backoff instant; the first 429 is retried, not degraded.
  const out = await summarizeThread(
    gmail,
    { id: "t3", snippet: "fallback" },
    { baseDelayMs: 0 }
  );
  assert.equal(calls, 2, "the fetch was retried once after the transient 429");
  assert.equal(out.subject, "Recovered");
  assert.equal(out.error, undefined, "a retried-then-succeeded fetch is not an error entry");
});

test("summarizeThread captures a missing thread id instead of throwing (#A)", async () => {
  const gmail = mockGmailGet(async () => {
    throw new Error("get should not be called without an id");
  });
  const out = await summarizeThread(gmail, { snippet: "s" });
  assert.equal(out.thread_id, "");
  assert.ok(out.error, "a missing id is reported as an error, not thrown");
});

test("one failing thread does not sink the whole search batch (#A)", async () => {
  const gmail = mockGmailGet(async ({ id }) => {
    if (id === "bad") {
      const e = new Error("server error");
      e.code = 500;
      throw e;
    }
    return {
      data: { messages: [{ payload: { headers: [{ name: "Subject", value: `S-${id}` }] } }] },
    };
  });
  const threads = [{ id: "a" }, { id: "bad" }, { id: "c" }];
  // retries:0 → the "bad" thread degrades without waiting out the retry budget.
  const out = await mapWithConcurrency(threads, 5, (t) =>
    summarizeThread(gmail, t, { retries: 0 })
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].subject, "S-a");
  assert.ok(out[1].error, "the failing thread carries an error");
  assert.equal(out[1].subject, "");
  assert.equal(out[2].subject, "S-c");
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

test("buildRawMessage folds long header lines to <=78 octets, unfolding intact", () => {
  const to = Array.from({ length: 80 }, (_, i) => `user${i}@example.com`);
  const references = Array.from(
    { length: 60 },
    (_, i) => `<msg-${i}@example.com>`
  ).join(" ");
  const mime = decodeBase64Url(buildRawMessage({ to, subject: "s", body: "b", references }));
  const headerBlock = mime.split("\r\n\r\n")[0];
  for (const line of headerBlock.split("\r\n")) {
    assert.ok(line.length <= 78, `header line exceeds 78 octets (${line.length}): ${line}`);
  }
  // Unfolding (drop a CRLF that is followed by a space) restores the originals.
  const unfolded = mime.replace(/\r\n /g, " ");
  assert.ok(unfolded.includes(`To: ${to.join(", ")}`), "To did not unfold to the original");
  assert.ok(
    unfolded.includes(`References: ${references}`),
    "References did not unfold to the original"
  );
});

test("buildRawMessage folds multi-byte header content within 78 octets (#6)", () => {
  // Message-ids with 2-byte UTF-8 characters: octet length exceeds character
  // length, so character-based folding would overflow the 78-octet limit.
  const references = Array.from(
    { length: 40 },
    (_, i) => `<αβγ${i}@example.com>`
  ).join(" ");
  const mime = decodeBase64Url(
    buildRawMessage({ to: ["a@b.com"], subject: "s", body: "b", references })
  );
  const headerBlock = mime.split("\r\n\r\n")[0];
  for (const line of headerBlock.split("\r\n")) {
    const octets = Buffer.byteLength(line, "utf-8");
    assert.ok(octets <= 78, `header line exceeds 78 octets (${octets}): ${line}`);
  }
  // Folding at ASCII spaces only, so unfolding restores the value byte-for-byte.
  const unfolded = mime.replace(/\r\n /g, " ");
  assert.ok(
    unfolded.includes(`References: ${references}`),
    "multi-byte References did not unfold intact"
  );
});

test("buildRawMessage splits a long non-ASCII subject into RFC 2047 words within 75 chars", () => {
  const subject = "テスト".repeat(40); // long, multi-byte
  const mime = decodeBase64Url(buildRawMessage({ to: ["a@b.com"], subject, body: "b" }));
  const words = mime.match(/=\?UTF-8\?B\?[^?]*\?=/g) || [];
  assert.ok(words.length >= 2, "expected the subject to span multiple encoded-words");
  for (const w of words) {
    assert.ok(w.length <= 75, `encoded-word exceeds 75 chars: ${w.length}`);
  }
  // The encoded-words decode and concatenate back to the original subject.
  const decoded = words
    .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf-8"))
    .join("");
  assert.equal(decoded, subject);
});

test("buildRawMessage keeps an ASCII filename in the simple quoted form (#M1)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      body: "b",
      attachments: [
        { filename: "report.pdf", mimeType: "application/pdf", contentBase64: "QQ==" },
      ],
    })
  );
  assert.match(mime, /name="report\.pdf"/);
  assert.match(mime, /filename="report\.pdf"/);
});

test("buildRawMessage encodes a non-ASCII filename as an RFC 2231 parameter, not RFC 2047 (#M1)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s", // ASCII subject => no encoded-word should appear anywhere
      body: "b",
      attachments: [
        { filename: "résumé.pdf", mimeType: "application/pdf", contentBase64: "QQ==" },
      ],
    })
  );
  // RFC 2231 extended parameter (filename*=UTF-8''…), not an encoded-word inside
  // a quoted string (which RFC 2047 §5 forbids).
  assert.match(mime, /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
  assert.match(mime, /name\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
  assert.doesNotMatch(mime, /=\?UTF-8\?B\?/);
  assert.doesNotMatch(mime, /filename="r/);
});

/**
 * Reassemble an RFC 2231 extended filename from its continuation segments
 * (`filename*0*=UTF-8''…; filename*1*=…`) in unfolded header text. Returns the
 * still-percent-encoded value.
 */
function joinExtendedFilenameSegments(unfolded) {
  const segs = [...unfolded.matchAll(/filename\*(\d+)\*=([^;\r\n]*)/g)].sort(
    (a, b) => Number(a[1]) - Number(b[1])
  );
  assert.ok(segs.length > 1, "expected multiple continuation segments");
  assert.ok(
    segs[0][2].startsWith("UTF-8''"),
    "segment 0 must carry the charset prefix"
  );
  const values = segs.map((s, i) => (i === 0 ? s[2].slice(7) : s[2]));
  // Check each SEGMENT before joining: joining erases the boundaries, so a
  // boundary that splits a %XX escape (a segment ending "%" or "%E") is
  // invisible to any assertion on the joined string — receiving clients,
  // which decode per-segment context, would garble the filename.
  values.forEach((v, i) => {
    assert.doesNotMatch(
      v,
      /%[0-9A-Fa-f]?$/,
      `segment ${i} ends mid-%XX escape: "${v.slice(-6)}"`
    );
  });
  return values.join("");
}

test("buildRawMessage splits a long non-ASCII filename into RFC 2231 continuations that round-trip (#M1)", () => {
  const filename = "報告書".repeat(30) + ".pdf"; // long + multi-byte
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      body: "b",
      attachments: [
        { filename, mimeType: "application/pdf", contentBase64: "QQ==" },
      ],
    })
  );
  // Continuations let the filename headers fold at parameter boundaries, so
  // every filename-bearing line meets the 78-octet fold target — the 998-octet
  // hard limit is never even approached. (Other lines, e.g. the multipart
  // boundary, are outside this fix's scope and only bound by the hard limit.)
  for (const line of mime.split("\r\n")) {
    const octets = Buffer.byteLength(line, "utf-8");
    assert.ok(octets <= 998, `line exceeds 998 octets (${octets})`);
    if (/filename\*/.test(line)) {
      assert.ok(octets <= 78, `filename line exceeds 78 octets (${octets}): ${line}`);
    }
  }
  const joined = joinExtendedFilenameSegments(mime.replace(/\r\n[ \t]/g, " "));
  assert.doesNotMatch(joined, / /, "no segment may contain an injected space");
  assert.equal(decodeURIComponent(joined), filename);
});

test("buildRawMessage keeps a very long filename intact — no space injected mid-escape (M1)", () => {
  // The percent-encoded form of this name exceeds the 998-octet hard limit.
  // The old single-parameter emission hard-broke it by inserting a space INTO
  // the value — landing mid-%XX-escape — so receiving clients failed to decode
  // the name. Continuations keep every segment a clean run of escapes.
  const filename = "あ".repeat(150) + ".pdf";
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      body: "b",
      attachments: [
        { filename, mimeType: "application/pdf", contentBase64: "QQ==" },
      ],
    })
  );
  for (const line of mime.split("\r\n")) {
    const octets = Buffer.byteLength(line, "utf-8");
    assert.ok(octets <= 998, `line exceeds 998 octets (${octets})`);
    if (/filename\*/.test(line)) {
      assert.ok(octets <= 78, `filename line exceeds 78 octets (${octets}): ${line}`);
    }
  }
  const joined = joinExtendedFilenameSegments(mime.replace(/\r\n[ \t]/g, " "));
  assert.doesNotMatch(joined, / /, "no segment may contain an injected space");
  // Mid-escape segment boundaries are asserted per-segment inside
  // joinExtendedFilenameSegments — on the joined string the boundaries are
  // already erased, so a check here could never fail.
  assert.equal(decodeURIComponent(joined), filename);
});

test("buildRawMessage splits a long quote-safe ASCII filename into quoted continuations (M1)", () => {
  // A >998-octet space-free ASCII name previously arrived one character longer
  // (a spurious space inserted by the hard break). Quoted RFC 2231
  // continuations (filename*0="…"; filename*1="…") preserve it byte-for-byte.
  const filename = "a".repeat(1104) + ".txt";
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      body: "b",
      attachments: [
        { filename, mimeType: "text/plain", contentBase64: "QQ==" },
      ],
    })
  );
  const unfolded = mime.replace(/\r\n[ \t]/g, " ");
  const segs = [...unfolded.matchAll(/filename\*(\d+)="([^"]*)"/g)].sort(
    (a, b) => Number(a[1]) - Number(b[1])
  );
  assert.ok(segs.length > 1, "expected multiple quoted continuation segments");
  const joined = segs.map((s) => s[2]).join("");
  assert.equal(joined.length, filename.length, "length preserved (no injected space)");
  assert.equal(joined, filename);
});

test("buildRawMessage re-quotes an already-quoted display name instead of nesting quotes (L3)", () => {
  // '"Doe, John" <j@x.com>' is exactly how clients render such addresses, so
  // it's what callers copy-paste. The quotes must be unwrapped and re-applied
  // canonically — previously the name arrived displaying literal quote marks.
  const mime = decodeBase64Url(
    buildRawMessage({ to: ['"Doe, John" <j@x.com>'], subject: "s", body: "b" })
  ).replace(/\r\n[ \t]/g, " ");
  assert.equal(mime.match(/^To:.*$/m)[0], 'To: "Doe, John" <j@x.com>');
  // Escapes inside the quoted form are unwrapped, then re-escaped as needed.
  const mime2 = decodeBase64Url(
    buildRawMessage({ to: ['"Say \\"hi\\", Jo" <jo@x.com>'], subject: "s", body: "b" })
  ).replace(/\r\n[ \t]/g, " ");
  assert.equal(mime2.match(/^To:.*$/m)[0], 'To: "Say \\"hi\\", Jo" <jo@x.com>');
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

test("handleGmailError reads the HTTP status from gaxios shapes (#L2)", () => {
  // gaxios surfaces a numeric status on error.status / error.response.status
  // (not error.code) for HTTP errors; both must be recognized.
  assert.match(handleGmailError({ status: 404 }), /Resource not found/);
  assert.match(handleGmailError({ response: { status: 429 } }), /Rate limit exceeded/);
});

test("handleGmailError surfaces Gmail's structured error detail (#L2)", () => {
  const err = {
    response: {
      status: 403,
      data: { error: { errors: [{ message: "User-rate limit exceeded" }] } },
    },
  };
  const msg = handleGmailError(err);
  assert.match(msg, /Permission denied/);
  assert.match(msg, /User-rate limit exceeded/); // detail is included, not dropped
});

test("handleGmailError reports a transport error distinctly, not as an API failure (#L2)", () => {
  const net = handleGmailError({
    code: "ENOTFOUND",
    message: "getaddrinfo ENOTFOUND gmail.googleapis.com",
  });
  assert.match(net, /Network error \(ENOTFOUND\)/);
  assert.doesNotMatch(net, /Gmail API request failed/);
});

test("handleGmailError maps invalid_grant (400) to re-auth guidance (M3)", () => {
  // The OAuth token endpoint's shape: data.error is the STRING "invalid_grant"
  // (this is how a revoked/expired refresh token — the most common way an
  // account dies — actually surfaces through google-auth-library).
  const msg = handleGmailError({
    status: 400,
    message: "invalid_grant",
    response: {
      status: 400,
      data: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    },
  });
  assert.match(msg, /invalid_grant/);
  assert.match(msg, /Token has been expired or revoked/);
  assert.match(msg, /add-account/);
  // A plain 400 (not invalid_grant) keeps the generic status message.
  const generic = handleGmailError({ status: 400, message: "badRequest" });
  assert.match(generic, /status 400/);
  assert.doesNotMatch(generic, /add-account/);
});

test("handleGmailError distinguishes a rate-limit 403 from a permission 403 (M4)", () => {
  const rateLimited = handleGmailError({
    response: {
      status: 403,
      data: {
        error: {
          errors: [
            { domain: "usageLimits", reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded" },
          ],
        },
      },
    },
  });
  assert.match(rateLimited, /Rate limit exceeded \(403 userRateLimitExceeded\)/);
  assert.doesNotMatch(rateLimited, /scope/);
  // A true permission 403 keeps the scope guidance.
  const permission = handleGmailError({
    response: {
      status: 403,
      data: {
        error: {
          errors: [
            { domain: "global", reason: "insufficientPermissions", message: "Insufficient Permission" },
          ],
        },
      },
    },
  });
  assert.match(permission, /Permission denied/);
  assert.match(permission, /scope/);
});

test("handleGmailError reports a request timeout as a timeout, not a generic error (#3)", () => {
  // A node-fetch timeout has no HTTP status and no string `code`, only `type`.
  const msg = handleGmailError({
    type: "request-timeout",
    message: "network timeout at: https://gmail.googleapis.com/...",
  });
  assert.match(msg, /timed out/i);
  assert.doesNotMatch(msg, /Gmail API request failed/);
});

test("handleGmailError reports a gaxios-7 AbortError timeout as a timeout (#g7)", () => {
  // gaxios 7 aborts a stalled request via its timeout AbortSignal: a GaxiosError
  // with no status and no `code` whose `cause` is an AbortError. It must still
  // read as a timeout, not a generic error.
  const cause = new Error("The operation was aborted.");
  cause.name = "AbortError";
  const msg = handleGmailError({ message: "The operation was aborted.", cause });
  assert.match(msg, /timed out/i);
  assert.doesNotMatch(msg, /Gmail API request failed/);
});

test("handleGmailError reads a transport code from the gaxios-7 FetchError cause (#g7)", () => {
  // A connection failure may carry its system `code` on the FetchError `cause`.
  const cause = new Error("connect ECONNREFUSED");
  cause.code = "ECONNREFUSED";
  const msg = handleGmailError({ message: "request to ... failed", cause });
  assert.match(msg, /Network error \(ECONNREFUSED\)/);
  assert.doesNotMatch(msg, /Gmail API request failed/);
});

test("requireField returns present values and throws on null/undefined", () => {
  assert.equal(requireField("abc", "thread.id"), "abc");
  assert.equal(requireField(0, "n"), 0); // falsy-but-present must pass through
  assert.equal(requireField("", "s"), "");
  assert.throws(() => requireField(undefined, "label.id"), /missing expected field: label\.id/);
  assert.throws(() => requireField(null, "message.id"), /missing expected field: message\.id/);
});

test("renderJsonText returns valid JSON under budget, a safe notice over it (#4)", () => {
  const small = { account: "a@b.com", count: 1, threads: [{ thread_id: "t1" }] };
  assert.deepEqual(JSON.parse(renderJsonText(small, "note")), small);

  // An object whose pretty-printed form exceeds CHARACTER_LIMIT (25000).
  const big = {
    items: Array.from({ length: 6000 }, (_, i) => ({ i, s: "xxxxxxxxxx" })),
  };
  assert.ok(JSON.stringify(big, null, 2).length > 25000, "fixture must exceed budget");
  const capped = renderJsonText(big, "Refine your query.");
  // The old slice-the-JSON behavior produced unparseable text; the notice must
  // not masquerade as JSON, and must point the reader at structuredContent.
  assert.throws(() => JSON.parse(capped));
  assert.match(capped, /structuredContent/);
  assert.match(capped, /Refine your query\./);

  // renderJsonText's over-budget branch must produce exactly the standalone
  // notice for the same length, so callers that precomputed the JSON length can
  // reuse jsonTooLargeNotice instead of re-serializing (#4).
  const len = JSON.stringify(big, null, 2).length;
  assert.equal(capped, jsonTooLargeNotice(len, "Refine your query."));
});

test("jsonTooLargeNotice reports the length and note and is not valid JSON (#4)", () => {
  const notice = jsonTooLargeNotice(12345, "Read structuredContent.");
  assert.match(notice, /12345 characters/);
  assert.match(notice, /structuredContent/);
  assert.match(notice, /Read structuredContent\./);
  assert.throws(() => JSON.parse(notice));
});

test("packageVersion matches package.json (#9)", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  );
  assert.equal(packageVersion(), pkg.version);
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

test("resolveAttachments rejects a non-regular file (directory) inside the allowlist (#5)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-att-"));
  const subdir = path.join(root, "a-directory");
  fs.mkdirSync(subdir);
  const prev = process.env.GMAIL_MCP_ATTACHMENTS_DIR;
  try {
    process.env.GMAIL_MCP_ATTACHMENTS_DIR = root;
    // A directory passes the existence + containment checks but is not a regular
    // file, so it must be refused rather than read. On POSIX the open succeeds
    // and the fstat-on-fd guard rejects it ("not a regular file"); on Windows the
    // open itself fails ("could not be opened safely"). Either way it's refused.
    assert.throws(
      () => resolveAttachments([{ path: subdir }]),
      /not a regular file|could not be opened safely/
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

test("resolveAttachments rejects base64 of an impossible length (#4)", () => {
  // Stripped of padding, a base64 string's length is never ≡ 1 (mod 4): a lone
  // trailing 6-bit group can't exist. Node's decoder would silently drop it
  // rather than flag the corruption, so these must be rejected up front.
  assert.throws(
    () => resolveAttachments([{ filename: "a.bin", content_base64: "QQQQQ" }]), // 5
    /not valid base64/
  );
  assert.throws(
    () => resolveAttachments([{ filename: "a.bin", content_base64: "Q" }]), // 1
    /not valid base64/
  );
  // Valid lengths (≡ 0/2/3 mod 4) still pass, padded or not.
  assert.doesNotThrow(() =>
    resolveAttachments([{ filename: "a.bin", content_base64: "QQ==" }])
  );
  assert.doesNotThrow(() =>
    resolveAttachments([{ filename: "a.bin", content_base64: "QQQ" }]) // unpadded
  );
});

// --------------------------------------------------------------------------
// capMessageBodies — lazy body rendering  (review items #7 + #E)
// --------------------------------------------------------------------------
test("capMessageBodies keeps bodies that fit within the budget", () => {
  const r = capMessageBodies([{ id: 1 }, { id: 2 }], 100, () => "aaa");
  assert.equal(r.truncated, false);
  assert.equal(r.messages[0].body, "aaa");
  assert.equal(r.messages[1].body, "aaa");
});

test("capMessageBodies truncates the crossing body and omits later ones", () => {
  const items = [{ b: "x" }, { b: "y" }, { b: "z" }];
  const r = capMessageBodies(items, 20, (m) => m.b.repeat(30));
  assert.equal(r.truncated, true);
  assert.ok(r.messages[0].body.startsWith("x".repeat(20)));
  assert.match(r.messages[0].body, /truncated/);
  assert.match(r.messages[1].body, /omitted/);
  assert.match(r.messages[2].body, /omitted/);
});

test("capMessageBodies renders lazily — bodies past the budget are never decoded (#E)", () => {
  const rendered = [];
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  capMessageBodies(items, 20, (m) => {
    rendered.push(m.id);
    return "z".repeat(30); // first body already exceeds the budget
  });
  // Only the first item is rendered; b and c are omitted without rendering.
  assert.deepEqual(rendered, ["a"]);
});

test("capMessageBodies treats an exact-fit body as not truncated", () => {
  const r = capMessageBodies([{ id: 1 }], 20, () => "a".repeat(20));
  assert.equal(r.truncated, false);
  assert.equal(r.messages[0].body, "a".repeat(20));
});

test("capMessageBodies preserves non-body fields", () => {
  const r = capMessageBodies([{ message_id: "m1", from: "a@b" }], 10, () => "x".repeat(50));
  assert.equal(r.messages[0].message_id, "m1");
  assert.equal(r.messages[0].from, "a@b");
  assert.match(r.messages[0].body, /truncated/);
});

// --------------------------------------------------------------------------
// deriveReplySubject  (review item #6)
// --------------------------------------------------------------------------
test("deriveReplySubject prefers an explicit subject, else derives from the thread", () => {
  assert.equal(deriveReplySubject("Custom", "Thread topic"), "Custom");
  assert.equal(deriveReplySubject("", "Thread topic"), ""); // explicit empty is honored
  assert.equal(deriveReplySubject(undefined, "Thread topic"), "Re: Thread topic");
  assert.equal(deriveReplySubject(undefined, "Re: Thread topic"), "Re: Thread topic");
  assert.equal(deriveReplySubject(undefined, "RE: shouting"), "RE: shouting");
  assert.equal(deriveReplySubject(undefined, "   "), "");
  assert.equal(deriveReplySubject(undefined, undefined), "");
});

// --------------------------------------------------------------------------
// buildRawMessage: crypto boundary (#A1), hard-break (#A3), alternative (#C2)
// --------------------------------------------------------------------------
test("buildRawMessage uses an unguessable, per-message multipart boundary (#A1)", () => {
  const attachments = [
    { filename: "a.bin", mimeType: "application/octet-stream", contentBase64: "QQ==" },
  ];
  const grab = () => {
    const mime = decodeBase64Url(
      buildRawMessage({ to: ["a@b.com"], subject: "s", body: "b", attachments })
    );
    const m = /boundary="(=_mix_[0-9a-f]{36})"/.exec(mime);
    assert.ok(m, "boundary is a random hex token, not time/Math.random based");
    return m[1];
  };
  // Two builds must not reuse a boundary (proves it's CSPRNG, not Date.now()).
  assert.notEqual(grab(), grab());
});

test("buildRawMessage hard-breaks a single >998-octet header token to satisfy the hard limit (#A3)", () => {
  // One enormous message-id with no internal space: space-folding can't break
  // it, so it must be hard-broken so no physical line exceeds 998 octets.
  const giant = "<" + "a".repeat(3000) + "@example.com>";
  const mime = decodeBase64Url(
    buildRawMessage({ to: ["a@b.com"], subject: "s", body: "b", references: giant })
  );
  for (const line of mime.split("\r\n")) {
    assert.ok(
      Buffer.byteLength(line, "utf-8") <= 998,
      `line exceeds 998 octets (${Buffer.byteLength(line, "utf-8")})`
    );
  }
});

test("buildRawMessage sends HTML as multipart/alternative with a derived plain part (#C2)", () => {
  const html = "<p>Hello <b>world</b></p>";
  const mime = decodeBase64Url(
    buildRawMessage({ to: ["a@b.com"], subject: "s", isHtml: true, body: html })
  );
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/);
  // The plain alternative is derived from the HTML (htmlToText => "Hello world").
  assert.ok(
    mime.includes(Buffer.from("Hello world", "utf-8").toString("base64")),
    "derived text/plain alternative present"
  );
  // The original HTML is retained as the text/html part.
  assert.ok(
    mime.includes(Buffer.from(html, "utf-8").toString("base64")),
    "text/html part present"
  );
});

test("buildRawMessage nests alternative inside mixed when an HTML body has attachments (#C2)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      isHtml: true,
      body: "<p>Hi</p>",
      attachments: [
        { filename: "a.txt", mimeType: "text/plain", contentBase64: "QQ==" },
      ],
    })
  );
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Disposition: attachment/);
});

test("buildRawMessage uses distinct mixed and alternative boundaries (#note5)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      isHtml: true,
      body: "<p>Hi</p>",
      attachments: [
        { filename: "a.txt", mimeType: "text/plain", contentBase64: "QQ==" },
      ],
    })
  );
  const mix = /boundary="(=_mix_[0-9a-f]+)"/.exec(mime);
  const alt = /boundary="(=_alt_[0-9a-f]+)"/.exec(mime);
  assert.ok(mix && alt, "both a mixed and an alternative boundary are present");
  assert.notEqual(mix[1], alt[1], "the two boundaries must differ");
  // The collision guard picks the mixed boundary to avoid the alternative one,
  // so neither is a substring of the other (a substring would let a delimiter
  // match inside the wrong level).
  assert.ok(
    !alt[1].includes(mix[1]) && !mix[1].includes(alt[1]),
    "neither boundary may contain the other"
  );
});

// --------------------------------------------------------------------------
// formatRecipient — display-name encoding/quoting (#note2, #note3)
// --------------------------------------------------------------------------
test("buildRawMessage quotes a display name containing a comma (#note3)", () => {
  // The comma-bearing name must be quoted so it isn't read as two recipients
  // once the list is comma-joined.
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["Doe, John <john@x.com>", "a@b.com"],
      subject: "s",
      body: "b",
    })
  );
  assert.match(mime, /^To: "Doe, John" <john@x\.com>, a@b\.com$/m);
});

test("buildRawMessage RFC 2047-encodes a non-ASCII recipient display name (#note2)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({ to: ["Müller <m@x.com>"], subject: "s", body: "b" })
  );
  // Display name encoded as an encoded-word; address left intact; no raw bytes.
  assert.match(mime, /^To: =\?UTF-8\?B\?[^?]+\?= <m@x\.com>$/m);
  const m = /=\?UTF-8\?B\?([^?]+)\?=/.exec(mime);
  assert.equal(Buffer.from(m[1], "base64").toString("utf-8"), "Müller");
});

test("buildRawMessage leaves a clean ASCII display name unquoted (#note3)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({ to: ["Alice Example <alice@x.com>"], subject: "s", body: "b" })
  );
  assert.match(mime, /^To: Alice Example <alice@x\.com>$/m);
});

// --------------------------------------------------------------------------
// htmlToText input bound (#note1)
// --------------------------------------------------------------------------
test("htmlToText bounds very large input before parsing (#note1)", () => {
  // Content past the input cap is dropped (the cap guards against multi-MB
  // bodies building an unbounded DOM); content before it survives. One giant
  // text node keeps the test fast.
  const html = "<p>VISIBLE_HEAD " + "y".repeat(2_000_000) + " HIDDEN_TAIL</p>";
  const out = htmlToText(html);
  assert.match(out, /VISIBLE_HEAD/);
  assert.doesNotMatch(out, /HIDDEN_TAIL/);
});

// --------------------------------------------------------------------------
// withRetry — transient-failure backoff (#C3)
// --------------------------------------------------------------------------
test("withRetry retries a transient 5xx then succeeds (#C3)", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const e = new Error("transient");
        e.code = 503;
        throw e;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("withRetry does not retry a non-retryable status (#C3)", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const e = new Error("nope");
        e.code = 404;
        throw e;
      },
      { retries: 5, baseDelayMs: 1 }
    ),
    /nope/
  );
  assert.equal(calls, 1); // tried once, no retries
});

test("withRetry gives up after the retry budget and rethrows (#C3)", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const e = new Error("rate");
        e.status = 429;
        throw e;
      },
      { retries: 2, baseDelayMs: 1 }
    ),
    /rate/
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test("withRetry retries a usage-limit 403 like a 429 — even for non-idempotent sends (M4)", async () => {
  // Gmail's alternate rate-limit shape: 403 with a usageLimits reason. Like a
  // 429 it was rejected before processing, so retrying can't duplicate a send.
  const rateLimit403 = () => {
    const e = new Error("User Rate Limit Exceeded");
    e.response = {
      status: 403,
      data: {
        error: {
          errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }],
        },
      },
    };
    return e;
  };
  for (const idempotent of [true, false]) {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls <= 2) throw rateLimit403();
        return "ok";
      },
      { baseDelayMs: 1, idempotent }
    );
    assert.equal(out, "ok");
    assert.equal(calls, 3, `idempotent=${idempotent}: two 403 throttles then success`);
  }

  // A permission 403 (no rate-limit reason) must NOT retry.
  let permCalls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        permCalls++;
        const e = new Error("Insufficient Permission");
        e.response = {
          status: 403,
          data: {
            error: { errors: [{ domain: "global", reason: "insufficientPermissions" }] },
          },
        };
        throw e;
      },
      { baseDelayMs: 1 }
    ),
    /Insufficient Permission/
  );
  assert.equal(permCalls, 1, "a permission 403 is not retryable");
});

test("a dailyLimitExceeded 403 is NOT retried and gets a distinct daily-quota message (N2)", async () => {
  // A hard per-day quota can't reset within a few seconds of backoff, so
  // retrying only adds latency — unlike the transient per-second throttles.
  const dailyLimit = () => {
    const e = new Error("Daily Limit Exceeded");
    e.response = {
      status: 403,
      data: { error: { errors: [{ domain: "usageLimits", reason: "dailyLimitExceeded" }] } },
    };
    return e;
  };
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw dailyLimit();
      },
      { baseDelayMs: 1, idempotent: false }
    )
  );
  assert.equal(calls, 1, "dailyLimitExceeded must not be retried");
  // ...and it must read as a quota problem, not a rate limit or a scope error.
  const msg = handleGmailError(dailyLimit());
  assert.match(msg, /Daily Gmail quota exceeded/);
  assert.match(msg, /dailyLimitExceeded/);
  assert.doesNotMatch(msg, /scope/);
});

test("capMessageBodies truncation markers don't say 'thread' (N3)", () => {
  // capMessageBodies serves single-message reads (gmail_get_message) too, so the
  // marker must not describe a single message as a thread.
  const truncated = capMessageBodies([{ id: 1 }], 5, () => "x".repeat(30000));
  assert.match(truncated.messages[0].body, /\[Body truncated: response size limit reached\]/);
  assert.doesNotMatch(truncated.messages[0].body, /thread/);

  const omitted = capMessageBodies([{ id: 1 }, { id: 2 }], 3, () => "yyy");
  assert.match(omitted.messages[1].body, /\[Body omitted: response size limit reached\]/);
  assert.doesNotMatch(omitted.messages[1].body, /thread/);
});

test("capMessageBodies markers blame the response limit, not the unrendered body (round-4 N1)", () => {
  // A body arriving after the budget is spent is never rendered (the lazy
  // contract), so the marker cannot know its size — the body may even be
  // EMPTY. The old text "[Body omitted: exceeds size limit]" asserted the
  // body exceeded something; the marker must only blame the response limit.
  const r = capMessageBodies([{ id: 1 }, { id: 2 }], 3, (m) =>
    m.id === 1 ? "yyy" : ""
  );
  assert.equal(r.messages[1].body, "[Body omitted: response size limit reached]");
  assert.doesNotMatch(r.messages[1].body, /exceeds/);
  // Same for the crossing body: it exceeded the REMAINING budget, not
  // necessarily "the size limit" — blame the response limit there too.
  const crossing = capMessageBodies([{ id: 1 }], 2, () => "zzzz");
  assert.doesNotMatch(crossing.messages[0].body, /exceeds/);
});

test("withRetry idempotent:false does NOT retry a 5xx (no duplicate side effect) (#retry)", async () => {
  // A non-idempotent call (send/draft): a 5xx after the server may already have
  // processed the request must NOT be retried, or it could duplicate the effect.
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const e = new Error("unavailable");
        e.code = 503;
        throw e;
      },
      { retries: 5, baseDelayMs: 1, idempotent: false }
    ),
    /unavailable/
  );
  assert.equal(calls, 1); // 503 is not retried for a non-idempotent call
});

test("withRetry idempotent:false still retries a 429 (rejected before processing) (#retry)", async () => {
  // A 429 means Gmail rejected the request before doing anything, so retrying is
  // safe even for a non-idempotent call.
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const e = new Error("rate");
        e.status = 429;
        throw e;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1, idempotent: false }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("withRetry retries a transient transport error (ETIMEDOUT) for idempotent calls (#3)", async () => {
  // A timeout/reset has no HTTP status; for an idempotent call it's safe to retry.
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 2) {
        const e = new Error("connect ETIMEDOUT");
        e.code = "ETIMEDOUT"; // string code (system error), not an HTTP status
        throw e;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("withRetry treats a node-fetch request-timeout as retryable for idempotent calls (#3)", async () => {
  // A node-fetch timeout carries no `code`, only `type: "request-timeout"`.
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 2) {
        const e = new Error("network timeout at: https://gmail.googleapis.com/...");
        e.type = "request-timeout";
        throw e;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("withRetry idempotent:false does NOT retry a transport timeout (#3)", async () => {
  // For a send/draft a timeout could mean the request was already processed, so
  // retrying might duplicate the side effect — it must surface immediately.
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const e = new Error("connect ETIMEDOUT");
        e.code = "ETIMEDOUT";
        throw e;
      },
      { retries: 5, baseDelayMs: 1, idempotent: false }
    ),
    /ETIMEDOUT/
  );
  assert.equal(calls, 1); // transport errors are never retried for non-idempotent calls
});

// gaxios 7 (the generation bump from gaxios 6) changes transport-error shapes: a
// per-request timeout now surfaces as a GaxiosError whose `cause` is an
// AbortError (no `code`, no `type`), and a connection failure also carries its
// system `code` on a FetchError `cause`. These exercise the rewritten detection.
test("withRetry retries a gaxios-7 AbortError timeout for idempotent calls (#g7)", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 2) {
        const e = new Error("The operation was aborted.");
        e.cause = new Error("aborted");
        e.cause.name = "AbortError";
        throw e;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 2); // the AbortError timeout was retried once
});

test("withRetry idempotent:false does NOT retry a gaxios-7 AbortError timeout (no duplicate send) (#g7)", async () => {
  // The no-duplicate-send guarantee under gaxios 7: a send/draft timeout may have
  // already been processed server-side, so it must surface immediately.
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const e = new Error("The operation was aborted.");
        e.cause = new Error("aborted");
        e.cause.name = "AbortError";
        throw e;
      },
      { retries: 5, baseDelayMs: 1, idempotent: false }
    ),
    /aborted/i
  );
  assert.equal(calls, 1);
});

test("withRetry retries a gaxios-7 transport error whose code is on the FetchError cause (#g7)", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 2) {
        const e = new Error("request to ... failed, reason: connect ECONNRESET");
        e.cause = new Error("connect ECONNRESET");
        e.cause.code = "ECONNRESET"; // system code on the cause, not the top level
        throw e;
      }
      return "ok";
    },
    { retries: 5, baseDelayMs: 1 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

// --------------------------------------------------------------------------
// Review follow-ups: remaining lows and notes (L1, L2, L4, L5, L6, N2, N3)
// --------------------------------------------------------------------------
test("foldHeaderLine never emits a whitespace-only folded line (L1)", () => {
  // A double space straddling the fold boundary before an unfoldable token
  // used to produce a line of only WSP — forbidden by RFC 5322 §3.2.2.
  const subject = "a".repeat(68) + "  " + "b".repeat(100);
  const mime = decodeBase64Url(buildRawMessage({ to: ["a@b.com"], subject, body: "x" }));
  for (const line of mime.split("\r\n")) {
    assert.doesNotMatch(line, /^[ \t]+$/, "no folded line may be all-whitespace");
  }
  // Unfolding still restores the subject byte-for-byte.
  const unfolded = mime.replace(/\r\n(?=[ \t])/g, "");
  assert.ok(unfolded.includes(`Subject: ${subject}`), "subject must unfold intact");
});

test("encodeHeaderWord protects ASCII text that looks like an encoded-word (L2)", () => {
  // Passed through verbatim, recipients would DECODE this into "Hacked".
  const literal = "=?UTF-8?B?SGFja2Vk?=";
  const mime = decodeBase64Url(buildRawMessage({ to: ["a@b.com"], subject: literal, body: "x" }));
  const subjectLine = mime.replace(/\r\n[ \t]/g, " ").match(/^Subject: (.*)$/m)[1];
  assert.notEqual(subjectLine, literal, "the literal must not go on the wire bare");
  // The emitted encoded-word(s) decode back to the literal text.
  const words = subjectLine.match(/=\?UTF-8\?B\?([^?]*)\?=/g);
  assert.ok(words && words.length > 0, "subject must be RFC 2047-encoded");
  const decoded = words
    .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf-8"))
    .join("");
  assert.equal(decoded, literal);
});

test("formatRecipient quotes an ASCII display name containing an encoded-word marker (L2)", () => {
  const mime = decodeBase64Url(
    buildRawMessage({ to: ["=?UTF-8?B?SGFja2Vk?= x <a@x.com>"], subject: "s", body: "x" })
  ).replace(/\r\n[ \t]/g, " ");
  // Quoted-strings are never decoded as encoded-words, so the name survives.
  assert.match(mime, /^To: "=\?UTF-8\?B\?SGFja2Vk\?= x" <a@x\.com>$/m);
});

/**
 * String.prototype.isWellFormed(), but working on Node 18 too (the API landed
 * in Node 20 and CI still runs the 18.x line that `engines` supports): scan
 * for lone surrogates by code unit.
 */
function isWellFormedString(s) {
  if (typeof s.isWellFormed === "function") return s.isWellFormed();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1); // NaN past the end — fails the range check
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++; // skip the low half of a valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false; // low surrogate with no preceding high half
    }
  }
  return true;
}

test("capMessageBodies never splits a surrogate pair at the truncation cut (L4)", () => {
  const r = capMessageBodies([{ id: 1 }], 5, () => "\u{1F600}".repeat(10));
  assert.equal(r.truncated, true);
  assert.match(r.messages[0].body, /truncated/);
  assert.equal(isWellFormedString(r.messages[0].body), true, "no lone surrogate may survive");
  // An even budget still cuts cleanly between pairs.
  const r2 = capMessageBodies([{ id: 1 }], 4, () => "\u{1F600}".repeat(10));
  assert.equal(isWellFormedString(r2.messages[0].body), true);
  // The helper itself must actually detect ill-formed strings (Node 18 path).
  assert.equal(isWellFormedString("ok \ud83d"), false, "lone high surrogate must be detected");
  assert.equal(isWellFormedString("\ude00 tail"), false, "lone low surrogate must be detected");
  assert.equal(isWellFormedString("\u{1F600}"), true);
});

test("extractPlainText falls back to HTML when the text/plain part is whitespace-only (L5)", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("\r\n") } },
      { mimeType: "text/html", body: { data: b64url("<p>Full content here</p>") } },
    ],
  };
  assert.match(extractPlainText(payload), /Full content here/);
  // A content-bearing plain part still wins over HTML.
  const normal = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("plain wins") } },
      { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
    ],
  };
  assert.equal(extractPlainText(normal), "plain wins");
});

test("summarizeThread decodes the Gmail API's snippet entity escapes (L6)", async () => {
  const gmail = mockGmailGet(async () => ({
    data: {
      messages: [
        {
          snippet: "I&#39;ll send the Q3 numbers &amp; slides &lt;soon&gt;",
          payload: { headers: [{ name: "Subject", value: "Q3" }] },
        },
      ],
    },
  }));
  const out = await summarizeThread(gmail, { id: "t1" });
  assert.equal(out.snippet, "I'll send the Q3 numbers & slides <soon>");

  // The degraded (fetch-failed) path decodes the list snippet too.
  const failing = mockGmailGet(async () => {
    const e = new Error("boom");
    e.code = 500;
    throw e;
  });
  const degraded = await summarizeThread(
    failing,
    { id: "t2", snippet: "Bob &amp; Carol&#x27;s plan" },
    { retries: 0, baseDelayMs: 1 }
  );
  assert.equal(degraded.snippet, "Bob & Carol's plan");
});

test("buildReplyHeaders normalizes a bare in_reply_to to msg-id form (N2)", () => {
  // Bare (bracket-less) ids are how Message-IDs are commonly displayed;
  // emitted verbatim they are invalid and receivers ignore the threading.
  assert.deepEqual(buildReplyHeaders(undefined, "CAF+abc@mail.gmail.com"), {
    inReplyTo: "<CAF+abc@mail.gmail.com>",
    references: "<CAF+abc@mail.gmail.com>",
  });
  // A normalized id still matches (and truncates) the thread's chain.
  const reply = { inReplyTo: "<c@x>", references: "<a@x> <b@x> <c@x>", subject: "T" };
  const out = buildReplyHeaders(reply, "b@x");
  assert.equal(out.inReplyTo, "<b@x>");
  assert.equal(out.references, "<a@x> <b@x>");
  // Already-bracketed ids pass through unchanged.
  assert.equal(buildReplyHeaders(undefined, "<ok@x>").inReplyTo, "<ok@x>");
});

test("resolveAttachments rejects composite MIME types that cannot be base64-encoded (N3)", () => {
  // RFC 2046 §5 forbids base64 for message/* and multipart/* entities.
  assert.throws(
    () =>
      resolveAttachments([
        { filename: "original.eml", mime_type: "message/rfc822", content_base64: "QQ==" },
      ]),
    /composite MIME type.*application\/octet-stream/
  );
  assert.throws(
    () =>
      resolveAttachments([
        { filename: "bundle", mime_type: "multipart/mixed", content_base64: "QQ==" },
      ]),
    /composite MIME type/
  );
  // Ordinary types are unaffected.
  assert.doesNotThrow(() =>
    resolveAttachments([
      { filename: "a.pdf", mime_type: "application/pdf", content_base64: "QQ==" },
    ])
  );
});

// --------------------------------------------------------------------------
// Retry layering (M5): withRetry must be the ONLY retry policy
// --------------------------------------------------------------------------
test("retry:false keeps the real Gmail client at one HTTP request per withRetry attempt (M5)", async () => {
  // googleapis-common force-enables gaxios's internal retry (3 extra requests
  // per GET on 408/429/5xx, fixed unjittered delays, no Retry-After). Stacked
  // under withRetry that multiplied to ~16 requests per failing idempotent
  // call. With retry:false (mirroring gmailFor's factory options), 3 withRetry
  // attempts must mean exactly 3 requests on the wire.
  const { gmail: gmailFactory } = await import("@googleapis/gmail");
  const { OAuth2Client } = await import("google-auth-library");
  const http = await import("node:http");

  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: 503, message: "backend unavailable" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const auth = new OAuth2Client({ clientId: "c", clientSecret: "s" });
    // A far-future expiry so the client never attempts a token refresh.
    auth.setCredentials({ access_token: "at", expiry_date: Date.now() + 3600_000 });
    const gmail = gmailFactory({
      version: "v1",
      auth,
      timeout: 2000,
      retry: false,
      rootUrl: `http://127.0.0.1:${server.address().port}`,
    });
    await assert.rejects(
      withRetry(() => gmail.users.labels.list({ userId: "me" }), {
        retries: 2,
        baseDelayMs: 1,
      })
    );
    assert.equal(
      hits,
      3,
      "3 withRetry attempts must produce exactly 3 HTTP requests (no hidden inner retry)"
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("getThreadReplyHeaders anchors the reply to the last DELIVERED message, skipping drafts (low)", async () => {
  // threads.get returns unsent drafts inline (DRAFT label). A reply must not
  // reference a draft's Message-ID — it was never delivered, so recipients'
  // clients can't thread on it. This is this server's own create_draft(thread)
  // → send_message(thread) flow.
  const gmail = mockGmailThread([
    {
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "Subject", value: "Topic" },
          { name: "Message-ID", value: "<real-1@x>" },
        ],
      },
    },
    {
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "Message-ID", value: "<real-2@x>" },
          { name: "References", value: "<real-1@x>" },
        ],
      },
    },
    {
      labelIds: ["DRAFT"],
      payload: {
        headers: [
          { name: "Message-ID", value: "<draft@x>" },
          { name: "References", value: "<real-1@x> <real-2@x>" },
        ],
      },
    },
  ]);
  const reply = await getThreadReplyHeaders(gmail, "t");
  assert.equal(reply.inReplyTo, "<real-2@x>", "must anchor to the last delivered message");
  assert.equal(reply.references, "<real-1@x> <real-2@x>");
  assert.doesNotMatch(reply.references, /draft@x/);
  assert.equal(reply.subject, "Topic");

  // A thread of only drafts yields nothing to thread on (empty headers),
  // rather than a reference to an undelivered id.
  const allDrafts = mockGmailThread([
    { labelIds: ["DRAFT"], payload: { headers: [{ name: "Message-ID", value: "<d@x>" }] } },
  ]);
  const none = await getThreadReplyHeaders(allDrafts, "t2");
  assert.equal(none.inReplyTo, "");
  assert.equal(none.references, "");
});

// --------------------------------------------------------------------------
// decodeRfc2047 — defensive display decoding of header values  (round-5)
// --------------------------------------------------------------------------
test("decodeRfc2047 decodes B- and Q-encoded words and passes plain text through (round-5)", () => {
  assert.equal(decodeRfc2047("=?UTF-8?B?5pel5pys6Kqe?="), "日本語");
  assert.equal(decodeRfc2047("=?utf-8?q?caf=C3=A9_au_lait?="), "café au lait");
  assert.equal(decodeRfc2047("=?ISO-8859-1?Q?caf=E9?="), "café");
  // Already-decoded (the common Gmail API case) and plain values are no-ops.
  assert.equal(decodeRfc2047("plain ascii subject"), "plain ascii subject");
  assert.equal(decodeRfc2047("Re: 日本語 (fwd)"), "Re: 日本語 (fwd)");
  // Text around an encoded word is kept verbatim.
  assert.equal(decodeRfc2047("Re: =?UTF-8?B?5pel5pys6Kqe?= (fwd)"), "Re: 日本語 (fwd)");
  // RFC 2231 language suffix on the charset is tolerated.
  assert.equal(decodeRfc2047("=?UTF-8*ja?B?5pel5pys6Kqe?="), "日本語");
});

test("decodeRfc2047 drops whitespace between adjacent encoded words (RFC 2047 §6.2)", () => {
  // The split exists only to satisfy the 76-char encoded-line limit.
  assert.equal(decodeRfc2047("=?UTF-8?B?5pel5pys?= =?UTF-8?B?6Kqe?="), "日本語");
  // ...but whitespace between a word and plain text is real content.
  assert.equal(decodeRfc2047("=?UTF-8?B?5pel5pys6Kqe?= news"), "日本語 news");
});

test("decodeRfc2047 leaves undecodable words raw instead of emitting mojibake (round-5)", () => {
  const unknownCharset = "=?X-KLINGON?B?5pel?=";
  assert.equal(decodeRfc2047(unknownCharset), unknownCharset);
  const badBase64 = "=?UTF-8?B?!!!!?=";
  assert.equal(decodeRfc2047(badBase64), badBase64);
  const badQuoted = "=?UTF-8?Q?=ZZ?=";
  assert.equal(decodeRfc2047(badQuoted), badQuoted);
});

test("decodeRfc2047 leaves a Q word containing literal non-ASCII raw, never truncated mod 256 (round-6)", () => {
  // Q encoded-text is printable ASCII by definition. A subject QUOTING an
  // encoded-word example arrives from the Gmail API as this literal text; the
  // Q byte loop used to push charCodeAt() values into a byte buffer, turning
  // "café" into "caf�" (and CJK into mod-256 garbage/NUL) instead of
  // leaving the sender's actual text untouched.
  const accented = "=?UTF-8?Q?café?=";
  assert.equal(decodeRfc2047(accented), accented);
  const cjk = "=?UTF-8?Q?日本語?=";
  assert.equal(decodeRfc2047(cjk), cjk);
});

test("summarizeThread decodes RFC 2047 subject/from for display (round-5)", async () => {
  const fake = {
    users: {
      threads: {
        get: async () => ({
          data: {
            messages: [
              {
                payload: {
                  headers: [
                    { name: "Subject", value: "=?UTF-8?B?5pel5pys6Kqe?=" },
                    { name: "From", value: "=?UTF-8?Q?Caf=C3=A9?= <cafe@x.com>" },
                    { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
                  ],
                },
                snippet: "s",
              },
            ],
          },
        }),
      },
    },
  };
  const out = await summarizeThread(fake, { id: "t1" });
  assert.equal(out.subject, "日本語");
  assert.equal(out.from, "Café <cafe@x.com>");
  assert.equal(out.date, "Mon, 1 Jan 2024 00:00:00 +0000");
});

test("a display name pasted with an embedded newline is normalized and quoted (round-6)", () => {
  // `.` doesn't match a newline, so the name-addr parse used to fail on a
  // pasted two-line display name; the whole string skipped formatRecipient's
  // quoting and went out (after header-level CRLF sanitization) as an
  // unquoted phrase containing ';' — a spec-invalid To header that Gmail
  // rejects opaquely or downstream clients misparse.
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["Ops Team;\nOn-call <oncall@example.com>"],
      subject: "s",
      body: "b",
    })
  );
  assert.ok(
    mime.split("\r\n").includes('To: "Ops Team; On-call" <oncall@example.com>'),
    `To header must be a quoted single-line phrase; got:\n${mime.split("\r\n").find((l) => l.startsWith("To:"))}`
  );
});

// --------------------------------------------------------------------------
// resolveAttachments — zero-byte inline attachments  (round-5)
// --------------------------------------------------------------------------
test("resolveAttachments accepts a zero-byte content_base64 attachment (round-5)", () => {
  // "" is the base64 of an empty file — a legal attachment. Truthiness checks
  // used to reject it with a factually wrong "provide exactly one of" error.
  const [att] = resolveAttachments([{ content_base64: "", filename: "empty.txt" }]);
  assert.equal(att.contentBase64, "");
  assert.equal(att.filename, "empty.txt");
  // The exactly-one rule is still enforced on real violations.
  assert.throws(() => resolveAttachments([{ filename: "x.txt" }]), /exactly one/);
  assert.throws(
    () => resolveAttachments([{ path: "p", content_base64: "", filename: "x.txt" }]),
    /exactly one/
  );
});

// --------------------------------------------------------------------------
// withRetry — Retry-After honoring  (round-5)
// --------------------------------------------------------------------------
test("withRetry honors a delta-seconds Retry-After larger than the backoff (Headers shape) (round-5)", async () => {
  const err = Object.assign(new Error("rate limited"), {
    response: {
      status: 429,
      headers: { get: (n) => (n === "retry-after" ? "1" : null) },
    },
  });
  let calls = 0;
  const t0 = Date.now();
  const out = await withRetry(
    () => {
      calls += 1;
      if (calls === 1) throw err;
      return Promise.resolve("ok");
    },
    { retries: 1, baseDelayMs: 1 }
  );
  const elapsed = Date.now() - t0;
  assert.equal(out, "ok");
  assert.equal(calls, 2);
  // Backoff alone would be ~2ms; the mandated wait is 1000ms.
  assert.ok(elapsed >= 900, `waited ${elapsed}ms; expected the ~1s mandated wait`);
});

test("withRetry caps a hostile/huge Retry-After (plain-object header shape) (round-5)", async () => {
  const err = Object.assign(new Error("unavailable"), {
    response: { status: 503, headers: { "retry-after": "3600" } },
  });
  let calls = 0;
  const t0 = Date.now();
  const out = await withRetry(
    () => {
      calls += 1;
      if (calls === 1) throw err;
      return Promise.resolve("ok");
    },
    { retries: 1, baseDelayMs: 1, retryAfterCapMs: 50 }
  );
  const elapsed = Date.now() - t0;
  assert.equal(out, "ok");
  // Two-sided bound: the lower edge proves the lowercase plain-object header
  // was actually PARSED and honored-then-capped (~50ms). Without it this test
  // passed identically when the header lookup was dropped entirely (a ~2ms
  // pure-backoff wait also satisfies `< 2000`) — a vacuous guard (round-6).
  assert.ok(elapsed >= 40, `waited only ${elapsed}ms; Retry-After was not parsed`);
  // An uncapped wait would be an hour; the cap bounds it to ~50ms.
  assert.ok(elapsed < 2000, `capped wait took ${elapsed}ms; expected ~50ms`);
});

test("withRetry honors an HTTP-date Retry-After (capital-case plain key) (round-5)", async () => {
  // toUTCString truncates milliseconds, so give it 2s of slack and assert
  // against a comfortably smaller bound to stay clock-jitter-proof.
  const date = new Date(Date.now() + 2000).toUTCString();
  const err = Object.assign(new Error("rate limited"), {
    response: { status: 429, headers: { "Retry-After": date } },
  });
  let calls = 0;
  const t0 = Date.now();
  await withRetry(
    () => {
      calls += 1;
      if (calls === 1) throw err;
      return Promise.resolve("ok");
    },
    { retries: 1, baseDelayMs: 1 }
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 800, `waited ${elapsed}ms; expected most of the ~1-2s mandated wait`);
});

// --------------------------------------------------------------------------
// Attachment fetching — listAttachments / sanitizeAttachmentFilename /
// saveAttachment  (attachment-download feature)
// --------------------------------------------------------------------------
test("listAttachments walks nested multiparts but never descends into an attachment's subtree", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("hi"), size: 2 } },
          { mimeType: "text/html", body: { data: b64url("<p>hi</p>"), size: 9 } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "report.pdf",
        body: { attachmentId: "A1", size: 111 },
      },
      {
        // A forwarded message attachment is ONE attachment; its inner parts
        // (including their own attachments) must not be enumerated.
        mimeType: "message/rfc822",
        filename: "fwd.eml",
        body: { attachmentId: "A2", size: 222 },
        parts: [
          {
            mimeType: "application/zip",
            filename: "inner.zip",
            body: { attachmentId: "INNER", size: 999 },
          },
        ],
      },
      {
        // Apple-Mail style: inline disposition but carries a filename.
        mimeType: "image/png",
        filename: "logo.png",
        headers: [{ name: "Content-Disposition", value: 'inline; filename="logo.png"' }],
        body: { attachmentId: "A3", size: 333 },
      },
      {
        // No attachmentId (bytes embedded in payload) — unfetchable, skipped.
        mimeType: "text/calendar",
        filename: "invite.ics",
        body: { data: b64url("BEGIN:VCALENDAR"), size: 15 },
      },
    ],
  };
  assert.deepEqual(listAttachments(payload).map((a) => a.attachment_id), ["A1", "A2", "A3"]);
  assert.deepEqual(listAttachments(payload)[0], {
    attachment_id: "A1",
    filename: "report.pdf",
    mime_type: "application/pdf",
    size: 111,
  });
  assert.deepEqual(listAttachments(undefined), []);
});

test("sanitizeAttachmentFilename strips traversal, control chars, and reserved characters", () => {
  assert.equal(sanitizeAttachmentFilename("../../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachmentFilename("..\\..\\evil.exe"), "evil.exe");
  assert.equal(sanitizeAttachmentFilename("C:\\Users\\x\\doc.pdf"), "doc.pdf");
  assert.equal(sanitizeAttachmentFilename("re:port|v2?.pdf"), "re_port_v2_.pdf");
  assert.equal(sanitizeAttachmentFilename("bad \r\nname.txt"), "bad __name.txt");
  assert.equal(sanitizeAttachmentFilename(""), "attachment");
  assert.equal(sanitizeAttachmentFilename(".."), "attachment");
  assert.equal(sanitizeAttachmentFilename("normal name (1).pdf"), "normal name (1).pdf");
  assert.equal(sanitizeAttachmentFilename("日本語レポート.pdf"), "日本語レポート.pdf");
});

test("saveAttachment requires the allowlist, saves inside it, and uniquifies collisions", () => {
  const prev = process.env.GMAIL_MCP_ATTACHMENTS_DIR;
  delete process.env.GMAIL_MCP_ATTACHMENTS_DIR;
  try {
    assert.throws(
      () => saveAttachment(Buffer.from("x"), "a.txt"),
      /GMAIL_MCP_ATTACHMENTS_DIR/,
      "saving without an allowlist must fail with an actionable error"
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-save-"));
    process.env.GMAIL_MCP_ATTACHMENTS_DIR = dir;
    try {
      const p1 = saveAttachment(Buffer.from("one"), "report.pdf");
      const p2 = saveAttachment(Buffer.from("two"), "report.pdf");
      const p3 = saveAttachment(Buffer.from("three"), "report.pdf");
      assert.equal(path.dirname(p1), dir);
      assert.equal(path.basename(p1), "report.pdf");
      assert.equal(path.basename(p2), "report (1).pdf");
      assert.equal(path.basename(p3), "report (2).pdf");
      assert.equal(fs.readFileSync(p1, "utf-8"), "one", "collision must not overwrite");
      assert.equal(fs.readFileSync(p2, "utf-8"), "two");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env.GMAIL_MCP_ATTACHMENTS_DIR;
    else process.env.GMAIL_MCP_ATTACHMENTS_DIR = prev;
  }
});
