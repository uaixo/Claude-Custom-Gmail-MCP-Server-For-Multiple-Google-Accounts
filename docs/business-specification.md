# Business Specification — Multi-Account Mailbox MCP Server

> **Status:** Draft v1.0 · **Type:** Business + Functional specification (provider-neutral)
> **Reference implementation:** this repository — a Gmail MCP server with multi-account support.
> **Primary build target:** an equivalent MCP server for **multiple Microsoft Outlook / Microsoft 365 accounts**.

---

## 0. How to read this document

This is a **provider-neutral** specification. It describes *what* the product does
and *why*, at a level that is independent of any one email provider. The existing
**Gmail** server is used as the **proven reference**; the **Outlook / Microsoft 365**
server is the **build target**.

- Requirements are written generically against an abstract **"mail provider."**
- Wherever a requirement depends on provider specifics, a **▶ Provider mapping**
  callout records the Gmail behaviour (today) and the Outlook/Microsoft Graph
  equivalent (to build).
- Requirements carry stable IDs (`FR-*`, `NFR-*`, `CON-*`) so a downstream
  spec-driven build can trace each delivered behaviour back to this document and
  generate acceptance tests from the **Acceptance criteria** in §13.

Audience: product owners, engineers, and AI coding agents implementing the Outlook
variant (or any future provider) from this specification.

The full Gmail→Outlook concept and API mapping lives in **Appendix A (§16)**.

---

## 1. Product vision & problem statement

### 1.1 Vision
A **local, single-connector bridge** that lets an AI assistant (an MCP host such as
Claude) operate **several of a user's mailboxes at once** — searching, reading,
composing, sending, and organising mail — through one consistent, safety-annotated
tool surface, with credentials that **never leave the user's machine**.

### 1.2 Problem
First-party AI email connectors typically bind **one account per connection**. A user
with multiple mailboxes (personal + several work/clients) cannot ask the assistant to
work across all of them without juggling connectors, and cannot disambiguate "which
account" inside a single request.

> This is a *product* limitation of one-account-per-connection connectors, **not** a
> limitation of the Model Context Protocol. The reference Gmail server demonstrates
> that one MCP connector can serve many accounts. The Outlook product must deliver the
> same advantage for Microsoft 365 / Outlook.com users.

### 1.3 Value proposition
- **One connector, many mailboxes** — connect any number of accounts; pick the target
  per request, or let the server default when only one is connected.
- **Local-first & private** — OAuth tokens are stored only on the user's machine;
  mail content flows machine ↔ provider, never through a third-party service.
- **Safe by default** — irreversible actions (sending, destructive label/folder
  changes) are explicitly annotated so the host can require user confirmation.
- **Least-privilege** — only the OAuth scopes strictly required are requested.

---

## 2. Goals & non-goals

### 2.1 Goals
1. Serve **multiple accounts of one mail provider** through a single MCP server.
2. Provide a complete **core mail workflow**: list accounts, search, read, draft,
   send, and organise (labels/categories/folders).
3. Make **account selection** a first-class, low-friction concept.
4. Keep **authentication local, per-account, and least-privilege**.
5. Be **safe**: annotate destructive actions; never silently email arbitrary local files.
6. Be **resilient**: bound every provider call in time, retry transient failures
   without ever duplicating a send.
7. Run cross-platform (Windows + macOS) with a simple one-time setup.

### 2.2 Non-goals (v1)
- Not a full email *client* (no rich rendering, no real-time push/IMAP IDLE).
- Not a multi-user/server-hosted SaaS by default (local stdio per user; remote
  deployment is an explicit *future* option — §15).
- Not a calendar/contacts product in v1 (those are **future scope** — §15).
- No cross-provider federation in one server instance (one server = one provider;
  Gmail and Outlook are separate servers built from this shared spec).

---

## 3. Personas & primary use cases

