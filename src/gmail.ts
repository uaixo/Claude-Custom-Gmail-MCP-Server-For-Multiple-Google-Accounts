import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import type { gmail_v1 } from "@googleapis/gmail";
import { convert as htmlToTextConvert } from "html-to-text";
import { getAuthedClient, loadTokens, resolveAccount } from "./auth.js";
import {
  attachmentDirs,
  CHARACTER_LIMIT,
  gmailRequestTimeoutMs,
  MAX_MESSAGE_BYTES,
} from "./constants.js";

// @googleapis/gmail is CommonJS. Resolve it through createRequire (instead of a
// static ESM import) so each call reads the gmail() factory off the package's
// live exports object. That property is also the single seam the integration
// tests swap to inject a fake Gmail client (see test/index.test.js).
const gmailApi = createRequire(import.meta.url)(
  "@googleapis/gmail"
) as typeof import("@googleapis/gmail");

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
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      // i is in-bounds, so items[i] is present; the explicit guard satisfies
      // noUncheckedIndexedAccess without changing behavior for the dense arrays
      // this is called with.
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item, i);
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
  // Set a per-request timeout at the client level so it applies to every call
  // (it propagates through the Gmail client to gaxios/node-fetch). Without it a
  // hung socket would block the tool call until the OS TCP timeout.
  //
  // retry:false disables gaxios's built-in retry, which googleapis-common
  // force-enables (options.retry defaults to true) — that layer re-fires GETs
  // up to 3 times with fixed unjittered delays INSIDE each withRetry attempt,
  // multiplying to ~16 requests per failing idempotent call and stalling tool
  // calls for many seconds under throttling. withRetry is the sole retry
  // policy: bounded, jittered, idempotency-aware.
  const gmail = gmailApi.gmail({
    version: "v1",
    auth,
    timeout: gmailRequestTimeoutMs(),
    retry: false,
  });
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
  // threads.get returns unsent DRAFTs inline in messages[] (they carry the
  // DRAFT label — present in metadata format). Anchor the reply to the last
  // DELIVERED message: a draft's Message-ID was never delivered to anyone (and
  // may be regenerated on send), so recipients' clients can't resolve an
  // In-Reply-To that names it and display the reply unthreaded. This matters
  // for this server's own flows: create_draft(thread_id) followed by
  // send_message(thread_id) would otherwise anchor to the fresh draft.
  const delivered = messages.filter(
    (m) => !(m.labelIds || []).includes("DRAFT")
  );
  const last = delivered[delivered.length - 1];
  const messageId = header(last?.payload, "Message-ID");
  const priorReferences = header(last?.payload, "References");
  const subject = header((delivered[0] ?? messages[0])?.payload, "Subject");
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
 * in a search result. The per-thread fetch is retried (idempotent backoff via
 * withRetry) so a transient 429 — most likely *during* a concurrent fan-out — is
 * ridden out rather than degrading the entry. Only after retries are exhausted
 * (or for a non-retryable failure, e.g. a thread deleted between the list and
 * this get) is the failure captured as an `error` field on a degraded entry
 * rather than thrown, so one bad thread doesn't sink the whole search. Falls
 * back to the list snippet when the full fetch is unavailable. `retryOpts` lets
 * a caller (or test) tune the retry budget; it defaults to withRetry's defaults.
 */
/** Named entities the Gmail API uses when escaping snippet fields. */
const SNIPPET_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the HTML entity escapes the Gmail API applies to `snippet` fields
 * (&#39;, &amp;, &quot;, numeric references, ...). The API returns snippets
 * HTML-escaped — unlike bodies, which are decoded via html-to-text — so
 * without this, search results read "I&#39;ll send the numbers &amp; slides".
 * Single left-to-right pass, so double-escaped text decodes one level only.
 */
function decodeSnippet(snippet: string): string {
  return snippet.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, body: string) => {
      if (body.charAt(0) === "#") {
        const code =
          body.charAt(1).toLowerCase() === "x"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match; // surrogate-range code point — leave the text as-is
        }
      }
      return SNIPPET_ENTITIES[body.toLowerCase()] ?? match;
    }
  );
}

