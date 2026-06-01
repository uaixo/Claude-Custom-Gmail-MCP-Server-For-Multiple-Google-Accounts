import fs from "fs";
import path from "path";
import { google, gmail_v1 } from "googleapis";
import { getAuthedClient, resolveAccount } from "./auth.js";
import { attachmentDirs, CHARACTER_LIMIT, MAX_MESSAGE_BYTES } from "./constants.js";

/**
 * Map over items running at most `limit` operations concurrently, preserving
 * input order in the results. Used to fan out per-thread metadata fetches
 * without issuing every request at once (which can trip rate limits).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Build a Gmail API client for a resolved account. */
export function gmailFor(account?: string): {
  gmail: gmail_v1.Gmail;
  account: string;
} {
  const resolved = resolveAccount(account);
  const auth = getAuthedClient(resolved);
  const gmail = google.gmail({ version: "v1", auth });
  return { gmail, account: resolved };
}

/**
 * Decode a base64url-encoded body to a string. Gmail returns part bytes in the
 * part's original charset (it does not transcode to UTF-8), so honor the
 * Content-Type charset when one is supplied. ASCII/UTF-8 take a fast path;
 * legacy charsets (windows-1252, iso-8859-*, shift_jis, ...) go through
 * TextDecoder. An unknown/unsupported label falls back to UTF-8 rather than
 * throwing, so a body is always returned.
 */
export function decodeBase64Url(data: string, charset = "utf-8"): string {
  const buf = Buffer.from(data, "base64url");
  const label = charset.trim().toLowerCase();
  if (
    label === "" ||
    label === "utf-8" ||
    label === "utf8" ||
    label === "us-ascii" ||
    label === "ascii"
  ) {
    return buf.toString("utf-8");
  }
  try {
    // TextDecoder is ICU-backed (Node 18+ ships full ICU); fatal:false (default)
    // maps malformed bytes to U+FFFD instead of throwing.
    return new TextDecoder(label).decode(buf);
  } catch {
    // Unknown/unsupported charset label — fall back to UTF-8.
    return buf.toString("utf-8");
  }
}

/** Encode a UTF-8 string to base64url (RFC 4648, no padding). */
export function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf-8").toString("base64url");
}

/** Pull a header value (case-insensitive) from a message part. */
export function header(
  payload: gmail_v1.Schema$MessagePart | undefined,
  name: string
): string {
  const headers = payload?.headers || [];
  const found = headers.find(
    (h) => (h.name || "").toLowerCase() === name.toLowerCase()
  );
  return found?.value || "";
}

/**
 * Threading headers for replying into an existing thread, derived from its
 * last message: the Message-ID to use as In-Reply-To, the accumulated
 * References chain, and the thread's subject. Fields are empty strings when the
 * corresponding header can't be read.
 */
export interface ThreadReplyHeaders {
  inReplyTo: string;
  references: string;
  subject: string;
}

/**
 * Fetch the headers needed to reply within an existing thread. Gmail only
 * threads a sent/drafted message when it references the thread via
 * In-Reply-To/References (or a matching Subject), so callers that pass a
 * thread_id must supply these. We reference the thread's most recent message
 * and append it to that message's existing References chain.
 */
export async function getThreadReplyHeaders(
  gmail: gmail_v1.Gmail,
  threadId: string
): Promise<ThreadReplyHeaders> {
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["Message-ID", "References", "Subject"],
  });
  const messages = res.data.messages || [];
  const last = messages[messages.length - 1];
  const messageId = header(last?.payload, "Message-ID");
  const priorReferences = header(last?.payload, "References");
  const subject = header(messages[0]?.payload, "Subject");
  const references = [priorReferences, messageId].filter(Boolean).join(" ");
  return { inReplyTo: messageId, references, subject };
}

/**
 * Choose the subject line for a (possibly reply) message. An explicit subject
 * always wins. When it's omitted and we're replying into a thread, fall back to
 * the thread's subject, prefixing "Re: " unless it already has one. Returns ""
 * when there's nothing to derive from (Gmail shows that as "(no subject)").
 */
