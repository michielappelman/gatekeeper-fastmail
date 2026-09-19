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

1. Read this package's `wrangler.jsonc` as the base Fastmail config.
2. Generate the production config with the deployment's account, Worker name, service bindings,
   `BASE_URL`, and observability settings.
3. Run `vp run -F gatekeeper-fastmail --no-cache build` before deploying the Worker.
4. Deploy it before the Workshop and Router, which consume its service binding.
5. Pin the submodule commit in the starter and record that commit in the deployment inventory.

The starter's `workers.fastmail.name` is the deployed Worker identity; it need not be
`gatekeeper-fastmail`. The public router is the only route: the Fastmail Worker should have no
public or preview URL. Users paste their own Fastmail API token through the Gatekeeper's connect
flow, so no deployment-wide Fastmail secret is required. Tokens should be scoped to Mail, with
Email submission only when a connection needs `send()`.

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

## Resource model (whole mailbox)

`FASTMAIL_RESOURCE` offers exactly one bindable resource per connected account: the whole mailbox
(`resource.ts`). There is no per-folder or per-search scoping yet. The resource's `urlPattern`
reserves room for `#mailbox/<id>` / `#search/<query>` hash-scoped variants without needing to migrate
any binding this version creates.

Even though there's nothing to actually pick, the connect modal still requires a working
`GatekeeperUser.startResourceConfigurator()` for every `SupportedResource` before "Add connection"
can be enabled — there's no way to opt a resource out of it. So `configurator/
fastmail-account-configurator-ui.tsx` is a trivial (zero-field, always-`isReady`) configurator that
just confirms what's being connected and reports the fixed resource URL, the same pattern
`gatekeeper-zoominfo`'s whole-account resource uses.

## Session API

See `types.d.ts` for the full agent-facing surface: `FastmailSession.listFolders/listThreads/
searchThreads/getThread/send`, and `FastmailThread.messages/readAttachment/moveToFolder/addKeyword/
removeKeyword/markRead/markUnread`. Deliberately no Gmail-style `archive()`/`trash()` convenience
verbs — call `listFolders()`, find the folder whose `role` is `"archive"`/`"trash"`, and pass its id
to `moveToFolder()`.

Every mutation (a thread patch, or `send()`) is queued via `ApprovalQueue.submitAction()` and only
actually reaches Fastmail once `FastmailGatekeeperImpl.applyAction()` is called on approval — so
`send()` returns once the send is *queued*, not once the message has left the account, matching
`JottacloudFileSession.write()`'s contract rather than a synchronous send. A thread patch
(`moveToFolder`/`addKeyword`/`removeKeyword`/`markRead`/`markUnread`) simulates its pending keyword
state so `FastmailThread.messages()` reflects the caller's own not-yet-approved edit immediately
(`cache.ts`); a queued `send()` has nothing to simulate.

## Observers

Strategy A (private-only, see `write-gatekeeper` skill "Observer verification"): a personal mailbox
has no per-observer ACL Fastmail exposes to check a second connected account against, so
`addObserver()` always throws, matching Gmail's and Jottacloud's own rationale.

## Current scope

- Resource scope is the whole mailbox; per-folder and per-search binding selection is not exposed.
- Token rotation is handled by reconnecting with a new token; there is no refresh-token cycle.
- Fastmail is not a sign-in identity provider (`getAuthenticatedEmail()` returns `null`), even though
  the connected account's own address is knowable.
