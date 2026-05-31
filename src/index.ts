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
import { listAccounts } from "./auth.js";
import {
  buildRawMessage,
  extractPlainText,
  getThreadReplyHeaders,
  gmailFor,
  handleGmailError,
  header,
  mapWithConcurrency,
  resolveAttachments,
} from "./gmail.js";
import { CHARACTER_LIMIT, THREAD_FETCH_CONCURRENCY } from "./constants.js";

/**
 * Shared attachment schema. Each attachment provides exactly one of `path`
 * (read from local disk by the server) or `content_base64` (inline). For
 * `path`, filename and mime_type are inferred if omitted; for `content_base64`,
 * filename is required.
 */
const attachmentSchema = z
  .object({
    filename: z
      .string()
      .optional()
      .describe(
        "Display filename. Defaults to the basename for 'path'; required for 'content_base64'."
      ),
    path: z
      .string()
      .optional()
      .describe(
        "Absolute or relative path to a local file on the machine running the server."
      ),
    content_base64: z
      .string()
      .optional()
      .describe("Inline file content, standard base64-encoded."),
    mime_type: z
      .string()
      .optional()
      .describe("MIME type. Inferred from the filename extension if omitted."),
  })
  .strict();

const server = new McpServer({
  name: "gmail-mcp-server",
  version: "1.0.0",
});

/** Shared optional account selector for all tools. */
const accountField = z
  .string()
  .email()
  .optional()
  .describe(
    "Email address of the connected Gmail account to use. Optional when only one account is connected; required to disambiguate when several are."
  );