export function deriveReplySubject(
  explicit: string | undefined,
  threadSubject: string | undefined
): string {
  if (explicit !== undefined) return explicit;
  const base = (threadSubject || "").trim();
  if (!base) return "";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/**
 * True when a message part is an attachment rather than body content. Body
 * extraction must skip these: an HTML-only email that also carries a text/plain
 * or text/html attachment (e.g. a .csv or .txt) would otherwise have the
 * attachment's bytes returned as the message body. A part counts as an
 * attachment when its Content-Disposition is "attachment", or when it has a
 * filename and isn't explicitly "inline".
 */
function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
  const disposition = header(part, "Content-Disposition").trim().toLowerCase();
  if (disposition.startsWith("attachment")) return true;
  if (disposition.startsWith("inline")) return false;
  return !!part.filename;
}

/** Extract the charset from a part's Content-Type header, if one is declared. */
function partCharset(
  part: gmail_v1.Schema$MessagePart | undefined
): string | undefined {
  const ct = header(part, "Content-Type");
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  return m?.[1];
}

/** Recursively return the first non-attachment part body matching a MIME type. */
function findPartBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string
): string {
  if (!payload) return "";
  // Don't read an attachment's body, and don't descend into it (e.g. a
  // forwarded message/rfc822 part): its contents aren't this message's body.
  if (isAttachmentPart(payload)) return "";
  if (payload.mimeType === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data, partCharset(payload));
  }
  for (const part of payload.parts || []) {
    const found = findPartBody(part, mimeType);
    if (found) return found;
  }
  return "";
}

/** Decode the handful of HTML entities that commonly appear in email bodies. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Strip an HTML email body down to readable plain text. Drops style/script
 * blocks, turns block-level closes and <br> into newlines, removes remaining
 * tags, decodes common entities, and collapses excess blank lines. This is a
 * best-effort fallback for messages with no text/plain part — not a full
 * HTML-to-text renderer.
 */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      // Strip comments first: a comment can contain '>' (e.g. "<!-- a > b -->"),
      // which the generic tag pass below would only partially remove.
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract a readable plain-text body from a message payload. Prefers a
 * text/plain part anywhere in the MIME tree; if none exists, falls back to the
 * first text/html part stripped to text via htmlToText. Returns "" when no
 * textual body is found.
 */
export function extractPlainText(
  payload: gmail_v1.Schema$MessagePart | undefined
): string {
  if (!payload) return "";
  const plain = findPartBody(payload, "text/plain");
  if (plain) return plain;
  const html = findPartBody(payload, "text/html");
  if (html) return htmlToText(html);
  return "";
}

/** A resolved attachment ready to be embedded in a MIME message. */
export interface ResolvedAttachment {
  filename: string;
  mimeType: string;
  /** Standard base64 (not base64url) content. */
  contentBase64: string;
}

/** Minimal extension → MIME type map for inferring attachment types. */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ics": "text/calendar",
};

/** Infer a MIME type from a filename's extension. */
export function inferMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** A loosely-typed attachment input from a tool call (path OR inline base64). */
export interface AttachmentInput {
  filename?: string;
  path?: string;
  content_base64?: string;
  mime_type?: string;
}

/**
 * Resolve tool-supplied attachments into base64 payloads. Each attachment must
 * provide exactly one of `path` (read from local disk) or `content_base64`
 * (inline). Throws an Error with an actionable message on bad input.
 */
