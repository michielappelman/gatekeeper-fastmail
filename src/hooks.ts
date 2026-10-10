// Fastmail new-message hooks: one `FastmailHookDriver` per connection (named by its UserAccount id,
// so one API token) reads what `Email/changes` created since its cursor and delivers each new
// message to every hook watching its folder, through the facet's self-stub, which re-checks the
// message and builds the capability the hook receives.
//
// The driver learns of new mail in two ways:
// - JMAP push (RFC 8620 §7.2): a `PushSubscription` whose URL is `{BASE_URL}/push/{driver}/{secret}`
//   and whose pushes are Web Push encrypted (RFC 8291) to keys only the driver holds. A push carries
//   only state strings, so it just makes the driver read changes now.
// - polling: every few minutes while push is unavailable (a local BASE_URL, an unverified
//   subscription), and as a safety net while it works, since a push can be delayed or dropped.
//
// As in gatekeeper-google's gmail-hooks.ts, `FastmailHookController` is a loopback entrypoint so
// that removing a connection, which deletes the facet, still reaches it.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { constantTimeEqual } from "@gadgets/gatekeeper-kit/connect-nonce";
import { FastmailError } from "./errors";
import {
  createPushSubscription,
  destroyPushSubscription,
  emailChanges,
  getEmailState,
  updatePushSubscription,
  type CreatedEmail,
} from "./fastmail-api";
import { HOUR_MS, HookDeliveryQueue, MINUTE_MS, disposeStubs } from "./hook-delivery-queue";
import type { FastmailMessageHook } from "./types";
import { decryptWebPush, generateWebPushKeys, MAX_PUSH_BYTES, type WebPushKeys } from "./webpush";

type Env = Cloudflare.Env & { BASE_URL?: string };

export type FastmailMessageHookTarget = RpcTarget & FastmailMessageHook<any>;

/** Where a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`. */
export type FastmailHookParams = { folderId: string };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface FastmailHookDelivery extends RpcTarget {
  /**
   * Deliver email `emailId` to one firing of the hook if it is new mail in the hook's folder;
   * otherwise return without calling it.
   */
  deliver(callback: RpcStub<FastmailMessageHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          emailId: string): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type FastmailHookProps = FastmailHookParams & {
  key: string;
  userObjectId: string;
  delivery: RpcStub<FastmailHookDelivery>;
};

@validateRpc()
export class FastmailHookController extends WorkerEntrypoint<Env, FastmailHookProps>
    implements HookController<FastmailMessageHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<FastmailMessageHookTarget>>,
               _target: HookTargetMetadata): Promise<void> {
    const { key, delivery, folderId, userObjectId } = this.ctx.props;
    await this.#driver().register(key, { folderId, userObjectId }, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await this.#driver().unregister(this.ctx.props.key);
  }

  #driver() {
    return this.ctx.exports.FastmailHookDriver.getByName(this.ctx.props.userObjectId);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** How often changes are read while no verified push subscription reports them. */
export const POLL_INTERVAL_MS = 2 * MINUTE_MS;
/** How often changes are read anyway while push works: a push can be delayed or dropped. */
export const SAFETY_SYNC_INTERVAL_MS = 15 * MINUTE_MS;
const SYNC_RETRY_MS = 5 * MINUTE_MS;
/** Bounds one alarm's read; the next alarm, set for at once, continues it. */
const MAX_CHANGES_PAGES_PER_SYNC = 10;
/** The lifetime asked for a push subscription; Fastmail may grant less, and it is renewed a day early. */
const PUSH_LIFETIME_MS = 7 * 24 * HOUR_MS;
const PUSH_RENEW_MARGIN_MS = 24 * HOUR_MS;
/** A subscription Fastmail hasn't verified by then is replaced: its verification push was lost. */
const PUSH_VERIFY_TIMEOUT_MS = 10 * MINUTE_MS;
const PUSH_RETRY_MS = HOUR_MS;
/** What the subscription asks to be told about: only new mail, not flag changes (RFC 8621 §1.5). */
const PUSH_TYPES = ["EmailDelivery"];

