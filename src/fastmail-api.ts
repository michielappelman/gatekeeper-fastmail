/**
 * Direct JMAP (RFC 8620/8621) client for Fastmail. No SDK exists for this; every call is a plain
 * `fetch()` POST of a JMAP request object, matching how Fastmail's JMAP API is documented at
 * https://www.fastmail.com/dev/ (see `./fastmail-types.ts`'s header on re-verifying specifics).
 *
 * Every function here throws `FastmailError`, never a raw `Response` or JMAP method-error object.
 */

import { errorForStatus, FastmailError } from "./errors";
import { escapeHtml } from "@gadgets/gatekeeper-kit/connect-pages";
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
  /** The session's login address: the fallback `From` on drafts when `Identity/get` is unavailable,
   * as it is for a token without Email submission. Absent on grants stored before it was recorded. */
  username?: string;
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
    username: session.username || undefined,
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

/** A JMAP `Email/query` filter: a `FilterCondition` or a `FilterOperator` (RFC 8621 §4.4.1). */
export type JmapFilter = Record<string, unknown>;

/**
 * Fetches one page of thread entries (one email per thread, per JMAP's `collapseThreads`), for
 * `OffsetCursor.fetchPage(offset, limit)`. `filter` narrows by mailbox, search, or a binding's scope.
 */
export async function queryThreadPage(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  filter: JmapFilter | undefined, offset: number, limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RawThreadEntry[]> {
  return queryEmailPage(apiUrl, apiToken, accountId, hasSubmission, filter, offset, limit, true, fetchImpl);
}

/** As `queryThreadPage()`, but one entry per message rather than per thread. */
export async function queryMessagePage(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  filter: JmapFilter | undefined, offset: number, limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RawThreadEntry[]> {
  return queryEmailPage(apiUrl, apiToken, accountId, hasSubmission, filter, offset, limit, false, fetchImpl);
}

async function queryEmailPage(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  filter: JmapFilter | undefined, offset: number, limit: number, collapseThreads: boolean,
  fetchImpl: typeof fetch,
): Promise<RawThreadEntry[]> {
  const using = usingFor(hasSubmission);
  const queryResult = await call(apiUrl, apiToken, using, "Email/query", {
    accountId,
    filter: filter && Object.keys(filter).length > 0 ? filter : undefined,
    sort: [{ property: "receivedAt", isAscending: false }],
    collapseThreads,
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

/** What a binding's scope needs to decide whether it admits an email. */
export type AdmissionInfo = Pick<JmapEmailObject, "id" | "threadId" | "mailboxIds" | "keywords" | "messageId">;

/** Fetches the admission-relevant properties of `emailIds`; ids that don't exist are left out. */
export async function getAdmissionInfo(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, emailIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<AdmissionInfo[]> {
  if (emailIds.length === 0) return [];
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/get", {
    accountId, ids: emailIds, properties: ["id", "threadId", "mailboxIds", "keywords", "messageId"],
  }, fetchImpl);
  return (result.list as AdmissionInfo[] | undefined) ?? [];
}

/**
 * Of `emails`, the ids that match `condition`, decided by Fastmail itself: one `Email/query` for
 * `condition` AND any of the emails' Message-IDs (RFC 8621's `header` filter), keeping only results
 * that are among `emails`. An email with no Message-ID can't be checked, so it never matches.
 */
export async function filterEmailsMatching(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  condition: JmapFilter, emails: Pick<AdmissionInfo, "id" | "messageId">[],
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const candidates = new Set(emails.map(email => email.id));
  const messageIds = [...new Set(emails.flatMap(email => email.messageId ?? []))];
  if (messageIds.length === 0) return new Set();
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/query", {
    accountId,
    filter: {
      operator: "AND",
      conditions: [
        condition,
        { operator: "OR", conditions: messageIds.map(id => ({ header: ["Message-ID", id] })) },
      ],
    },
    // Copies of one message share its Message-ID, so a result may be outside `emails`.
    limit: Math.min(256, Math.max(50, candidates.size * 4)),
  }, fetchImpl);
  return new Set(((result.ids as string[] | undefined) ?? []).filter(id => candidates.has(id)));
}

/** Fetches one email's raw header fields, in message order. */
export async function getEmailHeaders(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, emailId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; value: string }[]> {
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/get", {
    accountId, ids: [emailId], properties: ["id", "headers"],
  }, fetchImpl);
  const email = (result.list as { id: string; headers?: { name: string; value: string }[] }[] | undefined)?.[0];
  if (!email) throw new FastmailError("RESOURCE_NOT_FOUND", `Fastmail email ${emailId} was not found.`);
  return email.headers ?? [];
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
  "id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "subject", "receivedAt", "sentAt", "preview",
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

/**
 * Uploads content to the account's blob store (RFC 8620 §6.1). Unreferenced blobs may be deleted
 * after an hour, so this runs only when an approved draft or send is about to reference it.
 */
export async function uploadBlob(
  uploadUrlTemplate: string, apiToken: string, accountId: string, content: Uint8Array, mimeType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ blobId: string; size: number }> {
  const url = uploadUrlTemplate.replace("{accountId}", encodeURIComponent(accountId));
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": mimeType },
    body: content,
  });
  if (!res.ok) throw errorForStatus(res.status);
  let uploaded: { blobId?: unknown; size?: unknown };
  try {
    uploaded = JSON.parse(await readTextCapped(res)) as typeof uploaded;
  } catch (error) {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail's upload response could not be parsed.", { cause: error });
  }
  if (typeof uploaded.blobId !== "string" || typeof uploaded.size !== "number") {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report the uploaded blob.");
  }
  return { blobId: uploaded.blobId, size: uploaded.size };
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
  /** Attachments, as recorded before approval (see `./attachments.ts`). */
  attachments?: AttachmentRef[];
};

