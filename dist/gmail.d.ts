import { gmail_v1 } from "googleapis";
/** Build a Gmail API client for a resolved account. */
export declare function gmailFor(account?: string): {
    gmail: gmail_v1.Gmail;
    account: string;
};
/** Decode a base64url string to UTF-8. */
export declare function decodeBase64Url(data: string): string;
/** Encode a UTF-8 string to base64url (RFC 4648, no padding). */
export declare function encodeBase64Url(data: string): string;
/** Pull a header value (case-insensitive) from a message part. */
export declare function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string;
/** Recursively collect the plain-text body from a message payload. */
export declare function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string;
/** A resolved attachment ready to be embedded in a MIME message. */
export interface ResolvedAttachment {
    filename: string;
    mimeType: string;
    /** Standard base64 (not base64url) content. */
    contentBase64: string;
}
/** Infer a MIME type from a filename's extension. */
export declare function inferMimeType(filename: string): string;
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
export declare function resolveAttachments(inputs: AttachmentInput[] | undefined): ResolvedAttachment[];
/**
 * Build a raw RFC 2822 message suitable for Gmail's `raw` field.
 *
 * Body can be plain text or HTML (`isHtml`). When attachments are present the
 * message is `multipart/mixed` (body part first, then each attachment);
 * otherwise it's a single text/plain or text/html part. Handles To/Cc/Bcc,
 * RFC 2047 subject encoding, and optional reply threading headers.
 */
export declare function buildRawMessage(opts: {
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
}): string;
/** Format a Gmail API error into an actionable message. */
export declare function handleGmailError(error: unknown): string;
