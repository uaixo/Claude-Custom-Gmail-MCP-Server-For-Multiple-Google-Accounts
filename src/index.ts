#!/usr/bin/env node
/**
 * Gmail MCP Server with multi-account support.
 *
 * Every tool accepts an optional `account` parameter (an email address) that
 * selects which connected Gmail account to act on. If omitted and exactly one
 * account is connected, that account is used; if several are connected, the
 * tool returns an error asking you to disambiguate.
 *
 * Connect accounts with `npm run add-account` before starting the server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cleanupStaleTokenTemps, listAccounts } from "./auth.js";
import {
  buildRawMessage,
  buildReplyHeaders,
  capMessageBodies,
  deriveReplySubject,
  extractPlainTextSafe,
  getThreadReplyHeaders,
  gmailFor,
  handleGmailError,
  header,
  jsonTooLargeNotice,
  mapWithConcurrency,
  renderJsonText,
  requireField,
  resolveAttachments,
  summarizeThread,
  withRetry,
} from "./gmail.js";
import {
  CHARACTER_LIMIT,
  isMainModule,
  MAX_THREAD_BODY_CHARS,
  MAX_THREAD_MESSAGES,
  packageVersion,
  THREAD_FETCH_CONCURRENCY,
} from "./constants.js";

/**
 * Shared attachment schema, modeled as a union of two mutually exclusive forms
 * so the "exactly one of `path` / `content_base64`" rule is expressed in the
 * advertised JSON schema (an `anyOf`) and enforced at the validation boundary,
 * not only at runtime in resolveAttachments. The `path` form infers filename
 * and mime_type when omitted; the `content_base64` form requires filename. Each
 * member is `.strict()`, so supplying both fields (or neither) fails to match
 * either branch and is rejected.
 */
const attachmentSchema = z
  .union([
    z
      .object({
        path: z
          .string()
          .describe(
            "Path to a local file on the machine running the server. Disabled unless the server sets GMAIL_MCP_ATTACHMENTS_DIR; the file must resolve to within an allowed directory. Otherwise use content_base64."
          ),
        filename: z
          .string()
          .optional()
          .describe("Display filename. Defaults to the file's basename."),
        mime_type: z
          .string()
          .optional()
          .describe(
            "MIME type. Inferred from the filename extension if omitted."
          ),
      })
      .strict(),
    z
      .object({
        content_base64: z
          .string()
          .describe("Inline file content, standard base64-encoded."),
        filename: z
          .string()
          .describe("Display filename. Required for inline content_base64."),
        mime_type: z
          .string()
          .optional()
          .describe(
            "MIME type. Inferred from the filename extension if omitted."
          ),
      })
      .strict(),
  ])
  .describe(
    "A file to attach. Supply exactly one of 'path' (the server reads a local file) or 'content_base64' (inline base64)."
  );

// Exported so tests can connect an in-memory client and introspect the
// registered tools (e.g. assert tool annotations).
export const server = new McpServer({
  name: "gmail-mcp-server",
  version: packageVersion(),
});

/** Shared optional account selector for all tools. */
const accountField = z
  .string()
  .email()
  .optional()
  .describe(
    "Email address of the connected Gmail account to use. Optional when only one account is connected; required to disambiguate when several are."
  );