export function resolveAttachments(
  inputs: AttachmentInput[] | undefined
): ResolvedAttachment[] {
  if (!inputs?.length) return [];
  return inputs.map((a, i) => {
    const hasPath = !!a.path;
    const hasInline = !!a.content_base64;
    if (hasPath === hasInline) {
      throw new Error(
        `Attachment ${i}: provide exactly one of 'path' or 'content_base64'.`
      );
    }
    if (hasPath) {
      const filePath = a.path!;
      const allowedDirs = attachmentDirs();
      if (allowedDirs.length === 0) {
        throw new Error(
          `Attachment ${i}: reading local files by 'path' is disabled. Set ` +
            `GMAIL_MCP_ATTACHMENTS_DIR to one or more allowed directories, or ` +
            `supply the file inline via 'content_base64'.`
        );
      }
      if (!fs.existsSync(filePath)) {
        throw new Error(`Attachment ${i}: file not found at '${filePath}'.`);
      }
      // Resolve symlinks and "../" before checking containment so the file
      // can't escape the allowed directories.
      const resolved = fs.realpathSync(filePath);
      const allowed = allowedDirs.some((dir) => {
        let realDir: string;
        try {
          realDir = fs.realpathSync(dir);
        } catch {
          return false; // configured dir doesn't exist; it can't contain the file
        }
        return resolved === realDir || resolved.startsWith(realDir + path.sep);
      });
      if (!allowed) {
        throw new Error(
          `Attachment ${i}: '${filePath}' is outside the allowed attachment ` +
            `directories (GMAIL_MCP_ATTACHMENTS_DIR). Refusing to read it.`
        );
      }
      const filename = a.filename || path.basename(filePath);
      const mimeType = a.mime_type || inferMimeType(filename);
      const contentBase64 = fs.readFileSync(resolved).toString("base64");
      return { filename, mimeType, contentBase64 };
    }
    // Inline base64.
    if (!a.filename) {
      throw new Error(
        `Attachment ${i}: 'filename' is required when using 'content_base64'.`
      );
    }
    const mimeType = a.mime_type || inferMimeType(a.filename);
    // Validate, and normalize base64url -> standard base64, so we never embed a
    // silently-corrupt attachment. Buffer.from is lenient (it drops invalid
    // chars), so the regex is what actually rejects garbage; re-encoding the
    // decoded bytes yields canonical padding for the wire.
    const cleaned = a
      .content_base64!.replace(/\s+/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw new Error(`Attachment ${i}: 'content_base64' is not valid base64.`);
    }
    const contentBase64 = Buffer.from(cleaned, "base64").toString("base64");
    return { filename: a.filename, mimeType, contentBase64 };
  });
}

/**
 * Cap each encoded-word at 45 UTF-8 bytes: base64 of 45 bytes is 60 chars, and
 * with the `=?UTF-8?B?` ... `?=` overhead (12 chars) that's 72 — within RFC
 * 2047's 75-char-per-encoded-word limit.
 */
const MAX_ENCODED_WORD_BYTES = 45;

/**
 * RFC 2047 base64-encode a header value so non-ASCII survives. A long value is
 * split into multiple encoded-words (each within the 75-char limit), broken on
 * code-point boundaries so a multi-byte character is never split across words.
 * Adjacent encoded-words are space-separated; decoders concatenate them and
 * ignore the separating whitespace. Pure-ASCII values are returned unchanged so
 * plain subjects stay readable on the wire.
 */
function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  const flush = () => {
    if (chunk === "") return;
    words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf-8").toString("base64")}?=`);
    chunk = "";
    chunkBytes = 0;
  };
  for (const ch of value) {
    // for...of iterates by code point, so `ch` is never half a surrogate pair.
    const n = Buffer.byteLength(ch, "utf-8");
    if (chunkBytes + n > MAX_ENCODED_WORD_BYTES) flush();
    chunk += ch;
    chunkBytes += n;
  }
  flush();
  return words.join(" ");
}