export async function summarizeThread(
  gmail: gmail_v1.Gmail,
  thread: gmail_v1.Schema$Thread,
  retryOpts?: { retries?: number; baseDelayMs?: number }
): Promise<ThreadSummary> {
  const threadId = thread.id || "";
  try {
    const id = requireField(thread.id, "thread.id");
    const full = await withRetry(
      () =>
        gmail.users.threads.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        }),
      retryOpts
    );
    const first = full.data.messages?.[0];
    return {
      thread_id: id,
      subject: header(first?.payload, "Subject"),
      from: header(first?.payload, "From"),
      date: header(first?.payload, "Date"),
      snippet: decodeSnippet(first?.snippet || thread.snippet || ""),
    };
  } catch (error) {
    return {
      thread_id: threadId,
      subject: "",
      from: "",
      date: "",
      snippet: decodeSnippet(thread.snippet || ""),
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
/**
 * Normalize a caller-supplied Message-ID to RFC 5322 msg-id form ("<...>").
 * Message-IDs are often displayed and copy-pasted without the angle brackets;
 * emitting the bare token verbatim produces syntactically invalid
 * In-Reply-To/References headers that receiving clients ignore (the reply then
 * displays unthreaded for them, invisibly to the sender).
 */
function normalizeMsgId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed
    : `<${trimmed}>`;
}

export function buildReplyHeaders(
  reply: ThreadReplyHeaders | undefined,
  explicitInReplyTo?: string
): { inReplyTo?: string; references?: string } {
  // Normalize only the caller-supplied id; thread-derived ids come from real
  // Message-ID headers and are already in msg-id form.
  const inReplyTo =
    normalizeMsgId(explicitInReplyTo || "") || reply?.inReplyTo || "";
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
 * attachment when its Content-Disposition is "attachment", or when it carries a
 * filename — regardless of an "inline" disposition: some senders (notably
 * Apple Mail) dispose attached files as `inline; filename="x.txt"`, and such a
 * file must not outrank the real body. A true body part carries no filename,
 * so a filename-less inline part is still treated as body.
 */
function isAttachmentPart(part: gmail_v1.Schema$MessagePart): boolean {
  const disposition = header(part, "Content-Disposition").trim().toLowerCase();
  if (disposition.startsWith("attachment")) return true;
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

/**
 * Cap on the HTML handed to the parser. The plain text we keep is small \u2014 thread
 * reads truncate the output to a character budget, and the send path only
 * derives a fallback alternative part \u2014 so parsing an unbounded multi-MB body
 * would build a huge DOM for no benefit. 1 MB is far above any realistic email's
 * text content; a larger body is sliced (best-effort) before parsing.
 */
const MAX_HTML_INPUT_CHARS = 1_000_000;

/**
 * Cap on HTML element nesting handed to the parser. html-to-text walks the DOM
 * recursively, so without a depth limit ~2,200 nested tags (a few KB of
 * hostile input — MAX_HTML_INPUT_CHARS does not help) overflow the call stack
 * and the RangeError escapes to the caller. With the limit, deeper content
 * degrades to the library's ellipsis instead. Real emails nest a few dozen
 * levels at most; 150 is far above legitimate content and far below the
 * ~2,200-frame crash threshold.
 */
const MAX_HTML_NESTING_DEPTH = 150;

/**
 * Strip an HTML email body down to readable plain text using the html-to-text
 * library, which parses the markup (handling quoted attributes, comments,
 * malformed nesting, character references, and block structure) rather than
 * scrubbing tags with regexes. head/title/style/script are dropped, links
 * render as their visible text (no URL clutter), and images are skipped.
 * Non-breaking spaces are normalized to ordinary spaces so callers see plain
 * ASCII whitespace. Returns "" for empty/blank input.
 */
export function htmlToText(html: string): string {
  // Bound the input so a pathologically large body can't build an unbounded DOM
  // (the kept text is small either way; see MAX_HTML_INPUT_CHARS).
  const bounded =
    html.length > MAX_HTML_INPUT_CHARS
      ? html.slice(0, MAX_HTML_INPUT_CHARS)
      : html;
  return htmlToTextConvert(bounded, {
    // Preserve the content as-is; the model, not a fixed column width, decides
    // wrapping. Skip non-visible/non-text elements so they can't leak into the
    // body, and drop hrefs/images so only readable text remains.
    wordwrap: false,
    // Bound the DOM walk's recursion depth (see MAX_HTML_NESTING_DEPTH).
    limits: { maxDepth: MAX_HTML_NESTING_DEPTH },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "head", format: "skip" },
      { selector: "title", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
    ],
  })
    .replace(/\u00A0/g, " ")
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
  // Only a plain part with actual content wins. Some bulk-mail template
  // systems emit a whitespace-only text/plain alternative (e.g. a bare CRLF)
  // beside a full text/html part; returning that "body" would make the whole
  // message look empty when the HTML carries all the content.
  if (plain.trim()) return plain;
  const html = findPartBody(payload, "text/html");
  if (html) return htmlToText(html);
  return "";
}

/**
 * extractPlainText, but a failure on one message degrades to a marker body
 * instead of throwing. Thread reads extract every message's body in one pass;
 * without this isolation a single hostile or malformed body (e.g. HTML the
 * parser chokes on) rejects the whole tool call and makes every message in the
 * thread unreadable — permanently, since retrying decodes the same bytes.
 */
export function extractPlainTextSafe(
  payload: gmail_v1.Schema$MessagePart | undefined
): string {
  try {
    return extractPlainText(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `[Body could not be extracted: ${reason}]`;
  }
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
/**
 * Reject composite MIME types for attachments. Attachment parts are emitted
 * with Content-Transfer-Encoding: base64, which RFC 2046 §5 forbids for
 * message/* (§5.2.1) and multipart/* (§5.1) entities — emitting them anyway
 * produces a per-spec-invalid part that strict receivers refuse to parse
 * (e.g. an attached .eml shown as opaque instead of a forwarded message).
 */
function assertEncodableMimeType(index: number, mimeType: string): void {
  if (/^(message|multipart)\//i.test(mimeType.trim())) {
    throw new Error(
      `Attachment ${index}: composite MIME type '${mimeType}' cannot be ` +
        `base64-encoded (RFC 2046 §5). Attach it as application/octet-stream, ` +
        `or omit mime_type to infer one from the filename.`
    );
  }
}

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
      const isWithinAllowed = (p: string): boolean =>
        allowedDirs.some((dir) => {
          let realDir: string;
          try {
            realDir = fs.realpathSync(dir);
          } catch {
            return false; // configured dir doesn't exist; can't contain the file
          }
          return p === realDir || p.startsWith(realDir + path.sep);
        });
      const resolved = fs.realpathSync(filePath);
      const allowed = isWithinAllowed(resolved);
      if (!allowed) {
        throw new Error(
          `Attachment ${i}: '${filePath}' is outside the allowed attachment ` +
            `directories (GMAIL_MCP_ATTACHMENTS_DIR). Refusing to read it.`
        );
      }
      // Open the resolved real path once with O_NOFOLLOW, then fstat and read
      // from that same descriptor. This closes the TOCTOU window between the
      // containment check and the read: O_NOFOLLOW refuses a symlink swapped in
      // for the final path component after we resolved it (ELOOP), and operating
      // on the fd guarantees the regular-file check and the read see the same
      // inode. O_NOFOLLOW is POSIX-only; it degrades to a no-op (0) elsewhere.
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      let fd: number;
      try {
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
      } catch {
        // ELOOP (final component became a symlink) or ENOENT (vanished after the
        // check) — refuse rather than read something we didn't just validate.
        throw new Error(
          `Attachment ${i}: '${filePath}' could not be opened safely (it may have changed on disk).`
        );
      }
      try {
        // Only read regular files: a directory, FIFO, socket, or device inside
        // an allowed dir is not a valid attachment (and reading a FIFO could
        // block the server indefinitely). fstat sees the opened inode.
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) {
          throw new Error(`Attachment ${i}: '${filePath}' is not a regular file.`);
        }
        // O_NOFOLLOW guards only the FINAL path component; a racer swapping an
        // INTERMEDIATE directory for a symlink between realpathSync and openSync
        // could still have redirected the open outside the allowlist. Close that
        // window by requiring, after the open, that the path still resolves
        // inside the allowlist AND names the very inode this fd has open: a
        // racer can keep the path in-allowlist or keep the fd's inode, but not
        // both. Defense-in-depth — the earlier checks already block everything
        // that isn't an actively racing local process.
        let verified = false;
        try {
          const recheck = fs.realpathSync(filePath);
          const now = fs.statSync(recheck);
          verified =
            isWithinAllowed(recheck) &&
            now.dev === opened.dev &&
            now.ino === opened.ino;
        } catch {
          verified = false; // path vanished/changed under us — refuse
        }
        if (!verified) {
          throw new Error(
            `Attachment ${i}: '${filePath}' changed on disk while being read; refusing.`
          );
        }
        const filename = a.filename || path.basename(filePath);
        const mimeType = a.mime_type || inferMimeType(filename);
        assertEncodableMimeType(i, mimeType);
        const contentBase64 = fs.readFileSync(fd).toString("base64");
        return { filename, mimeType, contentBase64 };
      } finally {
        fs.closeSync(fd);
      }
    }
    // Inline base64.
    if (!a.filename) {
      throw new Error(
        `Attachment ${i}: 'filename' is required when using 'content_base64'.`
      );
    }
    const mimeType = a.mime_type || inferMimeType(a.filename);
    assertEncodableMimeType(i, mimeType);
    // Validate, and normalize base64url -> standard base64, so we never embed a
    // silently-corrupt attachment. Buffer.from is lenient (it drops invalid
    // chars), so the regex is what actually rejects garbage; re-encoding the
    // decoded bytes yields canonical padding for the wire.
    //
    // One whitespace-stripping pass, then validate against both the standard
    // (+/) and URL-safe (-_) alphabets in a single regex — no separate
    // alphabet-conversion passes just to validate.
    const cleaned = a.content_base64!.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(cleaned)) {
      throw new Error(`Attachment ${i}: 'content_base64' is not valid base64.`);
    }
    // Length must be possible: stripped of padding, a base64 string's length is
    // never ≡ 1 (mod 4) — a lone trailing 6-bit group can't exist, and Node's
    // lenient decoder would silently drop it rather than flag it. Measure the
    // unpadded length in place rather than allocating a trimmed copy. (Padding
    // is optional because base64url inputs arrive unpadded.)
    let unpaddedLen = cleaned.length;
    while (unpaddedLen > 0 && cleaned.charCodeAt(unpaddedLen - 1) === 0x3d /* = */) {
      unpaddedLen--;
    }
    if (unpaddedLen % 4 === 1) {
      throw new Error(`Attachment ${i}: 'content_base64' is not valid base64.`);
    }
    // Normalize the URL-safe alphabet to standard in one pass, then re-encode to
    // canonical standard base64 (canonical padding for the wire).
    const standard = cleaned.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/"));
    const contentBase64 = Buffer.from(standard, "base64").toString("base64");
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
  // Pure-ASCII values need no encoding — unless the text itself contains an
  // RFC 2047 encoded-word marker ("=?"): passed through verbatim, recipients'
  // clients would DECODE it into different text. RFC 2047 §2 requires encoding
  // such literals; wrapping the whole value preserves it exactly. Checked by
  // code unit rather than a control-char regex so the function carries no
  // lint-suppression baggage.
  if (isAscii(value) && !value.includes("=?")) return value;
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

/** RFC 5322 "specials" (plus ".") that force a display name to be quoted. */
const DISPLAY_NAME_SPECIALS = /[()<>[\]:;@\\,".]/;

/**
 * Render a recipient as an RFC 5322 mailbox. A bare address ("a@b.com") passes
 * through unchanged. For a "Display Name <addr>" form the display name is:
 *   - RFC 2047 encoded when it contains non-ASCII (so "Müller" survives the
 *     wire instead of going out as raw bytes), or
 *   - wrapped in a quoted-string when it contains specials such as a comma (so
 *     "Doe, John <j@x>" isn't read as two recipients once the list is
 *     comma-joined), escaping any " or \ inside, or
 *   - left as-is when it's a clean ASCII phrase.
 * CR/LF is still stripped at the header level by sanitizeHeaderValue, so a
 * display name can't inject a header regardless of this formatting.
 */
function formatRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  const m = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
  if (!m) return trimmed; // bare address (or nothing parseable as a name-addr)
  // Both capture groups are present whenever the regex matches; `?? ""` only
  // satisfies the type checker (the address group can never actually be empty).
  let name = (m[1] ?? "").trim();
  const address = (m[2] ?? "").trim();
  // Callers often supply the display name already in RFC 5322 quoted form
  // ('"Doe, John" <j@x>') — that is how mail clients render such addresses, so
  // it is what gets copy-pasted. Unwrap a well-formed quoted string (undoing
  // its \" and \\ escapes) so the quoting below re-quotes canonically instead
  // of nesting literal quote marks into the visible name.
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(name);
  if (quoted) name = (quoted[1] ?? "").replace(/\\(.)/g, "$1");
  if (!name) return `<${address}>`;
  let displayName: string;
  if (!isAscii(name)) {
    // RFC 2047 encoded-word — legal in a display-name phrase, and (unlike a
    // quoted-string) the right way to carry non-ASCII here.
    displayName = encodeHeaderWord(name);
  } else if (DISPLAY_NAME_SPECIALS.test(name) || name.includes("=?")) {
    // Quote names with specials — and any ASCII name containing "=?", which
    // would otherwise be decoded by recipients as an RFC 2047 encoded-word
    // (encoded-words are never recognized inside a quoted-string).
    displayName = `"${name.replace(/(["\\])/g, "\\$1")}"`;
  } else {
    displayName = name;
  }
  return `${displayName} <${address}>`;
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
 * Payload budget per RFC 2231 continuation segment. Chosen so a full parameter
 * unit (`; filename*NN*=<chunk>` — up to ~20 octets of overhead) stays within
 * foldHeaderLine's 78-octet target, letting the header fold legally at the
 * space after each `;` instead of ever needing a value-corrupting hard break.
 */
const RFC2231_SEGMENT_CHARS = 55;

/**
 * Render a filename as one or more MIME parameters per RFC 2231:
 *  - a short quote-safe ASCII name → the simple quoted form
 *    (`filename="report.pdf"`);
 *  - a long quote-safe ASCII name → quoted continuations
 *    (`filename*0="…"; filename*1="…"`), RFC 2231 §3;
 *  - a non-ASCII/unquotable name → the extended form (`filename*=UTF-8''…`),
 *    split into extended continuations (`filename*0*=UTF-8''…; filename*1*=…`)
 *    when long, cut only BETWEEN %XX escapes so no segment holds a partial
 *    escape. Only segment 0 carries the `UTF-8''` charset prefix (§4.1).
 * Continuations are what the RFC defines for over-long parameter values; the
 * previous single-parameter emission relied on hardBreakSegment past 998
 * octets, which inserted a space INTO the value (even mid-escape), corrupting
 * the filename on the receiving side.
 */
function filenameParams(paramName: string, filename: string): string[] {
  if (isQuotableFilename(filename)) {
    if (filename.length <= RFC2231_SEGMENT_CHARS) {
      return [`${paramName}="${filename}"`];
    }
    const parts: string[] = [];
    for (let i = 0; i < filename.length; i += RFC2231_SEGMENT_CHARS) {
      parts.push(filename.slice(i, i + RFC2231_SEGMENT_CHARS));
    }
    return parts.map((p, n) => `${paramName}*${n}="${p}"`);
  }
  const encoded = encodeRfc2231(filename);
  if (encoded.length <= RFC2231_SEGMENT_CHARS) {
    return [`${paramName}*=UTF-8''${encoded}`];
  }
  const chunks: string[] = [];
  let i = 0;
  while (i < encoded.length) {
    let end = Math.min(i + RFC2231_SEGMENT_CHARS, encoded.length);
    // Never cut inside a %XX escape: back off when the boundary would leave a
    // bare "%" or "%X" at the end of this chunk.
    if (end < encoded.length) {
      if (encoded.charAt(end - 1) === "%") end -= 1;
      else if (encoded.charAt(end - 2) === "%") end -= 2;
    }
    chunks.push(encoded.slice(i, end));
    i = end;
  }
  return chunks.map((c, n) =>
    n === 0 ? `${paramName}*0*=UTF-8''${c}` : `${paramName}*${n}*=${c}`
  );
}

/**
 * Build a MIME header line carrying a filename parameter (see filenameParams
 * for the encoding rules). Either way CR/LF can't survive — the quoted forms
 * are gated by isQuotableFilename, and the extended forms are percent-encoded —
 * so neither can inject a header.
 */
function mimeHeaderWithFilename(
  prefix: string,
  paramName: string,
  filename: string
): string {
  return [prefix, ...filenameParams(paramName, filename)].join("; ");
}

/** RFC 5322's hard per-line limit (998 octets, excluding the CRLF). */
const HARD_LINE_LIMIT = 998;

/**
 * Last-resort hard break for a segment that has no foldable space yet still
 * exceeds the hard line limit (e.g. one pathologically long token). Splits on a
 * UTF-8 code-point boundary — `for...of` iterates by code point, so a multi-byte
 * character is never cut — and gives each continuation a leading space so the
 * result re-folds as valid FWS. Unlike space-folding this alters the value on
 * unfolding (a space is inserted), but it only triggers for values far longer
 * than any real address or message-id (filenames never reach it — they are
 * split into RFC 2231 continuations upstream); everything shorter is
 * untouched. The alternative — emitting a >998-octet line — risks the whole
 * message being rejected.
 */
function hardBreakSegment(segment: string): string[] {
  if (Buffer.byteLength(segment, "utf-8") <= HARD_LINE_LIMIT) return [segment];
  const max = HARD_LINE_LIMIT - 1; // reserve an octet for the continuation space
  const pieces: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of segment) {
    const charBytes = Buffer.byteLength(ch, "utf-8");
    if (bytes + charBytes > max && cur !== "") {
      pieces.push(cur);
      cur = ch;
      bytes = charBytes;
    } else {
      cur += ch;
      bytes += charBytes;
    }
  }
  if (cur !== "") pieces.push(cur);
  return pieces.map((piece, idx) => (idx === 0 ? piece : ` ${piece}`));
}

/**
 * Fold a header line so no line exceeds 78 octets (RFC 5322 recommends ≤78; the
 * hard limit is 998). Length is measured in UTF-8 octets, not characters, so a
 * line of multi-byte content is still bounded correctly. Folds only at existing
 * spaces — inserting a CRLF before a space, which then serves as the
 * continuation line's indent — so unfolding restores the value byte-for-byte,
 * and the break point (an ASCII space) is never inside a multi-byte sequence.
 * This keeps long recipient lists, References chains, and multi-word encoded
 * subjects within spec. A single token longer than 78 octets (e.g. one long
 * address) is left intact rather than broken — except that a token still over
 * the 998-octet hard limit is hard-broken as a last resort (see
 * hardBreakSegment) so no emitted line can violate that limit.
 */
function foldHeaderLine(line: string): string {
  const LIMIT = 78; // octets
  if (Buffer.byteLength(line, "utf-8") <= LIMIT) return line;
  const segments: string[] = [];
  let segStart = 0; // index where the current output segment begins
  let lastSpace = -1; // index of the last space seen within the current segment
  let bytes = 0; // octets accumulated in the current segment so far
  for (let i = 0; i < line.length; i++) {
    // charAt returns "" past the end (never here, since i < length) and is typed
    // string, unlike line[i] which noUncheckedIndexedAccess widens to undefined.
    const ch = line.charAt(i);
    const charBytes = Buffer.byteLength(ch, "utf-8");
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
    if (ch === " ") lastSpace = i;
  }
  segments.push(line.slice(segStart));
  // RFC 5322 §3.2.2 forbids generating a folded line made up entirely of WSP.
  // A run of spaces straddling the fold boundary before an unfoldable token can
  // produce exactly that (two folds at adjacent spaces); merge any all-WSP
  // segment into the next segment (or the previous one at the end) so the
  // emitted lines are legal while unfolding still restores the value
  // byte-for-byte.
  const merged: string[] = [];
  let pendingWsp = "";
  for (const seg of segments) {
    if (/^[ \t]+$/.test(seg)) {
      pendingWsp += seg;
      continue;
    }
    merged.push(pendingWsp + seg);
    pendingWsp = "";
  }
  if (pendingWsp !== "") {
    if (merged.length > 0) merged[merged.length - 1] += pendingWsp;
    else merged.push(pendingWsp);
  }
  // Hard-break any segment that has no foldable space but still exceeds the
  // 998-octet hard limit; normal segments pass through unchanged.
  return merged.flatMap(hardBreakSegment).join("\r\n");
}

/** Wrap a long base64 string into 76-char lines per RFC 2045. */
function wrapBase64(data: string): string {
  return data.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** Generate an unguessable MIME boundary token (144 bits of CSPRNG entropy). */
function makeBoundary(tag: string): string {
  return `=_${tag}_${crypto.randomBytes(18).toString("hex")}`;
}

/**
 * A boundary guaranteed not to occur within the content it will delimit. With a
 * 144-bit random token a collision is already infinitesimal; this check makes
 * it impossible (and is cheap), so a delimiter can never appear inside a part
 * body and prematurely terminate it.
 */
function uniqueBoundary(tag: string, contents: string[]): string {
  let boundary = makeBoundary(tag);
  while (contents.some((c) => c.includes(boundary))) boundary = makeBoundary(tag);
  return boundary;
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
 * Render the message body as the lines of a MIME entity. When `isHtml` is set,
 * the body is sent as `multipart/alternative` with a text/plain part (derived
 * from the HTML via htmlToText, listed first per RFC 2046 "least rich first")
 * and the original HTML second, so non-HTML clients still get readable text.
 * Otherwise it's a single text/plain part. Each raw base64 blob is pushed onto
 * `contents` so the caller can choose enclosing boundaries that never collide
 * with the content.
 */
function renderBodyEntity(
  body: string,
  isHtml: boolean | undefined,
  contents: string[]
): string[] {
  if (!isHtml) {
    const b64 = wrapBase64(Buffer.from(body, "utf-8").toString("base64"));
    contents.push(b64);
    return [
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64,
    ];
  }
  const plainB64 = wrapBase64(
    Buffer.from(htmlToText(body), "utf-8").toString("base64")
  );
  const htmlB64 = wrapBase64(Buffer.from(body, "utf-8").toString("base64"));
  const altBoundary = uniqueBoundary("alt", [plainB64, htmlB64]);
  // Record the parts AND this boundary so an enclosing multipart/mixed boundary
  // (chosen later) is guaranteed distinct from the alternative boundary too, not
  // just from the content.
  contents.push(plainB64, htmlB64, altBoundary);
  return [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    plainB64,
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    `--${altBoundary}--`,
  ];
}

/** Render one attachment as the lines of a multipart/mixed part. */
function renderAttachmentPart(att: ResolvedAttachment): string[] {
  const safeMime = sanitizeHeaderValue(att.mimeType);
  // Fold each part header so a long (e.g. non-ASCII, percent-encoded) filename
  // can't produce an over-length line, just like the top-level headers.
  const partHeaders = [
    mimeHeaderWithFilename(`Content-Type: ${safeMime}`, "name", att.filename),
    "Content-Transfer-Encoding: base64",
    mimeHeaderWithFilename(
      "Content-Disposition: attachment",
      "filename",
      att.filename
    ),
  ].map(foldHeaderLine);
  return [...partHeaders, "", wrapBase64(att.contentBase64)];
}

/**
 * Build a raw RFC 2822 message suitable for Gmail's `raw` field.
 *
 * Body can be plain text or HTML (`isHtml`); an HTML body is sent as
 * `multipart/alternative` (auto-derived plain text + HTML). When attachments
 * are present the whole thing is wrapped in `multipart/mixed` (body entity
 * first, then each attachment). Handles To/Cc/Bcc, RFC 2047 subject encoding,
 * and optional reply threading headers.
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
  // Render each recipient to an RFC 5322 mailbox (encoding/quoting display
  // names) before comma-joining, so a name with a comma or non-ASCII survives.
  const formatList = (xs: string[]): string => xs.map(formatRecipient).join(", ");
  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${sanitizeHeaderValue(opts.from)}`);
  headers.push(`To: ${sanitizeHeaderValue(formatList(opts.to))}`);
  if (opts.cc?.length) headers.push(`Cc: ${sanitizeHeaderValue(formatList(opts.cc))}`);
  // The Bcc header is how Gmail learns the blind recipients for a raw send; it
  // strips the header before delivery, so it is not leaked to To/Cc. Keep it.
  if (opts.bcc?.length)
    headers.push(`Bcc: ${sanitizeHeaderValue(formatList(opts.bcc))}`);
  headers.push(`Subject: ${encodeHeaderWord(sanitizeHeaderValue(opts.subject))}`);
  if (opts.inReplyTo)
    headers.push(`In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}`);
  if (opts.references)
    headers.push(`References: ${sanitizeHeaderValue(opts.references)}`);
  headers.push("MIME-Version: 1.0");

  // Fold long header lines (recipient lists, References chains, multi-word
  // encoded subjects) to stay within RFC 5322's line-length limit.
  const foldedHeaders = headers.map(foldHeaderLine);

  // Raw content blobs, collected so multipart boundaries can be chosen to never
  // occur within the content they delimit.
  const contents: string[] = [];
  const bodyEntity = renderBodyEntity(opts.body, opts.isHtml, contents);

  const attachments = opts.attachments || [];

  // No attachments → the body entity is the whole message body.
  if (attachments.length === 0) {
    return finalizeMessage([...foldedHeaders, ...bodyEntity]);
  }

  // Attachments present → wrap the body entity and each attachment in
  // multipart/mixed.
  for (const att of attachments) {
    contents.push(att.contentBase64, att.filename, att.mimeType);
  }
  const boundary = uniqueBoundary("mix", contents);
  const lines: string[] = [
    ...foldedHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...bodyEntity,
  ];
  for (const att of attachments) {
    lines.push(`--${boundary}`, ...renderAttachmentPart(att));
  }
  lines.push(`--${boundary}--`, "");
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

/**
 * Extract a numeric HTTP status from the various shapes clients surface. Modern
 * gaxios sets a numeric `error.status` (or `error.response.status`); older
 * shapes put it on `code`. A *string* `code` (e.g. "ENOTFOUND") is a
 * transport-level failure, not an HTTP status, so it's ignored. Returns
 * undefined when there's no numeric HTTP status (transport or local error).
 */
function httpStatusOf(error: unknown): number | undefined {
  const e = error as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
  };
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.response?.status === "number") return e.response.status;
  if (typeof e?.code === "number") return e.code;
  return undefined;
}

/**
 * Statuses worth retrying for *idempotent* calls: rate limiting plus transient
 * server errors, none of which leave a side effect behind when retried.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Statuses safe to retry for *non-idempotent* calls (send / draft-create): only
 * a rate limit. A 429 means Gmail rejected the request before processing it, so
 * a retry can't duplicate the side effect — whereas retrying a 5xx that the
 * server had already processed could (e.g. deliver a second copy of an email).
 */
const RATE_LIMIT_ONLY = new Set([429]);

/**
 * Gmail's usage-limit errors that arrive as HTTP 403 (usageLimits domain)
 * rather than 429. Google's error guide says to retry these with exponential
 * backoff; like a 429, the request was rejected before processing, so they are
 * safe to retry even for non-idempotent calls (send/draft). Distinguished from
 * a true permission 403 by the structured `reason` field.
 */
const RATE_LIMIT_403_REASONS = new Set([
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "dailyLimitExceeded",
]);

/**
 * Extract the structured `reason` of the first error item from a Gmail API
 * error body (error.response.data.error.errors[0].reason, with the top-level
 * errors array as a fallback shape). This is the documented discriminator
 * between e.g. a rate-limit 403 and a missing-scope 403.
 */
function gmailErrorReason(error: unknown): string | undefined {
  const e = error as {
    errors?: Array<{ reason?: string }>;
    response?: {
      data?: { error?: { errors?: Array<{ reason?: string }> } | string };
    };
  };
  const errField = e?.response?.data?.error;
  if (typeof errField === "object" && errField !== null) {
    const reason = errField.errors?.[0]?.reason;
    if (reason) return reason;
  }
  return e?.errors?.[0]?.reason;
}

/** True when an error is a Gmail usage-limit 403 (retryable rate limit). */
function isRateLimit403(error: unknown): boolean {
  if (httpStatusOf(error) !== 403) return false;
  const reason = gmailErrorReason(error);
  return reason !== undefined && RATE_LIMIT_403_REASONS.has(reason);
}

/**
 * True when an error is the OAuth token endpoint rejecting the saved grant
 * (HTTP 400 `invalid_grant`): the refresh token was revoked, expired (e.g. the
 * 7-day expiry on a Testing-status OAuth client), or invalidated by a password
 * change. The token endpoint uses the OAuth error shape — `data.error` is the
 * STRING "invalid_grant" (with optional `data.error_description`) — not the
 * Gmail API's structured error object.
 */
function isInvalidGrant(error: unknown): boolean {
  if (httpStatusOf(error) !== 400) return false;
  const e = error as { message?: string; response?: { data?: { error?: unknown } } };
  return (
    e?.response?.data?.error === "invalid_grant" ||
    /invalid_grant/.test(e?.message ?? "")
  );
}

/**
 * Transient transport-level failures (no HTTP status) safe to retry for
 * *idempotent* calls: connection resets/refusals/timeouts where the request
 * never reached a definite outcome. Matched by Node's system-error `code`, which
 * gaxios 7 exposes on the top-level error and on its underlying FetchError
 * `cause`. A per-request timeout carries no `code` and is detected separately in
 * isTimeoutError.
 */
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);

