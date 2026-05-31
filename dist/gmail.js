import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { getAuthedClient, resolveAccount } from "./auth.js";
/** Build a Gmail API client for a resolved account. */
export function gmailFor(account) {
    const resolved = resolveAccount(account);
    const auth = getAuthedClient(resolved);
    const gmail = google.gmail({ version: "v1", auth });
    return { gmail, account: resolved };
}
/** Decode a base64url string to UTF-8. */
export function decodeBase64Url(data) {
    return Buffer.from(data, "base64url").toString("utf-8");
}
/** Encode a UTF-8 string to base64url (RFC 4648, no padding). */
export function encodeBase64Url(data) {
    return Buffer.from(data, "utf-8").toString("base64url");
}
/** Pull a header value (case-insensitive) from a message part. */
export function header(payload, name) {
    const headers = payload?.headers || [];
    const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
    return found?.value || "";
}
/** Recursively collect the plain-text body from a message payload. */
export function extractPlainText(payload) {
    if (!payload)
        return "";
    if (payload.mimeType === "text/plain" && payload.body?.data) {
        return decodeBase64Url(payload.body.data);
    }
    if (payload.parts) {
        // Prefer text/plain parts; fall back to recursing into everything.
        const text = payload.parts
            .map((p) => extractPlainText(p))
            .filter(Boolean)
            .join("\n");
        if (text)
            return text;
    }
    if (payload.body?.data && payload.mimeType?.startsWith("text/")) {
        return decodeBase64Url(payload.body.data);
    }
    return "";
}
/** Minimal extension → MIME type map for inferring attachment types. */
const MIME_BY_EXT = {
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
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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
export function inferMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    return MIME_BY_EXT[ext] || "application/octet-stream";
}
/**
 * Resolve tool-supplied attachments into base64 payloads. Each attachment must
 * provide exactly one of `path` (read from local disk) or `content_base64`
 * (inline). Throws an Error with an actionable message on bad input.
 */
export function resolveAttachments(inputs) {
    if (!inputs?.length)
        return [];
    return inputs.map((a, i) => {
        const hasPath = !!a.path;
        const hasInline = !!a.content_base64;
        if (hasPath === hasInline) {
            throw new Error(`Attachment ${i}: provide exactly one of 'path' or 'content_base64'.`);
        }
        if (hasPath) {
            const filePath = a.path;
            if (!fs.existsSync(filePath)) {
                throw new Error(`Attachment ${i}: file not found at '${filePath}'.`);
            }
            const filename = a.filename || path.basename(filePath);
            const mimeType = a.mime_type || inferMimeType(filename);
            const contentBase64 = fs.readFileSync(filePath).toString("base64");
            return { filename, mimeType, contentBase64 };
        }
        // Inline base64.
        if (!a.filename) {
            throw new Error(`Attachment ${i}: 'filename' is required when using 'content_base64'.`);
        }
        const mimeType = a.mime_type || inferMimeType(a.filename);
        return { filename: a.filename, mimeType, contentBase64: a.content_base64 };
    });
}
/** RFC 2047 base64-encode a header value so non-ASCII survives. */
function encodeHeaderWord(value) {
    // Only encode if it contains non-ASCII; keeps plain subjects readable on the wire.
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(value))
        return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}
/** Wrap a long base64 string into 76-char lines per RFC 2045. */
function wrapBase64(data) {
    return data.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}
/** Generate a unique MIME boundary token. */
function makeBoundary(tag) {
    return `=_${tag}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2)}`;
}
/**
 * Build a raw RFC 2822 message suitable for Gmail's `raw` field.
 *
 * Body can be plain text or HTML (`isHtml`). When attachments are present the
 * message is `multipart/mixed` (body part first, then each attachment);
 * otherwise it's a single text/plain or text/html part. Handles To/Cc/Bcc,
 * RFC 2047 subject encoding, and optional reply threading headers.
 */
export function buildRawMessage(opts) {
    const headers = [];
    if (opts.from)
        headers.push(`From: ${opts.from}`);
    headers.push(`To: ${opts.to.join(", ")}`);
    if (opts.cc?.length)
        headers.push(`Cc: ${opts.cc.join(", ")}`);
    if (opts.bcc?.length)
        headers.push(`Bcc: ${opts.bcc.join(", ")}`);
    headers.push(`Subject: ${encodeHeaderWord(opts.subject)}`);
    if (opts.inReplyTo)
        headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references)
        headers.push(`References: ${opts.references}`);
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
        return encodeBase64Url(lines.join("\r\n"));
    }
    // Multipart/mixed: body part, then one part per attachment.
    const boundary = makeBoundary("mix");
    const parts = [];
    parts.push([
        `--${boundary}`,
        `Content-Type: ${bodyContentType}`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(Buffer.from(opts.body, "utf-8").toString("base64")),
    ].join("\r\n"));
    for (const att of attachments) {
        const encodedName = encodeHeaderWord(att.filename);
        parts.push([
            `--${boundary}`,
            `Content-Type: ${att.mimeType}; name="${encodedName}"`,
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: attachment; filename="${encodedName}"`,
            "",
            wrapBase64(att.contentBase64),
        ].join("\r\n"));
    }
    const lines = [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        parts.join("\r\n"),
        `--${boundary}--`,
        "",
    ];
    return encodeBase64Url(lines.join("\r\n"));
}
/** Format a Gmail API error into an actionable message. */
export function handleGmailError(error) {
    const e = error;
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
            return `Error: Gmail API request failed${status ? ` (status ${status})` : ""}: ${detail}`;
    }
}
//# sourceMappingURL=gmail.js.map