### 3.1 Personas
- **The multi-mailbox professional (primary).** Runs personal + several work/client
  mailboxes; wants the assistant to triage, draft, and send from the right identity.
- **The power user / consultant.** Mailboxes spread across **different organisations**
  (different OAuth clients/tenants); needs each account authorised under its own client.
- **The privacy-conscious user.** Will only adopt a tool whose credentials and mail
  stay on their own machine.
- **The developer/integrator.** Embeds the server into an MCP host or extends it to a
  new provider — and is the consumer of *this* specification.

### 3.2 Primary use cases
1. "**Which mailboxes are connected?**" → list accounts.
2. "**Find …**" across a chosen mailbox → search, page through results, read a thread.
3. "**Draft a reply** to this thread" → compose a non-sending draft for human review.
4. "**Send** this message from my work account" → deliver immediately (gated as
   destructive).
5. "**Archive / mark read / categorise** these messages" → organise without deleting.
6. "**Connect another mailbox**" → one-time browser consent, then it's available.

---

## 4. Provider abstraction model (the key to reuse)

To build the same product on a different provider, implementations MUST map the
following **neutral domain concepts** onto provider primitives. Functional
requirements in §6 are written against these neutral terms.

| Neutral concept | Definition | Gmail (reference) | Outlook / MS Graph (target) |
| --- | --- | --- | --- |
| **Account** | One authenticated mailbox identity | Google account email | Microsoft account (UPN / primary SMTP) |
| **Conversation** | A grouping of related messages | Thread (`threadId`) | Conversation (`conversationId`) |
| **Message** | A single email | Message (`id`) | Message (`id`) |
| **Search query** | User-expressible filter over mail | Gmail search operators | Graph `$search` + OData `$filter` |
| **Result cursor** | Opaque "next page" token | `nextPageToken` | `@odata.nextLink` / `$skiptoken` |
| **Organisation label** | A tag/state applied to mail | Label (incl. system: `INBOX`, `UNREAD`, `TRASH`) | **Category** (tag) **+ mailFolder** (location) + flags (`isRead`) |
| **Draft** | Unsent, editable message | Draft resource | Draft message (`isDraft`) |
| **Send** | Irreversible delivery | `messages.send` | `sendMail` / send draft |
| **Reply threading** | Headers that file a reply into a conversation | RFC 5322 `In-Reply-To`/`References` | Graph `createReply`/`conversationId`, or MIME equivalents |

> **Critical mapping note.** Gmail collapses *tagging*, *foldering*, and *read-state*
> into one "label" concept. Outlook splits these: **categories** (tags), **mailFolders**
> (location, e.g. Archive/Junk), and **flags** (`isRead`). The neutral "organise mail"
> capability (§6.4) MUST be designed so a single provider-neutral request can be
> fulfilled by the right combination of Graph operations. This is the single largest
> design difference between the two providers.

---

## 5. Capability overview

The product exposes these capability areas as MCP tools. Tool **names**, exact
parameters, and provider operations are provider-specific; the **capabilities** are not.

| # | Capability | Reference tool (Gmail) | Destructive? | Future variant (Outlook) |
| --- | --- | --- | --- | --- |
| C1 | List connected accounts | `gmail_list_accounts` | No (read) | `outlook_list_accounts` |
| C2 | Search conversations | `gmail_search_threads` | No (read) | `outlook_search_messages` |
| C3 | Read a full conversation | `gmail_get_thread` | No (read) | `outlook_get_conversation` |
| C4 | Create a draft | `gmail_create_draft` | No (reversible write) | `outlook_create_draft` |
| C5 | Send a message | `gmail_send_message` | **Yes** | `outlook_send_message` |
| C6 | List organisation labels | `gmail_list_labels` | No (read) | `outlook_list_categories_folders` |
| C7 | Create a label | `gmail_create_label` | No (additive write) | `outlook_create_category` |
| C8 | Organise mail (add/remove labels, read-state, archive) | `gmail_modify_labels` | **Yes** | `outlook_organize_message` |

