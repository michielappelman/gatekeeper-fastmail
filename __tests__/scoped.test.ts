import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastmailError } from "../src/errors";
import { FastmailHookDeliveryImpl, FastmailSessionImpl } from "../src/fastmail";
import type { FastmailScope } from "../src/resource";
import { ScopeGuard } from "../src/scope";
import { getDraftRecord, type CacheKv } from "../src/cache";
import { applyDraftRevision, rejectDraftRevision } from "../src/drafts";
import { updateEmails } from "../src/fastmail-api";
import type { FastmailSearch, FastmailThreadChange } from "../src/types";

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
    "Email/set": () => ["Email/set", {}],
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
    expect(new ScopeGuard().listFilter({ inMailbox: "a", search: { text: "x" } })).toEqual({ inMailbox: "a", text: "x" });
    const folder = new ScopeGuard({ kind: "folder", folderId: "receipts" });
    expect(folder.listFilter({ search: { text: "x" } })).toEqual({ inMailbox: "receipts", text: "x" });
    expect(() => folder.listFilter({ inMailbox: "private" })).toThrow(FastmailError);
    const search = new ScopeGuard({ kind: "search", filter: { from: "shop@example.com" } });
    expect(search.listFilter({ search: { text: "x" } })).toEqual({
      operator: "AND", conditions: [{ from: "shop@example.com" }, { text: "x" }],
    });
    // A caller's search that is itself an operator is ANDed in whole, never merged into a condition.
    const either = { operator: "AND", conditions: [{ hasKeyword: "$seen" }, { hasKeyword: "$flagged" }] };
    expect(folder.listFilter({ search: either })).toEqual({ operator: "AND", conditions: [{ inMailbox: "receipts" }, either] });
    expect(new ScopeGuard().listFilter({ search: either })).toEqual(either);
    expect(new ScopeGuard().listFilter({ inMailbox: "a", search: either })).toEqual({
      operator: "AND", conditions: [{ inMailbox: "a" }, either],
    });
    expect(search.listFilter({ inMailbox: "a", search: either })).toEqual({
      operator: "AND", conditions: [{ from: "shop@example.com" }, { inMailbox: "a" }, either],
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
    const store = new Map<string, unknown>();
    const kv = {
      get: (key: string) => store.get(key),
      put: (key: string, value: unknown) => void store.set(key, value),
      delete: (key: string) => store.delete(key),
    };
    const impl = new FastmailHookDeliveryImpl(undefined, account as any, kv as any, {} as Ai, guard);
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
    expect(received[0]).toMatchObject({ message: { id: "e2", folderIds: ["inbox"] }, folderId: null });
  });
});

describe("structured search", () => {
  const receipts: FastmailScope = { kind: "folder", folderId: "receipts" };

  it("is ANDed with a folder binding's own folder, and a saved search's filter", async () => {
    const folder = setup(receipts);
    const jmap = mailbox();
    await (await folder.session.searchThreads({ from: "shop@example.com", unread: true })).next();
    expect(jmap.named("Email/query")[0].filter)
      .toEqual({ inMailbox: "receipts", from: "shop@example.com", notKeyword: "$seen" });

    // Colliding conditions keep the folder in an AND beside them.
    await (await folder.session.searchMessages({ unread: true, notKeyword: "$draft" })).next();
    // A cursor may load several pages per next(), so read the latest query, not a fixed index.
    expect(jmap.named("Email/query").at(-1)!.filter).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "receipts" }, {
        operator: "AND", conditions: [{ notKeyword: "$draft" }, { notKeyword: "$seen" }],
      }],
    });

    const saved = setup({ kind: "search", filter: { subject: "Re:" } });
    await (await saved.session.searchMessages({ flagged: true, unread: false }, "inbox")).next();
    expect(jmap.named("Email/query").at(-1)!.filter).toEqual({
      operator: "AND",
      conditions: [{ subject: "Re:" }, { inMailbox: "inbox" }, {
        operator: "AND", conditions: [{ hasKeyword: "$seen" }, { hasKeyword: "$flagged" }],
      }],
    });
  });

  it("keeps a string a full-text search, and refuses an invalid one before querying", async () => {
    const { session } = setup({ kind: "mailbox" });
    const jmap = mailbox();
    await (await session.searchThreads("wedding", "inbox")).next();
    expect(jmap.named("Email/query")[0].filter).toEqual({ inMailbox: "inbox", text: "wedding" });
    // The fake keeps returning a row, so the walk above queried repeatedly; invalid searches add none.
    const queried = jmap.named("Email/query").length;
    await expect(session.searchThreads({})).rejects.toThrow(FastmailError);
    await expect(session.searchMessages({ after: "yesterday" })).rejects.toThrow(FastmailError);
    await expect(session.searchMessages({ evil: true } as unknown as FastmailSearch)).rejects.toThrow();
    expect(jmap.named("Email/query")).toHaveLength(queried);
  });
});

