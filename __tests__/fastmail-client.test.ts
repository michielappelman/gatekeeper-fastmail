import { describe, expect, it, vi } from "vitest";
import { FastmailError } from "../src/errors";
import {
  fetchAccountInfo,
  fetchIdentityEmail,
  getReplySource,
  listMailboxes,
  queryThreadPage,
  replyRecipients,
  resolveSendContext,
  sendEmail,
  textToHtml,
  updateEmails,
} from "../src/fastmail-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

describe("fetchAccountInfo", () => {
  it("resolves account info from a live session response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
      uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
      accounts: {
        u1: { accountCapabilities: { "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} } },
      },
      primaryAccounts: { "urn:ietf:params:jmap:mail": "u1" },
    }));
    const info = await fetchAccountInfo("token123", fetchImpl);
    expect(info.accountId).toBe("u1");
    expect(info.hasSubmission).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.fastmail.com/jmap/session",
      expect.objectContaining({ headers: { Authorization: "Bearer token123" } }));
  });

  it("reports no submission scope when the account capability is absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      downloadUrl: "https://api.fastmail.com/jmap/download/",
      uploadUrl: "https://api.fastmail.com/jmap/upload/",
      accounts: { u1: { accountCapabilities: { "urn:ietf:params:jmap:mail": {} } } },
      primaryAccounts: { "urn:ietf:params:jmap:mail": "u1" },
    }));
    const info = await fetchAccountInfo("token", fetchImpl);
    expect(info.hasSubmission).toBe(false);
  });

  it("throws AUTH_EXPIRED on a 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    await expect(fetchAccountInfo("bad-token", fetchImpl)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("throws AUTH_REQUIRED when the token has no Mail access", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      apiUrl: "x", downloadUrl: "x", uploadUrl: "x", accounts: {}, primaryAccounts: {},
    }));
    await expect(fetchAccountInfo("token", fetchImpl)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("fetchIdentityEmail", () => {
  it("returns the first identity's email", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [["Identity/get", { list: [{ email: "me@fastmail.com" }] }, "c1"]],
    }));
    const email = await fetchIdentityEmail("https://api.fastmail.com/jmap/api/", "token", "u1", fetchImpl);
    expect(email).toBe("me@fastmail.com");
  });
});

describe("listMailboxes", () => {
  it("returns the mailbox list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [["Mailbox/get", {
        list: [{ id: "f1", name: "Inbox", parentId: null, role: "inbox", totalEmails: 1, unreadEmails: 1 }],
      }, "c1"]],
    }));
    const mailboxes = await listMailboxes("https://api/", "token", "u1", false, fetchImpl);
    expect(mailboxes).toHaveLength(1);
    expect(mailboxes[0]?.name).toBe("Inbox");
  });
});

