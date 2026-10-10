import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDraftRevision } from "../src/drafts";
import { putDraftRecord, getPendingAction } from "../src/cache";
import { FastmailSessionImpl } from "../src/fastmail";

const GRANT = {
  apiToken: "token", apiUrl: "https://api/", downloadUrlTemplate: "",
  uploadUrlTemplate: "https://api.fastmail.com/jmap/upload/{accountId}/",
  accountId: "u1", hasSubmission: true, identityEmail: "me@fastmail.com", username: "me@fastmail.com",
};

const HTML_ORIGINAL = {
  id: "e1", threadId: "t1", mailboxIds: { inbox: true }, keywords: {}, messageId: ["m1@x"],
  from: [{ email: "billing@example.com", name: "Billing" }], to: [{ email: "me@fastmail.com" }], cc: [],
  subject: "Invoice 42", receivedAt: "2026-10-01T10:00:05Z", sentAt: "2026-10-01T10:00:00Z", preview: "Your invoice",
  textBody: [{ partId: "1", type: "text/plain" }], htmlBody: [{ partId: "2", type: "text/html" }],
  bodyValues: {
    "1": { value: "Your invoice is attached." },
    "2": { value: '<html><head><style>p{}</style></head><body><p>Your <b>invoice</b> is attached.</p><img src="cid:logo@x"></body></html>' },
  },
  attachments: [
    { blobId: "Gpdf", type: "application/pdf", name: "invoice-42.pdf", size: 2048, disposition: "attachment", cid: null },
    { blobId: "Glogo", type: "image/png", name: "logo.png", size: 512, disposition: "inline", cid: "<logo@x>" },
  ],
};

/** A text-only message: JMAP's htmlBody falls back to the text/plain part. */
const TEXT_ORIGINAL = {
  ...HTML_ORIGINAL, id: "e2", subject: "Fwd: Notes",
  textBody: [{ partId: "1", type: "text/plain" }], htmlBody: [{ partId: "1", type: "text/plain" }],
  bodyValues: { "1": { value: "Plain <notes> & more." } }, attachments: [],
};

