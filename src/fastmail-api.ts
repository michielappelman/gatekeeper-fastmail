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
  type JmapMethodCall,
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

/**
 * Sends one JMAP request with a single method call and returns its result, throwing on a
 * transport failure, an HTTP error status, or a method-level `error` response.
 */
async function call(
  apiUrl: string, apiToken: string, using: string[], name: string, args: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const body: JmapRequestBody = { using, methodCalls: [[name, args, "c1"]] };
  const res = await fetchImpl(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw errorForStatus(res.status);

  let parsed: JmapResponseBody;
  try {
    parsed = JSON.parse(await readTextCapped(res)) as JmapResponseBody;
  } catch (error) {
    throw new FastmailError(
      "UPSTREAM_UNAVAILABLE", "Fastmail's JMAP response could not be parsed.", { cause: error });
  }
  const [responseName, result] = parsed.methodResponses[0] ?? [];
  if (responseName === "error") {
    const methodError = result as unknown as JmapMethodError;
    throw new FastmailError(
      methodErrorCode(methodError),
      `Fastmail rejected ${name}: ${methodError.type}${methodError.description ? ` (${methodError.description})` : ""}.`);
  }
  return result ?? {};
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
  draftMailboxId?: string;
};

/**
 * Sends a message: creates a draft `Email` and an `EmailSubmission` referencing it in one JMAP
 * request, with `onSuccessDestroyEmail` cleaning up the draft once the submission succeeds — the
 * two-call sequence Fastmail's own docs describe for sending mail.
 */
export async function sendEmail(
  apiUrl: string, apiToken: string, accountId: string, params: SendEmailParams,
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
  const body: JmapRequestBody = {
    using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY, JMAP_SUBMISSION_CAPABILITY],
    methodCalls: [
      ["Email/set", {
        accountId,
        create: {
          [draftId]: {
            mailboxIds: { [params.draftMailboxId ?? ""]: true },
            keywords: { "$draft": true, "$seen": true },
            from: [{ email: params.from }],
            to: params.to,
            cc: params.cc,
            bcc: params.bcc,
            subject: params.subject,
            bodyValues,
            textBody: textBody.length > 0 ? textBody : undefined,
            htmlBody: htmlBody.length > 0 ? htmlBody : undefined,
          },
        },
      }, "c1"],
      ["EmailSubmission/set", {
        accountId,
        create: {
          [submissionId]: { emailId: `#${draftId}`, identityId: undefined, onSuccessDestroyEmail: [`#${draftId}`] },
        },
      }, "c2"],
    ] as JmapMethodCall[],
  };

  const res = await fetchImpl(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw errorForStatus(res.status);
  let parsed: JmapResponseBody;
  try {
    parsed = JSON.parse(await readTextCapped(res)) as JmapResponseBody;
  } catch (error) {
    throw new FastmailError(
      "UPSTREAM_UNAVAILABLE", "Fastmail's send response could not be parsed.", { cause: error });
  }

  const setResult = parsed.methodResponses.find(([name]) => name === "Email/set")?.[1];
  const created = (setResult?.created as Record<string, { id: string }> | undefined)?.[draftId];
  const notCreated = (setResult?.notCreated as Record<string, JmapMethodError> | undefined)?.[draftId];
  if (notCreated) {
    throw new FastmailError(methodErrorCode(notCreated), `Fastmail rejected the draft: ${notCreated.type}.`);
  }

  const submissionResult = parsed.methodResponses.find(([name]) => name === "EmailSubmission/set")?.[1];
  const submissionFailure =
    (submissionResult?.notCreated as Record<string, JmapMethodError> | undefined)?.[submissionId];
  if (submissionFailure) {
    if (submissionFailure.type === "forbidden") {
      throw new FastmailError(
        "SUBMISSION_NOT_AUTHORIZED",
        "This Fastmail API token does not grant Email submission — send() is unavailable. " +
        "Create a new token with the Email submission scope to enable sending.");
    }
    throw new FastmailError(
      methodErrorCode(submissionFailure), `Fastmail rejected sending: ${submissionFailure.type}.`);
  }

  if (!created) {
    throw new FastmailError("UPSTREAM_UNAVAILABLE", "Fastmail did not report a created draft to send.");
  }
  return { emailId: created.id };
}
