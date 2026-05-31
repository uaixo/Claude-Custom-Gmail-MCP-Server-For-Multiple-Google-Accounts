import fs from "fs";
import path from "path";
import { google, gmail_v1 } from "googleapis";
import { getAuthedClient, resolveAccount } from "./auth.js";
import { attachmentDirs, MAX_MESSAGE_BYTES } from "./constants.js";

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

/** Decode a base64url string to UTF-8. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
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

/** Recursively return the first part body matching an exact MIME type. */
function findPartBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string
): string {
  if (!payload) return "";
  if (payload.mimeType === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
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
    return { filename: a.filename, mimeType, contentBase64: a.content_base64! };
  });
}

/** RFC 2047 base64-encode a header value so non-ASCII survives. */
function encodeHeaderWord(value: string): string {
  // Only encode if it contains non-ASCII; keeps plain subjects readable on the wire.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
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
  if (opts.from) headers.push(`From: ${opts.from}`);
  headers.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc?.length) headers.push(`Cc: ${opts.cc.join(", ")}`);
  // The Bcc header is how Gmail learns the blind recipients for a raw send; it
  // strips the header before delivery, so it is not leaked to To/Cc. Keep it.
  if (opts.bcc?.length) headers.push(`Bcc: ${opts.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderWord(opts.subject)}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  headers.push("MIME-Version: 1.0");

  const bodyContentType = opts.isHtml
    ? 'text/html; charset="UTF-8"'
    : 'text/plain; charset="UTF-8"';

  const attachments = opts.attachments || [];

  // Simple case: no attachments → single body part.
  if (attachments.length === 0) {
    const lines = [
      ...headers,
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
    const encodedName = encodeHeaderWord(att.filename);
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${encodedName}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${encodedName}"`,
        "",
        wrapBase64(att.contentBase64),
      ].join("\r\n")
    );
  }

  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    parts.join("\r\n"),
    `--${boundary}--`,
    "",
  ];
  return finalizeMessage(lines);
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