describe("folderIds on messages", () => {
  const inSeveralFolders = { receipts: true, archive: true, private: true };

  it("shows a folder binding only the folders it can see", async () => {
    const { session } = setup({ kind: "folder", folderId: "receipts" });
    mailbox();
    EMAILS.e1.mailboxIds = inSeveralFolders;
    try {
      const entries = await (await session.listMessages()).next();
      expect(entries?.[0].folderIds).toEqual(["receipts", "archive"]);
      const messages = await (await session.getThread("t1")).messages();
      expect(messages[0].folderIds).toEqual(["receipts", "archive"]);
    } finally {
      EMAILS.e1.mailboxIds = { receipts: true };
    }
  });

  it("shows the whole mailbox every folder", async () => {
    const { session } = setup({ kind: "mailbox" });
    mailbox();
    EMAILS.e1.mailboxIds = inSeveralFolders;
    try {
      const entries = await (await session.listMessages()).next();
      expect(entries?.[0].folderIds).toEqual(["receipts", "archive", "private"]);
    } finally {
      EMAILS.e1.mailboxIds = { receipts: true };
    }
  });
});

type PendingPatch = { kind: "patch"; emailIds: string[]; patch: Record<string, unknown> };

describe("updateThreads", () => {
  it("queues one action over every message of the threads, with the single-thread kind and overlays", async () => {
    const { session, queue, store } = setup({ kind: "mailbox" });
    const jmap = mailbox();
    await session.updateThreads(["t1", "t3", "t1"], { markRead: true });
    expect(pending(store)).toEqual([{ kind: "patch", emailIds: ["e1", "e2", "e3"], patch: { "keywords/$seen": true } }]);
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    expect(queue.submitAction.mock.calls[0][1]).toMatchObject({
      title: "Mark Fastmail threads read", actionKind: { tag: "readState" }, autoApprovable: true,
    });
    expect(JSON.stringify(queue.submitAction.mock.calls[0][1])).toContain("these 2 threads");
    // The simulated read state shows on each message straight away.
    expect(store.get("sim:keywords:e3")).toMatchObject({ keywords: { $seen: true } });
    // The change is one Email/set over all of them when approved.
    const [{ emailIds, patch }] = pending(store) as PendingPatch[];
    await updateEmails("https://api/", "token", "u1", true, emailIds, patch);
    expect(jmap.named("Email/set")).toHaveLength(1);
    expect(Object.keys(jmap.named("Email/set")[0].update)).toEqual(["e1", "e2", "e3"]);
  });

  it("moves, flags and unflags like the single-thread methods", async () => {
    const { session, queue, store } = setup({ kind: "mailbox" });
    mailbox();
    await session.updateThreads(["t3"], { moveToFolder: "archive" });
    await session.updateThreads(["t3"], { addKeyword: "$flagged" });
    await session.updateThreads(["t3"], { removeKeyword: "$flagged" });
    await session.updateThreads(["t3"], { markUnread: true });
    expect(pending(store)).toEqual([
      { kind: "patch", emailIds: ["e3"], patch: { mailboxIds: { archive: true } } },
      { kind: "patch", emailIds: ["e3"], patch: { "keywords/$flagged": true } },
      { kind: "patch", emailIds: ["e3"], patch: { "keywords/$flagged": null } },
      { kind: "patch", emailIds: ["e3"], patch: { "keywords/$seen": null } },
    ]);
    expect(queue.submitAction.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ actionKind: expect.objectContaining({ tag: "move" }), autoApprovable: true }),
      expect.objectContaining({ actionKind: expect.objectContaining({ tag: "keyword" }) }),
      expect.objectContaining({ actionKind: expect.objectContaining({ tag: "keyword" }) }),
      expect.objectContaining({ actionKind: expect.objectContaining({ tag: "readState" }) }),
    ]);
  });

  it("changes only the in-scope messages, and refuses an out-of-scope or missing thread before queueing", async () => {
    const { session, queue, store } = setup({ kind: "folder", folderId: "receipts" });
    fakeJmap({
      "Thread/get": args => ["Thread/get", {
        list: (args.ids as string[]).flatMap(id =>
          id === "t1" ? [{ id, emailIds: ["e1", "e2"] }] : id === "t3" ? [{ id, emailIds: ["e3"] }] : []),
      }],
      "Email/get": args => ["Email/get", { list: (args.ids as string[]).flatMap(id => EMAILS[id] ? [EMAILS[id]] : []) }],
      "Mailbox/get": () => ["Mailbox/get", { list: FOLDERS }],
    });
    await session.updateThreads(["t1"], { markRead: true });
    expect(pending(store)).toEqual([{ kind: "patch", emailIds: ["e1"], patch: { "keywords/$seen": true } }]);
    expect(queue.submitAction).toHaveBeenCalledTimes(1);

    const outside = await session.updateThreads(["t1", "t3"], { markRead: true }).catch((error: Error) => error.message);
    const missing = await session.updateThreads(["t1", "t404"], { markRead: true }).catch((error: Error) => error.message);
    expect(outside).toMatch(/not found/);
    expect(outside).toBe(missing);
    await expect(session.updateThreads(["t1"], { moveToFolder: "private" })).rejects.toThrow(/not found/);
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    expect(pending(store)).toHaveLength(1);
  });

  it("takes 1 to 500 thread ids and exactly one valid change", async () => {
    const { session, queue } = setup({ kind: "mailbox" });
    mailbox();
    await expect(session.updateThreads([], { markRead: true })).rejects.toThrow(FastmailError);
    await expect(session.updateThreads(Array.from({ length: 501 }, (_, i) => `t${i}`), { markRead: true }))
      .rejects.toThrow(FastmailError);
    // Malformed changes are turned away by the RPC argument validation, which throws synchronously.
    await expect(async () => session.updateThreads(
      ["t1"], { markRead: true, markUnread: true } as unknown as FastmailThreadChange)).rejects.toThrow();
    await expect(async () => session.updateThreads(
      ["t1"], { markRead: false } as unknown as FastmailThreadChange)).rejects.toThrow();
    await expect(session.updateThreads(["../t1"], { markRead: true })).rejects.toThrow(/not found/);
    expect(queue.submitAction).not.toHaveBeenCalled();
  });
});