describe("queryThreadPage", () => {
  it("combines Email/query and Email/get into ordered thread entries", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [["Email/query", { ids: ["e2", "e1"] }, "c1"]] }))
      .mockResolvedValueOnce(jsonResponse({
        methodResponses: [["Email/get", {
          list: [
            { id: "e1", threadId: "t1", subject: "First", from: [], receivedAt: "2026-01-01T00:00:00Z", preview: "a", keywords: {} },
            { id: "e2", threadId: "t2", subject: "Second", from: [], receivedAt: "2026-01-02T00:00:00Z", preview: "b", keywords: {} },
          ],
        }, "c1"]],
      }));
    const page = await queryThreadPage("https://api/", "token", "u1", false, undefined, 0, 25, fetchImpl);
    // Email/get does not promise to preserve request order; the client must restore it.
    expect(page.map(entry => entry.id)).toEqual(["e2", "e1"]);
  });

  it("returns an empty page without a second call when the query has no matches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ methodResponses: [["Email/query", { ids: [] }, "c1"]] }));
    const page = await queryThreadPage("https://api/", "token", "u1", false, { text: "nothing" }, 0, 25, fetchImpl);
    expect(page).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("updateEmails", () => {
  it("applies the same patch to every listed email id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ methodResponses: [["Email/set", { updated: { e1: {}, e2: {} } }, "c1"]] }));
    await updateEmails("https://api/", "token", "u1", false, ["e1", "e2"], { "keywords/$flagged": true }, fetchImpl);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.methodCalls[0][1].update).toEqual({
      e1: { "keywords/$flagged": true }, e2: { "keywords/$flagged": true },
    });
  });

  it("throws when Fastmail rejects one of the updates", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [["Email/set", { notUpdated: { e1: { type: "notFound" } } }, "c1"]],
    }));
    await expect(updateEmails("https://api/", "token", "u1", false, ["e1"], {}, fetchImpl))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("textToHtml", () => {
  it("wraps a single line in one paragraph", () => {
    expect(textToHtml("Hello there")).toContain("<p>Hello there</p>");
  });

  it("splits blank-line-separated text into separate paragraphs", () => {
    const html = textToHtml("First paragraph.\n\nSecond paragraph.");
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });

  it("turns a single line break within a paragraph into <br>, preserving line-wrapped structure", () => {
    const html = textToHtml("- item one\n- item two");
    expect(html).toContain("<p>- item one<br>- item two</p>");
  });

  it("escapes HTML special characters", () => {
    const html = textToHtml("Tom & Jerry <script>alert(1)</script>");
    expect(html).toContain("Tom &amp; Jerry &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("preserves accented characters and currency symbols unmodified", () => {
    expect(textToHtml("véén dag, € 112,50")).toContain("véén dag, € 112,50");
  });
});

const SEND_CONTEXT = { draftsMailboxId: "mb-drafts", sentMailboxId: "mb-sent", identityId: "id1" };

function requestBody(fetchImpl: ReturnType<typeof vi.fn>): any {
  return JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
}

describe("sendEmail", () => {
  it("returns the created draft's id on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    const result = await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi", textBody: "Hello",
    }, SEND_CONTEXT, fetchImpl);
    expect(result).toEqual({ emailId: "msg1" });
  });

  it("creates the draft in Drafts, submits with an identity, and moves it to Sent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi", textBody: "Hello",
    }, SEND_CONTEXT, fetchImpl);

    const [[, emailSet], [, submissionSet]] = requestBody(fetchImpl).methodCalls;
    expect(emailSet.create.draft1.mailboxIds).toEqual({ "mb-drafts": true });
    expect(submissionSet.create.submission1).toEqual({ emailId: "#draft1", identityId: "id1" });
    expect(submissionSet.onSuccessUpdateEmail).toEqual({
      "#submission1": {
        "keywords/$draft": null,
        "mailboxIds/mb-drafts": null,
        "mailboxIds/mb-sent": true,
      },
    });
    expect(submissionSet.onSuccessDestroyEmail).toBeUndefined();
  });

  it("only clears $draft when the account has no Sent mailbox", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi",
    }, { draftsMailboxId: "mb-drafts", identityId: "id1" }, fetchImpl);
    const [, [, submissionSet]] = requestBody(fetchImpl).methodCalls;
    expect(submissionSet.onSuccessUpdateEmail).toEqual({ "#submission1": { "keywords/$draft": null } });
  });

  it("throws SUBMISSION_NOT_AUTHORIZED when the token lacks submission scope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { notCreated: { submission1: { type: "forbidden" } } }, "c2"],
      ],
    }));
    await expect(sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi",
    }, SEND_CONTEXT, fetchImpl)).rejects.toMatchObject({ code: "SUBMISSION_NOT_AUTHORIZED" });
  });

  it("derives an html body when only textBody is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi", textBody: "Hello",
    }, SEND_CONTEXT, fetchImpl);

    const [[, emailSet]] = requestBody(fetchImpl).methodCalls;
    const draft = emailSet.create.draft1;
    expect(draft.bodyValues.text).toEqual({ value: "Hello" });
    expect(draft.bodyValues.html.value).toContain("<p>Hello</p>");
    expect(draft.textBody).toEqual([{ partId: "text", type: "text/plain" }]);
    expect(draft.htmlBody).toEqual([{ partId: "html", type: "text/html" }]);
  });

  it("does not derive an html body when neither textBody nor htmlBody is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi",
    }, SEND_CONTEXT, fetchImpl);

    const [[, emailSet]] = requestBody(fetchImpl).methodCalls;
    expect(emailSet.create.draft1.htmlBody).toBeUndefined();
    expect(emailSet.create.draft1.bodyValues.html).toBeUndefined();
  });

  it("passes an explicit htmlBody through unchanged rather than deriving one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg1" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi",
      textBody: "Hello", htmlBody: "<strong>Hello</strong>",
    }, SEND_CONTEXT, fetchImpl);

    const [[, emailSet]] = requestBody(fetchImpl).methodCalls;
    expect(emailSet.create.draft1.bodyValues.html).toEqual({ value: "<strong>Hello</strong>" });
  });

  it("throws on a method-level error response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["error", { type: "invalidArguments", description: "bad create" }, "c1"],
        ["error", { type: "invalidResultReference" }, "c2"],
      ],
    }));
    await expect(sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@example.com" }], subject: "Hi",
    }, SEND_CONTEXT, fetchImpl)).rejects.toMatchObject({
      code: "INVALID_RESOURCE", message: expect.stringContaining("bad create"),
    });
  });
});

