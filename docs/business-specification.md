# Business Specification — Multi-Account Mailbox MCP Server

> **Status:** Draft v1.1 · **Type:** Business + Functional specification (provider-neutral)
> **Provenance:** Derived from a reference implementation — a multi-account **Gmail** MCP server.
> **Provider mappings** (how these neutral requirements bind to a specific email
> provider such as Outlook / Microsoft 365) live in the companion document
> [`provider-mapping.md`](./provider-mapping.md). This specification itself names no provider.

---

## 0. How to read this document

This is a **provider-neutral** specification. It describes *what* the product does and
*why*, independent of any one email provider, so the same product can be built on any
provider (a multi-account Gmail server, an Outlook / Microsoft 365 server, etc.) from one
source of truth.

- Requirements are written generically against an abstract **"mail provider."**
- Requirements carry stable IDs (`FR-*`, `NFR-*`, `CON-*`) so a downstream, spec-driven
  build can trace each delivered behaviour back to this document and generate acceptance
  tests from the **Acceptance criteria** in §13.
- **No provider specifics appear here.** All concrete bindings — which API call, which
  OAuth scopes, which SDK, how one neutral concept decomposes into provider primitives —
  belong to the **build phase** and are recorded per provider in the companion
  [`provider-mapping.md`](./provider-mapping.md).
- "**Reference:**" parentheticals cite the proven default value observed in the reference
  implementation (e.g. *reference: 30s*). They are sensible defaults, not requirements
  tied to a provider.

Audience: product owners, engineers, and AI coding agents implementing a provider variant
from this specification.

---

## 1. Product vision & problem statement

### 1.1 Vision
A **local, single-connector bridge** that lets an AI assistant (an MCP host such as
Claude) operate **several of a user's mailboxes at once** — searching, reading, composing,
sending, and organising mail — through one consistent, safety-annotated tool surface, with
credentials that **never leave the user's machine**.

### 1.2 Problem
First-party AI email connectors typically bind **one account per connection**. A user with
multiple mailboxes (personal + several work/client accounts) cannot ask the assistant to
work across all of them through a single connector, and cannot disambiguate "which
account" inside a single request.

> This is a *product* limitation of one-account-per-connection connectors, **not** a
> limitation of the Model Context Protocol. The reference implementation demonstrates that
> one MCP connector can serve many accounts. **Every provider variant built from this spec
> MUST preserve that advantage.**

### 1.3 Value proposition
- **One connector, many mailboxes** — connect any number of accounts; pick the target per
  request, or let the server default when only one is connected.
- **Local-first & private** — OAuth tokens are stored only on the user's machine; mail
  content flows machine ↔ provider, never through a third-party service.
- **Safe by default** — irreversible actions (sending, destructive organise operations)
  are explicitly annotated so the host can require user confirmation.
- **Least-privilege** — only the OAuth scopes strictly required are requested.

---

## 2. Goals & non-goals

