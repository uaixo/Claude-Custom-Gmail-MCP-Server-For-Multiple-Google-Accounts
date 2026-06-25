# Provider Mapping — Gmail (reference) → Outlook / Microsoft 365 (target)

> **Companion to** [`business-specification.md`](./business-specification.md).
> The specification is **provider-neutral**. This document is **build-phase guidance**: it
> binds each neutral requirement to concrete provider primitives. It does **not** restate
> requirements — it maps them. Every row cites the spec section / requirement ID it serves so
> the mapping stays traceable.
>
> Two providers are shown side by side:
> - **Gmail** — the *reference implementation* these requirements were derived from (proven).
> - **Outlook / Microsoft 365** — the *build target* (to implement).
>
> Add a new column to extend the same neutral spec to any other provider.

---

## 1. Purpose & how to use this

1. Read the neutral requirement in the spec (e.g. **FR-C8-1**).
2. Find the corresponding row here to see the Gmail behaviour (reference) and the Outlook /
   Microsoft Graph operation to build.
3. Implement the Outlook operation so the **observable behaviour matches the requirement** —
   the spec, not this table, is the contract; this table is how you satisfy it on a provider.

> **Start with the four watch-items in §7** — they are where Outlook diverges most from the
> Gmail reference and where most porting effort and risk concentrate.

---

## 2. Domain-concept mapping  *(spec §4)*

| Neutral concept | Gmail (reference) | Outlook / Microsoft Graph (target) |
| --- | --- | --- |
| **Account** | Google account email | Microsoft account — `userPrincipalName` / primary SMTP (`mail`) |
| **Conversation** | Thread (`threadId`) | Conversation (`conversationId`) |
| **Message** | Message (`id`) | Message (`id`) |
| **Search query** | Gmail search operators (`from:`, `is:unread`, …) | Graph `$search` keywords + OData `$filter` |
| **Result cursor** | `nextPageToken` | `@odata.nextLink` (opaque) / `$skiptoken` |
| **Organisation label** | Label — unifies tag + system state (`INBOX`, `UNREAD`, `TRASH`, `SPAM`) | **Splits** into: **category** (tag) + **mailFolder** (location) + flags (`isRead`) |
| **Draft** | Draft resource | Draft message (`isDraft = true`) |
| **Send** | `users.messages.send` | `POST /me/sendMail`, or create draft then `POST …/send` |
| **Reply threading** | RFC 5322 `In-Reply-To` / `References` headers | `POST …/createReply` (+ `conversationId`), or MIME headers if sending raw |

> **The defining difference (spec §4 concept-decomposition rule).** Gmail collapses
> *tagging*, *foldering*, and *read-state* into one "label" concept. Outlook keeps them
> **separate**. This is why **FR-C8-6** exists: one neutral organise request must fan out to
> the right mix of Graph calls. See §7, item 1.

---

## 3. Capability → provider operation  *(spec §5–§6)*

| Cap | Neutral tool (spec) | Gmail (reference) | Outlook / Microsoft Graph (target) |
| --- | --- | --- | --- |
| C1 | `list_accounts` | Local token store enumeration | Local token store enumeration (provider-independent) |
| C2 | `search_conversations` | `users.threads.list` (`q`, `maxResults`, `pageToken`) + per-thread `users.threads.get` | `GET /me/messages` with `$search`/`$filter`, `$top`, `@odata.nextLink`; group by `conversationId` (or `GET /me/conversations` where available) |
| C3 | `read_conversation` | `users.threads.get` (`format=full`); bodies are base64url MIME parts | `GET /me/messages?$filter=conversationId eq '{id}'` (or expand the conversation); use `body`/`uniqueBody`, prefer `text` content type or convert HTML |
| C4 | `create_draft` | `users.drafts.create` with an RFC 2822 `raw` message | `POST /me/messages` (`isDraft`); attachments as `fileAttachment` resources or via MIME upload |
| C5 | `send_message` | build RFC 2822 `raw` → `users.messages.send` | `POST /me/sendMail` (structured JSON) **or** create draft → `POST …/send` (see §7 item 4) |
| C6 | `list_labels` | `users.labels.list` (system + user labels) | combine `GET /me/outlook/masterCategories` (tags) **and** `GET /me/mailFolders` (locations) |
| C7 | `create_label` | `users.labels.create` (supports `/` nesting) | `POST …/masterCategories` (a tag with a colour preset, no nesting) **or** `POST /me/mailFolders` (a folder; nesting = child folders) — choose by intent |
| C8 | `organize_mail` | `users.threads.modify` / `users.messages.modify` with `addLabelIds` / `removeLabelIds` | **fans out** — see §3.1 |