/** An attachment of a pending draft or send. */
export type AttachmentRef =
  /** New content, stored in the binding by SHA-256 until it is uploaded on approval. */
  | { kind: "new"; filename: string; mimeType: string; size: number; sha256: string }
  /** An attachment already in the account: a blob of message `fromEmailId`. `source` names that
   * message for the approver. */
  | {
      kind: "existing"; filename: string; mimeType: string; size: number; blobId: string; fromEmailId: string;
      source: string;
      /** For a forward: the original's inline image, kept inline so the quoted HTML still shows it. */
      cid?: string;
    };

/** An attachment as it goes on the Email, once uploaded. */
export type UploadedBlob = { blobId: string; type: string; name: string; cid?: string };

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
 * Derives a simple HTML alternative from plain text, so a message sent with only `textBody` still
 * renders with normal paragraph spacing in a proportional font instead of a mail client's bland
 * monospace plain-text view. A blank line starts a new paragraph; a single line break within a
 * paragraph becomes `<br>`, preserving line-wrapped structure like a manual bullet list.
 */
export function textToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map(paragraph => escapeHtml(paragraph).replace(/\n/g, "<br>"));
  const body = paragraphs.map(paragraph => `<p>${paragraph}</p>`).join("\n");
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, ` +
    `Arial, sans-serif; font-size: 14px; line-height: 1.5;">\n${body}\n</div>`;
}

/** The content of an Email to create in Drafts: the fields `sendEmail()` and `writeDraft()` share.
 * `from` is optional only for a draft, whose sender Fastmail fills in when it is opened. */
export type DraftEmailParams = Omit<SendEmailParams, "from"> & {
  from?: string;
  /** The attachments' blobs, resolved at apply time by `uploadAttachments()`. */
  attachmentBlobs?: UploadedBlob[];
};

/**
 * The `Email/set create` object for a message in Drafts. Falls back to a derived HTML alternative
 * when only `textBody` was given, so a plain `{ text: "..." }` message (the common case) doesn't ship
 * without any text/html part at all.
 */
function draftEmailCreate(
  params: DraftEmailParams, draftsMailboxId: string,
): Record<string, unknown> {
  const bodyValues: Record<string, { value: string }> = {};
  const textBody: { partId: string; type: string }[] = [];
  const htmlBody: { partId: string; type: string }[] = [];
  if (params.textBody !== undefined) {
    bodyValues.text = { value: params.textBody };
    textBody.push({ partId: "text", type: "text/plain" });
  }
  const html = params.htmlBody ?? (params.textBody !== undefined ? textToHtml(params.textBody) : undefined);
  if (html !== undefined) {
    bodyValues.html = { value: html };
    htmlBody.push({ partId: "html", type: "text/html" });
  }
  return {
    mailboxIds: { [draftsMailboxId]: true },
    keywords: { "$draft": true, "$seen": true },
    from: params.from !== undefined ? [{ email: params.from }] : undefined,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    inReplyTo: params.inReplyTo,
    references: params.references,
    bodyValues,
    textBody: textBody.length > 0 ? textBody : undefined,
    htmlBody: htmlBody.length > 0 ? htmlBody : undefined,
    attachments: params.attachmentBlobs?.length
      ? params.attachmentBlobs.map(blob => blob.cid
        ? { blobId: blob.blobId, type: blob.type, name: blob.name, disposition: "inline", cid: blob.cid }
        : { blobId: blob.blobId, type: blob.type, name: blob.name, disposition: "attachment" })
      : undefined,
  };
}

/**
 * Sends a message: creates a draft `Email` in Drafts and an `EmailSubmission` referencing it in one
 * JMAP request, with `onSuccessUpdateEmail` moving the message from Drafts to Sent and clearing
 * `$draft` once the submission succeeds — the sequence Fastmail's own docs describe for sending mail.
 */