type Registration = {
  folderId: string;
  userObjectId: string;
  /** When the hook was enabled: mail Fastmail received earlier is never delivered to it. */
  since: number;
};
type Capabilities = {
  delivery: RpcStub<FastmailHookDelivery>;
  initiator: Fetcher<HookInitiator<FastmailMessageHookTarget>>;
};
/** The driver's push subscription, stored before it is created so its verification push is accepted. */
type Push = {
  /** Fastmail's id, once `PushSubscription/set` (or the verification push) has reported it. */
  id?: string;
  /** The last path segment of the push URL, so a push names the subscription it was sent for. */
  secret: string;
  keys: WebPushKeys;
  /** The connection whose token created it, to remove it with once no hook is left. */
  userObjectId: string;
  /** Which token created it: a subscription lives and dies with its credentials. */
  tokenHash: string;
  createdAt: number;
  verified: boolean;
  expires?: number;
  /** When to check on it next: renew, replace an unverified one, or retry a failed create. */
  checkAt: number;
};
type Cursor = { accountId: string; state: string };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;

/** What the driver needs from the connection's `UserAccount`. */
export interface HookAccount {
  getGrant(): Promise<{ apiToken: string; apiUrl: string; accountId: string }>;
  noteCredentialsExpired(): Promise<void>;
}

/** One per connection with hooks, named by its UserAccount id; see `HookDriver`. */
export class FastmailHookDriver extends DurableObject<Env> {
  #driver = new HookDriver(this.ctx.storage, this.env, userObjectId => {
    const accounts = this.ctx.exports.UserAccount;
    return accounts.get(accounts.idFromString(userObjectId)) as unknown as HookAccount;
  });

  register(key: string, registration: Omit<Registration, "since">, capabilities: Capabilities): Promise<void> {
    return this.#driver.register(key, registration, capabilities);
  }

  unregister(key: string): Promise<void> {
    return this.#driver.unregister(key);
  }

  receivePush(secret: string, body: ArrayBuffer): Promise<boolean> {
    return this.#driver.receivePush(secret, body);
  }

  alarm(): Promise<void> {
    return this.#driver.alarm();
  }
}