/**
 * True when an error is a per-request timeout: the client aborted a stalled
 * request via its timeout AbortSignal. gaxios 7 surfaces this as a GaxiosError
 * with no HTTP status and no `code`, whose `cause` is an AbortError; older
 * (node-fetch) gaxios used `type: "request-timeout"`. Both shapes are recognized,
 * plus Node's `ABORT_ERR` code, so a timeout is classified consistently across
 * the stack. A timeout carries no HTTP status, so for a send/draft it is never
 * retried (see withRetry) — the request may already have been processed.
 */
function isTimeoutError(error: unknown): boolean {
  const e = error as { code?: unknown; type?: string; cause?: { name?: string } };
  return (
    e?.code === "ABORT_ERR" ||
    e?.cause?.name === "AbortError" ||
    e?.type === "request-timeout"
  );
}

/**
 * True when an error is a transient transport-level failure worth retrying for
 * an idempotent call: a known retryable system-error `code` (gaxios 7 sets it on
 * the top-level error and on its FetchError `cause`), or a per-request timeout.
 * Errors that carry an HTTP status are classified by status, not here. Retried
 * only for idempotent calls — for a send/draft a timeout/reset could mean the
 * request was already processed, so a retry might duplicate it.
 */
function isRetryableTransport(error: unknown): boolean {
  const e = error as { code?: number | string; cause?: { code?: number | string } };
  const codes = [e?.code, e?.cause?.code];
  if (codes.some((c) => typeof c === "string" && RETRYABLE_TRANSPORT_CODES.has(c))) {
    return true;
  }
  return isTimeoutError(error);
}