Plus an **out-of-band account-management CLI** (connect / list / remove accounts) —
see §8.

---

## 6. Functional requirements

Each tool MUST accept an **optional account selector** and follow the selection rule
(§7). Each tool MUST return both a human-readable summary and a structured result
(§11), and MUST map provider errors to actionable messages (§9).

### 6.1 C1 — List connected accounts
- **FR-C1-1.** Return the set of accounts currently connected to this server, as
  identity strings (email/UPN).
- **FR-C1-2.** When none are connected, return a non-error result that instructs the
  user how to connect one.
- **FR-C1-3.** This is the discovery entry point: its output supplies valid values for
  every other tool's account selector.
- *Annotations:* read-only, non-destructive, idempotent, closed-world.

### 6.2 C2 — Search conversations
- **FR-C2-1.** Accept a **required** provider-style query string and search the chosen
  account's mail.
- **FR-C2-2.** Accept a **page size** (default 20; bounded maximum 100) and return at
  most that many conversation summaries per call.
- **FR-C2-3.** Support **pagination**: when more results exist, return an opaque
  next-page cursor; accept that cursor on a subsequent call (with the same query) to
  fetch the next page.
- **FR-C2-4.** Each summary SHOULD include a stable conversation id, subject, sender,
  date, and a snippet.
- **FR-C2-5.** If a single conversation's summary cannot be fetched, **degrade that
  entry** (mark it with an error field) rather than failing the whole search.
- **FR-C2-6.** Bound the fan-out of per-conversation detail fetches to respect provider
  rate limits.
- *Annotations:* read-only, non-destructive, idempotent, open-world.

> **▶ Provider mapping.** Gmail: `threads.list` (`q`, `maxResults`, `pageToken`) +
> per-thread `threads.get`. Outlook: `GET /me/messages` with `$search`/`$filter`,
> `$top`, and `@odata.nextLink`; group by `conversationId` (or
> `GET /me/conversations` where available). Gmail query operators must be re-expressed
> as Graph `$search` keywords / OData `$filter` (e.g. `is:unread` →
> `isRead eq false`, `from:x` → `from/emailAddress/address eq 'x'`).

### 6.3 C3 — Read a full conversation
- **FR-C3-1.** Given a conversation id, return every message's headers (from, to, date,
  subject), plain-text body, and applied labels/categories.
- **FR-C3-2.** **Bound the payload**: cap the number of messages returned (keep the
  **newest**), and cap total body characters; when truncation occurs, set a
  `truncated` flag and report how many older messages were omitted.
- **FR-C3-3.** Prefer returning HTML bodies as readable **plain text**.
- *Annotations:* read-only, non-destructive, idempotent, open-world.

> **▶ Provider mapping.** Gmail: `threads.get` (`format=full`), bodies base64url in MIME
> parts. Outlook: `GET /me/messages?$filter=conversationId eq '…'` or expand a
> conversation; use `body`/`uniqueBody` and prefer `text` content type (or convert
> HTML).

### 6.4 C4 — Create a draft
- **FR-C4-1.** Compose a draft with: one or more **recipients** (`to`), optional
  `cc`/`bcc`, optional `subject`, a `body`, and an `is_html` flag.
- **FR-C4-2.** **Do not send.** The draft must be persisted in the account for later
  human review/sending.
- **FR-C4-3.** Support **attachments**, each supplied as **exactly one of**: a local
  file **path** (server reads it — subject to NFR-SEC-3) **or** inline base64 content.
  Infer filename/MIME type where omitted; require filename for inline content.
- **FR-C4-4.** Support **reply drafting**: given a conversation id, derive threading so
  the draft is filed as a reply; when subject is omitted on a reply, default to the
  conversation's subject prefixed with `Re:`.
- **FR-C4-5.** Recipients accept a bare address or a `Display Name <addr>` form; the
  implementation MUST prevent header injection via recipient/subject values.