/** Truncate an oversized text payload with a clear note. */
function capText(text: string, note: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Truncated at ${CHARACTER_LIMIT} characters. ${note}]`
  );
}

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
  async () => {
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

Returns: JSON {
  "account": string,
  "count": number,
  "threads": [ { "thread_id": string, "subject": string, "from": string, "date": string, "snippet": string } ]
}`,
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
        .describe("Maximum number of threads to return (1-100)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, account, max_results }) => {
    try {
      const { gmail, account: acct } = gmailFor(account);
      const list = await gmail.users.threads.list({
        userId: "me",
        q: query,
        maxResults: max_results,
      });
      const threads = list.data.threads || [];
      // Fetch lightweight metadata for each thread's first message, bounding the
      // fan-out so large result sets don't trip Gmail's rate limit.
      const detailed = await mapWithConcurrency(
        threads,
        THREAD_FETCH_CONCURRENCY,
        async (t) => {
          const full = await gmail.users.threads.get({
            userId: "me",
            id: t.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const first = full.data.messages?.[0];
          return {
            thread_id: t.id!,
            subject: header(first?.payload, "Subject"),
            from: header(first?.payload, "From"),
            date: header(first?.payload, "Date"),
            snippet: first?.snippet || t.snippet || "",
          };
        }
      );
      const output = { account: acct, count: detailed.length, threads: detailed };
      const text =
        detailed.length === 0
          ? `No threads found for query '${query}' in ${acct}.`
          : capText(JSON.stringify(output, null, 2), "Refine your query.");
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
}`,
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
      const res = await gmail.users.threads.get({
        userId: "me",
        id: thread_id,
        format: "full",
      });
      const messages = (res.data.messages || []).map((m) => ({
        message_id: m.id!,
        from: header(m.payload, "From"),
        to: header(m.payload, "To"),
        date: header(m.payload, "Date"),
        subject: header(m.payload, "Subject"),
        body: extractPlainText(m.payload),
        label_ids: m.labelIds || [],
      }));
      const output = { account: acct, thread_id, messages };
      const text = capText(
        JSON.stringify(output, null, 2),
        "Thread body was large; consider reading messages individually."
      );
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
  - subject (string): Subject line. Required.
  - body (string): Message body. Plain text by default, or HTML when is_html is true. Required.
  - is_html (boolean, optional): Treat body as HTML (default false).
  - attachments (object[], optional): Files to attach. Each item provides exactly one of 'path' (local file the server reads) or 'content_base64' (inline base64). 'filename' defaults to the basename for path, required for content_base64; 'mime_type' inferred from extension if omitted.
  - cc (string[], optional), bcc (string[], optional).
  - account (string, optional): Which connected account to draft from.
  - thread_id (string, optional): Attach the draft as a reply within this thread.

Returns: JSON { "account": string, "draft_id": string, "message_id": string }`,
    inputSchema: {
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses"),
      subject: z.string().describe("Subject line"),
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
      cc: z.array(z.string().email()).optional().describe("CC recipients"),
      bcc: z.array(z.string().email()).optional().describe("BCC recipients"),
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
        ? await getThreadReplyHeaders(gmail, thread_id)
        : undefined;
      const raw = buildRawMessage({
        from: acct,
        to,
        cc,
        bcc,
        subject,
        body,
        isHtml: is_html,
        attachments: resolvedAttachments,
        inReplyTo: reply?.inReplyTo,
        references: reply?.references,
      });
      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw, ...(thread_id ? { threadId: thread_id } : {}) },
        },
      });
      const output = {
        account: acct,
        draft_id: res.data.id!,
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
  - subject (string): Subject line. Required.
  - body (string): Message body. Plain text by default, or HTML when is_html is true. Required.
  - is_html (boolean, optional): Treat body as HTML (default false).
  - attachments (object[], optional): Files to attach. Each item provides exactly one of 'path' (local file the server reads) or 'content_base64' (inline base64). 'filename' defaults to the basename for path, required for content_base64; 'mime_type' inferred from extension if omitted.
  - cc (string[], optional), bcc (string[], optional).
  - account (string, optional): Which connected account to send from.
  - thread_id (string, optional): Send as a reply within this thread.
  - in_reply_to (string, optional): Message-ID header of the message being replied to (improves threading).

Returns: JSON { "account": string, "message_id": string, "thread_id": string }`,
    inputSchema: {
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses"),
      subject: z.string().describe("Subject line"),
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
      cc: z.array(z.string().email()).optional().describe("CC recipients"),
      bcc: z.array(z.string().email()).optional().describe("BCC recipients"),
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
      destructiveHint: false,
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
      // explicit in_reply_to still wins for In-Reply-To; the References chain
      // comes from the thread when available so Gmail keeps the conversation.
      const reply = thread_id
        ? await getThreadReplyHeaders(gmail, thread_id)
        : undefined;
      const inReplyTo = in_reply_to || reply?.inReplyTo;
      const references = reply?.references || in_reply_to;
      const raw = buildRawMessage({
        from: acct,
        to,
        cc,
        bcc,
        subject,
        body,
        isHtml: is_html,
        attachments: resolvedAttachments,
        inReplyTo,
        references,
      });
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, ...(thread_id ? { threadId: thread_id } : {}) },
      });
      const output = {
        account: acct,
        message_id: res.data.id!,
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
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => ({
        id: l.id!,
        name: l.name!,
        type: l.type || "user",
      }));
      const output = { account: acct, labels };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
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
      const res = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      const output = { account: acct, id: res.data.id!, name: res.data.name! };
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
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ thread_id, message_id, add_label_ids, remove_label_ids, account }) => {
    try {
      if ((thread_id && message_id) || (!thread_id && !message_id)) {
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
      if (thread_id) {
        const res = await gmail.users.threads.modify({
          userId: "me",
          id: thread_id,
          requestBody,
        });
        id = res.data.id!;
        labelIds = res.data.messages?.[0]?.labelIds || [];
      } else {
        const res = await gmail.users.messages.modify({
          userId: "me",
          id: message_id!,
          requestBody,
        });
        id = res.data.id!;
        labelIds = res.data.labelIds || [];
      }
      const output = {
        account: acct,
        target: thread_id ? "thread" : "message",
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const accounts = listAccounts();
  console.error(
    `gmail-mcp-server running via stdio. Connected accounts: ${
      accounts.length ? accounts.join(", ") : "none (run `npm run add-account`)"
    }`
  );
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