/**
 * Run a Gmail API call with bounded, jittered exponential backoff on transient
 * failures. By default (idempotent calls) it retries on rate limiting + 5xx;
 * pass `idempotent: false` for a call with a side effect that must not be
 * duplicated (send, draft create), which restricts retries to 429 only.
 * Non-retryable errors (other 4xx, local validation, transport errors with no
 * HTTP status) and the final attempt throw immediately, so callers' error
 * handling is unchanged except that a transient blip is retried instead of
 * surfaced. Jitter avoids synchronized retries across concurrent calls.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; idempotent?: boolean } = {}
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const idempotent = opts.idempotent !== false;
  const retryable = idempotent ? RETRYABLE_STATUSES : RATE_LIMIT_ONLY;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = httpStatusOf(error);
      // Retry an HTTP status in the retryable set; a usage-limit 403 (Gmail's
      // alternate rate-limit shape — like a 429, rejected before processing,
      // so safe even for send/draft); or — for idempotent calls only — a
      // transient transport error (timeout/reset) that carries no status. A
      // non-idempotent call never retries a transport error: the request may
      // have been processed, so a retry could duplicate it.
      const retryableNow =
        (status !== undefined && retryable.has(status)) ||
        isRateLimit403(error) ||
        (idempotent && isRetryableTransport(error));
      if (attempt >= retries || !retryableNow) {
        throw error;
      }
      const delay =
        baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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
    cause?: { code?: number | string };
  };
  // The HTTP status, wherever the client surfaced it (see httpStatusOf).
  const status = httpStatusOf(error);
  // Prefer Gmail's structured error detail (it lives under response.data.error
  // for a real API error); fall back to the error message.
  const detail =
    e?.response?.data?.error?.errors?.[0]?.message ||
    e?.response?.data?.error?.message ||
    e?.errors?.[0]?.message ||
    e?.message ||
    String(error);
  switch (status) {
    case 400: {
      // The OAuth token endpoint rejecting the saved grant (revoked, expired —
      // e.g. the 7-day expiry on a Testing-status client — or password change)
      // is the most common way an account dies. Without this branch it read as
      // a generic Gmail API failure and never mentioned the actual fix.
      if (isInvalidGrant(error)) {
        const desc = (
          error as { response?: { data?: { error_description?: string } } }
        )?.response?.data?.error_description;
        return (
          `Error: The account's saved authorization is no longer valid ` +
          `(invalid_grant${desc ? `: ${desc}` : ""}). ` +
          "Re-run `npm run add-account` for this account."
        );
      }
      break; // other 400s fall through to the generic status message
    }
    case 401:
      return "Error: Authentication failed or token expired. Re-run `npm run add-account` for this account.";
    case 403: {
      // Gmail's usage limits can surface as 403 (usageLimits domain), which is
      // a transient throttle — telling the user to re-check OAuth scopes for it
      // sends them to redo consent for nothing. The structured reason
      // distinguishes the two.
      const reason = gmailErrorReason(error);
      if (reason !== undefined && RATE_LIMIT_403_REASONS.has(reason)) {
        return `Error: Rate limit exceeded (403 ${reason}). Wait before retrying.`;
      }
      return `Error: Permission denied. The account may not have granted the required scope. (${detail})`;
    }
    case 404:
      return "Error: Resource not found. Check the message/thread/label ID.";
    case 429:
      return "Error: Rate limit exceeded. Wait before retrying.";
  }
  if (status) return `Error: Gmail API request failed (status ${status}): ${detail}`;
  // No HTTP status. A per-request timeout (the client aborted a stalled request)
  // has no status and no `code` — identify it via isTimeoutError and report it as
  // a timeout rather than a generic error.
  if (isTimeoutError(error)) {
    return "Error: Request to Gmail timed out. Check connectivity and retry.";
  }
  // A string `code` is a transport/system error (DNS failure, connection reset);
  // gaxios 7 sets it on the error and on its FetchError `cause`. Report it as a
  // network error rather than an API rejection. Otherwise it's a local error
  // (e.g. attachment validation).
  const transportCode =
    (typeof e?.code === "string" && e.code) ||
    (typeof e?.cause?.code === "string" && e.cause.code) ||
    undefined;
  if (transportCode) {
    return `Error: Network error (${transportCode}) reaching Gmail. Check connectivity and retry. (${detail})`;
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
  return jsonTooLargeNotice(json.length, note);
}

/**
 * The plain-text notice renderJsonText falls back to when a result is too large
 * to render as JSON. Split out so a caller that has already serialized the value
 * (e.g. gmail_get_thread, which stringifies once to size it and to build a
 * summary) can reuse that length instead of paying for a second JSON.stringify.
 */
export function jsonTooLargeNotice(length: number, note: string): string {
  return (
    `[Result too large to render as text (${length} characters); the ` +
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
      // Never cut between the halves of a surrogate pair: the resulting lone
      // surrogate is ill-formed Unicode that strict JSON/Unicode consumers
      // (e.g. serde-based MCP clients) reject for the whole response.
      let cut = remaining;
      const hi = body.charCodeAt(cut - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) cut -= 1;
      const trimmed =
        body.slice(0, cut) + "\n[Body truncated: thread exceeds size limit]";
      remaining = 0;
      return { ...item, body: trimmed };
    }
    remaining -= body.length;
    return { ...item, body };
  });
  return { messages, truncated };
}