/**
 * The driver's logic, apart from the Durable Object so it can be tested on fake storage. Storage:
 * `reg:`/`caps:` per hook, `cursor` (the Email state read through, and its account), `syncAt`
 * (when to read next), `push`, `pushCheckAt`, and the delivery queue's `msg:` rows, whose message
 * is a JMAP Email id.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class HookDriver {
  #queue: HookDeliveryQueue<string>;
  #pushing: Promise<void> | undefined;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
    private readonly account: (userObjectId: string) => HookAccount,
  ) {
    this.#queue = new HookDeliveryQueue<string>(storage, () => {
      logHook("delivery.dropped", "dropped a Fastmail message after repeated delivery failures");
    });
  }

  async register(key: string, registration: Omit<Registration, "since">, capabilities: Capabilities): Promise<void> {
    const kv = this.storage.kv;
    if (!kv.get<Cursor>("cursor")) {
      const grant = await this.#account(registration.userObjectId).getGrant();
      const state = await getEmailState(grant.apiUrl, grant.apiToken, grant.accountId);
      // Another enable may have started the cursor meanwhile, and a sync may have advanced it.
      if (!kv.get<Cursor>("cursor")) kv.put<Cursor>("cursor", { accountId: grant.accountId, state });
    }
    const replaced = kv.get<Capabilities>(capabilitiesKey(key));
    kv.put<Registration>(registrationKey(key), { ...registration, since: Date.now() });
    kv.put(capabilitiesKey(key), capabilities);
    disposeStubs(replaced);
    if (kv.get("syncAt") === undefined) kv.put("syncAt", Date.now() + POLL_INTERVAL_MS);
    // Set up push in the alarm, so a deployment or account that can't push still gets polled hooks.
    if (!kv.get<Push>("push")) kv.put("pushCheckAt", Date.now());
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    const kv = this.storage.kv;
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
    if (this.#registrations().length === 0) {
      kv.delete("cursor");
      kv.delete("syncAt");
      // The alarm removes the push subscription, with credentials a removed connection may still have.
      if (kv.get<Push>("push")) kv.put("pushCheckAt", Date.now());
    }
    await this.#reschedule();
  }

  /**
   * Handle one push sent to `{BASE_URL}/push/{driver}/{secret}`. Returns false, for a 404, unless
   * it is for this driver's current subscription and decrypts with its keys. Anything else
   * decryptable is acknowledged, so Fastmail doesn't retry it.
   */
  async receivePush(secret: string, body: ArrayBuffer): Promise<boolean> {
    const push = this.storage.kv.get<Push>("push");
    if (!push || !constantTimeEqual(secret, push.secret)) return false;
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(await decryptWebPush(new Uint8Array(body), push.keys)));
    } catch {
      return false;
    }
    if (typeof message !== "object" || message === null) return true;
    const { "@type": type } = message as { "@type"?: unknown };
    if (type === "PushVerification") {
      await this.#verify(push, message as { pushSubscriptionId?: unknown; verificationCode?: unknown });
    } else if (type === "StateChange" && this.#registrations().length > 0) {
      // Which types changed doesn't matter: the subscription asked only for new mail, and the read
      // is cheap when nothing was created.
      this.storage.kv.put("syncAt", Date.now());
      await this.#wakeBy(Date.now());
    }
    return true;
  }

  async #verify(push: Push, { pushSubscriptionId, verificationCode }: { pushSubscriptionId?: unknown; verificationCode?: unknown }) {
    if (typeof pushSubscriptionId !== "string" || typeof verificationCode !== "string") return;
    // The verification push can beat `PushSubscription/set`'s response, before the id is known.
    if (push.id !== undefined && push.id !== pushSubscriptionId) return;
    const registration = this.#registrations()[0]?.[1];
    if (!registration) return;
    const grant = await this.#account(registration.userObjectId).getGrant();
    const { expires } = await updatePushSubscription(
      grant.apiUrl, grant.apiToken, pushSubscriptionId, { verificationCode });
    const current = this.storage.kv.get<Push>("push");
    if (current?.secret !== push.secret) return;
    const verifiedExpiry = expires ?? current.expires;
    this.storage.kv.put<Push>("push", {
      ...current, id: pushSubscriptionId, verified: true, expires: verifiedExpiry,
      checkAt: renewalTime(verifiedExpiry),
    });
    // Polling relaxes to the safety interval from the next sync on.
    logHook("push.verified", "Fastmail push subscription verified");
    await this.#reschedule();
  }

  /**
   * The driver's one alarm, which #wakeBy() and #reschedule() set for the earliest time any of
   * these is due:
   * - reading changes, when a push reported some, or on the poll or safety interval;
   * - creating, renewing, replacing or removing the push subscription;
   * - delivering each queued message whose (re)try time has come, and forgetting finished ones.
   */
  async alarm(): Promise<void> {
    const kv = this.storage.kv;
    if (this.#registrations().length > 0 && (kv.get<number>("syncAt") ?? 0) <= Date.now()) await this.#sync();
    if ((kv.get<number>("pushCheckAt") ?? Infinity) <= Date.now() ||
        (kv.get<Push>("push")?.checkAt ?? Infinity) <= Date.now()) {
      await this.#maintainPush();
    }
    // After the sync, so the rows it just queued are due in this same run.
    await this.#queue.run(Date.now(), (hookKey, emailId) => this.#deliver(hookKey, emailId));
    await this.#reschedule();
  }

  /** Queue what Email/changes created since the cursor, then advance it. */
  async #sync(): Promise<void> {
    const kv = this.storage.kv;
    const startedSyncAt = kv.get<number>("syncAt");
    const started = kv.get<Cursor>("cursor");
    const registration = this.#registrations()[0]?.[1];
    if (!started || !registration) return;
    let nextSyncAt = Date.now() + (kv.get<Push>("push")?.verified ? SAFETY_SYNC_INTERVAL_MS : POLL_INTERVAL_MS);
    let next: Cursor = started;
    try {
      const grant = await this.#account(registration.userObjectId).getGrant();
      this.#notePushToken(await tokenHash(grant.apiToken));
      if (grant.accountId !== started.accountId) {
        // Reconnected to another Fastmail account: its states mean nothing here.
        logHook("sync.accountChanged", "Fastmail hooks' connection now reads another account; watching from now");
        next = { accountId: grant.accountId, state: await getEmailState(grant.apiUrl, grant.apiToken, grant.accountId) };
      } else {
        for (let pages = 0; ; pages++) {
          if (pages === MAX_CHANGES_PAGES_PER_SYNC) {
            nextSyncAt = Date.now();
            break;
          }
          const page = await emailChanges(grant.apiUrl, grant.apiToken, grant.accountId, next.state);
          if (page.kind === "reset") {
            // Mail that arrived in the gap is not delivered.
            logHook("sync.reset", "Fastmail can't compute changes from the stored state; watching from now");
            next = { ...next, state: await getEmailState(grant.apiUrl, grant.apiToken, grant.accountId) };
            break;
          }
          const registrations = this.#registrations();
          for (const email of page.created) this.#enqueue(registrations, email);
          next = { ...next, state: page.newState };
          if (!page.hasMoreChanges) break;
        }
      }
      // Every hook was unregistered meanwhile, which forgot the cursor; or another sync moved it.
      const current = kv.get<Cursor>("cursor");
      if (!current || current.state !== started.state || current.accountId !== started.accountId) return;
      kv.put<Cursor>("cursor", next);
    } catch (error) {
      logHook("sync.failed", "failed to read new Fastmail mail", error);
      if (error instanceof FastmailError && error.code === "AUTH_EXPIRED") {
        await this.#account(registration.userObjectId).noteCredentialsExpired().catch(() => {});
      }
      nextSyncAt = Date.now() + SYNC_RETRY_MS;
    }
    // A push or an enable during the sync set its own time, which must stand.
    if (kv.get("syncAt") === startedSyncAt) kv.put("syncAt", nextSyncAt);
  }

  /** Queue one created email for each hook that watches for it. */
  #enqueue(registrations: [string, Registration][], email: CreatedEmail): void {
    // The facet re-checks authoritatively. This prefilter exists because every delivery attempt
    // starts a hook firing in its workspace.
    if (email.keywords?.["$draft"]) return;
    const receivedAt = Date.parse(email.receivedAt);
    for (const [regKey, registration] of registrations) {
      if (!email.mailboxIds?.[registration.folderId]) continue;
      if (receivedAt < registration.since) continue;
      this.#queue.enqueue(regKey.slice("reg:".length), email.id, email.id, Date.now());
    }
  }

  async #deliver(hookKey: string, emailId: string): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling or deleting the hook unregisters it, which ends the retries.
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, emailId);
    } finally {
      disposeStubs(capabilities);
    }
  }

  /** Schedule the push subscription's replacement if the connection's token is no longer the one that made it. */
  #notePushToken(hash: string): void {
    const push = this.storage.kv.get<Push>("push");
    if (push && push.tokenHash !== hash) this.storage.kv.put("pushCheckAt", Date.now());
  }

  /** Bring the push subscription in line with the registrations, one run at a time. */
  #maintainPush(): Promise<void> {
    this.#pushing ??= this.#doMaintainPush().finally(() => this.#pushing = undefined);
    return this.#pushing;
  }

  async #doMaintainPush(): Promise<void> {
    const kv = this.storage.kv;
    kv.delete("pushCheckAt");
    const registration = this.#registrations()[0]?.[1];
    const push = kv.get<Push>("push");
    if (!registration) {
      if (!push) return;
      // Forgotten first, so an enable during the destroy creates a fresh subscription.
      kv.delete("push");
      await this.#destroyPush(push);
      return;
    }

    const pushUrl = pushBaseUrl(this.env);
    if (!pushUrl) return;
    try {
      const grant = await this.#account(registration.userObjectId).getGrant();
      const hash = await tokenHash(grant.apiToken);
      const now = Date.now();
      if (push && push.tokenHash === hash && push.id !== undefined) {
        if (push.verified && push.checkAt > now) return;
        if (push.verified) {
          const { expires } = await updatePushSubscription(
            grant.apiUrl, grant.apiToken, push.id, { expires: new Date(now + PUSH_LIFETIME_MS) });
          const current = kv.get<Push>("push");
          if (current?.secret === push.secret) {
            kv.put<Push>("push", { ...current, expires, checkAt: renewalTime(expires) });
          }
          return;
        }
        if (push.createdAt + PUSH_VERIFY_TIMEOUT_MS > now) return;
        // Polling covers for it meanwhile; retrying at once would churn subscriptions if Fastmail
        // can't reach this deployment.
        logHook("push.unverified", "Fastmail never verified the push subscription; retrying in an hour");
        kv.delete("push");
        kv.put("pushCheckAt", now + PUSH_RETRY_MS);
        await this.#destroyPush(push);
        return;
      }
      if (push) {
        kv.delete("push");
        await this.#destroyPush(push);
      }

      const created: Push = {
        secret: randomHex(32),
        keys: await generateWebPushKeys(),
        userObjectId: registration.userObjectId,
        tokenHash: hash,
        createdAt: now,
        verified: false,
        checkAt: now + PUSH_VERIFY_TIMEOUT_MS,
      };
      kv.put<Push>("push", created);
      const { id, expires } = await createPushSubscription(grant.apiUrl, grant.apiToken, {
        deviceClientId: `cloudflare-os-${registration.userObjectId.slice(0, 32)}`,
        url: `${pushUrl}/push/${encodeURIComponent(registration.userObjectId)}/${created.secret}`,
        keys: { p256dh: created.keys.p256dh, auth: created.keys.auth },
        types: PUSH_TYPES,
        expires: new Date(now + PUSH_LIFETIME_MS),
      });
      const current = kv.get<Push>("push");
      if (current?.secret === created.secret) {
        kv.put<Push>("push", { ...current, id, expires: expires ?? current.expires });
      } else {
        // Unregistered or replaced while creating.
        await this.#destroyPush({ ...created, id });
      }
    } catch (error) {
      logHook("push.failed", "failed to set up Fastmail push; polling instead", error);
      const current = kv.get<Push>("push");
      if (current) kv.put<Push>("push", { ...current, checkAt: Date.now() + PUSH_RETRY_MS });
      else kv.put("pushCheckAt", Date.now() + PUSH_RETRY_MS);
    }
  }

  /** Best-effort: a subscription left behind lapses at its expiry, or with its token. */
  async #destroyPush(push: Push): Promise<void> {
    if (push.id === undefined) return;
    try {
      const grant = await this.#account(push.userObjectId).getGrant();
      if (await tokenHash(grant.apiToken) !== push.tokenHash) return;
      await destroyPushSubscription(grant.apiUrl, grant.apiToken, push.id);
    } catch (error) {
      logHook("push.destroyFailed", "failed to remove a Fastmail push subscription", error);
    }
  }

  #account(userObjectId: string): HookAccount {
    return this.account(userObjectId);
  }

  #registrations(): [string, Registration][] {
    return [...this.storage.kv.list<Registration>({ prefix: "reg:" })];
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || time < current) await this.storage.setAlarm(time);
  }

  async #reschedule(): Promise<void> {
    const kv = this.storage.kv;
    const times: number[] = [];
    const queueDue = this.#queue.nextDue();
    if (queueDue !== undefined) times.push(queueDue);
    if (this.#registrations().length > 0) times.push(kv.get<number>("syncAt") ?? Date.now());
    const pushCheckAt = kv.get<number>("pushCheckAt");
    if (pushCheckAt !== undefined) times.push(pushCheckAt);
    const push = kv.get<Push>("push");
    if (push) times.push(this.#registrations().length > 0 ? push.checkAt : Date.now());
    if (times.length > 0) await this.storage.setAlarm(Math.min(...times));
    else await this.storage.deleteAlarm();
  }
}