describe("drafts beyond this connection's", () => {
  const NATIVE = {
    id: "n1", mailboxIds: { drafts: true }, from: [{ email: "me@fastmail.com" }],
    to: [{ email: "you@example.com", name: "You" }], cc: [], bcc: [{ email: "boss@example.com" }],
    subject: "Native draft", receivedAt: "2026-10-05T10:00:00Z", inReplyTo: null, references: null,
    attachments: [{ blobId: "b1", type: "application/pdf", name: "a.pdf", size: 10, disposition: "attachment" }],
    textBody: [{ partId: "1", type: "text/plain" }], htmlBody: [{ partId: "2", type: "text/html" }],
    bodyValues: { "1": { value: "Hello" }, "2": { value: "<p>Hello</p>" } },
  };

  function drafts() {
    return fakeJmap({
      "Mailbox/get": () => ["Mailbox/get", { list: [{ id: "drafts", role: "drafts" }] }],
      "Email/query": () => ["Email/query", { ids: ["n1"] }],
      "Email/get": args => ["Email/get", { list: (args.ids as string[]).includes("n1") ? [NATIVE] : [] }],
      "Email/set": () => ["Email/set", { created: { draft: { id: "e100" } } }],
    });
  }

  it("lists a Fastmail draft, adopts it on getDraft(), and edits it through the revision path", async () => {
    const { session, queue, kv } = setup({ kind: "mailbox" });
    const cacheKv = kv as unknown as CacheKv;
    const jmap = drafts();
    const listed = await session.listDrafts();
    expect(listed).toEqual([expect.objectContaining({
      id: "n1", subject: "Native draft", isReply: false, isForward: false,
      to: [{ email: "you@example.com", name: "You" }], bcc: [{ email: "boss@example.com" }],
      attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 10 }],
    })]);

    const draft = await session.getDraft("n1");
    const info = await draft.getMetadata();
    expect(info.id).not.toBe("n1");
    await expect(draft.getContent()).resolves.toEqual({ text: "Hello", html: "<p>Hello</p>" });
    // Opened again by either id, it is the same draft, and no longer listed twice.
    expect((await session.getDraft("n1").then(d => d.getMetadata())).id).toBe(info.id);
    expect((await session.getDraft(info.id).then(d => d.getMetadata())).id).toBe(info.id);
    expect((await session.listDrafts()).map(item => item.id)).toEqual([info.id]);

    await draft.update({ subject: "Changed" });
    expect(queue.submitAction.mock.calls[0][1]).not.toHaveProperty("actionKind");
    expect(Object.keys(getDraftRecord(cacheKv, info.id)?.pending ?? {})).toEqual(["1"]);

    // Approving replaces the Fastmail email: a new one is created and the adopted one destroyed.
    await applyDraftRevision(cacheKv, 1, info.id, GRANT);
    const [set] = jmap.named("Email/set");
    expect(set.destroy).toEqual(["n1"]);
    expect(set.create.draft).toMatchObject({
      subject: "Changed", to: [{ email: "you@example.com", name: "You" }], bcc: [{ email: "boss@example.com" }],
      bodyValues: { text: { value: "Hello" }, html: { value: "<p>Hello</p>" } },
      attachments: [{ blobId: "b1", type: "application/pdf", name: "a.pdf", disposition: "attachment" }],
    });
    expect(getDraftRecord(cacheKv, info.id)?.applied).toMatchObject({ emailId: "e100" });
  });

  it("never auto-approves changes to an adopted draft, unlike one this connection created", async () => {
    const { session, queue } = setup({ kind: "mailbox" });
    drafts();
    const adopted = await session.getDraft("n1");
    await adopted.update({ subject: "Changed" });
    await adopted.delete();
    const created = await session.createDraft({ to: [{ email: "you@example.com" }], subject: "Mine", text: "Hi" });
    await created.update({ subject: "Mine too" });
    const [update, remove, , createdUpdate] = queue.submitAction.mock.calls.map(call => call[1]);
    for (const submitted of [update, remove]) {
      expect(submitted).not.toHaveProperty("actionKind");
      expect(submitted).not.toHaveProperty("autoApprovable");
    }
    expect(createdUpdate).toMatchObject({ actionKind: { tag: "draftUpdate" }, autoApprovable: true });
  });

  it("drops an adopted draft whose Email was replaced in Fastmail, and refuses edits and applies against it", async () => {
    const { session, queue, kv } = setup({ kind: "mailbox" });
    const cacheKv = kv as unknown as CacheKv;
    let present = ["n1"];
    const NEWER = { ...NATIVE, id: "n2", subject: "Edited in Fastmail" };
    fakeJmap({
      "Mailbox/get": () => ["Mailbox/get", { list: [{ id: "drafts", role: "drafts" }] }],
      "Email/query": () => ["Email/query", { ids: present }],
      "Email/get": args => ["Email/get", {
        list: [NATIVE, NEWER].filter(email => present.includes(email.id) && (args.ids as string[]).includes(email.id)),
      }],
      "Email/set": () => ["Email/set", { created: { draft: { id: "e100" } } }],
    });
    const draft = await session.getDraft("n1");
    const { id } = await draft.getMetadata();
    await draft.update({ subject: "Pending" });
    queue.submitAction.mockClear();

    // The person edits it in Fastmail: Fastmail replaces n1 with n2.
    present = ["n2"];
    await expect(draft.update({ subject: "Too late" })).rejects.toThrow(/changed or discarded in Fastmail/);
    await expect(draft.delete()).rejects.toThrow(/changed or discarded in Fastmail/);
    expect(queue.submitAction).not.toHaveBeenCalled();
    await expect(applyDraftRevision(cacheKv, 1, id, GRANT)).rejects.toThrow(/changed or discarded in Fastmail/);

    // Once nothing awaits approval, the stale record drops and the new Email surfaces natively.
    rejectDraftRevision(cacheKv, 1, id);
    expect((await session.listDrafts()).map(item => item.id)).toEqual(["n2"]);
    expect(getDraftRecord(cacheKv, id)).toBeUndefined();
    await expect(session.getDraft(id)).rejects.toThrow(/no longer exists/);
    await expect(session.getDraft("n2").then(d => d.getMetadata())).resolves.toMatchObject({ subject: "Edited in Fastmail" });
  });

  it("doesn't adopt an email outside Drafts, or anything on a narrowed binding", async () => {
    const whole = setup({ kind: "mailbox" });
    drafts();
    await expect(whole.session.getDraft("e1")).rejects.toThrow(/no longer exists/);
    const scoped = setup({ kind: "folder", folderId: "receipts" });
    const jmap = drafts();
    await expect(scoped.session.listDrafts()).resolves.toEqual([]);
    await expect(scoped.session.getDraft("n1")).rejects.toThrow(/no longer exists/);
    expect(jmap.named("Email/query")).toHaveLength(0);
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
