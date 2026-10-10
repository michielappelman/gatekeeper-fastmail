# gatekeeper-fastmail

A Cloudflare OS Gatekeeper for Fastmail email, following the upstream `write-gatekeeper` skill
(`cloudflare-os/.agents/skills/write-gatekeeper/SKILL.md`). Modeled on two upstream references:
`gatekeeper-homeassistant`'s pasted-credential connect flow (Fastmail's JMAP API takes a bearer API
token, not an OAuth redirect) and `gatekeeper-google`'s Gmail session/capability design (adapted to
JMAP's Mailbox+Keyword model rather than Gmail's Label model).

## Use in another Cloudflare OS starter

This repository is designed to be consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment.
It is not an npm package: its `@gadgets/*` dependencies are resolved from the pinned Cloudflare OS
workspace in the consuming starter, which keeps the Gatekeeper Kit ABI aligned with the deployment.

From the root of the starter:

```sh
git submodule add https://github.com/michielappelman/gatekeeper-fastmail.git packages/gatekeeper-fastmail
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`, and its deploy wrapper must treat
`packages/gatekeeper-fastmail` as the Fastmail Worker package. In practice that means:

1. Read this package's `wrangler.jsonc` as the base Fastmail config. It is generated from
   `cloudflare.config.ts`: edit that, then run `pnpm configs:generate` from the starter root.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL`, and observability settings.
3. Run `vp run -F gatekeeper-fastmail --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter and record that commit in the deployment inventory.

