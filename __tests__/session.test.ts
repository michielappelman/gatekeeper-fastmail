import { afterEach, describe, expect, it, vi } from "vitest";
import { FastmailSessionImpl, FastmailThreadImpl } from "../src/fastmail";

function makeKv() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void store.set(key, structuredClone(value)),
    delete: (key: string) => store.delete(key),
  };
}

function fakeApprovalQueue() {
  const queue = {
    submitAction: vi.fn(async (_id: number, _description: Record<string, unknown>) => {}),
    authorizeObservation: vi.fn(async () => {}),
    dup: () => queue,
    [Symbol.dispose]: () => {},
  };
  return queue;
}

const SENDING_GRANT = {
  apiToken: "token", apiUrl: "https://api/", downloadUrlTemplate: "", uploadUrlTemplate: "",
  accountId: "u1", hasSubmission: true, identityEmail: "me@fastmail.com", username: "me@fastmail.com",
};
const DRAFT_ONLY_GRANT = { ...SENDING_GRANT, hasSubmission: false, identityEmail: undefined };

function setup(grant: typeof SENDING_GRANT | typeof DRAFT_ONLY_GRANT = SENDING_GRANT) {
  const queue = fakeApprovalQueue();
  const kv = makeKv();
  const account = { getGrant: async () => grant, noteCredentialsExpired: async () => {} };
  const session = new FastmailSessionImpl(queue as any, account as any, kv as any, {} as Ai);
  const thread = (messageIds: string[]) =>
    new FastmailThreadImpl(queue as any, account as any, kv as any, messageIds, {} as Ai);
  const submitted = () => queue.submitAction.mock.calls.map(([, description]) => description);
  return { queue, session, thread, submitted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drafts through the session", () => {
  it("queues a new draft as auto-approvable and shows it before approval", async () => {
    const { session, submitted } = setup();
    const draft = await session.createDraft({
      to: [{ email: "anna@example.com", name: "Anna" }], subject: "Dinner", text: "Friday?",
    });

    expect(submitted()).toHaveLength(1);
    expect(submitted()[0]).toMatchObject({
      title: "Create email draft",
      actionKind: { tag: "draftCreate" },
      autoApprovable: true,
    });
    const [info] = await session.listDrafts();
    expect(info).toMatchObject({
      to: [{ email: "anna@example.com", name: "Anna" }], subject: "Dinner", isReply: false,
    });
    expect(await draft.getContent()).toEqual({ text: "Friday?" });
  });

  it("edits, reopens and discards a draft", async () => {
    const { session, submitted } = setup();
    const draft = await session.createDraft({ subject: "Dinner", text: "Friday?", html: "<p>Friday?</p>" });
    const { id } = await draft.getMetadata();

    await draft.update({ to: [{ email: "bob@example.com" }], text: "Saturday?", html: null });
    expect(submitted()[1]).toMatchObject({ actionKind: { tag: "draftUpdate" }, autoApprovable: true });

    const reopened = await session.getDraft(id);
    expect(await reopened.getContent()).toEqual({ text: "Saturday?" });
    expect((await reopened.getMetadata()).to).toEqual([{ email: "bob@example.com" }]);

    await reopened.delete();
    expect(submitted()[2]).toMatchObject({ actionKind: { tag: "draftDelete" }, autoApprovable: true });
    expect(await session.listDrafts()).toEqual([]);
    await expect(session.getDraft(id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("never marks sending a draft auto-approvable", async () => {
    const { session, submitted } = setup();
    const draft = await session.createDraft({ to: [{ email: "anna@example.com" }], subject: "Hi", text: "Hello" });
    await draft.send();

    const send = submitted()[1];
    expect(send.title).toBe("Send email draft");
    expect(send.actionKind).toBeUndefined();
    expect(send.autoApprovable).toBeUndefined();
    expect(await session.listDrafts()).toEqual([]);
    await expect(draft.update({ subject: "Too late" })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("refuses to send a draft without recipients", async () => {
    const { session, submitted } = setup();
    const draft = await session.createDraft({ subject: "Hi" });
    await expect(draft.send()).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    expect(submitted()).toHaveLength(1);
  });

  it("never marks a direct send auto-approvable", async () => {
    const { session, submitted } = setup();
    await session.send([{ email: "anna@example.com" }], "Hi", { text: "Hello" });
    expect(submitted()[0].autoApprovable).toBeUndefined();
  });
});

describe("a token without Email submission", () => {
  it("can prepare drafts, from the session's login address", async () => {
    const { session, submitted } = setup(DRAFT_ONLY_GRANT);
    await session.createDraft({ to: [{ email: "anna@example.com" }], subject: "Hi", text: "Hello" });
    expect(submitted()[0].fields).toContainEqual(
      expect.objectContaining({ label: "From", value: "me@fastmail.com" }));
  });

  it("cannot send a draft, and queues nothing", async () => {
    const { session, submitted } = setup(DRAFT_ONLY_GRANT);
    const draft = await session.createDraft({ to: [{ email: "anna@example.com" }], subject: "Hi", text: "Hello" });
    await expect(draft.send()).rejects.toMatchObject({ code: "SUBMISSION_NOT_AUTHORIZED" });
    expect(submitted()).toHaveLength(1);
    expect(await session.listDrafts()).toHaveLength(1);
  });
});

describe("reply drafts", () => {
  it("addresses and threads a reply draft like reply()", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      methodResponses: [["Email/get", { list: [{
        id: "e-orig", messageId: ["orig@x"], references: ["root@x"],
        from: [{ email: "anna@example.com", name: "Anna" }], to: [{ email: "me@fastmail.com" }],
        subject: "Dinner", receivedAt: "2026-10-01T10:00:00Z",
      }] }, "c1"]],
    }))));
    const { session, thread, submitted } = setup(DRAFT_ONLY_GRANT);
    const draft = await thread(["e-orig"]).createReplyDraft({ text: "Yes!" });

    expect(submitted()[0]).toMatchObject({ title: "Save reply draft", actionKind: { tag: "draftCreate" } });
    const info = await draft.getMetadata();
    expect(info).toMatchObject({
      to: [{ email: "anna@example.com", name: "Anna" }], subject: "Re: Dinner", isReply: true,
    });
    expect(submitted()[0].fields).toContainEqual(
      expect.objectContaining({ label: "In-Reply-To", items: ["<orig@x>"] }));
    expect((await session.listDrafts())[0].isReply).toBe(true);
  });
});

describe("thread changes", () => {
  it("tags read state, keywords and moves with their own auto-approvable kinds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      methodResponses: [["Email/get", { list: [] }, "c1"]],
    }))));
    const { thread, submitted } = setup();
    const t = thread(["e1"]);
    await t.markRead();
    await t.addKeyword("$flagged");
    await t.moveToFolder("mb-archive");
    expect(submitted().map(description => description.actionKind)).toEqual([
      expect.objectContaining({ tag: "readState" }),
      expect.objectContaining({ tag: "keyword" }),
      expect.objectContaining({ tag: "move" }),
    ]);
    expect(submitted().every(description => description.autoApprovable === true)).toBe(true);
  });
});
