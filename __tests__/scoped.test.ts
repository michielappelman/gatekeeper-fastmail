import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastmailError } from "../src/errors";
import { FastmailHookDeliveryImpl, FastmailSessionImpl } from "../src/fastmail";
import type { FastmailScope } from "../src/resource";
import { ScopeGuard } from "../src/scope";

type MethodCall = [string, Record<string, any>, string];
type Handler = (args: Record<string, any>) => [string, Record<string, any>];

/** A fake JMAP API answering each method call with its handler, and recording every call. */
function fakeJmap(handlers: Record<string, Handler>) {
  const calls: MethodCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: MethodCall[] };
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      calls.push([name, args, callId]);
      const handler = handlers[name];
      if (!handler) throw new Error(`Unexpected JMAP call ${name}`);
      const [responseName, result] = handler(args);
      return [responseName, result, callId];
    });
    return new Response(JSON.stringify({ methodResponses }));
  }));
  return { named: (name: string) => calls.filter(([n]) => n === name).map(([, args]) => args) };
}

const GRANT = {
  apiToken: "token", apiUrl: "https://api/", downloadUrlTemplate: "", uploadUrlTemplate: "",
  accountId: "u1", hasSubmission: true, identityEmail: "me@fastmail.com", username: "me@fastmail.com",
};

/** A small mailbox: thread t1 has e1 (Receipts) and e2 (Inbox); e3 is alone in Inbox. */
const EMAILS: Record<string, any> = {
  e1: {
    id: "e1", threadId: "t1", mailboxIds: { receipts: true }, keywords: {}, messageId: ["m1@x"],
    from: [{ email: "shop@example.com" }], to: [{ email: "me@fastmail.com" }], cc: [], subject: "Your receipt",
    receivedAt: "2026-10-01T10:00:00Z", preview: "", textBody: [], htmlBody: [], bodyValues: {}, attachments: [],
    references: [], replyTo: null,
  },
  e2: {
    id: "e2", threadId: "t1", mailboxIds: { inbox: true }, keywords: {}, messageId: ["m2@x"],
    from: [{ email: "shop@example.com" }], to: [{ email: "me@fastmail.com" }], cc: [], subject: "Re: Your receipt",
    receivedAt: "2026-10-02T10:00:00Z", preview: "", textBody: [], htmlBody: [], bodyValues: {}, attachments: [],
    references: [], replyTo: null,
  },
  e3: {
    id: "e3", threadId: "t3", mailboxIds: { inbox: true }, keywords: {}, messageId: ["m3@x"],
    from: [{ email: "friend@example.com" }], to: [{ email: "me@fastmail.com" }], cc: [], subject: "Hi",
    receivedAt: "2026-10-03T10:00:00Z", preview: "", textBody: [], htmlBody: [], bodyValues: {}, attachments: [],
    references: [], replyTo: null,
  },
};
const FOLDERS = [
  { id: "inbox", name: "Inbox", parentId: null, role: "inbox", totalEmails: 2, unreadEmails: 0 },
  { id: "archive", name: "Archive", parentId: null, role: "archive", totalEmails: 0, unreadEmails: 0 },
  { id: "receipts", name: "Receipts", parentId: null, role: null, totalEmails: 1, unreadEmails: 0 },
  { id: "private", name: "Private", parentId: null, role: null, totalEmails: 9, unreadEmails: 0 },
];

/** The mailbox above as a JMAP API; `searchMatches` is which ids the saved search matches. */
function mailbox(searchMatches: string[] = []) {
  return fakeJmap({
    "Email/get": args => ["Email/get", { list: (args.ids as string[]).flatMap(id => EMAILS[id] ? [EMAILS[id]] : []) }],
    "Thread/get": args => ["Thread/get", {
      list: (args.ids as string[]).map(id => ({ id, emailIds: id === "t1" ? ["e1", "e2"] : ["e3"] })),
    }],
    "Email/query": args => ["Email/query", { ids: args.filter?.operator === "AND" && args.filter.conditions[1]?.operator === "OR"
      ? searchMatches : ["e1"] }],
    "Mailbox/get": () => ["Mailbox/get", { list: FOLDERS }],
  });
}

function setup(scope: FastmailScope) {
  const queue = {
    submitAction: vi.fn(async (_id: number, _description: Record<string, unknown>) => {}),
    authorizeObservation: vi.fn(async (_description: unknown) => {}),
    dup: () => queue,
    [Symbol.dispose]: () => {},
  };
  const store = new Map<string, unknown>();
  const kv = {
    get: (key: string) => structuredClone(store.get(key)),
    put: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
    delete: (key: string) => store.delete(key),
  };
  const account = { getGrant: async () => GRANT, noteCredentialsExpired: async () => {} };
  const guard = new ScopeGuard(scope);
  const session = new FastmailSessionImpl(queue as any, account as any, kv as any, {} as Ai, undefined, guard);
  return { session, queue, kv, account, guard, store };
}