export async function sendEmail(
  apiUrl: string, apiToken: string, accountId: string,
  params: SendEmailParams & { attachmentBlobs?: UploadedBlob[] }, context: SendContext,
  fetchImpl: typeof fetch = fetch,
): Promise<{ emailId: string }> {
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
        create: { [draftId]: draftEmailCreate(params, context.draftsMailboxId) },
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

// ---------------------------------------------------------------------------
// Drafts

/** The id of the account's Drafts mailbox (`role: "drafts"`). */
export async function findDraftsMailboxId(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Mailbox/get", {
    accountId, properties: ["id", "role"],
  }, fetchImpl);
  const mailboxes = (result.list as { id: string; role: string | null }[] | undefined) ?? [];
  const draftsMailboxId = mailboxes.find(mailbox => mailbox.role === "drafts")?.id;
  if (!draftsMailboxId) {
    throw new FastmailError(
      "RESOURCE_NOT_FOUND", "This Fastmail account has no Drafts mailbox to save the draft in.");
  }
  return draftsMailboxId;
}

/**
 * Saves a draft in Drafts, replacing `replacesEmailId` in the same `Email/set` when given. JMAP
 * Emails are immutable apart from keywords and mailboxes (RFC 8621 §4.6), so an edited draft is a
 * new Email with a new id; this returns it. A replaced Email that is already gone (discarded or
 * sent from Fastmail itself) is not an error: the new copy is still saved.
 */
export async function writeDraft(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean,
  params: DraftEmailParams, draftsMailboxId: string, replacesEmailId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ emailId: string }> {
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/set", {
    accountId,
    create: { draft: draftEmailCreate(params, draftsMailboxId) },
    destroy: replacesEmailId !== undefined ? [replacesEmailId] : undefined,
  }, fetchImpl);
  const notCreated = (result.notCreated as Record<string, JmapMethodError> | undefined)?.draft;
  if (notCreated) {
    throw new FastmailError(
      methodErrorCode(notCreated), `Fastmail rejected the draft: ${describeMethodError(notCreated)}.`);
  }
  const created = (result.created as Record<string, { id: string }> | undefined)?.draft;
  if (!created) {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report the saved draft.");
  }
  return { emailId: created.id };
}

/** Permanently destroys emails. Ids that are already gone are ignored. */
export async function destroyEmails(
  apiUrl: string, apiToken: string, accountId: string, hasSubmission: boolean, emailIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (emailIds.length === 0) return;
  const result = await call(apiUrl, apiToken, usingFor(hasSubmission), "Email/set", {
    accountId, destroy: emailIds,
  }, fetchImpl);
  const notDestroyed = result.notDestroyed as Record<string, JmapMethodError> | undefined;
  const failedId = emailIds.find(id => notDestroyed?.[id] && notDestroyed[id].type !== "notFound");
  if (failedId) {
    const failure = notDestroyed![failedId];
    throw new FastmailError(
      methodErrorCode(failure), `Fastmail rejected deleting ${failedId}: ${failure.type}.`);
  }
}

// ---------------------------------------------------------------------------
// New-mail hooks: Email state, changes, and push subscriptions (RFC 8620 §5.2, §7.2)

/** The account's current `Email` state string, where `emailChanges()` starts reading from. */
export async function getEmailState(
  apiUrl: string, apiToken: string, accountId: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const result = await call(apiUrl, apiToken, [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY], "Email/get", {
    accountId, ids: [], properties: ["id"],
  }, fetchImpl);
  if (typeof result.state !== "string") {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report the mailbox state.");
  }
  return result.state;
}

/** What a hook needs to decide whether an email created since the cursor is new mail it watches. */
export type CreatedEmail = Pick<JmapEmailObject, "id" | "mailboxIds" | "keywords" | "receivedAt">;

export type EmailChangesPage =
  | { kind: "ok"; created: CreatedEmail[]; newState: string; hasMoreChanges: boolean }
  /** The server can no longer compute changes from that state (RFC 8620 §5.2): start over. */
  | { kind: "reset" };

/** The most changes one `emailChanges()` page asks for; `hasMoreChanges` continues it. */
export const EMAIL_CHANGES_PAGE_SIZE = 256;

/**
 * One page of `Email/changes` since `sinceState`, with the emails it created fetched in the same
 * request by back-reference. Updates and destroys are ignored: a hook only hears of new mail, and a
 * move into a folder is an update. An email created and destroyed within the page is simply absent
 * from the `Email/get` list.
 */