The starter's `workers.fastmail.name` is the deployed Worker identity; it need not be
`gatekeeper-fastmail`. The public router is the only route: the Fastmail Worker should have no
public or preview URL. Users paste their own Fastmail API token through the Gatekeeper's connect
flow, so no deployment-wide Fastmail secret is required. Tokens should be scoped to Mail, with
Email submission only when a connection needs to send. A token without Email submission gives a
draft-only connection: the agent can prepare drafts for the user to send from Fastmail, and Fastmail
itself refuses any attempt to send (see [Drafts and sending](#drafts-and-sending)).

For local development and tests, run them from the consuming starter after the Cloudflare OS
submodule is initialized:

```sh
pnpm --filter gatekeeper-fastmail test:run
pnpm --filter gatekeeper-fastmail types:check
```

Keep the Cloudflare OS submodule and this Gatekeeper pinned together. If either changes, run the
Gatekeeper tests, the starter's type checks, and the full starter check before updating the
submodule gitlinks.

## Protocol

Fastmail's JMAP API (RFC 8620 core + RFC 8621 Mail) is JSON-over-HTTPS, so it fits a Worker's
`fetch()` model far better than IMAP's stateful binary protocol. There is no JMAP client library in
this repo or on npm suited to Workers, so `fastmail-api.ts` talks the protocol directly — the same
approach `gatekeeper-jottacloud` took for JFS.

The implementation follows Fastmail's JMAP service shape and RFC 8620/8621. Protocol details are
isolated in `fastmail-api.ts` and `fastmail-types.ts`, so endpoint or limit changes can be updated
without changing the Gatekeeper session and capability boundary.

## Auth

Fastmail's JMAP endpoint accepts only `Authorization: Bearer <token>` — the app passwords Fastmail
issues for IMAP/SMTP/POP3 do **not** work against JMAP. The connect form asks for a Fastmail API
token (Settings → Password & Security → API tokens, scoped to Mail, and Email submission if you want
this connection to be able to send). `GET /jmap/session` with the pasted token is both the connect
flow's validation ping and the source of everything needed to talk to the account (`apiUrl`,
`downloadUrl`/`uploadUrl` templates, the mail `accountId`, and whether the token carries Email
submission scope) — see `UserAccount.completeConnection()` in `fastmail.ts`.

There is no refresh cycle (unlike an OAuth grant): the token is live until revoked in Fastmail's own
settings, or an API call returns 401, which is reported to the Workshop via
`GatekeeperConnectCallback.credentialsExpired()`.

## Resource model (whole mailbox, folder, or saved search)

`FASTMAIL_RESOURCE` (`resource.ts`) is one resource per connected account, narrowed by the URL's
hash. The `urlPattern` is unchanged, so whole-mailbox bindings created before scopes existed keep
their URL and meaning:

| Binding | Resource URL | Session type |
|---|---|---|
| Whole mailbox | `https://api.fastmail.com/jmap/mail/account` | `FastmailSession` / `FastmailDraftOnlySession` |
| One folder | `…/account#mailbox/<JMAP Mailbox id>` | `FastmailScopedSession` / `FastmailScopedDraftOnlySession` |
| Saved search | `…/account#search/<percent-encoded canonical JSON filter>` | as for a folder |

A folder binding admits the messages currently in that folder (not its subfolders); mailbox ids
survive renames. A saved search is a structured filter (`from`, `to`, `subject`, `text`,
`hasKeyword`, `folderId`, `after`, `before`; at least one), mapped to a JMAP `FilterCondition`, never
a free-text query string, so the gatekeeper can check a single message against it.

`src/scope.ts`'s `ScopeGuard` enforces the scope everywhere, the way gatekeeper-google's label and
search bindings do:

- listings and searches get the scope ANDed into their `Email/query` filter; asking a folder binding
  for another folder is refused;
- every thread, message and hook capability re-checks admission on each read or change, so a
  message that leaves the folder or stops matching the search leaves scope; a thread shows only its
  admitted messages, and changes, attachments and replies reach only those;
- a search scope's admission is decided by Fastmail itself: one `Email/query` for the stored filter
  AND the emails' `Message-ID` headers (RFC 8621 `header` condition). Mail without a Message-ID is
  never admitted;
- a narrowed binding sees only its own folder and the Inbox, Archive, Trash and Junk folders in
  `listFolders()`, and may move mail only into those (not Sent, Drafts, Scheduled or Snoozed); a
  parent folder outside that set shows as `parentId: null`;
- a narrowed binding can't write new mail (`send()`, `createDraft()`), but can reply, or draft a
  reply, to messages in scope;
- ids outside the scope are refused exactly like ids that don't exist.

A whole-mailbox guard admits everything without a network round trip, so whole-mailbox bindings
behave as before.

The configurator (`configurator/fastmail-account-configurator-ui.tsx`) offers the three modes; the
folder list comes from the account through the configurator RPC, which also mints and parses the
resource URL (`FastmailAccountConfiguratorUI`), so the sandboxed module never re-implements the
encoding.

## Session API

See `types.d.ts` for the full agent-facing surface: `FastmailSession.listFolders/listThreads/
searchThreads/getThread/listMessages/searchMessages/getMessage/send/createDraft/listDrafts/getDraft/
subscribeNewMessages`, `FastmailMessageRef.read/getHeaders/thread/readAttachment/
readAttachmentAsMarkdown/moveToFolder/addKeyword/removeKeyword/markRead/markUnread/reply/
createReplyDraft` (one message, where the thread verbs act on the whole thread and a thread reply
answers its newest message), `FastmailThread.messages/reply/
createReplyDraft/readAttachment/moveToFolder/addKeyword/removeKeyword/markRead/markUnread`, and
`FastmailSendableDraft.getMetadata/getContent/update/delete/send`. Deliberately no Gmail-style
`archive()`/`trash()` convenience verbs — call `listFolders()`, find the folder whose `role` is
`"archive"`/`"trash"`, and pass its id to `moveToFolder()`.

Every mutation (a thread patch, a draft change, or a send) is queued via `ApprovalQueue.submitAction()` and only
actually reaches Fastmail once `FastmailGatekeeperImpl.applyAction()` is called on approval — so
`send()` returns once the send is *queued*, not once the message has left the account, matching
`JottacloudFileSession.write()`'s contract rather than a synchronous send. A thread patch
(`moveToFolder`/`addKeyword`/`removeKeyword`/`markRead`/`markUnread`) simulates its pending keyword
state so `FastmailThread.messages()` reflects the caller's own not-yet-approved edit immediately
(`cache.ts`); a queued `send()` has nothing to simulate.

The approval shows exactly what is sent (`src/approval.ts`, built with gatekeeper-kit's
`ActionDescriptionBuilder`): From, To, Cc, Bcc, Subject, a reply's In-Reply-To and References,
the full plain-text body, and the HTML body, including the one derived from the plain text when the
agent gave none. Such a description is marked complete. A thread change lists the messages it
touches (date, sender, subject) and the target folder or keyword.

## Drafts and sending

Drafts give the agent a way to prepare mail without sending it. `createDraft()` and
`FastmailThread.createReplyDraft()` save a message in the account's Drafts folder (`Email/set` with
`$draft`, no `EmailSubmission`), where the user can review, edit and send it in Fastmail. A draft
keeps a stable gatekeeper-assigned id across edits, because JMAP Emails are immutable apart from
keywords and mailboxes (RFC 8621 §4.6): every applied edit replaces the Email in one `Email/set`
(create the new copy, destroy the old one).

Each draft change is stored as a revision keyed by its action id (`cache.ts`, `drafts.ts`). The agent
always sees the newest revision, pending or applied, so it can keep editing without waiting for
approval. Applying a revision older than the one already applied is a no-op, so approvals arriving
out of order never overwrite newer content; rejecting a revision falls back to the newest remaining
one. `listDrafts()` covers the drafts created through this connection, not drafts the user wrote in
Fastmail (those are readable as threads in the Drafts folder), and edits the user makes to a draft
in Fastmail are not reflected back.

Sending a draft queues the exact content the agent sees as a snapshot. On approval the gatekeeper
submits that snapshot as a fresh Email and then discards the stored copy, so what leaves the account
is what the approver saw, even if the copy in Drafts changed meanwhile.

