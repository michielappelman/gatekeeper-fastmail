# Fastmail

Fastmail is a Cloudflare OS gatekeeper that gives the agent and gadgets access to a user's Fastmail
mailbox and contacts over [JMAP](https://www.fastmail.com/dev/). The agent can read, search and
organize mail, prepare drafts, send, reply and forward, react to new mail through hooks, and read
contacts. Every change waits for the user's approval; reads are recorded.

A user connects an account by pasting a Fastmail API token. There is no OAuth flow and no
deployment-wide secret.

## What a connection can do

| Capability | Methods | Needs approval |
|---|---|---|
| Browse and search | `listFolders`, `listThreads`, `searchThreads`, `listMessages`, `searchMessages`, `getThread`, `getMessage` | No (recorded) |
| Read a message | `read`, `getHeaders`, `readAttachment`, `readAttachmentAsMarkdown` | No (recorded) |
| Organize | `moveToFolder`, `addKeyword`, `removeKeyword`, `markRead`, `markUnread`; for many threads at once, `updateThreads` | Yes, auto-approvable |
| Draft | `createDraft`, `createReplyDraft`, `createForwardDraft`, draft `update`/`delete` | Yes, auto-approvable |
| Send | `send`, `reply`, `forward`, draft `send` | Yes, always by a person |
| Watch for new mail | `subscribeNewMessages` | The user enables each hook |
| Read contacts (contacts resource) | `listGroups`, `getGroup`, `listContacts`, `searchContacts`, `getContact` | No (recorded) |
| Change contacts | `createContact`, `updateContact`, `addToGroup`, `removeFromGroup` | Yes, auto-approvable |
| Delete contacts (whole-contacts binding only) | `deleteContact` | Yes, always by a person |

What a connection gets depends on two choices the user makes when connecting:

- **Token scope.** A token with Mail and Email submission gives a full connection
  (`FastmailSession`). A token with Mail only gives a **draft-only** connection
  (`FastmailDraftOnlySession`): the same surface without any send method. The agent prepares
  drafts, the user sends them from Fastmail, and Fastmail itself refuses a send for that token.
- **Binding scope.** The whole mailbox, one folder, or one saved search. A folder or search binding
  sees only the messages in scope and cannot write new mail, but can reply to and forward messages
  in scope. See [Binding scopes](#binding-scopes).

## Connecting an account

1. In Fastmail, open [**Settings → Password & Security → API tokens**](https://app.fastmail.com/settings/security/tokens)
   and create a token with **Mail** access. Add **Email submission** only if this connection should be
   able to send, and **Contacts** if it should read or change contacts (a read-only Contacts token
   can read them; approved changes then fail). App passwords (for IMAP, SMTP and POP)
   do not work with JMAP.
2. Paste the token into the gatekeeper's connect form.
3. Choose the binding scope in the configurator: whole mailbox, one folder, or a saved search.

On connect, `UserAccount.completeConnection()` calls `GET https://api.fastmail.com/jmap/session`
with the token. That one request validates the token and returns everything needed to use the
account: `apiUrl`, the `downloadUrl` and `uploadUrl` templates, the primary Mail `accountId`, and
whether the token carries Email submission. The token is stored in `UserAccount` and never reaches
an agent-facing object.

A token has no refresh cycle. It works until it is revoked in Fastmail. The first API call that
returns 401 is reported to the Workshop through `GatekeeperConnectCallback.credentialsExpired()`,
and the user reconnects with a new token.

## Agent API

The full contract lives in [`src/types.d.ts`](src/types.d.ts). Lists and searches return a
forward-only `Cursor`: call `next()` until it returns `null`.

```js
export default async function(self, env) {
  const folders = await env.FASTMAIL.listFolders();
  const archive = folders.find((f) => f.role === "archive");

  const cursor = await env.FASTMAIL.searchMessages({ text: "invoice", unread: true });
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
    for (const entry of page) {
      const message = await entry.ref.read();
      // { id, from, to, cc, subject, receivedAt, textBody?, htmlBody?, attachments, keywords, bulk }
      if (message.bulk.isBulk) continue;

      const pdf = message.attachments.find((a) => a.mimeType === "application/pdf");
      if (pdf) {
        const { markdown } = await entry.ref.readAttachmentAsMarkdown(pdf.blobId);
        // ...
      }
      await entry.ref.moveToFolder(archive.id);           // queued for approval
    }
  }
  cursor[Symbol.dispose]();
}
```

The object model:

- **Session** (`FastmailSession`, `FastmailDraftOnlySession`, or a scoped variant): folders,
  listings, searches, drafts, `send()` and hooks.
- **Thread** (`FastmailThread`): `messages()` oldest first; `reply()` and `createReplyDraft()`
  answer the newest message; organizing verbs act on every message in the thread.
- **Several threads** (`session.updateThreads(threadIds, change)`): one queued action, one approval
  and one `Email/set` for the in-scope messages of 1 to 500 threads (at most 1000 messages), with
  `change` one of `{ moveToFolder }`, `{ addKeyword }`, `{ removeKeyword }`, `{ markRead: true }` or
  `{ markUnread: true }`. A thread that is missing or has no message in scope refuses the whole call
  (the same error for both) before anything is queued. The approval lists a sample of the messages
  (each thread's newest first) and counts the rest. Narrowed bindings may only move into the folders
  `listFolders()` shows them, as for one thread.
- **Message** (`FastmailMessageRef`): `read()`, `getHeaders()`, attachments, `reply()`,
  `forward()`, and organizing verbs that act on that message only.
- **Draft** (`FastmailSendableDraft`): `getMetadata()`, `getContent()`, `update()`, `delete()`,
  `send()`.

**Searching.** `searchThreads()` and `searchMessages()` take a string (full text) or a
`FastmailSearch`: `text`, `from`, `to`, `subject`, `unread`, `flagged`, `hasKeyword`, `notKeyword`,
`hasAttachment`, `after` and `before` (dates as `YYYY-MM-DD` or a UTCDate). Every condition given
must match, and at least one is required; texts are capped at 256 characters. Conditions map to one
JMAP `FilterCondition`, except those sharing a key (e.g. `unread: true` with `notKeyword: "$draft"`,
or `unread: false` with `flagged: true`), which are ANDed in a filter operator. A narrowed binding's
folder or saved search is always ANDed with the caller's conditions. Messages report `folderIds`
(only folders the binding's `listFolders()` shows), so an agent can tell from a folder's `role`
where a message is, e.g. archived.

There are no Gmail-style `archive()` or `trash()` verbs. Find the folder whose `role` is
`"archive"` or `"trash"` in `listFolders()` and pass its id to `moveToFolder()`; folder names can be
renamed, roles cannot.

Errors carry a stable `FastmailErrorCode` (`src/errors.ts`), such as `AUTH_EXPIRED`,
`SUBMISSION_NOT_AUTHORIZED`, `CONTACTS_NOT_AUTHORIZED`, `RESOURCE_NOT_FOUND`,
`UNSUPPORTED_FOR_MARKDOWN` and `TOO_LARGE_FOR_MARKDOWN`.

## How a change runs

Every mutation goes through the session's `ApprovalQueue`:

1. The method validates its input and checks the target against the binding's `ScopeGuard`.
2. It builds an approval description with gatekeeper-kit's `ActionDescriptionBuilder`
   (`src/approval.ts`) and calls `ApprovalQueue.submitAction()`. The method returns once the action
   is queued. `send()` resolving does not mean the mail has left the account.
3. Until the action resolves, the agent sees its own pending edit: keyword changes are simulated
   per message (`src/cache.ts`), and a draft shows its newest revision. Folder moves and sends are
   not simulated.
4. On approval, `FastmailGatekeeperImpl.applyAction()` performs the JMAP call. The pending record is
   deleted only after Fastmail accepts it, so a failed apply stays approvable; an in-memory
   in-flight set stops a double approval from applying it twice.

The approval shows exactly what is sent: From, To, Cc, Bcc, Subject, a reply's In-Reply-To and
References, the full plain-text body, the HTML body (including one derived from plain text), and
every attachment. A thread change lists the messages it touches (date, sender, subject) and the
target folder or keyword.

**Auto-approval.** `getAutoApprovableActions()` lists the kinds a user may opt in to applying
automatically: `draftCreate`, `draftUpdate`, `draftDelete`, `readState`, `keyword` and `move`.
`updateThreads()` carries the same kind as the single-thread verb it stands for.
Anything that sends mail carries no action kind, so it always waits for a person. Auto-approving the
three draft kinds gives "the agent may prepare drafts, but nothing is sent without me".

Approved changes are not reversible through the gatekeeper.

## Binding scopes

`FASTMAIL_RESOURCE` (`src/resource.ts`) is one resource per connected account, narrowed by the
URL's hash:

| Binding | Resource URL | Session type |
|---|---|---|
| Whole mailbox | `https://api.fastmail.com/jmap/mail/account` | `FastmailSession` / `FastmailDraftOnlySession` |
| One folder | `…/account#mailbox/<JMAP Mailbox id>` | `FastmailScopedSession` / `FastmailScopedDraftOnlySession` |
| Saved search | `…/account#search/<percent-encoded canonical JSON filter>` | as for a folder |

A folder binding admits the messages currently in that folder, not its subfolders. Mailbox ids
survive renames. A saved search is a structured filter (`from`, `to`, `subject`, `text`,
`hasKeyword`, `folderId`, `after`, `before`; at least one) mapped to a JMAP `FilterCondition`, never
a free-text query, so the gatekeeper can check a single message against it. For example, a binding
for mail from one sender:

```text
https://api.fastmail.com/jmap/mail/account#search/%7B%22from%22%3A%22billing%40example.com%22%7D
```

`ScopeGuard` (`src/scope.ts`) enforces the scope on every path:

- Listings and searches get the scope ANDed into their `Email/query` filter. Asking a folder
  binding for another folder is refused.
- Every thread, message and hook capability re-checks admission on each read or change. A message
  that leaves the folder or stops matching the search leaves scope. A thread shows only its
  admitted messages, and replies, attachments and changes reach only those.
- Search admission is decided by Fastmail: one `Email/query` for the stored filter AND the
  messages' `Message-ID` headers (RFC 8621 `header` condition). Mail without a Message-ID is never
  admitted.
- `listFolders()` shows only the binding's own folder plus Inbox, Archive, Trash and Junk, and mail
  can be moved only into those. A parent folder outside that set shows as `parentId: null`.
- `send()` and `createDraft()` are not available; replying, drafting a reply and forwarding a
  message in scope are.
- Ids outside the scope are refused exactly like ids that do not exist.

A whole-mailbox guard admits everything without a network round trip.

The configurator (`src/configurator/fastmail-account-configurator-ui.tsx`) offers the three modes.
It loads the folder list through the configurator RPC, which also mints and parses the resource URL
(`FastmailAccountConfiguratorUI`), so the sandboxed module never re-implements the encoding.

## Contacts

`FASTMAIL_CONTACTS_RESOURCE` is a second, read-only resource of the same connected account, served
by its own Durable Object (`FastmailContactsGatekeeperImpl`, `src/contacts.ts`) over JMAP for
Contacts ([RFC 9610](https://www.rfc-editor.org/rfc/rfc9610)):

| Binding | Resource URL | Session type |
|---|---|---|
| All contacts | `https://api.fastmail.com/jmap/contacts/account` | `FastmailContactsSession` |
| One contact group | `…/account#group/<group ContactCard id>` | `FastmailGroupContactsSession` |

A contact group is a ContactCard of kind `group` whose `members` set lists the `uid`s of the cards
in it. A group binding re-reads that set for every page and every `getContact()`, so membership is
live: listings query `ContactCard/query` with the members' uids ORed in, a card outside the group is
refused exactly like a missing one, and a deleted group makes every call fail as not found. Group
cards themselves are never returned as contacts. They are dropped by the gatekeeper after the query
(the cursor's `retain`), not by a `kind` condition: Fastmail mis-parses a `kind` condition nested in
a filter operator (it moves `kind` onto the operator and leaves `{}`, so `NOT {kind: "group"}`
matches nothing), while nested `uid` and `text` conditions work.

The token needs the **Contacts** scope. Its contacts account comes from the session resource's
`primaryAccounts["urn:ietf:params:jmap:contacts"]`; a grant stored before contacts were supported
looks it up once on first use (`UserAccount.getContactsGrant()`). A token without it fails with
`CONTACTS_NOT_AUTHORIZED` until the account is reconnected with one that has it.

Changes are queued for approval and written by `applyAction()` with `ContactCard/set`; nothing
is simulated, so a change shows up in listings only once applied. Creating, editing and group
membership carry the `contactCreate`/`contactUpdate`/`contactGroup` action kinds and may be
auto-approved; `deleteContact()` carries none, so a person always approves it. The approval shows
the exact JSContact card for a creation, and for an edit the requested changes as given
(`src/contact-input.ts` maps the agent's input to JSContact).

- `createContact()` writes into the default address book. Its `uid` is minted when queued, so an
  apply retried after a lost response finds the card instead of creating a second one. Given a
  group (always, in a group binding), applying first adds that `uid` to the group's `members` (one
  `ContactCard/set`, which fails if the group is gone, so no card is created), then creates the card
  in a second one; each step is skipped when already done, so a retry completes either.
- `updateContact(id, changes: FastmailContactChanges)` edits per entry. `emails`, `phones`,
  `nicknames`, `organizations`, `titles`, `addresses` and `online` take `{ add?, remove? }`: `add`
  appends entries under fresh map keys (a value already present is not added again), `remove`
  deletes the matching ones (emails by address, case-insensitive; phones by digits and a leading
  `+`; the rest by the exact string `FastmailContact` shows). `name` sets `name/full`; `givenName`
  and `surname` replace only that component kind inside `name.components`, keeping the others
  (prefix, middle, ...); `birthday`, `notes` and `kind` replace; `null` removes. Entries the
  changes don't touch, with all their properties (structured address components, ...), stay as they
  are. Staging refuses an empty change and a `remove` value that isn't on the card
  (`INVALID_RESOURCE`, naming it).
  Nothing is resolved when staging: the approval stores the validated changes, and applying reads
  the card and the contacts `state`, builds a per-key PatchObject (`emails/<key>`, `name/full`,
  `name/components`, ...) and sends it with `ifInState`. On `stateMismatch` it re-reads and
  recomputes, up to 3 attempts, then fails with the action still approvable. A value to remove
  that is already gone is a no-op, so edits made between staging and approval are kept.
- A group binding's changes reach only the group's current members, checked when queued and again
  when applied. It can remove members from its group but not add existing contacts to it, and it
  has no `deleteContact()` (refused at runtime too, pointing to `removeFromGroup()`): deleting
  removes the contact from the whole account.

The configurator (`src/configurator/fastmail-contacts-configurator-ui.tsx`) offers all contacts or
one group, loading groups through `FastmailContactsConfiguratorUI`.

## Drafts and sending

`createDraft()`, `createReplyDraft()` and `createForwardDraft()` save a message in the account's
Drafts folder (`Email/set` with `$draft`, no `EmailSubmission`), where the user can review, edit
and send it in Fastmail.

JMAP Emails are immutable apart from keywords and mailboxes (RFC 8621 §4.6), so every applied edit
replaces the Email in one `Email/set` (create the new copy, destroy the old one). The gatekeeper
gives each draft a stable id across those replacements.

Each draft change is stored as a revision keyed by its action id (`src/drafts.ts`):

- The agent always sees the newest revision, pending or applied, so it can keep editing without
  waiting for approval.
- Applying a revision older than the one already applied is a no-op, so out-of-order approvals
  never overwrite newer content.
- Rejecting a revision falls back to the newest remaining one.

`listDrafts()` covers every draft in the Drafts folder on a whole-mailbox binding: first the drafts
held by this connection (created here, or opened with `getDraft()`), each under its stable
gatekeeper id, then the other Emails in the Drafts-role mailbox (up to the 100 newest, oldest first)
under their own Fastmail email ids. The two id kinds are told apart by lookup: `getDraft(id)` first
tries a draft record, then treats `id` as a JMAP email id. Opening a Fastmail email id **adopts**
that draft: nothing is queued, a draft record is created whose applied revision is the Email's
current content (addressees, subject, text and HTML bodies, `In-Reply-To`/`References`, and its
attachments as references to their existing blobs, so editing doesn't re-upload them), and the
draft then has a stable id (`getMetadata().id`), which `listDrafts()` shows from then on. Edits,
`send()` and `delete()` use the normal revisions, and applying one replaces or destroys the adopted
Email. Changes to an adopted draft are never auto-approved, since you wrote it rather than the agent.
If you edit or discard the draft in Fastmail after it was opened (Fastmail replaces the Email on
every save), the adopted copy is dropped on the next `listDrafts()`/`getDraft()` and the Email's new
version appears under its new Fastmail id; an edit, send or delete of the old copy is refused with
`RESOURCE_NOT_FOUND`, at queue time and again at approval time. A folder or search binding lists
and opens only drafts created through its connection: other drafts are out of scope.

Sending a draft queues the content the agent sees as a snapshot. On approval the gatekeeper submits
that snapshot as a fresh Email (created in Drafts, submitted with the sending `identityId`, and moved
to Sent through `onSuccessUpdateEmail`, all in one JMAP request), then discards the stored copy. What
leaves the account is what the approver saw.

Replies set `In-Reply-To` and `References` from the message being answered. Fastmail threads on
those headers, not on the subject, so a reply sent through plain `send()` would land outside the
thread. The answered message gets `$answered` after the send succeeds.

On a draft-only connection, `requireSender()` refuses every send path at runtime as well, and drafts
use the JMAP session's `username` as From when no sending identity is available. Grants stored
before `username` was recorded leave From unset until the account is reconnected.

## Attachments

Sends, replies, forwards, drafts and draft edits take `attachments` (`FastmailOutgoingAttachment`):

```js
// New content
{ filename: "report.pdf", mimeType: "application/pdf", content: arrayBuffer }
// An attachment already in the account, attached by blob id without download or upload
{ fromMessageId: message.id, blobId: message.attachments[0].blobId }
```

At most 20 attachments and 10 MiB in total per message, existing ones included. Nothing reaches
Fastmail before approval (`src/attachments.ts`):

- **New content** is validated (single-line filename, `type/subtype` MIME type), hashed, and stored
  in the binding's Durable Object storage under its SHA-256 in 512 KiB chunks. Drafts and sends hold
  a reference, so editing a draft does not copy its attachments. On approval it is uploaded to the
  JMAP upload endpoint (RFC 8620 §6.1). Uploading earlier would risk Fastmail discarding an
  unreferenced blob during a slow approval, or leave blobs behind after a rejection. Content no
  pending send or draft references is deleted after every approval and rejection.
- **An existing attachment** is admitted only from a message the binding's scope admits, and only
  if the blob is one of that message's attachments.

The approval lists each attachment's filename, type and size, plus the SHA-256 of new content or
the date, sender and subject of the message an existing one comes from.

`readAttachmentAsMarkdown()` converts HTML, PDF, and common office formats (Word, Excel,
OpenDocument, Apple Numbers) through the Worker's `WORKERS_AI` binding (`toMarkdown()`, the same
mechanism as the Workshop's `webFetch`). Unsupported types and attachments over 10 MiB are refused
from their metadata before anything is downloaded.

## Forwarding

`forward(to, body?, options?)` and `createForwardDraft()` forward one message:

- Subject `Fwd: …`, unless it already starts with `Fwd:` or `Fw:`.
- The caller's optional note, then the original under a `---------- Forwarded message ----------`
  block with its From, Date, Subject, To and Cc. The Date is the original's `Date` header.
- The plain-text part quotes the original's text, or a text rendering of its HTML. When the
  original has HTML, the HTML part quotes its `<body>` in a `<blockquote type="cite">`.
- The original's attachments are attached by blob id. Inline images keep `disposition: inline` and
  their `cid`, so the quoted HTML still shows them. `includeAttachments: false` leaves them out;
  `attachments` adds more.
- A forward is a new message: no In-Reply-To or References. The original gets `$forwarded` once it
  is sent.

## Bulk-mail signals

Every `FastmailMessage` and `FastmailMessageEntry` carries `bulk` (`FastmailBulkSignals`), so the
agent can triage newsletters and notifications without fetching raw headers:

```js
{
  isBulk: true,                      // List-Id, List-Unsubscribe, or Precedence bulk/list/junk
  listId: "news.example.com",
  unsubscribe: ["https://example.com/u/abc", "mailto:unsub@example.com"],
  oneClickUnsubscribe: true,         // RFC 8058
  precedence: "bulk",
  autoSubmitted: "auto-generated",   // automated mail, reported separately from isBulk
}
```

They come from header properties Fastmail parses in the same `Email/get`
(`header:List-Id:asText`, `header:List-Unsubscribe:asURLs`, RFC 8621 §4.1.2), so they cost no extra
request. The headers are set by the sender: a missing marker proves nothing, and the gatekeeper
never opens an unsubscribe URL.

## New-mail hooks

`subscribeNewMessages(hook, { folderId? })` calls a gadget for each new message arriving in the
Inbox, or in the named folder (for example one a Fastmail rule files mail into). On a scoped
binding it watches the binding's scope. It follows gatekeeper-google's `subscribeNewMessages()`:

- The hook is a persistent stub. It starts disabled, and nothing is delivered until the user
  enables it.
- Each delivery gets `{ message, folderId, thread, ref }`. Writes through `thread` and `ref` are
  queued for approval like any other.
- Drafts and mail received before the hook was enabled are never delivered. A message moved into
  the folder later is not new mail.
- Delivery is at least once and unordered, retried with backoff (eight attempts), so key work on
  `message.id`.

```js
// server.js (the gadget)
import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type === "fastmail") return new Triage();
    throw new TypeError(`Unknown restore type: ${params.type}`);
  }
}
class Triage extends RpcTarget {
  async receiveMessage({ message, thread }) {
    if (/urgent/i.test(message.subject)) await thread.addKeyword("$flagged");
  }
}

// executeCode
import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.FASTMAIL.subscribeNewMessages(await env.MY_GADGET[restore]({ type: "fastmail" }));
}
```

### How new mail is detected

`src/hooks.ts` runs one `FastmailHookDriver` Durable Object per connection (named by its
`UserAccount` id, so one per API token). It keeps an `Email` state cursor and reads `Email/changes`
plus `Email/get` by back-reference in one request. Every email created in a hook's folder since the
hook was enabled is queued for that hook. Delivery goes through a persistent self-stub of the
binding's facet (`FastmailHookDeliveryImpl`), which re-reads the message, re-checks folder, scope
and draft state, authorizes the observation, and only then calls the hook. If Fastmail can no
longer compute changes from the stored state (`cannotCalculateChanges`), the driver restarts from
the current state and mail in that gap is not delivered.

The driver learns of new mail in two ways:

- **JMAP push** ([RFC 8620 §7.2](https://www.rfc-editor.org/rfc/rfc8620#section-7.2)), usually
  within seconds. The driver creates a `PushSubscription` for `types: ["EmailDelivery"]`
  ([RFC 8621 §1.5](https://www.rfc-editor.org/rfc/rfc8621#section-1.5)) pointing at
  `{BASE_URL}/push/{userObjectId}/{secret}`, with Web Push keys it generates and keeps in its own
  storage. Fastmail encrypts every push to those keys
  ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), `aes128gcm`, `src/webpush.ts`): first a
  `PushVerification` that the driver echoes back with `PushSubscription/set`, then a `StateChange`
  per delivery, which only prompts the driver to read changes. A push that is not for the current
  subscription or does not decrypt gets a 404. The subscription is renewed a day before it expires,
  replaced when the token changes (Fastmail destroys a subscription with its credentials), and
  destroyed when the last hook is disabled. One that Fastmail has not verified within 10 minutes is
  dropped and retried hourly.
- **Polling.** Every 2 minutes while there is no verified subscription (a local or non-HTTPS
  `BASE_URL`, an unreachable push path, setup in progress), and every 15 minutes as a safety net
  while push works. Each poll is one JMAP request.

## Security

- **Token isolation.** The API token lives only in `UserAccount`. Sessions, threads, messages,
  drafts and hooks never hold it. Push keys and the push URL secret live only in the hook driver's
  storage.
- **Capability boundary.** `ScopeGuard` is checked on every read and change, including cached and
  simulated results, attachments and hook deliveries. Authorization is never inferred from a
  folder, thread or message id.
- **Sending.** Every send path waits for a person. On a draft-only connection the gatekeeper does
  not advertise send methods, refuses them at runtime, and Fastmail refuses `EmailSubmission/set`
  for the token, so the mode is enforced by the provider as well.
- **Observers.** Strategy A (private-only, see the `write-gatekeeper` skill's "Observer
  verification"): Fastmail exposes no per-observer ACL on a personal mailbox to check a second
  account against, so `addObserver()` always throws, as in the Google and Jottacloud gatekeepers.
- **Push endpoint.** The push path is unauthenticated by design (see below). Each subscription URL
  carries a 256-bit secret, a push is acted on only if it decrypts with that subscription's keys,
  and even then it carries only state strings. A forged push could at most make the driver read the
  mailbox with its own credentials.

## Why JMAP

Fastmail's JMAP API ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) core,
[RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) mail) is JSON over HTTPS, which fits a Worker's
`fetch()` model; IMAP is a stateful binary protocol that does not. JMAP also gives server-side
threading, batched method calls with back-references, push, and structured header parsing, which
this gatekeeper relies on.

No JMAP client library on npm suits Workers, so `src/fastmail-api.ts` speaks the protocol directly,
as `gatekeeper-jottacloud` does for JFS. Wire types are in `src/fastmail-types.ts`; session and
capability logic stays in `src/fastmail.ts`. Upstream HTTP and method errors are mapped to stable
`FastmailErrorCode` values, so session code never branches on raw JMAP error strings.

The gatekeeper follows the upstream `write-gatekeeper` skill
(`cloudflare-os/.agents/skills/write-gatekeeper/SKILL.md`). Its connect flow is modeled on
`gatekeeper-homeassistant` (pasted credential), and its session and capability design on
`gatekeeper-google`, adapted from Gmail's labels to JMAP's Mailbox and Keyword model.

## Deployment

This repository is consumed as a Git submodule by a
[`cloudflare-os-starter`](https://github.com/cloudflare/cloudflare-os-starter)-style deployment. It
is not an npm package: its `@gadgets/*` dependencies resolve from the Cloudflare OS workspace pinned
in the starter, which keeps the Gatekeeper Kit ABI aligned with the deployment.

From the root of the starter:

```sh
git submodule add https://github.com/michielappelman/gatekeeper-fastmail.git packages/gatekeeper-fastmail
git submodule update --init --recursive
pnpm install
```

The starter must include `packages/*` in `pnpm-workspace.yaml`, and its deploy wrapper must treat
`packages/gatekeeper-fastmail` as the Fastmail Worker package:

1. Use this package's `wrangler.jsonc` as the base config. It is generated from
   `cloudflare.config.ts`: edit that, then run `pnpm configs:generate` from the starter root.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL`, and observability settings.
3. Run `vp run -F gatekeeper-fastmail --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter and record it in the deployment inventory.

What the Worker needs:

- **Bindings.** `WORKERS_AI` (Workers AI, for `readAttachmentAsMarkdown()`), and Durable Objects
  `UserAccount`, `FastmailGatekeeperImpl`, `FastmailHookDriver` and `FastmailContactsGatekeeperImpl`
  (SQLite-backed, migrations `v0` to `v2`). Compatibility flags `nodejs_compat` and
  `allow_irrevocable_stub_storage`.
- **`BASE_URL`.** The public URL the router serves the gatekeeper on, for example
  `https://os.example.com/gatekeeper/fastmail`. JMAP push needs it to be public HTTPS; otherwise
  hooks fall back to polling.
- **No secrets.** Each user pastes their own token.
- **Routing.** The starter's `workers.fastmail.name` is the deployed Worker name and need not be
  `gatekeeper-fastmail`. The public router is the only route: the Worker should have no
  `workers.dev` or preview URL.

### Receiving pushes behind Cloudflare Access

Fastmail must be able to `POST` to `{BASE_URL}/push/...` without signing in. Behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/), add a
self-hosted Access application for `<host>/gatekeeper/fastmail/push` with a
[Bypass policy](https://developers.cloudflare.com/cloudflare-one/policies/access/#bypass) for
Everyone. The more specific path wins over the application protecting the host. Without the bypass,
hooks still work at the 2-minute polling interval and the driver retries push hourly.

### Development

Run tests and type checks from the consuming starter once the Cloudflare OS submodule is
initialized:

```sh
pnpm --filter gatekeeper-fastmail test:run
pnpm --filter gatekeeper-fastmail types:check
```

Tests use mocked `fetch` and need no Fastmail credentials. Keep the Cloudflare OS submodule and this
gatekeeper pinned together: if either changes, run the gatekeeper tests, the starter's type checks,
and the full starter check before updating the submodule gitlinks. Implementation invariants for
contributors and agents are in [AGENTS.md](AGENTS.md).

## Known limits

- **Folders, not subfolders.** A folder binding covers one folder. A saved search uses JMAP filter
  fields, not Fastmail's web search syntax.
- **Hooks report new mail only.** One folder (or scope) per hook; no moves, flag changes or
  deletions. Mail arriving during a `cannotCalculateChanges` gap is not delivered.
- **Drafts are one-way.** `listDrafts()` also lists drafts Fastmail holds that this connection didn't
  make (the 100 newest in the Drafts folder), but a draft's content is a snapshot taken when it is
  opened. If the draft is edited or discarded in Fastmail afterwards (which replaces the Email), the
  stale copy is dropped and the new Email is listed as a fresh native draft; changes already queued
  against the old copy are refused as no longer existing. A native draft's reply link is only its
  `In-Reply-To`/`References` headers, so sending it doesn't mark the original `$answered`.
- **No send receipt.** `send()`, `reply()` and `forward()` resolve when queued, and return no
  message id.
- **Token rotation is a reconnect.** There is no refresh cycle.
- **Not an identity provider.** `getAuthenticatedEmail()` returns `null`, even though the account's
  address is knowable.
- **Untrusted content.** Message bodies, headers and attachments come from senders. An agent that
  reads them can meet a prompt injection.

## License

[MIT](LICENSE)
