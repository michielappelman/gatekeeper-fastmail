import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastmailHookDeliveryImpl } from "../src/fastmail";
import { HookDriver, handlePush, POLL_INTERVAL_MS, pushBaseUrl } from "../src/hooks";
import { base64UrlDecode } from "../src/webpush";

const USER_OBJECT_ID = "a".repeat(64);
const GRANT = {
  apiToken: "token", apiUrl: "https://api.fastmail.com/jmap/api/", downloadUrlTemplate: "",
  uploadUrlTemplate: "", accountId: "u1", hasSubmission: true, identityEmail: "me@fastmail.com",
};

type MethodCall = [string, Record<string, any>, string];
type Handler = (args: Record<string, any>, earlier: Map<string, Record<string, any>>) => [string, Record<string, any>];

/** A fake JMAP API: each method call is answered by its handler, in order, with back-references
 * left for the handler to resolve from the earlier results. */
function fakeJmap(handlers: Record<string, Handler>) {
  const calls: MethodCall[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: MethodCall[] };
    const earlier = new Map<string, Record<string, any>>();
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      calls.push([name, args, callId]);
      const handler = handlers[name];
      if (!handler) throw new Error(`Unexpected JMAP call ${name}`);
      const [responseName, result] = handler(args, earlier);
      earlier.set(callId, result);
      return [responseName, result, callId];
    });
    return new Response(JSON.stringify({ methodResponses }));
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { calls, named: (name: string) => calls.filter(([n]) => n === name).map(([, args]) => args) };
}

function fakeStorage() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const account = { getGrant: vi.fn(async () => GRANT), noteCredentialsExpired: vi.fn(async () => {}) };
  return {
    storage: {
      kv: {
        get: (key: string) => store.get(key),
        put: (key: string, value: unknown) => void store.set(key, value),
        delete: (key: string) => store.delete(key),
        list: ({ prefix }: { prefix: string }) =>
          [...store].filter(([key]) => key.startsWith(prefix)).toSorted(([a], [b]) => a.localeCompare(b)),
      },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => void (alarm = time),
      deleteAlarm: async () => void (alarm = null),
    },
    store, account, alarm: () => alarm,
  };
}

function setup(env: { BASE_URL?: string } = {}) {
  const { storage, store, account, alarm } = fakeStorage();
  const driver = new HookDriver(storage as any, env as any, () => account);
  const delivered: string[] = [];
  const delivery = { deliver: vi.fn(async (_callback: unknown, _queue: unknown, id: string) => void delivered.push(id)) };
  const initiator = {
    startHook: vi.fn(async () => ({ callback: {}, approvalQueue: {}, [Symbol.dispose]() {} })),
  };
  const register = (key: string, folderId = "inbox-id") =>
    driver.register(key, { folderId, userObjectId: USER_OBJECT_ID }, { delivery, initiator } as any);
  return { driver, store, account, alarm, register, delivered, delivery };
}

