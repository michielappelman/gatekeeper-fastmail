/**
 * Direct JMAP (RFC 8620/8621) client for Fastmail. No SDK exists for this; every call is a plain
 * `fetch()` POST of a JMAP request object, matching how Fastmail's JMAP API is documented at
 * https://www.fastmail.com/dev/ (see `./fastmail-types.ts`'s header on re-verifying specifics).
 *
 * Every function here throws `FastmailError`, never a raw `Response` or JMAP method-error object.
 */

import { errorForStatus, FastmailError } from "./errors";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import {
  JMAP_CORE_CAPABILITY,
  JMAP_MAIL_CAPABILITY,
  JMAP_SUBMISSION_CAPABILITY,
  type JmapEmailAddress,
  type JmapEmailObject,
  type JmapMailboxObject,
  type JmapMethodError,
  type JmapRequestBody,
  type JmapResponseBody,
  type JmapSessionResource,
} from "./fastmail-types";

const SESSION_URL = "https://api.fastmail.com/jmap/session";

/** What a live token grants, resolved once at connect time and stored on the `UserAccount`. */
export type FastmailAccountInfo = {
  apiUrl: string;
  downloadUrlTemplate: string;
  uploadUrlTemplate: string;
  accountId: string;
  hasSubmission: boolean;
  identityEmail?: string;
};

/**
 * Fetches the JMAP session resource with the given bearer token and derives this account's mail
 * capabilities. This single call doubles as the connect-flow's "ping": a bad token, or a token with
 * no Mail access, throws before anything is stored.
 */
export async function fetchAccountInfo(
  apiToken: string, fetchImpl: typeof fetch = fetch,
): Promise<FastmailAccountInfo> {
  const res = await fetchImpl(SESSION_URL, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) throw errorForStatus(res.status);

  let session: JmapSessionResource;
  try {
    session = JSON.parse(await readTextCapped(res)) as JmapSessionResource;
  } catch (error) {
    throw new FastmailError(
      "UPSTREAM_UNAVAILABLE", "Fastmail's session response could not be parsed.", { cause: error });
  }

  const accountId = session.primaryAccounts?.[JMAP_MAIL_CAPABILITY];
  if (!accountId) {
    throw new FastmailError("AUTH_REQUIRED", "This Fastmail API token has no Mail access.");
  }
  const accountCapabilities = session.accounts?.[accountId]?.accountCapabilities ?? {};
  const hasSubmission = JMAP_SUBMISSION_CAPABILITY in accountCapabilities;

  return {
    apiUrl: session.apiUrl,
    downloadUrlTemplate: session.downloadUrl,
    uploadUrlTemplate: session.uploadUrl,
    accountId,
    hasSubmission,
  };
}

// ---------------------------------------------------------------------------
// Low-level request plumbing

function methodErrorCode(error: JmapMethodError): FastmailError["code"] {
  switch (error.type) {
    case "accountNotFound":
    case "notFound":
      return "RESOURCE_NOT_FOUND";
    case "forbidden":
    case "accountReadOnly":
      return "SUBMISSION_NOT_AUTHORIZED";
    case "invalidArguments":
    case "invalidResultReference":
    case "unknownMethod":
      return "INVALID_RESOURCE";
    case "requestTooLarge":
    case "tooManyRequests":
    case "limit":
      return "RATE_LIMITED";
    default:
      return "UPSTREAM_UNAVAILABLE";
  }
}

function describeMethodError(error: JmapMethodError): string {
  return `${error.type}${error.description ? ` (${error.description})` : ""}`;
}

/** Sends one JMAP request and returns its parsed body, throwing on a transport failure or an HTTP
 * error status. Method-level errors are left for `methodResult()` to surface per call. */