const pending = (store: Map<string, unknown>) =>
  [...store].filter(([key]) => key.startsWith("action:") && key !== "action:nextId").map(([, value]) => value);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScopeGuard", () => {
  it("narrows listings to the scope", () => {
    expect(new ScopeGuard().listFilter({})).toBeUndefined();
    expect(new ScopeGuard().listFilter({ inMailbox: "a", text: "x" })).toEqual({ inMailbox: "a", text: "x" });
    const folder = new ScopeGuard({ kind: "folder", folderId: "receipts" });
    expect(folder.listFilter({ text: "x" })).toEqual({ inMailbox: "receipts", text: "x" });
    expect(() => folder.listFilter({ inMailbox: "private" })).toThrow(FastmailError);
    const search = new ScopeGuard({ kind: "search", filter: { from: "shop@example.com" } });
    expect(search.listFilter({ text: "x" })).toEqual({
      operator: "AND", conditions: [{ from: "shop@example.com" }, { text: "x" }],
    });
  });

  it("admits by folder membership, and by Fastmail's own search for a search scope", async () => {
    mailbox();
    await expect(new ScopeGuard({ kind: "folder", folderId: "receipts" }).admit(GRANT, ["e1", "e2", "nope"]))
      .resolves.toEqual(["e1"]);
    const jmap = mailbox(["e2", "e9"]);
    await expect(new ScopeGuard({ kind: "search", filter: { subject: "Re:" } }).admit(GRANT, ["e1", "e2"]))
      .resolves.toEqual(["e2"]);
    const [query] = jmap.named("Email/query");
    expect(query.filter).toEqual({ operator: "AND", conditions: [
      { subject: "Re:" },
      { operator: "OR", conditions: [{ header: ["Message-ID", "m1@x"] }, { header: ["Message-ID", "m2@x"] }] },
    ] });
  });

  it("shows a narrowed binding only its own folder and the filing system folders", () => {
    const visible = new ScopeGuard({ kind: "folder", folderId: "receipts" }).visibleFolders(FOLDERS as any);
    expect(visible.map(folder => folder.id)).toEqual(["inbox", "archive", "receipts"]);
    expect(new ScopeGuard().visibleFolders(FOLDERS as any)).toHaveLength(4);
  });

  it("hides Sent, Drafts, Scheduled and Snoozed, and a hidden parent's id", () => {
    const folders = [
      { id: "inbox", name: "Inbox", parentId: null, role: "inbox" },
      { id: "sent", name: "Sent", parentId: null, role: "sent" },
      { id: "snoozed", name: "Snoozed", parentId: null, role: "snoozed" },
      { id: "scheduled", name: "Scheduled", parentId: null, role: "scheduled" },
      { id: "home", name: "Home", parentId: null, role: null },
      { id: "funda", name: "Funda", parentId: "home", role: null },
    ];
    const visible = new ScopeGuard({ kind: "folder", folderId: "funda" }).visibleFolders(folders as any);
    expect(visible).toEqual([
      { id: "inbox", name: "Inbox", parentId: null, role: "inbox" },
      { id: "funda", name: "Funda", parentId: null, role: null },
    ]);
    // The whole mailbox keeps the tree as it is.
    expect(new ScopeGuard().visibleFolders(folders as any)[5].parentId).toBe("home");
  });
});

