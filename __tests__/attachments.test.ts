import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAttachmentGarbage,
  MAX_ATTACHMENT_BYTES,
  prepareAttachments,
  uploadAttachments,
} from "../src/attachments";
import { setPendingAction, putDraftRecord } from "../src/cache";
import { FastmailError } from "../src/errors";
import { FastmailSessionImpl } from "../src/fastmail";
import { sendEmail } from "../src/fastmail-api";
import { ScopeGuard } from "../src/scope";

const GRANT = {
  apiToken: "token", apiUrl: "https://api/", downloadUrlTemplate: "",
  uploadUrlTemplate: "https://api.fastmail.com/jmap/upload/{accountId}/",
  accountId: "u1", hasSubmission: true, identityEmail: "me@fastmail.com", username: "me@fastmail.com",
};

/** A Durable Object KV stand-in that stores values as given and can list by prefix. */
function makeKv() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string) => store.get(key) as T | undefined,
    put: (key: string, value: unknown) => void store.set(key, value),
    delete: (key: string) => store.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...store].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

function bytes(size: number, seed = 1): ArrayBuffer {
  const content = new Uint8Array(size);
  for (let i = 0; i < size; i++) content[i] = (i * 31 + seed) & 0xff;
  return content.buffer;
}

async function sha256Hex(content: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", content))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const INVOICE = {
  id: "e1", threadId: "t1", mailboxIds: { receipts: true }, keywords: {}, messageId: ["m1@x"],
  from: [{ email: "billing@example.com", name: "Billing" }], to: [], cc: [], subject: "Invoice 42",
  receivedAt: "2026-10-01T10:00:00Z", preview: "", textBody: [], htmlBody: [], bodyValues: {},
  attachments: [{ blobId: "Gblob1", type: "application/pdf", name: "invoice-42.pdf", size: 2048 }],
};

function stubMailbox() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, any, string][] };
    return new Response(JSON.stringify({
      methodResponses: methodCalls.map(([name, args, id]) =>
        [name, { list: (args.ids as string[]).includes("e1") ? [INVOICE] : [] }, id]),
    }));
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareAttachments", () => {
  it("stores new content once, in chunks, under its SHA-256", async () => {
    const kv = makeKv();
    const content = bytes(1_200_000);
    const refs = await prepareAttachments(
      [{ filename: " report\n2026.pdf ", mimeType: "Application/PDF", content }],
      { kv, grant: GRANT, guard: new ScopeGuard() });
    const sha256 = await sha256Hex(content);
    expect(refs).toEqual([{ kind: "new", filename: "report 2026.pdf", mimeType: "application/pdf", size: 1_200_000, sha256 }]);
    expect(kv.get(`attmeta:${sha256}`)).toEqual({ size: 1_200_000, chunks: 3 });
    // The same content again stores nothing new.
    const before = kv.store.size;
    await prepareAttachments([{ filename: "copy.pdf", mimeType: "application/pdf", content }],
      { kv, grant: GRANT, guard: new ScopeGuard() });
    expect(kv.store.size).toBe(before);
  });

  it("refuses bad attachments without storing anything", async () => {
    const ctx = { kv: makeKv(), grant: GRANT, guard: new ScopeGuard() };
    const ok = { filename: "a.txt", mimeType: "text/plain", content: bytes(10) };
    for (const input of [
      [{ ...ok, mimeType: "text" }],
      [{ ...ok, filename: "  " }],
      [{ ...ok, filename: "x".repeat(300) }],
      Array.from({ length: 21 }, () => ok),
      [{ ...ok, content: bytes(MAX_ATTACHMENT_BYTES - 5) }, { ...ok, content: bytes(10, 2) }],
      [{ fromMessageId: "e1", blobId: "../x" }],
    ]) {
      await expect(prepareAttachments(input as any, ctx)).rejects.toThrow(FastmailError);
    }
    expect(ctx.kv.store.size).toBe(0);
  });

  it("re-attaches an attachment of a message in scope, without storing it", async () => {
    stubMailbox();
    const kv = makeKv();
    const refs = await prepareAttachments([{ fromMessageId: "e1", blobId: "Gblob1" }],
      { kv, grant: GRANT, guard: new ScopeGuard({ kind: "folder", folderId: "receipts" }) });
    expect(refs).toEqual([{
      kind: "existing", filename: "invoice-42.pdf", mimeType: "application/pdf", size: 2048,
      blobId: "Gblob1", fromEmailId: "e1", source: "2026-10-01 · Billing · Invoice 42",
    }]);
    expect(kv.store.size).toBe(0);
  });

  it("refuses an attachment of a message outside the scope, or a blob not on that message", async () => {
    stubMailbox();
    const outside = { kv: makeKv(), grant: GRANT, guard: new ScopeGuard({ kind: "folder", folderId: "private" }) };
    await expect(prepareAttachments([{ fromMessageId: "e1", blobId: "Gblob1" }], outside)).rejects.toThrow(/not found/);
    const inside = { kv: makeKv(), grant: GRANT, guard: new ScopeGuard() };
    await expect(prepareAttachments([{ fromMessageId: "e1", blobId: "Gother" }], inside))
      .rejects.toThrow(/does not belong/);
    await expect(prepareAttachments([{ fromMessageId: "e404", blobId: "Gblob1" }], inside)).rejects.toThrow(/not found/);
  });
});

