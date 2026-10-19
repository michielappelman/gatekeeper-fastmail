import { afterEach, describe, expect, it, vi } from "vitest";
import { FastmailSessionImpl } from "../src/fastmail";
import { deleteMaskedEmail } from "../src/fastmail-api";
import { ScopeGuard } from "../src/scope";

const GRANT = { apiUrl: "https://api/", apiToken: "token", accountId: "u1" };

type Call = [string, Record<string, unknown>, string];

/** A JMAP API holding `existing` masked addresses; records every method call. */
function stubJmap(existing: Record<string, unknown>[]) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Call[] };
    calls.push(...methodCalls);
    return new Response(JSON.stringify({
      methodResponses: methodCalls.map(([name, args, id]) => {
        if (name === "MaskedEmail/get") {
          const ids = args.ids as string[] | null;
          return [name, { list: ids ? existing.filter(m => ids.includes(m.id as string)) : existing }, id];
        }
        if (name === "MaskedEmail/set" && args.create) {
          return [name, { created: { m: { id: "new1", email: "shop.x7@fastmail.com", createdAt: "2026-10-19T10:00:00Z" } } }, id];
        }
        if (name === "MaskedEmail/set" && args.update) {
          const [target] = Object.keys(args.update as object);
          return [name, existing.some(m => m.id === target)
            ? { updated: { [target]: null } }
            : { notUpdated: { [target]: { type: "notFound" } } }, id];
        }
        return [name, {}, id];
      }),
    }));
  }));
  return calls;
}

function setup(existing: Record<string, unknown>[] = [], guard?: ScopeGuard) {
  const calls = stubJmap(existing);
  const queue = {
    submitAction: vi.fn(async (_id: number, _description: Record<string, unknown>) => {}),
    authorizeObservation: vi.fn(async () => {}),
    dup: () => queue,
    [Symbol.dispose]: () => {},
  };
  const kv = new Map<string, unknown>();
  const account = {
    getMaskedEmailGrant: async () => GRANT,
    noteCredentialsExpired: async () => {},
  };
  const session = new FastmailSessionImpl(
    queue as any, account as any,
    { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => void kv.set(k, v), delete: (k: string) => kv.delete(k) } as any,
    {} as Ai, undefined, guard);
  return { session, queue, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("masked email", () => {
  it("creates an address immediately, without queueing an approval", async () => {
    const { session, queue, calls } = setup();
    const masked = await session.createMaskedEmail({ forDomain: "shop.example.com/login", description: " Shop ", emailPrefix: "shop" });

    expect(masked).toEqual({
      id: "new1", email: "shop.x7@fastmail.com", state: "enabled", forDomain: "https://shop.example.com",
      description: "Shop", createdAt: new Date("2026-10-19T10:00:00Z"),
    });
    expect(queue.submitAction).not.toHaveBeenCalled();
    expect(calls).toEqual([["MaskedEmail/set", {
      accountId: "u1",
      create: { m: { state: "enabled", forDomain: "https://shop.example.com", description: "Shop", emailPrefix: "shop" } },
    }, "c1"]]);
  });

  it("rejects an invalid prefix or domain before calling Fastmail", async () => {
    const { session, calls } = setup();
    await expect(session.createMaskedEmail({ emailPrefix: "Shop-1" })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(session.createMaskedEmail({ forDomain: "localhost" })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(session.createMaskedEmail({ forDomain: "ftp://example.com" })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    expect(calls).toEqual([]);
  });

  it("queues a deletion that is never auto-approvable, and changes nothing yet", async () => {
    const { session, queue, calls } = setup([
      { id: "m1", email: "a.b@fastmail.com", state: "enabled", forDomain: "https://shop.example.com" },
    ]);
    await session.deleteMaskedEmail("m1");

    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    const description = queue.submitAction.mock.calls[0]![1];
    expect(description).toMatchObject({ title: "Delete Fastmail masked email", implementsRevert: false });
    expect(description).not.toHaveProperty("actionKind");
    expect(description).not.toHaveProperty("autoApprovable");
    expect(JSON.stringify(description)).toContain("a.b@fastmail.com");
    expect(calls.every(([name]) => name === "MaskedEmail/get")).toBe(true);
  });

  it("refuses to delete an unknown or already deleted address", async () => {
    const { session, queue } = setup([{ id: "gone", email: "g@fastmail.com", state: "deleted" }]);
    await expect(session.deleteMaskedEmail("gone")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(session.deleteMaskedEmail("nope")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(queue.submitAction).not.toHaveBeenCalled();
  });

  it("lists addresses without the deleted ones", async () => {
    const { session } = setup([
      { id: "m1", email: "a@fastmail.com", state: "enabled" },
      { id: "m2", email: "b@fastmail.com", state: "deleted" },
    ]);
    expect((await session.listMaskedEmails()).map(m => m.id)).toEqual(["m1"]);
  });

  it("is refused on a narrowed binding", async () => {
    const { session, calls } = setup([], new ScopeGuard({ kind: "folder", folderId: "f1" }));
    await expect(session.createMaskedEmail()).rejects.toMatchObject({ code: "SUBMISSION_NOT_AUTHORIZED" });
    await expect(session.deleteMaskedEmail("m1")).rejects.toMatchObject({ code: "SUBMISSION_NOT_AUTHORIZED" });
    expect(calls).toEqual([]);
  });

  it("applies a deletion by setting the state, treating a vanished address as done", async () => {
    const calls = stubJmap([{ id: "m1", email: "a@fastmail.com", state: "enabled" }]);
    await deleteMaskedEmail("https://api/", "token", "u1", "m1");
    await deleteMaskedEmail("https://api/", "token", "u1", "missing");
    expect(calls[0]).toEqual(["MaskedEmail/set", { accountId: "u1", update: { m1: { state: "deleted" } } }, "c1"]);
  });
});