### 2.1 Goals
1. Serve **multiple accounts of one mail provider** through a single MCP server.
2. Provide a complete **core mail workflow**: list accounts, search, read, draft, send, and
   organise (the provider's tagging/foldering/read-state model).
3. Make **account selection** a first-class, low-friction concept.
4. Keep **authentication local, per-account, and least-privilege**.
5. Be **safe**: annotate destructive actions; never silently email arbitrary local files.
6. Be **resilient**: bound every provider call in time, retry transient failures without
   ever duplicating a send.
7. Run cross-platform (Windows + macOS) with a simple one-time setup.

### 2.2 Non-goals (v1)
- Not a full email *client* (no rich rendering, no real-time push/IDLE).
- Not a multi-user/server-hosted SaaS by default (local stdio per user; remote deployment
  is an explicit *future* option — §15).
- Not a calendar/contacts product in v1 (those are **future scope** — §15).
- No cross-provider federation in one server instance: **one server = one provider**. Each
  provider variant is a **separate build** from this shared specification.

---

## 3. Personas & primary use cases

### 3.1 Personas
- **The multi-mailbox professional (primary).** Runs personal + several work/client
  mailboxes; wants the assistant to triage, draft, and send from the right identity.
- **The power user / consultant.** Mailboxes spread across **different organisations**
  (different OAuth clients), each of which must be authorised under its own client.
- **The privacy-conscious user.** Will only adopt a tool whose credentials and mail stay on
  their own machine.
- **The developer / integrator.** Embeds the server into an MCP host or builds a new
  provider variant — and is the consumer of *this* specification (plus a provider mapping).

### 3.2 Primary use cases
1. "**Which mailboxes are connected?**" → list accounts.
2. "**Find …**" within a chosen mailbox → search, page through results, read a conversation.
3. "**Draft a reply** to this conversation" → compose a non-sending draft for human review.
4. "**Send** this message from my work account" → deliver immediately (gated as destructive).
5. "**Archive / mark read / categorise** these messages" → organise without deleting.
6. "**Connect another mailbox**" → one-time browser consent, then it's available.

---

## 4. Domain model (neutral concepts)

Implementations MUST realise the following **neutral domain concepts** on top of their
provider's primitives. Functional requirements in §6 are written against these terms. The
concrete realisation for a given provider is recorded in the companion mapping document.

| Neutral concept | Definition |
| --- | --- |
| **Account** | One authenticated mailbox identity (an email address / user principal). |
| **Conversation** | A provider grouping of related messages (a thread). |
| **Message** | A single email within a conversation. |
| **Search query** | A user-expressible filter over mail, in the provider's native syntax. |
| **Result cursor** | An opaque "next page" token for paginating search results. |
| **Organisation label** | A tag/state/location applied to mail (user tags and system states such as inbox/unread/archived/trash). |
| **Draft** | An unsent, editable message persisted in the account. |
| **Send** | Irreversible delivery of a message. |
| **Reply threading** | The mechanism that files a reply into its existing conversation. |

> **Concept-decomposition rule.** A provider MAY model a single neutral concept as
> **several** primitives. In particular, the neutral **organisation label** may split into
> distinct *tag*, *folder/location*, and *read-state flag* concepts on some providers. The
> organise-mail capability (§6.8) MUST therefore be designed so that **one neutral request
> decomposes into the correct combination of provider operations** — this is the single
> most important design consideration when porting to a new provider, and is detailed per
> provider in the companion mapping.

---

## 5. Capability overview

The product exposes these capability areas as MCP tools. Tool names below are **neutral
placeholders**; each provider build chooses its own concrete tool names (recorded in the
mapping companion).

| # | Capability | Neutral tool name | Destructive? |
| --- | --- | --- | --- |
| C1 | List connected accounts | `list_accounts` | No (read) |
| C2 | Search conversations | `search_conversations` | No (read) |
| C3 | Read a full conversation | `read_conversation` | No (read) |
| C4 | Create a draft | `create_draft` | No (reversible write) |
| C5 | Send a message | `send_message` | **Yes** |
| C6 | List organisation labels | `list_labels` | No (read) |
| C7 | Create a label | `create_label` | No (additive write) |
| C8 | Organise mail (add/remove labels, read-state, archive) | `organize_mail` | **Yes** |

Plus an **out-of-band account-management CLI** (connect / list / remove accounts) — §8.

---

## 6. Functional requirements

Each tool MUST accept an **optional account selector** and follow the selection rule (§7),
return both a human-readable summary and a structured result (§11), and map provider errors
to actionable messages (§9).

### 6.1 C1 — List connected accounts
- **FR-C1-1.** Return the set of accounts currently connected to this server, as identity
  strings (email / user principal).
- **FR-C1-2.** When none are connected, return a non-error result that instructs the user
  how to connect one.
- **FR-C1-3.** This is the discovery entry point: its output supplies valid values for every
  other tool's account selector.
- *Annotations:* read-only, non-destructive, idempotent, closed-world.

### 6.2 C2 — Search conversations
- **FR-C2-1.** Accept a **required** query string (the provider's native search syntax) and
  search the chosen account's mail.
- **FR-C2-2.** Accept a **page size** (default 20; bounded maximum 100) and return at most
  that many conversation summaries per call.
- **FR-C2-3.** Support **pagination**: when more results exist, return an opaque next-page
  cursor; accept that cursor on a subsequent call (with the same query) to fetch the next
  page.
- **FR-C2-4.** Each summary SHOULD include a stable conversation id, subject, sender, date,
  and a snippet.
- **FR-C2-5.** If a single conversation's summary cannot be fetched, **degrade that entry**
  (mark it with an error field) rather than failing the whole search.
- **FR-C2-6.** Bound the fan-out of per-conversation detail fetches to respect provider rate
  limits.
- *Annotations:* read-only, non-destructive, idempotent, open-world.

### 6.3 C3 — Read a full conversation
- **FR-C3-1.** Given a conversation id, return every message's headers (from, to, date,
  subject), plain-text body, and applied organisation labels.
- **FR-C3-2.** **Bound the payload**: cap the number of messages returned (keep the
  **newest**), and cap total body characters; when truncation occurs, set a `truncated`
  flag and report how many older messages were omitted.
- **FR-C3-3.** Prefer returning rich/HTML bodies as readable **plain text**.
- *Annotations:* read-only, non-destructive, idempotent, open-world.

### 6.4 C4 — Create a draft
- **FR-C4-1.** Compose a draft with: one or more **recipients** (`to`), optional `cc`/`bcc`,
  optional `subject`, a `body`, and an `is_html` flag.
- **FR-C4-2.** **Do not send.** The draft MUST be persisted in the account for later human
  review/sending.
- **FR-C4-3.** Support **attachments**, each supplied as **exactly one of**: a local file
  **path** (server reads it — subject to NFR-SEC-3) **or** inline base64 content. Infer
  filename/MIME type where omitted; require filename for inline content.
- **FR-C4-4.** Support **reply drafting**: given a conversation id, derive threading so the
  draft is filed as a reply; when subject is omitted on a reply, default to the
  conversation's subject prefixed with `Re:`.
- **FR-C4-5.** Recipients accept a bare address or a `Display Name <addr>` form; the
  implementation MUST prevent header injection via recipient/subject values.
- *Annotations:* write, non-destructive (reversible), non-idempotent, open-world.

### 6.5 C5 — Send a message
- **FR-C5-1.** Same composition inputs as C4, plus an optional explicit reply-to-message
  reference to improve threading.
- **FR-C5-2.** **Deliver immediately.** This is irreversible.
- **FR-C5-3.** MUST be annotated **destructive** so the MCP host can gate it behind a user
  confirmation.
- **FR-C5-4.** MUST guarantee **no duplicate delivery** under retries (see NFR-REL-3).
- *Annotations:* write, **destructive**, non-idempotent, open-world.

### 6.6 C6 — List organisation labels
- **FR-C6-1.** Return all labels/tags/folders available in the account, each with a stable
  id, a display name, and a type (system vs user-created).
- **FR-C6-2.** Output is the id-discovery source for C8.
- *Annotations:* read-only, non-destructive, idempotent, open-world.

### 6.7 C7 — Create a label
- **FR-C7-1.** Create a new user label/tag by name (support hierarchy/nesting where the
  provider does, e.g. `Clients/Acme`).
- *Annotations:* write, non-destructive (additive), non-idempotent, open-world.

### 6.8 C8 — Organise mail (the unified "label" operation)
- **FR-C8-1.** Apply organisation changes to **exactly one** target: a whole conversation
  **or** a single message.
- **FR-C8-2.** Support **adding and/or removing** labels in one call; require at least one
  change.
- **FR-C8-3.** Support the common derived intents: **mark read/unread** and **archive**
  (remove from inbox) via this same capability.
- **FR-C8-4.** When applied to a conversation, report the resulting state across the whole
  conversation (e.g. the union of labels), not just one message.
- **FR-C8-5.** MUST be annotated **destructive** (removals and moves to trash/spam are
  non-additive) so the host can gate it.
- **FR-C8-6.** Per the concept-decomposition rule (§4), a single neutral organise request
  MUST be fulfilled by the correct combination of underlying provider operations (tagging,
  moving/foldering, and/or read-state changes).
- *Annotations:* write, **destructive**, idempotent, open-world.

---

## 7. Account & identity model

- **FR-ID-1 (optional selector).** Every tool except "list accounts" MUST accept an optional
  account selector (the account's identity string).
- **FR-ID-2 (default rule).** If the selector is omitted and **exactly one** account is
  connected, use it. If **several** are connected, return an actionable error asking the
  caller to specify one. If **none** are connected, return an actionable error telling the
  user to connect one.
- **FR-ID-3 (validation).** A specified-but-unknown account MUST fail with an error that
  lists the connected accounts.
- **FR-ID-4 (case-insensitive identity).** Account identity MUST be matched
  case-insensitively (store keyed by lower-cased identity).
- **FR-ID-5 (per-account credential binding).** Each account records **which OAuth client**
  authorised it; token refresh MUST always use that same client (refresh tokens are bound to
  the issuing client).
- **FR-ID-6 (multiple OAuth clients).** Support accounts spread across **different OAuth
  clients** (e.g. different organisations/projects), discovered from multiple credential
  sources.

---

## 8. Authentication & onboarding

Authentication is **per-account OAuth**, performed **out-of-band** by a small CLI before the
MCP server is used. The server itself never initiates interactive consent.

- **FR-AUTH-1 (connect).** Provide a CLI command to connect a new account via an interactive
  browser **authorization-code** consent flow.
- **FR-AUTH-2 (loopback redirect).** Use a **loopback** redirect on `127.0.0.1` with a
  preferred fixed port (reference: 4773) and automatic fallback to an OS-assigned port if
  busy.
- **FR-AUTH-3 (PKCE).** Use PKCE (S256) so an intercepted authorization code cannot be
  exchanged without the matching verifier.
- **FR-AUTH-4 (CSRF state).** Generate a random `state`, round-trip it, and verify it on the
  callback; unrelated/forged callbacks MUST be answered neutrally **without** aborting the
  genuine flow.
- **FR-AUTH-5 (refresh token).** Request **offline access** so a long-lived refresh token is
  obtained; force re-consent issuance when needed.
- **FR-AUTH-6 (identify account).** After token exchange, look up the authenticated identity
  to key the stored tokens; abort if it can't be determined.
- **FR-AUTH-7 (consent timeout).** Bound the wait for consent (reference: 5 minutes) and fail
  with guidance if it elapses.
- **FR-AUTH-8 (manage accounts).** Provide CLI commands to **list** connected accounts (with
  the credential source each uses) and to **remove** an account.
- **FR-AUTH-9 (re-consent recovery).** If a refresh token is revoked, re-running connect MUST
  repair the account; a running server MUST pick up rewritten credentials on its next call
  **without a restart**.
- **FR-AUTH-10 (least privilege).** Request the minimum scopes needed for the supported
  capabilities (read+organise, send, identity) and nothing more.

---

## 9. Error handling & resilience requirements

- **FR-ERR-1.** Provider errors MUST be mapped to **actionable, human-readable** messages
  (e.g. auth expired → "re-connect this account"; rate limited → "try again shortly";
  timeout reported as a timeout) and returned as tool errors, not raised as crashes.
- **FR-ERR-2.** A malformed/corrupt local token store MUST NOT crash the server; treat it as
  "no accounts" and surface a one-time warning explaining how to repair it.
- **FR-ERR-3.** Validation errors (bad recipient, both/neither of mutually exclusive fields,
  missing required change) MUST be returned as clear errors before any provider call.

---

## 10. Non-functional requirements

### 10.1 Security & privacy
- **NFR-SEC-1 (local secrets).** OAuth tokens MUST be stored **only on the user's machine**,
  in a token store file with owner-only permissions (`600`), inside a data directory created
  owner-only (`700`). Mail content MUST NOT transit any third party.
- **NFR-SEC-2 (atomic, locked token writes).** Token-store writes MUST be atomic (temp-file +
  rename) and guarded by a **cross-process lock** with stale-lock recovery, so concurrent
  writers (server refresh + CLI connect) can't lose updates or expose a partial file.
- **NFR-SEC-3 (attachment path guard).** Reading local files by **path** for attachments MUST
  be **disabled by default** and only permitted from an explicit allow-listed directory set
  by configuration; paths MUST be fully resolved (symlinks, `..`) and validated to fall
  within an allowed directory **before** reading. This prevents the server being coerced into
  emailing arbitrary local files (keys, `.env`). Inline base64 is always available as the safe
  alternative.
- **NFR-SEC-4 (TOCTOU-safe reads).** When a path attachment is allowed, open the resolved file
  **once** and validate via the open handle (no check-then-reopen window).
- **NFR-SEC-5 (header-injection safe).** Strip CR/LF from header-bound values (recipients,
  subject, filenames) so a display name or subject cannot inject headers.
- **NFR-SEC-6 (no secret logging).** Never log tokens, credentials, or message contents.
- **NFR-SEC-7 (consent-flow hardening).** The loopback callback server binds to loopback only
  and is short-lived; enforce PKCE + `state` (per §8).

### 10.2 Reliability
- **NFR-REL-1 (per-request timeout).** Every provider API call MUST have a bounded timeout
  (reference default 30s, configurable) so a stalled socket fails fast instead of hanging.
- **NFR-REL-2 (bounded retry).** Transient failures MUST be retried with **bounded, jittered
  backoff**.
- **NFR-REL-3 (no duplicate side effects).** **Send** and **draft-create** MUST retry **only**
  on pre-processing rate-limit rejections — never on ambiguous failures (transient 5xx or
  timeouts that may have succeeded) — so a retry can never deliver a duplicate. Read/organise
  operations may retry on rate limits, transient server errors, and transport failures.
- **NFR-REL-4 (concurrency bound).** Bulk per-item fetches (e.g. expanding search results)
  MUST cap concurrency to respect provider rate limits.

### 10.3 Performance & resource bounds
- **NFR-PERF-1.** Responses MUST be bounded to a character budget (reference 25,000), degrading
  gracefully (summaries / truncation flags) rather than emitting unbounded text.
- **NFR-PERF-2.** Conversation reads MUST cap message count (reference 100) and combined body
  characters (reference 20,000), keeping the newest content.
- **NFR-PERF-3.** Outgoing message size MUST be validated locally against the provider's limit
  (reference ~25 MB) before the API call, failing with a clear local error.

### 10.4 Output contract — see §11.

### 10.5 Compatibility & operability
- **NFR-OPS-1.** MUST run on **Node.js ≥ 18** on **Windows and macOS**.
- **NFR-OPS-2.** Default transport is **stdio**, launched by the MCP host; the server reports
  connected accounts to stderr on startup.
- **NFR-OPS-3.** All operational knobs (data dir, credentials source/selection, attachment
  allow-list, timeouts, lock timeout) MUST be configurable via environment variables (§12).
- **NFR-OPS-4 (safety annotations).** Every tool MUST carry MCP behavioural annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so hosts can gate
  destructive actions. Send and organise-mail MUST be `destructiveHint: true`.

---

## 11. Output / response contract

- **FR-OUT-1 (dual channel).** Every tool MUST return (a) a concise **human-readable** text
  summary and (b) a **structured** machine-readable result object.
- **FR-OUT-2 (authoritative structure).** When the human text is truncated for size, the
  structured result remains the authoritative, complete payload (within the documented caps).
- **FR-OUT-3 (stable shapes).** Result objects SHOULD use stable, documented field names (e.g.
  `account`, `count`, conversation/message ids, `next_page_token`, `truncated`,
  `omitted_message_count`). Optional fields appear only when meaningful.

---

## 12. Configuration requirements

Each provider build exposes these settings as environment variables. Names below use a
neutral `MAIL_MCP_*` convention; a provider build MAY use its own prefix (recorded in the
mapping companion), but MUST preserve the **meaning**.

| Setting | Neutral variable | Purpose |
| --- | --- | --- |
| Data directory | `MAIL_MCP_DATA_DIR` | Where tokens + credential sources live (default under `$HOME`). |
| Forced single OAuth client | `MAIL_OAUTH_CREDENTIALS` | Pin one client source; disables auto-discovery. |
| Attachment allow-list | `MAIL_MCP_ATTACHMENTS_DIR` | Directories `path` attachments may be read from (unset = `path` disabled). |
| Token-lock timeout | `MAIL_MCP_LOCK_TIMEOUT_MS` | Max wait for the token-store lock before failing a write. |
| Per-request timeout | `MAIL_MCP_REQUEST_TIMEOUT_MS` | Bound on each provider API call. |

The credential model supports **one or more** OAuth client sources, auto-discovered, so
accounts under different clients each refresh with the client that authorised them
(FR-ID-5/6).

---

## 13. Acceptance criteria (build-readiness)

A provider implementation is **spec-complete** when:

1. **Multi-account.** With ≥2 accounts connected, each tool operates on the selector-named
   account; omitting the selector with several connected returns the disambiguation error;
   with one connected it defaults correctly. *(FR-ID-1..3)*
2. **Capabilities.** C1–C8 each satisfy their FRs, verified against a real provider sandbox
   account. *(§6)*
3. **Onboarding.** The connect CLI completes a PKCE + `state` loopback consent, stores a
   refresh token, identifies the account, and survives a re-consent without server restart.
   *(FR-AUTH-1..9)*
4. **No duplicate sends.** A forced transient-failure test on send/draft never produces a
   duplicate. *(NFR-REL-3)*
5. **Attachment guard.** Path reads are refused unless allow-listed and within an allowed
   directory; inline base64 always works. *(NFR-SEC-3..4)*
6. **Safety.** Send and organise-mail are annotated destructive; a host configured to confirm
   destructive tools is prompted. *(NFR-OPS-4)*
7. **Resilience.** A simulated stalled request times out within the configured bound and (for
   read/organise) is retried. *(NFR-REL-1..2)*
8. **Local-only secrets.** Tokens are written `600` in a `700` dir and nothing leaves the
   machine. *(NFR-SEC-1)*
9. **Bounded output.** Oversized conversations/searches truncate gracefully with flags, never
   unbounded text. *(NFR-PERF-1..2)*

Success metrics (product): time-to-connect-second-account < 2 min; zero duplicate-send
incidents; zero credential-exfiltration paths; the assistant can complete the §3.2 use cases
end-to-end across ≥2 mailboxes.

---

## 14. Constraints & assumptions

- **CON-1.** One server instance serves **one provider**; each provider variant is a separate
  build of this spec, not a runtime mode.
- **CON-2.** The MCP host is responsible for *acting on* the destructive annotations
  (prompting the user); the server only declares them.
- **CON-3.** Unverified OAuth apps may restrict access (e.g. to explicitly listed test users)
  or require organisation/admin consent; onboarding docs MUST cover the provider's policy.
- **CON-4.** The assistant cannot see local file bytes, so inline-base64 attachments are
  impractical for large binaries — hence the allow-listed `path` mechanism (NFR-SEC-3).
- **ASM-1.** The user can create an OAuth client and run a one-time CLI.
- **ASM-2.** Network egress to the provider's API/OAuth endpoints is available.

---

## 15. Future scope (explicitly out of v1)

Natural extensions beyond core-mail parity. Each MUST inherit §7 (account model), §8 (auth),
§10 (NFRs), and §11 (output contract) unchanged:

- **Calendar.** List/search events, create/update/cancel, respond to invitations, suggest
  free times. Create/cancel are destructive.
- **Contacts.** Look up and resolve recipients; list contacts. Primarily read; writes are
  additive/destructive per operation.
- **Push / streaming updates.** Provider change notifications for near-real-time triage —
  requires a hosted callback (ties to remote deployment).
- **Remote deployment.** Swap stdio for a streamable-HTTP transport hosted over HTTPS to offer
  a *remote* custom connector. Adds multi-user concerns: per-user token isolation, authN/Z,
  and secret management — a significant scope step beyond local-first v1.

---

## 16. Glossary

- **MCP / MCP host** — the Model Context Protocol and the application (e.g. an AI assistant)
  that launches this server and calls its tools.
- **Tool** — a single capability the server exposes to the host, with typed inputs/outputs and
  behavioural annotations.
- **Account selector** — the optional per-tool parameter naming which connected account to act
  on (§7).
- **OAuth client** — the registered application identity under which an account is authorised;
  refresh tokens are bound to it (FR-ID-5).
- **Destructive annotation** — an MCP hint marking a tool whose effect is irreversible or
  non-additive, so the host can require confirmation (NFR-OPS-4).
- **Reference (value)** — a default observed in the reference implementation, cited as a
  sensible starting point, not a provider-bound requirement.
- **Provider mapping** — the companion document binding these neutral requirements to a
  specific provider; see [`provider-mapping.md`](./provider-mapping.md).

---

*End of specification. Provider-specific bindings: see [`provider-mapping.md`](./provider-mapping.md).*