describe("a folder binding", () => {
  const scope: FastmailScope = { kind: "folder", folderId: "receipts" };

  it("opens a thread showing only its messages in the folder", async () => {
    const { session, queue } = setup(scope);
    mailbox();
    const thread = await session.getThread("t1");
    const messages = await thread.messages();
    expect(messages.map(message => message.id)).toEqual(["e1"]);
    expect(queue.authorizeObservation).toHaveBeenCalled();
    await expect(session.getThread("t3")).rejects.toThrow(/not found/);
  });

  it("opens only messages in the folder", async () => {
    const { session } = setup(scope);
    mailbox();
    await expect((await session.getMessage("e1")).read()).resolves.toMatchObject({ id: "e1" });
    await expect(session.getMessage("e2")).rejects.toThrow(/not found/);
    await expect(session.getMessage("missing")).rejects.toThrow(/not found/);
    await expect(session.getMessage("../e1")).rejects.toThrow(/not found/);
  });

  it("refuses to list another folder, and lists its own", async () => {
    const { session } = setup(scope);
    const jmap = mailbox();
    await expect(session.listThreads("private")).rejects.toThrow(FastmailError);
    const cursor = await session.listMessages();
    await cursor.next();
    expect(jmap.named("Email/query")[0]).toMatchObject({ filter: { inMailbox: "receipts" }, collapseThreads: false });
  });

  it("can't write new mail, but can reply to a message in scope", async () => {
    const { session, queue } = setup(scope);
    mailbox();
    await expect(session.send([{ email: "x@example.com" }], "Hi", { text: "x" })).rejects.toThrow(/one folder/);
    await expect(session.createDraft({ subject: "x" })).rejects.toThrow(/one folder/);
    await (await session.getMessage("e1")).reply({ text: "Thanks" });
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
  });

  it("lists only its own and the system folders, and moves mail only there", async () => {
    const { session, store } = setup(scope);
    mailbox();
    expect((await session.listFolders()).map(folder => folder.id)).toEqual(["inbox", "archive", "receipts"]);
    const message = await session.getMessage("e1");
    await expect(message.moveToFolder("private")).rejects.toThrow(/not found/);
    await message.moveToFolder("archive");
    expect(pending(store)).toEqual([{ kind: "patch", emailIds: ["e1"], patch: { mailboxIds: { archive: true } } }]);
  });

  it("changes only the thread's messages in scope", async () => {
    const { session, store } = setup(scope);
    mailbox();
    await (await session.getThread("t1")).markRead();
    expect(pending(store)).toEqual([{ kind: "patch", emailIds: ["e1"], patch: { "keywords/$seen": true } }]);
  });

  it("drops a message from scope once it leaves the folder", async () => {
    const { session } = setup(scope);
    mailbox();
    const message = await session.getMessage("e1");
    EMAILS.e1.mailboxIds = { archive: true };
    try {
      await expect(message.read()).rejects.toThrow(/not found/);
    } finally {
      EMAILS.e1.mailboxIds = { receipts: true };
    }
  });
});

describe("probing ids outside a binding", () => {
  it("answers a missing thread exactly as an out-of-scope one", async () => {
    const { session } = setup({ kind: "folder", folderId: "receipts" });
    fakeJmap({
      "Thread/get": args => ["Thread/get", { list: args.ids[0] === "t3" ? [{ id: "t3", emailIds: ["e3"] }] : [] }],
      "Email/get": args => ["Email/get", { list: (args.ids as string[]).flatMap(id => EMAILS[id] ? [EMAILS[id]] : []) }],
    });
    const outside = await session.getThread("t3").catch((error: Error) => error.message);
    const missing = await session.getThread("t404").catch((error: Error) => error.message);
    expect(outside).toBe(missing);
  });
});

describe("a search binding", () => {
  it("admits what the search matches", async () => {
    const { session } = setup({ kind: "search", filter: { subject: "Re:" } });
    mailbox(["e2"]);
    const thread = await session.getThread("t1");
    expect((await thread.messages()).map(message => message.id)).toEqual(["e2"]);
    await expect(session.getMessage("e1")).rejects.toThrow(/not found/);
  });
});

describe("the whole mailbox", () => {
  it("opens any message, and acts on just that message", async () => {
    const { session, store } = setup({ kind: "mailbox" });
    mailbox();
    const message = await session.getMessage("e2");
    await message.addKeyword("$flagged");
    expect(pending(store)).toEqual([{ kind: "patch", emailIds: ["e2"], patch: { "keywords/$flagged": true } }]);
    const thread = await message.thread();
    expect((await thread.messages()).map(m => m.id)).toEqual(["e1", "e2"]);
  });

  it("reads one message's headers", async () => {
    const { session } = setup({ kind: "mailbox" });
    fakeJmap({
      "Email/get": args => ["Email/get", { list: [{ id: args.ids[0], headers: [{ name: "List-Id", value: "<news.example.com>" }] }] }],
    });
    await expect((await session.getMessage("e1")).getHeaders())
      .resolves.toEqual([{ name: "List-Id", value: "<news.example.com>" }]);
  });
});

describe("hook delivery on a search binding", () => {
  it("delivers only messages the search matches", async () => {
    const guard = new ScopeGuard({ kind: "search", filter: { subject: "Re:" } });
    const account = { getGrant: async () => GRANT, noteCredentialsExpired: async () => {} };
    const impl = new FastmailHookDeliveryImpl(undefined, account as any, new Map() as any, {} as Ai, guard);
    const received: any[] = [];
    const deliver = async (id: string) => {
      using queue = new RpcStub(new FakeApprovalQueue());
      using callback = new RpcStub(new FakeHook(received));
      await impl.deliver(callback as any, queue as any, id);
    };
    mailbox(["e2"]);
    await deliver("e1");
    expect(received).toEqual([]);
    await deliver("e2");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: { id: "e2" }, folderId: null });
  });
});

class FakeApprovalQueue extends RpcTarget {
  async authorizeObservation() {}
}

class FakeHook extends RpcTarget {
  constructor(private readonly received: unknown[]) {
    super();
  }
  async receiveMessage(entry: { message: unknown; folderId: unknown }) {
    this.received.push({ message: entry.message, folderId: entry.folderId });
  }
}
