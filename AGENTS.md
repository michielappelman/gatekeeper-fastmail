# Agent guide

## What this repository is

`gatekeeper-fastmail` is a Cloudflare Worker package for Cloudflare OS. It exposes one scoped
resource: the whole mailbox of one connected Fastmail account. The agent can list/search threads,
read messages and attachments, organize messages, and optionally send mail.

This repository is normally a Git submodule under `cloudflare-os-starter/packages/`. It is not a
standalone npm package: `@gadgets/*` dependencies resolve from the consuming Cloudflare OS
workspace.

Read [README.md](README.md) for deployment and user-facing behavior. Use this file for the
implementation constraints that are easy to miss.

## Related repositories and references

- [Cloudflare OS starter](https://github.com/cloudflare/cloudflare-os-starter): the consuming
  workspace and deployment host. In this workspace it is normally available at
  `../cloudflare-os-starter/`.
- [`@gadgets/gatekeeper-kit`](../cloudflare-os-starter/cloudflare-os/packages/gatekeeper-kit/): the
  shared library used for connect pages, credential staging, nonces, cursors, and Worker plumbing.
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
src/resource.ts       Whole-mailbox resource URL and validation
src/cache.ts          Folder cache, pending actions, and simulated keyword overlays
src/errors.ts         Stable FastmailErrorCode mapping
src/configurator/     Zero-field whole-mailbox configurator source/types
__tests__/             JMAP, resource, cache, and configurator tests
```

## Non-negotiable invariants

- v1 exposes exactly one resource URL: `https://api.fastmail.com/jmap/mail/account`. The
  `urlPattern` is deployed identity; do not change it casually.
- Resource parsing must reject foreign hosts, paths, malformed URLs, and hash-scoped variants.
  Per-folder and per-search bindings are not implemented, even though the URL pattern leaves room
  for them later.
- The resource is one connected account's whole mailbox. Do not infer authorization from a folder
  or thread id; the account binding is the capability boundary.
- `UserAccount` owns the Fastmail API token and resolved JMAP account information. The token must
  not reach agent-facing session objects.
- Fastmail API tokens are bearer tokens, not OAuth grants. There is no refresh cycle. A 401 must
  become `AUTH_EXPIRED`, notify the Workshop once, and require reconnecting with a new token.
- Connect validation must confirm Mail capability through `GET /jmap/session` before storing the
  grant. `send()` also requires Email submission capability and a usable sender identity.
- Every read path authorizes observation through `ApprovalQueue`, including cached and simulated
  results. Every mutation is queued for approval; `getAutoApprovableActions()` remains empty.
- Mailbox bindings are private to the connecting account. Observer sharing is intentionally
  rejected.
- `moveToFolder()` takes a Mailbox id. Use `listFolders()` and the stable `role` field to find
  archive/trash/etc.; do not add Gmail-style `archive()` or `trash()` shortcuts.
- Mutations are not automatically reversible. Do not claim that sending, moving, or keyword edits
  can be reverted through the Gatekeeper.

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
- Convert upstream HTTP and method errors into stable `FastmailErrorCode` values. Session code
  should not branch on raw response bodies or JMAP error strings.

When changing protocol code, update `__tests__/fastmail-client.test.ts` and keep the tests using
mocked `fetch`; no Fastmail credentials belong in the repository.

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
- Sends have no simulation and are irreversible; `send()` resolves when queued, not when delivered.
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
`src/generated/` should be regenerated by the package build, not edited by hand. Deployment uses
`wrangler.jsonc`, the Cap'n Web validation build, `nodejs_compat`, and Durable Objects.

Tests use mocked `fetch` and do not need Fastmail credentials. Coverage includes session discovery,
capability checks, JMAP request/response mapping, resource validation, caching, simulated keywords,
and configurator behavior. Full live-account and Durable Object `ctx.exports` integration coverage
is not part of the current test suite.

If the local package manager or workspace links are unavailable, report that explicitly rather than
claiming tests passed. At minimum run `git diff --check` and inspect the final diff.