### 3.1 C8 organise — the fan-out detail  *(spec FR-C8-3, FR-C8-6)*

| Neutral intent | Gmail (reference) | Outlook / Microsoft Graph (target) |
| --- | --- | --- |
| Add / remove a user tag | add/remove a user label id | `PATCH /me/messages/{id}` → set `categories[]` (add/remove from the array) |
| Mark read / unread | add/remove the `UNREAD` label | `PATCH /me/messages/{id}` → `isRead = true/false` |
| Archive (remove from inbox) | remove the `INBOX` label | `POST /me/messages/{id}/move` → destination = Archive folder |
| Move to trash / spam | add the `TRASH` / `SPAM` label | `POST /me/messages/{id}/move` → Deleted Items / Junk Email folder (or `DELETE` for trash) |
| Apply to a whole conversation | `threads.modify` (applies to all messages) | iterate the conversation's message ids (Graph has no single conversation-modify); apply per message, then report the union (spec FR-C8-4) |

---

## 4. Identity & authentication  *(spec §7–§8)*

| Concern | Gmail (reference) | Outlook / Microsoft Graph (target) |
| --- | --- | --- |
| Identity platform | Google OAuth 2.0 + `google-auth-library` | Microsoft identity platform (Entra ID) + **MSAL** |
| OAuth client type | OAuth **Desktop app** client | Entra ID **public client** app registration |
| Loopback redirect *(FR-AUTH-2)* | `http://127.0.0.1:4773/oauth2callback` | `http://localhost` (MSAL handles the loopback port) |
| PKCE *(FR-AUTH-3)* | `generateCodeVerifierAsync` + S256 | MSAL public-client PKCE (built in) |
| CSRF `state` *(FR-AUTH-4)* | random `state`, verified on callback | same pattern (MSAL exposes `state`) |
| Offline / refresh *(FR-AUTH-5)* | `access_type=offline`, `prompt=consent` | scope `offline_access`; MSAL token cache holds the refresh token |
| Identify account *(FR-AUTH-6)* | `oauth2.userinfo.get()` → email | `GET /me` → `userPrincipalName` / `mail` |
| Least-privilege scopes *(FR-AUTH-10)* | `gmail.modify`, `gmail.send`, `userinfo.email` | `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` |
| Per-account client binding *(FR-ID-5)* | account records which `credentials*.json` client authorised it | account records which **app registration** (and tenant) authorised it |
| Multiple OAuth clients *(FR-ID-6)* | several `credentials*.json` files, auto-discovered | several app-registration configs and/or tenants |

> **Auth-library swap.** MSAL replaces `google-auth-library` for both the consent flow and
> silent token refresh. Preserve the spec invariant **FR-ID-5**: a stored account must refresh
> with the *same* client that issued its refresh token. MSAL's token cache is per-authority; key
> your cache by account identity and bind it to the issuing app registration.

---

## 5. Configuration variable mapping  *(spec §12)*

| Neutral variable (spec) | Gmail (reference) | Outlook (suggested) |
| --- | --- | --- |
| `MAIL_MCP_DATA_DIR` | `GMAIL_MCP_DATA_DIR` (default `~/.gmail-mcp`) | `OUTLOOK_MCP_DATA_DIR` (e.g. `~/.outlook-mcp`) |
| `MAIL_OAUTH_CREDENTIALS` | `GMAIL_OAUTH_CREDENTIALS` | `OUTLOOK_OAUTH_CREDENTIALS` (app-registration config path) |
| `MAIL_MCP_ATTACHMENTS_DIR` | `GMAIL_MCP_ATTACHMENTS_DIR` | `OUTLOOK_MCP_ATTACHMENTS_DIR` |
| `MAIL_MCP_LOCK_TIMEOUT_MS` | `GMAIL_MCP_LOCK_TIMEOUT_MS` (12000) | `OUTLOOK_MCP_LOCK_TIMEOUT_MS` |
| `MAIL_MCP_REQUEST_TIMEOUT_MS` | `GMAIL_MCP_REQUEST_TIMEOUT_MS` (30000) | `OUTLOOK_MCP_REQUEST_TIMEOUT_MS` |