function setup(emails: Record<string, any>) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, any, string][] };
    return new Response(JSON.stringify({
      methodResponses: methodCalls.map(([name, args, id]) =>
        [name, { list: (args.ids as string[]).flatMap(emailId => emails[emailId] ? [emails[emailId]] : []) }, id]),
    }));
  }));
  const queue = {
    submitAction: vi.fn(async (_id: number, _description: any) => {}),
    authorizeObservation: vi.fn(async () => {}),
    dup: () => queue,
    [Symbol.dispose]: () => {},
  };
  const store = new Map<string, unknown>();
  const kv = {
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => void store.set(key, value),
    delete: (key: string) => store.delete(key),
  };
  const account = { getGrant: async () => GRANT, noteCredentialsExpired: async () => {} };
  const session = new FastmailSessionImpl(queue as any, account as any, kv as any, {} as Ai);
  return { session, queue, kv };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forward()", () => {
  it("quotes the original, keeps its attachments, and marks what it forwards", async () => {
    const { session, queue, kv } = setup({ e1: HTML_ORIGINAL });
    await (await session.getMessage("e1")).forward(
      [{ email: "accountant@example.com" }], { text: "For the books." }, { cc: [{ email: "partner@example.com" }] });
    const pending = getPendingAction(kv as any, 1) as any;
    expect(pending.forwardsEmailId).toBe("e1");
    const { params } = pending;
    expect(params).toMatchObject({
      from: "me@fastmail.com",
      to: [{ email: "accountant@example.com" }],
      cc: [{ email: "partner@example.com" }],
      subject: "Fwd: Invoice 42",
    });
    expect(params.inReplyTo).toBeUndefined();
    expect(params.textBody).toBe(
      "For the books.\n\n---------- Forwarded message ----------\n" +
      "From: Billing <billing@example.com>\nDate: Thu, 01 Oct 2026 10:00:00 GMT\nSubject: Invoice 42\n" +
      "To: me@fastmail.com\n\nYour invoice is attached.");
    expect(params.htmlBody).toContain("<p>For the books.</p>");
    expect(params.htmlBody).toContain("From: Billing &lt;billing@example.com&gt;");
    expect(params.htmlBody).toContain('<blockquote type="cite"');
    expect(params.htmlBody).toContain("<p>Your <b>invoice</b> is attached.</p>");
    expect(params.htmlBody).not.toContain("<head>");
    expect(params.attachments).toEqual([
      expect.objectContaining({ kind: "existing", blobId: "Gpdf", filename: "invoice-42.pdf", fromEmailId: "e1" }),
      expect.objectContaining({ kind: "existing", blobId: "Glogo", cid: "logo@x" }),
    ]);
    expect(params.attachments[0].cid).toBeUndefined();
    const [, description] = queue.submitAction.mock.calls[0];
    expect(description.title).toBe("Forward email");
    expect(JSON.stringify(description)).toContain("invoice-42.pdf");
  });

  it("leaves the attachments out on request, and doesn't take a text part for HTML", async () => {
    const { session, kv } = setup({ e2: TEXT_ORIGINAL, e1: HTML_ORIGINAL });
    await (await session.getMessage("e1")).forward([{ email: "a@example.com" }], undefined, { includeAttachments: false });
    expect((getPendingAction(kv as any, 1) as any).params.attachments).toBeUndefined();

    await (await session.getMessage("e2")).forward([{ email: "a@example.com" }]);
    const { params } = getPendingAction(kv as any, 2) as any;
    expect(params.subject).toBe("Fwd: Notes");
    expect(params.textBody).toBe(
      "---------- Forwarded message ----------\nFrom: Billing <billing@example.com>\n" +
      "Date: Thu, 01 Oct 2026 10:00:00 GMT\nSubject: Fwd: Notes\nTo: me@fastmail.com\n\nPlain <notes> & more.");
    // No HTML of its own: the plain text is what gets sent, with the usual derived HTML.
    expect(params.htmlBody).toBeUndefined();
  });

  it("tells an inline image apart from an attachment when reading", async () => {
    const { session } = setup({ e1: HTML_ORIGINAL });
    const message = await (await session.getMessage("e1")).read();
    expect(message.attachments).toEqual([
      { filename: "invoice-42.pdf", mimeType: "application/pdf", size: 2048, blobId: "Gpdf", inline: false },
      { filename: "logo.png", mimeType: "image/png", size: 512, blobId: "Glogo", inline: true, cid: "logo@x" },
    ]);
  });

  it("needs a recipient", async () => {
    const { session } = setup({ e1: HTML_ORIGINAL });
    await expect((await session.getMessage("e1")).forward([])).rejects.toThrow(/recipient/);
  });

  it("explains that the original's attachments count towards the limit", async () => {
    const big = { ...HTML_ORIGINAL, attachments: [{ ...HTML_ORIGINAL.attachments[0], size: 11 * 1024 * 1024 }] };
    const { session } = setup({ e1: big });
    await expect((await session.getMessage("e1")).forward([{ email: "a@example.com" }]))
      .rejects.toThrow(/includeAttachments: false/);
  });

  it("saves a forward draft", async () => {
    const { session } = setup({ e1: HTML_ORIGINAL });
    const draft = await (await session.getMessage("e1")).createForwardDraft([{ email: "a@example.com" }]);
    const info = await draft.getMetadata();
    expect(info).toMatchObject({ subject: "Fwd: Invoice 42", isForward: true, isReply: false });
    expect(info.attachments.map(attachment => attachment.filename)).toEqual(["invoice-42.pdf", "logo.png"]);
  });
});

describe("sending a forward draft", () => {
  it("marks the original $forwarded once sent, and keeps inline images inline", async () => {
    const calls: [string, any][] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, any, string][] };
      calls.push(...methodCalls.map(([name, args]) => [name, args] as [string, any]));
      return new Response(JSON.stringify({ methodResponses: methodCalls.map(([name, , id]) => {
        if (name === "Mailbox/get") return [name, { list: [{ id: "d", role: "drafts" }] }, id];
        if (name === "Identity/get") return [name, { list: [{ id: "i", email: "me@fastmail.com" }] }, id];
        if (name === "Email/set") return [name, { created: { draft1: { id: "E9" } }, updated: { e1: null } }, id];
        return [name, { created: { submission1: { id: "S1" } } }, id];
      }) }));
    });
    const store = new Map<string, unknown>();
    const kv = { get: (k: string) => store.get(k), put: (k: string, v: unknown) => void store.set(k, v), delete: (k: string) => store.delete(k) };
    putDraftRecord(kv as any, {
      id: "d1", from: "me@fastmail.com", forwardsEmailId: "e1",
      pending: { 5: { kind: "sent", at: 1, params: {
        from: "me@fastmail.com", to: [{ email: "a@example.com" }], subject: "Fwd: x", textBody: "x",
        attachments: [{ kind: "existing", filename: "logo.png", mimeType: "image/png", size: 1, blobId: "Glogo", fromEmailId: "e1", source: "", cid: "logo@x" }],
      } } },
    });
    await applyDraftRevision(kv as any, 5, "d1", GRANT, fetchImpl as any);
    const created = calls.find(([name, args]) => name === "Email/set" && args.create)![1].create.draft1;
    expect(created.attachments).toEqual([{ blobId: "Glogo", type: "image/png", name: "logo.png", disposition: "inline", cid: "logo@x" }]);
    expect(calls.some(([name, args]) => name === "Email/set" && args.update?.e1?.["keywords/$forwarded"] === true)).toBe(true);
  });
});
