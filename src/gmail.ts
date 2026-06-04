import fs from "fs";
import path from "path";
import { google, gmail_v1 } from "googleapis";
import { getAuthedClient, loadTokens, resolveAccount } from "./auth.js";
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
  // Load the token store once and reuse it for both resolution and client
  // lookup, rather than reading/parsing tokens.json twice per tool call.
  const store = loadTokens();
  const resolved = resolveAccount(account, store);
  const auth = getAuthedClient(resolved, store);
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

/** Lightweight per-thread summary returned by a search. */
export interface ThreadSummary {
  thread_id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  /** Set only when this thread's details couldn't be fetched. */
  error?: string;
}

/**
 * Fetch lightweight metadata (first message's Subject/From/Date) for one thread
 * in a search result. A per-thread failure — a transient 429/5xx, or a thread
 * deleted between the list and this get — is captured as an `error` field on a
 * degraded entry rather than thrown, so one bad thread doesn't sink the whole
 * search. Falls back to the list snippet when the full fetch is unavailable.
 */
export async function summarizeThread(
  gmail: gmail_v1.Gmail,
  thread: gmail_v1.Schema$Thread
): Promise<ThreadSummary> {
  const threadId = thread.id || "";
  try {
    const id = requireField(thread.id, "thread.id");
    const full = await gmail.users.threads.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date"],
    });
    const first = full.data.messages?.[0];
    return {
      thread_id: id,
      subject: header(first?.payload, "Subject"),
      from: header(first?.payload, "From"),
      date: header(first?.payload, "Date"),
      snippet: first?.snippet || thread.snippet || "",
    };
  } catch (error) {
    return {
      thread_id: threadId,
      subject: "",
      from: "",
      date: "",
      snippet: thread.snippet || "",
      error: handleGmailError(error),
    };
  }
}

/**
 * Combine an explicit In-Reply-To with a thread's derived reply headers into a
 * consistent pair for buildRawMessage. RFC 5322 threading is only well-formed
 * when the References chain ends with the In-Reply-To message id, so this
 * guarantees that: an explicit `explicitInReplyTo` (e.g. the caller's
 * `in_reply_to`) wins as In-Reply-To, and the References chain is made to
 * terminate with it.
 *
 * When In-Reply-To is found within the thread chain, the chain is *truncated*
 * at that message (keeping the ancestor path up to and including it) — a reply
 * to message N shouldn't list messages that came after N as its ancestors. When
 * it isn't in the chain (e.g. a caller-supplied id), it's appended so References
 * still terminates with it. Fields are undefined when there's nothing to thread
 * on.
 */
export function buildReplyHeaders(
  reply: ThreadReplyHeaders | undefined,
  explicitInReplyTo?: string
): { inReplyTo?: string; references?: string } {
  const inReplyTo = explicitInReplyTo || reply?.inReplyTo || "";
  let references = reply?.references || "";
  if (inReplyTo) {
    const ids = references ? references.split(/\s+/).filter(Boolean) : [];
    const at = ids.lastIndexOf(inReplyTo);
    references =
      at !== -1
        ? ids.slice(0, at + 1).join(" ") // truncate at the answered message
        : [...ids, inReplyTo].join(" "); // not present → append to terminate
  }
  return {
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
  };
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

/** The handful of named HTML entities that commonly appear in email bodies. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** String.fromCodePoint, but yields "" instead of throwing on an invalid code point. */
function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ""; // out of range (> 0x10FFFF) or otherwise invalid — drop it
  }
}