The data-dir, allow-list, lock, and timeout semantics are provider-independent and carry over
unchanged; only the credential *contents* (OAuth client config vs app-registration config) differ.

---

## 6. Cross-cutting behaviour  *(spec §9–§11)*

| Concern | Gmail (reference) | Outlook / Microsoft Graph (target) |
| --- | --- | --- |
| Rate-limit signal *(NFR-REL-2/3)* | HTTP 429 | HTTP 429 with `Retry-After` (honour the header) |
| Retryable transport errors *(NFR-REL-2)* | timeout / connection reset | same; map Graph SDK transient errors equivalently |
| Per-request timeout *(NFR-REL-1)* | client `timeout` option (30s) | Graph client request timeout / `AbortSignal` (30s) |
| Outgoing size limit *(NFR-PERF-3)* | ~25 MB (Gmail) | ~25–150 MB depending on mailbox policy; validate against the effective limit |
| Pagination cursor *(FR-C2-3)* | `nextPageToken` | `@odata.nextLink` — store/return it opaquely; do not parse `$skiptoken` |
| Error mapping *(FR-ERR-1)* | map Gmail API error → actionable text | map Graph error `code`/`message` → the same actionable categories |

---

## 7. Implementation watch-items (highest porting risk)

1. **Label decomposition *(spec §4, FR-C8-6)*.** The biggest delta. One neutral `organize_mail`
   request becomes several Graph calls — `categories[]` (tag), `move` (folder/archive/junk),
   `isRead` (read-state). Design this decomposition table **first** (start from §3.1) and treat
   it as the core of the Outlook build.
2. **Search translation *(spec FR-C2-1)*.** Gmail operators must be re-expressed as Graph
   `$search` + OData `$filter` (e.g. `is:unread` → `isRead eq false`; `from:x` →
   `from/emailAddress/address eq 'x'`; `has:attachment` → `hasAttachments eq true`). Document the
   supported operator subset and reject/translate the rest predictably.
3. **Auth library swap *(spec §8, FR-ID-5)*.** MSAL's flow and token cache differ from
   `google-auth-library`. Preserve the per-account refresh-token-bound-to-client invariant and the
   "pick up re-consent without restart" behaviour (FR-AUTH-9) on top of MSAL's cache.
4. **Send semantics *(spec FR-C5-4, NFR-REL-3)*.** Choose `sendMail` (one call) vs draft-then-send
   (two calls) and keep the **no-duplicate-on-retry** guarantee: only retry pre-processing 429s,
   never an ambiguous failure that may already have sent.

---

## 8. Concept glossary (provider terms)

- **Microsoft Graph** — Microsoft 365's unified REST API (`https://graph.microsoft.com`).
- **Entra ID** — Microsoft's identity platform (formerly Azure AD); issues OAuth tokens.
- **App registration** — the Entra ID application identity; the Outlook analogue of a Google
  OAuth client (spec "OAuth client", FR-ID-5).
- **MSAL** — Microsoft Authentication Library; handles the consent flow and silent refresh.
- **Category** — an Outlook tag applied to a message (`categories[]`); part of the neutral
  "organisation label" (spec §4).
- **mailFolder** — an Outlook location (Inbox, Archive, Junk Email, Deleted Items, custom); the
  other part of the neutral "organisation label".
- **conversationId** — Outlook's thread grouping key (neutral "conversation").

---

*Companion to [`business-specification.md`](./business-specification.md). Extend by adding a
provider column to the tables above; the neutral spec does not change.*