/**
 * A recipient: either a bare email address ("alice@x.com") or an RFC 5322
 * name-addr with a display name ("Alice Example <alice@x.com>"). The email part
 * (inside the angle brackets when present) must look like an address — a
 * non-empty local part and a non-empty, whitespace-free domain. The domain need
 * not be dotted, so intranet addresses like "ops@localhost" are accepted; Gmail
 * makes the final delivery-time judgment. CR/LF in the value is stripped
 * downstream in buildRawMessage, so a display name can't inject headers.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
function isRecipient(value: string): boolean {
  const trimmed = value.trim();
  const named = /<([^<>]+)>\s*$/.exec(trimmed);
  // When the name-addr form matched, capture group 1 is always present; `?? ""`
  // only satisfies noUncheckedIndexedAccess.
  const email = (named ? (named[1] ?? "") : trimmed).trim();
  return EMAIL_RE.test(email);
}
const recipientSchema = z
  .string()
  .refine(isRecipient, {
    message: 'Must be an email address or \'Display Name <email@host>\'.',
  });

// ---------------------------------------------------------------------------
// gmail_list_accounts
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_list_accounts",
  {
    title: "List Connected Gmail Accounts",
    description: `List the Gmail accounts that have been connected to this server.

Use this first to discover which email addresses are available for the 'account' parameter on the other tools.

Args: none.

Returns: JSON { "count": number, "accounts": string[] } where each entry is a connected account email.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  // Synchronous: listing accounts is a local read with nothing to await. The
  // SDK accepts a sync handler, and keeping it sync avoids a no-op async wrapper.
  () => {
    const accounts = listAccounts();
    const output = { count: accounts.length, accounts };
    const text =
      accounts.length === 0
        ? "No Gmail accounts connected. Run `npm run add-account` to connect one."
        : `Connected accounts (${accounts.length}):\n` +
          accounts.map((a) => `- ${a}`).join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: output,
    };
  }
);

// ---------------------------------------------------------------------------
// gmail_search_threads
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_search_threads",
  {
    title: "Search Gmail Threads",
    description: `Search email threads in a connected account using Gmail's query syntax.

Supports the same operators as the Gmail search box, e.g. "from:alice@x.com", "subject:invoice", "is:unread", "after:2026/01/01 has:attachment".

Args:
  - query (string): Gmail search query. Required.
  - account (string, optional): Which connected account to search.
  - max_results (number): 1-100, default 20.
  - page_token (string, optional): Opaque token from a previous call's "next_page_token", to fetch the next page of results for the same query.

Returns: JSON {
  "account": string,
  "count": number,
  "threads": [ { "thread_id": string, "subject": string, "from": string, "date": string, "snippet": string, "error"?: string } ],
  "next_page_token"?: string
}
"next_page_token" is present only when more results are available; pass it back as "page_token" (with the same query) to fetch the next page. If an individual thread's details can't be fetched, that entry includes an "error" string (and empty subject/from/date) instead of the search failing.`,
    inputSchema: {
      query: z
        .string()
        .min(1, "query is required")
        .max(500)
        .describe('Gmail search query, e.g. "from:alice is:unread"'),
      account: accountField,
      max_results: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of threads to return per page (1-100)"),
      page_token: z
        .string()
        .optional()
        .describe(
          "Opaque pagination token from a previous response's next_page_token; fetches the next page for the same query."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, account, max_results, page_token }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const list = await withRetry(() =>
        gmail.users.threads.list({
          userId: "me",
          q: query,
          maxResults: max_results,
          ...(page_token ? { pageToken: page_token } : {}),
        })
      );
      const threads = list.data.threads || [];
      // Fetch lightweight metadata for each thread's first message, bounding the
      // fan-out so large result sets don't trip Gmail's rate limit. A single
      // thread's fetch failing degrades to an entry with an `error` field rather
      // than failing the whole search (see summarizeThread).
      const detailed = await mapWithConcurrency(
        threads,
        THREAD_FETCH_CONCURRENCY,
        (t) => summarizeThread(gmail, t)
      );
      // Surface Gmail's pagination cursor so callers can fetch the next page;
      // present only when more results exist for this query.
      const nextPageToken = list.data.nextPageToken || undefined;
      const output = {
        account: acct,
        count: detailed.length,
        threads: detailed,
        ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
      };
      const text =
        detailed.length === 0
          ? `No threads found for query '${query}' in ${acct}.`
          : renderJsonText(output, "Refine your query.");
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// gmail_get_thread
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_get_thread",
  {
    title: "Get Gmail Thread",
    description: `Retrieve the full content of a single email thread, including every message's headers and plain-text body.

Args:
  - thread_id (string): The thread ID (from gmail_search_threads). Required.
  - account (string, optional): Which connected account to read from.

Returns: JSON {
  "account": string,
  "thread_id": string,
  "messages": [ { "message_id": string, "from": string, "to": string, "date": string, "subject": string, "body": string, "label_ids": string[] } ]
}

For very large threads the result may be truncated: "truncated": true is set, and "omitted_message_count" reports how many of the oldest messages were dropped (the newest are kept). When the combined bodies exceed the size budget, the newest messages' bodies are kept and older ones are replaced with an omission marker.`,
    inputSchema: {
      thread_id: z.string().min(1).describe("Thread ID to fetch"),
      account: accountField,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ thread_id, account }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const res = await withRetry(() =>
        gmail.users.threads.get({
          userId: "me",
          id: thread_id,
          format: "full",
        })
      );
      // Bound the message count first (slice the raw list), then bound the
      // bodies. Bodies are extracted lazily inside capMessageBodies, so bodies
      // past the size budget aren't decoded/HTML-stripped at all.
      const rawMessages = res.data.messages || [];
      const omittedMessages = Math.max(0, rawMessages.length - MAX_THREAD_MESSAGES);
      // Keep the NEWEST messages when a thread exceeds the cap. Gmail returns a
      // thread oldest-first, and the most recent messages are the ones a reader
      // usually wants, so drop from the front (oldest) rather than the tail.
      // slice(-N) returns the whole array when there are fewer than N messages.
      const kept = rawMessages.slice(-MAX_THREAD_MESSAGES);
      // Spend the body budget on the NEWEST messages first, for the same reason
      // the count cap keeps them: when a thread's bodies exceed the budget, the
      // latest replies must be the ones that survive, not the oldest. Feed
      // capMessageBodies the list reversed (it spends its budget in array
      // order), then restore chronological order for the output. Extraction is
      // per-message fault-isolated (extractPlainTextSafe) so one hostile or
      // malformed body degrades to a marker instead of failing the whole read.
      const { messages: cappedNewestFirst, truncated: bodyTruncated } =
        capMessageBodies([...kept].reverse(), MAX_THREAD_BODY_CHARS, (m) =>
          extractPlainTextSafe(m.payload)
        );
      const capped = cappedNewestFirst.reverse();
      const messages = capped.map((m) => ({
        message_id: requireField(m.id, "message.id"),
        from: header(m.payload, "From"),
        to: header(m.payload, "To"),
        date: header(m.payload, "Date"),
        subject: header(m.payload, "Subject"),
        body: m.body,
        label_ids: m.labelIds || [],
      }));
      const truncated = bodyTruncated || omittedMessages > 0;
      const output = {
        account: acct,
        thread_id,
        messages,
        ...(truncated ? { truncated: true } : {}),
        ...(omittedMessages > 0 ? { omitted_message_count: omittedMessages } : {}),
      };
      // Prefer the full JSON. If it's over the character budget, fall back to a
      // compact per-message summary (ids, headers, body sizes) that points at
      // structuredContent for the authoritative content — far more useful than a
      // bare "too large" notice. If even that summary is over budget (a thread
      // with very many messages), fall back to the notice.
      const fullJson = JSON.stringify(output, null, 2);
      let text: string;
      if (fullJson.length <= CHARACTER_LIMIT) {
        text = fullJson;
      } else {
        const summary = [
          `Thread ${thread_id} in ${acct}: ${messages.length} message(s)` +
            `${truncated ? " (truncated)" : ""}.`,
          omittedMessages > 0
            ? `${omittedMessages} older message(s) omitted.`
            : "",
          "Full headers and bodies are in structuredContent. Per-message summary:",
          ...messages.map(
            (m) =>
              `- [${m.message_id}] ${m.from || "(unknown sender)"} — ` +
              `${m.subject || "(no subject)"}` +
              `${m.date ? ` (${m.date})` : ""}; body ${m.body.length} chars`
          ),
        ]
          .filter(Boolean)
          .join("\n");
        text =
          summary.length <= CHARACTER_LIMIT
            ? summary
            : // Reuse the length we already computed for fullJson rather than
              // re-serializing inside renderJsonText (#4).
              jsonTooLargeNotice(
                fullJson.length,
                "Thread is very large; read messages individually."
              );
      }
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// gmail_create_draft
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_create_draft",
  {
    title: "Create Gmail Draft",
    description: `Create a draft email in a connected account. Does NOT send it.

Use for composing messages the user will review/send manually, or as a safe alternative to sending.

Args:
  - to (string[]): Recipient email addresses. Required.
  - subject (string, optional): Subject line. When omitted on a reply (thread_id set), defaults to the thread's subject, prefixed with "Re:".
  - body (string): Message body. Plain text by default, or HTML when is_html is true. Required.
  - is_html (boolean, optional): Treat body as HTML (default false).
  - attachments (object[], optional): Files to attach. Each item provides exactly one of 'path' (local file the server reads) or 'content_base64' (inline base64). 'filename' defaults to the basename for path, required for content_base64; 'mime_type' inferred from extension if omitted.
  - cc (string[], optional), bcc (string[], optional).
  - account (string, optional): Which connected account to draft from.
  - thread_id (string, optional): Attach the draft as a reply within this thread.

Returns: JSON { "account": string, "draft_id": string, "message_id": string }`,
    inputSchema: {
      to: z
        .array(recipientSchema)
        .min(1)
        .describe('Recipients, each "email@host" or \'Name <email@host>\''),
      subject: z
        .string()
        .optional()
        .describe(
          "Subject line. Optional when replying (thread_id set): defaults to the thread's subject prefixed with 'Re:'."
        ),
      body: z
        .string()
        .describe("Message body (plain text, or HTML when is_html is true)"),
      is_html: z
        .boolean()
        .optional()
        .describe("Treat body as HTML instead of plain text (default false)"),
      attachments: z
        .array(attachmentSchema)
        .optional()
        .describe("Files to attach (each via local 'path' or inline 'content_base64')"),
      cc: z.array(recipientSchema).optional().describe("CC recipients"),
      bcc: z.array(recipientSchema).optional().describe("BCC recipients"),
      account: accountField,
      thread_id: z
        .string()
        .optional()
        .describe("Optional thread ID to attach this draft to as a reply"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ to, subject, body, is_html, attachments, cc, bcc, account, thread_id }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const resolvedAttachments = resolveAttachments(attachments);
      // When drafting into a thread, derive threading headers from it so Gmail
      // associates the draft as a reply.
      const reply = thread_id
        ? await withRetry(() => getThreadReplyHeaders(gmail, thread_id))
        : undefined;
      const { inReplyTo, references } = buildReplyHeaders(reply);
      const raw = buildRawMessage({
        from: acct,
        to,
        cc,
        bcc,
        subject: deriveReplySubject(subject, reply?.subject),
        body,
        isHtml: is_html,
        attachments: resolvedAttachments,
        inReplyTo,
        references,
      });
      // idempotent:false → retry only on 429, so a transient 5xx after the
      // draft was already created can't leave a duplicate draft behind.
      const res = await withRetry(
        () =>
          gmail.users.drafts.create({
            userId: "me",
            requestBody: {
              message: { raw, ...(thread_id ? { threadId: thread_id } : {}) },
            },
          }),
        { idempotent: false }
      );
      const output = {
        account: acct,
        draft_id: requireField(res.data.id, "draft.id"),
        message_id: res.data.message?.id || "",
      };
      return {
        content: [
          {
            type: "text",
            text: `Draft created in ${acct} (draft_id: ${output.draft_id}).`,
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// gmail_send_message
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_send_message",
  {
    title: "Send Gmail Message",
    description: `Send an email immediately from a connected account. This delivers mail — use gmail_create_draft instead if the user wants to review first.

Args:
  - to (string[]): Recipient email addresses. Required.
  - subject (string, optional): Subject line. When omitted on a reply (thread_id set), defaults to the thread's subject, prefixed with "Re:".
  - body (string): Message body. Plain text by default, or HTML when is_html is true. Required.
  - is_html (boolean, optional): Treat body as HTML (default false).
  - attachments (object[], optional): Files to attach. Each item provides exactly one of 'path' (local file the server reads) or 'content_base64' (inline base64). 'filename' defaults to the basename for path, required for content_base64; 'mime_type' inferred from extension if omitted.
  - cc (string[], optional), bcc (string[], optional).
  - account (string, optional): Which connected account to send from.
  - thread_id (string, optional): Send as a reply within this thread.
  - in_reply_to (string, optional): Message-ID header of the message being replied to (improves threading).

Returns: JSON { "account": string, "message_id": string, "thread_id": string }`,
    inputSchema: {
      to: z
        .array(recipientSchema)
        .min(1)
        .describe('Recipients, each "email@host" or \'Name <email@host>\''),
      subject: z
        .string()
        .optional()
        .describe(
          "Subject line. Optional when replying (thread_id set): defaults to the thread's subject prefixed with 'Re:'."
        ),
      body: z
        .string()
        .describe("Message body (plain text, or HTML when is_html is true)"),
      is_html: z
        .boolean()
        .optional()
        .describe("Treat body as HTML instead of plain text (default false)"),
      attachments: z
        .array(attachmentSchema)
        .optional()
        .describe("Files to attach (each via local 'path' or inline 'content_base64')"),
      cc: z.array(recipientSchema).optional().describe("CC recipients"),
      bcc: z.array(recipientSchema).optional().describe("BCC recipients"),
      account: accountField,
      thread_id: z
        .string()
        .optional()
        .describe("Optional thread ID to send this message into as a reply"),
      in_reply_to: z
        .string()
        .optional()
        .describe("Optional Message-ID header value of the message being replied to"),
    },
    annotations: {
      readOnlyHint: false,
      // Sending delivers mail immediately and can't be undone. Flag it
      // destructive so MCP hosts can gate it behind a confirmation, unlike the
      // read tools and the reversible draft/label writes.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    to,
    subject,
    body,
    is_html,
    attachments,
    cc,
    bcc,
    account,
    thread_id,
    in_reply_to,
  }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const resolvedAttachments = resolveAttachments(attachments);
      // When sending into a thread, derive threading headers from it. An
      // explicit in_reply_to still wins for In-Reply-To; buildReplyHeaders then
      // makes the References chain terminate with it, so the two headers agree.
      const reply = thread_id
        ? await withRetry(() => getThreadReplyHeaders(gmail, thread_id))
        : undefined;
      const { inReplyTo, references } = buildReplyHeaders(reply, in_reply_to);
      const raw = buildRawMessage({
        from: acct,
        to,
        cc,
        bcc,
        subject: deriveReplySubject(subject, reply?.subject),
        body,
        isHtml: is_html,
        attachments: resolvedAttachments,
        inReplyTo,
        references,
      });
      // idempotent:false → retry only on 429 (rejected before processing), so a
      // transient 5xx after Gmail already sent the message can't deliver a
      // duplicate copy.
      const res = await withRetry(
        () =>
          gmail.users.messages.send({
            userId: "me",
            requestBody: { raw, ...(thread_id ? { threadId: thread_id } : {}) },
          }),
        { idempotent: false }
      );
      const output = {
        account: acct,
        message_id: requireField(res.data.id, "message.id"),
        thread_id: res.data.threadId || "",
      };
      return {
        content: [
          {
            type: "text",
            text: `Message sent from ${acct} (message_id: ${output.message_id}).`,
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// gmail_list_labels
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_list_labels",
  {
    title: "List Gmail Labels",
    description: `List all labels in a connected account (system labels like INBOX/UNREAD and user-created labels).

Use to discover label IDs needed by gmail_modify_labels.

Args:
  - account (string, optional): Which connected account to read from.

Returns: JSON { "account": string, "labels": [ { "id": string, "name": string, "type": string } ] }`,
    inputSchema: { account: accountField },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ account }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const res = await withRetry(() => gmail.users.labels.list({ userId: "me" }));
      const labels = (res.data.labels || []).map((l) => ({
        id: requireField(l.id, "label.id"),
        name: requireField(l.name, "label.name"),
        type: l.type || "user",
      }));
      const output = { account: acct, labels };
      // Route through renderJsonText (like the other read tools) so an account
      // with very many labels can't emit text past the character budget; the
      // full list is always available in structuredContent.
      const text = renderJsonText(
        output,
        "Read the full label list from structuredContent."
      );
      return {
        content: [{ type: "text", text }],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// gmail_create_label
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_create_label",
  {
    title: "Create Gmail Label",
    description: `Create a new user label in a connected account.

Args:
  - name (string): Label name (use "/" for nesting, e.g. "Clients/Acme"). Required.
  - account (string, optional): Which connected account to create the label in.

Returns: JSON { "account": string, "id": string, "name": string }`,
    inputSchema: {
      name: z.string().min(1).describe('Label name, e.g. "Clients/Acme"'),
      account: accountField,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name, account }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const res = await withRetry(() =>
        gmail.users.labels.create({
          userId: "me",
          requestBody: {
            name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        })
      );
      const output = {
        account: acct,
        id: requireField(res.data.id, "label.id"),
        name: requireField(res.data.name, "label.name"),
      };
      return {
        content: [
          {
            type: "text",
            text: `Label '${output.name}' created in ${acct} (id: ${output.id}).`,
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// gmail_modify_labels
// ---------------------------------------------------------------------------
server.registerTool(
  "gmail_modify_labels",
  {
    title: "Modify Gmail Labels on a Thread or Message",
    description: `Add and/or remove labels on a thread or a single message. Also used to mark read/unread (remove/add the "UNREAD" label) or archive (remove "INBOX").

Provide exactly one of thread_id or message_id.

Args:
  - thread_id (string, optional): Apply to a whole thread.
  - message_id (string, optional): Apply to a single message.
  - add_label_ids (string[], optional): Label IDs to add (use gmail_list_labels to find IDs).
  - remove_label_ids (string[], optional): Label IDs to remove.
  - account (string, optional): Which connected account to act on.

Returns: JSON { "account": string, "target": string, "id": string, "label_ids": string[] }`,
    inputSchema: {
      thread_id: z.string().optional().describe("Thread ID to modify"),
      message_id: z.string().optional().describe("Message ID to modify"),
      add_label_ids: z
        .array(z.string())
        .optional()
        .describe('Label IDs to add, e.g. ["UNREAD"] or a user label ID'),
      remove_label_ids: z
        .array(z.string())
        .optional()
        .describe('Label IDs to remove, e.g. ["UNREAD"] to mark as read'),
      account: accountField,
    },
    annotations: {
      readOnlyHint: false,
      // Removing labels is a non-additive change, and adding "TRASH"/"SPAM"
      // moves mail out of the inbox (recoverable, but not additive). Flag the
      // tool destructive so hosts can gate it behind a confirmation, rather
      // than letting a label edit slip past the same prompt that guards sends.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ thread_id, message_id, add_label_ids, remove_label_ids, account }) => {
    try {
      // Exactly one of thread_id / message_id must be set. Capture it as a
      // discriminated target so its id is a definite string downstream — no
      // non-null assertion needed.
      const target = thread_id
        ? ({ kind: "thread", id: thread_id } as const)
        : message_id
          ? ({ kind: "message", id: message_id } as const)
          : null;
      if (!target || (thread_id && message_id)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide exactly one of thread_id or message_id.",
            },
          ],
          isError: true,
        };
      }
      if (!add_label_ids?.length && !remove_label_ids?.length) {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide at least one of add_label_ids or remove_label_ids.",
            },
          ],
          isError: true,
        };
      }
      const { gmail, account: acct } = gmailFor(account);
      const requestBody = {
        addLabelIds: add_label_ids || [],
        removeLabelIds: remove_label_ids || [],
      };
      let id: string;
      let labelIds: string[];
      if (target.kind === "thread") {
        const res = await withRetry(() =>
          gmail.users.threads.modify({
            userId: "me",
            id: target.id,
            requestBody,
          })
        );
        id = requireField(res.data.id, "thread.id");
        // A thread modify applies to every message, which may then carry
        // differing labels; report the union across the thread rather than just
        // the first message's, which would misrepresent the result.
        const labelSet = new Set<string>();
        for (const m of res.data.messages || []) {
          for (const l of m.labelIds || []) labelSet.add(l);
        }
        labelIds = [...labelSet];
      } else {
        const res = await withRetry(() =>
          gmail.users.messages.modify({
            userId: "me",
            id: target.id,
            requestBody,
          })
        );
        id = requireField(res.data.id, "message.id");
        labelIds = res.data.labelIds || [];
      }
      const output = {
        account: acct,
        target: target.kind,
        id,
        label_ids: labelIds,
      };
      return {
        content: [
          {
            type: "text",
            text: `Updated labels on ${output.target} ${id} in ${acct}.`,
          },
        ],
        structuredContent: output,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleGmailError(error) }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  cleanupStaleTokenTemps();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const accounts = listAccounts();
  console.error(
    `gmail-mcp-server running via stdio. Connected accounts: ${
      accounts.length ? accounts.join(", ") : "none (run `npm run add-account`)"
    }`
  );
}

// Only start the server when invoked directly (not when imported, e.g. by tests).
if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