/** When to renew a subscription expiring at `expires`: a day early, and at least hourly checks. */
function renewalTime(expires: number | undefined): number {
  if (expires === undefined) return Date.now() + PUSH_LIFETIME_MS - PUSH_RENEW_MARGIN_MS;
  return Math.max(Date.now() + MINUTE_MS, expires - Math.min(PUSH_RENEW_MARGIN_MS, (expires - Date.now()) / 2));
}

/**
 * The base URL Fastmail can push to, or undefined when this deployment can't receive pushes: the
 * subscription URL must be public HTTPS (RFC 8620 §7.2).
 */
export function pushBaseUrl(env: { BASE_URL?: string }): string | undefined {
  if (!env.BASE_URL) return undefined;
  let url: URL;
  try {
    url = new URL(env.BASE_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    return undefined;
  }
  return stripTrailingSlashes(env.BASE_URL);
}

async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function logHook(event: string, message: string, error?: unknown): void {
  console.warn(JSON.stringify({
    tag: "fastmail", event: `hooks.${event}`, message,
    code: error instanceof FastmailError ? error.code : undefined,
    error: error === undefined ? undefined : error instanceof Error ? error.message : String(error),
  }));
}

// ── Push ingest ─────────────────────────────────────────────────────

/** Path segments of `POST {BASE_URL}/push/{userObjectId}/{secret}`. */
const PUSH_PATH = /^\/push\/([0-9a-f]{64})\/([0-9a-f]{64})$/;

/**
 * Route one push request to its driver. A push for no current subscription gets a 404, which tells
 * Fastmail to stop; anything accepted gets a 201 (RFC 8030 §5).
 */
export async function handlePush(relPath: string, request: Request, exports: Cloudflare.Exports): Promise<Response | undefined> {
  const match = PUSH_PATH.exec(relPath);
  if (!match) return undefined;
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_PUSH_BYTES) return new Response("Payload Too Large", { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PUSH_BYTES) return new Response("Payload Too Large", { status: 413 });
  const [, userObjectId, secret] = match;
  const accepted = await exports.FastmailHookDriver.getByName(userObjectId).receivePush(secret, body);
  return new Response(null, { status: accepted ? 201 : 404 });
}
