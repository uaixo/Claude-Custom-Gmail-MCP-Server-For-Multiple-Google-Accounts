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
  buildReplyHeaders,
  summarizeThread,
  buildRawMessage,
  handleGmailError,
  resolveAttachments,
  decodeBase64Url,
  capMessageBodies,
  deriveReplySubject,
  requireField,
  renderJsonText,
  jsonTooLargeNotice,
  withRetry,
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

test("buildRawMessage folds a long non-ASCII filename and round-trips it (#M1)", () => {
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
  // No physical line may exceed RFC 5322's 998-octet hard limit.
  for (const line of mime.split("\r\n")) {
    assert.ok(
      Buffer.byteLength(line, "utf-8") <= 998,
      `line exceeds 998 octets (${Buffer.byteLength(line, "utf-8")})`
    );
  }
  // The percent-encoded value (no spaces, so never folded internally) decodes
  // back to the original filename.
  const m = mime.match(/filename\*=UTF-8''([A-Za-z0-9%.\-_]+)/);
  assert.ok(m, "filename* parameter present");
  assert.equal(decodeURIComponent(m[1]), filename);
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