const STATE_HANDLER: Handler = () => ["Email/get", { state: "s1", list: [] }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FastmailHookDriver polling", () => {
  it("delivers new mail in the watched folder, and nothing else", async () => {
    const { driver, store, register, delivered } = setup();
    fakeJmap({ "Email/get": STATE_HANDLER });
    await register("hook1");
    expect(store.get("cursor")).toEqual({ accountId: "u1", state: "s1" });
    const since = (store.get("reg:hook1") as { since: number }).since;

    const now = new Date(since + 1000).toISOString();
    const before = new Date(since - 60_000).toISOString();
    const jmap = fakeJmap({
      "Email/changes": args => ["Email/changes", {
        oldState: args.sinceState, newState: "s2", hasMoreChanges: false,
        created: ["e1", "e2", "e3", "e4"], updated: ["e9"], destroyed: [],
      }],
      "Email/get": () => ["Email/get", { state: "s2", list: [
        { id: "e1", mailboxIds: { "inbox-id": true }, keywords: {}, receivedAt: now },
        { id: "e2", mailboxIds: { "inbox-id": true }, keywords: { $draft: true }, receivedAt: now },
        { id: "e3", mailboxIds: { "other-id": true }, keywords: {}, receivedAt: now },
        { id: "e4", mailboxIds: { "inbox-id": true }, keywords: {}, receivedAt: before },
      ] }],
    });
    store.set("syncAt", 0);
    await driver.alarm();

    expect(jmap.named("Email/changes")).toEqual([expect.objectContaining({ accountId: "u1", sinceState: "s1" })]);
    expect(jmap.named("Email/get")[0]["#ids"]).toEqual({ resultOf: "c1", name: "Email/changes", path: "/created" });
    expect(delivered).toEqual(["e1"]);
    expect(store.get("cursor")).toEqual({ accountId: "u1", state: "s2" });
    // No push without a public HTTPS BASE_URL, so the next read is a poll.
    expect(store.get("push")).toBeUndefined();
    expect(store.get("syncAt")).toBeGreaterThan(Date.now() + POLL_INTERVAL_MS - 5_000);

    // A duplicate read of the same changes doesn't deliver again.
    store.set("cursor", { accountId: "u1", state: "s1" });
    store.set("syncAt", 0);
    await driver.alarm();
    expect(delivered).toEqual(["e1"]);
  });

  it("watches from now when Fastmail can no longer compute changes", async () => {
    const { driver, store, register, delivered } = setup();
    fakeJmap({ "Email/get": STATE_HANDLER });
    await register("hook1");
    let stateCalls = 0;
    fakeJmap({
      "Email/changes": () => ["error", { type: "cannotCalculateChanges" }],
      "Email/get": args => {
        if (args["#ids"]) return ["error", { type: "invalidResultReference" }];
        stateCalls++;
        return ["Email/get", { state: "s9", list: [] }];
      },
    });
    store.set("syncAt", 0);
    await driver.alarm();
    expect(stateCalls).toBe(1);
    expect(store.get("cursor")).toEqual({ accountId: "u1", state: "s9" });
    expect(delivered).toEqual([]);
  });

  it("reports a revoked token and retries later", async () => {
    const { driver, store, register, account } = setup();
    fakeJmap({ "Email/get": STATE_HANDLER });
    await register("hook1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    store.set("syncAt", 0);
    await driver.alarm();
    expect(account.noteCredentialsExpired).toHaveBeenCalled();
    expect(store.get("cursor")).toEqual({ accountId: "u1", state: "s1" });
    expect(store.get("syncAt")).toBeGreaterThan(Date.now());
  });

  it("forgets its state once the last hook is disabled", async () => {
    const { driver, store, register } = setup();
    fakeJmap({ "Email/get": STATE_HANDLER });
    await register("hook1");
    await register("hook2", "other-id");
    await driver.unregister("hook1");
    expect(store.get("cursor")).toBeDefined();
    await driver.unregister("hook2");
    expect(store.get("cursor")).toBeUndefined();
    expect(store.get("syncAt")).toBeUndefined();
  });
});