describe("uploadAttachments", () => {
  it("uploads stored content as it was, and references existing blobs directly", async () => {
    const kv = makeKv();
    const content = bytes(700_000, 7);
    const refs = await prepareAttachments([{ filename: "photo.jpg", mimeType: "image/jpeg", content }],
      { kv, grant: GRANT, guard: new ScopeGuard() });
    const uploads: { url: string; type: string | null; body: Uint8Array }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const body = new Uint8Array(init.body as Uint8Array);
      uploads.push({ url, type: new Headers(init.headers).get("Content-Type"), body });
      return new Response(JSON.stringify({ blobId: "Gnew", size: body.byteLength, type: "image/jpeg" }));
    });
    const blobs = await uploadAttachments(kv, GRANT, [
      ...refs!,
      { kind: "existing", filename: "invoice.pdf", mimeType: "application/pdf", size: 1, blobId: "Gold", fromEmailId: "e1", source: "" },
    ], fetchImpl as any);
    expect(blobs).toEqual([
      { blobId: "Gnew", type: "image/jpeg", name: "photo.jpg" },
      { blobId: "Gold", type: "application/pdf", name: "invoice.pdf" },
    ]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe("https://api.fastmail.com/jmap/upload/u1/");
    expect(uploads[0].type).toBe("image/jpeg");
    expect(await sha256Hex(uploads[0].body.buffer as ArrayBuffer)).toBe(await sha256Hex(content));
  });

  it("puts the blobs on the sent Email as attachments", async () => {
    let created: any;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { methodCalls } = JSON.parse(init.body as string);
      created = methodCalls[0][1].create.draft1;
      return new Response(JSON.stringify({ methodResponses: [
        ["Email/set", { created: { draft1: { id: "E1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "S1" } } }, "c2"],
      ] }));
    });
    await sendEmail("https://api/", "t", "u1", {
      from: "me@fastmail.com", to: [{ email: "a@example.com" }], subject: "s", textBody: "x",
      attachmentBlobs: [{ blobId: "Gnew", type: "image/jpeg", name: "photo.jpg" }],
    }, { draftsMailboxId: "d", identityId: "i" }, fetchImpl as any);
    expect(created.attachments).toEqual([{ blobId: "Gnew", type: "image/jpeg", name: "photo.jpg", disposition: "attachment" }]);
  });
});

describe("collectAttachmentGarbage", () => {
  it("keeps content a pending send or draft references, and deletes the rest", async () => {
    const kv = makeKv();
    const ctx = { kv, grant: GRANT, guard: new ScopeGuard() };
    const [sent] = (await prepareAttachments([{ filename: "a.txt", mimeType: "text/plain", content: bytes(10, 1) }], ctx))!;
    const [drafted] = (await prepareAttachments([{ filename: "b.txt", mimeType: "text/plain", content: bytes(10, 2) }], ctx))!;
    const [orphan] = (await prepareAttachments([{ filename: "c.txt", mimeType: "text/plain", content: bytes(10, 3) }], ctx))!;
    setPendingAction(kv, 1, { kind: "send", params: { from: "me", to: [], subject: "", attachments: [sent] } });
    putDraftRecord(kv, {
      id: "d1", pending: { 2: { kind: "content", content: { to: [], subject: "", attachments: [drafted] }, at: 0 } },
    });
    collectAttachmentGarbage(kv);
    const sha = (ref: typeof sent) => (ref as { sha256: string }).sha256;
    expect(kv.get(`attmeta:${sha(sent)}`)).toBeDefined();
    expect(kv.get(`attmeta:${sha(drafted)}`)).toBeDefined();
    expect(kv.get(`attmeta:${sha(orphan)}`)).toBeUndefined();
    expect(kv.get(`attchunk:${sha(orphan)}:0`)).toBeUndefined();
  });
});

describe("sending with attachments", () => {
  it("records the attachment and shows its name, size and SHA-256 for approval", async () => {
    const queue = {
      submitAction: vi.fn(async (_id: number, _description: any) => {}),
      authorizeObservation: vi.fn(async () => {}),
      dup: () => queue,
      [Symbol.dispose]: () => {},
    };
    const kv = makeKv();
    const account = { getGrant: async () => GRANT, noteCredentialsExpired: async () => {} };
    const session = new FastmailSessionImpl(queue as any, account as any, kv as any, {} as Ai);
    const content = bytes(3000);
    await session.send([{ email: "a@example.com" }], "Report", { text: "See attached." },
      { attachments: [{ filename: "report.pdf", mimeType: "application/pdf", content }] });
    const description = JSON.stringify(queue.submitAction.mock.calls[0][1]);
    expect(description).toContain("report.pdf");
    expect(description).toContain("2.9 KiB");
    expect(description).toContain(await sha256Hex(content));
  });

  it("still refuses new drafts on a narrowed binding, attachments or not", async () => {
    stubMailbox();
    const queue = { submitAction: vi.fn(), authorizeObservation: vi.fn(async () => {}), dup: () => queue, [Symbol.dispose]: () => {} };
    const account = { getGrant: async () => GRANT, noteCredentialsExpired: async () => {} };
    const session = new FastmailSessionImpl(queue as any, account as any, makeKv() as any, {} as Ai, undefined,
      new ScopeGuard({ kind: "folder", folderId: "private" }));
    await expect(session.createDraft({ attachments: [{ fromMessageId: "e1", blobId: "Gblob1" }] }))
      .rejects.toThrow(/one folder/);
  });
});