export async function emailChanges(
  apiUrl: string, apiToken: string, accountId: string, sinceState: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EmailChangesPage> {
  const parsed = await request(apiUrl, apiToken, {
    using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
    methodCalls: [
      ["Email/changes", { accountId, sinceState, maxChanges: EMAIL_CHANGES_PAGE_SIZE }, "c1"],
      ["Email/get", {
        accountId,
        "#ids": { resultOf: "c1", name: "Email/changes", path: "/created" },
        properties: ["id", "mailboxIds", "keywords", "receivedAt"],
      }, "c2"],
    ],
  }, fetchImpl);
  const [name, first] = parsed.methodResponses?.find(([, , id]) => id === "c1") ?? [];
  if (name === "error" && (first as unknown as JmapMethodError).type === "cannotCalculateChanges") {
    return { kind: "reset" };
  }
  const changes = methodResult(parsed, "c1", "Email/changes");
  const got = methodResult(parsed, "c2", "Email/get");
  if (typeof changes.newState !== "string") {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report the new mailbox state.");
  }
  return {
    kind: "ok",
    created: (got.list as CreatedEmail[] | undefined) ?? [],
    newState: changes.newState,
    hasMoreChanges: changes.hasMoreChanges === true,
  };
}

/** Web Push encryption keys for a push subscription (RFC 8291), base64url. */
export type PushKeys = { p256dh: string; auth: string };

/**
 * Creates a push subscription for the token's credentials (RFC 8620 §7.2). Fastmail then POSTs a
 * `PushVerification` to `url`, and pushes nothing else until `verifyPushSubscription()` echoes its
 * code. `expires` is a request: the server may shorten it, so the returned value is what holds.
 */
export async function createPushSubscription(
  apiUrl: string, apiToken: string,
  subscription: { deviceClientId: string; url: string; keys: PushKeys; types: string[]; expires: Date },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; expires: number | undefined }> {
  const result = await call(apiUrl, apiToken, [JMAP_CORE_CAPABILITY], "PushSubscription/set", {
    create: { push: { ...subscription, expires: utcDate(subscription.expires) } },
  }, fetchImpl);
  const notCreated = (result.notCreated as Record<string, JmapMethodError> | undefined)?.push;
  if (notCreated) {
    throw new FastmailError(
      methodErrorCode(notCreated), `Fastmail refused the push subscription: ${describeMethodError(notCreated)}.`);
  }
  const created = (result.created as Record<string, { id?: string; expires?: string | null }> | undefined)?.push;
  if (!created?.id) {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report the new push subscription.");
  }
  return { id: created.id, expires: parseUtcDate(created.expires) };
}

/**
 * Updates a push subscription: `verificationCode` to complete verification, `expires` to renew it.
 * Returns the expiry the server set, if `expires` was asked for. Throws `RESOURCE_NOT_FOUND` when
 * the subscription no longer exists, e.g. because its token was revoked (RFC 8620 §7.2).
 */
export async function updatePushSubscription(
  apiUrl: string, apiToken: string, id: string, patch: { verificationCode?: string; expires?: Date },
  fetchImpl: typeof fetch = fetch,
): Promise<{ expires: number | undefined }> {
  const result = await call(apiUrl, apiToken, [JMAP_CORE_CAPABILITY], "PushSubscription/set", {
    update: {
      [id]: {
        ...patch.verificationCode !== undefined ? { verificationCode: patch.verificationCode } : {},
        ...patch.expires !== undefined ? { expires: utcDate(patch.expires) } : {},
      },
    },
  }, fetchImpl);
  const notUpdated = (result.notUpdated as Record<string, JmapMethodError> | undefined)?.[id];
  if (notUpdated) {
    throw new FastmailError(
      methodErrorCode(notUpdated),
      `Fastmail refused to update the push subscription: ${describeMethodError(notUpdated)}.`);
  }
  // A server returns only the properties it changed differently from the request (RFC 8620 §5.3).
  const updated = (result.updated as Record<string, { expires?: string | null } | null> | undefined)?.[id];
  return { expires: parseUtcDate(updated?.expires) ?? patch.expires?.getTime() };
}

/** Destroys a push subscription; one that is already gone counts as destroyed. */
export async function destroyPushSubscription(
  apiUrl: string, apiToken: string, id: string, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const result = await call(apiUrl, apiToken, [JMAP_CORE_CAPABILITY], "PushSubscription/set", {
    destroy: [id],
  }, fetchImpl);
  const failure = (result.notDestroyed as Record<string, JmapMethodError> | undefined)?.[id];
  if (failure && failure.type !== "notFound") {
    throw new FastmailError(
      methodErrorCode(failure),
      `Fastmail refused to remove the push subscription: ${describeMethodError(failure)}.`);
  }
}

/** A JMAP `UTCDate`: RFC 3339 with a `Z` and no fractional seconds. */
function utcDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseUtcDate(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}