/**
 * Decode the handful of HTML entities that commonly appear in email bodies. A
 * single left-to-right pass (rather than chained .replace() calls) avoids
 * double-decoding: e.g. "&amp;lt;" decodes to the literal "&lt;", not "<",
 * because scanning resumes after each match instead of re-reading the "&".
 * Numeric references are bounds-checked so a malformed value can't throw.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi,
    (match, body: string) => {
      const b = body.toLowerCase();
      if (b[0] === "#") {
        const code =
          b[1] === "x" ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
        return Number.isNaN(code) ? match : safeFromCodePoint(code);
      }
      return NAMED_ENTITIES[b] ?? match;
    }
  );
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
      // Drop the document head (title, meta, etc.) so its non-visible text
      // doesn't leak into the body. A stray <title> outside <head> is handled
      // too. Like the style/script passes below, fall back to end-of-input when
      // the closing tag is missing (truncated/malformed email) so an unclosed
      // head can't leak. The \b stops <head>/<title> from matching <header>,
      // <headline>, etc. — without it the "$" fallback would eat a visible
      // <header> and everything after it to EOF.
      .replace(/<head\b[\s\S]*?(?:<\/head>|$)/gi, "")
      .replace(/<title\b[\s\S]*?(?:<\/title>|$)/gi, "")
      // Match the closing tag, but fall back to end-of-input when it's missing
      // (a truncated/malformed email), so an unclosed block can't leak its
      // CSS/JS text into the body.
      .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, "")
      .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n")
      // Strip only genuine markup: a '<' that opens a start tag (letter), end
      // tag ('/'), declaration ('!', e.g. <!DOCTYPE>), or processing
      // instruction ('?'). A '<' followed by anything else — a space or digit,
      // as in "3 < 5 and 5 > 3" — is literal body text and is left intact,
      // where the old catch-all /<[^>]+>/ would have eaten "< 5 and 5 >" as a
      // bogus tag. A lone '>' has no matching opener and likewise survives.
      .replace(/<[/!?a-zA-Z][^>]*>/g, "")
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
      // Only read regular files: a directory, FIFO, socket, or device inside an
      // allowed dir is not a valid attachment (and reading a FIFO could block
      // the server indefinitely). statSync follows to the resolved real path.
      if (!fs.statSync(resolved).isFile()) {
        throw new Error(`Attachment ${i}: '${filePath}' is not a regular file.`);
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
    // Two checks: every character must be in the base64 alphabet, and the
    // length must be possible. Stripped of padding, a base64 string's length is
    // never ≡ 1 (mod 4) — a lone trailing 6-bit group can't exist. Node's
    // decoder is lenient and would silently drop that orphan group rather than
    // flag it, so we reject it here. (Padding is optional because base64url
    // inputs arrive unpadded; we re-pad canonically on re-encode below.)
    const unpadded = cleaned.replace(/=+$/, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || unpadded.length % 4 === 1) {
      throw new Error(`Attachment ${i}: 'content_base64' is not valid base64.`);
    }
    const contentBase64 = Buffer.from(cleaned, "base64").toString("base64");
    return { filename: a.filename, mimeType, contentBase64 };
  });
}

/** True when every character of `value` is in the ASCII range (≤ U+007F). */
function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
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
  // Pure-ASCII values need no encoding. Checked by code unit rather than a
  // control-char regex so the function carries no lint-suppression baggage.
  if (isAscii(value)) return value;
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
 * True when a filename is safe to place verbatim inside a quoted MIME parameter
 * (`name="…"` / `filename="…"`): pure ASCII with no control characters, double
 * quote, or backslash — i.e. nothing that could terminate or escape the quoted
 * string (and so inject a header). Anything else is emitted as an RFC 2231
 * extended parameter instead. Checked by code unit (no control-char regex) so
 * the function carries no lint-suppression baggage.
 */
function isQuotableFilename(name: string): boolean {
  if (!isAscii(name)) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x22 /* " */ || c === 0x5c /* \ */) return false;
  }
  return true;
}

/**
 * Percent-encode a string as an RFC 2231 / RFC 5987 extended-parameter value
 * (the part after `UTF-8''`). Every byte outside the RFC 5987 `attr-char` set
 * is encoded as %XX of its UTF-8 representation. This lets non-ASCII filenames
 * survive without the RFC 2047 encoded-words that RFC 2047 §5 forbids inside a
 * quoted parameter (and that some clients render literally).
 */