describe("FastmailHookDriver push", () => {
  const BASE_URL = "https://os.example.com/gatekeeper/fastmail";

  function pushJmap() {
    return fakeJmap({
      "Email/get": STATE_HANDLER,
      "Email/changes": () => ["Email/changes", { newState: "s1", hasMoreChanges: false, created: [] }],
      "PushSubscription/set": args => {
        if (args.create) {
          return ["PushSubscription/set", { created: { push: { id: "P1", expires: "2030-01-01T00:00:00Z" } } }];
        }
        if (args.update) return ["PushSubscription/set", { updated: { P1: null } }];
        return ["PushSubscription/set", { destroyed: args.destroy }];
      },
    });
  }

  it("subscribes, completes verification, and reads changes when pushed", async () => {
    const { driver, store, register, alarm } = setup({ BASE_URL });
    const jmap = pushJmap();
    await register("hook1");
    expect(alarm()).toBeLessThanOrEqual(Date.now());
    await driver.alarm();

    const [create] = jmap.named("PushSubscription/set");
    const subscription = create.create.push;
    const push = store.get("push") as { secret: string; keys: { p256dh: string; auth: string }; id: string; verified: boolean };
    expect(subscription).toMatchObject({
      url: `${BASE_URL}/push/${USER_OBJECT_ID}/${push.secret}`,
      keys: { p256dh: push.keys.p256dh, auth: push.keys.auth },
      types: ["EmailDelivery"],
    });
    expect(subscription.expires).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(push).toMatchObject({ id: "P1", verified: false });

    const verification = { "@type": "PushVerification", pushSubscriptionId: "P1", verificationCode: "code1" };
    // Wrong secret, or not encrypted to the subscription's keys: refused.
    expect(await driver.receivePush("0".repeat(64), await encryptPush(verification, push.keys))).toBe(false);
    expect(await driver.receivePush(push.secret, new TextEncoder().encode(JSON.stringify(verification)).buffer)).toBe(false);
    expect(await driver.receivePush(push.secret, await encryptPush(verification, push.keys))).toBe(true);
    expect(jmap.named("PushSubscription/set").at(-1)).toEqual({ update: { P1: { verificationCode: "code1" } } });
    expect(store.get("push")).toMatchObject({ verified: true, expires: Date.parse("2030-01-01T00:00:00Z") });

    store.set("syncAt", Date.now() + 3_600_000);
    const change = { "@type": "StateChange", changed: { u1: { EmailDelivery: "d2" } } };
    expect(await driver.receivePush(push.secret, await encryptPush(change, push.keys))).toBe(true);
    expect(store.get("syncAt")).toBeLessThanOrEqual(Date.now());
    expect(alarm()).toBeLessThanOrEqual(Date.now());
  });

  it("retries an unverified subscription hourly, polling meanwhile", async () => {
    const { driver, store, register } = setup({ BASE_URL });
    const jmap = pushJmap();
    await register("hook1");
    await driver.alarm();
    const push = store.get("push") as { createdAt: number; checkAt: number };
    store.set("push", { ...push, createdAt: push.createdAt - 3_600_000, checkAt: 0 });
    await driver.alarm();
    expect(jmap.named("PushSubscription/set").at(-1)).toEqual({ destroy: ["P1"] });
    expect(store.get("push")).toBeUndefined();
    expect(store.get("pushCheckAt")).toBeGreaterThan(Date.now() + 3_500_000);
    expect(store.get("syncAt")).toBeLessThan(Date.now() + POLL_INTERVAL_MS + 5_000);
  });

  it("removes the subscription once the last hook is disabled", async () => {
    const { driver, store, register } = setup({ BASE_URL });
    const jmap = pushJmap();
    await register("hook1");
    await driver.alarm();
    await driver.unregister("hook1");
    await driver.alarm();
    expect(jmap.named("PushSubscription/set").at(-1)).toEqual({ destroy: ["P1"] });
    expect(store.get("push")).toBeUndefined();
  });

  it("replaces the subscription when the connection's token changes", async () => {
    const { driver, store, register, account } = setup({ BASE_URL });
    const jmap = pushJmap();
    await register("hook1");
    await driver.alarm();
    const first = store.get("push") as { secret: string };
    account.getGrant.mockImplementation(async () => ({ ...GRANT, apiToken: "token2" }));
    store.set("syncAt", 0);
    await driver.alarm();
    expect(jmap.named("PushSubscription/set").filter(args => args.create)).toHaveLength(2);
    expect((store.get("push") as { secret: string }).secret).not.toBe(first.secret);
  });
});

describe("push routing", () => {
  it("only accepts pushes on the push path", async () => {
    const exports = { FastmailHookDriver: { getByName: () => ({ receivePush: async () => true }) } };
    const path = `/push/${USER_OBJECT_ID}/${"b".repeat(64)}`;
    expect(await handlePush("/push/x/y", new Request("https://x/", { method: "POST" }), exports as any)).toBeUndefined();
    expect((await handlePush(path, new Request("https://x/"), exports as any))!.status).toBe(405);
    expect((await handlePush(path, new Request("https://x/", { method: "POST", body: "x" }), exports as any))!.status).toBe(201);
  });

  it("pushes only to a public HTTPS base URL", () => {
    expect(pushBaseUrl({})).toBeUndefined();
    expect(pushBaseUrl({ BASE_URL: "http://localhost:8787/gatekeeper/fastmail" })).toBeUndefined();
    expect(pushBaseUrl({ BASE_URL: "https://os.example.com/gatekeeper/fastmail/" }))
      .toBe("https://os.example.com/gatekeeper/fastmail");
  });
});

