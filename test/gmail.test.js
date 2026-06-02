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
} from "../dist/gmail.js";
import { packageVersion } from "../dist/constants.js";

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
  const out = await summarizeThread(gmail, { id: "t2", snippet: "fallback" });
  assert.equal(out.thread_id, "t2"); // still identified from the list result
  assert.equal(out.snippet, "fallback"); // falls back to the list snippet
  assert.equal(out.subject, "");
  assert.match(out.error, /Rate limit/);
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
  const out = await mapWithConcurrency(threads, 5, (t) => summarizeThread(gmail, t));
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

test("buildRawMessage keeps a short non-ASCII filename as a single encoded-word", () => {
  const mime = decodeBase64Url(
    buildRawMessage({
      to: ["a@b.com"],
      subject: "s",
      body: "b",
      attachments: [
        { filename: "résumé.pdf", mimeType: "application/pdf", contentBase64: "QQ==" },
      ],
    })
  );
  const distinct = new Set(mime.match(/=\?UTF-8\?B\?[^?]*\?=/g));
  assert.equal(distinct.size, 1, "filename should be exactly one encoded-word");
  assert.ok(
    !distinct.values().next().value.includes(" "),
    "the filename encoded-word must not contain a space"
  );
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