/**
 * Remove CR/LF from a header value to prevent header injection. RFC 2822
 * headers are CRLF-delimited, so an embedded newline in a user-supplied value
 * (subject, recipients, message-id, mime type, ...) could otherwise inject
 * additional headers. CR/LF is collapsed to a space rather than rejected so a
 * value with a stray newline still sends.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * Sanitize a filename for use inside a quoted MIME parameter
 * (name="…" / filename="…"): strip CR/LF and neutralize the quote and backslash
 * characters that would otherwise terminate or escape the quoted string.
 * Non-ASCII still goes through RFC 2047 encoding via encodeHeaderWord.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n]+/g, " ").replace(/["\\]/g, "_");
}

/**
 * Fold a header line so no line exceeds 78 octets (RFC 5322 recommends ≤78; the
 * hard limit is 998). Folds only at existing spaces — inserting a CRLF before a
 * space, which then serves as the continuation line's indent — so unfolding
 * restores the value byte-for-byte. This keeps long recipient lists, References
 * chains, and multi-word encoded subjects within spec; a single token longer
 * than the limit (e.g. one very long address) is left intact rather than broken.
 */
function foldHeaderLine(line: string): string {
  const LIMIT = 78;
  if (line.length <= LIMIT) return line;
  const segments: string[] = [];
  let start = 0;
  while (line.length - start > LIMIT) {
    // Prefer the last space within the limit; otherwise the first space past it
    // (never break inside a token).
    let foldAt = -1;
    for (let i = Math.min(start + LIMIT, line.length - 1); i > start; i--) {
      if (line[i] === " ") {
        foldAt = i;
        break;
      }
    }
    if (foldAt === -1) {
      let i = start + LIMIT;
      while (i < line.length && line[i] !== " ") i++;
      if (i >= line.length) break; // no more fold points; emit the rest as-is
      foldAt = i;
    }
    segments.push(line.slice(start, foldAt));
    start = foldAt; // the space at foldAt becomes the next line's leading indent
  }
  segments.push(line.slice(start));
  return segments.join("\r\n");
}

/** Wrap a long base64 string into 76-char lines per RFC 2045. */
function wrapBase64(data: string): string {
  return data.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** Generate a unique MIME boundary token. */
function makeBoundary(tag: string): string {
  return `=_${tag}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
}

/**
 * Join the assembled message lines, enforce Gmail's message-size limit, and
 * base64url-encode for the API's `raw` field. Throws a clear error (rather than
 * letting the API reject opaquely) when the message — body plus base64-encoded
 * attachments — exceeds the limit.
 */
function finalizeMessage(lines: string[]): string {
  const message = lines.join("\r\n");
  const bytes = Buffer.byteLength(message, "utf-8");
  if (bytes > MAX_MESSAGE_BYTES) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Message is ${mb(bytes)} MB, exceeding Gmail's ${mb(
        MAX_MESSAGE_BYTES
      )} MB limit. Reduce the size or number of attachments (note base64 encoding adds ~33%).`
    );
  }
  return encodeBase64Url(message);
}

/**
 * Build a raw RFC 2822 message suitable for Gmail's `raw` field.
 *
 * Body can be plain text or HTML (`isHtml`). When attachments are present the
 * message is `multipart/mixed` (body part first, then each attachment);
 * otherwise it's a single text/plain or text/html part. Handles To/Cc/Bcc,
 * RFC 2047 subject encoding, and optional reply threading headers.
 */