async function request(
  apiUrl: string, apiToken: string, body: JmapRequestBody, fetchImpl: typeof fetch,
): Promise<JmapResponseBody> {
  const res = await fetchImpl(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw errorForStatus(res.status);

  try {
    return JSON.parse(await readTextCapped(res)) as JmapResponseBody;
  } catch (error) {
    throw new FastmailError(
      "UPSTREAM_UNAVAILABLE", "Fastmail's JMAP response could not be parsed.", { cause: error });
  }
}

/** Returns the result of the method call with `callId`, throwing if it came back as an `error`. */
function methodResult(parsed: JmapResponseBody, callId: string, name: string): Record<string, unknown> {
  const [responseName, result] = parsed.methodResponses?.find(([, , id]) => id === callId) ?? [];
  if (responseName === "error") {
    throw new FastmailError(
      methodErrorCode(result as unknown as JmapMethodError),
      `Fastmail rejected ${name}: ${describeMethodError(result as unknown as JmapMethodError)}.`);
  }
  return result ?? {};
}

/**
 * Sends one JMAP request with a single method call and returns its result, throwing on a
 * transport failure, an HTTP error status, or a method-level `error` response.
 */
async function call(
  apiUrl: string, apiToken: string, using: string[], name: string, args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const parsed = await request(apiUrl, apiToken, { using, methodCalls: [[name, args, "c1"]] }, fetchImpl);
  return methodResult(parsed, "c1", name);
}

function usingFor(hasSubmission: boolean): string[] {
  return hasSubmission
    ? [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY, JMAP_SUBMISSION_CAPABILITY]
    : [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY];
}

// ---------------------------------------------------------------------------
// Identity

/** Fetches the account's own address for use as the `From` on `sendEmail()`. Called once at connect. */
export async function fetchIdentityEmail(
  apiUrl: string, apiToken: string, accountId: string, fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const result = await call(
    apiUrl, apiToken, [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY, JMAP_SUBMISSION_CAPABILITY],
    "Identity/get", { accountId }, fetchImpl);
  const list = (result.list as { email: string }[] | undefined) ?? [];
  return list[0]?.email;
}

// ---------------------------------------------------------------------------
// Mailboxes

export async function listMailboxes(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<JmapMailboxObject[]> {
  const result = await call(
    apiUrl, apiToken, usingFor(hasSubmission), "Mailbox/get", { accountId }, fetchImpl);
  return (result.list as JmapMailboxObject[] | undefined) ?? [];
}

// ---------------------------------------------------------------------------
// Threads / messages

const THREAD_ENTRY_PROPERTIES = ["id", "threadId", "subject", "from", "receivedAt", "preview", "keywords"];

export type RawThreadEntry = {
  id: string;
  threadId: string;
  subject: string | null;
  from: JmapEmailAddress[] | null;
  receivedAt: string;
  preview: string;
  keywords: Record<string, boolean>;
};

/**
 * Fetches one page of thread entries (one email per thread, per JMAP's `collapseThreads`), for
 * `OffsetCursor.fetchPage(offset, limit)`. `filter` narrows by mailbox and/or full-text search.
 */
export async function queryThreadPage(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  filter: { inMailbox?: string; text?: string } | undefined, offset: number, limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RawThreadEntry[]> {
  const using = usingFor(hasSubmission);
  const queryResult = await call(apiUrl, apiToken, using, "Email/query", {
    accountId,
    filter: filter && Object.keys(filter).length > 0 ? filter : undefined,
    sort: [{ property: "receivedAt", isAscending: false }],
    collapseThreads: true,
    position: offset,
    limit,
  }, fetchImpl);
  const ids = (queryResult.ids as string[] | undefined) ?? [];
  if (ids.length === 0) return [];

  const getResult = await call(apiUrl, apiToken, using, "Email/get", {
    accountId,
    ids,
    properties: THREAD_ENTRY_PROPERTIES,
  }, fetchImpl);
  const list = (getResult.list as RawThreadEntry[] | undefined) ?? [];
  // Email/get does not promise to preserve the requested id order.
  const byOrder = new Map(ids.map((id, index) => [id, index]));
  return list.toSorted((a, b) => (byOrder.get(a.id) ?? 0) - (byOrder.get(b.id) ?? 0));
}

/** Fetches one thread's message ids and subject via `Thread/get`. */
export async function getThreadMetadata(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, threadId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ threadId: string; messageIds: string[] }> {
  const result = await call(
    apiUrl, apiToken, usingFor(hasSubmission), "Thread/get", { accountId, ids: [threadId] }, fetchImpl);
  const thread = (result.list as { id: string; emailIds: string[] }[] | undefined)?.[0];
  if (!thread) throw new FastmailError("RESOURCE_NOT_FOUND", `Fastmail thread ${threadId} was not found.`);
  return { threadId: thread.id, messageIds: thread.emailIds };
}

const MESSAGE_PROPERTIES = [
  "id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "subject", "receivedAt", "preview",
  "textBody", "htmlBody", "bodyValues", "attachments",
];

export async function getMessages(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, messageIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<JmapEmailObject[]> {
  if (messageIds.length === 0) return [];
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/get", {
    accountId,
    ids: messageIds,
    properties: MESSAGE_PROPERTIES,
    fetchTextBodyValues: true,
    fetchHTMLBodyValues: true,
  }, fetchImpl);
  return (result.list as JmapEmailObject[] | undefined) ?? [];
}

/** What a reply needs from the message it answers: its threading headers and addressees. */
export type JmapReplySource = Pick<
  JmapEmailObject,
  "id" | "messageId" | "references" | "from" | "to" | "cc" | "replyTo" | "subject" | "receivedAt"
>;

const REPLY_SOURCE_PROPERTIES =
  ["id", "messageId", "references", "from", "to", "cc", "replyTo", "subject", "receivedAt"];

/** Fetches the thread's most recent message (by `receivedAt`) with the headers a reply needs. */
export async function getReplySource(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, messageIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<JmapReplySource | undefined> {
  if (messageIds.length === 0) return undefined;
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/get", {
    accountId, ids: messageIds, properties: REPLY_SOURCE_PROPERTIES,
  }, fetchImpl);
  const list = (result.list as JmapReplySource[] | undefined) ?? [];
  return list.reduce<JmapReplySource | undefined>(
    (latest, email) => !latest || email.receivedAt > latest.receivedAt ? email : latest, undefined);
}

function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Addressees for a reply to `source`, sent from `self`. Replying to your own most recent message
 * continues to its recipients; otherwise it goes to the Reply-To (or From) address. */
export function replyRecipients(
  source: JmapReplySource, self: string, replyAll: boolean,
): { to: JmapEmailAddress[]; cc: JmapEmailAddress[] } {
  const fromSelf = (source.from ?? []).some(address => isSameAddress(address.email, self));
  const primary = fromSelf
    ? source.to ?? []
    : source.replyTo?.length ? source.replyTo : source.from ?? [];
  const seen = new Set([self.toLowerCase()]);
  const pick = (addresses: JmapReplySource["to"]) => (addresses ?? []).filter(address => {
    const key = address.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(address => ({ email: address.email, name: address.name ?? undefined }));
  const to = pick(primary);
  const cc = replyAll ? pick([...(fromSelf ? [] : source.to ?? []), ...source.cc ?? []]) : [];
  return { to, cc };
}

export async function downloadBlob(
  downloadUrlTemplate: string, apiToken: string, accountId: string, blobId: string,
  name: string, mimeType: string, fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const url = downloadUrlTemplate
    .replace("{accountId}", encodeURIComponent(accountId))
    .replace("{blobId}", encodeURIComponent(blobId))
    .replace("{type}", encodeURIComponent(mimeType))
    .replace("{name}", encodeURIComponent(name));
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!res.ok) throw errorForStatus(res.status);
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Mutations

/** Applies the same `Email/set update` patch (a JMAP patch object — whole properties like
 * `mailboxIds`, or `"keywords/<kw>"` fragment paths) to every listed email id in one request. */
export async function updateEmails(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, emailIds: string[],
  patch: Record<string, unknown>, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (emailIds.length === 0) return;
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/set", {
    accountId,
    update: Object.fromEntries(emailIds.map(id => [id, patch])),
  }, fetchImpl);
  const notUpdated = result.notUpdated as Record<string, JmapMethodError> | undefined;
  const failedId = emailIds.find(id => notUpdated?.[id]);
  if (failedId) {
    const failure = notUpdated![failedId];
    throw new FastmailError(
      methodErrorCode(failure), `Fastmail rejected the update to ${failedId}: ${failure.type}.`);
  }
}

export type SendEmailParams = {
  from: string;
  to: JmapEmailAddress[];
  cc?: JmapEmailAddress[];
  bcc?: JmapEmailAddress[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  /** Threading headers for a reply (message ids without angle brackets). */
  inReplyTo?: string[];
  references?: string[];
};

/** The account-specific ids a send needs, resolved at apply time by `resolveSendContext()`. */
export type SendContext = {
  /** The Drafts mailbox the message is created in before submission. */
  draftsMailboxId: string;
  /** The Sent mailbox the message is moved to once submitted, when the account has one. */
  sentMailboxId?: string;
  /** The Identity to submit as — required by `EmailSubmission/set create` (RFC 8621 §7.5). */
  identityId: string;
};

/**
 * Looks up the Drafts/Sent mailboxes and the sending Identity in one JMAP request. The identity is
 * the one whose address matches `from` (case-insensitively), falling back to the account's first.
 */
export async function resolveSendContext(
  apiUrl: string, apiToken: string, accountId: string, from: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendContext> {
  const parsed = await request(apiUrl, apiToken, {
    using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY, JMAP_SUBMISSION_CAPABILITY],
    methodCalls: [
      ["Mailbox/get", { accountId, properties: ["id", "role"] }, "c1"],
      ["Identity/get", { accountId, properties: ["id", "email"] }, "c2"],
    ],
  }, fetchImpl);
  const mailboxes = (methodResult(parsed, "c1", "Mailbox/get").list as
    { id: string; role: string | null }[] | undefined) ?? [];
  const identities = (methodResult(parsed, "c2", "Identity/get").list as
    { id: string; email: string }[] | undefined) ?? [];

  const draftsMailboxId = mailboxes.find(mailbox => mailbox.role === "drafts")?.id;
  if (!draftsMailboxId) {
    throw new FastmailError(
      "RESOURCE_NOT_FOUND", "This Fastmail account has no Drafts mailbox to compose the message in.");
  }
  const identity = identities.find(candidate => candidate.email.toLowerCase() === from.toLowerCase())
    ?? identities[0];
  if (!identity) {
    throw new FastmailError(
      "SUBMISSION_NOT_AUTHORIZED", "This Fastmail account has no sending identity to send from.");
  }
  return {
    draftsMailboxId,
    sentMailboxId: mailboxes.find(mailbox => mailbox.role === "sent")?.id,
    identityId: identity.id,
  };
}

/**
 * Sends a message: creates a draft `Email` in Drafts and an `EmailSubmission` referencing it in one
 * JMAP request, with `onSuccessUpdateEmail` moving the message from Drafts to Sent and clearing
 * `$draft` once the submission succeeds — the sequence Fastmail's own docs describe for sending mail.
 */
export async function sendEmail(
  apiUrl: string, apiToken: string, accountId: string, params: SendEmailParams, context: SendContext,
  fetchImpl: typeof fetch = fetch,
): Promise<{ emailId: string }> {
  const bodyValues: Record<string, { value: string; charset: string }> = {};
  const textBody: { partId: string; type: string }[] = [];
  const htmlBody: { partId: string; type: string }[] = [];
  if (params.textBody !== undefined) {
    bodyValues.text = { value: params.textBody, charset: "utf-8" };
    textBody.push({ partId: "text", type: "text/plain" });
  }
  if (params.htmlBody !== undefined) {
    bodyValues.html = { value: params.htmlBody, charset: "utf-8" };
    htmlBody.push({ partId: "html", type: "text/html" });
  }

  const draftId = "draft1";
  const submissionId = "submission1";
  const onSuccessPatch: Record<string, unknown> = { "keywords/$draft": null };
  if (context.sentMailboxId) {
    onSuccessPatch[`mailboxIds/${context.draftsMailboxId}`] = null;
    onSuccessPatch[`mailboxIds/${context.sentMailboxId}`] = true;
  }
  const parsed = await request(apiUrl, apiToken, {
    using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY, JMAP_SUBMISSION_CAPABILITY],
    methodCalls: [
      ["Email/set", {
        accountId,
        create: {
          [draftId]: {
            mailboxIds: { [context.draftsMailboxId]: true },
            keywords: { "$draft": true, "$seen": true },
            from: [{ email: params.from }],
            to: params.to,
            cc: params.cc,
            bcc: params.bcc,
            subject: params.subject,
            inReplyTo: params.inReplyTo,
            references: params.references,
            bodyValues,
            textBody: textBody.length > 0 ? textBody : undefined,
            htmlBody: htmlBody.length > 0 ? htmlBody : undefined,
          },
        },
      }, "c1"],
      ["EmailSubmission/set", {
        accountId,
        create: {
          [submissionId]: { emailId: `#${draftId}`, identityId: context.identityId },
        },
        onSuccessUpdateEmail: { [`#${submissionId}`]: onSuccessPatch },
      }, "c2"],
    ],
  }, fetchImpl);

  const setResult = methodResult(parsed, "c1", "Email/set");
  const created = (setResult.created as Record<string, { id: string }> | undefined)?.[draftId];
  const notCreated = (setResult.notCreated as Record<string, JmapMethodError> | undefined)?.[draftId];
  if (notCreated) {
    throw new FastmailError(
      methodErrorCode(notCreated), `Fastmail rejected the draft: ${describeMethodError(notCreated)}.`);
  }

  const submissionResult = methodResult(parsed, "c2", "EmailSubmission/set");
  const submissionFailure =
    (submissionResult.notCreated as Record<string, JmapMethodError> | undefined)?.[submissionId];
  if (submissionFailure) {
    if (submissionFailure.type === "forbidden") {
      throw new FastmailError(
        "SUBMISSION_NOT_AUTHORIZED",
        "This Fastmail API token does not grant Email submission — send() is unavailable. " +
        "Create a new token with the Email submission scope to enable sending.");
    }
    throw new FastmailError(
      methodErrorCode(submissionFailure),
      `Fastmail rejected sending: ${describeMethodError(submissionFailure)}.`);
  }

  if (!created) {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report a created draft to send.");
  }
  return { emailId: created.id };
}