**Auto-approval.** `getAutoApprovableActions()` lists the kinds a user may opt in to approving
automatically: creating, editing and discarding drafts (`draftCreate`, `draftUpdate`,
`draftDelete`), read state (`readState`), keywords (`keyword`) and folder moves (`move`). Sending
(`send()`, `reply()`, a draft's `send()`) carries no action kind, so it always waits for a person.
Auto-approving the three draft kinds gives "the agent may prepare drafts, but nothing is sent
without me".

**Draft-only connections.** With a token that lacks Email submission, `describe()` advertises
`FastmailDraftOnlySession` instead of `FastmailSession`: the same surface without `send()`,
`reply()`, or a draft's `send()`. The runtime still refuses those calls (`requireSender()`), and
Fastmail refuses `EmailSubmission/set` for such a token regardless, so this mode is enforced by the
provider, not only by the gatekeeper. Drafts on such a connection use the JMAP session's `username`
as their From address when no sending identity is available. Grants stored before `username` was
recorded leave From unset on such drafts until the account is reconnected.

## New-mail hooks

`subscribeNewMessages(hook, { folderId? })` binds a hook that is called with each new message
arriving in the inbox, or in the folder named (e.g. one a Fastmail rule files mail into). It follows
gatekeeper-google's `subscribeNewMessages()`: the hook is a persistent stub, the user approves it
before anything is delivered, and each firing gets `{ message, folderId, thread }`, where `thread` is
a full `FastmailThread` (or `FastmailDraftOnlyThread`) whose writes are queued for approval like
any other. Drafts and mail received before the hook was enabled are never delivered; a message
moved into the folder later is an update, not new mail. Delivery is at least once and unordered,
retried with backoff (eight attempts), so hooks should key their work on `message.id`.

`src/hooks.ts` holds the mechanism. One `FastmailHookDriver` Durable Object per connection (named
by its `UserAccount` id, so one API token) keeps an `Email` state cursor and reads
`Email/changes` + `Email/get` (by back-reference, one request) from it; every email created in a
hook's folder since the hook was enabled is queued for that hook. Delivery goes through a
persistent self-stub of the binding's facet (`FastmailHookDeliveryImpl`), which re-reads the
message, re-checks the folder and draft state, authorizes the observation, and only then calls the
hook. If Fastmail can no longer compute changes from the stored state (`cannotCalculateChanges`),
the driver starts over from the current state and mail in that gap is not delivered.

The driver learns of new mail in two ways:

- **JMAP push** ([RFC 8620 §7.2](https://www.rfc-editor.org/rfc/rfc8620#section-7.2)). The driver
  creates a `PushSubscription` for `types: ["EmailDelivery"]` (state changes only on new mail,
  [RFC 8621 §1.5](https://www.rfc-editor.org/rfc/rfc8621#section-1.5)) pointing at
  `{BASE_URL}/push/{userObjectId}/{secret}`, with Web Push keys it generates and keeps in its own
  storage. Fastmail encrypts every push to those keys ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291),
  `aes128gcm`), first a `PushVerification` that the driver echoes back with `PushSubscription/set`,
  then a `StateChange` per delivery, which only makes the driver read changes now. A push that
  isn't for the driver's current subscription or doesn't decrypt gets a 404. The subscription is
  renewed a day before it expires, replaced when the connection's token changes (Fastmail destroys
  a subscription with its credentials), and destroyed when the last hook is disabled. One
  Fastmail hasn't verified within 10 minutes is dropped and retried hourly.
- **Polling**. Every 2 minutes while there is no verified subscription (a local or non-HTTPS
  `BASE_URL`, an unreachable push path, setup in progress), and every 15 minutes as a safety net
  while push works, since a push can be delayed or dropped. Each poll is one JMAP request.

### Receiving pushes behind Cloudflare Access

Fastmail must be able to `POST` to `{BASE_URL}/push/...` without signing in. On a deployment behind
Cloudflare Access, add a **Bypass** for that path (a self-hosted Access application for
`<host>/gatekeeper/fastmail/push` with a Bypass policy for Everyone; the more specific path wins
over the application protecting the host). Each subscription's URL carries a 256-bit secret, and a
push is acted on only if it decrypts with that subscription's keys; even then it carries only state
strings, so a forged one could at most make the driver read the mailbox with its own credentials.
Without the bypass, hooks still work at the 2-minute polling interval, and the driver retries push
hourly.

## Observers

Strategy A (private-only, see `write-gatekeeper` skill "Observer verification"): a personal mailbox
has no per-observer ACL Fastmail exposes to check a second connected account against, so
`addObserver()` always throws, matching Gmail's and Jottacloud's own rationale.

## Current scope

- A folder binding covers one folder, not its subfolders; a saved search uses JMAP filter fields,
  not Fastmail's web search syntax.
- New-mail hooks watch one folder each and report new mail only, not moves, flag changes or
  deletions.
- Drafts and sends carry no attachments.
- Token rotation is handled by reconnecting with a new token; there is no refresh-token cycle.
- Fastmail is not a sign-in identity provider (`getAuthenticatedEmail()` returns `null`), even though
  the connected account's own address is knowable.

## License

[MIT](LICENSE)
