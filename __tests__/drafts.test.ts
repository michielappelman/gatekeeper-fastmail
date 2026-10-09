import { describe, expect, it, vi } from "vitest";
import {
  currentDraftRevision,
  getDraftRecord,
  putDraftRecord,
  type CacheKv,
  type DraftRecord,
  type DraftRevision,
} from "../src/cache";
import { applyDraftRevision, currentDraft, rejectDraftRevision } from "../src/drafts";

function makeKv(): CacheKv {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void store.set(key, structuredClone(value)),
    delete: (key: string) => store.delete(key),
  };
}

const GRANT = { apiUrl: "https://api/", apiToken: "token", accountId: "u1", hasSubmission: true };

type Call = [name: string, args: Record<string, any>, id: string];

/** A JMAP endpoint that answers each method call by name, numbering the Emails it creates. */
function fakeJmap() {
  const calls: Call[] = [];
  let nextEmail = 1;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Call[] };
    calls.push(...methodCalls);
    const methodResponses = methodCalls.map(([name, args, id]) => {
      switch (name) {
        case "Mailbox/get":
          return [name, { list: [{ id: "mb-drafts", role: "drafts" }, { id: "mb-sent", role: "sent" }] }, id];
        case "Identity/get":
          return [name, { list: [{ id: "id1", email: "me@fastmail.com" }] }, id];
        case "Email/set":
          return [name, {
            created: Object.fromEntries(Object.keys(args.create ?? {}).map(key => [key, { id: `e${nextEmail++}` }])),
          }, id];
        default:
          return [name, {}, id];
      }
    });
    return new Response(JSON.stringify({ methodResponses }));
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const content = (subject: string) => ({ to: [{ email: "you@example.com" }], subject, textBody: subject });

function draft(pending: Record<number, DraftRevision>, extra: Partial<DraftRecord> = {}): CacheKv {
  const kv = makeKv();
  putDraftRecord(kv, { id: "d1", from: "me@fastmail.com", pending, ...extra });
  return kv;
}