- *Annotations:* write, non-destructive (reversible), non-idempotent, open-world.

### 6.5 C5 — Send a message
- **FR-C5-1.** Same composition inputs as C4, plus an optional explicit
  reply-to-message reference to improve threading.
- **FR-C5-2.** **Deliver immediately.** This is irreversible.
- **FR-C5-3.** MUST be annotated **destructive** so the MCP host can gate it behind a
  user confirmation.
- **FR-C5-4.** MUST guarantee **no duplicate delivery** under retries (see NFR-REL-3).
- *Annotations:* write, **destructive**, non-idempotent, open-world.

> **▶ Provider mapping.** Gmail: build RFC 2822 `raw` and `messages.send`. Outlook:
> either `POST /me/sendMail` with a structured message JSON, or create a draft then
> `POST …/send`; attachments via `fileAttachment` resources or MIME upload.

### 6.6 C6 — List organisation labels
- **FR-C6-1.** Return all labels/categories available in the account, each with a stable
  id, a display name, and a type (system vs user-created).
- **FR-C6-2.** Output is the id-discovery source for C8.
- *Annotations:* read-only, non-destructive, idempotent, open-world.

> **▶ Provider mapping.** Gmail: `labels.list` (system + user labels). Outlook: combine
> `GET /me/outlook/masterCategories` (categories) and `GET /me/mailFolders` (folders);
> well-known states (read/unread, Archive, Junk) are flags/folders, not categories.

### 6.7 C7 — Create a label
- **FR-C7-1.** Create a new user label/category by name (support hierarchy/nesting where
  the provider does, e.g. `Clients/Acme`).
- *Annotations:* write, non-destructive (additive), non-idempotent, open-world.

> **▶ Provider mapping.** Gmail: `labels.create`. Outlook: `POST …/masterCategories`
> (categories have a colour preset, not nesting) **or** `POST /me/mailFolders` for a
> folder; the implementation chooses based on intent. Nesting maps to child mailFolders.

### 6.8 C8 — Organise mail (the unified "label" operation)
- **FR-C8-1.** Apply organisation changes to **exactly one** target: a whole
  conversation **or** a single message.
- **FR-C8-2.** Support **adding and/or removing** labels/categories in one call; require
  at least one change.
- **FR-C8-3.** Support the common derived intents: **mark read/unread** and **archive**
  (remove from inbox) via this same capability.
- **FR-C8-4.** When applied to a conversation, report the resulting state across the
  whole conversation (e.g. the union of labels), not just one message.
- **FR-C8-5.** MUST be annotated **destructive** (removals and moves to Trash/Junk are
  non-additive) so the host can gate it.
- *Annotations:* write, **destructive**, idempotent, open-world.

> **▶ Provider mapping.** Gmail: `threads.modify`/`messages.modify` with
> `addLabelIds`/`removeLabelIds`; read-state = toggle `UNREAD`; archive = remove
> `INBOX`. Outlook: this **fans out** — categories via `PATCH …/messages/{id}`
> (`categories[]`), read-state via `PATCH` (`isRead`), archive via `POST …/move`
> (to the Archive folder), Trash/Junk via `move` to Deleted Items/Junk. The neutral
> request must be decomposed into the right Graph calls.

---

## 7. Account & identity model