export function buildRawMessage(opts: {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  attachments?: ResolvedAttachment[];
  inReplyTo?: string;
  references?: string;
}): string {
  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${sanitizeHeaderValue(opts.from)}`);
  headers.push(`To: ${sanitizeHeaderValue(opts.to.join(", "))}`);
  if (opts.cc?.length) headers.push(`Cc: ${sanitizeHeaderValue(opts.cc.join(", "))}`);
  // The Bcc header is how Gmail learns the blind recipients for a raw send; it
  // strips the header before delivery, so it is not leaked to To/Cc. Keep it.
  if (opts.bcc?.length)
    headers.push(`Bcc: ${sanitizeHeaderValue(opts.bcc.join(", "))}`);
  headers.push(`Subject: ${encodeHeaderWord(sanitizeHeaderValue(opts.subject))}`);
  if (opts.inReplyTo)
    headers.push(`In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}`);
  if (opts.references)
    headers.push(`References: ${sanitizeHeaderValue(opts.references)}`);
  headers.push("MIME-Version: 1.0");

  // Fold long header lines (recipient lists, References chains, multi-word
  // encoded subjects) to stay within RFC 5322's line-length limit.
  const foldedHeaders = headers.map(foldHeaderLine);

  const bodyContentType = opts.isHtml
    ? 'text/html; charset="UTF-8"'
    : 'text/plain; charset="UTF-8"';

  const attachments = opts.attachments || [];

  // Simple case: no attachments → single body part.
  if (attachments.length === 0) {
    const lines = [
      ...foldedHeaders,
      `Content-Type: ${bodyContentType}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(opts.body, "utf-8").toString("base64")),
    ];
    return finalizeMessage(lines);
  }

  // Multipart/mixed: body part, then one part per attachment.
  const boundary = makeBoundary("mix");
  const parts: string[] = [];

  parts.push(
    [
      `--${boundary}`,
      `Content-Type: ${bodyContentType}`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(opts.body, "utf-8").toString("base64")),
    ].join("\r\n")
  );

  for (const att of attachments) {
    const encodedName = encodeHeaderWord(sanitizeFilename(att.filename));
    const safeMime = sanitizeHeaderValue(att.mimeType);
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${safeMime}; name="${encodedName}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${encodedName}"`,
        "",
        wrapBase64(att.contentBase64),
      ].join("\r\n")
    );
  }

  const lines = [
    ...foldedHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    parts.join("\r\n"),
    `--${boundary}--`,
    "",
  ];
  return finalizeMessage(lines);
}

/**
 * Assert that a field the Gmail API is expected to return is actually present.
 * Gmail's generated types make ids/names `string | null | undefined`; rather
 * than scatter non-null assertions (`!`), which silently propagate a bad value,
 * fail fast with an actionable message that handleGmailError surfaces cleanly.
 */
export function requireField<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Gmail API response missing expected field: ${what}.`);
  }
  return value;
}

/** Format a Gmail API error into an actionable message. */
export function handleGmailError(error: unknown): string {
  const e = error as {
    code?: number;
    status?: number;
    message?: string;
    errors?: Array<{ message?: string }>;
  };
  const status = e?.code || e?.status;
  const detail = e?.errors?.[0]?.message || e?.message || String(error);
  switch (status) {
    case 401:
      return "Error: Authentication failed or token expired. Re-run `npm run add-account` for this account.";
    case 403:
      return `Error: Permission denied. The account may not have granted the required scope. (${detail})`;
    case 404:
      return "Error: Resource not found. Check the message/thread/label ID.";
    case 429:
      return "Error: Rate limit exceeded. Wait before retrying.";
    default:
      // A status means it came from the Gmail API; without one it's a local
      // error (e.g. attachment validation) and shouldn't claim an API failure.
      return status
        ? `Error: Gmail API request failed (status ${status}): ${detail}`
        : `Error: ${detail}`;
  }
}

/** Truncate an oversized text payload with a clear note. */
export function capText(text: string, note: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated at ${CHARACTER_LIMIT} characters. ${note}]`
  );
}

/**
 * Bound the combined size of message bodies so structuredContent (and its text
 * rendering) can't balloon on a long thread. Bodies are kept in order until the
 * budget is spent; the body that crosses the budget is truncated and any later
 * bodies are omitted, each with a marker. Returns the trimmed messages and
 * whether any truncation occurred.
 */
export function capMessageBodies<T extends { body: string }>(
  messages: T[],
  budget: number
): { messages: T[]; truncated: boolean } {
  let remaining = budget;
  let truncated = false;
  const out = messages.map((m) => {
    const body = m.body || "";
    if (remaining <= 0) {
      if (body) truncated = true;
      return { ...m, body: body ? "[Body omitted: thread exceeds size limit]" : "" };
    }
    if (body.length > remaining) {
      truncated = true;
      const trimmed =
        body.slice(0, remaining) + "\n[Body truncated: thread exceeds size limit]";
      remaining = 0;
      return { ...m, body: trimmed };
    }
    remaining -= body.length;
    return m;
  });
  return { messages: out, truncated };
}