describe("applyDraftRevision", () => {
  it("saves a new draft and records the Email holding it", async () => {
    const kv = draft({ 1: { kind: "content", content: content("v1"), at: 1 } });
    const jmap = fakeJmap();
    await applyDraftRevision(kv, 1, "d1", GRANT, jmap.fetchImpl);

    const [, emailSet] = jmap.calls.find(([name, args]) => name === "Email/set" && args.create)!;
    expect(emailSet.create.draft).toMatchObject({ subject: "v1", from: [{ email: "me@fastmail.com" }] });
    expect(emailSet.destroy).toBeUndefined();
    expect(jmap.calls.some(([name]) => name === "EmailSubmission/set")).toBe(false);
    const record = getDraftRecord(kv, "d1")!;
    expect(record.pending).toEqual({});
    expect(record.applied).toMatchObject({ actionId: 1, emailId: "e1" });
  });

  it("replaces the previous copy on an edit", async () => {
    const kv = draft({ 2: { kind: "content", content: content("v2"), at: 2 } }, {
      applied: { actionId: 1, revision: { kind: "content", content: content("v1"), at: 1 }, emailId: "e-old" },
    });
    const jmap = fakeJmap();
    await applyDraftRevision(kv, 2, "d1", GRANT, jmap.fetchImpl);
    const [, emailSet] = jmap.calls.find(([name, args]) => name === "Email/set" && args.create)!;
    expect(emailSet.destroy).toEqual(["e-old"]);
    expect(getDraftRecord(kv, "d1")!.applied).toMatchObject({ actionId: 2, emailId: "e1" });
  });

  it("drops a revision older than the one already applied without calling Fastmail", async () => {
    const kv = draft({ 1: { kind: "content", content: content("v1"), at: 1 } }, {
      applied: { actionId: 2, revision: { kind: "content", content: content("v2"), at: 2 }, emailId: "e2" },
    });
    const jmap = fakeJmap();
    await applyDraftRevision(kv, 1, "d1", GRANT, jmap.fetchImpl);
    expect(jmap.fetchImpl).not.toHaveBeenCalled();
    const record = getDraftRecord(kv, "d1")!;
    expect(record.pending).toEqual({});
    expect(currentDraft(kv, "d1").content.subject).toBe("v2");
  });

  it("destroys the saved copy on delete", async () => {
    const kv = draft({ 2: { kind: "deleted", at: 2 } }, {
      applied: { actionId: 1, revision: { kind: "content", content: content("v1"), at: 1 }, emailId: "e-old" },
    });
    const jmap = fakeJmap();
    await applyDraftRevision(kv, 2, "d1", GRANT, jmap.fetchImpl);
    expect(jmap.calls).toEqual([["Email/set", { accountId: "u1", destroy: ["e-old"] }, "c1"]]);
    expect(() => currentDraft(kv, "d1")).toThrow(/no longer exists/);
  });

  it("deletes a never-saved draft without calling Fastmail", async () => {
    const kv = draft({ 1: { kind: "deleted", at: 1 } });
    const jmap = fakeJmap();
    await applyDraftRevision(kv, 1, "d1", GRANT, jmap.fetchImpl);
    expect(jmap.fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the approved snapshot, then discards the saved copy and marks the original answered", async () => {
    const params = { from: "me@fastmail.com", ...content("approved") };
    const kv = draft({ 2: { kind: "sent", params, at: 2 } }, {
      answersEmailId: "e-orig",
      applied: { actionId: 1, revision: { kind: "content", content: content("v1"), at: 1 }, emailId: "e-old" },
    });
    const jmap = fakeJmap();
    await applyDraftRevision(kv, 2, "d1", GRANT, jmap.fetchImpl);

    const names = jmap.calls.map(([name]) => name);
    expect(names).toEqual([
      "Mailbox/get", "Identity/get", "Email/set", "EmailSubmission/set", "Email/set", "Email/set",
    ]);
    expect(jmap.calls[2][1].create.draft1).toMatchObject({ subject: "approved" });
    expect(jmap.calls[4][1]).toEqual({ accountId: "u1", destroy: ["e-old"] });
    expect(jmap.calls[5][1].update).toEqual({ "e-orig": { "keywords/$answered": true } });

    const record = getDraftRecord(kv, "d1")!;
    expect(record.applied).toEqual({ actionId: 2, revision: { kind: "sent", at: 2 }, emailId: undefined });
    expect(() => currentDraft(kv, "d1")).toThrow(/has been sent/);
  });

  it("keeps revisions submitted while Fastmail was being called", async () => {
    const kv = draft({ 1: { kind: "content", content: content("v1"), at: 1 } });
    const jmap = fakeJmap();
    const inner = jmap.fetchImpl;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const record = getDraftRecord(kv, "d1")!;
      record.pending[2] = { kind: "content", content: content("v2"), at: 2 };
      putDraftRecord(kv, record);
      return inner(url, init);
    }) as typeof fetch;
    await applyDraftRevision(kv, 1, "d1", GRANT, fetchImpl);
    const record = getDraftRecord(kv, "d1")!;
    expect(Object.keys(record.pending)).toEqual(["2"]);
    expect(currentDraftRevision(record)?.actionId).toBe(2);
  });

  it("leaves the revision pending when Fastmail fails, so it stays approvable", async () => {
    const kv = draft({ 1: { kind: "content", content: content("v1"), at: 1 } });
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(applyDraftRevision(kv, 1, "d1", GRANT, fetchImpl))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(Object.keys(getDraftRecord(kv, "d1")!.pending)).toEqual(["1"]);
  });

  it("throws for an unknown revision", async () => {
    await expect(applyDraftRevision(makeKv(), 1, "missing", GRANT, fakeJmap().fetchImpl))
      .rejects.toThrow(/Unknown pending revision/);
  });
});

describe("rejectDraftRevision", () => {
  it("falls back to the newest remaining revision", () => {
    const kv = draft({
      1: { kind: "content", content: content("v1"), at: 1 },
      2: { kind: "content", content: content("v2"), at: 2 },
    });
    rejectDraftRevision(kv, 2, "d1");
    expect(currentDraft(kv, "d1").content.subject).toBe("v1");
  });

  it("brings back a draft whose send was rejected", () => {
    const kv = draft({ 2: { kind: "sent", params: { from: "me@fastmail.com", ...content("v1") }, at: 2 } }, {
      applied: { actionId: 1, revision: { kind: "content", content: content("v1"), at: 1 }, emailId: "e1" },
    });
    expect(() => currentDraft(kv, "d1")).toThrow(/has been sent/);
    rejectDraftRevision(kv, 2, "d1");
    expect(currentDraft(kv, "d1").content.subject).toBe("v1");
  });

  it("forgets a draft whose only revision was rejected", () => {
    const kv = draft({ 1: { kind: "content", content: content("v1"), at: 1 } });
    rejectDraftRevision(kv, 1, "d1");
    expect(getDraftRecord(kv, "d1")).toBeUndefined();
  });
});