- **FR-ID-1 (optional selector).** Every tool except "list accounts" MUST accept an
  optional account selector (the account's email/UPN).
- **FR-ID-2 (default rule).** If the selector is omitted and **exactly one** account is
  connected, use it. If **several** are connected, return an actionable error asking the
  caller to specify one. If **none** are connected, return an actionable error telling
  the user to connect one.
- **FR-ID-3 (validation).** A specified-but-unknown account MUST fail with an error that
  lists the connected accounts.
- **FR-ID-4 (case-insensitive identity).** Account identity MUST be matched
  case-insensitively (store keyed by lower-cased identity).
- **FR-ID-5 (per-account credential binding).** Each account records **which OAuth
  client** authorised it; token refresh MUST always use that same client. (Refresh
  tokens are bound to the issuing client.)
- **FR-ID-6 (multiple OAuth clients).** Support accounts spread across **different OAuth
  clients** (e.g. different cloud projects / tenants), discovered from multiple
  credential files.

> **▶ Provider mapping.** Identity lookup after consent: Gmail `userinfo.email`; Outlook
> `GET /me` (`userPrincipalName` / `mail`). "OAuth client" = Google OAuth *Desktop app*
> client ↔ Microsoft **Entra ID app registration** (public client). Multiple clients ↔
> multiple app registrations and/or multiple tenants.

---

## 8. Authentication & onboarding

Authentication is **per-account OAuth**, performed **out-of-band** by a small CLI before
the MCP server is used. The server itself never initiates interactive consent.

- **FR-AUTH-1 (connect).** Provide a CLI command to connect a new account via an
  interactive browser **authorization-code** consent flow.
- **FR-AUTH-2 (loopback redirect).** Use a **loopback** redirect on `127.0.0.1` with a
  preferred fixed port and automatic fallback to an OS-assigned port if busy.
- **FR-AUTH-3 (PKCE).** Use PKCE (S256) so an intercepted authorization code cannot be
  exchanged without the matching verifier.
- **FR-AUTH-4 (CSRF state).** Generate a random `state`, round-trip it, and verify it on
  the callback; unrelated/forged callbacks MUST be answered neutrally **without**
  aborting the genuine flow.
- **FR-AUTH-5 (refresh token).** Request **offline access** so a long-lived refresh
  token is obtained; force re-consent issuance when needed.
- **FR-AUTH-6 (identify account).** After token exchange, look up the authenticated
  identity to key the stored tokens; abort if it can't be determined.
- **FR-AUTH-7 (consent timeout).** Bound the wait for consent (reference: 5 minutes) and
  fail with guidance if it elapses.
- **FR-AUTH-8 (manage accounts).** Provide CLI commands to **list** connected accounts
  (with the credential file each uses) and to **remove** an account.
- **FR-AUTH-9 (re-consent recovery).** If a refresh token is revoked, re-running connect
  MUST repair the account; a running server MUST pick up rewritten credentials on its
  next call **without a restart**.
- **FR-AUTH-10 (least privilege).** Request the minimum scopes needed for the supported
  capabilities (read+organise, send, identity) and nothing more.

> **▶ Provider mapping.** Gmail scopes (reference): `gmail.modify`, `gmail.send`,
> `userinfo.email`; *Desktop app* client allows loopback redirects with no extra config.
> Outlook scopes (target): `Mail.ReadWrite`, `Mail.Send`, `User.Read`, plus
> `offline_access`; register an Entra ID **public client** with redirect
> `http://localhost` (MSAL handles loopback). MSAL replaces google-auth-library for the
> consent + refresh mechanics.

---

## 9. Error handling & resilience requirements

- **FR-ERR-1.** Provider errors MUST be mapped to **actionable, human-readable** messages
  (e.g. auth expired → "re-connect this account"; rate limited → "try again shortly";
  timeout reported as a timeout) and returned as tool errors, not raised as crashes.
- **FR-ERR-2.** A malformed/corrupt local token store MUST NOT crash the server; treat it
  as "no accounts" and surface a one-time warning explaining how to repair it.
- **FR-ERR-3.** Validation errors (bad recipient, both/neither of mutually exclusive
  fields, missing required change) MUST be returned as clear errors before any provider
  call.

---

## 10. Non-functional requirements

### 10.1 Security & privacy
- **NFR-SEC-1 (local secrets).** OAuth tokens MUST be stored **only on the user's
  machine**, in a token store file with owner-only permissions (`600`), inside a data
  directory created owner-only (`700`). Mail content MUST NOT transit any third party.
- **NFR-SEC-2 (atomic, locked token writes).** Token-store writes MUST be atomic
  (temp-file + rename) and guarded by a **cross-process lock** with stale-lock recovery,
  so concurrent writers (server refresh + CLI connect) can't lose updates or expose a
  partial file.
- **NFR-SEC-3 (attachment path guard).** Reading local files by **path** for attachments
  MUST be **disabled by default** and only permitted from an explicit allow-listed
  directory set by configuration; paths MUST be fully resolved (symlinks, `..`) and
  validated to fall within an allowed directory **before** reading. This prevents the
  server being coerced into emailing arbitrary local files (keys, `.env`). Inline base64
  is always available as the safe alternative.
- **NFR-SEC-4 (TOCTOU-safe reads).** When a path attachment is allowed, open the resolved
  file **once** and validate via the open handle (no check-then-reopen window).
- **NFR-SEC-5 (header-injection safe).** Strip CR/LF from header-bound values
  (recipients, subject, filenames) so a display name or subject cannot inject headers.
- **NFR-SEC-6 (no secret logging).** Never log tokens, credentials, or message contents.
- **NFR-SEC-7 (consent-flow hardening).** Loopback callback server binds to loopback only
  and is short-lived; enforce PKCE + `state` (per §8).

### 10.2 Reliability
- **NFR-REL-1 (per-request timeout).** Every provider API call MUST have a bounded
  timeout (reference default 30s, configurable) so a stalled socket fails fast instead of
  hanging.
- **NFR-REL-2 (bounded retry).** Transient failures MUST be retried with **bounded,
  jittered backoff**.
- **NFR-REL-3 (no duplicate side effects).** **Send** and **draft-create** MUST retry
  **only** on pre-processing rate-limit rejections — never on ambiguous failures
  (transient 5xx or timeouts that may have succeeded) — so a retry can never deliver a
  duplicate. Read/organise operations may retry on rate limits, transient server errors,
  and transport failures.
- **NFR-REL-4 (concurrency bound).** Bulk per-item fetches (e.g. expanding search
  results) MUST cap concurrency to respect provider rate limits.

### 10.3 Performance & resource bounds
- **NFR-PERF-1.** Responses MUST be bounded to a character budget (reference 25,000),
  degrading gracefully (summaries / truncation flags) rather than emitting unbounded text.
- **NFR-PERF-2.** Thread/conversation reads MUST cap message count (reference 100) and
  combined body characters (reference 20,000), keeping newest content.
- **NFR-PERF-3.** Outgoing message size MUST be validated locally against the provider's
  limit (reference ~25 MB) before the API call, failing with a clear local error.

### 10.4 Output contract — see §11.

### 10.5 Compatibility & operability
- **NFR-OPS-1.** MUST run on **Node.js ≥ 18** on **Windows and macOS**.
- **NFR-OPS-2.** Default transport is **stdio**, launched by the MCP host; the server
  reports connected accounts to stderr on startup.
- **NFR-OPS-3.** All operational knobs (data dir, credentials path/selection, attachment
  allow-list, timeouts, lock timeout) MUST be configurable via environment variables
  (§12).
- **NFR-OPS-4 (safety annotations).** Every tool MUST carry MCP behavioural annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so hosts can
  gate destructive actions. Send and organise-mail MUST be `destructiveHint: true`.

---

## 11. Output / response contract

- **FR-OUT-1 (dual channel).** Every tool MUST return (a) a concise **human-readable**
  text summary and (b) a **structured** machine-readable result object.
- **FR-OUT-2 (authoritative structure).** When the human text is truncated for size, the
  structured result remains the authoritative, complete payload (within the documented
  caps).
- **FR-OUT-3 (stable shapes).** Result objects SHOULD use stable, documented field names
  (e.g. `account`, `count`, conversation/message ids, `next_page_token`, `truncated`,
  `omitted_message_count`). Optional fields appear only when meaningful.

---

## 12. Configuration requirements

The Outlook build SHOULD mirror this configuration surface (renaming the provider
prefix, e.g. `OUTLOOK_MCP_*`), preserving meaning:

| Neutral setting | Reference variable (Gmail) | Purpose |
| --- | --- | --- |
| Data directory | `GMAIL_MCP_DATA_DIR` | Where tokens + credential files live (default under `$HOME`) |
| Forced single OAuth client | `GMAIL_OAUTH_CREDENTIALS` | Pin one client file; disables auto-discovery |
| Attachment allow-list | `GMAIL_MCP_ATTACHMENTS_DIR` | Directories `path` attachments may be read from (unset = `path` disabled) |
| Token-lock timeout | `GMAIL_MCP_LOCK_TIMEOUT_MS` | Max wait for the token-store lock before failing a write |
| Per-request timeout | `GMAIL_MCP_REQUEST_TIMEOUT_MS` | Bound on each provider API call |

> **▶ Provider mapping.** The credential-file model (one or more `credentials*.json`
> *Desktop app* clients, auto-discovered) maps to one or more **Entra ID app
> registration** configs. The data-dir, allow-list, lock, and timeout semantics are
> provider-independent and carry over unchanged.

---

## 13. Acceptance criteria (build-readiness)

A provider implementation is **spec-complete** when:

1. **Multi-account.** With ≥2 accounts connected, each tool operates on the
   selector-named account; omitting the selector with several connected returns the
   disambiguation error; with one connected it defaults correctly. *(FR-ID-1..3)*
2. **Capabilities.** C1–C8 each satisfy their FRs, verified against a real provider
   sandbox account. *(§6)*
3. **Onboarding.** The connect CLI completes a PKCE + `state` loopback consent, stores a
   refresh token, identifies the account, and survives a re-consent without server
   restart. *(FR-AUTH-1..9)*
4. **No duplicate sends.** A forced transient-failure test on send/draft never produces a
   duplicate. *(NFR-REL-3)*
5. **Attachment guard.** Path reads are refused unless allow-listed and within an allowed
   directory; inline base64 always works. *(NFR-SEC-3..4)*
6. **Safety.** Send and organise-mail are annotated destructive; a host configured to
   confirm destructive tools is prompted. *(NFR-OPS-4)*
7. **Resilience.** A simulated stalled request times out within the configured bound and
   (for read/organise) is retried. *(NFR-REL-1..2)*
8. **Local-only secrets.** Tokens are written `600` in a `700` dir and nothing leaves the
   machine. *(NFR-SEC-1)*
9. **Bounded output.** Oversized threads/searches truncate gracefully with flags, never
   unbounded text. *(NFR-PERF-1..2)*

Success metrics (product): time-to-connect-second-account < 2 min; zero duplicate-send
incidents; zero credential-exfiltration paths; assistant can complete the §3.2 use cases
end-to-end across ≥2 mailboxes.

---

## 14. Constraints & assumptions

- **CON-1.** One server instance serves **one provider**. The Outlook product is a
  separate build of this spec, not a runtime mode of the Gmail server.
- **CON-2.** The MCP host (e.g. Claude Desktop) is responsible for *acting on* the
  destructive annotations (prompting the user); the server only declares them.
- **CON-3.** Unverified OAuth apps may restrict access to explicitly listed test users
  (Gmail) / require admin consent (Outlook org tenants). Onboarding docs must cover this.
- **CON-4.** The assistant cannot see local file bytes, so inline-base64 attachments are
  impractical for large binaries — hence the allow-listed `path` mechanism (NFR-SEC-3).
- **ASM-1.** The user can create an OAuth client / app registration and run a one-time CLI.
- **ASM-2.** Network egress to the provider's API/OAuth endpoints is available.

---

## 15. Future scope (explicitly out of v1)

These are natural extensions for the Outlook / Microsoft 365 target, beyond Gmail parity:

- **Calendar (Microsoft Graph `/me/events`).** List/search events, create/update/cancel,
  respond to invitations, suggest free times. Reuses the same account-selection, auth,
  safety-annotation, and output-contract foundations; create/cancel are destructive.
- **Contacts (Graph `/me/contacts`).** Look up and resolve recipients, list contacts.
  Primarily read; writes are additive/destructive per operation.
- **Push/streaming updates.** Graph change notifications (webhooks) for near-real-time
  triage — requires a hosted callback (ties to remote deployment).
- **Remote deployment.** Swap stdio for a streamable-HTTP transport hosted over HTTPS to
  offer a *remote* custom connector (multi-user concerns: per-user token isolation,
  authN/Z, secret management) — a significant scope step beyond local-first v1.

When these are built, they MUST inherit §7 (account model), §8 (auth), §10 (NFRs), and
§11 (output contract) unchanged.

---

## 16. Appendix A — Gmail → Outlook / Microsoft Graph mapping reference

| Area | Gmail (reference) | Outlook / Microsoft Graph (target) |
| --- | --- | --- |
| Identity platform | Google OAuth 2.0 + `google-auth-library` | Microsoft identity platform (Entra ID) + **MSAL** |
| Client type | OAuth **Desktop app** client | Entra ID **public client** app registration |
| Loopback redirect | `http://127.0.0.1:4773/oauth2callback` | `http://localhost` (MSAL loopback) |
| Scopes | `gmail.modify`, `gmail.send`, `userinfo.email` | `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` |
| Identify account | `oauth2.userinfo.get()` → email | `GET /me` → `userPrincipalName`/`mail` |
| API client | `googleapis` (`gmail_v1`) | Microsoft Graph SDK / REST |
| List/search | `users.threads.list` (`q`, `maxResults`, `pageToken`) | `GET /me/messages` (`$search`/`$filter`, `$top`, `@odata.nextLink`) |
| Read conversation | `users.threads.get` (`format=full`) | `GET /me/messages?$filter=conversationId eq '…'` |
| Send | build RFC 2822 `raw` → `users.messages.send` | `POST /me/sendMail` (JSON) or draft → `/send` |
| Create draft | `users.drafts.create` | `POST /me/messages` (`isDraft`) |
| Reply threading | RFC 5322 `In-Reply-To`/`References` | `POST …/createReply` or set `conversationId` |
| List labels | `users.labels.list` | `GET /me/outlook/masterCategories` + `GET /me/mailFolders` |
| Create label | `users.labels.create` | `POST …/masterCategories` (tag) / `POST /me/mailFolders` (folder) |
| Add/remove label | `threads.modify`/`messages.modify` (`addLabelIds`/`removeLabelIds`) | `PATCH …/messages/{id}` (`categories[]`) |
| Mark read/unread | toggle `UNREAD` label | `PATCH …/messages/{id}` (`isRead`) |
| Archive | remove `INBOX` label | `POST …/messages/{id}/move` → Archive folder |
| Trash/Junk | add `TRASH`/`SPAM` label | `move` → Deleted Items / Junk Email folder |
| Pagination cursor | `nextPageToken` | `@odata.nextLink` / `$skiptoken` |
| Rate limit signal | HTTP 429 | HTTP 429 + `Retry-After` |

> **Implementation watch-items for the Outlook build**
> 1. **Label decomposition** (§4, §6.8): one neutral "organise" request → several Graph
>    calls (categories vs folders vs flags). Design this mapping first.
> 2. **Search translation** (§6.2): Gmail operators → Graph `$search`/OData `$filter`;
>    document the supported subset.
> 3. **Auth library swap** (§8): MSAL's flow/cache differs from google-auth-library;
>    preserve the per-account refresh-token-bound-to-client invariant (FR-ID-5).
> 4. **Send semantics** (§6.5, NFR-REL-3): choose `sendMail` vs draft-then-send and keep
>    the no-duplicate-on-retry guarantee.

---

*End of specification.*