describe("FastmailHookDeliveryImpl", () => {
  function deliverySetup(email: Record<string, unknown> | undefined) {
    fakeJmap({
      "Email/get": () => ["Email/get", { list: email ? [email] : [] }],
      "Thread/get": () => ["Thread/get", { list: [{ id: "t1", emailIds: ["e0", "e1"] }] }],
    });
    const account = { getGrant: async () => GRANT, noteCredentialsExpired: async () => {} };
    const queue = { authorizeObservation: vi.fn(async (_description: unknown) => {}) };
    const callback = { receiveMessage: vi.fn(async (_entry: unknown) => {}) };
    const impl = new FastmailHookDeliveryImpl("inbox-id", account as any, new Map() as any, {} as Ai);
    const deliver = async () => {
      using queueStub = new RpcStub(new FakeApprovalQueue(queue));
      using callbackStub = new RpcStub(new FakeHook(callback));
      await impl.deliver(callbackStub as any, queueStub as any, "e1");
    };
    return { deliver, queue, callback };
  }

  const EMAIL = {
    id: "e1", threadId: "t1", mailboxIds: { "inbox-id": true }, keywords: {},
    from: [{ email: "anna@example.com", name: "Anna" }], to: [], cc: [], subject: "Lunch?",
    receivedAt: "2026-10-10T12:00:00Z", preview: "", textBody: [], htmlBody: [], bodyValues: {},
    attachments: [],
  };

  it("authorizes the observation, then hands the hook the message and its thread", async () => {
    const { deliver, queue, callback } = deliverySetup(EMAIL);
    await deliver();
    expect(queue.authorizeObservation).toHaveBeenCalledWith(expect.objectContaining({
      title: "New Fastmail message: Lunch?",
    }));
    const [[entry]] = callback.receiveMessage.mock.calls as [[Record<string, any>]];
    expect(entry.message).toMatchObject({ id: "e1", subject: "Lunch?", from: [{ email: "anna@example.com", name: "Anna" }] });
    expect(entry.folderId).toBe("inbox-id");
    expect(entry.thread).toBeDefined();
  });

  it("skips mail that is gone, filed elsewhere, or a draft", async () => {
    for (const email of [
      undefined,
      { ...EMAIL, mailboxIds: { "other-id": true } },
      { ...EMAIL, keywords: { $draft: true } },
    ]) {
      const { deliver, queue, callback } = deliverySetup(email);
      await deliver();
      expect(queue.authorizeObservation).not.toHaveBeenCalled();
      expect(callback.receiveMessage).not.toHaveBeenCalled();
    }
  });
});

class FakeApprovalQueue extends RpcTarget {
  constructor(private readonly fake: { authorizeObservation: (description: unknown) => Promise<void> }) {
    super();
  }
  authorizeObservation(description: unknown) {
    return this.fake.authorizeObservation(description);
  }
}

class FakeHook extends RpcTarget {
  constructor(private readonly fake: { receiveMessage: (entry: unknown) => Promise<void> }) {
    super();
  }
  receiveMessage(entry: unknown) {
    return this.fake.receiveMessage(entry);
  }
}

// ── Web Push encryption, as Fastmail does it (RFC 8291 §3.4, RFC 8188) ──

async function encryptPush(message: unknown, keys: { p256dh: string; auth: string }): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const receiverPublic = base64UrlDecode(keys.p256dh);
  const receiverKey = await crypto.subtle.importKey("raw", receiverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(base64UrlDecode(keys.auth), secret,
    concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, concat(encoder.encode(JSON.stringify(message)), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, ciphertext).buffer as ArrayBuffer;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