function encodeRfc2231(value: string): string {
  let out = "";
  for (const b of Buffer.from(value, "utf-8")) {
    // RFC 5987 attr-char: ALPHA / DIGIT / "!#$&+-.^_`|~"
    const isAttrChar =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x21 ||
      b === 0x23 ||
      b === 0x24 ||
      b === 0x26 ||
      b === 0x2b ||
      b === 0x2d ||
      b === 0x2e ||
      b === 0x5e ||
      b === 0x5f ||
      b === 0x60 ||
      b === 0x7c ||
      b === 0x7e;
    out += isAttrChar
      ? String.fromCharCode(b)
      : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Build a MIME header line carrying a filename parameter, choosing the encoding
 * per RFC 2231: a quote-safe ASCII filename uses the simple quoted form
 * (`filename="report.pdf"`); anything non-ASCII or containing quoting-breaking
 * characters uses an RFC 2231 extended parameter (`filename*=UTF-8''…`), which
 * is the standards-conformant way to carry such names (RFC 2047 encoded-words
 * are illegal inside a quoted string). Either way CR/LF can't survive — the
 * quoted form is gated by isQuotableFilename, and the extended form is
 * percent-encoded — so neither can inject a header.
 */
function mimeHeaderWithFilename(
  prefix: string,
  paramName: string,
  filename: string
): string {
  return isQuotableFilename(filename)
    ? `${prefix}; ${paramName}="${filename}"`
    : `${prefix}; ${paramName}*=UTF-8''${encodeRfc2231(filename)}`;
}

/**
 * Fold a header line so no line exceeds 78 octets (RFC 5322 recommends ≤78; the
 * hard limit is 998). Length is measured in UTF-8 octets, not characters, so a
 * line of multi-byte content is still bounded correctly. Folds only at existing
 * spaces — inserting a CRLF before a space, which then serves as the
 * continuation line's indent — so unfolding restores the value byte-for-byte,
 * and the break point (an ASCII space) is never inside a multi-byte sequence.
 * This keeps long recipient lists, References chains, and multi-word encoded
 * subjects within spec; a single token longer than the limit (e.g. one very
 * long address) is left intact rather than broken.
 */
function foldHeaderLine(line: string): string {
  const LIMIT = 78; // octets
  if (Buffer.byteLength(line, "utf-8") <= LIMIT) return line;
  const segments: string[] = [];
  let segStart = 0; // index where the current output segment begins
  let lastSpace = -1; // index of the last space seen within the current segment
  let bytes = 0; // octets accumulated in the current segment so far
  for (let i = 0; i < line.length; i++) {
    const charBytes = Buffer.byteLength(line[i], "utf-8");
    if (bytes + charBytes > LIMIT && lastSpace > segStart) {
      // Fold at the last space: it becomes the next line's leading indent.
      segments.push(line.slice(segStart, lastSpace));
      segStart = lastSpace;
      lastSpace = -1;
      // Recount octets for the new segment (leading space through char i).
      bytes = Buffer.byteLength(line.slice(segStart, i + 1), "utf-8");
    } else {
      bytes += charBytes;
    }
    if (line[i] === " ") lastSpace = i;
  }
  segments.push(line.slice(segStart));
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
    const safeMime = sanitizeHeaderValue(att.mimeType);
    // Fold each part header so a long (e.g. non-ASCII, percent-encoded) filename
    // can't produce an over-length line, just like the top-level headers above.
    const partHeaders = [
      mimeHeaderWithFilename(`Content-Type: ${safeMime}`, "name", att.filename),
      "Content-Transfer-Encoding: base64",
      mimeHeaderWithFilename(
        "Content-Disposition: attachment",
        "filename",
        att.filename
      ),
    ].map(foldHeaderLine);
    parts.push(
      [`--${boundary}`, ...partHeaders, "", wrapBase64(att.contentBase64)].join(
        "\r\n"
      )
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
    code?: number | string;
    status?: number;
    message?: string;
    response?: {
      status?: number;
      data?: { error?: { message?: string; errors?: Array<{ message?: string }> } };
    };
    errors?: Array<{ message?: string }>;
  };
  // The HTTP status, wherever the client surfaced it. Modern gaxios sets a
  // numeric `error.status` (or `error.response.status`) for HTTP errors and
  // leaves `error.code` for transport-level failures (a string like
  // "ENOTFOUND"); older shapes put the numeric status on `code`. Cover all
  // three, but only treat a *number* as an HTTP status.
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.response?.status === "number"
        ? e.response.status
        : typeof e?.code === "number"
          ? e.code
          : undefined;
  // Prefer Gmail's structured error detail (it lives under response.data.error
  // for a real API error); fall back to the error message.
  const detail =
    e?.response?.data?.error?.errors?.[0]?.message ||
    e?.response?.data?.error?.message ||
    e?.errors?.[0]?.message ||
    e?.message ||
    String(error);
  switch (status) {
    case 401:
      return "Error: Authentication failed or token expired. Re-run `npm run add-account` for this account.";
    case 403:
      return `Error: Permission denied. The account may not have granted the required scope. (${detail})`;
    case 404:
      return "Error: Resource not found. Check the message/thread/label ID.";
    case 429:
      return "Error: Rate limit exceeded. Wait before retrying.";
  }
  if (status) return `Error: Gmail API request failed (status ${status}): ${detail}`;
  // No HTTP status. A string `code` is a transport/system error (DNS failure,
  // connection reset, timeout) — report it as such rather than as an API
  // rejection. Otherwise it's a local error (e.g. attachment validation).
  if (typeof e?.code === "string") {
    return `Error: Network error (${e.code}) reaching Gmail. Check connectivity and retry. (${detail})`;
  }
  return `Error: ${detail}`;
}

/**
 * Render a structured result as pretty JSON for the text channel without ever
 * emitting *invalid* JSON. Slicing a serialized object mid-string (the old
 * behavior) produced unparseable text; when the JSON would exceed the character
 * budget we instead return a short plain-text notice pointing at
 * structuredContent, which always carries the authoritative, complete result.
 */
export function renderJsonText(value: unknown, note: string): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= CHARACTER_LIMIT) return json;
  return (
    `[Result too large to render as text (${json.length} characters); the ` +
    `complete result is available in structuredContent. ${note}]`
  );
}

