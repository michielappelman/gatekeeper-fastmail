# Agent guide

## What this repository is

`gatekeeper-fastmail` is a Cloudflare Worker package for Cloudflare OS. It exposes two scoped
resources of one connected Fastmail account: the mailbox, where the agent can list/search threads,
read messages and attachments, organize messages, prepare drafts, and optionally send mail; and the
contacts, either all of them or one contact group, where it can read them and queue changes.

This repository is normally a Git submodule under `cloudflare-os-starter/packages/`. It is not a
standalone npm package: `@gadgets/*` dependencies resolve from the consuming Cloudflare OS
workspace.

Read [README.md](README.md) for deployment and user-facing behavior. Use this file for the
implementation constraints that are easy to miss.

## Related repositories and references

- [Cloudflare OS starter](https://github.com/michielappelman/cloudflare-os-starter): the consuming
  workspace and deployment host. In this workspace it is normally available at
  `../cloudflare-os-starter/`.
- [`@gadgets/gatekeeper-kit`](https://github.com/michielappelman/cloudflare-os/tree/main/packages/gatekeeper-kit):
  the shared library used for connect pages, credential staging, nonces, cursors, and Worker
  plumbing. Use the copy pinned by the starter (`../cloudflare-os-starter/cloudflare-os/packages/gatekeeper-kit/`).
  Read its `AGENTS.md`, `README.md`, and `USAGE.md` before changing those integrations.
- [Fastmail JMAP developer documentation](https://www.fastmail.com/dev/): service discovery and
  Fastmail-specific behavior.
- [JMAP Core RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) and [JMAP Mail RFC
  8621](https://www.rfc-editor.org/rfc/rfc8621): protocol contracts for the direct client.

## Start here

1. Check `git status` before editing and preserve unrelated worktree changes.
2. Read `src/types.d.ts` for the agent-facing `FastmailSession` and `FastmailThread` contracts.
3. Read `src/resource.ts` for the whole-mailbox resource URL and its strict parser.
4. Read `src/fastmail.ts` for `UserAccount`, the gatekeeper Durable Object, and session behavior.
5. Read the focused tests before changing JMAP request shapes, action handling, or resource rules.

The important code paths are:

```text
src/fastmail.ts       Worker entrypoint, UserAccount, gatekeeper DO, sessions, configurator
src/fastmail-api.ts   Direct JMAP fetch client and Fastmail session discovery
src/fastmail-types.ts JMAP wire types and capability constants
src/resource.ts       Resource URLs: mailbox (whole, folder, saved search) and contacts (all, group)
src/contacts.ts       Contacts resource: its gatekeeper DO, session, apply, configurator RPC
src/contact-input.ts  Agent contact input → JSContact card properties, with validation
src/scope.ts          ScopeGuard: what a binding admits, enforced on every path
src/cache.ts          Folder cache, pending actions, simulated keyword overlays, draft records
src/drafts.ts         Draft revision ordering: what the agent sees, apply and reject
src/errors.ts         Stable FastmailErrorCode mapping
src/hooks.ts          New-mail hooks: controller, per-connection driver DO, push route
src/hook-delivery-queue.ts  Per-hook retrying delivery queue (copied from gatekeeper-google)
src/webpush.ts        Web Push (RFC 8291 aes128gcm) key generation and decryption
src/attachments.ts    Outgoing attachments: stored by SHA-256 until approval, uploaded on apply
src/configurator/     Zero-field whole-mailbox configurator source/types
__tests__/             JMAP, resource, cache, and configurator tests
```

## Non-negotiable invariants

- The resource URL is `https://api.fastmail.com/jmap/mail/account`, optionally narrowed by
  `#mailbox/<id>` (one folder) or `#search/<canonical JSON filter>` (a saved search). The
  `urlPattern` and the bare whole-mailbox URL are deployed identity; never change their meaning.
- The contacts resource URL is `https://api.fastmail.com/jmap/contacts/account`, optionally narrowed
  by `#group/<group ContactCard id>`; its `urlPattern` is deployed identity too. A group binding
  re-reads the group's `members` on every listing and `getContact()`; a card outside it is refused
  exactly like a missing one, and group cards are never returned as contacts. Contact changes are
  queued for approval, and the scope is re-checked when they are applied. `deleteContact()` must
  never carry an `actionKind`/`autoApprovable`, and a group binding must not have it at all (absent
  from `FastmailGroupContactsSession`, refused at runtime); a group binding must never add existing
  contacts to its group.
- Resource parsing must reject foreign hosts, paths, query strings, malformed URLs, unknown hash
  forms, unknown search fields, and empty searches.
- The binding's `ScopeGuard` (`src/scope.ts`) is the capability boundary. Every read and change goes
  through it, including threads, single messages, attachments, replies, folder moves and hook
  deliveries; never infer authorization from a folder, thread or message id. Out-of-scope ids must
  be refused exactly like missing ones. Narrowed bindings can't write new mail.
- `UserAccount` owns the Fastmail API token and resolved JMAP account information. The token must
  not reach agent-facing session objects.
- Fastmail API tokens are bearer tokens, not OAuth grants. There is no refresh cycle. A 401 must
  become `AUTH_EXPIRED`, notify the Workshop once, and require reconnecting with a new token.
- Connect validation must confirm Mail capability through `GET /jmap/session` before storing the
  grant. Every send path (`send()`, `reply()`, a draft's `send()`) also requires Email submission
  capability and a usable sender identity (`requireSender()`). A grant without them is advertised
  as `FastmailDraftOnlySession`, which has no send methods.
- Every read path authorizes observation through `ApprovalQueue`, including cached and simulated
  results. Every mutation is queued for approval, except `createMaskedEmail()`, which by design
  creates the address immediately (it only authorizes observation). Draft changes, read state,
  keywords and moves carry an `actionKind` and `autoApprovable: true`, so a user may opt in to
  applying them automatically; anything that sends mail, and `deleteMaskedEmail()`, must never carry
  either, so it always waits for a person.
- Masked Email (`https://www.fastmail.com/dev/maskedemail`, its own token scope, account from
  `UserAccount.getMaskedEmailGrant()`) is whole-mailbox only (`requireWholeMailbox`), absent from the
  scoped session types. Deleting sets `state: "deleted"`; an apply that finds the address gone is a
  no-op.
- Mailbox bindings are private to the connecting account. Observer sharing is intentionally
  rejected.
- `moveToFolder()` takes a Mailbox id. Use `listFolders()` and the stable `role` field to find
  archive/trash/etc.; do not add Gmail-style `archive()` or `trash()` shortcuts.
- Mutations are not automatically reversible. Do not claim that sending, moving, or keyword edits
  can be reverted through the Gatekeeper.
- New-mail hooks never store the gadget's callback: the overseer does, through `bindHook()`, and the
  driver gets a fresh one from `HookInitiator.startHook()` per delivery. What a hook may see is
  decided by `FastmailHookDeliveryImpl` in the facet, not by the driver's prefilter, and every
  delivery authorizes its observation before calling the hook.
- A push is acted on only if it reaches the driver's current subscription URL secret and decrypts
  with that subscription's keys. The push private key and secret stay in the driver's storage; the
  API token stays in `UserAccount`.

## JMAP protocol boundary

There is no suitable Worker-native JMAP SDK in this package. Keep JSON request/response handling in
`src/fastmail-api.ts` and wire types in `src/fastmail-types.ts`; keep session and capability logic
in `src/fastmail.ts`.

Important protocol details:

- Discover `apiUrl`, download/upload templates, the primary Mail `accountId`, and capabilities from
  `https://api.fastmail.com/jmap/session` using `Authorization: Bearer <apiToken>`.
- Use JMAP Core + Mail capabilities for reads and mutations; include Submission only when the token
  supports it. At approval time, `resolveSendContext()` looks up the Drafts/Sent mailboxes and the
  sending Identity; `sendEmail()` then creates the draft in Drafts and submits it with that
  `identityId` in one JMAP request, moving it to Sent via `onSuccessUpdateEmail`.
- Thread listings use `Email/query` followed by `Email/get`, with `collapseThreads: true`, newest
  first, and `OffsetCursor` pages of 25. Preserve the requested id order because `Email/get` does
  not guarantee response order.
- Apply thread mutations with one `Email/set` patch to every message id in the thread.
- `updateThreads()` resolves its threads with one `Thread/get`, admits the messages through
  `ScopeGuard.admit()` in chunks of 500, and applies the pending patch as one `Email/set`. It caps
  the admitted messages at 1000 (`MAX_BULK_MESSAGES`), an assumption about a server's
  `maxObjectsInSet` that was not verified against Fastmail.
- Agent searches (`string | FastmailSearch`) go through `normalizeSearch()` in `src/resource.ts`,
  sharing its text, keyword and date validation with the saved-search scope, and become one
  `FilterCondition`; conditions colliding on a key (`unread`/`flagged` vs `hasKeyword`/`notKeyword`)
  are ANDed in an operator. `ScopeGuard.listFilter()` ANDs that with the scope: a plain condition
  may merge into a folder's `{inMailbox}`, an operator never does.
- Message and thread-message `folderIds` come from `mailboxIds`, filtered through
  `ScopeGuard.visibleFolders()` for narrowed bindings so no other folder id leaks.
- Convert upstream HTTP and method errors into stable `FastmailErrorCode` values. Session code
  should not branch on raw response bodies or JMAP error strings.
- Contacts use JMAP Core + Contacts (RFC 9610) against `primaryAccounts[urn:ietf:params:jmap:contacts]`.
  A group's `members` keys are its member cards' plain `uid`s, so group listings query an OR of
  `{uid}` conditions. Never put a `kind` condition inside a filter operator: Fastmail hoists it onto
  the operator (seen live: `NOT {kind: "group"}` matches nothing), so contact listings drop group
  cards client-side through `OffsetCursor`'s `retain`, which keeps paging by the raw page.
- A creation carries a `uid` minted when it was queued, so a retried apply looks the card up by
  `uid` instead of creating it twice, and goes into the default `AddressBook`. In a group it is
  two `ContactCard/set`s, in this order: add the `uid` to the group's `members` (fails if the group
  is gone, so nothing is created), then create the card; each is skipped when already done.
- An edit is never stored as a patch. `updateContact()` stores the validated
  `FastmailContactChanges`; `applyContactAction` reads the card and `state` at apply time, plans
  per-key paths with `planContactPatch()` (`emails/<key>`, `name/components`, ...; whole-property
  replacement would lose concurrent edits and properties `FastmailContact` doesn't show) and sends
  `ContactCard/set` with `ifInState`, recomputing on `stateMismatch` up to 3 attempts. Removals
  already satisfied are no-ops; at staging a removal that matches nothing is `INVALID_RESOURCE`.
  Keep the match rules in `contact-input.ts` in step with how `toAgentContact` shows each value.
- Masked Email calls `MaskedEmail/get` and `MaskedEmail/set` with `using` Core + the Masked Email
  capability only, against `primaryAccounts[https://www.fastmail.com/dev/maskedemail]`. A creation
  sends `state: "enabled"` (a `pending` address expires after 24 hours unused) and `forDomain`
  normalized to a URL origin; a delete is an update to `state: "deleted"`, with `notFound` treated
  as done. These shapes follow Fastmail's documentation and were not verified against a live account.

When changing protocol code, update `__tests__/fastmail-client.test.ts` (mail),
`__tests__/contacts.test.ts` (contacts; its fake reproduces Fastmail's `kind` quirk) or
`__tests__/masked-email.test.ts` (masked email) and keep the tests using mocked `fetch`; no Fastmail
credentials belong in the repository.

## Cache and pending-action behavior

- Folder lists are cached for 30 seconds.
- Each pending mutation is stored by action id until `applyAction()` or `rejectAction()` resolves
  it. Do not delete a pending record merely because `submitAction()` throws: the overseer may have
  committed the action even if the RPC response was lost.
- `applyAction()` deletes the pending record only after the Fastmail call succeeds. The overseer
  keeps an action pending when `applyAction()` throws, so a failed apply must stay approvable; an
  in-memory in-flight set stops a concurrent second approval from applying it twice.
- Keyword mutations set per-email simulated overlays immediately, so `messages()` reflects the
  caller's pending keyword changes. Clear an overlay only if the resolving action is still the
  latest overlay for that email.
- Folder moves do not have a simulated folder-membership view.
- `updateThreads()` is one `patch` pending action over the admitted messages of all its threads,
  built by the same `MessageSet.moveToFolder()`/`patchKeyword()` as the single-thread verbs (same
  action kinds, overlays and folder restrictions); thread ids are checked, as one all-or-nothing
  refusal, before anything is queued.
- Sends have no simulation and are irreversible; `send()` resolves when queued, not when delivered.
- Attachment content must never be uploaded before approval: it is stored in the binding's storage
  and uploaded in `applyAction()`/`applyDraftRevision()`. An existing attachment (by blob id) must
  come from a message the binding's `ScopeGuard` admits; `FastmailDraftImpl` always carries the
  guard for this.
- Drafts have a stable gatekeeper id (`draft:<id>` records) because every applied edit replaces the
  JMAP Email. Each draft change is a revision keyed by action id; the agent sees the newest one,
  applying a revision older than the applied one is a no-op, and rejecting one falls back to the
  newest remaining revision. Every revision carries the full content, so never make one depend on
  an earlier revision having been applied. Applies for one draft are serialized in memory
  (`#withDraftLock`). A draft send submits the approved snapshot as a fresh Email, then discards
  the stored copy.
- `listDrafts()`/`getDraft()` also reach Fastmail-native drafts, on a whole-mailbox binding only
  (a narrowed one may never see or adopt a draft it didn't create). Ids are told apart by lookup: a
  draft record id (a UUID) first, otherwise a JMAP email id that must be in the Drafts-role
  mailbox. Adopting stores a record with `applied: { actionId: 0, revision: content, emailId }`
  (action ids start at 1, so every real revision supersedes it) and queues nothing; the
  usual revision machinery then replaces the Email. `listDrafts()` skips any Email that is some
  record's `applied.emailId` so a draft is listed once, under its record id. Adopted attachments
  are `existing` refs by blob id. JMAP's `textBody` falls back to the HTML part, so
  `draftContentFromEmail()` takes a body only when the part's type is `text/plain`/`text/html`.
  Adopted records carry `adopted: true`: their update/delete are staged with no `actionKind`, so
  they are never auto-approved (the person wrote the draft, not the agent); send never is either.
  Fastmail replaces the Email whenever the person edits a draft, so an adopted record whose
  `applied` is still the `actionId: 0` source is checked against Drafts: `listDrafts()` and
  `getDraft()` drop it (when nothing is pending) so the new Email surfaces natively, and
  update/delete/send at stage time and `applyDraftRevision()` at apply time refuse with
  `RESOURCE_NOT_FOUND` while the source Email is gone (`assertAdoptedSourceLive`).
- `FastmailThread.reply()` queues the same `send` action with `inReplyTo`/`references` taken from
  the thread's latest message. Fastmail threads strictly on these Message-ID headers (unlike
  Gmail's subject heuristic), so a reply sent through plain `send()` lands outside the thread. The
  answered email is marked `$answered` best-effort after the send succeeds.

## Development and verification

Run commands from the consuming starter after the submodule and Cloudflare OS workspace are
initialized:

```sh
pnpm --filter gatekeeper-fastmail test:run
pnpm --filter gatekeeper-fastmail types:check
```

The package scripts are also available directly:

```sh
pnpm test:run
pnpm types:check
pnpm deploy
```

The configurator UI source is under `src/configurator/`; generated `.txt` assets under
`src/generated/` should be regenerated by the package build, not edited by hand. The Worker config
is authored in `cloudflare.config.ts`; `wrangler.jsonc` is generated from it, so never edit it by
hand: change `cloudflare.config.ts` and run `pnpm configs:generate` from the starter root
(`pnpm configs:check` fails on a stale file). Deployment uses the Cap'n Web validation build,
`nodejs_compat`, and Durable Objects.

Tests use mocked `fetch` and do not need Fastmail credentials. Coverage includes session discovery,
capability checks, JMAP request/response mapping, resource validation, caching, simulated keywords,
contacts (listing, group scope, queued changes and their apply), masked email (immediate creation,
approval-only deletion, scope refusal), and configurator behavior. Full
live-account and Durable Object `ctx.exports` integration coverage
is not part of the current test suite. The hook driver's logic (`HookDriver`) is tested on fake
storage with a test-side Web Push encryptor standing in for Fastmail (`__tests__/hooks.test.ts`),
and `__tests__/hooks-worker.test.ts` reaches the real Durable Object.

If the local package manager or workspace links are unavailable, report that explicitly rather than
claiming tests passed. At minimum run `git diff --check` and inspect the final diff.