describe("sendEmail threading headers", () => {
  it("sets inReplyTo and references on a reply's draft", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Email/set", { created: { draft1: { id: "msg2" } } }, "c1"],
        ["EmailSubmission/set", { created: { submission1: { id: "sub1" } } }, "c2"],
      ],
    }));
    await sendEmail("https://api/", "token", "u1", {
      from: "me@fastmail.com", to: [{ email: "you@gmail.com" }], subject: "Re: Hi", textBody: "Yes",
      inReplyTo: ["orig@mail.gmail.com"], references: ["root@x", "orig@mail.gmail.com"],
    }, SEND_CONTEXT, fetchImpl);
    const [[, emailSet]] = requestBody(fetchImpl).methodCalls;
    expect(emailSet.create.draft1.inReplyTo).toEqual(["orig@mail.gmail.com"]);
    expect(emailSet.create.draft1.references).toEqual(["root@x", "orig@mail.gmail.com"]);
  });
});

describe("getReplySource", () => {
  it("returns the most recent message with its threading headers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      methodResponses: [["Email/get", {
        list: [
          { id: "e2", messageId: ["b@x"], receivedAt: "2026-09-19T12:00:00Z" },
          { id: "e1", messageId: ["a@x"], receivedAt: "2026-09-18T12:00:00Z" },
        ],
      }, "c1"]],
    }));
    const source = await getReplySource("https://api/", "token", "u1", true, ["e1", "e2"], fetchImpl);
    expect(source?.id).toBe("e2");
    expect(requestBody(fetchImpl).methodCalls[0][1].properties)
      .toEqual(expect.arrayContaining(["messageId", "references", "replyTo"]));
  });
});

describe("replyRecipients", () => {
  const base = { id: "e1", messageId: ["a@x"], references: null, subject: "Hi", receivedAt: "" };

  it("replies to the sender, preferring Reply-To", () => {
    expect(replyRecipients({
      ...base, from: [{ email: "you@gmail.com", name: "You" }], replyTo: [{ email: "list@x.org" }],
      to: [{ email: "me@fastmail.com" }], cc: null,
    }, "me@fastmail.com", false)).toEqual({ to: [{ email: "list@x.org", name: undefined }], cc: [] });
  });

  it("reply-all adds other To/Cc recipients but never yourself", () => {
    expect(replyRecipients({
      ...base, from: [{ email: "you@gmail.com" }], replyTo: null,
      to: [{ email: "ME@fastmail.com" }, { email: "bob@x" }], cc: [{ email: "you@gmail.com" }, { email: "c@x" }],
    }, "me@fastmail.com", true)).toEqual({
      to: [{ email: "you@gmail.com", name: undefined }],
      cc: [{ email: "bob@x", name: undefined }, { email: "c@x", name: undefined }],
    });
  });

  it("continues to the original recipients when the latest message is your own", () => {
    expect(replyRecipients({
      ...base, from: [{ email: "me@fastmail.com" }], replyTo: null,
      to: [{ email: "you@gmail.com" }], cc: null,
    }, "me@fastmail.com", false)).toEqual({ to: [{ email: "you@gmail.com", name: undefined }], cc: [] });
  });
});

describe("resolveSendContext", () => {
  function contextResponse(identities: { id: string; email: string }[], roles = ["inbox", "drafts", "sent"]) {
    return vi.fn(async () => jsonResponse({
      methodResponses: [
        ["Mailbox/get", { list: roles.map(role => ({ id: `mb-${role}`, role })) }, "c1"],
        ["Identity/get", { list: identities }, "c2"],
      ],
    }));
  }

  it("resolves Drafts, Sent, and the identity matching the sender", async () => {
    const fetchImpl = contextResponse([
      { id: "id-other", email: "alias@example.com" },
      { id: "id-me", email: "Me@Fastmail.com" },
    ]);
    await expect(resolveSendContext("https://api/", "token", "u1", "me@fastmail.com", fetchImpl))
      .resolves.toEqual({ draftsMailboxId: "mb-drafts", sentMailboxId: "mb-sent", identityId: "id-me" });
  });

  it("falls back to the first identity when none matches", async () => {
    const fetchImpl = contextResponse([{ id: "id-first", email: "alias@example.com" }]);
    await expect(resolveSendContext("https://api/", "token", "u1", "me@fastmail.com", fetchImpl))
      .resolves.toMatchObject({ identityId: "id-first" });
  });

  it("throws when the account has no Drafts mailbox", async () => {
    const fetchImpl = contextResponse([{ id: "id-me", email: "me@fastmail.com" }], ["inbox"]);
    await expect(resolveSendContext("https://api/", "token", "u1", "me@fastmail.com", fetchImpl))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("throws when the account has no identity", async () => {
    const fetchImpl = contextResponse([]);
    await expect(resolveSendContext("https://api/", "token", "u1", "me@fastmail.com", fetchImpl))
      .rejects.toMatchObject({ code: "SUBMISSION_NOT_AUTHORIZED" });
  });
});

describe("FastmailError", () => {
  it("is thrown, not a raw Response, on transport failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    await expect(fetchAccountInfo("token", fetchImpl)).rejects.toBeInstanceOf(FastmailError);
  });
});