/**
 * Bound the combined size of message bodies so structuredContent (and its text
 * rendering) can't balloon on a long thread. Bodies are produced in order by
 * `renderBody` until the budget is spent; the body that crosses the budget is
 * truncated and any later bodies are omitted with a marker.
 *
 * `renderBody` is invoked lazily — only while budget remains — so the (possibly
 * expensive) decode/HTML-stripping of bodies that would be omitted is skipped
 * entirely. Each result item is the input augmented with its final `body`.
 */
export function capMessageBodies<T>(
  items: T[],
  budget: number,
  renderBody: (item: T) => string
): { messages: Array<T & { body: string }>; truncated: boolean } {
  let remaining = budget;
  let truncated = false;
  const messages = items.map((item) => {
    if (remaining <= 0) {
      // Budget already spent — omit without rendering (the point of laziness).
      truncated = true;
      return { ...item, body: "[Body omitted: thread exceeds size limit]" };
    }
    const body = renderBody(item);
    if (body.length > remaining) {
      truncated = true;
      const trimmed =
        body.slice(0, remaining) + "\n[Body truncated: thread exceeds size limit]";
      remaining = 0;
      return { ...item, body: trimmed };
    }
    remaining -= body.length;
    return { ...item, body };
  });
  return { messages, truncated };
}
